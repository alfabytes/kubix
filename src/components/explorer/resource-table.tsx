import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  MoreHorizontal,
  RefreshCw,
  SearchX,
} from "lucide-react";

import type { DiscoveredResourceDto, ResourceSummaryDto } from "@/lib/ipc/types";
import { deriveRowTelemetry, type RowTelemetry } from "@/lib/resource-telemetry";
import { formatTimestamp } from "@/lib/utils";
import type { ResourceView } from "@/stores/explorer-store";

export type SortColumnKey =
  | "status"
  | "name"
  | "namespace"
  | "containers"
  | "restarts"
  | "controlledBy"
  | "node"
  | "pods"
  | "taints"
  | "detail"
  | "uid"
  | "age";

export type SortDirection = "asc" | "desc";

export interface TableSortState {
  key: SortColumnKey;
  direction: SortDirection;
}

export interface ResourceTableProps {
  resource: DiscoveredResourceDto | null;
  view: ResourceView;
  isFetching: boolean;
  error: string | null;
  selectedName: string | null;
  selectedUid?: string | null;
  filterActive?: boolean;
  hideMetaBar?: boolean;
  sort?: TableSortState | null;
  onSortChange?: (next: TableSortState | null) => void;
  checkedUids?: Set<string>;
  onToggleCheck?: (uid: string) => void;
  onSelect: (row: ResourceSummaryDto) => void;
}

const ROW_HEIGHT = 33;
const OVERSCAN = 8;

const WORKLOAD_RATIO_KINDS = new Set([
  "Deployment",
  "StatefulSet",
  "DaemonSet",
  "ReplicaSet",
  "ReplicationController",
  "Job",
  "CronJob",
]);

function deriveDetailSummary(row: ResourceSummaryDto, telemetry: RowTelemetry): string {
  return (
    telemetry.message ||
    (telemetry.node !== "—" ? telemetry.node : "") ||
    (Object.keys(row.labels ?? {}).length > 0
      ? `${Object.keys(row.labels).length} labels`
      : "—")
  );
}

function formatControllerKind(controlledBy: string): string {
  if (!controlledBy || controlledBy === "—") return "—";
  const slashIdx = controlledBy.indexOf("/");
  return slashIdx > 0 ? controlledBy.slice(0, slashIdx) : controlledBy;
}

