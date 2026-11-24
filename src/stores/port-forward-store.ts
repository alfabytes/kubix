import { create } from "zustand";

import { ipc } from "@/lib/ipc/client";
import type { PortForwardDto } from "@/lib/ipc/types";

interface PortForwardState {
  forwards: PortForwardDto[];
  error: string | null;

  startForward: (args: {
    contextId: string;
    namespace: string;
    kind: string;
    name: string;
    remotePort: number;
    localPort?: number;
  }) => Promise<PortForwardDto>;
  stopForward: (forwardId: string) => Promise<void>;
  refreshForwards: (contextId: string) => Promise<void>;
  clearContextForwards: (contextId: string) => void;
  clearError: () => void;
  reset: () => void;
}

export function defaultLocalPort(remotePort: number): number {
  return remotePort >= 1024 ? remotePort : remotePort + 8000;
}

export const usePortForwardStore = create<PortForwardState>()((set) => ({
  forwards: [],
  error: null,

  startForward: async ({ contextId, namespace, kind, name, remotePort, localPort }) => {
    set({ error: null });
    try {
      const dto = await ipc.startPortForward({
        contextId,
        namespace: namespace || "default",
        kind,
        name,
        remotePort,
        localPort,
      });
      set((state) => ({
        forwards: [
          ...state.forwards.filter((f) => f.forwardId !== dto.forwardId),
          dto,
        ],
        error: null,
      }));
      return dto;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      set({ error: msg });
      throw err;
    }
  },

  stopForward: async (forwardId) => {
    try {
      await ipc.stopPortForward(forwardId);
    } catch {
      // Ignore cleanup race if backend already stopped it
    }
    set((state) => ({
      forwards: state.forwards.filter((f) => f.forwardId !== forwardId),
    }));
  },

  refreshForwards: async (contextId) => {
    try {
      const list = await ipc.listPortForwards(contextId);
      set((state) => ({
        forwards: [
          ...state.forwards.filter((f) => f.contextId !== contextId),
          ...list,
        ],
      }));
    } catch {
      // Ignore transient query errors
    }
  },

  clearContextForwards: (contextId) =>
    set((state) => ({
      forwards: state.forwards.filter((f) => f.contextId !== contextId),
    })),

  clearError: () => set({ error: null }),
  reset: () => set({ forwards: [], error: null }),
}));
