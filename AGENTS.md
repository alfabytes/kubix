# Kubix

A free and open-source Kubernetes desktop IDE. Tauri 2 + Rust (kube-rs) backend,
React + TypeScript frontend.

**Milestone 1 scope:** kubeconfig discovery, multi-cluster navigation, and a read-only
resource explorer with live watch updates. No mutating Kubernetes operations exist.

## Read-only guarantee

Kubix never writes to a cluster in this milestone, and that is enforced structurally:

- `src-tauri/src/ipc/commands.rs` declares every command and asserts each is read-only.
- `src-tauri/src/readonly.rs` scans the backend sources for kube write verbs (`.create(`,
  `.delete(`, `.patch(`, …) and fails the test suite if one appears.
- Secrets are masked in the backend before serialization
  (`src-tauri/src/app.rs::mask_secrets`); raw `data`/`stringData` never crosses the IPC boundary.

Adding write support requires deliberately editing those guards, which is the review gate.

## Layout

```
src/                 React frontend
  lib/ipc/           the only place that calls Tauri invoke/listen
    types.ts         TypeScript mirror of src-tauri/src/ipc/dto.rs
    client.ts        typed command wrappers + delta application
    events.ts        event names, payload types, error normalization
    schema/          generated contract.json (do not hand-edit)
  stores/            zustand: cluster state, explorer views
  routes/            ClusterPicker, ClusterShell
  components/        ui primitives, cluster cards, explorer table/detail
src-tauri/           Rust backend
  src/config/        kubeconfig parsing, credential-free context descriptors
  src/cluster/       lazy client pool, connect timeout, auth classification
  src/discovery/     API discovery normalization + curated GVK catalog
  src/watch/         delta accumulator, watcher budget/LRU, summary mapping
  src/ipc/           command roster, DTOs, event names, contract emitter
  src/app.rs         Tauri commands and event emission
tests/frontend/      vitest: IPC client, stores, components, app integration
src-tauri/tests/     IPC contract + capability + secret-leak guards
```

## Prerequisites

- Node 22+ and pnpm 12
- Rust stable (`rustup`), with `rustfmt` and `clippy` components
- For `pnpm tauri dev` on Linux: `libwebkit2gtk-4.1-dev`, `libappindicator3-dev`,
  `librsvg2-dev`, `patchelf`, `libssl-dev`, `libgtk-3-dev`
- Optional, for a disposable test cluster: `kind` **plus a working container runtime**
  (Docker Desktop, OrbStack, Colima, or Podman). Kubix itself does not need a runtime.

## Commands

```bash
pnpm install                 # install frontend dependencies (no flags needed)
pnpm dev                     # vite dev server (http://localhost:1420)
pnpm tauri dev               # full desktop app
pnpm build                   # typecheck + production bundle (required before cargo test)
pnpm typecheck               # tsc --noEmit
pnpm test                    # vitest run
pnpm ipc:schema              # regenerate src/lib/ipc/schema/contract.json from Rust
pnpm ipc:check               # fail when Rust DTOs and the TS mirror drift

cargo fmt     --manifest-path src-tauri/Cargo.toml --all --check
cargo clippy  --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test    --manifest-path src-tauri/Cargo.toml
```

`pnpm verify` runs format → clippy → rust tests → typecheck → vitest → IPC drift in order.

`cargo test` compiles the Tauri context macro, which requires `dist/` to exist, so run
`pnpm build` once before the first `cargo test`.

## IPC contract workflow

Rust is the source of truth. When you change a DTO or a command:

1. Edit `src-tauri/src/ipc/{dto,commands,events}.rs`.
2. `pnpm ipc:schema` and commit the regenerated `contract.json`.
3. Mirror the field in `src/lib/ipc/types.ts` (field names are camelCase on both sides).
4. `pnpm ipc:check` must pass — it regenerates from Rust, diffs the committed contract,
   and verifies every contract field exists in the TS mirror.

Events: `kubix://resource-delta`, `kubix://context-state`, `kubix://watch-evicted`.

## Manual acceptance

Automated where it can be honest, manual only for what needs eyes on a window.

```bash
./scripts/create-kind-cluster.sh          # needs a container runtime
cargo test --manifest-path src-tauri/Cargo.toml -- --ignored   # kind-backed checks
pnpm tauri dev
```

The `--ignored` suite drives the real command layer against the kind context named by
`$KUBIX_KIND_CONTEXT` and fails (never skips) when that variable is set but the cluster is
unreachable.

### UI checklist (run once per change to the explorer)

1. The cluster picker lists every context in `$KUBECONFIG` / `~/.kube/config`, showing
   auth kind (`exec` vs `clientCert`) and the API server host only — no credentials.
2. Nothing is contacted at startup: contexts stay `disconnected` until selected.
3. Selecting the kind context reaches `ready`; an unreachable context shows `unreachable`
   with a retry action, and a context with rejected credentials shows `authFailed` —
   not the same badge, not a hang.
4. Opening Pods shows only the context's default namespace without typing; the **All
   namespaces** button lists every namespace, and switching resource types re-seeds the
   filter to the default.
5. Opening a Secret shows masked values plus a `maskedPaths` banner; the YAML editor is
   read-only.
6. `kubectl -n kubix-demo run extra --image=nginx` adds a row within ~1 s; deleting it
   removes the row.
7. Opening nine distinct views evicts the oldest: it shows the stale banner and Reload
   resyncs.

## Testing against real clusters

Only read-only listing is safe. `~/.kube/config` on the author's machine is treated as a
*fixture corpus* (it contains orphan clusters, a context without a user, and stale `.bak`
files); automated tests never point at it. Use `kind` or the unit-level fakes instead.

## Known limitations (milestone 1)

- No write/apply/delete, no exec, no logs, no Helm, no metrics, no topology graph UI.
- No proxy or impersonation support.
- `kubectl` exec auth apiVersion `v1beta1` is accepted; newer clusters may require an
  upgrade path that is not implemented yet.
- Watches are capped at 8 concurrent; evicted views show a stale banner and need a reload.
