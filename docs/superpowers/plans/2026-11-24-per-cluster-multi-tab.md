# Per-Cluster Multi-Tab Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Kubix's single-tab workspace bar into a per-cluster open-or-focus multi-tab workspace with per-tab UI state preservation, active-tab-only watch gating, right-click/middle-click tab actions, and native macOS `Cmd+W` support.

**Architecture:** Extract pure tab-list and history-pruning reducers into `src/components/ide/workspace-tabs-state.ts`, enhance `WorkspaceTabs` with close-others/close-right/middle-click/auto-scroll ergonomics, wire a single read-only UI menu event (`kubix://close-active-tab`) through Tauri's native menu in `src-tauri/src/app/mod.rs` (plus `core:window:allow-close`), and update `ClusterShell` + `App.tsx` + `SettingsModal` to manage per-tab state (`tabStateById`), active-tab-only live watches, and keyboard shortcuts.

**Tech Stack:** React 18, TypeScript 5.7, Tailwind CSS, Zustand 5, TanStack Query 5, Vitest + Testing Library, Tauri 2 (Rust).

**Spec:** [2026-11-24-per-cluster-multi-tab-design.md](file:///Users/tentanganakbahagia/Documents/Mine/kubix/docs/superpowers/specs/2026-11-24-per-cluster-multi-tab-design.md)

## Global Constraints

- **Read-only guarantee preserved:** Zero new Tauri commands; only one UI menu event (`kubix://close-active-tab`, payload `"null"`) following the Rust → `pnpm ipc:schema` → TypeScript workflow, plus `"core:window:allow-close"` in `src-tauri/capabilities/default.json` (never `shell:`, `fs:`, `http:`, or `process:`).
- **Zero new dependencies:** No new npm or Cargo packages.
- **Stable test contracts:** Keep `data-testid="workspace-tabs"` and `data-testid="workspace-tab"` intact; update legacy single-tab assertions in `tests/frontend/ide-ui.test.tsx` (lines ~1094–1106 and ~1211).
- **Watch budget & memory safety:** Only the active tab mounts its view, live Kubernetes watch, Monaco editor, or log stream.
- **Full verification gate:** `pnpm verify` (`rust:fmt`, `rust:clippy`, `rust:test`, `typecheck`, `test`, `ipc:check`) must pass.

## Review Focus

1. **Closing the last remaining non-overview tab via `Cmd+W`:** Must replace the lone non-overview tab with `Cluster Overview` instead of emptying the tab strip or closing the app window; pressing `Cmd+W` when only `Cluster Overview` is open must be a no-op inside a cluster (pinned in Task 1 and Task 4 tests).
2. **Shortcuts firing inside editable controls or modal dialogs:** `Cmd/Ctrl+1..9`, `Ctrl+Tab`/`Ctrl+Shift+Tab`, and JS `Cmd/Ctrl+W` fallback must not switch or close tabs when focused inside an `input`/`textarea`/`select`/`contentEditable` or when a `[role="dialog"]` modal is open (pinned in Task 4 test).
3. **Background resource-list tabs leaking live watches:** Switching from `Pods` to `Events` (or `Deployments`) must stop the inactive `/v1/pods` watch via `stop_watch` while keeping cached rows in `useExplorerStore.views` for immediate switch-back (pinned in Task 4 test).
4. **Tab context menu disabled boundaries and dismissal:** Right-clicking a lone tab or the rightmost tab must disable **Close Others** / **Close to the Right** so no tab is mistakenly closed, and `Escape` or outside click must dismiss the menu (pinned in Task 2 test).
5. **Re-opening an existing full-tab resource detail to a different inner tab:** Opening a resource already open at `overview` with `detailTab: "logs"` must focus the existing tab and update its `detailTab` to `"logs"` without duplicating the tab (pinned in Task 1 and Task 4 tests).

---

## File Structure

- **Create** `src/components/ide/workspace-tabs-state.ts` — Pure tab-list mutations (`openOrFocusTab`, `closeTabById`, `closeOtherTabsById`, `closeTabsToRightById`, `closeActiveTabOrReset`), per-tab state map pruning (`pruneTabStateMap`), `navHistory` pruning/compaction (`pruneNavHistoryForRemainingTabs`), and shortcut resolution (`resolveTabShortcutId`, `resolveCycleTabId`).
- **Create** `tests/frontend/workspace-tabs-state.test.ts` — Unit tests for every pure reducer and edge case.
- **Modify** `src/components/ide/workspace-tabs.tsx` — Always allow closing tabs when `tabs.length > 1`, add middle-click close, right-click context menu (`Close`, `Close Others`, `Close to the Right`), and active-tab `scrollIntoView`.
- **Modify** `src-tauri/src/ipc/events.rs`, `src-tauri/src/app/mod.rs`, `src-tauri/capabilities/default.json`, `src/lib/ipc/schema/contract.json`, `src/lib/ipc/events.ts`, `src/lib/ipc/client.ts` — Register `kubix://close-active-tab`, configure Tauri's desktop menu (`Close Tab` on `CmdOrCtrl+W`, `Close Window` on `CmdOrCtrl+Shift+W`), emit event on menu trigger, and expose `onCloseActiveTab`.
- **Modify** `src/routes/cluster-shell.tsx`, `src/App.tsx`, `src/components/ide/settings-modal.tsx` — Wire open-or-focus tabs, `tabStateById`, active-tab watch gating, full sidebar/history sync, keyboard shortcuts, native `close-active-tab` handling (closing window on `ClusterPicker`), and SettingsModal shortcut documentation.
- **Modify** `tests/frontend/ide-ui.test.tsx` — Add `WorkspaceTabs` UI tests, update legacy single-tab assertions, and add multi-tab `ClusterShell`/`App` integration tests.

---

### Task 1: Pure Workspace Tab & History State Module

**Files:**
- Create: `src/components/ide/workspace-tabs-state.ts`
- Test: `tests/frontend/workspace-tabs-state.test.ts`

**Interfaces:**
- Consumes: `WorkspaceTabItem` from `@/components/ide/workspace-tabs`, `DetailTab` from `@/components/explorer/resource-detail`, `SpecialNavTarget` from `@/components/ide/navigation-sidebar`.
- Produces (exported from `src/components/ide/workspace-tabs-state.ts`):
  - `INITIAL_OVERVIEW_TAB: WorkspaceTabItem`
  - `ListTabState` interface: `{ rowFilter: string; podStatusFilter: string[]; selectedName: string | null; selectedUid: string | null; selectedNamespace?: string; checkedUids: string[] }`
  - `EMPTY_LIST_TAB_STATE: ListTabState`
  - `NavHistoryEntry` union type (moved from `cluster-shell.tsx` so both share it)
  - `NavHistoryState` interface: `{ entries: NavHistoryEntry[]; index: number }`
  - `sameHistoryEntry(a: NavHistoryEntry, b: NavHistoryEntry): boolean`
  - `tabIdForHistoryEntry(entry: NavHistoryEntry): string`
  - `historyEntryForTab(tab: WorkspaceTabItem): NavHistoryEntry`
  - `openOrFocusTab(tabs: WorkspaceTabItem[], nextTab: WorkspaceTabItem): { tabs: WorkspaceTabItem[]; activeTabId: string }`
  - `closeTabById(tabs: WorkspaceTabItem[], activeTabId: string, targetId: string): { tabs: WorkspaceTabItem[]; activeTabId: string; removedIds: string[] }`
  - `closeActiveTabOrReset(tabs: WorkspaceTabItem[], activeTabId: string): { tabs: WorkspaceTabItem[]; activeTabId: string; removedIds: string[]; changed: boolean }`
  - `closeOtherTabsById(tabs: WorkspaceTabItem[], targetId: string): { tabs: WorkspaceTabItem[]; activeTabId: string; removedIds: string[] }`
  - `closeTabsToRightById(tabs: WorkspaceTabItem[], activeTabId: string, targetId: string): { tabs: WorkspaceTabItem[]; activeTabId: string; removedIds: string[] }`
  - `pruneTabStateMap(stateById: Record<string, ListTabState>, removedIds: string[]): Record<string, ListTabState>`
  - `pruneNavHistoryForRemainingTabs(history: NavHistoryState, remainingTabs: WorkspaceTabItem[], activeTab: WorkspaceTabItem): NavHistoryState`
  - `resolveTabShortcutId(tabs: WorkspaceTabItem[], digit: number): string | null`
  - `resolveCycleTabId(tabs: WorkspaceTabItem[], activeTabId: string, direction: 1 | -1): string | null`

- [ ] **Step 1: Write the failing unit tests in `tests/frontend/workspace-tabs-state.test.ts`**

Write tests covering:
- `openOrFocusTab`: appends new tab and activates it; focuses existing tab by `id` without duplicating; when focusing an existing `resource-detail` tab with a new `detailTab` (e.g. `"logs"` over `"overview"`), updates `detailTab` in place.
- `closeTabById`: closing an inactive tab keeps `activeTabId` unchanged; closing an active middle tab selects the right neighbor; closing the rightmost active tab selects the left neighbor; closing the only tab falls back to `[INITIAL_OVERVIEW_TAB]`.
- `closeActiveTabOrReset`: when `tabs.length > 1`, closes active tab like `closeTabById`; when only one non-overview tab is open (`Pods`), replaces it with `[INITIAL_OVERVIEW_TAB]` (`changed: true`); when only `INITIAL_OVERVIEW_TAB` is open, returns `changed: false` with the same tab.
- `closeOtherTabsById`: keeps only `targetId`, sets it active, returns all other IDs in `removedIds`.
- `closeTabsToRightById`: drops tabs after `targetId`, preserves `activeTabId` if it was at or left of `targetId`, activates `targetId` if `activeTabId` was removed.
- `pruneTabStateMap`: removes closed tab IDs and returns the original reference when nothing was removed.
- `pruneNavHistoryForRemainingTabs`: drops entries whose `tabIdForHistoryEntry` is not in `remainingTabs`, collapses adjacent duplicate entries, and points `index` to `historyEntryForTab(activeTab)` (appending it if absent).
- `resolveTabShortcutId`: maps digits `1..8` to 0-based index (returns `null` if out of bounds) and digit `9` to the last tab (`tabs[tabs.length - 1]`).
- `resolveCycleTabId`: wraps forward from last tab to first (`direction: 1`) and backward from first tab to last (`direction: -1`); returns `null` when `tabs.length <= 1`.

- [ ] **Step 2: Run unit tests to verify they fail**

Run: `pnpm test tests/frontend/workspace-tabs-state.test.ts`
Expected: FAIL because `src/components/ide/workspace-tabs-state.ts` does not exist yet.

- [ ] **Step 3: Implement `src/components/ide/workspace-tabs-state.ts`**

Implement all exported types and pure functions listed in the Interfaces block. Ensure `INITIAL_OVERVIEW_TAB` does not hardcode `closable: false` (leave `closable` undefined/`true` so `WorkspaceTabs` controls close-button visibility via `tabs.length > 1`). In `openOrFocusTab`, preserve existing tab fields when focusing by `id`, updating `detailTab` only when `nextTab.kind === "resource-detail" && nextTab.detailTab` is provided. In `pruneNavHistoryForRemainingTabs`, filter `entries` to those whose `tabIdForHistoryEntry(entry)` is in the set of `remainingTabs` IDs, deduplicate adjacent entries with `sameHistoryEntry`, and anchor `index` to the matching `activeEntry` (preferring the last occurrence at or before the mapped old index, or appending `activeEntry` if none remain).

- [ ] **Step 4: Run unit tests to verify they pass**

Run: `pnpm test tests/frontend/workspace-tabs-state.test.ts`
Expected: PASS (all tests green).

---

### Task 2: `WorkspaceTabs` UI Enhancements (Middle-Click, Context Menu, Auto-Scroll)

**Files:**
- Modify: `src/components/ide/workspace-tabs.tsx`
- Test: `tests/frontend/ide-ui.test.tsx`

**Interfaces:**
- Consumes: existing `WorkspaceTabItem`, `WorkspaceTabKind`.
- Produces (`WorkspaceTabsProps` in `src/components/ide/workspace-tabs.tsx`):
  ```ts
  export interface WorkspaceTabsProps {
    tabs: WorkspaceTabItem[];
    activeTabId: string;
    onSelectTab: (id: string) => void;
    onCloseTab: (id: string) => void;
    onCloseOtherTabs?: (id: string) => void;
    onCloseTabsToRight?: (id: string) => void;
    rightActions?: React.ReactNode;
  }
  ```

- [ ] **Step 1: Write failing `WorkspaceTabs` tests in `tests/frontend/ide-ui.test.tsx`**

Add tests in the existing `WorkspaceTabs` describe block verifying:
- When 2+ tabs exist (even with `overview`), each tab renders a close button (`Close tab <title>`) and clicking `×` calls `onCloseTab(id)`.
- Middle-clicking a tab (`fireEvent.auxClick(tabEl, { button: 1 })`) calls `onCloseTab(tab.id)` when `tabs.length > 1`, and does nothing when `tabs.length === 1`.
- Right-clicking a tab (`fireEvent.contextMenu(tabEl)`) opens a `role="menu"` popover (`data-testid="tab-context-menu"`) with **Close**, **Close Others**, and **Close to the Right**:
  - Clicking **Close Others** calls `onCloseOtherTabs(tab.id)` and closes the menu.
  - Clicking **Close to the Right** calls `onCloseTabsToRight(tab.id)` and closes the menu.
  - When right-clicking the rightmost tab, **Close to the Right** is `disabled`.
  - When right-clicking the only tab (`tabs.length === 1`), **Close**, **Close Others**, and **Close to the Right** are all `disabled`.
  - Pressing `Escape` or clicking outside dismisses the menu.

- [ ] **Step 2: Run the new `WorkspaceTabs` tests to verify they fail**

Run: `pnpm test tests/frontend/ide-ui.test.tsx -t "WorkspaceTabs"`
Expected: FAIL on missing context menu / middle-click close behavior.

- [ ] **Step 3: Update `src/components/ide/workspace-tabs.tsx`**

- Add `onCloseOtherTabs?: (id: string) => void` and `onCloseTabsToRight?: (id: string) => void` to `WorkspaceTabsProps`.
- Allow closing any tab when `tab.closable !== false && tabs.length > 1`.
- Add `onAuxClick` handler on each tab container: if `e.button === 1 && tab.closable !== false && tabs.length > 1`, call `e.preventDefault()` and `onCloseTab(tab.id)`.
- Add `onContextMenu` handler storing `{ tabId, x, y }` state and rendering a fixed-position `role="menu"` (`data-testid="tab-context-menu"`) clamped to viewport width/height, with `Close`, `Close Others`, and `Close to the Right` menu items (`role="menuitem"`). Dismiss on `Escape`, `mousedown` outside the menu, or clicking any enabled menu item.
- Keep a ref map of tab DOM nodes and in a `useEffect` on `activeTabId`, call `el?.scrollIntoView?.({ block: "nearest", inline: "nearest" })` so newly opened/focused tabs scroll into view safely in both WebKit and jsdom.

- [ ] **Step 4: Run `WorkspaceTabs` tests to verify they pass**

Run: `pnpm test tests/frontend/ide-ui.test.tsx -t "WorkspaceTabs"`
Expected: PASS.

---

### Task 3: Native macOS `Cmd+W` Menu Wiring & IPC Event Contract

**Files:**
- Modify: `src-tauri/src/ipc/events.rs`
- Modify: `src-tauri/src/app/mod.rs`
- Modify: `src-tauri/capabilities/default.json`
- Regenerate: `src/lib/ipc/schema/contract.json` (via `pnpm ipc:schema`)
- Modify: `src/lib/ipc/events.ts`
- Modify: `src/lib/ipc/client.ts`

**Interfaces:**
- Produces (Rust):
  - `crate::ipc::events::CLOSE_ACTIVE_TAB = "kubix://close-active-tab"` (payload `"null"`)
  - `MENU_CLOSE_TAB_ID: &str = "close-tab"` and `MENU_CLOSE_WINDOW_ID: &str = "close-window"` in `src-tauri/src/app/mod.rs`
  - `build_app_menu<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<tauri::menu::Menu<R>>` (attached in `run()` via `.menu(build_app_menu)` and `.on_menu_event(...)`)
- Produces (TypeScript):
  - `CLOSE_ACTIVE_TAB_EVENT = "kubix://close-active-tab"` in `src/lib/ipc/events.ts` (`EventPayloads[CLOSE_ACTIVE_TAB_EVENT]: null`)
  - `onCloseActiveTab(handler: () => void): Promise<UnlistenFn>` in `src/lib/ipc/client.ts`

- [ ] **Step 1: Register `CLOSE_ACTIVE_TAB` event in Rust & update capability file**

- In `src-tauri/src/ipc/events.rs`: add `pub const CLOSE_ACTIVE_TAB: &str = "kubix://close-active-tab";` and add `EventSpec { name: CLOSE_ACTIVE_TAB, payload: "null" }` to `EVENTS`.
- In `src-tauri/capabilities/default.json`: add `"core:window:allow-close"` to `permissions`.

- [ ] **Step 2: Run `pnpm ipc:check` to confirm contract drift is detected before regenerating**

Run: `pnpm ipc:check`
Expected: FAIL reporting `src/lib/ipc/schema/contract.json` is stale.

- [ ] **Step 3: Regenerate `contract.json` and mirror event in TypeScript**

- Run: `pnpm ipc:schema`
- In `src/lib/ipc/events.ts`: export `CLOSE_ACTIVE_TAB_EVENT = "kubix://close-active-tab"` and add `[CLOSE_ACTIVE_TAB_EVENT]: null` to `EventPayloads`.
- In `src/lib/ipc/client.ts`: import `CLOSE_ACTIVE_TAB_EVENT` and export `onCloseActiveTab(handler: () => void): Promise<UnlistenFn>` delegating to `transport.listen(CLOSE_ACTIVE_TAB_EVENT, () => handler())`.

- [ ] **Step 4: Wire native desktop menu (`CmdOrCtrl+W` → `close-tab`, `CmdOrCtrl+Shift+W` → `close_window`) in `src-tauri/src/app/mod.rs`**

In `src-tauri/src/app/mod.rs`:
- Import `crate::ipc::events::CLOSE_ACTIVE_TAB` and `tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu}`.
- Implement `build_app_menu<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<Menu<R>>`:
  - Include standard macOS App submenu (`#[cfg(target_os = "macos")]` with about/services/hide/quit), **File** submenu with `MenuItem::with_id(app, MENU_CLOSE_TAB_ID, "Close Tab", true, Some("CmdOrCtrl+W"))` and `MenuItem::with_id(app, MENU_CLOSE_WINDOW_ID, "Close Window", true, Some("CmdOrCtrl+Shift+W"))` (or `PredefinedMenuItem::close_window` without `Cmd+W` conflict—using `MenuItem::with_id` with `CmdOrCtrl+Shift+W` calling `window.close()` in `on_menu_event` avoids AppKit re-binding `Cmd+W` to `PredefinedMenuItem::close_window`), plus standard **Edit** (Undo, Redo, Cut, Copy, Paste, Select All), **View** (Fullscreen), and **Window** (Minimize, Maximize) submenus so native copy/paste/select-all in WebKit continue working identically.
- In `run()`, attach `.menu(build_app_menu)` and `.on_menu_event(|app, event| { ... })`:
  - `MENU_CLOSE_TAB_ID` → `let _ = app.emit(CLOSE_ACTIVE_TAB, ());`
  - `MENU_CLOSE_WINDOW_ID` → if let `Some(window) = app.get_webview_window("main")`, `let _ = window.close();`.

- [ ] **Step 5: Run Rust checks, tests, and IPC drift check**

Run: `pnpm build && pnpm rust:fmt && pnpm rust:clippy && pnpm rust:test && pnpm ipc:check`
Expected: All pass (including `readonly.rs`, `ipc_contract.rs`, `tauri_capabilities_stay_minimal`, and `check-ipc-drift.mjs`).

---

### Task 4: `ClusterShell`, `App.tsx`, and `SettingsModal` Multi-Tab Integration

**Files:**
- Modify: `src/routes/cluster-shell.tsx`
- Modify: `src/App.tsx`
- Modify: `src/components/ide/settings-modal.tsx`
- Test: `tests/frontend/ide-ui.test.tsx`

**Interfaces:**
- Consumes:
  - All helpers from `src/components/ide/workspace-tabs-state.ts` (Task 1).
  - Updated `WorkspaceTabs` props (`onCloseOtherTabs`, `onCloseTabsToRight`) from `src/components/ide/workspace-tabs.tsx` (Task 2).
  - `onCloseActiveTab` from `src/lib/ipc/client.ts` (Task 3).
- Produces:
  - `ClusterNavControls` in `src/routes/cluster-shell.tsx` extended with `closeActiveTab: () => void` so `App.tsx` can forward `kubix://close-active-tab` to `ClusterShell`.
  - `App(props?: { onCloseWindow?: () => void })` in `src/App.tsx` so tests can assert `ClusterPicker` `Cmd+W` window-close delegation without mocking Tauri internals.

- [ ] **Step 1: Write failing integration tests in `tests/frontend/ide-ui.test.tsx`**

1. Update legacy single-tab assertions:
   - Lines ~1094–1106 (test clicking `Deployments`, `Visualizer`, `Security`, `Helm`): assert tabs accumulate (`Cluster Overview` + `Deployment` → 2, + `Topology` → 3, + `Security` → 4, + `Helm Releases` → 5) and clicking an already-open sidebar item focuses its existing tab without increasing the count.
   - Line ~1211 (namespace persistence test clicking `Pods`, `Nodes`, `Deployments`): assert 4 tabs (`Cluster Overview`, `Pod`, `Node`, `Deployment`) while namespace filter still persists as `""`.
2. Add focused multi-tab integration tests covering:
   - **Per-tab UI state preservation:** Open `Pods`, enter a `row-filter` value (e.g. `"api"`) and open a row in the floating drawer; switch to `Deployments` tab (verify `row-filter` is empty and drawer is closed); switch back to `Pods` tab (verify `row-filter` is still `"api"` and the Pod drawer is still open).
   - **Watch stop on background tab:** Open `Pods` (triggers `list_resources` for `/v1/pods`), switch to `Events` tab, assert `stop_watch` was called for `/v1/pods`; switch back to `Pods` tab and verify cached rows render immediately.
   - **Full-tab resource detail deduplication & subtab update:** Open a Pod in a full tab at `overview`, then re-open the same Pod to `logs` — assert only one detail tab exists for that Pod and its active inner tab switches to `logs`.
   - **Closing tabs & Back/Forward history pruning:** Open `Pods`, `Deployments`, `Events`; close `Deployments` (verify `Events` stays active); press Back (`⌘[`) and verify it navigates to `Pods` (skipping closed `Deployments`); test **Close Others** and **Close to the Right** via right-click context menu.
   - **`Cmd/Ctrl+W`, `Cmd/Ctrl+1..9`, `Ctrl+Tab`, and input/dialog suppression:**
     - `Meta+1` / `Meta+2` / `Meta+9` and `Ctrl+Tab` / `Ctrl+Shift+Tab` switch tabs.
     - Shortcuts do nothing while typing inside `row-filter` input or when `SettingsModal` (`role="dialog"`) is open.
     - `kubix://close-active-tab` closes active tab; when only one non-overview tab remains, resets to `Cluster Overview`; when only `Cluster Overview` remains, stays on `Cluster Overview`; when on `ClusterPicker`, invokes window close helper.
   - **Cluster switch resets tabs:** Switching to another cluster resets the tab strip to `[Cluster Overview]`.

- [ ] **Step 2: Run integration tests to verify they fail**

Run: `pnpm test tests/frontend/ide-ui.test.tsx`
Expected: FAIL on the updated and newly added multi-tab assertions.

- [ ] **Step 3: Refactor `src/routes/cluster-shell.tsx` to use multi-tab state & active-tab watch gating**

- Extend `ClusterNavControls` with `closeActiveTab: () => void`.
- Replace top-level `rowFilter`, `podStatusFilter`, `selectedName`, `selectedUid`, `selectedNamespace`, `checkedUids` state with `tabStateById: Record<string, ListTabState>` read/written via helper `updateActiveListState(updater)` keyed by `activeTab.id` (falling back to `EMPTY_LIST_TAB_STATE`).
- Reset `tabs`, `activeTabId`, `tabStateById`, `navHistory`, `compareOpen`, and `diffPair` when `contextId` changes.
- Replace all `setTabs([nextTab])` and `[base, nextDetailTab]` calls with `openOrFocusTab` (in prop-sync `useEffect`, `openSpecialTab`, `openResourceFullTab`, `restoreHistoryEntry`).
- Implement `handleSelectTab` with `skipSyncEffectRef.current = true` whenever updating `specialView` / `activeGvr`, handling **all** tab kinds (`resource-list`, `resource-detail`, `overview`, `topology`, `events`, `security`, `helm`, `port-forwards`), and pushing the tab's `NavHistoryEntry`.
- Implement `handleCloseTab`, `handleCloseOtherTabs`, `handleCloseTabsToRight`, and `closeActiveTab` using `closeTabById`, `closeOtherTabsById`, `closeTabsToRightById`, `closeActiveTabOrReset`, `pruneTabStateMap`, and `pruneNavHistoryForRemainingTabs`, syncing `specialView` and `activeGvr` to the resulting active tab.
- Gate `useResourceListQuery` and `useStopWatchOnUnmount` on `activeListGvr = activeTab.kind === "resource-list" ? (activeTab.gvr ?? null) : null` and `context?.state === "ready" || context?.state === "degraded"`. Only show `stale-banner` when `activeTab.kind === "resource-list"`.
- Clear `selectedName`, `selectedUid`, `selectedNamespace`, and `checkedUids` for the active list tab (plus `compareOpen`) when `activeNamespaceFilter` changes, while preserving `rowFilter` and `podStatusFilter`.
- Register `keydown` handler in `ClusterShell` for `Cmd/Ctrl+1..9`, `Ctrl+Tab` / `Ctrl+Shift+Tab`, and `Cmd/Ctrl+W` fallback (ignoring events when target is editable or `[role="dialog"]` is in the DOM).
- Pass `onCloseOtherTabs={handleCloseOtherTabs}` and `onCloseTabsToRight={handleCloseTabsToRight}` to `<WorkspaceTabs />`.

- [ ] **Step 4: Wire `onCloseActiveTab` in `src/App.tsx` and update `src/components/ide/settings-modal.tsx`**

- In `src/App.tsx`:
  - Accept optional `{ onCloseWindow?: () => void }` prop on `App` (defaulting to dynamically importing `@tauri-apps/api/window` and calling `getCurrentWindow().close()` only when `getIpcTransport() === tauriTransport`, caught cleanly if unavailable).
  - Subscribe to `onCloseActiveTab` in a `useEffect`:
    - If `selectedIdRef.current !== null`: call `clusterNavRef.current?.closeActiveTab()`.
    - Else (on `ClusterPicker`): invoke `onCloseWindow` / default Tauri window close.
- In `src/components/ide/settings-modal.tsx`:
  - Add to `SHORTCUTS`:
    - `{ keys: ["⌘", "W"], description: "Close active workspace tab" }`
    - `{ keys: ["⌘", "1–9"], description: "Switch to workspace tab by position" }`
    - `{ keys: ["⌃", "Tab"], description: "Cycle to next or previous workspace tab" }`

- [ ] **Step 5: Run full verification suite**

Run: `pnpm build && pnpm verify`
Expected: All 6 checks pass with zero warnings or errors (`rust:fmt`, `rust:clippy`, `rust:test`, `typecheck`, `test`, `ipc:check`).
