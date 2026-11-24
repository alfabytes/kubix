import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Activity,
  ArrowUpRight,
  Boxes,
  ChevronDown,
  ChevronRight,
  Cpu,
  Database,
  FileKey2,
  Gauge,
  Globe,
  HardDrive,
  Layers,
  LayoutGrid,
  Maximize2,
  Minus,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Server,
} from "lucide-react";

import {
  buildNamespaceTopologyGraph,
  buildOrthogonalRoundedPath,
  buildTopologyGraph,
  defaultDetailsForNode,
  getCategoryStyle,
  type QuorumDetailRow,
  type TopologyCategory,
  type TopologyDetailRow,
  type TopologyEdge,
  type TopologyNode,
  type TopologyNodeKind,
  type VisualizerLayerPreset,
} from "@/components/ide/topology/graph-builder";
import type { NamespaceTopologyDto, ResourceSummaryDto } from "@/lib/ipc/types";
import { useExplorerStore } from "@/stores/explorer-store";

export type {
  QuorumDetailRow,
  TopologyDetailRow,
  TopologyEdge,
  TopologyNode,
  TopologyNodeKind,
  VisualizerLayerPreset,
};

export interface TopologyCanvasProps {
  contextId?: string;
  contextName?: string;
  namespace?: string;
  rows?: ResourceSummaryDto[];
  namespaceTopology?: NamespaceTopologyDto | null;
  isLoading?: boolean;
  onRefresh?: () => void;
  namespaceControl?: ReactNode;
  flush?: boolean;
  manifestYaml?: string;
  focusResource?: {
    kind: string;
    name: string;
    namespace?: string;
  };
  compact?: boolean;
  onSelectNode?: (node: TopologyNode) => void;
  onOpenNode?: (node: TopologyNode) => void;
}


function CategoryIcon({ category }: { category: TopologyCategory }) {
  switch (category) {
    case "network":
      return <Globe size={11} className="shrink-0" aria-hidden="true" />;
    case "workload":
      return <Layers size={11} className="shrink-0" aria-hidden="true" />;
    case "operator":
      return <Database size={11} className="shrink-0" aria-hidden="true" />;
    case "config":
      return <FileKey2 size={11} className="shrink-0" aria-hidden="true" />;
    case "runtime":
    default:
      return <Cpu size={11} className="shrink-0" aria-hidden="true" />;
  }
}


