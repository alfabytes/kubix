# Day-to-Day Debugging & Fast-Jump Navigation Design

## Intent & Why
Make read-only incident triage in Kubix self-contained so engineers don't have to switch back to `kubectl` to inspect previous crash logs, trace a Pod to its Node/controller/mounted secrets, or jump directly to a resource by name.

## Goals, Non-Goals & Anti-Goals
- **Goals**:
  1. **Previous container logs (`--previous`)**: Toggle in the Logs toolbar to inspect logs from the last terminated container instance (`LogParams.previous = true`).
  2. **Cross-resource clickable navigation**: Clicking `Node`, `ServiceAccount`, `ownerReferences` (`Controlled By`), mounted `ConfigMap`/`Secret` references in `ResourceDetail` Overview, or any non-focus card in `TopologyCanvas` jumps directly to that target resource's detail view.
  3. **Instance-level `Cmd+K` search**: Search loaded resources across views in the active cluster by resource name (e.g., `metrics-server`, `api-gateway`) and jump straight to its detail view.
- **Non-Goals**: Cluster mutations (scale/restart/delete/apply), full cluster-wide server-side search indexing across unvisited APIs, or rewriting `get_pod_logs` to WebSocket streaming.
- **Anti-Goals**: Weakening the read-only IPC guarantee (`src-tauri/src/readonly.rs`), adding synthetic fallback data when `--previous` returns no terminated container logs, or burning extra live watcher slots on navigation.

## Constraints
- Must stay 100% read-only (`pnpm verify` including `readonly.rs` and `pnpm ipc:check` must pass).
- IPC contract changes must flow Rust → `pnpm ipc:schema` → TypeScript mirror (`src/lib/ipc/types.ts`).

## Approaches Considered
1. **Approach 1 — Root-Cause & Fast-Jump Debugging Suite *(Selected)***: `--previous` logs toggle + clickable cross-resource references (`ResourceDetail` & `TopologyCanvas`) + instance-level `Cmd+K` search. *Trade-off*: Small read-only IPC extension + frontend navigation wiring; highest immediate reduction in `kubectl` context-switching during daily debugging.
2. **Approach 2 — Live Cluster Security & Health Audit + Node Metrics**: Live pod security/misconfiguration scanner + `metrics.k8s.io/v1beta1/nodes`. *Trade-off*: Better for fleet posture reviews, less helpful when drilling into a single failing Pod.
3. **Approach 3 — True Streaming Logs & JSON Inspector**: Replace log polling with Tauri event streaming + JSON field explorer. *Trade-off*: Helps high-volume structured log tailing, but leaves `--previous`, cross-resource tracing, and `Cmd+K` lookup unsolved.

## Design

### 1. Previous Container Logs (`--previous`)
- **Backend / IPC**: Add `#[serde(default)] pub previous: Option<bool>` to `GetPodLogsArgs` in `src-tauri/src/ipc/dto.rs` (mirrored as `previous?: boolean` in `src/lib/ipc/types.ts`, `src/lib/ipc/client.ts`, `src/lib/hooks.ts`, and regenerated `src/lib/ipc/schema/contract.json`).
- In `get_pod_logs` (`src-tauri/src/app.rs`), pass `previous: args.previous.unwrap_or(false)` into `LogParams`. When `previous` is true and Kubernetes returns an error (e.g. `"previous terminated container ... not found"`), surface that exact kubelet message cleanly in the chunk without faking logs.
- **Frontend (`src/components/explorer/resource-detail.tsx`)**: Add a `Previous` toggle button (`data-testid="toggle-previous-logs"`) in the Logs toolbar next to `Live / Paused`. Enabling `Previous` automatically pauses live polling (previous logs are immutable) and passes `previous: true` to `usePodLogsQuery`. Resets to `false` when switching resources.

### 2. Cross-Resource Clickable Navigation
- **Target Resolution Helper (`src/lib/resource-telemetry.ts`)**: Map Kubernetes `kind` (e.g. `Node`, `Pod`, `ReplicaSet`, `Deployment`, `StatefulSet`, `DaemonSet`, `Job`, `CronJob`, `Service`, `ConfigMap`, `Secret`, `ServiceAccount`) to its GVR (matching against discovered resources first, falling back to canonical core/apps/batch GVRs).
- **Manifest References (`parseManifestSummary`)**: Extract `ownerReferences` (`Array<{ kind: string; name: string }>`) and mounted volume/env `configMapRefs` / `secretRefs` into `ParsedManifestInfo` so `ResourceDetail` Overview can render them as clickable links.
- **UI Wiring (`ResourceDetail`, `TopologyCanvas`, `ClusterShell`)**:
  - Pass `onNavigateResource?: (target: { kind: string; gvr: string; name: string; namespace?: string }) => void` from `ClusterShell` into `ResourceDetail` (both split-pane and full-tab).
  - Inside `ResourceDetail` Overview: make **Node**, **ServiceAccount**, **Owner (`Controlled By`)**, and mounted **ConfigMap / Secret** references clickable buttons that call `onNavigateResource`.
  - Inside `ResourceDetail` Topology tab: wire `TopologyCanvas`'s `onSelectNode` (or an explicit click/open action on non-focus nodes — clicking once selects, double-clicking or clicking a small `"Open"` action button on the node header navigates so dragging/selecting nodes doesn't accidentally yank you away!). *(Builder call: add a compact `"Open ↗"` button on non-focus Topology cards so drag/select stays safe.)*
  - In `ClusterShell`: `navigateToResource(target)` opens the target resource directly in a full workspace detail tab (or updates the active detail panel) and pushes the previous view onto a lightweight navigation history stack so the top-bar Back (`←`) / Forward (`→`) buttons work across resource jumps.

### 3. Instance-Level `Cmd+K` Search
- **`GlobalCommandBar` (`src/components/ide/global-command-bar.tsx`) & `App.tsx`**:
  - Read loaded `ResourceSummaryDto` entries for the active context from `useExplorerStore` (`views`), deduplicated by `uid`.
  - When searching in `Cmd+K`, show a **Loaded Resources** section matching `name`, `namespace`, or `kind` (up to 8 results, displaying `kind`, `name`, and `namespace`).
  - Selecting a loaded resource navigates straight to its detail view via `onSelectResourceInstance` (routed through `App.tsx` → `ClusterShell` so it opens the resource detail immediately without losing the active context).

## Left to the Builder
- Exact Tailwind styling for link buttons, the `Previous` toggle active state, and `Cmd+K` loaded-resource rows.
- Exact test fixtures in `tests/frontend/ide-ui.test.tsx` and Rust unit/IPC contract tests.
