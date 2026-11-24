import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

import { App } from "@/App";
import { getClusterProfileMeta } from "@/components/ide/icon-rail";
import { setIpcTransport, tauriTransport, type IpcTransport } from "@/lib/ipc/client";
import type { ClusterContextDto, DiscoveredResourceDto } from "@/lib/ipc/types";
import { useClusterProfileStore } from "@/stores/cluster-profile-store";
import { useClusterStore } from "@/stores/cluster-store";
import { useExplorerStore } from "@/stores/explorer-store";
import { useSettingsStore } from "@/stores/settings-store";

vi.mock("@monaco-editor/react", () => ({
  default: ({ value }: { value?: string }) => (
    <div data-testid="mock-editor" data-value={value ?? ""} />
  ),
  DiffEditor: ({ original, modified }: { original?: string; modified?: string }) => (
    <div
      data-testid="mock-diff-editor"
      data-original={original ?? ""}
      data-modified={modified ?? ""}
    />
  ),
}));

const ctx = (id: string, over: Partial<ClusterContextDto> = {}): ClusterContextDto => ({
  id,
  name: id,
  clusterName: `cluster-${id}`,
  server: `${id}.example:6443`,
  namespaceDefault: "default",
  authKind: "exec",
  authHint: "aws",
  isCurrent: false,
  state: "disconnected",
  issues: [],
  ...over,
});

const pods: DiscoveredResourceDto = {
  gvr: "/v1/pods",
  kind: "Pod",
  group: "",
  version: "v1",
  plural: "pods",
  namespaced: true,
  shortNames: ["po"],
  verbs: ["get", "list", "watch"],
  curated: true,
};

function fakeTransport(overrides: Partial<IpcTransport> = {}): IpcTransport {
  return {
    invoke: (async (command: string) => {
      switch (command) {
        case "list_contexts":
        case "rescan_kubeconfig":
          return [ctx("kind-dev"), ctx("eks-prod", { authKind: "exec", authHint: "aws" })];
        case "discover_resources":
          return [pods];
        case "list_resources":
          return [];
        default:
          return null;
      }
    }) as IpcTransport["invoke"],
    listen: (async () => () => {}) as IpcTransport["listen"],
    ...overrides,
  };
}

function renderApp() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return render(<App />, { wrapper });
}

beforeEach(() => {
  useClusterStore.getState().reset();
  useExplorerStore.getState().reset();
  useClusterProfileStore.getState().reset();
  useSettingsStore.getState().reset();
});

afterEach(() => {
  setIpcTransport(tauriTransport);
  vi.restoreAllMocks();
});

describe("ClusterPicker", () => {
  it("lists contexts from the backend", async () => {
    setIpcTransport(fakeTransport());
    renderApp();
    await waitFor(() => expect(screen.getByTestId("cluster-count")).toHaveTextContent("2 of 2"));
    expect(screen.getAllByTestId("cluster-card")).toHaveLength(2);
    expect(screen.getAllByText("kind-dev").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("eks-prod").length).toBeGreaterThanOrEqual(1);
  });

  it("filters contexts on the client", async () => {
    setIpcTransport(fakeTransport());
    renderApp();
    await waitFor(() => expect(screen.getAllByTestId("cluster-card")).toHaveLength(2));
    await userEvent.type(screen.getByLabelText("Filter contexts"), "eks");
    expect(screen.getAllByTestId("cluster-card")).toHaveLength(1);
    expect(screen.getByTestId("cluster-count")).toHaveTextContent("1 of 2");
  });

  it("shows a readable error when the kubeconfig cannot be read", async () => {
    setIpcTransport(
      fakeTransport({
        invoke: (async () => {
          throw {
            code: "kubeconfigNotFound",
            message: "no readable kubeconfig found",
            retryable: false,
          };
        }) as IpcTransport["invoke"],
      }),
    );
    renderApp();
    await waitFor(() => expect(screen.getByTestId("clusters-error")).toBeInTheDocument());
    expect(screen.getByTestId("clusters-error")).toHaveTextContent("no readable kubeconfig found");
    expect(screen.getByTestId("clusters-error")).toHaveTextContent("$KUBECONFIG");
  });

  it("connects a context and directly opens the explorer from the card in one click", async () => {
    let connectCalls = 0;
    const base = fakeTransport();
    setIpcTransport({
      ...base,
      invoke: (async (command: string, args: unknown) => {
        if (command === "connect_context") {
          connectCalls += 1;
          const id = (args as { contextId: string }).contextId;
          return ctx(id, { state: "ready" });
        }
        if (command === "discover_resources") return [pods];
        if (command === "list_resources") return [];
        return (base.invoke as (c: string, a: unknown) => Promise<unknown>)(command, args);
      }) as IpcTransport["invoke"],
    });

    renderApp();
    await waitFor(() => expect(screen.getAllByTestId("cluster-card")).toHaveLength(2));

    const cards = screen.getAllByTestId("cluster-card");
    const firstCard = cards[0] as HTMLElement;
    await userEvent.click(firstCard.querySelector('[data-testid="connect-cluster"]') as HTMLElement);
    expect(connectCalls).toBe(1);

    await waitFor(() => expect(screen.getByTestId("explorer-placeholder")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "WorkLoad" }));
    expect(screen.getAllByTestId("resource-type").some((el) => el.dataset.gvr === "/v1/pods")).toBe(
      true,
    );
  });
});

