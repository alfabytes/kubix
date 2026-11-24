import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Boxes,
  Command,
  Moon,
  Network,
  Search,
  Server,
  ShieldCheck,
  Sun,
} from "lucide-react";

import type { DiscoveredResourceDto } from "@/lib/ipc/types";
import type { ResourceNavigationTarget } from "@/lib/resource-telemetry";
import type { ContextRow } from "@/stores/cluster-store";
import { useExplorerStore } from "@/stores/explorer-store";

export interface GlobalCommandBarProps {
  contexts: ContextRow[];
  activeContext: ContextRow | null;
  resources: DiscoveredResourceDto[];
  theme: "dark" | "light";
  canGoBack?: boolean;
  canGoForward?: boolean;
  onBack?: () => void;
  onForward?: () => void;
  onSelectContext: (context: ContextRow) => void;
  onSelectResource: (item: DiscoveredResourceDto) => void;
  onSelectResourceInstance?: (target: ResourceNavigationTarget) => void;
  onSelectTopology?: () => void;
  onSwitchTheme: () => void;
}

export function GlobalCommandBar({
  contexts,
  activeContext,
  resources,
  theme,
  canGoBack = false,
  canGoForward = false,
  onBack,
  onForward,
  onSelectContext,
  onSelectResource,
  onSelectResourceInstance,
  onSelectTopology,
  onSwitchTheme,
}: GlobalCommandBarProps) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const views = useExplorerStore((s) => s.views);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(true);
        inputRef.current?.focus();
      } else if (e.key === "Escape") {
        setOpen(false);
        inputRef.current?.blur();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const onClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matchedContexts = contexts
      .filter((c) => !needle || c.name.toLowerCase().includes(needle))
      .slice(0, 4);
    const matchedResources = resources
      .filter(
        (r) =>
          !needle ||
          r.kind.toLowerCase().includes(needle) ||
          r.plural.toLowerCase().includes(needle) ||
          r.shortNames.some((s) => s.toLowerCase().includes(needle)),
      )
      .slice(0, 8);

    const matchedInstances: Array<ResourceNavigationTarget & { uid: string }> = [];
    if (open && activeContext && needle) {
      const prefix = `${activeContext.id}\u0000`;
      const kindByGvr = new Map(resources.map((r) => [r.gvr, r.kind]));
      const seen = new Set<string>();
      const scored: Array<{
        rank: number;
        item: ResourceNavigationTarget & { uid: string };
      }> = [];
      for (const [key, entry] of Object.entries(views)) {
        if (!key.startsWith(prefix)) continue;
        const gvr = key.split("\u0000")[1] ?? "";
        if (!gvr) continue;
        const fallbackKind = gvr.split("/").pop() ?? "Resource";
        for (const row of entry.rows) {
          const dedupeKey = row.uid || `${gvr}:${row.namespace ?? ""}:${row.name}`;
          if (seen.has(dedupeKey)) continue;
          const kind = row.kind || kindByGvr.get(gvr) || fallbackKind;
          const lowerName = row.name.toLowerCase();
          const lowerNs = (row.namespace ?? "").toLowerCase();
          const lowerKind = kind.toLowerCase();

          let rank = -1;
          if (lowerName === needle) rank = 0;
          else if (lowerName.startsWith(needle)) rank = 1;
          else if (lowerName.includes(needle)) rank = 2;
          else if (lowerNs.includes(needle) || lowerKind.includes(needle)) rank = 3;
          if (rank < 0) continue;

          seen.add(dedupeKey);
          scored.push({
            rank,
            item: {
              uid: dedupeKey,
              kind,
              gvr,
              name: row.name,
              namespace: row.namespace || undefined,
            },
          });
        }
      }
      scored.sort((a, b) => a.rank - b.rank || a.item.name.localeCompare(b.item.name));
      matchedInstances.push(...scored.slice(0, 8).map((s) => s.item));
    }

    return { matchedContexts, matchedResources, matchedInstances };
  }, [query, contexts, resources, open, activeContext, views]);

  return (
    <header
      data-testid="global-command-bar"
      className="flex h-9 shrink-0 items-center justify-between gap-3 border-b border-border bg-rail px-3 select-none"
    >
      {/* Left: History arrows + Quick Search */}
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            aria-label="Navigate back"
            disabled={!canGoBack}
            onClick={onBack}
            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-hover hover:text-foreground disabled:opacity-35"
          >
            <ArrowLeft size={13} aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label="Navigate forward"
            disabled={!canGoForward}
            onClick={onForward}
            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-hover hover:text-foreground disabled:opacity-35"
          >
            <ArrowRight size={13} aria-hidden="true" />
          </button>
        </div>

        <div ref={containerRef} className="relative w-full max-w-md">
          <div className="relative flex items-center">
            <Search
              size={12}
              className="pointer-events-none absolute left-2.5 text-muted-foreground"
              aria-hidden="true"
            />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onFocus={() => setOpen(true)}
              onChange={(e) => {
                setQuery(e.target.value);
                setOpen(true);
              }}
              onKeyDown={(e) => {
                if (
                  e.key === "Enter" &&
                  query.trim().length > 0 &&
                  results.matchedInstances.length > 0 &&
                  onSelectResourceInstance
                ) {
                  e.preventDefault();
                  const first = results.matchedInstances[0]!;
                  onSelectResourceInstance({
                    kind: first.kind,
                    gvr: first.gvr,
                    name: first.name,
                    namespace: first.namespace,
                  });
                  setOpen(false);
                  setQuery("");
                }
              }}
              placeholder="Search ..."
              aria-label="Global quick search"
              className="h-6 w-full rounded border border-border bg-background/80 pl-7 pr-12 text-[11.5px] text-foreground placeholder:text-muted-foreground focus:border-primary/70 focus:outline-none"
            />
            <span className="pointer-events-none absolute right-2 flex items-center gap-0.5 font-mono text-[9.5px] text-muted-foreground">
              <Command size={10} aria-hidden="true" />K
            </span>
          </div>

          {open ? (
            <div
              data-testid="command-palette-popover"
              className="absolute left-0 right-0 top-7 z-50 max-h-80 overflow-y-auto rounded border border-border-strong bg-popover p-1.5 shadow-2xl"
            >
              {activeContext && onSelectTopology ? (
                <button
                  type="button"
                  onClick={() => {
                    onSelectTopology();
                    setOpen(false);
                  }}
                  className="flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-left text-[11.5px] text-foreground hover:bg-hover"
                >
                  <span className="flex items-center gap-2">
                    <Network size={12} className="text-primary" />
                    <span>Open Cluster Topology</span>
                  </span>
                  <span className="font-mono text-[10px] text-muted-foreground">Visualizer</span>
                </button>
              ) : null}

              {results.matchedInstances.length > 0 && onSelectResourceInstance ? (
                <div
                  className="mt-1 border-t border-border pt-1"
                  data-testid="command-palette-instances"
                >
                  <div className="px-2 py-1 ide-section-label">Loaded Resources</div>
                  {results.matchedInstances.map((item) => (
                    <button
                      key={item.uid}
                      type="button"
                      data-testid={`command-instance-${item.uid}`}
                      onClick={() => {
                        onSelectResourceInstance({
                          kind: item.kind,
                          gvr: item.gvr,
                          name: item.name,
                          namespace: item.namespace,
                        });
                        setOpen(false);
                        setQuery("");
                      }}
                      className="flex w-full items-center justify-between gap-2 rounded-sm px-2 py-1 text-left text-[11.5px] text-foreground hover:bg-hover"
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="shrink-0 rounded border border-primary/35 bg-primary/10 px-1 py-0.2 font-mono text-[9.5px] text-primary">
                          {item.kind}
                        </span>
                        <span className="truncate font-mono">{item.name}</span>
                      </span>
                      <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                        {item.namespace ?? "cluster-scoped"}
                      </span>
                    </button>
                  ))}
                </div>
              ) : null}

              {results.matchedResources.length > 0 ? (
                <div className="mt-1">
                  <div className="px-2 py-1 ide-section-label">Resources</div>
                  {results.matchedResources.map((item) => (
                    <button
                      key={item.gvr}
                      type="button"
                      onClick={() => {
                        onSelectResource(item);
                        setOpen(false);
                        setQuery("");
                      }}
                      className="flex w-full items-center justify-between rounded-sm px-2 py-1 text-left text-[11.5px] text-foreground hover:bg-hover"
                    >
                      <span className="flex items-center gap-2">
                        <Boxes size={12} className="text-primary" />
                        <span>{item.kind}</span>
                      </span>
                      <span className="font-mono text-[10px] text-muted-foreground">
                        {item.group || "core"}/{item.version}
                      </span>
                    </button>
                  ))}
                </div>
              ) : null}

              {results.matchedContexts.length > 0 ? (
                <div className="mt-1 border-t border-border pt-1">
                  <div className="px-2 py-1 ide-section-label">Clusters</div>
                  {results.matchedContexts.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => {
                        onSelectContext(c);
                        setOpen(false);
                        setQuery("");
                      }}
                      className="flex w-full items-center justify-between rounded-sm px-2 py-1 text-left text-[11.5px] text-foreground hover:bg-hover"
                    >
                      <span className="flex items-center gap-2 truncate">
                        <Server size={12} className="shrink-0 text-primary" />
                        <span className="truncate">{c.name}</span>
                      </span>
                      <span className="font-mono text-[10px] text-muted-foreground">{c.state}</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      {/* Right: Read-Only indicator + Theme pill toggle */}
      <div className="flex shrink-0 items-center gap-2">
        <span
          className="hidden items-center gap-1 rounded border border-success/30 bg-success/10 px-2 py-0.5 font-mono text-[10px] font-medium text-success sm:inline-flex"
          title="Read-only mode enforced by Kubix IPC guard"
        >
          <ShieldCheck size={11} aria-hidden="true" />
          Read-Only
        </span>

        <button
          type="button"
          aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
          title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
          onClick={onSwitchTheme}
          className="flex h-6 items-center gap-1 rounded-full border border-border-strong bg-elevated px-1.5 text-muted-foreground transition-colors hover:border-primary/60 hover:text-foreground"
        >
          <Sun
            size={11}
            className={theme === "light" ? "text-primary" : "opacity-45"}
            aria-hidden="true"
          />
          <span className="h-3 w-px bg-border" aria-hidden="true" />
          <Moon
            size={11}
            className={theme === "dark" ? "text-primary" : "opacity-45"}
            aria-hidden="true"
          />
        </button>
      </div>
    </header>
  );
}
