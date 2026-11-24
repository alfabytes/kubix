import { useQuery } from "@tanstack/react-query";
import { Activity, AlertCircle, Boxes, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { parseNodeCapacity } from "@/components/explorer/detail/detail-utils";
import { MetricsCard } from "@/components/ide/metrics-card";
import { SectionCard } from "@/components/ide/section-card";
import { ipc } from "@/lib/ipc/client";
import {
  parseCpuMillicoresValue,
  parseMemoryMibValue,
  type ParsedContainerInfo,
} from "@/lib/resource-telemetry";

const SAMPLE_TIME_LABELS = ["Earliest", "", "", "", "", "Now"];

export function WorkloadMetricsPanel({
  contextId,
  gvr,
  name,
  namespace,
  containers,
  isNode = false,
  manifestYaml,
}: {
  contextId: string;
  gvr: string;
  name: string;
  namespace: string;
  containers: ParsedContainerInfo[];
  isNode?: boolean;
  manifestYaml?: string;
}) {
  const metricsQuery = useQuery({
    queryKey: ["resource-metrics", contextId, gvr, name, namespace],
    queryFn: () => ipc.getResourceMetrics(contextId, gvr, name, namespace),
    enabled: Boolean(contextId && name),
    refetchInterval: 5000,
    retry: false,
  });

  const [cpuSamples, setCpuSamples] = useState<number[]>([]);
  const [memSamples, setMemSamples] = useState<number[]>([]);

  useEffect(() => {
    setCpuSamples([]);
    setMemSamples([]);
  }, [contextId, gvr, name, namespace]);

  const metricsData =
    metricsQuery.data && typeof metricsQuery.data === "object" ? metricsQuery.data : null;

  useEffect(() => {
    if (!metricsData?.metricsServerAvailable) return;
    setCpuSamples((prev) => [...prev.slice(-19), metricsData.totalCpuMillicores]);
    setMemSamples((prev) => [...prev.slice(-19), metricsData.totalMemoryMib]);
  }, [
    metricsData?.metricsServerAvailable,
    metricsData?.timestamp,
    metricsData?.totalCpuMillicores,
    metricsData?.totalMemoryMib,
  ]);

  const specSummary = useMemo(() => {
    let cpuReq = 0;
    let cpuLim = 0;
    let memReq = 0;
    let memLim = 0;
    let hasCpuReq = false;
    let hasCpuLim = false;
    let hasMemReq = false;
    let hasMemLim = false;
    for (const c of containers) {
      const cr = parseCpuMillicoresValue(c.cpuRequest);
      const cl = parseCpuMillicoresValue(c.cpuLimit);
      const mr = parseMemoryMibValue(c.memRequest);
      const ml = parseMemoryMibValue(c.memLimit);
      if (cr !== null) {
        cpuReq += cr;
        hasCpuReq = true;
      }
      if (cl !== null) {
        cpuLim += cl;
        hasCpuLim = true;
      }
      if (mr !== null) {
        memReq += mr;
        hasMemReq = true;
      }
      if (ml !== null) {
        memLim += ml;
        hasMemLim = true;
      }
    }
    return {
      cpuRequest: hasCpuReq ? cpuReq : null,
      cpuLimit: hasCpuLim ? cpuLim : null,
      memRequest: hasMemReq ? memReq : null,
      memLimit: hasMemLim ? memLim : null,
    };
  }, [containers]);

  const nodeCapacity = useMemo(
    () => (isNode ? parseNodeCapacity(manifestYaml) : null),
    [isNode, manifestYaml],
  );

  const serverAvailable = metricsData?.metricsServerAvailable === true;
  const liveCpu = metricsData?.totalCpuMillicores ?? 0;
  const liveMem = metricsData?.totalMemoryMib ?? 0;

  const effectiveCpuMax = isNode ? nodeCapacity?.cpuMillicores ?? null : specSummary.cpuLimit;
  const effectiveMemMax = isNode ? nodeCapacity?.memoryMib ?? null : specSummary.memLimit;

  const cpuPct =
    serverAvailable && effectiveCpuMax && effectiveCpuMax > 0
      ? Math.min(100, Math.round((liveCpu / effectiveCpuMax) * 100))
      : undefined;
  const memPct =
    serverAvailable && effectiveMemMax && effectiveMemMax > 0
      ? Math.min(100, Math.round((liveMem / effectiveMemMax) * 100))
      : undefined;

  const chartCpu =
    cpuSamples.length >= 2 ? cpuSamples : cpuSamples.length === 1 ? [cpuSamples[0]!, cpuSamples[0]!] : [];
  const chartMem =
    memSamples.length >= 2 ? memSamples : memSamples.length === 1 ? [memSamples[0]!, memSamples[0]!] : [];

  return (
    <div className="h-full overflow-y-auto p-3 space-y-3" data-testid="detail-metrics">
      {metricsQuery.isLoading ? (
        <div className="flex items-center gap-2 rounded border border-border bg-elevated/60 p-3 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" aria-hidden />
          Querying metrics.k8s.io/v1beta1…
        </div>
      ) : metricsQuery.error ? (
        <div className="rounded border border-destructive/40 bg-destructive/10 p-2.5 text-xs text-destructive">
          {String((metricsQuery.error as Error).message)}
        </div>
      ) : !serverAvailable ? (
        <div
          data-testid="metrics-server-unavailable"
          className="flex items-start gap-2 rounded border border-warning/40 bg-warning/10 p-2.5 text-xs text-foreground"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
          <div>
            <div className="font-semibold">Metrics Server not installed</div>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              {metricsData?.statusMessage ??
                "Cluster does not expose metrics.k8s.io/v1beta1. Displaying container resource requests and limits declared in the manifest."}
            </p>
          </div>
        </div>
      ) : null}

      {/* Top Live / Quota KPI Cards */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <MetricsCard
          label="CPU Usage"
          value={serverAvailable ? `${liveCpu}m` : "Unavailable"}
          sublabel={
            isNode
              ? nodeCapacity?.cpuRaw
                ? `Capacity ${nodeCapacity.cpuRaw} CPU${cpuPct !== undefined ? ` (${cpuPct}%)` : ""}`
                : "Node live CPU usage"
              : specSummary.cpuLimit !== null
                ? `Limit ${specSummary.cpuLimit}m · Req ${specSummary.cpuRequest ?? 0}m`
                : specSummary.cpuRequest !== null
                  ? `Req ${specSummary.cpuRequest}m · No limit`
                  : "No CPU request/limit set"
          }
          progressPct={cpuPct}
          sparkline={chartCpu.length > 0 ? chartCpu.slice(-10) : undefined}
          icon={<Activity size={13} />}
          tone={serverAvailable ? "primary" : "neutral"}
        />
        <MetricsCard
          label="Memory Working Set"
          value={serverAvailable ? `${liveMem} MiB` : "Unavailable"}
          sublabel={
            isNode
              ? nodeCapacity?.memoryMib
                ? `Capacity ${(nodeCapacity.memoryMib / 1024).toFixed(1)} GiB${memPct !== undefined ? ` (${memPct}%)` : ""}`
                : "Node live memory usage"
              : specSummary.memLimit !== null
                ? `Limit ${Math.round(specSummary.memLimit)}Mi · Req ${Math.round(specSummary.memRequest ?? 0)}Mi`
                : specSummary.memRequest !== null
                  ? `Req ${Math.round(specSummary.memRequest)}Mi · No limit`
                  : "No memory request/limit set"
          }
          progressPct={memPct}
          sparkline={chartMem.length > 0 ? chartMem.slice(-10) : undefined}
          icon={<Activity size={13} />}
          tone={serverAvailable ? "success" : "neutral"}
        />
        {isNode ? (
          <MetricsCard
            label="Metric Window"
            value={serverAvailable ? `${metricsData?.windowSeconds ?? 15}s` : "—"}
            sublabel="metrics.k8s.io/v1beta1/nodes"
            icon={<Activity size={13} />}
            tone="primary"
          />
        ) : (
          <MetricsCard
            label="Observed Pods"
            value={serverAvailable ? `${metricsData?.podCount ?? 0}` : `${containers.length}`}
            sublabel={
              serverAvailable
                ? `metrics.k8s.io/v1beta1 · ${metricsData?.windowSeconds ?? 15}s window`
                : "Containers declared in spec"
            }
            icon={<Boxes size={13} />}
            tone="primary"
          />
        )}
      </div>

      {serverAvailable && chartCpu.length > 0 ? (
        <SectionCard
          title="Live Resource Telemetry"
          subtitle={`Polling metrics.k8s.io/v1beta1 (${cpuSamples.length} live ${cpuSamples.length === 1 ? "sample" : "samples"})`}
          icon={<Activity size={12} />}
        >
          <div className="space-y-3">
            <TelemetryAreaChart
              id="cpu"
              title="CPU Usage"
              unit="m"
              series={chartCpu}
              thresholdValue={specSummary.cpuRequest ?? undefined}
              thresholdLabel={
                specSummary.cpuRequest !== null ? `req ${specSummary.cpuRequest}m` : undefined
              }
              yMax={Math.max(50, specSummary.cpuLimit ?? 0, Math.ceil(Math.max(...chartCpu) * 1.4))}
              color="hsl(var(--primary))"
            />
            <TelemetryAreaChart
              id="memory"
              title="Memory Working Set"
              unit="Mi"
              series={chartMem}
              thresholdValue={specSummary.memRequest ?? undefined}
              thresholdLabel={
                specSummary.memRequest !== null ? `req ${Math.round(specSummary.memRequest)}Mi` : undefined
              }
              yMax={Math.max(
                64,
                specSummary.memLimit ?? 0,
                Math.ceil(Math.max(...chartMem) * 1.4),
              )}
              color="hsl(var(--success))"
            />
          </div>
        </SectionCard>
      ) : null}

      {/* Per-Node or Per-Container Live Usage & Real Manifest Quotas */}
      {isNode ? (
        <SectionCard
          title="Node Resource Breakdown"
          subtitle={name}
          icon={<Activity size={12} />}
          bodyClassName="p-0"
        >
          <div className="space-y-2 p-3 text-[11.5px]">
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono font-semibold text-foreground">{name}</span>
              <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">
                {serverAvailable ? (
                  <>
                    CPU <strong className="text-primary">{liveCpu}m</strong> · Mem{" "}
                    <strong className="text-success">{liveMem}Mi</strong>
                  </>
                ) : (
                  "Live usage unavailable"
                )}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="mb-0.5 flex justify-between font-mono text-[9.5px] text-muted-foreground">
                  <span>CPU vs Capacity</span>
                  <span>
                    {liveCpu}m / {nodeCapacity?.cpuRaw ?? "—"} CPU
                    {cpuPct !== undefined ? ` (${cpuPct}%)` : ""}
                  </span>
                </div>
                <div className="h-1 w-full overflow-hidden rounded-sm bg-secondary">
                  <div className="h-full bg-primary" style={{ width: `${cpuPct ?? 0}%` }} />
                </div>
              </div>
              <div>
                <div className="mb-0.5 flex justify-between font-mono text-[9.5px] text-muted-foreground">
                  <span>Memory vs Capacity</span>
                  <span>
                    {liveMem}Mi /{" "}
                    {nodeCapacity?.memoryMib
                      ? `${(nodeCapacity.memoryMib / 1024).toFixed(1)}Gi`
                      : "—"}
                    {memPct !== undefined ? ` (${memPct}%)` : ""}
                  </span>
                </div>
                <div className="h-1 w-full overflow-hidden rounded-sm bg-secondary">
                  <div className="h-full bg-success" style={{ width: `${memPct ?? 0}%` }} />
                </div>
              </div>
            </div>
          </div>
        </SectionCard>
      ) : (
        <SectionCard
          title="Container Resource Breakdown"
          subtitle={`${containers.length} ${containers.length === 1 ? "container" : "containers"}`}
          icon={<Boxes size={12} />}
          bodyClassName="p-0"
        >
          <div className="divide-y divide-border text-[11.5px]">
            {containers.map((c) => {
              const liveMetric = metricsData?.containers.find((m) => m.name === c.name);
              const cCpuLive = liveMetric?.cpuMillicores;
              const cMemLive = liveMetric?.memoryMib;
              const cCpuLim = parseCpuMillicoresValue(c.cpuLimit);
              const cMemLim = parseMemoryMibValue(c.memLimit);
              const cCpuBar =
                cCpuLive !== undefined && cCpuLim && cCpuLim > 0
                  ? Math.min(100, Math.round((cCpuLive / cCpuLim) * 100))
                  : 0;
              const cMemBar =
                cMemLive !== undefined && cMemLim && cMemLim > 0
                  ? Math.min(100, Math.round((cMemLive / cMemLim) * 100))
                  : 0;

              return (
                <div key={c.name} className="space-y-2 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <span className="font-mono font-semibold text-foreground">{c.name}</span>
                      <span className="ml-2 truncate font-mono text-[10px] text-muted-foreground">
                        {c.image}
                      </span>
                    </div>
                    <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">
                      {serverAvailable && cCpuLive !== undefined && cMemLive !== undefined ? (
                        <>
                          CPU <strong className="text-primary">{cCpuLive}m</strong> · Mem{" "}
                          <strong className="text-success">{cMemLive}Mi</strong>
                        </>
                      ) : (
                        "Live usage unavailable"
                      )}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <div className="mb-0.5 flex justify-between font-mono text-[9.5px] text-muted-foreground">
                        <span>CPU Request / Limit</span>
                        <span>
                          {c.cpuRequest || "—"} / {c.cpuLimit || "Unbounded"}
                        </span>
                      </div>
                      <div className="h-1 w-full overflow-hidden rounded-sm bg-secondary">
                        <div className="h-full bg-primary" style={{ width: `${cCpuBar}%` }} />
                      </div>
                    </div>
                    <div>
                      <div className="mb-0.5 flex justify-between font-mono text-[9.5px] text-muted-foreground">
                        <span>Memory Request / Limit</span>
                        <span>
                          {c.memRequest || "—"} / {c.memLimit || "Unbounded"}
                        </span>
                      </div>
                      <div className="h-1 w-full overflow-hidden rounded-sm bg-secondary">
                        <div className="h-full bg-success" style={{ width: `${cMemBar}%` }} />
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </SectionCard>
      )}
    </div>
  );
}

function TelemetryAreaChart({
  id,
  title,
  unit,
  series,
  secondarySeries,
  secondaryLabel,
  thresholdValue,
  thresholdLabel,
  yMax,
  color,
  secondaryColor,
}: {
  id: string;
  title: string;
  unit: string;
  series: number[];
  secondarySeries?: number[];
  secondaryLabel?: string;
  thresholdValue?: number;
  thresholdLabel?: string;
  yMax: number;
  color: string;
  secondaryColor?: string;
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const avg = (series.reduce((acc, v) => acc + v, 0) / series.length).toFixed(1);
  const peak = Math.max(...series).toFixed(1);
  const min = Math.min(...series).toFixed(1);
  const activeIdx = hoverIdx ?? series.length - 1;
  const activeVal = series[activeIdx] ?? 0;
  const activeSecVal = secondarySeries ? secondarySeries[activeIdx] : undefined;
  const minutesAgo = Math.round(((series.length - 1 - activeIdx) / (series.length - 1)) * 15);
  const timeTag = minutesAgo === 0 ? "Now" : `-${minutesAgo}m`;

  const toCoords = (vals: number[]) =>
    vals.map((v, i) => {
      const x = (i / (vals.length - 1)) * 400;
      const clamped = Math.max(0, Math.min(yMax, v));
      const y = 92 - (clamped / yMax) * 80;
      return { x, y };
    });

  const primaryCoords = toCoords(series);
  const primaryPoints = primaryCoords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");
  const areaPoints = `0,96 ${primaryPoints} 400,96`;

  const secondaryCoords = secondarySeries ? toCoords(secondarySeries) : null;
  const secondaryPoints = secondaryCoords
    ? secondaryCoords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ")
    : null;

  const thresholdY =
    thresholdValue && thresholdValue < yMax
      ? 92 - (thresholdValue / yMax) * 80
      : null;

  const activePoint = primaryCoords[activeIdx];

  return (
    <div className="rounded border border-border bg-background/80 p-2.5">
      {/* Chart Header */}
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-[11px]">
        <div className="flex items-center gap-2">
          <span
            className="h-2 w-2 rounded-full"
            style={{ backgroundColor: color }}
            aria-hidden="true"
          />
          <span className="font-semibold text-foreground">{title}</span>
          <span className="rounded border border-border bg-elevated px-1.5 py-0.2 font-mono text-[9.5px] text-muted-foreground">
            {unit}
          </span>
          {secondaryLabel && secondaryColor ? (
            <span className="ml-1 flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <span
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: secondaryColor }}
              />
              {secondaryLabel}
            </span>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-3 font-mono text-[10.5px]">
          <span className="rounded bg-elevated px-1.5 py-0.5 text-foreground">
            {timeTag}: <strong style={{ color }}>{activeVal}{unit}</strong>
            {activeSecVal !== undefined ? (
              <span className="ml-1.5 text-muted-foreground">
                / {activeSecVal}{unit}
              </span>
            ) : null}
          </span>
          <span className="text-muted-foreground">
            min <span className="text-foreground/90">{min}{unit}</span> · avg{" "}
            <span className="text-foreground/90">{avg}{unit}</span> · peak{" "}
            <span style={{ color }}>{peak}{unit}</span>
          </span>
        </div>
      </div>

      {/* Plot Canvas + Y-Axis */}
      <div className="flex items-stretch gap-2">
        <div className="flex w-10 shrink-0 flex-col justify-between py-0.5 text-right font-mono text-[9.5px] tabular-nums text-muted-foreground">
          <span>{yMax}{unit}</span>
          <span>{Math.round(yMax / 2)}{unit}</span>
          <span>0{unit}</span>
        </div>

        <div
          className="relative min-w-0 flex-1"
          onMouseLeave={() => setHoverIdx(null)}
        >
          <svg
            viewBox="0 0 400 100"
            preserveAspectRatio="none"
            className="h-24 w-full overflow-hidden rounded-sm border border-border/80 bg-rail/60"
          >
            <defs>
              <linearGradient id={`grad-${id}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity="0.34" />
                <stop offset="100%" stopColor={color} stopOpacity="0.02" />
              </linearGradient>
            </defs>

            {/* Horizontal reference gridlines */}
            <line x1="0" y1="12" x2="400" y2="12" stroke="hsl(var(--border))" strokeDasharray="2 3" strokeWidth="1" />
            <line x1="0" y1="52" x2="400" y2="52" stroke="hsl(var(--border))" strokeDasharray="2 3" strokeWidth="1" />
            <line x1="0" y1="92" x2="400" y2="92" stroke="hsl(var(--border))" strokeWidth="1" />

            {/* Vertical gridlines */}
            {[80, 160, 240, 320].map((vx) => (
              <line
                key={vx}
                x1={vx}
                y1="0"
                x2={vx}
                y2="100"
                stroke="hsl(var(--border) / 0.45)"
                strokeWidth="1"
              />
            ))}

            {/* Request / Limit threshold line */}
            {thresholdY !== null ? (
              <line
                x1="0"
                y1={thresholdY}
                x2="400"
                y2={thresholdY}
                stroke="hsl(var(--warning) / 0.7)"
                strokeDasharray="4 3"
                strokeWidth="1.2"
              />
            ) : null}

            {/* Primary area & line */}
            <polygon points={areaPoints} fill={`url(#grad-${id})`} />
            <polyline
              fill="none"
              stroke={color}
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
              points={primaryPoints}
            />

            {/* Optional secondary line (e.g., Network TX) */}
            {secondaryPoints && secondaryColor ? (
              <polyline
                fill="none"
                stroke={secondaryColor}
                strokeWidth="1.7"
                strokeDasharray="3 2"
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
                points={secondaryPoints}
              />
            ) : null}

            {/* Active cursor line */}
            {activePoint ? (
              <line
                x1={activePoint.x}
                y1="0"
                x2={activePoint.x}
                y2="100"
                stroke={color}
                strokeOpacity="0.45"
                strokeWidth="1.2"
                vectorEffect="non-scaling-stroke"
              />
            ) : null}
          </svg>

          {/* Threshold Badge Overlay */}
          {thresholdLabel && thresholdY !== null ? (
            <span
              className="pointer-events-none absolute right-1.5 rounded bg-background/85 px-1 font-mono text-[9px] text-warning"
              style={{ top: `${Math.max(2, thresholdY - 8)}%` }}
            >
              {thresholdLabel}
            </span>
          ) : null}

          {/* Invisible Interactive Hover Columns */}
          <div className="absolute inset-0 flex">
            {series.map((_, idx) => (
              <div
                key={idx}
                className="h-full flex-1 cursor-crosshair"
                onMouseEnter={() => setHoverIdx(idx)}
              />
            ))}
          </div>

          {/* X-Axis Timestamps */}
          <div className="mt-1 flex justify-between font-mono text-[9.5px] text-muted-foreground">
            {SAMPLE_TIME_LABELS.map((lbl, idx) => (
              <span key={`${idx}-${lbl}`}>{lbl}</span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

