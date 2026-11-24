# Per-Cluster Multi-Tab Workspace — Design

**Date:** 2026-11-24  
**Status:** Draft (pending user approval)

## Intent & Why

Engineers using Kubix alongside tools like K8Studio and Freelens want to keep multiple cluster views open at the same time—for example, `Pods`, `Events`, `Security`, and one or more full-tab Pod/Log inspectors—and flip between them without losing table search filters or drawer selections.

Today [workspace-tabs.tsx](file:///Users/tentanganakbahagia/Documents/Mine/kubix/src/components/ide/workspace-tabs.tsx) already renders a tab bar, but [cluster-shell.tsx](file:///Users/tentanganakbahagia/Documents/Mine/kubix/src/routes/cluster-shell.tsx) overwrites the tab list (`setTabs([nextTab])`) on every sidebar click and caps full-tab resource details to `[base, nextDetailTab]`. Switching away from any view destroys it.

## Goals, Non-Goals & Anti-Goals

### Goals
1. **Open-or-focus per-cluster tab strip:** Navigating to any resource list, special view (`Cluster Overview`, `Topology`, `Events`, `Security`, `Helm Releases`, `Port Forwards`), or full-tab resource detail (via "Open in workspace tab", `Cmd+K` instance search, or cross-resource clickable links) appends a new tab or focuses the existing tab with the same `id` instead of wiping the bar.
2. **Preserve per-tab UI state:** Switching tabs remembers each tab's local state:
   - Resource-list tabs: `rowFilter`, `podStatusFilter`, floating detail drawer selection (`selectedName`, `selectedUid`, `selectedNamespace`), and `checkedUids` (table sort is already preserved per GVR in `sortByGvr`).
   - Resource-detail tabs: active inner `detailTab` (`overview`, `yaml`, `logs`, `events`, `security`, `metrics`, `topology`).
3. **Standard tab ergonomics & native `Cmd+W` support:**
   - All tabs are closable whenever `tabs.length > 1` (closing the last tab or closing a single non-overview tab falls back to `Cluster Overview`).
   - Close via `×` button, middle-click (`button === 1`), or a right-click context menu on any tab (**Close**, **Close Others**, **Close to the Right**).
   - Active tab automatically scrolls into view inside the horizontally scrollable tab strip.
   - Keyboard shortcuts:
     - `Cmd/Ctrl+W`: wired through Tauri's native application menu on desktop (plus a JS `keydown` fallback for non-menu / test environments) so `Cmd+W` closes the active tab inside a cluster (or falls back to `Cluster Overview` if the lone tab is not overview; no-op when only `Cluster Overview` is open) and closes the window when on `ClusterPicker`. `File → Close Window` moves to `Cmd/Ctrl+Shift+W`.
     - `Cmd/Ctrl+1`..`Cmd/Ctrl+8`: focus tab by 1-based index; `Cmd/Ctrl+9`: focus the last tab.
     - `Ctrl+Tab` / `Ctrl+Shift+Tab`: cycle forward / backward through open tabs (wrapping around).
     - Frontend `keydown` shortcuts are suppressed while typing in inputs/textareas/selects/contentEditable or when a modal dialog (`[role="dialog"]`) is open.
   - List the new shortcuts in `SettingsModal` (`SHORTCUTS`).
4. **Protect the 8-watch LRU budget & WebKit memory:** Only the currently active tab mounts its view, live watch, Monaco YAML editor, or log stream. Cached rows in `useExplorerStore.views` keep switch-back rendering immediate while watches resume cleanly.
5. **Honest sidebar & Back/Forward history sync:** Switching tabs updates sidebar selection (`activeGvr` / `specialView`) cleanly—including `events` and `resource-detail`—and Back/Forward navigation stays honest across open tabs without wiping other tabs or resurrecting closed ones.

### Non-Goals
- Cross-cluster tabs or concurrent multi-cluster connections (`App.tsx` single-cluster disconnect behavior stays unchanged).
- Per-tab namespace filters (all resource-list tabs in a cluster continue to share `useExplorerStore.namespaceFilter`).
- Drag-and-drop tab reordering, split-pane side-by-side tab groups, or persisting open tabs to `localStorage` across app restarts.
- Background keep-alive mounting or background log streaming for inactive tabs.

### Anti-Goals
- Consuming Kubix's 8 concurrent Kubernetes watch slots on inactive background tabs.
- Leaving hidden Monaco editors or live log streams mounted in WebKit.
- Breaking the Freelens-style floating resource detail drawer on resource-list tabs.
- Adding any mutating Kubernetes command or relaxing `src-tauri/src/readonly.rs` / capability security guards (`shell:`, `fs:`, `http:`, `process:`).

## Constraints

- **Read-only guarantee preserved:** No new Tauri commands; only one UI menu event (`kubix://close-active-tab`) following the Rust → `pnpm ipc:schema` → TypeScript contract workflow, plus `core:window:allow-close` in `src-tauri/capabilities/default.json`.
- Zero new npm or Cargo dependencies.
- Keep existing `data-testid="workspace-tabs"` and `data-testid="workspace-tab"` contracts intact.
- Existing tests in `tests/frontend/ide-ui.test.tsx` (around lines 1094–1106 and 1211) that explicitly asserted the old single-tab replacement (`toHaveLength(1)` after switching views) must be updated to verify multi-tab retention.
- `pnpm verify` (rustfmt, clippy, cargo test, typecheck, vitest, `pnpm ipc:check`) must pass.

## Approaches Considered

1. **Approach 1 — Active-Tab Rendering + Per-Tab State in `ClusterShell` *(Selected)*:** Keep an open-or-focus tab list and per-tab local state map inside `ClusterShell`, rendering only the active tab while sharing the cluster's namespace filter. *Trade-off:* Lowest CPU/memory footprint, never exhausts the 8-watch budget, minimal churn to `useExplorerStore`; background `Logs` tabs reconnect and re-tail when switched back to.
2. **Approach 2 — Keep Open Tabs Mounted in Background (CSS-Hidden):** Render all open tabs simultaneously and hide inactive ones with CSS. *Trade-off:* Continuous background log streaming, but every open list tab burns a watch slot (evicting at >8) and hidden Monaco editors/streams increase WebKit memory usage.
3. **Approach 3 — Dedicated `useWorkspaceTabStore` with Per-Tab Namespace Scope:** Move tabs and namespace filters into a new Zustand store keyed by `contextId`. *Trade-off:* Independent namespaces per tab and remount survival, at the cost of refactoring `namespaceFilter` out of `useExplorerStore` and reworking existing namespace-seeding behavior/tests.

## Design

### 1. Tab Identity, Ordering & Lifecycle
- **Stable tab IDs (deduplication key):**
  - Cluster Overview: `special:cluster-overview`
  - Other special views: `special:topology`, `special:events`, `special:security`, `special:helm`, `special:port-forwards`
  - Resource lists: `list:<gvr>`
  - Full-tab resource details: `detail:<gvr>:<namespace ?? "">:<name>`
- **Open-or-focus rule:**
  - Opening any target checks if a tab with the same `id` already exists in `tabs`.
  - If it exists: activate it (and for `resource-detail`, update `detailTab` if explicitly requested, e.g. opening directly to `logs`).
  - If it does not exist: append it to the end of `tabs` and activate it. *(Builder/designer call: consistent append-to-end ordering keeps `Cmd+1..9` positions predictable.)*
- **Closability & closing fallback:**
  - Remove `closable: false` restrictions on overview/list/special tabs; `WorkspaceTabs` shows a tab's close button whenever `tabs.length > 1`.
  - Closing an **inactive** tab removes it and leaves `activeTabId` unchanged.
  - Closing the **active** tab selects the right neighbor (`remaining[closedIndex]`), or the left neighbor (`remaining[closedIndex - 1]`) if it was the rightmost tab. If no tabs remain, fall back to `[INITIAL_OVERVIEW_TAB]`.
  - **Close Others (`targetId`)**: keeps only `targetId` and activates it.
  - **Close to the Right (`targetId`)**: removes all tabs at index `> targetIndex`; if `activeTabId` was among the removed tabs, activates `targetId`.
- **Cluster switch reset:** When `contextId` changes, reset `tabs` to `[INITIAL_OVERVIEW_TAB]`, `activeTabId` to `INITIAL_OVERVIEW_TAB.id`, `tabStateById` to `{}`, and `navHistory` to `[{ kind: "overview" }]`.

### 2. Per-Tab State Model (`tabStateById`)
- Store resource-list UI state in `tabStateById: Record<string, ListTabState>` keyed by tab `id`:
  ```ts
  interface ListTabState {
    rowFilter: string;
    podStatusFilter: string[];
    selectedName: string | null;
    selectedUid: string | null;
    selectedNamespace?: string;
    checkedUids: string[];
  }
  ```
- Read and update the active list tab's fields directly through `tabStateById[activeTab.id]` (falling back to empty defaults) rather than mirroring into separate top-level `useState` hooks, avoiding stale-sync races on rapid tab switches.
- When `activeNamespaceFilter` changes on a `resource-list` tab, clear `selectedName`, `selectedUid`, `selectedNamespace`, and `checkedUids` for that tab (and close `compareOpen`), while preserving `rowFilter` and `podStatusFilter`.
- On any tab close (`close`, `closeOthers`, `closeRight`), prune removed tab IDs from `tabStateById`.
- On `resource-detail` tabs, pass `onTabChange` to `ResourceDetail` so changing the inner tab (`Overview` / `YAML` / `Logs` / `Events` / `Security` / `Metrics` / `Topology`) updates that tab's `detailTab` field in `tabs`.

### 3. Active-Tab Watch Gating & Sidebar / History Sync
- **Watch gating in `ClusterShell`:**
  - `const activeListGvr = activeTab.kind === "resource-list" ? (activeTab.gvr ?? null) : null;`
  - Gate `useResourceListQuery` on `enabled: Boolean(activeListGvr) && (context?.state === "ready" || context?.state === "degraded")` using `gvr: (activeListGvr ?? "") as GroupVersionResource`.
  - Pass `activeListGvr` to `useStopWatchOnUnmount(contextId, activeListGvr, effectiveNamespace)` so switching to a non-list tab (or another list tab) stops the previous watch and frees its watch slot while `useExplorerStore.views` retains the cached snapshot.
  - Only render the `stale-banner` when `activeTab.kind === "resource-list"`.
- **Sidebar & App sync (`handleSelectTab` / `handleCloseTab`):**
  - When activating a tab directly from the tab bar, set `skipSyncEffectRef.current = true` whenever updating `specialView` or `activeGvr` so the prop-sync `useEffect` does not double-push history.
  - Handle **all** tab kinds in `handleSelectTab` and close-fallback sync:
    - `resource-list` → `onChangeSpecialView(null)` + `setActiveGvr(tab.gvr)`
    - `resource-detail` → `onChangeSpecialView(null)`
    - `overview` → `onChangeSpecialView("cluster-overview")`
    - `topology` / `events` / `security` / `helm` / `port-forwards` → `onChangeSpecialView(tab.kind)`
- **Back/Forward history (`navHistory`) — *(Designer call)*:**
  - Clicking a tab pushes its `NavHistoryEntry` (deduped via `sameHistoryEntry`).
  - `restoreHistoryEntry` focuses (or opens if needed) the target tab in the existing `tabs` list without wiping other open tabs.
  - Closing tabs (`Close`, `Close Others`, `Close to the Right`) **prunes closed tabs' entries from `navHistory`**, collapses adjacent duplicates, and anchors `index` to the active remaining tab (matching Kubix's existing convention in `cluster-shell.tsx:773` so Back/Forward never unexpectedly resurrects a tab you explicitly closed).

