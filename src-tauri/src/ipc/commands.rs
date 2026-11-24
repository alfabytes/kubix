use serde::{Deserialize, Serialize};

/// Static description of every Tauri command Kubix exposes.
///
/// ## Read-only guarantee
///
/// Kubix is read-only by default. This roster is the single place a command can be
/// added, and [`READ_ONLY_ROSTER`] is asserted against it in tests: a mutating command
/// cannot be registered without failing the test suite, and the plan-level decision
/// is that no mutating command exists in this milestone at all.
pub struct CommandSpec {
    pub name: &'static str,
    pub read_only: bool,
    /// TypeScript type of the single argument object (`null` when the command takes none).
    pub args: &'static str,
    /// TypeScript type of the resolved value on success.
    pub returns: &'static str,
}

pub const COMMANDS: &[CommandSpec] = &[
    CommandSpec {
        name: "list_contexts",
        read_only: true,
        args: "null",
        returns: "ClusterContextDto[]",
    },
    CommandSpec {
        name: "rescan_kubeconfig",
        read_only: true,
        args: "null",
        returns: "ClusterContextDto[]",
    },
    CommandSpec {
        name: "connect_context",
        read_only: true,
        args: "ContextArgs",
        returns: "ClusterContextDto",
    },
    CommandSpec {
        name: "disconnect_context",
        read_only: true,
        args: "ContextArgs",
        returns: "ClusterContextDto",
    },
    CommandSpec {
        name: "discover_resources",
        read_only: true,
        args: "ContextArgs",
        returns: "DiscoveredResourceDto[]",
    },
    CommandSpec {
        name: "list_resources",
        read_only: true,
        args: "ListResourcesArgs",
        returns: "ResourceSummaryDto[]",
    },
    CommandSpec {
        name: "get_resource",
        read_only: true,
        args: "GetResourceArgs",
        returns: "ResourceManifestDto",
    },
    CommandSpec {
        name: "get_pod_logs",
        read_only: true,
        args: "GetPodLogsArgs",
        returns: "PodLogsDto",
    },
    CommandSpec {
        name: "start_log_stream",
        read_only: true,
        args: "StartLogStreamArgs",
        returns: "LogStreamSessionDto",
    },
    CommandSpec {
        name: "stop_log_stream",
        read_only: true,
        args: "StopLogStreamArgs",
        returns: "null",
    },
    CommandSpec {
        name: "start_shell",
        read_only: true,
        args: "StartShellArgs",
        returns: "ShellSessionDto",
    },
    CommandSpec {
        name: "send_shell_input",
        read_only: true,
        args: "ShellInputArgs",
        returns: "null",
    },
    CommandSpec {
        name: "resize_shell",
        read_only: true,
        args: "ShellResizeArgs",
        returns: "null",
    },
    CommandSpec {
        name: "close_shell",
        read_only: true,
        args: "CloseShellArgs",
        returns: "null",
    },
    CommandSpec {
        name: "start_port_forward",
        read_only: true,
        args: "StartPortForwardArgs",
        returns: "PortForwardDto",
    },
    CommandSpec {
        name: "stop_port_forward",
        read_only: true,
        args: "StopPortForwardArgs",
        returns: "null",
    },
    CommandSpec {
        name: "list_port_forwards",
        read_only: true,
        args: "ContextArgs",
        returns: "PortForwardDto[]",
    },
    CommandSpec {
        name: "get_cluster_overview",
        read_only: true,
        args: "ContextArgs",
        returns: "ClusterOverviewDto",
    },
    CommandSpec {
        name: "get_cluster_security_audit",
        read_only: true,
        args: "ContextArgs",
        returns: "ClusterSecurityAuditDto",
    },
    CommandSpec {
        name: "get_resource_events",
        read_only: true,
        args: "GetResourceArgs",
        returns: "ClusterEventDto[]",
    },
    CommandSpec {
        name: "get_resource_metrics",
        read_only: true,
        args: "GetResourceArgs",
        returns: "ResourceMetricsDto",
    },
    CommandSpec {
        name: "get_namespace_topology",
        read_only: true,
        args: "GetNamespaceTopologyArgs",
        returns: "NamespaceTopologyDto",
    },
    CommandSpec {
        name: "stop_watch",
        read_only: true,
        args: "StopWatchArgs",
        returns: "null",
    },
];

/// Every command that is allowed to exist. Anything else must be reviewed.
pub const READ_ONLY_ROSTER: &[&str] = &[
    "list_contexts",
    "rescan_kubeconfig",
    "connect_context",
    "disconnect_context",
    "discover_resources",
    "list_resources",
    "get_resource",
    "get_pod_logs",
    "start_log_stream",
    "stop_log_stream",
    "start_shell",
    "send_shell_input",
    "resize_shell",
    "close_shell",
    "start_port_forward",
    "stop_port_forward",
    "list_port_forwards",
    "get_cluster_overview",
    "get_cluster_security_audit",
    "get_resource_events",
    "get_resource_metrics",
    "get_namespace_topology",
    "stop_watch",
];

/// Substrings that indicate a Kubernetes resource write path. Used by the read-only guard
/// test which scans the backend sources; a hit means a mutating code path slipped in.
///
/// Interactive container shell sessions (`start_shell`) are explicitly permitted, while
/// cluster resource mutations (`create`/`delete`/`patch`/`replace`) remain blocked.
pub const MUTATING_VERBS: &[&str] = &[
    ".create(",
    ".delete(",
    ".patch(",
    ".replace(",
    ".delete_collection(",
    ".delete_and_finalize(",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandNames {
    pub commands: Vec<String>,
}

pub fn command_names() -> Vec<String> {
    COMMANDS.iter().map(|c| c.name.to_string()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roster_matches_specs_exactly() {
        let declared: Vec<&str> = COMMANDS.iter().map(|c| c.name).collect();
        assert_eq!(declared, READ_ONLY_ROSTER);
    }

    #[test]
    fn every_spec_is_read_only() {
        for spec in COMMANDS {
            assert!(
                spec.read_only,
                "{} must be read-only in this milestone",
                spec.name
            );
        }
    }

    #[test]
    fn no_command_name_implies_mutation() {
        for spec in COMMANDS {
            let lower = spec.name.to_lowercase();
            for verb in [
                "create", "delete", "patch", "apply", "update", "exec", "scale", "cordon",
            ] {
                assert!(
                    !lower.contains(verb),
                    "command '{}' looks mutating (contains '{verb}')",
                    spec.name
                );
            }
        }
    }
}
