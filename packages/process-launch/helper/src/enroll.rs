//! Self-enrollment into a transient user scope through the user manager's
//! `StartTransientUnit`, with one combined deadline. Nothing here writes to
//! the inherited stdio descriptors or changes the process's own state other
//! than its cgroup.

use std::fs;
use std::io::Read;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use crate::names::{is_valid_scope, is_valid_slice, slice_cgroup_path};
use crate::status::bounded_detail;

pub struct Config {
    pub unit: String,
    pub slice: String,
    pub user_bus: Option<String>,
    pub busctl: String,
    pub deadline: Duration,
    pub stop_timeout: Duration,
    pub cgroup_root: String,
    pub proc_self_cgroup: String,
}

pub struct Enrollment {
    pub enrolled: bool,
    pub reason: Option<&'static str>,
    pub detail: Option<String>,
    pub original_cgroup: Option<String>,
    pub cgroup: Option<String>,
    pub expected_cgroup: Option<String>,
    pub response_lost: bool,
    pub unit_may_exist: bool,
}

impl Enrollment {
    fn degraded(reason: &'static str) -> Self {
        Enrollment {
            enrolled: false,
            reason: Some(reason),
            detail: None,
            original_cgroup: None,
            cgroup: None,
            expected_cgroup: None,
            response_lost: false,
            unit_may_exist: false,
        }
    }
}

/// The unified (cgroup v2) path of this process, from `/proc/self/cgroup`.
pub fn read_own_cgroup(proc_self_cgroup: &str) -> Option<String> {
    let text = fs::read_to_string(proc_self_cgroup).ok()?;
    text.lines()
        .find_map(|line| line.strip_prefix("0::"))
        .map(|path| path.trim_end().to_string())
}

/// The cgroup of this UID's own user manager, when this process runs below it.
pub fn user_manager_cgroup(own_cgroup: &str, uid: u32) -> Option<String> {
    let marker = format!("/user.slice/user-{uid}.slice/user@{uid}.service");
    let index = own_cgroup.find(&marker)?;
    let end = index + marker.len();
    match own_cgroup.as_bytes().get(end) {
        None | Some(b'/') => Some(own_cgroup[..end].to_string()),
        Some(_) => None,
    }
}

fn has_cpu_controller(cgroup_root: &str, manager: &str) -> bool {
    let path = format!("{cgroup_root}{manager}/cgroup.subtree_control");
    fs::read_to_string(path)
        .map(|text| {
            text.split_whitespace()
                .any(|controller| controller == "cpu")
        })
        .unwrap_or(false)
}

fn user_bus_socket(address: &str) -> Option<&str> {
    // Only a plain unix socket path is accepted. The address comes from the
    // server's own environment, never from a provider override.
    let path = address.strip_prefix("unix:path=")?;
    if path.is_empty() || path.contains(',') || path.contains(';') || !path.starts_with('/') {
        return None;
    }
    Some(path)
}

fn remaining(deadline: Instant) -> Duration {
    deadline.saturating_duration_since(Instant::now())
}

fn mark_inherited_descriptors_cloexec() {
    // Runs in the forked busctl child after its stdio is set up. Caller-owned
    // descriptors (credentials, verified executables, IPC) must not reach
    // busctl. Marking them close-on-exec instead of closing them keeps the
    // standard library's own exec-error pipe working. The flag is per
    // descriptor table, so the helper's own descriptors are unaffected.
    const CLOSE_RANGE_CLOEXEC: libc::c_uint = 1 << 2;
    unsafe {
        if libc::syscall(libc::SYS_close_range, 3u32, u32::MAX, CLOSE_RANGE_CLOEXEC) == 0 {
            return;
        }
        let mut limit: libc::rlimit = std::mem::zeroed();
        let max = if libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) == 0 {
            limit.rlim_cur.min(65_536) as i32
        } else {
            4096
        };
        for fd in 3..max {
            let flags = libc::fcntl(fd, libc::F_GETFD);
            if flags >= 0 {
                libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC);
            }
        }
    }
}

