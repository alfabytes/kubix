//! Tauri runtime wiring: state, command handlers, and event emitters.
//!
//! Every handler here is on the read-only roster declared in
//! `crate::ipc::commands`. Do not add a mutating command.

use std::collections::HashMap;
use std::sync::atomic::AtomicU64;
use std::sync::Arc;
use std::time::Duration;

use kube::config::Kubeconfig;
use kube::core::DynamicObject;
use kube::Api;
use serde_json::Value;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{mpsc, Mutex, RwLock};
use tokio::task::JoinHandle;
use tracing::{info, warn};

use crate::cluster::ClusterManager;
use crate::config::{self, ContextDescriptor};
use crate::discovery::{self, ApiResourceEntry};
use crate::error::{KubixContextualError, KubixError, KubixErrorDto};
use crate::ipc::dto::{
    parse_gvr, ClusterContextDto, ConnectionState, ContextArgs, DiscoveredResourceDto,
    GetResourceArgs, ListResourcesArgs, Namespace, PortForwardDto, ResourceDeletionDto,
    ResourceDeltaDto, ResourceManifestDto, ResourceSummaryDto, StopWatchArgs, WatchEvictedDto,
};
use crate::ipc::events::{CLOSE_ACTIVE_TAB, CONTEXT_STATE, RESOURCE_DELTA, WATCH_EVICTED};
use crate::watch::{summarize, DeltaAccumulator, WatchBudget, WatchEvent, WatchRegistry};

mod logs;
mod security;
mod shell;
mod telemetry;
mod topology;

pub use telemetry::{parse_cpu_millicores, parse_memory_mib};

pub const SECRET_MASK: &str = "<masked by kubix>";

struct WatchTask {
    pub(super) handle: JoinHandle<()>,
}

pub(super) struct ShellSession {
    pub(super) context_id: String,
    pub(super) stdin_tx: mpsc::UnboundedSender<Vec<u8>>,
    pub(super) resize_tx: mpsc::UnboundedSender<(u16, u16)>,
    pub(super) handle: JoinHandle<()>,
}

pub(super) struct PortForwardSession {
    pub(super) dto: PortForwardDto,
    pub(super) handle: JoinHandle<()>,
}

pub(super) struct LogStreamTask {
    pub(super) context_id: String,
    pub(super) handles: Vec<JoinHandle<()>>,
}

pub(super) static NEXT_SHELL_ID: AtomicU64 = AtomicU64::new(1);
pub(super) static NEXT_FORWARD_ID: AtomicU64 = AtomicU64::new(1);
pub(super) static NEXT_LOG_STREAM_ID: AtomicU64 = AtomicU64::new(1);

pub struct AppState {
    pub(super) manager: Arc<ClusterManager>,
    pub(super) discovery_cache: RwLock<HashMap<String, Vec<ApiResourceEntry>>>,
    watches: Mutex<HashMap<String, WatchTask>>,
    registry: Mutex<WatchRegistry>,
    pub(super) shells: Mutex<HashMap<String, ShellSession>>,
    pub(super) port_forwards: Mutex<HashMap<String, PortForwardSession>>,
    pub(super) log_streams: Mutex<HashMap<String, LogStreamTask>>,
}

impl AppState {
    fn new() -> Self {
        Self {
            manager: Arc::new(ClusterManager::new()),
            discovery_cache: RwLock::new(HashMap::new()),
            watches: Mutex::new(HashMap::new()),
            registry: Mutex::new(WatchRegistry::new(WatchBudget::default().max_watches)),
            shells: Mutex::new(HashMap::new()),
            port_forwards: Mutex::new(HashMap::new()),
            log_streams: Mutex::new(HashMap::new()),
        }
    }
}

fn watch_key(context_id: &str, gvr: &str, namespace: &str) -> String {
    format!("{context_id}\u{0}{gvr}\u{0}{namespace}")
}

pub(super) type CommandResult<T> = std::result::Result<T, KubixErrorDto>;

pub(super) fn map_err(error: impl Into<KubixError>, context_id: Option<String>) -> KubixErrorDto {
    let error: KubixError = error.into();
    error.to_dto(context_id)
}

fn map_contextual(error: KubixContextualError) -> KubixErrorDto {
    error.dto()
}

/// Load (or reload) the kubeconfig from disk into the manager.
async fn refresh_kubeconfig(state: &AppState) -> Result<Vec<ContextDescriptor>, KubixError> {
    let discovery = config::discover_from_env()?;
    let paths = discovery.sources.clone();
    for warning in &discovery.warnings {
        warn!(%warning, "kubeconfig warning");
    }
    let mut merged = Kubeconfig::default();
    for path in &paths {
        let loaded =
            Kubeconfig::read_from(path).map_err(|e| KubixError::KubeconfigParseFailed {
                message: format!("{}: {e}", path.display()),
            })?;
        merged.clusters.extend(loaded.clusters);
        merged.contexts.extend(loaded.contexts);
        merged.auth_infos.extend(loaded.auth_infos);
        merged.current_context = merged.current_context.or(loaded.current_context);
    }
    let descriptors = discovery.contexts;
    state.manager.load(descriptors.clone(), merged).await;
    Ok(descriptors)
}

fn contexts_dto(state: &AppState, descriptors: &[ContextDescriptor]) -> Vec<ClusterContextDto> {
    let _ = state;
    descriptors
        .iter()
        .map(|d| ClusterContextDto::from_descriptor(d, ConnectionState::Disconnected))
        .collect()
}

async fn emit_context(app: &AppHandle, dto: &ClusterContextDto) {
    if let Err(e) = app.emit(CONTEXT_STATE, dto) {
        warn!(error = %e, "failed to emit context state");
    }
}

