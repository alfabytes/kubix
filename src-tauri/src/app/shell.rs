//! Interactive container shell sessions and local TCP port-forwarding.

use std::sync::atomic::Ordering;

use kube::Api;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc;

use super::logs::extract_selector_from_workload;
use super::{
    api_for, map_err, AppState, CommandResult, PortForwardSession, ShellSession, NEXT_FORWARD_ID,
    NEXT_SHELL_ID,
};
use crate::error::KubixError;
use crate::ipc::dto::{
    CloseShellArgs, ContextArgs, PortForwardDto, ShellInputArgs, ShellOutputDto, ShellResizeArgs,
    ShellSessionDto, StartPortForwardArgs, StartShellArgs, StopPortForwardArgs,
};
use crate::ipc::events::SHELL_OUTPUT;

#[tauri::command]
pub(super) async fn start_shell(
    app: AppHandle,
    state: State<'_, AppState>,
    args: StartShellArgs,
) -> CommandResult<ShellSessionDto> {
    use futures::SinkExt;
    use k8s_openapi::api::core::v1::Pod;
    use kube::api::{AttachParams, TerminalSize};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let namespace = if args.namespace.trim().is_empty() {
        "default".to_string()
    } else {
        args.namespace.clone()
    };

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

    let pod_api: Api<Pod> = Api::namespaced(client, &namespace);
    let container = match args.container.clone().filter(|s| !s.is_empty()) {
        Some(c) => c,
        None => {
            let pod = pod_api
                .get(&args.pod_name)
                .await
                .map_err(|e| map_err(KubixError::from_kube(e), Some(args.context_id.clone())))?;
            pod.spec
                .and_then(|s| s.containers.into_iter().next())
                .map(|c| c.name)
                .ok_or_else(|| {
                    map_err(
                        KubixError::internal("pod has no containers"),
                        Some(args.context_id.clone()),
                    )
                })?
        }
    };

    let cmd: Vec<String> = if args.command.is_empty() {
        vec![
            "sh".to_string(),
            "-c".to_string(),
            "export TERM=\"${TERM:-xterm-256color}\"; if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi"
                .to_string(),
        ]
    } else {
        args.command.clone()
    };

    let ap = AttachParams::interactive_tty().container(container.clone());
    let mut attached = pod_api
        .exec(&args.pod_name, cmd, &ap)
        .await
        .map_err(|e| map_err(KubixError::from_kube(e), Some(args.context_id.clone())))?;

    let session_id = format!("shell-{}", NEXT_SHELL_ID.fetch_add(1, Ordering::Relaxed));
    let (stdin_tx, mut stdin_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let (resize_tx, mut resize_rx) = mpsc::unbounded_channel::<(u16, u16)>();

    let mut stdin_writer = attached.stdin();
    let mut stdout_reader = attached.stdout();
    let mut term_size_writer = attached.terminal_size();
    let status_fut = attached.take_status();

    if let Some(writer) = term_size_writer.as_mut() {
        let width = args.cols.unwrap_or(100).max(20);
        let height = args.rows.unwrap_or(28).max(5);
        let _ = writer.send(TerminalSize { width, height }).await;
    }

    let app_handle = app.clone();
    let sid = session_id.clone();

    let handle = tokio::spawn(async move {
        let mut buf = [0u8; 8192];
        loop {
            tokio::select! {
                Some(bytes) = stdin_rx.recv() => {
                    if let Some(w) = stdin_writer.as_mut() {
                        if w.write_all(&bytes).await.is_err() {
                            break;
                        }
                        let _ = w.flush().await;
                    }
                }
                Some((width, height)) = resize_rx.recv() => {
                    if let Some(ts) = term_size_writer.as_mut() {
                        let _ = ts.send(TerminalSize {
                            width: width.max(20),
                            height: height.max(5),
                        }).await;
                    }
                }
                read_res = async {
                    match stdout_reader.as_mut() {
                        Some(r) => r.read(&mut buf).await,
                        None => Ok(0),
                    }
                } => {
                    match read_res {
                        Ok(0) => break,
                        Ok(n) => {
                            let text = String::from_utf8_lossy(&buf[..n]).to_string();
                            let _ = app_handle.emit(
                                SHELL_OUTPUT,
                                ShellOutputDto {
                                    session_id: sid.clone(),
                                    stream: "stdout".to_string(),
                                    data: text,
                                    closed: false,
                                },
                            );
                        }
                        Err(_) => break,
                    }
                }
            }
        }

        let join_res = attached.join().await;
        let status_msg = match status_fut {
            Some(fut) => fut.await.and_then(|s| {
                if s.status.as_deref() == Some("Failure") {
                    s.message
                } else {
                    None
                }
            }),
            None => None,
        };
        let close_banner = match (status_msg, join_res) {
            (Some(msg), _) => format!("\r\n[session closed: {msg}]\r\n"),
            (None, Err(err)) => format!("\r\n[session closed: {err}]\r\n"),
            (None, Ok(())) => "\r\n[session closed]\r\n".to_string(),
        };
        let _ = app_handle.emit(
            SHELL_OUTPUT,
            ShellOutputDto {
                session_id: sid,
                stream: "system".to_string(),
                data: close_banner,
                closed: true,
            },
        );
    });

    state.shells.lock().await.insert(
        session_id.clone(),
        ShellSession {
            context_id: args.context_id.clone(),
            stdin_tx,
            resize_tx,
            handle,
        },
    );

    Ok(ShellSessionDto {
        session_id,
        context_id: args.context_id,
        namespace,
        pod_name: args.pod_name,
        container,
    })
}

#[tauri::command]
pub(super) async fn send_shell_input(
    state: State<'_, AppState>,
    args: ShellInputArgs,
) -> CommandResult<()> {
    let shells = state.shells.lock().await;
    if let Some(session) = shells.get(&args.session_id) {
        let _ = session.stdin_tx.send(args.data.into_bytes());
    }
    Ok(())
}

#[tauri::command]
pub(super) async fn resize_shell(
    state: State<'_, AppState>,
    args: ShellResizeArgs,
) -> CommandResult<()> {
    let shells = state.shells.lock().await;
    if let Some(session) = shells.get(&args.session_id) {
        let _ = session.resize_tx.send((args.cols, args.rows));
    }
    Ok(())
}

#[tauri::command]
pub(super) async fn close_shell(
    state: State<'_, AppState>,
    args: CloseShellArgs,
) -> CommandResult<()> {
    if let Some(session) = state.shells.lock().await.remove(&args.session_id) {
        session.handle.abort();
    }
    Ok(())
}

pub(super) fn pick_running_or_first_pod(
    pods: &[k8s_openapi::api::core::v1::Pod],
) -> Option<&k8s_openapi::api::core::v1::Pod> {
    pods.iter()
        .find(|p| p.status.as_ref().and_then(|s| s.phase.as_deref()) == Some("Running"))
        .or_else(|| pods.first())
}

pub(super) fn workload_gvr_for_kind(kind: &str) -> &'static str {
    match kind.to_ascii_lowercase().as_str() {
        "deployment" => "apps/v1/deployments",
        "statefulset" => "apps/v1/statefulsets",
        "daemonset" => "apps/v1/daemonsets",
        "replicaset" => "apps/v1/replicasets",
        "replicationcontroller" => "/v1/replicationcontrollers",
        "job" => "batch/v1/jobs",
        _ => "apps/v1/deployments",
    }
}

