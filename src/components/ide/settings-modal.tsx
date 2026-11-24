import { useEffect, useState } from "react";
import { Keyboard, RotateCcw, ShieldCheck, SlidersHorizontal, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  useSettingsStore,
  type LogFontSizeOption,
  type LogTailOption,
  type YamlFontSizeOption,
} from "@/stores/settings-store";

export interface SettingsModalProps {
  theme: "dark" | "light";
  onSwitchTheme: () => void;
  onClose: () => void;
}

const SHORTCUTS: Array<{ keys: string[]; description: string }> = [
  { keys: ["⌘", "K"], description: "Open global quick search (resources & contexts)" },
  { keys: ["⌘", ","], description: "Open or close Workspace Settings" },
  { keys: ["⌘", "W"], description: "Close active workspace tab" },
  { keys: ["⌘", "1–9"], description: "Switch to workspace tab by position" },
  { keys: ["⌃", "Tab"], description: "Cycle to next or previous workspace tab" },
  { keys: ["⌘", "["], description: "Navigate back in cluster history (or Alt+←)" },
  { keys: ["⌘", "]"], description: "Navigate forward in cluster history (or Alt+→)" },
  { keys: ["Esc"], description: "Close open dialogs or search popover" },
  { keys: ["Enter"], description: "Inspect focused row in resource table" },
];