### 4. Native macOS `Cmd+W` Menu Wiring & Keyboard Shortcuts
- **Rust menu + IPC event (`src-tauri/src/app/mod.rs`, `src-tauri/src/ipc/events.rs`, `src-tauri/capabilities/default.json`):**
  - Declare `pub const CLOSE_ACTIVE_TAB: &str = "kubix://close-active-tab";` with payload `"null"` in `src-tauri/src/ipc/events.rs`, regenerate `src/lib/ipc/schema/contract.json` via `pnpm ipc:schema`, and mirror it in `src/lib/ipc/events.ts` (`CLOSE_ACTIVE_TAB_EVENT`) and `src/lib/ipc/client.ts` (`onCloseActiveTab`).
  - In `src-tauri/src/app/mod.rs` (`run()`), attach a desktop menu preserving the standard macOS App / Edit / View / Window items, with **File → Close Tab** bound to `CmdOrCtrl+W` and **File → Close Window** bound to `CmdOrCtrl+Shift+W` (`PredefinedMenuItem::close_window`).
  - In `.on_menu_event(...)`, when `close-tab` triggers, emit `CLOSE_ACTIVE_TAB` (`()` payload) to the main window.
  - Add `"core:window:allow-close"` to `src-tauri/capabilities/default.json` so `App.tsx` can close the window via `getCurrentWindow().close()` when `kubix://close-active-tab` arrives on `ClusterPicker` (`selectedId === null`).
