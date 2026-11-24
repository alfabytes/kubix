import { describe, expect, it } from "vitest";

import { applyDelta, resourceKeyString } from "@/lib/ipc/client";
import type { ResourceDeltaDto, ResourceSummaryDto } from "@/lib/ipc/types";
import { useExplorerStore } from "@/stores/explorer-store";
import { useClusterStore } from "@/stores/cluster-store";
import type { ClusterContextDto } from "@/lib/ipc/types";

const pod = (uid: string, name: string, namespace = "dev"): ResourceSummaryDto => ({
  uid,
  name,
  namespace,
  kind: "Pod",
  createdAt: "2026-01-01T00:00:00Z",
  labels: {},
});

const ctx = (id: string, over: Partial<ClusterContextDto> = {}): ClusterContextDto => ({
  id,
  name: id,
  clusterName: `cluster-${id}`,
  server: `${id}.test:6443`,
  namespaceDefault: "default",
  authKind: "exec",
  authHint: "aws",
  isCurrent: false,
  state: "disconnected",
  issues: [],
  ...over,
});

describe("explorer store", () => {
  it("loads, applies deltas and reports view state", () => {
    const store = useExplorerStore.getState();
    store.reset();
    const key = { contextId: "c1", gvr: "/v1/pods", namespace: "dev" };

    useExplorerStore.getState().beginLoad(key);
    expect(useExplorerStore.getState().views[resourceKeyString(key)]?.status).toBe("loading");

    useExplorerStore.getState().finishLoad(key, [pod("1", "a"), pod("2", "b")]);
    const loaded = useExplorerStore.getState().views[resourceKeyString(key)];
    expect(loaded?.status).toBe("ready");
    expect(loaded?.rows).toHaveLength(2);
    expect(loaded?.loadedAt).toBeTypeOf("number");

    const delta: ResourceDeltaDto = {
      contextId: "c1",
      gvr: "/v1/pods",
      namespace: "dev",
      batchId: 2,
      upserts: [pod("3", "c"), pod("1", "a2")],
      deletions: [{ uid: "2" }],
      truncated: false,
      isSnapshot: false,
    };
    useExplorerStore.getState().applyDelta(delta);
    const updated = useExplorerStore.getState().views[resourceKeyString(key)];
    expect(updated?.rows.map((r) => r.name)).toEqual(["a2", "c"]);
  });

  it("ignores deltas for views it does not track", () => {
    useExplorerStore.getState().reset();
    useExplorerStore
      .getState()
      .applyDelta({
        contextId: "ghost",
        gvr: "/v1/pods",
        namespace: "",
        batchId: 1,
        upserts: [pod("1", "a")],
        deletions: [],
        truncated: false,
        isSnapshot: false,
      });
    expect(Object.keys(useExplorerStore.getState().views)).toHaveLength(0);
  });

  it("marks a view stale when the backend truncates without rows", () => {
    useExplorerStore.getState().reset();
    const key = { contextId: "c1", gvr: "/v1/pods", namespace: "" };
    useExplorerStore.getState().finishLoad(key, [pod("1", "a", "")]);
    useExplorerStore.getState().applyDelta({
      contextId: "c1",
      gvr: "/v1/pods",
      namespace: "",
      batchId: 3,
      upserts: [],
      deletions: [],
      truncated: true,
      isSnapshot: false,
    });
    const view = useExplorerStore.getState().views[resourceKeyString(key)];
    expect(view?.status).toBe("stale");
    expect(view?.truncated).toBe(true);
  });

  it("records eviction and clears per-context state", () => {
    useExplorerStore.getState().reset();
    const key = { contextId: "c1", gvr: "/v1/pods", namespace: "" };
    useExplorerStore.getState().finishLoad(key, [pod("1", "a", "")]);
    useExplorerStore.getState().setDiscovered("c1", [], "ready");

    useExplorerStore.getState().markEvicted(key);
    expect(useExplorerStore.getState().views[resourceKeyString(key)]?.evicted).toBe(true);

    useExplorerStore.getState().clearContext("c1");
    expect(useExplorerStore.getState().views[resourceKeyString(key)]).toBeUndefined();
    expect(useExplorerStore.getState().discovered.c1).toBeUndefined();
  });

  it("exposes applyDelta as a pure function used by the store", () => {
    expect(applyDelta([], {
      contextId: "c",
      gvr: "/v1/pods",
      namespace: "",
      batchId: 1,
      upserts: [pod("1", "a", "")],
      deletions: [],
      truncated: false,
      isSnapshot: false,
    })?.length).toBe(1);
  });
});

