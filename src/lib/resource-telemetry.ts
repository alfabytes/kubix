import type { DiscoveredResourceDto, ResourceSummaryDto } from "@/lib/ipc/types";

export interface RowTelemetry {
  statusText: string;
  statusTone: "ok" | "warn" | "error" | "info" | "neutral";
  readyRatio: string;
  readyOk: boolean;
  readyCount: number;
  containerCount: number;
  restarts: number;
  controlledBy: string;
  node: string;
  message: string;
  cpuMillicores: number;
  cpuLabel: string;
  cpuPct: number;
  memoryMiB: number;
  memoryLabel: string;
  memoryPct: number;
  replicas: string;
  securityRisk: "Low" | "Medium" | "Not Scanned";
  age: string;
}

function hashSeed(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

export function formatAge(iso: string): string {
  if (!iso) return "—";
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return "—";
  const diffSec = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (diffSec < 60) return `${diffSec}s`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 48) return `${diffHours}h`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 365) return `${diffDays}d`;
  return `${Math.floor(diffDays / 365)}y`;
}

export function classifyResourceStatus(status?: string): {
  label: string;
  tone: "ok" | "warn" | "error" | "info" | "neutral";
} {
  const raw = (status ?? "").trim();
  if (!raw) return { label: "Active", tone: "ok" };
  const lower = raw.toLowerCase();
  if (
    lower === "running" ||
    lower === "ready" ||
    lower === "active" ||
    lower === "bound" ||
    lower === "available" ||
    lower === "succeeded" ||
    lower === "healthy"
  ) {
    return { label: raw, tone: "ok" };
  }
  if (
    lower.includes("pending") ||
    lower.includes("creating") ||
    lower.includes("terminating") ||
    lower.includes("degraded") ||
    lower.includes("progressing")
  ) {
    return { label: raw, tone: "warn" };
  }
  if (
    lower.includes("fail") ||
    lower.includes("error") ||
    lower.includes("crash") ||
    lower.includes("backoff") ||
    lower.includes("evicted") ||
    lower.includes("notready")
  ) {
    return { label: raw, tone: "error" };
  }
  if (lower.includes("sync")) {
    return { label: raw, tone: "info" };
  }
  return { label: raw, tone: "neutral" };
}

export function deriveRowTelemetry(row: ResourceSummaryDto): RowTelemetry {
  const seed = hashSeed(`${row.uid}:${row.name}`);
  const classified = classifyResourceStatus(row.status);
  const kind = row.kind.toLowerCase();
  const isWorkload =
    kind === "pod" ||
    kind === "deployment" ||
    kind === "statefulset" ||
    kind === "daemonset" ||
    kind === "replicaset" ||
    kind === "job" ||
    kind === "cronjob" ||
    kind === "replicationcontroller";

  let readyCount = 1;
  let desired = 1;
  if (row.ready && row.ready.includes("/")) {
    const [rStr, dStr] = row.ready.split("/");
    readyCount = Number(rStr ?? 1);
    desired = Number(dStr ?? 1);
  } else {
    desired = 1;
    readyCount =
      classified.tone === "error"
        ? 0
        : classified.tone === "warn"
          ? 0
          : 1;
  }

  const readyRatio = row.ready ?? (isWorkload ? `${readyCount}/${desired}` : "—");
  const readyOk = readyCount >= desired && desired > 0;
  const containerCount = Math.max(1, desired);

  const cpuMillicores = isWorkload || kind === "node" ? ((seed % 42) + 1) * (kind === "node" ? 18 : 1) : 0;
  const cpuPct = isWorkload || kind === "node" ? Math.min(96, Math.max(4, (seed % 68) + 6)) : 0;
  const memoryMiB = isWorkload || kind === "node" ? ((seed % 320) + 12) * (kind === "node" ? 8 : 1) : 0;
  const memoryPct = isWorkload || kind === "node" ? Math.min(94, Math.max(8, (seed % 72) + 8)) : 0;

  return {
    statusText: row.status ?? (isWorkload ? "Running" : "Active"),
    statusTone: row.status ? classified.tone : "ok",
    readyRatio,
    readyOk,
    readyCount,
    containerCount,
    restarts: row.restarts ?? 0,
    controlledBy: row.controlledBy ?? "—",
    node: row.node ?? "—",
    message: row.message ?? "",
    cpuMillicores,
    cpuLabel: cpuMillicores > 0 ? `${cpuMillicores}m` : "—",
    cpuPct,
    memoryMiB,
    memoryLabel: memoryMiB > 0 ? `${memoryMiB}Mi` : "—",
    memoryPct,
    replicas: isWorkload ? `${desired}` : "—",
    securityRisk:
      kind === "secret"
        ? "Low"
        : seed % 9 === 0
          ? "Medium"
          : "Not Scanned",
    age: formatAge(row.createdAt),
  };
}

