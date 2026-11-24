import Editor from "@monaco-editor/react";
import {
  AlertCircle,
  ArrowDown,
  ArrowUpRight,
  Boxes,
  ChevronDown,
  Copy,
  Download,
  EyeOff,
  FileCode2,
  Filter,
  GitCompareArrows,
  Loader2,
  Maximize2,
  Network,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Terminal,
  WrapText,
  X,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ResourceStatusChip } from "@/components/clusters/status-badge";
import {
  checkIsWorkload,
  checkSupportsTopology,
  compileLogSearch,
  formatCpuTotal,
  formatMemoryTotal,
  formatShortPodLabel,
  getPodColorStyle,
  MAX_STREAMED_LOG_LINES,
  parseRawLogLine,
  splitHighlightSegments,
  type ParsedLogLine,
} from "@/components/explorer/detail/detail-utils";
import { WorkloadMetricsPanel } from "@/components/explorer/detail/metrics-panel";
import { PortForwardControl } from "@/components/explorer/detail/port-forward-control";
import { MetricsCard } from "@/components/ide/metrics-card";
import { SectionCard } from "@/components/ide/section-card";
import { TopologyCanvas } from "@/components/ide/topology-canvas";
import type { DiffResourceRef } from "@/components/ide/yaml-diff-modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { usePodLogsQuery, useResourceManifestQuery } from "@/lib/hooks";
import { ipc, onPodLogLine } from "@/lib/ipc/client";
import type { DiscoveredResourceDto, LogStreamSessionDto } from "@/lib/ipc/types";
import {
  formatAge,
  parseCpuMillicoresValue,
  parseManifestSummary,
  parseMemoryMibValue,
  resolveGvrForKind,
  type ResourceNavigationTarget,
} from "@/lib/resource-telemetry";
import { stripYamlNoise } from "@/lib/yaml-utils";
import { useSettingsStore } from "@/stores/settings-store";
import { useTerminalStore } from "@/stores/terminal-store";

export type DetailTab =
  | "overview"
  | "yaml"
  | "logs"
  | "events"
  | "security"
  | "metrics"
  | "topology";

export interface ResourceDetailProps {
  contextId: string;
  gvr: string;
  name: string;
  namespace?: string;
  theme?: "dark" | "light";
  initialTab?: DetailTab;
  isFullTab?: boolean;
  discoveredResources?: DiscoveredResourceDto[];
  comparableResources?: DiffResourceRef[];
  onOpenDiff?: (left: DiffResourceRef, right: DiffResourceRef) => void;
  onNavigateResource?: (target: ResourceNavigationTarget) => void;
  onOpenFullTab?: (activeTab: DetailTab) => void;
  onTabChange?: (tab: DetailTab) => void;
  onClose: () => void;
}

const DETAIL_TABS: Array<{
  id: DetailTab;
  label: string;
  workloadOnly?: boolean;
  metricsOnly?: boolean;
  topologyOnly?: boolean;
}> = [
  { id: "overview", label: "Overview" },
  { id: "yaml", label: "YAML" },
  { id: "logs", label: "Logs", workloadOnly: true },
  { id: "events", label: "Events" },
  { id: "security", label: "Security", workloadOnly: true },
  { id: "metrics", label: "Metrics", metricsOnly: true },
  { id: "topology", label: "Topology", topologyOnly: true },
];


