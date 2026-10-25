//! `paperclip-scope-exec`: join a transient systemd user scope, then execute
//! the original target exactly once in place.
//!
//! ```text
//! paperclip-scope-exec --unit <name.scope> --slice <name.slice>
//!     [--user-bus unix:path=<socket>] [--status-file <path>]
//!     [--deadline-ms <n>] [--stop-timeout-ms <n>] [--busctl <path>]
//!     [--argv0 <arg0>] -- <file> [args...]
//! ```
//!
//! The process keeps its PID, process group, session, cwd, environment,
//! signal state and every inherited descriptor. The helper never writes to
//! descriptors 0, 1 or 2; its only output is the status file. On any
//! enrollment failure the target still runs once, in its original cgroup.
//!
//! `no_main` keeps the Rust runtime's start-up code out: it would ignore
//! SIGPIPE and reopen closed standard descriptors, and the target must see
//! neither change.

#![cfg_attr(not(test), no_main)]
// Under test the C entry point is compiled out, which leaves its callees unused.
#![cfg_attr(test, allow(dead_code, unused_imports))]

mod enroll;
mod names;
mod status;

use std::ffi::{CStr, CString, OsStr, OsString};
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::time::{Duration, Instant};

use enroll::{enroll, Config, Enrollment};
use status::{write_atomic, Outcome, Status};

/// Exit codes used only when the target could not run at all. A target's
/// own exit code passes through unchanged because the target replaces this
/// process. The status file distinguishes the two.
const EXIT_USAGE: i32 = 125;
const EXIT_EXEC_FAILED: i32 = 126;
const EXIT_EXEC_NOT_FOUND: i32 = 127;

const DEFAULT_DEADLINE_MS: u64 = 2_000;
const MAX_DEADLINE_MS: u64 = 30_000;
const DEFAULT_STOP_TIMEOUT_MS: u64 = 10_000;
const MAX_STOP_TIMEOUT_MS: u64 = 300_000;
const DEFAULT_BUSCTL: &str = "/usr/bin/busctl";

struct Options {
    unit: Option<String>,
    slice: Option<String>,
    user_bus: Option<String>,
    status_file: Option<String>,
    deadline_ms: u64,
    stop_timeout_ms: u64,
    busctl: String,
    argv0: Option<OsString>,
    invalid: bool,
}

struct Invocation {
    options: Options,
    file: OsString,
    args: Vec<OsString>,
}

fn parse_millis(value: &OsStr, max: u64) -> Option<u64> {
    let parsed: u64 = value.to_str()?.parse().ok()?;
    (1..=max).contains(&parsed).then_some(parsed)
}

fn parse(argv: Vec<OsString>) -> Option<Invocation> {
    let mut options = Options {
        unit: None,
        slice: None,
        user_bus: None,
        status_file: None,
        deadline_ms: DEFAULT_DEADLINE_MS,
        stop_timeout_ms: DEFAULT_STOP_TIMEOUT_MS,
        busctl: DEFAULT_BUSCTL.to_string(),
        argv0: None,
        invalid: false,
    };
    let mut rest = argv.into_iter().skip(1);
    loop {
        let flag = rest.next()?;
        if flag == "--" {
            break;
        }
        let Some(value) = rest.next() else {
            return None;
        };
        if value == "--" {
            // A flag without a value directly before the target separator.
            // Treat the target as found and the options as invalid.
            options.invalid = true;
            break;
        }
        let text = value.to_str().map(str::to_owned);
        match flag.to_str() {
            Some("--unit") => options.unit = text,
            Some("--slice") => options.slice = text,
            Some("--user-bus") => options.user_bus = text,
            Some("--status-file") => options.status_file = text,
            Some("--busctl") => match text {
                Some(path) if path.starts_with('/') => options.busctl = path,
                _ => options.invalid = true,
            },
            Some("--argv0") => options.argv0 = Some(value),
            Some("--deadline-ms") => match parse_millis(&value, MAX_DEADLINE_MS) {
                Some(ms) => options.deadline_ms = ms,
                None => options.invalid = true,
            },
            Some("--stop-timeout-ms") => match parse_millis(&value, MAX_STOP_TIMEOUT_MS) {
                Some(ms) => options.stop_timeout_ms = ms,
                None => options.invalid = true,
            },
            _ => options.invalid = true,
        }
    }
    let file = rest.next()?;
    if file.is_empty() {
        return None;
    }
    Some(Invocation {
        options,
        file,
        args: rest.collect(),
    })
}