fn spawn_busctl(config: &Config, address: &str, budget: Duration) -> std::io::Result<Child> {
    let pid = std::process::id().to_string();
    let stop_usec = (config.stop_timeout.as_micros() as u64).to_string();
    let timeout = format!("--timeout={}ms", budget.as_millis().max(1));
    let mut command = Command::new(&config.busctl);
    command
        .args([
            "--user",
            timeout.as_str(),
            "call",
            "org.freedesktop.systemd1",
            "/org/freedesktop/systemd1",
            "org.freedesktop.systemd1.Manager",
            "StartTransientUnit",
            "ssa(sv)a(sa(sv))",
            config.unit.as_str(),
            "fail",
            "6",
            "Slice",
            "s",
            config.slice.as_str(),
            "PIDs",
            "au",
            "1",
            pid.as_str(),
            "KillMode",
            "s",
            "control-group",
            "TimeoutStopUSec",
            "t",
            stop_usec.as_str(),
            "CollectMode",
            "s",
            "inactive-or-failed",
            "Description",
            "s",
            "Paperclip agent workload",
            "0",
        ])
        .env_clear()
        .env("DBUS_SESSION_BUS_ADDRESS", address)
        .env("PATH", "/usr/bin:/bin")
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    unsafe {
        command.pre_exec(|| {
            mark_inherited_descriptors_cloexec();
            Ok(())
        });
    }
    command.spawn()
}

enum BusctlResult {
    Succeeded,
    Failed(String),
    TimedOut,
}

/// Wait for exactly this busctl child until the deadline. On timeout it is
/// killed and reaped; no other process is touched.
fn wait_busctl(mut child: Child, deadline: Instant) -> BusctlResult {
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut stderr = String::new();
                if let Some(mut pipe) = child.stderr.take() {
                    let _ = pipe.read_to_string(&mut stderr);
                }
                return if status.success() {
                    BusctlResult::Succeeded
                } else {
                    BusctlResult::Failed(stderr)
                };
            }
            Ok(None) => {}
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return BusctlResult::Failed(String::new());
            }
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return BusctlResult::TimedOut;
        }
        std::thread::sleep(Duration::from_millis(2));
    }
}

