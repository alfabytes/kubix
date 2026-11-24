import { useCallback, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  getIpcTransport,
  ipc,
  KubixIpcError,
  normalizeIpcError,
  onContextState,
  onResourceDelta,
  onShellOutput,
  onWatchEvicted,
  type EventPayloads,
  type UnlistenFn,
} from "@/lib/ipc/client";
import type {
  ClusterContextDto,
  ContextId,
  GroupVersionResource,
  Namespace,
  PodLogsDto,
  ResourceManifestDto,
} from "@/lib/ipc/types";
import { useClusterStore } from "@/stores/cluster-store";
import { useExplorerStore } from "@/stores/explorer-store";
import { useTerminalStore } from "@/stores/terminal-store";

export const contextKeys = {
  all: ["contexts"] as const,
  one: (id: ContextId) => ["contexts", id] as const,
};

export const discoveryKeys = {
  all: ["discovery"] as const,
  one: (id: ContextId) => ["discovery", id] as const,
};

export const resourceKeys = {
  list: (id: ContextId, gvr: GroupVersionResource, namespace: Namespace) =>
    ["resources", id, gvr, namespace] as const,
  one: (id: ContextId, gvr: GroupVersionResource, name: string, namespace?: string) =>
    ["resource", id, gvr, namespace ?? "", name] as const,
  logs: (
    id: ContextId,
    gvr: GroupVersionResource,
    name: string,
    namespace?: string,
    container?: string,
    tailLines?: number,
    previous?: boolean,
  ) =>
    [
      "pod-logs",
      id,
      gvr,
      namespace ?? "",
      name,
      container ?? "",
      tailLines ?? 200,
      Boolean(previous),
    ] as const,
};

function asMessage(error: unknown): string {
  return error instanceof KubixIpcError ? error.message : normalizeIpcError(error).message;
}

// ---- context lifecycle --------------------------------------------------------

export function useContextsQuery() {
  const replaceAll = useClusterStore((s) => s.replaceAll);
  const setLoading = useClusterStore((s) => s.setLoading);
  const setError = useClusterStore((s) => s.setError);

  return useQuery({
    queryKey: contextKeys.all,
    queryFn: async () => {
      setLoading(true);
      try {
        const contexts = await ipc.listContexts();
        replaceAll(contexts);
        return contexts;
      } catch (error) {
        setError(asMessage(error));
        throw error;
      }
    },
    staleTime: Infinity,
    retry: false,
  });
}

export function useRescanMutation() {
  const queryClient = useQueryClient();
  const replaceAll = useClusterStore((s) => s.replaceAll);
  return useMutation({
    mutationFn: () => ipc.rescanKubeconfig(),
    onSuccess: (contexts: ClusterContextDto[]) => {
      replaceAll(contexts);
      queryClient.setQueryData(contextKeys.all, contexts);
      queryClient.removeQueries({ queryKey: discoveryKeys.all });
    },
  });
}

