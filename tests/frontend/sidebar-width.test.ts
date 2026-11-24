import { describe, expect, it } from "vitest";

import {
  clampInspectorWidthPct,
  clampSidebarWidth,
  INSPECTOR_DEFAULT_WIDTH_PCT,
  INSPECTOR_MAX_WIDTH_PCT,
  INSPECTOR_MIN_WIDTH_PCT,
  INSPECTOR_WIDTH_STORAGE_KEY,
  loadInspectorWidthPct,
  loadSidebarWidth,
  saveInspectorWidthPct,
  saveSidebarWidth,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_WIDTH_STORAGE_KEY,
} from "@/components/ide/sidebar-width";

function createMemoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    dump: () => Object.fromEntries(map.entries()),
  };
}

describe("sidebar-width helpers", () => {
  it("clamps sidebar width within [180, 420] and handles NaN/fractional values", () => {
    expect(SIDEBAR_DEFAULT_WIDTH).toBe(224);
    expect(SIDEBAR_MIN_WIDTH).toBe(180);
    expect(SIDEBAR_MAX_WIDTH).toBe(420);

    expect(clampSidebarWidth(Number.NaN)).toBe(224);
    expect(clampSidebarWidth(Number.POSITIVE_INFINITY)).toBe(224);
    expect(clampSidebarWidth(120)).toBe(180);
    expect(clampSidebarWidth(600)).toBe(420);
    expect(clampSidebarWidth(267.6)).toBe(268);
  });

  it("caps sidebar width dynamically on narrow viewports while never dropping below min", () => {
    // 650 - 376 reserve = 274 max
    expect(clampSidebarWidth(420, 650)).toBe(274);
    // 480 - 376 reserve = 104 -> floored at min 180
    expect(clampSidebarWidth(300, 480)).toBe(180);
    // Wide desktop viewport allows full 420
    expect(clampSidebarWidth(420, 1440)).toBe(420);
  });

  it("loads and saves sidebar width safely across corrupt or throwing storage", () => {
    const empty = createMemoryStorage();
    expect(loadSidebarWidth(empty)).toBe(224);

    const corrupt = createMemoryStorage({ [SIDEBAR_WIDTH_STORAGE_KEY]: "not-a-number" });
    expect(loadSidebarWidth(corrupt)).toBe(224);

    const outOfRange = createMemoryStorage({ [SIDEBAR_WIDTH_STORAGE_KEY]: "999" });
    expect(loadSidebarWidth(outOfRange, 1440)).toBe(420);
    expect(loadSidebarWidth(outOfRange, 650)).toBe(274);

    const throwingStorage = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(loadSidebarWidth(throwingStorage)).toBe(224);
    expect(() => saveSidebarWidth(310, throwingStorage)).not.toThrow();

    saveSidebarWidth(312.4, empty);
    expect(empty.dump()[SIDEBAR_WIDTH_STORAGE_KEY]).toBe("312");
    expect(loadSidebarWidth(empty, 1440)).toBe(312);
  });

  it("clamps, loads, and saves inspector drawer width percentage safely", () => {
    expect(INSPECTOR_DEFAULT_WIDTH_PCT).toBe(42);
    expect(INSPECTOR_MIN_WIDTH_PCT).toBe(25);
    expect(INSPECTOR_MAX_WIDTH_PCT).toBe(80);

    expect(clampInspectorWidthPct(Number.NaN)).toBe(42);
    expect(clampInspectorWidthPct(10)).toBe(25);
    expect(clampInspectorWidthPct(95)).toBe(80);
    expect(clampInspectorWidthPct(54.6)).toBe(55);

    const store = createMemoryStorage({ [INSPECTOR_WIDTH_STORAGE_KEY]: "abc" });
    expect(loadInspectorWidthPct(store)).toBe(42);

    saveInspectorWidthPct(58.2, store);
    expect(store.dump()[INSPECTOR_WIDTH_STORAGE_KEY]).toBe("58");
    expect(loadInspectorWidthPct(store)).toBe(58);

    const throwingStorage = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(loadInspectorWidthPct(throwingStorage)).toBe(42);
    expect(() => saveInspectorWidthPct(60, throwingStorage)).not.toThrow();
  });
});
