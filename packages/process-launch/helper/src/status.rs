//! The helper's half of the launch record: one small JSON file, written
//! atomically next to the parent's intent manifest. It holds identity and
//! enrollment facts only, never the target's argv, environment or output.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;

pub const STATUS_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Enrolled,
    Degraded,
}

#[derive(Debug, Clone)]
pub struct Status {
    pub unit: String,
    pub slice: String,
    pub outcome: Outcome,
    /// A fixed reason code for a degraded outcome.
    pub reason: Option<&'static str>,
    /// A short, bounded diagnostic, for example the first line of a busctl
    /// error. Never target data.
    pub detail: Option<String>,
    pub pid: u32,
    pub pid_start_time: Option<String>,
    pub boot_id: Option<String>,
    pub original_cgroup: Option<String>,
    pub cgroup: Option<String>,
    pub expected_cgroup: Option<String>,
    /// The scope was observed although the manager reply was lost or late.
    pub response_lost: bool,
    /// The manager may still create the scope after the deadline passed.
    pub unit_may_exist: bool,
    pub elapsed_ms: u64,
    /// Set only when the final exec of the target failed.
    pub exec_error: Option<String>,
}

fn push_json_string(out: &mut String, value: &str) {
    out.push('"');
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

fn push_field(out: &mut String, key: &str, value: Option<&str>) {
    out.push(',');
    push_json_string(out, key);
    out.push(':');
    match value {
        Some(value) => push_json_string(out, value),
        None => out.push_str("null"),
    }
}

fn push_raw(out: &mut String, key: &str, raw: &str) {
    out.push(',');
    push_json_string(out, key);
    out.push(':');
    out.push_str(raw);
}

impl Status {
    pub fn to_json(&self) -> String {
        let mut out = String::with_capacity(512);
        out.push_str(&format!("{{\"version\":{STATUS_VERSION}"));
        push_field(&mut out, "kind", Some("paperclip-scope-exec-status"));
        push_field(&mut out, "unit", Some(&self.unit));
        push_field(&mut out, "slice", Some(&self.slice));
        push_field(
            &mut out,
            "outcome",
            Some(match self.outcome {
                Outcome::Enrolled => "enrolled",
                Outcome::Degraded => "degraded",
            }),
        );
        push_field(&mut out, "reason", self.reason);
        push_field(&mut out, "detail", self.detail.as_deref());
        push_raw(&mut out, "pid", &self.pid.to_string());
        push_field(&mut out, "pidStartTime", self.pid_start_time.as_deref());
        push_field(&mut out, "bootId", self.boot_id.as_deref());
        push_field(&mut out, "originalCgroup", self.original_cgroup.as_deref());
        push_field(&mut out, "cgroup", self.cgroup.as_deref());
        push_field(&mut out, "expectedCgroup", self.expected_cgroup.as_deref());
        push_raw(
            &mut out,
            "responseLost",
            if self.response_lost { "true" } else { "false" },
        );
        push_raw(
            &mut out,
            "unitMayExist",
            if self.unit_may_exist { "true" } else { "false" },
        );
        push_raw(&mut out, "elapsedMs", &self.elapsed_ms.to_string());
        push_field(&mut out, "execError", self.exec_error.as_deref());
        out.push_str("}\n");
        out
    }
}

/// Bound a diagnostic to one short printable line.
pub fn bounded_detail(raw: &str) -> Option<String> {
    let line = raw.lines().map(str::trim).find(|line| !line.is_empty())?;
    let cleaned: String = line.chars().filter(|c| !c.is_control()).take(200).collect();
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned)
    }
}

/// Write the status atomically: a fresh private temporary file, fsync, then
/// rename over the final name. Every descriptor is close-on-exec and is
/// closed before this returns. Failure is reported, never fatal.
pub fn write_atomic(path: &str, body: &str) -> std::io::Result<()> {
    let temporary = format!("{path}.tmp-{}", std::process::id());
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary)?;
        file.write_all(body.as_bytes())?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Status {
        Status {
            unit: "pcagent-a-b-c.scope".into(),
            slice: "app-agents.slice".into(),
            outcome: Outcome::Degraded,
            reason: Some("timeout"),
            detail: Some("quote \" backslash \\ tab\t".into()),
            pid: 42,
            pid_start_time: Some("123".into()),
            boot_id: None,
            original_cgroup: Some("/a/b".into()),
            cgroup: None,
            expected_cgroup: None,
            response_lost: false,
            unit_may_exist: true,
            elapsed_ms: 7,
            exec_error: None,
        }
    }

    #[test]
    fn writes_escaped_json() {
        let json = sample().to_json();
        assert!(json.starts_with("{\"version\":1,\"kind\":\"paperclip-scope-exec-status\""));
        assert!(json.contains("\"detail\":\"quote \\\" backslash \\\\ tab\\t\""));
        assert!(json.contains("\"bootId\":null"));
        assert!(json.contains("\"unitMayExist\":true"));
        assert!(json.contains("\"pid\":42"));
    }

    #[test]
    fn bounds_details() {
        assert_eq!(
            bounded_detail("\n  Failed to connect: x\nmore"),
            Some("Failed to connect: x".into())
        );
        assert_eq!(bounded_detail("   \n"), None);
        assert_eq!(bounded_detail(&"a".repeat(500)).unwrap().len(), 200);
    }

    #[test]
    fn atomic_write_replaces_file() {
        let dir = std::env::temp_dir().join(format!("pcse-status-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("s.json");
        let path = path.to_str().unwrap();
        write_atomic(path, "one").unwrap();
        write_atomic(path, "two").unwrap();
        assert_eq!(fs::read_to_string(path).unwrap(), "two");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        fs::remove_dir_all(&dir).unwrap();
    }
}
