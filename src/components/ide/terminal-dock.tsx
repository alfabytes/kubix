import "@xterm/xterm/css/xterm.css";

import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import { ChevronDown, ChevronUp, RotateCw, Terminal, X } from "lucide-react";
import { useEffect, useRef } from "react";

import { ipc } from "@/lib/ipc/client";
import { useTerminalStore, type TerminalTab } from "@/stores/terminal-store";

interface XTermInstanceProps {
  tab: TerminalTab;
  active: boolean;
  theme: "dark" | "light";
}

function XTermInstance({ tab, active, theme }: XTermInstanceProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const activeRef = useRef(active);
  activeRef.current = active;
  const subscribeSession = useTerminalStore((s) => s.subscribeSession);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let term: XTerm;
    let fit: FitAddon;
    try {
      term = new XTerm({
        cursorBlink: true,
        fontFamily:
          'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
        fontSize: 12,
        lineHeight: 1.35,
        scrollback: 5000,
        theme:
          theme === "dark"
            ? {
                background: "#090b10",
                foreground: "#e2e8f0",
                cursor: "#38bdf8",
                selectionBackground: "rgba(56, 189, 248, 0.25)",
              }
            : {
                background: "#ffffff",
                foreground: "#0f172a",
                cursor: "#0284c7",
                selectionBackground: "rgba(2, 132, 199, 0.2)",
              },
      });
      fit = new FitAddon();
      term.loadAddon(fit);
      term.open(el);
      termRef.current = term;
      fitRef.current = fit;
    } catch {
      // jsdom test environment lacks canvas context; store-backed terminal metadata still mounts cleanly.
      return;
    }

    const safeFit = () => {
      try {
        fit.fit();
      } catch {
        // Ignore transient resize errors when collapsed or before first paint
      }
    };

    safeFit();
    const rafId = requestAnimationFrame(() => {
      safeFit();
      if (activeRef.current) term.focus();
    });

    const dataDisposable = term.onData((data) => {
      const current = tabRef.current;
      if (current.sessionId && current.status === "connected") {
        void ipc.sendShellInput(current.sessionId, data).catch(() => undefined);
      }
    });

    const resizeDisposable = term.onResize(({ cols, rows }) => {
      const current = tabRef.current;
      if (current.sessionId && current.status === "connected") {
        void ipc.resizeShell(current.sessionId, cols, rows).catch(() => undefined);
      }
    });

    const observer = new ResizeObserver(() => {
      safeFit();
    });
    observer.observe(el);

    return () => {
      cancelAnimationFrame(rafId);
      observer.disconnect();
      dataDisposable.dispose();
      resizeDisposable.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [tab.tabId]);

  useEffect(() => {
    if (!termRef.current) return;
    termRef.current.options.theme =
      theme === "dark"
        ? {
            background: "#090b10",
            foreground: "#e2e8f0",
            cursor: "#38bdf8",
            selectionBackground: "rgba(56, 189, 248, 0.25)",
          }
        : {
            background: "#ffffff",
            foreground: "#0f172a",
            cursor: "#0284c7",
            selectionBackground: "rgba(2, 132, 199, 0.2)",
          };
  }, [theme]);

  useEffect(() => {
    if (!tab.sessionId) return;
    const sid = tab.sessionId;
    termRef.current?.reset();
    const unsub = subscribeSession(sid, (chunk) => {
      termRef.current?.write(chunk);
    });
    const rafId = requestAnimationFrame(() => {
      if (fitRef.current && termRef.current) {
        try {
          fitRef.current.fit();
          void ipc
            .resizeShell(sid, termRef.current.cols, termRef.current.rows)
            .catch(() => undefined);
          if (activeRef.current) termRef.current.focus();
        } catch {
          // Ignore fit error
        }
      }
    });
    return () => {
      cancelAnimationFrame(rafId);
      unsub();
    };
  }, [tab.sessionId, subscribeSession]);

  useEffect(() => {
    if (active && fitRef.current && termRef.current) {
      const rafId = requestAnimationFrame(() => {
        try {
          fitRef.current?.fit();
          termRef.current?.focus();
        } catch {
          // Ignore
        }
      });
      return () => cancelAnimationFrame(rafId);
    }
  }, [active]);

  return (
    <div
      data-testid={`xterm-container-${tab.tabId}`}
      onMouseDown={() => termRef.current?.focus()}
      className={active ? "relative h-full w-full p-1.5" : "hidden"}
    >
      {tab.status === "connecting" ? (
        <div className="pointer-events-none absolute top-2 right-3 z-10 rounded border border-border bg-panel/90 px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
          Connecting to {tab.namespace}/{tab.podName} ({tab.container})...
        </div>
      ) : null}
      {tab.status === "error" ? (
        <div className="p-3 font-mono text-xs text-destructive">
          Failed to open container shell: {tab.error}
        </div>
      ) : null}
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
}

export function TerminalDock({
  contextId,
  theme,
}: {
  contextId: string;
  theme: "dark" | "light";
}) {
  const allTabs = useTerminalStore((s) => s.tabs);
  const activeTabId = useTerminalStore((s) => s.activeTabId);
  const minimized = useTerminalStore((s) => s.minimized);
  const heightPx = useTerminalStore((s) => s.heightPx);
  const selectTab = useTerminalStore((s) => s.selectTab);
  const closeTab = useTerminalStore((s) => s.closeTab);
  const openShell = useTerminalStore((s) => s.openShell);
  const setMinimized = useTerminalStore((s) => s.setMinimized);
  const setHeightPx = useTerminalStore((s) => s.setHeightPx);

  const tabs = allTabs.filter((t) => t.contextId === contextId);
  if (tabs.length === 0) return null;

  const activeTab = tabs.find((t) => t.tabId === activeTabId) ?? tabs[tabs.length - 1]!;

  return (
    <section
      data-testid="terminal-dock"
      aria-label="Container shell terminal"
      className="flex shrink-0 flex-col border-t border-border-strong bg-panel select-none"
      style={{ height: minimized ? 32 : heightPx }}
    >
      {/* Top Drag Handle (when expanded) */}
      {!minimized ? (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize terminal dock"
          className="h-1 cursor-row-resize bg-transparent transition-colors hover:bg-primary/50"
          onPointerDown={(event) => {
            event.preventDefault();
            const startY = event.clientY;
            const startHeight = heightPx;
            const onMove = (ev: PointerEvent) => {
              setHeightPx(startHeight + (startY - ev.clientY));
            };
            const onEnd = () => {
              window.removeEventListener("pointermove", onMove);
              window.removeEventListener("pointerup", onEnd);
            };
            window.addEventListener("pointermove", onMove);
            window.addEventListener("pointerup", onEnd, { once: true });
          }}
        />
      ) : null}

      {/* Dock Tab Bar */}
      <div className="flex h-8 shrink-0 items-center justify-between gap-2 border-b border-border bg-rail px-2">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          <span className="mr-1 inline-flex items-center gap-1 rounded border border-primary/35 bg-primary/10 px-1.5 py-0.5 font-mono text-[9.5px] font-semibold uppercase tracking-wide text-primary">
            <Terminal size={10} aria-hidden="true" />
            Shell
          </span>

          {tabs.map((tab) => {
            const isActive = tab.tabId === activeTab.tabId;
            return (
              <div
                key={tab.tabId}
                data-testid="terminal-tab"
                className={`group flex shrink-0 items-center gap-1.5 rounded-sm border px-2 py-0.5 text-[11px] transition-colors ${
                  isActive
                    ? "border-primary/50 bg-panel font-medium text-foreground"
                    : "border-transparent text-muted-foreground hover:bg-hover hover:text-foreground"
                }`}
              >
                <button
                  type="button"
                  onClick={() => selectTab(tab.tabId)}
                  className="flex items-center gap-1.5"
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      tab.status === "connected"
                        ? "bg-success"
                        : tab.status === "connecting"
                          ? "animate-pulse bg-primary"
                          : tab.status === "error"
                            ? "bg-destructive"
                            : "bg-muted-foreground"
                    }`}
                  />
                  <span className="max-w-[14rem] truncate font-mono">
                    {tab.podName}
                    <span className="text-muted-foreground">/{tab.container}</span>
                  </span>
                </button>

                {tab.status === "closed" || tab.status === "error" ? (
                  <button
                    type="button"
                    aria-label={`Reconnect ${tab.podName}`}
                    title="Reconnect shell"
                    onClick={() => {
                      closeTab(tab.tabId);
                      void openShell({
                        contextId: tab.contextId,
                        namespace: tab.namespace,
                        podName: tab.podName,
                        container: tab.container,
                      });
                    }}
                    className="rounded p-0.5 text-muted-foreground hover:bg-hover hover:text-primary"
                  >
                    <RotateCw size={10} />
                  </button>
                ) : null}

                <button
                  type="button"
                  aria-label={`Close shell ${tab.podName}`}
                  onClick={() => closeTab(tab.tabId)}
                  className="rounded p-0.5 text-muted-foreground hover:bg-hover hover:text-foreground"
                >
                  <X size={11} />
                </button>
              </div>
            );
          })}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            aria-label={minimized ? "Expand terminal" : "Minimize terminal"}
            title={minimized ? "Expand terminal" : "Minimize terminal"}
            onClick={() => setMinimized(!minimized)}
            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-hover hover:text-foreground"
          >
            {minimized ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          </button>
        </div>
      </div>

      {/* Terminal Viewports (kept mounted when minimized so xterm state survives toggle) */}
      <div
        className={
          minimized
            ? "hidden"
            : `min-h-0 flex-1 overflow-hidden ${theme === "dark" ? "bg-[#090b10]" : "bg-white"}`
        }
      >
        {tabs.map((tab) => (
          <XTermInstance
            key={tab.tabId}
            tab={tab}
            active={tab.tabId === activeTab.tabId}
            theme={theme}
          />
        ))}
      </div>
    </section>
  );
}
