import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  GitCompareArrows,
  Menu,
  RefreshCw,
  Search,
} from "lucide-react";

import { StatusBadge } from "@/components/clusters/status-badge";
import {
  NamespacePicker,
  parseNamespaceSelection,
} from "@/components/explorer/namespace-picker";
import { ResourceDetail, type DetailTab } from "@/components/explorer/resource-detail";
import { ResourceTable, type TableSortState } from "@/components/explorer/resource-table";
import {
  StatusFilterPicker,
  type StatusFilterOption,
} from "@/components/explorer/status-filter-picker";
import {
  ClusterOverview,
  HelmReleasesView,
  PortForwardsView,
  SecurityCenterView,
} from "@/components/ide/cluster-overview";
import { EventsTimelineView } from "@/components/ide/events-timeline-view";
import type { SpecialNavTarget } from "@/components/ide/navigation-sidebar";
import {
  clampInspectorWidthPct,
  INSPECTOR_DEFAULT_WIDTH_PCT,
  INSPECTOR_MAX_WIDTH_PCT,
  INSPECTOR_MIN_WIDTH_PCT,
  loadInspectorWidthPct,
  saveInspectorWidthPct,
} from "@/components/ide/sidebar-width";
import { TerminalDock } from "@/components/ide/terminal-dock";
import { TopologyCanvas } from "@/components/ide/topology-canvas";
import { YamlDiffModal, type DiffResourceRef } from "@/components/ide/yaml-diff-modal";
import {
  WorkspaceTabs,
  type WorkspaceTabItem,
} from "@/components/ide/workspace-tabs";
import {
  closeActiveTabOrReset,
  closeOtherTabsById,
  closeTabById,
  closeTabsToRightById,
  EMPTY_LIST_TAB_STATE,
  historyEntryForTab,
  INITIAL_OVERVIEW_TAB,
  openOrFocusTab,
  pruneNavHistoryForRemainingTabs,
  pruneTabStateMap,
  resolveCycleTabId,
  resolveTabShortcutId,
  sameHistoryEntry,
  type ListTabState,
  type NavHistoryEntry,
} from "@/components/ide/workspace-tabs-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  useConnectMutation,
  useDiscoveryQuery,
  useNamespaceTopologyQuery,
  useResourceListQuery,
  useStopWatchOnUnmount,
} from "@/lib/hooks";
import type {
  DiscoveredResourceDto,
  GroupVersionResource,
  Namespace,
} from "@/lib/ipc/types";
import {
  deriveRowTelemetry,
  resolveGvrForKind,
  type ResourceNavigationTarget,
} from "@/lib/resource-telemetry";
import { useClusterStore } from "@/stores/cluster-store";
import { viewFor, useExplorerStore } from "@/stores/explorer-store";

export interface ClusterNavControls {
  canGoBack: boolean;
  canGoForward: boolean;
  goBack: () => void;
  goForward: () => void;
  closeActiveTab: () => void;
}

export interface ClusterShellProps {
  contextId: string;
  specialView: SpecialNavTarget | null;
  navIntentNonce?: number;
  onChangeSpecialView: (next: SpecialNavTarget | null) => void;
  onNavControlsChange?: (controls: ClusterNavControls) => void;
  pendingResourceJump?: (ResourceNavigationTarget & { nonce: number }) | null;
  onConsumedResourceJump?: () => void;
  onToggleSidebar: () => void;
  onBack: () => void;
  theme?: "dark" | "light";
}

