import type { NamespaceTopologyDto, ResourceSummaryDto } from "@/lib/ipc/types";
import { parseManifestSummary } from "@/lib/resource-telemetry";

export interface TopologyFocusResource {
  kind: string;
  name: string;
  namespace?: string;
}

export type TopologyNodeKind =
  | "Pod"
  | "Deployment"
  | "StatefulSet"
  | "DaemonSet"
  | "ReplicaSet"
  | "Job"
  | "CronJob"
  | "HorizontalPodAutoscaler"
  | "Service"
  | "Ingress"
  | "Gateway"
  | "HTTPRoute"
  | "GRPCRoute"
  | "TLSRoute"
  | "TCPRoute"
  | "Certificate"
  | "PersistentVolumeClaim"
  | "Node"
  | "ConfigMap"
  | "Secret"
  | "ServiceAccount"
  | "Namespace"
  | (string & {});

export interface TopologyDetailRow {
  icon: "kind" | "scope" | "image" | "net" | "status";
  label: string;
  value: string;
  tone?: "default" | "positive" | "warn";
  progressPct?: number;
}

/** @deprecated Kept as alias for backwards compatibility */
export type QuorumDetailRow = TopologyDetailRow;

export interface TopologyNode {
  id: string;
  kind: TopologyNodeKind;
  gvr?: string;
  name: string;
  namespace?: string;
  status: "Running" | "Ready" | "Active" | "Warning" | "Error";
  isFocus?: boolean;
  isPlaceholder?: boolean;
  external?: boolean;
  layer?: string;
  podCount?: number;
  readyPodCount?: number;
  parentWorkloadId?: string;
  loadTicks?: number;
  details?: TopologyDetailRow[];
  footerLabel?: string;
  x: number;
  y: number;
}

export interface TopologyEdge {
  id: string;
  from: string;
  to: string;
  label: string;
  crossNamespace?: boolean;
}

export type VisualizerLayerPreset = "full" | "traffic" | "ingress-gateway";


export type TopologyCategory = "network" | "workload" | "runtime" | "config" | "operator";

export interface CategoryStyle {
  category: TopologyCategory;
  label: string;
  accentHex: string;
  badgeClass: string;
}

export function getCategoryStyle(kind: TopologyNodeKind): CategoryStyle {
  switch (kind) {
    case "Gateway":
      return {
        category: "network",
        label: "Gateway API",
        accentHex: "#22d3ee",
        badgeClass: "border-cyan-500/40 bg-cyan-500/10 text-cyan-400",
      };
    case "HTTPRoute":
    case "GRPCRoute":
    case "TLSRoute":
    case "TCPRoute":
      return {
        category: "network",
        label: "Gateway Route",
        accentHex: "#06b6d4",
        badgeClass: "border-cyan-500/35 bg-cyan-500/10 text-cyan-300",
      };
    case "Service":
    case "Ingress":
      return {
        category: "network",
        label: "Network",
        accentHex: "#38bdf8",
        badgeClass: "border-sky-500/35 bg-sky-500/10 text-sky-400",
      };
    case "Deployment":
    case "StatefulSet":
    case "DaemonSet":
    case "ReplicaSet":
    case "Job":
    case "CronJob":
    case "HorizontalPodAutoscaler":
      return {
        category: "workload",
        label: "Workloads",
        accentHex: "#a78bfa",
        badgeClass: "border-violet-500/35 bg-violet-500/10 text-violet-400",
      };
    case "Certificate":
      return {
        category: "config",
        label: "TLS Certificate",
        accentHex: "#14b8a6",
        badgeClass: "border-teal-500/40 bg-teal-500/10 text-teal-400",
      };
    case "PersistentVolumeClaim":
    case "ConfigMap":
    case "Secret":
    case "ServiceAccount":
      return {
        category: "config",
        label: kind === "PersistentVolumeClaim" ? "Storage" : "Config & TLS",
        accentHex: "#f59e0b",
        badgeClass: "border-amber-500/35 bg-amber-500/10 text-amber-400",
      };
    case "Pod":
    case "Node":
    case "Namespace":
      return {
        category: "runtime",
        label: "Runtime",
        accentHex: "#10b981",
        badgeClass: "border-emerald-500/35 bg-emerald-500/10 text-emerald-400",
      };
    default:
      return {
        category: "operator",
        label: "Operator CR",
        accentHex: "#e879f9",
        badgeClass: "border-fuchsia-500/40 bg-fuchsia-500/10 text-fuchsia-400",
      };
  }
}


export function defaultDetailsForNode(node: TopologyNode): TopologyDetailRow[] {
  if (node.details && node.details.length > 0) {
    return node.details;
  }

  return [
    { icon: "kind", label: "Kind", value: node.kind },
    {
      icon: "scope",
      label: node.namespace ? "Namespace" : "Scope",
      value: node.namespace || "cluster-scoped",
    },
    {
      icon: "status",
      label: "Status",
      value: node.status,
      tone: node.status === "Warning" ? "warn" : "positive",
    },
  ];
}

/**
 * Extracts real Kubernetes ownerReferences, volumes (Secrets / ConfigMaps), nodeName,
 * podIP, hostIP, replicas, and serviceAccountName directly from a resource's YAML manifest.
 */