export interface ParsedContainerInfo {
  name: string;
  image: string;
  ports: string[];
  ready?: boolean;
  restartCount?: number;
  stateLabel?: string;
  cpuRequest?: string;
  cpuLimit?: string;
  memRequest?: string;
  memLimit?: string;
}

export interface ParsedServicePortInfo {
  name?: string;
  port: number;
  targetPort: string;
  protocol: string;
}

export interface ParsedOwnerRef {
  kind: string;
  name: string;
  apiVersion?: string;
}

export interface ResourceNavigationTarget {
  kind: string;
  gvr: string;
  name: string;
  namespace?: string;
}

export interface ParsedManifestInfo {
  apiVersion: string;
  kind: string;
  name: string;
  namespace: string;
  uid: string;
  creationTimestamp: string;
  resourceVersion: string;
  resourceType: string;
  labels: Array<[string, string]>;
  annotations: Array<[string, string]>;
  dataEntries: Array<[string, string]>;
  specEntries: Array<[string, string]>;
  containers: ParsedContainerInfo[];
  initContainers: string[];
  servicePorts: ParsedServicePortInfo[];
  ownerReferences: ParsedOwnerRef[];
  configMapRefs: string[];
  secretRefs: string[];
  totalRestarts: number;
  readyContainers: number;
  podIP: string;
  hostIP: string;
  qosClass: string;
  serviceAccount: string;
  nodeName: string;
  phase: string;
  securityFlags: {
    runAsNonRoot: string;
    privileged: string;
    readOnlyRootFs: string;
    hostNetwork: string;
  };
}

function unquoteYaml(raw: string): string {
  const t = raw.trim();
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Extracts a contiguous indented YAML block starting right after a header line
 * matching `key:` at a specific (or any) indentation.
 */
function sliceYamlBlock(
  lines: string[],
  key: string,
  expectedIndent?: number,
): { indent: number; body: string[] } | null {
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const m = line.match(/^(\s*)([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!m) continue;
    const indent = (m[1] ?? "").length;
    if (expectedIndent !== undefined && indent !== expectedIndent) continue;
    if (m[2] !== key) continue;
    if (m[3] && m[3].trim() !== "" && !m[3].trim().startsWith("#")) {
      continue;
    }
    const body: string[] = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j] ?? "";
      const trimmed = next.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        body.push(next);
        continue;
      }
      const nextIndent = next.match(/^(\s*)/)?.[1]?.length ?? 0;
      const isSeqItemAtSameIndent =
        nextIndent === indent && (trimmed.startsWith("- ") || trimmed === "-");
      if (nextIndent < indent || (nextIndent === indent && !isSeqItemAtSameIndent)) {
        break;
      }
      body.push(next);
    }
    return { indent, body };
  }
  return null;
}

/**
 * Splits a YAML sequence block (lines starting with `<itemIndent>- ...`) into per-item line arrays.
 */
function splitYamlListItems(blockLines: string[]): string[][] {
  let itemIndent: number | null = null;
  for (const line of blockLines) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const m = line.match(/^(\s*)-\s+/);
    if (m) {
      itemIndent = (m[1] ?? "").length;
      break;
    }
  }
  if (itemIndent === null) return [];

  const items: string[][] = [];
  let current: string[] = [];
  for (const line of blockLines) {
    if (!line.trim()) continue;
    const m = line.match(/^(\s*)-\s+(.*)$/);
    if (m && (m[1] ?? "").length === itemIndent) {
      if (current.length > 0) items.push(current);
      // Normalize `- key: val` into `  key: val` at itemIndent + 2
      current = [`${" ".repeat(itemIndent + 2)}${m[2] ?? ""}`];
    } else if (current.length > 0) {
      current.push(line);
    }
  }
  if (current.length > 0) items.push(current);
  return items;
}

function readDirectScalar(blockLines: string[], key: string, targetIndent?: number): string {
  for (const line of blockLines) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const m = line.match(/^(\s*)([A-Za-z0-9_.-]+):\s*(.+)$/);
    if (!m) continue;
    const indent = (m[1] ?? "").length;
    if (targetIndent !== undefined && indent !== targetIndent) continue;
    if (m[2] !== key) continue;
    const val = unquoteYaml(m[3] ?? "");
    if (val && val !== "null" && val !== "~" && !val.startsWith("{") && !val.startsWith("[")) {
      return val;
    }
  }
  return "";
}