export function TopologyCanvas({
  contextId,
  namespace,
  rows,
  namespaceTopology,
  isLoading = false,
  onRefresh,
  namespaceControl,
  flush = false,
  manifestYaml,
  focusResource,
  compact = false,
  onSelectNode,
  onOpenNode,
}: TopologyCanvasProps) {
  const allViews = useExplorerStore((s) => s.views);
  const isNamespaceMode = namespaceTopology !== undefined;

  const [layerPreset, setLayerPreset] = useState<VisualizerLayerPreset>("full");
  const [expandedWorkloads, setExpandedWorkloads] = useState<Set<string>>(() => new Set());
  const [expandAllPods, setExpandAllPods] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  // Reset per-workload expanded pods when switching context/namespace
  useEffect(() => {
    setExpandedWorkloads(new Set());
    setExpandAllPods(false);
  }, [contextId, namespace]);

  const toggleWorkloadPods = (workloadId: string) => {
    setExpandedWorkloads((prev) => {
      const next = new Set(prev);
      if (next.has(workloadId)) {
        next.delete(workloadId);
      } else {
        next.add(workloadId);
      }
      return next;
    });
  };

  // Merge explicitly passed rows with any loaded resource views for this context
  const mergedRows = useMemo(() => {
    const byUid = new Map<string, ResourceSummaryDto>();
    for (const r of rows ?? []) {
      byUid.set(r.uid, r);
    }
    if (contextId) {
      const prefix = `${contextId}\u0000`;
      for (const [key, entry] of Object.entries(allViews)) {
        if (!key.startsWith(prefix)) continue;
        for (const r of entry.rows) {
          if (namespace && r.namespace && r.namespace !== namespace) continue;
          if (!byUid.has(r.uid)) byUid.set(r.uid, r);
        }
      }
    }
    return [...byUid.values()];
  }, [rows, allViews, contextId, namespace]);

  const initialGraph = useMemo(() => {
    if (namespaceTopology) {
      return buildNamespaceTopologyGraph(
        namespaceTopology,
        layerPreset,
        expandedWorkloads,
        expandAllPods,
        searchQuery,
      );
    }
    return buildTopologyGraph(mergedRows, focusResource, manifestYaml);
  }, [
    namespaceTopology,
    layerPreset,
    expandedWorkloads,
    expandAllPods,
    searchQuery,
    mergedRows,
    focusResource,
    manifestYaml,
  ]);

  const hasCollapsiblePods = useMemo(
    () =>
      Boolean(
        namespaceTopology?.nodes.some(
          (n) => n.layer === "workload" && (n.podCount ?? 0) > 0,
        ),
      ),
    [namespaceTopology],
  );

  const [nodes, setNodes] = useState<TopologyNode[]>(initialGraph.nodes);
  const edges = initialGraph.edges;

  useEffect(() => {
    setNodes(initialGraph.nodes);
  }, [initialGraph]);

  const [zoom, setZoom] = useState(compact ? 0.85 : 0.9);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const panRef = useRef(pan);
  panRef.current = pan;
  const [selectedId, setSelectedId] = useState<string | null>(initialGraph.nodes[0]?.id ?? null);
  const [categoryFilter, setCategoryFilter] = useState<TopologyCategory | null>(null);

  const canvasRef = useRef<HTMLDivElement>(null);
  const transformLayerRef = useRef<HTMLDivElement>(null);
  const [wheelActive, setWheelActive] = useState(false);

  const [canvasDrag, setCanvasDrag] = useState<{
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null>(null);

  const [nodeDrag, setNodeDrag] = useState<{
    id: string;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null>(null);

  // Track active drags at the window level so releasing outside the canvas or over a child
  // never leaves the canvas stuck in a dragging state. Apply canvas pan directly via refs
  // for zero-jank 120fps movement, committing React state on release.
  useEffect(() => {
    if (!canvasDrag && !nodeDrag) return;
    const commitAndStop = () => {
      if (canvasDrag) {
        setPan(panRef.current);
      }
      setCanvasDrag(null);
      setNodeDrag(null);
    };
    const handleMove = (e: PointerEvent) => {
      if (e.pointerType === "mouse" && (e.buttons & 1) === 0) {
        commitAndStop();
        return;
      }
      if (nodeDrag) {
        const dx = (e.clientX - nodeDrag.startX) / zoom;
        const dy = (e.clientY - nodeDrag.startY) / zoom;
        setNodes((prev) =>
          prev.map((n) =>
            n.id === nodeDrag.id
              ? { ...n, x: Math.round(nodeDrag.origX + dx), y: Math.round(nodeDrag.origY + dy) }
              : n,
          ),
        );
        return;
      }
      if (canvasDrag) {
        const nextX = canvasDrag.origX + (e.clientX - canvasDrag.startX);
        const nextY = canvasDrag.origY + (e.clientY - canvasDrag.startY);
        panRef.current = { x: nextX, y: nextY };
        if (transformLayerRef.current) {
          transformLayerRef.current.style.transform = `translate3d(${nextX}px, ${nextY}px, 0) scale(${zoom})`;
        }
        if (canvasRef.current) {
          canvasRef.current.style.backgroundPosition = `${nextX}px ${nextY}px`;
        }
      }
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", commitAndStop);
    window.addEventListener("pointercancel", commitAndStop);
    window.addEventListener("blur", commitAndStop);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", commitAndStop);
      window.removeEventListener("pointercancel", commitAndStop);
      window.removeEventListener("blur", commitAndStop);
    };
  }, [canvasDrag, nodeDrag, zoom]);

  // Native-feeling trackpad two-finger panning and pinch-to-zoom.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    let wheelTimer: ReturnType<typeof setTimeout> | null = null;
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      setWheelActive(true);
      if (wheelTimer) clearTimeout(wheelTimer);
      wheelTimer = setTimeout(() => setWheelActive(false), 120);

      if (e.ctrlKey || e.metaKey) {
        const delta = -e.deltaY * 0.004;
        setZoom((z) => Math.max(0.4, Math.min(1.8, Number((z + delta).toFixed(3)))));
      } else {
        setPan((prev) => ({
          x: prev.x - e.deltaX,
          y: prev.y - e.deltaY,
        }));
      }
    };
    el.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", handleWheel);
      if (wheelTimer) clearTimeout(wheelTimer);
    };
  }, []);

  const isInteracting = Boolean(canvasDrag || nodeDrag || wheelActive);

  const visibleNodes = useMemo(
    () =>
      !isNamespaceMode && categoryFilter
        ? nodes.filter((n) => getCategoryStyle(n.kind).category === categoryFilter)
        : nodes,
    [nodes, categoryFilter, isNamespaceMode],
  );
  const visibleIds = useMemo(() => new Set(visibleNodes.map((n) => n.id)), [visibleNodes]);
  const visibleEdges = useMemo(
    () => edges.filter((e) => visibleIds.has(e.from) && visibleIds.has(e.to)),
    [edges, visibleIds],
  );

  const NODE_W = 248;

  function estimateCardHeight(node: TopologyNode): number {
    const count = node.details?.length ?? 3;
    const hasPodFooter =
      isNamespaceMode &&
      layerPreset === "full" &&
      node.layer === "workload" &&
      (node.podCount ?? 0) > 0;
    return 66 + count * 25 + (hasPodFooter ? 28 : 0);
  }

  function resetLayout() {
    setNodes(initialGraph.nodes);
    setPan({ x: 0, y: 0 });
    setCategoryFilter(null);
    if (isNamespaceMode) {
      setLayerPreset("full");
      setSearchQuery("");
      setExpandedWorkloads(new Set());
      setExpandAllPods(false);
    }
  }

  return (
    <div
      data-testid="topology-canvas"
      className={`relative flex h-full min-h-[340px] flex-col overflow-hidden bg-background select-none ${
        flush ? "" : "rounded-md border border-border"
      }`}
    >
      {/* Kubix Integrated Topology Toolbar */}
      <div
        data-topology-hud="toolbar"
        className={`flex min-h-[42px] shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border bg-panel px-3 py-1.5 text-[11px]`}
      >
        <div className="flex flex-wrap items-center gap-2">
          {!compact ? (
            isNamespaceMode ? (
              <h1 className="text-[14px] font-semibold tracking-tight text-foreground">
                Visualizer
              </h1>
            ) : (
              <span className="mr-1 font-mono text-[11px] font-semibold text-foreground">
                {focusResource ? focusResource.name : "Visualizer"}
                {!namespaceControl ? (
                  <span className="ml-1.5 font-normal text-muted-foreground">
                    ({namespace ? `ns:${namespace}` : "all-ns"})
                  </span>
                ) : null}
              </span>
            )
          ) : null}

          {namespaceControl}

          {isNamespaceMode ? (
            <>
              <div
                className="flex items-center rounded border border-border bg-elevated p-0.5 text-[10.5px]"
                data-testid="visualizer-layer-presets"
              >
                {(
                  [
                    { id: "full", label: "Full" },
                    { id: "traffic", label: "Traffic" },
                    { id: "ingress-gateway", label: "Ingress & Gateway" },
                  ] as const
                ).map((item) => {
                  const active = layerPreset === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setLayerPreset(item.id)}
                      className={`rounded-sm px-2 py-0.5 transition-colors ${
                        active
                          ? "bg-primary/20 font-semibold text-primary"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {item.label}
                    </button>
                  );
                })}
              </div>

              {layerPreset === "full" && hasCollapsiblePods ? (
                <button
                  type="button"
                  data-testid="visualizer-toggle-all-pods"
                  onClick={() => setExpandAllPods((v) => !v)}
                  className={`rounded border px-2 py-0.5 text-[10.5px] transition-colors ${
                    expandAllPods
                      ? "border-emerald-500/45 bg-emerald-500/10 font-medium text-emerald-400"
                      : "border-border bg-elevated text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {expandAllPods ? "Collapse Pods" : "Expand Pods"}
                </button>
              ) : null}

              <div className="relative">
                <Search
                  size={11}
                  className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground"
                  aria-hidden="true"
                />
                <input
                  type="search"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Filter graph…"
                  aria-label="Filter visualizer graph"
                  className="h-6 w-36 rounded border border-border bg-background pl-6 pr-2 font-mono text-[10.5px] text-foreground placeholder:text-muted-foreground focus:border-primary/70 focus:outline-none"
                />
              </div>

              {namespaceTopology?.gatewayApiDetected ? (
                <span
                  data-testid="visualizer-gateway-badge"
                  title={`Detected Gateway API: ${namespaceTopology.gatewayApiKinds.join(", ")}`}
                  className="inline-flex items-center gap-1 rounded border border-cyan-500/35 bg-cyan-500/10 px-1.5 py-0.5 font-mono text-[10px] font-medium text-cyan-400"
                >
                  <Globe size={10} aria-hidden="true" />
                  Gateway API
                </span>
              ) : null}
            </>
          ) : (
            <div className="flex items-center rounded border border-border bg-elevated p-0.5 text-[10.5px]">
              {(
                [
                  { id: null, label: "All" },
                  { id: "workload", label: "Workloads" },
                  { id: "runtime", label: "Runtime" },
                  { id: "network", label: "Network" },
                  { id: "config", label: "Config" },
                ] as const
              ).map((item) => {
                const active = categoryFilter === item.id;
                return (
                  <button
                    key={item.label}
                    type="button"
                    onClick={() => setCategoryFilter(item.id)}
                    className={`rounded-sm px-2 py-0.5 transition-colors ${
                      active
                        ? "bg-primary/20 font-semibold text-primary"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {item.label}
                  </button>
                );
              })}
            </div>
          )}

          <span className="hidden font-mono text-[10px] text-muted-foreground sm:inline">
            {visibleNodes.length} {visibleNodes.length === 1 ? "object" : "objects"} ·{" "}
            {visibleEdges.length} {visibleEdges.length === 1 ? "link" : "links"}
          </span>
        </div>

        <div className="flex items-center gap-1">
          {onRefresh ? (
            <button
              type="button"
              aria-label="Refresh topology"
              title="Refresh topology"
              onClick={onRefresh}
              className="flex h-6 w-6 items-center justify-center rounded border border-border bg-elevated text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
            >
              <RefreshCw size={11} className={isLoading ? "animate-spin text-primary" : undefined} />
            </button>
          ) : null}
          <button
            type="button"
            aria-label="Zoom out"
            onClick={() => setZoom((z) => Math.max(0.5, Number((z - 0.1).toFixed(2))))}
            className="flex h-6 w-6 items-center justify-center rounded border border-border bg-elevated text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
          >
            <Minus size={12} />
          </button>
          <span className="min-w-[2.5rem] text-center font-mono text-[10.5px] font-semibold tabular-nums text-foreground">
            {Math.round(zoom * 100)}%
          </span>
          <button
            type="button"
            aria-label="Zoom in"
            onClick={() => setZoom((z) => Math.min(1.6, Number((z + 0.1).toFixed(2))))}
            className="flex h-6 w-6 items-center justify-center rounded border border-border bg-elevated text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
          >
            <Plus size={12} />
          </button>
          <button
            type="button"
            aria-label="Fit to screen"
            title="Fit to screen"
            onClick={() => {
              setZoom(compact ? 0.85 : 0.9);
              setPan({ x: 0, y: 0 });
            }}
            className="flex h-6 w-6 items-center justify-center rounded border border-border bg-elevated text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
          >
            <Maximize2 size={11} />
          </button>
          <button
            type="button"
            aria-label="Reset view"
            title="Reset layout"
            onClick={() => {
              setZoom(compact ? 0.85 : 0.9);
              resetLayout();
            }}
            className="flex h-6 items-center gap-1 rounded border border-border bg-elevated px-2 text-[10.5px] text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
          >
            <LayoutGrid size={11} />
            <RotateCcw size={10} />
          </button>
        </div>
      </div>

      {/* Kubix Blueprint Grid Canvas */}
      <div
        ref={canvasRef}
        data-testid="topology-viewport"
        className="relative min-h-0 flex-1 touch-none overflow-hidden"
        style={{
          cursor: canvasDrag || nodeDrag ? "grabbing" : "grab",
          backgroundImage:
            "linear-gradient(to right, hsl(var(--border) / 0.32) 1px, transparent 1px), linear-gradient(to bottom, hsl(var(--border) / 0.32) 1px, transparent 1px)",
          backgroundSize: `${28 * zoom}px ${28 * zoom}px`,
          backgroundPosition: `${pan.x}px ${pan.y}px`,
        }}
        onPointerDown={(e) => {
          if (typeof e.button === "number" && e.button !== 0) return;
          if ((e.target as HTMLElement).closest("[data-topology-node]")) return;
          if ((e.target as HTMLElement).closest("[data-topology-hud]")) return;
          e.preventDefault();
          setCanvasDrag({
            startX: e.clientX,
            startY: e.clientY,
            origX: panRef.current.x,
            origY: panRef.current.y,
          });
        }}
      >
        {/* Transformed Graph Layer */}
        <div
          ref={transformLayerRef}
          data-testid="topology-transform-layer"
          className={`absolute inset-0 origin-top-left ${
            isInteracting ? "will-change-transform" : "transition-transform duration-150"
          }`}
          style={{
            transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})`,
          }}
        >
          {/* Static Orthogonal Rounded-Elbow Connector Lines (No Arrow, No Traffic Animation) */}
          <svg
            width="1300"
            height="720"
            className="pointer-events-none absolute left-0 top-0 overflow-visible"
            aria-hidden="true"
          >
            {visibleEdges.map((edge) => {
              const from = nodes.find((n) => n.id === edge.from);
              const to = nodes.find((n) => n.id === edge.to);
              if (!from || !to) return null;

              const fromStyle = getCategoryStyle(from.kind);
              const fromH = estimateCardHeight(from);
              const toH = estimateCardHeight(to);

              const x1 = from.x + NODE_W;
              const y1 = from.y + Math.min(82, fromH * 0.5);
              const x2 = to.x;
              const y2 = to.y + Math.min(64, toH * 0.42);

              const { d, labelX, labelY } = buildOrthogonalRoundedPath(x1, y1, x2, y2);
              const highlighted = selectedId === edge.from || selectedId === edge.to;

              return (
                <g key={edge.id} data-testid={`topology-edge-${edge.id}`}>
                  <path
                    d={d}
                    fill="none"
                    stroke={highlighted ? fromStyle.accentHex : "hsl(var(--border-strong))"}
                    strokeOpacity={highlighted ? 0.28 : 0.55}
                    strokeWidth={6}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <path
                    d={d}
                    fill="none"
                    stroke={
                      highlighted ? fromStyle.accentHex : "hsl(var(--muted-foreground) / 0.6)"
                    }
                    strokeWidth={1.8}
                    strokeDasharray={edge.crossNamespace ? "5 4" : undefined}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <circle
                    cx={x1}
                    cy={y1}
                    r="3.8"
                    fill={fromStyle.accentHex}
                    stroke="hsl(var(--card))"
                    strokeWidth="1.5"
                  />
                  <circle
                    cx={x2}
                    cy={y2}
                    r="3.8"
                    fill="hsl(var(--card))"
                    stroke={highlighted ? fromStyle.accentHex : "hsl(var(--muted-foreground))"}
                    strokeWidth="1.6"
                  />
                  {edge.label ? (
                    <g transform={`translate(${labelX}, ${labelY})`}>
                      <rect
                        x={-(edge.label.length * 3.2 + 8)}
                        y={-9}
                        width={edge.label.length * 6.4 + 16}
                        height={18}
                        rx={4}
                        fill="hsl(var(--panel))"
                        stroke={
                          highlighted ? fromStyle.accentHex : "hsl(var(--border))"
                        }
                        strokeOpacity={highlighted ? 0.55 : 1}
                        strokeWidth={1}
                      />
                      <text
                        textAnchor="middle"
                        dominantBaseline="central"
                        fill={
                          highlighted ? fromStyle.accentHex : "hsl(var(--muted-foreground))"
                        }
                        fontSize="9.5"
                        fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                      >
                        {edge.label}
                      </text>
                    </g>
                  ) : null}
                </g>
              );
            })}
          </svg>

          {/* Kubix Kubernetes Blueprint Node Cards */}
          {visibleNodes.map((node) => {
            const selected = selectedId === node.id;
            const style = getCategoryStyle(node.kind);
            const detailRows = defaultDetailsForNode(node);

            return (
              <div
                key={node.id}
                data-topology-node={node.id}
                onClick={() => {
                  setSelectedId(node.id);
                  onSelectNode?.(node);
                }}
                onPointerDown={(e) => {
                  if (typeof e.button === "number" && e.button !== 0) return;
                  e.stopPropagation();
                  e.preventDefault();
                  setSelectedId(node.id);
                  setNodeDrag({
                    id: node.id,
                    startX: e.clientX,
                    startY: e.clientY,
                    origX: node.x,
                    origY: node.y,
                  });
                }}
                style={{
                  left: node.x,
                  top: node.y,
                  width: NODE_W,
                  borderLeftColor: style.accentHex,
                }}
                className={`group absolute cursor-grab overflow-hidden rounded-md border border-l-[3px] bg-card text-left shadow-md transition-shadow active:cursor-grabbing ${
                  selected || node.isFocus
                    ? "border-primary/80 ring-1 ring-primary/35 shadow-lg"
                    : "border-border-strong hover:border-primary/45"
                }`}
              >
                {/* Compact Kubernetes Card Header */}
                <div className="border-b border-border/70 bg-elevated/60 px-2.5 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span
                      title={node.kind}
                      className={`inline-flex max-w-[116px] items-center gap-1 truncate rounded border px-1.5 py-0.2 font-mono text-[9.5px] font-semibold uppercase tracking-wide ${style.badgeClass}`}
                    >
                      <CategoryIcon category={style.category} />
                      <span className="truncate">
                        {node.kind === "PersistentVolumeClaim"
                          ? "PVC"
                          : node.kind === "HorizontalPodAutoscaler"
                            ? "HPA"
                            : node.kind === "Certificate"
                              ? "CERT"
                              : node.kind}
                      </span>
                    </span>
                    <div className="flex items-center gap-1.5">
                      {onOpenNode && !node.isFocus && !node.isPlaceholder ? (
                        <button
                          type="button"
                          data-testid={`topology-open-node-${node.id}`}
                          title={`Open ${node.kind} ${node.name}`}
                          aria-label={`Open ${node.kind} ${node.name}`}
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpenNode(node);
                          }}
                          className="inline-flex items-center gap-0.5 rounded border border-border bg-background/80 px-1.5 py-0.5 font-mono text-[9.5px] text-muted-foreground transition-colors hover:border-primary/60 hover:text-primary"
                        >
                          Open
                          <ArrowUpRight size={10} aria-hidden="true" />
                        </button>
                      ) : null}
                      <span
                        className={`inline-flex items-center gap-1 font-mono text-[10px] font-medium ${
                          node.status === "Error"
                            ? "text-destructive"
                            : node.status === "Warning"
                              ? "text-warning"
                              : "text-success"
                        }`}
                      >
                        <span
                          className={`h-1.5 w-1.5 rounded-full ${
                            node.status === "Error"
                              ? "bg-destructive"
                              : node.status === "Warning"
                                ? "bg-warning"
                                : "bg-success"
                          }`}
                        />
                        {node.status}
                      </span>
                    </div>
                  </div>
                  <div className="mt-1 flex items-baseline justify-between gap-2">
                    <span
                      className="truncate font-mono text-[12px] font-semibold text-foreground"
                      title={`${node.kind}: ${node.name}`}
                    >
                      {node.name}
                    </span>
                    {node.namespace ? (
                      <span
                        className={`shrink-0 font-mono text-[9.5px] ${
                          node.external
                            ? "rounded border border-cyan-500/35 bg-cyan-500/10 px-1 text-cyan-400"
                            : "text-muted-foreground"
                        }`}
                        title={node.external ? `Cross-namespace (${node.namespace})` : node.namespace}
                      >
                        {node.external ? `ns/${node.namespace}` : node.namespace}
                      </span>
                    ) : null}
                  </div>
                </div>

                {/* Spec & Runtime Key-Value Properties */}
                <div className="divide-y divide-border/50 px-2.5 py-1 font-mono text-[10.5px]">
                  {detailRows.map((row) => (
                    <div key={row.label} className="py-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex shrink-0 items-center gap-1 font-sans text-[10.5px] text-muted-foreground">
                          {row.icon === "kind" ? (
                            <Boxes size={10} className="shrink-0 opacity-70" />
                          ) : row.icon === "scope" ? (
                            <Server size={10} className="shrink-0 opacity-70" />
                          ) : row.icon === "image" ? (
                            <HardDrive size={10} className="shrink-0 opacity-70" />
                          ) : row.icon === "net" ? (
                            <Gauge size={10} className="shrink-0 opacity-70" />
                          ) : (
                            <Activity size={10} className="shrink-0 opacity-70" />
                          )}
                          <span>{row.label}</span>
                        </span>
                        <span
                          title={row.value}
                          className={`truncate font-medium tabular-nums ${
                            row.tone === "positive"
                              ? "text-success"
                              : row.tone === "warn"
                                ? "text-warning"
                                : "text-foreground"
                          }`}
                        >
                          {row.value}
                        </span>
                      </div>

                      {typeof row.progressPct === "number" ? (
                        <div className="mt-1 h-0.5 w-full overflow-hidden rounded-full bg-secondary">
                          <div
                            className="h-full rounded-full"
                            style={{
                              width: `${Math.max(8, Math.min(100, row.progressPct))}%`,
                              backgroundColor: style.accentHex,
                            }}
                          />
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>

                {isNamespaceMode &&
                layerPreset === "full" &&
                node.layer === "workload" &&
                typeof node.podCount === "number" &&
                node.podCount > 0 ? (
                  <div className="border-t border-border/70 bg-elevated/40 px-2.5 py-1">
                    <button
                      type="button"
                      data-testid={`topology-toggle-pods-${node.id}`}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleWorkloadPods(node.id);
                      }}
                      className="flex w-full items-center justify-between font-mono text-[10px] text-emerald-400 transition-colors hover:text-emerald-300"
                    >
                      <span className="inline-flex items-center gap-1">
                        {expandAllPods || expandedWorkloads.has(node.id) ? (
                          <ChevronDown size={11} aria-hidden="true" />
                        ) : (
                          <ChevronRight size={11} aria-hidden="true" />
                        )}
                        {node.readyPodCount ?? node.podCount}/{node.podCount}{" "}
                        {node.podCount === 1 ? "Pod" : "Pods"}
                      </span>
                      <span className="text-[9.5px] text-muted-foreground">
                        {expandAllPods || expandedWorkloads.has(node.id) ? "Hide" : "Expand"}
                      </span>
                    </button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>

        {isNamespaceMode && isLoading && visibleNodes.length === 0 ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="flex items-center gap-2 rounded-md border border-border bg-panel/95 px-3 py-2 text-xs text-muted-foreground shadow-sm">
              <RefreshCw size={13} className="animate-spin text-primary" aria-hidden="true" />
              Loading live namespace topology…
            </div>
          </div>
        ) : isNamespaceMode && !isLoading && visibleNodes.length === 0 ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="rounded-md border border-border bg-panel/95 px-4 py-3 text-center text-xs text-muted-foreground shadow-sm">
              No resources match the current namespace &amp; layer filter.
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
