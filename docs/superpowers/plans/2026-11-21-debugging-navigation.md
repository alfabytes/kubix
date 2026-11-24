# Day-to-Day Debugging & Fast-Jump Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add read-only `--previous` container log inspection, clickable cross-resource navigation (from `ResourceDetail` Overview & `TopologyCanvas`) with Back/Forward history, and instance-level `Cmd+K` loaded-resource search so engineers can triage failing workloads end-to-end inside Kubix.

**Architecture:** Extend the existing read-only `get_pod_logs` IPC command with an optional `previous?: boolean` parameter (`LogParams.previous`), regenerate the IPC schema contract (`contract.json`), centralize Kubernetes manifest reference extraction (`ownerReferences`, `configMapRefs`, `secretRefs`) and `Kind → GVR` resolution in `src/lib/resource-telemetry.ts`, wire cross-resource detail jumps and a Back/Forward history stack in `ClusterShell` + `App`, and surface active-context loaded `ResourceSummaryDto` instances inside `GlobalCommandBar`.

**Tech Stack:** Rust (`kube-rs`, `k8s-openapi`, `serde`, `schemars`), Tauri 2 IPC contract (`pnpm ipc:schema` / `pnpm ipc:check`), React 19, TypeScript, TanStack Query, Zustand, Tailwind CSS, Vitest + React Testing Library.

