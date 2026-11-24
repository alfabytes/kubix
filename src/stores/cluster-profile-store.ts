import { create } from "zustand";

export type AvatarShape =
  | "circle"
  | "blob"
  | "squircle"
  | "pill"
  | "triangle"
  | "hexagon"
  | "cloud"
  | "square"
  | "diamond"
  | "pentagon";

export type AvatarFinish = "plush" | "flat";

export type AvatarEyes =
  | "glance-up"
  | "tall-bars"
  | "round"
  | "oval-tilt"
  | "sleepy-top"
  | "angry"
  | "determined"
  | "v-happy"
  | "wide-ovals"
  | "side-eye"
  | "skeptical"
  | "shy-tilt"
  | "squint-happy"
  | "look-down"
  | "flat-line"
  | "tiny-dots";

export type ClusterAvatarConfig =
  | {
      kind: "initials";
      label?: string;
      bgColor?: string;
    }
  | {
      kind: "character";
      shape: AvatarShape;
      finish: AvatarFinish;
      eyes: AvatarEyes;
      color: string | "auto";
    }
  | {
      kind: "image";
      dataUrl: string;
      animatedRing?: boolean;
    };

interface PersistedProfileData {
  pinnedIds: string[];
  avatars: Record<string, ClusterAvatarConfig>;
}

const STORAGE_KEY = "kubix:cluster-profiles:v1";

function loadPersisted(): PersistedProfileData {
  if (typeof window === "undefined") {
    return { pinnedIds: [], avatars: {} };
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { pinnedIds: [], avatars: {} };
    const parsed = JSON.parse(raw) as Partial<PersistedProfileData>;
    const pinnedIds = Array.isArray(parsed.pinnedIds)
      ? parsed.pinnedIds.filter((id): id is string => typeof id === "string" && id.length > 0)
      : [];
    const avatars =
      parsed.avatars && typeof parsed.avatars === "object" ? parsed.avatars : {};
    return { pinnedIds: [...new Set(pinnedIds)], avatars };
  } catch {
    return { pinnedIds: [], avatars: {} };
  }
}

function savePersisted(data: PersistedProfileData): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // Ignore storage quota / privacy mode failures cleanly
  }
}

export interface ClusterProfileStoreState {
  pinnedIds: string[];
  avatars: Record<string, ClusterAvatarConfig>;
  pin: (contextId: string, insertIndex?: number) => void;
  unpin: (contextId: string) => void;
  togglePin: (contextId: string) => void;
  swapPinned: (idA: string, idB: string) => void;
  reorderPinned: (draggedId: string, targetId: string, position: "before" | "after") => void;
  setAvatar: (contextId: string, config: ClusterAvatarConfig) => void;
  resetAvatar: (contextId: string) => void;
  reset: () => void;
}

const initial = loadPersisted();

export const useClusterProfileStore = create<ClusterProfileStoreState>((set) => ({
  pinnedIds: initial.pinnedIds,
  avatars: initial.avatars,

  pin: (contextId, insertIndex) =>
    set((state) => {
      if (!contextId) return state;
      const without = state.pinnedIds.filter((id) => id !== contextId);
      const next = [...without];
      if (typeof insertIndex === "number" && insertIndex >= 0 && insertIndex <= next.length) {
        next.splice(insertIndex, 0, contextId);
      } else {
        next.push(contextId);
      }
      savePersisted({ pinnedIds: next, avatars: state.avatars });
      return { pinnedIds: next };
    }),

  unpin: (contextId) =>
    set((state) => {
      if (!state.pinnedIds.includes(contextId)) return state;
      const next = state.pinnedIds.filter((id) => id !== contextId);
      savePersisted({ pinnedIds: next, avatars: state.avatars });
      return { pinnedIds: next };
    }),

  togglePin: (contextId) =>
    set((state) => {
      const exists = state.pinnedIds.includes(contextId);
      const next = exists
        ? state.pinnedIds.filter((id) => id !== contextId)
        : [...state.pinnedIds, contextId];
      savePersisted({ pinnedIds: next, avatars: state.avatars });
      return { pinnedIds: next };
    }),

  swapPinned: (idA, idB) =>
    set((state) => {
      if (!idA || !idB || idA === idB) return state;
      const idxA = state.pinnedIds.indexOf(idA);
      const idxB = state.pinnedIds.indexOf(idB);
      if (idxA === -1 || idxB === -1) return state;
      const next = [...state.pinnedIds];
      next[idxA] = idB;
      next[idxB] = idA;
      savePersisted({ pinnedIds: next, avatars: state.avatars });
      return { pinnedIds: next };
    }),

  reorderPinned: (draggedId, targetId, position) =>
    set((state) => {
      if (!draggedId || !targetId || draggedId === targetId) return state;
      const without = state.pinnedIds.filter((id) => id !== draggedId);
      const targetIdx = without.indexOf(targetId);
      if (targetIdx === -1) {
        const next = [...without, draggedId];
        savePersisted({ pinnedIds: next, avatars: state.avatars });
        return { pinnedIds: next };
      }
      const insertAt = position === "after" ? targetIdx + 1 : targetIdx;
      without.splice(insertAt, 0, draggedId);
      savePersisted({ pinnedIds: without, avatars: state.avatars });
      return { pinnedIds: without };
    }),

  setAvatar: (contextId, config) =>
    set((state) => {
      const avatars = { ...state.avatars, [contextId]: config };
      savePersisted({ pinnedIds: state.pinnedIds, avatars });
      return { avatars };
    }),

  resetAvatar: (contextId) =>
    set((state) => {
      if (!(contextId in state.avatars)) return state;
      const avatars = { ...state.avatars };
      delete avatars[contextId];
      savePersisted({ pinnedIds: state.pinnedIds, avatars });
      return { avatars };
    }),

  reset: () => {
    savePersisted({ pinnedIds: [], avatars: {} });
    set({ pinnedIds: [], avatars: {} });
  },
}));
