import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const xtermHarness = vi.hoisted(() => ({
  onDataHandler: null as ((data: string) => void) | null,
  onResizeHandler: null as ((size: { cols: number; rows: number }) => void) | null,
  writes: [] as string[],
  resets: 0,
  focuses: 0,
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class MockTerminal {
    cols = 100;
    rows = 22;
    options: Record<string, unknown> = {};
    loadAddon() {}
    open() {}
    dispose() {}
    reset() {
      xtermHarness.resets += 1;
    }
    write(data: string) {
      xtermHarness.writes.push(data);
    }
    focus() {
      xtermHarness.focuses += 1;
    }
    onData(cb: (data: string) => void) {
      xtermHarness.onDataHandler = cb;
      return { dispose: () => {} };
    }
    onResize(cb: (size: { cols: number; rows: number }) => void) {
      xtermHarness.onResizeHandler = cb;
      return { dispose: () => {} };
    }
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class MockFitAddon {
    fit() {}
  },
}));

import { TerminalDock } from "@/components/ide/terminal-dock";
import { setIpcTransport, tauriTransport, type IpcTransport } from "@/lib/ipc/client";
import { useTerminalStore } from "@/stores/terminal-store";

describe("TerminalDock xterm wiring", () => {
  beforeEach(() => {
    xtermHarness.onDataHandler = null;
    xtermHarness.onResizeHandler = null;
    xtermHarness.writes = [];
    xtermHarness.resets = 0;
    xtermHarness.focuses = 0;
    useTerminalStore.getState().reset();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setIpcTransport(tauriTransport);
    useTerminalStore.getState().reset();
  });

  it("forwards keyboard input and resizes after async sessionId connection", async () => {
    let resolveStart: ((session: unknown) => void) | null = null;
    const inputs: Array<{ sessionId: string; data: string }> = [];
    const resizes: Array<{ sessionId: string; cols: number; rows: number }> = [];

    setIpcTransport({
      invoke: (async (command: string, args: unknown) => {
        if (command === "start_shell") {
          return await new Promise((resolve) => {
            resolveStart = (session) => resolve(session as never);
          });
        }
        if (command === "send_shell_input") {
          inputs.push(args as { sessionId: string; data: string });
          return null;
        }
        if (command === "resize_shell") {
          resizes.push(args as { sessionId: string; cols: number; rows: number });
          return null;
        }
        return null;
      }) as IpcTransport["invoke"],
      listen: (async () => () => {}) as IpcTransport["listen"],
    });

    const openPromise = useTerminalStore.getState().openShell({
      contextId: "kind-dev",
      namespace: "kubix-demo",
      podName: "web-0",
      container: "nginx",
    });

    render(<TerminalDock contextId="kind-dev" theme="dark" />);
    expect(screen.getByText(/Connecting to kubix-demo\/web-0/)).toBeInTheDocument();

    resolveStart!({
      sessionId: "shell-42",
      contextId: "kind-dev",
      namespace: "kubix-demo",
      podName: "web-0",
      container: "nginx",
    });
    await openPromise;

    useTerminalStore.getState().pushOutput({
      sessionId: "shell-42",
      stream: "stdout",
      data: "/ # ",
      closed: false,
    });

    await waitFor(() => expect(xtermHarness.writes).toContain("/ # "));

    xtermHarness.onDataHandler?.("ls -la\r");
    xtermHarness.onResizeHandler?.({ cols: 120, rows: 30 });

    await waitFor(() => {
      expect(inputs).toContainEqual({ sessionId: "shell-42", data: "ls -la\r" });
      expect(resizes).toContainEqual({ sessionId: "shell-42", cols: 120, rows: 30 });
    });
  });

  it("focuses and un-minimizes an existing active shell instead of spawning a duplicate, and allows reopening after close", async () => {
    let seq = 0;
    const startCalls: Array<Record<string, unknown>> = [];

    setIpcTransport({
      invoke: (async (command: string, args: unknown) => {
        if (command === "start_shell") {
          seq += 1;
          const payload = args as Record<string, unknown>;
          startCalls.push(payload);
          return {
            sessionId: `shell-${seq}`,
            contextId: payload.contextId,
            namespace: payload.namespace,
            podName: payload.podName,
            container: payload.container ?? "nginx",
          };
        }
        return null;
      }) as IpcTransport["invoke"],
      listen: (async () => () => {}) as IpcTransport["listen"],
    });

    await useTerminalStore.getState().openShell({
      contextId: "kind-dev",
      namespace: "kubix-demo",
      podName: "web-0",
      container: "nginx",
    });
    const firstTabId = useTerminalStore.getState().activeTabId;
    expect(startCalls).toHaveLength(1);
    expect(useTerminalStore.getState().tabs).toHaveLength(1);

    // Different container on the same pod opens its own tab
    await useTerminalStore.getState().openShell({
      contextId: "kind-dev",
      namespace: "kubix-demo",
      podName: "web-0",
      container: "sidecar",
    });
    expect(startCalls).toHaveLength(2);
    expect(useTerminalStore.getState().tabs).toHaveLength(2);
    expect(useTerminalStore.getState().activeTabId).not.toBe(firstTabId);

    // Minimize dock, then click Shell on nginx again -> reuses existing tab & expands dock
    useTerminalStore.getState().setMinimized(true);
    await useTerminalStore.getState().openShell({
      contextId: "kind-dev",
      namespace: "kubix-demo",
      podName: "web-0",
      container: "nginx",
    });
    expect(startCalls).toHaveLength(2);
    expect(useTerminalStore.getState().tabs).toHaveLength(2);
    expect(useTerminalStore.getState().activeTabId).toBe(firstTabId);
    expect(useTerminalStore.getState().minimized).toBe(false);

    // Once nginx session closes, clicking Shell again opens a fresh session
    useTerminalStore.getState().pushOutput({
      sessionId: "shell-1",
      stream: "stdout",
      data: "exit\r\n",
      closed: true,
    });
    await useTerminalStore.getState().openShell({
      contextId: "kind-dev",
      namespace: "kubix-demo",
      podName: "web-0",
      container: "nginx",
    });
    expect(startCalls).toHaveLength(3);
    expect(useTerminalStore.getState().tabs).toHaveLength(3);
  });
});
