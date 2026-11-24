/**
 * IPC contract v1 — TypeScript mirror of `src-tauri/src/ipc/dto.rs`.
 *
 * Source of truth is Rust. `pnpm ipc:check` fails when these types drift from the
 * generated `schema/contract.json`. Never edit field names here without changing Rust.
 */

export type ContextId = string;
/** `"group/version/plural"`, core group is empty: `"/v1/pods"`. */
export type GroupVersionResource = string;
/** Empty string means "all namespaces". */
export type Namespace = string;

export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "ready"
  | "authRequired"
  | "authFailed"
  | "unreachable"
  | "forbidden"
  | "degraded";

export type AuthKind = "exec" | "clientCert" | "token" | "other";

export type ErrorCode =
  | "kubeconfigNotFound"
  | "kubeconfigParseFailed"
  | "unknownContext"
  | "authRequired"
  | "authFailed"
  | "clusterUnreachable"
  | "forbidden"
  | "discoveryFailed"
  | "resourceNotFound"
  | "watchEvicted"
  | "internal";

export interface KubixErrorDto {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  contextId?: ContextId;
}

export interface ClusterContextDto {
  id: ContextId;
  name: string;
  clusterName: string;
  server: string;
  namespaceDefault: string;
  authKind: AuthKind;
  authHint?: string;
  isCurrent: boolean;
  state: ConnectionState;
  lastError?: KubixErrorDto;
  issues: string[];
}

export interface DiscoveredResourceDto {
  gvr: GroupVersionResource;
  kind: string;
  group: string;
  version: string;
  plural: string;
  namespaced: boolean;
  shortNames: string[];
  verbs: string[];
  curated: boolean;
}

export interface ResourceSummaryDto {
  uid: string;
  name: string;
  namespace?: string;
  kind: string;
  createdAt: string;
  labels: Record<string, string>;
  status?: string;
  ready?: string;
  restarts?: number;
  controlledBy?: string;
  node?: string;
  message?: string;
  taints?: number;
}

export interface ResourceManifestDto {
  contextId: ContextId;
  gvr: GroupVersionResource;
  name: string;
  namespace?: string;
  yaml: string;
  maskedPaths: string[];
}

export interface PodLogChunkDto {
  podName: string;
  containerName: string;
  logs: string;
}

export interface PodLogsDto {
  contextId: ContextId;
  gvr: GroupVersionResource;
  name: string;
  namespace?: string;
  pods: string[];
  containers: string[];
  initContainers?: string[];
  chunks: PodLogChunkDto[];
}

export interface ShellSessionDto {
  sessionId: string;
  contextId: ContextId;
  namespace: string;
  podName: string;
  container: string;
}

export interface ShellOutputDto {
  sessionId: string;
  stream: string;
  data: string;
  closed: boolean;
}

export interface PortForwardDto {
  forwardId: string;
  contextId: ContextId;
  namespace: string;
  kind: string;
  name: string;
  targetPod: string;
  remotePort: number;
  localPort: number;
  localUrl: string;
}

export interface ClusterNodeOverviewDto {
  name: string;
  ready: boolean;
  kubeletVersion: string;
  roles: string;
  cpuCapacity: string;
  memoryCapacity: string;
  cpuCapacityMillicores?: number;
  memoryCapacityMib?: number;
  cpuUsageMillicores?: number;
  memoryUsageMib?: number;
  createdAt: string;
}

export interface ClusterEventDto {
  uid: string;
  eventType: string;
  reason: string;
  involvedObject: string;
  namespace: string;
  from: string;
  message: string;
  count: number;
  createdAt: string;
}

export interface ClusterOverviewDto {
  contextId: ContextId;
  readyNodes: number;
  totalNodes: number;
  namespaceCount: number;
  runningPods: number;
  totalPods: number;
  healthyDeployments: number;
  totalDeployments: number;
  metricsServerAvailable?: boolean;
  nodes: ClusterNodeOverviewDto[];
  recentEvents: ClusterEventDto[];
}

export interface LogStreamSessionDto {
  streamId: string;
  pods: string[];
  containers: string[];
  initContainers?: string[];
}

export interface PodLogLineDto {
  streamId: string;
  podName: string;
  containerName: string;
  line: string;
  closed: boolean;
  error?: string;
}

export interface SecurityFindingDto {
  id: string;
  severity: "critical" | "high" | "medium" | "low" | string;
  category: string;
  checkName: string;
  namespace: string;
  podName: string;
  containerName?: string;
  message: string;
}

export interface ClusterSecurityAuditDto {
  contextId: ContextId;
  scannedPods: number;
  scannedContainers: number;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  findings: SecurityFindingDto[];
}

export interface ContainerMetricDto {
  name: string;
  cpuMillicores: number;
  memoryMib: number;
}

export interface ResourceMetricsDto {
  contextId: ContextId;
  metricsServerAvailable: boolean;
  statusMessage?: string;
  timestamp: string;
  windowSeconds: number;
  totalCpuMillicores: number;
  totalMemoryMib: number;
  podCount: number;
  containers: ContainerMetricDto[];
}

export interface TopologyDetailDto {
  label: string;
  value: string;
}

