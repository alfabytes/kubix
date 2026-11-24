import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "@/App";
import { ResourceDetail } from "@/components/explorer/resource-detail";
import {
  MetricsCard,
  NavigationSidebar,
  PageHeader,
  SectionCard,
  TopologyCanvas,
  WorkspaceTabs,
} from "@/components/ide";
import { setIpcTransport, tauriTransport, type IpcTransport } from "@/lib/ipc/client";
import type { ClusterContextDto, DiscoveredResourceDto } from "@/lib/ipc/types";
import { categorizeResources } from "@/lib/resource-telemetry";
import { stripYamlNoise } from "@/lib/yaml-utils";
import { useClusterProfileStore } from "@/stores/cluster-profile-store";
import { useClusterStore } from "@/stores/cluster-store";
import { useExplorerStore } from "@/stores/explorer-store";
import { usePortForwardStore } from "@/stores/port-forward-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useTerminalStore } from "@/stores/terminal-store";

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
  state: "ready",
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

const deployments: DiscoveredResourceDto = {
  gvr: "apps/v1/deployments",
  kind: "Deployment",
  group: "apps",
  version: "v1",
  plural: "deployments",
  namespaced: true,
  shortNames: ["deploy"],
  verbs: ["get", "list", "watch"],
  curated: true,
};

const services: DiscoveredResourceDto = {
  gvr: "/v1/services",
  kind: "Service",
  group: "",
  version: "v1",
  plural: "services",
  namespaced: true,
  shortNames: ["svc"],
  verbs: ["get", "list", "watch"],
  curated: true,
};

const secrets: DiscoveredResourceDto = {
  gvr: "/v1/secrets",
  kind: "Secret",
  group: "",
  version: "v1",
  plural: "secrets",
  namespaced: true,
  shortNames: [],
  verbs: ["get", "list", "watch"],
  curated: true,
};

const roles: DiscoveredResourceDto = {
  gvr: "rbac.authorization.k8s.io/v1/roles",
  kind: "Role",
  group: "rbac.authorization.k8s.io",
  version: "v1",
  plural: "roles",
  namespaced: true,
  shortNames: [],
  verbs: ["get", "list", "watch"],
  curated: false,
};

function renderWithQuery(node: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

beforeEach(() => {
  useClusterStore.getState().reset();
  useClusterProfileStore.getState().reset();
  useExplorerStore.getState().reset();
  useSettingsStore.getState().reset();
  useTerminalStore.getState().reset();
  usePortForwardStore.getState().reset();
});

afterEach(() => {
  setIpcTransport(tauriTransport);
  vi.restoreAllMocks();
});

describe("IDE design system components", () => {
  it("renders SectionCard, MetricsCard, PageHeader, and WorkspaceTabs", async () => {
    const onSelectTab = vi.fn();
    const onCloseTab = vi.fn();
    render(
      <div>
        <WorkspaceTabs
          tabs={[
            { id: "t1", kind: "overview", title: "Cluster Overview", closable: false },
            { id: "t2", kind: "resource-list", title: "Deployments", subtitle: "v1", closable: true },
          ]}
          activeTabId="t2"
          onSelectTab={onSelectTab}
          onCloseTab={onCloseTab}
        />
        <PageHeader
          title="Deployments"
          breadcrumbs={["kind-dev", "apps", "deployments"]}
          scopeLabel="default"
        />
        <MetricsCard label="CPU Usage" value="14m" sublabel="20% of limit" progressPct={20} />
        <SectionCard title="Metadata" subtitle="apps/v1">
          <span>metadata body</span>
        </SectionCard>
      </div>,
    );

    expect(screen.getByTestId("workspace-tabs")).toBeInTheDocument();
    expect(screen.getAllByTestId("workspace-tab")).toHaveLength(2);
    expect(screen.getByText("CPU Usage")).toBeInTheDocument();
    expect(screen.getByText("14m")).toBeInTheDocument();
    expect(screen.getByText("metadata body")).toBeInTheDocument();

    await userEvent.click(screen.getByLabelText("Close tab Deployments"));
    expect(onCloseTab).toHaveBeenCalledWith("t2");
  });

  it("WorkspaceTabs supports middle-click close and right-click context menu with disabled bounds", async () => {
    const onSelectTab = vi.fn();
    const onCloseTab = vi.fn();
    const onCloseOtherTabs = vi.fn();
    const onCloseTabsToRight = vi.fn();

    const { rerender } = render(
      <WorkspaceTabs
        tabs={[
          { id: "t1", kind: "overview", title: "Cluster Overview" },
          { id: "t2", kind: "resource-list", title: "Pods" },
          { id: "t3", kind: "events", title: "Events" },
        ]}
        activeTabId="t2"
        onSelectTab={onSelectTab}
        onCloseTab={onCloseTab}
        onCloseOtherTabs={onCloseOtherTabs}
        onCloseTabsToRight={onCloseTabsToRight}
      />,
    );

    const tabs = screen.getAllByTestId("workspace-tab");
    expect(screen.getByLabelText("Close tab Cluster Overview")).toBeInTheDocument();

    // Middle-click closes tab
    fireEvent(tabs[1]!, new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }));
    expect(onCloseTab).toHaveBeenCalledWith("t2");

    // Right-click middle tab opens context menu and triggers Close Others / Close to the Right
    fireEvent.contextMenu(tabs[1]!);
    const menu = screen.getByTestId("tab-context-menu");
    expect(menu).toHaveAttribute("role", "menu");
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Close Others" }));
    expect(onCloseOtherTabs).toHaveBeenCalledWith("t2");
    expect(screen.queryByTestId("tab-context-menu")).not.toBeInTheDocument();

    fireEvent.contextMenu(tabs[1]!);
    await userEvent.click(
      within(screen.getByTestId("tab-context-menu")).getByRole("menuitem", {
        name: "Close to the Right",
      }),
    );
    expect(onCloseTabsToRight).toHaveBeenCalledWith("t2");
    expect(screen.queryByTestId("tab-context-menu")).not.toBeInTheDocument();

    // Right-click rightmost tab disables "Close to the Right", and Escape dismisses menu
    fireEvent.contextMenu(tabs[2]!);
    const rightMenu = screen.getByTestId("tab-context-menu");
    expect(within(rightMenu).getByRole("menuitem", { name: "Close to the Right" })).toBeDisabled();
    expect(within(rightMenu).getByRole("menuitem", { name: "Close Others" })).not.toBeDisabled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("tab-context-menu")).not.toBeInTheDocument();

    // Lone tab disables Close / Close Others / Close to the Right and ignores middle-click
    onCloseTab.mockClear();
    rerender(
      <WorkspaceTabs
        tabs={[{ id: "t1", kind: "overview", title: "Cluster Overview" }]}
        activeTabId="t1"
        onSelectTab={onSelectTab}
        onCloseTab={onCloseTab}
        onCloseOtherTabs={onCloseOtherTabs}
        onCloseTabsToRight={onCloseTabsToRight}
      />,
    );
    const loneTab = screen.getByTestId("workspace-tab");
    fireEvent(loneTab, new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }));
    expect(onCloseTab).not.toHaveBeenCalled();

    fireEvent.contextMenu(loneTab);
    const loneMenu = screen.getByTestId("tab-context-menu");
    expect(within(loneMenu).getByRole("menuitem", { name: "Close" })).toBeDisabled();
    expect(within(loneMenu).getByRole("menuitem", { name: "Close Others" })).toBeDisabled();
    expect(within(loneMenu).getByRole("menuitem", { name: "Close to the Right" })).toBeDisabled();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId("tab-context-menu")).not.toBeInTheDocument();
  });

  it("truncates long MetricsCard values safely with tooltip and overflow clipping", () => {
    const { container } = render(
      <MetricsCard
        label="Resource Type"
        value="PersistentVolumeClaim"
        sublabel="v1"
        tone="primary"
      />,
    );

    const card = container.firstElementChild as HTMLElement;
    expect(card.className).toContain("min-w-0");
    expect(card.className).toContain("overflow-hidden");

    const valueEl = screen.getByText("PersistentVolumeClaim");
    expect(valueEl.className).toContain("truncate");
    expect(valueEl.className).toContain("text-[13px]");
    expect(valueEl).toHaveAttribute("title", "PersistentVolumeClaim");
  });

  it("renders TopologyCanvas with zoom controls and node selection", async () => {
    const { container } = render(<TopologyCanvas contextName="kind-dev" />);
    expect(screen.getByTestId("topology-canvas")).toBeInTheDocument();
    expect(screen.getByText("90%")).toBeInTheDocument();
    expect(container.querySelector("animateMotion")).toBeNull();
    expect(screen.queryByText(/Tidied the board/i)).not.toBeInTheDocument();

    await userEvent.click(screen.getByLabelText("Zoom in"));
    expect(screen.getByText("100%")).toBeInTheDocument();

    await userEvent.click(screen.getByLabelText("Zoom out"));
    expect(screen.getByText("90%")).toBeInTheDocument();
  });

  it("pans TopologyCanvas cleanly without transition lag and never stays stuck after release", () => {
    render(<TopologyCanvas contextName="kind-dev" />);
    const viewport = screen.getByTestId("topology-viewport");
    const layer = screen.getByTestId("topology-transform-layer");

    const mousePointer = (
      type: string,
      init: MouseEventInit,
    ): MouseEvent => {
      const ev = new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
      Object.defineProperty(ev, "pointerType", { value: "mouse" });
      return ev;
    };

    // Start dragging the canvas
    fireEvent(viewport, mousePointer("pointerdown", { button: 0, buttons: 1, clientX: 100, clientY: 100 }));
    expect(layer.className).not.toContain("transition-transform");

    fireEvent(window, mousePointer("pointermove", { buttons: 1, clientX: 160, clientY: 140 }));
    expect(layer.style.transform).toContain("translate3d(60px, 40px, 0)");
    expect(viewport.style.backgroundPosition).toBe("60px 40px");

    // Release on window -> subsequent movement must not pan further
    fireEvent(window, mousePointer("pointerup", { buttons: 0, clientX: 160, clientY: 140 }));
    expect(layer.className).toContain("transition-transform");
    fireEvent(window, mousePointer("pointermove", { buttons: 0, clientX: 300, clientY: 300 }));
    expect(layer.style.transform).toContain("translate3d(60px, 40px, 0)");

    // Even if a pointerup is missed (WKWebView quirk), a mouse move with buttons=0 stops dragging
    fireEvent(viewport, mousePointer("pointerdown", { button: 0, buttons: 1, clientX: 200, clientY: 200 }));
    fireEvent(window, mousePointer("pointermove", { buttons: 0, clientX: 260, clientY: 260 }));
    expect(layer.style.transform).toContain("translate3d(60px, 40px, 0)");
  });

  it("builds TopologyCanvas nodes from real Kubernetes manifest ownerReferences, nodeName, containers, and volumes", () => {
    const podYaml = [
      "apiVersion: v1",
      "kind: Pod",
      "metadata:",
      "  name: web-5d4f7c4d94-2qrwp",
      "  namespace: kubix-demo",
      "  ownerReferences:",
      "    - apiVersion: apps/v1",
      "      kind: ReplicaSet",
      "      name: web-5d4f7c4d94",
      "spec:",
      "  nodeName: kubix-dev-control-plane",
      "  serviceAccountName: default",
      "  containers:",
      "    - name: nginx",
      "      image: nginx:1.27-alpine",
      "  volumes:",
      "    - name: secret-vol",
      "      secret:",
      "        secretName: kubix-demo-secret",
      "status:",
      "  phase: Running",
      "  podIP: 10.244.0.9",
    ].join("\n");

    render(
      <TopologyCanvas
        compact
        focusResource={{ kind: "Pod", name: "web-5d4f7c4d94-2qrwp", namespace: "kubix-demo" }}
        manifestYaml={podYaml}
      />,
    );

    expect(screen.getByText("web")).toBeInTheDocument();
    expect(screen.getAllByText("web-5d4f7c4d94").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("web-5d4f7c4d94-2qrwp")).toBeInTheDocument();
    expect(screen.getByText("kubix-dev-control-plane")).toBeInTheDocument();
    expect(screen.getByText("kubix-demo-secret")).toBeInTheDocument();
    expect(screen.getByText("nginx:1.27-alpine")).toBeInTheDocument();
    expect(screen.getByText("10.244.0.9")).toBeInTheDocument();
    expect(screen.queryByText(/Apdex/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Clients/)).not.toBeInTheDocument();
  });
});

describe("ResourceDetail inner tabs", () => {
  it("switches across Overview, YAML, Logs, Events, Security, Metrics, and Topology", async () => {
    setIpcTransport({
      invoke: (async (command: string) => {
        if (command === "get_resource_events") {
          return [
            {
              uid: "ev-1",
              eventType: "Normal",
              reason: "Scheduled",
              involvedObject: "Pod/etcd-control-plane",
              namespace: "kube-system",
              from: "default-scheduler",
              message: "Successfully assigned etcd-control-plane",
              count: 1,
              createdAt: "2026-11-21T06:00:00Z",
            },
          ];
        }
        if (command === "get_resource_metrics") {
          return {
            contextId: "kind-dev",
            metricsServerAvailable: false,
            statusMessage: "Metrics Server not installed",
            timestamp: "",
            windowSeconds: 15,
            totalCpuMillicores: 0,
            totalMemoryMib: 0,
            podCount: 0,
            containers: [],
          };
        }
        return {
          contextId: "kind-dev",
          gvr: "/v1/pods",
          name: "etcd-control-plane",
          namespace: "kube-system",
          yaml: [
            "apiVersion: v1",
            "kind: Pod",
            "metadata:",
            "  name: etcd-control-plane",
            "  namespace: kube-system",
            "  labels:",
            "    component: etcd",
            "spec:",
            "  serviceAccountName: default",
            "  containers:",
            "    - name: etcd",
            "      image: registry.k8s.io/etcd:3.5.15",
          ].join("\n"),
          maskedPaths: [],
        };
      }) as IpcTransport["invoke"],
      listen: (async () => () => {}) as IpcTransport["listen"],
    });

    renderWithQuery(
      <ResourceDetail
        contextId="kind-dev"
        gvr="/v1/pods"
        name="etcd-control-plane"
        namespace="kube-system"
        initialTab="overview"
        onClose={() => {}}
      />,
    );

    expect(await screen.findByTestId("detail-overview")).toBeInTheDocument();
    expect(await screen.findByText("registry.k8s.io/etcd:3.5.15")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("detail-tab-yaml"));
    expect(screen.getByTestId("mock-editor")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("detail-tab-logs"));
    expect(screen.getByTestId("detail-logs")).toBeInTheDocument();
    expect(screen.getByLabelText("Search logs")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("detail-tab-events"));
    expect(screen.getByTestId("detail-events")).toBeInTheDocument();
    expect(screen.getByText("Scheduled")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("detail-tab-security"));
    expect(screen.getByTestId("detail-security")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("detail-tab-metrics"));
    expect(screen.getByTestId("detail-metrics")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("detail-tab-topology"));
    expect(screen.getByTestId("detail-topology")).toBeInTheDocument();
    expect(screen.getByTestId("topology-canvas")).toBeInTheDocument();
  });

  it("renders Config-specific Overview (data keys, type, no fake CPU/containers) and hides Logs/Metrics tabs for Secret and ConfigMap", async () => {
    setIpcTransport({
      invoke: (async () => ({
        contextId: "kind-dev",
        gvr: "/v1/secrets",
        name: "kubix-demo-secret",
        namespace: "kubix-demo",
        yaml: [
          "apiVersion: v1",
          "kind: Secret",
          "type: Opaque",
          "metadata:",
          "  name: kubix-demo-secret",
          "  namespace: kubix-demo",
          "  uid: 85118ad2-1234",
          "  resourceVersion: '942'",
          "data:",
          "  password: <masked by kubix>",
        ].join("\n"),
        maskedPaths: ["/data/password"],
      })) as IpcTransport["invoke"],
      listen: (async () => () => {}) as IpcTransport["listen"],
    });

    renderWithQuery(
      <ResourceDetail
        contextId="kind-dev"
        gvr="/v1/secrets"
        name="kubix-demo-secret"
        namespace="kubix-demo"
        initialTab="overview"
        onClose={() => {}}
      />,
    );

    expect(await screen.findByTestId("detail-overview")).toBeInTheDocument();
    expect(await screen.findByTestId("config-data-section")).toBeInTheDocument();
    expect(screen.getByTestId("config-data-entry")).toHaveTextContent("password");
    expect(screen.getAllByText("Opaque").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("CPU Usage")).not.toBeInTheDocument();
    expect(screen.queryByText("Containers & Images")).not.toBeInTheDocument();
    expect(screen.queryByText("registry.k8s.io/pause:3.10")).not.toBeInTheDocument();
    expect(screen.queryByTestId("detail-tab-logs")).not.toBeInTheDocument();
    expect(screen.queryByTestId("detail-tab-metrics")).not.toBeInTheDocument();
  });

  it("extracts real Pod metadata and spec.containers without mixing in volumes or containerStatuses", async () => {
    setIpcTransport({
      invoke: (async () => ({
        contextId: "kind-dev",
        gvr: "/v1/pods",
        name: "web-5d4f7c4d94-2qrwp",
        namespace: "kubix-demo",
        yaml: [
          "apiVersion: v1",
          "kind: Pod",
          "metadata:",
          "  name: web-5d4f7c4d94-2qrwp",
          "  namespace: kubix-demo",
          "  uid: 91c4e120-aaaa-bbbb-cccc-1234567890ab",
          "  creationTimestamp: '2026-11-19T04:10:00Z'",
          "spec:",
          "  nodeName: kubix-dev-control-plane",
          "  serviceAccountName: default",
          "  volumes:",
          "    - name: kube-api-access-r8g6d",
          "      projected:",
          "        defaultMode: 420",
          "  containers:",
          "    - name: nginx",
          "      image: nginx:alpine",
          "      ports:",
          "        - containerPort: 80",
          "          protocol: TCP",
          "      resources:",
          "        requests:",
          "          cpu: 50m",
          "          memory: 64Mi",
          "status:",
          "  phase: Running",
          "  podIP: 10.244.0.14",
          "  qosClass: Burstable",
          "  containerStatuses:",
          "    - name: nginx",
          "      image: docker.io/library/nginx:alpine",
          "      ready: true",
          "      restartCount: 2",
          "      state:",
          "        running:",
          "          startedAt: '2026-11-19T04:10:05Z'",
        ].join("\n"),
        maskedPaths: [],
      })) as IpcTransport["invoke"],
      listen: (async () => () => {}) as IpcTransport["listen"],
    });

    renderWithQuery(
      <ResourceDetail
        contextId="kind-dev"
        gvr="/v1/pods"
        name="web-5d4f7c4d94-2qrwp"
        namespace="kubix-demo"
        initialTab="overview"
        onClose={() => {}}
      />,
    );

    expect(
      await screen.findByText("91c4e120-aaaa-bbbb-cccc-1234567890ab"),
    ).toBeInTheDocument();
    const overview = screen.getByTestId("detail-overview");
    expect(overview).toHaveTextContent("2026-11-19T04:10:00Z");
    expect(overview).toHaveTextContent("1 / 1");
    expect(overview).toHaveTextContent("50m");
    expect(overview).toHaveTextContent("64Mi");

    const items = screen.getAllByTestId("container-item");
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent("nginx");
    expect(items[0]).toHaveTextContent("nginx:alpine");
    expect(items[0]).not.toHaveTextContent("kube-api-access-r8g6d");
    expect(items[0]).not.toHaveTextContent("container-2");
    expect(screen.queryByText("kube-api-access-r8g6d")).not.toBeInTheDocument();
  });

  it("parses serde_yaml unindented sequences where `- ` shares indentation with `containers:`", async () => {
    setIpcTransport({
      invoke: (async () => ({
        contextId: "kind-dev",
        gvr: "/v1/pods",
        name: "web-5d4f7c4d94-2qrwp",
        namespace: "kubix-demo",
        yaml: [
          "apiVersion: v1",
          "kind: Pod",
          "metadata:",
          "  creationTimestamp: '2026-11-18T20:04:03Z'",
          "  name: web-5d4f7c4d94-2qrwp",
          "  namespace: kubix-demo",
          "  uid: 865f1265-41c1-4e46-9e2f-925337e10932",
          "spec:",
          "  containers:",
          "  - image: nginx:alpine",
          "    name: nginx",
          "    ports:",
          "    - containerPort: 80",
          "      protocol: TCP",
          "  nodeName: kubix-dev-control-plane",
          "  serviceAccountName: default",
          "  volumes:",
          "  - name: kube-api-access-r8g6d",
          "    projected:",
          "      defaultMode: 420",
          "status:",
          "  containerStatuses:",
          "  - containerID: containerd://abc",
          "    image: docker.io/library/nginx:alpine",
          "    name: nginx",
          "    ready: true",
          "    restartCount: 0",
          "    state:",
          "      running:",
          "        startedAt: '2026-11-18T20:04:05Z'",
          "  phase: Running",
          "  podIP: 10.244.0.6",
          "  qosClass: BestEffort",
        ].join("\n"),
        maskedPaths: [],
      })) as IpcTransport["invoke"],
      listen: (async () => () => {}) as IpcTransport["listen"],
    });

    renderWithQuery(
      <ResourceDetail
        contextId="kind-dev"
        gvr="/v1/pods"
        name="web-5d4f7c4d94-2qrwp"
        namespace="kubix-demo"
        initialTab="overview"
        onClose={() => {}}
      />,
    );

    const item = await screen.findByTestId("container-item");
    expect(item).toHaveTextContent("nginx");
    expect(item).toHaveTextContent("nginx:alpine");
    expect(item).toHaveTextContent("80/TCP");
    expect(item).toHaveTextContent("Running");
    expect(screen.getByTestId("detail-overview")).toHaveTextContent("1 / 1");
  });

  it("opens an interactive container shell tab in the bottom TerminalDock from a Pod", async () => {
    const startCalls: Array<{ podName: string; container?: string }> = [];
    const closeCalls: string[] = [];
    setIpcTransport({
      invoke: (async (command: string, args: unknown) => {
        switch (command) {
          case "list_contexts":
            return [ctx("kind-dev")];
          case "discover_resources":
            return [pods];
          case "list_resources":
            return [
              {
                uid: "p1",
                name: "web-0",
                namespace: "kubix-demo",
                kind: "Pod",
                createdAt: "2026-01-01T00:00:00Z",
                labels: {},
                status: "Running",
              },
            ];
          case "get_resource":
            return {
              contextId: "kind-dev",
              gvr: "/v1/pods",
              name: "web-0",
              namespace: "kubix-demo",
              yaml: [
                "apiVersion: v1",
                "kind: Pod",
                "metadata:",
                "  name: web-0",
                "  namespace: kubix-demo",
                "spec:",
                "  containers:",
                "  - image: nginx:alpine",
                "    name: nginx",
              ].join("\n"),
              maskedPaths: [],
            };
          case "start_shell": {
            const payload = args as { podName: string; container?: string };
            startCalls.push(payload);
            return {
              sessionId: "shell-1",
              contextId: "kind-dev",
              namespace: "kubix-demo",
              podName: payload.podName,
              container: payload.container ?? "nginx",
            };
          }
          case "close_shell": {
            closeCalls.push((args as { sessionId: string }).sessionId);
            return null;
          }
          default:
            return null;
        }
      }) as IpcTransport["invoke"],
      listen: (async () => () => {}) as IpcTransport["listen"],
    });

    renderWithQuery(<App />);
    await waitFor(() => expect(screen.getByTestId("open-cluster")).toBeInTheDocument());
    await userEvent.click(screen.getByTestId("open-cluster"));

    await waitFor(() => expect(screen.getByTestId("explorer-placeholder")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "WorkLoad" }));

    await waitFor(() => expect(screen.getAllByTestId("resource-type")).not.toHaveLength(0));
    const podBtn = screen
      .getAllByTestId("resource-type")
      .find((el) => el.dataset.gvr === "/v1/pods") as HTMLElement;
    await userEvent.click(podBtn);

    await waitFor(() => expect(screen.getByText("web-0")).toBeInTheDocument());
    await userEvent.click(screen.getByTestId("resource-row"));

    const containerShellBtn = await screen.findByTestId("exec-container-nginx");
    await userEvent.click(containerShellBtn);

    expect(startCalls).toContainEqual(
      expect.objectContaining({ podName: "web-0", container: "nginx" }),
    );
    expect(await screen.findByTestId("terminal-dock")).toBeInTheDocument();
    expect(screen.getByTestId("terminal-tab")).toHaveTextContent("web-0/nginx");
    expect(await screen.findByTestId("interactive-shell-badge")).toHaveTextContent(
      "INTERACTIVE SHELL (1)",
    );

    await userEvent.click(screen.getByRole("button", { name: "Close shell web-0" }));
    await waitFor(() => expect(screen.queryByTestId("terminal-dock")).not.toBeInTheDocument());
    expect(closeCalls).toContain("shell-1");
  });

  it("keeps kubix://shell-output subscribed under React StrictMode and replays early prompts", async () => {
    const activeListeners = new Map<string, Set<(payload: unknown) => void>>();
    let resolveStartShell: ((session: unknown) => void) | null = null;

    setIpcTransport({
      invoke: (async (command: string) => {
        if (command === "list_contexts") return [ctx("kind-dev")];
        if (command === "start_shell") {
          return await new Promise((resolve) => {
            resolveStartShell = (session) => resolve(session as never);
          });
        }
        return null;
      }) as IpcTransport["invoke"],
      listen: (async (event: string, handler: (payload: unknown) => void) => {
        const set = activeListeners.get(event) ?? new Set();
        set.add(handler);
        activeListeners.set(event, set);
        return () => {
          set.delete(handler);
        };
      }) as IpcTransport["listen"],
    });

    renderWithQuery(
      <StrictMode>
        <App />
      </StrictMode>,
    );

    await waitFor(() =>
      expect(activeListeners.get("kubix://shell-output")?.size ?? 0).toBeGreaterThan(0),
    );

    const shellPromise = useTerminalStore.getState().openShell({
      contextId: "kind-dev",
      namespace: "kubix-demo",
      podName: "web-0",
      container: "nginx",
    });

    // Prompt arrives before start_shell RPC resolves
    for (const fn of activeListeners.get("kubix://shell-output") ?? []) {
      fn({
        sessionId: "shell-strict-1",
        stream: "stdout",
        data: "/ # ",
        closed: false,
      });
    }

    resolveStartShell!({
      sessionId: "shell-strict-1",
      contextId: "kind-dev",
      namespace: "kubix-demo",
      podName: "web-0",
      container: "nginx",
    });
    await shellPromise;

    const receivedFirstMount: string[] = [];
    const unsub = useTerminalStore.getState().subscribeSession("shell-strict-1", (chunk) => {
      receivedFirstMount.push(chunk);
    });
    expect(receivedFirstMount).toEqual(["/ # "]);
    unsub();

    // StrictMode / minimize remount still sees the buffered prompt
    const receivedSecondMount: string[] = [];
    const unsub2 = useTerminalStore.getState().subscribeSession("shell-strict-1", (chunk) => {
      receivedSecondMount.push(chunk);
    });
    expect(receivedSecondMount).toEqual(["/ # "]);
    unsub2();
  });

  it("fetches real pod logs for a Deployment and labels each log line with its pod name", async () => {
    setIpcTransport({
      invoke: (async (command: string) => {
        if (command === "get_resource") {
          return {
            contextId: "kind-dev",
            gvr: "apps/v1/deployments",
            name: "web",
            namespace: "kubix-demo",
            yaml: "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\n  namespace: kubix-demo",
            maskedPaths: [],
          };
        }
        if (command === "get_pod_logs") {
          return {
            contextId: "kind-dev",
            gvr: "apps/v1/deployments",
            name: "web",
            namespace: "kubix-demo",
            pods: ["web-5d4f7c4d94-2qrwp", "web-5d4f7c4d94-hwjbz"],
            containers: ["nginx"],
            chunks: [
              {
                podName: "web-5d4f7c4d94-2qrwp",
                containerName: "nginx",
                logs: "2026-11-19T05:30:01.000Z GET /healthz 200 OK\n",
              },
              {
                podName: "web-5d4f7c4d94-hwjbz",
                containerName: "nginx",
                logs: "2026-11-19T05:30:02.000Z WARN upstream slow response\n",
              },
            ],
          };
        }
        return null;
      }) as IpcTransport["invoke"],
      listen: (async () => () => {}) as IpcTransport["listen"],
    });

    renderWithQuery(
      <ResourceDetail
        contextId="kind-dev"
        gvr="apps/v1/deployments"
        name="web"
        namespace="kubix-demo"
        initialTab="logs"
        onClose={() => {}}
      />,
    );

    expect(await screen.findByTestId("log-pods-bar")).toBeInTheDocument();
    const podLabels = await screen.findAllByTestId("log-pod-label");
    expect(podLabels).toHaveLength(2);
    expect(podLabels[0]).toHaveTextContent("2qrwp");
    expect(podLabels[0]).toHaveAttribute("title", "web-5d4f7c4d94-2qrwp/nginx");
    expect(podLabels[1]).toHaveTextContent("hwjbz");
    expect(podLabels[1]).toHaveAttribute("title", "web-5d4f7c4d94-hwjbz/nginx");
    expect(screen.getByText(/GET \/healthz 200 OK/)).toBeInTheDocument();
    expect(screen.getByText(/WARN upstream slow response/)).toBeInTheDocument();
  });
});

