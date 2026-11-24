import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowUpRight, Loader2, RefreshCw, Search } from "lucide-react";
import { useMemo, useState } from "react";

import { ResourceStatusChip } from "@/components/clusters/status-badge";
import {
  NamespacePicker,
  parseNamespaceSelection,
} from "@/components/explorer/namespace-picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ipc } from "@/lib/ipc/client";
import type { ClusterEventDto, DiscoveredResourceDto } from "@/lib/ipc/types";
import {
  formatAge,
  resolveGvrForKind,
  type ResourceNavigationTarget,
} from "@/lib/resource-telemetry";
import type { ContextRow } from "@/stores/cluster-store";
import { useSettingsStore } from "@/stores/settings-store";

export interface EventsTimelineViewProps {
  context: ContextRow;
  resources: DiscoveredResourceDto[];
  namespace: string;
  observedNamespaces: string[];
  onChangeNamespace: (ns: string) => void;
  onNavigateResource?: (target: ResourceNavigationTarget) => void;
}

export function EventsTimelineView({
  context,
  resources,
  namespace,
  observedNamespaces,
  onChangeNamespace,
  onNavigateResource,
}: EventsTimelineViewProps) {
  const defaultAutoRefresh = useSettingsStore((s) => s.eventsAutoRefresh);
  const [severityFilter, setSeverityFilter] = useState<"all" | "warning" | "normal">("all");
  const [search, setSearch] = useState("");
  const [autoRefresh, setAutoRefresh] = useState(defaultAutoRefresh);

  const ready = context.state === "ready" || context.state === "degraded";

  const selectedNamespaces = useMemo(() => parseNamespaceSelection(namespace), [namespace]);
  const queryNamespace = selectedNamespaces.length === 1 ? selectedNamespaces[0] : undefined;

  const eventsQuery = useQuery({
    queryKey: ["cluster-events-timeline", context.id, queryNamespace || "*"],
    queryFn: () => ipc.getResourceEvents(context.id, "/v1/events", "", queryNamespace),
    enabled: ready,
    refetchInterval: autoRefresh ? 5000 : false,
    retry: false,
  });

  const allEvents = useMemo<ClusterEventDto[]>(() => {
    const raw = Array.isArray(eventsQuery.data) ? eventsQuery.data : [];
    if (selectedNamespaces.length < 2) return raw;
    const allowed = new Set(selectedNamespaces);
    return raw.filter((ev) => allowed.has(ev.namespace));
  }, [eventsQuery.data, selectedNamespaces]);

  const warningCount = useMemo(
    () => allEvents.filter((e) => e.eventType === "Warning").length,
    [allEvents],
  );
  const normalCount = allEvents.length - warningCount;

  const filteredEvents = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allEvents.filter((ev) => {
      if (severityFilter === "warning" && ev.eventType !== "Warning") return false;
      if (severityFilter === "normal" && ev.eventType === "Warning") return false;
      if (!q) return true;
      return (
        ev.reason.toLowerCase().includes(q) ||
        ev.involvedObject.toLowerCase().includes(q) ||
        ev.message.toLowerCase().includes(q) ||
        ev.from.toLowerCase().includes(q) ||
        ev.namespace.toLowerCase().includes(q)
      );
    });
  }, [allEvents, search, severityFilter]);

  const handleJump = (ev: ClusterEventDto) => {
    if (!onNavigateResource) return;
    const slashIdx = ev.involvedObject.indexOf("/");
    if (slashIdx <= 0) return;
    const kind = ev.involvedObject.slice(0, slashIdx).trim();
    const name = ev.involvedObject.slice(slashIdx + 1).trim();
    if (!kind || !name) return;
    const resolved = resolveGvrForKind(kind, resources);
    if (!resolved) return;
    onNavigateResource({
      kind,
      gvr: resolved.gvr,
      name,
      namespace: resolved.namespaced ? ev.namespace || context.namespaceDefault || "default" : undefined,
    });
  };

  return (
    <div data-testid="events-timeline-view" className="flex h-full flex-col bg-background">
      {/* Compact single-bar toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-panel px-3 py-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center rounded border border-border bg-elevated p-0.5 text-[10.5px]">
            {(
              [
                { id: "all", label: `All (${allEvents.length})` },
                { id: "warning", label: `Warnings (${warningCount})` },
                { id: "normal", label: `Normal (${normalCount})` },
              ] as const
            ).map((opt) => (
              <button
                key={opt.id}
                type="button"
                data-testid={`events-filter-${opt.id}`}
                onClick={() => setSeverityFilter(opt.id)}
                className={`rounded-sm px-2 py-0.5 font-medium transition-colors ${
                  severityFilter === opt.id
                    ? opt.id === "warning"
                      ? "bg-warning/20 text-warning"
                      : "bg-primary/20 text-primary"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <NamespacePicker
            value={namespace}
            defaultValue={context.namespaceDefault}
            observed={observedNamespaces}
            onChange={onChangeNamespace}
          />

          <div className="relative w-48 sm:w-64">
            <Search
              size={11}
              className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter reason, object, message…"
              aria-label="Filter events"
              data-testid="events-search-input"
              className="h-7 bg-elevated pl-6 font-mono text-[11px]"
            />
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            variant={autoRefresh ? "secondary" : "outline"}
            className="h-7 px-2 text-[10.5px]"
            data-testid="events-toggle-live"
            onClick={() => setAutoRefresh((v) => !v)}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                autoRefresh ? "animate-pulse bg-success" : "bg-muted-foreground"
              }`}
            />
            {autoRefresh ? "Live 5s" : "Paused"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[10.5px]"
            data-testid="events-refresh"
            disabled={eventsQuery.isFetching}
            onClick={() => void eventsQuery.refetch()}
          >
            <RefreshCw
              size={11}
              className={eventsQuery.isFetching ? "animate-spin text-primary" : ""}
              aria-hidden="true"
            />
            Refresh
          </Button>
        </div>
      </div>

      {/* Timeline Body */}
      <div className="min-h-0 flex-1 overflow-auto">
        {eventsQuery.isLoading ? (
          <div className="flex items-center gap-2 p-4 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" aria-hidden="true" />
            Loading live Kubernetes events…
          </div>
        ) : eventsQuery.error ? (
          <div className="m-3 flex items-start gap-2 rounded border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span>{String((eventsQuery.error as Error).message)}</span>
          </div>
        ) : filteredEvents.length === 0 ? (
          <div
            data-testid="events-timeline-empty"
            className="p-8 text-center text-xs text-muted-foreground"
          >
            No matching Kubernetes events in{" "}
            <span className="font-mono text-foreground">
              {namespace || "all namespaces"}
            </span>
            .
          </div>
        ) : (
          <table className="w-full border-collapse text-left text-[11.5px]">
            <thead className="sticky top-0 z-10 border-b border-border bg-elevated/95 backdrop-blur-sm">
              <tr className="ide-table-header">
                <th className="w-24 px-3 py-2">Type</th>
                <th className="w-36 px-3 py-2">Reason</th>
                <th className="w-56 px-3 py-2">Involved Object</th>
                <th className="w-28 px-3 py-2">Namespace</th>
                <th className="w-16 px-3 py-2 text-right">Count</th>
                <th className="w-28 px-3 py-2">Source</th>
                <th className="w-16 px-3 py-2 text-right">Age</th>
                <th className="px-3 py-2">Message</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/70">
              {filteredEvents.map((ev, idx) => {
                const isWarning = ev.eventType === "Warning";
                const isSpike = ev.count >= 5;
                const canJump =
                  Boolean(onNavigateResource) &&
                  ev.involvedObject.includes("/") &&
                  Boolean(
                    resolveGvrForKind(
                      ev.involvedObject.slice(0, ev.involvedObject.indexOf("/")).trim(),
                      resources,
                    ),
                  );

                return (
                  <tr
                    key={ev.uid || `${ev.reason}-${ev.involvedObject}-${idx}`}
                    data-testid="timeline-event-row"
                    data-event-type={ev.eventType}
                    className={`transition-colors hover:bg-hover/65 ${
                      isWarning ? "bg-warning/[0.03]" : ""
                    }`}
                  >
                    <td className="px-3 py-2 align-top">
                      <ResourceStatusChip
                        label={ev.eventType || "Normal"}
                        tone={isWarning ? "warn" : "ok"}
                      />
                    </td>
                    <td className="px-3 py-2 align-top font-mono font-semibold text-foreground">
                      {ev.reason}
                    </td>
                    <td className="px-3 py-2 align-top font-mono">
                      {canJump ? (
                        <button
                          type="button"
                          data-testid="timeline-event-jump"
                          onClick={() => handleJump(ev)}
                          className="inline-flex max-w-full items-center gap-1 text-left text-primary underline-offset-2 hover:underline"
                          title={`Inspect ${ev.involvedObject}`}
                        >
                          <span className="truncate">{ev.involvedObject}</span>
                          <ArrowUpRight size={11} className="shrink-0" aria-hidden="true" />
                        </button>
                      ) : (
                        <span className="text-foreground">{ev.involvedObject}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 align-top font-mono text-[11px] text-muted-foreground">
                      {ev.namespace || "cluster"}
                    </td>
                    <td className="px-3 py-2 text-right align-top font-mono tabular-nums">
                      <span
                        className={
                          isSpike
                            ? "rounded border border-warning/40 bg-warning/15 px-1.5 py-0.2 font-semibold text-warning"
                            : "text-muted-foreground"
                        }
                      >
                        ×{ev.count}
                      </span>
                    </td>
                    <td className="px-3 py-2 align-top font-mono text-[10.5px] text-muted-foreground">
                      {ev.from || "—"}
                    </td>
                    <td className="px-3 py-2 text-right align-top font-mono text-[10.5px] tabular-nums text-muted-foreground">
                      {formatAge(ev.createdAt)}
                    </td>
                    <td className="px-3 py-2 align-top text-muted-foreground">{ev.message}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
