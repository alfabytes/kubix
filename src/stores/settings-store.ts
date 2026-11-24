import { create } from "zustand";

export type LogTailOption = 100 | 250 | 1000 | 0;
export type LogFontSizeOption = 11 | 12 | 13;
export type YamlFontSizeOption = 11 | 12 | 13 | 14;

export interface KubixSettings {
  defaultLogTailLines: LogTailOption;
  logFontSize: LogFontSizeOption;
  yamlFontSize: YamlFontSizeOption;
  showLogTimestamps: boolean;
  wrapLogLines: boolean;
  cleanYamlByDefault: boolean;
  eventsAutoRefresh: boolean;
}

export const DEFAULT_SETTINGS: KubixSettings = {
  defaultLogTailLines: 250,
  logFontSize: 11,
  yamlFontSize: 12,
  showLogTimestamps: true,
  wrapLogLines: false,
  cleanYamlByDefault: false,
  eventsAutoRefresh: true,
};

const STORAGE_KEY = "kubix:settings:v1";

function loadSettings(): KubixSettings {
  if (typeof window === "undefined") return { ...DEFAULT_SETTINGS };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<KubixSettings>;
    return {
      defaultLogTailLines:
        parsed.defaultLogTailLines === 100 ||
        parsed.defaultLogTailLines === 250 ||
        parsed.defaultLogTailLines === 1000 ||
        parsed.defaultLogTailLines === 0
          ? parsed.defaultLogTailLines
          : DEFAULT_SETTINGS.defaultLogTailLines,
      logFontSize:
        parsed.logFontSize === 11 || parsed.logFontSize === 12 || parsed.logFontSize === 13
          ? parsed.logFontSize
          : DEFAULT_SETTINGS.logFontSize,
      yamlFontSize:
        parsed.yamlFontSize === 11 ||
        parsed.yamlFontSize === 12 ||
        parsed.yamlFontSize === 13 ||
        parsed.yamlFontSize === 14
          ? parsed.yamlFontSize
          : DEFAULT_SETTINGS.yamlFontSize,
      showLogTimestamps:
        typeof parsed.showLogTimestamps === "boolean"
          ? parsed.showLogTimestamps
          : DEFAULT_SETTINGS.showLogTimestamps,
      wrapLogLines:
        typeof parsed.wrapLogLines === "boolean"
          ? parsed.wrapLogLines
          : DEFAULT_SETTINGS.wrapLogLines,
      cleanYamlByDefault:
        typeof parsed.cleanYamlByDefault === "boolean"
          ? parsed.cleanYamlByDefault
          : DEFAULT_SETTINGS.cleanYamlByDefault,
      eventsAutoRefresh:
        typeof parsed.eventsAutoRefresh === "boolean"
          ? parsed.eventsAutoRefresh
          : DEFAULT_SETTINGS.eventsAutoRefresh,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(next: KubixSettings): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Ignore storage quota / private mode failures cleanly
  }
}

export interface SettingsStoreState extends KubixSettings {
  update: (patch: Partial<KubixSettings>) => void;
  reset: () => void;
}

const initial = loadSettings();

export const useSettingsStore = create<SettingsStoreState>((set) => ({
  ...initial,

  update: (patch) =>
    set((state) => {
      const next: KubixSettings = {
        defaultLogTailLines: patch.defaultLogTailLines ?? state.defaultLogTailLines,
        logFontSize: patch.logFontSize ?? state.logFontSize,
        yamlFontSize: patch.yamlFontSize ?? state.yamlFontSize,
        showLogTimestamps: patch.showLogTimestamps ?? state.showLogTimestamps,
        wrapLogLines: patch.wrapLogLines ?? state.wrapLogLines,
        cleanYamlByDefault: patch.cleanYamlByDefault ?? state.cleanYamlByDefault,
        eventsAutoRefresh: patch.eventsAutoRefresh ?? state.eventsAutoRefresh,
      };
      saveSettings(next);
      return next;
    }),

  reset: () => {
    saveSettings({ ...DEFAULT_SETTINGS });
    set({ ...DEFAULT_SETTINGS });
  },
}));
