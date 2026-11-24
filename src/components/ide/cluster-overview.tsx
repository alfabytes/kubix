import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  Boxes,
  CheckCircle2,
  Cpu,
  HardDrive,
  Layers,
  Loader2,
  Network,
  RefreshCw,
  Server,
} from "lucide-react";

import { parseNamespaceSelection } from "@/components/explorer/namespace-picker";
import { MetricsCard } from "@/components/ide/metrics-card";
import { SectionCard } from "@/components/ide/section-card";
import { Button } from "@/components/ui/button";
import { ipc } from "@/lib/ipc/client";
import type { DiscoveredResourceDto, ResourceSummaryDto } from "@/lib/ipc/types";
import {
  formatAge,
  resolveGvrForKind,
  type ResourceNavigationTarget,
} from "@/lib/resource-telemetry";
import type { ContextRow } from "@/stores/cluster-store";
import { useExplorerStore } from "@/stores/explorer-store";

export { HelmReleasesView } from "@/components/ide/helm-releases-view";
export { PortForwardsView } from "@/components/ide/port-forwards-view";
export { SecurityCenterView } from "@/components/ide/security-center-view";

export interface ClusterOverviewProps {
  context: ContextRow;
  resources: DiscoveredResourceDto[];
  activeWatchCount: number;
  mode?: "cluster" | "workload";
  isLandingPlaceholder?: boolean;
  onSelectResource: (item: DiscoveredResourceDto) => void;
  onNavigateResource?: (target: ResourceNavigationTarget) => void;
  onOpenTopology: () => void;
  onOpenEvents?: () => void;
}

function formatMillicoresShort(millicores: number): string {
  if (millicores >= 1000) {
    const cores = millicores / 1000;
    return `${cores >= 10 ? cores.toFixed(0) : cores.toFixed(1)} CPU`;
  }
  return `${Math.round(millicores)}m`;
}

function formatMibShort(mib: number): string {
  if (mib >= 1024) {
    const gib = mib / 1024;
    return `${gib >= 100 ? gib.toFixed(0) : gib.toFixed(1)} GiB`;
  }
  return `${Math.round(mib)} MiB`;
}

function usageTone(pct: number | null): "primary" | "warning" | "destructive" | "success" {
  if (pct === null) return "primary";
  if (pct >= 85) return "destructive";
  if (pct >= 65) return "warning";
  return "primary";
}

function barColor(pct: number | null, okClass: string): string {
  if ((pct ?? 0) >= 85) return "bg-destructive";
  if ((pct ?? 0) >= 65) return "bg-warning";
  return okClass;
}

function formatHost(server?: string): string {
  if (!server) return "";
  try {
    return new URL(server).host;
  } catch {
    return server;
  }
}

