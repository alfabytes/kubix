# Freelens-Style Floating Resource Detail Drawer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the right-side `ResourceDetail` inspector in `ClusterShell` from a table-shrinking flex sibling into a Freelens-style floating overlay drawer with persistent, WKWebView-safe left-edge resizing.

**Architecture:** Extract pure inspector width clamping and `localStorage` persistence into `src/components/ide/sidebar-width.ts` (alongside the sidebar width helpers so panel-sizing logic lives in one cohesive module), then update `src/routes/cluster-shell.tsx` so `splitRef` is `relative`, the table `<section>` stays `flex-1` full-width unconditionally, and `<aside data-testid="resource-inspector-drawer">` floats `absolute inset-y-0 right-0 z-20` with a flush left-edge `role="separator"` handle.

**Tech Stack:** React 18, TypeScript, Tailwind CSS, Vitest + React Testing Library.

**Spec:** [2026-11-23-freelens-detail-drawer-design.md](file:///Users/tentanganakbahagia/Documents/Mine/kubix/docs/superpowers/specs/2026-11-23-freelens-detail-drawer-design.md)

## Global Constraints

- Frontend-only; zero new dependencies; no Rust or IPC contract changes.
- Default inspector width `42%`, clamped `[25, 80]` (and `0` collapse-on-drag if dragged past extreme right stays clean or snaps to min `25%` — wait: check `resizeInspector` in `cluster-shell.tsx` first to preserve existing behavior!).
- Persist under `kubix:inspector-width:v1`; silently fall back to `42` on corrupt/unavailable storage.
- Keep `role="separator" aria-label="Resize resource inspector"`, `aria-valuenow`, and `tests/frontend/app.test.tsx` green.

## Review Focus

1. **Corrupt `localStorage` width (`"abc"`, `"500"`, `"-10"`):** Must fall back to `42` or clamp into `[25, 80]`.
2. **Stuck pointer drag on inspector edge in macOS WKWebView:** Window-level `pointerup` / `pointercancel` / `blur` and mouse `(e.buttons & 1) === 0` guard must always stop dragging and restore body cursor/selection.
3. **Click-outside vs clicking resize handle or another table row:** Clicking the left-edge resize handle or another `resource-row` must NOT close the drawer; clicking empty space/toolbar/sidebar or pressing `Escape` must close it.
4. **Narrow viewport (`< 1200px`):** Table must NOT get `max-[1199px]:hidden`, and drawer must not overflow the container (`max-w-full`, `minWidth: "min(100%, 420px)"`).
5. **Double-click reset & right-click guard:** Double-clicking the handle resets width to `42%` and saves it; right-clicking (`button: 2`) does not start a drag.

---

### Task 1: Inspector width clamping & persistence helpers

**Files:**
- Modify: `src/components/ide/sidebar-width.ts`
- Test: `tests/frontend/sidebar-width.test.ts`

**Interfaces:**
- Produces:
  - `INSPECTOR_DEFAULT_WIDTH_PCT = 42`
  - `INSPECTOR_MIN_WIDTH_PCT = 25`
  - `INSPECTOR_MAX_WIDTH_PCT = 80`
  - `INSPECTOR_WIDTH_STORAGE_KEY = "kubix:inspector-width:v1"`
  - `clampInspectorWidthPct(pct: number): number`
  - `loadInspectorWidthPct(storage?: Pick<Storage, "getItem"> | null): number`
  - `saveInspectorWidthPct(pct: number, storage?: Pick<Storage, "setItem"> | null): void`

- [ ] **Step 1: Write failing unit tests for inspector width helpers**
- [ ] **Step 2: Run Vitest to confirm RED**
- [ ] **Step 3: Implement inspector width helpers in `src/components/ide/sidebar-width.ts`**
- [ ] **Step 4: Run Vitest to confirm GREEN**

---

### Task 2: Freelens-style floating overlay drawer in `ClusterShell`

**Files:**
- Modify: `src/routes/cluster-shell.tsx`
- Test: `tests/frontend/ide-ui.test.tsx`

**Interfaces:**
- Consumes: `INSPECTOR_DEFAULT_WIDTH_PCT`, `INSPECTOR_MIN_WIDTH_PCT`, `INSPECTOR_MAX_WIDTH_PCT`, `clampInspectorWidthPct`, `loadInspectorWidthPct`, `saveInspectorWidthPct` from `src/components/ide/sidebar-width.ts`.
- Produces:
  - `splitRef` container has `relative flex min-h-0 flex-1 overflow-hidden`.
  - Table `<section data-testid="resource-list-pane">` stays `min-w-0 flex-1 overflow-hidden` (no `max-[1199px]:hidden`).
  - Overlay `<aside ref={inspectorRef} data-testid="resource-inspector-drawer">` uses `absolute inset-y-0 right-0 z-20 flex max-w-full border-l border-border bg-background shadow-[-12px_0_32px_rgba(0,0,0,0.32)]` with `style={{ width: `${inspectorWidth}%`, minWidth: "min(100%, 420px)" }}`.
  - Flush left-edge `<div ref={separatorRef} role="separator" aria-label="Resize resource inspector" ... />` inside/attached to the drawer with window-level pointer drag cleanup, mouse button guard, double-click reset to `42%`, keyboard `ArrowLeft`/`ArrowRight`, and `localStorage` persistence.

- [ ] **Step 1: Write failing test verifying Freelens overlay drawer classes (table never hidden/shrunk, drawer is absolute overlay), pointer drag resize + persistence, double-click reset, right-click guard, and click-outside/row-swap behavior**
- [ ] **Step 2: Run targeted test to confirm RED**
- [ ] **Step 3: Implement floating overlay drawer & resize improvements in `src/routes/cluster-shell.tsx`**
- [ ] **Step 4: Run targeted test + `tests/frontend/app.test.tsx` to confirm GREEN**
- [ ] **Step 5: Run full verification suite (`pnpm typecheck && pnpm test && pnpm build`) and dispatch fresh reviewer check**