fn wait_for_membership(config: &Config, expected: &str, deadline: Instant) -> bool {
    loop {
        if read_own_cgroup(&config.proc_self_cgroup).as_deref() == Some(expected) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(2));
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Failure {
    /// busctl never reached the manager, so no call was made.
    NoConnection,
    /// The manager answered the call with an error, so no scope exists.
    Rejected,
    /// The call may have reached the manager (timeout, reset, crash).
    Uncertain,
}

/// Errno texts busctl prints for local transport failures. With these the
/// call may still have been delivered.
const TRANSPORT_ERRORS: &[&str] = &[
    "timed out",
    "Timeout",
    "Connection reset",
    "Broken pipe",
    "not connected",
    "Connection refused",
    "No buffer space",
    "Interrupted",
];

fn classify_failure(stderr: &str) -> Failure {
    if stderr.contains("Failed to connect to") {
        return Failure::NoConnection;
    }
    let text = stderr.trim_start();
    if text.starts_with("Call failed:")
        && !TRANSPORT_ERRORS.iter().any(|error| text.contains(error))
    {
        return Failure::Rejected;
    }
    Failure::Uncertain
}

pub fn enroll(config: &Config, started: Instant) -> Enrollment {
    let deadline = started + config.deadline;
    if !is_valid_slice(&config.slice) {
        return Enrollment::degraded("invalid_slice");
    }
    if !is_valid_scope(&config.unit) {
        return Enrollment::degraded("invalid_unit");
    }
    let Some(original) = read_own_cgroup(&config.proc_self_cgroup) else {
        return Enrollment::degraded("cgroup_v2_unavailable");
    };
    let uid = unsafe { libc::getuid() };
    let mut result = Enrollment::degraded("not_under_user_manager");
    result.original_cgroup = Some(original.clone());
    let Some(manager) = user_manager_cgroup(&original, uid) else {
        return result;
    };
    if !has_cpu_controller(&config.cgroup_root, &manager) {
        result.reason = Some("cpu_controller_unavailable");
        return result;
    }
    let Some(address) = config.user_bus.as_deref() else {
        result.reason = Some("user_bus_unconfigured");
        return result;
    };
    let Some(socket) = user_bus_socket(address) else {
        result.reason = Some("user_bus_unsupported_address");
        return result;
    };
    if !Path::new(socket).exists() {
        result.reason = Some("user_bus_unavailable");
        return result;
    }
    let expected = format!(
        "{manager}{}/{}",
        slice_cgroup_path(&config.slice),
        config.unit
    );
    result.expected_cgroup = Some(expected.clone());
    let budget = remaining(deadline);
    if budget.is_zero() {
        result.reason = Some("timeout");
        return result;
    }
    let child = match spawn_busctl(config, address, budget) {
        Ok(child) => child,
        Err(error) => {
            result.reason = Some(if error.kind() == std::io::ErrorKind::NotFound {
                "busctl_missing"
            } else {
                "busctl_spawn_failed"
            });
            return result;
        }
    };
    let call = wait_busctl(child, deadline);
    let failure = match &call {
        BusctlResult::Failed(stderr) => Some(classify_failure(stderr)),
        _ => None,
    };
    let observed = match (&call, &failure) {
        // A definite answer that nothing was created: no need to wait.
        (_, Some(Failure::NoConnection | Failure::Rejected)) => false,
        // The deadline has passed: one last look.
        (BusctlResult::TimedOut, _) => {
            read_own_cgroup(&config.proc_self_cgroup).as_deref() == Some(expected.as_str())
        }
        // A success reply only says a start job was queued, and a lost reply
        // may still have created the scope; the move happens when the manager
        // runs the job. Membership is the confirmation. Never start a second
        // attempt.
        _ => wait_for_membership(config, &expected, deadline),
    };
    if observed {
        result.enrolled = true;
        result.reason = None;
        result.cgroup = Some(expected);
        result.response_lost = !matches!(call, BusctlResult::Succeeded);
        return result;
    }
    result.cgroup = read_own_cgroup(&config.proc_self_cgroup);
    match call {
        BusctlResult::Succeeded => {
            result.reason = Some("enrollment_not_observed");
            result.unit_may_exist = true;
        }
        BusctlResult::TimedOut => {
            result.reason = Some("timeout");
            result.unit_may_exist = true;
        }
        BusctlResult::Failed(stderr) => {
            result.detail = bounded_detail(&stderr);
            match failure {
                Some(Failure::NoConnection) => result.reason = Some("user_bus_unavailable"),
                Some(Failure::Rejected) => result.reason = Some("start_transient_unit_failed"),
                _ => {
                    result.reason = Some("start_transient_unit_uncertain");
                    result.unit_may_exist = true;
                }
            }
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_own_user_manager_only() {
        let own = "/user.slice/user-1000.slice/user@1000.service/app.slice/paperclipai.service";
        assert_eq!(
            user_manager_cgroup(own, 1000).as_deref(),
            Some("/user.slice/user-1000.slice/user@1000.service")
        );
        assert_eq!(user_manager_cgroup(own, 1001), None);
        assert_eq!(
            user_manager_cgroup("/user.slice/user-1000.slice/user@1000.servicex/a", 1000),
            None
        );
        assert_eq!(user_manager_cgroup("/system.slice/foo.service", 1000), None);
    }

    #[test]
    fn classifies_busctl_failures() {
        assert_eq!(
            classify_failure("Failed to connect to user scope bus via local transport: No such file or directory"),
            Failure::NoConnection
        );
        assert_eq!(
            classify_failure("Call failed: Invalid unit name or type: bad/name.scope\n"),
            Failure::Rejected
        );
        assert_eq!(
            classify_failure("Call failed: Connection timed out"),
            Failure::Uncertain
        );
        assert_eq!(
            classify_failure("Call failed: Connection reset by peer"),
            Failure::Uncertain
        );
        assert_eq!(classify_failure(""), Failure::Uncertain);
    }

    #[test]
    fn requires_the_cpu_controller() {
        let root = std::env::temp_dir().join(format!("pcse-cgroup-{}", std::process::id()));
        let manager = "/user.slice/user-1.slice/user@1.service";
        let dir = root.join(manager.trim_start_matches('/'));
        fs::create_dir_all(&dir).unwrap();
        let root_text = root.to_str().unwrap();
        fs::write(dir.join("cgroup.subtree_control"), "memory pids\n").unwrap();
        assert!(!has_cpu_controller(root_text, manager));
        fs::write(dir.join("cgroup.subtree_control"), "cpuset cpu memory\n").unwrap();
        assert!(has_cpu_controller(root_text, manager));
        assert!(!has_cpu_controller(root_text, "/missing"));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn accepts_only_plain_unix_bus_paths() {
        assert_eq!(
            user_bus_socket("unix:path=/run/user/1000/bus"),
            Some("/run/user/1000/bus")
        );
        assert_eq!(user_bus_socket("unix:path=/run/user/1000/bus,guid=1"), None);
        assert_eq!(user_bus_socket("unix:abstract=x"), None);
        assert_eq!(user_bus_socket("tcp:host=x"), None);
        assert_eq!(user_bus_socket("unix:path=relative"), None);
    }
}
