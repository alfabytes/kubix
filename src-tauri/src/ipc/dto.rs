use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::config::{AuthKind, ContextDescriptor};

pub type ContextId = String;
/// `"group/version/resource"` with group empty for core: `"/v1/pods"`.
pub type GroupVersionResource = String;
/// Empty string means all namespaces.
pub type Namespace = String;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ConnectionState {
    Disconnected,
    Connecting,
    Ready,
    AuthRequired,
    AuthFailed,
    Unreachable,
    Forbidden,
    Degraded,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ClusterContextDto {
    pub id: ContextId,
    pub name: String,
    pub cluster_name: String,
    pub server: String,
    pub namespace_default: String,
    pub auth_kind: AuthKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth_hint: Option<String>,
    pub is_current: bool,
    pub state: ConnectionState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<crate::error::KubixErrorDto>,
    pub issues: Vec<String>,
}

impl ClusterContextDto {
    pub fn from_descriptor(d: &ContextDescriptor, state: ConnectionState) -> Self {
        ClusterContextDto {
            id: d.id.clone(),
            name: d.name.clone(),
            cluster_name: d.cluster_name.clone(),
            server: d.server.clone(),
            namespace_default: d.namespace_default.clone(),
            auth_kind: d.auth.kind,
            auth_hint: d.auth.hint.clone(),
            is_current: d.is_current,
            state,
            last_error: None,
            issues: d.issues.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredResourceDto {
    pub gvr: GroupVersionResource,
    pub kind: String,
    pub group: String,
    pub version: String,
    pub plural: String,
    pub namespaced: bool,
    pub short_names: Vec<String>,
    pub verbs: Vec<String>,
    pub curated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ResourceSummaryDto {
    pub uid: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub namespace: Option<String>,
    pub kind: String,
    pub created_at: String,
    pub labels: std::collections::BTreeMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ready: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub restarts: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub controlled_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub taints: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ResourceManifestDto {
    pub context_id: ContextId,
    pub gvr: GroupVersionResource,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub namespace: Option<String>,
    pub yaml: String,
    pub masked_paths: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PodLogChunkDto {
    pub pod_name: String,
    pub container_name: String,
    pub logs: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PodLogsDto {
    pub context_id: ContextId,
    pub gvr: GroupVersionResource,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub namespace: Option<String>,
    pub pods: Vec<String>,
    pub containers: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub init_containers: Vec<String>,
    pub chunks: Vec<PodLogChunkDto>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ShellSessionDto {
    pub session_id: String,
    pub context_id: ContextId,
    pub namespace: String,
    pub pod_name: String,
    pub container: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ShellOutputDto {
    pub session_id: String,
    pub stream: String,
    pub data: String,
    pub closed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PortForwardDto {
    pub forward_id: String,
    pub context_id: ContextId,
    pub namespace: String,
    pub kind: String,
    pub name: String,
    pub target_pod: String,
    pub remote_port: u16,
    pub local_port: u16,
    pub local_url: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ClusterNodeOverviewDto {
    pub name: String,
    pub ready: bool,
    pub kubelet_version: String,
    pub roles: String,
    pub cpu_capacity: String,
    pub memory_capacity: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cpu_capacity_millicores: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory_capacity_mib: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cpu_usage_millicores: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory_usage_mib: Option<f64>,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ClusterEventDto {
    pub uid: String,
    pub event_type: String,
    pub reason: String,
    pub involved_object: String,
    pub namespace: String,
    pub from: String,
    pub message: String,
    pub count: u32,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ClusterOverviewDto {
    pub context_id: ContextId,
    pub ready_nodes: u32,
    pub total_nodes: u32,
    pub namespace_count: u32,
    pub running_pods: u32,
    pub total_pods: u32,
    pub healthy_deployments: u32,
    pub total_deployments: u32,
    #[serde(default)]
    pub metrics_server_available: bool,
    pub nodes: Vec<ClusterNodeOverviewDto>,
    pub recent_events: Vec<ClusterEventDto>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LogStreamSessionDto {
    pub stream_id: String,
    pub pods: Vec<String>,
    pub containers: Vec<String>,
    #[serde(default)]
    pub init_containers: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PodLogLineDto {
    pub stream_id: String,
    pub pod_name: String,
    pub container_name: String,
    pub line: String,
    pub closed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SecurityFindingDto {
    pub id: String,
    pub severity: String,
    pub category: String,
    pub check_name: String,
    pub namespace: String,
    pub pod_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub container_name: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ClusterSecurityAuditDto {
    pub context_id: ContextId,
    pub scanned_pods: u32,
    pub scanned_containers: u32,
    pub critical_count: u32,
    pub high_count: u32,
    pub medium_count: u32,
    pub low_count: u32,
    pub findings: Vec<SecurityFindingDto>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ContainerMetricDto {
    pub name: String,
    pub cpu_millicores: f64,
    pub memory_mib: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ResourceMetricsDto {
    pub context_id: ContextId,
    pub metrics_server_available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_message: Option<String>,
    pub timestamp: String,
    pub window_seconds: u32,
    pub total_cpu_millicores: f64,
    pub total_memory_mib: f64,
    pub pod_count: u32,
    pub containers: Vec<ContainerMetricDto>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ResourceDeletionDto {
    pub uid: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ResourceDeltaDto {
    pub context_id: ContextId,
    pub gvr: GroupVersionResource,
    pub namespace: Namespace,
    pub batch_id: u64,
    pub upserts: Vec<ResourceSummaryDto>,
    pub deletions: Vec<ResourceDeletionDto>,
    pub truncated: bool,
    /// True when this batch is the authoritative result of a watcher snapshot; the UI
    /// replaces its rows instead of merging them.
    pub is_snapshot: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WatchEvictedDto {
    pub context_id: ContextId,
    pub gvr: GroupVersionResource,
    pub namespace: Namespace,
}

// ---- command argument shapes -------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ContextArgs {
    pub context_id: ContextId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListResourcesArgs {
    pub context_id: ContextId,
    pub gvr: GroupVersionResource,
    pub namespace: Namespace,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StopWatchArgs {
    pub context_id: ContextId,
    pub gvr: GroupVersionResource,
    pub namespace: Namespace,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GetResourceArgs {
    pub context_id: ContextId,
    pub gvr: GroupVersionResource,
    pub name: String,
    #[serde(default)]
    pub namespace: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GetPodLogsArgs {
    pub context_id: ContextId,
    pub gvr: GroupVersionResource,
    pub name: String,
    #[serde(default)]
    pub namespace: Option<String>,
    #[serde(default)]
    pub container: Option<String>,
    #[serde(default)]
    pub tail_lines: Option<i64>,
    #[serde(default)]
    pub previous: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StartShellArgs {
    pub context_id: ContextId,
    pub namespace: String,
    pub pod_name: String,
    #[serde(default)]
    pub container: Option<String>,
    #[serde(default)]
    pub cols: Option<u16>,
    #[serde(default)]
    pub rows: Option<u16>,
    #[serde(default)]
    pub command: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ShellInputArgs {
    pub session_id: String,
    pub data: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ShellResizeArgs {
    pub session_id: String,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CloseShellArgs {
    pub session_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StartPortForwardArgs {
    pub context_id: ContextId,
    pub namespace: String,
    pub kind: String,
    pub name: String,
    pub remote_port: u16,
    #[serde(default)]
    pub local_port: Option<u16>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StopPortForwardArgs {
    pub forward_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StartLogStreamArgs {
    pub context_id: ContextId,
    pub gvr: GroupVersionResource,
    pub name: String,
    #[serde(default)]
    pub namespace: Option<String>,
    #[serde(default)]
    pub container: Option<String>,
    #[serde(default)]
    pub tail_lines: Option<i64>,
    #[serde(default)]
    pub previous: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StopLogStreamArgs {
    pub stream_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GetNamespaceTopologyArgs {
    pub context_id: ContextId,
    #[serde(default)]
    pub namespace: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TopologyDetailDto {
    pub label: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TopologyNodeDto {
    pub id: String,
    pub kind: String,
    pub gvr: GroupVersionResource,
    pub name: String,
    pub namespace: String,
    /// Layout column category: "entry" | "routing" | "service" | "workload" | "pod" | "aux"
    pub layer: String,
    pub status: String,
    #[serde(default)]
    pub external: bool,
    #[serde(default)]
    pub subtitle: Option<String>,
    #[serde(default)]
    pub pod_count: Option<u32>,
    #[serde(default)]
    pub ready_pod_count: Option<u32>,
    #[serde(default)]
    pub parent_workload_id: Option<String>,
    #[serde(default)]
    pub details: Vec<TopologyDetailDto>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TopologyEdgeDto {
    pub id: String,
    pub from: String,
    pub to: String,
    pub label: String,
    #[serde(default)]
    pub cross_namespace: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NamespaceTopologyDto {
    pub context_id: ContextId,
    pub namespace: String,
    pub gateway_api_detected: bool,
    #[serde(default)]
    pub gateway_api_kinds: Vec<String>,
    pub nodes: Vec<TopologyNodeDto>,
    pub edges: Vec<TopologyEdgeDto>,
}

// ---- helpers other modules share --------------------------------------------

pub fn gvr_string(group: &str, version: &str, plural: &str) -> GroupVersionResource {
    format!("{group}/{version}/{plural}")
}

/// Split a `group/version/plural` string. Core group is the empty string.
pub fn parse_gvr(gvr: &str) -> Option<(&str, &str, &str)> {
    let mut parts = gvr.splitn(3, '/');
    let group = parts.next()?;
    let version = parts.next()?;
    let plural = parts.next()?;
    if version.is_empty() || plural.is_empty() {
        return None;
    }
    Some((group, version, plural))
}

pub fn display_name_for(path: &Path) -> String {
    path.file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gvr_roundtrip_core_group() {
        let s = gvr_string("", "v1", "pods");
        assert_eq!(s, "/v1/pods");
        assert_eq!(parse_gvr(&s), Some(("", "v1", "pods")));
    }

    #[test]
    fn gvr_roundtrip_named_group() {
        let s = gvr_string("apps", "v1", "deployments");
        assert_eq!(s, "apps/v1/deployments");
        assert_eq!(parse_gvr(&s), Some(("apps", "v1", "deployments")));
    }

    #[test]
    fn parse_gvr_rejects_incomplete() {
        assert_eq!(parse_gvr("/v1"), None);
        assert_eq!(parse_gvr("/v1/"), None);
        assert_eq!(parse_gvr("apps/v1/"), None);
    }

    #[test]
    fn connection_state_serializes_camel_case() {
        let json = serde_json::to_string(&ConnectionState::AuthRequired).unwrap();
        assert_eq!(json, "\"authRequired\"");
        let json = serde_json::to_string(&ConnectionState::Unreachable).unwrap();
        assert_eq!(json, "\"unreachable\"");
    }

    #[test]
    fn summary_omits_absent_optionals() {
        let s = ResourceSummaryDto {
            uid: "u".into(),
            name: "n".into(),
            namespace: None,
            kind: "Pod".into(),
            created_at: "2026-01-01T00:00:00Z".into(),
            labels: Default::default(),
            status: None,
            ready: None,
            restarts: None,
            controlled_by: None,
            node: None,
            message: None,
            taints: None,
        };
        let json = serde_json::to_string(&s).unwrap();
        assert!(!json.contains("namespace"));
        assert!(!json.contains("status"));
        assert!(json.contains("\"createdAt\""));
    }
}
