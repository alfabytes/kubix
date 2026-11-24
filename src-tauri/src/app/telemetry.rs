//! Cluster overview, resource events, and Metrics Server telemetry.

use std::collections::HashMap;

use kube::core::DynamicObject;
use kube::Api;
use serde_json::Value;
use tauri::State;

use super::logs::extract_selector_from_workload;
use super::{api_for, map_err, AppState, CommandResult};
use crate::error::KubixError;
use crate::ipc::dto::{
    parse_gvr, ClusterEventDto, ClusterNodeOverviewDto, ClusterOverviewDto, ContainerMetricDto,
    ContextArgs, GetResourceArgs, ResourceMetricsDto,
};

fn format_k8s_time(ts: Option<&k8s_openapi::apimachinery::pkg::apis::meta::v1::Time>) -> String {
    ts.map(|t| t.0.to_rfc3339()).unwrap_or_default()
}

fn event_timestamp(ev: &k8s_openapi::api::core::v1::Event) -> String {
    ev.last_timestamp
        .as_ref()
        .map(|t| t.0.to_rfc3339())
        .or_else(|| ev.event_time.as_ref().map(|t| t.0.to_rfc3339()))
        .or_else(|| {
            ev.metadata
                .creation_timestamp
                .as_ref()
                .map(|t| t.0.to_rfc3339())
        })
        .unwrap_or_default()
}

fn event_to_dto(ev: &k8s_openapi::api::core::v1::Event) -> ClusterEventDto {
    let inv_kind = ev.involved_object.kind.as_deref().unwrap_or("");
    let inv_name = ev.involved_object.name.as_deref().unwrap_or("");
    let involved_object = if !inv_kind.is_empty() && !inv_name.is_empty() {
        format!("{inv_kind}/{inv_name}")
    } else {
        format!("{inv_kind}{inv_name}")
    };
    let from = ev
        .source
        .as_ref()
        .and_then(|s| s.component.clone())
        .or_else(|| ev.reporting_component.clone())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| inv_kind.to_string());

    ClusterEventDto {
        uid: ev
            .metadata
            .uid
            .clone()
            .unwrap_or_else(|| ev.metadata.name.clone().unwrap_or_default()),
        event_type: ev.type_.clone().unwrap_or_else(|| "Normal".to_string()),
        reason: ev.reason.clone().unwrap_or_else(|| "Event".to_string()),
        involved_object,
        namespace: ev.metadata.namespace.clone().unwrap_or_default(),
        from,
        message: ev.message.clone().unwrap_or_default(),
        count: ev.count.unwrap_or(1).max(1) as u32,
        created_at: event_timestamp(ev),
    }
}

pub fn parse_cpu_millicores(raw: &str) -> f64 {
    let s = raw.trim();
    if s.is_empty() {
        return 0.0;
    }
    if let Some(num) = s.strip_suffix('n') {
        return num.parse::<f64>().unwrap_or(0.0) / 1_000_000.0;
    }
    if let Some(num) = s.strip_suffix('u') {
        return num.parse::<f64>().unwrap_or(0.0) / 1_000.0;
    }
    if let Some(num) = s.strip_suffix('m') {
        return num.parse::<f64>().unwrap_or(0.0);
    }
    s.parse::<f64>().unwrap_or(0.0) * 1_000.0
}

pub fn parse_memory_mib(raw: &str) -> f64 {
    let s = raw.trim();
    if s.is_empty() {
        return 0.0;
    }
    let (num_str, factor_mib) = if let Some(v) = s.strip_suffix("Ki") {
        (v, 1.0 / 1024.0)
    } else if let Some(v) = s.strip_suffix("Mi") {
        (v, 1.0)
    } else if let Some(v) = s.strip_suffix("Gi") {
        (v, 1024.0)
    } else if let Some(v) = s.strip_suffix("Ti") {
        (v, 1024.0 * 1024.0)
    } else if let Some(v) = s.strip_suffix('K') {
        (v, 1_000.0 / (1024.0 * 1024.0))
    } else if let Some(v) = s.strip_suffix('M') {
        (v, 1_000_000.0 / (1024.0 * 1024.0))
    } else if let Some(v) = s.strip_suffix('G') {
        (v, 1_000_000_000.0 / (1024.0 * 1024.0))
    } else {
        (s, 1.0 / (1024.0 * 1024.0))
    };
    num_str.parse::<f64>().unwrap_or(0.0) * factor_mib
}