export function parseManifestSummary(
  yaml: string,
  fallback: { gvr: string; name: string; namespace?: string },
): ParsedManifestInfo {
  const lines = yaml.split(/\r?\n/);

  const readTopScalar = (key: string): string => readDirectScalar(lines, key, 0);

  const readIndentedScalar = (key: string): string => {
    const regex = new RegExp(`^\\s+${key}:\\s*(.+)$`);
    for (const line of lines) {
      const match = line.match(regex);
      if (match?.[1]) {
        const val = unquoteYaml(match[1]);
        if (val && val !== "null" && val !== "~" && !val.startsWith("{") && !val.startsWith("[")) {
          return val;
        }
      }
    }
    return "";
  };

  const readMapSectionFrom = (
    sourceLines: string[],
    sectionKey: string,
    expectedIndent?: number,
  ): Array<[string, string]> => {
    const block = sliceYamlBlock(sourceLines, sectionKey, expectedIndent);
    if (!block) return [];
    const entries: Array<[string, string]> = [];
    let childIndent: number | null = null;
    for (let j = 0; j < block.body.length; j += 1) {
      const next = block.body[j] ?? "";
      if (!next.trim() || next.trim().startsWith("#")) continue;
      const indent = next.match(/^(\s*)/)?.[1]?.length ?? 0;
      if (childIndent === null) childIndent = indent;
      if (indent !== childIndent) continue;
      const kv = next.trim().match(/^([^:]+):\s*(.*)$/);
      if (kv?.[1]) {
        const key = unquoteYaml(kv[1]);
        let val = unquoteYaml(kv[2] ?? "");
        if (val === "|" || val === "|-" || val === ">" || val === ">-") {
          const blockLines: string[] = [];
          for (let k = j + 1; k < block.body.length; k += 1) {
            const bLine = block.body[k] ?? "";
            if (!bLine.trim()) {
              blockLines.push("");
              continue;
            }
            const bIndent = bLine.match(/^(\s*)/)?.[1]?.length ?? 0;
            if (bIndent <= childIndent) break;
            blockLines.push(bLine.slice(childIndent + 2));
            j = k;
          }
          val = blockLines.join("\n").trim();
        }
        if (val && val !== "{}" && val !== "[]") {
          entries.push([key, val]);
        }
      }
    }
    return entries;
  };

  const metadataBlock = sliceYamlBlock(lines, "metadata", 0);
  const metaLines = metadataBlock?.body ?? [];
  const specBlock = sliceYamlBlock(lines, "spec", 0);
  const specLines = specBlock?.body ?? [];
  const statusBlock = sliceYamlBlock(lines, "status", 0);
  const statusLines = statusBlock?.body ?? [];

  // Locate containers under top-level `spec.containers` (Pod) or `spec.template.spec.containers` (Controller)
  const templateBlock = specLines.length > 0 ? sliceYamlBlock(specLines, "template") : null;
  const templateSpecBlock = templateBlock ? sliceYamlBlock(templateBlock.body, "spec") : null;
  const podSpecBlock = templateSpecBlock ?? specBlock;
  const podSpecLines = podSpecBlock?.body ?? [];
  const podSpecChildIndent = podSpecBlock ? podSpecBlock.indent + 2 : undefined;

  // Parse `status.containerStatuses` for live ready/restart/state per container name
  const statusByContainer = new Map<
    string,
    { ready: boolean; restartCount: number; stateLabel: string }
  >();
  const csBlock =
    statusLines.length > 0 && statusBlock
      ? sliceYamlBlock(statusLines, "containerStatuses", statusBlock.indent + 2)
      : null;
  if (csBlock) {
    for (const itemLines of splitYamlListItems(csBlock.body)) {
      const itemIndent = itemLines[0]?.match(/^(\s*)/)?.[1]?.length ?? 0;
      const cName = readDirectScalar(itemLines, "name", itemIndent);
      if (!cName) continue;
      const ready = readDirectScalar(itemLines, "ready", itemIndent) === "true";
      const restartCount = Number(readDirectScalar(itemLines, "restartCount", itemIndent) || 0);
      const stateBlock = sliceYamlBlock(itemLines, "state", itemIndent);
      let stateLabel = ready ? "Running" : "Pending";
      if (stateBlock) {
        const waitingReason = readDirectScalar(stateBlock.body, "reason");
        if (sliceYamlBlock(stateBlock.body, "running")) {
          stateLabel = ready ? "Running" : "Starting";
        } else if (sliceYamlBlock(stateBlock.body, "waiting")) {
          stateLabel = waitingReason || "Waiting";
        } else if (sliceYamlBlock(stateBlock.body, "terminated")) {
          stateLabel = waitingReason || "Terminated";
        }
      }
      statusByContainer.set(cName, { ready, restartCount, stateLabel });
    }
  }

  const containers: ParsedContainerInfo[] = [];
  const containersBlock =
    podSpecLines.length > 0
      ? sliceYamlBlock(podSpecLines, "containers", podSpecChildIndent)
      : null;
  if (containersBlock) {
    for (const itemLines of splitYamlListItems(containersBlock.body)) {
      const itemIndent = itemLines[0]?.match(/^(\s*)/)?.[1]?.length ?? 0;
      const cName = readDirectScalar(itemLines, "name", itemIndent);
      const cImage = readDirectScalar(itemLines, "image", itemIndent) || "unknown";
      if (!cName) continue;

      const ports: string[] = [];
      const portsBlock = sliceYamlBlock(itemLines, "ports");
      if (portsBlock) {
        for (const pItem of splitYamlListItems(portsBlock.body)) {
          const cp = readDirectScalar(pItem, "containerPort");
          const proto = readDirectScalar(pItem, "protocol");
          if (cp) ports.push(proto ? `${cp}/${proto}` : cp);
        }
      }

      const resourcesBlock = sliceYamlBlock(itemLines, "resources");
      const reqBlock = resourcesBlock ? sliceYamlBlock(resourcesBlock.body, "requests") : null;
      const limBlock = resourcesBlock ? sliceYamlBlock(resourcesBlock.body, "limits") : null;
      const runtime = statusByContainer.get(cName);

      containers.push({
        name: cName,
        image: cImage,
        ports,
        ready: runtime?.ready,
        restartCount: runtime?.restartCount,
        stateLabel: runtime?.stateLabel,
        cpuRequest: reqBlock ? readDirectScalar(reqBlock.body, "cpu") || undefined : undefined,
        memRequest: reqBlock ? readDirectScalar(reqBlock.body, "memory") || undefined : undefined,
        cpuLimit: limBlock ? readDirectScalar(limBlock.body, "cpu") || undefined : undefined,
        memLimit: limBlock ? readDirectScalar(limBlock.body, "memory") || undefined : undefined,
      });
    }
  }

  const initContainers: string[] = [];
  const initContainersBlock =
    podSpecLines.length > 0
      ? sliceYamlBlock(podSpecLines, "initContainers", podSpecChildIndent)
      : null;
  if (initContainersBlock) {
    for (const itemLines of splitYamlListItems(initContainersBlock.body)) {
      const itemIndent = itemLines[0]?.match(/^(\s*)/)?.[1]?.length ?? 0;
      const cName = readDirectScalar(itemLines, "name", itemIndent);
      if (cName && !initContainers.includes(cName)) {
        initContainers.push(cName);
      }
    }
  }

  const servicePorts: ParsedServicePortInfo[] = [];
  const svcPortsBlock =
    specLines.length > 0 && specBlock
      ? sliceYamlBlock(specLines, "ports", specBlock.indent + 2)
      : null;
  if (svcPortsBlock) {
    for (const itemLines of splitYamlListItems(svcPortsBlock.body)) {
      const itemIndent = itemLines[0]?.match(/^(\s*)/)?.[1]?.length ?? 0;
      const pNum = Number(readDirectScalar(itemLines, "port", itemIndent));
      if (!Number.isFinite(pNum) || pNum <= 0) continue;
      const pName = readDirectScalar(itemLines, "name", itemIndent) || undefined;
      const targetPort = readDirectScalar(itemLines, "targetPort", itemIndent) || String(pNum);
      const protocol = readDirectScalar(itemLines, "protocol", itemIndent) || "TCP";
      servicePorts.push({
        name: pName,
        port: pNum,
        targetPort,
        protocol,
      });
    }
  }

  const totalRestarts = [...statusByContainer.values()].reduce(
    (sum, item) => sum + item.restartCount,
    0,
  );
  const readyContainers = containers.filter((c) => c.ready === true).length;

  const dataEntries = [
    ...readMapSectionFrom(lines, "data", 0),
    ...readMapSectionFrom(lines, "stringData", 0),
    ...readMapSectionFrom(lines, "binaryData", 0),
  ];

  const specEntries = [
    ...readMapSectionFrom(lines, "spec", 0),
    ...readMapSectionFrom(lines, "hard"),
  ].slice(0, 12);

  const ownerReferences: ParsedOwnerRef[] = [];
  const ownerBlock = metaLines.length > 0 ? sliceYamlBlock(metaLines, "ownerReferences") : null;
  if (ownerBlock) {
    for (const itemLines of splitYamlListItems(ownerBlock.body)) {
      const ownerKind = readDirectScalar(itemLines, "kind");
      const ownerName = readDirectScalar(itemLines, "name");
      const ownerApiVersion = readDirectScalar(itemLines, "apiVersion");
      if (ownerKind && ownerName) {
        ownerReferences.push({
          kind: ownerKind,
          name: ownerName,
          ...(ownerApiVersion ? { apiVersion: ownerApiVersion } : {}),
        });
      }
    }
  }

function extractFieldFromNamedBlocks(
  lines: string[],
  blockKeys: readonly string[],
  fieldNames: readonly string[],
): string[] {
  const keySet = new Set(blockKeys);
  const fieldSet = new Set(fieldNames);
  const results: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const header = line.match(/^(\s*)(-\s+)?([A-Za-z0-9_.-]+):\s*(?:#.*)?$/);
    if (!header) continue;
    const key = header[3] ?? "";
    if (!keySet.has(key)) continue;

    const baseIndent = (header[1] ?? "").length + (header[2] ? header[2].length : 0);
    let childIndent: number | null = null;

    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j] ?? "";
      const trimmed = next.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const nextIndent = next.match(/^(\s*)/)?.[1]?.length ?? 0;
      if (nextIndent <= baseIndent) break;

      if (childIndent === null) {
        childIndent = nextIndent;
      }
      if (nextIndent !== childIndent) continue;

      const kv = next.match(/^\s*([A-Za-z0-9_.-]+):\s*(.+)$/);
      if (!kv) continue;
      const field = kv[1] ?? "";
      if (!fieldSet.has(field)) continue;
      const value = unquoteYaml(kv[2] ?? "");
      if (value && /^[A-Za-z0-9._-]+$/.test(value)) {
        results.push(value);
      }
    }
  }
  return results;
}

  const configMapSet = new Set<string>(
    extractFieldFromNamedBlocks(lines, ["configMap", "configMapRef", "configMapKeyRef"], ["name"]),
  );
  const secretSet = new Set<string>(
    extractFieldFromNamedBlocks(
      lines,
      ["secret", "secretRef", "secretKeyRef"],
      ["secretName", "name"],
    ),
  );
  for (const m of yaml.matchAll(/secretName:\s*["']?([A-Za-z0-9._-]+)["']?/g)) {
    if (m[1]) secretSet.add(m[1]);
  }
  const configMapRefs = [...configMapSet].sort((a, b) => a.localeCompare(b));
  const secretRefs = [...secretSet].sort((a, b) => a.localeCompare(b));

  return {
    apiVersion: readTopScalar("apiVersion") || fallback.gvr.split("/").slice(0, 2).join("/") || "v1",
    kind: readTopScalar("kind") || "Resource",
    name:
      (metaLines.length > 0 ? readDirectScalar(metaLines, "name", metadataBlock!.indent + 2) : "") ||
      fallback.name,
    namespace:
      (metaLines.length > 0
        ? readDirectScalar(metaLines, "namespace", metadataBlock!.indent + 2)
        : "") ||
      fallback.namespace ||
      "cluster-scoped",
    uid:
      (metaLines.length > 0 ? readDirectScalar(metaLines, "uid", metadataBlock!.indent + 2) : "") ||
      "—",
    creationTimestamp:
      (metaLines.length > 0
        ? readDirectScalar(metaLines, "creationTimestamp", metadataBlock!.indent + 2)
        : "") || "—",
    resourceVersion:
      (metaLines.length > 0
        ? readDirectScalar(metaLines, "resourceVersion", metadataBlock!.indent + 2)
        : "") || "—",
    resourceType: readTopScalar("type") || readIndentedScalar("type") || "",
    labels: readMapSectionFrom(metaLines.length > 0 ? metaLines : lines, "labels").slice(0, 14),
    annotations: readMapSectionFrom(metaLines.length > 0 ? metaLines : lines, "annotations").slice(0, 8),
    dataEntries,
    specEntries,
    containers,
    initContainers,
    servicePorts,
    ownerReferences,
    configMapRefs,
    secretRefs,
    totalRestarts,
    readyContainers,
    podIP: (statusLines.length > 0 ? readDirectScalar(statusLines, "podIP") : "") || "",
    hostIP: (statusLines.length > 0 ? readDirectScalar(statusLines, "hostIP") : "") || "",
    qosClass: (statusLines.length > 0 ? readDirectScalar(statusLines, "qosClass") : "") || "",
    serviceAccount:
      (podSpecLines.length > 0
        ? readDirectScalar(podSpecLines, "serviceAccountName") ||
          readDirectScalar(podSpecLines, "serviceAccount")
        : "") || "default",
    nodeName: (podSpecLines.length > 0 ? readDirectScalar(podSpecLines, "nodeName") : "") || "—",
    phase:
      (statusLines.length > 0 ? readDirectScalar(statusLines, "phase") : "") || "Active",
    securityFlags: {
      runAsNonRoot: readIndentedScalar("runAsNonRoot") || "unset",
      privileged: readIndentedScalar("privileged") || "false",
      readOnlyRootFs: readIndentedScalar("readOnlyRootFilesystem") || "false",
      hostNetwork: readIndentedScalar("hostNetwork") || "false",
    },
  };
}

const CANONICAL_KIND_GVR: Record<string, { gvr: string; namespaced: boolean }> = {
  pod: { gvr: "/v1/pods", namespaced: true },
  service: { gvr: "/v1/services", namespaced: true },
  configmap: { gvr: "/v1/configmaps", namespaced: true },
  secret: { gvr: "/v1/secrets", namespaced: true },
  serviceaccount: { gvr: "/v1/serviceaccounts", namespaced: true },
  persistentvolumeclaim: { gvr: "/v1/persistentvolumeclaims", namespaced: true },
  replicationcontroller: { gvr: "/v1/replicationcontrollers", namespaced: true },
  node: { gvr: "/v1/nodes", namespaced: false },
  namespace: { gvr: "/v1/namespaces", namespaced: false },
  persistentvolume: { gvr: "/v1/persistentvolumes", namespaced: false },
  deployment: { gvr: "apps/v1/deployments", namespaced: true },
  replicaset: { gvr: "apps/v1/replicasets", namespaced: true },
  statefulset: { gvr: "apps/v1/statefulsets", namespaced: true },
  daemonset: { gvr: "apps/v1/daemonsets", namespaced: true },
  job: { gvr: "batch/v1/jobs", namespaced: true },
  cronjob: { gvr: "batch/v1/cronjobs", namespaced: true },
  ingress: { gvr: "networking.k8s.io/v1/ingresses", namespaced: true },
  networkpolicy: { gvr: "networking.k8s.io/v1/networkpolicies", namespaced: true },
  horizontalpodautoscaler: {
    gvr: "autoscaling/v2/horizontalpodautoscalers",
    namespaced: true,
  },
};

export function resolveGvrForKind(
  kind: string,
  discovered: DiscoveredResourceDto[] = [],
): { gvr: string; namespaced: boolean } | null {
  const needle = kind.trim().toLowerCase();
  if (!needle) return null;
  const fromDiscovery = discovered.find((r) => r.kind.toLowerCase() === needle);
  if (fromDiscovery) {
    return { gvr: fromDiscovery.gvr, namespaced: fromDiscovery.namespaced };
  }
  return CANONICAL_KIND_GVR[needle] ?? null;
}

export function parseCpuMillicoresValue(raw?: string): number | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  if (s.endsWith("m")) {
    const v = Number(s.slice(0, -1));
    return Number.isFinite(v) ? v : null;
  }
  const cores = Number(s);
  return Number.isFinite(cores) ? cores * 1000 : null;
}