export function useConnectMutation() {
  const queryClient = useQueryClient();
  const upsert = useClusterStore((s) => s.upsert);
  const patchState = useClusterStore((s) => s.patchState);
  const select = useClusterStore((s) => s.select);
  const setDiscovered = useExplorerStore((s) => s.setDiscovered);
  const setDiscoveryError = useExplorerStore((s) => s.setDiscoveryError);
  const clearContext = useExplorerStore((s) => s.clearContext);

  const loadDiscovery = useCallback(
    async (contextId: ContextId) => {
      try {
        const resources = await ipc.discoverResources(contextId);
        setDiscovered(contextId, resources, "ready");
        queryClient.setQueryData(discoveryKeys.one(contextId), resources);
      } catch (error) {
        setDiscoveryError(contextId, asMessage(error));
      }
    },
    [queryClient, setDiscovered, setDiscoveryError],
  );

  return useMutation({
    mutationFn: async (contextId: ContextId) => {
      // Single-cluster profile rule: disconnect any other active cluster first.
      const prevById = useClusterStore.getState().byId;
      for (const other of Object.values(prevById)) {
        if (other.id !== contextId && (other.state === "ready" || other.state === "degraded")) {
          patchState(other.id, "disconnected", false);
          clearContext(other.id);
          if (useClusterStore.getState().selectedId === other.id) {
            select(null);
          }
          queryClient.removeQueries({ queryKey: discoveryKeys.one(other.id) });
          queryClient.removeQueries({ queryKey: ["resources", other.id] });
          queryClient.removeQueries({ queryKey: ["resource", other.id] });
          void ipc.disconnectContext(other.id).catch(() => undefined);
        }
      }

      patchState(contextId, "connecting", true);
      setDiscoveryError(contextId, null);
      queryClient.removeQueries({ queryKey: discoveryKeys.one(contextId) });
      const dto = await ipc.connectContext(contextId);
      upsert(dto);
      if (dto.state === "ready" || dto.state === "degraded") {
        await loadDiscovery(contextId);
      }
      return dto;
    },
    onError: (error, contextId) => {
      const normalized = normalizeIpcError(error);
      const state = normalized.code === "authFailed" ? "authFailed"
        : normalized.code === "authRequired" ? "authRequired"
        : normalized.code === "forbidden" ? "forbidden" : "unreachable";
      patchState(contextId, state, false);
      const current = useClusterStore.getState().byId[contextId];
      if (current) upsert({
        ...current,
        state,
        lastError: {
          code: normalized.code,
          message: normalized.message,
          retryable: normalized.retryable,
          contextId,
        },
      });
    },
  });
}

export function useDisconnectMutation() {
  const queryClient = useQueryClient();
  const upsert = useClusterStore((s) => s.upsert);
  const patchState = useClusterStore((s) => s.patchState);
  const select = useClusterStore((s) => s.select);
  const clearContext = useExplorerStore((s) => s.clearContext);
  return useMutation({
    mutationFn: (contextId: ContextId) => ipc.disconnectContext(contextId),
    onSuccess: (dto, contextId) => {
      if (dto) upsert(dto);
      else patchState(contextId, "disconnected", false);
      if (useClusterStore.getState().selectedId === contextId) select(null);
      clearContext(contextId);
      useTerminalStore.getState().closeContextTabs(contextId);
      queryClient.removeQueries({ queryKey: discoveryKeys.one(contextId) });
      queryClient.removeQueries({ queryKey: ["resources", contextId] });
      queryClient.removeQueries({ queryKey: ["resource", contextId] });
    },
  });
}

// ---- discovery -----------------------------------------------------------------

export function useDiscoveryQuery(contextId: ContextId | null) {
  const cached = useExplorerStore((s) => (contextId ? s.discovered[contextId] : undefined));
  const setDiscovered = useExplorerStore((s) => s.setDiscovered);
  const contextState = useClusterStore((s) =>
    contextId ? s.byId[contextId]?.state : undefined,
  );
  const isConnected = contextState === "ready" || contextState === "degraded";

  return useQuery({
    queryKey: contextId ? discoveryKeys.one(contextId) : ["discovery", "none"],
    queryFn: async () => {
      const id = contextId as ContextId;
      const resources = await ipc.discoverResources(id);
      setDiscovered(id, resources, "ready");
      return resources;
    },
    enabled: !!contextId && isConnected && !cached,
    initialData: cached,
    staleTime: Infinity,
    retry: false,
  });
}

// ---- resource lists ------------------------------------------------------------

interface ListArgs {
  contextId: ContextId;
  gvr: GroupVersionResource;
  namespace: Namespace;
  enabled: boolean;
}

export function useResourceListQuery({ contextId, gvr, namespace, enabled }: ListArgs) {
  const beginLoad = useExplorerStore((s) => s.beginLoad);
  const mergeSnapshot = useExplorerStore((s) => s.mergeSnapshot);
  const failLoad = useExplorerStore((s) => s.failLoad);

  const key = { contextId, gvr, namespace };

  return useQuery({
    queryKey: resourceKeys.list(contextId, gvr, namespace),
    queryFn: async () => {
      // The backend starts the watch as part of this call, so the view must already
      // exist: a delta that wins the race with the list response has somewhere to go.
      beginLoad(key);
      try {
        const rows = await ipc.listResources(contextId, gvr, namespace);
        mergeSnapshot(key, rows);
        return rows;
      } catch (error) {
        failLoad(key, asMessage(error));
        throw error;
      }
    },
    enabled,
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  });
}

