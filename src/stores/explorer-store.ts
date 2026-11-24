import { create } from "zustand";

import { applyDelta, compareRows, resourceKeyString, type ResourceKey } from "@/lib/ipc/client";
import type {
  DiscoveredResourceDto,
  Namespace,
  ResourceDeltaDto,
  ResourceSummaryDto,
} from "@/lib/ipc/types";

export type ViewStatus = "idle" | "loading" | "ready" | "error" | "stale";

export interface ResourceView {
  status: ViewStatus;
  rows: ResourceSummaryDto[];
  error: string | null;
  /** Set when the backend evicted this watch; the user must reload. */
  evicted: boolean;
  /** True while a delta is arriving faster than we can render. */
  truncated: boolean;
  namespace: Namespace;
  loadedAt: number | null;
}

interface ExplorerState {
  discovered: Record<string, DiscoveredResourceDto[]>;
  discoveryStatus: Record<string, ViewStatus>;
  discoveryError: Record<string, string | null>;
  views: Record<string, ResourceView>;
  activeGvr: string | null;
  namespaceFilter: Namespace;

  setDiscovered: (contextId: string, resources: DiscoveredResourceDto[], status: ViewStatus) => void;
  setDiscoveryError: (contextId: string, message: string | null) => void;
  setActiveGvr: (gvr: string | null) => void;
  setNamespaceFilter: (namespace: Namespace) => void;
  /**
   * Seed the filter from the context default once per `(context, resource)` scope.
   * `scopeKey` is opaque to the store; the shell composes it.
   */
  seedNamespace: (scopeKey: string, namespace: string) => void;
  /** Which scope last seeded the filter, so switching kinds re-seeds. */
  seededFor: string | null;

  beginLoad: (key: ResourceKey) => void;
  /** Merge a one-shot list result without discarding rows a delta already delivered. */
  mergeSnapshot: (key: ResourceKey, rows: ResourceSummaryDto[]) => void;
  finishLoad: (key: ResourceKey, rows: ResourceSummaryDto[]) => void;
  failLoad: (key: ResourceKey, message: string) => void;
  applyDelta: (delta: ResourceDeltaDto) => void;
  markEvicted: (key: ResourceKey) => void;
  clearContext: (contextId: string) => void;
  reset: () => void;
}

const emptyView = (namespace: Namespace = ""): ResourceView => ({
  status: "idle",
  rows: [],
  error: null,
  evicted: false,
  truncated: false,
  namespace,
  loadedAt: null,
});

// Stable fallback instances: a selector that allocates a new object each call makes
// zustand v5 re-render forever.
const PENDING_VIEWS = new Map<string, ResourceView>();

function pendingView(key: ResourceKey): ResourceView {
  const id = resourceKeyString(key);
  let view = PENDING_VIEWS.get(id);
  if (!view) {
    view = emptyView(key.namespace);
    PENDING_VIEWS.set(id, view);
  }
  return view;
}

const initial = {
  discovered: {} as Record<string, DiscoveredResourceDto[]>,
  discoveryStatus: {} as Record<string, ViewStatus>,
  discoveryError: {} as Record<string, string | null>,
  views: {} as Record<string, ResourceView>,
  activeGvr: null as string | null,
  namespaceFilter: "" as Namespace,
  seededFor: null as string | null,
};

export const useExplorerStore = create<ExplorerState>()((set) => ({
  ...initial,

  setDiscovered: (contextId, resources, status) =>
    set((state) => ({
      discovered: { ...state.discovered, [contextId]: resources },
      discoveryStatus: { ...state.discoveryStatus, [contextId]: status },
      discoveryError: { ...state.discoveryError, [contextId]: null },
    })),

  setDiscoveryError: (contextId, message) =>
    set((state) => ({
      discoveryStatus: { ...state.discoveryStatus, [contextId]: message ? "error" : "idle" },
      discoveryError: { ...state.discoveryError, [contextId]: message },
    })),

  setActiveGvr: (activeGvr) => set({ activeGvr }),
  setNamespaceFilter: (namespaceFilter) => set({ namespaceFilter }),

  seedNamespace: (scopeKey, namespace) =>
    set({
      namespaceFilter: namespace,
      seededFor: scopeKey,
    }),

  beginLoad: (key) =>
    set((state) => {
      const id = resourceKeyString(key);
      const existing = state.views[id] ?? emptyView(key.namespace);
      return {
        views: {
          ...state.views,
          [id]: { ...existing, status: "loading", error: null, evicted: false, namespace: key.namespace },
        },
      };
    }),

  mergeSnapshot: (key, rows) =>
    set((state) => {
      const id = resourceKeyString(key);
      const existing = state.views[id] ?? emptyView(key.namespace);
      // Rows that arrived by delta before the list resolved are newer than the list, so
      // a list row never overwrites an existing uid.
      const byUid = new Map<string, ResourceSummaryDto>();
      for (const row of existing.rows) byUid.set(row.uid, row);
      for (const row of rows) {
        if (!byUid.has(row.uid)) byUid.set(row.uid, row);
      }
      const merged = [...byUid.values()].sort(compareRows);
      return {
        views: {
          ...state.views,
          [id]: {
            status: "ready",
            rows: merged,
            error: null,
            evicted: false,
            truncated: false,
            namespace: key.namespace,
            loadedAt: Date.now(),
          },
        },
      };
    }),

  finishLoad: (key, rows) =>
    set((state) => {
      const id = resourceKeyString(key);
      return {
        views: {
          ...state.views,
          [id]: {
            status: "ready",
            rows,
            error: null,
            evicted: false,
            truncated: false,
            namespace: key.namespace,
            loadedAt: Date.now(),
          },
        },
      };
    }),

  failLoad: (key, message) =>
    set((state) => {
      const id = resourceKeyString(key);
      const existing = state.views[id] ?? emptyView(key.namespace);
      return {
        views: {
          ...state.views,
          [id]: { ...existing, status: "error", error: message },
        },
      };
    }),

  applyDelta: (delta) =>
    set((state) => {
      const id = resourceKeyString({
        contextId: delta.contextId,
        gvr: delta.gvr,
        namespace: delta.namespace,
      });
      const existing = state.views[id];
      if (!existing) return state; // stale delta for a view we no longer track
      const nextRows = applyDelta(existing.rows, delta);
      if (nextRows === undefined) {
        return {
          views: {
            ...state.views,
            [id]: { ...existing, status: "stale", truncated: true },
          },
        };
      }
      return {
        views: {
          ...state.views,
          [id]: { ...existing, rows: nextRows, truncated: existing.truncated || delta.truncated },
        },
      };
    }),

  markEvicted: (key) =>
    set((state) => {
      const id = resourceKeyString(key);
      const existing = state.views[id] ?? emptyView(key.namespace);
      return {
        views: {
          ...state.views,
          [id]: { ...existing, status: "stale", evicted: true },
        },
      };
    }),

  clearContext: (contextId) =>
    set((state) => {
      const prefix = `${contextId}\u0000`;
      const views = Object.fromEntries(
        Object.entries(state.views).filter(([key]) => !key.startsWith(prefix)),
      );
      const discovered = Object.fromEntries(
        Object.entries(state.discovered).filter(([key]) => key !== contextId),
      );
      return { views, discovered };
    }),

  reset: () => set({ ...initial }),
}));

export function viewFor(state: ExplorerState, key: ResourceKey): ResourceView {
  return state.views[resourceKeyString(key)] ?? pendingView(key);
}
