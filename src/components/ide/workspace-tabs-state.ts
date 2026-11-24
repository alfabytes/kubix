import type { DetailTab } from "@/components/explorer/resource-detail";
import type { SpecialNavTarget } from "@/components/ide/navigation-sidebar";
import type { WorkspaceTabItem } from "@/components/ide/workspace-tabs";

export const INITIAL_OVERVIEW_TAB: WorkspaceTabItem = {
  id: "special:cluster-overview",
  kind: "overview",
  title: "Cluster Overview",
};

export interface ListTabState {
  rowFilter: string;
  podStatusFilter: string[];
  selectedName: string | null;
  selectedUid: string | null;
  selectedNamespace?: string;
  checkedUids: string[];
}

export const EMPTY_LIST_TAB_STATE: ListTabState = {
  rowFilter: "",
  podStatusFilter: [],
  selectedName: null,
  selectedUid: null,
  selectedNamespace: undefined,
  checkedUids: [],
};

export type NavHistoryEntry =
  | { kind: "overview" }
  | { kind: "special"; target: SpecialNavTarget }
  | {
      kind: "resource-list";
      gvr: string;
      selectedName?: string | null;
      selectedUid?: string | null;
      selectedNamespace?: string;
    }
  | {
      kind: "resource-detail";
      gvr: string;
      name: string;
      namespace?: string;
      detailTab?: DetailTab;
    };

export interface NavHistoryState {
  entries: NavHistoryEntry[];
  index: number;
}

export function sameHistoryEntry(a: NavHistoryEntry, b: NavHistoryEntry): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "overview" && b.kind === "overview") return true;
  if (a.kind === "special" && b.kind === "special") return a.target === b.target;
  if (a.kind === "resource-list" && b.kind === "resource-list") return a.gvr === b.gvr;
  if (a.kind === "resource-detail" && b.kind === "resource-detail") {
    return a.gvr === b.gvr && a.name === b.name && (a.namespace ?? "") === (b.namespace ?? "");
  }
  return false;
}

export function tabIdForHistoryEntry(entry: NavHistoryEntry): string {
  switch (entry.kind) {
    case "overview":
      return INITIAL_OVERVIEW_TAB.id;
    case "special":
      return `special:${entry.target}`;
    case "resource-list":
      return `list:${entry.gvr}`;
    case "resource-detail":
      return `detail:${entry.gvr}:${entry.namespace ?? ""}:${entry.name}`;
  }
}

export function historyEntryForTab(tab: WorkspaceTabItem): NavHistoryEntry {
  switch (tab.kind) {
    case "overview":
      return { kind: "overview" };
    case "resource-list":
      return { kind: "resource-list", gvr: tab.gvr ?? "" };
    case "resource-detail":
      return {
        kind: "resource-detail",
        gvr: tab.gvr ?? "",
        name: tab.resourceName ?? tab.title,
        namespace: tab.resourceNamespace,
        detailTab: tab.detailTab,
      };
    case "topology":
    case "events":
    case "security":
    case "helm":
    case "port-forwards":
      return { kind: "special", target: tab.kind };
  }
}

export function openOrFocusTab(
  tabs: WorkspaceTabItem[],
  nextTab: WorkspaceTabItem,
): { tabs: WorkspaceTabItem[]; activeTabId: string } {
  const existingIndex = tabs.findIndex((t) => t.id === nextTab.id);
  if (existingIndex === -1) {
    return {
      tabs: [...tabs, nextTab],
      activeTabId: nextTab.id,
    };
  }

  const existing = tabs[existingIndex]!;
  if (
    nextTab.kind === "resource-detail" &&
    nextTab.detailTab &&
    existing.detailTab !== nextTab.detailTab
  ) {
    const updated = [...tabs];
    updated[existingIndex] = { ...existing, detailTab: nextTab.detailTab };
    return { tabs: updated, activeTabId: existing.id };
  }

  return { tabs, activeTabId: existing.id };
}

export function closeTabById(
  tabs: WorkspaceTabItem[],
  activeTabId: string,
  targetId: string,
): { tabs: WorkspaceTabItem[]; activeTabId: string; removedIds: string[] } {
  const targetIndex = tabs.findIndex((t) => t.id === targetId);
  if (targetIndex === -1) {
    return { tabs, activeTabId, removedIds: [] };
  }

  const remaining = tabs.filter((t) => t.id !== targetId);
  if (remaining.length === 0) {
    return {
      tabs: [INITIAL_OVERVIEW_TAB],
      activeTabId: INITIAL_OVERVIEW_TAB.id,
      removedIds: [targetId],
    };
  }

  if (activeTabId !== targetId) {
    return { tabs: remaining, activeTabId, removedIds: [targetId] };
  }

  const nextActive = remaining[targetIndex] ?? remaining[targetIndex - 1] ?? INITIAL_OVERVIEW_TAB;
  return {
    tabs: remaining,
    activeTabId: nextActive.id,
    removedIds: [targetId],
  };
}

