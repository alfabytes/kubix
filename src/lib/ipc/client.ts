import type {
  CommandArgs,
  CommandName,
  CommandResults,
  ContextId,
  ResourceSummaryDto,
  Namespace,
  GroupVersionResource,
  ResourceDeltaDto,
} from "./types";
import {
  CLOSE_ACTIVE_TAB_EVENT,
  CONTEXT_STATE_EVENT,
  POD_LOG_LINE_EVENT,
  RESOURCE_DELTA_EVENT,
  SHELL_OUTPUT_EVENT,
  WATCH_EVICTED_EVENT,
  KubixIpcError,
  normalizeIpcError,
  type EventName,
  type EventPayloads,
  type IpcTransport,
  type UnlistenFn,
} from "./events";

export type { EventName, EventPayloads, IpcTransport, UnlistenFn };
export { KubixIpcError, normalizeIpcError };

/**
 * Lazy Tauri transport. `@tauri-apps/api` is imported dynamically so the module is
 * importable in jsdom tests and in the browser without a Tauri host.
 *
 * Tauri's `#[tauri::command]` unwraps function-parameter names: a Rust handler taking
 * `args: ContextArgs` expects a top-level `args` key in the invoke payload, not the
 * DTO fields spread at the top level. Command types in `types.ts` stay flat, so the
 * wrapping lives here and nowhere else.
 */
export const tauriTransport: IpcTransport = {
  async invoke<C extends CommandName>(command: C, args: CommandArgs[C]): Promise<CommandResults[C]> {
    const { invoke } = await import("@tauri-apps/api/core");
    const payload = args === null || args === undefined ? {} : { args };
    try {
      return await invoke<CommandResults[C]>(command, payload);
    } catch (raw) {
      throw normalizeIpcError(raw);
    }
  },
  async listen<E extends EventName>(
    event: E,
    handler: (payload: EventPayloads[E]) => void,
  ): Promise<UnlistenFn> {
    const { listen } = await import("@tauri-apps/api/event");
    return listen<EventPayloads[E]>(event, (message) => handler(message.payload));
  },
};

let transport: IpcTransport = tauriTransport;

/** Test/DI seam. Restore with `setIpcTransport(tauriTransport)`. */
export function setIpcTransport(next: IpcTransport): void {
  transport = next;
}

export function getIpcTransport(): IpcTransport {
  return transport;
}

async function call<C extends CommandName>(
  command: C,
  args: CommandArgs[C],
): Promise<CommandResults[C]> {
  try {
    return await transport.invoke(command, args);
  } catch (raw) {
    throw normalizeIpcError(raw);
  }
}

// ---- commands (mirrors src-tauri/src/ipc/commands.rs, all read-only) ----------

export const ipc = {
  listContexts: () => call("list_contexts", null),
  rescanKubeconfig: () => call("rescan_kubeconfig", null),
  connectContext: (contextId: ContextId) => call("connect_context", { contextId }),
  disconnectContext: (contextId: ContextId) => call("disconnect_context", { contextId }),
  discoverResources: (contextId: ContextId) => call("discover_resources", { contextId }),
  listResources: (contextId: ContextId, gvr: GroupVersionResource, namespace: Namespace = "") =>
    call("list_resources", { contextId, gvr, namespace }),
  getResource: (contextId: ContextId, gvr: GroupVersionResource, name: string, namespace?: string) =>
    call("get_resource", { contextId, gvr, name, namespace }),
  getPodLogs: (
    contextId: ContextId,
    gvr: GroupVersionResource,
    name: string,
    namespace?: string,
    container?: string,
    tailLines?: number,
    previous?: boolean,
  ) =>
    call("get_pod_logs", { contextId, gvr, name, namespace, container, tailLines, previous }),
  startLogStream: (args: CommandArgs["start_log_stream"]) => call("start_log_stream", args),
  stopLogStream: (streamId: string) => call("stop_log_stream", { streamId }),
  startShell: (args: CommandArgs["start_shell"]) => call("start_shell", args),
  sendShellInput: (sessionId: string, data: string) =>
    call("send_shell_input", { sessionId, data }),
  resizeShell: (sessionId: string, cols: number, rows: number) =>
    call("resize_shell", { sessionId, cols, rows }),
  closeShell: (sessionId: string) => call("close_shell", { sessionId }),
  startPortForward: (args: CommandArgs["start_port_forward"]) =>
    call("start_port_forward", args),
  stopPortForward: (forwardId: string) => call("stop_port_forward", { forwardId }),
  listPortForwards: (contextId: ContextId) =>
    call("list_port_forwards", { contextId }),
  getClusterOverview: (contextId: ContextId) =>
    call("get_cluster_overview", { contextId }),
  getClusterSecurityAudit: (contextId: ContextId) =>
    call("get_cluster_security_audit", { contextId }),
  getResourceEvents: (
    contextId: ContextId,
    gvr: GroupVersionResource,
    name: string,
    namespace?: string,
  ) => call("get_resource_events", { contextId, gvr, name, namespace }),
  getResourceMetrics: (
    contextId: ContextId,
    gvr: GroupVersionResource,
    name: string,
    namespace?: string,
  ) => call("get_resource_metrics", { contextId, gvr, name, namespace }),
  getNamespaceTopology: (contextId: ContextId, namespace?: string) =>
    call("get_namespace_topology", { contextId, namespace }),
  stopWatch: (contextId: ContextId, gvr: GroupVersionResource, namespace: Namespace = "") =>
    call("stop_watch", { contextId, gvr, namespace }),
};