#[tauri::command]
async fn list_contexts(
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<Vec<ClusterContextDto>> {
    let descriptors = refresh_kubeconfig(&state)
        .await
        .map_err(|e| map_err(e, None))?;
    let dtos = contexts_dto(&state, &descriptors);
    for dto in &dtos {
        emit_context(&app, dto).await;
    }
    Ok(dtos)
}

#[tauri::command]
async fn rescan_kubeconfig(
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<Vec<ClusterContextDto>> {
    list_contexts(app, state).await
}

async fn disconnect_context_state(state: &AppState, context_id: &str) -> Option<ClusterContextDto> {
    // Stop every watch belonging to this context before dropping the client.
    let mut watches = state.watches.lock().await;
    let stale: Vec<String> = watches
        .keys()
        .filter(|k| k.starts_with(&format!("{context_id}\u{0}")))
        .cloned()
        .collect();
    for key in stale {
        if let Some(task) = watches.remove(&key) {
            task.handle.abort();
            let mut registry = state.registry.lock().await;
            registry.remove(&key);
        }
    }
    drop(watches);

    // Close any open interactive container shells belonging to this context.
    let mut shells = state.shells.lock().await;
    let stale_shells: Vec<String> = shells
        .iter()
        .filter(|(_, s)| s.context_id == context_id)
        .map(|(id, _)| id.clone())
        .collect();
    for sid in stale_shells {
        if let Some(session) = shells.remove(&sid) {
            session.handle.abort();
        }
    }
    drop(shells);

    // Stop any active local port-forward listeners belonging to this context.
    let mut forwards = state.port_forwards.lock().await;
    let stale_forwards: Vec<String> = forwards
        .iter()
        .filter(|(_, f)| f.dto.context_id == context_id)
        .map(|(id, _)| id.clone())
        .collect();
    for fid in stale_forwards {
        if let Some(session) = forwards.remove(&fid) {
            session.handle.abort();
        }
    }
    drop(forwards);

    let mut log_streams = state.log_streams.lock().await;
    let stale_streams: Vec<String> = log_streams
        .iter()
        .filter(|(_, s)| s.context_id == context_id)
        .map(|(k, _)| k.clone())
        .collect();
    for sid in stale_streams {
        if let Some(stream) = log_streams.remove(&sid) {
            for handle in stream.handles {
                handle.abort();
            }
        }
    }
    drop(log_streams);

    let dto = state.manager.disconnect(context_id).await?;
    state.discovery_cache.write().await.remove(context_id);
    Some(dto)
}

#[tauri::command]
async fn connect_context(
    app: AppHandle,
    state: State<'_, AppState>,
    args: ContextArgs,
) -> CommandResult<ClusterContextDto> {
    if !state.manager.has_config().await {
        refresh_kubeconfig(&state)
            .await
            .map_err(|e| map_err(e, None))?;
    }

    // Single-cluster profile rule: disconnect any other active cluster first.
    let connected = state.manager.connected_ids().await;
    for other_id in connected {
        if other_id != args.context_id {
            if let Some(disconnected_dto) = disconnect_context_state(&state, &other_id).await {
                emit_context(&app, &disconnected_dto).await;
            }
        }
    }

    let dto = state
        .manager
        .connect(&args.context_id)
        .await
        .map_err(map_contextual)?;
    emit_context(&app, &dto).await;
    Ok(dto)
}

#[tauri::command]
async fn disconnect_context(
    app: AppHandle,
    state: State<'_, AppState>,
    args: ContextArgs,
) -> CommandResult<ClusterContextDto> {
    let dto = disconnect_context_state(&state, &args.context_id)
        .await
        .ok_or_else(|| {
            map_err(
                KubixError::UnknownContext {
                    context_id: args.context_id.clone(),
                },
                Some(args.context_id.clone()),
            )
        })?;
    emit_context(&app, &dto).await;
    Ok(dto)
}

fn push_api_resource_list(
    out: &mut Vec<ApiResourceEntry>,
    group: &str,
    version: &str,
    list: k8s_openapi::apimachinery::pkg::apis::meta::v1::APIResourceList,
) {
    for res in list.resources {
        out.push(ApiResourceEntry {
            group: res.group.unwrap_or_else(|| group.to_string()),
            version: res.version.unwrap_or_else(|| version.to_string()),
            plural: res.name,
            kind: res.kind,
            namespaced: res.namespaced,
            short_names: res.short_names.unwrap_or_default(),
            verbs: res.verbs,
        });
    }
}

/// Resilient per-group discovery fallback: fetches core `/api` and each `/apis/<group>/<version>`
/// concurrently and skips any individual group/version that fails (e.g. a broken/503 aggregated
/// APIService) instead of aborting discovery for the entire cluster.
async fn resilient_group_discovery(
    client: kube::Client,
) -> Result<Vec<ApiResourceEntry>, KubixError> {
    use futures::StreamExt;

    let mut entries = Vec::new();
    let mut first_error: Option<String> = None;

    match client.list_core_api_versions().await {
        Ok(core_versions) => {
            for ver in core_versions.versions {
                match client.list_core_api_resources(&ver).await {
                    Ok(list) => push_api_resource_list(&mut entries, "", &ver, list),
                    Err(err) => {
                        tracing::warn!(version = %ver, error = %err, "skipping core api version during discovery");
                        if first_error.is_none() {
                            first_error = Some(err.to_string());
                        }
                    }
                }
            }
        }
        Err(err) => {
            tracing::warn!(error = %err, "failed to list core api versions");
            first_error = Some(err.to_string());
        }
    }

    match client.list_api_groups().await {
        Ok(api_groups) => {
            let mut group_versions: Vec<(String, String, String)> = Vec::new();
            for group in api_groups.groups {
                for ver in group.versions {
                    group_versions.push((group.name.clone(), ver.version, ver.group_version));
                }
            }

            let results: Vec<_> = futures::stream::iter(group_versions)
                .map(|(g, v, gv)| {
                    let c = client.clone();
                    async move { (g, v, gv.clone(), c.list_api_group_resources(&gv).await) }
                })
                .buffer_unordered(12)
                .collect()
                .await;

            for (g, v, gv, res) in results {
                match res {
                    Ok(list) => push_api_resource_list(&mut entries, &g, &v, list),
                    Err(err) => {
                        tracing::warn!(group_version = %gv, error = %err, "skipping unavailable api group during discovery");
                        if first_error.is_none() {
                            first_error = Some(err.to_string());
                        }
                    }
                }
            }
        }
        Err(err) => {
            tracing::warn!(error = %err, "failed to list api groups");
            if first_error.is_none() {
                first_error = Some(err.to_string());
            }
        }
    }

    if entries.is_empty() {
        return Err(KubixError::DiscoveryFailed {
            message: first_error.unwrap_or_else(|| "no API resources discovered".to_string()),
        });
    }
    Ok(entries)
}

pub(super) async fn resolve_discovery(
    state: &AppState,
    context_id: &str,
) -> Result<Vec<ApiResourceEntry>, KubixError> {
    if let Some(cached) = state.discovery_cache.read().await.get(context_id) {
        return Ok(cached.clone());
    }
    let client =
        state
            .manager
            .client(context_id)
            .await
            .ok_or_else(|| KubixError::AuthRequired {
                message: "context is not connected".to_string(),
            })?;

    // Use resilient per-group discovery so a single broken/503 aggregated APIService
    // (common on EKS clusters with optional metrics/webhook adapters) is skipped instead
    // of aborting discovery for all healthy core & CRD resources.
    let entries = resilient_group_discovery(client).await?;

    state
        .discovery_cache
        .write()
        .await
        .insert(context_id.to_string(), entries.clone());
    Ok(entries)
}

#[tauri::command]
async fn discover_resources(
    state: State<'_, AppState>,
    args: ContextArgs,
) -> CommandResult<Vec<DiscoveredResourceDto>> {
    let entries = resolve_discovery(&state, &args.context_id)
        .await
        .map_err(|e| map_err(e, Some(args.context_id.clone())))?;
    Ok(discovery::normalize(entries))
}

pub(super) async fn api_for(
    state: &AppState,
    context_id: &str,
    gvr: &str,
    namespace: &str,
) -> Result<Api<DynamicObject>, KubixError> {
    let entries = resolve_discovery(state, context_id).await?;
    let entry = discovery::find_gvr(&entries, gvr).ok_or_else(|| KubixError::DiscoveryFailed {
        message: format!("resource '{gvr}' is not served by this cluster"),
    })?;
    let client =
        state
            .manager
            .client(context_id)
            .await
            .ok_or_else(|| KubixError::AuthRequired {
                message: "context is not connected".to_string(),
            })?;
    let api: Api<DynamicObject> = if entry.namespaced && !namespace.is_empty() {
        Api::namespaced_with(client, namespace, &entry.api_resource())
    } else {
        Api::all_with(client, &entry.api_resource())
    };
    Ok(api)
}

#[tauri::command]
async fn list_resources(
    app: AppHandle,
    state: State<'_, AppState>,
    args: ListResourcesArgs,
) -> CommandResult<Vec<ResourceSummaryDto>> {
    if parse_gvr(&args.gvr).is_none() {
        return Err(map_err(
            KubixError::DiscoveryFailed {
                message: format!("malformed gvr '{}'", args.gvr),
            },
            Some(args.context_id.clone()),
        ));
    }

    let entries = resolve_discovery(&state, &args.context_id)
        .await
        .map_err(|e| map_err(e, Some(args.context_id.clone())))?;
    let entry = discovery::find_gvr(&entries, &args.gvr).ok_or_else(|| {
        map_err(
            KubixError::DiscoveryFailed {
                message: format!("resource '{}' is not served here", args.gvr),
            },
            Some(args.context_id.clone()),
        )
    })?;

    let api = api_for(&state, &args.context_id, &args.gvr, &args.namespace)
        .await
        .map_err(|e| map_err(e, Some(args.context_id.clone())))?;

    let list = api
        .list(&Default::default())
        .await
        .map_err(|e| map_err(KubixError::from_kube(e), Some(args.context_id.clone())))?;

    let kind = entry.kind.clone();
    let rows: Vec<ResourceSummaryDto> = list
        .items
        .iter()
        .filter_map(|obj| summarize(obj, &kind))
        .collect();

    start_watch(
        &app,
        &state,
        args.context_id.clone(),
        entry,
        args.namespace.clone(),
    )
    .await;
    Ok(rows)
}

async fn start_watch(
    app: &AppHandle,
    state: &AppState,
    context_id: String,
    entry: ApiResourceEntry,
    namespace: Namespace,
) {
    let gvr = entry.gvr();
    let key = watch_key(&context_id, &gvr, &namespace);

    {
        let watches = state.watches.lock().await;
        if watches.contains_key(&key) {
            return;
        }
    }

    let evicted_key = {
        let mut registry = state.registry.lock().await;
        registry.register(&key)
    };
    if let Some(evicted) = evicted_key {
        let mut watches = state.watches.lock().await;
        if let Some(task) = watches.remove(&evicted) {
            task.handle.abort();
            let parts: Vec<&str> = evicted.split('\u{0}').collect();
            let payload = WatchEvictedDto {
                context_id: parts.first().unwrap_or(&"").to_string(),
                gvr: parts.get(1).unwrap_or(&"").to_string(),
                namespace: parts.get(2).unwrap_or(&"").to_string(),
            };
            if let Err(e) = app.emit(WATCH_EVICTED, payload) {
                warn!(error = %e, "failed to emit watch eviction");
            }
        }
    }

    let app_handle = app.clone();
    let context_for_task = context_id.clone();
    let namespace_for_task = namespace.clone();
    let gvr_for_task = gvr.clone();
    let kind_for_task = entry.kind.clone();

    let api = match api_for(state, &context_id, &gvr, &namespace).await {
        Ok(api) => api,
        Err(e) => {
            warn!(error = %e, "cannot start watch: no api handle");
            return;
        }
    };

    let handle = tokio::spawn(async move {
        use futures::StreamExt;
        use kube::runtime::watcher;

        let mut accumulator = DeltaAccumulator::new(WatchBudget::default());
        let mut stream = Box::pin(watcher(api, Default::default()));
        let mut ticker = tokio::time::interval(accumulator_flush_interval());

        loop {
            tokio::select! {
                _ = ticker.tick() => {
                    if let Some(batch) = accumulator.tick(accumulator_flush_interval()) {
                        emit_batch(&app_handle, &context_for_task, &gvr_for_task, &namespace_for_task, &kind_for_task, batch);
                    }
                }
                item = stream.next() => {
                    match item {
                        None => break,
                        // A new list is starting: materialized rows are stale until the
                        // snapshot completes.
                        Some(Ok(watcher::Event::Init)) => {
                            maybe_flush(&app_handle, &context_for_task, &gvr_for_task, &namespace_for_task, &kind_for_task, &mut accumulator, WatchEvent::StartingSnapshot);
                        }
                        // Snapshot rows arrive one by one; they must be buffered, not
                        // dropped, or the UI only ever sees post-subscribe changes.
                        Some(Ok(watcher::Event::InitApply(obj))) => {
                            maybe_flush(&app_handle, &context_for_task, &gvr_for_task, &namespace_for_task, &kind_for_task, &mut accumulator, WatchEvent::Applied(Box::new(obj)));
                        }
                        Some(Ok(watcher::Event::InitDone)) => {
                            maybe_flush(&app_handle, &context_for_task, &gvr_for_task, &namespace_for_task, &kind_for_task, &mut accumulator, WatchEvent::SnapshotComplete);
                        }
                        Some(Ok(watcher::Event::Apply(obj))) => {
                            maybe_flush(&app_handle, &context_for_task, &gvr_for_task, &namespace_for_task, &kind_for_task, &mut accumulator, WatchEvent::Applied(Box::new(obj)));
                        }
                        Some(Ok(watcher::Event::Delete(obj))) => {
                            let uid = crate::watch::uid_of(&obj);
                            maybe_flush(&app_handle, &context_for_task, &gvr_for_task, &namespace_for_task, &kind_for_task, &mut accumulator, WatchEvent::Deleted(uid));
                        }
                        Some(Err(err)) => {
                            warn!(context = %context_for_task, gvr = %gvr_for_task, error = %err, "watch stream error");
                            maybe_flush(&app_handle, &context_for_task, &gvr_for_task, &namespace_for_task, &kind_for_task, &mut accumulator, WatchEvent::Error(err.to_string()));
                        }
                    }
                }
            }
        }
        info!(context = %context_for_task, gvr = %gvr_for_task, "watch stopped");
    });

    state.watches.lock().await.insert(key, WatchTask { handle });
}

fn accumulator_flush_interval() -> Duration {
    WatchBudget::default().flush_interval
}

fn maybe_flush(
    app: &AppHandle,
    context_id: &str,
    gvr: &str,
    namespace: &str,
    kind: &str,
    accumulator: &mut DeltaAccumulator,
    event: WatchEvent,
) {
    if let Some(batch) = accumulator.push(event) {
        emit_batch(app, context_id, gvr, namespace, kind, batch);
    }
}

fn emit_batch(
    app: &AppHandle,
    context_id: &str,
    gvr: &str,
    namespace: &str,
    kind: &str,
    mut batch: crate::watch::FlushedBatch,
) {
    batch
        .upserts
        .retain(|obj| crate::watch::in_namespace_filter(namespace, obj));
    let upserts: Vec<ResourceSummaryDto> = batch
        .upserts
        .iter()
        .filter_map(|obj| summarize(obj, kind))
        .collect();
    if upserts.is_empty() && batch.deletions.is_empty() && !batch.truncated {
        return;
    }
    let payload = ResourceDeltaDto {
        context_id: context_id.to_string(),
        gvr: gvr.to_string(),
        namespace: namespace.to_string(),
        batch_id: batch.batch_id,
        upserts,
        deletions: batch
            .deletions
            .iter()
            .map(|uid| ResourceDeletionDto { uid: uid.clone() })
            .collect(),
        truncated: batch.truncated,
        is_snapshot: batch.is_snapshot,
    };
    if let Err(e) = app.emit(RESOURCE_DELTA, payload) {
        warn!(error = %e, "failed to emit resource delta");
    }
}

#[tauri::command]
async fn stop_watch(state: State<'_, AppState>, args: StopWatchArgs) -> CommandResult<()> {
    let key = watch_key(&args.context_id, &args.gvr, &args.namespace);
    if let Some(task) = state.watches.lock().await.remove(&key) {
        task.handle.abort();
        state.registry.lock().await.remove(&key);
    }
    Ok(())
}

#[tauri::command]
async fn get_resource(
    state: State<'_, AppState>,
    args: GetResourceArgs,
) -> CommandResult<ResourceManifestDto> {
    let namespace = args.namespace.clone().unwrap_or_default();
    let api = api_for(&state, &args.context_id, &args.gvr, &namespace)
        .await
        .map_err(|e| map_err(e, Some(args.context_id.clone())))?;

    let obj = api
        .get(&args.name)
        .await
        .map_err(|e| map_err(KubixError::from_kube(e), Some(args.context_id.clone())))?;

    // Serialize the full DynamicObject (apiVersion, kind, metadata, spec, status, data)
    // instead of `obj.data` alone, which strips `metadata` and `types`.
    let raw_value = serde_json::to_value(&obj).map_err(|e| {
        map_err(
            KubixError::internal(format!("cannot serialize resource: {e}")),
            Some(args.context_id.clone()),
        )
    })?;
    let (value, masked_paths) = mask_secrets(&args.gvr, raw_value);
    let yaml = serde_yaml::to_string(&value).map_err(|e| {
        map_err(
            KubixError::internal(format!("cannot render yaml: {e}")),
            Some(args.context_id.clone()),
        )
    })?;

    Ok(ResourceManifestDto {
        context_id: args.context_id,
        gvr: args.gvr,
        name: args.name,
        namespace: obj.metadata.namespace,
        yaml,
        masked_paths,
    })
}

/// Secrets never leave the backend unmasked. Returns the redacted document plus the
/// JSON paths that were redacted so the UI can annotate them.
pub fn mask_secrets(gvr: &str, mut data: Value) -> (Value, Vec<String>) {
    let is_secret = gvr.ends_with("/secrets") || gvr == "/v1/secrets" || gvr.ends_with("/secret");
    if !is_secret {
        return (data, Vec::new());
    }
    let mut paths = Vec::new();
    if let Some(object) = data.as_object_mut() {
        for key in ["data", "stringData"] {
            if let Some(field) = object.get_mut(key).and_then(Value::as_object_mut) {
                for (entry_key, entry_value) in field.iter_mut() {
                    paths.push(format!("/{key}/{entry_key}"));
                    *entry_value = Value::String(SECRET_MASK.to_string());
                }
            }
        }
    }
    (data, paths)
}

const MENU_CLOSE_TAB_ID: &str = "close-tab";
const MENU_CLOSE_WINDOW_ID: &str = "close-window";

fn build_app_menu<R: tauri::Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let close_tab = MenuItem::with_id(
        app,
        MENU_CLOSE_TAB_ID,
        "Close Tab",
        true,
        Some("CmdOrCtrl+W"),
    )?;
    let close_window = MenuItem::with_id(
        app,
        MENU_CLOSE_WINDOW_ID,
        "Close Window",
        true,
        Some("CmdOrCtrl+Shift+W"),
    )?;

    let file_menu = Submenu::with_items(app, "File", true, &[&close_tab, &close_window])?;
    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let view_menu = Submenu::with_items(
        app,
        "View",
        true,
        &[&PredefinedMenuItem::fullscreen(app, None)?],
    )?;
    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
        ],
    )?;

    #[cfg(target_os = "macos")]
    {
        let app_menu = Submenu::with_items(
            app,
            "Kubix",
            true,
            &[
                &PredefinedMenuItem::about(app, None, None)?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::services(app, None)?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::hide(app, None)?,
                &PredefinedMenuItem::hide_others(app, None)?,
                &PredefinedMenuItem::show_all(app, None)?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::quit(app, None)?,
            ],
        )?;
        Menu::with_items(
            app,
            &[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu],
        )
    }

    #[cfg(not(target_os = "macos"))]
    {
        Menu::with_items(app, &[&file_menu, &edit_menu, &view_menu, &window_menu])
    }
}

pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("kubix=info,warn")),
        )
        .init();

    tauri::Builder::default()
        .menu(build_app_menu)
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if id == MENU_CLOSE_TAB_ID {
                if let Err(e) = app.emit(CLOSE_ACTIVE_TAB, ()) {
                    warn!(error = %e, "failed to emit close-active-tab menu event");
                }
            } else if id == MENU_CLOSE_WINDOW_ID {
                if let Some(window) = app.get_webview_window("main") {
                    if let Err(e) = window.close() {
                        warn!(error = %e, "failed to close main window");
                    }
                }
            }
        })
        .setup(|app| {
            app.manage(AppState::new());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_contexts,
            rescan_kubeconfig,
            connect_context,
            disconnect_context,
            discover_resources,
            list_resources,
            get_resource,
            logs::get_pod_logs,
            logs::start_log_stream,
            logs::stop_log_stream,
            shell::start_shell,
            shell::send_shell_input,
            shell::resize_shell,
            shell::close_shell,
            shell::start_port_forward,
            shell::stop_port_forward,
            shell::list_port_forwards,
            telemetry::get_cluster_overview,
            security::get_cluster_security_audit,
            telemetry::get_resource_events,
            telemetry::get_resource_metrics,
            topology::get_namespace_topology,
            stop_watch
        ])
        .run(tauri::generate_context!())
        .expect("error while running Kubix");
}