export function ClusterOverview({
  context,
  resources,
  mode = "cluster",
  isLandingPlaceholder = false,
  onSelectResource,
  onNavigateResource,
  onOpenTopology,
  onOpenEvents,
}: ClusterOverviewProps) {
  const allViews = useExplorerStore((s) => s.views);
  const namespaceFilter = useExplorerStore((s) => s.namespaceFilter);
  const [eventFilter, setEventFilter] = useState<"all" | "warning">("all");

  const overviewQuery = useQuery({
    queryKey: ["cluster-overview", context.id],
    queryFn: () => ipc.getClusterOverview(context.id),
    enabled: context.state === "ready" || context.state === "degraded",
    refetchInterval: 10000,
    retry: false,
  });

  const liveOverview =
    overviewQuery.data &&
    typeof overviewQuery.data === "object" &&
    "totalNodes" in overviewQuery.data
      ? overviewQuery.data
      : null;

  const resourceByGvr = useMemo(() => {
    const map = new Map<string, DiscoveredResourceDto>();
    for (const r of resources) {
      map.set(r.gvr, r);
    }
    return map;
  }, [resources]);

  const nodesResource = resourceByGvr.get("/v1/nodes");
  const podsResource = resourceByGvr.get("/v1/pods");
  const namespacesResource = resourceByGvr.get("/v1/namespaces");

  const namespacedCount = resources.filter((r) => r.namespaced).length;
  const clusterScopedCount = resources.length - namespacedCount;
  const apiGroupCount = new Set(resources.map((r) => r.group || "core")).size;

  // Summarize live cluster overview when available, falling back cleanly to any already-watched rows.
  const liveInventory = useMemo(() => {
    const byUid = new Map<string, ResourceSummaryDto>();
    const prefix = `${context.id}\u0000`;
    for (const [key, entry] of Object.entries(allViews)) {
      if (!key.startsWith(prefix)) continue;
      for (const r of entry.rows) {
        byUid.set(r.uid, r);
      }
    }
    const items = [...byUid.values()];
    const pods = items.filter((r) => r.kind === "Pod");
    const deployments = items.filter(
      (r) => r.kind === "Deployment" || r.kind === "StatefulSet" || r.kind === "DaemonSet",
    );
    const runningPods = pods.filter(
      (p) => !p.status || p.status === "Running" || p.status === "Succeeded",
    ).length;
    return {
      podCount: liveOverview?.totalPods ?? pods.length,
      runningPods: liveOverview?.runningPods ?? runningPods,
      controllerCount: liveOverview?.totalDeployments ?? deployments.length,
      healthyControllers: liveOverview?.healthyDeployments ?? deployments.length,
      readyNodes: liveOverview?.readyNodes ?? 0,
      totalNodes: liveOverview?.totalNodes ?? 0,
      namespaceCount: liveOverview?.namespaceCount ?? 0,
    };
  }, [allViews, context.id, liveOverview]);

  // Aggregate live cluster CPU & memory capacity / usage across nodes.
  const clusterCapacity = useMemo(() => {
    if (!liveOverview || liveOverview.nodes.length === 0) {
      return {
        totalCpuMc: 0,
        usedCpuMc: 0,
        hasCpuUsage: false,
        cpuPct: null as number | null,
        totalMemMib: 0,
        usedMemMib: 0,
        hasMemUsage: false,
        memPct: null as number | null,
      };
    }

    let totalCpuMc = 0;
    let usedCpuMc = 0;
    let hasCpuUsage = false;
    let totalMemMib = 0;
    let usedMemMib = 0;
    let hasMemUsage = false;

    for (const node of liveOverview.nodes) {
      if (typeof node.cpuCapacityMillicores === "number" && node.cpuCapacityMillicores > 0) {
        totalCpuMc += node.cpuCapacityMillicores;
      }
      if (typeof node.cpuUsageMillicores === "number") {
        usedCpuMc += node.cpuUsageMillicores;
        hasCpuUsage = true;
      }
      if (typeof node.memoryCapacityMib === "number" && node.memoryCapacityMib > 0) {
        totalMemMib += node.memoryCapacityMib;
      }
      if (typeof node.memoryUsageMib === "number") {
        usedMemMib += node.memoryUsageMib;
        hasMemUsage = true;
      }
    }

    const cpuPct =
      hasCpuUsage && totalCpuMc > 0 ? Math.min(100, Math.round((usedCpuMc / totalCpuMc) * 100)) : null;
    const memPct =
      hasMemUsage && totalMemMib > 0
        ? Math.min(100, Math.round((usedMemMib / totalMemMib) * 100))
        : null;

    return {
      totalCpuMc,
      usedCpuMc,
      hasCpuUsage,
      cpuPct,
      totalMemMib,
      usedMemMib,
      hasMemUsage,
      memPct,
    };
  }, [liveOverview]);

  const recentEvents = useMemo(() => liveOverview?.recentEvents ?? [], [liveOverview]);
  const warningEventsCount = useMemo(
    () => recentEvents.filter((ev) => ev.eventType === "Warning").length,
    [recentEvents],
  );
  const visibleEvents = useMemo(
    () =>
      eventFilter === "warning"
        ? recentEvents.filter((ev) => ev.eventType === "Warning")
        : recentEvents,
    [recentEvents, eventFilter],
  );

  const serverHost = formatHost(context.server);
  const nodeCapacitySummary =
    clusterCapacity.totalCpuMc > 0 || clusterCapacity.totalMemMib > 0
      ? [
          clusterCapacity.totalCpuMc > 0 ? formatMillicoresShort(clusterCapacity.totalCpuMc) : null,
          clusterCapacity.totalMemMib > 0 ? formatMibShort(clusterCapacity.totalMemMib) : null,
        ]
          .filter(Boolean)
          .join(" · ")
      : `${liveInventory.namespaceCount} namespaces · ${resources.length} APIs`;

  return (
    <div
      data-testid={isLandingPlaceholder ? "explorer-placeholder" : "cluster-overview"}
      className="flex h-full flex-col overflow-hidden"
    >
      {/* Clean single-row header */}
      <div className="flex min-h-[42px] shrink-0 items-center justify-between gap-2.5 border-b border-border bg-panel px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <h1 className="truncate text-[14px] font-semibold tracking-tight text-foreground">
            Cluster Overview
          </h1>
          {serverHost ? (
            <span
              className="hidden truncate font-mono text-[10.5px] text-muted-foreground sm:inline"
              title={context.server}
            >
              {serverHost}
            </span>
          ) : null}
          {liveOverview ? (
            <span className="hidden rounded border border-border bg-elevated px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground md:inline">
              {liveOverview.namespaceCount} ns
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1.5 px-2 text-[11px]"
            onClick={onOpenTopology}
          >
            <Network size={12} className="text-primary" aria-hidden="true" />
            Topology
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1.5 px-2 text-[11px]"
            disabled={overviewQuery.isFetching}
            onClick={() => overviewQuery.refetch()}
          >
            <RefreshCw
              size={12}
              className={overviewQuery.isFetching ? "animate-spin text-primary" : ""}
              aria-hidden="true"
            />
            Refresh
          </Button>
        </div>
      </div>

      {/* Main uncluttered content */}
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3 xl:overflow-hidden">
        {/* Compact 4-card operational KPI strip */}
        <div className="grid shrink-0 grid-cols-2 gap-2.5 lg:grid-cols-4">
          <MetricsCard
            label={
              liveOverview
                ? "Nodes"
                : mode === "workload"
                  ? "Workload APIs"
                  : "Discovered APIs"
            }
            value={
              liveOverview
                ? `${liveInventory.readyNodes} / ${liveInventory.totalNodes}`
                : resources.length
            }
            sublabel={
              liveOverview
                ? nodeCapacitySummary
                : `${namespacedCount} namespaced · ${clusterScopedCount} cluster`
            }
            icon={liveOverview ? <Server size={14} /> : <Boxes size={14} />}
            tone={
              liveOverview &&
              liveInventory.totalNodes > 0 &&
              liveInventory.readyNodes < liveInventory.totalNodes
                ? "warning"
                : "primary"
            }
            onClick={nodesResource ? () => onSelectResource(nodesResource) : undefined}
          />

          <MetricsCard
            label={liveInventory.podCount > 0 || liveOverview ? "Pods" : "API Groups"}
            value={
              liveInventory.podCount > 0 || liveOverview
                ? `${liveInventory.runningPods} / ${liveInventory.podCount}`
                : apiGroupCount
            }
            sublabel={
              liveOverview
                ? `${liveInventory.healthyControllers}/${liveInventory.controllerCount} Deployments ready`
                : liveInventory.podCount > 0
                  ? (() => {
                      const selected = parseNamespaceSelection(namespaceFilter);
                      return selected.length > 1
                        ? `Running in ${selected.length} namespaces`
                        : `Running in ${selected[0] || context.namespaceDefault}`;
                    })()
                  : `${resources.length} discovered kinds`
            }
            icon={<CheckCircle2 size={14} />}
            tone={
              liveInventory.podCount > 0 && liveInventory.runningPods < liveInventory.podCount
                ? "warning"
                : "success"
            }
            onClick={podsResource ? () => onSelectResource(podsResource) : undefined}
          />

          {clusterCapacity.hasCpuUsage ? (
            <MetricsCard
              label="CPU Usage"
              value={
                clusterCapacity.cpuPct !== null
                  ? `${clusterCapacity.cpuPct}%`
                  : formatMillicoresShort(clusterCapacity.usedCpuMc)
              }
              sublabel={
                clusterCapacity.totalCpuMc > 0
                  ? `${formatMillicoresShort(clusterCapacity.usedCpuMc)} / ${formatMillicoresShort(clusterCapacity.totalCpuMc)}`
                  : "Cluster total"
              }
              progressPct={clusterCapacity.cpuPct ?? undefined}
              icon={<Cpu size={14} />}
              tone={usageTone(clusterCapacity.cpuPct)}
              onClick={nodesResource ? () => onSelectResource(nodesResource) : undefined}
            />
          ) : (
            <MetricsCard
              label="Namespaces"
              value={liveOverview ? liveInventory.namespaceCount : "—"}
              sublabel={`${resources.length} APIs · ${apiGroupCount} groups`}
              icon={<Layers size={14} />}
              tone="primary"
              onClick={namespacesResource ? () => onSelectResource(namespacesResource) : undefined}
            />
          )}

          {clusterCapacity.hasMemUsage ? (
            <MetricsCard
              label="Memory Usage"
              value={
                clusterCapacity.memPct !== null
                  ? `${clusterCapacity.memPct}%`
                  : formatMibShort(clusterCapacity.usedMemMib)
              }
              sublabel={
                clusterCapacity.totalMemMib > 0
                  ? `${formatMibShort(clusterCapacity.usedMemMib)} / ${formatMibShort(clusterCapacity.totalMemMib)}`
                  : "Cluster total"
              }
              progressPct={clusterCapacity.memPct ?? undefined}
              icon={<HardDrive size={14} />}
              tone={
                clusterCapacity.memPct !== null && clusterCapacity.memPct < 65
                  ? "success"
                  : usageTone(clusterCapacity.memPct)
              }
              onClick={nodesResource ? () => onSelectResource(nodesResource) : undefined}
            />
          ) : (
            <MetricsCard
              label="Recent Warnings"
              value={liveOverview ? warningEventsCount : "—"}
              sublabel={
                liveOverview
                  ? `${recentEvents.length} recent cluster events`
                  : "Waiting for cluster telemetry"
              }
              icon={
                warningEventsCount > 0 ? <AlertTriangle size={14} /> : <Activity size={14} />
              }
              tone={warningEventsCount > 0 ? "warning" : "success"}
              onClick={onOpenEvents}
            />
          )}
        </div>

        {/* Balanced full-height Nodes & Recent Events panels */}
        {liveOverview ? (
          <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 xl:grid-cols-2">
            <SectionCard
              title="Nodes"
              subtitle={`${liveOverview.readyNodes}/${liveOverview.totalNodes} ready`}
              icon={<Server size={13} />}
              className="min-h-[260px] xl:min-h-0"
              bodyClassName="min-h-0 flex-1 overflow-y-auto p-0"
              actions={
                nodesResource ? (
                  <button
                    type="button"
                    onClick={() => onSelectResource(nodesResource)}
                    className="inline-flex items-center gap-0.5 text-[10.5px] font-medium text-muted-foreground transition-colors hover:text-primary"
                  >
                    View all
                    <ArrowUpRight size={11} aria-hidden="true" />
                  </button>
                ) : null
              }
            >
              {liveOverview.nodes.length === 0 ? (
                <div className="p-4 text-xs text-muted-foreground">
                  No nodes reported by cluster.
                </div>
              ) : (
                <div className="divide-y divide-border/60">
                  {liveOverview.nodes.map((node) => {
                    const hasCpuUsage = typeof node.cpuUsageMillicores === "number";
                    const hasMemUsage = typeof node.memoryUsageMib === "number";
                    const cpuPct =
                      hasCpuUsage && node.cpuCapacityMillicores && node.cpuCapacityMillicores > 0
                        ? Math.min(
                            100,
                            Math.round((node.cpuUsageMillicores! / node.cpuCapacityMillicores) * 100),
                          )
                        : null;
                    const memPct =
                      hasMemUsage && node.memoryCapacityMib && node.memoryCapacityMib > 0
                        ? Math.min(
                            100,
                            Math.round((node.memoryUsageMib! / node.memoryCapacityMib) * 100),
                          )
                        : null;
                    const memUsedLabel = hasMemUsage ? formatMibShort(node.memoryUsageMib!) : null;

                    const content = (
                      <>
                        <div className="flex w-full items-center justify-between gap-2">
                          <div className="flex min-w-0 items-center gap-2">
                            <span
                              className={`h-2 w-2 shrink-0 rounded-full ${
                                node.ready ? "bg-success" : "bg-destructive"
                              }`}
                              title={node.ready ? "Ready" : "NotReady"}
                              aria-label={node.ready ? "Ready" : "NotReady"}
                            />
                            <span
                              className={`truncate font-mono text-[12px] font-medium ${
                                onNavigateResource
                                  ? "text-foreground transition-colors group-hover:text-primary"
                                  : "text-foreground"
                              }`}
                              title={node.name}
                            >
                              {node.name}
                            </span>
                            {onNavigateResource ? (
                              <ArrowUpRight
                                size={11}
                                className="shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:text-primary group-hover:opacity-100"
                                aria-hidden="true"
                              />
                            ) : null}
                          </div>
                          <div className="shrink-0 font-mono text-[10.5px] tabular-nums text-muted-foreground">
                            <span>{node.cpuCapacity} CPU</span>
                            <span className="mx-1 text-border">·</span>
                            <span>{node.memoryCapacity}</span>
                          </div>
                        </div>

                        <div className="mt-0.5 pl-4 font-mono text-[10px] text-muted-foreground/85">
                          {node.roles} · {node.kubeletVersion || "kubelet"} ·{" "}
                          {node.createdAt ? formatAge(node.createdAt) : "—"}
                        </div>

                        {hasCpuUsage || hasMemUsage ? (
                          <div className="mt-2 grid w-full grid-cols-2 gap-3 pl-4 font-mono text-[10px]">
                            <div>
                              <div className="flex items-center justify-between text-muted-foreground">
                                <span>
                                  CPU{" "}
                                  <strong className="font-medium text-foreground">
                                    {Math.round(node.cpuUsageMillicores ?? 0)}m
                                  </strong>
                                </span>
                                {cpuPct !== null ? (
                                  <span className="tabular-nums">{cpuPct}%</span>
                                ) : null}
                              </div>
                              <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-secondary">
                                <div
                                  className={`h-full rounded-full ${barColor(cpuPct, "bg-primary")}`}
                                  style={{ width: `${cpuPct ?? 0}%` }}
                                />
                              </div>
                            </div>
                            <div>
                              <div className="flex items-center justify-between text-muted-foreground">
                                <span>
                                  MEM{" "}
                                  <strong className="font-medium text-foreground">
                                    {memUsedLabel ?? "—"}
                                  </strong>
                                </span>
                                {memPct !== null ? (
                                  <span className="tabular-nums">{memPct}%</span>
                                ) : null}
                              </div>
                              <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-secondary">
                                <div
                                  className={`h-full rounded-full ${barColor(memPct, "bg-success")}`}
                                  style={{ width: `${memPct ?? 0}%` }}
                                />
                              </div>
                            </div>
                          </div>
                        ) : null}
                      </>
                    );

                    return onNavigateResource ? (
                      <button
                        key={node.name}
                        type="button"
                        data-testid={`overview-node-${node.name}`}
                        onClick={() =>
                          onNavigateResource({
                            kind: "Node",
                            gvr: "/v1/nodes",
                            name: node.name,
                            namespace: undefined,
                          })
                        }
                        className="group flex w-full flex-col px-3 py-2.5 text-left transition-colors hover:bg-hover/60"
                      >
                        {content}
                      </button>
                    ) : (
                      <div
                        key={node.name}
                        data-testid={`overview-node-${node.name}`}
                        className="flex w-full flex-col px-3 py-2.5"
                      >
                        {content}
                      </div>
                    );
                  })}
                </div>
              )}
            </SectionCard>

            <SectionCard
              title="Recent Events"
              subtitle={`${visibleEvents.length} shown`}
              icon={<Activity size={13} />}
              className="min-h-[260px] xl:min-h-0"
              bodyClassName="min-h-0 flex-1 overflow-y-auto p-0"
              actions={
                <div className="flex items-center gap-2">
                  {warningEventsCount > 0 ? (
                    <div className="inline-flex overflow-hidden rounded border border-border bg-background text-[10px]">
                      <button
                        type="button"
                        onClick={() => setEventFilter("all")}
                        className={`px-1.5 py-0.5 transition-colors ${
                          eventFilter === "all"
                            ? "bg-primary/15 font-medium text-primary"
                            : "text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        All
                      </button>
                      <button
                        type="button"
                        onClick={() => setEventFilter("warning")}
                        className={`border-l border-border px-1.5 py-0.5 transition-colors ${
                          eventFilter === "warning"
                            ? "bg-warning/15 font-medium text-warning"
                            : "text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        Warnings ({warningEventsCount})
                      </button>
                    </div>
                  ) : null}
                  {onOpenEvents ? (
                    <button
                      type="button"
                      onClick={onOpenEvents}
                      className="inline-flex items-center gap-0.5 text-[10.5px] font-medium text-muted-foreground transition-colors hover:text-primary"
                    >
                      View all
                      <ArrowUpRight size={11} aria-hidden="true" />
                    </button>
                  ) : null}
                </div>
              }
            >
              {visibleEvents.length === 0 ? (
                <div className="p-4 text-xs text-muted-foreground">
                  {eventFilter === "warning"
                    ? "No recent warning events."
                    : "No recent events in cluster."}
                </div>
              ) : (
                <div className="divide-y divide-border/60">
                  {visibleEvents.slice(0, 25).map((ev, idx) => {
                    const slashIdx = ev.involvedObject.indexOf("/");
                    const evKind = slashIdx > 0 ? ev.involvedObject.slice(0, slashIdx) : "";
                    const evName = slashIdx > 0 ? ev.involvedObject.slice(slashIdx + 1) : "";
                    const resolved = evKind ? resolveGvrForKind(evKind, resources) : null;
                    const canJump = Boolean(onNavigateResource && resolved && evName);
                    const isWarning = ev.eventType === "Warning";

                    return (
                      <div
                        key={ev.uid || `${ev.reason}-${idx}`}
                        data-testid="overview-event-row"
                        className="flex items-start justify-between gap-2.5 px-3 py-2 text-[11px] transition-colors hover:bg-hover/40"
                      >
                        <div className="flex min-w-0 flex-1 items-start gap-2">
                          <span
                            className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                              isWarning ? "bg-warning" : "bg-success"
                            }`}
                            title={ev.eventType}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                              <span
                                className={`font-mono font-semibold ${
                                  isWarning ? "text-warning" : "text-foreground"
                                }`}
                              >
                                {ev.reason}
                              </span>
                              {canJump && resolved ? (
                                <button
                                  type="button"
                                  data-testid={`overview-event-link-${evName}`}
                                  onClick={() =>
                                    onNavigateResource?.({
                                      kind: evKind,
                                      gvr: resolved.gvr,
                                      name: evName,
                                      namespace: resolved.namespaced
                                        ? ev.namespace || context.namespaceDefault
                                        : undefined,
                                    })
                                  }
                                  className="inline-flex max-w-full items-center gap-0.5 truncate font-mono text-primary underline-offset-2 hover:underline"
                                >
                                  <span className="truncate">{ev.involvedObject}</span>
                                  <ArrowUpRight size={10} className="shrink-0" aria-hidden="true" />
                                </button>
                              ) : (
                                <span className="truncate font-mono text-muted-foreground">
                                  {ev.involvedObject}
                                </span>
                              )}
                              {ev.namespace ? (
                                <span className="rounded bg-elevated px-1 py-0.2 font-mono text-[9.5px] text-muted-foreground">
                                  {ev.namespace}
                                </span>
                              ) : null}
                            </div>
                            <p
                              className="mt-0.5 truncate text-[11px] text-muted-foreground"
                              title={ev.message}
                            >
                              {ev.message}
                            </p>
                          </div>
                        </div>
                        <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
                          {formatAge(ev.createdAt)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </SectionCard>
          </div>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center rounded border border-dashed border-border bg-panel/40 p-8 text-center">
            {overviewQuery.isFetching ? (
              <>
                <Loader2 size={18} className="mb-2 animate-spin text-primary" />
                <p className="text-xs font-medium text-foreground">Loading cluster overview…</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  Gathering nodes, pods, and recent events from {context.name}.
                </p>
              </>
            ) : (
              <>
                <Server size={18} className="mb-2 text-muted-foreground/70" />
                <p className="text-xs font-medium text-foreground">
                  Select a resource type from the sidebar to explore {context.name}
                </p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  Live node telemetry and recent cluster events will appear here once available.
                </p>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