describe("categorizeResources deduplication and Lens canonical sorting", () => {
  it("deduplicates double Event and HPA versions and sorts Workloads in Lens canonical order", () => {
    const mk = (
      kind: string,
      group: string,
      version: string,
      plural: string,
      curated = false,
    ): DiscoveredResourceDto => ({
      gvr: group ? `${group}/${version}/${plural}` : `/${version}/${plural}`,
      kind,
      group,
      version,
      plural,
      namespaced: true,
      shortNames: [],
      verbs: ["get", "list", "watch"],
      curated,
    });

    const { primaryGroups } = categorizeResources([
      mk("Event", "", "v1", "events"),
      mk("Event", "events.k8s.io", "v1", "events"),
      mk("Node", "", "v1", "nodes", true),
      mk("Namespace", "", "v1", "namespaces", true),
      mk("CronJob", "batch", "v1", "cronjobs", true),
      mk("StatefulSet", "apps", "v1", "statefulsets", true),
      mk("HorizontalPodAutoscaler", "autoscaling", "v1", "horizontalpodautoscalers"),
      mk("HorizontalPodAutoscaler", "autoscaling", "v2", "horizontalpodautoscalers"),
      mk("Pod", "", "v1", "pods", true),
      mk("ReplicaSet", "apps", "v1", "replicasets"),
      mk("Deployment", "apps", "v1", "deployments", true),
      mk("DaemonSet", "apps", "v1", "daemonsets", true),
      mk("Job", "batch", "v1", "jobs", true),
      mk("ReplicationController", "", "v1", "replicationcontrollers"),
    ]);

    const clusterGroup = primaryGroups.find((g) => g.id === "cluster")!;
    const eventItems = clusterGroup.items.filter((i) => i.kind === "Event");
    expect(eventItems).toHaveLength(1);
    expect(eventItems[0]?.gvr).toBe("/v1/events");

    const workloadGroup = primaryGroups.find((g) => g.id === "workload")!;
    expect(workloadGroup.items.map((i) => i.kind)).toEqual([
      "Pod",
      "Deployment",
      "DaemonSet",
      "StatefulSet",
      "ReplicaSet",
      "ReplicationController",
      "Job",
      "CronJob",
      "HorizontalPodAutoscaler",
    ]);
    const hpa = workloadGroup.items.find((i) => i.kind === "HorizontalPodAutoscaler");
    expect(hpa?.version).toBe("v2");
  });

  it("pins CustomResourceDefinition, groups operator CRDs by exact API group, and tucks built-in *.k8s.io APIs at the bottom", () => {
    const mk = (
      kind: string,
      group: string,
      version: string,
      plural: string,
    ): DiscoveredResourceDto => ({
      gvr: group ? `${group}/${version}/${plural}` : `/${version}/${plural}`,
      kind,
      group,
      version,
      plural,
      namespaced: true,
      shortNames: [],
      verbs: ["get", "list", "watch"],
      curated: false,
    });

    const { crdSection } = categorizeResources([
      mk("CustomResourceDefinition", "apiextensions.k8s.io", "v1", "customresourcedefinitions"),
      mk("Certificate", "cert-manager.io", "v1", "certificates"),
      mk("Issuer", "cert-manager.io", "v1", "issuers"),
      mk("Cluster", "apps.kubeblocks.io", "v1alpha1", "clusters"),
      mk("Cluster", "apps.kubeblocks.io", "v1", "clusters"),
      mk("Component", "apps.kubeblocks.io", "v1alpha1", "components"),
      mk("Elasticsearch", "elasticsearch.k8s.elastic.co", "v1", "elasticsearches"),
      mk("NodePool", "karpenter.k8s.aws", "v1", "nodepools"),
      mk("Service", "serving.knative.dev", "v1", "services"),
      mk("MutatingWebhookConfiguration", "admissionregistration.k8s.io", "v1", "mutatingwebhookconfigurations"),
      mk("NodeMetrics", "metrics.k8s.io", "v1beta1", "nodemetrics"),
    ]);

    expect(crdSection.pinnedCrd?.kind).toBe("CustomResourceDefinition");
    expect(crdSection.operatorGroups.map((g) => g.title)).toEqual([
      "apps.kubeblocks.io",
      "cert-manager.io",
      "elasticsearch.k8s.elastic.co",
      "karpenter.k8s.aws",
      "serving.knative.dev",
    ]);
    // apps.kubeblocks.io dedupes Cluster v1alpha1 vs v1 -> prefers v1
    expect(crdSection.operatorGroups[0]?.items.map((i) => `${i.kind}:${i.version}`)).toEqual([
      "Cluster:v1",
      "Component:v1alpha1",
    ]);
    expect(crdSection.builtInGroup?.title).toBe("Kubernetes APIs");
    expect(crdSection.builtInGroup?.items.map((i) => i.kind)).toEqual([
      "MutatingWebhookConfiguration",
      "NodeMetrics",
    ]);
    expect(crdSection.totalCount).toBe(10);
  });

  it("renders collapsible CRD API subgroups in NavigationSidebar with pinned CRD, search auto-expand, and activeGvr auto-expand", async () => {
    const mk = (
      kind: string,
      group: string,
      version: string,
      plural: string,
    ): DiscoveredResourceDto => ({
      gvr: group ? `${group}/${version}/${plural}` : `/${version}/${plural}`,
      kind,
      group,
      version,
      plural,
      namespaced: true,
      shortNames: [],
      verbs: ["get", "list", "watch"],
      curated: false,
    });

    const resources = [
      mk("CustomResourceDefinition", "apiextensions.k8s.io", "v1", "customresourcedefinitions"),
      mk("Certificate", "cert-manager.io", "v1", "certificates"),
      mk("Issuer", "cert-manager.io", "v1", "issuers"),
      mk("Cluster", "apps.kubeblocks.io", "v1", "clusters"),
      mk("MutatingWebhookConfiguration", "admissionregistration.k8s.io", "v1", "mutatingwebhookconfigurations"),
    ];
    const onSelectResource = vi.fn();

    const activeContext = {
      ...ctx("kind-dev"),
      state: "ready" as const,
      lastError: undefined,
      pending: false,
    };

    const { rerender } = render(
      <NavigationSidebar
        activeContext={activeContext}
        resources={resources}
        isLoadingDiscovery={false}
        discoveryError={null}
        activeGvr={null}
        activeSpecialView={null}
        open
        onCloseMobile={() => {}}
        onSelectResource={onSelectResource}
        onSelectSpecial={() => {}}
        onBackToClusters={() => {}}
      />,
    );

    // Kubernetes APIs is its own separate top-level section (outside Custom Resources)
    const k8sApisBtn = screen.getByRole("button", { name: /Kubernetes APIs/i });
    expect(k8sApisBtn).toHaveAttribute("aria-expanded", "false");

    // Expand Custom Resources
    await userEvent.click(screen.getByRole("button", { name: /Custom Resources/i }));

    // Pinned Definitions (CustomResourceDefinition) is immediately visible at top
    const defsBtn = screen.getByRole("button", { name: /Definitions/i });
    expect(defsBtn).toHaveAttribute("data-gvr", "apiextensions.k8s.io/v1/customresourcedefinitions");

    // Operator subgroups are rendered collapsed by default inside Custom Resources
    const certGroupBtn = screen.getByRole("button", { name: /cert-manager\.io/i });
    const kbGroupBtn = screen.getByRole("button", { name: /apps\.kubeblocks\.io/i });
    expect(certGroupBtn).toHaveAttribute("aria-expanded", "false");
    expect(kbGroupBtn).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: /^Certificate/i })).not.toBeInTheDocument();

    // Clicking cert-manager.io expands its Custom Resources
    await userEvent.click(certGroupBtn);
    expect(certGroupBtn).toHaveAttribute("aria-expanded", "true");
    const certBtn = screen.getByRole("button", { name: /Certificate/i });
    await userEvent.click(certBtn);
    expect(onSelectResource).toHaveBeenCalledWith(
      expect.objectContaining({ gvr: "cert-manager.io/v1/certificates" }),
    );

    // Typing in sidebar filter auto-expands matching Custom Resource subgroup
    const searchInput = screen.getByLabelText("Find resource type");
    await userEvent.type(searchInput, "kubeblocks");
    expect(screen.getByRole("button", { name: /Cluster/i })).toBeInTheDocument();
    await userEvent.clear(searchInput);

    // Setting activeGvr to a built-in Kubernetes API auto-expands the top-level Kubernetes APIs section
    rerender(
      <NavigationSidebar
        activeContext={activeContext}
        resources={resources}
        isLoadingDiscovery={false}
        discoveryError={null}
        activeGvr="admissionregistration.k8s.io/v1/mutatingwebhookconfigurations"
        activeSpecialView={null}
        open
        onCloseMobile={() => {}}
        onSelectResource={onSelectResource}
        onSelectSpecial={() => {}}
        onBackToClusters={() => {}}
      />,
    );

    await waitFor(() => {
      expect(k8sApisBtn).toHaveAttribute("aria-expanded", "true");
      expect(
        screen.getByRole("button", { name: /MutatingWebhookConfiguration/i }),
      ).toBeInTheDocument();
    });
  });
});

