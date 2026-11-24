//! Pod & workload log snapshots and live streaming.

use std::sync::atomic::Ordering;

use kube::Api;
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};

use super::{api_for, map_err, AppState, CommandResult, LogStreamTask, NEXT_LOG_STREAM_ID};
use crate::error::KubixError;
use crate::ipc::dto::{
    GetPodLogsArgs, LogStreamSessionDto, PodLogChunkDto, PodLogLineDto, PodLogsDto,
    StartLogStreamArgs, StopLogStreamArgs,
};
use crate::ipc::events::POD_LOG_LINE;

pub(super) fn extract_selector_from_workload(data: &Value) -> Option<String> {
    let match_labels = data
        .get("spec")
        .and_then(|s| s.get("selector"))
        .and_then(|sel| sel.get("matchLabels").or(Some(sel)))
        .and_then(Value::as_object)?;
    let pairs: Vec<String> = match_labels
        .iter()
        .filter_map(|(k, v)| v.as_str().map(|s| format!("{k}={s}")))
        .collect();
    if pairs.is_empty() {
        None
    } else {
        Some(pairs.join(","))
    }
}

pub(super) fn build_pod_log_params(
    container: Option<String>,
    tail_lines: Option<i64>,
    previous: bool,
    follow: bool,
) -> kube::api::LogParams {
    let resolved_tail = tail_lines.filter(|&n| n > 0).map(|n| n.clamp(10, 10_000));
    kube::api::LogParams {
        container,
        timestamps: true,
        tail_lines: resolved_tail,
        previous,
        follow,
        ..Default::default()
    }
}

pub(super) fn should_fallback_to_init_containers(
    previous: bool,
    has_regular_logs: bool,
    has_init_containers: bool,
) -> bool {
    !previous && !has_regular_logs && has_init_containers
}

pub(super) fn should_stream_init_containers(pod: &k8s_openapi::api::core::v1::Pod) -> bool {
    let has_inits = pod
        .spec
        .as_ref()
        .and_then(|s| s.init_containers.as_ref())
        .is_some_and(|list| !list.is_empty());
    if !has_inits {
        return false;
    }
    let phase = pod
        .status
        .as_ref()
        .and_then(|s| s.phase.as_deref())
        .unwrap_or("");
    if phase == "Pending" {
        return true;
    }
    pod.status
        .as_ref()
        .and_then(|s| s.init_container_statuses.as_ref())
        .is_some_and(|statuses| statuses.iter().any(|st| !st.ready))
}

pub(super) async fn resolve_target_pods(
    state: &AppState,
    client: kube::Client,
    context_id: &str,
    gvr: &str,
    name: &str,
    namespace: &str,
) -> CommandResult<Vec<k8s_openapi::api::core::v1::Pod>> {
    use k8s_openapi::api::core::v1::Pod;
    use kube::api::ListParams;

    let pod_api: Api<Pod> = Api::namespaced(client, namespace);
    let is_pod = gvr == "/v1/pods" || gvr.ends_with("/pods");

    if is_pod {
        let pod = pod_api
            .get(name)
            .await
            .map_err(|e| map_err(KubixError::from_kube(e), Some(context_id.to_string())))?;
        return Ok(vec![pod]);
    }

    let selector = match api_for(state, context_id, gvr, namespace).await {
        Ok(workload_api) => workload_api
            .get(name)
            .await
            .ok()
            .and_then(|obj| extract_selector_from_workload(&obj.data)),
        Err(_) => None,
    };

    let lp = match &selector {
        Some(sel) => ListParams::default().labels(sel),
        None => ListParams::default(),
    };

    let pod_list = pod_api
        .list(&lp)
        .await
        .map_err(|e| map_err(KubixError::from_kube(e), Some(context_id.to_string())))?;

    let prefix = format!("{name}-");
    let mut matched: Vec<Pod> = pod_list
        .items
        .into_iter()
        .filter(|p| {
            if selector.is_some() {
                true
            } else {
                p.metadata
                    .name
                    .as_deref()
                    .is_some_and(|n| n == name || n.starts_with(&prefix))
            }
        })
        .collect();

    matched.sort_by(|a, b| a.metadata.name.cmp(&b.metadata.name));
    matched.truncate(8);
    Ok(matched)
}

