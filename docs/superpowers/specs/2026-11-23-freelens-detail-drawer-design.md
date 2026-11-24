# Freelens-Style Floating Resource Detail Drawer — Design

**Date:** 2026-11-23  
**Status:** Approved

## Intent & Why

Currently, clicking a row in any resource list opens `<ResourceDetail>` as a side-by-side flex sibling inside `ClusterShell`, shrinking the table by `42%` on desktop (truncating columns like `Restarts`, `Controlled By`, and `Node`) and hiding the table completely on windows narrower than `1200px`. Making the detail panel a Freelens-style right-side floating overlay drawer keeps the table at full `100%` width underneath at all times.

## Goals

- Keep the resource list `<section>` at full `100%` width without shrinking, reflowing, or hiding when `<ResourceDetail>` is open or resized.
- Render `<ResourceDetail>` inside an `absolute inset-y-0 right-0 z-20` overlay drawer anchored to `splitRef` with a crisp left border and soft left elevation shadow.
- Provide a flush left-edge resize handle (`role="separator"`, `aria-label="Resize resource inspector"`) supporting mouse/pointer drag (with WKWebView-safe `window` `pointermove` / `pointerup` / `pointercancel` / `blur` + primary-button guard), keyboard `ArrowLeft`/`ArrowRight`, and double-click reset to `42%`.
- Persist the inspector width percentage in `localStorage` (`kubix:inspector-width:v1`), clamped to `[25, 80]` (default `42%`, `minWidth: "min(100%, 420px)"`), preserving existing `ArrowLeft` resize behavior tested in `tests/frontend/app.test.tsx`.
- Preserve Freelens interactions: clicking another row in the visible table swaps drawer content in place; clicking outside or pressing `Escape` closes the drawer; expand-to-tab still works.

## Non-Goals & Anti-Goals

- **Non-goal:** Modal backdrop dimming that blocks interacting with the visible portion of the table.
- **Non-goal:** Changing full-tab `resource-detail` view behavior.

## Constraints

- Frontend-only change; no Rust backend or IPC contract changes.
- Zero new npm dependencies.
- Keep existing `role="separator" aria-label="Resize resource inspector"`, `aria-valuenow={inspectorWidth}`, `data-testid="resource-detail"`, and `tests/frontend/app.test.tsx` passing.

## Approaches Considered

1. **Absolute right-side overlay drawer inside `splitRef` (Chosen):** Zero reflow on the table, allows clicking other rows seamlessly on the visible left side, matches Freelens/Lens ergonomics.
2. **Modal dialog:** Blocks interacting with the underlying table.
3. **Flex split pane (current):** Always squishes table columns when open.
