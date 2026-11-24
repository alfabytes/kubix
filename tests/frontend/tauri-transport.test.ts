import { describe, expect, it, vi } from "vitest";

const { invokeSpy } = vi.hoisted(() => ({
  invokeSpy: vi.fn(async (_command: string, _payload?: unknown) => null),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, payload?: unknown) => invokeSpy(command, payload),
}));

describe("tauriTransport.invoke", () => {
  it("nests the DTO under `args` so Tauri can unwrap the Rust parameter", async () => {
    const { tauriTransport } = await import("@/lib/ipc/client");
    await tauriTransport.invoke("discover_resources", { contextId: "kind-kubix-dev" });

    expect(invokeSpy).toHaveBeenCalledWith("discover_resources", {
      args: { contextId: "kind-kubix-dev" },
    });
  });

  it("sends an empty object for no-arg commands instead of undefined", async () => {
    const { tauriTransport } = await import("@/lib/ipc/client");
    await tauriTransport.invoke("list_contexts", null);
    expect(invokeSpy).toHaveBeenCalledWith("list_contexts", {});
  });
});
