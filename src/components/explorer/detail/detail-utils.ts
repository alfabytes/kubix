import {
  parseCpuMillicoresValue,
  parseMemoryMibValue,
} from "@/lib/resource-telemetry";

const WORKLOAD_RESOURCE_KINDS = new Set([
  "pod",
  "pods",
  "deployment",
  "deployments",
  "statefulset",
  "statefulsets",
  "daemonset",
  "daemonsets",
  "replicaset",
  "replicasets",
  "replicationcontroller",
  "replicationcontrollers",
  "job",
  "jobs",
  "cronjob",
  "cronjobs",
  "horizontalpodautoscaler",
  "horizontalpodautoscalers",
]);

const TOPOLOGY_NETWORK_KINDS = new Set([
  "service",
  "services",
  "ingress",
  "ingresses",
  "gateway",
  "gateways",
  "httproute",
  "httproutes",
  "grpcroute",
  "grpcroutes",
  "tlsroute",
  "tlsroutes",
  "tcproute",
  "tcproutes",
]);

export function checkIsWorkload(kindLabel: string, gvr: string): boolean {
  const k = kindLabel.toLowerCase();
  const plural = (gvr.split("/").pop() ?? "").toLowerCase();
  return WORKLOAD_RESOURCE_KINDS.has(k) || WORKLOAD_RESOURCE_KINDS.has(plural);
}

export function checkSupportsTopology(kindLabel: string, gvr: string): boolean {
  if (checkIsWorkload(kindLabel, gvr)) return true;
  const k = kindLabel.toLowerCase();
  const plural = (gvr.split("/").pop() ?? "").toLowerCase();
  return TOPOLOGY_NETWORK_KINDS.has(k) || TOPOLOGY_NETWORK_KINDS.has(plural);
}

export function formatCpuTotal(millicores: number): string {
  if (millicores <= 0) return "";
  if (millicores >= 1000) {
    const cores = millicores / 1000;
    return Number.isInteger(cores) ? String(cores) : String(Number(cores.toFixed(2)));
  }
  return `${Math.round(millicores)}m`;
}

export function formatMemoryTotal(mib: number): string {
  if (mib <= 0) return "";
  if (mib >= 1024) {
    const gib = mib / 1024;
    return `${Number.isInteger(gib) ? gib : Number(gib.toFixed(2))}Gi`;
  }
  return `${Math.round(mib)}Mi`;
}