#[tauri::command]
pub(super) async fn start_port_forward(
    state: State<'_, AppState>,
    args: StartPortForwardArgs,
) -> CommandResult<PortForwardDto> {
    use k8s_openapi::api::core::v1::{Pod, Service};
    use k8s_openapi::apimachinery::pkg::util::intstr::IntOrString;
    use kube::api::ListParams;

    let namespace = if args.namespace.trim().is_empty() {
        "default".to_string()
    } else {
        args.namespace.trim().to_string()
    };

    // Reuse an existing forward if one is already active for the same resource & remote port.
    {
        let existing = state.port_forwards.lock().await;
        if let Some(found) = existing.values().find(|s| {
            s.dto.context_id == args.context_id
                && s.dto.namespace == namespace
                && s.dto.kind.eq_ignore_ascii_case(&args.kind)
                && s.dto.name == args.name
                && s.dto.remote_port == args.remote_port
        }) {
            return Ok(found.dto.clone());
        }
    }

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
    let (target_pod, resolved_remote_port) = if args.kind.eq_ignore_ascii_case("Pod") {
        let pod = pod_api
            .get(&args.name)
            .await
            .map_err(|e| map_err(KubixError::from_kube(e), Some(args.context_id.clone())))?;
        let pod_name = pod.metadata.name.unwrap_or_else(|| args.name.clone());
        (pod_name, args.remote_port)
    } else if args.kind.eq_ignore_ascii_case("Service") {
        let svc_api: Api<Service> = Api::namespaced(client, &namespace);
        let svc = svc_api
            .get(&args.name)
            .await
            .map_err(|e| map_err(KubixError::from_kube(e), Some(args.context_id.clone())))?;
        let spec = svc.spec.ok_or_else(|| {
            map_err(
                KubixError::internal("Service has no spec"),
                Some(args.context_id.clone()),
            )
        })?;
        let selector_map = spec.selector.unwrap_or_default();
        if selector_map.is_empty() {
            return Err(map_err(
                KubixError::internal("Service has no pod selector"),
                Some(args.context_id.clone()),
            ));
        }
        let selector_str = selector_map
            .iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect::<Vec<_>>()
            .join(",");
        let pod_list = pod_api
            .list(&ListParams::default().labels(&selector_str))
            .await
            .map_err(|e| map_err(KubixError::from_kube(e), Some(args.context_id.clone())))?;
        let chosen_pod = pick_running_or_first_pod(&pod_list.items).ok_or_else(|| {
            map_err(
                KubixError::internal("no backing Pods match this Service selector"),
                Some(args.context_id.clone()),
            )
        })?;
        let pod_name = chosen_pod.metadata.name.clone().ok_or_else(|| {
            map_err(
                KubixError::internal("backing Pod is missing a name"),
                Some(args.context_id.clone()),
            )
        })?;

        let target_port = spec
            .ports
            .unwrap_or_default()
            .into_iter()
            .find(|sp| sp.port as u16 == args.remote_port)
            .and_then(|sp| sp.target_port)
            .map(|tp| match tp {
                IntOrString::Int(p) => (p as u16).max(1),
                IntOrString::String(port_name) => chosen_pod
                    .spec
                    .as_ref()
                    .and_then(|ps| {
                        ps.containers
                            .iter()
                            .flat_map(|c| c.ports.iter().flatten())
                            .find(|cp| cp.name.as_deref() == Some(port_name.as_str()))
                            .map(|cp| cp.container_port as u16)
                    })
                    .unwrap_or(args.remote_port),
            })
            .unwrap_or(args.remote_port);

        (pod_name, target_port)
    } else {
        let gvr = workload_gvr_for_kind(&args.kind);
        let selector = match api_for(&state, &args.context_id, gvr, &namespace).await {
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
        let pod_list = pod_api
            .list(&lp)
            .await
            .map_err(|e| map_err(KubixError::from_kube(e), Some(args.context_id.clone())))?;
        let prefix = format!("{}-", args.name);
        let matched: Vec<Pod> = pod_list
            .items
            .into_iter()
            .filter(|p| {
                if selector.is_some() {
                    true
                } else {
                    p.metadata
                        .name
                        .as_deref()
                        .is_some_and(|n| n == args.name || n.starts_with(&prefix))
                }
            })
            .collect();
        let chosen_pod = pick_running_or_first_pod(&matched).ok_or_else(|| {
            map_err(
                KubixError::internal(format!(
                    "no running Pods found for {} '{}'",
                    args.kind, args.name
                )),
                Some(args.context_id.clone()),
            )
        })?;
        let pod_name = chosen_pod.metadata.name.clone().ok_or_else(|| {
            map_err(
                KubixError::internal("backing Pod is missing a name"),
                Some(args.context_id.clone()),
            )
        })?;
        (pod_name, args.remote_port)
    };

    let bind_port = args.local_port.unwrap_or(0);
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", bind_port))
        .await
        .map_err(|e| {
            map_err(
                KubixError::internal(format!("unable to bind 127.0.0.1:{bind_port}: {e}")),
                Some(args.context_id.clone()),
            )
        })?;
    let actual_local_port = listener.local_addr().map(|a| a.port()).unwrap_or(bind_port);

    let forward_id = format!("pf-{}", NEXT_FORWARD_ID.fetch_add(1, Ordering::Relaxed));
    let target_pod_for_task = target_pod.clone();

    let handle = tokio::spawn(async move {
        while let Ok((mut local_stream, _peer)) = listener.accept().await {
            let api = pod_api.clone();
            let pod_name = target_pod_for_task.clone();
            tokio::spawn(async move {
                if let Ok(mut pf) = api.portforward(&pod_name, &[resolved_remote_port]).await {
                    if let Some(mut upstream) = pf.take_stream(resolved_remote_port) {
                        let _ =
                            tokio::io::copy_bidirectional(&mut local_stream, &mut upstream).await;
                    }
                    pf.abort();
                }
            });
        }
    });

    let dto = PortForwardDto {
        forward_id: forward_id.clone(),
        context_id: args.context_id,
        namespace,
        kind: args.kind,
        name: args.name,
        target_pod,
        remote_port: args.remote_port,
        local_port: actual_local_port,
        local_url: format!("http://127.0.0.1:{actual_local_port}"),
    };

    state.port_forwards.lock().await.insert(
        forward_id,
        PortForwardSession {
            dto: dto.clone(),
            handle,
        },
    );

    Ok(dto)
}

#[tauri::command]
pub(super) async fn stop_port_forward(
    state: State<'_, AppState>,
    args: StopPortForwardArgs,
) -> CommandResult<()> {
    if let Some(session) = state.port_forwards.lock().await.remove(&args.forward_id) {
        session.handle.abort();
    }
    Ok(())
}

#[tauri::command]
pub(super) async fn list_port_forwards(
    state: State<'_, AppState>,
    args: ContextArgs,
) -> CommandResult<Vec<PortForwardDto>> {
    let forwards = state.port_forwards.lock().await;
    let mut items: Vec<PortForwardDto> = forwards
        .values()
        .filter(|s| s.dto.context_id == args.context_id)
        .map(|s| s.dto.clone())
        .collect();
    items.sort_by_key(|a| a.local_port);
    Ok(items)
}