/**
 * Stops the watcher for a view. Keyed on the serialized key so React's dependency
 * comparison can not fire on an equal-but-new tuple, and skipped for an empty view.
 */
export function useStopWatchOnUnmount(
  contextId: ContextId | null,
  gvr: string | null,
  namespace: Namespace,
) {
  const key = contextId && gvr ? `${contextId}\u0000${gvr}\u0000${namespace}` : null;

  useEffect(() => {
    if (!key || !contextId || !gvr) return;
    const id = contextId;
    const target = gvr;
    const ns = namespace;
    return () => {
      void ipc.stopWatch(id, target, ns).catch(() => undefined);
    };
    // `key` encodes all three values; using it avoids re-running on equal tuples.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

// ---- single resource -----------------------------------------------------------

export function useResourceManifestQuery(
  contextId: ContextId | null,
  gvr: GroupVersionResource | null,
  name: string | null,
  namespace?: string,
) {
  return useQuery<ResourceManifestDto>({
    queryKey: contextId && gvr && name ? resourceKeys.one(contextId, gvr, name, namespace) : ["resource", "none"],
    queryFn: () => ipc.getResource(contextId as string, gvr as string, name as string, namespace),
    enabled: !!contextId && !!gvr && !!name,
    retry: false,
    gcTime: 5 * 60 * 1000,
  });
}

export function usePodLogsQuery(args: {
  contextId: ContextId | null;
  gvr: GroupVersionResource | null;
  name: string | null;
  namespace?: string;
  container?: string;
  tailLines?: number;
  previous?: boolean;
  enabled: boolean;
  refetchInterval?: number | false;
}) {
  const {
    contextId,
    gvr,
    name,
    namespace,
    container,
    tailLines = 200,
    previous = false,
    enabled,
    refetchInterval,
  } = args;
  return useQuery<PodLogsDto>({
    queryKey:
      contextId && gvr && name
        ? resourceKeys.logs(contextId, gvr, name, namespace, container, tailLines, previous)
        : ["pod-logs", "none"],
    queryFn: () =>
      ipc.getPodLogs(
        contextId as string,
        gvr as string,
        name as string,
        namespace,
        container,
        tailLines,
        previous,
      ),
    enabled: enabled && !!contextId && !!gvr && !!name,
    retry: false,
    refetchInterval,
  });
}

export function useNamespaceTopologyQuery(
  contextId: ContextId | null,
  namespace: Namespace,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["namespace-topology", contextId, namespace],
    queryFn: () => ipc.getNamespaceTopology(contextId!, namespace),
    enabled: Boolean(contextId) && enabled,
    retry: false,
    staleTime: 10_000,
  });
}

// ---- event bridge --------------------------------------------------------------

/**
 * Subscribes to the three backend events exactly once at app boot and fans them into
 * the stores. Returns a cleanup function so tests can unmount cleanly.
 */
export function useIpcEventBridge(): void {
  useEffect(() => {
    const transport = getIpcTransport();
    const unlisteners: UnlistenFn[] = [];
    let disposed = false;

    const register = (promise: Promise<UnlistenFn>) => {
      promise
        .then((unlisten) => {
          if (disposed) unlisten();
          else unlisteners.push(unlisten);
        })
        .catch(() => undefined);
    };

    register(onContextState((payload: EventPayloads["kubix://context-state"]) => {
      useClusterStore.getState().upsert(payload);
    }));

    register(onResourceDelta((payload: EventPayloads["kubix://resource-delta"]) => {
      useExplorerStore.getState().applyDelta(payload);
    }));

    register(onWatchEvicted((payload: EventPayloads["kubix://watch-evicted"]) => {
      useExplorerStore.getState().markEvicted({
        contextId: payload.contextId,
        gvr: payload.gvr,
        namespace: payload.namespace,
      });
    }));

    register(onShellOutput((payload: EventPayloads["kubix://shell-output"]) => {
      useTerminalStore.getState().pushOutput(payload);
    }));

    void transport;

    return () => {
      disposed = true;
      for (const unlisten of unlisteners) unlisten();
    };
  }, []);
}