#[tauri::command]
pub(super) async fn get_pod_logs(
    state: State<'_, AppState>,
    args: GetPodLogsArgs,
) -> CommandResult<PodLogsDto> {
    use k8s_openapi::api::core::v1::Pod;

    let namespace = args
        .namespace
        .clone()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "default".to_string());

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

    let pod_api: Api<Pod> = Api::namespaced(client.clone(), &namespace);
    let is_pod = args.gvr == "/v1/pods" || args.gvr.ends_with("/pods");
    // `tail_lines == Some(0)` explicitly means "All lines" (`None`).
    let tail_opt: Option<i64> = match args.tail_lines {
        Some(n) if n <= 0 => None,
        Some(n) => Some(n.clamp(10, 10_000)),
        None => Some(250),
    };

    let target_pods = resolve_target_pods(
        &state,
        client,
        &args.context_id,
        &args.gvr,
        &args.name,
        &namespace,
    )
    .await?;

    let mut pods_names = Vec::new();
    let mut all_containers = Vec::new();
    let mut all_init_containers = Vec::new();
    let mut chunks = Vec::new();
    let per_pod_tail: Option<i64> = tail_opt.map(|tail| {
        if target_pods.len() > 1 {
            (tail / (target_pods.len() as i64)).max(40)
        } else {
            tail
        }
    });
    let requested_container = args
        .container
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let previous = args.previous.unwrap_or(false);

    for pod in &target_pods {
        let Some(pod_name) = pod.metadata.name.clone() else {
            continue;
        };
        pods_names.push(pod_name.clone());

        let pod_containers: Vec<String> = pod
            .spec
            .as_ref()
            .map(|s| s.containers.iter().map(|c| c.name.clone()).collect())
            .unwrap_or_default();
        let pod_init_containers: Vec<String> = pod
            .spec
            .as_ref()
            .and_then(|s| s.init_containers.as_ref())
            .map(|list| list.iter().map(|c| c.name.clone()).collect())
            .unwrap_or_default();

        for c in &pod_containers {
            if !all_containers.contains(c) {
                all_containers.push(c.clone());
            }
        }
        for c in &pod_init_containers {
            if !all_init_containers.contains(c) {
                all_init_containers.push(c.clone());
            }
        }

        if let Some(req) = requested_container {
            let matches_container = pod_containers.iter().any(|c| c == req)
                || pod_init_containers.iter().any(|c| c == req);
            if !matches_container && !is_pod {
                continue;
            }
            let lp = build_pod_log_params(Some(req.to_string()), per_pod_tail, previous, false);
            let raw_logs = match pod_api.logs(&pod_name, &lp).await {
                Ok(text) => text,
                Err(err) => {
                    format!("(unable to read container logs for {pod_name}/{req}: {err})")
                }
            };
            chunks.push(PodLogChunkDto {
                pod_name,
                container_name: req.to_string(),
                logs: raw_logs,
            });
            continue;
        }

        // Default "All containers": fetch logs from every regular container on the pod.
        let targets: Vec<Option<String>> = if pod_containers.is_empty() {
            vec![None]
        } else {
            pod_containers.iter().cloned().map(Some).collect()
        };
        let stream_tail: Option<i64> = per_pod_tail.map(|t| {
            if targets.len() > 1 {
                (t / (targets.len() as i64)).max(30)
            } else {
                t
            }
        });

        let mut pod_regular_chunks = Vec::new();
        let mut has_regular_logs = false;
        for target in targets {
            let cname = target.clone().unwrap_or_else(|| "default".to_string());
            let lp = build_pod_log_params(target, stream_tail, previous, false);
            let raw_logs = match pod_api.logs(&pod_name, &lp).await {
                Ok(text) => {
                    if !text.trim().is_empty() {
                        has_regular_logs = true;
                    }
                    text
                }
                Err(err) => {
                    format!("(unable to read container logs for {pod_name}/{cname}: {err})")
                }
            };
            pod_regular_chunks.push(PodLogChunkDto {
                pod_name: pod_name.clone(),
                container_name: cname,
                logs: raw_logs,
            });
        }

        // If regular containers produced no logs and initContainers exist (e.g. PodInitializing /
        // Init:CrashLoopBackOff), surface initContainer logs automatically in "All containers".
        // Skip this fallback when `previous` is requested so real kubelet errors for regular
        // containers (e.g. no prior terminated instance) are surfaced directly.
        if should_fallback_to_init_containers(
            previous,
            has_regular_logs,
            !pod_init_containers.is_empty(),
        ) {
            let mut init_chunks = Vec::new();
            let mut has_init_output = false;
            for init_name in &pod_init_containers {
                let lp =
                    build_pod_log_params(Some(init_name.clone()), per_pod_tail, previous, false);
                match pod_api.logs(&pod_name, &lp).await {
                    Ok(text) if !text.trim().is_empty() => {
                        has_init_output = true;
                        init_chunks.push(PodLogChunkDto {
                            pod_name: pod_name.clone(),
                            container_name: format!("init:{init_name}"),
                            logs: text,
                        });
                    }
                    Ok(_) => {}
                    Err(err) => {
                        init_chunks.push(PodLogChunkDto {
                            pod_name: pod_name.clone(),
                            container_name: format!("init:{init_name}"),
                            logs: format!(
                                "(unable to read init container logs for {pod_name}/{init_name}: {err})"
                            ),
                        });
                    }
                }
            }
            if has_init_output || !init_chunks.is_empty() {
                chunks.extend(init_chunks);
            } else {
                chunks.extend(pod_regular_chunks);
            }
        } else {
            chunks.extend(pod_regular_chunks);
        }
    }

    Ok(PodLogsDto {
        context_id: args.context_id,
        gvr: args.gvr,
        name: args.name,
        namespace: Some(namespace),
        pods: pods_names,
        containers: all_containers,
        init_containers: all_init_containers,
        chunks,
    })
}

