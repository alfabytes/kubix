use std::collections::{BTreeMap, BTreeSet};

use serde_json::{json, Value};

use super::{commands, dto, events};
use crate::error::KubixErrorDto;

/// Build the machine-readable IPC contract. This is the single source of truth that
/// the TypeScript mirror in `src/lib/ipc/` must agree with.
pub fn contract() -> Value {
    let mut schemas: BTreeMap<String, Value> = BTreeMap::new();
    macro_rules! add {
        ($ty:ty, $name:literal) => {
            schemas.insert(
                $name.to_string(),
                serde_json::to_value(schemars::schema_for!($ty)).expect("schema"),
            );
        };
    }

    add!(dto::ContextId, "ContextId");
    add!(dto::GroupVersionResource, "GroupVersionResource");
    add!(dto::Namespace, "Namespace");
    add!(dto::ConnectionState, "ConnectionState");
    add!(crate::config::AuthKind, "AuthKind");
    add!(dto::ClusterContextDto, "ClusterContextDto");
    add!(dto::DiscoveredResourceDto, "DiscoveredResourceDto");
    add!(dto::ResourceSummaryDto, "ResourceSummaryDto");
    add!(dto::ResourceManifestDto, "ResourceManifestDto");
    add!(dto::PodLogChunkDto, "PodLogChunkDto");
    add!(dto::PodLogsDto, "PodLogsDto");
    add!(dto::LogStreamSessionDto, "LogStreamSessionDto");
    add!(dto::PodLogLineDto, "PodLogLineDto");
    add!(dto::ShellSessionDto, "ShellSessionDto");
    add!(dto::ShellOutputDto, "ShellOutputDto");
    add!(dto::PortForwardDto, "PortForwardDto");
    add!(dto::ClusterNodeOverviewDto, "ClusterNodeOverviewDto");
    add!(dto::ClusterEventDto, "ClusterEventDto");
    add!(dto::ClusterOverviewDto, "ClusterOverviewDto");
    add!(dto::SecurityFindingDto, "SecurityFindingDto");
    add!(dto::ClusterSecurityAuditDto, "ClusterSecurityAuditDto");
    add!(dto::ContainerMetricDto, "ContainerMetricDto");
    add!(dto::ResourceMetricsDto, "ResourceMetricsDto");
    add!(dto::TopologyDetailDto, "TopologyDetailDto");
    add!(dto::TopologyNodeDto, "TopologyNodeDto");
    add!(dto::TopologyEdgeDto, "TopologyEdgeDto");
    add!(dto::NamespaceTopologyDto, "NamespaceTopologyDto");
    add!(dto::ResourceDeletionDto, "ResourceDeletionDto");
    add!(dto::ResourceDeltaDto, "ResourceDeltaDto");
    add!(dto::WatchEvictedDto, "WatchEvictedDto");
    add!(KubixErrorDto, "KubixErrorDto");
    add!(crate::error::ErrorCode, "ErrorCode");
    add!(dto::ContextArgs, "ContextArgs");
    add!(dto::ListResourcesArgs, "ListResourcesArgs");
    add!(dto::StopWatchArgs, "StopWatchArgs");
    add!(dto::GetResourceArgs, "GetResourceArgs");
    add!(dto::GetPodLogsArgs, "GetPodLogsArgs");
    add!(dto::StartLogStreamArgs, "StartLogStreamArgs");
    add!(dto::StopLogStreamArgs, "StopLogStreamArgs");
    add!(dto::StartShellArgs, "StartShellArgs");
    add!(dto::ShellInputArgs, "ShellInputArgs");
    add!(dto::ShellResizeArgs, "ShellResizeArgs");
    add!(dto::CloseShellArgs, "CloseShellArgs");
    add!(dto::StartPortForwardArgs, "StartPortForwardArgs");
    add!(dto::StopPortForwardArgs, "StopPortForwardArgs");
    add!(dto::GetNamespaceTopologyArgs, "GetNamespaceTopologyArgs");

    let commands: Value = commands::COMMANDS
        .iter()
        .map(|c| {
            json!({
                "name": c.name,
                "readOnly": c.read_only,
                "args": c.args,
                "returns": c.returns,
            })
        })
        .collect();

    let events: Value = events::EVENTS
        .iter()
        .map(|e| json!({ "name": e.name, "payload": e.payload }))
        .collect();

    json!({
        "version": 1,
        "commands": commands,
        "events": events,
        "schemas": schemas,
    })
}

pub fn contract_json() -> String {
    let mut out = serde_json::to_string_pretty(&contract()).expect("contract serializes");
    out.push('\n');
    out
}

/// All property names declared by every DTO schema. Used by the drift check to verify
/// the TypeScript mirror exposes exactly these fields.
pub fn all_property_names() -> BTreeSet<String> {
    let mut names = BTreeSet::new();
    let contract = contract();
    if let Some(schemas) = contract.get("schemas").and_then(Value::as_object) {
        for schema in schemas.values() {
            collect_property_names(schema, &mut names);
        }
    }
    names
}

fn collect_property_names(schema: &Value, out: &mut BTreeSet<String>) {
    if let Some(properties) = schema.get("properties").and_then(Value::as_object) {
        for name in properties.keys() {
            out.insert(name.clone());
        }
    }
    for defs_key in ["definitions", "$defs"] {
        if let Some(defs) = schema.get(defs_key).and_then(Value::as_object) {
            for def in defs.values() {
                collect_property_names(def, out);
            }
        }
    }
    if let Some(items) = schema.get("items") {
        collect_property_names(items, out);
    }
    for key in ["anyOf", "oneOf", "allOf"] {
        if let Some(branches) = schema.get(key).and_then(Value::as_array) {
            for branch in branches {
                collect_property_names(branch, out);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn contract_has_version_and_sections() {
        let c = contract();
        assert_eq!(c["version"], 1);
        assert!(c["commands"].as_array().is_some_and(|a| !a.is_empty()));
        assert!(c["events"].as_array().is_some_and(|a| !a.is_empty()));
        assert!(c["schemas"].as_object().is_some_and(|o| o.len() > 10));
    }

    #[test]
    fn contract_json_is_stable() {
        assert_eq!(contract_json(), contract_json());
    }

    #[test]
    fn every_command_name_is_snake_case() {
        for cmd in commands::COMMANDS {
            assert_eq!(cmd.name, cmd.name.to_lowercase(), "{}", cmd.name);
            assert!(!cmd.name.contains('-'), "{}", cmd.name);
        }
    }

    #[test]
    fn property_names_are_camel_case() {
        for name in all_property_names() {
            assert!(
                !name.contains('_'),
                "IPC property '{name}' leaks snake_case to the frontend"
            );
        }
    }
}
