export const SIDEBAR_DEFAULT_WIDTH = 224;
export const SIDEBAR_MIN_WIDTH = 180;
export const SIDEBAR_MAX_WIDTH = 420;
/** Reserve 56px icon rail + 320px main workspace on narrower windows. */
export const SIDEBAR_MIN_MAIN_RESERVE = 376;
export const SIDEBAR_WIDTH_STORAGE_KEY = "kubix:sidebar-width:v1";

export const INSPECTOR_DEFAULT_WIDTH_PCT = 42;
export const INSPECTOR_MIN_WIDTH_PCT = 25;
export const INSPECTOR_MAX_WIDTH_PCT = 80;
export const INSPECTOR_WIDTH_STORAGE_KEY = "kubix:inspector-width:v1";

function defaultStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function clampSidebarWidth(width: number, viewportWidth?: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT_WIDTH;
  const maxAllowed =
    typeof viewportWidth === "number" && Number.isFinite(viewportWidth) && viewportWidth > 0
      ? Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, viewportWidth - SIDEBAR_MIN_MAIN_RESERVE))
      : SIDEBAR_MAX_WIDTH;
  return Math.round(Math.max(SIDEBAR_MIN_WIDTH, Math.min(maxAllowed, width)));
}

export function loadSidebarWidth(
  storage: Pick<Storage, "getItem"> | null | undefined = undefined,
  viewportWidth?: number,
): number {
  const target = storage === undefined ? defaultStorage() : storage;
  if (!target) return clampSidebarWidth(SIDEBAR_DEFAULT_WIDTH, viewportWidth);
  try {
    const raw = target.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    if (!raw) return clampSidebarWidth(SIDEBAR_DEFAULT_WIDTH, viewportWidth);
    const parsed = Number(raw);
    return clampSidebarWidth(parsed, viewportWidth);
  } catch {
    return clampSidebarWidth(SIDEBAR_DEFAULT_WIDTH, viewportWidth);
  }
}

export function saveSidebarWidth(
  width: number,
  storage: Pick<Storage, "setItem"> | null | undefined = undefined,
): void {
  const target = storage === undefined ? defaultStorage() : storage;
  if (!target) return;
  try {
    target.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(clampSidebarWidth(width)));
  } catch {
    // Ignore storage quota / private mode failures cleanly
  }
}

export function clampInspectorWidthPct(pct: number): number {
  if (!Number.isFinite(pct)) return INSPECTOR_DEFAULT_WIDTH_PCT;
  return Math.round(Math.max(INSPECTOR_MIN_WIDTH_PCT, Math.min(INSPECTOR_MAX_WIDTH_PCT, pct)));
}

export function loadInspectorWidthPct(
  storage: Pick<Storage, "getItem"> | null | undefined = undefined,
): number {
  const target = storage === undefined ? defaultStorage() : storage;
  if (!target) return INSPECTOR_DEFAULT_WIDTH_PCT;
  try {
    const raw = target.getItem(INSPECTOR_WIDTH_STORAGE_KEY);
    if (!raw) return INSPECTOR_DEFAULT_WIDTH_PCT;
    const parsed = Number(raw);
    return clampInspectorWidthPct(parsed);
  } catch {
    return INSPECTOR_DEFAULT_WIDTH_PCT;
  }
}

export function saveInspectorWidthPct(
  pct: number,
  storage: Pick<Storage, "setItem"> | null | undefined = undefined,
): void {
  const target = storage === undefined ? defaultStorage() : storage;
  if (!target) return;
  try {
    target.setItem(INSPECTOR_WIDTH_STORAGE_KEY, String(clampInspectorWidthPct(pct)));
  } catch {
    // Ignore storage quota / private mode failures cleanly
  }
}
