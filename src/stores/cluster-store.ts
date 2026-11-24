import { create } from "zustand";

import type { ClusterContextDto, ConnectionState, ContextId } from "@/lib/ipc/types";

export interface ContextRow extends ClusterContextDto {
  /** Set locally while a connect attempt is in flight. */
  pending: boolean;
}

interface ClusterState {
  contexts: ContextId[];
  byId: Record<ContextId, ContextRow>;
  selectedId: ContextId | null;
  /** True while the very first load is in flight. */
  loading: boolean;
  error: string | null;

  setLoading: (loading: boolean) => void;
  setError: (message: string | null) => void;
  replaceAll: (contexts: ClusterContextDto[]) => void;
  upsert: (context: ClusterContextDto) => void;
  patchState: (contextId: ContextId, state: ConnectionState, pending?: boolean) => void;
  select: (contextId: ContextId | null) => void;
  reset: () => void;
}

const initial = {
  contexts: [] as ContextId[],
  byId: {} as Record<ContextId, ContextRow>,
  selectedId: null as ContextId | null,
  loading: false,
  error: null as string | null,
};

// Selectors must return stable references or zustand v5 re-renders forever, so derived
// arrays are memoized per state snapshot instead of recomputed on every call.
let orderedCache: { contexts: ContextId[]; byId: Record<ContextId, ContextRow>; result: ContextRow[] } | null =
  null;

const EMPTY_ROW_LIST: ContextRow[] = [];

function row(context: ClusterContextDto, pending = false): ContextRow {
  return { ...context, pending };
}

export const useClusterStore = create<ClusterState>()((set) => ({
  ...initial,

  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),

  replaceAll: (contexts) =>
    set((state) => {
      const byId: Record<ContextId, ContextRow> = {};
      const order: ContextId[] = [];
      for (const ctx of contexts) {
        const previous = state.byId[ctx.id];
        // Keep an in-flight local state rather than reverting to "disconnected".
        byId[ctx.id] = previous?.pending ? { ...ctx, pending: true, state: previous.state } : row(ctx);
        order.push(ctx.id);
      }
      // `isCurrent` describes kubectl, not an instruction to contact a cluster.
      const selectedId =
        state.selectedId && byId[state.selectedId]?.state === "ready"
          ? state.selectedId
          : null;
      return { contexts: order, byId, selectedId, loading: false, error: null };
    }),

  upsert: (context) =>
    set((state) => {
      const exists = state.byId[context.id] !== undefined;
      return {
        contexts: exists ? state.contexts : [...state.contexts, context.id],
        byId: { ...state.byId, [context.id]: row(context) },
      };
    }),

  patchState: (contextId, next, pending = false) =>
    set((state) => {
      const existing = state.byId[contextId];
      if (!existing) return state;
      return {
        byId: { ...state.byId, [contextId]: { ...existing, state: next, pending } },
      };
    }),

  select: (selectedId) => set({ selectedId }),

  reset: () => set({ ...initial }),
}));

export function selectOrderedContexts(state: ClusterState): ContextRow[] {
  if (state.contexts.length === 0) {
    orderedCache = null;
    return EMPTY_ROW_LIST;
  }
  if (orderedCache && orderedCache.contexts === state.contexts && orderedCache.byId === state.byId) {
    return orderedCache.result;
  }
  const result = state.contexts
    .map((id) => state.byId[id])
    .filter((row): row is ContextRow => !!row);
  orderedCache = { contexts: state.contexts, byId: state.byId, result };
  return result;
}

export function selectSelectedContext(state: ClusterState): ContextRow | null {
  return state.selectedId ? (state.byId[state.selectedId] ?? null) : null;
}