- **Frontend handling (`App.tsx` & `ClusterShell`):**
  - `App.tsx` subscribes to `onCloseActiveTab`: if a cluster is selected (`selectedId !== null`), it invokes the close-active-tab callback exposed by `ClusterShell` (via `clusterNav` or a ref); if on `ClusterPicker` (`selectedId === null`), it closes the Tauri window (no-op in browser/test transport).
  - `ClusterShell` registers a `keydown` listener for `Cmd/Ctrl+1..9`, `Ctrl+Tab` / `Ctrl+Shift+Tab`, and a `Cmd/Ctrl+W` fallback (for browser dev mode / tests / Linux when native menu didn't intercept it; guarded against editable inputs and `[role="dialog"]`).
  - When `closeActiveTab` runs inside `ClusterShell`: if `tabs.length > 1`, close the active tab; if `tabs.length === 1` and it is not `INITIAL_OVERVIEW_TAB`, replace it with `INITIAL_OVERVIEW_TAB`; if only `INITIAL_OVERVIEW_TAB` is open, no-op.
- **SettingsModal:** Add `⌘W` (Close active tab), `⌘1–9` (Jump to tab), and `⌃Tab / ⌃⇧Tab` (Next / previous tab) to `SHORTCUTS` in [settings-modal.tsx](file:///Users/tentanganakbahagia/Documents/Mine/kubix/src/components/ide/settings-modal.tsx).

### 5. `WorkspaceTabs` UI Enhancements
- Extend `WorkspaceTabsProps` with:
  - `onCloseOtherTabs?: (id: string) => void`
  - `onCloseTabsToRight?: (id: string) => void`
- Support middle-click close (`onAuxClick` when `e.button === 1`, calling `e.preventDefault()` and `onCloseTab(tab.id)` when `tabs.length > 1`).
- Support right-click context menu (`onContextMenu`) on each tab with **Close**, **Close Others** (disabled when `tabs.length <= 1`), and **Close to the Right** (disabled when tab is rightmost); closes on outside click, `Escape`, or action selection.
- Auto-scroll the active tab element into view when `activeTabId` changes (guarded for jsdom where `scrollIntoView` may be undefined).

## Left to the Builder

- Pure helper module extraction (e.g., `src/components/ide/workspace-tabs-state.ts`) for tab array mutations (`openOrFocusTab`, `closeTab`, `closeOtherTabs`, `closeTabsToRight`) and history pruning to keep `ClusterShell` clean and unit-testable.
- Exact Tailwind classes and viewport-edge clamping for the tab right-click context menu.
- Exact test cases in `tests/frontend/ide-ui.test.tsx` (updating lines ~1094–1106 & 1211 plus adding multi-tab tests) and unit tests for the tab state helpers.