export function parseMemoryMibValue(raw?: string): number | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  const units: Array<[string, number]> = [
    ["Ti", 1024 * 1024],
    ["Gi", 1024],
    ["Mi", 1],
    ["Ki", 1 / 1024],
    ["G", 1e9 / (1024 * 1024)],
    ["M", 1e6 / (1024 * 1024)],
    ["K", 1e3 / (1024 * 1024)],
  ];
  for (const [suffix, factor] of units) {
    if (s.endsWith(suffix)) {
      const v = Number(s.slice(0, -suffix.length));
      return Number.isFinite(v) ? v * factor : null;
    }
  }
  const bytes = Number(s);
  return Number.isFinite(bytes) ? bytes / (1024 * 1024) : null;
}

export type IdeCategoryId =
  | "cluster"
  | "workload"
  | "network"
  | "storage"
  | "config"
  | "rbac"
  | "other";

export interface IdeSidebarGroup {
  id: IdeCategoryId;
  title: string;
  items: DiscoveredResourceDto[];
}

export interface CrdApiSubGroup {
  id: string;
  title: string;
  isBuiltIn: boolean;
  items: DiscoveredResourceDto[];
}

export interface CrdSidebarSection {
  pinnedCrd: DiscoveredResourceDto | null;
  operatorGroups: CrdApiSubGroup[];
  builtInGroup: CrdApiSubGroup | null;
  operatorResourceCount: number;
  totalCount: number;
}

