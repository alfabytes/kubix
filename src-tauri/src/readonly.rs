//! Read-only guarantee for the Kubix backend.
//!
//! The milestone contract is that **no mutating Kubernetes operation exists in the
//! backend**. That is enforced structurally, not by documentation:
//!
//! 1. Every Tauri command is declared in [`crate::ipc::commands::COMMANDS`] and must be
//!    on [`crate::ipc::commands::READ_ONLY_ROSTER`].
//! 2. This module scans the backend sources for mutating kube verbs and fails the test
//!    suite if one appears.
//!
//! When write support is eventually added it must change this test deliberately, which
//! is exactly the review gate we want.

use crate::ipc::commands::{MUTATING_VERBS, READ_ONLY_ROSTER};

/// Files that are allowed to *mention* mutating verbs because they are the guard itself
/// or declare the verb list it scans for.
const GUARD_EXEMPT: &[&str] = &["readonly.rs", "commands.rs"];

/// Scan Rust sources under `src/` for forbidden mutating calls.
pub fn scan_for_mutations(root: &std::path::Path) -> Vec<String> {
    let mut findings = Vec::new();
    let mut stack = vec![root.to_path_buf()];

    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            if path.extension().and_then(|e| e.to_str()) != Some("rs") {
                continue;
            }
            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or_default()
                .to_string();
            if GUARD_EXEMPT.contains(&name.as_str()) {
                continue;
            }
            let Ok(source) = std::fs::read_to_string(&path) else {
                continue;
            };
            for (line_no, line) in source.lines().enumerate() {
                // Tests may exercise classification logic without performing writes.
                if line.trim_start().starts_with("//") {
                    continue;
                }
                for verb in MUTATING_VERBS {
                    if line.contains(verb) {
                        findings.push(format!(
                            "{}:{} contains mutating verb '{}': {}",
                            path.display(),
                            line_no + 1,
                            verb,
                            line.trim()
                        ));
                    }
                }
            }
        }
    }
    findings
}

pub fn assert_read_only_roster(names: &[String]) {
    for name in names {
        assert!(
            READ_ONLY_ROSTER.contains(&name.as_str()),
            "command '{name}' is not on the read-only roster; mutating commands are not allowed"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::commands::command_names;

    fn backend_src() -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src")
    }

    #[test]
    fn backend_sources_have_no_mutating_kube_calls() {
        let findings = scan_for_mutations(&backend_src());
        assert!(
            findings.is_empty(),
            "read-only guarantee violated:\n{}",
            findings.join("\n")
        );
    }

    #[test]
    fn every_declared_command_is_on_read_only_roster() {
        assert_read_only_roster(&command_names());
    }

    #[test]
    fn scan_detects_a_planted_mutation() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("evil.rs");
        std::fs::write(
            &file,
            "fn go(api: &Api<Pod>) { let _ = api.delete(\"x\", &Default::default()); }\n",
        )
        .unwrap();
        let findings = scan_for_mutations(dir.path());
        assert_eq!(findings.len(), 1, "{findings:?}");
        assert!(findings[0].contains(".delete("));
    }

    #[test]
    fn scan_ignores_comments() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("ok.rs"),
            "// never call .delete() here\nfn a() {}\n",
        )
        .unwrap();
        assert!(scan_for_mutations(dir.path()).is_empty());
    }

    #[test]
    fn non_roster_command_is_rejected() {
        let result = std::panic::catch_unwind(|| {
            assert_read_only_roster(&["delete_pod".to_string()]);
        });
        assert!(result.is_err());
    }
}