export function tryParseJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  const candidate = trimmed.slice(start, end + 1);
  try {
    const parsed = JSON.parse(candidate);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

export interface ParsedLogLine {
  key: string;
  lineNumber: number;
  podName: string;
  containerName: string;
  timestamp: string;
  tsMs: number;
  order: number;
  level: "info" | "warn" | "error";
  caller: string;
  message: string;
  rawJson: string;
  parsedJson: Record<string, unknown> | null;
}

export function parseRawLogLine(
  key: string,
  podName: string,
  containerName: string,
  raw: string,
  order: number,
): ParsedLogLine {
  const tsMatch = raw.match(/^(\d{4}-\d{2}-\d{2}T\S+)\s+(.*)$/);
  const timestamp = tsMatch?.[1] ?? "";
  const tsMs = timestamp ? Date.parse(timestamp) : Number.NaN;
  const body = tsMatch?.[2] ?? raw;
  const lower = body.toLowerCase();
  const level: "info" | "warn" | "error" =
    lower.includes("error") ||
    lower.includes("fatal") ||
    lower.includes("panic") ||
    lower.includes("err]") ||
    lower.includes("\"level\":\"error\"")
      ? "error"
      : lower.includes("warn") || lower.includes("\"level\":\"warn\"")
        ? "warn"
        : "info";
  return {
    key,
    lineNumber: order + 1,
    podName,
    containerName,
    timestamp,
    tsMs,
    order,
    level,
    caller: containerName,
    message: body,
    rawJson: body,
    parsedJson: tryParseJsonObject(body),
  };
}

export function parseNodeCapacity(yaml: string | undefined): {
  cpuMillicores: number | null;
  memoryMib: number | null;
  cpuRaw: string | null;
  memoryRaw: string | null;
} {
  if (!yaml) {
    return { cpuMillicores: null, memoryMib: null, cpuRaw: null, memoryRaw: null };
  }
  const lines = yaml.split(/\r?\n/);
  const readSection = (sectionName: string) => {
    let cpuRaw: string | null = null;
    let memoryRaw: string | null = null;
    for (let i = 0; i < lines.length; i += 1) {
      const m = (lines[i] ?? "").match(new RegExp(`^(\\s+)${sectionName}:\\s*$`));
      if (!m) continue;
      const baseIndent = (m[1] ?? "").length;
      for (let j = i + 1; j < lines.length; j += 1) {
        const next = lines[j] ?? "";
        const trimmed = next.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const nextIndent = next.match(/^(\s*)/)?.[1]?.length ?? 0;
        if (nextIndent <= baseIndent) break;
        const kv = next.match(/^\s*(cpu|memory):\s*["']?([^"'\s#]+)["']?/);
        if (kv?.[1] === "cpu" && kv[2]) cpuRaw = kv[2];
        if (kv?.[1] === "memory" && kv[2]) memoryRaw = kv[2];
      }
      if (cpuRaw || memoryRaw) break;
    }
    return { cpuRaw, memoryRaw };
  };

  const cap = readSection("capacity");
  const alloc = cap.cpuRaw || cap.memoryRaw ? cap : readSection("allocatable");
  return {
    cpuMillicores: alloc.cpuRaw ? parseCpuMillicoresValue(alloc.cpuRaw) : null,
    memoryMib: alloc.memoryRaw ? parseMemoryMibValue(alloc.memoryRaw) : null,
    cpuRaw: alloc.cpuRaw,
    memoryRaw: alloc.memoryRaw,
  };
}

export const MAX_STREAMED_LOG_LINES = 5000;

/** Stern-style distinct high-contrast color badges for multi-pod log streams (light + dark). */
const POD_COLOR_STYLES = [
  "border-cyan-500/40 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300",
  "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  "border-violet-500/40 bg-violet-500/10 text-violet-700 dark:text-violet-300",
  "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  "border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-300",
  "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  "border-lime-600/40 bg-lime-500/10 text-lime-700 dark:text-lime-300",
  "border-fuchsia-500/40 bg-fuchsia-500/10 text-fuchsia-700 dark:text-fuchsia-300",
];

export function getPodColorStyle(podName: string): string {
  let hash = 0;
  for (let i = 0; i < podName.length; i += 1) {
    hash = (hash * 31 + podName.charCodeAt(i)) >>> 0;
  }
  return POD_COLOR_STYLES[hash % POD_COLOR_STYLES.length] ?? POD_COLOR_STYLES[0]!;
}

/**
 * Compact display label for a pod inside workload logs so long Deployment prefixes
 * (e.g. `ta-contents-skypiea-dpl-f6668f864-qxzfq`) don't eat horizontal space.
 */
export function formatShortPodLabel(podName: string, workloadName?: string): string {
  if (!podName) return "";
  let short = podName;
  if (workloadName && podName.startsWith(`${workloadName}-`)) {
    const rest = podName.slice(workloadName.length + 1);
    if (rest) {
      // Deployment pods look like `<rs-hash>-<5-char-id>` (e.g. `f6668f864-qxzfq`) -> `qxzfq`
      const rsMatch = rest.match(/^[a-z0-9]{6,10}-([a-z0-9]{4,6})$/);
      if (rsMatch?.[1]) {
        short = rsMatch[1];
      } else if (/^\d+$/.test(rest)) {
        // StatefulSet ordinal (e.g. `redis-0` -> `#0`)
        short = `#${rest}`;
      } else {
        short = rest;
      }
    }
  } else if (podName.length > 16) {
    const tailMatch = podName.match(/-([a-z0-9]{4,6})$/);
    short = tailMatch?.[1] ? `…${tailMatch[1]}` : `…${podName.slice(-10)}`;
  }
  return short;
}

export function compileLogSearch(
  query: string,
  useRegex: boolean,
): { regex: RegExp | null; error: string | null } {
  const trimmed = query.trim();
  if (!trimmed) return { regex: null, error: null };
  if (!useRegex) {
    const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return { regex: new RegExp(escaped, "gi"), error: null };
  }
  try {
    return { regex: new RegExp(trimmed, "gi"), error: null };
  } catch (err) {
    return {
      regex: null,
      error: err instanceof Error ? err.message : "Invalid regular expression",
    };
  }
}

export function splitHighlightSegments(
  text: string,
  regex: RegExp | null,
): Array<{ text: string; match: boolean }> {
  if (!regex || !text) return [{ text, match: false }];
  const re = new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : `${regex.flags}g`);
  const segments: Array<{ text: string; match: boolean }> = [];
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  let guard = 0;
  while ((m = re.exec(text)) !== null && guard < 200) {
    guard += 1;
    if (m[0].length === 0) {
      re.lastIndex += 1;
      continue;
    }
    if (m.index > lastIndex) {
      segments.push({ text: text.slice(lastIndex, m.index), match: false });
    }
    segments.push({ text: m[0], match: true });
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < text.length) {
    segments.push({ text: text.slice(lastIndex), match: false });
  }
  return segments.length > 0 ? segments : [{ text, match: false }];
}