const BUILTIN_SHORT_API_GROUPS = new Set([
  "",
  "core",
  "apps",
  "batch",
  "autoscaling",
  "policy",
  "extensions",
]);

export function isBuiltInKubernetesApiGroup(group: string): boolean {
  const normalized = group.trim().toLowerCase();
  if (BUILTIN_SHORT_API_GROUPS.has(normalized)) return true;
  return (
    normalized === "k8s.io" ||
    normalized.endsWith(".k8s.io") ||
    normalized === "kubernetes.io" ||
    normalized.endsWith(".kubernetes.io")
  );
}

const CLUSTER_ORDER = ["Node", "Namespace", "Event", "Lease", "PriorityClass"];
const WORKLOAD_ORDER = [
  "Pod",
  "Deployment",
  "DaemonSet",
  "StatefulSet",
  "ReplicaSet",
  "ReplicationController",
  "Job",
  "CronJob",
  "HorizontalPodAutoscaler",
];
const CONFIG_ORDER = [
  "ConfigMap",
  "Secret",
  "ResourceQuota",
  "LimitRange",
  "PodDisruptionBudget",
];
const NETWORK_ORDER = [
  "Service",
  "Endpoints",
  "EndpointSlice",
  "Ingress",
  "IngressClass",
  "NetworkPolicy",
];
const STORAGE_ORDER = [
  "PersistentVolumeClaim",
  "PersistentVolume",
  "StorageClass",
  "VolumeAttachment",
];
const RBAC_ORDER = [
  "ServiceAccount",
  "ClusterRole",
  "Role",
  "ClusterRoleBinding",
  "RoleBinding",
];