export function SettingsModal({ theme, onSwitchTheme, onClose }: SettingsModalProps) {
  const [tab, setTab] = useState<"preferences" | "shortcuts">("preferences");
  const defaultLogTailLines = useSettingsStore((s) => s.defaultLogTailLines);
  const logFontSize = useSettingsStore((s) => s.logFontSize);
  const yamlFontSize = useSettingsStore((s) => s.yamlFontSize);
  const showLogTimestamps = useSettingsStore((s) => s.showLogTimestamps);
  const wrapLogLines = useSettingsStore((s) => s.wrapLogLines);
  const cleanYamlByDefault = useSettingsStore((s) => s.cleanYamlByDefault);
  const eventsAutoRefresh = useSettingsStore((s) => s.eventsAutoRefresh);
  const update = useSettingsStore((s) => s.update);
  const reset = useSettingsStore((s) => s.reset);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Workspace settings"
      data-testid="settings-modal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/75 p-4 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-md flex-col overflow-hidden rounded-xl border border-border-strong bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border bg-elevated/50 px-4 py-3">
          <div>
            <h2 className="text-[13px] font-semibold text-foreground">Workspace Settings</h2>
            <p className="text-[11px] text-muted-foreground">
              Editor defaults, log streaming preferences &amp; keyboard shortcuts
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label="Close settings"
            onClick={onClose}
          >
            <X size={14} />
          </Button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 border-b border-border bg-elevated/30 px-4 py-2 text-[11px]">
          <button
            type="button"
            data-testid="settings-tab-preferences"
            onClick={() => setTab("preferences")}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-2.5 py-1.5 font-medium transition-colors ${
              tab === "preferences"
                ? "bg-primary/15 text-primary ring-1 ring-primary/40"
                : "text-muted-foreground hover:bg-hover hover:text-foreground"
            }`}
          >
            <SlidersHorizontal size={12} aria-hidden="true" />
            Preferences
          </button>
          <button
            type="button"
            data-testid="settings-tab-shortcuts"
            onClick={() => setTab("shortcuts")}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-2.5 py-1.5 font-medium transition-colors ${
              tab === "shortcuts"
                ? "bg-primary/15 text-primary ring-1 ring-primary/40"
                : "text-muted-foreground hover:bg-hover hover:text-foreground"
            }`}
          >
            <Keyboard size={12} aria-hidden="true" />
            Shortcuts
          </button>
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-y-auto p-4 text-[11.5px]">
          {tab === "preferences" ? (
            <div className="space-y-4">
              {/* Appearance */}
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="font-medium text-foreground">Theme</div>
                  <div className="text-[10.5px] text-muted-foreground">
                    Switch between dark obsidian and light contrast
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2.5 text-[11px]"
                  data-testid="settings-theme-toggle"
                  onClick={onSwitchTheme}
                >
                  {theme === "dark" ? "Obsidian Dark" : "Light High-Contrast"}
                </Button>
              </div>

              {/* Default Log Tail */}
              <div className="flex items-center justify-between gap-3 border-t border-border/70 pt-3">
                <div>
                  <div className="font-medium text-foreground">Default log tail</div>
                  <div className="text-[10.5px] text-muted-foreground">
                    Initial line count fetched when opening Logs
                  </div>
                </div>
                <select
                  aria-label="Default log tail"
                  data-testid="settings-log-tail"
                  value={String(defaultLogTailLines)}
                  onChange={(e) =>
                    update({ defaultLogTailLines: Number(e.target.value) as LogTailOption })
                  }
                  className="h-7 rounded border border-border bg-elevated px-2 font-mono text-[11px] text-foreground"
                >
                  <option value="100">100 lines</option>
                  <option value="250">250 lines</option>
                  <option value="1000">1000 lines</option>
                  <option value="0">All lines</option>
                </select>
              </div>

              {/* Log Font Size */}
              <div className="flex items-center justify-between gap-3 border-t border-border/70 pt-3">
                <div>
                  <div className="font-medium text-foreground">Log viewer font size</div>
                  <div className="text-[10.5px] text-muted-foreground">
                    Monospace text size in pod &amp; workload streams
                  </div>
                </div>
                <div className="flex gap-1">
                  {([11, 12, 13] as LogFontSizeOption[]).map((sz) => (
                    <button
                      key={sz}
                      type="button"
                      data-testid={`settings-log-font-${sz}`}
                      onClick={() => update({ logFontSize: sz })}
                      className={`rounded border px-2 py-0.5 font-mono text-[10.5px] transition-colors ${
                        logFontSize === sz
                          ? "border-primary bg-primary/15 font-semibold text-primary"
                          : "border-border bg-elevated text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {sz}px
                    </button>
                  ))}
                </div>
              </div>

              {/* YAML Editor Font Size */}
              <div className="flex items-center justify-between gap-3 border-t border-border/70 pt-3">
                <div>
                  <div className="font-medium text-foreground">YAML editor font size</div>
                  <div className="text-[10.5px] text-muted-foreground">
                    Applies to manifest viewer and YAML diff view
                  </div>
                </div>
                <div className="flex gap-1">
                  {([11, 12, 13, 14] as YamlFontSizeOption[]).map((sz) => (
                    <button
                      key={sz}
                      type="button"
                      data-testid={`settings-yaml-font-${sz}`}
                      onClick={() => update({ yamlFontSize: sz })}
                      className={`rounded border px-2 py-0.5 font-mono text-[10.5px] transition-colors ${
                        yamlFontSize === sz
                          ? "border-primary bg-primary/15 font-semibold text-primary"
                          : "border-border bg-elevated text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {sz}px
                    </button>
                  ))}
                </div>
              </div>

              {/* Toggles */}
              <div className="space-y-2.5 border-t border-border/70 pt-3">
                <label className="flex cursor-pointer items-center justify-between gap-3">
                  <div>
                    <div className="font-medium text-foreground">Clean YAML by default</div>
                    <div className="text-[10.5px] text-muted-foreground">
                      Hide managedFields, uid &amp; resourceVersion noise in YAML view
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    data-testid="settings-clean-yaml"
                    checked={cleanYamlByDefault}
                    onChange={(e) => update({ cleanYamlByDefault: e.target.checked })}
                    className="h-4 w-4 accent-primary"
                  />
                </label>

                <label className="flex cursor-pointer items-center justify-between gap-3">
                  <div>
                    <div className="font-medium text-foreground">Show log timestamps</div>
                    <div className="text-[10.5px] text-muted-foreground">
                      Display ISO timestamps beside each log line
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    data-testid="settings-log-timestamps"
                    checked={showLogTimestamps}
                    onChange={(e) => update({ showLogTimestamps: e.target.checked })}
                    className="h-4 w-4 accent-primary"
                  />
                </label>

                <label className="flex cursor-pointer items-center justify-between gap-3">
                  <div>
                    <div className="font-medium text-foreground">Wrap log lines</div>
                    <div className="text-[10.5px] text-muted-foreground">
                      Wrap long lines inside the viewer or scroll horizontally
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    data-testid="settings-log-wrap"
                    checked={wrapLogLines}
                    onChange={(e) => update({ wrapLogLines: e.target.checked })}
                    className="h-4 w-4 accent-primary"
                  />
                </label>

                <label className="flex cursor-pointer items-center justify-between gap-3">
                  <div>
                    <div className="font-medium text-foreground">Auto-refresh Events timeline</div>
                    <div className="text-[10.5px] text-muted-foreground">
                      Poll live cluster &amp; namespace events every 5 seconds
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    data-testid="settings-events-autorefresh"
                    checked={eventsAutoRefresh}
                    onChange={(e) => update({ eventsAutoRefresh: e.target.checked })}
                    className="h-4 w-4 accent-primary"
                  />
                </label>
              </div>

              {/* System Guard Info */}
              <div className="space-y-1.5 rounded-lg border border-border bg-elevated/40 p-2.5 text-[10.5px]">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Cluster Mode</span>
                  <span className="inline-flex items-center gap-1 font-mono text-success">
                    <ShieldCheck size={11} aria-hidden="true" /> READ-ONLY · SINGLE PROFILE
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Concurrent Watch Limit</span>
                  <span className="font-mono text-foreground">8 LRU streams</span>
                </div>
              </div>
            </div>
          ) : (
            <div className="divide-y divide-border/70" data-testid="settings-shortcuts-list">
              {SHORTCUTS.map((item) => (
                <div
                  key={item.description}
                  className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0"
                >
                  <span className="text-muted-foreground">{item.description}</span>
                  <span className="flex shrink-0 items-center gap-1">
                    {item.keys.map((k) => (
                      <kbd
                        key={k}
                        className="rounded border border-border-strong bg-elevated px-1.5 py-0.5 font-mono text-[10.5px] font-semibold text-foreground shadow-sm"
                      >
                        {k}
                      </kbd>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-border bg-elevated/40 px-4 py-2.5">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-[11px] text-muted-foreground hover:text-foreground"
            data-testid="settings-reset"
            onClick={reset}
          >
            <RotateCcw size={11} aria-hidden="true" />
            Reset defaults
          </Button>
          <Button size="sm" className="h-7 px-3 text-[11px]" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    </div>
  );
}