export function closeActiveTabOrReset(
  tabs: WorkspaceTabItem[],
  activeTabId: string,
): { tabs: WorkspaceTabItem[]; activeTabId: string; removedIds: string[]; changed: boolean } {
  if (tabs.length <= 1) {
    const only = tabs[0];
    if (!only || only.id === INITIAL_OVERVIEW_TAB.id) {
      return {
        tabs: only ? tabs : [INITIAL_OVERVIEW_TAB],
        activeTabId: INITIAL_OVERVIEW_TAB.id,
        removedIds: [],
        changed: false,
      };
    }
    return {
      tabs: [INITIAL_OVERVIEW_TAB],
      activeTabId: INITIAL_OVERVIEW_TAB.id,
      removedIds: [only.id],
      changed: true,
    };
  }

  const closed = closeTabById(tabs, activeTabId, activeTabId);
  return { ...closed, changed: closed.removedIds.length > 0 };
}

export function closeOtherTabsById(
  tabs: WorkspaceTabItem[],
  targetId: string,
): { tabs: WorkspaceTabItem[]; activeTabId: string; removedIds: string[] } {
  const target = tabs.find((t) => t.id === targetId);
  if (!target) {
    return {
      tabs,
      activeTabId: tabs[0]?.id ?? INITIAL_OVERVIEW_TAB.id,
      removedIds: [],
    };
  }
  const removedIds = tabs.filter((t) => t.id !== targetId).map((t) => t.id);
  return {
    tabs: [target],
    activeTabId: target.id,
    removedIds,
  };
}

export function closeTabsToRightById(
  tabs: WorkspaceTabItem[],
  activeTabId: string,
  targetId: string,
): { tabs: WorkspaceTabItem[]; activeTabId: string; removedIds: string[] } {
  const targetIndex = tabs.findIndex((t) => t.id === targetId);
  if (targetIndex === -1 || targetIndex === tabs.length - 1) {
    return { tabs, activeTabId, removedIds: [] };
  }
  const kept = tabs.slice(0, targetIndex + 1);
  const removedIds = tabs.slice(targetIndex + 1).map((t) => t.id);
  const activeStillKept = kept.some((t) => t.id === activeTabId);
  return {
    tabs: kept,
    activeTabId: activeStillKept ? activeTabId : targetId,
    removedIds,
  };
}

export function pruneTabStateMap(
  stateById: Record<string, ListTabState>,
  removedIds: string[],
): Record<string, ListTabState> {
  if (removedIds.length === 0) return stateById;
  let changed = false;
  for (const id of removedIds) {
    if (Object.prototype.hasOwnProperty.call(stateById, id)) {
      changed = true;
      break;
    }
  }
  if (!changed) return stateById;

  const removedSet = new Set(removedIds);
  const next: Record<string, ListTabState> = {};
  for (const [id, value] of Object.entries(stateById)) {
    if (!removedSet.has(id)) {
      next[id] = value;
    }
  }
  return next;
}

export function pruneNavHistoryForRemainingTabs(
  history: NavHistoryState,
  remainingTabs: WorkspaceTabItem[],
  activeTab: WorkspaceTabItem,
): NavHistoryState {
  const remainingIds = new Set(remainingTabs.map((t) => t.id));
  const compacted: NavHistoryEntry[] = [];
  let mappedIndex = -1;

  for (let i = 0; i < history.entries.length; i += 1) {
    const entry = history.entries[i]!;
    if (!remainingIds.has(tabIdForHistoryEntry(entry))) {
      continue;
    }
    const prev = compacted[compacted.length - 1];
    if (!prev || !sameHistoryEntry(prev, entry)) {
      compacted.push(entry);
    }
    if (i <= history.index) {
      mappedIndex = compacted.length - 1;
    }
  }

  const activeEntry = historyEntryForTab(activeTab);
  if (compacted.length === 0) {
    return { entries: [activeEntry], index: 0 };
  }

  if (mappedIndex >= 0 && sameHistoryEntry(compacted[mappedIndex]!, activeEntry)) {
    return { entries: compacted, index: mappedIndex };
  }

  // Prefer the closest occurrence of activeEntry at or before mappedIndex; otherwise search forward.
  for (let i = Math.min(mappedIndex, compacted.length - 1); i >= 0; i -= 1) {
    if (sameHistoryEntry(compacted[i]!, activeEntry)) {
      return { entries: compacted, index: i };
    }
  }
  for (let i = Math.max(0, mappedIndex + 1); i < compacted.length; i += 1) {
    if (sameHistoryEntry(compacted[i]!, activeEntry)) {
      return { entries: compacted, index: i };
    }
  }

  const nextEntries = [...compacted.slice(0, Math.max(0, mappedIndex + 1)), activeEntry];
  return { entries: nextEntries, index: nextEntries.length - 1 };
}

export function resolveTabShortcutId(tabs: WorkspaceTabItem[], digit: number): string | null {
  if (tabs.length === 0 || digit < 1 || digit > 9) return null;
  if (digit === 9) {
    return tabs[tabs.length - 1]?.id ?? null;
  }
  return tabs[digit - 1]?.id ?? null;
}

export function resolveCycleTabId(
  tabs: WorkspaceTabItem[],
  activeTabId: string,
  direction: 1 | -1,
): string | null {
  if (tabs.length <= 1) return null;
  const idx = tabs.findIndex((t) => t.id === activeTabId);
  if (idx === -1) return tabs[0]?.id ?? null;
  const nextIdx = (idx + direction + tabs.length) % tabs.length;
  return tabs[nextIdx]?.id ?? null;
}