describe("event bridge", () => {
  it("applies a resource delta pushed by the backend", async () => {
    let deltaHandler: ((payload: unknown) => void) | undefined;
    const base = fakeTransport();
    setIpcTransport({
      ...base,
      invoke: (async (command: string, args: unknown) => {
        if (command === "connect_context") {
          return ctx((args as { contextId: string }).contextId, { state: "ready" });
        }
        if (command === "discover_resources") return [pods];
        if (command === "list_resources") {
          const namespace = (args as { namespace: string }).namespace;
          return [
            {
              uid: "u1",
              name: "api-0",
              namespace: namespace || "dev",
              kind: "Pod",
              createdAt: "2026-01-01T00:00:00Z",
              labels: {},
            },
          ];
        }
        return (base.invoke as (c: string, a: unknown) => Promise<unknown>)(command, args);
      }) as IpcTransport["invoke"],
      listen: (async (event: string, handler: (payload: unknown) => void) => {
        if (event === "kubix://resource-delta") deltaHandler = handler;
        return () => {};
      }) as IpcTransport["listen"],
    });

    renderApp();
    await waitFor(() => expect(screen.getAllByTestId("cluster-card")).toHaveLength(2));
    const card = screen.getAllByTestId("cluster-card")[0] as HTMLElement;
    await userEvent.click(card.querySelector('[data-testid="connect-cluster"]') as HTMLElement);

    await waitFor(() => expect(screen.getByTestId("explorer-placeholder")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "WorkLoad" }));
    await waitFor(() => expect(screen.getAllByTestId("resource-type")).not.toHaveLength(0));
    const podButton = screen
      .getAllByTestId("resource-type")
      .find((el) => el.dataset.gvr === "/v1/pods") as HTMLElement;
    await userEvent.click(podButton);

    await waitFor(() => expect(screen.getByTestId("row-count")).toHaveTextContent("1 item"));

    await waitFor(() => expect(deltaHandler).toBeTypeOf("function"));
    act(() => deltaHandler?.({
      contextId: "kind-dev",
      gvr: "/v1/pods",
      namespace: "default",
      batchId: 2,
      upserts: [
        {
          uid: "u2",
          name: "worker-0",
          namespace: "default",
          kind: "Pod",
          createdAt: "2026-01-01T00:00:00Z",
          labels: {},
        },
      ],
      deletions: [{ uid: "u1" }],
      truncated: false,
      isSnapshot: false,
    }));

    await waitFor(() => expect(screen.getByTestId("row-count")).toHaveTextContent("1 item"));
    expect(screen.getByTestId("resource-table")).toHaveTextContent("worker-0");
    expect(screen.getByTestId("resource-table")).not.toHaveTextContent("api-0");
  });
});