export function ResourceDetail({
  contextId,
  gvr,
  name,
  namespace,
  theme = "dark",
  initialTab = "yaml",
  isFullTab = false,
  discoveredResources = [],
  comparableResources = [],
  onOpenDiff,
  onNavigateResource,
  onOpenFullTab,
  onTabChange,
  onClose,
}: ResourceDetailProps) {
  const query = useResourceManifestQuery(contextId, gvr, name, namespace);
  const openShell = useTerminalStore((s) => s.openShell);
  const defaultLogTailLines = useSettingsStore((s) => s.defaultLogTailLines);
  const defaultLogFontSize = useSettingsStore((s) => s.logFontSize);
  const yamlFontSize = useSettingsStore((s) => s.yamlFontSize);
  const defaultShowTimestamps = useSettingsStore((s) => s.showLogTimestamps);
  const defaultWrapLogs = useSettingsStore((s) => s.wrapLogLines);
  const cleanYamlByDefault = useSettingsStore((s) => s.cleanYamlByDefault);

  const [activeTab, setActiveTab] = useState<DetailTab>(initialTab);
  const [copied, setCopied] = useState(false);
  const [copiedClean, setCopiedClean] = useState(false);
  const [cleanYamlView, setCleanYamlView] = useState(cleanYamlByDefault);

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  useEffect(() => {
    setCleanYamlView(cleanYamlByDefault);
  }, [cleanYamlByDefault]);

  // Logs viewer local controls
  const [logSearch, setLogSearch] = useState("");
  const [logRegexMode, setLogRegexMode] = useState(false);
  const [logLevelFilter, setLogLevelFilter] = useState<"all" | "info" | "warn" | "error">("all");
  const [showTimestamps, setShowTimestamps] = useState(defaultShowTimestamps);
  const [wrapLogs, setWrapLogs] = useState(defaultWrapLogs);
  const [liveLogs, setLiveLogs] = useState(true);
  const [previousLogs, setPreviousLogs] = useState(false);
  const [logTailLines, setLogTailLines] = useState<number>(defaultLogTailLines);
  const [logFontSize, setLogFontSize] = useState<11 | 12 | 13>(defaultLogFontSize);
  const [logControlsOpen, setLogControlsOpen] = useState(false);
  const [selectedPods, setSelectedPods] = useState<string[]>([]);
  const [selectedContainer, setSelectedContainer] = useState<string>("");
  const [shellMenuOpen, setShellMenuOpen] = useState(false);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [expandedLogKey, setExpandedLogKey] = useState<string | null>(null);
  const [copiedJsonKey, setCopiedJsonKey] = useState<string | null>(null);
  const [streamMode, setStreamMode] = useState<"idle" | "streaming" | "fallback">("idle");
  const [streamMeta, setStreamMeta] = useState<LogStreamSessionDto | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [streamEnded, setStreamEnded] = useState(false);
  const [streamedLines, setStreamedLines] = useState<ParsedLogLine[]>([]);
  const streamLineSeqRef = useRef(0);
  const logsScrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  useEffect(() => {
    setLogTailLines(defaultLogTailLines);
  }, [defaultLogTailLines]);

  useEffect(() => {
    setLogFontSize(defaultLogFontSize);
  }, [defaultLogFontSize]);

  useEffect(() => {
    setShowTimestamps(defaultShowTimestamps);
  }, [defaultShowTimestamps]);

  useEffect(() => {
    setWrapLogs(defaultWrapLogs);
  }, [defaultWrapLogs]);

  useEffect(() => {
    setSelectedPods([]);
    setSelectedContainer("");
    setPreviousLogs(false);
    setShellMenuOpen(false);
    setExpandedLogKey(null);
    setStreamedLines([]);
    setStreamMeta(null);
    setStreamError(null);
    setStreamEnded(false);
    setStreamMode("idle");
    stickToBottomRef.current = true;
    setShowJumpToLatest(false);
  }, [contextId, gvr, name, namespace]);

  const parsed = useMemo(() => {
    if (!query.data) return null;
    return parseManifestSummary(query.data.yaml, { gvr, name, namespace });
  }, [query.data, gvr, name, namespace]);

  const navigateToKind = useCallback(
    (targetKind: string, targetName: string, targetNamespace?: string) => {
      if (!onNavigateResource || !targetName || targetName === "—") return;
      const resolved = resolveGvrForKind(targetKind, discoveredResources);
      if (!resolved) return;
      const fallbackNs =
        targetNamespace ||
        namespace ||
        (parsed?.namespace && parsed.namespace !== "cluster-scoped"
          ? parsed.namespace
          : undefined) ||
        "default";
      onNavigateResource({
        kind: targetKind,
        gvr: resolved.gvr,
        name: targetName,
        namespace: resolved.namespaced ? fallbackNs : undefined,
      });
    },
    [discoveredResources, namespace, onNavigateResource, parsed?.namespace],
  );

  const kindLabel = parsed?.kind ?? (gvr.split("/").pop() || "Resource");
  const isWorkload = useMemo(() => checkIsWorkload(kindLabel, gvr), [kindLabel, gvr]);
  const isNode =
    kindLabel.toLowerCase() === "node" || gvr === "/v1/nodes" || gvr.endsWith("/nodes");
  const supportsMetrics = isWorkload || isNode;
  const supportsTopology = useMemo(
    () => checkSupportsTopology(kindLabel, gvr),
    [kindLabel, gvr],
  );
  const isSecret =
    kindLabel.toLowerCase() === "secret" ||
    gvr.endsWith("/secrets") ||
    gvr.endsWith("/secret");
  const isConfigMap =
    kindLabel.toLowerCase() === "configmap" ||
    gvr.endsWith("/configmaps") ||
    gvr.endsWith("/configmap");
  const isService =
    kindLabel.toLowerCase() === "service" ||
    gvr === "/v1/services" ||
    gvr.endsWith("/services");

  const visibleTabs = useMemo(
    () =>
      DETAIL_TABS.filter(
        (tab) =>
          (!tab.workloadOnly || isWorkload) &&
          (!tab.metricsOnly || supportsMetrics) &&
          (!tab.topologyOnly || supportsTopology),
      ),
    [isWorkload, supportsMetrics, supportsTopology],
  );

  useEffect(() => {
    if (!visibleTabs.some((t) => t.id === activeTab)) {
      setActiveTab("overview");
    }
  }, [activeTab, visibleTabs]);

  const configDataRows = useMemo(() => {
    const map = new Map<string, string>();
    for (const [k, v] of parsed?.dataEntries ?? []) {
      map.set(k, v);
    }
    for (const maskedPath of query.data?.maskedPaths ?? []) {
      const key = maskedPath.split("/").filter(Boolean).slice(1).join("/");
      if (key && !map.has(key)) {
        map.set(key, "<masked by kubix>");
      }
    }
    return [...map.entries()];
  }, [parsed?.dataEntries, query.data?.maskedPaths]);

  const isPodResource =
    kindLabel.toLowerCase() === "pod" ||
    gvr === "/v1/pods" ||
    gvr.endsWith("/pods");

  const shouldStreamLive = activeTab === "logs" && isWorkload && liveLogs && !previousLogs;

  useEffect(() => {
    if (!shouldStreamLive) {
      setStreamMode("idle");
      setStreamMeta(null);
      setStreamError(null);
      setStreamEnded(false);
      return;
    }

    let cancelled = false;
    let activeStreamId: string | null = null;
    let unlisten: (() => void) | null = null;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const pendingBatch: ParsedLogLine[] = [];
    const earlyEvents: Array<{
      streamId: string;
      podName: string;
      containerName: string;
      line: string;
      closed: boolean;
      error?: string;
    }> = [];

    setStreamedLines([]);
    setStreamMeta(null);
    setStreamError(null);
    setStreamEnded(false);
    setStreamMode("idle");
    setExpandedLogKey(null);

    const flushPending = () => {
      flushTimer = null;
      if (cancelled || pendingBatch.length === 0) return;
      const batch = pendingBatch.splice(0, pendingBatch.length);
      setStreamedLines((prev) => {
        const combined = prev.length === 0 ? batch : [...prev, ...batch];
        if (combined.length > MAX_STREAMED_LOG_LINES) {
          return combined.slice(combined.length - MAX_STREAMED_LOG_LINES);
        }
        return combined;
      });
    };

    const enqueueLine = (podName: string, containerName: string, raw: string) => {
      if (!raw.trim()) return;
      streamLineSeqRef.current += 1;
      const order = streamLineSeqRef.current;
      pendingBatch.push(parseRawLogLine(`stream-${order}`, podName, containerName, raw, order));
      if (!flushTimer) {
        flushTimer = setTimeout(flushPending, 16);
      }
    };

    const handlePayload = (payload: {
      podName: string;
      containerName: string;
      line: string;
      closed: boolean;
      error?: string;
    }) => {
      if (payload.line) {
        enqueueLine(payload.podName, payload.containerName, payload.line);
      }
      if (payload.error) {
        setStreamError(payload.error);
      }
      if (payload.closed) {
        if (flushTimer) {
          clearTimeout(flushTimer);
          flushPending();
        }
        setStreamEnded(true);
      }
    };

    void (async () => {
      try {
        const stopListener = await onPodLogLine((payload) => {
          if (cancelled) return;
          if (activeStreamId === null) {
            earlyEvents.push(payload);
            return;
          }
          if (payload.streamId !== activeStreamId) return;
          handlePayload(payload);
        });
        if (cancelled) {
          stopListener();
          return;
        }
        unlisten = stopListener;

        const session = await ipc.startLogStream({
          contextId,
          gvr,
          name,
          namespace,
          container: selectedContainer || undefined,
          tailLines: logTailLines,
          previous: false,
        });
        if (cancelled) {
          if (session?.streamId) {
            void ipc.stopLogStream(session.streamId).catch(() => undefined);
          }
          return;
        }
        if (session && typeof session === "object" && typeof session.streamId === "string") {
          activeStreamId = session.streamId;
          setStreamMeta(session);
          setStreamMode("streaming");
          for (const ev of earlyEvents) {
            if (ev.streamId === session.streamId) {
              handlePayload(ev);
            }
          }
          earlyEvents.length = 0;
          if (pendingBatch.length > 0) {
            if (flushTimer) clearTimeout(flushTimer);
            flushPending();
          }
        } else {
          setStreamMode("fallback");
        }
      } catch {
        if (!cancelled) {
          setStreamMode("fallback");
        }
      }
    })();

    return () => {
      cancelled = true;
      if (flushTimer) clearTimeout(flushTimer);
      unlisten?.();
      if (activeStreamId) {
        void ipc.stopLogStream(activeStreamId).catch(() => undefined);
      }
    };
  }, [
    shouldStreamLive,
    contextId,
    gvr,
    name,
    namespace,
    selectedContainer,
    logTailLines,
  ]);

  const useSnapshotLogs =
    activeTab === "logs" && isWorkload && (!shouldStreamLive || streamMode === "fallback");

  const logsQuery = usePodLogsQuery({
    contextId,
    gvr,
    name,
    namespace,
    container: selectedContainer || undefined,
    tailLines: logTailLines,
    previous: previousLogs,
    enabled: useSnapshotLogs,
    refetchInterval:
      activeTab === "logs" && liveLogs && !previousLogs && streamMode === "fallback" ? 3000 : false,
  });

  const activeLogPods = useMemo(() => {
    if (streamMode === "streaming" && streamMeta?.pods) return streamMeta.pods;
    return logsQuery.data?.pods ?? [];
  }, [streamMode, streamMeta?.pods, logsQuery.data?.pods]);

  const availableContainers = useMemo(() => {
    const names = new Set<string>();
    for (const c of streamMeta?.containers ?? []) {
      if (c) names.add(c);
    }
    for (const c of logsQuery.data?.containers ?? []) {
      if (c) names.add(c);
    }
    for (const c of parsed?.containers ?? []) {
      if (c.name) names.add(c.name);
    }
    return [...names];
  }, [streamMeta?.containers, logsQuery.data?.containers, parsed?.containers]);

  const availableInitContainers = useMemo(() => {
    const names = new Set<string>();
    for (const c of streamMeta?.initContainers ?? []) {
      if (c) names.add(c);
    }
    for (const c of logsQuery.data?.initContainers ?? []) {
      if (c) names.add(c);
    }
    for (const c of parsed?.initContainers ?? []) {
      if (c) names.add(c);
    }
    return [...names];
  }, [streamMeta?.initContainers, logsQuery.data?.initContainers, parsed?.initContainers]);

  const totalSelectableContainers =
    availableContainers.length + availableInitContainers.length;

  const allUnfilteredPodLogs = useMemo(() => {
    let parsedLines: ParsedLogLine[] = [];

    if (streamMode === "streaming") {
      parsedLines = streamedLines.filter((item) => {
        const normalizedContainer = item.containerName.replace(/^init:/, "");
        if (
          selectedContainer &&
          normalizedContainer !== selectedContainer &&
          item.containerName !== selectedContainer
        ) {
          return false;
        }
        return true;
      });
    } else {
      const dto = logsQuery.data;
      if (dto && Array.isArray(dto.chunks)) {
        let idx = 0;
        for (const chunk of dto.chunks) {
          const normalizedContainer = chunk.containerName.replace(/^init:/, "");
          if (
            selectedContainer &&
            normalizedContainer !== selectedContainer &&
            chunk.containerName !== selectedContainer
          ) {
            continue;
          }
          for (const raw of chunk.logs.split(/\r?\n/)) {
            if (!raw.trim()) continue;
            parsedLines.push(
              parseRawLogLine(`snap-${idx}`, chunk.podName, chunk.containerName, raw, idx),
            );
            idx += 1;
          }
        }
      }
    }
    return parsedLines;
  }, [streamMode, streamedLines, logsQuery.data, selectedContainer]);

  const podLineCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const line of allUnfilteredPodLogs) {
      counts.set(line.podName, (counts.get(line.podName) ?? 0) + 1);
    }
    return counts;
  }, [allUnfilteredPodLogs]);

  const logs = useMemo(() => {
    const podSet = selectedPods.length > 0 ? new Set(selectedPods) : null;
    const scoped = podSet
      ? allUnfilteredPodLogs.filter((line) => podSet.has(line.podName))
      : allUnfilteredPodLogs;

    // Interleave multi-pod / multi-container logs chronologically by timestamp.
    const sorted = [...scoped].sort((a, b) => {
      const validA = Number.isFinite(a.tsMs);
      const validB = Number.isFinite(b.tsMs);
      if (validA && validB && a.tsMs !== b.tsMs) {
        return a.tsMs - b.tsMs;
      }
      return a.order - b.order;
    });
    return sorted.map((line, index) => ({
      ...line,
      lineNumber: index + 1,
    }));
  }, [allUnfilteredPodLogs, selectedPods]);

  const compiledLogSearch = useMemo(
    () => compileLogSearch(logSearch, logRegexMode),
    [logSearch, logRegexMode],
  );

  const filteredLogs = useMemo(() => {
    const needle = logSearch.trim().toLowerCase();
    return logs.filter((entry) => {
      if (logLevelFilter !== "all" && entry.level !== logLevelFilter) return false;
      if (!needle) return true;
      if (logRegexMode) {
        if (!compiledLogSearch.regex) return false;
        const re = new RegExp(compiledLogSearch.regex.source, "i");
        return re.test(entry.rawJson) || re.test(entry.podName);
      }
      return (
        entry.rawJson.toLowerCase().includes(needle) ||
        entry.podName.toLowerCase().includes(needle)
      );
    });
  }, [logs, logSearch, logLevelFilter, logRegexMode, compiledLogSearch.regex]);

  // Re-pin to the newest line at the bottom when entering Logs or switching stream filters.
  useEffect(() => {
    if (activeTab !== "logs") return;
    stickToBottomRef.current = true;
    setShowJumpToLatest(false);
  }, [activeTab, selectedContainer, selectedPods, previousLogs]);

  // Auto-scroll to the bottom (newest log) when pinned and log lines load or update.
  useEffect(() => {
    if (activeTab !== "logs" || !stickToBottomRef.current) return;
    const el = logsScrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [activeTab, filteredLogs]);

  const handleLogsScroll = useCallback(() => {
    const el = logsScrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distanceFromBottom <= 24;
    stickToBottomRef.current = atBottom;
    setShowJumpToLatest(!atBottom);
  }, []);

  const scrollLogsToBottom = useCallback(() => {
    const el = logsScrollRef.current;
    stickToBottomRef.current = true;
    setShowJumpToLatest(false);
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, []);

  const eventsQuery = useQuery({
    queryKey: ["resource-events", contextId, gvr, name, namespace ?? ""],
    queryFn: () => ipc.getResourceEvents(contextId, gvr, name, namespace),
    enabled: activeTab === "events" && !!contextId,
    refetchInterval: activeTab === "events" ? 5000 : false,
    retry: false,
  });

  const events = useMemo(() => {
    const rawEvents = eventsQuery.data;
    if (!Array.isArray(rawEvents)) return [];
    return rawEvents.map((ev) => ({
      uid: ev.uid,
      type: (ev.eventType === "Warning" ? "Warning" : "Normal") as "Normal" | "Warning",
      reason: ev.reason,
      involvedObject: ev.involvedObject || `${kindLabel}/${name}`,
      age: formatAge(ev.createdAt),
      from: ev.from || kindLabel,
      message: ev.message,
      count: ev.count ?? 1,
    }));
  }, [eventsQuery.data, kindLabel, name]);

  const cleanYaml = useMemo(
    () => (query.data ? stripYamlNoise(query.data.yaml) : ""),
    [query.data],
  );

  const displayedYaml = cleanYamlView ? cleanYaml : (query.data?.yaml ?? "");

  const diffCandidates = useMemo(
    () =>
      comparableResources.filter(
        (item) => !(item.name === name && (item.namespace ?? "") === (namespace ?? "")),
      ),
    [comparableResources, name, namespace],
  );

  const copy = useCallback(async () => {
    if (!query.data) return;
    try {
      await navigator.clipboard.writeText(query.data.yaml);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }, [query.data]);

  const copyCleanYaml = useCallback(async () => {
    if (!cleanYaml) return;
    try {
      await navigator.clipboard.writeText(cleanYaml);
      setCopiedClean(true);
      window.setTimeout(() => setCopiedClean(false), 1500);
    } catch {
      setCopiedClean(false);
    }
  }, [cleanYaml]);

  const downloadLogs = useCallback(() => {
    const content = filteredLogs
      .map((l) => {
        const prefix = `[${l.podName}/${l.containerName}]`;
        return l.timestamp ? `${prefix} ${l.timestamp} ${l.rawJson}` : `${prefix} ${l.rawJson}`;
      })
      .join("\n");
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name}.log`;
    a.click();
    URL.revokeObjectURL(url);
  }, [filteredLogs, name]);

  return (
    <div className="flex h-full min-w-0 flex-col bg-panel" data-testid="resource-detail">
      {/* Detail Header */}
      <header className="flex items-start gap-2 border-b border-border bg-elevated/60 px-3 py-2">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-primary/40 bg-primary/10 text-primary">
          <Boxes size={14} aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-primary">
              {kindLabel}
            </span>
            <ResourceStatusChip label={parsed?.phase || "Active"} tone="ok" />
            <span className="rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[9.5px] text-muted-foreground">
              {gvr}
            </span>
          </div>
          <p className="mt-0.5 truncate font-mono text-xs font-semibold text-foreground" title={name}>
            {namespace ? (
              <>
                <span className="text-muted-foreground">{namespace}:</span>
                {name}
              </>
            ) : (
              name
            )}
          </p>
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-1">
          {isPodResource ? (
            <div className="relative">
              <Button
                size="sm"
                variant="outline"
                className="h-7 gap-1 px-2 text-[11px]"
                aria-haspopup={(parsed?.containers.length ?? 0) > 1 ? "menu" : undefined}
                aria-expanded={(parsed?.containers.length ?? 0) > 1 ? shellMenuOpen : undefined}
                onClick={() => {
                  const podContainers = parsed?.containers ?? [];
                  if (podContainers.length > 1) {
                    setShellMenuOpen((open) => !open);
                    return;
                  }
                  void openShell({
                    contextId,
                    namespace: namespace || parsed?.namespace || "default",
                    podName: name,
                    container: podContainers[0]?.name,
                  });
                }}
                data-testid="exec-pod-shell"
                title="Open interactive container shell"
              >
                <Terminal className="h-3 w-3 text-primary" aria-hidden />
                Shell
                {(parsed?.containers.length ?? 0) > 1 ? (
                  <ChevronDown className="h-3 w-3 text-muted-foreground" aria-hidden />
                ) : null}
              </Button>

              {shellMenuOpen && (parsed?.containers.length ?? 0) > 1 ? (
                <div
                  role="menu"
                  aria-label="Select container for shell"
                  data-testid="exec-pod-shell-menu"
                  className="absolute top-full right-0 z-30 mt-1 w-64 rounded border border-border-strong bg-popover p-1 text-popover-foreground shadow-xl"
                >
                  <div className="border-b border-border px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Select container ({parsed?.containers.length})
                  </div>
                  <div className="mt-1 space-y-0.5">
                    {(parsed?.containers ?? []).map((c) => {
                      const isOk = c.ready ?? true;
                      const stateText = c.stateLabel ?? (isOk ? "Ready" : "Pending");
                      return (
                        <button
                          key={c.name}
                          type="button"
                          role="menuitem"
                          data-testid={`exec-pod-shell-option-${c.name}`}
                          onClick={() => {
                            setShellMenuOpen(false);
                            void openShell({
                              contextId,
                              namespace: namespace || parsed?.namespace || "default",
                              podName: name,
                              container: c.name,
                            });
                          }}
                          className="flex w-full flex-col gap-0.5 rounded px-2 py-1.5 text-left transition-colors hover:bg-hover"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="flex items-center gap-1.5 font-mono text-[11px] font-semibold text-foreground">
                              <span
                                className={`h-1.5 w-1.5 rounded-full ${
                                  isOk ? "bg-success" : "bg-warning"
                                }`}
                              />
                              {c.name}
                            </span>
                            <span
                              className={`rounded px-1.5 py-0.2 font-mono text-[9.5px] ${
                                isOk
                                  ? "bg-success/15 text-success"
                                  : "bg-warning/15 text-warning"
                              }`}
                            >
                              {stateText}
                            </span>
                          </div>
                          <span className="truncate pl-3 font-mono text-[10px] text-muted-foreground">
                            {c.image}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
          {onOpenFullTab && !isFullTab ? (
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              onClick={() => onOpenFullTab(activeTab)}
              title="Open in full workspace tab"
              aria-label="Open in workspace tab"
            >
              <Maximize2 className="h-3.5 w-3.5" aria-hidden />
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[11px]"
            onClick={copy}
            disabled={!query.data}
            data-testid="copy-yaml"
          >
            <Copy className="h-3 w-3" aria-hidden />
            {copied ? "Copied" : "Copy YAML"}
          </Button>
          {!isFullTab ? (
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              onClick={onClose}
              aria-label="Close detail"
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </Button>
          ) : null}
        </div>
      </header>

      {/* Inner Detail Navigation Tabs */}
      <div
        role="tablist"
        aria-label="Resource detail tabs"
        className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border bg-rail px-2"
      >
        {visibleTabs.map((tab) => {
          const active = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              data-testid={`detail-tab-${tab.id}`}
              onClick={() => {
                setActiveTab(tab.id);
                onTabChange?.(tab.id);
              }}
              className={`relative shrink-0 px-2.5 py-1.5 text-[11.5px] transition-colors ${
                active
                  ? "font-semibold text-primary"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {tab.label}
              {active ? (
                <span
                  aria-hidden="true"
                  className="absolute inset-x-1 bottom-0 h-0.5 rounded-t bg-primary"
                />
              ) : null}
            </button>
          );
        })}
      </div>

      {/* Loading / Error / Secret Masking Banner */}
      {query.isLoading ? (
        <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-[11px] text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin text-primary" aria-hidden />
          Loading manifest…
        </div>
      ) : null}

      {query.error ? (
        <div
          role="alert"
          className="m-3 flex items-start gap-2 rounded border border-destructive/40 bg-destructive/10 p-2.5 text-[11px] text-destructive"
        >
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>{String((query.error as Error).message)}</span>
        </div>
      ) : null}

      {query.data && query.data.maskedPaths.length > 0 ? (
        <div
          data-testid="masked-banner"
          className="flex items-center gap-2 border-b border-warning/40 bg-warning/10 px-3 py-1.5 text-[11px] text-warning"
        >
          <EyeOff className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="truncate">
            {query.data.maskedPaths.length} secret field(s) masked:{" "}
            <span className="font-mono">{query.data.maskedPaths.join(", ")}</span>
          </span>
        </div>
      ) : null}

      {/* Tab Content Area */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {activeTab === "yaml" ? (
          <div className="flex h-full min-h-[240px] flex-col">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-panel px-2.5 py-1.5 text-[10.5px]">
              <div className="flex items-center gap-1.5">
                <div className="flex items-center rounded border border-border bg-elevated p-0.5">
                  <button
                    type="button"
                    data-testid="yaml-mode-raw"
                    onClick={() => setCleanYamlView(false)}
                    className={`rounded-sm px-2 py-0.5 font-medium transition-colors ${
                      !cleanYamlView
                        ? "bg-primary/20 text-primary"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    Raw YAML
                  </button>
                  <button
                    type="button"
                    data-testid="yaml-mode-clean"
                    onClick={() => setCleanYamlView(true)}
                    className={`inline-flex items-center gap-1 rounded-sm px-2 py-0.5 font-medium transition-colors ${
                      cleanYamlView
                        ? "bg-primary/20 text-primary"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                    title="Strip managedFields, uid, resourceVersion, and status"
                  >
                    <Sparkles size={10} aria-hidden="true" />
                    Clean YAML
                  </button>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 px-2 text-[10.5px]"
                  data-testid="copy-clean-yaml"
                  onClick={() => void copyCleanYaml()}
                  disabled={!cleanYaml}
                  title="Copy manifest with managedFields, uid, resourceVersion, and status removed"
                >
                  <Copy size={10} aria-hidden="true" />
                  {copiedClean ? "Copied clean!" : "Copy clean YAML"}
                </Button>
              </div>

              {onOpenDiff && diffCandidates.length > 0 ? (
                <div className="flex items-center gap-1.5">
                  <GitCompareArrows size={12} className="text-muted-foreground" aria-hidden="true" />
                  <select
                    aria-label="Compare YAML with resource"
                    data-testid="yaml-diff-select"
                    value=""
                    onChange={(e) => {
                      const val = e.target.value;
                      if (!val) return;
                      const match = diffCandidates.find(
                        (c) => `${c.namespace ?? ""}/${c.name}` === val,
                      );
                      if (match) {
                        onOpenDiff({ gvr, kind: kindLabel, name, namespace }, match);
                      }
                    }}
                    className="h-6 max-w-[200px] rounded border border-border bg-elevated px-2 font-mono text-[10.5px] text-foreground"
                  >
                    <option value="">Diff with…</option>
                    {diffCandidates.map((c) => {
                      const key = `${c.namespace ?? ""}/${c.name}`;
                      return (
                        <option key={key} value={key}>
                          {c.namespace ? `${c.namespace}/${c.name}` : c.name}
                        </option>
                      );
                    })}
                  </select>
                </div>
              ) : null}
            </div>
            <div className="min-h-0 flex-1">
              {query.data ? (
                <Editor
                  height="100%"
                  defaultLanguage="yaml"
                  value={displayedYaml}
                  theme={theme === "dark" ? "vs-dark" : "vs"}
                  options={{
                    readOnly: true,
                    domReadOnly: true,
                    minimap: { enabled: false },
                    fontSize: yamlFontSize,
                    lineNumbers: "on",
                    scrollBeyondLastLine: false,
                    renderLineHighlight: "none",
                    wordWrap: "on",
                    contextmenu: false,
                    folding: true,
                    automaticLayout: true,
                    padding: { top: 8 },
                  }}
                />
              ) : null}
            </div>
          </div>
        ) : null}

        {activeTab === "overview" ? (
          <div className="h-full overflow-y-auto p-3 space-y-3" data-testid="detail-overview">
            {isWorkload ? (
              (() => {
                const containerList = parsed?.containers ?? [];
                let cpuReqSum = 0;
                let cpuLimSum = 0;
                let memReqSum = 0;
                let memLimSum = 0;
                for (const c of containerList) {
                  const cr = parseCpuMillicoresValue(c.cpuRequest);
                  const cl = parseCpuMillicoresValue(c.cpuLimit);
                  const mr = parseMemoryMibValue(c.memRequest);
                  const ml = parseMemoryMibValue(c.memLimit);
                  if (cr !== null && cr > 0) cpuReqSum += cr;
                  if (cl !== null && cl > 0) cpuLimSum += cl;
                  if (mr !== null && mr > 0) memReqSum += mr;
                  if (ml !== null && ml > 0) memLimSum += ml;
                }
                const cpuReqs = formatCpuTotal(cpuReqSum);
                const cpuLims = formatCpuTotal(cpuLimSum);
                const memReqs = formatMemoryTotal(memReqSum);
                const memLims = formatMemoryTotal(memLimSum);
                const restarts = parsed?.totalRestarts ?? 0;
                const totalC = containerList.length;
                const readyC =
                  parsed && containerList.some((c) => c.ready !== undefined)
                    ? parsed.readyContainers
                    : totalC;

                return (
                  <div
                    className={
                      isFullTab
                        ? "grid grid-cols-2 gap-2 sm:grid-cols-4"
                        : "grid grid-cols-2 gap-2"
                    }
                  >
                    <MetricsCard
                      label="CPU Quota"
                      value={cpuReqs || cpuLims || "Unbounded"}
                      sublabel={
                        cpuReqs || cpuLims
                          ? `req ${cpuReqs || "—"} / lim ${cpuLims || "—"}`
                          : "No CPU limit set"
                      }
                      tone="primary"
                    />
                    <MetricsCard
                      label="Memory Quota"
                      value={memReqs || memLims || "Unbounded"}
                      sublabel={
                        memReqs || memLims
                          ? `req ${memReqs || "—"} / lim ${memLims || "—"}`
                          : "No memory limit set"
                      }
                      tone="primary"
                    />
                    <MetricsCard
                      label="Restarts"
                      value={restarts}
                      sublabel={parsed?.qosClass ? `QoS: ${parsed.qosClass}` : "Across containers"}
                      tone={restarts > 0 ? "warning" : "success"}
                    />
                    <MetricsCard
                      label="Containers"
                      value={totalC > 0 ? `${readyC} / ${totalC}` : "—"}
                      sublabel={`sa: ${parsed?.serviceAccount ?? "default"}`}
                      tone={totalC > 0 && readyC === totalC ? "success" : "neutral"}
                    />
                  </div>
                );
              })()
            ) : (
              <div
                className={
                  isFullTab
                    ? "grid grid-cols-2 gap-2 sm:grid-cols-4"
                    : "grid grid-cols-2 gap-2"
                }
              >
                <MetricsCard
                  label="Resource Type"
                  value={parsed?.resourceType || (isSecret ? "Opaque" : kindLabel)}
                  sublabel={parsed?.apiVersion ?? gvr}
                  tone="primary"
                />
                <MetricsCard
                  label={isSecret || isConfigMap ? "Data Keys" : "Spec Fields"}
                  value={isSecret || isConfigMap ? configDataRows.length : (parsed?.specEntries.length ?? 0)}
                  sublabel={
                    isSecret
                      ? "Encrypted secret entries"
                      : isConfigMap
                        ? "Configuration entries"
                        : "Configured fields"
                  }
                  tone="neutral"
                />
                <MetricsCard
                  label="Data Protection"
                  value={
                    isSecret
                      ? `${query.data?.maskedPaths.length || configDataRows.length} Masked`
                      : "Read-Only"
                  }
                  sublabel={isSecret ? "Redacted before IPC" : "Immutable in Kubix"}
                  tone="success"
                />
                <MetricsCard
                  label="Labels"
                  value={parsed?.labels.length ?? 0}
                  sublabel={`${parsed?.annotations.length ?? 0} annotations`}
                  tone="neutral"
                />
              </div>
            )}

            <SectionCard title="Metadata" subtitle={parsed?.apiVersion ?? gvr} icon={<FileCode2 size={12} />}>
              <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-[11.5px] sm:grid-cols-2">
                <div>
                  <dt className="ide-meta-label">Name</dt>
                  <dd className="mt-0.5 break-all font-mono text-foreground">{parsed?.name ?? name}</dd>
                </div>
                <div>
                  <dt className="ide-meta-label">Namespace</dt>
                  <dd className="mt-0.5 font-mono text-foreground">{parsed?.namespace ?? (namespace || "cluster-scoped")}</dd>
                </div>
                <div>
                  <dt className="ide-meta-label">UID</dt>
                  <dd className="mt-0.5 truncate font-mono text-[10.5px] text-muted-foreground">{parsed?.uid ?? "—"}</dd>
                </div>
                <div>
                  <dt className="ide-meta-label">Created</dt>
                  <dd className="mt-0.5 font-mono text-[10.5px] text-muted-foreground">{parsed?.creationTimestamp ?? "—"}</dd>
                </div>
                {isWorkload ? (
                  <>
                    <div>
                      <dt className="ide-meta-label">Service Account</dt>
                      <dd className="mt-0.5 font-mono text-foreground">
                        {onNavigateResource && parsed?.serviceAccount ? (
                          <button
                            type="button"
                            data-testid="nav-link-serviceaccount"
                            onClick={() => navigateToKind("ServiceAccount", parsed.serviceAccount)}
                            className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"
                          >
                            {parsed.serviceAccount}
                            <ArrowUpRight size={10} aria-hidden="true" />
                          </button>
                        ) : (
                          parsed?.serviceAccount ?? "default"
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt className="ide-meta-label">Node</dt>
                      <dd className="mt-0.5 font-mono text-primary">
                        {onNavigateResource && parsed?.nodeName && parsed.nodeName !== "—" ? (
                          <button
                            type="button"
                            data-testid="nav-link-node"
                            onClick={() => navigateToKind("Node", parsed.nodeName)}
                            className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"
                          >
                            {parsed.nodeName}
                            <ArrowUpRight size={10} aria-hidden="true" />
                          </button>
                        ) : (
                          parsed?.nodeName ?? "—"
                        )}
                        {parsed?.podIP ? (
                          <span className="ml-2 text-[10px] text-muted-foreground">
                            ({parsed.podIP})
                          </span>
                        ) : null}
                      </dd>
                    </div>
                  </>
                ) : (
                  <>
                    <div>
                      <dt className="ide-meta-label">Type</dt>
                      <dd className="mt-0.5 break-all font-mono text-foreground">
                        {parsed?.resourceType || (isSecret ? "Opaque" : kindLabel)}
                      </dd>
                    </div>
                    <div>
                      <dt className="ide-meta-label">Resource Version</dt>
                      <dd className="mt-0.5 font-mono text-[10.5px] text-muted-foreground">
                        {parsed?.resourceVersion ?? "—"}
                      </dd>
                    </div>
                  </>
                )}
              </dl>

              {parsed && parsed.ownerReferences.length > 0 ? (
                <div className="mt-3 border-t border-border pt-2.5">
                  <div className="ide-meta-label mb-1.5">Controlled By</div>
                  <div className="flex flex-wrap gap-1.5">
                    {parsed.ownerReferences.map((owner) => {
                      const canJump =
                        Boolean(onNavigateResource) &&
                        Boolean(resolveGvrForKind(owner.kind, discoveredResources));
                      return canJump ? (
                        <button
                          key={`${owner.kind}-${owner.name}`}
                          type="button"
                          data-testid={`nav-link-owner-${owner.name}`}
                          onClick={() => navigateToKind(owner.kind, owner.name)}
                          className="inline-flex items-center gap-1 rounded border border-primary/35 bg-primary/10 px-2 py-0.5 font-mono text-[10.5px] text-primary transition-colors hover:bg-primary/20"
                        >
                          <span className="text-muted-foreground">{owner.kind}/</span>
                          <span>{owner.name}</span>
                          <ArrowUpRight size={10} aria-hidden="true" />
                        </button>
                      ) : (
                        <span
                          key={`${owner.kind}-${owner.name}`}
                          className="inline-flex items-center gap-1 rounded border border-border bg-elevated px-2 py-0.5 font-mono text-[10.5px] text-foreground"
                        >
                          <span className="text-muted-foreground">{owner.kind}/</span>
                          <span>{owner.name}</span>
                        </span>
                      );
                    })}
                  </div>
                </div>
              ) : null}

              {parsed && (parsed.configMapRefs.length > 0 || parsed.secretRefs.length > 0) ? (
                <div className="mt-3 border-t border-border pt-2.5">
                  <div className="ide-meta-label mb-1.5">Referenced Config &amp; Secrets</div>
                  <div className="flex flex-wrap gap-1.5">
                    {parsed.configMapRefs.map((cm) =>
                      onNavigateResource ? (
                        <button
                          key={`cm-${cm}`}
                          type="button"
                          data-testid={`nav-link-configmap-${cm}`}
                          onClick={() => navigateToKind("ConfigMap", cm)}
                          className="inline-flex items-center gap-1 rounded border border-amber-500/35 bg-amber-500/10 px-2 py-0.5 font-mono text-[10.5px] text-amber-400 transition-colors hover:bg-amber-500/20"
                        >
                          <span className="text-muted-foreground">ConfigMap/</span>
                          <span>{cm}</span>
                          <ArrowUpRight size={10} aria-hidden="true" />
                        </button>
                      ) : (
                        <span
                          key={`cm-${cm}`}
                          className="inline-flex items-center gap-1 rounded border border-border bg-elevated px-2 py-0.5 font-mono text-[10.5px]"
                        >
                          ConfigMap/{cm}
                        </span>
                      ),
                    )}
                    {parsed.secretRefs.map((sec) =>
                      onNavigateResource ? (
                        <button
                          key={`sec-${sec}`}
                          type="button"
                          data-testid={`nav-link-secret-${sec}`}
                          onClick={() => navigateToKind("Secret", sec)}
                          className="inline-flex items-center gap-1 rounded border border-warning/35 bg-warning/10 px-2 py-0.5 font-mono text-[10.5px] text-warning transition-colors hover:bg-warning/20"
                        >
                          <span className="text-muted-foreground">Secret/</span>
                          <span>{sec}</span>
                          <ArrowUpRight size={10} aria-hidden="true" />
                        </button>
                      ) : (
                        <span
                          key={`sec-${sec}`}
                          className="inline-flex items-center gap-1 rounded border border-border bg-elevated px-2 py-0.5 font-mono text-[10.5px]"
                        >
                          Secret/{sec}
                        </span>
                      ),
                    )}
                  </div>
                </div>
              ) : null}

              {parsed && parsed.labels.length > 0 ? (
                <div className="mt-3 border-t border-border pt-2.5">
                  <div className="ide-meta-label mb-1.5">Labels</div>
                  <div className="flex flex-wrap gap-1">
                    {parsed.labels.map(([k, v]) => (
                      <span
                        key={k}
                        className="inline-flex items-center rounded border border-border bg-elevated px-1.5 py-0.5 font-mono text-[10px]"
                      >
                        <span className="text-muted-foreground">{k}=</span>
                        <span className="text-primary">{v}</span>
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}

              {parsed && parsed.annotations.length > 0 ? (
                <div className="mt-3 border-t border-border pt-2.5">
                  <div className="ide-meta-label mb-1.5">Annotations</div>
                  <div className="flex flex-wrap gap-1">
                    {parsed.annotations.map(([k, v]) => (
                      <span
                        key={k}
                        className="inline-flex max-w-full items-center truncate rounded border border-border bg-elevated px-1.5 py-0.5 font-mono text-[10px]"
                      >
                        <span className="text-muted-foreground">{k}=</span>
                        <span className="truncate text-foreground">{v}</span>
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}
            </SectionCard>

            {isWorkload ? (
              <SectionCard
                title="Containers & Images"
                subtitle={`${parsed?.containers.length ?? 0} spec ${
                  (parsed?.containers.length ?? 0) === 1 ? "entry" : "entries"
                }`}
                icon={<Boxes size={12} />}
                bodyClassName="p-0"
              >
                <div className="divide-y divide-border" data-testid="containers-list">
                  {parsed && parsed.containers.length > 0 ? (
                    parsed.containers.map((c) => {
                      const isOk = c.ready ?? true;
                      const stateText = c.stateLabel ?? (isOk ? "Ready" : "Pending");
                      return (
                        <div
                          key={c.name}
                          data-testid="container-item"
                          className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-[11.5px]"
                        >
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span
                                className={`h-1.5 w-1.5 rounded-full ${
                                  isOk ? "bg-success" : "bg-warning"
                                }`}
                              />
                              <span className="font-mono font-semibold text-foreground">
                                {c.name}
                              </span>
                              {c.ports.length > 0 ? (
                                <div className="flex flex-wrap items-center gap-1.5">
                                  {c.ports.map((portLabel) => {
                                    const portNum = Number.parseInt(portLabel, 10);
                                    return (
                                      <span
                                        key={portLabel}
                                        className="inline-flex items-center gap-1 rounded border border-border bg-elevated px-1.5 py-0.5 font-mono text-[9.5px] text-muted-foreground"
                                      >
                                        <span>port: {portLabel}</span>
                                        {Number.isFinite(portNum) && portNum > 0 ? (
                                          <PortForwardControl
                                            contextId={contextId}
                                            namespace={namespace || parsed?.namespace || "default"}
                                            kind={kindLabel}
                                            name={name}
                                            remotePort={portNum}
                                          />
                                        ) : null}
                                      </span>
                                    );
                                  })}
                                </div>
                              ) : null}
                              {typeof c.restartCount === "number" && c.restartCount > 0 ? (
                                <span className="rounded border border-warning/40 bg-warning/10 px-1.5 py-0.5 font-mono text-[9.5px] text-warning">
                                  restarts: {c.restartCount}
                                </span>
                              ) : null}
                            </div>
                            <div className="mt-0.5 truncate font-mono text-[10.5px] text-muted-foreground">
                              {c.image}
                            </div>
                          </div>
                          <div className="flex items-center gap-1.5">
                            {isPodResource ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-6 px-2 text-[10.5px] text-primary hover:bg-primary/10"
                                onClick={() =>
                                  void openShell({
                                    contextId,
                                    namespace: namespace || parsed?.namespace || "default",
                                    podName: name,
                                    container: c.name,
                                  })
                                }
                                data-testid={`exec-container-${c.name}`}
                                title={`Exec shell in ${c.name}`}
                              >
                                <Terminal size={11} aria-hidden="true" />
                                Shell
                              </Button>
                            ) : null}
                            <ResourceStatusChip
                              label={stateText}
                              tone={isOk ? "ok" : "warn"}
                            />
                          </div>
                        </div>
                      );
                    })
                  ) : (
                    <p className="px-3 py-4 text-xs text-muted-foreground">
                      {query.isLoading
                        ? "Loading container specification…"
                        : "No container specs found in manifest."}
                    </p>
                  )}
                </div>
              </SectionCard>
            ) : isSecret || isConfigMap ? (
              <SectionCard
                title={isSecret ? "Secret Data Keys" : "ConfigMap Data"}
                subtitle={`${configDataRows.length} ${configDataRows.length === 1 ? "entry" : "entries"}`}
                icon={isSecret ? <EyeOff size={12} /> : <FileCode2 size={12} />}
                bodyClassName="p-0"
              >
                <div className="divide-y divide-border" data-testid="config-data-section">
                  {configDataRows.length > 0 ? (
                    configDataRows.map(([k, v]) => (
                      <div
                        key={k}
                        data-testid="config-data-entry"
                        className="flex flex-col gap-1 px-3 py-2 text-[11.5px]"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono font-semibold text-primary">{k}</span>
                          {isSecret || v === "<masked by kubix>" ? (
                            <span className="inline-flex items-center gap-1 rounded border border-warning/40 bg-warning/10 px-1.5 py-0.5 font-mono text-[10px] text-warning">
                              <EyeOff size={10} aria-hidden="true" />
                              &lt;masked by kubix&gt;
                            </span>
                          ) : null}
                        </div>
                        {!isSecret && v !== "<masked by kubix>" ? (
                          <pre className="mt-0.5 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded border border-border bg-background/90 px-2 py-1.5 font-mono text-[11px] text-foreground">
                            {v}
                          </pre>
                        ) : null}
                      </div>
                    ))
                  ) : (
                    <p className="px-3 py-4 text-xs text-muted-foreground">
                      No data entries defined on this {kindLabel}.
                    </p>
                  )}
                </div>
              </SectionCard>
            ) : parsed && parsed.specEntries.length > 0 ? (
              <SectionCard
                title="Specification Summary"
                subtitle={`${parsed.specEntries.length} fields`}
                icon={<FileCode2 size={12} />}
                bodyClassName="p-0"
              >
                <div className="divide-y divide-border" data-testid="spec-summary-section">
                  {parsed.specEntries.map(([k, v]) => (
                    <div
                      key={k}
                      className="flex items-center justify-between gap-3 px-3 py-2 text-[11.5px]"
                    >
                      <span className="font-mono text-muted-foreground">{k}</span>
                      <span className="truncate font-mono text-foreground">{v}</span>
                    </div>
                  ))}
                </div>
              </SectionCard>
            ) : null}

            {isService && parsed && parsed.servicePorts.length > 0 ? (
              <SectionCard
                title="Service Ports & Forwarding"
                subtitle={`${parsed.servicePorts.length} ${
                  parsed.servicePorts.length === 1 ? "port" : "ports"
                }`}
                icon={<Network size={12} />}
                bodyClassName="p-0"
              >
                <div className="divide-y divide-border" data-testid="service-ports-section">
                  {parsed.servicePorts.map((sp) => (
                    <div
                      key={`${sp.port}-${sp.protocol}`}
                      data-testid="service-port-entry"
                      className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-[11.5px]"
                    >
                      <div className="flex items-center gap-2 font-mono">
                        {sp.name ? (
                          <span className="font-semibold text-foreground">{sp.name}</span>
                        ) : null}
                        <span className="text-primary">
                          :{sp.port} → :{sp.targetPort}
                        </span>
                        <span className="rounded border border-border bg-elevated px-1.5 py-0.2 text-[9.5px] text-muted-foreground">
                          {sp.protocol}
                        </span>
                      </div>
                      <PortForwardControl
                        contextId={contextId}
                        namespace={namespace || parsed.namespace || "default"}
                        kind="Service"
                        name={name}
                        remotePort={sp.port}
                      />
                    </div>
                  ))}
                </div>
              </SectionCard>
            ) : null}
          </div>
        ) : null}

        {activeTab === "logs" ? (
          <div className="relative flex h-full flex-col bg-background" data-testid="detail-logs">
            {/* Log Toolbar */}
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-panel px-2.5 py-1.5">
              <div className="flex min-w-[220px] flex-1 flex-wrap items-center gap-1.5">
                <div className="flex shrink-0 items-center rounded border border-border bg-elevated p-0.5 text-[10.5px]">
                  {(["all", "info", "warn", "error"] as const).map((lvl) => (
                    <button
                      key={lvl}
                      type="button"
                      onClick={() => setLogLevelFilter(lvl)}
                      className={`rounded-sm px-2 py-0.5 uppercase transition-colors ${
                        logLevelFilter === lvl
                          ? "bg-primary/20 font-semibold text-primary"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {lvl}
                    </button>
                  ))}
                </div>
                <div className="relative min-w-[130px] max-w-xs flex-1">
                  <Search size={11} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={logSearch}
                    onChange={(e) => setLogSearch(e.target.value)}
                    placeholder={logRegexMode ? "Regex filter (e.g. err|50\\d)…" : "Search logs…"}
                    aria-label="Search logs"
                    className={`h-7 bg-elevated pl-6 pr-8 font-mono text-[11px] ${
                      compiledLogSearch.error ? "border-destructive focus:border-destructive" : ""
                    }`}
                  />
                  <button
                    type="button"
                    data-testid="log-regex-toggle"
                    aria-pressed={logRegexMode}
                    aria-label="Toggle regular expression search"
                    title={
                      compiledLogSearch.error
                        ? `Invalid regex: ${compiledLogSearch.error}`
                        : "Use regular expression (.*)"
                    }
                    onClick={() => setLogRegexMode((v) => !v)}
                    className={`absolute right-1 top-1/2 -translate-y-1/2 rounded px-1 py-0.5 font-mono text-[10px] font-semibold transition-colors ${
                      logRegexMode
                        ? compiledLogSearch.error
                          ? "bg-destructive/20 text-destructive"
                          : "bg-primary/20 text-primary"
                        : "text-muted-foreground hover:bg-hover hover:text-foreground"
                    }`}
                  >
                    .*
                  </button>
                </div>
                <span className="shrink-0 whitespace-nowrap font-mono text-[10px] text-muted-foreground">
                  {filteredLogs.length} lines
                </span>
              </div>

              <div className="flex shrink-0 flex-wrap items-center gap-1">
                {totalSelectableContainers > 1 || availableInitContainers.length > 0 ? (
                  <select
                    aria-label="Select container"
                    data-testid="log-container-select"
                    value={selectedContainer}
                    onChange={(e) => setSelectedContainer(e.target.value)}
                    className="h-7 rounded border border-border bg-elevated px-2 font-mono text-[10.5px] text-foreground"
                  >
                    <option value="">All containers ({totalSelectableContainers})</option>
                    {availableContainers.map((c) => (
                      <option key={c} value={c}>
                        container: {c}
                      </option>
                    ))}
                    {availableInitContainers.map((ic) => (
                      <option key={`init-${ic}`} value={ic}>
                        init: {ic}
                      </option>
                    ))}
                  </select>
                ) : totalSelectableContainers === 1 ? (
                  <span
                    data-testid="log-single-container-badge"
                    className="hidden shrink-0 whitespace-nowrap rounded border border-border bg-elevated px-2 py-1 font-mono text-[10.5px] text-muted-foreground sm:inline-flex"
                  >
                    container: {availableContainers[0] ?? availableInitContainers[0]}
                  </span>
                ) : null}
                <select
                  aria-label="Tail lines"
                  data-testid="log-tail-select"
                  value={String(logTailLines)}
                  onChange={(e) => setLogTailLines(Number(e.target.value))}
                  className="h-7 rounded border border-border bg-elevated px-2 font-mono text-[10.5px] text-foreground"
                >
                  <option value="100">100 lines</option>
                  <option value="250">250 lines</option>
                  <option value="1000">1000 lines</option>
                  <option value="0">All lines</option>
                </select>
                <Button
                  size="sm"
                  variant={previousLogs ? "secondary" : "outline"}
                  className={`h-7 px-2 text-[10.5px] ${
                    previousLogs ? "border-warning/50 bg-warning/15 text-warning" : ""
                  }`}
                  data-testid="toggle-previous-logs"
                  aria-pressed={previousLogs}
                  title="Show logs from the previous terminated container instance (--previous)"
                  onClick={() => {
                    setPreviousLogs((prev) => {
                      const next = !prev;
                      if (next) setLiveLogs(false);
                      return next;
                    });
                  }}
                >
                  Previous
                </Button>
                <Button
                  size="sm"
                  variant={liveLogs && !previousLogs ? "secondary" : "outline"}
                  className="h-7 px-2 text-[10.5px]"
                  onClick={() => {
                    setLiveLogs((v) => {
                      const next = !v;
                      if (next) setPreviousLogs(false);
                      return next;
                    });
                  }}
                >
                  <span className={`h-1.5 w-1.5 rounded-full ${liveLogs && !previousLogs ? "animate-pulse bg-success" : "bg-muted-foreground"}`} />
                  {liveLogs && !previousLogs ? "Live" : "Paused"}
                </Button>
                <Button
                  size="sm"
                  variant={wrapLogs ? "secondary" : "outline"}
                  className="h-7 px-2 text-[10.5px]"
                  data-testid="toggle-log-wrap"
                  aria-pressed={wrapLogs}
                  title={wrapLogs ? "Disable line wrapping (scroll horizontally)" : "Wrap long log lines"}
                  onClick={() => setWrapLogs((v) => !v)}
                >
                  <WrapText size={11} aria-hidden="true" />
                  Wrap
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-[10.5px]"
                  onClick={downloadLogs}
                >
                  <Download size={11} />
                  Download
                </Button>
                <Button
                  size="icon"
                  variant={logControlsOpen ? "secondary" : "ghost"}
                  className="h-7 w-7"
                  aria-label="Log display options"
                  onClick={() => setLogControlsOpen((v) => !v)}
                >
                  <SlidersHorizontal size={12} />
                </Button>
              </div>
            </div>

            {/* Stern-style Multi-Pod Color Filter Bar (shown on Deployments, StatefulSets, etc.) */}
            {(!isPodResource || activeLogPods.length > 1) && activeLogPods.length > 0 ? (
              <div
                data-testid="log-pods-bar"
                className="flex flex-wrap items-center gap-1.5 border-b border-border bg-elevated/60 px-2.5 py-1.5 text-[10.5px]"
              >
                <span className="font-semibold uppercase tracking-wider text-muted-foreground">
                  Pods ({activeLogPods.length}):
                </span>
                <button
                  type="button"
                  onClick={() => setSelectedPods([])}
                  className={`rounded border px-2 py-0.5 font-mono transition-colors ${
                    selectedPods.length === 0
                      ? "border-primary bg-primary/15 font-semibold text-primary"
                      : "border-border bg-background text-muted-foreground hover:text-foreground"
                  }`}
                >
                  All Pods
                </button>
                {activeLogPods.map((podName) => {
                  const selected = selectedPods.includes(podName);
                  const count = podLineCounts.get(podName) ?? 0;
                  const podColor = getPodColorStyle(podName);
                  const shortPod = formatShortPodLabel(podName, isPodResource ? undefined : name);
                  return (
                    <button
                      key={podName}
                      type="button"
                      data-testid={`log-pod-chip-${podName}`}
                      aria-pressed={selected}
                      title={podName}
                      onClick={() =>
                        setSelectedPods((prev) =>
                          prev.includes(podName)
                            ? prev.filter((p) => p !== podName)
                            : [...prev, podName],
                        )
                      }
                      className={`inline-flex items-center gap-1.5 rounded border px-2 py-0.5 font-mono transition-colors ${
                        selected
                          ? `${podColor} font-semibold ring-1 ring-current/40`
                          : selectedPods.length === 0
                            ? `${podColor} opacity-85 hover:opacity-100`
                            : "border-border bg-background text-muted-foreground opacity-60 hover:opacity-100"
                      }`}
                    >
                      <span>{shortPod}</span>
                      <span className="text-[9.5px] opacity-75 tabular-nums">{count}</span>
                    </button>
                  );
                })}
              </div>
            ) : null}

            <div className="relative flex min-h-0 flex-1">
              <div
                ref={logsScrollRef}
                data-testid="logs-scroll-container"
                data-log-wrap={wrapLogs ? "true" : "false"}
                onScroll={handleLogsScroll}
                className="min-h-0 flex-1 overflow-auto p-2 font-mono leading-relaxed"
                style={{ fontSize: `${logFontSize}px` }}
              >
                {streamMode === "streaming" && streamError ? (
                  <div
                    data-testid="log-stream-error"
                    className="m-2 rounded border border-destructive/40 bg-destructive/10 p-2.5 text-xs text-destructive"
                  >
                    {streamError}
                  </div>
                ) : null}
                {useSnapshotLogs && logsQuery.isLoading ? (
                  <div className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" aria-hidden />
                    Reading container logs from cluster…
                  </div>
                ) : useSnapshotLogs && logsQuery.error ? (
                  <div className="m-2 rounded border border-destructive/40 bg-destructive/10 p-2.5 text-xs text-destructive">
                    {String((logsQuery.error as Error).message)}
                  </div>
                ) : filteredLogs.length === 0 && !streamError ? (
                  <div className="p-4 text-xs text-muted-foreground">
                    {streamMode === "streaming"
                      ? streamEnded
                        ? "Log stream closed — no lines emitted."
                        : "Waiting for live container log lines…"
                      : "No container log lines matched."}
                  </div>
                ) : (
                  filteredLogs.map((line) => {
                    const multiPod = !isPodResource || activeLogPods.length > 1;
                    const multiContainer =
                      totalSelectableContainers > 1 ||
                      line.containerName.startsWith("init:");
                    const isJsonExpanded = expandedLogKey === line.key;

                    return (
                      <div key={line.key}>
                        <div
                          className={`flex gap-2.5 rounded-sm px-1.5 py-0.5 hover:bg-hover/60 ${
                            wrapLogs ? "" : "w-max min-w-full whitespace-nowrap"
                          }`}
                        >
                          <span className="w-8 shrink-0 select-none text-right tabular-nums text-muted-foreground/50">
                            {line.lineNumber}
                          </span>
                          {multiPod ? (
                            (() => {
                              const shortPod = formatShortPodLabel(
                                line.podName,
                                isPodResource ? undefined : name,
                              );
                              return (
                                <span
                                  data-testid="log-pod-label"
                                  className={`max-w-[140px] shrink-0 self-start truncate rounded border px-1.5 py-0.2 text-[10px] font-semibold ${getPodColorStyle(line.podName)}`}
                                  title={`${line.podName}/${line.containerName}`}
                                >
                                  {multiContainer ? `${shortPod}/${line.containerName}` : shortPod}
                                </span>
                              );
                            })()
                          ) : multiContainer ? (
                            <span
                              data-testid="log-container-label"
                              className="shrink-0 self-start rounded border border-info/35 bg-info/10 px-1.5 py-0.2 text-[10px] font-semibold text-primary"
                              title={`Container: ${line.containerName}`}
                            >
                              [{line.containerName}]
                            </span>
                          ) : null}
                          {showTimestamps && line.timestamp ? (
                            <span className="shrink-0 text-muted-foreground">
                              {line.timestamp}
                            </span>
                          ) : null}
                          <span
                            className={
                              wrapLogs
                                ? "min-w-0 flex-1 whitespace-pre-wrap break-all"
                                : "shrink-0 whitespace-pre"
                            }
                          >
                            <span
                              className={
                                line.level === "error"
                                  ? "text-destructive"
                                  : line.level === "warn"
                                    ? "text-warning"
                                    : "text-primary"
                              }
                            >
                              [{line.level.toUpperCase()}]
                            </span>{" "}
                            {!multiContainer && line.caller && line.caller !== "default" ? (
                              <>
                                <span className="text-muted-foreground">({line.caller})</span>{" "}
                              </>
                            ) : null}
                            {line.parsedJson ? (
                              <button
                                type="button"
                                data-testid="log-json-badge"
                                aria-expanded={isJsonExpanded}
                                onClick={() =>
                                  setExpandedLogKey((prev) => (prev === line.key ? null : line.key))
                                }
                                title="Inspect structured JSON fields"
                                className={`mr-1.5 inline-flex items-center rounded border px-1 py-0.2 font-mono text-[9.5px] transition-colors ${
                                  isJsonExpanded
                                    ? "border-primary bg-primary/20 text-primary"
                                    : "border-border bg-elevated text-muted-foreground hover:border-primary/60 hover:text-primary"
                                }`}
                              >
                                {"{}"}
                              </button>
                            ) : null}
                            <span className="text-foreground">
                              {compiledLogSearch.regex
                                ? splitHighlightSegments(line.rawJson, compiledLogSearch.regex).map(
                                    (seg, idx) =>
                                      seg.match ? (
                                        <mark
                                          key={idx}
                                          data-testid="log-search-match"
                                          className="rounded-sm bg-warning/35 px-0.5 text-foreground"
                                        >
                                          {seg.text}
                                        </mark>
                                      ) : (
                                        <span key={idx}>{seg.text}</span>
                                      ),
                                  )
                                : line.rawJson}
                            </span>
                          </span>
                        </div>

                        {isJsonExpanded && line.parsedJson ? (
                          <div
                            data-testid="log-json-inspector"
                            className="my-1 ml-10 mr-2 rounded border border-border-strong bg-panel p-2 text-[11px]"
                          >
                            <div className="mb-1.5 flex items-center justify-between border-b border-border pb-1">
                              <span className="font-sans text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                                Structured JSON Payload
                              </span>
                              <button
                                type="button"
                                onClick={() => {
                                  const pretty = JSON.stringify(line.parsedJson, null, 2);
                                  void navigator.clipboard?.writeText(pretty).catch(() => undefined);
                                  setCopiedJsonKey(line.key);
                                  window.setTimeout(
                                    () => setCopiedJsonKey((k) => (k === line.key ? null : k)),
                                    1200,
                                  );
                                }}
                                className="inline-flex items-center gap-1 rounded border border-border bg-elevated px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
                              >
                                <Copy size={10} aria-hidden="true" />
                                {copiedJsonKey === line.key ? "Copied" : "Copy JSON"}
                              </button>
                            </div>
                            <div className="divide-y divide-border/50">
                              {Object.entries(line.parsedJson).map(([fieldKey, fieldVal]) => {
                                const displayVal =
                                  typeof fieldVal === "string"
                                    ? fieldVal
                                    : JSON.stringify(fieldVal);
                                return (
                                  <div
                                    key={fieldKey}
                                    className="flex items-start justify-between gap-2 py-1"
                                  >
                                    <div className="min-w-0 flex-1 break-all">
                                      <span className="font-semibold text-primary">{fieldKey}</span>
                                      <span className="text-muted-foreground">: </span>
                                      <span className="text-foreground">{displayVal}</span>
                                    </div>
                                    {displayVal && displayVal.length <= 120 ? (
                                      <button
                                        type="button"
                                        aria-label={`Filter by ${displayVal}`}
                                        onClick={() => setLogSearch(displayVal)}
                                        className="shrink-0 rounded border border-border bg-elevated px-1.5 py-0.2 text-[9.5px] text-muted-foreground transition-colors hover:border-primary/60 hover:text-primary"
                                      >
                                        Filter
                                      </button>
                                    ) : null}
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        ) : null}
                      </div>
                    );
                  })
                )}
              </div>

              {showJumpToLatest && filteredLogs.length > 0 ? (
                <button
                  type="button"
                  data-testid="scroll-logs-bottom"
                  onClick={scrollLogsToBottom}
                  className="absolute bottom-3 right-3 z-10 inline-flex items-center gap-1 rounded border border-primary/50 bg-panel/95 px-2.5 py-1 font-mono text-[10.5px] font-medium text-primary shadow-md backdrop-blur-sm transition-colors hover:bg-primary/15"
                >
                  <ArrowDown size={11} aria-hidden="true" />
                  Jump to latest
                </button>
              ) : null}

              {logControlsOpen ? (
                <div className="w-52 shrink-0 border-l border-border bg-panel p-2.5 text-[11px] space-y-3">
                  <div className="flex items-center justify-between border-b border-border pb-1.5">
                    <span className="font-semibold text-foreground">Log Controls</span>
                    <button
                      type="button"
                      onClick={() => setLogControlsOpen(false)}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <X size={12} />
                    </button>
                  </div>
                  <label className="flex items-center justify-between">
                    <span className="text-muted-foreground">Show timestamps</span>
                    <input
                      type="checkbox"
                      checked={showTimestamps}
                      onChange={(e) => setShowTimestamps(e.target.checked)}
                      className="accent-primary"
                    />
                  </label>
                  <label className="flex items-center justify-between">
                    <span className="text-muted-foreground">Wrap lines</span>
                    <input
                      type="checkbox"
                      data-testid="log-controls-wrap"
                      checked={wrapLogs}
                      onChange={(e) => setWrapLogs(e.target.checked)}
                      className="accent-primary"
                    />
                  </label>
                  <label className="flex items-center justify-between">
                    <span className="text-muted-foreground">Live follow</span>
                    <input
                      type="checkbox"
                      checked={liveLogs && !previousLogs}
                      onChange={(e) => {
                        const next = e.target.checked;
                        setLiveLogs(next);
                        if (next) setPreviousLogs(false);
                      }}
                      className="accent-primary"
                    />
                  </label>
                  <div>
                    <div className="mb-1 text-muted-foreground">Font size</div>
                    <div className="flex gap-1">
                      {([11, 12, 13] as const).map((sz) => (
                        <button
                          key={sz}
                          type="button"
                          onClick={() => setLogFontSize(sz)}
                          className={`flex-1 rounded border py-0.5 font-mono text-[10.5px] ${
                            logFontSize === sz
                              ? "border-primary bg-primary/15 text-primary"
                              : "border-border bg-elevated text-muted-foreground"
                          }`}
                        >
                          {sz}px
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="border-t border-border pt-2 flex gap-1.5">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 flex-1 text-[10.5px]"
                      onClick={() => {
                        void query.refetch();
                        void logsQuery.refetch();
                      }}
                    >
                      <RefreshCw size={11} /> Refresh
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        {activeTab === "events" ? (
          <div className="h-full overflow-y-auto p-3" data-testid="detail-events">
            <SectionCard
              title="Kubernetes Events"
              subtitle={`${events.length} recent ${events.length === 1 ? "event" : "events"}`}
              icon={<Terminal size={12} />}
              bodyClassName="p-0"
            >
              {eventsQuery.isLoading ? (
                <div className="flex items-center gap-2 p-4 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" aria-hidden />
                  Loading Kubernetes events…
                </div>
              ) : eventsQuery.error ? (
                <div className="m-3 rounded border border-destructive/40 bg-destructive/10 p-2.5 text-xs text-destructive">
                  {String((eventsQuery.error as Error).message)}
                </div>
              ) : events.length === 0 ? (
                <div
                  data-testid="events-empty"
                  className="p-6 text-center text-xs text-muted-foreground"
                >
                  No recent Kubernetes events for{" "}
                  <span className="font-mono text-foreground">
                    {kindLabel}/{name}
                  </span>
                  .
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-left text-[11px]">
                    <thead>
                      <tr className="border-b border-border bg-elevated/80 ide-table-header">
                        <th className="px-3 py-1.5">Type</th>
                        <th className="px-3 py-1.5">Reason</th>
                        <th className="px-3 py-1.5">Involved Object</th>
                        <th className="px-3 py-1.5">From</th>
                        <th className="px-3 py-1.5">Count</th>
                        <th className="px-3 py-1.5">Age</th>
                        <th className="px-3 py-1.5">Message</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/70">
                      {events.map((ev, idx) => (
                        <tr
                          key={ev.uid || `${ev.reason}-${ev.involvedObject}-${idx}`}
                          data-testid="event-row"
                          className="hover:bg-hover/60"
                        >
                          <td className="px-3 py-1.5">
                            <ResourceStatusChip
                              label={ev.type}
                              tone={ev.type === "Warning" ? "warn" : "ok"}
                            />
                          </td>
                          <td className="px-3 py-1.5 font-mono font-medium text-foreground">
                            {ev.reason}
                          </td>
                          <td className="px-3 py-1.5 font-mono text-primary">
                            {ev.involvedObject}
                          </td>
                          <td className="px-3 py-1.5 font-mono text-muted-foreground">{ev.from}</td>
                          <td className="px-3 py-1.5 font-mono tabular-nums">{ev.count}</td>
                          <td className="px-3 py-1.5 font-mono tabular-nums text-muted-foreground">
                            {ev.age}
                          </td>
                          <td className="px-3 py-1.5 text-muted-foreground">{ev.message}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </SectionCard>
          </div>
        ) : null}

        {activeTab === "security" ? (
          <div className="h-full overflow-y-auto p-3 space-y-3" data-testid="detail-security">
            <div className="grid grid-cols-2 gap-2">
              <MetricsCard
                label="Secret Masking"
                value={query.data?.maskedPaths.length ? `${query.data.maskedPaths.length} masked` : "Protected"}
                sublabel="Backend IPC sanitizer"
                icon={<ShieldCheck size={14} />}
                tone="success"
              />
              <MetricsCard
                label="Privileged Mode"
                value={parsed?.securityFlags.privileged ?? "false"}
                sublabel={`hostNetwork: ${parsed?.securityFlags.hostNetwork ?? "false"}`}
                icon={<ShieldAlert size={14} />}
                tone={parsed?.securityFlags.privileged === "true" ? "warning" : "primary"}
              />
            </div>
            <SectionCard title="Security Context & RBAC Checks" icon={<Filter size={12} />} bodyClassName="p-0">
              <div className="divide-y divide-border text-[11.5px]">
                {(
                  [
                    { label: "ServiceAccount", val: parsed?.serviceAccount ?? "default", tone: "info" },
                    {
                      label: "runAsNonRoot",
                      val: parsed?.securityFlags.runAsNonRoot ?? "unset",
                      tone: parsed?.securityFlags.runAsNonRoot === "true" ? "ok" : "neutral",
                    },
                    {
                      label: "readOnlyRootFilesystem",
                      val: parsed?.securityFlags.readOnlyRootFs ?? "false",
                      tone: parsed?.securityFlags.readOnlyRootFs === "true" ? "ok" : "neutral",
                    },
                    {
                      label: "hostNetwork",
                      val: parsed?.securityFlags.hostNetwork ?? "false",
                      tone: parsed?.securityFlags.hostNetwork === "true" ? "warn" : "ok",
                    },
                  ] as const
                ).map(({ label, val, tone }) => (
                  <div key={label} className="flex items-center justify-between px-3 py-2">
                    <span className="font-mono text-muted-foreground">{label}</span>
                    <ResourceStatusChip label={val} tone={tone} />
                  </div>
                ))}
              </div>
            </SectionCard>
          </div>
        ) : null}

        {activeTab === "metrics" ? (
          <WorkloadMetricsPanel
            contextId={contextId}
            gvr={gvr}
            name={name}
            namespace={namespace ?? "default"}
            containers={parsed?.containers ?? []}
            isNode={isNode}
            manifestYaml={query.data?.yaml}
          />
        ) : null}

        {activeTab === "topology" ? (
          <div className="h-full p-2.5" data-testid="detail-topology">
            <TopologyCanvas
              compact
              contextId={contextId}
              namespace={namespace}
              manifestYaml={query.data?.yaml}
              focusResource={{ kind: kindLabel, name, namespace }}
              onOpenNode={
                onNavigateResource
                  ? (node) => navigateToKind(node.kind, node.name, node.namespace)
                  : undefined
              }
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