fn read_trimmed(path: &str) -> Option<String> {
    std::fs::read_to_string(path)
        .ok()
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
}

/// Field 22 of `/proc/self/stat`. It does not change across exec, so it
/// identifies the target process too.
fn own_start_time() -> Option<String> {
    let stat = std::fs::read_to_string("/proc/self/stat").ok()?;
    let after_comm = &stat[stat.rfind(')')? + 1..];
    after_comm.split_whitespace().nth(19).map(str::to_owned)
}

fn run_enrollment(options: &Options, started: Instant) -> Enrollment {
    let config = Config {
        unit: options.unit.clone().unwrap_or_default(),
        slice: options.slice.clone().unwrap_or_default(),
        user_bus: options.user_bus.clone(),
        busctl: options.busctl.clone(),
        deadline: Duration::from_millis(options.deadline_ms),
        stop_timeout: Duration::from_millis(options.stop_timeout_ms),
        cgroup_root: "/sys/fs/cgroup".to_string(),
        proc_self_cgroup: "/proc/self/cgroup".to_string(),
    };
    // A helper bug must not stop the target from running once. The panic
    // hook is silenced so nothing reaches the target's stderr.
    match std::panic::catch_unwind(|| enroll(&config, started)) {
        Ok(enrollment) => enrollment,
        Err(_) => Enrollment {
            enrolled: false,
            reason: Some("helper_panic"),
            detail: None,
            original_cgroup: enroll::read_own_cgroup(&config.proc_self_cgroup),
            cgroup: None,
            expected_cgroup: None,
            response_lost: false,
            unit_may_exist: true,
        },
    }
}

fn status_from(options: &Options, enrollment: Enrollment, started: Instant) -> Status {
    Status {
        unit: options.unit.clone().unwrap_or_default(),
        slice: options.slice.clone().unwrap_or_default(),
        outcome: if enrollment.enrolled {
            Outcome::Enrolled
        } else {
            Outcome::Degraded
        },
        reason: enrollment.reason,
        detail: enrollment.detail,
        pid: std::process::id(),
        pid_start_time: own_start_time(),
        boot_id: read_trimmed("/proc/sys/kernel/random/boot_id"),
        original_cgroup: enrollment.original_cgroup,
        cgroup: enrollment.cgroup,
        expected_cgroup: enrollment.expected_cgroup,
        response_lost: enrollment.response_lost,
        unit_may_exist: enrollment.unit_may_exist,
        elapsed_ms: started.elapsed().as_millis() as u64,
        exec_error: None,
    }
}

fn errno_name(errno: i32) -> String {
    match errno {
        libc::ENOENT => "ENOENT".into(),
        libc::EACCES => "EACCES".into(),
        libc::ENOEXEC => "ENOEXEC".into(),
        libc::ENOTDIR => "ENOTDIR".into(),
        libc::E2BIG => "E2BIG".into(),
        libc::ELOOP => "ELOOP".into(),
        libc::ENAMETOOLONG => "ENAMETOOLONG".into(),
        libc::ETXTBSY => "ETXTBSY".into(),
        other => format!("errno {other}"),
    }
}

fn last_errno() -> i32 {
    std::io::Error::last_os_error().raw_os_error().unwrap_or(0)
}