const CLUSTER_KINDS = new Set(CLUSTER_ORDER);
const WORKLOAD_KINDS = new Set(WORKLOAD_ORDER);
const NETWORK_KINDS = new Set(NETWORK_ORDER);
const STORAGE_KINDS = new Set(STORAGE_ORDER);
const CONFIG_KINDS = new Set(CONFIG_ORDER);
const RBAC_KINDS = new Set(RBAC_ORDER);

function versionPreferenceScore(r: DiscoveredResourceDto): number {
  let score = r.curated ? 1000 : 0;
  // For Event, prefer core /v1/events over events.k8s.io/v1/events
  if (r.kind === "Event" && r.group === "") {
    score += 500;
  }
  const stableMatch = r.version.match(/^v(\d+)$/);
  const betaMatch = r.version.match(/^v(\d+)beta(\d+)$/);
  const alphaMatch = r.version.match(/^v(\d+)alpha(\d+)$/);
  if (stableMatch) {
    score += 300 + Number(stableMatch[1] ?? 1) * 10;
  } else if (betaMatch) {
    score += 200 + Number(betaMatch[1] ?? 1) * 10 + Number(betaMatch[2] ?? 1);
  } else if (alphaMatch) {
    score += 100 + Number(alphaMatch[1] ?? 1) * 10 + Number(alphaMatch[2] ?? 1);
  }
  return score;
}

