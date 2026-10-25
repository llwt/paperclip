//! Unit and slice name rules. These mirror `src/unit-names.ts`; both sides
//! validate so neither trusts the other's input.

const MAX_UNIT_NAME: usize = 255;

/// Slices that must never receive agent workloads: the root slice, the
/// well-known top-level slices, and `app.slice`, which holds the Paperclip
/// service itself.
const RESERVED_SLICES: &[&str] = &[
    "-.slice",
    "system.slice",
    "user.slice",
    "machine.slice",
    "app.slice",
    "session.slice",
    "background.slice",
];

fn is_unit_char(c: u8) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, b'_' | b'.' | b':' | b'-')
}

/// A non-root slice name such as `app-agents.slice`: unit characters only,
/// no separators or path traversal, no empty hierarchy segment.
pub fn is_valid_slice(name: &str) -> bool {
    if name.len() > MAX_UNIT_NAME || RESERVED_SLICES.contains(&name) {
        return false;
    }
    let Some(stem) = name.strip_suffix(".slice") else {
        return false;
    };
    if stem.is_empty() || !stem.bytes().all(is_unit_char) {
        return false;
    }
    if stem.contains('.') {
        return false;
    }
    stem.split('-').all(|segment| !segment.is_empty())
}

/// A transient scope name: unit characters only, ending in `.scope`.
pub fn is_valid_scope(name: &str) -> bool {
    if name.len() > MAX_UNIT_NAME {
        return false;
    }
    let Some(stem) = name.strip_suffix(".scope") else {
        return false;
    };
    !stem.is_empty() && !stem.starts_with('-') && stem.bytes().all(is_unit_char)
}

/// The cgroup path of a slice below its manager, following systemd's prefix
/// rule: `app-agents.slice` is `/app.slice/app-agents.slice`.
pub fn slice_cgroup_path(slice: &str) -> String {
    let stem = slice.strip_suffix(".slice").unwrap_or(slice);
    let mut path = String::new();
    let mut prefix = String::new();
    for (index, segment) in stem.split('-').enumerate() {
        if index > 0 {
            prefix.push('-');
        }
        prefix.push_str(segment);
        path.push('/');
        path.push_str(&prefix);
        path.push_str(".slice");
    }
    path
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_agent_slices() {
        assert!(is_valid_slice("app-agents.slice"));
        assert!(is_valid_slice("app-pcltest_1.slice"));
        assert!(is_valid_slice("agents.slice"));
    }

    #[test]
    fn rejects_reserved_and_malformed_slices() {
        for name in [
            "-.slice",
            "app.slice",
            "system.slice",
            "user.slice",
            "app-agents",
            "app-agents.service",
            "app--agents.slice",
            "-app.slice",
            "app-.slice",
            "app/agents.slice",
            "../app.slice",
            "app..agents.slice",
            "app agents.slice",
            ".slice",
            "",
        ] {
            assert!(!is_valid_slice(name), "{name}");
        }
        assert!(!is_valid_slice(&format!("{}.slice", "a".repeat(260))));
    }

    #[test]
    fn validates_scope_names() {
        assert!(is_valid_scope("pcagent-0123abcd-4567-89ef.scope"));
        assert!(!is_valid_scope("pcagent.service"));
        assert!(!is_valid_scope("-x.scope"));
        assert!(!is_valid_scope("a/b.scope"));
        assert!(!is_valid_scope(".scope"));
        assert!(!is_valid_scope("a b.scope"));
    }

    #[test]
    fn maps_slice_to_cgroup_path() {
        assert_eq!(
            slice_cgroup_path("app-agents.slice"),
            "/app.slice/app-agents.slice"
        );
        assert_eq!(slice_cgroup_path("agents.slice"), "/agents.slice");
        assert_eq!(
            slice_cgroup_path("app-agents-test.slice"),
            "/app.slice/app-agents.slice/app-agents-test.slice"
        );
    }
}