describe("workspace navigation", () => {
  it("starts on Home without connecting the kubectl current context", async () => {
    const calls: string[] = [];
    const base = fakeTransport();
    setIpcTransport({
      ...base,
      invoke: (async (command: string, args: unknown) => {
        calls.push(command);
        if (command === "list_contexts") return [ctx("kind-dev", { isCurrent: true })];
        return (base.invoke as (c: string, a: unknown) => Promise<unknown>)(command, args);
      }) as IpcTransport["invoke"],
    });
    renderApp();
    await waitFor(() => expect(screen.getByText("Your clusters")).toBeInTheDocument());
    expect(screen.getByTestId("cluster-card")).toBeInTheDocument();
    expect(useClusterStore.getState().selectedId).toBeNull();
    expect(calls).toEqual(["list_contexts"]);
  });

  it("clicking a disconnected rail profile directly connects and opens the cluster without a dialog", async () => {
    const calls: string[] = [];
    const base = fakeTransport();
    setIpcTransport({
      ...base,
      invoke: (async (command: string, args: unknown) => {
        calls.push(command);
        if (command === "connect_context") {
          const id = (args as { contextId: string }).contextId;
          return ctx(id, { state: "ready" });
        }
        return (base.invoke as (c: string, a: unknown) => Promise<unknown>)(command, args);
      }) as IpcTransport["invoke"],
    });
    useClusterProfileStore.getState().pin("kind-dev");
    useClusterProfileStore.getState().pin("eks-prod");
    renderApp();
    await waitFor(() => expect(screen.getAllByTestId("cluster-rail-item")).toHaveLength(2));
    await userEvent.click(screen.getAllByTestId("cluster-rail-item")[0]!);
    expect(screen.queryByRole("dialog", { name: /Connect to kind-dev/ })).not.toBeInTheDocument();
    expect(useClusterStore.getState().selectedId).toBe("kind-dev");
    await waitFor(() => expect(screen.getByTestId("explorer-placeholder")).toBeInTheDocument());
    expect(calls).toContain("connect_context");
  });

  it("shows an inline rejected connection error and retry button in the cluster workspace", async () => {
    const base = fakeTransport();
    setIpcTransport({ ...base, invoke: (async (command: string, args: unknown) => {
      if (command === "connect_context") throw { code: "authFailed", message: "token expired", retryable: false };
      return (base.invoke as (c: string, a: unknown) => Promise<unknown>)(command, args);
    }) as IpcTransport["invoke"] });
    renderApp();
    await waitFor(() => expect(screen.getAllByTestId("cluster-card")).toHaveLength(2));
    const first = screen.getAllByTestId("cluster-card")[0]!;
    await userEvent.click(first.querySelector('[data-testid="connect-cluster"]') as HTMLElement);
    await waitFor(() => expect(screen.getByTestId("cluster-error")).toHaveTextContent("token expired"));
    expect(screen.getByTestId("status-badge")).toHaveAttribute("data-state", "authFailed");
    expect(useClusterStore.getState().selectedId).toBe("kind-dev");
  });

  it("clicking a second disconnected rail profile directly switches and connects it while disconnecting the previous cluster", async () => {
    const base = fakeTransport();
    setIpcTransport({
      ...base,
      invoke: (async (command: string, args: unknown) => {
        if (command === "connect_context") {
          const id = (args as { contextId: string }).contextId;
          return ctx(id, { state: "ready" });
        }
        return (base.invoke as (c: string, a: unknown) => Promise<unknown>)(command, args);
      }) as IpcTransport["invoke"],
    });
    useClusterProfileStore.getState().pin("kind-dev");
    useClusterProfileStore.getState().pin("eks-prod");
    renderApp();
    await waitFor(() => expect(screen.getAllByTestId("cluster-rail-item")).toHaveLength(2));
    act(() => { useClusterStore.getState().upsert(ctx("kind-dev", { state: "ready" })); });
    await userEvent.click(screen.getByTestId("open-cluster"));
    expect(screen.getByTestId("explorer-placeholder")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /eks-prod, Disconnected/ }));
    expect(screen.queryByRole("dialog", { name: /Connect to eks-prod/ })).not.toBeInTheDocument();
    await waitFor(() => expect(useClusterStore.getState().selectedId).toBe("eks-prod"));
    await waitFor(() => expect(useClusterStore.getState().byId["eks-prod"]?.state).toBe("ready"));
    expect(useClusterStore.getState().byId["kind-dev"]?.state).toBe("disconnected");
  });

  it("waits for connect_context to finish before calling discover_resources when clicking a disconnected pinned cluster", async () => {
    let connected = false;
    let prematureDiscoverCalls = 0;
    let resolveConnect!: (value: ClusterContextDto) => void;
    const base = fakeTransport();
    setIpcTransport({
      ...base,
      invoke: (async (command: string, args: unknown) => {
        if (command === "connect_context") {
          return await new Promise<ClusterContextDto>((resolve) => {
            resolveConnect = (dto) => {
              connected = true;
              resolve(dto);
            };
          });
        }
        if (command === "discover_resources") {
          if (!connected) {
            prematureDiscoverCalls += 1;
            throw {
              code: "authRequired",
              message: "authentication requires interaction: context is not connected",
              retryable: false,
            };
          }
          return [pods];
        }
        return (base.invoke as (c: string, a: unknown) => Promise<unknown>)(command, args);
      }) as IpcTransport["invoke"],
    });

    useClusterProfileStore.getState().pin("eks-prod");
    renderApp();
    await waitFor(() => expect(screen.getAllByTestId("cluster-rail-item")).toHaveLength(1));

    // Click disconnected pinned eks-prod in the rail
    await userEvent.click(screen.getByRole("button", { name: /eks-prod, Disconnected/ }));

    // While connecting, discover_resources must NOT fire prematurely or show an error
    await waitFor(() => expect(useClusterStore.getState().byId["eks-prod"]?.state).toBe("connecting"));
    expect(prematureDiscoverCalls).toBe(0);
    expect(screen.queryByText(/context is not connected/i)).not.toBeInTheDocument();

    // Now finish connect_context -> discovery runs cleanly and populates WorkLoad APIs
    act(() => {
      resolveConnect(ctx("eks-prod", { state: "ready" }));
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "WorkLoad" })).toBeInTheDocument());
    expect(screen.queryByText(/context is not connected/i)).not.toBeInTheDocument();
  });

  it("extracts distinct initials from EKS ARN and vcluster context names", () => {
    expect(
      getClusterProfileMeta(
        "arn:aws:eks:ap-southeast-3:255045239074:cluster/ta-cluster-ebpf-prod",
      ),
    ).toMatchObject({
      initials: "TCE",
      shortName: "ta-cluster-ebpf-prod",
    });
    expect(
      getClusterProfileMeta("arn:aws:eks:ap-southeast-3:255045239074:cluster/ta-cluster-prod"),
    ).toMatchObject({
      initials: "TCP",
      shortName: "ta-cluster-prod",
    });
    expect(
      getClusterProfileMeta(
        "vcluster_ta-staging_vcluster_arn:aws:eks:ap-southeast-3:255045239074:cluster/ta-cluster-prod",
      ),
    ).toMatchObject({
      initials: "VTS",
    });
  });

  it("switches connected contexts without connecting a disconnected one", async () => {
    setIpcTransport(fakeTransport());
    useClusterProfileStore.getState().pin("kind-dev");
    useClusterProfileStore.getState().pin("eks-prod");
    renderApp();
    await waitFor(() => expect(screen.getAllByTestId("cluster-rail-item")).toHaveLength(2));
    expect(screen.queryByTestId("cluster-sidebar")).not.toBeInTheDocument();
    act(() => {
      useClusterStore.getState().upsert(ctx("kind-dev", { state: "ready" }));
      useClusterStore.getState().upsert(ctx("eks-prod", { state: "ready" }));
    });
    await userEvent.click(screen.getByRole("button", { name: /kind-dev, Connected/ }));
    expect(useClusterStore.getState().selectedId).toBe("kind-dev");
    expect(screen.getByTestId("cluster-sidebar")).toBeInTheDocument();
    expect(screen.getByTestId("active-cluster-title")).toHaveTextContent("kind-dev");

    await userEvent.click(screen.getByRole("button", { name: /eks-prod, Connected/ }));
    expect(useClusterStore.getState().selectedId).toBe("eks-prod");
    expect(screen.getByTestId("active-cluster-title")).toHaveTextContent("eks-prod");
    // Previous cluster is automatically disconnected so only one cluster stays active.
    await waitFor(() =>
      expect(useClusterStore.getState().byId["kind-dev"]?.state).toBe("disconnected"),
    );

    await userEvent.click(screen.getByRole("button", { name: "Home" }));
    expect(screen.getByText("Your clusters")).toBeInTheDocument();
    expect(screen.queryByTestId("cluster-sidebar")).not.toBeInTheDocument();
  });

  it("auto-disconnects the previous cluster when connecting a second cluster profile", async () => {
    const disconnectCalls: string[] = [];
    const base = fakeTransport();
    setIpcTransport({
      ...base,
      invoke: (async (command: string, args: unknown) => {
        if (command === "connect_context") {
          const id = (args as { contextId: string }).contextId;
          return ctx(id, { state: "ready" });
        }
        if (command === "disconnect_context") {
          const id = (args as { contextId: string }).contextId;
          disconnectCalls.push(id);
          return ctx(id, { state: "disconnected" });
        }
        if (command === "discover_resources") return [pods];
        return (base.invoke as (c: string, a: unknown) => Promise<unknown>)(command, args);
      }) as IpcTransport["invoke"],
    });

    useClusterProfileStore.getState().pin("kind-dev");
    useClusterProfileStore.getState().pin("eks-prod");
    renderApp();
    await waitFor(() => expect(screen.getAllByTestId("cluster-card")).toHaveLength(2));

    const cards = screen.getAllByTestId("cluster-card");
    await userEvent.click(cards[0]!.querySelector('[data-testid="connect-cluster"]') as HTMLElement);
    await waitFor(() =>
      expect(useClusterStore.getState().byId["kind-dev"]?.state).toBe("ready"),
    );

    // Click second cluster profile in the hotbar -> first cluster must auto-disconnect
    await userEvent.click(screen.getAllByTestId("cluster-rail-item")[1]!);
    await waitFor(() =>
      expect(useClusterStore.getState().byId["eks-prod"]?.state).toBe("ready"),
    );
    expect(useClusterStore.getState().byId["kind-dev"]?.state).toBe("disconnected");
    expect(disconnectCalls).toContain("kind-dev");
  });

  it("switches themes locally without touching Kubernetes", async () => {
    const calls: string[] = [];
    const base = fakeTransport();
    setIpcTransport({ ...base, invoke: (async (command: string, args: unknown) => {
      calls.push(command);
      return (base.invoke as (c: string, a: unknown) => Promise<unknown>)(command, args);
    }) as IpcTransport["invoke"] });
    renderApp();
    await waitFor(() => expect(screen.getAllByTestId("cluster-card")).toHaveLength(2));
    const before = document.documentElement.classList.contains("dark");
    await userEvent.click(screen.getByRole("button", { name: `Switch to ${before ? "light" : "dark"} theme` }));
    expect(document.documentElement.classList.contains("dark")).toBe(!before);
    expect(localStorage.getItem("kubix-theme")).toBe(before ? "light" : "dark");
    expect(calls).toEqual(["list_contexts"]);
    document.documentElement.classList.toggle("dark", before);
    localStorage.removeItem("kubix-theme");
  });

  it("filters only loaded rows and opens a keyboard-resizable inspector", async () => {
    const base = fakeTransport();
    setIpcTransport({ ...base, invoke: (async (command: string, args: unknown) => {
      if (command === "list_resources") return [
        { uid: "a", name: "api", namespace: "default", kind: "Pod", createdAt: "", labels: {} },
        { uid: "b", name: "worker", namespace: "default", kind: "Pod", createdAt: "", labels: {} },
      ];
      if (command === "get_resource") return { contextId: "kind-dev", gvr: "/v1/pods", name: "worker", namespace: "default", yaml: "kind: Pod", maskedPaths: [] };
      return (base.invoke as (c: string, a: unknown) => Promise<unknown>)(command, args);
    }) as IpcTransport["invoke"] });
    renderApp();
    await waitFor(() => expect(screen.getAllByTestId("cluster-card")).toHaveLength(2));
    act(() => { useClusterStore.getState().upsert(ctx("kind-dev", { state: "ready" })); });
    await userEvent.click(screen.getByTestId("open-cluster"));
    await waitFor(() => expect(screen.getByTestId("explorer-placeholder")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "WorkLoad" }));
    await waitFor(() => expect(screen.getAllByTestId("resource-type")).not.toHaveLength(0));
    await userEvent.click(screen.getAllByTestId("resource-type")[0]!);
    await waitFor(() => expect(screen.getAllByTestId("resource-row")).toHaveLength(2));
    await userEvent.type(screen.getByLabelText("Filter loaded rows"), "worker");
    expect(screen.getAllByTestId("resource-row")).toHaveLength(1);
    fireEvent.keyDown(screen.getByTestId("resource-row"), { key: "Enter" });
    const separator = screen.getByRole("separator", { name: "Resize resource inspector" });
    expect(separator).toHaveAttribute("aria-valuenow", "42");
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 900, right: 1200 } as DOMRect);
    fireEvent.keyDown(separator, { key: "ArrowLeft" });
    expect(separator).toHaveAttribute("aria-valuenow", "45");
    await userEvent.click(screen.getByRole("button", { name: "Close detail" }));
    expect(screen.queryByTestId("resource-detail")).not.toBeInTheDocument();
  });
});