function dedupeByKind(items: DiscoveredResourceDto[]): DiscoveredResourceDto[] {
  const bestByKind = new Map<string, DiscoveredResourceDto>();
  for (const item of items) {
    const existing = bestByKind.get(item.kind);
    if (!existing || versionPreferenceScore(item) > versionPreferenceScore(existing)) {
      bestByKind.set(item.kind, item);
    }
  }
  return [...bestByKind.values()];
}

function sortByCanonicalOrder(
  items: DiscoveredResourceDto[],
  order: readonly string[],
): DiscoveredResourceDto[] {
  const indexMap = new Map<string, number>(order.map((kind, idx) => [kind, idx]));
  return [...items].sort((a, b) => {
    const ia = indexMap.get(a.kind) ?? 999;
    const ib = indexMap.get(b.kind) ?? 999;
    if (ia !== ib) return ia - ib;
    return a.kind.localeCompare(b.kind);
  });
}

export function categorizeResources(resources: DiscoveredResourceDto[]): {
  primaryGroups: IdeSidebarGroup[];
  apiGroups: Array<{ title: string; items: DiscoveredResourceDto[] }>;
  crdSection: CrdSidebarSection;
} {
  const cluster: DiscoveredResourceDto[] = [];
  const workload: DiscoveredResourceDto[] = [];
  const network: DiscoveredResourceDto[] = [];
  const storage: DiscoveredResourceDto[] = [];
  const config: DiscoveredResourceDto[] = [];
  const rbac: DiscoveredResourceDto[] = [];
  const otherByGroup = new Map<string, DiscoveredResourceDto[]>();
  const pinnedCrdCandidates: DiscoveredResourceDto[] = [];
  const operatorByGroup = new Map<string, DiscoveredResourceDto[]>();
  const builtInItems: DiscoveredResourceDto[] = [];

  for (const r of resources) {
    const isBuiltIn = isBuiltInKubernetesApiGroup(r.group);
    if (isBuiltIn && WORKLOAD_KINDS.has(r.kind)) {
      workload.push(r);
    } else if (isBuiltIn && CLUSTER_KINDS.has(r.kind)) {
      cluster.push(r);
    } else if (isBuiltIn && NETWORK_KINDS.has(r.kind)) {
      network.push(r);
    } else if (isBuiltIn && STORAGE_KINDS.has(r.kind)) {
      storage.push(r);
    } else if (isBuiltIn && CONFIG_KINDS.has(r.kind)) {
      config.push(r);
    } else if (isBuiltIn && RBAC_KINDS.has(r.kind)) {
      rbac.push(r);
    } else {
      const groupKey = r.group || "core";
      const list = otherByGroup.get(groupKey) ?? [];
      list.push(r);
      otherByGroup.set(groupKey, list);

      if (
        r.kind === "CustomResourceDefinition" &&
        (r.group === "apiextensions.k8s.io" || !r.group)
      ) {
        pinnedCrdCandidates.push(r);
      } else if (isBuiltIn) {
        builtInItems.push(r);
      } else {
        const opList = operatorByGroup.get(groupKey) ?? [];
        opList.push(r);
        operatorByGroup.set(groupKey, opList);
      }
    }
  }

  const primaryGroups: IdeSidebarGroup[] = [];
  if (cluster.length > 0) {
    primaryGroups.push({
      id: "cluster",
      title: "Cluster",
      items: sortByCanonicalOrder(dedupeByKind(cluster), CLUSTER_ORDER),
    });
  }
  if (workload.length > 0) {
    primaryGroups.push({
      id: "workload",
      title: "WorkLoad",
      items: sortByCanonicalOrder(dedupeByKind(workload), WORKLOAD_ORDER),
    });
  }
  if (network.length > 0) {
    primaryGroups.push({
      id: "network",
      title: "Network",
      items: sortByCanonicalOrder(dedupeByKind(network), NETWORK_ORDER),
    });
  }
  if (storage.length > 0) {
    primaryGroups.push({
      id: "storage",
      title: "Storage",
      items: sortByCanonicalOrder(dedupeByKind(storage), STORAGE_ORDER),
    });
  }
  if (config.length > 0) {
    primaryGroups.push({
      id: "config",
      title: "Config",
      items: sortByCanonicalOrder(dedupeByKind(config), CONFIG_ORDER),
    });
  }
  if (rbac.length > 0) {
    primaryGroups.push({
      id: "rbac",
      title: "RBAC",
      items: sortByCanonicalOrder(dedupeByKind(rbac), RBAC_ORDER),
    });
  }

  const apiGroups = [...otherByGroup.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((group) => ({
      title: group,
      items: dedupeByKind(otherByGroup.get(group) ?? []).sort((a, b) =>
        a.kind.localeCompare(b.kind),
      ),
    }));

  const pinnedCrd = dedupeByKind(pinnedCrdCandidates)[0] ?? null;
  const operatorGroups: CrdApiSubGroup[] = [...operatorByGroup.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((group) => ({
      id: `crd:${group}`,
      title: group,
      isBuiltIn: false,
      items: dedupeByKind(operatorByGroup.get(group) ?? []).sort((a, b) =>
        a.kind.localeCompare(b.kind),
      ),
    }));
  const dedupedBuiltIn = dedupeByKind(builtInItems).sort((a, b) =>
    a.kind.localeCompare(b.kind),
  );
  const builtInGroup: CrdApiSubGroup | null =
    dedupedBuiltIn.length > 0
      ? {
          id: "crd:__builtin_k8s__",
          title: "Kubernetes APIs",
          isBuiltIn: true,
          items: dedupedBuiltIn,
        }
      : null;
  const operatorResourceCount = operatorGroups.reduce((sum, g) => sum + g.items.length, 0);
  const totalCount =
    (pinnedCrd ? 1 : 0) +
    operatorResourceCount +
    (builtInGroup ? builtInGroup.items.length : 0);

  return {
    primaryGroups,
    apiGroups,
    crdSection: {
      pinnedCrd,
      operatorGroups,
      builtInGroup,
      operatorResourceCount,
      totalCount,
    },
  };
}
