import { describe, expect, it } from "vitest";

import { applyDelta, compareRows, resourceKeyString } from "@/lib/ipc/client";
import { KubixIpcError, normalizeIpcError } from "@/lib/ipc/events";
import type { ResourceDeltaDto, ResourceSummaryDto } from "@/lib/ipc/types";

const row = (uid: string, name: string, namespace?: string): ResourceSummaryDto => ({
  uid,
  name,
  kind: "Pod",
  createdAt: "2026-01-01T00:00:00Z",
  labels: {},
  ...(namespace === undefined ? {} : { namespace }),
});

const delta = (over: Partial<ResourceDeltaDto>): ResourceDeltaDto => ({
  contextId: "kind-dev",
  gvr: "/v1/pods",
  namespace: "dev",
  batchId: 1,
  upserts: [],
  deletions: [],
  truncated: false,
  isSnapshot: false,
  ...over,
});

describe("applyDelta", () => {
  it("adds new upserts", () => {
    const next = applyDelta([row("1", "a", "dev")], delta({ upserts: [row("2", "b", "dev")] }));
    expect(next?.map((r) => r.name)).toEqual(["a", "b"]);
  });

  it("replaces existing rows by uid without duplicating", () => {
    const updated = { ...row("1", "a", "dev"), status: "Running" };
    const next = applyDelta([row("1", "a", "dev")], delta({ upserts: [updated] }));
    expect(next).toHaveLength(1);
    expect(next?.[0]?.status).toBe("Running");
  });

  it("removes deletions", () => {
    const next = applyDelta(
      [row("1", "a", "dev"), row("2", "b", "dev")],
      delta({ deletions: [{ uid: "1" }] }),
    );
    expect(next?.map((r) => r.uid)).toEqual(["2"]);
  });

  it("applies deletion before upsert of the same uid in one batch", () => {
    const next = applyDelta(
      [],
      delta({ deletions: [{ uid: "1" }], upserts: [row("1", "recreated", "dev")] }),
    );
    expect(next?.map((r) => r.name)).toEqual(["recreated"]);
  });

  it("returns undefined for a truncated and empty batch so callers relist", () => {
    expect(applyDelta([row("1", "a", "dev")], delta({ truncated: true }))).toBeUndefined();
  });

  it("still applies a truncated batch that carries rows", () => {
    const next = applyDelta([], delta({ truncated: true, upserts: [row("9", "z", "dev")] }));
    expect(next?.map((r) => r.uid)).toEqual(["9"]);
  });

  it("keeps rows sorted by namespace then name", () => {
    const next = applyDelta(
      [],
      delta({
        upserts: [row("3", "c", "zeta"), row("1", "b", "alpha"), row("2", "a", "alpha")],
      }),
    );
    expect(next?.map((r) => `${r.namespace}/${r.name}`)).toEqual([
      "alpha/a",
      "alpha/b",
      "zeta/c",
    ]);
  });
});

describe("compareRows", () => {
  it("treats missing namespace as sorting first", () => {
    expect(compareRows(row("1", "b"), row("2", "a", "x"))).toBeLessThan(0);
  });
});

describe("resourceKeyString", () => {
  it("separates parts with a delimiter that names cannot contain", () => {
    expect(resourceKeyString({ contextId: "c", gvr: "/v1/pods", namespace: "" })).toBe(
      "c\u0000/v1/pods\u0000",
    );
  });

  it("distinguishes all-namespace from a named namespace", () => {
    const a = resourceKeyString({ contextId: "c", gvr: "/v1/pods", namespace: "" });
    const b = resourceKeyString({ contextId: "c", gvr: "/v1/pods", namespace: "default" });
    expect(a).not.toBe(b);
  });
});

describe("normalizeIpcError", () => {
  it("passes through already-normalized errors", () => {
    const err = new KubixIpcError({ code: "forbidden", message: "no", retryable: false });
    expect(normalizeIpcError(err)).toBe(err);
  });

  it("accepts a plain DTO", () => {
    const err = normalizeIpcError({
      code: "authFailed",
      message: "bad creds",
      retryable: false,
      contextId: "ctx",
    });
    expect(err).toBeInstanceOf(KubixIpcError);
    expect(err.code).toBe("authFailed");
    expect(err.contextId).toBe("ctx");
  });

  it("accepts a JSON string DTO", () => {
    const err = normalizeIpcError(
      JSON.stringify({ code: "clusterUnreachable", message: "down", retryable: true }),
    );
    expect(err.code).toBe("clusterUnreachable");
    expect(err.retryable).toBe(true);
  });

  it("accepts a wrapped { error } object", () => {
    const err = normalizeIpcError({
      error: { code: "unknownContext", message: "missing", retryable: false },
    });
    expect(err.code).toBe("unknownContext");
  });

  it("wraps unknown strings and objects as internal", () => {
    expect(normalizeIpcError("boom").code).toBe("internal");
    expect(normalizeIpcError({ weird: true }).code).toBe("internal");
    expect(normalizeIpcError(undefined).message).toBe("unexpected IPC failure");
  });

  it("keeps Error messages", () => {
    const err = normalizeIpcError(new Error("socket closed"));
    expect(err.code).toBe("internal");
    expect(err.message).toBe("socket closed");
  });
});
