import { afterEach, describe, expect, it } from "vitest";

import {
  getIpcTransport,
  ipc,
  setIpcTransport,
  tauriTransport,
  type IpcTransport,
} from "@/lib/ipc/client";

/**
 * The Rust handlers take a single `args: SomeArgs` parameter, so Tauri unwraps the
 * payload by parameter name: the invoke payload must be `{ args: { ...fields } }`.
 * Passing the fields at the top level yields
 * "command discover_resources missing required key args".
 */
function recordingTransport(): { transport: IpcTransport; calls: Array<{ command: string; payload: unknown }> } {
  const calls: Array<{ command: string; payload: unknown }> = [];
  const transport: IpcTransport = {
    invoke: (async (command: string, args: unknown) => {
      calls.push({ command, payload: args });
      return null;
    }) as IpcTransport["invoke"],
    listen: (async () => () => {}) as IpcTransport["listen"],
  };
  return { transport, calls };
}

afterEach(() => {
  setIpcTransport(tauriTransport);
});

describe("transport arg shape", () => {
  it("sends command arguments untouched on the transport seam", async () => {
    const { transport, calls } = recordingTransport();
    setIpcTransport(transport);
    await ipc.discoverResources("kind-kubix-dev");
    expect(calls[0]).toEqual({
      command: "discover_resources",
      payload: { contextId: "kind-kubix-dev" },
    });
    expect(getIpcTransport()).toBe(transport);
  });

  it("never sends undefined for a no-arg command", async () => {
    const { transport, calls } = recordingTransport();
    setIpcTransport(transport);
    await ipc.listContexts();
    expect(calls[0]?.command).toBe("list_contexts");
    expect(calls[0]?.payload).not.toBeUndefined();
  });
});