#[cfg(test)]
mod tests {
    use super::logs::{
        build_pod_log_params, should_fallback_to_init_containers, should_stream_init_containers,
    };
    use super::security::audit_pods;
    use super::topology::{build_namespace_topology, NamespaceTopologyInput};
    use super::*;
    use crate::ipc::dto::GetPodLogsArgs;

    #[test]
    fn watch_keys_do_not_collide_across_parts() {
        let a = watch_key("c", "/v1/pods", "");
        let b = watch_key("c", "/v1/pods", "default");
        let c = watch_key("c2", "/v1/pods", "");
        assert_ne!(a, b);
        assert_ne!(a, c);
        assert_eq!(a.split('\u{0}').count(), 3);
    }

    #[test]
    fn kubernetes_resource_quantities_parse_to_millicores_and_mib() {
        assert!((parse_cpu_millicores("12500000n") - 12.5).abs() < 0.01);
        assert!((parse_cpu_millicores("250u") - 0.25).abs() < 0.01);
        assert!((parse_cpu_millicores("500m") - 500.0).abs() < 0.01);
        assert!((parse_cpu_millicores("2") - 2000.0).abs() < 0.01);

        assert!((parse_memory_mib("65536Ki") - 64.0).abs() < 0.01);
        assert!((parse_memory_mib("128Mi") - 128.0).abs() < 0.01);
        assert!((parse_memory_mib("1.5Gi") - 1536.0).abs() < 0.01);
    }