/// The PATH value in this process's own environment, which is the target's
/// environment: the helper never changes it.
fn search_path() -> Vec<u8> {
    std::env::var_os("PATH")
        .map(OsStringExt::into_vec)
        // libuv's default when PATH is unset, so a wrapped spawn resolves
        // like an unwrapped one.
        .unwrap_or_else(|| b"/usr/bin:/bin".to_vec())
}

/// The shell glibc's `execvp` falls back to for a file the kernel will not
/// execute (ENOEXEC), such as a script without a `#!` line.
const FALLBACK_SHELL: &[u8] = b"/bin/sh\0";

/// One `execv` with glibc's ENOEXEC fallback: on ENOEXEC the file runs as
/// `/bin/sh <path> args...` (argv[0] replaced, as glibc does). Nothing has
/// run when ENOEXEC is returned, so this is still exactly one exec of the
/// target. Returns only on failure, with the errno of the first attempt
/// unless the shell itself could not run.
fn exec_path(path: &CStr, argv: &[*const libc::c_char]) -> i32 {
    unsafe { libc::execv(path.as_ptr(), argv.as_ptr()) };
    let errno = last_errno();
    if errno != libc::ENOEXEC {
        return errno;
    }
    let shell = FALLBACK_SHELL.as_ptr().cast::<libc::c_char>();
    let mut script: Vec<*const libc::c_char> = Vec::with_capacity(argv.len() + 1);
    script.push(shell);
    script.push(path.as_ptr());
    // argv ends with its null terminator; skip the original argv[0].
    script.extend_from_slice(argv.get(1..).unwrap_or(&[std::ptr::null()]));
    unsafe { libc::execv(shell, script.as_ptr()) };
    errno
}

/// Execute `file` the way libuv's spawn does on Linux (glibc `execvp`): a
/// name with a slash is used as is; otherwise each PATH entry is tried, an
/// empty entry meaning the current directory. A file without a valid
/// executable format runs through `/bin/sh`. Returns only on failure, with
/// the errno to report.
fn exec_target(file: &OsStr, argv: &[CString]) -> i32 {
    let mut pointers: Vec<*const libc::c_char> = argv.iter().map(|arg| arg.as_ptr()).collect();
    pointers.push(std::ptr::null());
    let bytes = file.as_bytes();
    if bytes.contains(&b'/') {
        let Ok(path) = CString::new(bytes) else {
            return libc::ENOENT;
        };
        return exec_path(&path, &pointers);
    }
    let mut saw_eacces = false;
    let mut result = libc::ENOENT;
    for entry in search_path().split(|byte| *byte == b':') {
        let mut candidate = if entry.is_empty() {
            b".".to_vec()
        } else {
            entry.to_vec()
        };
        candidate.push(b'/');
        candidate.extend_from_slice(bytes);
        let Ok(path) = CString::new(candidate) else {
            continue;
        };
        match exec_path(&path, &pointers) {
            libc::EACCES => saw_eacces = true,
            // glibc's execvp moves on to the next PATH entry for these.
            libc::ENOENT | libc::ENOTDIR | libc::ESTALE | libc::ENODEV | libc::ETIMEDOUT => {}
            other => {
                result = other;
                break;
            }
        }
    }
    if saw_eacces && result == libc::ENOENT {
        libc::EACCES
    } else {
        result
    }
}

fn to_cstring(value: OsString) -> Option<CString> {
    CString::new(value.into_vec()).ok()
}

fn arguments(argc: libc::c_int, argv: *const *const libc::c_char) -> Vec<OsString> {
    (0..argc.max(0) as usize)
        .map(|index| unsafe { *argv.add(index) })
        .take_while(|pointer| !pointer.is_null())
        .map(|pointer| OsStr::from_bytes(unsafe { CStr::from_ptr(pointer) }.to_bytes()).to_owned())
        .collect()
}