#[tauri::command]
pub(super) async fn start_log_stream(
    app: AppHandle,
    state: State<'_, AppState>,
    args: StartLogStreamArgs,
) -> CommandResult<LogStreamSessionDto> {
    use futures::{AsyncBufReadExt, StreamExt};
    use k8s_openapi::api::core::v1::Pod;

    let namespace = args
        .namespace
        .clone()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "default".to_string());

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

    let is_pod = args.gvr == "/v1/pods" || args.gvr.ends_with("/pods");
    let tail_opt: Option<i64> = match args.tail_lines {
        Some(n) if n <= 0 => None,
        Some(n) => Some(n.clamp(10, 10_000)),
        None => Some(250),
    };

    let target_pods = resolve_target_pods(
        &state,
        client.clone(),
        &args.context_id,
        &args.gvr,
        &args.name,
        &namespace,
    )
    .await?;

    let stream_id = format!(
        "log-stream-{}",
        NEXT_LOG_STREAM_ID.fetch_add(1, Ordering::Relaxed)
    );
    let requested_container = args
        .container
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let previous = args.previous.unwrap_or(false);
    let follow = !previous;

    let mut pods_names = Vec::new();
    let mut all_containers = Vec::new();
    let mut all_init_containers = Vec::new();
    let mut targets_to_spawn: Vec<(String, Option<String>, String)> = Vec::new();

    for pod in &target_pods {
        let Some(pod_name) = pod.metadata.name.clone() else {
            continue;
        };
        pods_names.push(pod_name.clone());

        let pod_containers: Vec<String> = pod
            .spec
            .as_ref()
            .map(|s| s.containers.iter().map(|c| c.name.clone()).collect())
            .unwrap_or_default();
        let pod_init_containers: Vec<String> = pod
            .spec
            .as_ref()
            .and_then(|s| s.init_containers.as_ref())
            .map(|list| list.iter().map(|c| c.name.clone()).collect())
            .unwrap_or_default();

        for c in &pod_containers {
            if !all_containers.contains(c) {
                all_containers.push(c.clone());
            }
        }
        for c in &pod_init_containers {
            if !all_init_containers.contains(c) {
                all_init_containers.push(c.clone());
            }
        }

        if let Some(req) = requested_container {
            let matches_container = pod_containers.iter().any(|c| c == req)
                || pod_init_containers.iter().any(|c| c == req);
            if matches_container || is_pod {
                targets_to_spawn.push((pod_name, Some(req.to_string()), req.to_string()));
            }
        } else if !previous && should_stream_init_containers(pod) {
            for init_name in pod_init_containers {
                targets_to_spawn.push((
                    pod_name.clone(),
                    Some(init_name.clone()),
                    format!("init:{init_name}"),
                ));
            }
        } else if pod_containers.is_empty() {
            targets_to_spawn.push((pod_name, None, "default".to_string()));
        } else {
            for cname in pod_containers {
                targets_to_spawn.push((pod_name.clone(), Some(cname.clone()), cname));
            }
        }
    }

    let total_streams = targets_to_spawn.len().max(1) as i64;
    let per_stream_tail: Option<i64> = tail_opt.map(|t| {
        if total_streams > 1 {
            (t / total_streams).max(30)
        } else {
            t
        }
    });

    let mut handles = Vec::with_capacity(targets_to_spawn.len());
    for (pod_name, container_opt, label_container) in targets_to_spawn {
        let pod_api: Api<Pod> = Api::namespaced(client.clone(), &namespace);
        let app_clone = app.clone();
        let sid = stream_id.clone();
        let lp = build_pod_log_params(container_opt, per_stream_tail, previous, follow);

        let handle = tokio::spawn(async move {
            match pod_api.log_stream(&pod_name, &lp).await {
                Ok(stream) => {
                    let mut lines = stream.lines();
                    while let Some(next_line) = lines.next().await {
                        match next_line {
                            Ok(line) => {
                                let _ = app_clone.emit(
                                    POD_LOG_LINE,
                                    PodLogLineDto {
                                        stream_id: sid.clone(),
                                        pod_name: pod_name.clone(),
                                        container_name: label_container.clone(),
                                        line,
                                        closed: false,
                                        error: None,
                                    },
                                );
                            }
                            Err(err) => {
                                let _ = app_clone.emit(
                                    POD_LOG_LINE,
                                    PodLogLineDto {
                                        stream_id: sid.clone(),
                                        pod_name: pod_name.clone(),
                                        container_name: label_container.clone(),
                                        line: String::new(),
                                        closed: true,
                                        error: Some(err.to_string()),
                                    },
                                );
                                return;
                            }
                        }
                    }
                    let _ = app_clone.emit(
                        POD_LOG_LINE,
                        PodLogLineDto {
                            stream_id: sid,
                            pod_name,
                            container_name: label_container,
                            line: String::new(),
                            closed: true,
                            error: None,
                        },
                    );
                }
                Err(err) => {
                    let _ = app_clone.emit(
                        POD_LOG_LINE,
                        PodLogLineDto {
                            stream_id: sid,
                            pod_name: pod_name.clone(),
                            container_name: label_container.clone(),
                            line: format!(
                                "(unable to stream container logs for {pod_name}/{label_container}: {err})"
                            ),
                            closed: true,
                            error: Some(err.to_string()),
                        },
                    );
                }
            }
        });
        handles.push(handle);
    }

    state.log_streams.lock().await.insert(
        stream_id.clone(),
        LogStreamTask {
            context_id: args.context_id,
            handles,
        },
    );

    Ok(LogStreamSessionDto {
        stream_id,
        pods: pods_names,
        containers: all_containers,
        init_containers: all_init_containers,
    })
}

#[tauri::command]
pub(super) async fn stop_log_stream(
    state: State<'_, AppState>,
    args: StopLogStreamArgs,
) -> CommandResult<()> {
    if let Some(task) = state.log_streams.lock().await.remove(&args.stream_id) {
        for handle in task.handles {
            handle.abort();
        }
    }
    Ok(())
}