describe("IDE workspace shell navigation", () => {
  it("opens grouped sections, resource tabs, topology, security, and helm views", async () => {
    setIpcTransport({
      invoke: (async (command: string) => {
        switch (command) {
          case "list_contexts":
            return [ctx("kind-dev")];
          case "discover_resources":
            return [pods, deployments, services, secrets, roles];
          case "list_resources":
            return [
              {
                uid: "d1",
                name: "coredns",
                namespace: "kube-system",
                kind: "Deployment",
                createdAt: "2026-01-01T00:00:00Z",
                labels: { app: "coredns" },
                status: "Running",
              },
            ];
          default:
            return null;
        }
      }) as IpcTransport["invoke"],
      listen: (async () => () => {}) as IpcTransport["listen"],
    });

    renderWithQuery(<App />);
    await waitFor(() => expect(screen.getByTestId("open-cluster")).toBeInTheDocument());
    await userEvent.click(screen.getByTestId("open-cluster"));

    await waitFor(() => expect(screen.getByTestId("explorer-placeholder")).toBeInTheDocument());
    expect(screen.getByTestId("global-command-bar")).toBeInTheDocument();

    const sidebarNav = screen.getByRole("navigation", { name: "Resource types" });
    expect(within(sidebarNav).getByText("Cluster")).toBeInTheDocument();
    expect(within(sidebarNav).getByText("WorkLoad")).toBeInTheDocument();
    expect(within(sidebarNav).getByText("Visualizer")).toBeInTheDocument();
    expect(within(sidebarNav).getByText("Security")).toBeInTheDocument();
    expect(within(sidebarNav).getByText("Helm")).toBeInTheDocument();
    expect(within(sidebarNav).getByText("Network")).toBeInTheDocument();
    expect(within(sidebarNav).getByText("Config")).toBeInTheDocument();
    expect(within(sidebarNav).getByText("RBAC")).toBeInTheDocument();

    // All sidebar groups start collapsed by default
    expect(within(sidebarNav).getByRole("button", { name: "Cluster" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(within(sidebarNav).getByRole("button", { name: "WorkLoad" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );

    await userEvent.click(within(sidebarNav).getByRole("button", { name: "WorkLoad" }));
    expect(within(sidebarNav).getByRole("button", { name: "WorkLoad" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );

    const deployBtn = screen
      .getAllByTestId("resource-type")
      .find((el) => el.dataset.gvr === "apps/v1/deployments") as HTMLElement;
    await userEvent.click(deployBtn);

    await waitFor(() => expect(screen.getByTestId("resource-table")).toBeInTheDocument());
    expect(screen.getByText("coredns")).toBeInTheDocument();
    expect(screen.getAllByTestId("workspace-tab")).toHaveLength(2);

    await userEvent.click(within(sidebarNav).getByText("Visualizer"));
    expect(screen.getByTestId("topology-canvas")).toBeInTheDocument();
    expect(screen.getAllByTestId("workspace-tab")).toHaveLength(3);

    await userEvent.click(within(sidebarNav).getByText("Security"));
    expect(screen.getByTestId("security-view")).toBeInTheDocument();
    expect(screen.getAllByTestId("workspace-tab")).toHaveLength(4);

    await userEvent.click(within(sidebarNav).getByText("Helm"));
    expect(screen.getByTestId("helm-view")).toBeInTheDocument();
    expect(screen.getAllByTestId("workspace-tab")).toHaveLength(5);

    // Clicking an already-open sidebar view focuses its existing tab without duplicating
    await userEvent.click(within(sidebarNav).getByText("Security"));
    expect(screen.getByTestId("security-view")).toBeInTheDocument();
    expect(screen.getAllByTestId("workspace-tab")).toHaveLength(5);
  });

  it("persists the selected namespace filter across different resource types", async () => {
    const listCalls: Array<{ gvr: string; namespace: string }> = [];
    const nodes: DiscoveredResourceDto = {
      gvr: "/v1/nodes",
      kind: "Node",
      group: "",
      version: "v1",
      plural: "nodes",
      namespaced: false,
      shortNames: ["no"],
      verbs: ["get", "list", "watch"],
      curated: true,
    };

    setIpcTransport({
      invoke: (async (command: string, args: unknown) => {
        switch (command) {
          case "list_contexts":
            return [ctx("kind-dev")];
          case "discover_resources":
            return [pods, deployments, nodes];
          case "list_resources": {
            const call = args as { gvr: string; namespace: string };
            listCalls.push({ gvr: call.gvr, namespace: call.namespace });
            if (call.gvr === "/v1/pods") {
              return [
                {
                  uid: "p1",
                  name: "web-pod",
                  namespace: "kubix-demo",
                  kind: "Pod",
                  createdAt: "2026-01-01T00:00:00Z",
                  labels: {},
                  status: "Running",
                },
              ];
            }
            if (call.gvr === "apps/v1/deployments" && call.namespace === "") {
              return [
                {
                  uid: "d1",
                  name: "web-deploy",
                  namespace: "kubix-demo",
                  kind: "Deployment",
                  createdAt: "2026-01-01T00:00:00Z",
                  labels: {},
                  status: "Running",
                },
              ];
            }
            return [];
          }
          default:
            return null;
        }
      }) as IpcTransport["invoke"],
      listen: (async () => () => {}) as IpcTransport["listen"],
    });

    renderWithQuery(<App />);
    await waitFor(() => expect(screen.getByTestId("open-cluster")).toBeInTheDocument());
    await userEvent.click(screen.getByTestId("open-cluster"));
    await waitFor(() => expect(screen.getByTestId("explorer-placeholder")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "WorkLoad" }));

    await waitFor(() => expect(screen.getAllByTestId("resource-type")).not.toHaveLength(0));

    // Open Pods first (seeds to "default")
    const podBtn = screen
      .getAllByTestId("resource-type")
      .find((el) => el.dataset.gvr === "/v1/pods") as HTMLElement;
    await userEvent.click(podBtn);
    await waitFor(() =>
      expect(screen.getByTestId("namespace-filter")).toHaveAttribute("data-value", "default"),
    );

    // Switch namespace filter to All Namespaces
    await userEvent.click(screen.getByTestId("namespace-filter"));
    await userEvent.click(screen.getByTestId("namespace-all-toggle"));
    await waitFor(() =>
      expect(screen.getByTestId("namespace-filter")).toHaveAttribute("data-value", ""),
    );

    // Visit cluster-scoped Node, then switch to Deployment
    await userEvent.click(screen.getByRole("button", { name: "Cluster" }));
    const nodeBtn = screen
      .getAllByTestId("resource-type")
      .find((el) => el.dataset.gvr === "/v1/nodes") as HTMLElement;
    await userEvent.click(nodeBtn);
    await waitFor(() => expect(screen.getByText("Nodes")).toBeInTheDocument());

    const deployBtn = screen
      .getAllByTestId("resource-type")
      .find((el) => el.dataset.gvr === "apps/v1/deployments") as HTMLElement;
    await userEvent.click(deployBtn);

    // Namespace filter stays All Namespaces ("") and loads Deployment in ""
    await waitFor(() =>
      expect(screen.getByTestId("namespace-filter")).toHaveAttribute("data-value", ""),
    );
    await waitFor(() => expect(screen.getByText("web-deploy")).toBeInTheDocument());
    expect(listCalls).toContainEqual({ gvr: "apps/v1/deployments", namespace: "" });
    expect(screen.getAllByTestId("workspace-tab")).toHaveLength(4);

    // Observed namespace "kubix-demo" from Pods/Deployments is available in dropdown
    await userEvent.click(screen.getByTestId("namespace-filter"));
    expect(
      screen
        .getAllByTestId("namespace-option")
        .some((el) => el.getAttribute("data-namespace") === "kubix-demo"),
    ).toBe(true);
  });

  it("removes Overview from the WorkLoad sidebar group while keeping Cluster Overview", async () => {
    setIpcTransport({
      invoke: (async (command: string) => {
        if (command === "list_contexts") return [ctx("kind-dev")];
        if (command === "discover_resources") return [pods, deployments];
        return null;
      }) as IpcTransport["invoke"],
      listen: (async () => () => {}) as IpcTransport["listen"],
    });

    renderWithQuery(<App />);
    await waitFor(() => expect(screen.getByTestId("open-cluster")).toBeInTheDocument());
    await userEvent.click(screen.getByTestId("open-cluster"));
    await waitFor(() => expect(screen.getByTestId("explorer-placeholder")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: "WorkLoad" }));
    expect(screen.queryByRole("button", { name: "Overview" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Cluster" }));
    expect(screen.getByRole("button", { name: "Overview" })).toBeInTheDocument();
  });

  it("sorts visible ResourceTable columns Asc -> Desc -> Default and remembers sort per resource tab", async () => {
    const podRows = [
      {
        uid: "p-a",
        name: "alpha",
        namespace: "default",
        kind: "Pod",
        createdAt: "2026-01-01T00:10:00Z",
        labels: {},
        status: "Running",
        restarts: 2,
      },
      {
        uid: "p-b",
        name: "beta",
        namespace: "default",
        kind: "Pod",
        createdAt: "2026-01-01T00:30:00Z",
        labels: {},
        status: "Pending",
        restarts: 10,
      },
      {
        uid: "p-c",
        name: "gamma",
        namespace: "default",
        kind: "Pod",
        createdAt: "2026-01-01T00:20:00Z",
        labels: {},
        status: "Running",
        restarts: 0,
      },
    ];

    setIpcTransport({
      invoke: (async (command: string, args: unknown) => {
        if (command === "list_contexts") return [ctx("kind-dev")];
        if (command === "discover_resources") return [pods, deployments];
        if (command === "list_resources") {
          const gvr = (args as { gvr: string }).gvr;
          if (gvr === "/v1/pods") return podRows;
          if (gvr === "apps/v1/deployments") {
            return [
              {
                uid: "d-z",
                name: "zeta-api",
                namespace: "default",
                kind: "Deployment",
                createdAt: "2026-01-01T00:00:00Z",
                labels: {},
                status: "1/1",
                ready: "1/1",
              },
              {
                uid: "d-a",
                name: "alpha-web",
                namespace: "default",
                kind: "Deployment",
                createdAt: "2026-01-01T00:05:00Z",
                labels: {},
                status: "1/1",
                ready: "1/1",
              },
            ];
          }
        }
        return null;
      }) as IpcTransport["invoke"],
      listen: (async () => () => {}) as IpcTransport["listen"],
    });

    renderWithQuery(<App />);
    await waitFor(() => expect(screen.getByTestId("open-cluster")).toBeInTheDocument());
    await userEvent.click(screen.getByTestId("open-cluster"));
    await waitFor(() => expect(screen.getByTestId("explorer-placeholder")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "WorkLoad" }));

    const podBtn = screen
      .getAllByTestId("resource-type")
      .find((el) => el.dataset.gvr === "/v1/pods") as HTMLElement;
    await userEvent.click(podBtn);
    await waitFor(() => expect(screen.getByText("alpha")).toBeInTheDocument());

    const rowNames = () =>
      screen.getAllByTestId("resource-row").map((el) => el.getAttribute("data-uid"));

    // Click Restarts: Asc (0, 2, 10) -> gamma, alpha, beta
    await userEvent.click(screen.getByTestId("sort-col-restarts"));
    expect(rowNames()).toEqual(["p-c", "p-a", "p-b"]);

    // Click Restarts again: Desc (10, 2, 0) -> beta, alpha, gamma
    await userEvent.click(screen.getByTestId("sort-col-restarts"));
    expect(rowNames()).toEqual(["p-b", "p-a", "p-c"]);

    // Switch to Deployments (defaults to store order: alpha-web then zeta-api)
    const deployBtn = screen
      .getAllByTestId("resource-type")
      .find((el) => el.dataset.gvr === "apps/v1/deployments") as HTMLElement;
    await userEvent.click(deployBtn);
    await waitFor(() => expect(screen.getByText("zeta-api")).toBeInTheDocument());
    expect(rowNames()).toEqual(["d-a", "d-z"]);

    // Sort Deployments Name Asc -> Desc (zeta-api then alpha-web)
    await userEvent.click(screen.getByTestId("sort-col-name"));
    await userEvent.click(screen.getByTestId("sort-col-name"));
    expect(rowNames()).toEqual(["d-z", "d-a"]);

    // Switch back to Pods: Pods remembers Restarts Desc
    await userEvent.click(podBtn);
    await waitFor(() => expect(screen.getByText("alpha")).toBeInTheDocument());
    expect(rowNames()).toEqual(["p-b", "p-a", "p-c"]);

    // Third click resets Pods Restarts to Default (alpha, beta, gamma)
    await userEvent.click(screen.getByTestId("sort-col-restarts"));
    expect(rowNames()).toEqual(["p-a", "p-b", "p-c"]);

    // Age Asc puts youngest first (00:30 beta, 00:20 gamma, 00:10 alpha)
    await userEvent.click(screen.getByTestId("sort-col-age"));
    expect(rowNames()).toEqual(["p-b", "p-c", "p-a"]);

    // Switch back to Deployments: still remembers Name Desc
    await userEvent.click(deployBtn);
    await waitFor(() => expect(screen.getByText("zeta-api")).toBeInTheDocument());
    expect(rowNames()).toEqual(["d-z", "d-a"]);
  });

  it("interleaves multi-container logs chronologically and supports container/initContainer filter pills", async () => {
    const logRequests: Array<{ container?: string }> = [];
    setIpcTransport({
      invoke: (async (command: string, args: unknown) => {
        if (command === "get_resource") {
          return {
            contextId: "kind-dev",
            gvr: "/v1/pods",
            name: "api-0",
            namespace: "kubix-demo",
            yaml: [
              "apiVersion: v1",
              "kind: Pod",
              "metadata:",
              "  name: api-0",
              "  namespace: kubix-demo",
              "spec:",
              "  initContainers:",
              "  - image: busybox",
              "    name: migrate-db",
              "  containers:",
              "  - image: nginx",
              "    name: app",
              "  - image: envoy",
              "    name: sidecar",
            ].join("\n"),
            maskedPaths: [],
          };
        }
        if (command === "get_pod_logs") {
          const payload = args as { container?: string };
          logRequests.push({ container: payload.container });
          if (payload.container === "migrate-db") {
            return {
              contextId: "kind-dev",
              gvr: "/v1/pods",
              name: "api-0",
              namespace: "kubix-demo",
              pods: ["api-0"],
              containers: ["app", "sidecar"],
              initContainers: ["migrate-db"],
              chunks: [
                {
                  podName: "api-0",
                  containerName: "migrate-db",
                  logs: "2026-11-19T05:00:00.000Z schema migration ok\n",
                },
              ],
            };
          }
          return {
            contextId: "kind-dev",
            gvr: "/v1/pods",
            name: "api-0",
            namespace: "kubix-demo",
            pods: ["api-0"],
            containers: ["app", "sidecar"],
            initContainers: ["migrate-db"],
            chunks: [
              {
                podName: "api-0",
                containerName: "app",
                logs: "2026-11-19T05:30:02.000Z app started\n",
              },
              {
                podName: "api-0",
                containerName: "sidecar",
                logs: "2026-11-19T05:30:01.000Z proxy ready\n",
              },
            ],
          };
        }
        return null;
      }) as IpcTransport["invoke"],
      listen: (async () => () => {}) as IpcTransport["listen"],
    });

    renderWithQuery(
      <ResourceDetail
        contextId="kind-dev"
        gvr="/v1/pods"
        name="api-0"
        namespace="kubix-demo"
        initialTab="logs"
        onClose={() => {}}
      />,
    );

    const select = await screen.findByTestId("log-container-select");
    expect(select).toHaveTextContent("All containers (3)");
    expect(select).toHaveTextContent("container: app");
    expect(select).toHaveTextContent("container: sidecar");
    expect(select).toHaveTextContent("init: migrate-db");
    expect(screen.queryByTestId("log-containers-bar")).not.toBeInTheDocument();

    // Chronological order: sidecar (05:30:01) before app (05:30:02)
    const containerBadges = await screen.findAllByTestId("log-container-label");
    expect(containerBadges.map((el) => el.textContent)).toEqual(["[sidecar]", "[app]"]);

    // Selecting init container from the dropdown queries & displays init container logs
    await userEvent.selectOptions(select, "migrate-db");
    await waitFor(() => expect(screen.getByText(/schema migration ok/)).toBeInTheDocument());
    expect(logRequests).toContainEqual({ container: "migrate-db" });
    expect(select).toHaveValue("migrate-db");
  });

  it("opens a container selection menu when clicking the Pod header Shell button on a multi-container Pod", async () => {
    const startCalls: Array<{ podName: string; container?: string }> = [];
    setIpcTransport({
      invoke: (async (command: string, args: unknown) => {
        if (command === "get_resource") {
          return {
            contextId: "kind-dev",
            gvr: "/v1/pods",
            name: "api-0",
            namespace: "kubix-demo",
            yaml: [
              "apiVersion: v1",
              "kind: Pod",
              "metadata:",
              "  name: api-0",
              "  namespace: kubix-demo",
              "spec:",
              "  containers:",
              "  - image: nginx:alpine",
              "    name: app",
              "  - image: envoyproxy/envoy:v1.31",
              "    name: sidecar",
            ].join("\n"),
            maskedPaths: [],
          };
        }
        if (command === "start_shell") {
          const payload = args as { podName: string; container?: string };
          startCalls.push(payload);
          return {
            sessionId: "shell-sidecar",
            contextId: "kind-dev",
            namespace: "kubix-demo",
            podName: payload.podName,
            container: payload.container ?? "app",
          };
        }
        return null;
      }) as IpcTransport["invoke"],
      listen: (async () => () => {}) as IpcTransport["listen"],
    });

    renderWithQuery(
      <ResourceDetail
        contextId="kind-dev"
        gvr="/v1/pods"
        name="api-0"
        namespace="kubix-demo"
        initialTab="overview"
        onClose={() => {}}
      />,
    );

    await screen.findByTestId("exec-container-app");
    await userEvent.click(screen.getByTestId("exec-pod-shell"));

    // Should NOT start shell yet; opens the container selection dropdown menu
    expect(startCalls).toHaveLength(0);
    const menu = await screen.findByTestId("exec-pod-shell-menu");
    expect(menu).toHaveTextContent("app");
    expect(menu).toHaveTextContent("sidecar");

    await userEvent.click(screen.getByTestId("exec-pod-shell-option-sidecar"));
    expect(startCalls).toContainEqual(
      expect.objectContaining({ podName: "api-0", container: "sidecar" }),
    );
    expect(screen.queryByTestId("exec-pod-shell-menu")).not.toBeInTheDocument();
  });

  it("starts and stops a local port-forward from a Service or Pod and manages it in Network -> Port Forwards", async () => {
    const startedForwards: Array<{
      kind: string;
      name: string;
      remotePort: number;
      localPort?: number;
    }> = [];
    const stoppedForwards: string[] = [];

    setIpcTransport({
      invoke: (async (command: string, args: unknown) => {
        switch (command) {
          case "list_contexts":
            return [ctx("kind-dev")];
          case "discover_resources":
            return [pods, services];
          case "list_resources":
            return [
              {
                uid: "svc-1",
                name: "api-gateway-svc",
                namespace: "kubix-demo",
                kind: "Service",
                createdAt: "2026-01-01T00:00:00Z",
                labels: {},
                status: "ClusterIP",
              },
            ];
          case "get_resource":
            return {
              contextId: "kind-dev",
              gvr: "/v1/services",
              name: "api-gateway-svc",
              namespace: "kubix-demo",
              yaml: [
                "apiVersion: v1",
                "kind: Service",
                "metadata:",
                "  name: api-gateway-svc",
                "  namespace: kubix-demo",
                "spec:",
                "  type: ClusterIP",
                "  ports:",
                "  - name: http",
                "    port: 80",
                "    targetPort: 80",
                "    protocol: TCP",
              ].join("\n"),
              maskedPaths: [],
            };
          case "start_port_forward": {
            const payload = args as {
              kind: string;
              name: string;
              remotePort: number;
              localPort?: number;
            };
            startedForwards.push(payload);
            const lp = payload.localPort || 8080;
            return {
              forwardId: "pf-1",
              contextId: "kind-dev",
              namespace: "kubix-demo",
              kind: payload.kind,
              name: payload.name,
              targetPod: "api-gateway-74ffdb8b8f-g4k6d",
              remotePort: payload.remotePort,
              localPort: lp,
              localUrl: `http://127.0.0.1:${lp}`,
            };
          }
          case "list_port_forwards":
            return usePortForwardStore.getState().forwards;
          case "stop_port_forward": {
            stoppedForwards.push((args as { forwardId: string }).forwardId);
            return null;
          }
          default:
            return null;
        }
      }) as IpcTransport["invoke"],
      listen: (async () => () => {}) as IpcTransport["listen"],
    });

    renderWithQuery(<App />);
    await waitFor(() => expect(screen.getByTestId("open-cluster")).toBeInTheDocument());
    await userEvent.click(screen.getByTestId("open-cluster"));
    await waitFor(() => expect(screen.getByTestId("explorer-placeholder")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: "Network" }));
    const svcBtn = screen
      .getAllByTestId("resource-type")
      .find((el) => el.dataset.gvr === "/v1/services") as HTMLElement;
    await userEvent.click(svcBtn);

    await waitFor(() => expect(screen.getByText("api-gateway-svc")).toBeInTheDocument());
    await userEvent.click(screen.getByTestId("resource-row"));

    expect(await screen.findByTestId("service-ports-section")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("open-forward-80"));

    // Privileged port 80 pre-fills with smart default 8080
    const input = screen.getByTestId("forward-local-input-80") as HTMLInputElement;
    expect(input.value).toBe("8080");

    await userEvent.click(screen.getByTestId("confirm-forward-80"));
    expect(await screen.findByTestId("active-forward-80")).toHaveTextContent("127.0.0.1:8080");
    expect(startedForwards).toContainEqual(
      expect.objectContaining({
        kind: "Service",
        name: "api-gateway-svc",
        remotePort: 80,
        localPort: 8080,
      }),
    );

    // Status bar badge shows FORWARDS (1) and clicking it opens the Port Forwards manager view
    const statusBadge = await screen.findByTestId("active-forwards-badge");
    expect(statusBadge).toHaveTextContent("FORWARDS (1)");
    await userEvent.click(statusBadge);

    const view = await screen.findByTestId("port-forwards-view");
    expect(view).toHaveTextContent("http://127.0.0.1:8080");
    expect(view).toHaveTextContent("api-gateway-74ffdb8b8f-g4k6d");

    await userEvent.click(screen.getByTestId("stop-forward-id-pf-1"));
    await waitFor(() =>
      expect(screen.queryByTestId("port-forward-row-pf-1")).not.toBeInTheDocument(),
    );
    expect(stoppedForwards).toContain("pf-1");
  });

  it("preserves the active inner detail tab when opening in a full workspace tab and collapses split detail on outside click", async () => {
    setIpcTransport({
      invoke: (async (command: string, args: unknown) => {
        if (command === "list_contexts") return [ctx("kind-dev")];
        if (command === "discover_resources") return [pods];
        if (command === "list_resources") {
          return [
            {
              uid: "p-1",
              name: "web-1",
              namespace: "default",
              kind: "Pod",
              createdAt: "2026-01-01T00:00:00Z",
              labels: {},
              status: "Running",
            },
            {
              uid: "p-2",
              name: "web-2",
              namespace: "default",
              kind: "Pod",
              createdAt: "2026-01-01T00:01:00Z",
              labels: {},
              status: "Running",
            },
          ];
        }
        if (command === "get_resource") {
          const req = args as { name: string };
          return {
            contextId: "kind-dev",
            gvr: "/v1/pods",
            name: req.name,
            namespace: "default",
            yaml: `apiVersion: v1\nkind: Pod\nmetadata:\n  name: ${req.name}\n  namespace: default\nspec:\n  containers:\n  - image: nginx:alpine\n    name: nginx`,
            maskedPaths: [],
          };
        }
        if (command === "get_pod_logs") {
          return {
            contextId: "kind-dev",
            gvr: "/v1/pods",
            name: "web-1",
            namespace: "default",
            pods: ["web-1"],
            containers: ["nginx"],
            chunks: [
              {
                podName: "web-1",
                containerName: "nginx",
                logs: "2026-11-19T06:00:00.000Z live log line\n",
              },
            ],
          };
        }
        return null;
      }) as IpcTransport["invoke"],
      listen: (async () => () => {}) as IpcTransport["listen"],
    });

    renderWithQuery(<App />);
    await waitFor(() => expect(screen.getByTestId("open-cluster")).toBeInTheDocument());
    await userEvent.click(screen.getByTestId("open-cluster"));
    await waitFor(() => expect(screen.getByTestId("explorer-placeholder")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "WorkLoad" }));

    const podBtn = screen
      .getAllByTestId("resource-type")
      .find((el) => el.dataset.gvr === "/v1/pods") as HTMLElement;
    await userEvent.click(podBtn);
    await waitFor(() => expect(screen.getByText("web-1")).toBeInTheDocument());

    const rows = screen.getAllByTestId("resource-row");
    await userEvent.click(rows[0]!);
    expect(await screen.findByTestId("resource-detail")).toBeInTheDocument();

    // Clicking outside the detail panel (e.g., on the table container) collapses it
    await userEvent.click(screen.getByTestId("resource-table"));
    await waitFor(() => expect(screen.queryByTestId("resource-detail")).not.toBeInTheDocument());

    // Open row again, switch to Logs tab, then expand to full workspace tab
    await userEvent.click(screen.getAllByTestId("resource-row")[0]!);
    expect(await screen.findByTestId("resource-detail")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("detail-tab-logs"));
    expect(await screen.findByTestId("detail-logs")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Open in workspace tab" }));

    // Full workspace tab opens directly on Logs (not reset back to Overview)
    expect(await screen.findByTestId("detail-logs")).toBeInTheDocument();
    expect(screen.queryByTestId("detail-overview")).not.toBeInTheDocument();
  });

  it("renders real Events empty state and Metrics Server unavailable notice with real container spec quotas", async () => {
    setIpcTransport({
      invoke: (async (command: string) => {
        if (command === "get_resource") {
          return {
            contextId: "kind-dev",
            gvr: "/v1/pods",
            name: "worker-0",
            namespace: "default",
            yaml: [
              "apiVersion: v1",
              "kind: Pod",
              "metadata:",
              "  name: worker-0",
              "  namespace: default",
              "spec:",
              "  containers:",
              "  - name: worker",
              "    image: busybox:1.36",
              "    resources:",
              "      requests:",
              "        cpu: 100m",
              "        memory: 128Mi",
              "      limits:",
              "        cpu: 250m",
              "        memory: 256Mi",
            ].join("\n"),
            maskedPaths: [],
          };
        }
        if (command === "get_resource_events") return [];
        if (command === "get_resource_metrics") {
          return {
            contextId: "kind-dev",
            metricsServerAvailable: false,
            statusMessage: "Metrics Server (metrics.k8s.io/v1beta1) is not installed on this cluster.",
            timestamp: "",
            windowSeconds: 15,
            totalCpuMillicores: 0,
            totalMemoryMib: 0,
            podCount: 0,
            containers: [],
          };
        }
        return null;
      }) as IpcTransport["invoke"],
      listen: (async () => () => {}) as IpcTransport["listen"],
    });

    renderWithQuery(
      <ResourceDetail
        contextId="kind-dev"
        gvr="/v1/pods"
        name="worker-0"
        namespace="default"
        initialTab="events"
        onClose={() => {}}
      />,
    );

    expect(await screen.findByTestId("events-empty")).toHaveTextContent(
      "No recent Kubernetes events for Pod/worker-0.",
    );

    await userEvent.click(screen.getByTestId("detail-tab-metrics"));
    expect(await screen.findByTestId("metrics-server-unavailable")).toHaveTextContent(
      "Metrics Server not installed",
    );
    expect(screen.getByText("100m / 250m")).toBeInTheDocument();
    expect(screen.getByText("128Mi / 256Mi")).toBeInTheDocument();
    expect(screen.queryByText(/req 50m/)).not.toBeInTheDocument();
  });

  it("loads real cluster overview telemetry (nodes, pods, deployments, events) immediately on connect", async () => {
    setIpcTransport({
      invoke: (async (command: string) => {
        switch (command) {
          case "list_contexts":
            return [ctx("kind-dev")];
          case "discover_resources":
            return [pods, deployments];
          case "get_cluster_overview":
            return {
              contextId: "kind-dev",
              readyNodes: 1,
              totalNodes: 1,
              namespaceCount: 5,
              runningPods: 9,
              totalPods: 10,
              healthyDeployments: 2,
              totalDeployments: 2,
              nodes: [
                {
                  name: "kubix-dev-control-plane",
                  ready: true,
                  kubeletVersion: "v1.31.0",
                  roles: "control-plane",
                  cpuCapacity: "8",
                  memoryCapacity: "15.6 GiB",
                  createdAt: "2026-11-18T20:00:00Z",
                },
              ],
              recentEvents: [
                {
                  uid: "ev-cluster-1",
                  eventType: "Warning",
                  reason: "BackOff",
                  involvedObject: "Pod/api-0",
                  namespace: "kubix-demo",
                  from: "kubelet",
                  message: "Back-off restarting failed container",
                  count: 3,
                  createdAt: "2026-11-21T06:05:00Z",
                },
              ],
            };
          default:
            return null;
        }
      }) as IpcTransport["invoke"],
      listen: (async () => () => {}) as IpcTransport["listen"],
    });

    renderWithQuery(<App />);
    await waitFor(() => expect(screen.getByTestId("open-cluster")).toBeInTheDocument());
    await userEvent.click(screen.getByTestId("open-cluster"));

    expect(await screen.findByTestId("overview-node-kubix-dev-control-plane")).toBeInTheDocument();
    expect(screen.getByText("9 / 10")).toBeInTheDocument();
    expect(screen.getByText(/2\/2 Deployments ready/)).toBeInTheDocument();
    expect(await screen.findByTestId("overview-event-row")).toHaveTextContent(
      "Back-off restarting failed container",
    );
  });

  it("toggles previous container logs (--previous), pauses live polling, and resets on resource switch", async () => {
    const logCalls: Array<Record<string, unknown>> = [];
    setIpcTransport({
      invoke: (async (command: string, args?: Record<string, unknown>) => {
        if (command === "get_resource") {
          const resName = String(args?.name ?? "crash-pod-0");
          return {
            contextId: "kind-dev",
            gvr: "/v1/pods",
            name: resName,
            namespace: "default",
            yaml: `apiVersion: v1\nkind: Pod\nmetadata:\n  name: ${resName}\n  namespace: default\nspec:\n  containers:\n  - name: app\n    image: nginx:1.27\n`,
            maskedPaths: [],
          };
        }
        if (command === "get_pod_logs") {
          logCalls.push(args ?? {});
          const isPrev = Boolean(args?.previous);
          return {
            contextId: "kind-dev",
            gvr: "/v1/pods",
            name: String(args?.name ?? "crash-pod-0"),
            namespace: "default",
            pods: [String(args?.name ?? "crash-pod-0")],
            containers: ["app"],
            initContainers: [],
            chunks: [
              {
                podName: String(args?.name ?? "crash-pod-0"),
                containerName: "app",
                logs: isPrev
                  ? "2026-11-21T07:00:00Z fatal: OOMKilled before restart"
                  : "2026-11-21T07:05:00Z info: server started cleanly",
              },
            ],
          };
        }
        return null;
      }) as IpcTransport["invoke"],
      listen: (async () => () => {}) as IpcTransport["listen"],
    });

    function SwitchPodHarness() {
      const [podName, setPodName] = useState("crash-pod-0");
      return (
        <>
          <button type="button" onClick={() => setPodName("healthy-pod-1")}>
            Switch Pod
          </button>
          <ResourceDetail
            contextId="kind-dev"
            gvr="/v1/pods"
            name={podName}
            namespace="default"
            initialTab="logs"
            onClose={() => {}}
          />
        </>
      );
    }

    renderWithQuery(<SwitchPodHarness />);

    expect(await screen.findByText(/server started cleanly/)).toBeInTheDocument();
    const prevBtn = screen.getByTestId("toggle-previous-logs");
    expect(prevBtn).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: /^Live$/i })).toBeInTheDocument();
    expect(logCalls.some((c) => c.name === "crash-pod-0" && !c.previous)).toBe(true);

    await userEvent.click(prevBtn);
    expect(prevBtn).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /^Paused$/i })).toBeInTheDocument();
    expect(await screen.findByText(/OOMKilled before restart/)).toBeInTheDocument();
    expect(logCalls.some((c) => c.name === "crash-pod-0" && c.previous === true)).toBe(true);

    // Switching to another pod must reset Previous back to false
    await userEvent.click(screen.getByRole("button", { name: "Switch Pod" }));

    await waitFor(() => {
      expect(screen.getByTestId("toggle-previous-logs")).toHaveAttribute("aria-pressed", "false");
    });
    expect(await screen.findByText(/server started cleanly/)).toBeInTheDocument();
    expect(logCalls.some((c) => c.name === "healthy-pod-1" && !c.previous)).toBe(true);
  });

  it("renders clickable cross-resource links in ResourceDetail Overview (cluster-scoped Node vs namespaced refs)", async () => {
    setIpcTransport({
      invoke: (async (command: string) => {
        if (command === "get_resource") {
          return {
            contextId: "kind-dev",
            gvr: "/v1/pods",
            name: "api-gateway-6f7d8b-abc",
            namespace: "kubix-demo",
            yaml: `apiVersion: v1
kind: Pod
metadata:
  name: api-gateway-6f7d8b-abc
  namespace: kubix-demo
  ownerReferences:
  - apiVersion: apps/v1
    kind: ReplicaSet
    name: api-gateway-6f7d8b
spec:
  serviceAccountName: api-sa
  nodeName: worker-1
  containers:
  - name: app
    image: nginx:1.27
  volumes:
  - name: cfg
    configMap:
      name: app-config
  - name: creds
    secret:
      secretName: db-creds
`,
            maskedPaths: [],
          };
        }
        return null;
      }) as IpcTransport["invoke"],
      listen: (async () => () => {}) as IpcTransport["listen"],
    });

    const onNavigate = vi.fn();
    renderWithQuery(
      <ResourceDetail
        contextId="kind-dev"
        gvr="/v1/pods"
        name="api-gateway-6f7d8b-abc"
        namespace="kubix-demo"
        initialTab="overview"
        onNavigateResource={onNavigate}
        onClose={() => {}}
      />,
    );

    const nodeLink = await screen.findByTestId("nav-link-node");
    await userEvent.click(nodeLink);
    expect(onNavigate).toHaveBeenCalledWith({
      kind: "Node",
      gvr: "/v1/nodes",
      name: "worker-1",
      namespace: undefined,
    });

    await userEvent.click(screen.getByTestId("nav-link-serviceaccount"));
    expect(onNavigate).toHaveBeenCalledWith({
      kind: "ServiceAccount",
      gvr: "/v1/serviceaccounts",
      name: "api-sa",
      namespace: "kubix-demo",
    });

    await userEvent.click(screen.getByTestId("nav-link-owner-api-gateway-6f7d8b"));
    expect(onNavigate).toHaveBeenCalledWith({
      kind: "ReplicaSet",
      gvr: "apps/v1/replicasets",
      name: "api-gateway-6f7d8b",
      namespace: "kubix-demo",
    });

    await userEvent.click(screen.getByTestId("nav-link-configmap-app-config"));
    expect(onNavigate).toHaveBeenCalledWith({
      kind: "ConfigMap",
      gvr: "/v1/configmaps",
      name: "app-config",
      namespace: "kubix-demo",
    });

    await userEvent.click(screen.getByTestId("nav-link-secret-db-creds"));
    expect(onNavigate).toHaveBeenCalledWith({
      kind: "Secret",
      gvr: "/v1/secrets",
      name: "db-creds",
      namespace: "kubix-demo",
    });
  });

  it("opens non-focus TopologyCanvas cards only via explicit topology open button, not card click", async () => {
    const onSelect = vi.fn();
    const onOpen = vi.fn();
    const manifestYaml = `apiVersion: v1
kind: Pod
metadata:
  name: api-0
  namespace: default
  ownerReferences:
  - apiVersion: apps/v1
    kind: ReplicaSet
    name: api-rs-1
spec:
  serviceAccountName: default
  nodeName: worker-1
  containers:
  - name: app
    image: nginx:1.27
`;

    renderWithQuery(
      <TopologyCanvas
        compact
        contextId="kind-dev"
        namespace="default"
        manifestYaml={manifestYaml}
        focusResource={{ kind: "Pod", name: "api-0", namespace: "default" }}
        onSelectNode={onSelect}
        onOpenNode={onOpen}
      />,
    );

    // Focus pod card should not render an Open button
    expect(screen.queryByTestId("topology-open-node-focus-pod")).not.toBeInTheDocument();

    // Clicking a non-focus node body selects it without triggering navigation
    const nodeCard = screen.getByText("worker-1").closest("[data-topology-node]") as HTMLElement;
    expect(nodeCard).toBeTruthy();
    await userEvent.click(nodeCard);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();

    // Clicking the explicit Open button navigates to that node
    const openBtn = within(nodeCard).getByRole("button", { name: /Open Node worker-1/i });
    await userEvent.click(openBtn);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ kind: "Node", name: "worker-1" }));
  });

  it("navigates across resources without opening extra watches and traverses navigation history with Back/Forward", async () => {
    const listCalls: Array<Record<string, unknown>> = [];
    const getCalls: Array<Record<string, unknown>> = [];

    setIpcTransport({
      invoke: (async (command: string, args?: Record<string, unknown>) => {
        switch (command) {
          case "list_contexts":
            return [ctx("kind-dev")];
          case "discover_resources":
            return [
              pods,
              {
                gvr: "/v1/nodes",
                kind: "Node",
                group: "",
                version: "v1",
                plural: "nodes",
                namespaced: false,
                shortNames: ["no"],
                verbs: ["get", "list", "watch"],
                curated: true,
              },
            ];
          case "get_cluster_overview":
            return {
              contextId: "kind-dev",
              readyNodes: 1,
              totalNodes: 1,
              namespaceCount: 1,
              runningPods: 1,
              totalPods: 1,
              healthyDeployments: 0,
              totalDeployments: 0,
              nodes: [],
              recentEvents: [],
            };
          case "list_resources":
            listCalls.push(args ?? {});
            return [
              {
                uid: "pod-uid-1",
                name: "web-0",
                namespace: "default",
                kind: "Pod",
                createdAt: "2026-11-21T06:00:00Z",
                status: "Running",
                ready: "1/1",
                restarts: 0,
              },
            ];
          case "get_resource":
            getCalls.push(args ?? {});
            if (args?.gvr === "/v1/nodes") {
              return {
                contextId: "kind-dev",
                gvr: "/v1/nodes",
                name: "worker-1",
                namespace: undefined,
                yaml: "apiVersion: v1\nkind: Node\nmetadata:\n  name: worker-1\nstatus:\n  phase: Ready\n",
                maskedPaths: [],
              };
            }
            return {
              contextId: "kind-dev",
              gvr: "/v1/pods",
              name: "web-0",
              namespace: "default",
              yaml: "apiVersion: v1\nkind: Pod\nmetadata:\n  name: web-0\n  namespace: default\nspec:\n  nodeName: worker-1\n  serviceAccountName: default\n  containers:\n  - name: app\n    image: nginx:1.27\n",
              maskedPaths: [],
            };
          default:
            return null;
        }
      }) as IpcTransport["invoke"],
      listen: (async () => () => {}) as IpcTransport["listen"],
    });

    renderWithQuery(<App />);
    await waitFor(() => expect(screen.getByTestId("open-cluster")).toBeInTheDocument());
    await userEvent.click(screen.getByTestId("open-cluster"));

    // Open Pods list and select web-0
    await userEvent.click(await screen.findByRole("button", { name: "WorkLoad" }));
    await waitFor(() =>
      expect(screen.getAllByTestId("resource-type").some((el) => el.dataset.gvr === "/v1/pods")).toBe(
        true,
      ),
    );
    const podNav = screen
      .getAllByTestId("resource-type")
      .find((el) => el.dataset.gvr === "/v1/pods") as HTMLElement;
    await userEvent.click(podNav);
    const podRow = await screen.findByText("web-0");
    await userEvent.click(podRow);

    // Click Node link inside split ResourceDetail Overview
    const nodeLink = await screen.findByTestId("nav-link-node");
    await userEvent.click(nodeLink);

    // Should open Node detail directly via get_resource without calling list_resources for /v1/nodes
    await waitFor(() => {
      expect(getCalls.some((c) => c.gvr === "/v1/nodes" && c.name === "worker-1")).toBe(true);
    });
    expect(listCalls.some((c) => c.gvr === "/v1/nodes")).toBe(false);
    expect(await screen.findByTestId("resource-detail")).toHaveTextContent("worker-1");

    // Top-bar Back returns to prior view and enables Forward
    const backBtn = screen.getByRole("button", { name: "Navigate back" });
    const forwardBtn = screen.getByRole("button", { name: "Navigate forward" });
    expect(backBtn).toBeEnabled();
    expect(forwardBtn).toBeDisabled();

    await userEvent.click(backBtn);
    await waitFor(() => {
      expect(forwardBtn).toBeEnabled();
    });
    expect(await screen.findByTestId("resource-detail")).toHaveTextContent("web-0");

    // Top-bar Forward returns to Node worker-1 detail
    await userEvent.click(forwardBtn);
    expect(await screen.findByTestId("resource-detail")).toHaveTextContent("worker-1");
  });

  it("searches active-context loaded resources in Cmd+K with uid deduplication and jumps straight to detail", async () => {
    const getCalls: Array<Record<string, unknown>> = [];

    setIpcTransport({
      invoke: (async (command: string, args?: Record<string, unknown>) => {
        switch (command) {
          case "list_contexts":
            return [ctx("kind-dev"), ctx("prod-other")];
          case "discover_resources":
            return [pods, deployments];
          case "get_cluster_overview":
            return {
              contextId: "kind-dev",
              readyNodes: 1,
              totalNodes: 1,
              namespaceCount: 2,
              runningPods: 2,
              totalPods: 2,
              healthyDeployments: 1,
              totalDeployments: 1,
              nodes: [],
              recentEvents: [],
            };
          case "get_resource":
            getCalls.push(args ?? {});
            return {
              contextId: "kind-dev",
              gvr: String(args?.gvr ?? "apps/v1/deployments"),
              name: String(args?.name ?? "api-gateway"),
              namespace: String(args?.namespace ?? "kubix-demo"),
              yaml: `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: ${String(args?.name ?? "api-gateway")}\n  namespace: ${String(args?.namespace ?? "kubix-demo")}\nspec:\n  replicas: 2\n`,
              maskedPaths: [],
            };
          default:
            return null;
        }
      }) as IpcTransport["invoke"],
      listen: (async () => () => {}) as IpcTransport["listen"],
    });

    // Seed loaded views across both namespace-scoped and all-namespaces (duplicate uid) plus another context
    useExplorerStore.getState().finishLoad(
      { contextId: "kind-dev", gvr: "apps/v1/deployments", namespace: "kubix-demo" },
      [
        {
          uid: "dep-api-gw",
          name: "api-gateway",
          namespace: "kubix-demo",
          kind: "Deployment",
          createdAt: "2026-11-21T06:00:00Z",
          labels: {},
          status: "2/2",
        },
      ],
    );
    useExplorerStore.getState().finishLoad(
      { contextId: "kind-dev", gvr: "apps/v1/deployments", namespace: "" },
      [
        {
          uid: "dep-api-gw",
          name: "api-gateway",
          namespace: "kubix-demo",
          kind: "Deployment",
          createdAt: "2026-11-21T06:00:00Z",
          labels: {},
          status: "2/2",
        },
      ],
    );
    useExplorerStore.getState().finishLoad(
      { contextId: "prod-other", gvr: "/v1/pods", namespace: "prod" },
      [
        {
          uid: "pod-other-ctx",
          name: "api-gateway-other-cluster",
          namespace: "prod",
          kind: "Pod",
          createdAt: "2026-11-21T06:00:00Z",
          labels: {},
          status: "Running",
        },
      ],
    );

    renderWithQuery(<App />);
    await waitFor(() => expect(screen.getAllByTestId("open-cluster").length).toBeGreaterThan(0));
    await userEvent.click(screen.getAllByTestId("open-cluster")[0]!);
    await waitFor(() => expect(screen.getByTestId("explorer-placeholder")).toBeInTheDocument());

    const searchInput = screen.getByLabelText("Global quick search");
    await userEvent.click(searchInput);
    await userEvent.type(searchInput, "api-gateway");

    const instancesSection = await screen.findByTestId("command-palette-instances");
    // Deduplicated: only 1 button for dep-api-gw
    expect(within(instancesSection).getAllByTestId("command-instance-dep-api-gw")).toHaveLength(1);
    expect(instancesSection).toHaveTextContent("api-gateway");
    expect(instancesSection).toHaveTextContent("kubix-demo");
    // Context-isolated: never leaks prod-other rows
    expect(instancesSection).not.toHaveTextContent("api-gateway-other-cluster");

    // Clicking the loaded resource opens its ResourceDetail directly
    await userEvent.click(within(instancesSection).getByTestId("command-instance-dep-api-gw"));
    await waitFor(() => {
      expect(
        getCalls.some(
          (c) =>
            c.gvr === "apps/v1/deployments" &&
            c.name === "api-gateway" &&
            c.namespace === "kubix-demo",
        ),
      ).toBe(true);
    });
    expect(await screen.findByTestId("resource-detail")).toHaveTextContent("api-gateway");
    expect(screen.queryByTestId("command-palette-instances")).not.toBeInTheDocument();
  });

  it("does not render Open button on placeholder or template-container cards in TopologyCanvas", () => {
    const onOpen = vi.fn();
    const deployYaml = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-gateway
  namespace: kubix-demo
spec:
  replicas: 2
  template:
    spec:
      containers:
      - name: nginx-proxy
        image: nginx:1.27
`;

    const { unmount } = renderWithQuery(
      <TopologyCanvas
        compact
        contextId="kind-dev"
        namespace="kubix-demo"
        manifestYaml={deployYaml}
        focusResource={{ kind: "Deployment", name: "api-gateway", namespace: "kubix-demo" }}
        onOpenNode={onOpen}
      />,
    );

    // Template container card is a placeholder (not a real Pod named nginx-proxy)
    const tmplCard = screen.getByText("nginx-proxy").closest("[data-topology-node]") as HTMLElement;
    expect(tmplCard).toBeTruthy();
    expect(within(tmplCard).queryByRole("button", { name: /Open/i })).not.toBeInTheDocument();
    unmount();

    // Cluster-level Topology with zero loaded rows renders static blueprint placeholders without Open
    renderWithQuery(
      <TopologyCanvas
        contextId="kind-dev"
        contextName="kind-dev"
        namespace="default"
        rows={[]}
        onOpenNode={onOpen}
      />,
    );
    expect(screen.queryByRole("button", { name: /^Open /i })).not.toBeInTheDocument();
  });

  it("returns to same resource list from jumped detail tab, preserves cross-GVR split selection & specialView on Back, and syncs history on tab close", async () => {
    setIpcTransport({
      invoke: (async (command: string, args?: Record<string, unknown>) => {
        switch (command) {
          case "list_contexts":
            return [ctx("kind-dev")];
          case "discover_resources":
            return [
              pods,
              deployments,
              {
                gvr: "/v1/nodes",
                kind: "Node",
                group: "",
                version: "v1",
                plural: "nodes",
                namespaced: false,
                shortNames: ["no"],
                verbs: ["get", "list", "watch"],
                curated: true,
              },
            ];
          case "get_cluster_overview":
            return {
              contextId: "kind-dev",
              readyNodes: 1,
              totalNodes: 1,
              namespaceCount: 1,
              runningPods: 1,
              totalPods: 1,
              healthyDeployments: 1,
              totalDeployments: 1,
              nodes: [],
              recentEvents: [],
            };
          case "list_resources":
            if (args?.gvr === "apps/v1/deployments") {
              return [
                {
                  uid: "dep-1",
                  name: "frontend",
                  namespace: "default",
                  kind: "Deployment",
                  createdAt: "2026-11-21T06:00:00Z",
                  labels: {},
                  status: "1/1",
                },
              ];
            }
            return [
              {
                uid: "pod-1",
                name: "web-0",
                namespace: "default",
                kind: "Pod",
                createdAt: "2026-11-21T06:00:00Z",
                labels: {},
                status: "Running",
                ready: "1/1",
                restarts: 0,
              },
            ];
          case "get_resource":
            if (args?.gvr === "/v1/nodes") {
              return {
                contextId: "kind-dev",
                gvr: "/v1/nodes",
                name: "worker-1",
                namespace: undefined,
                yaml: "apiVersion: v1\nkind: Node\nmetadata:\n  name: worker-1\n",
                maskedPaths: [],
              };
            }
            return {
              contextId: "kind-dev",
              gvr: "/v1/pods",
              name: "web-0",
              namespace: "default",
              yaml: "apiVersion: v1\nkind: Pod\nmetadata:\n  name: web-0\n  namespace: default\nspec:\n  nodeName: worker-1\n  serviceAccountName: default\n  containers:\n  - name: app\n    image: nginx:1.27\n",
              maskedPaths: [],
            };
          default:
            return null;
        }
      }) as IpcTransport["invoke"],
      listen: (async () => () => {}) as IpcTransport["listen"],
    });

    renderWithQuery(<App />);
    await waitFor(() => expect(screen.getByTestId("open-cluster")).toBeInTheDocument());
    await userEvent.click(screen.getByTestId("open-cluster"));

    // 1. Open Pods -> select web-0 -> jump to Node worker-1
    await userEvent.click(await screen.findByRole("button", { name: "WorkLoad" }));
    const podNav = screen
      .getAllByTestId("resource-type")
      .find((el) => el.dataset.gvr === "/v1/pods") as HTMLElement;
    const deployNav = screen
      .getAllByTestId("resource-type")
      .find((el) => el.dataset.gvr === "apps/v1/deployments") as HTMLElement;

    await userEvent.click(podNav);
    await userEvent.click(await screen.findByText("web-0"));
    await userEvent.click(await screen.findByTestId("nav-link-node"));
    expect(await screen.findByTestId("resource-detail")).toHaveTextContent("worker-1");

    // 2. Re-clicking Pods in the sidebar while on detail(Node) must return to Pods list (not no-op!)
    await userEvent.click(podNav);
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Pods" })).toBeInTheDocument();
    });

    // 3. Re-select web-0 -> jump to Node -> navigate to Deployments -> Back -> Back restores web-0 split detail
    await userEvent.click(await screen.findByText("web-0"));
    await userEvent.click(await screen.findByTestId("nav-link-node"));
    expect(await screen.findByTestId("resource-detail")).toHaveTextContent("worker-1");

    await userEvent.click(deployNav);
    expect(await screen.findByRole("heading", { name: "Deployments" })).toBeInTheDocument();

    const backBtn = screen.getByRole("button", { name: "Navigate back" });
    await userEvent.click(backBtn);
    expect(await screen.findByTestId("resource-detail")).toHaveTextContent("worker-1");

    await userEvent.click(backBtn);
    expect(await screen.findByTestId("resource-detail")).toHaveTextContent("web-0");

    // 4. Jump to Node -> click Security -> Back -> re-click Security (must not be stuck on stale specialView)
    await userEvent.click(await screen.findByTestId("nav-link-node"));
    expect(await screen.findByTestId("resource-detail")).toHaveTextContent("worker-1");
    const sidebarNav = screen.getByRole("navigation", { name: "Resource types" });
    await userEvent.click(within(sidebarNav).getByText("Security"));
    expect(await screen.findByText(/Cluster Mutation Guard/i)).toBeInTheDocument();

    await userEvent.click(backBtn);
    expect(await screen.findByTestId("resource-detail")).toHaveTextContent("worker-1");

    await userEvent.click(within(sidebarNav).getByText("Security"));
    expect(await screen.findByText(/Cluster Mutation Guard/i)).toBeInTheDocument();

    // 5. Back to detail(worker-1) -> close detail tab via X -> Forward must stay disabled (synced history)
    await userEvent.click(backBtn);
    expect(await screen.findByTestId("resource-detail")).toHaveTextContent("worker-1");
    await userEvent.click(screen.getByRole("button", { name: /Close tab worker-1/i }));
    await waitFor(() => {
      expect(screen.queryByTestId("resource-detail")).not.toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Navigate forward" })).toBeDisabled();
  });

  it("auto-scrolls logs to the newest line at the bottom, pauses auto-scroll when scrolled up, and provides Jump to latest", async () => {
    setIpcTransport({
      invoke: (async (command: string) => {
        if (command === "get_resource") {
          return {
            contextId: "kind-dev",
            gvr: "/v1/pods",
            name: "stream-pod",
            namespace: "default",
            yaml: "apiVersion: v1\nkind: Pod\nmetadata:\n  name: stream-pod\n  namespace: default\nspec:\n  containers:\n  - name: app\n    image: nginx:1.27\n",
            maskedPaths: [],
          };
        }
        if (command === "get_pod_logs") {
          return {
            contextId: "kind-dev",
            gvr: "/v1/pods",
            name: "stream-pod",
            namespace: "default",
            pods: ["stream-pod"],
            containers: ["app"],
            initContainers: [],
            chunks: [
              {
                podName: "stream-pod",
                containerName: "app",
                logs: [
                  "2026-11-21T07:00:00Z oldest line",
                  "2026-11-21T07:01:00Z middle line",
                  "2026-11-21T07:02:00Z newest line",
                ].join("\n"),
              },
            ],
          };
        }
        return null;
      }) as IpcTransport["invoke"],
      listen: (async () => () => {}) as IpcTransport["listen"],
    });

    renderWithQuery(
      <ResourceDetail
        contextId="kind-dev"
        gvr="/v1/pods"
        name="stream-pod"
        namespace="default"
        initialTab="logs"
        onClose={() => {}}
      />,
    );

    const scroller = await screen.findByTestId("logs-scroll-container");
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 1200 });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 300 });

    // Wait for logs to render; newest line is last and scrollTop snaps to scrollHeight
    expect(await screen.findByText(/newest line/)).toBeInTheDocument();
    await waitFor(() => {
      expect(scroller.scrollTop).toBe(1200);
    });
    expect(screen.queryByTestId("scroll-logs-bottom")).not.toBeInTheDocument();

    // User scrolls up to read older logs -> Jump to latest button appears
    scroller.scrollTop = 100;
    fireEvent.scroll(scroller);
    const jumpBtn = await screen.findByTestId("scroll-logs-bottom");
    expect(jumpBtn).toBeInTheDocument();

    // Clicking Jump to latest snaps back to the bottom and hides the button
    await userEvent.click(jumpBtn);
    await waitFor(() => {
      expect(scroller.scrollTop).toBe(1200);
      expect(screen.queryByTestId("scroll-logs-bottom")).not.toBeInTheDocument();
    });
  });

  it("shows the Topology tab only for Workloads and Network resources (Service, Ingress, HPA) and hides it for Config/Node/RBAC", async () => {
    setIpcTransport({
      invoke: (async (command: string, args?: Record<string, unknown>) => {
        if (command === "get_resource") {
          const gvr = String(args?.gvr ?? "");
          const name = String(args?.name ?? "res");
          const kind =
            gvr === "/v1/services"
              ? "Service"
              : gvr === "networking.k8s.io/v1/ingresses"
                ? "Ingress"
                : gvr === "/v1/configmaps"
                  ? "ConfigMap"
                  : gvr === "/v1/nodes"
                    ? "Node"
                    : "Pod";
          return {
            contextId: "kind-dev",
            gvr,
            name,
            namespace: kind === "Node" ? undefined : "default",
            yaml: `apiVersion: v1\nkind: ${kind}\nmetadata:\n  name: ${name}\n`,
            maskedPaths: [],
          };
        }
        return null;
      }) as IpcTransport["invoke"],
      listen: (async () => () => {}) as IpcTransport["listen"],
    });

    // ConfigMap -> NO Topology tab
    const cm = renderWithQuery(
      <ResourceDetail
        contextId="kind-dev"
        gvr="/v1/configmaps"
        name="app-config"
        namespace="default"
        initialTab="overview"
        onClose={() => {}}
      />,
    );
    expect(await screen.findByTestId("detail-overview")).toBeInTheDocument();
    expect(screen.queryByTestId("detail-tab-topology")).not.toBeInTheDocument();
    cm.unmount();

    // Node -> NO Topology tab
    const node = renderWithQuery(
      <ResourceDetail
        contextId="kind-dev"
        gvr="/v1/nodes"
        name="worker-1"
        initialTab="overview"
        onClose={() => {}}
      />,
    );
    expect(await screen.findByTestId("detail-overview")).toBeInTheDocument();
    expect(screen.queryByTestId("detail-tab-topology")).not.toBeInTheDocument();
    node.unmount();

    // Service -> SHOWS Topology tab
    const svc = renderWithQuery(
      <ResourceDetail
        contextId="kind-dev"
        gvr="/v1/services"
        name="api-gateway-svc"
        namespace="default"
        initialTab="overview"
        onClose={() => {}}
      />,
    );
    expect(await screen.findByTestId("detail-overview")).toBeInTheDocument();
    expect(screen.getByTestId("detail-tab-topology")).toBeInTheDocument();
    svc.unmount();

    // Ingress -> SHOWS Topology tab
    renderWithQuery(
      <ResourceDetail
        contextId="kind-dev"
        gvr="networking.k8s.io/v1/ingresses"
        name="public-edge"
        namespace="default"
        initialTab="overview"
        onClose={() => {}}
      />,
    );
    expect(await screen.findByTestId("detail-overview")).toBeInTheDocument();
    expect(screen.getByTestId("detail-tab-topology")).toBeInTheDocument();
  });

  it("renders real selector/backend/scaleTarget topology links for Service, Ingress, and HorizontalPodAutoscaler", async () => {
    const onOpen = vi.fn();

    // Seed loaded Pods for Service selector matching
    useExplorerStore.getState().finishLoad(
      { contextId: "kind-dev", gvr: "/v1/pods", namespace: "kubix-demo" },
      [
        {
          uid: "pod-gw-1",
          name: "api-gateway-6f7d8b-1",
          namespace: "kubix-demo",
          kind: "Pod",
          createdAt: "2026-11-21T06:00:00Z",
          labels: { app: "api-gateway", tier: "edge" },
          status: "Running",
        },
        {
          uid: "pod-other",
          name: "redis-0",
          namespace: "kubix-demo",
          kind: "Pod",
          createdAt: "2026-11-21T06:00:00Z",
          labels: { app: "redis" },
          status: "Running",
        },
      ],
    );

    // 1. Service -> matched Pods via spec.selector (alphabetical serde_yaml key order)
    const serviceYaml = `apiVersion: v1
kind: Service
metadata:
  name: api-gateway-svc
  namespace: kubix-demo
spec:
  clusterIP: 10.96.10.5
  ports:
  - port: 80
    protocol: TCP
    targetPort: 8080
  selector:
    app: api-gateway
  type: ClusterIP
`;
    const svcView = renderWithQuery(
      <TopologyCanvas
        compact
        contextId="kind-dev"
        namespace="kubix-demo"
        manifestYaml={serviceYaml}
        focusResource={{ kind: "Service", name: "api-gateway-svc", namespace: "kubix-demo" }}
        onOpenNode={onOpen}
      />,
    );
    expect(screen.getByText("api-gateway-6f7d8b-1")).toBeInTheDocument();
    expect(screen.queryByText("redis-0")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Open Pod api-gateway-6f7d8b-1/i }));
    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "Pod", name: "api-gateway-6f7d8b-1", namespace: "kubix-demo" }),
    );
    svcView.unmount();

    // 2. Ingress -> backend Service via networking.k8s.io/v1 rules
    const ingressYaml = `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: public-edge
  namespace: kubix-demo
spec:
  rules:
  - host: api.kubix.local
    http:
      paths:
      - backend:
          service:
            name: api-gateway-svc
            port:
              number: 80
        path: /
        pathType: Prefix
`;
    const ingView = renderWithQuery(
      <TopologyCanvas
        compact
        contextId="kind-dev"
        namespace="kubix-demo"
        manifestYaml={ingressYaml}
        focusResource={{ kind: "Ingress", name: "public-edge", namespace: "kubix-demo" }}
        onOpenNode={onOpen}
      />,
    );
    expect(screen.getByText("api-gateway-svc")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Open Service api-gateway-svc/i }));
    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "Service", name: "api-gateway-svc", namespace: "kubix-demo" }),
    );
    ingView.unmount();

    // 3. HorizontalPodAutoscaler -> scaleTargetRef Deployment
    const hpaYaml = `apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: api-gateway-hpa
  namespace: kubix-demo
spec:
  maxReplicas: 10
  minReplicas: 2
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-gateway
`;
    renderWithQuery(
      <TopologyCanvas
        compact
        contextId="kind-dev"
        namespace="kubix-demo"
        manifestYaml={hpaYaml}
        focusResource={{
          kind: "HorizontalPodAutoscaler",
          name: "api-gateway-hpa",
          namespace: "kubix-demo",
        }}
        onOpenNode={onOpen}
      />,
    );
    expect(screen.getByText("api-gateway")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Open Deployment api-gateway/i }));
    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "Deployment", name: "api-gateway", namespace: "kubix-demo" }),
    );
  });

  it("hides inner Security tab for non-workloads, syncs Log Controls Live follow with Previous, ranks exact Cmd+K matches first, makes Overview nodes/events clickable, and releases Helm watch on unmount", async () => {
    const stopWatchCalls: Array<Record<string, unknown>> = [];
    const getCalls: Array<Record<string, unknown>> = [];

    setIpcTransport({
      invoke: (async (command: string, args?: Record<string, unknown>) => {
        switch (command) {
          case "list_contexts":
            return [ctx("kind-dev")];
          case "discover_resources":
            return [pods, deployments];
          case "get_cluster_overview":
            return {
              contextId: "kind-dev",
              readyNodes: 1,
              totalNodes: 1,
              namespaceCount: 2,
              runningPods: 1,
              totalPods: 1,
              healthyDeployments: 1,
              totalDeployments: 1,
              nodes: [
                {
                  name: "worker-alpha",
                  ready: true,
                  kubeletVersion: "v1.31.0",
                  roles: "worker",
                  cpuCapacity: "4",
                  memoryCapacity: "8 GiB",
                  createdAt: "2026-11-21T06:00:00Z",
                },
              ],
              recentEvents: [
                {
                  uid: "ev-click-1",
                  eventType: "Warning",
                  reason: "BackOff",
                  involvedObject: "Pod/crash-api-0",
                  namespace: "kubix-demo",
                  from: "kubelet",
                  message: "Back-off restarting failed container",
                  count: 2,
                  createdAt: "2026-11-21T06:05:00Z",
                },
              ],
            };
          case "list_resources":
            return [];
          case "stop_watch":
            stopWatchCalls.push(args ?? {});
            return null;
          case "get_resource":
            getCalls.push(args ?? {});
            return {
              contextId: "kind-dev",
              gvr: String(args?.gvr ?? "/v1/pods"),
              name: String(args?.name ?? "res"),
              namespace: args?.namespace as string | undefined,
              yaml: `apiVersion: v1\nkind: ${
                args?.gvr === "/v1/nodes"
                  ? "Node"
                  : args?.gvr === "/v1/configmaps"
                    ? "ConfigMap"
                    : "Pod"
              }\nmetadata:\n  name: ${String(args?.name ?? "res")}\nspec:\n  containers:\n  - name: app\n    image: nginx:1.27\n`,
              maskedPaths: [],
            };
          case "get_pod_logs":
            return {
              contextId: "kind-dev",
              gvr: "/v1/pods",
              name: String(args?.name ?? "crash-api-0"),
              namespace: "kubix-demo",
              pods: ["crash-api-0"],
              containers: ["app"],
              initContainers: [],
              chunks: [
                {
                  podName: "crash-api-0",
                  containerName: "app",
                  logs: "2026-11-21T07:00:00Z hello",
                },
              ],
            };
          default:
            return null;
        }
      }) as IpcTransport["invoke"],
      listen: (async () => () => {}) as IpcTransport["listen"],
    });

    // 1. Security tab hidden on ConfigMap
    const cm = renderWithQuery(
      <ResourceDetail
        contextId="kind-dev"
        gvr="/v1/configmaps"
        name="app-cfg"
        namespace="default"
        initialTab="overview"
        onClose={() => {}}
      />,
    );
    expect(await screen.findByTestId("detail-overview")).toBeInTheDocument();
    expect(screen.queryByTestId("detail-tab-security")).not.toBeInTheDocument();
    cm.unmount();

    // 2. Log Controls popover Live follow checkbox clears Previous mode
    const podDetail = renderWithQuery(
      <ResourceDetail
        contextId="kind-dev"
        gvr="/v1/pods"
        name="crash-api-0"
        namespace="kubix-demo"
        initialTab="logs"
        onClose={() => {}}
      />,
    );
    expect(await screen.findByText(/hello/)).toBeInTheDocument();
    expect(screen.getByTestId("detail-tab-security")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("toggle-previous-logs"));
    expect(screen.getByTestId("toggle-previous-logs")).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: "Log display options" }));
    const liveCheckbox = screen.getByLabelText("Live follow") as HTMLInputElement;
    expect(liveCheckbox.checked).toBe(false);
    await userEvent.click(liveCheckbox);
    expect(screen.getByTestId("toggle-previous-logs")).toHaveAttribute("aria-pressed", "false");
    expect(liveCheckbox.checked).toBe(true);
    podDetail.unmount();

    // 3. Seed 10 rows in namespace "api" before an exact-name match "api" to verify Cmd+K ranking
    useExplorerStore.getState().finishLoad(
      { contextId: "kind-dev", gvr: "/v1/pods", namespace: "api" },
      [
        ...Array.from({ length: 10 }, (_, idx) => ({
          uid: `ns-match-${idx}`,
          name: `worker-${idx}`,
          namespace: "api",
          kind: "Pod",
          createdAt: "2026-11-21T06:00:00Z",
          labels: {},
          status: "Running",
        })),
        {
          uid: "exact-api-pod",
          name: "api",
          namespace: "default",
          kind: "Pod",
          createdAt: "2026-11-21T06:00:00Z",
          labels: {},
          status: "Running",
        },
      ],
    );

    renderWithQuery(<App />);
    await waitFor(() => expect(screen.getByTestId("open-cluster")).toBeInTheDocument());
    await userEvent.click(screen.getByTestId("open-cluster"));

    // 3b. Cmd+K exact match "api" must appear in top 8 despite 10 earlier namespace matches
    const searchInput = screen.getByLabelText("Global quick search");
    await userEvent.click(searchInput);
    await userEvent.type(searchInput, "api");
    const instances = await screen.findByTestId("command-palette-instances");
    expect(within(instances).getByTestId("command-instance-exact-api-pod")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");

    // 4. Overview Node & Event rows are clickable and navigate to detail
    await userEvent.click(await screen.findByTestId("overview-node-worker-alpha"));
    await waitFor(() => {
      expect(getCalls.some((c) => c.gvr === "/v1/nodes" && c.name === "worker-alpha")).toBe(true);
    });
    expect(await screen.findByTestId("resource-detail")).toHaveTextContent("worker-alpha");

    await userEvent.click(screen.getByRole("button", { name: "Navigate back" }));
    const evLink = await screen.findByTestId("overview-event-link-crash-api-0");
    await userEvent.click(evLink);
    await waitFor(() => {
      expect(
        getCalls.some(
          (c) => c.gvr === "/v1/pods" && c.name === "crash-api-0" && c.namespace === "kubix-demo",
        ),
      ).toBe(true);
    });

    // 5. Opening Helm and navigating away stops its /v1/secrets watch
    const sidebarNav = screen.getByRole("navigation", { name: "Resource types" });
    await userEvent.click(within(sidebarNav).getByText("Helm"));
    expect(await screen.findByTestId("helm-view")).toBeInTheDocument();
    await userEvent.click(within(sidebarNav).getByText("Security"));
    expect(await screen.findByTestId("security-view")).toBeInTheDocument();
    await waitFor(() => {
      expect(stopWatchCalls.some((c) => c.gvr === "/v1/secrets" && c.namespace === "")).toBe(true);
    });
  });

  it("aggregates multi-container CPU and Memory quotas as clean summed totals (and Unbounded when all zero)", async () => {
    const zeroContainersYaml = `apiVersion: v1
kind: Pod
metadata:
  name: sonarqube-postgresql-0
  namespace: sonarqube
spec:
  containers:
  - name: c1
    image: postgres:15
    resources:
      requests:
        cpu: "0"
        memory: "0"
      limits:
        cpu: "0"
        memory: "0"
  - name: c2
    image: sidecar:1
    resources:
      requests:
        cpu: "0"
        memory: "0"
      limits:
        cpu: "0"
        memory: "0"
  - name: c3
    image: exporter:1
    resources:
      requests:
        cpu: "0"
        memory: "0"
      limits:
        cpu: "0"
        memory: "0"
`;

    const summedContainersYaml = `apiVersion: v1
kind: Pod
metadata:
  name: multi-quota-pod
  namespace: default
spec:
  containers:
  - name: app
    image: app:1
    resources:
      requests:
        cpu: 100m
        memory: 128Mi
      limits:
        cpu: 500m
        memory: 512Mi
  - name: proxy
    image: envoy:1
    resources:
      requests:
        cpu: 250m
        memory: 256Mi
      limits:
        cpu: "1"
        memory: 1Gi
  - name: metrics
    image: prom:1
    resources:
      requests:
        cpu: 150m
        memory: 128Mi
      limits:
        cpu: 500m
        memory: 512Mi
`;

    setIpcTransport({
      invoke: (async (command: string, args?: Record<string, unknown>) => {
        if (command === "get_resource") {
          const name = String(args?.name ?? "");
          return {
            contextId: "kind-dev",
            gvr: "/v1/pods",
            name,
            namespace: name === "sonarqube-postgresql-0" ? "sonarqube" : "default",
            yaml: name === "sonarqube-postgresql-0" ? zeroContainersYaml : summedContainersYaml,
            maskedPaths: [],
          };
        }
        return null;
      }) as IpcTransport["invoke"],
      listen: (async () => () => {}) as IpcTransport["listen"],
    });

    // 1. BestEffort / all-zero multi-container pod shows Unbounded instead of "0, 0, 0"
    const zeroView = renderWithQuery(
      <ResourceDetail
        contextId="kind-dev"
        gvr="/v1/pods"
        name="sonarqube-postgresql-0"
        namespace="sonarqube"
        initialTab="overview"
        onClose={() => {}}
      />,
    );
    expect(await screen.findByText("c1")).toBeInTheDocument();
    expect(screen.queryByText(/0, 0/)).not.toBeInTheDocument();
    expect(screen.getAllByText("Unbounded")).toHaveLength(2);
    expect(screen.getByText("No CPU limit set")).toBeInTheDocument();
    expect(screen.getByText("No memory limit set")).toBeInTheDocument();
    zeroView.unmount();

    // 2. Multi-container pod with quotas sums into a single CPU and Memory total
    renderWithQuery(
      <ResourceDetail
        contextId="kind-dev"
        gvr="/v1/pods"
        name="multi-quota-pod"
        namespace="default"
        initialTab="overview"
        onClose={() => {}}
      />,
    );
    expect(await screen.findByText("req 500m / lim 2")).toBeInTheDocument();
    expect(screen.getByText("req 512Mi / lim 2Gi")).toBeInTheDocument();
  });

  it("streams live pod logs via kubix://pod-log-line, changes tail size, and expands JSON log lines to inspect/filter fields", async () => {
    const streamStarts: Array<Record<string, unknown>> = [];
    const streamStops: Array<Record<string, unknown>> = [];
    let emitLogLine: ((payload: unknown) => void) | null = null;
    let streamSeq = 0;

    setIpcTransport({
      invoke: (async (command: string, args?: Record<string, unknown>) => {
        if (command === "get_resource") {
          return {
            contextId: "kind-dev",
            gvr: "/v1/pods",
            name: "checkout-0",
            namespace: "prod",
            yaml: "apiVersion: v1\nkind: Pod\nmetadata:\n  name: checkout-0\n  namespace: prod\nspec:\n  containers:\n  - name: api\n    image: checkout:v1\n",
            maskedPaths: [],
          };
        }
        if (command === "start_log_stream") {
          streamSeq += 1;
          streamStarts.push(args ?? {});
          return {
            streamId: `log-stream-${streamSeq}`,
            pods: ["checkout-0"],
            containers: ["api"],
            initContainers: [],
          };
        }
        if (command === "stop_log_stream") {
          streamStops.push(args ?? {});
          return null;
        }
        if (command === "get_pod_logs") {
          return {
            contextId: "kind-dev",
            gvr: "/v1/pods",
            name: "checkout-0",
            namespace: "prod",
            pods: ["checkout-0"],
            containers: ["api"],
            initContainers: [],
            chunks: [
              {
                podName: "checkout-0",
                containerName: "api",
                logs: "2026-11-21T07:00:00Z previous crash line",
              },
            ],
          };
        }
        return null;
      }) as IpcTransport["invoke"],
      listen: (async (event: string, handler: (payload: unknown) => void) => {
        if (event === "kubix://pod-log-line") {
          emitLogLine = handler;
        }
        return () => {
          if (event === "kubix://pod-log-line" && emitLogLine === handler) {
            emitLogLine = null;
          }
        };
      }) as IpcTransport["listen"],
    });

    renderWithQuery(
      <ResourceDetail
        contextId="kind-dev"
        gvr="/v1/pods"
        name="checkout-0"
        namespace="prod"
        initialTab="logs"
        onClose={() => {}}
      />,
    );

    await waitFor(() => expect(streamStarts).toHaveLength(1));
    expect(streamStarts[0]).toMatchObject({ name: "checkout-0", tailLines: 250 });

    // Emit a plain line and a structured JSON log line over the live stream
    act(() => {
      emitLogLine?.({
        streamId: "log-stream-1",
        podName: "checkout-0",
        containerName: "api",
        line: "2026-11-21T07:10:00Z server listening on :8080",
        closed: false,
      });
      emitLogLine?.({
        streamId: "log-stream-1",
        podName: "checkout-0",
        containerName: "api",
        line: '2026-11-21T07:10:01Z {"level":"error","requestId":"req-99","msg":"payment failed"}',
        closed: false,
      });
    });

    expect(await screen.findByText(/server listening on :8080/)).toBeInTheDocument();
    const jsonBadge = await screen.findByTestId("log-json-badge");
    await userEvent.click(jsonBadge);

    const inspector = await screen.findByTestId("log-json-inspector");
    expect(inspector).toHaveTextContent("requestId");
    expect(inspector).toHaveTextContent("req-99");

    // Clicking "Filter" on a JSON field value filters the log list to that value
    await userEvent.click(within(inspector).getByRole("button", { name: /Filter by req-99/i }));
    expect(screen.getByLabelText("Search logs")).toHaveValue("req-99");
    expect(screen.queryByText(/server listening on :8080/)).not.toBeInTheDocument();

    // Changing Tail picker stops stream-1 and starts stream-2 with 1000 lines
    const tailSelect = screen.getByTestId("log-tail-select");
    await userEvent.selectOptions(tailSelect, "1000");
    await waitFor(() => {
      expect(streamStops.some((s) => s.streamId === "log-stream-1")).toBe(true);
      expect(streamStarts.some((s) => s.tailLines === 1000)).toBe(true);
    });

    // Toggling Previous stops the live stream and loads previous logs snapshot
    await userEvent.click(screen.getByTestId("toggle-previous-logs"));
    await waitFor(() => {
      expect(streamStops.some((s) => s.streamId === "log-stream-2")).toBe(true);
    });
    await userEvent.clear(screen.getByLabelText("Search logs"));
    expect(await screen.findByText(/previous crash line/)).toBeInTheDocument();
  });

  it("displays live Node CPU/Memory metrics in Overview and Node Detail, and live clickable Security Audit findings in Security view", async () => {
    const getCalls: Array<Record<string, unknown>> = [];
    const metricsCalls: Array<Record<string, unknown>> = [];

    setIpcTransport({
      invoke: (async (command: string, args?: Record<string, unknown>) => {
        switch (command) {
          case "list_contexts":
            return [ctx("kind-dev")];
          case "discover_resources":
            return [
              pods,
              deployments,
              {
                gvr: "/v1/nodes",
                kind: "Node",
                group: "",
                version: "v1",
                plural: "nodes",
                namespaced: false,
                shortNames: ["no"],
                verbs: ["get", "list", "watch"],
                curated: true,
              },
            ];
          case "get_cluster_overview":
            return {
              contextId: "kind-dev",
              readyNodes: 1,
              totalNodes: 1,
              namespaceCount: 2,
              runningPods: 3,
              totalPods: 3,
              healthyDeployments: 1,
              totalDeployments: 1,
              metricsServerAvailable: true,
              nodes: [
                {
                  name: "eks-worker-1",
                  ready: true,
                  kubeletVersion: "v1.31.0",
                  roles: "worker",
                  cpuCapacity: "4",
                  memoryCapacity: "16.0 GiB",
                  cpuCapacityMillicores: 4000,
                  memoryCapacityMib: 16384,
                  cpuUsageMillicores: 1200,
                  memoryUsageMib: 4096,
                  createdAt: "2026-11-21T06:00:00Z",
                },
              ],
              recentEvents: [],
            };
          case "get_cluster_security_audit":
            return {
              contextId: "kind-dev",
              scannedPods: 3,
              scannedContainers: 4,
              criticalCount: 1,
              highCount: 1,
              mediumCount: 0,
              lowCount: 1,
              findings: [
                {
                  id: "f-crit-1",
                  severity: "critical",
                  category: "Privilege Escalation",
                  checkName: "Privileged container",
                  namespace: "staging",
                  podName: "priv-agent-0",
                  containerName: "agent",
                  message: "Container 'agent' runs with securityContext.privileged: true.",
                },
                {
                  id: "f-high-1",
                  severity: "high",
                  category: "Host Isolation",
                  checkName: "Host namespace enabled (hostNetwork)",
                  namespace: "kube-system",
                  podName: "net-daemon-1",
                  message: "Pod shares host namespace(s): hostNetwork.",
                },
                {
                  id: "f-low-1",
                  severity: "low",
                  category: "Supply Chain",
                  checkName: "Mutable :latest or untagged image",
                  namespace: "default",
                  podName: "web-latest-0",
                  containerName: "web",
                  message: "Container 'web' uses unpinned image 'nginx:latest'.",
                },
              ],
            };
          case "get_resource":
            getCalls.push(args ?? {});
            return {
              contextId: "kind-dev",
              gvr: String(args?.gvr ?? "/v1/pods"),
              name: String(args?.name ?? "res"),
              namespace: args?.namespace as string | undefined,
              yaml: `apiVersion: v1\nkind: ${args?.gvr === "/v1/nodes" ? "Node" : "Pod"}\nmetadata:\n  name: ${String(args?.name ?? "res")}\n`,
              maskedPaths: [],
            };
          case "get_resource_metrics":
            metricsCalls.push(args ?? {});
            return {
              contextId: "kind-dev",
              metricsServerAvailable: true,
              timestamp: "2026-11-21T07:15:00Z",
              windowSeconds: 15,
              totalCpuMillicores: 1200,
              totalMemoryMib: 4096,
              podCount: 1,
              containers: [{ name: "eks-worker-1", cpuMillicores: 1200, memoryMib: 4096 }],
            };
          default:
            return null;
        }
      }) as IpcTransport["invoke"],
      listen: (async () => () => {}) as IpcTransport["listen"],
    });

    renderWithQuery(<App />);
    await waitFor(() => expect(screen.getByTestId("open-cluster")).toBeInTheDocument());
    await userEvent.click(screen.getByTestId("open-cluster"));

    // 1. Live Node metrics bar appears in Cluster Overview
    const nodeCard = await screen.findByTestId("overview-node-eks-worker-1");
    expect(nodeCard).toHaveTextContent("1200m");
    expect(nodeCard).toHaveTextContent("30%");
    expect(nodeCard).toHaveTextContent("4.0 GiB");
    expect(nodeCard).toHaveTextContent("25%");

    // 2. Clicking the Node opens Node detail with a live Metrics tab
    await userEvent.click(nodeCard);
    const metricsTab = await screen.findByTestId("detail-tab-metrics");
    await userEvent.click(metricsTab);
    await waitFor(() => {
      expect(metricsCalls.some((c) => c.gvr === "/v1/nodes" && c.name === "eks-worker-1")).toBe(
        true,
      );
    });
    expect(await screen.findByTestId("detail-metrics")).toHaveTextContent("1200m");

    // 3. Opening sidebar Security view shows live findings, filters by severity, and jumps to Pod
    const sidebarNav = screen.getByRole("navigation", { name: "Resource types" });
    await userEvent.click(within(sidebarNav).getByText("Security"));
    expect(await screen.findByTestId("security-audit-list")).toBeInTheDocument();
    expect(screen.getByText("Privileged container")).toBeInTheDocument();
    expect(screen.getByText("Mutable :latest or untagged image")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("security-filter-critical"));
    expect(screen.getByText("Privileged container")).toBeInTheDocument();
    expect(screen.queryByText("Mutable :latest or untagged image")).not.toBeInTheDocument();

    // Clicking the finding jumps straight into priv-agent-0 Pod detail
    await userEvent.click(screen.getByTestId("security-finding-link-f-crit-1"));
    await waitFor(() => {
      expect(
        getCalls.some(
          (c) => c.gvr === "/v1/pods" && c.name === "priv-agent-0" && c.namespace === "staging",
        ),
      ).toBe(true);
    });
    expect(await screen.findByTestId("resource-detail")).toHaveTextContent("priv-agent-0");
  });

  it("surfaces log stream closed/error payloads and renders Node-specific Metrics breakdown without Pod/Container labels", async () => {
    let emitLogLine: ((payload: unknown) => void) | null = null;

    setIpcTransport({
      invoke: (async (command: string, args?: Record<string, unknown>) => {
        if (command === "get_resource") {
          const isNode = args?.gvr === "/v1/nodes";
          return {
            contextId: "kind-dev",
            gvr: String(args?.gvr ?? "/v1/pods"),
            name: String(args?.name ?? "res"),
            namespace: isNode ? undefined : "default",
            yaml: isNode
              ? `apiVersion: v1
kind: Node
metadata:
  name: eks-worker-1
status:
  capacity:
    cpu: "4"
    memory: 16Gi
`
              : "apiVersion: v1\nkind: Pod\nmetadata:\n  name: broken-0\n  namespace: default\nspec:\n  containers:\n  - name: app\n    image: app:v1\n",
            maskedPaths: [],
          };
        }
        if (command === "start_log_stream") {
          return {
            streamId: "log-stream-err",
            pods: ["broken-0"],
            containers: ["app"],
            initContainers: [],
          };
        }
        if (command === "stop_log_stream") return null;
        if (command === "get_resource_metrics") {
          return {
            contextId: "kind-dev",
            metricsServerAvailable: true,
            timestamp: "2026-11-21T07:15:00Z",
            windowSeconds: 15,
            totalCpuMillicores: 1200,
            totalMemoryMib: 4096,
            podCount: 1,
            containers: [{ name: "eks-worker-1", cpuMillicores: 1200, memoryMib: 4096 }],
          };
        }
        return null;
      }) as IpcTransport["invoke"],
      listen: (async (event: string, handler: (payload: unknown) => void) => {
        if (event === "kubix://pod-log-line") emitLogLine = handler;
        return () => {
          if (event === "kubix://pod-log-line" && emitLogLine === handler) emitLogLine = null;
        };
      }) as IpcTransport["listen"],
    });

    // 1. Mid-stream error with empty line must surface error banner (not hang on Waiting...)
    const podView = renderWithQuery(
      <ResourceDetail
        contextId="kind-dev"
        gvr="/v1/pods"
        name="broken-0"
        namespace="default"
        initialTab="logs"
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(emitLogLine).not.toBeNull());
    act(() => {
      emitLogLine?.({
        streamId: "log-stream-err",
        podName: "broken-0",
        containerName: "app",
        line: "",
        closed: true,
        error: "container app is waiting to start: CrashLoopBackOff",
      });
    });
    expect(await screen.findByTestId("log-stream-error")).toHaveTextContent(
      "container app is waiting to start: CrashLoopBackOff",
    );
    podView.unmount();

    // 2. Node Metrics tab renders Node Resource Breakdown (not Observed Pods / 0 containers)
    renderWithQuery(
      <ResourceDetail
        contextId="kind-dev"
        gvr="/v1/nodes"
        name="eks-worker-1"
        initialTab="metrics"
        onClose={() => {}}
      />,
    );
    const metricsPanel = await screen.findByTestId("detail-metrics");
    await waitFor(() => expect(metricsPanel).toHaveTextContent("Node Resource Breakdown"));
    expect(metricsPanel).not.toHaveTextContent("Observed Pods");
    expect(metricsPanel).not.toHaveTextContent("0 containers");
    expect(metricsPanel).toHaveTextContent("30%");
    expect(metricsPanel).toHaveTextContent("25%");
  });

  it("renders Live Namespace Visualizer with Gateway API + Ingress, collapsible workload pods, layer presets, and HTTPRoute Topology tab", async () => {
    const gatewayYaml = [
      "apiVersion: gateway.networking.k8s.io/v1",
      "kind: Gateway",
      "metadata:",
      "  name: edge-gw",
      "  namespace: gateway-system",
      "spec:",
      "  gatewayClassName: envoy",
      "  listeners:",
      "    - name: https",
      "      port: 443",
      "      protocol: HTTPS",
    ].join("\n");

    const httpRouteYaml = [
      "apiVersion: gateway.networking.k8s.io/v1",
      "kind: HTTPRoute",
      "metadata:",
      "  name: api-route",
      "  namespace: prod",
      "spec:",
      "  hostnames:",
      "    - api.example.com",
      "  parentRefs:",
      "    - name: edge-gw",
      "      namespace: gateway-system",
      "      sectionName: https",
      "  rules:",
      "    - matches:",
      "        - path:",
      "            type: PathPrefix",
      "            value: /api",
      "      backendRefs:",
      "        - name: api-svc",
      "          port: 8080",
    ].join("\n");

    const topologyPayload = {
      contextId: "kind-dev",
      namespace: "prod",
      gatewayApiDetected: true,
      gatewayApiKinds: ["Gateway", "HTTPRoute"],
      nodes: [
        {
          id: "Gateway/gateway-system/edge-gw",
          kind: "Gateway",
          gvr: "gateway.networking.k8s.io/v1/gateways",
          name: "edge-gw",
          namespace: "gateway-system",
          layer: "entry",
          status: "Ready",
          external: true,
          subtitle: "envoy · HTTPS:443",
          details: [{ label: "Class", value: "envoy" }],
        },
        {
          id: "Ingress/prod/legacy-ing",
          kind: "Ingress",
          gvr: "networking.k8s.io/v1/ingresses",
          name: "legacy-ing",
          namespace: "prod",
          layer: "entry",
          status: "Active",
          external: false,
          subtitle: "legacy.example.com",
          details: [{ label: "Class", value: "nginx" }],
        },
        {
          id: "HTTPRoute/prod/api-route",
          kind: "HTTPRoute",
          gvr: "gateway.networking.k8s.io/v1/httproutes",
          name: "api-route",
          namespace: "prod",
          layer: "routing",
          status: "Ready",
          external: false,
          subtitle: "api.example.com",
          details: [{ label: "Hostnames", value: "api.example.com" }],
        },
        {
          id: "Service/prod/api-svc",
          kind: "Service",
          gvr: "/v1/services",
          name: "api-svc",
          namespace: "prod",
          layer: "service",
          status: "Active",
          external: false,
          subtitle: "ClusterIP :8080",
          details: [{ label: "Type", value: "ClusterIP" }],
        },
        {
          id: "Deployment/prod/api",
          kind: "Deployment",
          gvr: "apps/v1/deployments",
          name: "api",
          namespace: "prod",
          layer: "workload",
          status: "Running",
          external: false,
          subtitle: "1/1 ready",
          podCount: 1,
          readyPodCount: 1,
          details: [{ label: "Replicas", value: "1/1 ready" }],
        },
        {
          id: "Pod/prod/api-7f8d-abc",
          kind: "Pod",
          gvr: "/v1/pods",
          name: "api-7f8d-abc",
          namespace: "prod",
          layer: "pod",
          status: "Running",
          external: false,
          subtitle: "node: node-a",
          parentWorkloadId: "Deployment/prod/api",
          details: [{ label: "Node", value: "node-a" }],
        },
        {
          id: "HorizontalPodAutoscaler/prod/api-hpa",
          kind: "HorizontalPodAutoscaler",
          gvr: "autoscaling/v2/horizontalpodautoscalers",
          name: "api-hpa",
          namespace: "prod",
          layer: "aux",
          status: "Active",
          external: false,
          subtitle: "1 (1–5)",
          details: [{ label: "Target", value: "Deployment/api" }],
        },
        {
          id: "PersistentVolumeClaim/prod/api-data",
          kind: "PersistentVolumeClaim",
          gvr: "/v1/persistentvolumeclaims",
          name: "api-data",
          namespace: "prod",
          layer: "aux",
          status: "Ready",
          external: false,
          subtitle: "20Gi · Bound",
          details: [{ label: "Capacity", value: "20Gi" }],
        },
      ],
      edges: [
        {
          id: "e1",
          from: "Gateway/gateway-system/edge-gw",
          to: "HTTPRoute/prod/api-route",
          label: "https · api.example.com",
          crossNamespace: true,
        },
        {
          id: "e2",
          from: "HTTPRoute/prod/api-route",
          to: "Service/prod/api-svc",
          label: "/api :8080",
          crossNamespace: false,
        },
        {
          id: "e3",
          from: "Ingress/prod/legacy-ing",
          to: "Service/prod/api-svc",
          label: "legacy.example.com/v1 :8080",
          crossNamespace: false,
        },
        {
          id: "e4",
          from: "Service/prod/api-svc",
          to: "Deployment/prod/api",
          label: "routes",
          crossNamespace: false,
        },
        {
          id: "e5",
          from: "Deployment/prod/api",
          to: "Pod/prod/api-7f8d-abc",
          label: "owns",
          crossNamespace: false,
        },
        {
          id: "e6",
          from: "HorizontalPodAutoscaler/prod/api-hpa",
          to: "Deployment/prod/api",
          label: "scales 1–5",
          crossNamespace: false,
        },
        {
          id: "e7",
          from: "Deployment/prod/api",
          to: "PersistentVolumeClaim/prod/api-data",
          label: "mounts",
          crossNamespace: false,
        },
      ],
    };

    const transport: IpcTransport = {
      invoke: vi.fn(async (cmd, args) => {
        if (cmd === "list_contexts") return [ctx("kind-dev", { namespaceDefault: "prod" })];
        if (cmd === "connect_context")
          return ctx("kind-dev", { state: "ready", namespaceDefault: "prod" });
        if (cmd === "discover_resources") {
          return [
            {
              gvr: "/v1/pods",
              group: "",
              version: "v1",
              plural: "pods",
              kind: "Pod",
              namespaced: true,
              shortNames: ["po"],
              verbs: ["get", "list", "watch"],
              curated: true,
            },
            {
              gvr: "gateway.networking.k8s.io/v1/gateways",
              group: "gateway.networking.k8s.io",
              version: "v1",
              plural: "gateways",
              kind: "Gateway",
              namespaced: true,
              shortNames: ["gtw"],
              verbs: ["get", "list", "watch"],
              curated: false,
            },
            {
              gvr: "gateway.networking.k8s.io/v1/httproutes",
              group: "gateway.networking.k8s.io",
              version: "v1",
              plural: "httproutes",
              kind: "HTTPRoute",
              namespaced: true,
              shortNames: [],
              verbs: ["get", "list", "watch"],
              curated: false,
            },
          ];
        }
        if (cmd === "get_cluster_overview") {
          return {
            contextId: "kind-dev",
            totalNodes: 1,
            readyNodes: 1,
            totalPods: 1,
            runningPods: 1,
            totalNamespaces: 2,
            totalDeployments: 1,
            metricsServerAvailable: false,
            nodes: [],
            recentEvents: [],
          };
        }
        if (cmd === "get_namespace_topology") return topologyPayload;
        if (cmd === "get_resource") {
          const a = args as { gvr: string; name: string; namespace?: string };
          if (a.gvr === "gateway.networking.k8s.io/v1/gateways") {
            return {
              contextId: "kind-dev",
              gvr: a.gvr,
              name: a.name,
              namespace: a.namespace,
              yaml: gatewayYaml,
              maskedPaths: [],
            };
          }
          return {
            contextId: "kind-dev",
            gvr: a.gvr,
            name: a.name,
            namespace: a.namespace,
            yaml: httpRouteYaml,
            maskedPaths: [],
          };
        }
        if (cmd === "list_resources") return [];
        if (cmd === "list_port_forwards") return [];
        if (cmd === "stop_watch") return null;
        return null;
      }) as IpcTransport["invoke"],
      listen: vi.fn(async () => () => {}) as IpcTransport["listen"],
    };
    setIpcTransport(transport);

    const appView = renderWithQuery(<App />);

    // Connect and open Visualizer from sidebar
    await userEvent.click(await screen.findByTestId("open-cluster"));
    const sidebarNav = await screen.findByRole("navigation", { name: "Resource types" });
    await userEvent.click(within(sidebarNav).getByText("Visualizer"));

    // Gateway API badge + Gateway, HTTPRoute, Ingress, Service, Deployment, HPA, PVC rendered
    // Visualizer uses a single unified 42px toolbar without a redundant PageHeader / cluster ARN banner
    expect(await screen.findByTestId("visualizer-gateway-badge")).toHaveTextContent("Gateway API");
    const canvas = screen.getByTestId("topology-canvas");
    expect(within(canvas).getByRole("heading", { name: "Visualizer" })).toBeInTheDocument();
    expect(within(canvas).queryByText("kind-dev")).not.toBeInTheDocument();
    expect(within(canvas).getByText("edge-gw")).toBeInTheDocument();
    expect(within(canvas).getByText("api-route")).toBeInTheDocument();
    expect(within(canvas).getByText("legacy-ing")).toBeInTheDocument();
    expect(within(canvas).getByText("api-svc")).toBeInTheDocument();
    expect(within(canvas).getByText("api-hpa")).toBeInTheDocument();
    expect(within(canvas).getByText("api-data")).toBeInTheDocument();
    expect(within(canvas).getByText("PVC")).toBeInTheDocument();
    expect(within(canvas).getByText("HPA")).toBeInTheDocument();

    // Managed Pod is collapsed by default under Deployment/prod/api
    expect(within(canvas).queryByText("api-7f8d-abc")).not.toBeInTheDocument();
    const togglePodsBtn = within(canvas).getByTestId("topology-toggle-pods-Deployment/prod/api");
    expect(togglePodsBtn).toHaveTextContent("1/1 Pod");
    await userEvent.click(togglePodsBtn);
    expect(within(canvas).getByText("api-7f8d-abc")).toBeInTheDocument();

    // Traffic preset hides Pods, HPA, and PVC while keeping Gateway/HTTPRoute/Ingress/Service/Deployment
    const presets = screen.getByTestId("visualizer-layer-presets");
    await userEvent.click(within(presets).getByRole("button", { name: "Traffic" }));
    expect(within(canvas).getByText("edge-gw")).toBeInTheDocument();
    expect(within(canvas).getByText("api-route")).toBeInTheDocument();
    expect(within(canvas).queryByText("api-7f8d-abc")).not.toBeInTheDocument();
    expect(within(canvas).queryByText("api-hpa")).not.toBeInTheDocument();
    expect(within(canvas).queryByText("api-data")).not.toBeInTheDocument();

    // Ingress & Gateway preset keeps entry + routes + targeted Service and hides Deployment
    await userEvent.click(within(presets).getByRole("button", { name: "Ingress & Gateway" }));
    expect(within(canvas).getByText("edge-gw")).toBeInTheDocument();
    expect(within(canvas).getByText("api-route")).toBeInTheDocument();
    expect(within(canvas).getByText("legacy-ing")).toBeInTheDocument();
    expect(within(canvas).getByText("api-svc")).toBeInTheDocument();
    expect(
      canvas.querySelector('[data-topology-node="Deployment/prod/api"]'),
    ).toBeNull();

    // Clicking Open on cross-namespace Gateway navigates straight to that Gateway detail tab
    await userEvent.click(
      within(canvas).getByTestId("topology-open-node-Gateway/gateway-system/edge-gw"),
    );
    await waitFor(() => {
      expect(screen.getByTestId("resource-detail")).toHaveTextContent("edge-gw");
    });
    expect(screen.getByTestId("resource-detail")).toHaveTextContent("gateway-system");
    appView.unmount();

    // Per-resource Topology tab on HTTPRoute renders Gateway -> HTTPRoute -> Service
    renderWithQuery(
      <ResourceDetail
        contextId="kind-dev"
        gvr="gateway.networking.k8s.io/v1/httproutes"
        name="api-route"
        namespace="prod"
        initialTab="overview"
        onClose={() => {}}
      />,
    );
    const topoTab = await screen.findByTestId("detail-tab-topology");
    await userEvent.click(topoTab);
    const detailCanvas = await screen.findByTestId("topology-canvas");
    expect(within(detailCanvas).getByText("edge-gw")).toBeInTheDocument();
    expect(within(detailCanvas).getByText("api-route")).toBeInTheDocument();
    expect(within(detailCanvas).getByText("api-svc")).toBeInTheDocument();
  });

  it("renders Operator CRs (RabbitmqCluster, InstanceSet) and TLS Secrets/Certificates with preset filtering and exact GVR Open links", async () => {
    const onOpenNode = vi.fn();
    render(
      <TopologyCanvas
        contextId="kind-dev"
        namespace="prod"
        flush
        onOpenNode={onOpenNode}
        namespaceTopology={{
          contextId: "kind-dev",
          namespace: "prod",
          gatewayApiDetected: true,
          gatewayApiKinds: ["Gateway"],
          nodes: [
            {
              id: "Gateway/envoy-gateway-system/edge-gw",
              kind: "Gateway",
              gvr: "gateway.networking.k8s.io/v1/gateways",
              name: "edge-gw",
              namespace: "envoy-gateway-system",
              layer: "entry",
              status: "Ready",
              external: true,
              details: [{ label: "Class", value: "envoy" }],
            },
            {
              id: "Certificate/prod/app-tls-cert",
              kind: "Certificate",
              gvr: "cert-manager.io/v1/certificates",
              name: "app-tls-cert",
              namespace: "prod",
              layer: "entry",
              status: "Ready",
              external: false,
              details: [{ label: "Issuer", value: "letsencrypt-prod" }],
            },
            {
              id: "Secret/prod/app-tls",
              kind: "Secret",
              gvr: "/v1/secrets",
              name: "app-tls",
              namespace: "prod",
              layer: "routing",
              status: "Ready",
              external: false,
              details: [{ label: "Type", value: "TLS Secret" }],
            },
            {
              id: "RabbitmqCluster/prod/mq-cluster",
              kind: "RabbitmqCluster",
              gvr: "rabbitmq.com/v1beta1/rabbitmqclusters",
              name: "mq-cluster",
              namespace: "prod",
              layer: "operator",
              status: "Active",
              external: false,
              details: [{ label: "API", value: "rabbitmq.com/v1beta1" }],
            },
            {
              id: "InstanceSet/prod/pg",
              kind: "InstanceSet",
              gvr: "workloads.kubeblocks.io/v1alpha1/instancesets",
              name: "pg",
              namespace: "prod",
              layer: "workload",
              status: "Running",
              external: false,
              podCount: 1,
              readyPodCount: 1,
              details: [{ label: "API", value: "workloads.kubeblocks.io/v1alpha1" }],
            },
            {
              id: "Pod/prod/pg-0",
              kind: "Pod",
              gvr: "/v1/pods",
              name: "pg-0",
              namespace: "prod",
              layer: "pod",
              status: "Running",
              external: false,
              parentWorkloadId: "InstanceSet/prod/pg",
              details: [{ label: "Node", value: "node-1" }],
            },
          ],
          edges: [
            {
              id: "e-gw-tls",
              from: "Gateway/envoy-gateway-system/edge-gw",
              to: "Secret/prod/app-tls",
              label: "tls · https",
              crossNamespace: true,
            },
            {
              id: "e-cert-tls",
              from: "Certificate/prod/app-tls-cert",
              to: "Secret/prod/app-tls",
              label: "issues",
              crossNamespace: false,
            },
            {
              id: "e-inst-pod",
              from: "InstanceSet/prod/pg",
              to: "Pod/prod/pg-0",
              label: "owns",
              crossNamespace: false,
            },
          ],
        }}
      />,
    );

    const canvas = screen.getByTestId("topology-canvas");
    expect(within(canvas).getByText("mq-cluster")).toBeInTheDocument();
    expect(within(canvas).getByText("app-tls-cert")).toBeInTheDocument();
    expect(within(canvas).getByText("CERT")).toBeInTheDocument();
    expect(within(canvas).getByText("app-tls")).toBeInTheDocument();
    expect(within(canvas).getByText("pg")).toBeInTheDocument();

    // Direct Pod-owning Operator CR (InstanceSet) collapses Pods by default and expands on click
    expect(within(canvas).queryByText("pg-0")).not.toBeInTheDocument();
    await userEvent.click(within(canvas).getByTestId("topology-toggle-pods-InstanceSet/prod/pg"));
    expect(within(canvas).getByText("pg-0")).toBeInTheDocument();

    // Clicking Open on RabbitmqCluster forwards exact discovered GVR
    await userEvent.click(
      within(canvas).getByTestId("topology-open-node-RabbitmqCluster/prod/mq-cluster"),
    );
    expect(onOpenNode).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "RabbitmqCluster",
        name: "mq-cluster",
        gvr: "rabbitmq.com/v1beta1/rabbitmqclusters",
      }),
    );

    // Ingress & Gateway preset keeps Gateway, Certificate, and TLS Secret while hiding Operator CR / InstanceSet
    const presets = screen.getByTestId("visualizer-layer-presets");
    await userEvent.click(within(presets).getByRole("button", { name: "Ingress & Gateway" }));
    expect(within(canvas).getByText("edge-gw")).toBeInTheDocument();
    expect(within(canvas).getByText("app-tls-cert")).toBeInTheDocument();
    expect(within(canvas).getByText("app-tls")).toBeInTheDocument();
    expect(within(canvas).queryByText("mq-cluster")).not.toBeInTheDocument();
    expect(within(canvas).queryByText("pg")).not.toBeInTheDocument();
  });

  it("shows only pinned clusters in IconRail, supports drag-and-drop pinning & reordering, and customizes animated bot & uploaded picture avatars", async () => {
    const dev = ctx("kind-dev", { state: "disconnected" });
    const prod = ctx("eks-prod", { state: "ready" });
    const staging = ctx("vcluster-staging", { state: "disconnected" });

    setIpcTransport({
      invoke: (async (command: string) => {
        if (command === "list_contexts") return [dev, prod, staging];
        return [];
      }) as IpcTransport["invoke"],
      listen: async () => () => {},
    });

    renderWithQuery(<App />);
    await waitFor(() => expect(screen.getAllByTestId("cluster-card")).toHaveLength(3));

    // Nothing is pinned initially: IconRail renders zero cluster icons and ClusterCards are not draggable.
    expect(screen.queryAllByTestId("cluster-rail-item")).toHaveLength(0);
    const cards = screen.getAllByTestId("cluster-card");
    const prodCard = cards.find((c) => c.getAttribute("data-context-id") === "eks-prod")!;
    const devCard = cards.find((c) => c.getAttribute("data-context-id") === "kind-dev")!;
    const stagingCard = cards.find((c) => c.getAttribute("data-context-id") === "vcluster-staging")!;
    expect(prodCard).not.toHaveAttribute("draggable");

    // Pin all 3 clusters: [kind-dev (KKD), eks-prod (EP), vcluster-staging (VTS)].
    await userEvent.click(within(devCard).getByTestId("toggle-pin-cluster"));
    await userEvent.click(within(prodCard).getByTestId("toggle-pin-cluster"));
    await userEvent.click(within(stagingCard).getByTestId("toggle-pin-cluster"));

    await waitFor(() => expect(screen.getAllByTestId("cluster-rail-item")).toHaveLength(3));
    expect(
      screen.getAllByTestId("cluster-rail-item").map((el) => el.getAttribute("data-context-id")),
    ).toEqual(["kind-dev", "eks-prod", "vcluster-staging"]);

    // Drag vcluster-staging onto kind-dev: they switch positions while eks-prod stays in the middle.
    const railItems = screen.getAllByTestId("cluster-rail-item");
    const mockSlotRect = (el: HTMLElement, top: number) =>
      vi.spyOn(el.parentElement!, "getBoundingClientRect").mockReturnValue({
        top,
        height: 40,
        bottom: top + 40,
        left: 0,
        right: 40,
        width: 40,
        x: 0,
        y: top,
        toJSON: () => ({}),
      });
    mockSlotRect(railItems[0]!, 100); // kind-dev (center 120)
    mockSlotRect(railItems[1]!, 150); // eks-prod (center 170)
    mockSlotRect(railItems[2]!, 200); // vcluster-staging (center 220)

    fireEvent(
      railItems[2]!,
      new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, clientY: 220 }),
    );
    fireEvent(window, new MouseEvent("pointermove", { bubbles: true, cancelable: true, clientY: 120 }));
    expect(railItems[0]!).toHaveAttribute("data-swap-target", "true");
    fireEvent(window, new MouseEvent("pointerup", { bubbles: true, cancelable: true, clientY: 120 }));

    expect(
      screen.getAllByTestId("cluster-rail-item").map((el) => el.getAttribute("data-context-id")),
    ).toEqual(["vcluster-staging", "eks-prod", "kind-dev"]);
    expect(JSON.parse(localStorage.getItem("kubix:cluster-profiles:v1") ?? "{}").pinnedIds).toEqual(
      ["vcluster-staging", "eks-prod", "kind-dev"],
    );

    // Default avatar is short-name initials ("KD" for kind-dev, now at index 2).
    const devRailAvatar = within(screen.getAllByTestId("cluster-rail-item")[2]!).getByTestId(
      "cluster-avatar",
    );
    expect(devRailAvatar).toHaveAttribute("data-avatar-kind", "initials");
    expect(devRailAvatar).toHaveTextContent("KD");

    // Open profile editor by clicking kind-dev's avatar on ClusterCard.
    await userEvent.click(within(devCard).getByTestId("edit-cluster-avatar"));
    const editor = screen.getByTestId("cluster-avatar-editor");
    expect(editor).toBeInTheDocument();

    // Pick a Plush Hexagon shape, Round -> Angry eyes, and Magenta color swatch.
    await userEvent.click(within(editor).getByTestId("avatar-shape-hexagon"));
    await userEvent.click(within(editor).getByTestId("avatar-eyes-angry"));
    await userEvent.click(within(editor).getByTestId("avatar-color-e040c8"));

    // Both ClusterCard and IconRail update immediately to the animated Plush character.
    const updatedRailAvatar = within(screen.getAllByTestId("cluster-rail-item")[2]!).getByTestId(
      "cluster-avatar",
    );
    expect(updatedRailAvatar).toHaveAttribute("data-avatar-kind", "character");
    expect(updatedRailAvatar).toHaveAttribute("data-avatar-shape", "hexagon");
    expect(updatedRailAvatar).toHaveAttribute("data-avatar-finish", "plush");
    expect(updatedRailAvatar).toHaveAttribute("data-avatar-eyes", "angry");
    expect(updatedRailAvatar).toHaveAttribute("data-avatar-color", "#e040c8");

    expect(within(devCard).getByTestId("cluster-avatar")).toHaveAttribute(
      "data-avatar-shape",
      "hexagon",
    );

    // Switch to Flat finish and verify it updates live.
    await userEvent.click(within(editor).getByTestId("avatar-finish-flat"));
    expect(
      within(screen.getAllByTestId("cluster-rail-item")[2]!).getByTestId("cluster-avatar"),
    ).toHaveAttribute("data-avatar-finish", "flat");

    // Upload a custom SVG image directly from the IMAGE section.
    const fileInput = within(editor).getByTestId("avatar-file-input") as HTMLInputElement;
    const svgFile = new File(['<svg xmlns="http://www.w3.org/2000/svg"></svg>'], "bot.svg", {
      type: "image/svg+xml",
    });
    await userEvent.upload(fileInput, svgFile);

    await waitFor(() =>
      expect(
        within(screen.getAllByTestId("cluster-rail-item")[2]!).getByTestId("cluster-avatar"),
      ).toHaveAttribute("data-avatar-kind", "image"),
    );

    // Reset back to default short name initials.
    await userEvent.click(within(editor).getByTestId("avatar-reset-default"));
    expect(
      within(screen.getAllByTestId("cluster-rail-item")[2]!).getByTestId("cluster-avatar"),
    ).toHaveAttribute("data-avatar-kind", "initials");
    expect(
      within(screen.getAllByTestId("cluster-rail-item")[2]!).getByTestId("cluster-avatar"),
    ).toHaveTextContent("KD");

    // Unpin kind-dev from inside the editor removes it from IconRail.
    await userEvent.click(within(editor).getByTestId("editor-toggle-pin"));
    expect(
      screen.getAllByTestId("cluster-rail-item").map((el) => el.getAttribute("data-context-id")),
    ).toEqual(["vcluster-staging", "eks-prod"]);
  });

  it("strips server noise with stripYamlNoise and powers Settings modal, Clean YAML, Monaco Diff, Live Events Timeline, and Stern-style Multi-Pod Logs", async () => {
    // 1. Unit check for stripYamlNoise
    const noisyYaml = [
      "apiVersion: apps/v1",
      "kind: Deployment",
      "metadata:",
      "  name: web-api",
      "  namespace: prod",
      "  uid: 12345-abc",
      "  resourceVersion: '9981'",
      "  generation: 4",
      "  creationTimestamp: '2026-01-01T00:00:00Z'",
      "  annotations:",
      "    kubectl.kubernetes.io/last-applied-configuration: '{\"kind\":\"Deployment\"}'",
      "  managedFields:",
      "    - manager: kubectl",
      "      operation: Apply",
      "  labels:",
      "    app: web-api",
      "spec:",
      "  replicas: 3",
      "status:",
      "  availableReplicas: 3",
    ].join("\n");

    const cleaned = stripYamlNoise(noisyYaml);
    expect(cleaned).toContain("name: web-api");
    expect(cleaned).toContain("replicas: 3");
    expect(cleaned).not.toContain("managedFields");
    expect(cleaned).not.toContain("resourceVersion");
    expect(cleaned).not.toContain("uid:");
    expect(cleaned).not.toContain("last-applied-configuration");
    expect(cleaned).not.toContain("annotations:");
    expect(cleaned).not.toContain("availableReplicas");

    const noisyYamlV2 = noisyYaml
      .replace("name: web-api", "name: web-api-v2")
      .replace("replicas: 3", "replicas: 5");

    const cluster = ctx("prod-cluster", { state: "ready" });
    setIpcTransport({
      invoke: (async (command: string, args?: unknown) => {
        if (command === "list_contexts") return [cluster];
        if (command === "discover_resources") return [pods, deployments, services];
        if (command === "list_resources") {
          const payload = args as { gvr?: string } | undefined;
          if (payload?.gvr === "apps/v1/deployments") {
            return [
              {
                uid: "dep-1",
                name: "web-api",
                namespace: "prod",
                kind: "Deployment",
                createdAt: "2026-01-01T00:00:00Z",
                labels: { app: "web-api" },
              },
              {
                uid: "dep-2",
                name: "web-api-v2",
                namespace: "prod",
                kind: "Deployment",
                createdAt: "2026-01-01T00:00:00Z",
                labels: { app: "web-api-v2" },
              },
            ];
          }
          return [];
        }
        if (command === "get_resource") {
          const payload = args as { name?: string } | undefined;
          const resName = payload?.name ?? "web-api";
          return {
            contextId: "prod-cluster",
            gvr: "apps/v1/deployments",
            name: resName,
            namespace: "prod",
            yaml: resName === "web-api-v2" ? noisyYamlV2 : noisyYaml,
            maskedPaths: [],
          };
        }
        if (command === "get_resource_events") {
          return [
            {
              uid: "ev-1",
              eventType: "Warning",
              reason: "BackOff",
              involvedObject: "Pod/web-api-7d4b",
              namespace: "prod",
              from: "kubelet",
              message: "Back-off restarting failed container",
              count: 12,
              createdAt: "2026-11-23T00:00:00Z",
            },
            {
              uid: "ev-2",
              eventType: "Normal",
              reason: "Scheduled",
              involvedObject: "Pod/web-api-8c1a",
              namespace: "prod",
              from: "default-scheduler",
              message: "Successfully assigned prod/web-api-8c1a",
              count: 1,
              createdAt: "2026-11-23T00:01:00Z",
            },
          ];
        }
        if (command === "get_pod_logs") {
          return {
            contextId: "prod-cluster",
            gvr: "apps/v1/deployments",
            name: "web-api",
            namespace: "prod",
            pods: ["web-api-pod-a", "web-api-pod-b"],
            containers: ["app"],
            initContainers: [],
            chunks: [
              {
                podName: "web-api-pod-a",
                containerName: "app",
                logs: "2026-11-23T00:00:01Z INFO server ready\n2026-11-23T00:00:02Z ERROR status=502 upstream timeout",
              },
              {
                podName: "web-api-pod-b",
                containerName: "app",
                logs: "2026-11-23T00:00:03Z INFO healthcheck ok\n2026-11-23T00:00:04Z WARN retry=503 circuit open",
              },
            ],
          };
        }
        if (command === "start_log_stream") {
          throw new Error("fallback to snapshot logs in test");
        }
        return [];
      }) as IpcTransport["invoke"],
      listen: async () => () => {},
    });

    renderWithQuery(<App />);
    await waitFor(() => expect(screen.getAllByTestId("cluster-card")).toHaveLength(1));

    // 2. Settings Modal via Cmd+, shortcut, preferences persistence & Shortcuts tab
    fireEvent.keyDown(window, { key: ",", metaKey: true });
    const settingsModal = await screen.findByTestId("settings-modal");
    await userEvent.selectOptions(within(settingsModal).getByTestId("settings-log-tail"), "1000");
    await userEvent.click(within(settingsModal).getByTestId("settings-yaml-font-14"));
    expect(useSettingsStore.getState().defaultLogTailLines).toBe(1000);
    expect(useSettingsStore.getState().yamlFontSize).toBe(14);
    await userEvent.click(within(settingsModal).getByTestId("settings-tab-shortcuts"));
    expect(within(settingsModal).getByTestId("settings-shortcuts-list")).toBeInTheDocument();
    await userEvent.click(within(settingsModal).getByRole("button", { name: "Done" }));
    expect(screen.queryByTestId("settings-modal")).not.toBeInTheDocument();

    // Enter prod-cluster
    await userEvent.click(screen.getByTestId("open-cluster"));
    await waitFor(() => expect(screen.getByTestId("cluster-sidebar")).toBeInTheDocument());

    // 3. Live Events & Warnings Timeline view + warning filter + jump to Pod
    await userEvent.click(screen.getByRole("button", { name: "Events" }));
    const timeline = await screen.findByTestId("events-timeline-view");
    await waitFor(() => expect(within(timeline).getAllByTestId("timeline-event-row")).toHaveLength(2));
    await userEvent.click(within(timeline).getByTestId("events-filter-warning"));
    expect(within(timeline).getAllByTestId("timeline-event-row")).toHaveLength(1);
    expect(within(timeline).getByText("×12")).toBeInTheDocument();
    await userEvent.click(within(timeline).getByTestId("timeline-event-jump"));
    await waitFor(() => expect(screen.getByTestId("resource-detail")).toBeInTheDocument());

    // 4. Open Deployments, inspect YAML Clean mode + Diff modal + Stern-style Multi-Pod Logs
    await userEvent.click(screen.getByRole("button", { name: "WorkLoad" }));
    const deployBtn = await screen.findByRole("button", { name: /Deployment/ });
    await userEvent.click(deployBtn);
    await waitFor(() => expect(screen.getAllByTestId("resource-row")).toHaveLength(2));
    await userEvent.click(screen.getAllByTestId("resource-row")[0]!);

    const detail = await screen.findByTestId("resource-detail");
    // YAML tab: Clean YAML toggle & Diff with sibling Deployment
    await userEvent.click(within(detail).getByRole("tab", { name: "YAML" }));
    await waitFor(() => expect(within(detail).getByTestId("mock-editor")).toBeInTheDocument());
    expect(within(detail).getByTestId("mock-editor").getAttribute("data-value")).toContain(
      "managedFields",
    );
    await userEvent.click(within(detail).getByTestId("yaml-mode-clean"));
    expect(within(detail).getByTestId("mock-editor").getAttribute("data-value")).not.toContain(
      "managedFields",
    );

    // Open Monaco DiffEditor modal via Diff with… dropdown
    await userEvent.selectOptions(within(detail).getByTestId("yaml-diff-select"), "prod/web-api-v2");
    const diffModal = await screen.findByTestId("yaml-diff-modal");
    const diffEditor = await within(diffModal).findByTestId("mock-diff-editor");
    expect(diffEditor.getAttribute("data-original")).toContain("replicas: 3");
    expect(diffEditor.getAttribute("data-modified")).toContain("replicas: 5");
    expect(diffEditor.getAttribute("data-original")).not.toContain("managedFields");
    await userEvent.click(within(diffModal).getByTestId("diff-swap-sides"));
    expect(within(diffModal).getByTestId("diff-left-label")).toHaveTextContent("prod/web-api-v2");
    await userEvent.click(within(diffModal).getByRole("button", { name: "Close diff" }));
    expect(screen.queryByTestId("yaml-diff-modal")).not.toBeInTheDocument();

    // 5. Stern-style Multi-Pod Logs with color-coded chips, line counts, and regex highlighting
    await userEvent.click(within(detail).getByRole("tab", { name: "Logs" }));
    await waitFor(() => expect(within(detail).getByTestId("log-pods-bar")).toBeInTheDocument());
    expect(within(detail).getByTestId("log-pod-chip-web-api-pod-a")).toHaveTextContent("2");
    expect(within(detail).getByTestId("log-pod-chip-web-api-pod-b")).toHaveTextContent("2");
    expect(within(detail).getAllByTestId("log-pod-label")).toHaveLength(4);

    // Toggle regex search `50[23]` -> matches both pods & renders <mark> highlights
    await userEvent.click(within(detail).getByTestId("log-regex-toggle"));
    await userEvent.type(within(detail).getByLabelText("Search logs"), "50[23]");
    expect(within(detail).getAllByTestId("log-search-match")).toHaveLength(2);

    // Filter down to a single pod via its Stern color chip
    await userEvent.click(within(detail).getByTestId("log-pod-chip-web-api-pod-a"));
    expect(within(detail).getAllByTestId("log-pod-label")).toHaveLength(1);
    expect(within(detail).getByTestId("log-pod-label")).toHaveTextContent("pod-a");
    expect(within(detail).getByTestId("log-pod-label")).toHaveAttribute(
      "title",
      "web-api-pod-a/app",
    );

    // Toggle line wrapping on/off directly from the Logs toolbar (defaults to no-wrap)
    const scrollBox = within(detail).getByTestId("logs-scroll-container");
    const wrapBtn = within(detail).getByTestId("toggle-log-wrap");
    expect(scrollBox).toHaveAttribute("data-log-wrap", "false");
    expect(wrapBtn).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(wrapBtn);
    expect(scrollBox).toHaveAttribute("data-log-wrap", "true");
    expect(wrapBtn).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(wrapBtn);
    expect(scrollBox).toHaveAttribute("data-log-wrap", "false");
  });

  it("filters resource rows across multiple selected namespaces using a single cluster-wide watch", async () => {
    const cluster = ctx("multi-ns", { state: "ready" });
    const listNamespaces: string[] = [];

    setIpcTransport({
      invoke: (async (command: string, args?: unknown) => {
        if (command === "list_contexts") return [cluster];
        if (command === "discover_resources") return [pods];
        if (command === "list_resources") {
          const payload = args as { namespace?: string } | undefined;
          const ns = payload?.namespace ?? "";
          listNamespaces.push(ns);
          const allPods = [
            {
              uid: "p-def",
              name: "web-default",
              namespace: "default",
              kind: "Pod",
              createdAt: "2026-01-01T00:00:00Z",
              labels: {},
            },
            {
              uid: "p-prod",
              name: "api-prod",
              namespace: "prod",
              kind: "Pod",
              createdAt: "2026-01-01T00:00:00Z",
              labels: {},
            },
            {
              uid: "p-sys",
              name: "coredns",
              namespace: "kube-system",
              kind: "Pod",
              createdAt: "2026-01-01T00:00:00Z",
              labels: {},
            },
          ];
          return ns ? allPods.filter((p) => p.namespace === ns) : allPods;
        }
        return [];
      }) as IpcTransport["invoke"],
      listen: async () => () => {},
    });

    renderWithQuery(<App />);
    await waitFor(() => expect(screen.getAllByTestId("cluster-card")).toHaveLength(1));
    await userEvent.click(screen.getByTestId("open-cluster"));
    await waitFor(() => expect(screen.getByRole("button", { name: "WorkLoad" })).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: "WorkLoad" }));
    await userEvent.click(await screen.findByTestId("resource-type"));
    await waitFor(() => expect(screen.getAllByTestId("resource-row")).toHaveLength(1));

    // Switch to All Namespaces first so all 3 namespaces are observed
    await userEvent.click(screen.getByTestId("namespace-filter"));
    await userEvent.click(screen.getByTestId("namespace-all-toggle"));
    await waitFor(() => expect(screen.getAllByTestId("resource-row")).toHaveLength(3));

    // Multi-select default + prod -> kube-system pod is filtered out
    await userEvent.click(screen.getByTestId("namespace-filter"));
    await userEvent.click(
      screen.getAllByTestId("namespace-option").find((el) => el.getAttribute("data-namespace") === "default")!,
    );
    await userEvent.click(
      screen.getAllByTestId("namespace-option").find((el) => el.getAttribute("data-namespace") === "prod")!,
    );

    await waitFor(() => expect(screen.getAllByTestId("resource-row")).toHaveLength(2));
    const names = screen.getAllByTestId("resource-row").map((el) => el.getAttribute("aria-label"));
    expect(names).toEqual(["Open Pod web-default", "Open Pod api-prod"]);
    expect(screen.getByTestId("namespace-filter")).toHaveAttribute("data-value", "default,prod");
    expect(listNamespaces).toContain("");
  });

  it("filters Pod rows by one or multiple statuses and supports Issues only quick filter", async () => {
    const cluster = ctx("status-pod-cluster", { state: "ready" });

    setIpcTransport({
      invoke: (async (command: string) => {
        if (command === "list_contexts") return [cluster];
        if (command === "discover_resources") return [pods];
        if (command === "list_resources") {
          return [
            {
              uid: "p-run",
              name: "api-running",
              namespace: "default",
              kind: "Pod",
              status: "Running",
              ready: "1/1",
              createdAt: "2026-01-01T00:00:00Z",
              labels: {},
            },
            {
              uid: "p-succ",
              name: "backup-job-done",
              namespace: "default",
              kind: "Pod",
              status: "Succeeded",
              ready: "0/1",
              createdAt: "2026-01-01T00:00:00Z",
              labels: {},
            },
            {
              uid: "p-crash",
              name: "worker-crash",
              namespace: "default",
              kind: "Pod",
              status: "CrashLoopBackOff",
              ready: "0/1",
              restarts: 5,
              createdAt: "2026-01-01T00:00:00Z",
              labels: {},
            },
            {
              uid: "p-pend",
              name: "scheduler-pending",
              namespace: "default",
              kind: "Pod",
              status: "Pending",
              ready: "0/1",
              createdAt: "2026-01-01T00:00:00Z",
              labels: {},
            },
          ];
        }
        return [];
      }) as IpcTransport["invoke"],
      listen: async () => () => {},
    });

    renderWithQuery(<App />);
    await waitFor(() => expect(screen.getAllByTestId("cluster-card")).toHaveLength(1));
    await userEvent.click(screen.getByTestId("open-cluster"));
    await waitFor(() => expect(screen.getByRole("button", { name: "WorkLoad" })).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: "WorkLoad" }));
    await userEvent.click(await screen.findByTestId("resource-type"));
    await waitFor(() => expect(screen.getAllByTestId("resource-row")).toHaveLength(4));

    // Open Pod Status filter -> unhealthy statuses appear at top with counts
    await userEvent.click(screen.getByTestId("pod-status-filter"));
    const optionStatuses = screen
      .getAllByTestId("status-option")
      .map((el) => el.getAttribute("data-status"));
    expect(optionStatuses).toEqual(["CrashLoopBackOff", "Pending", "Running", "Succeeded"]);

    // Click "Issues only" -> shows only CrashLoopBackOff + Pending (2 pods)
    await userEvent.click(screen.getByTestId("status-issues-only"));
    await waitFor(() => expect(screen.getAllByTestId("resource-row")).toHaveLength(2));
    expect(
      screen.getAllByTestId("resource-row").map((el) => el.getAttribute("aria-label")),
    ).toEqual(["Open Pod scheduler-pending", "Open Pod worker-crash"]);

    // Reopen and isolate only Running via hover `only` button
    await userEvent.click(screen.getByTestId("pod-status-filter"));
    await userEvent.click(screen.getByTestId("status-only-Running"));
    await waitFor(() => expect(screen.getAllByTestId("resource-row")).toHaveLength(1));
    expect(screen.getByTestId("resource-row")).toHaveAttribute("aria-label", "Open Pod api-running");
  });

  it("resizes NavigationSidebar via drag, keyboard, double-click reset, and persists width", () => {
    window.localStorage.removeItem("kubix:sidebar-width:v1");
    Object.defineProperty(window, "innerWidth", { value: 1440, writable: true, configurable: true });

    const mousePointer = (type: string, init: MouseEventInit): MouseEvent => {
      const ev = new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
      Object.defineProperty(ev, "pointerType", { value: "mouse" });
      return ev;
    };

    const { unmount } = render(
      <NavigationSidebar
        activeContext={{
          id: "kind-dev",
          name: "kind-dev",
          clusterName: "kind-dev",
          server: "https://127.0.0.1:6443",
          namespaceDefault: "default",
          authKind: "clientCert",
          isCurrent: true,
          state: "ready",
          issues: [],
          pending: false,
        }}
        resources={[]}
        isLoadingDiscovery={false}
        discoveryError={null}
        activeGvr={null}
        activeSpecialView={null}
        open={false}
        onCloseMobile={vi.fn()}
        onSelectResource={vi.fn()}
        onSelectSpecial={vi.fn()}
      />,
    );

    const aside = screen.getByTestId("cluster-sidebar");
    const handle = screen.getByTestId("sidebar-resize-handle");
    expect(aside.style.getPropertyValue("--sidebar-width")).toBe("224px");
    expect(handle).toHaveAttribute("aria-valuenow", "224");

    // Right-click must not initiate drag
    fireEvent(handle, mousePointer("pointerdown", { button: 2, buttons: 2, clientX: 280 }));
    fireEvent(window, mousePointer("pointermove", { buttons: 2, clientX: 360 }));
    expect(aside.style.getPropertyValue("--sidebar-width")).toBe("224px");

    // Primary drag right by +80px -> 304px and persists on release
    fireEvent(handle, mousePointer("pointerdown", { button: 0, buttons: 1, clientX: 280 }));
    fireEvent(window, mousePointer("pointermove", { buttons: 1, clientX: 360 }));
    expect(aside.style.getPropertyValue("--sidebar-width")).toBe("304px");
    expect(handle).toHaveAttribute("aria-valuenow", "304");

    fireEvent(window, mousePointer("pointerup", { buttons: 0, clientX: 360 }));
    expect(window.localStorage.getItem("kubix:sidebar-width:v1")).toBe("304");

    // Missed pointerup guard: mouse move with buttons=0 stops dragging cleanly
    fireEvent(handle, mousePointer("pointerdown", { button: 0, buttons: 1, clientX: 360 }));
    fireEvent(window, mousePointer("pointermove", { buttons: 0, clientX: 460 }));
    expect(aside.style.getPropertyValue("--sidebar-width")).toBe("304px");

    // Clamps beyond max (420px) and min (180px)
    fireEvent(handle, mousePointer("pointerdown", { button: 0, buttons: 1, clientX: 360 }));
    fireEvent(window, mousePointer("pointermove", { buttons: 1, clientX: 900 }));
    expect(aside.style.getPropertyValue("--sidebar-width")).toBe("420px");
    fireEvent(window, mousePointer("pointerup", { buttons: 0, clientX: 900 }));

    // Narrow viewport resize re-clamps wide sidebar so main workspace keeps reserve
    Object.defineProperty(window, "innerWidth", { value: 650, writable: true, configurable: true });
    fireEvent(window, new Event("resize"));
    expect(aside.style.getPropertyValue("--sidebar-width")).toBe("274px");

    // Restore wide viewport, test keyboard + double-click reset
    Object.defineProperty(window, "innerWidth", { value: 1440, writable: true, configurable: true });
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(aside.style.getPropertyValue("--sidebar-width")).toBe("290px");
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(aside.style.getPropertyValue("--sidebar-width")).toBe("274px");
    fireEvent.keyDown(handle, { key: "Home" });
    expect(aside.style.getPropertyValue("--sidebar-width")).toBe("180px");
    fireEvent.keyDown(handle, { key: "End" });
    expect(aside.style.getPropertyValue("--sidebar-width")).toBe("420px");

    fireEvent.doubleClick(handle);
    expect(aside.style.getPropertyValue("--sidebar-width")).toBe("224px");
    expect(window.localStorage.getItem("kubix:sidebar-width:v1")).toBe("224");

    // Synchronous pointerdown + pointerup in same tick (before effects flush) must not leave body cursor stuck
    act(() => {
      handle.dispatchEvent(mousePointer("pointerdown", { button: 0, buttons: 1, clientX: 224 }));
      window.dispatchEvent(mousePointer("pointerup", { buttons: 0, clientX: 224 }));
    });
    expect(document.body.style.cursor).toBe("");

    unmount();
  });

  it("opens ResourceDetail as a Freelens-style floating overlay drawer without shrinking the list", async () => {
    window.localStorage.removeItem("kubix:inspector-width:v1");
    setIpcTransport({
      invoke: (async (command: string, args?: Record<string, unknown>) => {
        if (command === "list_contexts") {
          return [
            {
              id: "kind-dev",
              name: "kind-dev",
              clusterName: "kind-dev",
              server: "https://127.0.0.1:6443",
              namespaceDefault: "default",
              authKind: "clientCert",
              isCurrent: true,
              state: "ready",
              issues: [],
            },
          ];
        }
        if (command === "connect_context") {
          return {
            id: "kind-dev",
            name: "kind-dev",
            clusterName: "kind-dev",
            server: "https://127.0.0.1:6443",
            namespaceDefault: "default",
            authKind: "clientCert",
            isCurrent: true,
            state: "ready",
            issues: [],
          };
        }
        if (command === "discover_resources") {
          return [
            {
              gvr: "/v1/pods",
              kind: "Pod",
              group: "",
              version: "v1",
              plural: "pods",
              namespaced: true,
              shortNames: ["po"],
              verbs: ["get", "list", "watch"],
              curated: true,
            },
          ];
        }
        if (command === "list_resources") {
          return [
            {
              uid: "p-1",
              name: "pod-alpha",
              namespace: "default",
              kind: "Pod",
              status: "Running",
              ready: "1/1",
              createdAt: "2026-01-01T00:00:00Z",
              labels: {},
            },
            {
              uid: "p-2",
              name: "pod-beta",
              namespace: "default",
              kind: "Pod",
              status: "Running",
              ready: "1/1",
              createdAt: "2026-01-01T00:00:00Z",
              labels: {},
            },
          ];
        }
        if (command === "get_resource") {
          const name = String(args?.name ?? "pod-alpha");
          return {
            contextId: "kind-dev",
            gvr: "/v1/pods",
            name,
            namespace: "default",
            yaml: `apiVersion: v1\nkind: Pod\nmetadata:\n  name: ${name}\n  namespace: default\n`,
            maskedPaths: [],
          };
        }
        return [];
      }) as IpcTransport["invoke"],
      listen: async () => () => {},
    });

    const mousePointer = (type: string, init: MouseEventInit): MouseEvent => {
      const ev = new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
      Object.defineProperty(ev, "pointerType", { value: "mouse" });
      return ev;
    };

    renderWithQuery(<App />);
    await waitFor(() => expect(screen.getAllByTestId("cluster-card")).toHaveLength(1));
    await userEvent.click(screen.getByTestId("open-cluster"));
    await waitFor(() => expect(screen.getByRole("button", { name: "WorkLoad" })).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: "WorkLoad" }));
    await userEvent.click(await screen.findByTestId("resource-type"));
    await waitFor(() => expect(screen.getAllByTestId("resource-row")).toHaveLength(2));

    // Open first Pod -> drawer floats over the list without hiding/shrinking the list pane
    await userEvent.click(screen.getByRole("button", { name: "Open Pod pod-alpha" }));
    const drawer = await screen.findByTestId("resource-inspector-drawer");
    const listPane = screen.getByTestId("resource-list-pane");

    expect(drawer.className).toContain("absolute");
    expect(drawer.className).toContain("right-0");
    expect(drawer.className).toContain("inset-y-0");
    expect(listPane.className).toContain("flex-1");
    expect(listPane.className).not.toContain("max-[1199px]:hidden");
    expect(drawer.style.width).toBe("42%");

    // Floating drawer always shows the X close button (never hidden below 1200px) and no Back button
    const closeBtn = screen.getByRole("button", { name: "Close detail" });
    expect(closeBtn.className).not.toContain("max-[1199px]:hidden");
    expect(screen.queryByRole("button", { name: "Back to list" })).not.toBeInTheDocument();

    // Drag resize separator left -> widens drawer and persists width on release
    const separator = screen.getByRole("separator", { name: "Resize resource inspector" });
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue({ width: 1000, right: 1200 } as DOMRect);

    // Right-click must not resize
    fireEvent(separator, mousePointer("pointerdown", { button: 2, buttons: 2, clientX: 780 }));
    fireEvent(window, mousePointer("pointermove", { buttons: 2, clientX: 600 }));
    expect(drawer.style.width).toBe("42%");

    // Primary drag left to clientX=600 -> width = (1200 - 600)/1000 = 60%
    fireEvent(separator, mousePointer("pointerdown", { button: 0, buttons: 1, clientX: 780 }));
    fireEvent(window, mousePointer("pointermove", { buttons: 1, clientX: 600 }));
    expect(drawer.style.width).toBe("60%");
    expect(separator).toHaveAttribute("aria-valuenow", "60");
    fireEvent(window, mousePointer("pointerup", { buttons: 0, clientX: 600 }));
    expect(window.localStorage.getItem("kubix:inspector-width:v1")).toBe("60");

    // Double-click separator resets to 42%
    fireEvent.doubleClick(separator);
    expect(drawer.style.width).toBe("42%");
    expect(window.localStorage.getItem("kubix:inspector-width:v1")).toBe("42");

    // Clicking another row swaps content in place without closing the drawer
    await userEvent.click(screen.getByRole("button", { name: "Open Pod pod-beta" }));
    expect(await screen.findByTestId("resource-detail")).toHaveTextContent("pod-beta");

    // Pressing Escape while an open popover (Cmd+K search) is active must NOT close the drawer underneath
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(await screen.findByTestId("command-palette-popover")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("command-palette-popover")).not.toBeInTheDocument();
    expect(screen.getByTestId("resource-inspector-drawer")).toBeInTheDocument();

    // Starting a drawer drag and pressing Escape mid-drag closes the drawer and restores body cursor
    fireEvent(separator, mousePointer("pointerdown", { button: 0, buttons: 1, clientX: 780 }));
    expect(document.body.style.cursor).toBe("col-resize");
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByTestId("resource-inspector-drawer")).not.toBeInTheDocument();
    });
    expect(document.body.style.cursor).toBe("");

    // Reopen and verify clicking outside still closes the floating drawer
    await userEvent.click(screen.getByRole("button", { name: "Open Pod pod-alpha" }));
    expect(await screen.findByTestId("resource-inspector-drawer")).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByTestId("row-count"));
    await waitFor(() => {
      expect(screen.queryByTestId("resource-inspector-drawer")).not.toBeInTheDocument();
    });

    rectSpy.mockRestore();
  });

  it("supports per-cluster multi-tab state preservation, watch gating, history pruning, and native Cmd+W", async () => {
    const stopWatchCalls: Array<{ gvr: string; namespace: string }> = [];
    let emitCloseActiveTab: (() => void) | null = null;
    const onCloseWindow = vi.fn();

    setIpcTransport({
      invoke: (async (command: string, args: Record<string, unknown>) => {
        switch (command) {
          case "list_contexts":
            return [ctx("cluster-a"), ctx("cluster-b")];
          case "connect_context":
            return ctx(String(args.contextId ?? "cluster-a"));
          case "disconnect_context":
            return ctx(String(args.contextId ?? "cluster-a"), { state: "disconnected" });
          case "discover_resources":
            return [pods, deployments];
          case "list_resources": {
            const gvr = String(args.gvr ?? "");
            if (gvr === "/v1/pods") {
              return [
                {
                  uid: "p-1",
                  name: "api-pod",
                  namespace: "default",
                  kind: "Pod",
                  status: "Running",
                  ready: "1/1",
                  createdAt: "2026-01-01T00:00:00Z",
                  labels: {},
                },
                {
                  uid: "p-2",
                  name: "worker-pod",
                  namespace: "default",
                  kind: "Pod",
                  status: "Running",
                  ready: "1/1",
                  createdAt: "2026-01-01T00:00:00Z",
                  labels: {},
                },
              ];
            }
            if (gvr === "apps/v1/deployments") {
              return [
                {
                  uid: "d-1",
                  name: "web-deploy",
                  namespace: "default",
                  kind: "Deployment",
                  status: "Running",
                  ready: "1/1",
                  createdAt: "2026-01-01T00:00:00Z",
                  labels: {},
                },
              ];
            }
            return [];
          }
          case "stop_watch":
            stopWatchCalls.push({
              gvr: String(args.gvr ?? ""),
              namespace: String(args.namespace ?? ""),
            });
            return null;
          case "get_resource": {
            const name = String(args.name ?? "api-pod");
            const gvr = String(args.gvr ?? "/v1/pods");
            const kind = gvr === "/v1/pods" ? "Pod" : "Deployment";
            return {
              contextId: String(args.contextId ?? "cluster-a"),
              gvr,
              name,
              namespace: "default",
              yaml: `apiVersion: v1\nkind: ${kind}\nmetadata:\n  name: ${name}\n  namespace: default\nspec:\n  containers:\n    - name: app\n      image: nginx:1.25\n`,
              maskedPaths: [],
            };
          }
          case "get_pod_logs":
            return { pods: ["api-pod"], containers: ["app"], initContainers: [], chunks: [] };
          case "get_cluster_overview":
            return {
              contextId: String(args.contextId ?? "cluster-a"),
              nodes: [],
              totalPods: 2,
              runningPods: 2,
              failingPods: 0,
              totalDeployments: 1,
              healthyDeployments: 1,
              totalNamespaces: 1,
              recentEvents: [],
            };
          default:
            return [];
        }
      }) as IpcTransport["invoke"],
      listen: (async (event: string, handler: (payload: unknown) => void) => {
        if (event === "kubix://close-active-tab") {
          emitCloseActiveTab = () => handler(null);
        }
        return () => {
          if (event === "kubix://close-active-tab") {
            emitCloseActiveTab = null;
          }
        };
      }) as IpcTransport["listen"],
    });

    renderWithQuery(<App onCloseWindow={onCloseWindow} />);
    await waitFor(() => expect(screen.getAllByTestId("cluster-card")).toHaveLength(2));

    // On ClusterPicker, native Cmd+W event triggers onCloseWindow
    expect(emitCloseActiveTab).not.toBeNull();
    act(() => {
      emitCloseActiveTab?.();
    });
    expect(onCloseWindow).toHaveBeenCalledTimes(1);

    // Open cluster-a -> starts on Cluster Overview (1 tab)
    await userEvent.click(screen.getAllByTestId("open-cluster")[0]!);
    await waitFor(() => expect(screen.getByRole("button", { name: "WorkLoad" })).toBeInTheDocument());
    expect(screen.getAllByTestId("workspace-tab")).toHaveLength(1);

    // Native Cmd+W when only Cluster Overview is open is a no-op (does not close window)
    act(() => {
      emitCloseActiveTab?.();
    });
    expect(onCloseWindow).toHaveBeenCalledTimes(1);
    expect(screen.getAllByTestId("workspace-tab")).toHaveLength(1);

    // Open Pods tab, filter rows to "api", and open floating drawer on api-pod
    await userEvent.click(screen.getByRole("button", { name: "WorkLoad" }));
    const podBtn = screen
      .getAllByTestId("resource-type")
      .find((el) => el.dataset.gvr === "/v1/pods") as HTMLElement;
    await userEvent.click(podBtn);
    await waitFor(() => expect(screen.getByText("api-pod")).toBeInTheDocument());
    expect(screen.getAllByTestId("workspace-tab")).toHaveLength(2);

    const filterInput = screen.getByTestId("row-filter");
    await userEvent.type(filterInput, "api");
    expect(filterInput).toHaveValue("api");
    expect(screen.queryByText("worker-pod")).not.toBeInTheDocument();

    // Shortcuts must NOT fire while focused inside row-filter input
    fireEvent.keyDown(filterInput, { key: "1", metaKey: true });
    expect(screen.getAllByTestId("workspace-tab")[1]).toHaveAttribute("data-active", "true");

    await userEvent.click(screen.getByRole("button", { name: "Open Pod api-pod" }));
    expect(await screen.findByTestId("resource-inspector-drawer")).toBeInTheDocument();

    // Open Deployments tab -> Pods state is isolated & watch for /v1/pods stops
    const deployBtn = screen
      .getAllByTestId("resource-type")
      .find((el) => el.dataset.gvr === "apps/v1/deployments") as HTMLElement;
    await userEvent.click(deployBtn);
    await waitFor(() => expect(screen.getByText("web-deploy")).toBeInTheDocument());
    expect(screen.getAllByTestId("workspace-tab")).toHaveLength(3);
    expect(screen.getByTestId("row-filter")).toHaveValue("");
    expect(screen.queryByTestId("resource-inspector-drawer")).not.toBeInTheDocument();
    expect(stopWatchCalls.some((c) => c.gvr === "/v1/pods")).toBe(true);

    // Switch back to Pods via Cmd+2 -> restores row filter "api" and floating drawer
    fireEvent.keyDown(window, { key: "2", metaKey: true });
    await waitFor(() => expect(screen.getByTestId("row-filter")).toHaveValue("api"));
    expect(screen.getByTestId("resource-inspector-drawer")).toBeInTheDocument();

    // Expand api-pod into full tab (overview), then re-open same pod to logs -> dedupes & updates detailTab
    await userEvent.click(screen.getByLabelText("Open in workspace tab"));
    await waitFor(() => expect(screen.getAllByTestId("workspace-tab")).toHaveLength(4));
    expect(screen.getByTestId("detail-tab-overview")).toHaveAttribute("aria-selected", "true");

    // Switch to Pods (Cmd+2), open api-pod drawer -> switch drawer to Logs -> expand to full tab
    fireEvent.keyDown(window, { key: "2", metaKey: true });
    await waitFor(() => expect(screen.getByTestId("resource-table")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Open Pod api-pod" }));
    expect(await screen.findByTestId("resource-inspector-drawer")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("detail-tab-logs"));
    await userEvent.click(screen.getByLabelText("Open in workspace tab"));
    await waitFor(() => expect(screen.getByTestId("detail-tab-logs")).toHaveAttribute("aria-selected", "true"));
    expect(screen.getAllByTestId("workspace-tab")).toHaveLength(4);

    // Switch to Events tab -> stops background /v1/pods watch and adds 5th tab
    stopWatchCalls.length = 0;
    const sidebarNav = screen.getByTestId("cluster-sidebar");
    await userEvent.click(within(sidebarNav).getByText("Events"));
    await waitFor(() => expect(screen.getAllByTestId("workspace-tab")).toHaveLength(5));
    expect(screen.getAllByTestId("workspace-tab")[4]).toHaveAttribute("data-active", "true");

    // Ctrl+Tab wraps from last tab to first tab (Cluster Overview)
    fireEvent.keyDown(window, { key: "Tab", ctrlKey: true });
    await waitFor(() =>
      expect(screen.getAllByTestId("workspace-tab")[0]).toHaveAttribute("data-active", "true"),
    );

    // Cmd+9 jumps to last tab (Events)
    fireEvent.keyDown(window, { key: "9", metaKey: true });
    await waitFor(() =>
      expect(screen.getAllByTestId("workspace-tab")[4]).toHaveAttribute("data-active", "true"),
    );

    // Shortcuts suppressed when SettingsModal dialog is open
    fireEvent.keyDown(window, { key: ",", metaKey: true });
    expect(await screen.findByTestId("settings-modal")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "1", metaKey: true });
    expect(screen.getAllByTestId("workspace-tab")[4]).toHaveAttribute("data-active", "true");
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("settings-modal")).not.toBeInTheDocument());

    // Close Deployments (inactive tab) -> Events stays active; Back skips closed Deployments
    await userEvent.click(screen.getByLabelText("Close tab Deployment"));
    expect(screen.getAllByTestId("workspace-tab")).toHaveLength(4);
    expect(screen.getAllByTestId("workspace-tab")[3]).toHaveAttribute("data-active", "true");

    // Right-click Pods -> Close Others leaves only Pods; native Cmd+W on lone non-overview tab resets to Cluster Overview
    const tabsBeforeCloseOthers = screen.getAllByTestId("workspace-tab");
    fireEvent.contextMenu(tabsBeforeCloseOthers[1]!);
    await userEvent.click(
      within(screen.getByTestId("tab-context-menu")).getByRole("menuitem", { name: "Close Others" }),
    );
    await waitFor(() => expect(screen.getAllByTestId("workspace-tab")).toHaveLength(1));
    expect(screen.getAllByTestId("workspace-tab")[0]).toHaveTextContent("Pod");

    act(() => {
      emitCloseActiveTab?.();
    });
    await waitFor(() =>
      expect(screen.getAllByTestId("workspace-tab")[0]).toHaveTextContent("Cluster Overview"),
    );
    expect(onCloseWindow).toHaveBeenCalledTimes(1);
  });
});
