import { describe, expect, it } from "vitest";

import type { ConnectionState, KubixErrorDto } from "@/lib/ipc/types";
import { describeConnectionState, formatTimestamp, shortGvr } from "@/lib/utils";

const err = (over: Partial<KubixErrorDto> = {}): KubixErrorDto => ({
  code: "authFailed",
  message: "credentials rejected",
  retryable: false,
  ...over,
});

describe("describeConnectionState", () => {
  const cases: Array<[ConnectionState, string, string]> = [
    ["disconnected", "Disconnected", "neutral"],
    ["connecting", "Connecting", "busy"],
    ["ready", "Connected", "ok"],
    ["authRequired", "Auth required", "warn"],
    ["authFailed", "Auth failed", "error"],
    ["unreachable", "Unreachable", "error"],
    ["forbidden", "Forbidden", "warn"],
    ["degraded", "Degraded", "warn"],
  ];

  it.each(cases)("maps %s to %s/%s", (state, label, tone) => {
    const described = describeConnectionState(state);
    expect(described.label).toBe(label);
    expect(described.tone).toBe(tone);
    expect(described.description.length).toBeGreaterThan(0);
  });

  it("prefers the backend error message for auth failures", () => {
    expect(describeConnectionState("authFailed", err()).description).toBe("credentials rejected");
  });

  it("prefers the backend error message for unreachable clusters", () => {
    const described = describeConnectionState(
      "unreachable",
      err({ code: "clusterUnreachable", message: "connection refused" }),
    );
    expect(described.description).toBe("connection refused");
  });

  it("ignores stale error text for ready contexts", () => {
    expect(describeConnectionState("ready", err()).description).toContain("Read-only");
  });
});

describe("formatTimestamp", () => {
  it("returns a dash for empty values", () => {
    expect(formatTimestamp("")).toBe("—");
  });

  it("passes through unparseable values", () => {
    expect(formatTimestamp("not a date")).toBe("not a date");
  });

  it("formats a valid RFC3339 timestamp", () => {
    expect(formatTimestamp("2026-01-02T03:04:05Z")).not.toBe("—");
  });
});

describe("shortGvr", () => {
  it("keeps core resources readable", () => {
    expect(shortGvr("/v1/pods")).toBe("v1/pods");
  });

  it("drops the group for named resources", () => {
    expect(shortGvr("apps/v1/deployments")).toBe("v1/deployments");
  });
});