    #[test]
    fn secret_data_is_masked_and_paths_reported() {
        let data = serde_json::json!({
            "data": {"password": "cGFzcw==", "token": "YWJj"},
            "stringData": {"api_key": "plain"},
            "metadata": {"name": "s"}
        });
        let (masked, paths) = mask_secrets("/v1/secrets", data);
        assert_eq!(masked["data"]["password"], SECRET_MASK);
        assert_eq!(masked["data"]["token"], SECRET_MASK);
        assert_eq!(masked["stringData"]["api_key"], SECRET_MASK);
        assert_eq!(masked["metadata"]["name"], "s");
        assert_eq!(paths.len(), 3);
        assert!(paths.contains(&"/data/password".to_string()));
        assert!(paths.contains(&"/stringData/api_key".to_string()));
        let raw = serde_json::to_string(&masked).unwrap();
        assert!(!raw.contains("cGFzcw=="));
        assert!(!raw.contains("plain"));
    }

    #[test]
    fn non_secrets_are_untouched() {
        let data = serde_json::json!({"data": {"a": "b"}});
        let (masked, paths) = mask_secrets("/v1/configmaps", data.clone());
        assert_eq!(masked, data);
        assert!(paths.is_empty());
    }

    #[test]
    fn secret_without_data_sections_is_safe() {
        let data = serde_json::json!({"metadata": {"name": "empty"}});
        let (masked, paths) = mask_secrets("/v1/secrets", data);
        assert!(paths.is_empty());
        assert_eq!(masked["metadata"]["name"], "empty");
    }

    #[test]
    fn connected_contexts_that_are_missing_descriptors_still_emit() {
        // Guards against a panic path in contexts_dto if descriptors change under us.
        let state = AppState::new();
        assert!(contexts_dto(&state, &[]).is_empty());
    }

    #[test]
    fn dynamic_object_serialization_preserves_metadata_and_masks_secrets() {
        let obj: DynamicObject = serde_json::from_value(serde_json::json!({
            "apiVersion": "v1",
            "kind": "Secret",
            "metadata": {
                "name": "kubix-demo-secret",
                "namespace": "kubix-demo",
                "uid": "85118ad2-0000-0000-0000-000000000001"
            },
            "type": "Opaque",
            "data": {
                "password": "c3VwZXItc2VjcmV0"
            }
        }))
        .unwrap();
        let val = serde_json::to_value(&obj).unwrap();
        let (masked, paths) = mask_secrets("/v1/secrets", val);
        assert_eq!(masked["apiVersion"], "v1");
        assert_eq!(masked["kind"], "Secret");
        assert_eq!(masked["metadata"]["name"], "kubix-demo-secret");
        assert_eq!(
            masked["metadata"]["uid"],
            "85118ad2-0000-0000-0000-000000000001"
        );
        assert_eq!(masked["data"]["password"], SECRET_MASK);
        assert_eq!(paths, vec!["/data/password"]);
    }

    #[test]
    fn pod_log_params_respects_previous_and_skips_init_fallback_when_previous() {
        let default_args: GetPodLogsArgs = serde_json::from_value(serde_json::json!({
            "contextId": "ctx-1",
            "gvr": "/v1/pods",
            "name": "web-0"
        }))
        .expect("deserialize without previous");
        assert_eq!(default_args.previous, None);

        let prev_args: GetPodLogsArgs = serde_json::from_value(serde_json::json!({
            "contextId": "ctx-1",
            "gvr": "/v1/pods",
            "name": "web-0",
            "previous": true
        }))
        .expect("deserialize with previous");
        assert_eq!(prev_args.previous, Some(true));

        let lp = build_pod_log_params(Some("app".to_string()), Some(200), true, false);
        assert!(lp.previous);
        assert!(lp.timestamps);
        assert!(!lp.follow);
        assert_eq!(lp.container.as_deref(), Some("app"));
        assert_eq!(lp.tail_lines, Some(200));

        let lp_all = build_pod_log_params(None, Some(0), false, true);
        assert!(lp_all.follow);
        assert_eq!(lp_all.tail_lines, None);

        assert!(should_fallback_to_init_containers(false, false, true));
        assert!(!should_fallback_to_init_containers(true, false, true));
        assert!(!should_fallback_to_init_containers(false, true, true));
    }

    #[test]
    fn security_audit_detects_privileged_host_root_limits_latest_and_default_sa() {
        use k8s_openapi::api::core::v1::Pod;

        let risky_pod: Pod = serde_json::from_value(serde_json::json!({
            "apiVersion": "v1",
            "kind": "Pod",
            "metadata": {
                "name": "risky-app-0",
                "namespace": "staging"
            },
            "spec": {
                "hostNetwork": true,
                "containers": [
                    {
                        "name": "evil",
                        "image": "nginx:latest",
                        "securityContext": {
                            "privileged": true,
                            "runAsUser": 0
                        }
                    },
                    {
                        "name": "good",
                        "image": "ghcr.io/org/api:v1.2.3",
                        "securityContext": {
                            "runAsNonRoot": true,
                            "privileged": false
                        },
                        "resources": {
                            "limits": {
                                "cpu": "500m",
                                "memory": "256Mi"
                            }
                        }
                    }
                ]
            }
        }))
        .expect("valid pod");

        let report = audit_pods("ctx-1", &[risky_pod]);
        assert_eq!(report.scanned_pods, 1);
        assert_eq!(report.scanned_containers, 2);
        assert_eq!(report.critical_count, 1);
        assert_eq!(report.high_count, 2);
        assert_eq!(report.medium_count, 1);
        assert_eq!(report.low_count, 2);
        assert!(report
            .findings
            .iter()
            .all(|f| f.container_name.as_deref() != Some("good")));
    }

