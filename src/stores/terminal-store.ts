import { create } from "zustand";

import { ipc } from "@/lib/ipc/client";
import type { ShellOutputDto } from "@/lib/ipc/types";

export interface TerminalTab {
  tabId: string;
  contextId: string;
  namespace: string;
  podName: string;
  container: string;
  sessionId: string | null;
  status: "connecting" | "connected" | "closed" | "error";
  error?: string;
}

type OutputListener = (chunk: string) => void;

interface TerminalState {
  tabs: TerminalTab[];
  activeTabId: string | null;
  minimized: boolean;
  heightPx: number;
  buffers: Record<string, string[]>;

  openShell: (args: {
    contextId: string;
    namespace: string;
    podName: string;
    container?: string;
  }) => Promise<void>;
  selectTab: (tabId: string) => void;
  closeTab: (tabId: string) => void;
  closeContextTabs: (contextId: string) => void;
  setMinimized: (minimized: boolean) => void;
  setHeightPx: (height: number) => void;
  pushOutput: (payload: ShellOutputDto) => void;
  subscribeSession: (sessionId: string, listener: OutputListener) => () => void;
  reset: () => void;
}

const listenersBySession = new Map<string, Set<OutputListener>>();
const transcriptsBySession = new Map<string, string[]>();
const MAX_TRANSCRIPT_CHUNKS = 500;

function appendTranscriptChunk(sessionId: string, chunk: string) {
  const existing = transcriptsBySession.get(sessionId) ?? [];
  existing.push(chunk);
  if (existing.length > MAX_TRANSCRIPT_CHUNKS) {
    existing.splice(0, existing.length - MAX_TRANSCRIPT_CHUNKS);
  }
  transcriptsBySession.set(sessionId, existing);
}

export const useTerminalStore = create<TerminalState>()((set, get) => ({
  tabs: [],
  activeTabId: null,
  minimized: false,
  heightPx: 260,
  buffers: {},

  openShell: async ({ contextId, namespace, podName, container }) => {
    const ns = namespace || "default";
    const existing = get().tabs.find((t) => {
      if (t.contextId !== contextId || t.namespace !== ns || t.podName !== podName) {
        return false;
      }
      if (t.status !== "connecting" && t.status !== "connected") {
        return false;
      }
      if (!container) return true;
      return t.container === container;
    });
    if (existing) {
      set({ activeTabId: existing.tabId, minimized: false });
      return;
    }

    const resolvedContainer = container || "default";
    const tabId = `term-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    const tab: TerminalTab = {
      tabId,
      contextId,
      namespace: ns,
      podName,
      container: resolvedContainer,
      sessionId: null,
      status: "connecting",
    };

    set((state) => ({
      tabs: [...state.tabs, tab],
      activeTabId: tabId,
      minimized: false,
    }));

    try {
      const session = await ipc.startShell({
        contextId,
        namespace: ns,
        podName,
        container,
        cols: 100,
        rows: 22,
      });

      set((state) => ({
        tabs: state.tabs.map((t) =>
          t.tabId === tabId
            ? {
                ...t,
                container: session.container,
                sessionId: session.sessionId,
                status: "connected",
              }
            : t,
        ),
      }));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      set((state) => ({
        tabs: state.tabs.map((t) =>
          t.tabId === tabId ? { ...t, status: "error", error: msg } : t,
        ),
      }));
    }
  },

  selectTab: (activeTabId) => set({ activeTabId, minimized: false }),

  closeTab: (tabId) => {
    const target = get().tabs.find((t) => t.tabId === tabId);
    if (target?.sessionId) {
      void ipc.closeShell(target.sessionId).catch(() => undefined);
      listenersBySession.delete(target.sessionId);
      transcriptsBySession.delete(target.sessionId);
    }
    set((state) => {
      const nextTabs = state.tabs.filter((t) => t.tabId !== tabId);
      const nextActive =
        state.activeTabId === tabId
          ? (nextTabs[nextTabs.length - 1]?.tabId ?? null)
          : state.activeTabId;
      return {
        tabs: nextTabs,
        activeTabId: nextActive,
      };
    });
  },

  closeContextTabs: (contextId) => {
    const matching = get().tabs.filter((t) => t.contextId === contextId);
    for (const t of matching) {
      if (t.sessionId) {
        void ipc.closeShell(t.sessionId).catch(() => undefined);
        listenersBySession.delete(t.sessionId);
        transcriptsBySession.delete(t.sessionId);
      }
    }
    set((state) => {
      const nextTabs = state.tabs.filter((t) => t.contextId !== contextId);
      const nextActive = nextTabs.some((t) => t.tabId === state.activeTabId)
        ? state.activeTabId
        : (nextTabs[0]?.tabId ?? null);
      return { tabs: nextTabs, activeTabId: nextActive };
    });
  },

  setMinimized: (minimized) => set({ minimized }),
  setHeightPx: (heightPx) => set({ heightPx: Math.max(140, Math.min(540, heightPx)) }),

  pushOutput: (payload) => {
    appendTranscriptChunk(payload.sessionId, payload.data);
    const subs = listenersBySession.get(payload.sessionId);
    if (subs && subs.size > 0) {
      for (const fn of subs) fn(payload.data);
    }
    if (payload.closed) {
      set((state) => ({
        tabs: state.tabs.map((t) =>
          t.sessionId === payload.sessionId ? { ...t, status: "closed" } : t,
        ),
      }));
    }
  },

  subscribeSession: (sessionId, listener) => {
    let setForSession = listenersBySession.get(sessionId);
    if (!setForSession) {
      setForSession = new Set();
      listenersBySession.set(sessionId, setForSession);
    }
    setForSession.add(listener);

    // Replay buffered session output so StrictMode remounts or dock minimizes never lose early prompts.
    const transcript = transcriptsBySession.get(sessionId);
    if (transcript && transcript.length > 0) {
      for (const chunk of transcript) listener(chunk);
    }

    return () => {
      const current = listenersBySession.get(sessionId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) listenersBySession.delete(sessionId);
    };
  },

  reset: () => {
    listenersBySession.clear();
    transcriptsBySession.clear();
    set({ tabs: [], activeTabId: null, minimized: false, heightPx: 260, buffers: {} });
  },
}));