fn print_version() -> i32 {
    // The only output the helper ever writes, and only when run on its own.
    let line = format!("paperclip-scope-exec {}\n", env!("CARGO_PKG_VERSION"));
    unsafe { libc::write(1, line.as_ptr().cast(), line.len()) };
    0
}

#[cfg(not(test))]
#[no_mangle]
pub extern "C" fn main(argc: libc::c_int, argv: *const *const libc::c_char) -> libc::c_int {
    let started = Instant::now();
    std::panic::set_hook(Box::new(|_| {}));
    let raw = arguments(argc, argv);
    if raw.len() == 2 && raw[1] == "--version" {
        return print_version();
    }
    let Some(invocation) = parse(raw) else {
        return EXIT_USAGE;
    };
    let Invocation {
        options,
        file,
        args,
    } = invocation;
    let mut target_argv = Vec::with_capacity(args.len() + 1);
    let Some(first) = to_cstring(options.argv0.clone().unwrap_or_else(|| file.clone())) else {
        return EXIT_USAGE;
    };
    target_argv.push(first);
    for arg in args {
        let Some(arg) = to_cstring(arg) else {
            return EXIT_USAGE;
        };
        target_argv.push(arg);
    }

    let enrollment = if options.invalid || options.unit.is_none() || options.slice.is_none() {
        invalid_options()
    } else {
        run_enrollment(&options, started)
    };
    let mut status = status_from(&options, enrollment, started);
    if let Some(path) = options.status_file.as_deref() {
        let _ = write_atomic(path, &status.to_json());
    }

    let errno = exec_target(&file, &target_argv);
    status.exec_error = Some(errno_name(errno));
    if let Some(path) = options.status_file.as_deref() {
        let _ = write_atomic(path, &status.to_json());
    }
    if errno == libc::ENOENT {
        EXIT_EXEC_NOT_FOUND
    } else {
        EXIT_EXEC_FAILED
    }
}

fn invalid_options() -> Enrollment {
    Enrollment {
        enrolled: false,
        reason: Some("invalid_options"),
        detail: None,
        original_cgroup: enroll::read_own_cgroup("/proc/self/cgroup"),
        cgroup: None,
        expected_cgroup: None,
        response_lost: false,
        unit_may_exist: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn os(values: &[&str]) -> Vec<OsString> {
        values.iter().map(OsString::from).collect()
    }

    #[test]
    fn parses_options_and_target() {
        let invocation = parse(os(&[
            "helper",
            "--unit",
            "a.scope",
            "--slice",
            "app-agents.slice",
            "--deadline-ms",
            "500",
            "--",
            "echo",
            "--unit",
            "$HOME x",
        ]))
        .unwrap();
        assert_eq!(invocation.options.unit.as_deref(), Some("a.scope"));
        assert_eq!(invocation.options.deadline_ms, 500);
        assert!(!invocation.options.invalid);
        assert_eq!(invocation.file, "echo");
        assert_eq!(invocation.args, os(&["--unit", "$HOME x"]));
    }

    #[test]
    fn invalid_options_still_find_the_target() {
        let invocation = parse(os(&[
            "helper",
            "--bogus",
            "1",
            "--deadline-ms",
            "0",
            "--",
            "true",
        ]))
        .unwrap();
        assert!(invocation.options.invalid);
        assert_eq!(invocation.file, "true");
        let invocation = parse(os(&["helper", "--unit", "--", "true"])).unwrap();
        assert!(invocation.options.invalid);
        assert_eq!(invocation.file, "true");
        let invocation = parse(os(&["helper", "--busctl", "relative", "--", "true"])).unwrap();
        assert!(invocation.options.invalid);
    }

    #[test]
    fn rejects_missing_target() {
        assert!(parse(os(&["helper", "--unit", "a.scope"])).is_none());
        assert!(parse(os(&["helper", "--"])).is_none());
        assert!(parse(os(&["helper", "--", ""])).is_none());
    }
}