    #[test]
    fn security_audit_audits_init_containers_and_skips_completed_pods() {
        use k8s_openapi::api::core::v1::Pod;

        let active_with_init: Pod = serde_json::from_value(serde_json::json!({
            "apiVersion": "v1",
            "kind": "Pod",
            "metadata": { "name": "api-0", "namespace": "prod" },
            "status": { "phase": "Running" },
            "spec": {
                "serviceAccountName": "api-sa",
                "initContainers": [
                    {
                        "name": "setup",
                        "image": "busybox:1.36",
                        "securityContext": { "privileged": true, "runAsNonRoot": true },
                        "resources": { "limits": { "cpu": "100m", "memory": "64Mi" } }
                    }
                ],
                "containers": [
                    {
                        "name": "app",
                        "image": "app:v1",
                        "securityContext": { "runAsNonRoot": true },
                        "resources": { "limits": { "cpu": "500m", "memory": "256Mi" } }
                    }
                ]
            }
        }))
        .expect("active pod");

        let succeeded_job_pod: Pod = serde_json::from_value(serde_json::json!({
            "apiVersion": "v1",
            "kind": "Pod",
            "metadata": { "name": "cron-done-1", "namespace": "prod" },
            "status": { "phase": "Succeeded" },
            "spec": {
                "containers": [
                    {
                        "name": "job",
                        "image": "alpine:latest",
                        "securityContext": { "privileged": true }
                    }
                ]
            }
        }))
        .expect("succeeded pod");

        let report = audit_pods("ctx-1", &[active_with_init, succeeded_job_pod]);
        assert_eq!(report.scanned_pods, 1);
        assert_eq!(report.scanned_containers, 2);
        assert_eq!(report.critical_count, 1);
        assert!(
            report
                .findings
                .iter()
                .any(|f| f.container_name.as_deref() == Some("init:setup")
                    && f.severity == "critical")
        );
        assert!(report.findings.iter().all(|f| f.pod_name != "cron-done-1"));
    }

    #[test]
    fn should_stream_init_containers_detects_initializing_pod() {
        use k8s_openapi::api::core::v1::Pod;

        let init_failing: Pod = serde_json::from_value(serde_json::json!({
            "apiVersion": "v1",
            "kind": "Pod",
            "metadata": { "name": "booting-0" },
            "status": {
                "phase": "Pending",
                "initContainerStatuses": [{ "name": "init-db", "ready": false, "restartCount": 1, "image": "x", "imageID": "" }]
            },
            "spec": {
                "initContainers": [{ "name": "init-db", "image": "x" }],
                "containers": [{ "name": "app", "image": "y" }]
            }
        }))
        .unwrap();

        let running_ready: Pod = serde_json::from_value(serde_json::json!({
            "apiVersion": "v1",
            "kind": "Pod",
            "metadata": { "name": "ready-0" },
            "status": {
                "phase": "Running",
                "initContainerStatuses": [{ "name": "init-db", "ready": true, "restartCount": 0, "image": "x", "imageID": "" }]
            },
            "spec": {
                "initContainers": [{ "name": "init-db", "image": "x" }],
                "containers": [{ "name": "app", "image": "y" }]
            }
        }))
        .unwrap();

        assert!(should_stream_init_containers(&init_failing));
        assert!(!should_stream_init_containers(&running_ready));
    }

