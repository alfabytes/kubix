//! Live namespace topology builder (Gateway API + Ingress + Services + Workloads + Pods + HPA + PVC).

use std::collections::HashMap;

use kube::core::DynamicObject;
use kube::Api;
use serde_json::Value;
use tauri::State;

use super::{map_err, resolve_discovery, AppState, CommandResult};
use crate::discovery::ApiResourceEntry;
use crate::error::KubixError;
use crate::ipc::dto::{
    GetNamespaceTopologyArgs, NamespaceTopologyDto, TopologyDetailDto, TopologyEdgeDto,
    TopologyNodeDto,
};

pub(super) struct NamespaceTopologyInput {
    pub(super) context_id: String,
    pub(super) namespace: String,
    pub(super) gateway_api_detected: bool,
    pub(super) gateway_api_kinds: Vec<String>,
    pub(super) gateway_gvr: Option<String>,
    pub(super) ingresses: Vec<k8s_openapi::api::networking::v1::Ingress>,
    pub(super) services: Vec<k8s_openapi::api::core::v1::Service>,
    pub(super) deployments: Vec<k8s_openapi::api::apps::v1::Deployment>,
    pub(super) statefulsets: Vec<k8s_openapi::api::apps::v1::StatefulSet>,
    pub(super) daemonsets: Vec<k8s_openapi::api::apps::v1::DaemonSet>,
    pub(super) replicasets: Vec<k8s_openapi::api::apps::v1::ReplicaSet>,
    pub(super) jobs: Vec<k8s_openapi::api::batch::v1::Job>,
    pub(super) pods: Vec<k8s_openapi::api::core::v1::Pod>,
    pub(super) hpas: Vec<k8s_openapi::api::autoscaling::v2::HorizontalPodAutoscaler>,
    pub(super) pvcs: Vec<k8s_openapi::api::core::v1::PersistentVolumeClaim>,
    /// `(gvr, object)` for Gateway API `Gateway` objects (including fetched cross-namespace parents).
    pub(super) gateways: Vec<(String, DynamicObject)>,
    /// `(kind, gvr, object)` for Gateway API route objects (`HTTPRoute`, `GRPCRoute`, `TLSRoute`, `TCPRoute`).
    pub(super) routes: Vec<(String, String, DynamicObject)>,
    /// `(gvr, object)` for optional cert-manager `Certificate` objects.
    pub(super) certificates: Vec<(String, DynamicObject)>,
    /// Lookup from `(api_version_or_group_or_empty, kind)` -> discovered GVR for resolving Operator CRs.
    pub(super) discovered_gvrs: HashMap<(String, String), String>,
}

fn is_builtin_owner_kind(kind: &str) -> bool {
    matches!(
        kind,
        "ReplicaSet"
            | "Deployment"
            | "StatefulSet"
            | "DaemonSet"
            | "Job"
            | "CronJob"
            | "Node"
            | "Pod"
            | "ReplicationController"
    )
}

fn resolve_owner_gvr(
    discovered_gvrs: &HashMap<(String, String), String>,
    api_version: &str,
    kind: &str,
) -> String {
    if let Some(gvr) = discovered_gvrs.get(&(api_version.to_string(), kind.to_string())) {
        return gvr.clone();
    }
    let group = api_version.split_once('/').map(|(g, _)| g).unwrap_or("");
    if !group.is_empty() {
        if let Some(gvr) = discovered_gvrs.get(&(group.to_string(), kind.to_string())) {
            return gvr.clone();
        }
    }
    if let Some(gvr) = discovered_gvrs.get(&(String::new(), kind.to_string())) {
        return gvr.clone();
    }
    let plural = format!("{}s", kind.to_lowercase());
    if let Some((g, v)) = api_version.split_once('/') {
        format!("{g}/{v}/{plural}")
    } else if !api_version.is_empty() {
        format!("/{api_version}/{plural}")
    } else {
        format!("/v1/{plural}")
    }
}

fn upsert_tls_secret_node(
    nodes: &mut std::collections::BTreeMap<String, TopologyNodeDto>,
    input_ns: &str,
    secret_ns: &str,
    secret_name: &str,
) -> String {
    let secret_id = topo_node_id("Secret", secret_ns, secret_name);
    let external = !input_ns.is_empty() && secret_ns != input_ns;
    nodes
        .entry(secret_id.clone())
        .or_insert_with(|| TopologyNodeDto {
            id: secret_id.clone(),
            kind: "Secret".to_string(),
            gvr: "/v1/secrets".to_string(),
            name: secret_name.to_string(),
            namespace: secret_ns.to_string(),
            layer: "routing".to_string(),
            status: "Ready".to_string(),
            external,
            subtitle: Some("TLS Secret (masked)".to_string()),
            pod_count: None,
            ready_pod_count: None,
            parent_workload_id: None,
            details: vec![
                TopologyDetailDto {
                    label: "Type".to_string(),
                    value: "TLS Secret".to_string(),
                },
                TopologyDetailDto {
                    label: "Namespace".to_string(),
                    value: secret_ns.to_string(),
                },
            ],
        });
    secret_id
}

fn extract_certificate_status(obj: &DynamicObject) -> String {
    if let Some(conds) = obj
        .data
        .get("status")
        .and_then(|s| s.get("conditions"))
        .and_then(Value::as_array)
    {
        if let Some(ready) = conds
            .iter()
            .find(|c| c.get("type").and_then(Value::as_str) == Some("Ready"))
        {
            return match ready.get("status").and_then(Value::as_str) {
                Some("True") => "Ready".to_string(),
                Some("False") => "Error".to_string(),
                _ => "Warning".to_string(),
            };
        }
    }
    "Active".to_string()
}

fn attach_operator_owners(
    nodes: &mut std::collections::BTreeMap<String, TopologyNodeDto>,
    edges: &mut std::collections::BTreeMap<(String, String), (Vec<String>, bool)>,
    discovered_gvrs: &HashMap<(String, String), String>,
    owners: Option<&Vec<k8s_openapi::apimachinery::pkg::apis::meta::v1::OwnerReference>>,
    ns: &str,
    child_id: &str,
) {
    let Some(owners) = owners else {
        return;
    };
    for owner in owners {
        if owner.kind.is_empty() || owner.name.is_empty() || is_builtin_owner_kind(&owner.kind) {
            continue;
        }
        let cr_id = topo_node_id(&owner.kind, ns, &owner.name);
        let gvr = resolve_owner_gvr(discovered_gvrs, &owner.api_version, &owner.kind);
        nodes
            .entry(cr_id.clone())
            .or_insert_with(|| TopologyNodeDto {
                id: cr_id.clone(),
                kind: owner.kind.clone(),
                gvr,
                name: owner.name.clone(),
                namespace: ns.to_string(),
                layer: "operator".to_string(),
                status: "Active".to_string(),
                external: false,
                subtitle: Some(owner.api_version.clone()),
                pod_count: None,
                ready_pod_count: None,
                parent_workload_id: None,
                details: vec![
                    TopologyDetailDto {
                        label: "API".to_string(),
                        value: owner.api_version.clone(),
                    },
                    TopologyDetailDto {
                        label: "Role".to_string(),
                        value: "Operator CR".to_string(),
                    },
                ],
            });
        push_edge(
            edges,
            cr_id,
            child_id.to_string(),
            "manages".to_string(),
            false,
        );
    }
}

fn topo_node_id(kind: &str, namespace: &str, name: &str) -> String {
    format!("{kind}/{namespace}/{name}")
}

fn selector_matches_labels(
    selector: &std::collections::BTreeMap<String, String>,
    labels: &std::collections::BTreeMap<String, String>,
) -> bool {
    if selector.is_empty() {
        return false;
    }
    selector
        .iter()
        .all(|(k, v)| labels.get(k).map(String::as_str) == Some(v.as_str()))
}

fn push_edge(
    edges: &mut std::collections::BTreeMap<(String, String), (Vec<String>, bool)>,
    from: String,
    to: String,
    label: String,
    cross_namespace: bool,
) {
    if from == to {
        return;
    }
    let entry = edges
        .entry((from, to))
        .or_insert_with(|| (Vec::new(), cross_namespace));
    entry.1 = entry.1 || cross_namespace;
    if !label.is_empty() && !entry.0.contains(&label) {
        entry.0.push(label);
    }
}