describe("namespace scope", () => {
  it("stops the previous watch when the namespace changes", async () => {
    const stopCalls: Array<{ contextId: string; gvr: string; namespace: string }> = [];
    const listCalls: Array<{ contextId: string; gvr: string; namespace: string }> = [];
    const base = fakeTransport();
    setIpcTransport({
      ...base,
      invoke: (async (command: string, args: unknown) => {
        if (command === "connect_context") {
          return ctx((args as { contextId: string }).contextId, { state: "ready" });
        }
        if (command === "discover_resources") return [pods];
        if (command === "list_resources") {
          listCalls.push(args as { contextId: string; gvr: string; namespace: string });
          return [];
        }
        if (command === "stop_watch") {
          stopCalls.push(args as { contextId: string; gvr: string; namespace: string });
          return null;
        }
        return (base.invoke as (c: string, a: unknown) => Promise<unknown>)(command, args);
      }) as IpcTransport["invoke"],
    });

    renderApp();
    await waitFor(() => expect(screen.getAllByTestId("cluster-card")).toHaveLength(2));
    const card = screen.getAllByTestId("cluster-card")[0] as HTMLElement;
    await userEvent.click(card.querySelector('[data-testid="connect-cluster"]') as HTMLElement);

    await waitFor(() => expect(screen.getByRole("button", { name: "WorkLoad" })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "WorkLoad" }));

    const podButton = await waitFor(() => {
      const found = screen
        .getAllByTestId("resource-type")
        .find((el) => el.dataset.gvr === "/v1/pods");
      expect(found).toBeDefined();
      return found as HTMLElement;
    });
    await userEvent.click(podButton);

    // The filter is seeded from namespaceDefault, so no typing is needed.
    await waitFor(() =>
      expect(screen.getByTestId("namespace-filter")).toHaveAttribute("data-value", "default"),
    );
    expect(listCalls).toContainEqual(expect.objectContaining({ namespace: "default" }));
    expect(listCalls).not.toContainEqual(expect.objectContaining({ namespace: "" }));

    await userEvent.click(screen.getByTestId("namespace-filter"));
    await userEvent.click(screen.getByTestId("namespace-all-toggle"));

    await waitFor(() =>
      expect(stopCalls).toContainEqual(
        expect.objectContaining({ contextId: "kind-dev", gvr: "/v1/pods", namespace: "default" }),
      ),
    );
  });
});