// ---- events -------------------------------------------------------------------

export function onContextState(
  handler: (payload: EventPayloads[typeof CONTEXT_STATE_EVENT]) => void,
): Promise<UnlistenFn> {
  return transport.listen(CONTEXT_STATE_EVENT, handler);
}

export function onResourceDelta(
  handler: (payload: EventPayloads[typeof RESOURCE_DELTA_EVENT]) => void,
): Promise<UnlistenFn> {
  return transport.listen(RESOURCE_DELTA_EVENT, handler);
}

export function onWatchEvicted(
  handler: (payload: EventPayloads[typeof WATCH_EVICTED_EVENT]) => void,
): Promise<UnlistenFn> {
  return transport.listen(WATCH_EVICTED_EVENT, handler);
}

export function onShellOutput(
  handler: (payload: EventPayloads[typeof SHELL_OUTPUT_EVENT]) => void,
): Promise<UnlistenFn> {
  return transport.listen(SHELL_OUTPUT_EVENT, handler);
}

export function onPodLogLine(
  handler: (payload: EventPayloads[typeof POD_LOG_LINE_EVENT]) => void,
): Promise<UnlistenFn> {
  return transport.listen(POD_LOG_LINE_EVENT, handler);
}

export function onCloseActiveTab(handler: () => void): Promise<UnlistenFn> {
  return transport.listen(CLOSE_ACTIVE_TAB_EVENT, () => handler());
}

// ---- delta application (pure, unit tested) ------------------------------------

export interface ResourceKey {
  contextId: ContextId;
  gvr: GroupVersionResource;
  namespace: Namespace;
}

export function resourceKeyString(key: ResourceKey): string {
  return `${key.contextId}\u0000${key.gvr}\u0000${key.namespace}`;
}

/** Returns `undefined` when the key is not tracked (stale delta after eviction). */
export function applyDelta(
  rows: ResourceSummaryDto[],
  delta: ResourceDeltaDto,
): ResourceSummaryDto[] | undefined {
  if (delta.isSnapshot) {
    // The watcher snapshot is authoritative: it replaces whatever the one-shot list
    // returned, including rows created before the list resolved.
    return [...delta.upserts].sort(compareRows);
  }
  if (delta.truncated && delta.upserts.length === 0 && delta.deletions.length === 0) {
    return undefined;
  }
  const deletions = new Set(delta.deletions.map((d) => d.uid));
  const upsertById = new Map(delta.upserts.map((row) => [row.uid, row]));

  const next: ResourceSummaryDto[] = [];
  for (const row of rows) {
    if (deletions.has(row.uid)) continue;
    const updated = upsertById.get(row.uid);
    if (updated) {
      next.push(updated);
      upsertById.delete(row.uid);
    } else {
      next.push(row);
    }
  }
  for (const row of upsertById.values()) next.push(row);
  next.sort(compareRows);
  return next;
}

export function compareRows(a: ResourceSummaryDto, b: ResourceSummaryDto): number {
  const ns = (a.namespace ?? "").localeCompare(b.namespace ?? "");
  if (ns !== 0) return ns;
  return a.name.localeCompare(b.name);
}