export function ClusterShell({
  contextId,
  specialView,
  navIntentNonce = 0,
  onChangeSpecialView,
  onNavControlsChange,
  pendingResourceJump,
  onConsumedResourceJump,
  onToggleSidebar,
  onBack,
  theme = "dark",
}: ClusterShellProps) {
  const context = useClusterStore((s) => s.byId[contextId]);
  const connect = useConnectMutation();
  const discovery = useDiscoveryQuery(contextId);
  const activeGvr = useExplorerStore((s) => s.activeGvr);
  const setActiveGvr = useExplorerStore((s) => s.setActiveGvr);
  const namespaceFilter = useExplorerStore((s) => s.namespaceFilter);
  const setNamespaceFilter = useExplorerStore((s) => s.setNamespaceFilter);
  const seededFor = useExplorerStore((s) => s.seededFor);
  const seedNamespace = useExplorerStore((s) => s.seedNamespace);
  const allViews = useExplorerStore((s) => s.views);

  const [tabs, setTabs] = useState<WorkspaceTabItem[]>([INITIAL_OVERVIEW_TAB]);
  const [activeTabId, setActiveTabId] = useState<string>(INITIAL_OVERVIEW_TAB.id);
  const [tabStateById, setTabStateById] = useState<Record<string, ListTabState>>({});
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;
  const prevContextIdRef = useRef(contextId);
  const [inspectorWidth, setInspectorWidth] = useState<number>(() => loadInspectorWidthPct());
  const [inspectorResizing, setInspectorResizing] = useState(false);
  const inspectorWidthRef = useRef(inspectorWidth);
  inspectorWidthRef.current = inspectorWidth;
  const [compareOpen, setCompareOpen] = useState(false);
  const [diffPair, setDiffPair] = useState<{ left: DiffResourceRef; right: DiffResourceRef } | null>(
    null,
  );
  const [sortByGvr, setSortByGvr] = useState<Record<string, TableSortState | null>>({});
  const [navHistory, setNavHistory] = useState<{
    entries: NavHistoryEntry[];
    index: number;
  }>({ entries: [{ kind: "overview" }], index: 0 });
  const navHistoryRef = useRef(navHistory);
  navHistoryRef.current = navHistory;
  const skipSyncEffectRef = useRef(false);
  const splitRef = useRef<HTMLDivElement>(null);
  const inspectorRef = useRef<HTMLElement>(null);
  const separatorRef = useRef<HTMLDivElement>(null);

  const pushHistory = useCallback((entry: NavHistoryEntry) => {
    setNavHistory((prev) => {
      const current = prev.entries[prev.index];
      if (current && sameHistoryEntry(current, entry)) return prev;
      const nextEntries = [...prev.entries.slice(0, prev.index + 1), entry];
      return { entries: nextEntries, index: nextEntries.length - 1 };
    });
  }, []);

  const activeTab = useMemo(
    () => tabs.find((t) => t.id === activeTabId) ?? tabs[0] ?? INITIAL_OVERVIEW_TAB,
    [tabs, activeTabId],
  );

  const activeListState =
    activeTab.kind === "resource-list"
      ? (tabStateById[activeTab.id] ?? EMPTY_LIST_TAB_STATE)
      : EMPTY_LIST_TAB_STATE;
  const rowFilter = activeListState.rowFilter;
  const podStatusFilter = activeListState.podStatusFilter;
  const selectedName = activeListState.selectedName;
  const selectedUid = activeListState.selectedUid;
  const selectedNamespace = activeListState.selectedNamespace;
  const checkedUids = useMemo(
    () => new Set(activeListState.checkedUids),
    [activeListState.checkedUids],
  );

  const updateListTabState = useCallback(
    (tabId: string, updater: (prev: ListTabState) => ListTabState) => {
      setTabStateById((prev) => ({
        ...prev,
        [tabId]: updater(prev[tabId] ?? EMPTY_LIST_TAB_STATE),
      }));
    },
    [],
  );

  const setRowFilter = useCallback(
    (next: string) => {
      if (activeTab.kind !== "resource-list") return;
      updateListTabState(activeTab.id, (prev) => ({ ...prev, rowFilter: next }));
    },
    [activeTab.id, activeTab.kind, updateListTabState],
  );

  const setPodStatusFilter = useCallback(
    (next: string[]) => {
      if (activeTab.kind !== "resource-list") return;
      updateListTabState(activeTab.id, (prev) => ({ ...prev, podStatusFilter: next }));
    },
    [activeTab.id, activeTab.kind, updateListTabState],
  );

  const setSelection = useCallback(
    (tabId: string, name: string | null, uid: string | null, ns?: string) => {
      updateListTabState(tabId, (prev) => ({
        ...prev,
        selectedName: name,
        selectedUid: uid,
        selectedNamespace: ns,
      }));
    },
    [updateListTabState],
  );

  // Reset per-cluster workspace tabs & history when switching contexts without remounting.
  useEffect(() => {
    if (prevContextIdRef.current === contextId) return;
    prevContextIdRef.current = contextId;
    tabsRef.current = [INITIAL_OVERVIEW_TAB];
    activeTabIdRef.current = INITIAL_OVERVIEW_TAB.id;
    setTabs([INITIAL_OVERVIEW_TAB]);
    setActiveTabId(INITIAL_OVERVIEW_TAB.id);
    setTabStateById({});
    setCompareOpen(false);
    setDiffPair(null);
    setNavHistory({ entries: [{ kind: "overview" }], index: 0 });
  }, [contextId]);

  const resources = useMemo(() => discovery.data ?? [], [discovery.data]);
  const activeResource = useMemo(
    () => resources.find((r) => r.gvr === activeGvr) ?? null,
    [activeGvr, resources],
  );
  const activeListGvr = activeTab.kind === "resource-list" ? (activeTab.gvr ?? null) : null;
  const activeListResource = useMemo(
    () => (activeListGvr ? (resources.find((r) => r.gvr === activeListGvr) ?? null) : null),
    [activeListGvr, resources],
  );

  // Sync special views and resource list selections triggered from sidebar or command bar
  useEffect(() => {
    if (skipSyncEffectRef.current) {
      skipSyncEffectRef.current = false;
      return;
    }
    if (specialView) {
      openSpecialTab(specialView, false);
      pushHistory(
        specialView === "cluster-overview"
          ? { kind: "overview" }
          : { kind: "special", target: specialView },
      );
      return;
    }
    if (!activeResource) return;
    const id = `list:${activeResource.gvr}`;
    const nextTab: WorkspaceTabItem = {
      id,
      kind: "resource-list",
      title: activeResource.kind,
      subtitle: activeResource.version,
      gvr: activeResource.gvr,
    };
    const opened = openOrFocusTab(tabsRef.current, nextTab);
    tabsRef.current = opened.tabs;
    activeTabIdRef.current = opened.activeTabId;
    setTabs(opened.tabs);
    setActiveTabId(opened.activeTabId);
    pushHistory({ kind: "resource-list", gvr: activeResource.gvr });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [specialView, activeResource, navIntentNonce, pushHistory]);

  // Close the right-side Resource Detail split inspector when clicking outside it or pressing Escape.
  useEffect(() => {
    if (activeTab.kind !== "resource-list" || !selectedName) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (
          document.querySelector(
            '[role="dialog"], [role="listbox"], [role="menu"], [data-testid="command-palette-popover"]',
          )
        ) {
          return;
        }
        setSelection(activeTab.id, null, null, selectedNamespace);
      }
    };

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (inspectorRef.current?.contains(target)) return;
      if (separatorRef.current?.contains(target)) return;
      if (target.closest('[data-testid="resource-row"]')) return;
      if (target.closest('[data-testid="workspace-tabs"]')) return;
      if (target.closest('[data-testid="cluster-sidebar"]')) return;
      if (target.closest('[data-testid="terminal-dock"]')) return;
      if (target.closest('[role="dialog"]')) return;
      setSelection(activeTab.id, null, null, selectedNamespace);
    };

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("mousedown", handlePointerDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("mousedown", handlePointerDown);
    };
  }, [activeTab.id, activeTab.kind, selectedName, selectedNamespace, setSelection]);

  const contextNamespaceDefault = context?.namespaceDefault ?? "default";
  // Seed once per cluster context so switching resource types preserves the active namespace filter.
  const scopeKey = activeListResource?.namespaced ? contextId : null;

  const activeNamespaceFilter: Namespace = activeListResource?.namespaced
    ? seededFor === scopeKey
      ? namespaceFilter
      : contextNamespaceDefault
    : "";

  const selectedNamespaces = useMemo(
    () => parseNamespaceSelection(activeNamespaceFilter),
    [activeNamespaceFilter],
  );

  // Single namespace watches that exact namespace; All (0) or Multi (2+) uses a single
  // cluster-wide watch ("") and filters rows client-side so we only consume 1 watch slot.
  const effectiveNamespace: Namespace =
    selectedNamespaces.length === 1 ? selectedNamespaces[0]! : "";

  const view = useExplorerStore((s) =>
    viewFor(s, { contextId, gvr: activeListGvr ?? "", namespace: effectiveNamespace }),
  );

  useEffect(() => {
    if (!scopeKey || seededFor === scopeKey) return;
    seedNamespace(scopeKey, contextNamespaceDefault);
  }, [scopeKey, contextNamespaceDefault, seedNamespace, seededFor]);

  const visualizerNamespace: Namespace = useMemo(() => {
    const raw = seededFor === contextId ? namespaceFilter : contextNamespaceDefault;
    const parts = parseNamespaceSelection(raw);
    return parts[0] ?? "";
  }, [contextId, contextNamespaceDefault, namespaceFilter, seededFor]);

  const namespaceTopologyQuery = useNamespaceTopologyQuery(
    contextId,
    visualizerNamespace,
    (context?.state === "ready" || context?.state === "degraded") &&
      activeTab.kind === "topology",
  );

  const observedNamespaces = useMemo(() => {
    const seen = new Set<string>();
    const prefix = `${contextId}\u0000`;
    for (const [key, entry] of Object.entries(allViews)) {
      if (!key.startsWith(prefix)) continue;
      const isNamespacesList = key.startsWith(`${contextId}\u0000/v1/namespaces\u0000`);
      for (const row of entry.rows) {
        if (row.namespace) seen.add(row.namespace);
        if (isNamespacesList && row.name) seen.add(row.name);
      }
    }
    for (const node of namespaceTopologyQuery.data?.nodes ?? []) {
      if (node.namespace) seen.add(node.namespace);
    }
    for (const ns of parseNamespaceSelection(namespaceFilter)) {
      seen.add(ns);
    }
    return [...seen].sort((a, b) => a.localeCompare(b));
  }, [allViews, contextId, namespaceFilter, namespaceTopologyQuery.data]);

  const scopedRows = useMemo(() => {
    if (selectedNamespaces.length < 2) return view.rows;
    const allowed = new Set(selectedNamespaces);
    return view.rows.filter((row) => allowed.has(row.namespace ?? ""));
  }, [view.rows, selectedNamespaces]);

  const isPodList = activeListResource?.kind === "Pod";

  const prevNamespaceFilterRef = useRef<{
    contextId: string;
    tabId: string;
    ns: Namespace;
  } | null>(null);

  const podStatusOptions = useMemo<StatusFilterOption[]>(() => {
    if (!isPodList) return [];
    const byStatus = new Map<string, StatusFilterOption>();
    for (const row of scopedRows) {
      const tel = deriveRowTelemetry(row);
      const existing = byStatus.get(tel.statusText);
      if (existing) {
        existing.count += 1;
      } else {
        byStatus.set(tel.statusText, {
          status: tel.statusText,
          count: 1,
          tone: tel.statusTone,
        });
      }
    }
    for (const selected of podStatusFilter) {
      if (!byStatus.has(selected)) {
        byStatus.set(selected, { status: selected, count: 0, tone: "neutral" });
      }
    }
    const rank = (opt: StatusFilterOption) => {
      if (opt.tone === "error") return 0;
      if (opt.tone === "warn") return 1;
      if (opt.status === "Running") return 2;
      if (opt.status === "Succeeded" || opt.status === "Completed") return 3;
      return 4;
    };
    return [...byStatus.values()].sort(
      (a, b) => rank(a) - rank(b) || a.status.localeCompare(b.status),
    );
  }, [isPodList, scopedRows, podStatusFilter]);

  const filteredRows = useMemo(() => {
    const statusSet =
      isPodList && podStatusFilter.length > 0 ? new Set(podStatusFilter) : null;
    const needle = rowFilter.trim().toLowerCase();
    if (!statusSet && !needle) return scopedRows;
    return scopedRows.filter((row) => {
      if (statusSet && !statusSet.has(deriveRowTelemetry(row).statusText)) {
        return false;
      }
      if (!needle) return true;
      return (
        row.name.toLowerCase().includes(needle) ||
        (row.namespace ?? "").toLowerCase().includes(needle)
      );
    });
  }, [scopedRows, isPodList, podStatusFilter, rowFilter]);

  useEffect(() => {
    if (activeTab.kind !== "resource-list") {
      setCompareOpen(false);
      return;
    }
    const prev = prevNamespaceFilterRef.current;
    prevNamespaceFilterRef.current = {
      contextId,
      tabId: activeTab.id,
      ns: activeNamespaceFilter,
    };
    if (
      prev &&
      prev.contextId === contextId &&
      prev.tabId === activeTab.id &&
      prev.ns !== activeNamespaceFilter
    ) {
      updateListTabState(activeTab.id, (cur) => ({
        ...cur,
        selectedName: null,
        selectedUid: null,
        selectedNamespace: undefined,
        checkedUids: [],
      }));
      setCompareOpen(false);
    }
  }, [activeNamespaceFilter, activeTab.id, activeTab.kind, contextId, updateListTabState]);

  const stopInspectorResizeRef = useRef<(() => void) | null>(null);

  const resizeInspector = useCallback((clientX: number, persist = false) => {
    const bounds = splitRef.current?.getBoundingClientRect();
    if (!bounds || bounds.width === 0) return;
    const rawPct = ((bounds.right - clientX) / bounds.width) * 100;
    const clamped = clampInspectorWidthPct(rawPct);
    inspectorWidthRef.current = clamped;
    setInspectorWidth(clamped);
    if (persist) {
      saveInspectorWidthPct(clamped);
    }
  }, []);

  const startInspectorResize = useCallback(() => {
    stopInspectorResizeRef.current?.();
    const prevCursor = document.body.style.cursor;
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    setInspectorResizing(true);

    let cleanedUp = false;
    const stopResize = (persist = true) => {
      if (cleanedUp) return;
      cleanedUp = true;
      stopInspectorResizeRef.current = null;
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevUserSelect;
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleEnd);
      window.removeEventListener("pointercancel", handleEnd);
      window.removeEventListener("blur", handleEnd);
      setInspectorResizing(false);
      if (persist) {
        saveInspectorWidthPct(inspectorWidthRef.current);
      }
    };

    const handleEnd = () => stopResize(true);

    const handleMove = (next: PointerEvent) => {
      if (next.pointerType === "mouse" && (next.buttons & 1) === 0) {
        stopResize(true);
        return;
      }
      resizeInspector(next.clientX);
    };

    stopInspectorResizeRef.current = () => stopResize(false);
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleEnd);
    window.addEventListener("pointercancel", handleEnd);
    window.addEventListener("blur", handleEnd);
  }, [resizeInspector]);

  useEffect(() => {
    if (activeTab.kind !== "resource-list" || !selectedName) {
      stopInspectorResizeRef.current?.();
    }
  }, [activeTab.kind, selectedName]);

  useEffect(() => {
    return () => {
      stopInspectorResizeRef.current?.();
    };
  }, []);

  const listQuery = useResourceListQuery({
    contextId,
    gvr: (activeListGvr ?? "") as GroupVersionResource,
    namespace: effectiveNamespace,
    enabled: Boolean(activeListGvr) && (context?.state === "ready" || context?.state === "degraded"),
  });
  useStopWatchOnUnmount(contextId, activeListGvr, effectiveNamespace);

  const activeWatchCount = useMemo(() => {
    const prefix = `${contextId}\u0000`;
    return Object.entries(allViews).filter(
      ([k, v]) => k.startsWith(prefix) && !v.evicted && v.status === "ready",
    ).length;
  }, [allViews, contextId]);

  const syncSidebarForTab = useCallback(
    (tab: WorkspaceTabItem) => {
      let nextSpecial: SpecialNavTarget | null = null;
      let nextGvr: string | null = activeGvr;

      if (tab.kind === "resource-list") {
        nextSpecial = null;
        if (tab.gvr) nextGvr = tab.gvr;
      } else if (tab.kind === "resource-detail") {
        nextSpecial = null;
      } else if (tab.kind === "overview") {
        nextSpecial = "cluster-overview";
      } else {
        nextSpecial = tab.kind;
      }

      if (nextSpecial !== specialView || nextGvr !== activeGvr) {
        skipSyncEffectRef.current = true;
      }
      if (nextSpecial !== specialView) {
        onChangeSpecialView(nextSpecial);
      }
      if (nextGvr !== activeGvr) {
        setActiveGvr(nextGvr);
      }
    },
    [activeGvr, onChangeSpecialView, setActiveGvr, specialView],
  );

  function openResourceTab(item: DiscoveredResourceDto) {
    onChangeSpecialView(null);
    setActiveGvr(item.gvr);
  }

  function openSpecialTab(target: SpecialNavTarget, notifyParent = true) {
    const map: Record<SpecialNavTarget, WorkspaceTabItem> = {
      "cluster-overview": INITIAL_OVERVIEW_TAB,
      topology: {
        id: "special:topology",
        kind: "topology",
        title: "Topology",
        subtitle: "Graph",
      },
      events: {
        id: "special:events",
        kind: "events",
        title: "Events",
        subtitle: "Live Timeline",
      },
      security: {
        id: "special:security",
        kind: "security",
        title: "Security",
      },
      helm: {
        id: "special:helm",
        kind: "helm",
        title: "Helm Releases",
      },
      "port-forwards": {
        id: "special:port-forwards",
        kind: "port-forwards",
        title: "Port Forwards",
      },
    };
    const nextTab = map[target];
    const opened = openOrFocusTab(tabsRef.current, nextTab);
    tabsRef.current = opened.tabs;
    activeTabIdRef.current = opened.activeTabId;
    setTabs(opened.tabs);
    setActiveTabId(opened.activeTabId);
    if (notifyParent) {
      if (specialView !== target) {
        skipSyncEffectRef.current = true;
        onChangeSpecialView(target);
      }
      pushHistory(target === "cluster-overview" ? { kind: "overview" } : { kind: "special", target });
    }
  }

  function openResourceFullTab(
    gvr: string,
    name: string,
    ns?: string,
    detailTab: DetailTab = "overview",
    recordHistory = true,
  ) {
    const id = `detail:${gvr}:${ns ?? ""}:${name}`;
    const nextDetailTab: WorkspaceTabItem = {
      id,
      kind: "resource-detail",
      title: name,
      subtitle: ns,
      gvr,
      resourceName: name,
      resourceNamespace: ns,
      detailTab,
    };
    if (recordHistory) {
      // Preserve split-inspector selection on the current resource-list history entry so Back restores it.
      if (activeTab.kind === "resource-list" && activeTab.gvr && selectedName) {
        setNavHistory((prev) => {
          const entries = [...prev.entries];
          const cur = entries[prev.index];
          if (cur && cur.kind === "resource-list" && cur.gvr === activeTab.gvr) {
            entries[prev.index] = {
              ...cur,
              selectedName,
              selectedUid,
              selectedNamespace,
            };
          }
          const nextEntry: NavHistoryEntry = {
            kind: "resource-detail",
            gvr,
            name,
            namespace: ns,
            detailTab,
          };
          const trimmed = entries.slice(0, prev.index + 1);
          const last = trimmed[trimmed.length - 1];
          if (last && sameHistoryEntry(last, nextEntry)) {
            return { entries: trimmed, index: trimmed.length - 1 };
          }
          trimmed.push(nextEntry);
          return { entries: trimmed, index: trimmed.length - 1 };
        });
      } else {
        pushHistory({
          kind: "resource-detail",
          gvr,
          name,
          namespace: ns,
          detailTab,
        });
      }
    }
    if (activeTab.kind === "resource-list" && selectedName) {
      setSelection(activeTab.id, null, null, selectedNamespace);
    }
    if (specialView !== null) {
      skipSyncEffectRef.current = true;
      onChangeSpecialView(null);
    }
    const opened = openOrFocusTab(tabsRef.current, nextDetailTab);
    tabsRef.current = opened.tabs;
    activeTabIdRef.current = opened.activeTabId;
    setTabs(opened.tabs);
    setActiveTabId(opened.activeTabId);
  }

  function navigateToResource(target: ResourceNavigationTarget) {
    openResourceFullTab(target.gvr, target.name, target.namespace, "overview", true);
  }

  useEffect(() => {
    if (!pendingResourceJump) return;
    navigateToResource(pendingResourceJump);
    onConsumedResourceJump?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingResourceJump?.nonce]);

  const restoreHistoryEntry = useCallback(
    (entry: NavHistoryEntry) => {
      if (entry.kind === "overview") {
        const opened = openOrFocusTab(tabsRef.current, INITIAL_OVERVIEW_TAB);
        tabsRef.current = opened.tabs;
        activeTabIdRef.current = opened.activeTabId;
        setTabs(opened.tabs);
        setActiveTabId(opened.activeTabId);
        syncSidebarForTab(INITIAL_OVERVIEW_TAB);
      } else if (entry.kind === "special") {
        openSpecialTab(entry.target, false);
        const restoredTab =
          tabsRef.current.find((t) => t.id === `special:${entry.target}`) ?? INITIAL_OVERVIEW_TAB;
        syncSidebarForTab(restoredTab);
      } else if (entry.kind === "resource-list") {
        const res = resources.find((r) => r.gvr === entry.gvr);
        const listTab: WorkspaceTabItem = {
          id: `list:${entry.gvr}`,
          kind: "resource-list",
          title: res?.kind ?? entry.gvr.split("/").pop() ?? "Resources",
          subtitle: res?.version,
          gvr: entry.gvr,
        };
        const opened = openOrFocusTab(tabsRef.current, listTab);
        tabsRef.current = opened.tabs;
        activeTabIdRef.current = opened.activeTabId;
        setTabs(opened.tabs);
        setActiveTabId(opened.activeTabId);
        if (entry.selectedName !== undefined) {
          setSelection(
            listTab.id,
            entry.selectedName ?? null,
            entry.selectedUid ?? null,
            entry.selectedNamespace,
          );
        }
        syncSidebarForTab(listTab);
      } else if (entry.kind === "resource-detail") {
        openResourceFullTab(
          entry.gvr,
          entry.name,
          entry.namespace,
          entry.detailTab ?? "overview",
          false,
        );
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [resources, setSelection, syncSidebarForTab],
  );

  const restoreHistoryRef = useRef(restoreHistoryEntry);
  restoreHistoryRef.current = restoreHistoryEntry;

  const goBackInCluster = useCallback(() => {
    const cur = navHistoryRef.current;
    if (cur.index <= 0) return;
    const nextIndex = cur.index - 1;
    const target = cur.entries[nextIndex];
    if (!target) return;
    setNavHistory({ entries: cur.entries, index: nextIndex });
    restoreHistoryRef.current(target);
  }, []);

  const goForwardInCluster = useCallback(() => {
    const cur = navHistoryRef.current;
    if (cur.index >= cur.entries.length - 1) return;
    const nextIndex = cur.index + 1;
    const target = cur.entries[nextIndex];
    if (!target) return;
    setNavHistory({ entries: cur.entries, index: nextIndex });
    restoreHistoryRef.current(target);
  }, []);

  const applyTabMutation = useCallback(
    (
      nextTabs: WorkspaceTabItem[],
      nextActiveTabId: string,
      removedIds: string[],
      activeChanged: boolean,
    ) => {
      tabsRef.current = nextTabs;
      activeTabIdRef.current = nextActiveTabId;
      setTabs(nextTabs);
      setActiveTabId(nextActiveTabId);
      if (removedIds.length > 0) {
        setTabStateById((prev) => pruneTabStateMap(prev, removedIds));
      }
      const nextActiveTab =
        nextTabs.find((t) => t.id === nextActiveTabId) ?? nextTabs[0] ?? INITIAL_OVERVIEW_TAB;
      if (activeChanged) {
        setCompareOpen(false);
        syncSidebarForTab(nextActiveTab);
      }
      setNavHistory((prev) => pruneNavHistoryForRemainingTabs(prev, nextTabs, nextActiveTab));
    },
    [syncSidebarForTab],
  );

  const handleSelectTab = useCallback(
    (id: string) => {
      const found = tabsRef.current.find((t) => t.id === id);
      if (!found) return;
      activeTabIdRef.current = id;
      setActiveTabId(id);
      setCompareOpen(false);
      syncSidebarForTab(found);
      pushHistory(historyEntryForTab(found));
    },
    [pushHistory, syncSidebarForTab],
  );

  const handleCloseTab = useCallback(
    (id: string) => {
      const prevActiveId = activeTabIdRef.current;
      const result = closeTabById(tabsRef.current, prevActiveId, id);
      if (result.removedIds.length === 0) return;
      applyTabMutation(
        result.tabs,
        result.activeTabId,
        result.removedIds,
        prevActiveId === id || result.activeTabId !== prevActiveId,
      );
    },
    [applyTabMutation],
  );

  const handleCloseOtherTabs = useCallback(
    (id: string) => {
      const prevActiveId = activeTabIdRef.current;
      const result = closeOtherTabsById(tabsRef.current, id);
      if (result.removedIds.length === 0) return;
      applyTabMutation(
        result.tabs,
        result.activeTabId,
        result.removedIds,
        result.activeTabId !== prevActiveId,
      );
    },
    [applyTabMutation],
  );

  const handleCloseTabsToRight = useCallback(
    (id: string) => {
      const prevActiveId = activeTabIdRef.current;
      const result = closeTabsToRightById(tabsRef.current, prevActiveId, id);
      if (result.removedIds.length === 0) return;
      applyTabMutation(
        result.tabs,
        result.activeTabId,
        result.removedIds,
        result.activeTabId !== prevActiveId,
      );
    },
    [applyTabMutation],
  );

  const closeActiveTab = useCallback(() => {
    const result = closeActiveTabOrReset(tabsRef.current, activeTabIdRef.current);
    if (!result.changed) return;
    applyTabMutation(result.tabs, result.activeTabId, result.removedIds, true);
  }, [applyTabMutation]);

  useEffect(() => {
    onNavControlsChange?.({
      canGoBack: navHistory.index > 0,
      canGoForward: navHistory.index < navHistory.entries.length - 1,
      goBack: goBackInCluster,
      goForward: goForwardInCluster,
      closeActiveTab,
    });
  }, [
    navHistory.index,
    navHistory.entries.length,
    goBackInCluster,
    goForwardInCluster,
    closeActiveTab,
    onNavControlsChange,
  ]);

  // Workspace tab keyboard shortcuts: Cmd/Ctrl+1..9, Ctrl+Tab / Ctrl+Shift+Tab, and Cmd/Ctrl+W fallback.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const inEditable =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable);
      if (inEditable) return;
      if (document.querySelector('[role="dialog"]')) return;

      if (event.ctrlKey && !event.metaKey && !event.altKey && event.key === "Tab") {
        const nextId = resolveCycleTabId(
          tabsRef.current,
          activeTabIdRef.current,
          event.shiftKey ? -1 : 1,
        );
        if (nextId) {
          event.preventDefault();
          handleSelectTab(nextId);
        }
        return;
      }

      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey) {
        if (event.key >= "1" && event.key <= "9") {
          const targetId = resolveTabShortcutId(tabsRef.current, Number(event.key));
          if (targetId) {
            event.preventDefault();
            handleSelectTab(targetId);
          }
          return;
        }
        if (event.key.toLowerCase() === "w") {
          event.preventDefault();
          closeActiveTab();
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [closeActiveTab, handleSelectTab]);

  function toggleRowCheck(uid: string) {
    if (activeTab.kind !== "resource-list") return;
    updateListTabState(activeTab.id, (prev) => {
      const exists = prev.checkedUids.includes(uid);
      return {
        ...prev,
        checkedUids: exists ? prev.checkedUids.filter((id) => id !== uid) : [...prev.checkedUids, uid],
      };
    });
  }

  if (!context) {
    return (
      <div className="p-6 text-xs">
        Unknown context.{" "}
        <Button size="sm" variant="link" onClick={onBack}>
          Back to clusters
        </Button>
      </div>
    );
  }

  const disconnected = context.state !== "ready" && context.state !== "degraded";
  const comparedRows = scopedRows.filter((r) => checkedUids.has(r.uid)).slice(0, 2);
  const displayedCount = filteredRows.length;

  return (
    <div className="flex h-full min-w-0 flex-col bg-background">
      {/* Top IDE Workspace Tabs */}
      <WorkspaceTabs
        tabs={tabs}
        activeTabId={activeTab.id}
        onSelectTab={handleSelectTab}
        onCloseTab={handleCloseTab}
        onCloseOtherTabs={handleCloseOtherTabs}
        onCloseTabsToRight={handleCloseTabsToRight}
        rightActions={
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 md:hidden"
            onClick={onToggleSidebar}
            aria-label="Toggle resource navigation"
          >
            <Menu className="h-3.5 w-3.5" aria-hidden />
          </Button>
        }
      />

      {context.state === "connecting" || context.pending ? (
        <div
          data-testid="cluster-connecting-banner"
          className="flex items-center gap-2 border-b border-primary/30 bg-primary/10 px-3 py-1.5 text-[11px] text-primary"
        >
          <RefreshCw className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden />
          <span>Connecting to {context.name}…</span>
        </div>
      ) : disconnected ? (
        <div
          data-testid="cluster-error"
          className="flex flex-wrap items-center justify-between gap-2 border-b border-destructive/40 bg-destructive/10 px-3 py-1.5 text-[11px] text-destructive"
        >
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <StatusBadge
              compact
              context={{
                state: context.state,
                lastError: context.lastError,
                pending: context.pending,
              }}
            />
            <span>
              {context.lastError
                ? context.lastError.message
                : `Context is ${context.state}.`}
            </span>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-[10.5px]"
            disabled={connect.isPending}
            onClick={() => connect.mutate(contextId)}
            data-testid="connect-cluster"
          >
            <RefreshCw
              className={`h-3 w-3 ${connect.isPending ? "animate-spin text-primary" : ""}`}
              aria-hidden
            />
            {context.state === "disconnected" ? "Connect" : "Retry"}
          </Button>
        </div>
      ) : null}

      {activeTab.kind === "resource-list" && (view.evicted || view.status === "stale") ? (
        <div
          data-testid="stale-banner"
          className="flex items-center gap-2 border-b border-warning/40 bg-warning/10 px-3 py-1.5 text-[11px] text-warning"
        >
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
          Live updates were dropped to stay within the watcher budget. Reload to resync.
          <Button
            size="sm"
            variant="outline"
            className="ml-2 h-6 px-2 text-[10.5px]"
            onClick={() => listQuery.refetch()}
          >
            Reload
          </Button>
        </div>
      ) : null}

      {/* Main Workspace Content */}
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* Single Unified 42px K8Studio Toolbar for Resource List */}
        {activeTab.kind === "resource-list" && activeListResource ? (
          <div className="flex min-h-[42px] shrink-0 flex-wrap items-center gap-2.5 border-b border-border bg-panel px-3 py-1.5">
            <h1 className="text-[14px] font-semibold tracking-tight text-foreground">
              {activeListResource.plural.charAt(0).toUpperCase() + activeListResource.plural.slice(1)}
            </h1>

            {activeListResource.namespaced ? (
              <NamespacePicker
                value={namespaceFilter}
                defaultValue={contextNamespaceDefault}
                observed={observedNamespaces}
                onChange={setNamespaceFilter}
              />
            ) : (
              <span className="rounded border border-border bg-elevated px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
                cluster-scoped
              </span>
            )}

            {isPodList ? (
              <StatusFilterPicker
                selected={podStatusFilter}
                options={podStatusOptions}
                onChange={setPodStatusFilter}
              />
            ) : null}

            <div className="relative min-w-[160px] max-w-md flex-1">
              <Search
                size={12}
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                aria-label="Filter loaded rows"
                data-testid="row-filter"
                value={rowFilter}
                onChange={(event) => setRowFilter(event.target.value)}
                placeholder={`Search ${activeListResource.kind}...`}
                className="h-7 border-primary/25 bg-accent/20 pl-7 text-[11.5px] focus-visible:border-primary"
              />
            </div>

            <div className="ml-auto flex shrink-0 items-center gap-2">
              <span
                data-testid="row-count"
                className="font-mono text-[11px] tabular-nums text-muted-foreground"
              >
                {displayedCount} {displayedCount === 1 ? "item" : "items"}
              </span>

              <span className="hidden items-center gap-1 font-mono text-[10.5px] text-muted-foreground sm:flex">
                {listQuery.isFetching ? (
                  <RefreshCw size={11} className="animate-spin text-primary" aria-label="Loading" />
                ) : view.status === "ready" ? (
                  <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden="true" />
                ) : null}
                {listQuery.isFetching ? "Syncing" : view.status === "ready" ? "Live" : view.status}
              </span>

              <Button
                variant={compareOpen ? "secondary" : "ghost"}
                size="sm"
                className="h-7 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                disabled={checkedUids.size < 2}
                onClick={() => setCompareOpen((v) => !v)}
                title={
                  checkedUids.size < 2
                    ? "Check 2 rows to compare"
                    : "Compare selected resources"
                }
              >
                <GitCompareArrows className="h-3 w-3" aria-hidden />
                Compare{checkedUids.size > 0 ? ` (${checkedUids.size})` : ""}
              </Button>

              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2 text-[11px]"
                onClick={() => listQuery.refetch()}
                disabled={listQuery.isFetching || !activeListGvr}
                data-testid="reload-resources"
              >
                <RefreshCw
                  className={`h-3 w-3 ${listQuery.isFetching ? "animate-spin text-primary" : ""}`}
                  aria-hidden
                />
                Reload
              </Button>
            </div>
          </div>
        ) : activeTab.kind !== "resource-detail" &&
          activeTab.kind !== "topology" &&
          activeTab.kind !== "events" &&
          activeTab.kind !== "overview" ? (
          <div className="flex min-h-[42px] shrink-0 items-center justify-between gap-2.5 border-b border-border bg-panel px-3 py-1.5">
            <div className="flex min-w-0 items-center gap-2.5">
              <h1 className="truncate text-[14px] font-semibold tracking-tight text-foreground">
                {activeTab.title}
              </h1>
              {activeTab.subtitle ? (
                <span className="hidden font-mono text-[10.5px] text-muted-foreground sm:inline">
                  {activeTab.subtitle}
                </span>
              ) : null}
            </div>
          </div>
        ) : null}

        {/* Side-by-Side Monaco YAML Diff Modal (from 2-row Compare or Detail Diff picker) */}
        {diffPair ? (
          <YamlDiffModal
            contextId={contextId}
            left={diffPair.left}
            right={diffPair.right}
            theme={theme}
            onClose={() => setDiffPair(null)}
          />
        ) : compareOpen && comparedRows.length === 2 && activeListGvr ? (
          <YamlDiffModal
            contextId={contextId}
            left={{
              gvr: activeListGvr,
              kind: comparedRows[0]!.kind,
              name: comparedRows[0]!.name,
              namespace: comparedRows[0]!.namespace,
            }}
            right={{
              gvr: activeListGvr,
              kind: comparedRows[1]!.kind,
              name: comparedRows[1]!.name,
              namespace: comparedRows[1]!.namespace,
            }}
            theme={theme}
            onClose={() => setCompareOpen(false)}
          />
        ) : null}

        {/* Workspace Body: Full-Width Main View + Freelens-Style Floating Detail Drawer */}
        <div ref={splitRef} className="relative flex min-h-0 flex-1 overflow-hidden">
          {activeTab.kind === "topology" ? (
            <section className="min-w-0 flex-1 overflow-hidden">
              <TopologyCanvas
                contextId={contextId}
                contextName={context.name}
                namespace={visualizerNamespace}
                flush
                rows={view.rows}
                namespaceTopology={
                  namespaceTopologyQuery.data
                    ? namespaceTopologyQuery.data
                    : namespaceTopologyQuery.isLoading
                      ? null
                      : undefined
                }
                isLoading={namespaceTopologyQuery.isFetching}
                onRefresh={() => void namespaceTopologyQuery.refetch()}
                namespaceControl={
                  <NamespacePicker
                    multi={false}
                    value={visualizerNamespace}
                    defaultValue={contextNamespaceDefault}
                    observed={observedNamespaces}
                    onChange={(nextNs) => {
                      seedNamespace(contextId, nextNs);
                      setNamespaceFilter(nextNs);
                    }}
                  />
                }
                onOpenNode={(node) => {
                  const resolved = resolveGvrForKind(node.kind, resources);
                  const targetGvr = node.gvr || resolved?.gvr;
                  if (!targetGvr) return;
                  const isNamespaced = resolved ? resolved.namespaced : Boolean(node.namespace);
                  navigateToResource({
                    kind: node.kind,
                    gvr: targetGvr,
                    name: node.name,
                    namespace: isNamespaced
                      ? node.namespace || visualizerNamespace || contextNamespaceDefault
                      : undefined,
                  });
                }}
              />
            </section>
          ) : activeTab.kind === "events" ? (
            <section className="min-w-0 flex-1 overflow-hidden">
              <EventsTimelineView
                context={context}
                resources={resources}
                namespace={namespaceFilter}
                observedNamespaces={observedNamespaces}
                onChangeNamespace={(nextNs) => {
                  seedNamespace(contextId, nextNs);
                  setNamespaceFilter(nextNs);
                }}
                onNavigateResource={navigateToResource}
              />
            </section>
          ) : activeTab.kind === "security" ? (
            <section className="min-w-0 flex-1 overflow-hidden">
              <SecurityCenterView context={context} onNavigateResource={navigateToResource} />
            </section>
          ) : activeTab.kind === "helm" ? (
            <section className="min-w-0 flex-1 overflow-hidden">
              <HelmReleasesView context={context} />
            </section>
          ) : activeTab.kind === "port-forwards" ? (
            <section className="min-w-0 flex-1 overflow-hidden">
              <PortForwardsView context={context} />
            </section>
          ) : activeTab.kind === "resource-detail" && activeTab.gvr && activeTab.resourceName ? (
            <section className="min-w-0 flex-1 overflow-hidden">
              <ResourceDetail
                contextId={contextId}
                gvr={activeTab.gvr}
                name={activeTab.resourceName}
                namespace={activeTab.resourceNamespace}
                theme={theme}
                initialTab={activeTab.detailTab ?? "overview"}
                isFullTab
                discoveredResources={resources}
                comparableResources={
                  (allViews[`${contextId}\u0000${activeTab.gvr}`]?.rows ?? []).map((r) => ({
                    gvr: activeTab.gvr!,
                    kind: r.kind,
                    name: r.name,
                    namespace: r.namespace,
                  }))
                }
                onOpenDiff={(left, right) => setDiffPair({ left, right })}
                onNavigateResource={navigateToResource}
                onTabChange={(nextTab) => {
                  setTabs((prev) =>
                    prev.map((t) => (t.id === activeTab.id ? { ...t, detailTab: nextTab } : t)),
                  );
                }}
                onClose={() => handleCloseTab(activeTab.id)}
              />
            </section>
          ) : (
            <>
              <section
                data-testid="resource-list-pane"
                className="min-w-0 flex-1 overflow-hidden"
              >
                {activeTab.kind === "overview" || !activeListGvr ? (
                  <ClusterOverview
                    context={context}
                    resources={resources}
                    activeWatchCount={activeWatchCount}
                    mode="cluster"
                    isLandingPlaceholder={!activeGvr}
                    onSelectResource={openResourceTab}
                    onNavigateResource={navigateToResource}
                    onOpenTopology={() => openSpecialTab("topology")}
                    onOpenEvents={() => openSpecialTab("events")}
                  />
                ) : (
                  <ResourceTable
                    resource={activeListResource}
                    view={
                      selectedNamespaces.length >= 2 ||
                      (isPodList && podStatusFilter.length > 0) ||
                      rowFilter.trim()
                        ? { ...view, rows: filteredRows }
                        : view
                    }
                    filterActive={
                      rowFilter.trim().length > 0 || (isPodList && podStatusFilter.length > 0)
                    }
                    hideMetaBar
                    sort={activeListResource ? (sortByGvr[activeListResource.gvr] ?? null) : null}
                    onSortChange={(next) => {
                      if (!activeListResource) return;
                      setSortByGvr((prev) => ({ ...prev, [activeListResource.gvr]: next }));
                    }}
                    isFetching={listQuery.isFetching}
                    error={listQuery.error ? String((listQuery.error as Error).message) : null}
                    selectedName={selectedName}
                    selectedUid={selectedUid}
                    checkedUids={checkedUids}
                    onToggleCheck={toggleRowCheck}
                    onSelect={(row) => {
                      const alreadySelected = selectedUid
                        ? selectedUid === row.uid
                        : selectedName === row.name;
                      if (alreadySelected) {
                        setSelection(activeTab.id, null, null, selectedNamespace);
                        return;
                      }
                      setSelection(activeTab.id, row.name, row.uid, row.namespace);
                    }}
                  />
                )}
              </section>

              {activeTab.kind === "resource-list" && activeListGvr && selectedName ? (
                <aside
                  ref={inspectorRef}
                  data-testid="resource-inspector-drawer"
                  className="absolute inset-y-0 right-0 z-20 flex max-w-full border-l border-border bg-background shadow-[-12px_0_32px_rgba(0,0,0,0.32)]"
                  style={{ width: `${inspectorWidth}%`, minWidth: "min(100%, 420px)" }}
                >
                  <div
                    ref={separatorRef}
                    role="separator"
                    aria-label="Resize resource inspector"
                    aria-orientation="vertical"
                    aria-valuemin={INSPECTOR_MIN_WIDTH_PCT}
                    aria-valuemax={INSPECTOR_MAX_WIDTH_PCT}
                    aria-valuenow={inspectorWidth}
                    tabIndex={0}
                    title="Drag to resize detail drawer (double-click to reset)"
                    className="group absolute inset-y-0 -left-[3px] z-30 w-[6px] cursor-col-resize outline-none"
                    onPointerDown={(event) => {
                      if (typeof event.button === "number" && event.button !== 0) return;
                      event.preventDefault();
                      startInspectorResize();
                    }}
                    onDoubleClick={() => {
                      inspectorWidthRef.current = INSPECTOR_DEFAULT_WIDTH_PCT;
                      setInspectorWidth(INSPECTOR_DEFAULT_WIDTH_PCT);
                      saveInspectorWidthPct(INSPECTOR_DEFAULT_WIDTH_PCT);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                        event.preventDefault();
                        const bounds = splitRef.current?.getBoundingClientRect();
                        if (bounds) {
                          resizeInspector(
                            bounds.right -
                              (bounds.width * inspectorWidthRef.current) / 100 +
                              (event.key === "ArrowLeft" ? -24 : 24),
                            true,
                          );
                        }
                      }
                    }}
                  >
                    <span
                      aria-hidden="true"
                      className={`mx-auto block h-full w-[2px] transition-colors ${
                        inspectorResizing
                          ? "bg-primary"
                          : "bg-transparent group-hover:bg-primary/60 group-focus-visible:bg-primary"
                      }`}
                    />
                  </div>
                  <div className="min-w-0 flex-1 overflow-hidden">
                    <ResourceDetail
                      contextId={contextId}
                      gvr={activeListGvr}
                      name={selectedName}
                      namespace={selectedNamespace}
                      theme={theme}
                      initialTab="overview"
                      discoveredResources={resources}
                      comparableResources={view.rows.map((r) => ({
                        gvr: activeListGvr,
                        kind: r.kind,
                        name: r.name,
                        namespace: r.namespace,
                      }))}
                      onOpenDiff={(left, right) => setDiffPair({ left, right })}
                      onNavigateResource={navigateToResource}
                      onOpenFullTab={(currentTab) =>
                        openResourceFullTab(activeListGvr, selectedName, selectedNamespace, currentTab)
                      }
                      onClose={() => {
                        setSelection(activeTab.id, null, null, selectedNamespace);
                      }}
                    />
                  </div>
                </aside>
              ) : null}
            </>
          )}
        </div>
      </main>

      {/* Bottom Lens-Style Container Shell Dock */}
      <TerminalDock contextId={contextId} theme={theme} />
    </div>
  );
}