fn gateway_version_rank(version: &str) -> u8 {
    match version {
        "v1" => 3,
        "v1beta1" => 2,
        "v1alpha2" => 1,
        _ => 0,
    }
}

fn pod_is_ready(pod: &k8s_openapi::api::core::v1::Pod) -> bool {
    let Some(status) = pod.status.as_ref() else {
        return false;
    };
    if let Some(conds) = status.conditions.as_ref() {
        if let Some(ready) = conds.iter().find(|c| c.type_ == "Ready") {
            return ready.status == "True";
        }
    }
    status.phase.as_deref() == Some("Running")
}

fn pod_status_label(pod: &k8s_openapi::api::core::v1::Pod) -> String {
    let Some(status) = pod.status.as_ref() else {
        return "Pending".to_string();
    };
    if let Some(cs_list) = status.container_statuses.as_ref() {
        for cs in cs_list {
            if let Some(waiting) = cs.state.as_ref().and_then(|s| s.waiting.as_ref()) {
                if let Some(reason) = waiting.reason.as_deref() {
                    if reason.contains("Crash")
                        || reason.contains("Err")
                        || reason.contains("BackOff")
                    {
                        return "Error".to_string();
                    }
                    return "Warning".to_string();
                }
            }
        }
    }
    match status.phase.as_deref() {
        Some("Running") => {
            if pod_is_ready(pod) {
                "Running".to_string()
            } else {
                "Warning".to_string()
            }
        }
        Some("Succeeded") => "Ready".to_string(),
        Some("Failed") => "Error".to_string(),
        Some("Pending") => "Warning".to_string(),
        _ => "Active".to_string(),
    }
}

fn extract_gateway_status(obj: &DynamicObject) -> String {
    if let Some(conds) = obj
        .data
        .get("status")
        .and_then(|s| s.get("conditions"))
        .and_then(Value::as_array)
    {
        for kind in ["Programmed", "Accepted", "Ready"] {
            if let Some(c) = conds
                .iter()
                .find(|c| c.get("type").and_then(Value::as_str) == Some(kind))
            {
                return match c.get("status").and_then(Value::as_str) {
                    Some("True") => "Ready".to_string(),
                    Some("False") => "Error".to_string(),
                    _ => "Warning".to_string(),
                };
            }
        }
    }
    "Active".to_string()
}

fn extract_route_status(obj: &DynamicObject) -> String {
    if let Some(parents) = obj
        .data
        .get("status")
        .and_then(|s| s.get("parents"))
        .and_then(Value::as_array)
    {
        let mut saw_accepted = false;
        for parent in parents {
            if let Some(conds) = parent.get("conditions").and_then(Value::as_array) {
                for cond in conds {
                    let ctype = cond.get("type").and_then(Value::as_str).unwrap_or("");
                    let cstatus = cond.get("status").and_then(Value::as_str).unwrap_or("");
                    if (ctype == "Accepted" || ctype == "ResolvedRefs") && cstatus == "False" {
                        return "Error".to_string();
                    }
                    if ctype == "Accepted" && cstatus == "True" {
                        saw_accepted = true;
                    }
                }
            }
        }
        if saw_accepted {
            return "Ready".to_string();
        }
    }
    "Active".to_string()
}