fn is_metrics_unavailable(err: &kube::Error) -> bool {
    match err {
        kube::Error::Api(resp) => matches!(resp.code, 404 | 410 | 501 | 503),
        _ => false,
    }
}

#[tauri::command]
pub(super) async fn get_cluster_overview(
    state: State<'_, AppState>,
    args: ContextArgs,
) -> CommandResult<ClusterOverviewDto> {
    use k8s_openapi::api::apps::v1::Deployment;
    use k8s_openapi::api::core::v1::{Event, Namespace as K8sNamespace, Node, Pod};
    use kube::api::ListParams;

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

    let node_api: Api<Node> = Api::all(client.clone());
    let ns_api: Api<K8sNamespace> = Api::all(client.clone());
    let pod_api: Api<Pod> = Api::all(client.clone());
    let deploy_api: Api<Deployment> = Api::all(client.clone());
    let event_api: Api<Event> = Api::all(client.clone());
    let node_metrics_ar = kube::discovery::ApiResource {
        group: "metrics.k8s.io".to_string(),
        version: "v1beta1".to_string(),
        api_version: "metrics.k8s.io/v1beta1".to_string(),
        kind: "NodeMetrics".to_string(),
        plural: "nodes".to_string(),
    };
    let node_metrics_api: Api<DynamicObject> = Api::all_with(client, &node_metrics_ar);

    let lp = ListParams::default();
    let event_lp = ListParams::default().limit(150);

    let (nodes_res, ns_res, pods_res, deploys_res, events_res, node_metrics_res) = tokio::join!(
        node_api.list(&lp),
        ns_api.list(&lp),
        pod_api.list(&lp),
        deploy_api.list(&lp),
        event_api.list(&event_lp),
        node_metrics_api.list(&lp),
    );

    let nodes_items = nodes_res
        .map_err(|e| map_err(KubixError::from_kube(e), Some(args.context_id.clone())))?
        .items;
    let namespace_count = ns_res.map(|l| l.items.len() as u32).unwrap_or(0);
    let pods_items = pods_res.map(|l| l.items).unwrap_or_default();
    let deploys_items = deploys_res.map(|l| l.items).unwrap_or_default();
    let events_items = events_res.map(|l| l.items).unwrap_or_default();

    let (metrics_server_available, node_metrics_by_name) = match node_metrics_res {
        Ok(list) => {
            let mut map: HashMap<String, (f64, f64)> = HashMap::new();
            for obj in &list.items {
                let Some(nname) = obj.metadata.name.as_deref() else {
                    continue;
                };
                let usage = obj.data.get("usage");
                let cpu_m = usage
                    .and_then(|u| u.get("cpu"))
                    .and_then(Value::as_str)
                    .map(parse_cpu_millicores)
                    .unwrap_or(0.0);
                let mem_mib = usage
                    .and_then(|u| u.get("memory"))
                    .and_then(Value::as_str)
                    .map(parse_memory_mib)
                    .unwrap_or(0.0);
                map.insert(
                    nname.to_string(),
                    (
                        (cpu_m * 10.0).round() / 10.0,
                        (mem_mib * 10.0).round() / 10.0,
                    ),
                );
            }
            (true, map)
        }
        Err(_) => (false, HashMap::new()),
    };

    let mut ready_nodes = 0u32;
    let mut nodes = Vec::with_capacity(nodes_items.len());
    for n in &nodes_items {
        let name = n.metadata.name.clone().unwrap_or_default();
        let ready = n
            .status
            .as_ref()
            .and_then(|s| s.conditions.as_ref())
            .is_some_and(|conds| {
                conds
                    .iter()
                    .any(|c| c.type_ == "Ready" && c.status == "True")
            });
        if ready {
            ready_nodes += 1;
        }
        let kubelet_version = n
            .status
            .as_ref()
            .and_then(|s| s.node_info.as_ref())
            .map(|ni| ni.kubelet_version.clone())
            .unwrap_or_default();
        let mut roles: Vec<String> = n
            .metadata
            .labels
            .as_ref()
            .map(|labels| {
                labels
                    .keys()
                    .filter_map(|k| k.strip_prefix("node-role.kubernetes.io/"))
                    .filter(|r| !r.is_empty())
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        roles.sort();
        let roles_str = if roles.is_empty() {
            "worker".to_string()
        } else {
            roles.join(", ")
        };
        let capacity = n.status.as_ref().and_then(|s| s.capacity.as_ref());
        let cpu_capacity_raw = capacity.and_then(|m| m.get("cpu")).map(|q| q.0.clone());
        let cpu_capacity_millicores = cpu_capacity_raw.as_deref().map(parse_cpu_millicores);
        let cpu_capacity = cpu_capacity_raw.unwrap_or_else(|| "—".to_string());

        let memory_capacity_mib = capacity
            .and_then(|m| m.get("memory"))
            .map(|q| (parse_memory_mib(&q.0) * 10.0).round() / 10.0);
        let memory_capacity = memory_capacity_mib
            .map(|mib| {
                if mib >= 1024.0 {
                    format!("{:.1} GiB", mib / 1024.0)
                } else {
                    format!("{:.0} MiB", mib)
                }
            })
            .unwrap_or_else(|| "—".to_string());

        let (cpu_usage_millicores, memory_usage_mib) = node_metrics_by_name
            .get(&name)
            .map(|&(c, m)| (Some(c), Some(m)))
            .unwrap_or((None, None));

        nodes.push(ClusterNodeOverviewDto {
            name,
            ready,
            kubelet_version,
            roles: roles_str,
            cpu_capacity,
            memory_capacity,
            cpu_capacity_millicores,
            memory_capacity_mib,
            cpu_usage_millicores,
            memory_usage_mib,
            created_at: format_k8s_time(n.metadata.creation_timestamp.as_ref()),
        });
    }

    let running_pods = pods_items
        .iter()
        .filter(|p| {
            matches!(
                p.status.as_ref().and_then(|s| s.phase.as_deref()),
                Some("Running" | "Succeeded")
            )
        })
        .count() as u32;

    let healthy_deployments = deploys_items
        .iter()
        .filter(|d| {
            let desired = d.spec.as_ref().and_then(|s| s.replicas).unwrap_or(1);
            let ready = d
                .status
                .as_ref()
                .and_then(|s| s.ready_replicas)
                .unwrap_or(0);
            desired > 0 && ready >= desired
        })
        .count() as u32;

    let mut recent_events: Vec<ClusterEventDto> = events_items.iter().map(event_to_dto).collect();
    recent_events.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    recent_events.truncate(25);

    Ok(ClusterOverviewDto {
        context_id: args.context_id,
        ready_nodes,
        total_nodes: nodes_items.len() as u32,
        namespace_count,
        running_pods,
        total_pods: pods_items.len() as u32,
        healthy_deployments,
        total_deployments: deploys_items.len() as u32,
        metrics_server_available,
        nodes,
        recent_events,
    })
}

#[tauri::command]
pub(super) async fn get_resource_events(
    state: State<'_, AppState>,
    args: GetResourceArgs,
) -> CommandResult<Vec<ClusterEventDto>> {
    use k8s_openapi::api::core::v1::Event;
    use kube::api::ListParams;

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

    let plural = parse_gvr(&args.gvr).map(|(_, _, p)| p).unwrap_or("");
    let include_children = matches!(
        plural,
        "deployments"
            | "statefulsets"
            | "daemonsets"
            | "replicasets"
            | "replicationcontrollers"
            | "jobs"
            | "cronjobs"
    );

    let event_api: Api<Event> = match args.namespace.as_deref().filter(|s| !s.is_empty()) {
        Some(ns) => Api::namespaced(client, ns),
        None => Api::all(client),
    };

    let list = event_api
        .list(&ListParams::default())
        .await
        .map_err(|e| map_err(KubixError::from_kube(e), Some(args.context_id.clone())))?;

    let target_name = args.name.trim();
    let prefix = format!("{target_name}-");
    let mut matched: Vec<ClusterEventDto> = list
        .items
        .iter()
        .filter(|ev| {
            if target_name.is_empty() {
                return true;
            }
            let inv_name = ev.involved_object.name.as_deref().unwrap_or("");
            if inv_name == target_name {
                return true;
            }
            if include_children && inv_name.starts_with(&prefix) {
                return matches!(
                    ev.involved_object.kind.as_deref(),
                    Some(
                        "Pod"
                            | "ReplicaSet"
                            | "Job"
                            | "ControllerRevision"
                            | "Deployment"
                            | "StatefulSet"
                            | "DaemonSet"
                    )
                );
            }
            false
        })
        .map(event_to_dto)
        .collect();

    matched.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    if target_name.is_empty() {
        matched.truncate(300);
    }
    Ok(matched)
}

#[tauri::command]
pub(super) async fn get_resource_metrics(
    state: State<'_, AppState>,
    args: GetResourceArgs,
) -> CommandResult<ResourceMetricsDto> {
    use kube::api::ListParams;
    use kube::discovery::ApiResource;

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

    let namespace = args
        .namespace
        .clone()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "default".to_string());
    let plural = parse_gvr(&args.gvr).map(|(_, _, p)| p).unwrap_or("");

    let pod_metrics_ar = ApiResource {
        group: "metrics.k8s.io".to_string(),
        version: "v1beta1".to_string(),
        api_version: "metrics.k8s.io/v1beta1".to_string(),
        kind: "PodMetrics".to_string(),
        plural: "pods".to_string(),
    };
    let pod_metrics_api: Api<DynamicObject> =
        Api::namespaced_with(client.clone(), &namespace, &pod_metrics_ar);

    let mut container_totals: std::collections::BTreeMap<String, (f64, f64)> =
        std::collections::BTreeMap::new();
    let mut pod_count = 0u32;
    let mut timestamp = String::new();
    let mut window_seconds = 15u32;

    let accumulate_pod_metrics = |obj: &DynamicObject,
                                  totals: &mut std::collections::BTreeMap<String, (f64, f64)>,
                                  ts: &mut String,
                                  win: &mut u32| {
        if ts.is_empty() {
            if let Some(t) = obj.data.get("timestamp").and_then(Value::as_str) {
                *ts = t.to_string();
            }
        }
        if let Some(w_str) = obj.data.get("window").and_then(Value::as_str) {
            if let Some(secs) = w_str.strip_suffix('s').and_then(|v| v.parse::<u32>().ok()) {
                *win = secs;
            }
        }
        if let Some(containers) = obj.data.get("containers").and_then(Value::as_array) {
            for c in containers {
                let cname = c
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("default")
                    .to_string();
                let usage = c.get("usage");
                let cpu_m = usage
                    .and_then(|u| u.get("cpu"))
                    .and_then(Value::as_str)
                    .map(parse_cpu_millicores)
                    .unwrap_or(0.0);
                let mem_mib = usage
                    .and_then(|u| u.get("memory"))
                    .and_then(Value::as_str)
                    .map(parse_memory_mib)
                    .unwrap_or(0.0);
                let entry = totals.entry(cname).or_insert((0.0, 0.0));
                entry.0 += cpu_m;
                entry.1 += mem_mib;
            }
        }
    };

    if plural == "nodes" {
        let node_metrics_ar = ApiResource {
            group: "metrics.k8s.io".to_string(),
            version: "v1beta1".to_string(),
            api_version: "metrics.k8s.io/v1beta1".to_string(),
            kind: "NodeMetrics".to_string(),
            plural: "nodes".to_string(),
        };
        let node_metrics_api: Api<DynamicObject> = Api::all_with(client.clone(), &node_metrics_ar);
        match node_metrics_api.get(&args.name).await {
            Ok(obj) => {
                if let Some(t) = obj.data.get("timestamp").and_then(Value::as_str) {
                    timestamp = t.to_string();
                }
                if let Some(w_str) = obj.data.get("window").and_then(Value::as_str) {
                    if let Some(secs) = w_str.strip_suffix('s').and_then(|v| v.parse::<u32>().ok())
                    {
                        window_seconds = secs;
                    }
                }
                let usage = obj.data.get("usage");
                let cpu_m = usage
                    .and_then(|u| u.get("cpu"))
                    .and_then(Value::as_str)
                    .map(parse_cpu_millicores)
                    .unwrap_or(0.0);
                let mem_mib = usage
                    .and_then(|u| u.get("memory"))
                    .and_then(Value::as_str)
                    .map(parse_memory_mib)
                    .unwrap_or(0.0);
                let cpu_rounded = (cpu_m * 10.0).round() / 10.0;
                let mem_rounded = (mem_mib * 10.0).round() / 10.0;
                return Ok(ResourceMetricsDto {
                    context_id: args.context_id,
                    metrics_server_available: true,
                    status_message: None,
                    timestamp,
                    window_seconds,
                    total_cpu_millicores: cpu_rounded,
                    total_memory_mib: mem_rounded,
                    pod_count: 1,
                    containers: vec![ContainerMetricDto {
                        name: args.name,
                        cpu_millicores: cpu_rounded,
                        memory_mib: mem_rounded,
                    }],
                });
            }
            Err(err) if is_metrics_unavailable(&err) => {
                return Ok(ResourceMetricsDto {
                    context_id: args.context_id,
                    metrics_server_available: false,
                    status_message: Some(
                        "Metrics Server (metrics.k8s.io/v1beta1) is not installed on this cluster."
                            .to_string(),
                    ),
                    timestamp: String::new(),
                    window_seconds: 15,
                    total_cpu_millicores: 0.0,
                    total_memory_mib: 0.0,
                    pod_count: 0,
                    containers: Vec::new(),
                });
            }
            Err(err) => {
                return Err(map_err(
                    KubixError::from_kube(err),
                    Some(args.context_id.clone()),
                ));
            }
        }
    }

    if plural == "pods" {
        match pod_metrics_api.get(&args.name).await {
            Ok(obj) => {
                pod_count = 1;
                accumulate_pod_metrics(
                    &obj,
                    &mut container_totals,
                    &mut timestamp,
                    &mut window_seconds,
                );
            }
            Err(err) if is_metrics_unavailable(&err) => {
                return Ok(ResourceMetricsDto {
                    context_id: args.context_id,
                    metrics_server_available: false,
                    status_message: Some(
                        "Metrics Server (metrics.k8s.io/v1beta1) is not installed on this cluster."
                            .to_string(),
                    ),
                    timestamp: String::new(),
                    window_seconds: 15,
                    total_cpu_millicores: 0.0,
                    total_memory_mib: 0.0,
                    pod_count: 0,
                    containers: Vec::new(),
                });
            }
            Err(err) => {
                return Err(map_err(
                    KubixError::from_kube(err),
                    Some(args.context_id.clone()),
                ));
            }
        }
    } else {
        let selector = match api_for(&state, &args.context_id, &args.gvr, &namespace).await {
            Ok(workload_api) => workload_api
                .get(&args.name)
                .await
                .ok()
                .and_then(|obj| extract_selector_from_workload(&obj.data)),
            Err(_) => None,
        };
        let lp = match &selector {
            Some(sel) => ListParams::default().labels(sel),
            None => ListParams::default(),
        };
        match pod_metrics_api.list(&lp).await {
            Ok(list) => {
                let prefix = format!("{}-", args.name);
                for obj in &list.items {
                    let pname = obj.metadata.name.as_deref().unwrap_or("");
                    if selector.is_some() || pname == args.name || pname.starts_with(&prefix) {
                        pod_count += 1;
                        accumulate_pod_metrics(
                            obj,
                            &mut container_totals,
                            &mut timestamp,
                            &mut window_seconds,
                        );
                    }
                }
            }
            Err(err) if is_metrics_unavailable(&err) => {
                return Ok(ResourceMetricsDto {
                    context_id: args.context_id,
                    metrics_server_available: false,
                    status_message: Some(
                        "Metrics Server (metrics.k8s.io/v1beta1) is not installed on this cluster."
                            .to_string(),
                    ),
                    timestamp: String::new(),
                    window_seconds: 15,
                    total_cpu_millicores: 0.0,
                    total_memory_mib: 0.0,
                    pod_count: 0,
                    containers: Vec::new(),
                });
            }
            Err(err) => {
                return Err(map_err(
                    KubixError::from_kube(err),
                    Some(args.context_id.clone()),
                ));
            }
        }
    }

    let mut total_cpu = 0.0;
    let mut total_mem = 0.0;
    let containers: Vec<ContainerMetricDto> = container_totals
        .into_iter()
        .map(|(cname, (cpu, mem))| {
            let cpu_rounded = (cpu * 10.0).round() / 10.0;
            let mem_rounded = (mem * 10.0).round() / 10.0;
            total_cpu += cpu_rounded;
            total_mem += mem_rounded;
            ContainerMetricDto {
                name: cname,
                cpu_millicores: cpu_rounded,
                memory_mib: mem_rounded,
            }
        })
        .collect();

    Ok(ResourceMetricsDto {
        context_id: args.context_id,
        metrics_server_available: true,
        status_message: None,
        timestamp,
        window_seconds,
        total_cpu_millicores: (total_cpu * 10.0).round() / 10.0,
        total_memory_mib: (total_mem * 10.0).round() / 10.0,
        pod_count,
        containers,
    })
}