    #[test]
    fn namespace_topology_wires_gateway_api_ingress_workloads_pods_hpa_and_pvc() {
        use k8s_openapi::api::apps::v1::{Deployment, ReplicaSet};
        use k8s_openapi::api::autoscaling::v2::HorizontalPodAutoscaler;
        use k8s_openapi::api::core::v1::{PersistentVolumeClaim, Pod, Service};
        use k8s_openapi::api::networking::v1::Ingress;

        let dep: Deployment = serde_json::from_value(serde_json::json!({
            "apiVersion": "apps/v1",
            "kind": "Deployment",
            "metadata": { "name": "api", "namespace": "prod" },
            "spec": {
                "replicas": 2,
                "selector": { "matchLabels": { "app": "api" } },
                "template": {
                    "metadata": { "labels": { "app": "api" } },
                    "spec": {
                        "containers": [{ "name": "api", "image": "ghcr.io/acme/api:1.2" }],
                        "volumes": [{ "name": "data", "persistentVolumeClaim": { "claimName": "api-data" } }]
                    }
                }
            },
            "status": { "readyReplicas": 2 }
        }))
        .unwrap();

        let rs: ReplicaSet = serde_json::from_value(serde_json::json!({
            "apiVersion": "apps/v1",
            "kind": "ReplicaSet",
            "metadata": {
                "name": "api-7f8d",
                "namespace": "prod",
                "ownerReferences": [{ "apiVersion": "apps/v1", "kind": "Deployment", "name": "api", "uid": "u1" }]
            }
        }))
        .unwrap();

        let pod: Pod = serde_json::from_value(serde_json::json!({
            "apiVersion": "v1",
            "kind": "Pod",
            "metadata": {
                "name": "api-7f8d-abc",
                "namespace": "prod",
                "labels": { "app": "api" },
                "ownerReferences": [{ "apiVersion": "apps/v1", "kind": "ReplicaSet", "name": "api-7f8d", "uid": "u2" }]
            },
            "spec": { "nodeName": "node-a", "containers": [{ "name": "api", "image": "ghcr.io/acme/api:1.2" }] },
            "status": { "phase": "Running", "podIP": "10.0.0.5", "conditions": [{ "type": "Ready", "status": "True" }] }
        }))
        .unwrap();

        let svc: Service = serde_json::from_value(serde_json::json!({
            "apiVersion": "v1",
            "kind": "Service",
            "metadata": { "name": "api-svc", "namespace": "prod" },
            "spec": {
                "type": "ClusterIP",
                "clusterIP": "10.96.1.10",
                "selector": { "app": "api" },
                "ports": [{ "port": 8080, "targetPort": 8080 }]
            }
        }))
        .unwrap();

        let ing: Ingress = serde_json::from_value(serde_json::json!({
            "apiVersion": "networking.k8s.io/v1",
            "kind": "Ingress",
            "metadata": { "name": "legacy-ing", "namespace": "prod" },
            "spec": {
                "ingressClassName": "nginx",
                "rules": [{
                    "host": "legacy.example.com",
                    "http": {
                        "paths": [{
                            "path": "/v1",
                            "pathType": "Prefix",
                            "backend": { "service": { "name": "api-svc", "port": { "number": 8080 } } }
                        }]
                    }
                }]
            }
        }))
        .unwrap();

        let hpa: HorizontalPodAutoscaler = serde_json::from_value(serde_json::json!({
            "apiVersion": "autoscaling/v2",
            "kind": "HorizontalPodAutoscaler",
            "metadata": { "name": "api-hpa", "namespace": "prod" },
            "spec": {
                "scaleTargetRef": { "apiVersion": "apps/v1", "kind": "Deployment", "name": "api" },
                "minReplicas": 2,
                "maxReplicas": 8
            },
            "status": { "currentReplicas": 2 }
        }))
        .unwrap();

        let pvc: PersistentVolumeClaim = serde_json::from_value(serde_json::json!({
            "apiVersion": "v1",
            "kind": "PersistentVolumeClaim",
            "metadata": { "name": "api-data", "namespace": "prod" },
            "spec": { "storageClassName": "gp3" },
            "status": { "phase": "Bound", "capacity": { "storage": "20Gi" } }
        }))
        .unwrap();

        let gw: DynamicObject = serde_json::from_value(serde_json::json!({
            "apiVersion": "gateway.networking.k8s.io/v1",
            "kind": "Gateway",
            "metadata": { "name": "edge-gw", "namespace": "gateway-system" },
            "spec": {
                "gatewayClassName": "envoy",
                "listeners": [{ "name": "https", "port": 443, "protocol": "HTTPS" }]
            },
            "status": { "conditions": [{ "type": "Programmed", "status": "True" }] }
        }))
        .unwrap();

        let http_route: DynamicObject = serde_json::from_value(serde_json::json!({
            "apiVersion": "gateway.networking.k8s.io/v1",
            "kind": "HTTPRoute",
            "metadata": { "name": "api-route", "namespace": "prod" },
            "spec": {
                "hostnames": ["api.example.com"],
                "parentRefs": [{ "name": "edge-gw", "namespace": "gateway-system", "sectionName": "https" }],
                "rules": [{
                    "matches": [{ "path": { "type": "PathPrefix", "value": "/api" } }],
                    "backendRefs": [{ "name": "api-svc", "port": 8080, "weight": 100 }]
                }]
            },
            "status": { "parents": [{ "conditions": [{ "type": "Accepted", "status": "True" }] }] }
        }))
        .unwrap();

        let topo = build_namespace_topology(NamespaceTopologyInput {
            context_id: "ctx-1".to_string(),
            namespace: "prod".to_string(),
            gateway_api_detected: true,
            gateway_api_kinds: vec!["Gateway".to_string(), "HTTPRoute".to_string()],
            gateway_gvr: Some("gateway.networking.k8s.io/v1/gateways".to_string()),
            ingresses: vec![ing],
            services: vec![svc],
            deployments: vec![dep],
            statefulsets: vec![],
            daemonsets: vec![],
            replicasets: vec![rs],
            jobs: vec![],
            pods: vec![pod],
            hpas: vec![hpa],
            pvcs: vec![pvc],
            gateways: vec![("gateway.networking.k8s.io/v1/gateways".to_string(), gw)],
            routes: vec![(
                "HTTPRoute".to_string(),
                "gateway.networking.k8s.io/v1/httproutes".to_string(),
                http_route,
            )],
            certificates: vec![],
            discovered_gvrs: HashMap::new(),
        });

        assert!(topo.gateway_api_detected);
        let gw_node = topo
            .nodes
            .iter()
            .find(|n| n.kind == "Gateway" && n.name == "edge-gw")
            .expect("Gateway node");
        assert!(gw_node.external);
        assert_eq!(gw_node.namespace, "gateway-system");
        assert_eq!(gw_node.status, "Ready");

        let dep_node = topo
            .nodes
            .iter()
            .find(|n| n.kind == "Deployment" && n.name == "api")
            .expect("Deployment node");
        assert_eq!(dep_node.pod_count, Some(1));
        assert_eq!(dep_node.ready_pod_count, Some(1));

        let pod_node = topo
            .nodes
            .iter()
            .find(|n| n.kind == "Pod" && n.name == "api-7f8d-abc")
            .expect("Pod node");
        assert_eq!(
            pod_node.parent_workload_id.as_deref(),
            Some("Deployment/prod/api")
        );

        let has_edge =
            |from: &str, to: &str| topo.edges.iter().find(|e| e.from == from && e.to == to);
        let gw_to_route = has_edge("Gateway/gateway-system/edge-gw", "HTTPRoute/prod/api-route")
            .expect("Gateway -> HTTPRoute");
        assert!(gw_to_route.cross_namespace);
        assert!(gw_to_route.label.contains("https"));

        let route_to_svc = has_edge("HTTPRoute/prod/api-route", "Service/prod/api-svc")
            .expect("HTTPRoute -> Service");
        assert!(route_to_svc.label.contains("/api"));
        assert!(route_to_svc.label.contains(":8080"));

        assert!(has_edge("Ingress/prod/legacy-ing", "Service/prod/api-svc").is_some());
        assert!(has_edge("Service/prod/api-svc", "Deployment/prod/api").is_some());
        assert!(has_edge("Deployment/prod/api", "Pod/prod/api-7f8d-abc").is_some());
        assert!(has_edge(
            "HorizontalPodAutoscaler/prod/api-hpa",
            "Deployment/prod/api"
        )
        .is_some());
        assert!(has_edge("Deployment/prod/api", "PersistentVolumeClaim/prod/api-data").is_some());
    }