export interface TopologyNodeDto {
  id: string;
  kind: string;
  gvr: GroupVersionResource;
  name: string;
  namespace: string;
  layer: "entry" | "routing" | "service" | "workload" | "pod" | "aux" | string;
  status: string;
  external: boolean;
  subtitle?: string;
  podCount?: number;
  readyPodCount?: number;
  parentWorkloadId?: string;
  details: TopologyDetailDto[];
}

export interface TopologyEdgeDto {
  id: string;
  from: string;
  to: string;
  label: string;
  crossNamespace: boolean;
}

export interface NamespaceTopologyDto {
  contextId: ContextId;
  namespace: string;
  gatewayApiDetected: boolean;
  gatewayApiKinds: string[];
  nodes: TopologyNodeDto[];
  edges: TopologyEdgeDto[];
}

export interface ResourceDeletionDto {
  uid: string;
}

export interface ResourceDeltaDto {
  contextId: ContextId;
  gvr: GroupVersionResource;
  namespace: Namespace;
  batchId: number;
  upserts: ResourceSummaryDto[];
  deletions: ResourceDeletionDto[];
  truncated: boolean;
  /** Authoritative watcher snapshot: the UI replaces its rows instead of merging. */
  isSnapshot: boolean;
}

export interface WatchEvictedDto {
  contextId: ContextId;
  gvr: GroupVersionResource;
  namespace: Namespace;
}

// ---- command arguments -------------------------------------------------------

export interface ContextArgs {
  contextId: ContextId;
}

export interface ListResourcesArgs {
  contextId: ContextId;
  gvr: GroupVersionResource;
  namespace: Namespace;
}

export interface StopWatchArgs {
  contextId: ContextId;
  gvr: GroupVersionResource;
  namespace: Namespace;
}

export interface GetResourceArgs {
  contextId: ContextId;
  gvr: GroupVersionResource;
  name: string;
  namespace?: string;
}

export interface GetPodLogsArgs {
  contextId: ContextId;
  gvr: GroupVersionResource;
  name: string;
  namespace?: string;
  container?: string;
  tailLines?: number;
  previous?: boolean;
}

export interface StartShellArgs {
  contextId: ContextId;
  namespace: string;
  podName: string;
  container?: string;
  cols?: number;
  rows?: number;
  command?: string[];
}

export interface ShellInputArgs {
  sessionId: string;
  data: string;
}

export interface ShellResizeArgs {
  sessionId: string;
  cols: number;
  rows: number;
}

export interface CloseShellArgs {
  sessionId: string;
}

export interface StartPortForwardArgs {
  contextId: ContextId;
  namespace: string;
  kind: string;
  name: string;
  remotePort: number;
  localPort?: number;
}

export interface StopPortForwardArgs {
  forwardId: string;
}

export interface StartLogStreamArgs {
  contextId: ContextId;
  gvr: GroupVersionResource;
  name: string;
  namespace?: string;
  container?: string;
  tailLines?: number;
  previous?: boolean;
}

export interface StopLogStreamArgs {
  streamId: string;
}

export interface GetNamespaceTopologyArgs {
  contextId: ContextId;
  namespace?: string;
}

/** Per-command argument tuple; `null` means the command takes no arguments. */
export interface CommandArgs {
  list_contexts: null;
  rescan_kubeconfig: null;
  connect_context: ContextArgs;
  disconnect_context: ContextArgs;
  discover_resources: ContextArgs;
  list_resources: ListResourcesArgs;
  get_resource: GetResourceArgs;
  get_pod_logs: GetPodLogsArgs;
  start_log_stream: StartLogStreamArgs;
  stop_log_stream: StopLogStreamArgs;
  start_shell: StartShellArgs;
  send_shell_input: ShellInputArgs;
  resize_shell: ShellResizeArgs;
  close_shell: CloseShellArgs;
  start_port_forward: StartPortForwardArgs;
  stop_port_forward: StopPortForwardArgs;
  list_port_forwards: ContextArgs;
  get_cluster_overview: ContextArgs;
  get_cluster_security_audit: ContextArgs;
  get_resource_events: GetResourceArgs;
  get_resource_metrics: GetResourceArgs;
  get_namespace_topology: GetNamespaceTopologyArgs;
  stop_watch: StopWatchArgs;
}

export interface CommandResults {
  list_contexts: ClusterContextDto[];
  rescan_kubeconfig: ClusterContextDto[];
  connect_context: ClusterContextDto;
  disconnect_context: ClusterContextDto;
  discover_resources: DiscoveredResourceDto[];
  list_resources: ResourceSummaryDto[];
  get_resource: ResourceManifestDto;
  get_pod_logs: PodLogsDto;
  start_log_stream: LogStreamSessionDto;
  stop_log_stream: null;
  start_shell: ShellSessionDto;
  send_shell_input: null;
  resize_shell: null;
  close_shell: null;
  start_port_forward: PortForwardDto;
  stop_port_forward: null;
  list_port_forwards: PortForwardDto[];
  get_cluster_overview: ClusterOverviewDto;
  get_cluster_security_audit: ClusterSecurityAuditDto;
  get_resource_events: ClusterEventDto[];
  get_resource_metrics: ResourceMetricsDto;
  get_namespace_topology: NamespaceTopologyDto;
  stop_watch: null;
}

export type CommandName = keyof CommandArgs;