function compareText(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

function compareOptionalText(a: string, b: string, dir: number): number {
  const aEmpty = !a || a === "—";
  const bEmpty = !b || b === "—";
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;
  if (bEmpty) return -1;
  return compareText(a, b) * dir;
}

export function sortResourceRows(
  rows: ResourceSummaryDto[],
  sort: TableSortState | null | undefined,
): ResourceSummaryDto[] {
  if (!sort || rows.length <= 1) return rows;
  const dir = sort.direction === "asc" ? 1 : -1;
  const decorated = rows.map((row) => ({
    row,
    telemetry: deriveRowTelemetry(row),
  }));

  decorated.sort((left, right) => {
    const a = left.row;
    const b = right.row;
    const ta = left.telemetry;
    const tb = right.telemetry;
    let cmp = 0;

    switch (sort.key) {
      case "status":
        cmp = compareText(ta.statusText, tb.statusText) * dir;
        break;
      case "name":
        cmp = compareText(a.name, b.name) * dir;
        break;
      case "namespace":
        cmp = compareOptionalText(a.namespace ?? "", b.namespace ?? "", dir);
        break;
      case "containers":
      case "pods": {
        const ratioA = ta.containerCount > 0 ? ta.readyCount / ta.containerCount : 0;
        const ratioB = tb.containerCount > 0 ? tb.readyCount / tb.containerCount : 0;
        cmp =
          (ratioA - ratioB ||
            ta.readyCount - tb.readyCount ||
            ta.containerCount - tb.containerCount) * dir;
        break;
      }
      case "restarts":
        cmp = (ta.restarts - tb.restarts) * dir;
        break;
      case "controlledBy":
        cmp =
          compareOptionalText(
            formatControllerKind(ta.controlledBy),
            formatControllerKind(tb.controlledBy),
            dir,
          ) || compareOptionalText(ta.controlledBy, tb.controlledBy, dir);
        break;
      case "node":
        cmp = compareOptionalText(ta.node, tb.node, dir);
        break;
      case "taints":
        cmp = ((a.taints ?? 0) - (b.taints ?? 0)) * dir;
        break;
      case "detail":
        cmp = compareOptionalText(
          deriveDetailSummary(a, ta),
          deriveDetailSummary(b, tb),
          dir,
        );
        break;
      case "uid":
        cmp = compareText(a.uid, b.uid) * dir;
        break;
      case "age": {
        const tsA = a.createdAt ? Date.parse(a.createdAt) : Number.NaN;
        const tsB = b.createdAt ? Date.parse(b.createdAt) : Number.NaN;
        const validA = Number.isFinite(tsA);
        const validB = Number.isFinite(tsB);
        if (!validA && !validB) {
          cmp = 0;
        } else if (!validA) {
          cmp = 1;
        } else if (!validB) {
          cmp = -1;
        } else {
          // Ascending Age puts youngest resources (largest createdAt) first: e.g. 10s -> 2m -> 3d.
          cmp = (tsB - tsA) * dir;
        }
        break;
      }
    }

    if (cmp !== 0) return cmp;
    return (
      compareText(a.namespace ?? "", b.namespace ?? "") ||
      compareText(a.name, b.name) ||
      compareText(a.uid, b.uid)
    );
  });

  return decorated.map((item) => item.row);
}

export function nextSortState(
  current: TableSortState | null | undefined,
  key: SortColumnKey,
): TableSortState | null {
  if (!current || current.key !== key) {
    return { key, direction: "asc" };
  }
  if (current.direction === "asc") {
    return { key, direction: "desc" };
  }
  return null;
}

function SortableColumnHeader({
  label,
  colKey,
  sort,
  onToggle,
  className = "",
}: {
  label: string;
  colKey: SortColumnKey;
  sort: TableSortState | null;
  onToggle: (key: SortColumnKey) => void;
  className?: string;
}) {
  const active = sort?.key === colKey;
  const ariaSort = active
    ? sort.direction === "asc"
      ? "ascending"
      : "descending"
    : "none";

  return (
    <span role="columnheader" aria-sort={ariaSort} className={className}>
      <button
        type="button"
        onClick={() => onToggle(colKey)}
        data-testid={`sort-col-${colKey}`}
        className={`group flex w-full items-center justify-between gap-1 text-left transition-colors hover:text-foreground ${
          active ? "font-semibold text-foreground" : ""
        }`}
      >
        <span className="truncate">{label}</span>
        {active ? (
          sort.direction === "asc" ? (
            <ArrowUp size={11} className="shrink-0 text-primary" aria-hidden="true" />
          ) : (
            <ArrowDown size={11} className="shrink-0 text-primary" aria-hidden="true" />
          )
        ) : (
          <ArrowUpDown
            size={10}
            className="shrink-0 opacity-0 transition-opacity group-hover:opacity-60"
            aria-hidden="true"
          />
        )}
      </button>
    </span>
  );
}

/** The header is outside the scroll transform; only rows are windowed. */
export function ResourceTable({
  resource,
  view,
  isFetching,
  error,
  selectedName,
  selectedUid,
  filterActive,
  hideMetaBar = false,
  sort: controlledSort,
  onSortChange,
  checkedUids,
  onToggleCheck,
  onSelect,
}: ResourceTableProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(640);
  const [internalSort, setInternalSort] = useState<TableSortState | null>(null);

  const activeSort = controlledSort !== undefined ? controlledSort : internalSort;

  const handleToggleSort = (key: SortColumnKey) => {
    const next = nextSortState(activeSort, key);
    if (onSortChange) {
      onSortChange(next);
    } else {
      setInternalSort(next);
    }
  };

  useEffect(() => {
    const element = scrollerRef.current;
    if (!element) return;
    const measure = () => setViewportHeight(element.clientHeight || 640);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [resource?.gvr]);

  useEffect(() => {
    setScrollTop(0);
    scrollerRef.current?.scrollTo({ top: 0 });
  }, [resource?.gvr, view.namespace, filterActive, activeSort?.key, activeSort?.direction]);

  const sortedRows = useMemo(
    () => sortResourceRows(view.rows, activeSort),
    [view.rows, activeSort],
  );

  if (!resource) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        Select a resource type.
      </div>
    );
  }

  const rows = sortedRows;
  const showNamespace = resource.namespaced;
  const mode: "pod" | "workload" | "node" | "generic" =
    resource.kind === "Pod"
      ? "pod"
      : resource.kind === "Node"
        ? "node"
        : WORKLOAD_RATIO_KINDS.has(resource.kind)
          ? "workload"
          : "generic";

  const columns =
    mode === "pod"
      ? showNamespace
        ? "28px minmax(88px,0.85fr) minmax(200px,2.4fr) minmax(115px,1.1fr) minmax(94px,0.85fr) minmax(74px,0.65fr) minmax(100px,0.9fr) minmax(135px,1.25fr) minmax(68px,0.6fr) 34px"
        : "28px minmax(88px,0.85fr) minmax(220px,2.7fr) minmax(94px,0.85fr) minmax(74px,0.65fr) minmax(100px,0.9fr) minmax(135px,1.25fr) minmax(68px,0.6fr) 34px"
      : mode === "workload"
        ? showNamespace
          ? "28px minmax(88px,0.85fr) minmax(210px,2.6fr) minmax(120px,1.15fr) minmax(90px,0.8fr) minmax(105px,0.95fr) minmax(74px,0.7fr) 34px"
          : "28px minmax(88px,0.85fr) minmax(230px,2.9fr) minmax(90px,0.8fr) minmax(105px,0.95fr) minmax(74px,0.7fr) 34px"
        : mode === "node"
          ? "28px minmax(88px,0.8fr) minmax(220px,2.5fr) minmax(78px,0.65fr) minmax(145px,1.3fr) minmax(72px,0.65fr) minmax(96px,0.8fr) 34px"
          : showNamespace
            ? "28px minmax(88px,0.85fr) minmax(200px,2.3fr) minmax(120px,1.15fr) minmax(150px,1.5fr) minmax(72px,0.7fr) minmax(96px,0.85fr) 34px"
            : "28px minmax(88px,0.85fr) minmax(220px,2.6fr) minmax(150px,1.5fr) minmax(72px,0.7fr) minmax(96px,0.85fr) 34px";

  const minTableWidth = showNamespace ? "820px" : "700px";

  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const count = Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN * 2;
  const windowRows = rows.slice(first, first + count);

  return (
    <div className="flex h-full min-w-0 flex-col bg-background" data-testid="resource-table">
      {!hideMetaBar ? (
        <div className="flex h-7 shrink-0 items-center justify-between border-b border-border bg-panel/70 px-3 text-[11px] text-muted-foreground">
          <span data-testid="row-count" className="font-mono tabular-nums">
            {rows.length} {rows.length === 1 ? "item" : "items"}
            {filterActive ? " matching loaded rows" : ""}
            {view.truncated ? " / live stream truncated" : ""}
          </span>
          <span className="flex items-center gap-1.5 font-mono text-[10.5px]">
            {isFetching ? (
              <RefreshCw size={11} className="animate-spin text-primary" aria-label="Loading" />
            ) : view.status === "ready" ? (
              <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden="true" />
            ) : null}
            {isFetching ? "Syncing" : view.status === "ready" ? "Live watch" : view.status}
          </span>
        </div>
      ) : null}

      {error && view.status === "error" ? (
        <div
          role="alert"
          data-testid="list-error"
          className="m-3 flex gap-2 rounded border border-destructive/40 border-l-2 border-l-destructive bg-destructive/10 p-2.5 text-xs text-destructive"
        >
          <AlertCircle size={14} className="shrink-0" />
          {error}
        </div>
      ) : null}

      {/* Sticky Column Headers with Vertical Dividers */}
      <div
        ref={headerRef}
        className="min-w-0 shrink-0 overflow-hidden border-b border-border bg-panel"
      >
        <div style={{ minWidth: minTableWidth }}>
          <div
            role="row"
            className="grid h-8 items-center px-3 text-[11px] font-medium text-muted-foreground select-none"
            style={{ gridTemplateColumns: columns }}
          >
            <span role="columnheader" aria-label="Select" />
            <SortableColumnHeader
              label="Status"
              colKey="status"
              sort={activeSort}
              onToggle={handleToggleSort}
              className="border-r border-border/60 pr-2"
            />
            <SortableColumnHeader
              label="Name"
              colKey="name"
              sort={activeSort}
              onToggle={handleToggleSort}
              className="border-r border-border/60 px-2"
            />
            {showNamespace ? (
              <SortableColumnHeader
                label="Namespace"
                colKey="namespace"
                sort={activeSort}
                onToggle={handleToggleSort}
                className="border-r border-border/60 px-2"
              />
            ) : null}
            {mode === "pod" ? (
              <>
                <SortableColumnHeader
                  label="Containers"
                  colKey="containers"
                  sort={activeSort}
                  onToggle={handleToggleSort}
                  className="border-r border-border/60 px-2"
                />
                <SortableColumnHeader
                  label="Restarts"
                  colKey="restarts"
                  sort={activeSort}
                  onToggle={handleToggleSort}
                  className="border-r border-border/60 px-2"
                />
                <SortableColumnHeader
                  label="Controlled By"
                  colKey="controlledBy"
                  sort={activeSort}
                  onToggle={handleToggleSort}
                  className="border-r border-border/60 px-2"
                />
                <SortableColumnHeader
                  label="Node"
                  colKey="node"
                  sort={activeSort}
                  onToggle={handleToggleSort}
                  className="border-r border-border/60 px-2"
                />
                <SortableColumnHeader
                  label="Age"
                  colKey="age"
                  sort={activeSort}
                  onToggle={handleToggleSort}
                  className="px-2"
                />
              </>
            ) : mode === "workload" ? (
              <>
                <SortableColumnHeader
                  label="Pods"
                  colKey="pods"
                  sort={activeSort}
                  onToggle={handleToggleSort}
                  className="border-r border-border/60 px-2"
                />
                <SortableColumnHeader
                  label="Controlled By"
                  colKey="controlledBy"
                  sort={activeSort}
                  onToggle={handleToggleSort}
                  className="border-r border-border/60 px-2"
                />
                <SortableColumnHeader
                  label="Age"
                  colKey="age"
                  sort={activeSort}
                  onToggle={handleToggleSort}
                  className="px-2"
                />
              </>
            ) : mode === "node" ? (
              <>
                <SortableColumnHeader
                  label="Taints"
                  colKey="taints"
                  sort={activeSort}
                  onToggle={handleToggleSort}
                  className="border-r border-border/60 px-2"
                />
                <SortableColumnHeader
                  label="Version"
                  colKey="node"
                  sort={activeSort}
                  onToggle={handleToggleSort}
                  className="border-r border-border/60 px-2"
                />
                <SortableColumnHeader
                  label="Age"
                  colKey="age"
                  sort={activeSort}
                  onToggle={handleToggleSort}
                  className="border-r border-border/60 px-2"
                />
                <SortableColumnHeader
                  label="UID"
                  colKey="uid"
                  sort={activeSort}
                  onToggle={handleToggleSort}
                  className="px-2"
                />
              </>
            ) : (
              <>
                <SortableColumnHeader
                  label="Detail"
                  colKey="detail"
                  sort={activeSort}
                  onToggle={handleToggleSort}
                  className="border-r border-border/60 px-2"
                />
                <SortableColumnHeader
                  label="Age"
                  colKey="age"
                  sort={activeSort}
                  onToggle={handleToggleSort}
                  className="border-r border-border/60 px-2"
                />
                <SortableColumnHeader
                  label="UID"
                  colKey="uid"
                  sort={activeSort}
                  onToggle={handleToggleSort}
                  className="px-2"
                />
              </>
            )}
            <span role="columnheader" aria-label="Actions" />
          </div>
        </div>
      </div>

      {view.status === "loading" && rows.length === 0 ? (
        <p data-testid="list-loading" className="p-4 text-xs text-muted-foreground">
          Loading {resource.kind.toLowerCase()}…
        </p>
      ) : null}

      {view.status !== "loading" && rows.length === 0 && !error ? (
        <div
          data-testid="list-empty"
          className="flex flex-col items-center justify-center gap-2 p-12 text-center text-xs text-muted-foreground"
        >
          <SearchX size={20} aria-hidden="true" />
          <p>
            {filterActive
              ? "No loaded rows match this filter."
              : `No ${resource.kind.toLowerCase()} in this scope.`}
          </p>
        </div>
      ) : null}

      {/* Virtualized Rows Scroller */}
      <div
        ref={scrollerRef}
        className="min-h-0 flex-1 overflow-auto"
        onScroll={(event) => {
          setScrollTop(event.currentTarget.scrollTop);
          if (headerRef.current) headerRef.current.scrollLeft = event.currentTarget.scrollLeft;
        }}
      >
        <div
          className="relative"
          style={{ height: rows.length * ROW_HEIGHT, minWidth: minTableWidth }}
        >
          <div className="absolute inset-x-0" style={{ top: first * ROW_HEIGHT }}>
            {windowRows.map((row) => {
              const selected = selectedUid ? selectedUid === row.uid : selectedName === row.name;
              const checked = checkedUids?.has(row.uid) ?? false;
              const telemetry = deriveRowTelemetry(row);
              const statusColor =
                telemetry.statusTone === "ok"
                  ? "text-success"
                  : telemetry.statusTone === "warn"
                    ? "text-warning"
                    : telemetry.statusTone === "error"
                      ? "text-destructive"
                      : telemetry.statusTone === "info"
                        ? "text-primary"
                        : "text-muted-foreground";

              const detailSummary =
                telemetry.message ||
                (telemetry.node !== "—" ? telemetry.node : "") ||
                (Object.keys(row.labels ?? {}).length > 0
                  ? `${Object.keys(row.labels).length} labels`
                  : "—");

              return (
                <div
                  key={row.uid}
                  role="button"
                  tabIndex={0}
                  aria-label={`Open ${row.kind} ${row.name}`}
                  aria-pressed={selected}
                  data-testid="resource-row"
                  data-uid={row.uid}
                  data-selected={selected}
                  onClick={() => onSelect(row)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onSelect(row);
                    }
                  }}
                  className={`grid cursor-pointer items-center border-b border-border/50 px-3 text-[11.5px] transition-colors hover:bg-hover/75 ${
                    selected
                      ? "border-l-2 border-l-primary bg-primary/10"
                      : "border-l-2 border-l-transparent"
                  }`}
                  style={{ height: ROW_HEIGHT, gridTemplateColumns: columns }}
                >
                  {/* Checkbox */}
                  <span
                    className="flex items-center"
                    onClick={(e) => {
                      if (!onToggleCheck) return;
                      e.stopPropagation();
                      onToggleCheck(row.uid);
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => onToggleCheck?.(row.uid)}
                      onClick={(e) => e.stopPropagation()}
                      aria-label={`Pin ${row.name} for comparison`}
                      className="h-3.5 w-3.5 cursor-pointer rounded-[3px] border-border-strong bg-background accent-primary"
                    />
                  </span>

                  {/* Status */}
                  <span className={`truncate pr-2 font-medium ${statusColor}`}>
                    {telemetry.statusText}
                  </span>

                  {/* Name */}
                  <span
                    className="truncate px-2 font-medium text-primary hover:underline"
                    title={`${row.name} (${row.uid})`}
                  >
                    {row.name}
                  </span>

                  {/* Namespace */}
                  {showNamespace ? (
                    <span
                      className="truncate px-2 text-foreground/85"
                      title={row.namespace}
                    >
                      {row.namespace ?? "—"}
                    </span>
                  ) : null}

                  {/* Kind-aware Lens columns */}
                  {mode === "pod" ? (
                    <>
                      {/* Containers ready squares + ratio */}
                      <span className="flex items-center gap-1.5 px-2">
                        <span className="flex items-center gap-1">
                          {Array.from({ length: Math.min(4, telemetry.containerCount) }).map(
                            (_, idx) => {
                              const isReady = idx < telemetry.readyCount;
                              const isCompleted =
                                telemetry.statusText === "Succeeded" ||
                                telemetry.statusText === "Completed";
                              return (
                                <span
                                  key={idx}
                                  title={
                                    isReady
                                      ? "Container Ready"
                                      : isCompleted
                                        ? "Container Completed (exited 0)"
                                        : "Container Not Ready"
                                  }
                                  className={`h-2.5 w-2.5 rounded-[2px] border ${
                                    telemetry.statusTone === "error"
                                      ? "border-destructive/60 bg-destructive/75"
                                      : isReady
                                        ? "border-success/60 bg-success/85"
                                        : isCompleted
                                          ? "border-muted-foreground/40 bg-muted-foreground/35"
                                          : "border-warning/60 bg-warning/75"
                                  }`}
                                />
                              );
                            },
                          )}
                        </span>
                        <span className="font-mono text-[10.5px] text-muted-foreground">
                          {telemetry.readyRatio}
                        </span>
                      </span>

                      {/* Restarts */}
                      <span
                        className={`truncate px-2 font-mono text-[11px] tabular-nums ${
                          telemetry.restarts > 0 ? "font-semibold text-warning" : "text-muted-foreground"
                        }`}
                      >
                        {telemetry.restarts}
                      </span>

                      {/* Controlled By */}
                      <span
                        className="truncate px-2 font-mono text-[11px] text-muted-foreground"
                        title={telemetry.controlledBy}
                      >
                        {formatControllerKind(telemetry.controlledBy)}
                      </span>

                      {/* Node */}
                      <span
                        className="truncate px-2 font-mono text-[11px] text-foreground/85"
                        title={telemetry.node}
                      >
                        {telemetry.node}
                      </span>

                      {/* Age */}
                      <span
                        className="truncate px-2 font-mono text-[11px] tabular-nums text-muted-foreground"
                        title={formatTimestamp(row.createdAt)}
                      >
                        {telemetry.age}
                      </span>
                    </>
                  ) : mode === "workload" ? (
                    <>
                      {/* Pods ready/desired */}
                      <span className="px-2">
                        <span
                          className={`inline-flex rounded-[3px] border px-2 py-0.5 font-mono text-[10.5px] font-medium tabular-nums ${
                            telemetry.readyOk
                              ? "border-success/40 bg-success/15 text-success"
                              : "border-warning/40 bg-warning/15 text-warning"
                          }`}
                        >
                          {telemetry.readyRatio}
                        </span>
                      </span>

                      {/* Controlled By */}
                      <span
                        className="truncate px-2 font-mono text-[11px] text-muted-foreground"
                        title={telemetry.controlledBy}
                      >
                        {formatControllerKind(telemetry.controlledBy)}
                      </span>

                      {/* Age */}
                      <span
                        className="truncate px-2 font-mono text-[11px] tabular-nums text-muted-foreground"
                        title={formatTimestamp(row.createdAt)}
                      >
                        {telemetry.age}
                      </span>
                    </>
                  ) : mode === "node" ? (
                    <>
                      {/* Taints count (with exact taints on hover) */}
                      <span
                        data-testid="node-taints-cell"
                        className="truncate px-2 font-mono text-[11px] tabular-nums"
                        title={
                          row.message ||
                          ((row.taints ?? 0) === 0 ? "No taints" : `${row.taints} taints`)
                        }
                      >
                        {(row.taints ?? 0) > 0 ? (
                          <span className="inline-flex rounded-[3px] border border-warning/40 bg-warning/15 px-1.5 py-0.2 font-semibold text-warning">
                            {row.taints}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">0</span>
                        )}
                      </span>

                      {/* Kubelet Version */}
                      <span
                        className="truncate px-2 font-mono text-[11px] text-muted-foreground"
                        title={row.node || "—"}
                      >
                        {row.node || "—"}
                      </span>

                      {/* Age */}
                      <span
                        className="truncate px-2 font-mono text-[11px] tabular-nums text-muted-foreground"
                        title={formatTimestamp(row.createdAt)}
                      >
                        {telemetry.age}
                      </span>

                      {/* Short UID */}
                      <span
                        className="truncate px-2 font-mono text-[10.5px] text-muted-foreground"
                        title={row.uid}
                      >
                        {row.uid.slice(0, 8)}
                      </span>
                    </>
                  ) : (
                    <>
                      {/* Detail (Type / ClusterIP / Keys / Event message) */}
                      <span
                        className="truncate px-2 font-mono text-[11px] text-muted-foreground"
                        title={detailSummary}
                      >
                        {detailSummary}
                      </span>

                      {/* Age */}
                      <span
                        className="truncate px-2 font-mono text-[11px] tabular-nums text-muted-foreground"
                        title={formatTimestamp(row.createdAt)}
                      >
                        {telemetry.age}
                      </span>

                      {/* Short UID */}
                      <span
                        className="truncate px-2 font-mono text-[10.5px] text-muted-foreground"
                        title={row.uid}
                      >
                        {row.uid.slice(0, 8)}
                      </span>
                    </>
                  )}

                  {/* Row action affordance */}
                  <span className="flex justify-end text-muted-foreground/70">
                    <MoreHorizontal size={13} aria-hidden="true" />
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
