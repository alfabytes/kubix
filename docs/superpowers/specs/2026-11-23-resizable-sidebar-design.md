# Resizable Resource Navigation Sidebar — Design

**Date:** 2026-11-23  
**Status:** Approved

## Intent & Why

The left resource navigation sidebar (`NavigationSidebar`) is currently fixed at `224px` (`w-56`). On clusters with longer names (`ta-cluster-eb...`) or longer Kubernetes resource kinds (`HorizontalPodAutoscaler`, operator CRDs), labels truncate with no way to widen the sidebar—or narrow it when the user wants more horizontal space for resource tables.

## Goals

- Drag-resize the right edge of `NavigationSidebar` smoothly on desktop (`md+` viewports).
- Default width `224px`, clamped between `180px` (min) and `420px` (max), and capped dynamically so the main workspace keeps at least `320px` beside the `56px` icon rail on narrow windows.
- Persist the chosen width in `localStorage` (`kubix:sidebar-width:v1`) across restarts.
- Support double-click on the handle to reset to `224px`, and keyboard resizing (`ArrowLeft` / `ArrowRight` / `Home` / `End`) on an accessible `role="separator"`.
- Handle pointer release reliably in macOS WKWebView (`window` `pointermove` / `pointerup` / `pointercancel` / `blur` + primary-button guard).

## Non-Goals & Anti-Goals

- **Non-goal:** Collapsing the sidebar to `0px` when dragged past the minimum.
- **Non-goal:** Resizing the mobile (`< md`) slide-over drawer (keeps fixed `224px` width, handle hidden).
- **Anti-goal:** Adding a third-party split-pane dependency or adding a thick visual gap between the sidebar and workspace tabs.

## Constraints

- Frontend-only change; no Rust backend or IPC contract changes.
- Zero new npm dependencies.
- Keep existing `data-testid="cluster-sidebar"` and all existing `NavigationSidebar` / `AppShell` behavior intact.

## Approaches Considered

1. **Native pointer-event edge handle inside `NavigationSidebar` (Chosen):** Uses the same zero-dependency window-level pointer pattern as `ClusterShell`'s inspector splitter, with a subtle 6px hit area overlaid on the existing 1px right border (`md+` only) and CSS custom property `--sidebar-width` so mobile drawer width stays untouched.
2. **Third-party split-pane library (e.g., `react-resizable-panels`):** Unnecessary bundle/dependency overhead for a single divider.
3. **Preset width toggle buttons (compact/normal/wide):** Simpler, but doesn't let the user dial in an exact width for their cluster and CRD names.

## Architecture Summary

- `src/components/ide/sidebar-width.ts`: pure clamping and `localStorage` load/save helpers (`SIDEBAR_DEFAULT_WIDTH = 224`, `SIDEBAR_MIN_WIDTH = 180`, `SIDEBAR_MAX_WIDTH = 420`, `SIDEBAR_WIDTH_STORAGE_KEY = "kubix:sidebar-width:v1"`).
- `src/components/ide/navigation-sidebar.tsx`: manages sidebar width state (hydrated from storage, re-clamped on window resize), renders the `<aside>` using `--sidebar-width` at `md+`, and renders the accessible `role="separator"` right-edge resize handle with drag, double-click reset, and keyboard resizing.