function parseRealK8sRelations(
  yaml: string | undefined,
  focus: { kind: string; name: string; namespace?: string },
) {
  const raw = yaml ?? "";
  const summary = parseManifestSummary(raw, {
    gvr: "",
    name: focus.name,
    namespace: focus.namespace,
  });

  // Owner references under metadata.ownerReferences
  const owners: Array<{ kind: string; name: string }> = [];
  const ownerSection = raw.match(/ownerReferences:\s*\n((?:\s+.*\n?)+)/);
  if (ownerSection?.[1]) {
    const block = ownerSection[1];
    const kindMatches = [...block.matchAll(/kind:\s*["']?([A-Za-z0-9_-]+)["']?/g)];
    const nameMatches = [...block.matchAll(/name:\s*["']?([A-Za-z0-9._-]+)["']?/g)];
    kindMatches.forEach((km, idx) => {
      const k = km[1];
      const n = nameMatches[idx]?.[1];
      if (k && n) owners.push({ kind: k, name: n });
    });
  }

  // Fallback owner inference from standard K8s Pod/ReplicaSet naming convention:
  // `<deployment>-<pod-template-hash>-<5char-pod-id>`
  const podPattern = focus.name.match(/^(.+)-([0-9a-f]{6,10})-([a-z0-9]{5})$/);
  const rsPattern = focus.name.match(/^(.+)-([0-9a-f]{6,10})$/);

  let inferredDeployment: string | null = null;
  let inferredReplicaSet: string | null = null;

  if (focus.kind === "Pod") {
    const rsOwner = owners.find((o) => o.kind === "ReplicaSet");
    if (rsOwner) {
      inferredReplicaSet = rsOwner.name;
      const m = rsOwner.name.match(/^(.+)-([0-9a-f]{6,10})$/);
      if (m?.[1]) inferredDeployment = m[1];
    } else if (podPattern?.[1] && podPattern?.[2]) {
      inferredDeployment = podPattern[1];
      inferredReplicaSet = `${podPattern[1]}-${podPattern[2]}`;
    }
  } else if (focus.kind === "ReplicaSet" && rsPattern?.[1]) {
    inferredDeployment = rsPattern[1];
  }

  const secretRefs = summary.secretRefs;
  const configMapRefs = summary.configMapRefs;

  const podIP = raw.match(/podIP:\s*["']?([^\s"']+)["']?/)?.[1] ?? "";
  const hostIP = raw.match(/hostIP:\s*["']?([^\s"']+)["']?/)?.[1] ?? "";
  const replicas = raw.match(/^\s+replicas:\s*(\d+)/m)?.[1] ?? "";
  const readyReplicas = raw.match(/^\s+readyReplicas:\s*(\d+)/m)?.[1] ?? "";
  const strategy = raw.match(/^\s+type:\s*(RollingUpdate|Recreate|OnDelete)/m)?.[1] ?? "";
  const clusterIP = raw.match(/^\s+clusterIP:\s*["']?([^\s"']+)["']?/m)?.[1] ?? "";

  return {
    summary,
    owners,
    inferredDeployment,
    inferredReplicaSet,
    secretRefs,
    configMapRefs,
    podIP,
    hostIP,
    replicas,
    readyReplicas,
    strategy,
    clusterIP,
  };
}

function unquoteScalar(raw: string): string {
  const t = raw.trim();
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
    return t.slice(1, -1);
  }
  return t;
}

function parseServiceSelector(raw: string): Array<[string, string]> {
  const lines = raw.split(/\r?\n/);
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = (lines[i] ?? "").match(/^(\s+)selector:\s*(?:#.*)?$/);
    if (!m) continue;
    const baseIndent = (m[1] ?? "").length;
    let childIndent: number | null = null;
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j] ?? "";
      const trimmed = next.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const nextIndent = next.match(/^(\s*)/)?.[1]?.length ?? 0;
      if (nextIndent <= baseIndent) break;
      if (childIndent === null) childIndent = nextIndent;
      if (nextIndent !== childIndent) continue;
      const kv = next.match(/^\s*([A-Za-z0-9_./-]+):\s*(.+)$/);
      if (kv?.[1] && kv[2]) {
        const val = unquoteScalar(kv[2]);
        if (val && !val.startsWith("{")) pairs.push([kv[1], val]);
      }
    }
    if (pairs.length > 0) break;
  }
  return pairs;
}

function parseIngressBackends(raw: string): {
  hosts: string[];
  services: Array<{ name: string; port?: string }>;
} {
  const lines = raw.split(/\r?\n/);
  const hostSet = new Set<string>();
  const serviceMap = new Map<string, string | undefined>();

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const hostMatch = line.match(/^\s*(?:-\s+)?host:\s*(.+)$/);
    if (hostMatch?.[1]) {
      const host = unquoteScalar(hostMatch[1]);
      if (host) hostSet.add(host);
    }

    // networking.k8s.io/v1: backend.service.{name, port.{number|name}}
    const svcHeader = line.match(/^(\s*)(-\s+)?service:\s*(?:#.*)?$/);
    if (svcHeader) {
      const baseIndent = (svcHeader[1] ?? "").length + (svcHeader[2] ? svcHeader[2].length : 0);
      let svcName = "";
      let svcPort = "";
      for (let j = i + 1; j < lines.length; j += 1) {
        const next = lines[j] ?? "";
        const trimmed = next.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const nextIndent = next.match(/^(\s*)/)?.[1]?.length ?? 0;
        if (nextIndent <= baseIndent) break;
        const nameMatch = next.match(/^\s*name:\s*(.+)$/);
        if (nameMatch?.[1] && !svcName) {
          svcName = unquoteScalar(nameMatch[1]);
        }
        const numMatch = next.match(/^\s*number:\s*(\d+)/);
        if (numMatch?.[1] && !svcPort) {
          svcPort = numMatch[1];
        }
      }
      if (svcName) {
        serviceMap.set(svcName, svcPort || serviceMap.get(svcName));
      }
    }

    // Legacy extensions/v1beta1: serviceName
    const legacyMatch = line.match(/^\s*serviceName:\s*(.+)$/);
    if (legacyMatch?.[1]) {
      const svcName = unquoteScalar(legacyMatch[1]);
      if (svcName && !serviceMap.has(svcName)) {
        serviceMap.set(svcName, undefined);
      }
    }
  }

  return {
    hosts: [...hostSet],
    services: [...serviceMap.entries()].map(([name, port]) => ({ name, port })),
  };
}

function parseHpaScaleTarget(raw: string): {
  kind: string;
  name: string;
  minReplicas?: string;
  maxReplicas?: string;
} | null {
  const lines = raw.split(/\r?\n/);
  let targetKind = "";
  let targetName = "";
  for (let i = 0; i < lines.length; i += 1) {
    const header = (lines[i] ?? "").match(/^(\s+)scaleTargetRef:\s*(?:#.*)?$/);
    if (!header) continue;
    const baseIndent = (header[1] ?? "").length;
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j] ?? "";
      const trimmed = next.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const nextIndent = next.match(/^(\s*)/)?.[1]?.length ?? 0;
      if (nextIndent <= baseIndent) break;
      const kindMatch = next.match(/^\s*kind:\s*(.+)$/);
      if (kindMatch?.[1]) targetKind = unquoteScalar(kindMatch[1]);
      const nameMatch = next.match(/^\s*name:\s*(.+)$/);
      if (nameMatch?.[1]) targetName = unquoteScalar(nameMatch[1]);
    }
    break;
  }
  if (!targetKind || !targetName) return null;
  const minReplicas = raw.match(/^\s+minReplicas:\s*(\d+)/m)?.[1];
  const maxReplicas = raw.match(/^\s+maxReplicas:\s*(\d+)/m)?.[1];
  return { kind: targetKind, name: targetName, minReplicas, maxReplicas };
}

function parseGatewayRouteRelations(raw: string): {
  hostnames: string[];
  parentRefs: Array<{ kind: string; name: string; namespace?: string; sectionName?: string }>;
  backendRefs: Array<{ name: string; namespace?: string; port?: string }>;
} {
  const lines = raw.split(/\r?\n/);
  const hostnames: string[] = [];
  const parentRefs: Array<{ kind: string; name: string; namespace?: string; sectionName?: string }> = [];
  const backendRefs: Array<{ name: string; namespace?: string; port?: string }> = [];

  const readObjectList = (sectionName: string): Array<Record<string, string>> => {
    const items: Array<Record<string, string>> = [];
    for (let i = 0; i < lines.length; i += 1) {
      const m = (lines[i] ?? "").match(new RegExp(`^(\\s*)${sectionName}:\\s*(?:#.*)?$`));
      if (!m) continue;
      const baseIndent = (m[1] ?? "").length;
      let current: Record<string, string> | null = null;
      let itemIndent: number | null = null;
      for (let j = i + 1; j < lines.length; j += 1) {
        const next = lines[j] ?? "";
        const trimmed = next.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const nextIndent = next.match(/^(\s*)/)?.[1]?.length ?? 0;
        const isSeqAtBase = nextIndent === baseIndent && trimmed.startsWith("- ");
        if (nextIndent < baseIndent || (nextIndent === baseIndent && !isSeqAtBase)) break;
        if (trimmed.startsWith("- ")) {
          if (itemIndent === null || nextIndent <= itemIndent) {
            itemIndent = nextIndent;
            current = {};
            items.push(current);
            const rest = trimmed.slice(2).trim();
            const kv = rest.match(/^([A-Za-z0-9_.-]+):\s*(.+)$/);
            if (kv?.[1] && kv[2]) current[kv[1]] = unquoteScalar(kv[2]);
          }
          continue;
        }
        if (current) {
          const kv = trimmed.match(/^([A-Za-z0-9_.-]+):\s*(.+)$/);
          if (kv?.[1] && kv[2] && !current[kv[1]]) {
            current[kv[1]] = unquoteScalar(kv[2]);
          }
        }
      }
    }
    return items;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const m = (lines[i] ?? "").match(/^(\s*)hostnames:\s*(?:#.*)?$/);
    if (!m) continue;
    const baseIndent = (m[1] ?? "").length;
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j] ?? "";
      const trimmed = next.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const nextIndent = next.match(/^(\s*)/)?.[1]?.length ?? 0;
      const isSeqAtBase = nextIndent === baseIndent && trimmed.startsWith("- ");
      if (nextIndent < baseIndent || (nextIndent === baseIndent && !isSeqAtBase)) break;
      if (trimmed.startsWith("- ")) {
        const val = unquoteScalar(trimmed.slice(2));
        if (val && !hostnames.includes(val)) hostnames.push(val);
      }
    }
    break;
  }

  for (const item of readObjectList("parentRefs")) {
    if (!item.name) continue;
    parentRefs.push({
      kind: item.kind || "Gateway",
      name: item.name,
      namespace: item.namespace,
      sectionName: item.sectionName,
    });
  }

  const seenBackends = new Set<string>();
  for (const item of readObjectList("backendRefs")) {
    if (!item.name) continue;
    if (item.kind && item.kind !== "Service") continue;
    const key = `${item.namespace ?? ""}/${item.name}:${item.port ?? ""}`;
    if (seenBackends.has(key)) continue;
    seenBackends.add(key);
    backendRefs.push({
      name: item.name,
      namespace: item.namespace,
      port: item.port,
    });
  }

  return { hostnames, parentRefs, backendRefs };
}

function parseGatewayInfo(raw: string): {
  gatewayClassName?: string;
  listeners: string[];
} {
  const gatewayClassName = raw.match(/^\s*gatewayClassName:\s*(.+)$/m)?.[1];
  const listeners: string[] = [];
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const m = (lines[i] ?? "").match(/^(\s*)listeners:\s*(?:#.*)?$/);
    if (!m) continue;
    const baseIndent = (m[1] ?? "").length;
    let curProto = "";
    let curPort = "";
    const flush = () => {
      if (curPort) listeners.push(`${curProto || "HTTP"}:${curPort}`);
      curProto = "";
      curPort = "";
    };
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j] ?? "";
      const trimmed = next.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const nextIndent = next.match(/^(\s*)/)?.[1]?.length ?? 0;
      const isSeqAtBase = nextIndent === baseIndent && trimmed.startsWith("- ");
      if (nextIndent < baseIndent || (nextIndent === baseIndent && !isSeqAtBase)) break;
      if (trimmed.startsWith("- ")) flush();
      const protoM = trimmed.match(/^(?:-\s+)?protocol:\s*(.+)$/);
      if (protoM?.[1]) curProto = unquoteScalar(protoM[1]);
      const portM = trimmed.match(/^(?:-\s+)?port:\s*(\d+)/);
      if (portM?.[1]) curPort = portM[1];
    }
    flush();
    break;
  }
  return {
    gatewayClassName: gatewayClassName ? unquoteScalar(gatewayClassName) : undefined,
    listeners,
  };
}

function buildFocusedResourceGraph(
  focus: NonNullable<TopologyFocusResource>,
  manifestYaml: string | undefined,
  storeRows: ResourceSummaryDto[],
): { nodes: TopologyNode[]; edges: TopologyEdge[]; isLiveDerived: boolean } {
  const ns = focus.namespace || "default";
  const rel = parseRealK8sRelations(manifestYaml, focus);
  const { summary } = rel;
  const nodes: TopologyNode[] = [];
  const edges: TopologyEdge[] = [];

  const normKind = (k: string): TopologyNodeKind => {
    const valid: TopologyNodeKind[] = [
      "Pod",
      "Deployment",
      "StatefulSet",
      "DaemonSet",
      "ReplicaSet",
      "Job",
      "CronJob",
      "HorizontalPodAutoscaler",
      "Service",
      "Ingress",
      "Gateway",
      "HTTPRoute",
      "GRPCRoute",
      "TLSRoute",
      "TCPRoute",
      "PersistentVolumeClaim",
      "Node",
      "ConfigMap",
      "Secret",
      "ServiceAccount",
      "Namespace",
    ];
    return (valid.find((v) => v.toLowerCase() === k.toLowerCase()) ?? "Pod") as TopologyNodeKind;
  };

  const focusKind = normKind(focus.kind);

  if (focusKind === "Pod") {
    // 1. Left Column: Owner Chain (Deployment -> ReplicaSet, or StatefulSet/DaemonSet/Job)
    let parentId: string | null = null;

    if (rel.inferredDeployment) {
      const deployId = `owner-deploy-${rel.inferredDeployment}`;
      nodes.push({
        id: deployId,
        kind: "Deployment",
        name: rel.inferredDeployment,
        namespace: ns,
        status: "Running",
        loadTicks: 3,
        details: [
          { icon: "kind", label: "Kind", value: "Deployment · apps/v1" },
          { icon: "scope", label: "Namespace", value: ns },
          { icon: "status", label: "Manages", value: rel.inferredReplicaSet ?? "ReplicaSet", tone: "positive" },
        ],
        footerLabel: `Deployment · ns/${ns}`,
        x: 45,
        y: 55,
      });
      parentId = deployId;
    }

    if (rel.inferredReplicaSet) {
      const rsId = `owner-rs-${rel.inferredReplicaSet}`;
      const hashSuffix = rel.inferredReplicaSet.split("-").pop() ?? "";
      nodes.push({
        id: rsId,
        kind: "ReplicaSet",
        name: rel.inferredReplicaSet,
        namespace: ns,
        status: "Active",
        loadTicks: 2,
        details: [
          { icon: "kind", label: "Kind", value: "ReplicaSet · apps/v1" },
          { icon: "scope", label: "Revision Hash", value: hashSuffix },
          {
            icon: "status",
            label: "Owner",
            value: rel.inferredDeployment ? `deploy/${rel.inferredDeployment}` : ns,
            tone: "positive",
          },
        ],
        footerLabel: `ReplicaSet · Controlled`,
        x: 45,
        y: rel.inferredDeployment ? 265 : 140,
      });
      if (parentId) {
        edges.push({ id: "e-deploy-rs", from: parentId, to: rsId, label: "owns" });
      }
      parentId = rsId;
    } else if (rel.owners.length > 0) {
      const firstOwner = rel.owners[0]!;
      const ownerId = `owner-${firstOwner.kind}-${firstOwner.name}`;
      nodes.push({
        id: ownerId,
        kind: normKind(firstOwner.kind),
        name: firstOwner.name,
        namespace: ns,
        status: "Running",
        loadTicks: 3,
        details: [
          { icon: "kind", label: "Controller", value: firstOwner.kind },
          { icon: "scope", label: "Namespace", value: ns },
          { icon: "status", label: "Relation", value: "ownerReference", tone: "positive" },
        ],
        footerLabel: `${firstOwner.kind} · Owner`,
        x: 45,
        y: 135,
      });
      parentId = ownerId;
    }

    // 2. Center Column: The Focus Pod itself with real container & IP details
    const podId = `focus-pod-${focus.name}`;
    const firstContainer = summary.containers[0];
    const podRows: QuorumDetailRow[] = [
      {
        icon: "status",
        label: "Phase",
        value: summary.phase || "Running",
        tone: "positive",
      },
      {
        icon: "kind",
        label: "Containers",
        value:
          summary.containers.length > 0
            ? `${summary.containers.map((c) => c.name).join(", ")} (${summary.containers.length})`
            : "1 container",
        progressPct: 100,
      },
    ];
    if (firstContainer) {
      podRows.push({
        icon: "image",
        label: "Image",
        value: firstContainer.image.split("/").pop() || firstContainer.image,
      });
    }
    if (rel.podIP) {
      podRows.push({ icon: "net", label: "Pod IP", value: rel.podIP });
    } else if (firstContainer && firstContainer.ports.length > 0) {
      podRows.push({
        icon: "net",
        label: "Ports",
        value: firstContainer.ports.map((p) => `${p}/TCP`).join(", "),
      });
    }

    nodes.push({
      id: podId,
      kind: "Pod",
      name: focus.name,
      namespace: ns,
      status: "Running",
      isFocus: true,
      loadTicks: 4,
      details: podRows,
      footerLabel: `Focus Pod · ns/${ns}`,
      x: parentId ? 375 : 80,
      y: 120,
    });

    if (parentId) {
      edges.push({ id: "e-owner-pod", from: parentId, to: podId, label: "manages" });
    }

    // 3. Right Column: Real Scheduled Node + Real Mounted Secrets/ConfigMaps/ServiceAccount
    const rightX = parentId ? 705 : 415;
    let rightY = 45;

    if (summary.nodeName && summary.nodeName !== "—") {
      const nodeId = `host-node-${summary.nodeName}`;
      nodes.push({
        id: nodeId,
        kind: "Node",
        name: summary.nodeName,
        status: "Ready",
        loadTicks: 3,
        details: [
          { icon: "kind", label: "Kind", value: "Node · v1" },
          { icon: "scope", label: "Scope", value: "cluster-scoped" },
          ...(rel.hostIP
            ? [{ icon: "net" as const, label: "Host IP", value: rel.hostIP }]
            : []),
          { icon: "status", label: "Placement", value: "Scheduled Host", tone: "positive" },
        ],
        footerLabel: `Node · Ready`,
        x: rightX,
        y: rightY,
      });
      edges.push({ id: "e-pod-node", from: podId, to: nodeId, label: "scheduled on" });
      rightY += 215;
    }

    for (const cmName of rel.configMapRefs.slice(0, 2)) {
      const cmId = `cm-${cmName}`;
      nodes.push({
        id: cmId,
        kind: "ConfigMap",
        name: cmName,
        namespace: ns,
        status: "Active",
        loadTicks: 1,
        details: [
          { icon: "kind", label: "Kind", value: "ConfigMap · v1" },
          { icon: "scope", label: "Namespace", value: ns },
          { icon: "status", label: "Binding", value: "Volume / Env", tone: "positive" },
        ],
        footerLabel: `ConfigMap · Mounted`,
        x: rightX,
        y: rightY,
      });
      edges.push({ id: `e-pod-${cmId}`, from: podId, to: cmId, label: "mounts" });
      rightY += 185;
    }

    for (const secName of rel.secretRefs.slice(0, 2)) {
      const secId = `sec-${secName}`;
      nodes.push({
        id: secId,
        kind: "Secret",
        name: secName,
        namespace: ns,
        status: "Active",
        loadTicks: 1,
        details: [
          { icon: "kind", label: "Kind", value: "Secret · v1" },
          { icon: "scope", label: "Namespace", value: ns },
          { icon: "status", label: "Protection", value: "Masked IPC", tone: "positive" },
        ],
        footerLabel: `Secret · Mounted`,
        x: rightX,
        y: rightY,
      });
      edges.push({ id: `e-pod-${secId}`, from: podId, to: secId, label: "mounts" });
      rightY += 185;
    }

    if (rel.configMapRefs.length === 0 && rel.secretRefs.length === 0) {
      const saName = summary.serviceAccount || "default";
      const saId = `sa-${saName}`;
      nodes.push({
        id: saId,
        kind: "ServiceAccount",
        name: saName,
        namespace: ns,
        status: "Active",
        loadTicks: 1,
        details: [
          { icon: "kind", label: "Kind", value: "ServiceAccount · v1" },
          { icon: "scope", label: "Namespace", value: ns },
          { icon: "status", label: "Identity", value: "Pod Identity", tone: "positive" },
        ],
        footerLabel: `ServiceAccount · ns/${ns}`,
        x: rightX,
        y: rightY,
      });
      edges.push({ id: "e-pod-sa", from: podId, to: saId, label: "authenticates as" });
    }

    return { nodes, edges, isLiveDerived: true };
  }

  // Case B: Controller (Deployment, StatefulSet, DaemonSet, ReplicaSet, Job)
  if (
    focusKind === "Deployment" ||
    focusKind === "StatefulSet" ||
    focusKind === "DaemonSet" ||
    focusKind === "ReplicaSet" ||
    focusKind === "Job"
  ) {
    const ctrlId = `focus-ctrl-${focus.name}`;
    const desired = Number(rel.replicas || 1);
    const ready = Number(rel.readyReplicas || desired);
    const pct = desired > 0 ? Math.round((ready / desired) * 100) : 100;

    nodes.push({
      id: ctrlId,
      kind: focusKind,
      name: focus.name,
      namespace: ns,
      status: "Running",
      isFocus: true,
      loadTicks: 3,
      details: [
        { icon: "kind", label: "Kind", value: `${focusKind} · ${summary.apiVersion}` },
        { icon: "scope", label: "Namespace", value: ns },
        ...(rel.replicas
          ? [
              {
                icon: "status" as const,
                label: "Replicas",
                value: `${ready} / ${desired} ready`,
                tone: "positive" as const,
                progressPct: pct,
              },
            ]
          : []),
        ...(rel.strategy
          ? [{ icon: "net" as const, label: "Strategy", value: rel.strategy }]
          : []),
      ],
      footerLabel: `Focus ${focusKind} · ns/${ns}`,
      x: 55,
      y: 125,
    });

    // Matching real Pods from storeRows in this namespace
    const prefix = `${focus.name}-`;
    const matchingPods = storeRows.filter(
      (r) =>
        r.kind === "Pod" &&
        (r.namespace ?? "default") === ns &&
        (r.name === focus.name || r.name.startsWith(prefix)),
    );

    if (matchingPods.length > 0) {
      matchingPods.slice(0, 3).forEach((pod, idx) => {
        const pId = `child-pod-${pod.uid}`;
        nodes.push({
          id: pId,
          kind: "Pod",
          name: pod.name,
          namespace: pod.namespace ?? ns,
          status: pod.status === "Pending" ? "Warning" : "Running",
          loadTicks: 2,
          details: [
            { icon: "kind", label: "Kind", value: "Pod · v1" },
            { icon: "scope", label: "Namespace", value: pod.namespace ?? ns },
            {
              icon: "status",
              label: "Status",
              value: pod.status ?? "Running",
              tone: "positive",
            },
          ],
          footerLabel: `Pod · Controlled`,
          x: 410,
          y: 45 + idx * 185,
        });
        edges.push({ id: `e-ctrl-${pId}`, from: ctrlId, to: pId, label: "manages" });
      });
    } else if (summary.containers.length > 0) {
      summary.containers.forEach((c, idx) => {
        const cId = `tmpl-container-${c.name}`;
        nodes.push({
          id: cId,
          kind: "Pod",
          name: c.name,
          namespace: ns,
          status: "Running",
          isPlaceholder: true,
          loadTicks: 2,
          details: [
            { icon: "kind", label: "Template Spec", value: "Container" },
            {
              icon: "image",
              label: "Image",
              value: c.image.split("/").pop() || c.image,
            },
            {
              icon: "net",
              label: "Ports",
              value: c.ports.length > 0 ? c.ports.map((p) => `${p}/TCP`).join(", ") : "none",
            },
          ],
          footerLabel: `Pod Template · ${c.name}`,
          x: 410,
          y: 80 + idx * 190,
        });
        edges.push({ id: `e-ctrl-${cId}`, from: ctrlId, to: cId, label: "spec.template" });
      });
    }

    return { nodes, edges, isLiveDerived: true };
  }

  // Case C: Service -> matching Pods via spec.selector
  if (focusKind === "Service") {
    const selectorPairs = parseServiceSelector(manifestYaml ?? "");
    const svcId = `focus-svc-${focus.name}`;
    const portSummary =
      summary.servicePorts.length > 0
        ? summary.servicePorts.map((p) => `${p.port}→${p.targetPort}`).join(", ")
        : "—";

    nodes.push({
      id: svcId,
      kind: "Service",
      name: focus.name,
      namespace: ns,
      status: "Active",
      isFocus: true,
      loadTicks: 2,
      details: [
        { icon: "net", label: "Type", value: summary.resourceType || "ClusterIP" },
        { icon: "net", label: "Cluster IP", value: rel.clusterIP || "None" },
        { icon: "net", label: "Ports", value: portSummary },
        {
          icon: "scope",
          label: "Selector",
          value:
            selectorPairs.length > 0
              ? selectorPairs.map(([k, v]) => `${k}=${v}`).join(", ")
              : "none",
        },
      ],
      footerLabel: `Focus Service · ns/${ns}`,
      x: 75,
      y: 120,
    });

    const matchedPods =
      selectorPairs.length > 0
        ? storeRows
            .filter((r) => {
              if (r.kind !== "Pod") return false;
              if (r.namespace && r.namespace !== ns) return false;
              const labels = r.labels ?? {};
              return selectorPairs.every(([k, v]) => labels[k] === v);
            })
            .slice(0, 6)
        : [];

    if (matchedPods.length > 0) {
      matchedPods.forEach((p, idx) => {
        const pId = `svc-pod-${p.uid}`;
        nodes.push({
          id: pId,
          kind: "Pod",
          name: p.name,
          namespace: p.namespace || ns,
          status: p.status === "Running" || p.status === "Ready" ? "Running" : "Warning",
          loadTicks: 2,
          details: [
            {
              icon: "status",
              label: "Status",
              value: p.status || "Running",
              tone: p.status === "Running" ? "positive" : "warn",
            },
            { icon: "scope", label: "Namespace", value: p.namespace || ns },
            ...(p.ready ? [{ icon: "kind" as const, label: "Ready", value: p.ready }] : []),
          ],
          footerLabel: `Pod · ${p.status || "Running"}`,
          x: 420,
          y: 45 + idx * 175,
        });
        edges.push({ id: `e-svc-${pId}`, from: svcId, to: pId, label: "routes" });
      });
    } else if (selectorPairs.length > 0) {
      const hintId = `svc-selector-hint-${focus.name}`;
      nodes.push({
        id: hintId,
        kind: "Pod",
        name: selectorPairs.map(([k, v]) => `${k}=${v}`).join(", "),
        namespace: ns,
        status: "Active",
        isPlaceholder: true,
        loadTicks: 1,
        details: [
          { icon: "kind", label: "Target Selector", value: "Pods" },
          { icon: "scope", label: "Namespace", value: ns },
          { icon: "status", label: "Hint", value: "Open Pods list to load targets" },
        ],
        footerLabel: "Selector Match · Pod",
        x: 420,
        y: 120,
      });
      edges.push({ id: `e-svc-hint`, from: svcId, to: hintId, label: "selects" });
    }

    return { nodes, edges, isLiveDerived: true };
  }

  // Case D: Ingress -> backend Services
  if (focusKind === "Ingress") {
    const ingInfo = parseIngressBackends(manifestYaml ?? "");
    const ingId = `focus-ing-${focus.name}`;
    nodes.push({
      id: ingId,
      kind: "Ingress",
      name: focus.name,
      namespace: ns,
      status: "Active",
      isFocus: true,
      loadTicks: 2,
      details: [
        { icon: "kind", label: "Kind", value: `Ingress · ${summary.apiVersion}` },
        {
          icon: "net",
          label: "Hosts",
          value: ingInfo.hosts.length > 0 ? ingInfo.hosts.join(", ") : "*",
        },
        {
          icon: "status",
          label: "Backends",
          value: `${ingInfo.services.length} ${ingInfo.services.length === 1 ? "service" : "services"}`,
          tone: ingInfo.services.length > 0 ? "positive" : "default",
        },
      ],
      footerLabel: `Focus Ingress · ns/${ns}`,
      x: 75,
      y: 120,
    });

    ingInfo.services.forEach((svc, idx) => {
      const svcId = `ing-svc-${svc.name}`;
      nodes.push({
        id: svcId,
        kind: "Service",
        name: svc.name,
        namespace: ns,
        status: "Active",
        loadTicks: 2,
        details: [
          { icon: "kind", label: "Kind", value: "Service · v1" },
          { icon: "scope", label: "Namespace", value: ns },
          ...(svc.port ? [{ icon: "net" as const, label: "Backend Port", value: `:${svc.port}` }] : []),
        ],
        footerLabel: `Service · ns/${ns}`,
        x: 420,
        y: 55 + idx * 175,
      });
      edges.push({
        id: `e-ing-${svcId}`,
        from: ingId,
        to: svcId,
        label: svc.port ? `:${svc.port}` : "routes",
      });
    });

    return { nodes, edges, isLiveDerived: true };
  }

  // Case D2: Gateway API Routes (HTTPRoute / GRPCRoute / TLSRoute / TCPRoute) -> Gateway parentRefs + backend Services
  if (
    focusKind === "HTTPRoute" ||
    focusKind === "GRPCRoute" ||
    focusKind === "TLSRoute" ||
    focusKind === "TCPRoute"
  ) {
    const routeInfo = parseGatewayRouteRelations(manifestYaml ?? "");
    const routeId = `focus-route-${focus.name}`;
    const hasParents = routeInfo.parentRefs.length > 0;
    const focusX = hasParents ? 385 : 75;

    routeInfo.parentRefs.forEach((pref, idx) => {
      const gwNs = pref.namespace || ns;
      const gwId = `route-parent-${gwNs}-${pref.name}`;
      nodes.push({
        id: gwId,
        kind: normKind(pref.kind),
        name: pref.name,
        namespace: gwNs,
        status: "Active",
        external: gwNs !== ns,
        loadTicks: 2,
        details: [
          { icon: "kind", label: "Kind", value: `${pref.kind} · Gateway API` },
          { icon: "scope", label: "Namespace", value: gwNs },
          ...(pref.sectionName ? [{ icon: "net" as const, label: "Listener", value: pref.sectionName }] : []),
        ],
        footerLabel: `${pref.kind} · ns/${gwNs}`,
        x: 55,
        y: 55 + idx * 175,
      });
      edges.push({
        id: `e-parent-${gwId}-${routeId}`,
        from: gwId,
        to: routeId,
        label: pref.sectionName || routeInfo.hostnames[0] || "attaches",
        crossNamespace: gwNs !== ns,
      });
    });

    nodes.push({
      id: routeId,
      kind: focusKind,
      name: focus.name,
      namespace: ns,
      status: "Active",
      isFocus: true,
      loadTicks: 2,
      details: [
        { icon: "kind", label: "Kind", value: `${focusKind} · ${summary.apiVersion}` },
        {
          icon: "net",
          label: "Hostnames",
          value: routeInfo.hostnames.length > 0 ? routeInfo.hostnames.join(", ") : "*",
        },
        {
          icon: "status",
          label: "Backends",
          value: `${routeInfo.backendRefs.length} ${routeInfo.backendRefs.length === 1 ? "service" : "services"}`,
          tone: routeInfo.backendRefs.length > 0 ? "positive" : "default",
        },
      ],
      footerLabel: `Focus ${focusKind} · ns/${ns}`,
      x: focusX,
      y: 110,
    });

    routeInfo.backendRefs.forEach((bref, idx) => {
      const bNs = bref.namespace || ns;
      const svcId = `route-svc-${bNs}-${bref.name}`;
      nodes.push({
        id: svcId,
        kind: "Service",
        name: bref.name,
        namespace: bNs,
        status: "Active",
        external: bNs !== ns,
        loadTicks: 2,
        details: [
          { icon: "kind", label: "Kind", value: "Service · v1" },
          { icon: "scope", label: "Namespace", value: bNs },
          ...(bref.port ? [{ icon: "net" as const, label: "Port", value: `:${bref.port}` }] : []),
        ],
        footerLabel: `Service · ns/${bNs}`,
        x: focusX + 335,
        y: 55 + idx * 175,
      });
      edges.push({
        id: `e-route-${svcId}`,
        from: routeId,
        to: svcId,
        label: bref.port ? `:${bref.port}` : "routes",
        crossNamespace: bNs !== ns,
      });
    });

    return { nodes, edges, isLiveDerived: true };
  }

  // Case D3: Gateway -> listeners & matching routes in store
  if (focusKind === "Gateway") {
    const gwInfo = parseGatewayInfo(manifestYaml ?? "");
    const gwId = `focus-gw-${focus.name}`;
    nodes.push({
      id: gwId,
      kind: "Gateway",
      name: focus.name,
      namespace: ns,
      status: "Ready",
      isFocus: true,
      loadTicks: 2,
      details: [
        { icon: "kind", label: "Kind", value: `Gateway · ${summary.apiVersion}` },
        { icon: "scope", label: "Class", value: gwInfo.gatewayClassName || "gateway" },
        {
          icon: "net",
          label: "Listeners",
          value: gwInfo.listeners.length > 0 ? gwInfo.listeners.join(", ") : "—",
        },
      ],
      footerLabel: `Focus Gateway · ns/${ns}`,
      x: 75,
      y: 110,
    });
    return { nodes, edges, isLiveDerived: true };
  }

  // Case E: HorizontalPodAutoscaler -> scaleTargetRef workload
  if (focusKind === "HorizontalPodAutoscaler") {
    const target = parseHpaScaleTarget(manifestYaml ?? "");
    const hpaId = `focus-hpa-${focus.name}`;
    nodes.push({
      id: hpaId,
      kind: "HorizontalPodAutoscaler",
      name: focus.name,
      namespace: ns,
      status: "Active",
      isFocus: true,
      loadTicks: 2,
      details: [
        { icon: "kind", label: "Kind", value: `HPA · ${summary.apiVersion}` },
        { icon: "scope", label: "Namespace", value: ns },
        {
          icon: "status",
          label: "Replicas",
          value:
            target?.minReplicas || target?.maxReplicas
              ? `${target.minReplicas ?? "1"}–${target.maxReplicas ?? "?"}`
              : "auto",
          tone: "positive",
        },
      ],
      footerLabel: `Focus HPA · ns/${ns}`,
      x: 75,
      y: 120,
    });

    if (target) {
      const targetKind = normKind(target.kind);
      const targetId = `hpa-target-${target.name}`;
      nodes.push({
        id: targetId,
        kind: targetKind,
        name: target.name,
        namespace: ns,
        status: "Running",
        loadTicks: 3,
        details: [
          { icon: "kind", label: "Target Kind", value: target.kind },
          { icon: "scope", label: "Namespace", value: ns },
          { icon: "status", label: "Controlled By", value: "Autoscaler", tone: "positive" },
        ],
        footerLabel: `${target.kind} · ns/${ns}`,
        x: 420,
        y: 120,
      });
      edges.push({ id: `e-hpa-target`, from: hpaId, to: targetId, label: "scales" });
    }

    return { nodes, edges, isLiveDerived: true };
  }

  // Case F: Generic fallback (CronJob / other)
  const focusId = `focus-${focusKind}-${focus.name}`;
  nodes.push({
    id: focusId,
    kind: focusKind,
    name: focus.name,
    namespace: focus.namespace,
    status: "Active",
    isFocus: true,
    loadTicks: 2,
    details: [
      { icon: "kind", label: "Kind", value: `${focusKind} · ${summary.apiVersion}` },
      {
        icon: "scope",
        label: focus.namespace ? "Namespace" : "Scope",
        value: focus.namespace || "cluster-scoped",
      },
      ...(summary.resourceType
        ? [{ icon: "net" as const, label: "Type", value: summary.resourceType }]
        : []),
      ...(rel.clusterIP
        ? [{ icon: "net" as const, label: "Cluster IP", value: rel.clusterIP }]
        : []),
      ...(summary.dataEntries.length > 0
        ? [
            {
              icon: "status" as const,
              label: "Data Keys",
              value: `${summary.dataEntries.length} entries`,
              tone: "positive" as const,
            },
          ]
        : []),
    ],
    footerLabel: `Focus ${focusKind}${focus.namespace ? ` · ns/${focus.namespace}` : ""}`,
    x: 340,
    y: 120,
  });

  if (focus.namespace) {
    const nsId = `scope-ns-${focus.namespace}`;
    nodes.push({
      id: nsId,
      kind: "Namespace",
      name: focus.namespace,
      status: "Active",
      loadTicks: 1,
      details: [
        { icon: "kind", label: "Kind", value: "Namespace · v1" },
        { icon: "scope", label: "Scope", value: "cluster-scoped" },
        { icon: "status", label: "Status", value: "Active", tone: "positive" },
      ],
      footerLabel: `Namespace · ${focus.namespace}`,
      x: 45,
      y: 120,
    });
    edges.push({ id: "e-ns-focus", from: nsId, to: focusId, label: "scopes" });
  }

  return { nodes, edges, isLiveDerived: true };
}

export function buildTopologyGraph(
  rows: ResourceSummaryDto[] | undefined,
  focusResource?: TopologyFocusResource,
  manifestYaml?: string,
): { nodes: TopologyNode[]; edges: TopologyEdge[]; isLiveDerived: boolean } {
  const allRows = rows ?? [];

  if (focusResource) {
    return buildFocusedResourceGraph(focusResource, manifestYaml, allRows);
  }

  if (allRows.length > 0) {
    const services = allRows.filter((r) => r.kind === "Service" || r.kind === "Ingress").slice(0, 3);
    const controllers = allRows
      .filter(
        (r) =>
          r.kind === "Deployment" ||
          r.kind === "StatefulSet" ||
          r.kind === "DaemonSet" ||
          r.kind === "ReplicaSet" ||
          r.kind === "Job",
      )
      .slice(0, 3);
    const pods = allRows.filter((r) => r.kind === "Pod").slice(0, 4);
    const configs = allRows
      .filter((r) => r.kind === "ConfigMap" || r.kind === "Secret" || r.kind === "Node")
      .slice(0, 3);

    const nodes: TopologyNode[] = [];
    const edges: TopologyEdge[] = [];

    const toNode = (row: ResourceSummaryDto, x: number, y: number): TopologyNode => {
      const kind = (row.kind as TopologyNodeKind) || "Pod";
      const labelCount = Object.keys(row.labels ?? {}).length;
      const firstLabel = Object.entries(row.labels ?? {})[0];
      return {
        id: `live-${row.uid}`,
        kind,
        name: row.name,
        namespace: row.namespace,
        status: row.status === "Pending" || row.status === "Degraded" ? "Warning" : "Running",
        loadTicks: kind === "Pod" ? 3 : 2,
        details: [
          { icon: "kind", label: "Kind", value: row.kind },
          {
            icon: "scope",
            label: row.namespace ? "Namespace" : "Scope",
            value: row.namespace || "cluster-scoped",
          },
          ...(firstLabel
            ? [
                {
                  icon: "net" as const,
                  label: "Selector",
                  value: `${firstLabel[0]}=${firstLabel[1]}`,
                },
              ]
            : [
                {
                  icon: "net" as const,
                  label: "Labels",
                  value: `${labelCount} attached`,
                },
              ]),
          {
            icon: "status",
            label: "Status",
            value: row.status ?? "Active",
            tone: row.status === "Pending" ? "warn" : "positive",
          },
        ],
        footerLabel: `${row.kind}${row.namespace ? ` · ns/${row.namespace}` : ""}`,
        x,
        y,
      };
    };

    // If we have categorized rows, arrange them in clean left-to-right columns
    if (services.length > 0 || controllers.length > 0 || pods.length > 0) {
      let colX = 50;
      const svcNodes: TopologyNode[] = [];
      const ctrlNodes: TopologyNode[] = [];
      const podNodes: TopologyNode[] = [];

      if (services.length > 0) {
        services.forEach((r, idx) => {
          const n = toNode(r, colX, 55 + idx * 195);
          nodes.push(n);
          svcNodes.push(n);
        });
        colX += 320;
      }

      if (controllers.length > 0) {
        controllers.forEach((r, idx) => {
          const n = toNode(r, colX, 55 + idx * 195);
          nodes.push(n);
          ctrlNodes.push(n);
        });
        colX += 320;
      }

      if (pods.length > 0) {
        pods.forEach((r, idx) => {
          const n = toNode(r, colX, 45 + idx * 185);
          nodes.push(n);
          podNodes.push(n);
        });
        colX += 320;
      }

      if (configs.length > 0) {
        configs.forEach((r, idx) => {
          const n = toNode(r, colX, 55 + idx * 195);
          nodes.push(n);
          const source = podNodes[idx % Math.max(1, podNodes.length)] ?? ctrlNodes[0];
          if (source) {
            edges.push({
              id: `e-${source.id}-${n.id}`,
              from: source.id,
              to: n.id,
              label: n.kind === "Node" ? "scheduled on" : "references",
            });
          }
        });
      }

      // Connect services -> controllers (or pods)
      for (const svc of svcNodes) {
        const target =
          ctrlNodes.find((c) => c.name.startsWith(svc.name) || svc.name.startsWith(c.name)) ??
          ctrlNodes[0] ??
          podNodes.find((p) => p.name.startsWith(svc.name)) ??
          podNodes[0];
        if (target) {
          edges.push({ id: `e-${svc.id}-${target.id}`, from: svc.id, to: target.id, label: "routes" });
        }
      }

      // Connect controllers -> pods (by prefix match or same namespace)
      for (const pod of podNodes) {
        const owner =
          ctrlNodes.find((c) => pod.name.startsWith(`${c.name}-`)) ?? ctrlNodes[0];
        if (owner) {
          edges.push({ id: `e-${owner.id}-${pod.id}`, from: owner.id, to: pod.id, label: "manages" });
        } else if (svcNodes.length === 0 && ctrlNodes.length === 0) {
          // Group pods under their namespace node
          const nsName = pod.namespace || "default";
          let nsNode = nodes.find((n) => n.id === `ns-${nsName}`);
          if (!nsNode) {
            nsNode = {
              id: `ns-${nsName}`,
              kind: "Namespace",
              name: nsName,
              status: "Active",
              loadTicks: 2,
              details: [
                { icon: "kind", label: "Kind", value: "Namespace · v1" },
                { icon: "scope", label: "Workloads", value: `${podNodes.length} pods` },
                { icon: "status", label: "Status", value: "Active", tone: "positive" },
              ],
              footerLabel: `Namespace · ${nsName}`,
              x: 50,
              y: 140,
            };
            nodes.push(nsNode);
          }
          // Shift pod to column 2 if we created a namespace root in column 1
          pod.x = 385;
          edges.push({ id: `e-${nsNode.id}-${pod.id}`, from: nsNode.id, to: pod.id, label: "contains" });
        }
      }

      return { nodes, edges, isLiveDerived: true };
    }

    // Fallback when rows are another resource type (e.g., Namespaces, Nodes, Roles)
    const sample = allRows.slice(0, 6);
    sample.forEach((r, idx) => {
      nodes.push(toNode(r, 70 + (idx % 3) * 310, 55 + Math.floor(idx / 3) * 210));
    });
    return { nodes, edges, isLiveDerived: true };
  }

  // Default architectural blueprint when no cluster view has been loaded yet
  const nodes: TopologyNode[] = [
    {
      id: "svc-k8s",
      kind: "Service",
      name: "kubernetes",
      namespace: "default",
      status: "Active",
      isPlaceholder: true,
      loadTicks: 2,
      details: [
        { icon: "kind", label: "Kind", value: "Service · v1" },
        { icon: "scope", label: "Namespace", value: "default" },
        { icon: "net", label: "Port", value: "443 → 6443/TCP" },
      ],
      footerLabel: "Service · ClusterIP",
      x: 75,
      y: 135,
    },
    {
      id: "api-pod",
      kind: "Deployment",
      name: "kube-apiserver",
      namespace: "kube-system",
      status: "Running",
      isPlaceholder: true,
      loadTicks: 3,
      details: [
        { icon: "kind", label: "Kind", value: "Control Plane · v1" },
        { icon: "scope", label: "Namespace", value: "kube-system" },
        { icon: "status", label: "Status", value: "Ready", tone: "positive" },
      ],
      footerLabel: "Control Plane · kube-system",
      x: 395,
      y: 105,
    },
    {
      id: "n1",
      kind: "Pod",
      name: "coredns",
      namespace: "kube-system",
      status: "Running",
      isPlaceholder: true,
      loadTicks: 2,
      details: [
        { icon: "kind", label: "Kind", value: "Pod · v1" },
        { icon: "scope", label: "Namespace", value: "kube-system" },
        { icon: "net", label: "Service", value: "kube-dns :53" },
      ],
      footerLabel: "Pod · kube-system",
      x: 725,
      y: 45,
    },
    {
      id: "n3",
      kind: "Node",
      name: "control-plane-node",
      status: "Ready",
      isPlaceholder: true,
      loadTicks: 2,
      details: [
        { icon: "kind", label: "Kind", value: "Node · v1" },
        { icon: "scope", label: "Scope", value: "cluster-scoped" },
        { icon: "status", label: "Kubelet", value: "Ready", tone: "positive" },
      ],
      footerLabel: "Node · Ready",
      x: 725,
      y: 265,
    },
  ];
  const edges: TopologyEdge[] = [
    { id: "e1", from: "svc-k8s", to: "api-pod", label: "routes" },
    { id: "e2", from: "api-pod", to: "n1", label: "schedules" },
    { id: "e3", from: "api-pod", to: "n3", label: "hosted on" },
  ];
  return { nodes, edges, isLiveDerived: false };
}

export function buildOrthogonalRoundedPath(x1: number, y1: number, x2: number, y2: number): {
  d: string;
  labelX: number;
  labelY: number;
} {
  const midX = (x1 + x2) / 2;
  const dy = y2 - y1;
  const absDy = Math.abs(dy);
  const dx = x2 - x1;

  if (absDy < 6 || dx <= 20) {
    return {
      d: `M ${x1} ${y1} L ${x2} ${y2}`,
      labelX: midX,
      labelY: (y1 + y2) / 2,
    };
  }

  const r = Math.min(12, absDy / 2, Math.abs(midX - x1) / 2);
  const dirY = dy > 0 ? 1 : -1;

  return {
    d: [
      `M ${x1} ${y1}`,
      `L ${midX - r} ${y1}`,
      `Q ${midX} ${y1} ${midX} ${y1 + dirY * r}`,
      `L ${midX} ${y2 - dirY * r}`,
      `Q ${midX} ${y2} ${midX + r} ${y2}`,
      `L ${x2} ${y2}`,
    ].join(" "),
    labelX: midX,
    labelY: (y1 + y2) / 2,
  };
}

function normalizeNodeStatus(raw: string): TopologyNode["status"] {
  if (raw === "Error") return "Error";
  if (raw === "Warning" || raw === "Pending" || raw === "Degraded") return "Warning";
  if (raw === "Ready") return "Ready";
  if (raw === "Running") return "Running";
  return "Active";
}

export function buildNamespaceTopologyGraph(
  dto: NamespaceTopologyDto,
  preset: VisualizerLayerPreset,
  expandedWorkloads: ReadonlySet<string>,
  expandAllPods: boolean,
  searchNeedle: string,
): { nodes: TopologyNode[]; edges: TopologyEdge[]; isLiveDerived: boolean } {
  // Determine which Services are directly targeted by Ingress or Gateway API Routes
  const ingressGatewayTargetServices = new Set<string>();
  const nodeById = new Map(dto.nodes.map((n) => [n.id, n]));
  for (const edge of dto.edges) {
    const src = nodeById.get(edge.from);
    const dst = nodeById.get(edge.to);
    if (
      src &&
      dst &&
      dst.kind === "Service" &&
      (src.layer === "entry" || src.layer === "routing")
    ) {
      ingressGatewayTargetServices.add(dst.id);
    }
  }

  // 1. Filter by layer preset & collapsed workload pods
  let filteredDtos = dto.nodes.filter((n) => {
    if (preset === "ingress-gateway") {
      if (n.layer === "entry" || n.layer === "routing") return true;
      if (n.layer === "service" && ingressGatewayTargetServices.has(n.id)) return true;
      return false;
    }
    if (preset === "traffic") {
      return (
        n.layer === "entry" ||
        n.layer === "routing" ||
        n.layer === "service" ||
        n.layer === "workload"
      );
    }
    // "full": keep pods only if standalone or parent workload is expanded
    if (n.layer === "pod" && n.parentWorkloadId) {
      return expandAllPods || expandedWorkloads.has(n.parentWorkloadId);
    }
    return true;
  });

  // 2. Optional search filter (keeps matching nodes + their direct 1-hop neighbors)
  const needle = searchNeedle.trim().toLowerCase();
  if (needle) {
    const matched = new Set<string>();
    for (const n of filteredDtos) {
      const hay = [
        n.name,
        n.kind,
        n.namespace,
        n.subtitle ?? "",
        ...n.details.map((d) => `${d.label} ${d.value}`),
      ]
        .join(" ")
        .toLowerCase();
      if (hay.includes(needle)) matched.add(n.id);
    }
    for (const e of dto.edges) {
      if (e.label.toLowerCase().includes(needle)) {
        matched.add(e.from);
        matched.add(e.to);
      }
    }
    const expandedMatch = new Set(matched);
    for (const e of dto.edges) {
      if (matched.has(e.from)) expandedMatch.add(e.to);
      if (matched.has(e.to)) expandedMatch.add(e.from);
    }
    filteredDtos = filteredDtos.filter((n) => expandedMatch.has(n.id));
  }

  // 3. Bucket into ordered left-to-right lanes, skipping empty columns.
  // Operator CRs (layer: "operator") share the service column directly left of workloads
  // so `Operator CR --manages--> Workload` and `Service --routes--> Workload` both flow left-to-right.
  const laneOrder = ["entry", "routing", "service", "workload", "pod", "aux"] as const;
  const byLane = new Map<string, typeof filteredDtos>();
  for (const lane of laneOrder) byLane.set(lane, []);
  for (const n of filteredDtos) {
    const lane =
      n.layer === "operator" ? "service" : byLane.has(n.layer) ? n.layer : "workload";
    byLane.get(lane)!.push(n);
  }

  const nodes: TopologyNode[] = [];
  let colX = 48;
  for (const lane of laneOrder) {
    const items = byLane.get(lane) ?? [];
    if (items.length === 0) continue;
    items.sort((a, b) => {
      // Keep Services above Operator CRs in the shared column, and Routes above TLS Secrets in routing
      const rank = (item: (typeof items)[number]) => {
        if (item.layer === "operator") return 2;
        if (item.kind === "Secret") return 2;
        if (item.kind === "Certificate") return 2;
        return 0;
      };
      const ra = rank(a);
      const rb = rank(b);
      if (ra !== rb) return ra - rb;
      if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
      return a.name.localeCompare(b.name);
    });
    let curY = 44;
    for (const item of items) {
      const details: TopologyDetailRow[] = item.details.slice(0, 3).map((d) => ({
        icon:
          d.label === "Ports" || d.label === "Listeners" || d.label === "Hosts" || d.label === "Hostnames"
            ? "net"
            : d.label === "Image" || d.label === "Capacity"
              ? "image"
              : d.label === "Node" || d.label === "Namespace" || d.label === "Class"
                ? "scope"
                : "status",
        label: d.label,
        value: d.value,
      }));
      if (details.length === 0 && item.subtitle) {
        details.push({ icon: "net", label: "Info", value: item.subtitle });
      }
      const hasPodToggle =
        preset === "full" &&
        item.layer === "workload" &&
        typeof item.podCount === "number" &&
        item.podCount > 0;
      const estH = 66 + Math.max(1, details.length) * 25 + (hasPodToggle ? 28 : 0);

      nodes.push({
        id: item.id,
        kind: (item.kind as TopologyNodeKind) || "Pod",
        gvr: item.gvr,
        name: item.name,
        namespace: item.namespace,
        status: normalizeNodeStatus(item.status),
        external: item.external,
        layer: item.layer,
        podCount: item.podCount,
        readyPodCount: item.readyPodCount,
        parentWorkloadId: item.parentWorkloadId,
        details,
        footerLabel: `${item.kind} · ns/${item.namespace}`,
        x: colX,
        y: curY,
      });
      curY += estH + 24;
    }
    colX += 326;
  }

  const visibleIdSet = new Set(nodes.map((n) => n.id));
  const edges: TopologyEdge[] = dto.edges
    .filter((e) => visibleIdSet.has(e.from) && visibleIdSet.has(e.to))
    .map((e) => ({
      id: e.id,
      from: e.from,
      to: e.to,
      label: e.label,
      crossNamespace: e.crossNamespace,
    }));

  return { nodes, edges, isLiveDerived: true };
}