pub(super) fn build_namespace_topology(input: NamespaceTopologyInput) -> NamespaceTopologyDto {
    let mut nodes: std::collections::BTreeMap<String, TopologyNodeDto> =
        std::collections::BTreeMap::new();
    let mut edges: std::collections::BTreeMap<(String, String), (Vec<String>, bool)> =
        std::collections::BTreeMap::new();

    let default_gateway_gvr = input
        .gateway_gvr
        .clone()
        .unwrap_or_else(|| "gateway.networking.k8s.io/v1/gateways".to_string());

    // 1. ReplicaSet -> Deployment ownership lookup
    let mut rs_to_deploy: HashMap<(String, String), String> = HashMap::new();
    for rs in &input.replicasets {
        let rs_name = rs.metadata.name.clone().unwrap_or_default();
        let rs_ns = rs
            .metadata
            .namespace
            .clone()
            .unwrap_or_else(|| "default".to_string());
        if rs_name.is_empty() {
            continue;
        }
        if let Some(owner) = rs
            .metadata
            .owner_references
            .as_ref()
            .and_then(|refs| refs.iter().find(|r| r.kind == "Deployment"))
        {
            rs_to_deploy.insert(
                (rs_ns.clone(), rs_name),
                topo_node_id("Deployment", &rs_ns, &owner.name),
            );
        }
    }

    // Track workload template labels & PVC claims for selector/mount edges
    let mut workload_template_labels: Vec<(
        String,
        String,
        std::collections::BTreeMap<String, String>,
    )> = Vec::new();
    let mut workload_pvcs: Vec<(String, String, Vec<String>)> = Vec::new();

    // 2. Workloads: Deployments, StatefulSets, DaemonSets, Jobs
    for dep in &input.deployments {
        let name = dep.metadata.name.clone().unwrap_or_default();
        if name.is_empty() {
            continue;
        }
        let ns = dep
            .metadata
            .namespace
            .clone()
            .unwrap_or_else(|| "default".to_string());
        let id = topo_node_id("Deployment", &ns, &name);
        let desired = dep
            .spec
            .as_ref()
            .and_then(|s| s.replicas)
            .unwrap_or(1)
            .max(0) as u32;
        let ready = dep
            .status
            .as_ref()
            .and_then(|s| s.ready_replicas)
            .unwrap_or(0)
            .max(0) as u32;
        let status = if desired == 0 || ready >= desired {
            "Running"
        } else {
            "Warning"
        };
        let mut details = vec![TopologyDetailDto {
            label: "Replicas".to_string(),
            value: format!("{ready}/{desired} ready"),
        }];
        if let Some(tpl) = dep.spec.as_ref().map(|s| &s.template) {
            if let Some(labels) = tpl.metadata.as_ref().and_then(|m| m.labels.as_ref()) {
                workload_template_labels.push((id.clone(), ns.clone(), labels.clone()));
            }
            if let Some(spec) = tpl.spec.as_ref() {
                if let Some(first_c) = spec.containers.first() {
                    if let Some(img) = first_c.image.as_deref() {
                        details.push(TopologyDetailDto {
                            label: "Image".to_string(),
                            value: img.to_string(),
                        });
                    }
                }
                let claims: Vec<String> = spec
                    .volumes
                    .as_ref()
                    .into_iter()
                    .flatten()
                    .filter_map(|v| {
                        v.persistent_volume_claim
                            .as_ref()
                            .map(|p| p.claim_name.clone())
                    })
                    .collect();
                if !claims.is_empty() {
                    workload_pvcs.push((id.clone(), ns.clone(), claims));
                }
            }
        }
        nodes.insert(
            id.clone(),
            TopologyNodeDto {
                id: id.clone(),
                kind: "Deployment".to_string(),
                gvr: "apps/v1/deployments".to_string(),
                name,
                namespace: ns.clone(),
                layer: "workload".to_string(),
                status: status.to_string(),
                external: false,
                subtitle: Some(format!("{ready}/{desired} ready")),
                pod_count: Some(0),
                ready_pod_count: Some(0),
                parent_workload_id: None,
                details,
            },
        );
        attach_operator_owners(
            &mut nodes,
            &mut edges,
            &input.discovered_gvrs,
            dep.metadata.owner_references.as_ref(),
            &ns,
            &id,
        );
    }

    for sts in &input.statefulsets {
        let name = sts.metadata.name.clone().unwrap_or_default();
        if name.is_empty() {
            continue;
        }
        let ns = sts
            .metadata
            .namespace
            .clone()
            .unwrap_or_else(|| "default".to_string());
        let id = topo_node_id("StatefulSet", &ns, &name);
        let desired = sts
            .spec
            .as_ref()
            .and_then(|s| s.replicas)
            .unwrap_or(1)
            .max(0) as u32;
        let ready = sts
            .status
            .as_ref()
            .and_then(|s| s.ready_replicas)
            .unwrap_or(0)
            .max(0) as u32;
        let status = if desired == 0 || ready >= desired {
            "Running"
        } else {
            "Warning"
        };
        let mut details = vec![TopologyDetailDto {
            label: "Replicas".to_string(),
            value: format!("{ready}/{desired} ready"),
        }];
        if let Some(spec) = sts.spec.as_ref() {
            if let Some(labels) = spec
                .template
                .metadata
                .as_ref()
                .and_then(|m| m.labels.as_ref())
            {
                workload_template_labels.push((id.clone(), ns.clone(), labels.clone()));
            }
            if let Some(pspec) = spec.template.spec.as_ref() {
                if let Some(first_c) = pspec.containers.first() {
                    if let Some(img) = first_c.image.as_deref() {
                        details.push(TopologyDetailDto {
                            label: "Image".to_string(),
                            value: img.to_string(),
                        });
                    }
                }
                let claims: Vec<String> = pspec
                    .volumes
                    .as_ref()
                    .into_iter()
                    .flatten()
                    .filter_map(|v| {
                        v.persistent_volume_claim
                            .as_ref()
                            .map(|p| p.claim_name.clone())
                    })
                    .collect();
                if !claims.is_empty() {
                    workload_pvcs.push((id.clone(), ns.clone(), claims));
                }
            }
        }
        nodes.insert(
            id.clone(),
            TopologyNodeDto {
                id: id.clone(),
                kind: "StatefulSet".to_string(),
                gvr: "apps/v1/statefulsets".to_string(),
                name,
                namespace: ns.clone(),
                layer: "workload".to_string(),
                status: status.to_string(),
                external: false,
                subtitle: Some(format!("{ready}/{desired} ready")),
                pod_count: Some(0),
                ready_pod_count: Some(0),
                parent_workload_id: None,
                details,
            },
        );
        attach_operator_owners(
            &mut nodes,
            &mut edges,
            &input.discovered_gvrs,
            sts.metadata.owner_references.as_ref(),
            &ns,
            &id,
        );
    }

    for ds in &input.daemonsets {
        let name = ds.metadata.name.clone().unwrap_or_default();
        if name.is_empty() {
            continue;
        }
        let ns = ds
            .metadata
            .namespace
            .clone()
            .unwrap_or_else(|| "default".to_string());
        let id = topo_node_id("DaemonSet", &ns, &name);
        let desired = ds
            .status
            .as_ref()
            .map(|s| s.desired_number_scheduled.max(0) as u32)
            .unwrap_or(0);
        let ready = ds
            .status
            .as_ref()
            .map(|s| s.number_ready.max(0) as u32)
            .unwrap_or(0);
        let status = if desired == 0 || ready >= desired {
            "Running"
        } else {
            "Warning"
        };
        if let Some(spec) = ds.spec.as_ref() {
            if let Some(labels) = spec
                .template
                .metadata
                .as_ref()
                .and_then(|m| m.labels.as_ref())
            {
                workload_template_labels.push((id.clone(), ns.clone(), labels.clone()));
            }
        }
        nodes.insert(
            id.clone(),
            TopologyNodeDto {
                id: id.clone(),
                kind: "DaemonSet".to_string(),
                gvr: "apps/v1/daemonsets".to_string(),
                name,
                namespace: ns.clone(),
                layer: "workload".to_string(),
                status: status.to_string(),
                external: false,
                subtitle: Some(format!("{ready}/{desired} ready")),
                pod_count: Some(0),
                ready_pod_count: Some(0),
                parent_workload_id: None,
                details: vec![TopologyDetailDto {
                    label: "Scheduled".to_string(),
                    value: format!("{ready}/{desired} ready"),
                }],
            },
        );
        attach_operator_owners(
            &mut nodes,
            &mut edges,
            &input.discovered_gvrs,
            ds.metadata.owner_references.as_ref(),
            &ns,
            &id,
        );
    }

    for job in &input.jobs {
        let name = job.metadata.name.clone().unwrap_or_default();
        if name.is_empty() {
            continue;
        }
        let ns = job
            .metadata
            .namespace
            .clone()
            .unwrap_or_else(|| "default".to_string());
        let id = topo_node_id("Job", &ns, &name);
        let succeeded = job.status.as_ref().and_then(|s| s.succeeded).unwrap_or(0);
        let failed = job.status.as_ref().and_then(|s| s.failed).unwrap_or(0);
        let status = if failed > 0 {
            "Error"
        } else if succeeded > 0 {
            "Ready"
        } else {
            "Running"
        };
        nodes.insert(
            id.clone(),
            TopologyNodeDto {
                id: id.clone(),
                kind: "Job".to_string(),
                gvr: "batch/v1/jobs".to_string(),
                name,
                namespace: ns.clone(),
                layer: "workload".to_string(),
                status: status.to_string(),
                external: false,
                subtitle: Some(format!("{succeeded} succeeded")),
                pod_count: Some(0),
                ready_pod_count: Some(0),
                parent_workload_id: None,
                details: vec![TopologyDetailDto {
                    label: "Completions".to_string(),
                    value: format!("{succeeded} ok / {failed} failed"),
                }],
            },
        );
        attach_operator_owners(
            &mut nodes,
            &mut edges,
            &input.discovered_gvrs,
            job.metadata.owner_references.as_ref(),
            &ns,
            &id,
        );
    }

    struct PodTopoRecord {
        id: String,
        ns: String,
        parent_workload_id: Option<String>,
        labels: std::collections::BTreeMap<String, String>,
        claims: Vec<String>,
    }

    // 3. Pods + ownership linkage to Workloads
    let mut pod_records: Vec<PodTopoRecord> = Vec::new();

    for pod in &input.pods {
        let name = pod.metadata.name.clone().unwrap_or_default();
        if name.is_empty() {
            continue;
        }
        let ns = pod
            .metadata
            .namespace
            .clone()
            .unwrap_or_else(|| "default".to_string());
        let id = topo_node_id("Pod", &ns, &name);

        let mut parent_workload_id: Option<String> = None;
        if let Some(owners) = pod.metadata.owner_references.as_ref() {
            for owner in owners {
                match owner.kind.as_str() {
                    "ReplicaSet" => {
                        if let Some(dep_id) = rs_to_deploy.get(&(ns.clone(), owner.name.clone())) {
                            if nodes.contains_key(dep_id) {
                                parent_workload_id = Some(dep_id.clone());
                                break;
                            }
                        }
                    }
                    "StatefulSet" | "DaemonSet" | "Job" => {
                        let candidate = topo_node_id(&owner.kind, &ns, &owner.name);
                        if nodes.contains_key(&candidate) {
                            parent_workload_id = Some(candidate);
                            break;
                        }
                    }
                    other if !other.is_empty() && !is_builtin_owner_kind(other) => {
                        // Direct Pod-owning Operator CR (e.g. KubeBlocks InstanceSet)
                        let cr_id = topo_node_id(other, &ns, &owner.name);
                        let gvr =
                            resolve_owner_gvr(&input.discovered_gvrs, &owner.api_version, other);
                        nodes
                            .entry(cr_id.clone())
                            .or_insert_with(|| TopologyNodeDto {
                                id: cr_id.clone(),
                                kind: other.to_string(),
                                gvr,
                                name: owner.name.clone(),
                                namespace: ns.clone(),
                                layer: "workload".to_string(),
                                status: "Running".to_string(),
                                external: false,
                                subtitle: Some(owner.api_version.clone()),
                                pod_count: Some(0),
                                ready_pod_count: Some(0),
                                parent_workload_id: None,
                                details: vec![
                                    TopologyDetailDto {
                                        label: "API".to_string(),
                                        value: owner.api_version.clone(),
                                    },
                                    TopologyDetailDto {
                                        label: "Role".to_string(),
                                        value: "Operator Workload".to_string(),
                                    },
                                ],
                            });
                        parent_workload_id = Some(cr_id);
                        break;
                    }
                    _ => {}
                }
            }
        }

        let ready = pod_is_ready(pod);
        if let Some(parent_id) = parent_workload_id.as_ref() {
            if let Some(parent_node) = nodes.get_mut(parent_id) {
                parent_node.pod_count = Some(parent_node.pod_count.unwrap_or(0) + 1);
                if ready {
                    parent_node.ready_pod_count =
                        Some(parent_node.ready_pod_count.unwrap_or(0) + 1);
                }
            }
            push_edge(
                &mut edges,
                parent_id.clone(),
                id.clone(),
                "owns".to_string(),
                false,
            );
        }

        let labels = pod.metadata.labels.clone().unwrap_or_default();
        let node_name = pod
            .spec
            .as_ref()
            .and_then(|s| s.node_name.clone())
            .unwrap_or_else(|| "Unscheduled".to_string());
        let pod_ip = pod
            .status
            .as_ref()
            .and_then(|s| s.pod_ip.clone())
            .unwrap_or_else(|| "—".to_string());
        let restarts: i32 = pod
            .status
            .as_ref()
            .and_then(|s| s.container_statuses.as_ref())
            .map(|cs| cs.iter().map(|c| c.restart_count).sum())
            .unwrap_or(0);
        let claims: Vec<String> = pod
            .spec
            .as_ref()
            .and_then(|s| s.volumes.as_ref())
            .into_iter()
            .flatten()
            .filter_map(|v| {
                v.persistent_volume_claim
                    .as_ref()
                    .map(|p| p.claim_name.clone())
            })
            .collect();

        pod_records.push(PodTopoRecord {
            id: id.clone(),
            ns: ns.clone(),
            parent_workload_id: parent_workload_id.clone(),
            labels,
            claims,
        });

        nodes.insert(
            id.clone(),
            TopologyNodeDto {
                id,
                kind: "Pod".to_string(),
                gvr: "/v1/pods".to_string(),
                name,
                namespace: ns,
                layer: "pod".to_string(),
                status: pod_status_label(pod),
                external: false,
                subtitle: Some(format!("node: {node_name}")),
                pod_count: None,
                ready_pod_count: None,
                parent_workload_id,
                details: vec![
                    TopologyDetailDto {
                        label: "Node".to_string(),
                        value: node_name,
                    },
                    TopologyDetailDto {
                        label: "Pod IP".to_string(),
                        value: pod_ip,
                    },
                    TopologyDetailDto {
                        label: "Restarts".to_string(),
                        value: restarts.to_string(),
                    },
                ],
            },
        );
    }

    // 4. PVCs + Workload/Pod mount edges
    for pvc in &input.pvcs {
        let name = pvc.metadata.name.clone().unwrap_or_default();
        if name.is_empty() {
            continue;
        }
        let ns = pvc
            .metadata
            .namespace
            .clone()
            .unwrap_or_else(|| "default".to_string());
        let id = topo_node_id("PersistentVolumeClaim", &ns, &name);
        let phase = pvc
            .status
            .as_ref()
            .and_then(|s| s.phase.clone())
            .unwrap_or_else(|| "Pending".to_string());
        let cap = pvc
            .status
            .as_ref()
            .and_then(|s| s.capacity.as_ref())
            .and_then(|c| c.get("storage"))
            .map(|q| q.0.clone())
            .or_else(|| {
                pvc.spec
                    .as_ref()
                    .and_then(|s| s.resources.as_ref())
                    .and_then(|r| r.requests.as_ref())
                    .and_then(|req| req.get("storage"))
                    .map(|q| q.0.clone())
            })
            .unwrap_or_else(|| "—".to_string());
        let storage_class = pvc
            .spec
            .as_ref()
            .and_then(|s| s.storage_class_name.clone())
            .unwrap_or_else(|| "default".to_string());
        let status = if phase == "Bound" { "Ready" } else { "Warning" };
        nodes.insert(
            id.clone(),
            TopologyNodeDto {
                id,
                kind: "PersistentVolumeClaim".to_string(),
                gvr: "/v1/persistentvolumeclaims".to_string(),
                name,
                namespace: ns,
                layer: "aux".to_string(),
                status: status.to_string(),
                external: false,
                subtitle: Some(format!("{cap} · {phase}")),
                pod_count: None,
                ready_pod_count: None,
                parent_workload_id: None,
                details: vec![
                    TopologyDetailDto {
                        label: "Phase".to_string(),
                        value: phase,
                    },
                    TopologyDetailDto {
                        label: "Capacity".to_string(),
                        value: cap,
                    },
                    TopologyDetailDto {
                        label: "StorageClass".to_string(),
                        value: storage_class,
                    },
                ],
            },
        );
    }

    for (wl_id, ns, claims) in &workload_pvcs {
        for claim in claims {
            let pvc_id = topo_node_id("PersistentVolumeClaim", ns, claim);
            if nodes.contains_key(&pvc_id) {
                push_edge(
                    &mut edges,
                    wl_id.clone(),
                    pvc_id,
                    "mounts".to_string(),
                    false,
                );
            }
        }
    }
    for pod_rec in &pod_records {
        for claim in &pod_rec.claims {
            let pvc_id = topo_node_id("PersistentVolumeClaim", &pod_rec.ns, claim);
            if nodes.contains_key(&pvc_id) {
                let source = pod_rec
                    .parent_workload_id
                    .clone()
                    .unwrap_or_else(|| pod_rec.id.clone());
                push_edge(&mut edges, source, pvc_id, "mounts".to_string(), false);
            }
        }
    }

    // 5. Services + selector matching to Workloads / standalone Pods
    for svc in &input.services {
        let name = svc.metadata.name.clone().unwrap_or_default();
        if name.is_empty() {
            continue;
        }
        let ns = svc
            .metadata
            .namespace
            .clone()
            .unwrap_or_else(|| "default".to_string());
        let id = topo_node_id("Service", &ns, &name);
        let svc_type = svc
            .spec
            .as_ref()
            .and_then(|s| s.type_.clone())
            .unwrap_or_else(|| "ClusterIP".to_string());
        let cluster_ip = svc
            .spec
            .as_ref()
            .and_then(|s| s.cluster_ip.clone())
            .unwrap_or_else(|| "None".to_string());
        let ports: Vec<String> = svc
            .spec
            .as_ref()
            .and_then(|s| s.ports.as_ref())
            .into_iter()
            .flatten()
            .map(|p| format!("{}", p.port))
            .collect();
        let port_label = if ports.is_empty() {
            svc_type.clone()
        } else {
            format!("{svc_type} :{}", ports.join(", "))
        };
        let selector = svc
            .spec
            .as_ref()
            .and_then(|s| s.selector.clone())
            .unwrap_or_default();

        let mut details = vec![
            TopologyDetailDto {
                label: "Type".to_string(),
                value: svc_type,
            },
            TopologyDetailDto {
                label: "Cluster IP".to_string(),
                value: cluster_ip,
            },
        ];
        if !ports.is_empty() {
            details.push(TopologyDetailDto {
                label: "Ports".to_string(),
                value: ports.join(", "),
            });
        }
        if !selector.is_empty() {
            let sel_str = selector
                .iter()
                .take(2)
                .map(|(k, v)| format!("{k}={v}"))
                .collect::<Vec<_>>()
                .join(", ");
            details.push(TopologyDetailDto {
                label: "Selector".to_string(),
                value: sel_str,
            });
        }

        nodes.insert(
            id.clone(),
            TopologyNodeDto {
                id: id.clone(),
                kind: "Service".to_string(),
                gvr: "/v1/services".to_string(),
                name,
                namespace: ns.clone(),
                layer: "service".to_string(),
                status: "Active".to_string(),
                external: false,
                subtitle: Some(port_label),
                pod_count: None,
                ready_pod_count: None,
                parent_workload_id: None,
                details,
            },
        );

        if !selector.is_empty() {
            for (wl_id, wl_ns, tpl_labels) in &workload_template_labels {
                if wl_ns == &ns && selector_matches_labels(&selector, tpl_labels) {
                    push_edge(
                        &mut edges,
                        id.clone(),
                        wl_id.clone(),
                        "routes".to_string(),
                        false,
                    );
                }
            }
            for pod_rec in &pod_records {
                if pod_rec.ns == ns && selector_matches_labels(&selector, &pod_rec.labels) {
                    if let Some(wl_id) = &pod_rec.parent_workload_id {
                        push_edge(
                            &mut edges,
                            id.clone(),
                            wl_id.clone(),
                            "routes".to_string(),
                            false,
                        );
                    } else {
                        push_edge(
                            &mut edges,
                            id.clone(),
                            pod_rec.id.clone(),
                            "routes".to_string(),
                            false,
                        );
                    }
                }
            }
        }
    }

    // 6. Classic Ingress -> Service
    for ing in &input.ingresses {
        let name = ing.metadata.name.clone().unwrap_or_default();
        if name.is_empty() {
            continue;
        }
        let ns = ing
            .metadata
            .namespace
            .clone()
            .unwrap_or_else(|| "default".to_string());
        let id = topo_node_id("Ingress", &ns, &name);
        let class_name = ing
            .spec
            .as_ref()
            .and_then(|s| s.ingress_class_name.clone())
            .or_else(|| {
                ing.metadata
                    .annotations
                    .as_ref()
                    .and_then(|a| a.get("kubernetes.io/ingress.class").cloned())
            })
            .unwrap_or_else(|| "default".to_string());
        let mut hosts: Vec<String> = Vec::new();
        let tls_count = ing
            .spec
            .as_ref()
            .and_then(|s| s.tls.as_ref())
            .map(|t| t.len())
            .unwrap_or(0);

        if let Some(spec) = ing.spec.as_ref() {
            if let Some(rules) = spec.rules.as_ref() {
                for rule in rules {
                    let host = rule.host.clone().unwrap_or_default();
                    if !host.is_empty() && !hosts.contains(&host) {
                        hosts.push(host.clone());
                    }
                    if let Some(http) = rule.http.as_ref() {
                        for path_rule in &http.paths {
                            if let Some(svc_backend) = path_rule.backend.service.as_ref() {
                                let svc_id = topo_node_id("Service", &ns, &svc_backend.name);
                                let path_str =
                                    path_rule.path.clone().unwrap_or_else(|| "/".to_string());
                                let port_str = svc_backend
                                    .port
                                    .as_ref()
                                    .and_then(|p| {
                                        p.number
                                            .map(|n| format!(":{n}"))
                                            .or_else(|| p.name.as_ref().map(|s| format!(":{s}")))
                                    })
                                    .unwrap_or_default();
                                let label = if host.is_empty() {
                                    format!("{path_str}{port_str}")
                                } else {
                                    format!("{host}{path_str}{port_str}")
                                };
                                if !nodes.contains_key(&svc_id) {
                                    nodes.insert(
                                        svc_id.clone(),
                                        TopologyNodeDto {
                                            id: svc_id.clone(),
                                            kind: "Service".to_string(),
                                            gvr: "/v1/services".to_string(),
                                            name: svc_backend.name.clone(),
                                            namespace: ns.clone(),
                                            layer: "service".to_string(),
                                            status: "Warning".to_string(),
                                            external: true,
                                            subtitle: Some("Referenced backend".to_string()),
                                            pod_count: None,
                                            ready_pod_count: None,
                                            parent_workload_id: None,
                                            details: vec![],
                                        },
                                    );
                                }
                                push_edge(&mut edges, id.clone(), svc_id, label, false);
                            }
                        }
                    }
                }
            }
            if let Some(def_svc) = spec
                .default_backend
                .as_ref()
                .and_then(|b| b.service.as_ref())
            {
                let svc_id = topo_node_id("Service", &ns, &def_svc.name);
                if nodes.contains_key(&svc_id) {
                    push_edge(
                        &mut edges,
                        id.clone(),
                        svc_id,
                        "defaultBackend".to_string(),
                        false,
                    );
                }
            }
            if let Some(tls_list) = spec.tls.as_ref() {
                for tls in tls_list {
                    let Some(secret_name) = tls
                        .secret_name
                        .as_deref()
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                    else {
                        continue;
                    };
                    let secret_id =
                        upsert_tls_secret_node(&mut nodes, &input.namespace, &ns, secret_name);
                    let tls_host = tls.hosts.as_ref().and_then(|h| h.first()).cloned();
                    let label = match tls_host {
                        Some(h) if !h.is_empty() => format!("tls · {h}"),
                        _ => "tls".to_string(),
                    };
                    push_edge(&mut edges, id.clone(), secret_id, label, false);
                }
            }
        }

        let subtitle = hosts
            .first()
            .cloned()
            .unwrap_or_else(|| format!("class: {class_name}"));
        let mut details = vec![TopologyDetailDto {
            label: "Class".to_string(),
            value: class_name,
        }];
        if !hosts.is_empty() {
            details.push(TopologyDetailDto {
                label: "Hosts".to_string(),
                value: hosts.join(", "),
            });
        }
        if tls_count > 0 {
            details.push(TopologyDetailDto {
                label: "TLS".to_string(),
                value: format!("{tls_count} cert(s)"),
            });
        }

        nodes.insert(
            id.clone(),
            TopologyNodeDto {
                id,
                kind: "Ingress".to_string(),
                gvr: "networking.k8s.io/v1/ingresses".to_string(),
                name,
                namespace: ns,
                layer: "entry".to_string(),
                status: "Active".to_string(),
                external: false,
                subtitle: Some(subtitle),
                pod_count: None,
                ready_pod_count: None,
                parent_workload_id: None,
                details,
            },
        );
    }

    // 7. Gateway API: Gateways
    for (gvr, gw) in &input.gateways {
        let name = gw.metadata.name.clone().unwrap_or_default();
        if name.is_empty() {
            continue;
        }
        let ns = gw
            .metadata
            .namespace
            .clone()
            .unwrap_or_else(|| "default".to_string());
        let id = topo_node_id("Gateway", &ns, &name);
        let external = !input.namespace.is_empty() && ns != input.namespace;
        let class_name = gw
            .data
            .get("spec")
            .and_then(|s| s.get("gatewayClassName"))
            .and_then(Value::as_str)
            .unwrap_or("gateway")
            .to_string();
        let listeners: Vec<String> = gw
            .data
            .get("spec")
            .and_then(|s| s.get("listeners"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|l| {
                let port = l.get("port").and_then(Value::as_u64)?;
                let proto = l.get("protocol").and_then(Value::as_str).unwrap_or("HTTP");
                Some(format!("{proto}:{port}"))
            })
            .collect();
        let addresses: Vec<String> = gw
            .data
            .get("status")
            .and_then(|s| s.get("addresses"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|a| a.get("value").and_then(Value::as_str).map(String::from))
            .collect();

        let mut details = vec![TopologyDetailDto {
            label: "Class".to_string(),
            value: class_name.clone(),
        }];
        if !listeners.is_empty() {
            details.push(TopologyDetailDto {
                label: "Listeners".to_string(),
                value: listeners.join(", "),
            });
        }
        if !addresses.is_empty() {
            details.push(TopologyDetailDto {
                label: "Address".to_string(),
                value: addresses.join(", "),
            });
        }

        nodes.insert(
            id.clone(),
            TopologyNodeDto {
                id: id.clone(),
                kind: "Gateway".to_string(),
                gvr: gvr.clone(),
                name,
                namespace: ns.clone(),
                layer: "entry".to_string(),
                status: extract_gateway_status(gw),
                external,
                subtitle: Some(if !listeners.is_empty() {
                    format!("{class_name} · {}", listeners.join(", "))
                } else {
                    format!("class: {class_name}")
                }),
                pod_count: None,
                ready_pod_count: None,
                parent_workload_id: None,
                details,
            },
        );

        // Gateway listener TLS certificateRefs -> TLS Secret
        if let Some(listener_arr) = gw
            .data
            .get("spec")
            .and_then(|s| s.get("listeners"))
            .and_then(Value::as_array)
        {
            for listener in listener_arr {
                let listener_name = listener
                    .get("name")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty());
                let Some(cert_refs) = listener
                    .get("tls")
                    .and_then(|t| t.get("certificateRefs"))
                    .and_then(Value::as_array)
                else {
                    continue;
                };
                for cref in cert_refs {
                    let ckind = cref
                        .get("kind")
                        .and_then(Value::as_str)
                        .filter(|k| !k.is_empty())
                        .unwrap_or("Secret");
                    if ckind != "Secret" {
                        continue;
                    }
                    let Some(cname) = cref
                        .get("name")
                        .and_then(Value::as_str)
                        .filter(|s| !s.is_empty())
                    else {
                        continue;
                    };
                    let cns = cref
                        .get("namespace")
                        .and_then(Value::as_str)
                        .filter(|s| !s.is_empty())
                        .unwrap_or(&ns);
                    let secret_id =
                        upsert_tls_secret_node(&mut nodes, &input.namespace, cns, cname);
                    let label = match listener_name {
                        Some(ln) => format!("tls · {ln}"),
                        None => "tls".to_string(),
                    };
                    push_edge(&mut edges, id.clone(), secret_id, label, cns != ns);
                }
            }
        }
    }

    // 7b. Optional cert-manager Certificates -> referenced TLS Secrets
    for (gvr, cert) in &input.certificates {
        let name = cert.metadata.name.clone().unwrap_or_default();
        if name.is_empty() {
            continue;
        }
        let ns = cert
            .metadata
            .namespace
            .clone()
            .unwrap_or_else(|| "default".to_string());
        let Some(secret_name) = cert
            .data
            .get("spec")
            .and_then(|s| s.get("secretName"))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        else {
            continue;
        };
        let secret_id = topo_node_id("Secret", &ns, secret_name);
        if !nodes.contains_key(&secret_id) {
            continue;
        }
        let cert_id = topo_node_id("Certificate", &ns, &name);
        let issuer = cert
            .data
            .get("spec")
            .and_then(|s| s.get("issuerRef"))
            .and_then(|ir| ir.get("name"))
            .and_then(Value::as_str)
            .unwrap_or("cert-manager")
            .to_string();
        let dns_names: Vec<String> = cert
            .data
            .get("spec")
            .and_then(|s| s.get("dnsNames"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(String::from)
            .collect();
        let not_after = cert
            .data
            .get("status")
            .and_then(|s| s.get("notAfter"))
            .and_then(Value::as_str)
            .map(|s| s.split('T').next().unwrap_or(s).to_string());

        let mut details = vec![TopologyDetailDto {
            label: "Issuer".to_string(),
            value: issuer.clone(),
        }];
        if !dns_names.is_empty() {
            details.push(TopologyDetailDto {
                label: "DNS".to_string(),
                value: dns_names.join(", "),
            });
        }
        if let Some(exp) = not_after {
            details.push(TopologyDetailDto {
                label: "Expires".to_string(),
                value: exp,
            });
        }

        nodes.insert(
            cert_id.clone(),
            TopologyNodeDto {
                id: cert_id.clone(),
                kind: "Certificate".to_string(),
                gvr: gvr.clone(),
                name,
                namespace: ns.clone(),
                layer: "entry".to_string(),
                status: extract_certificate_status(cert),
                external: !input.namespace.is_empty() && ns != input.namespace,
                subtitle: dns_names.first().cloned().or(Some(issuer)),
                pod_count: None,
                ready_pod_count: None,
                parent_workload_id: None,
                details,
            },
        );
        push_edge(&mut edges, cert_id, secret_id, "issues".to_string(), false);
    }

    // 8. Gateway API: HTTPRoute / GRPCRoute / TLSRoute / TCPRoute
    for (route_kind, gvr, route) in &input.routes {
        let name = route.metadata.name.clone().unwrap_or_default();
        if name.is_empty() {
            continue;
        }
        let ns = route
            .metadata
            .namespace
            .clone()
            .unwrap_or_else(|| "default".to_string());
        let id = topo_node_id(route_kind, &ns, &name);
        let spec = route.data.get("spec");
        let hostnames: Vec<String> = spec
            .and_then(|s| s.get("hostnames"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(String::from)
            .collect();
        let parent_refs = spec
            .and_then(|s| s.get("parentRefs"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let rules = spec
            .and_then(|s| s.get("rules"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();

        // ParentRefs: Gateway -> Route
        for pref in &parent_refs {
            let parent_name = pref.get("name").and_then(Value::as_str).unwrap_or_default();
            if parent_name.is_empty() {
                continue;
            }
            let parent_kind = pref
                .get("kind")
                .and_then(Value::as_str)
                .filter(|k| !k.is_empty())
                .unwrap_or("Gateway");
            let parent_ns = pref
                .get("namespace")
                .and_then(Value::as_str)
                .filter(|n| !n.is_empty())
                .unwrap_or(&ns);
            let parent_id = topo_node_id(parent_kind, parent_ns, parent_name);
            let cross_ns = parent_ns != ns;

            if !nodes.contains_key(&parent_id) {
                nodes.insert(
                    parent_id.clone(),
                    TopologyNodeDto {
                        id: parent_id.clone(),
                        kind: parent_kind.to_string(),
                        gvr: if parent_kind == "Gateway" {
                            default_gateway_gvr.clone()
                        } else {
                            "/v1/services".to_string()
                        },
                        name: parent_name.to_string(),
                        namespace: parent_ns.to_string(),
                        layer: "entry".to_string(),
                        status: "Active".to_string(),
                        external: cross_ns,
                        subtitle: Some(if cross_ns {
                            format!("ns/{parent_ns}")
                        } else {
                            "Gateway parent".to_string()
                        }),
                        pod_count: None,
                        ready_pod_count: None,
                        parent_workload_id: None,
                        details: vec![TopologyDetailDto {
                            label: "Namespace".to_string(),
                            value: parent_ns.to_string(),
                        }],
                    },
                );
            }

            let section = pref
                .get("sectionName")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty());
            let edge_label = match (section, hostnames.first()) {
                (Some(sec), Some(host)) => format!("{sec} · {host}"),
                (Some(sec), None) => sec.to_string(),
                (None, Some(host)) => host.clone(),
                (None, None) => "attaches".to_string(),
            };
            push_edge(&mut edges, parent_id, id.clone(), edge_label, cross_ns);
        }

        // BackendRefs: Route -> Service
        for rule in &rules {
            let match_prefix = rule
                .get("matches")
                .and_then(Value::as_array)
                .and_then(|m| m.first())
                .and_then(|first| {
                    first
                        .get("path")
                        .and_then(|p| p.get("value"))
                        .and_then(Value::as_str)
                        .map(String::from)
                        .or_else(|| {
                            let svc = first
                                .get("method")
                                .and_then(|m| m.get("service"))
                                .and_then(Value::as_str);
                            let method = first
                                .get("method")
                                .and_then(|m| m.get("method"))
                                .and_then(Value::as_str);
                            match (svc, method) {
                                (Some(s), Some(m)) => Some(format!("{s}/{m}")),
                                (Some(s), None) => Some(s.to_string()),
                                _ => None,
                            }
                        })
                });

            let backends = rule
                .get("backendRefs")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let total_weight: u64 = backends
                .iter()
                .filter_map(|b| b.get("weight").and_then(Value::as_u64))
                .sum();

            for bref in &backends {
                let bname = bref.get("name").and_then(Value::as_str).unwrap_or_default();
                if bname.is_empty() {
                    continue;
                }
                let bkind = bref
                    .get("kind")
                    .and_then(Value::as_str)
                    .filter(|k| !k.is_empty())
                    .unwrap_or("Service");
                if bkind != "Service" {
                    continue;
                }
                let bns = bref
                    .get("namespace")
                    .and_then(Value::as_str)
                    .filter(|n| !n.is_empty())
                    .unwrap_or(&ns);
                let cross_ns = bns != ns;
                let svc_id = topo_node_id("Service", bns, bname);

                if !nodes.contains_key(&svc_id) {
                    nodes.insert(
                        svc_id.clone(),
                        TopologyNodeDto {
                            id: svc_id.clone(),
                            kind: "Service".to_string(),
                            gvr: "/v1/services".to_string(),
                            name: bname.to_string(),
                            namespace: bns.to_string(),
                            layer: "service".to_string(),
                            status: if cross_ns {
                                "Active".to_string()
                            } else {
                                "Warning".to_string()
                            },
                            external: true,
                            subtitle: Some(if cross_ns {
                                format!("ns/{bns}")
                            } else {
                                "Referenced backend".to_string()
                            }),
                            pod_count: None,
                            ready_pod_count: None,
                            parent_workload_id: None,
                            details: vec![],
                        },
                    );
                }

                let mut parts: Vec<String> = Vec::new();
                if let Some(ref mp) = match_prefix {
                    parts.push(mp.clone());
                }
                if backends.len() > 1 {
                    if let Some(w) = bref.get("weight").and_then(Value::as_u64) {
                        if total_weight > 0 {
                            let pct = ((w as f64 / total_weight as f64) * 100.0).round() as u64;
                            parts.push(format!("{pct}%"));
                        }
                    }
                }
                if let Some(port) = bref.get("port").and_then(Value::as_u64) {
                    parts.push(format!(":{port}"));
                }
                let label = if parts.is_empty() {
                    "routes".to_string()
                } else {
                    parts.join(" ")
                };

                push_edge(&mut edges, id.clone(), svc_id, label, cross_ns);
            }
        }

        let mut details = vec![
            TopologyDetailDto {
                label: "Rules".to_string(),
                value: rules.len().to_string(),
            },
            TopologyDetailDto {
                label: "Parents".to_string(),
                value: parent_refs.len().to_string(),
            },
        ];
        if !hostnames.is_empty() {
            details.insert(
                0,
                TopologyDetailDto {
                    label: "Hostnames".to_string(),
                    value: hostnames.join(", "),
                },
            );
        }

        nodes.insert(
            id.clone(),
            TopologyNodeDto {
                id,
                kind: route_kind.clone(),
                gvr: gvr.clone(),
                name,
                namespace: ns,
                layer: "routing".to_string(),
                status: extract_route_status(route),
                external: false,
                subtitle: hostnames
                    .first()
                    .cloned()
                    .or_else(|| Some(format!("{} rule(s)", rules.len()))),
                pod_count: None,
                ready_pod_count: None,
                parent_workload_id: None,
                details,
            },
        );
    }

    // 9. HorizontalPodAutoscalers -> Workload
    for hpa in &input.hpas {
        let name = hpa.metadata.name.clone().unwrap_or_default();
        if name.is_empty() {
            continue;
        }
        let ns = hpa
            .metadata
            .namespace
            .clone()
            .unwrap_or_else(|| "default".to_string());
        let id = topo_node_id("HorizontalPodAutoscaler", &ns, &name);
        let min_rep = hpa.spec.as_ref().and_then(|s| s.min_replicas).unwrap_or(1);
        let max_rep = hpa.spec.as_ref().map(|s| s.max_replicas).unwrap_or(1);
        let cur_rep = hpa
            .status
            .as_ref()
            .and_then(|s| s.current_replicas)
            .unwrap_or(0);

        let mut details = vec![TopologyDetailDto {
            label: "Replicas".to_string(),
            value: format!("{cur_rep} ({min_rep}–{max_rep})"),
        }];
        if let Some(target) = hpa.spec.as_ref().map(|s| &s.scale_target_ref) {
            details.push(TopologyDetailDto {
                label: "Target".to_string(),
                value: format!("{}/{}", target.kind, target.name),
            });
            let target_id = topo_node_id(&target.kind, &ns, &target.name);
            if nodes.contains_key(&target_id) {
                push_edge(
                    &mut edges,
                    id.clone(),
                    target_id,
                    format!("scales {min_rep}–{max_rep}"),
                    false,
                );
            }
        }

        nodes.insert(
            id.clone(),
            TopologyNodeDto {
                id,
                kind: "HorizontalPodAutoscaler".to_string(),
                gvr: "autoscaling/v2/horizontalpodautoscalers".to_string(),
                name,
                namespace: ns,
                layer: "aux".to_string(),
                status: "Active".to_string(),
                external: false,
                subtitle: Some(format!("{cur_rep} ({min_rep}–{max_rep})")),
                pod_count: None,
                ready_pod_count: None,
                parent_workload_id: None,
                details,
            },
        );
    }

    let edge_dtos: Vec<TopologyEdgeDto> = edges
        .into_iter()
        .map(|((from, to), (labels, cross_namespace))| {
            let summary = if labels.len() <= 2 {
                labels.join(", ")
            } else {
                format!("{}, {} +{}", labels[0], labels[1], labels.len() - 2)
            };
            TopologyEdgeDto {
                id: format!("{from}->{to}"),
                from,
                to,
                label: summary,
                cross_namespace,
            }
        })
        .collect();

    NamespaceTopologyDto {
        context_id: input.context_id,
        namespace: input.namespace,
        gateway_api_detected: input.gateway_api_detected,
        gateway_api_kinds: input.gateway_api_kinds,
        nodes: nodes.into_values().collect(),
        edges: edge_dtos,
    }
}

#[tauri::command]
pub(super) async fn get_namespace_topology(
    state: State<'_, AppState>,
    args: GetNamespaceTopologyArgs,
) -> CommandResult<NamespaceTopologyDto> {
    let client = state
        .manager
        .client(&args.context_id)
        .await
        .ok_or_else(|| {
            map_err(
                KubixError::AuthRequired {
                    message: "context is not connected".to_string(),
                },
                Some(args.context_id.clone()),
            )
        })?;

    let ns = args.namespace.unwrap_or_default().trim().to_string();
    let lp = kube::api::ListParams::default();

    // Ensure discovery cache is populated so we can detect Gateway API versions accurately.
    let discovered_entries = resolve_discovery(&state, &args.context_id)
        .await
        .unwrap_or_default();

    // Pick best discovered version per Gateway API kind (`gateway.networking.k8s.io`).
    let gateway_target_kinds = ["Gateway", "HTTPRoute", "GRPCRoute", "TLSRoute", "TCPRoute"];
    let mut best_gw_entries: HashMap<String, ApiResourceEntry> = HashMap::new();
    for entry in &discovered_entries {
        if entry.group == "gateway.networking.k8s.io"
            && entry.is_listable()
            && gateway_target_kinds.contains(&entry.kind.as_str())
        {
            let replace = match best_gw_entries.get(&entry.kind) {
                Some(existing) => {
                    gateway_version_rank(&entry.version) > gateway_version_rank(&existing.version)
                }
                None => true,
            };
            if replace {
                best_gw_entries.insert(entry.kind.clone(), entry.clone());
            }
        }
    }
    let gateway_api_detected = !best_gw_entries.is_empty();
    let mut gateway_api_kinds: Vec<String> = gateway_target_kinds
        .iter()
        .filter(|k| best_gw_entries.contains_key(**k))
        .map(|k| k.to_string())
        .collect();
    gateway_api_kinds.sort();

    // List standard Kubernetes resources in parallel (tolerating per-kind RBAC 403/404).
    let (ing_res, svc_res, dep_res, sts_res, ds_res, rs_res, job_res, pod_res, hpa_res, pvc_res) =
        if ns.is_empty() {
            let ing_api = Api::<k8s_openapi::api::networking::v1::Ingress>::all(client.clone());
            let svc_api = Api::<k8s_openapi::api::core::v1::Service>::all(client.clone());
            let dep_api = Api::<k8s_openapi::api::apps::v1::Deployment>::all(client.clone());
            let sts_api = Api::<k8s_openapi::api::apps::v1::StatefulSet>::all(client.clone());
            let ds_api = Api::<k8s_openapi::api::apps::v1::DaemonSet>::all(client.clone());
            let rs_api = Api::<k8s_openapi::api::apps::v1::ReplicaSet>::all(client.clone());
            let job_api = Api::<k8s_openapi::api::batch::v1::Job>::all(client.clone());
            let pod_api = Api::<k8s_openapi::api::core::v1::Pod>::all(client.clone());
            let hpa_api = Api::<k8s_openapi::api::autoscaling::v2::HorizontalPodAutoscaler>::all(
                client.clone(),
            );
            let pvc_api =
                Api::<k8s_openapi::api::core::v1::PersistentVolumeClaim>::all(client.clone());
            tokio::join!(
                ing_api.list(&lp),
                svc_api.list(&lp),
                dep_api.list(&lp),
                sts_api.list(&lp),
                ds_api.list(&lp),
                rs_api.list(&lp),
                job_api.list(&lp),
                pod_api.list(&lp),
                hpa_api.list(&lp),
                pvc_api.list(&lp),
            )
        } else {
            let ing_api =
                Api::<k8s_openapi::api::networking::v1::Ingress>::namespaced(client.clone(), &ns);
            let svc_api =
                Api::<k8s_openapi::api::core::v1::Service>::namespaced(client.clone(), &ns);
            let dep_api =
                Api::<k8s_openapi::api::apps::v1::Deployment>::namespaced(client.clone(), &ns);
            let sts_api =
                Api::<k8s_openapi::api::apps::v1::StatefulSet>::namespaced(client.clone(), &ns);
            let ds_api =
                Api::<k8s_openapi::api::apps::v1::DaemonSet>::namespaced(client.clone(), &ns);
            let rs_api =
                Api::<k8s_openapi::api::apps::v1::ReplicaSet>::namespaced(client.clone(), &ns);
            let job_api = Api::<k8s_openapi::api::batch::v1::Job>::namespaced(client.clone(), &ns);
            let pod_api = Api::<k8s_openapi::api::core::v1::Pod>::namespaced(client.clone(), &ns);
            let hpa_api =
                Api::<k8s_openapi::api::autoscaling::v2::HorizontalPodAutoscaler>::namespaced(
                    client.clone(),
                    &ns,
                );
            let pvc_api = Api::<k8s_openapi::api::core::v1::PersistentVolumeClaim>::namespaced(
                client.clone(),
                &ns,
            );
            tokio::join!(
                ing_api.list(&lp),
                svc_api.list(&lp),
                dep_api.list(&lp),
                sts_api.list(&lp),
                ds_api.list(&lp),
                rs_api.list(&lp),
                job_api.list(&lp),
                pod_api.list(&lp),
                hpa_api.list(&lp),
                pvc_api.list(&lp),
            )
        };

    // Fetch discovered Gateway API resources dynamically.
    let mut gateways: Vec<(String, DynamicObject)> = Vec::new();
    let mut routes: Vec<(String, String, DynamicObject)> = Vec::new();
    let gateway_entry = best_gw_entries.get("Gateway").cloned();

    if let Some(ref gw_e) = gateway_entry {
        let ar = gw_e.api_resource();
        let api = if ns.is_empty() {
            Api::<DynamicObject>::all_with(client.clone(), &ar)
        } else {
            Api::<DynamicObject>::namespaced_with(client.clone(), &ns, &ar)
        };
        if let Ok(list) = api.list(&lp).await {
            let gvr = gw_e.gvr();
            for item in list.items {
                gateways.push((gvr.clone(), item));
            }
        }
    }

    for route_kind in ["HTTPRoute", "GRPCRoute", "TLSRoute", "TCPRoute"] {
        if let Some(route_e) = best_gw_entries.get(route_kind) {
            let ar = route_e.api_resource();
            let api = if ns.is_empty() {
                Api::<DynamicObject>::all_with(client.clone(), &ar)
            } else {
                Api::<DynamicObject>::namespaced_with(client.clone(), &ns, &ar)
            };
            if let Ok(list) = api.list(&lp).await {
                let gvr = route_e.gvr();
                for item in list.items {
                    routes.push((route_kind.to_string(), gvr.clone(), item));
                }
            }
        }
    }

    // Best-effort fetch of cross-namespace Gateways referenced by parentRefs.
    if let Some(ref gw_e) = gateway_entry {
        if !ns.is_empty() {
            let existing_gws: std::collections::HashSet<(String, String)> = gateways
                .iter()
                .filter_map(|(_, gw)| {
                    Some((
                        gw.metadata
                            .namespace
                            .clone()
                            .unwrap_or_else(|| "default".to_string()),
                        gw.metadata.name.clone()?,
                    ))
                })
                .collect();
            let mut missing_parents: std::collections::BTreeSet<(String, String)> =
                std::collections::BTreeSet::new();
            for (_, _, route) in &routes {
                if let Some(prefs) = route
                    .data
                    .get("spec")
                    .and_then(|s| s.get("parentRefs"))
                    .and_then(Value::as_array)
                {
                    for pref in prefs {
                        let pkind = pref
                            .get("kind")
                            .and_then(Value::as_str)
                            .filter(|k| !k.is_empty())
                            .unwrap_or("Gateway");
                        if pkind != "Gateway" {
                            continue;
                        }
                        if let Some(pname) = pref.get("name").and_then(Value::as_str) {
                            let pns = pref
                                .get("namespace")
                                .and_then(Value::as_str)
                                .filter(|n| !n.is_empty())
                                .unwrap_or(&ns);
                            let key = (pns.to_string(), pname.to_string());
                            if !existing_gws.contains(&key) {
                                missing_parents.insert(key);
                            }
                        }
                    }
                }
            }
            let ar = gw_e.api_resource();
            let gvr = gw_e.gvr();
            for (pns, pname) in missing_parents.into_iter().take(8) {
                let api = Api::<DynamicObject>::namespaced_with(client.clone(), &pns, &ar);
                if let Ok(gw_obj) = api.get(&pname).await {
                    gateways.push((gvr.clone(), gw_obj));
                }
            }
        }
    }

    // Build discovered GVR lookup for resolving Operator CRs & detect cert-manager Certificates.
    let mut discovered_gvrs: HashMap<(String, String), String> = HashMap::new();
    let mut cert_manager_entry: Option<ApiResourceEntry> = None;
    for entry in &discovered_entries {
        if !entry.is_listable() {
            continue;
        }
        let gvr = entry.gvr();
        let api_version = if entry.group.is_empty() {
            entry.version.clone()
        } else {
            format!("{}/{}", entry.group, entry.version)
        };
        discovered_gvrs
            .entry((api_version, entry.kind.clone()))
            .or_insert_with(|| gvr.clone());
        if !entry.group.is_empty() {
            discovered_gvrs
                .entry((entry.group.clone(), entry.kind.clone()))
                .or_insert_with(|| gvr.clone());
        }
        discovered_gvrs
            .entry((String::new(), entry.kind.clone()))
            .or_insert_with(|| gvr.clone());

        if entry.group == "cert-manager.io" && entry.kind == "Certificate" {
            let replace = match cert_manager_entry.as_ref() {
                Some(existing) => {
                    gateway_version_rank(&entry.version) > gateway_version_rank(&existing.version)
                }
                None => true,
            };
            if replace {
                cert_manager_entry = Some(entry.clone());
            }
        }
    }

    // Fetch optional cert-manager Certificates (for linking TLS Secrets to Certificates).
    let mut certificates: Vec<(String, DynamicObject)> = Vec::new();
    if let Some(ref cert_e) = cert_manager_entry {
        let ar = cert_e.api_resource();
        let gvr = cert_e.gvr();
        let api = if ns.is_empty() {
            Api::<DynamicObject>::all_with(client.clone(), &ar)
        } else {
            Api::<DynamicObject>::namespaced_with(client.clone(), &ns, &ar)
        };
        if let Ok(list) = api.list(&lp).await {
            for item in list.items {
                certificates.push((gvr.clone(), item));
            }
        }
        // Also fetch Certificates from any external Gateway namespace (e.g. envoy-gateway-system)
        if !ns.is_empty() {
            let ext_namespaces: std::collections::BTreeSet<String> = gateways
                .iter()
                .filter_map(|(_, gw)| gw.metadata.namespace.clone())
                .filter(|gw_ns| gw_ns != &ns)
                .collect();
            for ext_ns in ext_namespaces.into_iter().take(4) {
                let ext_api = Api::<DynamicObject>::namespaced_with(client.clone(), &ext_ns, &ar);
                if let Ok(list) = ext_api.list(&lp).await {
                    for item in list.items {
                        certificates.push((gvr.clone(), item));
                    }
                }
            }
        }
    }

    Ok(build_namespace_topology(NamespaceTopologyInput {
        context_id: args.context_id,
        namespace: ns,
        gateway_api_detected,
        gateway_api_kinds,
        gateway_gvr: gateway_entry.map(|e| e.gvr()),
        ingresses: ing_res.map(|l| l.items).unwrap_or_default(),
        services: svc_res.map(|l| l.items).unwrap_or_default(),
        deployments: dep_res.map(|l| l.items).unwrap_or_default(),
        statefulsets: sts_res.map(|l| l.items).unwrap_or_default(),
        daemonsets: ds_res.map(|l| l.items).unwrap_or_default(),
        replicasets: rs_res.map(|l| l.items).unwrap_or_default(),
        jobs: job_res.map(|l| l.items).unwrap_or_default(),
        pods: pod_res.map(|l| l.items).unwrap_or_default(),
        hpas: hpa_res.map(|l| l.items).unwrap_or_default(),
        pvcs: pvc_res.map(|l| l.items).unwrap_or_default(),
        gateways,
        routes,
        certificates,
        discovered_gvrs,
    }))
}