describe("cluster store", () => {
  it("lists contexts without opening the kubectl current context", () => {
    useClusterStore.getState().reset();
    useClusterStore.getState().replaceAll([ctx("a"), ctx("b", { isCurrent: true })]);
    expect(useClusterStore.getState().contexts).toEqual(["a", "b"]);
    expect(useClusterStore.getState().selectedId).toBeNull();
    expect(useClusterStore.getState().loading).toBe(false);
    expect(useClusterStore.getState().error).toBeNull();
  });

  it("preserves selection when it still exists after a rescan", () => {
    useClusterStore.getState().reset();
    useClusterStore.getState().replaceAll([ctx("a"), ctx("b")]);
    useClusterStore.getState().select("a");
    useClusterStore.getState().replaceAll([ctx("a", { isCurrent: true, state: "ready" }), ctx("c")]);
    expect(useClusterStore.getState().selectedId).toBe("a");
  });

  it("keeps an in-flight pending state through a rescan", () => {
    useClusterStore.getState().reset();
    useClusterStore.getState().replaceAll([ctx("a")]);
    useClusterStore.getState().patchState("a", "connecting", true);
    useClusterStore.getState().replaceAll([ctx("a")]);
    const row = useClusterStore.getState().byId.a;
    expect(row?.pending).toBe(true);
    expect(row?.state).toBe("connecting");
  });

  it("upserts new contexts and ignores unknown patches", () => {
    useClusterStore.getState().reset();
    useClusterStore.getState().upsert(ctx("x"));
    expect(useClusterStore.getState().contexts).toEqual(["x"]);
    useClusterStore.getState().upsert(ctx("x", { state: "ready" }));
    expect(useClusterStore.getState().contexts).toEqual(["x"]);
    expect(useClusterStore.getState().byId.x?.state).toBe("ready");
    useClusterStore.getState().patchState("missing", "ready");
    expect(useClusterStore.getState().byId.missing).toBeUndefined();
  });

  it("clears selection that no longer exists", () => {
    useClusterStore.getState().reset();
    useClusterStore.getState().replaceAll([ctx("a", { isCurrent: true })]);
    useClusterStore.getState().select("a");
    useClusterStore.getState().replaceAll([ctx("b")]);
    expect(useClusterStore.getState().selectedId).toBeNull();
  });
});

describe("delta and snapshot ordering", () => {
  const key = { contextId: "c1", gvr: "/v1/pods", namespace: "dev" };

  const deltaWith = (over: Partial<ResourceDeltaDto>): ResourceDeltaDto => ({
    contextId: "c1",
    gvr: "/v1/pods",
    namespace: "dev",
    batchId: 1,
    upserts: [],
    deletions: [],
    truncated: false,
    isSnapshot: false,
    ...over,
  });

  it("accepts a delta that arrives before the list response", () => {
    useExplorerStore.getState().reset();
    useExplorerStore.getState().beginLoad(key);

    useExplorerStore
      .getState()
      .applyDelta(deltaWith({ upserts: [pod("early", "created-mid-flight")] }));

    expect(useExplorerStore.getState().views[resourceKeyString(key)]?.rows).toHaveLength(1);
  });

  it("snapshot merge keeps rows added by a delta mid flight", () => {
    useExplorerStore.getState().reset();
    useExplorerStore.getState().beginLoad(key);
    useExplorerStore.getState().applyDelta(deltaWith({ upserts: [pod("u2", "newer")] }));

    // The one-shot list resolves afterwards and does not know about u2 yet.
    useExplorerStore.getState().mergeSnapshot(key, [pod("u1", "older")]);

    const view = useExplorerStore.getState().views[resourceKeyString(key)];
    expect(view?.status).toBe("ready");
    expect(view?.rows.map((r) => r.uid)).toEqual(["u2", "u1"]);
  });

  it("snapshot merge does not let a stale list row replace a delta row", () => {
    useExplorerStore.getState().reset();
    useExplorerStore.getState().beginLoad(key);
    useExplorerStore
      .getState()
      .applyDelta(deltaWith({ upserts: [{ ...pod("u1", "renamed"), status: "Running" }] }));

    useExplorerStore.getState().mergeSnapshot(key, [pod("u1", "renamed")]);

    const view = useExplorerStore.getState().views[resourceKeyString(key)];
    expect(view?.rows).toHaveLength(1);
    expect(view?.rows[0]?.status).toBe("Running");
  });

  it("ignores deltas outside the tracked namespace", () => {
    useExplorerStore.getState().reset();
    useExplorerStore.getState().finishLoad(key, [pod("u1", "a")]);

    useExplorerStore
      .getState()
      .applyDelta(deltaWith({ namespace: "prod", upserts: [pod("u9", "b", "prod")] }));

    expect(useExplorerStore.getState().views[resourceKeyString(key)]?.rows).toHaveLength(1);
  });

  it("seeds the namespace filter once per scope", () => {
    useExplorerStore.getState().reset();
    useExplorerStore.getState().seedNamespace("c1\u0000/v1/pods", "dev");
    expect(useExplorerStore.getState().namespaceFilter).toBe("dev");
    expect(useExplorerStore.getState().seededFor).toBe("c1\u0000/v1/pods");

    useExplorerStore.getState().setNamespaceFilter("");
    useExplorerStore.getState().seedNamespace("c1\u0000/v1/pods", "dev");
    // The shell guards on seededFor, so an explicit "all namespaces" choice survives.
    expect(useExplorerStore.getState().namespaceFilter).toBe("dev");
  });

  it("applies snapshot batches by replacing rather than merging", () => {
    useExplorerStore.getState().reset();
    useExplorerStore.getState().finishLoad(key, [pod("old", "stale-row")]);

    useExplorerStore
      .getState()
      .applyDelta(deltaWith({ isSnapshot: true, batchId: 5, upserts: [pod("new", "fresh-row")] }));

    const rows = useExplorerStore.getState().views[resourceKeyString(key)]?.rows ?? [];
    expect(rows.map((r) => r.uid)).toEqual(["new"]);
  });
});