**Spec:** [2026-11-21-debugging-navigation-design.md](file:///Users/tentanganakbahagia/Documents/Mine/kubix/docs/superpowers/specs/2026-11-21-debugging-navigation-design.md)

**Global Constraints:**
- Strictly read-only: zero new mutating Kubernetes operations; `src-tauri/src/readonly.rs` and `pnpm verify` must pass.
- IPC source-of-truth workflow: edit `src-tauri/src/ipc/dto.rs` → run `pnpm ipc:schema` → mirror in `src/lib/ipc/types.ts` → verify with `pnpm ipc:check`.
- Always run `pnpm build` before `cargo test` (Tauri's context macro requires `dist/` to exist).
- Never call `list_resources` / open a new live watcher when jumping to a single resource detail (`get_resource` only).

**Review Focus:**
1. **`--previous` error honesty & initContainer fallback guard** (Task 1): When `previous: true`, `get_pod_logs` passes `previous: true` to `LogParams` and must skip the `initContainers` fallback so kubelet's real error for regular containers is never hidden; toggling `Previous` in UI pauses live polling and resets to `false` on resource switch. Verified by Rust unit test + Vitest test in `tests/frontend/ide-ui.test.tsx`.
2. **Cluster-scoped vs namespaced link resolution** (Task 2): Jumping to a cluster-scoped `Node` from a namespaced `Pod` must omit `namespace` (`undefined`), while `ServiceAccount`, `ReplicaSet`, `ConfigMap`, and `Secret` preserve the source namespace. Verified by unit tests in `tests/frontend/resource-telemetry.test.ts`.
3. **Topology drag/select safety vs explicit `Open` button** (Task 3): Clicking or dragging a non-focus `TopologyCanvas` card only selects/moves it; only clicking the card's explicit `Open` button (`stopPropagation` on click and pointerDown) navigates. Verified by Vitest test in `tests/frontend/ide-ui.test.tsx`.
4. **Watch-budget-safe jumps & Back/Forward history integrity** (Task 3): Cross-resource jumps open a `resource-detail` tab directly without invoking `list_resources`; Back (`←`) and Forward (`→`) restore prior views without duplicating stack entries. Verified by Vitest test in `tests/frontend/ide-ui.test.tsx`.
5. **Context isolation & `uid` deduplication in `Cmd+K` search** (Task 4): `GlobalCommandBar` only indexes `useExplorerStore.views` keys matching `activeContext.id` and deduplicates rows by `uid` across namespace-scoped and all-namespace views. Verified by Vitest test in `tests/frontend/ide-ui.test.tsx`.

---

## File Map

- **Modify:** `src-tauri/src/ipc/dto.rs` — add `#[serde(default)] pub previous: Option<bool>` to `GetPodLogsArgs`.
- **Modify:** `src-tauri/src/app.rs` — wire `previous` into `LogParams` inside `get_pod_logs` (with pure helper for unit testing) and guard the `initContainers` fallback when `previous` is true.
- **Regenerate:** `src/lib/ipc/schema/contract.json` — via `pnpm ipc:schema`.
- **Modify:** `src/lib/ipc/types.ts` — add `previous?: boolean` to `GetPodLogsArgs`.
- **Modify:** `src/lib/ipc/client.ts` — pass `previous` in `ipc.getPodLogs`.
- **Modify:** `src/lib/hooks.ts` — include `previous` in `resourceKeys.logs` and `usePodLogsQuery`.
- **Modify:** `src/lib/resource-telemetry.ts` — add `ownerReferences`, `configMapRefs`, `secretRefs` to `ParsedManifestInfo`, add `ResourceNavigationTarget` & `resolveGvrForKind`.
- **Create:** `tests/frontend/resource-telemetry.test.ts` — unit tests for manifest reference parsing and `resolveGvrForKind`.
- **Modify:** `src/components/explorer/resource-detail.tsx` — add `Previous` logs toggle, clickable Overview references (`Node`, `ServiceAccount`, `Controlled By`, `ConfigMaps & Secrets`), and pass `onOpenNode` to `TopologyCanvas`.
- **Modify:** `src/components/ide/topology-canvas.tsx` — add `onOpenNode?: (node: TopologyNode) => void` and a compact `Open` button on non-focus cards.
- **Modify:** `src/routes/cluster-shell.tsx` — add `navigateToResource`, Back/Forward navigation history stack, `pendingResourceJump` support, and wire `onNavigateResource` into split & full-tab `ResourceDetail`.
- **Modify:** `src/components/ide/global-command-bar.tsx` — search active-context loaded resources (`useExplorerStore.views`, deduplicated by `uid`) and emit `onSelectResourceInstance`.
- **Modify:** `src/components/ide/app-shell.tsx` & `src/App.tsx` — thread `onSelectResourceInstance` and Back/Forward history controls between `GlobalCommandBar`, `AppShell`, and `ClusterShell`.
- **Modify:** `tests/frontend/ide-ui.test.tsx` — integration/UI tests for `--previous` logs, clickable Overview & Topology navigation, Back/Forward history, and `Cmd+K` instance search.

---

### Task 1: Previous Container Logs (`--previous`) Across Rust IPC & Logs Toolbar

**Files:**
- Modify: `src-tauri/src/ipc/dto.rs` (lines 295–307)
- Modify: `src-tauri/src/app.rs` (lines 705–850 and `#[cfg(test)] mod tests`)
- Regenerate: `src/lib/ipc/schema/contract.json`
- Modify: `src/lib/ipc/types.ts` (lines 240–247)
- Modify: `src/lib/ipc/client.ts` (lines 89–98)
- Modify: `src/lib/hooks.ts` (lines 43–51, 276–305)
- Modify: `src/components/explorer/resource-detail.tsx` (lines 125–196, 1070–1090)
- Test: `tests/frontend/ide-ui.test.tsx`

- [ ] **Step 1: Add failing Rust unit test for `build_pod_log_params` and `GetPodLogsArgs` deserialization**

In `src-tauri/src/app.rs` (inside the existing `#[cfg(test)] mod tests` block at the bottom of the file), add a unit test verifying:
1. `GetPodLogsArgs` deserializes with `previous` omitted (defaults to `None`) and with `"previous": true` (`Some(true)`).
2. A small pure helper `build_pod_log_params(container: Option<String>, tail_lines: i64, previous: bool) -> LogParams` sets `lp.previous == previous`, `lp.timestamps == true`, and `lp.tail_lines == Some(tail_lines)`.
3. A pure predicate `should_fallback_to_init_containers(previous: bool, has_regular_logs: bool, has_init_containers: bool) -> bool` returns `false` when `previous` is `true` even if `has_regular_logs` is `false` and `has_init_containers` is `true`.

```rust
#[test]
fn pod_log_params_respects_previous_and_skips_init_fallback_when_previous() {
    let default_args: GetPodLogsArgs = serde_json::from_value(serde_json::json!({
        "contextId": "ctx-1",
        "gvr": "/v1/pods",
        "name": "web-0"
    }))
    .expect("deserialize without previous");
    assert_eq!(default_args.previous, None);

    let prev_args: GetPodLogsArgs = serde_json::from_value(serde_json::json!({
        "contextId": "ctx-1",
        "gvr": "/v1/pods",
        "name": "web-0",
        "previous": true
    }))
    .expect("deserialize with previous");
    assert_eq!(prev_args.previous, Some(true));

    let lp = build_pod_log_params(Some("app".to_string()), 200, true);
    assert!(lp.previous);
    assert!(lp.timestamps);
    assert_eq!(lp.container.as_deref(), Some("app"));
    assert_eq!(lp.tail_lines, Some(200));

    assert!(should_fallback_to_init_containers(false, false, true));
    assert!(!should_fallback_to_init_containers(true, false, true));
    assert!(!should_fallback_to_init_containers(false, true, true));
}
```

- [ ] **Step 2: Run the Rust test to verify it fails**

Run:
```bash
cargo test --manifest-path src-tauri/Cargo.toml pod_log_params_respects_previous
```
Expected: FAIL (compile error: `GetPodLogsArgs` has no field `previous`, helpers do not exist yet).

- [ ] **Step 3: Implement `previous` in `src-tauri/src/ipc/dto.rs` and `src-tauri/src/app.rs`**

1. In `src-tauri/src/ipc/dto.rs`, add `#[serde(default)] pub previous: Option<bool>,` to `GetPodLogsArgs`:
```rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GetPodLogsArgs {
    pub context_id: ContextId,
    pub gvr: GroupVersionResource,
    pub name: String,
    #[serde(default)]
    pub namespace: Option<String>,
    #[serde(default)]
    pub container: Option<String>,
    #[serde(default)]
    pub tail_lines: Option<i64>,
    #[serde(default)]
    pub previous: Option<bool>,
}
```
2. In `src-tauri/src/app.rs`, add the two pure helpers right above `get_pod_logs`:
```rust
fn build_pod_log_params(container: Option<String>, tail_lines: i64, previous: bool) -> LogParams {
    LogParams {
        container,
        timestamps: true,
        tail_lines: Some(tail_lines),
        previous,
        ..Default::default()
    }
}

fn should_fallback_to_init_containers(
    previous: bool,
    has_regular_logs: bool,
    has_init_containers: bool,
) -> bool {
    !previous && !has_regular_logs && has_init_containers
}
```
3. Inside `get_pod_logs`, compute `let previous = args.previous.unwrap_or(false);` and use `build_pod_log_params` in the `requested_container` branch, the regular containers branch, and the `initContainers` fallback branch, guarding the fallback with `if should_fallback_to_init_containers(previous, has_regular_logs, !pod_init_containers.is_empty())`.

- [ ] **Step 4: Regenerate IPC contract schema and mirror in TypeScript**

1. Run `pnpm ipc:schema` to update `src/lib/ipc/schema/contract.json`.
2. Update `src/lib/ipc/types.ts`: add `previous?: boolean;` to `GetPodLogsArgs`.
3. Update `src/lib/ipc/client.ts`: add `previous?: boolean` as the 7th parameter of `ipc.getPodLogs` and pass `previous` in the payload `{ contextId, gvr, name, namespace, container, tailLines, previous }`.
4. Update `src/lib/hooks.ts`:
   - Add `previous?: boolean` to `resourceKeys.logs(...)` (include `Boolean(previous)` in the query key tuple so normal and previous logs never collide in React Query cache).
   - Add `previous?: boolean` to `usePodLogsQuery` args and forward it to `resourceKeys.logs` and `ipc.getPodLogs`.

- [ ] **Step 5: Run Rust test and `pnpm ipc:check` to verify backend + contract**

Run:
```bash
pnpm build && cargo test --manifest-path src-tauri/Cargo.toml pod_log_params_respects_previous && pnpm ipc:check
```
Expected: PASS (Rust test passes, `pnpm ipc:check` reports zero drift).

- [ ] **Step 6: Write failing frontend UI test for `Previous` logs toggle in `tests/frontend/ide-ui.test.tsx`**

Add a test in `tests/frontend/ide-ui.test.tsx` verifying:
- Opening Logs on a Pod shows the `Previous` toggle (`data-testid="toggle-previous-logs"`), initially inactive (`aria-pressed="false"`), and `get_pod_logs` is invoked with `previous: false` (or `undefined`).
- Clicking `Previous` toggles it active (`aria-pressed="true"`), switches the Live button to `Paused`, and invokes `get_pod_logs` with `previous: true`, displaying the returned previous crash logs (or kubelet's error chunk verbatim when no prior terminated container exists).
- Re-rendering `ResourceDetail` with a different Pod `name` resets `Previous` back to `aria-pressed="false"`.

- [ ] **Step 7: Run the frontend test to verify it fails**

Run:
```bash
pnpm test tests/frontend/ide-ui.test.tsx -t "previous container logs"
```
Expected: FAIL (`toggle-previous-logs` button not found).

- [ ] **Step 8: Implement `Previous` toggle in `src/components/explorer/resource-detail.tsx`**

In `src/components/explorer/resource-detail.tsx`:
1. Add state `const [previousLogs, setPreviousLogs] = useState(false);`.
2. Inside the `useEffect(..., [contextId, gvr, name, namespace])` reset block, add `setPreviousLogs(false);`.
3. Pass `previous: previousLogs` to `usePodLogsQuery`, and compute `refetchInterval: activeTab === "logs" && liveLogs && !previousLogs ? 3000 : false`.
4. In the Logs toolbar (right before the `Live / Paused` button), render a `Previous` toggle button:
```tsx
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
```
5. When clicking `Live / Paused` while `previousLogs` is `true`, if the user turns Live back on, set `setPreviousLogs(false)` so Live polling actually resumes on current container logs.

- [ ] **Step 9: Run frontend tests and verify**

Run:
```bash
pnpm test tests/frontend/ide-ui.test.tsx -t "previous container logs"
```
Expected: PASS.

---

### Task 2: Manifest Reference Extraction & Kind→GVR Resolver

**Files:**
- Modify: `src/lib/resource-telemetry.ts` (lines 179–210, 520–565)
- Create: `tests/frontend/resource-telemetry.test.ts`

- [ ] **Step 1: Write failing unit tests in `tests/frontend/resource-telemetry.test.ts`**

Create `tests/frontend/resource-telemetry.test.ts` testing:
1. `parseManifestSummary` extracts:
   - `ownerReferences`: `[{ kind: "ReplicaSet", name: "api-gateway-6f7d8b9c4", apiVersion: "apps/v1" }]` from `metadata.ownerReferences`.
   - `configMapRefs`: deduplicated, sorted names from `volumes[].configMap.name`, `envFrom[].configMapRef.name`, and `env[].valueFrom.configMapKeyRef.name`.
   - `secretRefs`: deduplicated, sorted names from `volumes[].secret.secretName`, `envFrom[].secretRef.name`, and `env[].valueFrom.secretKeyRef.name`.
2. `resolveGvrForKind`:
   - Resolves `"Node"` → `{ gvr: "/v1/nodes", namespaced: false }` (cluster-scoped!).
   - Resolves `"ServiceAccount"` → `{ gvr: "/v1/serviceaccounts", namespaced: true }`.
   - Resolves `"ReplicaSet"` → `{ gvr: "apps/v1/replicasets", namespaced: true }`.
   - Resolves `"ConfigMap"` → `{ gvr: "/v1/configmaps", namespaced: true }` and `"Secret"` → `{ gvr: "/v1/secrets", namespaced: true }`.
   - Prefers a matching entry from `discovered: DiscoveredResourceDto[]` (including CRDs like `Certificate` from `cert-manager.io/v1/certificates`), and returns `null` for an unknown kind when not in `discovered`.

- [ ] **Step 2: Run the new test file to verify it fails**

Run:
```bash
pnpm test tests/frontend/resource-telemetry.test.ts
```
Expected: FAIL (`resolveGvrForKind` is not exported and `ParsedManifestInfo` lacks `ownerReferences`, `configMapRefs`, `secretRefs`).

- [ ] **Step 3: Implement manifest reference parsing & `resolveGvrForKind` in `src/lib/resource-telemetry.ts`**

1. Export types in `src/lib/resource-telemetry.ts`:
```ts
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
```
2. Add `ownerReferences: ParsedOwnerRef[]`, `configMapRefs: string[]`, and `secretRefs: string[]` to `ParsedManifestInfo`.
3. In `parseManifestSummary`:
   - Parse `metadata.ownerReferences` via `sliceYamlBlock(metadataBlock.body, "ownerReferences")` + `splitYamlListItems`, reading `kind`, `name`, and optional `apiVersion` for each item.
   - Extract `configMapRefs` and `secretRefs` from the manifest YAML covering:
     - `secretName:\s*["']?([A-Za-z0-9._-]+)["']?`
     - `secret(?:Key)?Ref:\s*\n\s+name:\s*["']?([A-Za-z0-9._-]+)["']?`
     - `configMap:\s*\n\s+name:\s*["']?([A-Za-z0-9._-]+)["']?`
     - `configMap(?:Key)?Ref:\s*\n\s+name:\s*["']?([A-Za-z0-9._-]+)["']?`
     Return deduplicated, alphabetically sorted string arrays.
4. Export `resolveGvrForKind(kind: string, discovered: DiscoveredResourceDto[] = []): { gvr: string; namespaced: boolean } | null`:
   - Match `discovered` first (`r.kind.toLowerCase() === kind.toLowerCase()`).
   - Fallback map for standard Kubernetes kinds:
     - Core namespaced: `Pod` (`/v1/pods`), `Service` (`/v1/services`), `ConfigMap` (`/v1/configmaps`), `Secret` (`/v1/secrets`), `ServiceAccount` (`/v1/serviceaccounts`), `PersistentVolumeClaim` (`/v1/persistentvolumeclaims`), `ReplicationController` (`/v1/replicationcontrollers`)
     - Core cluster-scoped: `Node` (`/v1/nodes`), `Namespace` (`/v1/namespaces`), `PersistentVolume` (`/v1/persistentvolumes`)
     - `apps/v1` namespaced: `Deployment` (`apps/v1/deployments`), `ReplicaSet` (`apps/v1/replicasets`), `StatefulSet` (`apps/v1/statefulsets`), `DaemonSet` (`apps/v1/daemonsets`)
     - `batch/v1` namespaced: `Job` (`batch/v1/jobs`), `CronJob` (`batch/v1/cronjobs`)
     - `networking.k8s.io/v1` namespaced: `Ingress` (`networking.k8s.io/v1/ingresses`), `NetworkPolicy` (`networking.k8s.io/v1/networkpolicies`)
     - `autoscaling/v2` namespaced: `HorizontalPodAutoscaler` (`autoscaling/v2/horizontalpodautoscalers`)

- [ ] **Step 4: Run `tests/frontend/resource-telemetry.test.ts` to verify it passes**

Run:
```bash
pnpm test tests/frontend/resource-telemetry.test.ts
```
Expected: PASS.

---

### Task 3: Cross-Resource Clickable Navigation & Back/Forward History

**Files:**
- Modify: `src/components/ide/topology-canvas.tsx` (lines 70–84, 1330–1400)
- Modify: `src/components/explorer/resource-detail.tsx` (props, Overview Metadata & References, Topology tab)
- Modify: `src/routes/cluster-shell.tsx` (navigation history stack, `navigateToResource`, Back/Forward handlers, wiring `ResourceDetail`)
- Modify: `src/App.tsx` (connect `AppShell` `canGoBack` / `canGoForward` / `onGoBack` / `onGoForward` to `ClusterShell`'s history controller)
- Test: `tests/frontend/ide-ui.test.tsx`

- [ ] **Step 1: Write failing tests in `tests/frontend/ide-ui.test.tsx`**

Add tests covering:
1. **Overview clickable links (`ResourceDetail`)**: Rendering a Pod with `nodeName: worker-1`, `serviceAccountName: api-sa`, `ownerReferences: [{ kind: "ReplicaSet", name: "api-gateway-6f7d8b" }]`, a mounted `ConfigMap` (`app-config`), and a mounted `Secret` (`db-creds`) renders clickable buttons for each; clicking `worker-1` calls `onNavigateResource` with `{ kind: "Node", gvr: "/v1/nodes", name: "worker-1", namespace: undefined }` (cluster-scoped!), and clicking `api-gateway-6f7d8b`, `api-sa`, `app-config`, or `db-creds` calls `onNavigateResource` with the Pod's namespace (`default`) and resolved GVR.
2. **Topology card `Open` button safety (`TopologyCanvas`)**: Clicking a non-focus node card body selects it without calling `onOpenNode`; clicking its explicit `Open` button (`data-testid="topology-open-node-..."`) calls `onOpenNode(node)` and does not appear on the focus node itself.
3. **End-to-end jump + Back/Forward history (`App` / `ClusterShell`)**: From a Pod detail view, clicking the `Node` link opens the `Node` resource detail tab via `get_resource` (without invoking `list_resources` for `/v1/nodes`), enables the top-bar Back (`←`) button, clicking Back returns to the Pod detail tab and enables Forward (`→`), and clicking Forward returns to the `Node` detail tab.

- [ ] **Step 2: Run the new tests to verify they fail**

Run:
```bash
pnpm test tests/frontend/ide-ui.test.tsx -t "cross-resource|topology open|navigation history"
```
Expected: FAIL.

- [ ] **Step 3: Add explicit `Open` button to non-focus cards in `src/components/ide/topology-canvas.tsx`**

1. Add `onOpenNode?: (node: TopologyNode) => void;` to `TopologyCanvasProps`.
2. In the card header (`src/components/ide/topology-canvas.tsx` around line 1363), when `onOpenNode && !node.isFocus`, render a compact `Open` button (with `ArrowUpRight` icon from `lucide-react`):
```tsx
{onOpenNode && !node.isFocus ? (
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
```

- [ ] **Step 4: Wire clickable references & Topology `onOpenNode` in `src/components/explorer/resource-detail.tsx`**

1. Extend `ResourceDetailProps` with:
   - `discoveredResources?: DiscoveredResourceDto[];`
   - `onNavigateResource?: (target: ResourceNavigationTarget) => void;`
2. Add a small helper inside `ResourceDetail`:
```tsx
function navigateKind(kind: string, targetName: string) {
  if (!onNavigateResource || !targetName || targetName === "—") return;
  const resolved = resolveGvrForKind(kind, discoveredResources);
  if (!resolved) return;
  onNavigateResource({
    kind,
    gvr: resolved.gvr,
    name: targetName,
    namespace: resolved.namespaced ? (namespace || parsed?.namespace || "default") : undefined,
  });
}
```
3. In the Overview `Metadata` card:
   - Make `Service Account` (`parsed?.serviceAccount`) clickable when `onNavigateResource` is provided (`data-testid="nav-link-serviceaccount"`).
   - Make `Node` (`parsed?.nodeName`) clickable when `onNavigateResource` is provided (`data-testid="nav-link-node"`), keeping the `(podIP)` suffix outside the button.
   - If `parsed?.ownerReferences.length > 0`, render a `Controlled By` metadata block with clickable pills (`data-testid={`nav-link-owner-${owner.name}`}`) showing `${owner.kind}/${owner.name}`.
   - If `parsed?.configMapRefs.length > 0 || parsed?.secretRefs.length > 0`, render a `Referenced Config & Secrets` block inside Overview (right below Labels/Annotations) with clickable pills for each ConfigMap (`data-testid={`nav-link-configmap-${cm}`}`) and Secret (`data-testid={`nav-link-secret-${sec}`}`).
4. In the `Topology` tab (`<TopologyCanvas ... />`), pass `onOpenNode`:
```tsx
onOpenNode={
  onNavigateResource
    ? (node) => {
        const resolved = resolveGvrForKind(node.kind, discoveredResources);
        if (!resolved) return;
        onNavigateResource({
          kind: node.kind,
          gvr: resolved.gvr,
          name: node.name,
          namespace: resolved.namespaced
            ? (node.namespace || namespace || parsed?.namespace || "default")
            : undefined,
        });
      }
    : undefined
}
```

- [ ] **Step 5: Implement `navigateToResource` & Back/Forward history stack in `src/routes/cluster-shell.tsx` and connect to `src/App.tsx`**

1. Define a lightweight `NavHistoryEntry` union in `src/routes/cluster-shell.tsx`:
```ts
type NavHistoryEntry =
  | { kind: "overview" }
  | { kind: "special"; target: SpecialNavTarget }
  | { kind: "resource-list"; gvr: string }
  | { kind: "resource-detail"; gvr: string; name: string; namespace?: string; detailTab?: DetailTab };
```
2. Maintain `historyRef` + `historyState` (`{ entries: NavHistoryEntry[]; index: number }`) initialized from the active view, plus a pure equality helper `sameHistoryEntry(a, b)` so navigating to the current entry never creates duplicates.
3. Implement `navigateToResource(target: ResourceNavigationTarget)`:
   - Captures the current view snapshot as the base entry if not already at `history.entries[history.index]`.
   - Truncates any forward entries (`entries.slice(0, index + 1)`), appends `{ kind: "resource-detail", gvr: target.gvr, name: target.name, namespace: target.namespace, detailTab: "overview" }`, advances `index`, and calls `openResourceFullTab(target.gvr, target.name, target.namespace, "overview")` (never calls `setActiveGvr` or `list_resources`).
4. Implement `goBackInCluster()` and `goForwardInCluster()` that move `history.index` by `-1` / `+1` and restore the entry cleanly (setting `skipHistoryPushRef.current = true` during restoration so effect syncs don't re-push).
5. Also record transitions when switching `activeGvr` / `specialView` / opening a full detail tab (`openResourceFullTab`).
6. Expose a small prop on `ClusterShell`:
```ts
export interface ClusterNavControls {
  canGoBack: boolean;
  canGoForward: boolean;
  goBack: () => void;
  goForward: () => void;
}
```
Pass `onNavControlsChange?: (controls: ClusterNavControls) => void` from `App.tsx` to `ClusterShell`. In `App.tsx`:
- Reset nav controls when `selectedId` changes.
- `canGoBack={Boolean(selectedId)}` (so Back can always pop cluster history first, and when at index 0 fall back to existing behavior: clearing `activeGvr`/`specialView` or returning to cluster picker).
- `canGoForward={Boolean(selectedId && clusterNav?.canGoForward)}`.
- `onGoBack`: if `clusterNav?.canGoBack`, call `clusterNav.goBack()`; otherwise keep the existing fallback.
- `onGoForward`: call `clusterNav?.goForward()`.
7. Pass `discoveredResources={resources}` and `onNavigateResource={navigateToResource}` to both the full-tab `ResourceDetail` and the split-pane `ResourceDetail` in `ClusterShell`, and pass `onOpenNode` to the top-level `TopologyCanvas` special view in `ClusterShell` too so cluster-level Topology cards also support `Open`.

- [ ] **Step 6: Run the frontend tests and verify**

Run:
```bash
pnpm test tests/frontend/ide-ui.test.tsx tests/frontend/app.test.tsx
```
Expected: PASS (both new tests and all existing tests pass with zero regressions).

---

### Task 4: Instance-Level `Cmd+K` Search & Final Verification Gate

**Files:**
- Modify: `src/components/ide/global-command-bar.tsx` (props, loaded resource selector, results section, keyboard navigation)
- Modify: `src/components/ide/app-shell.tsx` (thread `onSelectResourceInstance`)
- Modify: `src/App.tsx` (hold `pendingResourceJump` state and pass `onSelectResourceInstance` → `AppShell`, `pendingResourceJump` → `ClusterShell`)
- Modify: `src/routes/cluster-shell.tsx` (consume `pendingResourceJump` via `navigateToResource`)
- Test: `tests/frontend/ide-ui.test.tsx`

- [ ] **Step 1: Write failing tests in `tests/frontend/ide-ui.test.tsx`**

Add tests verifying:
1. **Loaded resource matching & deduplication**: Populate `useExplorerStore` with rows for `ctx-1` (including the same Pod `uid` loaded under both `namespace: "default"` and `namespace: ""`, plus a Deployment `api-gateway` in `kubix-demo`) and rows for a different cluster `ctx-2` (`secret-other-cluster`). Open `Cmd+K` with `activeContext = ctx-1` and type `"api-gateway"`:
   - Shows a **Loaded Resources** section with `api-gateway` (kind, name, namespace).
   - Never shows `secret-other-cluster` from `ctx-2`.
   - Deduplicates the duplicate `uid` so it appears once.
2. **Direct jump to detail view**: Clicking a loaded resource item in `Cmd+K` closes the palette, clears the query, and opens that resource's detail view directly in `ClusterShell` (calling `get_resource` for that instance without resetting to the list view).

- [ ] **Step 2: Run the new tests to verify they fail**

Run:
```bash
pnpm test tests/frontend/ide-ui.test.tsx -t "instance-level|loaded resources"
```
Expected: FAIL.

- [ ] **Step 3: Add loaded resource search to `src/components/ide/global-command-bar.tsx`**

1. Extend `GlobalCommandBarProps` with:
   ```ts
   onSelectResourceInstance?: (target: ResourceNavigationTarget) => void;
   ```
2. Read `const views = useExplorerStore((s) => s.views);` inside `GlobalCommandBar`.
3. Compute `matchedInstances` via `useMemo` when `open && activeContext`:
   - Iterate `Object.entries(views)` where `key.startsWith(`${activeContext.id}\u0000`)`.
   - Parse `gvr` from `key.split("\u0000")[1]`.
   - Look up `kind` from `resources.find((r) => r.gvr === gvr)?.kind` (falling back to singularized GVR segment).
   - Deduplicate by `row.uid` (falling back to `${gvr}:${row.namespace ?? ""}:${row.name}` if `uid` is empty).
   - Filter by `q` matching `row.name`, `row.namespace ?? ""`, or `kind` (case-insensitive). Show up to 8 matches (only when `q.length > 0` or if user has loaded rows — show top 8 when `q.length > 0` so empty `Cmd+K` stays clean and focused on clusters/views/kinds, and when typing a name like `metrics-server` or `api-gateway`, loaded instances appear right at the top!).
4. Render a **Loaded Resources** section (`data-testid="command-palette-instances"`) right below the Topology action (when `matchedInstances.length > 0`) with buttons (`data-testid={`command-instance-${item.uid}`}`) showing kind pill, monospace name, and namespace badge; clicking calls `onSelectResourceInstance({ kind, gvr, name, namespace })`, closes the palette, and resets `query` to `""`.
5. If the user presses `Enter` inside the command search `<input>` while `matchedInstances.length > 0` and `q.length > 0`, jump directly to `matchedInstances[0]` (closing the palette and clearing `query`).

- [ ] **Step 4: Wire `onSelectResourceInstance` through `AppShell`, `App.tsx`, and `ClusterShell`**

1. In `src/components/ide/app-shell.tsx`: add `onSelectResourceInstance?: (target: ResourceNavigationTarget) => void` to `AppShellProps` and forward it to `<GlobalCommandBar>`.
2. In `src/App.tsx`:
   - Add `const [pendingJump, setPendingJump] = useState<(ResourceNavigationTarget & { nonce: number }) | null>(null);`.
   - Clear `pendingJump` when `selectedId` changes.
   - Pass `onSelectResourceInstance={(target) => setPendingJump({ ...target, nonce: Date.now() })}` to `<AppShell>`.
   - Pass `pendingResourceJump={pendingJump}` and `onConsumedResourceJump={() => setPendingJump(null)}` to `<ClusterShell>`.
3. In `src/routes/cluster-shell.tsx`:
   - Add a `useEffect` watching `pendingResourceJump?.nonce`: when present, call `navigateToResource(pendingResourceJump)` and `onConsumedResourceJump?.()`.

- [ ] **Step 5: Run full verification suite (`pnpm build && pnpm verify`)**

Run:
```bash
pnpm build && pnpm verify
```
Expected: ALL gates pass cleanly:
- `cargo fmt --manifest-path src-tauri/Cargo.toml --all --check`
- `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`
- `cargo test --manifest-path src-tauri/Cargo.toml` (all Rust unit + IPC contract + `readonly.rs` tests pass)
- `pnpm typecheck` (`tsc --noEmit`)
- `pnpm test` (all Vitest suites pass)
- `pnpm ipc:check` (zero Rust↔TS contract drift)
