import { describe, expect, it } from "vitest";

import type { WorkspaceTabItem } from "@/components/ide/workspace-tabs";
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
  tabIdForHistoryEntry,
  type ListTabState,
  type NavHistoryState,
} from "@/components/ide/workspace-tabs-state";

const podsTab: WorkspaceTabItem = {
  id: "list:/v1/pods",
  kind: "resource-list",
  title: "Pod",
  subtitle: "v1",
  gvr: "/v1/pods",
};

const deployTab: WorkspaceTabItem = {
  id: "list:apps/v1/deployments",
  kind: "resource-list",
  title: "Deployment",
  subtitle: "v1",
  gvr: "apps/v1/deployments",
};

const eventsTab: WorkspaceTabItem = {
  id: "special:events",
  kind: "events",
  title: "Events",
  subtitle: "Live Timeline",
};

const podDetailOverview: WorkspaceTabItem = {
  id: "detail:/v1/pods:platform:otel-0",
  kind: "resource-detail",
  title: "otel-0",
  subtitle: "platform",
  gvr: "/v1/pods",
  resourceName: "otel-0",
  resourceNamespace: "platform",
  detailTab: "overview",
};

describe("workspace-tabs-state", () => {
  it("appends a new tab and focuses existing tabs without duplicating", () => {
    const first = openOrFocusTab([INITIAL_OVERVIEW_TAB], podsTab);
    expect(first.tabs.map((t) => t.id)).toEqual([INITIAL_OVERVIEW_TAB.id, podsTab.id]);
    expect(first.activeTabId).toBe(podsTab.id);

    const second = openOrFocusTab(first.tabs, deployTab);
    expect(second.tabs.map((t) => t.id)).toEqual([
      INITIAL_OVERVIEW_TAB.id,
      podsTab.id,
      deployTab.id,
    ]);
    expect(second.activeTabId).toBe(deployTab.id);

    const refocused = openOrFocusTab(second.tabs, podsTab);
    expect(refocused.tabs.map((t) => t.id)).toEqual([
      INITIAL_OVERVIEW_TAB.id,
      podsTab.id,
      deployTab.id,
    ]);
    expect(refocused.activeTabId).toBe(podsTab.id);
  });

  it("updates detailTab in place when re-opening an existing resource-detail tab to a new subtab", () => {
    const opened = openOrFocusTab([INITIAL_OVERVIEW_TAB, podsTab], podDetailOverview);
    expect(opened.tabs).toHaveLength(3);
    expect(opened.tabs[2]?.detailTab).toBe("overview");

    const reopenedLogs = openOrFocusTab(opened.tabs, {
      ...podDetailOverview,
      detailTab: "logs",
    });
    expect(reopenedLogs.tabs).toHaveLength(3);
    expect(reopenedLogs.activeTabId).toBe(podDetailOverview.id);
    expect(reopenedLogs.tabs[2]?.detailTab).toBe("logs");
  });

  it("closes inactive, active middle, active rightmost, and lone tabs predictably", () => {
    const tabs = [INITIAL_OVERVIEW_TAB, podsTab, deployTab, eventsTab];

    // Closing inactive tab keeps active tab unchanged
    const closeInactive = closeTabById(tabs, eventsTab.id, podsTab.id);
    expect(closeInactive.tabs.map((t) => t.id)).toEqual([
      INITIAL_OVERVIEW_TAB.id,
      deployTab.id,
      eventsTab.id,
    ]);
    expect(closeInactive.activeTabId).toBe(eventsTab.id);
    expect(closeInactive.removedIds).toEqual([podsTab.id]);

    // Closing active middle tab focuses right neighbor
    const closeMiddle = closeTabById(tabs, podsTab.id, podsTab.id);
    expect(closeMiddle.activeTabId).toBe(deployTab.id);
    expect(closeMiddle.removedIds).toEqual([podsTab.id]);

    // Closing active rightmost tab focuses left neighbor
    const closeRightmost = closeTabById(tabs, eventsTab.id, eventsTab.id);
    expect(closeRightmost.activeTabId).toBe(deployTab.id);

    // Closing the only tab falls back to INITIAL_OVERVIEW_TAB
    const closeLast = closeTabById([podsTab], podsTab.id, podsTab.id);
    expect(closeLast.tabs).toEqual([INITIAL_OVERVIEW_TAB]);
    expect(closeLast.activeTabId).toBe(INITIAL_OVERVIEW_TAB.id);
    expect(closeLast.removedIds).toEqual([podsTab.id]);
  });

  it("closeActiveTabOrReset replaces a lone non-overview tab with Overview and no-ops on lone Overview", () => {
    const multi = closeActiveTabOrReset([INITIAL_OVERVIEW_TAB, podsTab], podsTab.id);
    expect(multi.changed).toBe(true);
    expect(multi.tabs).toEqual([INITIAL_OVERVIEW_TAB]);
    expect(multi.activeTabId).toBe(INITIAL_OVERVIEW_TAB.id);
    expect(multi.removedIds).toEqual([podsTab.id]);

    const lonePods = closeActiveTabOrReset([podsTab], podsTab.id);
    expect(lonePods.changed).toBe(true);
    expect(lonePods.tabs).toEqual([INITIAL_OVERVIEW_TAB]);
    expect(lonePods.activeTabId).toBe(INITIAL_OVERVIEW_TAB.id);
    expect(lonePods.removedIds).toEqual([podsTab.id]);

    const loneOverview = closeActiveTabOrReset([INITIAL_OVERVIEW_TAB], INITIAL_OVERVIEW_TAB.id);
    expect(loneOverview.changed).toBe(false);
    expect(loneOverview.tabs).toEqual([INITIAL_OVERVIEW_TAB]);
    expect(loneOverview.activeTabId).toBe(INITIAL_OVERVIEW_TAB.id);
    expect(loneOverview.removedIds).toEqual([]);
  });

  it("supports closeOtherTabsById and closeTabsToRightById", () => {
    const tabs = [INITIAL_OVERVIEW_TAB, podsTab, deployTab, eventsTab];

    const others = closeOtherTabsById(tabs, deployTab.id);
    expect(others.tabs).toEqual([deployTab]);
    expect(others.activeTabId).toBe(deployTab.id);
    expect(others.removedIds).toEqual([INITIAL_OVERVIEW_TAB.id, podsTab.id, eventsTab.id]);

    // Active tab to the left of target stays active
    const rightKeepActive = closeTabsToRightById(tabs, INITIAL_OVERVIEW_TAB.id, podsTab.id);
    expect(rightKeepActive.tabs.map((t) => t.id)).toEqual([INITIAL_OVERVIEW_TAB.id, podsTab.id]);
    expect(rightKeepActive.activeTabId).toBe(INITIAL_OVERVIEW_TAB.id);
    expect(rightKeepActive.removedIds).toEqual([deployTab.id, eventsTab.id]);

    // Active tab to the right of target falls back to target
    const rightSwitchActive = closeTabsToRightById(tabs, eventsTab.id, podsTab.id);
    expect(rightSwitchActive.tabs.map((t) => t.id)).toEqual([INITIAL_OVERVIEW_TAB.id, podsTab.id]);
    expect(rightSwitchActive.activeTabId).toBe(podsTab.id);
    expect(rightSwitchActive.removedIds).toEqual([deployTab.id, eventsTab.id]);
  });

  it("prunes closed tab IDs from tabStateById and keeps reference when unchanged", () => {
    const podState: ListTabState = { ...EMPTY_LIST_TAB_STATE, rowFilter: "api" };
    const deployState: ListTabState = { ...EMPTY_LIST_TAB_STATE, rowFilter: "web" };
    const map: Record<string, ListTabState> = {
      [podsTab.id]: podState,
      [deployTab.id]: deployState,
    };

    expect(pruneTabStateMap(map, [])).toBe(map);
    expect(pruneTabStateMap(map, ["missing"])).toBe(map);

    const pruned = pruneTabStateMap(map, [deployTab.id]);
    expect(pruned).toEqual({ [podsTab.id]: podState });
  });

  it("prunes closed tabs from navHistory, collapses adjacent duplicates, and anchors index", () => {
    const history: NavHistoryState = {
      entries: [
        { kind: "overview" },
        { kind: "resource-list", gvr: "/v1/pods" },
        { kind: "resource-list", gvr: "apps/v1/deployments" },
        { kind: "resource-list", gvr: "/v1/pods" },
        { kind: "special", target: "events" },
      ],
      index: 4,
    };

    expect(tabIdForHistoryEntry({ kind: "overview" })).toBe(INITIAL_OVERVIEW_TAB.id);
    expect(sameHistoryEntry(historyEntryForTab(podsTab), { kind: "resource-list", gvr: "/v1/pods" })).toBe(
      true,
    );

    // Close Deployments while Events is active -> adjacent Pod entries collapse into one
    const pruned = pruneNavHistoryForRemainingTabs(
      history,
      [INITIAL_OVERVIEW_TAB, podsTab, eventsTab],
      eventsTab,
    );
    expect(pruned.entries).toEqual([
      { kind: "overview" },
      { kind: "resource-list", gvr: "/v1/pods" },
      { kind: "special", target: "events" },
    ]);
    expect(pruned.index).toBe(2);

    // Close Events -> falls back to Pods as active
    const prunedAfterEvents = pruneNavHistoryForRemainingTabs(
      pruned,
      [INITIAL_OVERVIEW_TAB, podsTab],
      podsTab,
    );
    expect(prunedAfterEvents.entries).toEqual([
      { kind: "overview" },
      { kind: "resource-list", gvr: "/v1/pods" },
    ]);
    expect(prunedAfterEvents.index).toBe(1);
  });

  it("resolves Cmd+1..9 shortcut digits and Ctrl+Tab cycling", () => {
    const tenTabs: WorkspaceTabItem[] = Array.from({ length: 10 }, (_, idx) => ({
      id: `tab-${idx + 1}`,
      kind: "resource-list",
      title: `Tab ${idx + 1}`,
      gvr: `/v1/r${idx + 1}`,
    }));

    expect(resolveTabShortcutId(tenTabs, 1)).toBe("tab-1");
    expect(resolveTabShortcutId(tenTabs, 8)).toBe("tab-8");
    expect(resolveTabShortcutId(tenTabs, 9)).toBe("tab-10");
    expect(resolveTabShortcutId([podsTab, deployTab], 5)).toBeNull();
    expect(resolveTabShortcutId([podsTab, deployTab], 9)).toBe(deployTab.id);

    const trio = [INITIAL_OVERVIEW_TAB, podsTab, deployTab];
    expect(resolveCycleTabId(trio, INITIAL_OVERVIEW_TAB.id, 1)).toBe(podsTab.id);
    expect(resolveCycleTabId(trio, deployTab.id, 1)).toBe(INITIAL_OVERVIEW_TAB.id);
    expect(resolveCycleTabId(trio, INITIAL_OVERVIEW_TAB.id, -1)).toBe(deployTab.id);
    expect(resolveCycleTabId([INITIAL_OVERVIEW_TAB], INITIAL_OVERVIEW_TAB.id, 1)).toBeNull();
  });
});