    #[test]
    fn namespace_topology_wires_operator_crs_and_tls_secrets_with_certificates() {
        use k8s_openapi::api::apps::v1::StatefulSet;
        use k8s_openapi::api::core::v1::{Pod, Service};
        use k8s_openapi::api::networking::v1::Ingress;

        let mq_sts: StatefulSet = serde_json::from_value(serde_json::json!({
            "apiVersion": "apps/v1",
            "kind": "StatefulSet",
            "metadata": {
                "name": "mq-server",
                "namespace": "prod",
                "ownerReferences": [{
                    "apiVersion": "rabbitmq.com/v1beta1",
                    "kind": "RabbitmqCluster",
                    "name": "mq-cluster",
                    "uid": "rmq-1"
                }]
            },
            "spec": {
                "replicas": 1,
                "serviceName": "mq-nodes",
                "selector": { "matchLabels": { "app": "mq" } },
                "template": {
                    "metadata": { "labels": { "app": "mq" } },
                    "spec": { "containers": [{ "name": "rabbitmq", "image": "rabbitmq:3.13" }] }
                }
            },
            "status": { "readyReplicas": 1 }
        }))
        .unwrap();

        let kb_pod: Pod = serde_json::from_value(serde_json::json!({
            "apiVersion": "v1",
            "kind": "Pod",
            "metadata": {
                "name": "pg-0",
                "namespace": "prod",
                "labels": { "app": "pg" },
                "ownerReferences": [{
                    "apiVersion": "workloads.kubeblocks.io/v1alpha1",
                    "kind": "InstanceSet",
                    "name": "pg",
                    "uid": "kb-1"
                }]
            },
            "spec": { "nodeName": "node-1", "containers": [{ "name": "pg", "image": "postgres:16" }] },
            "status": { "phase": "Running", "conditions": [{ "type": "Ready", "status": "True" }] }
        }))
        .unwrap();

        let pg_svc: Service = serde_json::from_value(serde_json::json!({
            "apiVersion": "v1",
            "kind": "Service",
            "metadata": { "name": "pg-svc", "namespace": "prod" },
            "spec": {
                "type": "ClusterIP",
                "selector": { "app": "pg" },
                "ports": [{ "port": 5432 }]
            }
        }))
        .unwrap();

        let ing: Ingress = serde_json::from_value(serde_json::json!({
            "apiVersion": "networking.k8s.io/v1",
            "kind": "Ingress",
            "metadata": { "name": "app-ing", "namespace": "prod" },
            "spec": {
                "tls": [{ "hosts": ["app.example.com"], "secretName": "app-tls" }],
                "rules": [{
                    "host": "app.example.com",
                    "http": {
                        "paths": [{
                            "path": "/",
                            "pathType": "Prefix",
                            "backend": { "service": { "name": "pg-svc", "port": { "number": 5432 } } }
                        }]
                    }
                }]
            }
        }))
        .unwrap();

        let gw: DynamicObject = serde_json::from_value(serde_json::json!({
            "apiVersion": "gateway.networking.k8s.io/v1",
            "kind": "Gateway",
            "metadata": { "name": "edge-gw", "namespace": "envoy-gateway-system" },
            "spec": {
                "gatewayClassName": "envoy",
                "listeners": [{
                    "name": "https",
                    "port": 443,
                    "protocol": "HTTPS",
                    "tls": { "certificateRefs": [{ "name": "edge-tls" }] }
                }]
            },
            "status": { "conditions": [{ "type": "Programmed", "status": "True" }] }
        }))
        .unwrap();

        let cert: DynamicObject = serde_json::from_value(serde_json::json!({
            "apiVersion": "cert-manager.io/v1",
            "kind": "Certificate",
            "metadata": { "name": "app-tls-cert", "namespace": "prod" },
            "spec": {
                "secretName": "app-tls",
                "dnsNames": ["app.example.com"],
                "issuerRef": { "name": "letsencrypt-prod" }
            },
            "status": {
                "notAfter": "2027-01-15T00:00:00Z",
                "conditions": [{ "type": "Ready", "status": "True" }]
            }
        }))
        .unwrap();

        let mut discovered_gvrs = HashMap::new();
        discovered_gvrs.insert(
            (
                "rabbitmq.com/v1beta1".to_string(),
                "RabbitmqCluster".to_string(),
            ),
            "rabbitmq.com/v1beta1/rabbitmqclusters".to_string(),
        );
        discovered_gvrs.insert(
            (
                "workloads.kubeblocks.io/v1alpha1".to_string(),
                "InstanceSet".to_string(),
            ),
            "workloads.kubeblocks.io/v1alpha1/instancesets".to_string(),
        );

        let topo = build_namespace_topology(NamespaceTopologyInput {
            context_id: "ctx-1".to_string(),
            namespace: "prod".to_string(),
            gateway_api_detected: true,
            gateway_api_kinds: vec!["Gateway".to_string()],
            gateway_gvr: Some("gateway.networking.k8s.io/v1/gateways".to_string()),
            ingresses: vec![ing],
            services: vec![pg_svc],
            deployments: vec![],
            statefulsets: vec![mq_sts],
            daemonsets: vec![],
            replicasets: vec![],
            jobs: vec![],
            pods: vec![kb_pod],
            hpas: vec![],
            pvcs: vec![],
            gateways: vec![("gateway.networking.k8s.io/v1/gateways".to_string(), gw)],
            routes: vec![],
            certificates: vec![("cert-manager.io/v1/certificates".to_string(), cert)],
            discovered_gvrs,
        });

        let has_edge =
            |from: &str, to: &str| topo.edges.iter().find(|e| e.from == from && e.to == to);

        // 1. Workload-owning Operator CR (RabbitmqCluster -> StatefulSet)
        let rmq = topo
            .nodes
            .iter()
            .find(|n| n.kind == "RabbitmqCluster" && n.name == "mq-cluster")
            .expect("RabbitmqCluster node");
        assert_eq!(rmq.layer, "operator");
        assert_eq!(rmq.gvr, "rabbitmq.com/v1beta1/rabbitmqclusters");
        assert!(has_edge(
            "RabbitmqCluster/prod/mq-cluster",
            "StatefulSet/prod/mq-server"
        )
        .is_some());

        // 2. Direct Pod-owning Operator CR (KubeBlocks InstanceSet -> Pod + Service -> InstanceSet)
        let inst = topo
            .nodes
            .iter()
            .find(|n| n.kind == "InstanceSet" && n.name == "pg")
            .expect("InstanceSet node");
        assert_eq!(inst.layer, "workload");
        assert_eq!(inst.gvr, "workloads.kubeblocks.io/v1alpha1/instancesets");
        assert_eq!(inst.pod_count, Some(1));
        assert_eq!(inst.ready_pod_count, Some(1));
        assert!(has_edge("Service/prod/pg-svc", "InstanceSet/prod/pg").is_some());
        assert!(has_edge("InstanceSet/prod/pg", "Pod/prod/pg-0").is_some());

        // 3. TLS Secrets from Ingress & Gateway + cert-manager Certificate -> Secret
        let app_tls = topo
            .nodes
            .iter()
            .find(|n| n.kind == "Secret" && n.name == "app-tls")
            .expect("Ingress TLS Secret");
        assert_eq!(app_tls.layer, "routing");
        assert!(has_edge("Ingress/prod/app-ing", "Secret/prod/app-tls").is_some());

        let edge_tls = topo
            .nodes
            .iter()
            .find(|n| n.kind == "Secret" && n.name == "edge-tls")
            .expect("Gateway TLS Secret");
        assert!(edge_tls.external);
        assert_eq!(edge_tls.namespace, "envoy-gateway-system");
        assert!(has_edge(
            "Gateway/envoy-gateway-system/edge-gw",
            "Secret/envoy-gateway-system/edge-tls"
        )
        .is_some());

        let cert_node = topo
            .nodes
            .iter()
            .find(|n| n.kind == "Certificate" && n.name == "app-tls-cert")
            .expect("cert-manager Certificate");
        assert_eq!(cert_node.status, "Ready");
        assert_eq!(cert_node.gvr, "cert-manager.io/v1/certificates");
        assert!(has_edge("Certificate/prod/app-tls-cert", "Secret/prod/app-tls").is_some());
    }
}
