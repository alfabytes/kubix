# Resizable Resource Navigation Sidebar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the desktop left resource navigation sidebar (`NavigationSidebar`) smoothly drag-resizable between `180px` and `420px`, with double-click reset, keyboard accessibility, and `localStorage` persistence.

**Architecture:** Extract pure width clamping and `localStorage` load/save logic into a small helper module (`src/components/ide/sidebar-width.ts`), then wire stateful drag/keyboard/double-click resizing and a flush right-edge `role="separator"` handle directly into `NavigationSidebar` using a CSS custom property (`--sidebar-width`) so the mobile `< md` overlay drawer remains untouched.

**Tech Stack:** React 18, TypeScript, Tailwind CSS, Vitest + React Testing Library.

**Spec:** [2026-11-23-resizable-sidebar-design.md](file:///Users/tentanganakbahagia/Documents/Mine/kubix/docs/superpowers/specs/2026-11-23-resizable-sidebar-design.md)

## Global Constraints

- Frontend-only change; no Rust or IPC contract changes.
- Zero new npm dependencies.
- Default width `224px`, minimum `180px`, maximum `420px`, dynamic cap leaving at least `376px` (`56px` icon rail + `320px` main workspace) on narrow windows.
- Persist under `localStorage` key `kubix:sidebar-width:v1`; silently fall back to default when storage is unavailable or corrupt.
- Mobile (`< md`) keeps fixed `w-56` (`224px`) drawer width and hides the resize handle.
- Preserve `data-testid="cluster-sidebar"` and existing tests.

## Review Focus

1. **Corrupt or non-numeric `localStorage` value (e.g., `"abc"`, `"-50"`, `"NaN"`):** Must fall back cleanly to `224px` or clamp to `[180, 420]` without producing `NaNpx`.
2. **Stuck drag in macOS WKWebView when `pointerup` is missed:** Receiving a mouse `pointermove` with `(e.buttons & 1) === 0` or window `blur`/`pointercancel` must end the drag, restore body cursor/selection, and persist the last valid width.
3. **Narrow window resize after widening sidebar to `420px`:** Shrinking the viewport must re-clamp the sidebar width so the main workspace never gets crushed below `320px`, while never shrinking below `180px`.
4. **Non-primary mouse click (right-click `button: 2`) on the resize handle:** Must not initiate a drag or mutate width.
5. **Storage throwing in restricted WebView / private mode:** `loadSidebarWidth` and `saveSidebarWidth` must swallow storage errors and continue working in memory.

---

### Task 1: Sidebar width clamping and persistence helpers

**Files:**
- Create: `src/components/ide/sidebar-width.ts`
- Test: `tests/frontend/sidebar-width.test.ts`

**Interfaces:**
- Consumes: browser `Storage` interface (injected optionally for deterministic tests).
- Produces:
  - `SIDEBAR_DEFAULT_WIDTH = 224`
  - `SIDEBAR_MIN_WIDTH = 180`
  - `SIDEBAR_MAX_WIDTH = 420`
  - `SIDEBAR_MIN_MAIN_RESERVE = 376`
  - `SIDEBAR_WIDTH_STORAGE_KEY = "kubix:sidebar-width:v1"`
  - `clampSidebarWidth(width: number, viewportWidth?: number): number`
  - `loadSidebarWidth(storage?: Pick<Storage, "getItem"> | null, viewportWidth?: number): number`
  - `saveSidebarWidth(width: number, storage?: Pick<Storage, "setItem"> | null): void`

- [ ] **Step 1: Write the failing unit tests**

Create `tests/frontend/sidebar-width.test.ts` asserting:
- `clampSidebarWidth` returns `224` for `NaN`/`Infinity`, clamps `< 180` to `180`, clamps `> 420` to `420`, rounds fractional pixels, and caps at `Math.max(180, viewportWidth - 376)` on narrow viewports (e.g., `viewportWidth = 650` caps `420` to `274`; `viewportWidth = 480` caps to `180`).
- `loadSidebarWidth` returns `224` when storage is empty, corrupt (`"abc"`), or throws; returns clamped saved integer when valid.
- `saveSidebarWidth` writes clamped integer string to `kubix:sidebar-width:v1` and does not throw when `setItem` throws.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/frontend/sidebar-width.test.ts`
Expected: FAIL because `src/components/ide/sidebar-width.ts` does not exist yet.

- [ ] **Step 3: Implement `src/components/ide/sidebar-width.ts`**

Export the constants and three pure helper functions matching the interface block above.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/frontend/sidebar-width.test.ts`
Expected: PASS (all cases green).

---

### Task 2: Resizable `NavigationSidebar` edge handle, keyboard & reset behavior

**Files:**
- Modify: `src/components/ide/navigation-sidebar.tsx:1-225`
- Test: `tests/frontend/ide-ui.test.tsx` (add focused resize test in `IDE workspace shell navigation` or `IDE design system components`)

**Interfaces:**
- Consumes: `SIDEBAR_DEFAULT_WIDTH`, `SIDEBAR_MIN_WIDTH`, `SIDEBAR_MAX_WIDTH`, `clampSidebarWidth`, `loadSidebarWidth`, `saveSidebarWidth` from `src/components/ide/sidebar-width.ts`.
- Produces:
  - `NavigationSidebar` renders `<aside data-testid="cluster-sidebar">` with CSS variable `--sidebar-width: ${sidebarWidth}px` and class `w-56 ... md:relative md:inset-auto md:left-auto md:z-auto md:flex md:w-[var(--sidebar-width)] md:shadow-none`.
  - Desktop-only resize handle `<div data-testid="sidebar-resize-handle" role="separator" aria-label="Resize resource navigation" aria-orientation="vertical" aria-valuemin={180} aria-valuemax={420} aria-valuenow={sidebarWidth} tabIndex={0} />` overlaid flush on the right edge (`hidden md:block`).

- [ ] **Step 1: Write the failing component tests**

Add a test in `tests/frontend/ide-ui.test.tsx` verifying:
1. `NavigationSidebar` hydrates saved width from `localStorage` (`kubix:sidebar-width:v1`), defaulting to `224px`.
2. Dragging `sidebar-resize-handle` right by `+80px` updates `--sidebar-width` to `304px`, persists `304` to `localStorage` on `window` `pointerup`, and ignores further moves after release (including when a mouse `pointermove` arrives with `buttons: 0` without `pointerup`).
3. Right-clicking (`button: 2`) the handle does not start dragging or alter width.
4. Dragging beyond bounds clamps to `[180, 420]`.
5. Double-clicking `sidebar-resize-handle` resets width to `224px` and persists `224`.
6. Pressing `ArrowRight` / `ArrowLeft` / `Home` / `End` on the focused handle adjusts width (`+16`, `-16`, `180`, `420`) and updates `aria-valuenow` and `localStorage`.
7. Shrinking `window.innerWidth` re-clamps a wide sidebar cleanly so the main pane keeps its reserve width.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/frontend/ide-ui.test.tsx -t "resizes NavigationSidebar"`
Expected: FAIL because `sidebar-resize-handle` is not rendered yet.

- [ ] **Step 3: Implement resizable sidebar handle in `src/components/ide/navigation-sidebar.tsx`**

- Hydrate `sidebarWidth` state via `loadSidebarWidth(undefined, window.innerWidth)` and keep a `widthRef` in sync for drag completion.
- Update `<aside>` classes (`md:relative md:inset-auto md:left-auto md:z-auto md:w-[var(--sidebar-width)]`) and inline CSS custom property `--sidebar-width: ${sidebarWidth}px`.
- Add the flush right-edge `sidebar-resize-handle` (`hidden md:block`) with subtle centered `2px` highlight bar on hover/focus/active drag.
- Track active drag via window-level `pointermove`, `pointerup`, `pointercancel`, and `blur` listeners; guard non-primary clicks (`typeof e.button === "number" && e.button !== 0`) and missed mouse release (`e.pointerType === "mouse" && (e.buttons & 1) === 0`); set and restore `document.body.style.cursor` and `document.body.style.userSelect`; persist via `saveSidebarWidth` on drag end.
- Handle `onDoubleClick` (reset to `SIDEBAR_DEFAULT_WIDTH` and save), `onKeyDown` (`ArrowLeft`/`ArrowRight` ±16px, `Home` min, `End` max, save), and `window` `resize` re-clamping.

- [ ] **Step 4: Run targeted test to verify it passes**

Run: `pnpm vitest run tests/frontend/ide-ui.test.tsx -t "resizes NavigationSidebar"`
Expected: PASS.

- [ ] **Step 5: Run full verification suite**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: `tsc --noEmit` exits 0, all Vitest test files pass, `vite build` succeeds cleanly.
