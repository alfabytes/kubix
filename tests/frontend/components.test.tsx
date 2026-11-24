import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { StatusBadge } from "@/components/clusters/status-badge";
import { ClusterCard } from "@/components/clusters/cluster-card";
import { NamespacePicker } from "@/components/explorer/namespace-picker";
import { ResourceTable } from "@/components/explorer/resource-table";
import type {
  ClusterContextDto,
  DiscoveredResourceDto,
  ResourceSummaryDto,
} from "@/lib/ipc/types";
import { useClusterProfileStore } from "@/stores/cluster-profile-store";
import { useClusterStore } from "@/stores/cluster-store";
import type { ResourceView } from "@/stores/explorer-store";

const context = (over: Partial<ClusterContextDto> = {}): ClusterContextDto => ({
  id: "kind-dev",
  name: "kind-dev",
  clusterName: "kind-dev",
  server: "127.0.0.1:6443",
  namespaceDefault: "default",
  authKind: "clientCert",
  isCurrent: true,
  state: "disconnected",
  issues: [],
  ...over,
});

const deployment: DiscoveredResourceDto = {
  gvr: "apps/v1/deployments",
  kind: "Deployment",
  group: "apps",
  version: "v1",
  plural: "deployments",
  namespaced: true,
  shortNames: [],
  verbs: ["get", "list", "watch"],
  curated: true,
};

const view = (over: Partial<ResourceView> = {}): ResourceView => ({
  status: "ready",
  rows: [],
  error: null,
  evicted: false,
  truncated: false,
  namespace: "",
  loadedAt: Date.now(),
  ...over,
});

const row = (uid: string, name: string, over: Partial<ResourceSummaryDto> = {}): ResourceSummaryDto => ({
  uid,
  name,
  namespace: "dev",
  kind: "Deployment",
  createdAt: "2026-01-01T00:00:00Z",
  labels: {},
  ...over,
});

beforeEach(() => {
  useClusterStore.getState().reset();
  useClusterProfileStore.getState().reset();
});

describe("StatusBadge", () => {
  it("renders the connected tone for ready", () => {
    render(<StatusBadge context={{ state: "ready" }} />);
    const badge = screen.getByTestId("status-badge");
    expect(badge).toHaveTextContent("Connected");
    expect(badge).toHaveAttribute("data-tone", "ok");
  });

  it("shows connecting while a connect attempt is pending", () => {
    render(<StatusBadge context={{ state: "disconnected", pending: true }} />);
    expect(screen.getByTestId("status-badge")).toHaveAttribute("data-state", "connecting");
  });

  it("surfaces the backend message for auth failures", () => {
    render(
      <StatusBadge
        context={{
          state: "authFailed",
          lastError: { code: "authFailed", message: "expired token", retryable: false },
        }}
      />,
    );
    expect(screen.getByTestId("status-badge")).toHaveAttribute("title", "expired token");
  });
});

describe("ClusterCard", () => {
  it("offers connect when disconnected", async () => {
    const onConnect = vi.fn();
    render(
      <ClusterCard
        context={context()}
        onConnect={onConnect}
        onDisconnect={vi.fn()}
        onSelect={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByTestId("connect-cluster"));
    expect(onConnect).toHaveBeenCalledWith("kind-dev");
  });

  it("labels a failed connection as retry", () => {
    render(
      <ClusterCard
        context={context({
          state: "authFailed",
          lastError: { code: "authFailed", message: "bad creds", retryable: false },
        })}
        onConnect={vi.fn()}
        onDisconnect={vi.fn()}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByTestId("connect-cluster")).toHaveTextContent("Retry");
    expect(screen.getByTestId("cluster-error")).toHaveTextContent("bad creds");
  });

  it("shows unreachable differently from auth failures", () => {
    render(
      <ClusterCard
        context={context({
          state: "unreachable",
          lastError: { code: "clusterUnreachable", message: "connection refused", retryable: true },
        })}
        onConnect={vi.fn()}
        onDisconnect={vi.fn()}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByTestId("status-badge")).toHaveAttribute("data-state", "unreachable");
    expect(screen.getByTestId("cluster-error")).toHaveTextContent("retry when ready");
  });

  it("offers open and disconnect when ready", async () => {
    const onSelect = vi.fn();
    const onDisconnect = vi.fn();
    render(
      <ClusterCard
        context={context({ state: "ready" })}
        onConnect={vi.fn()}
        onDisconnect={onDisconnect}
        onSelect={onSelect}
      />,
    );
    await userEvent.click(screen.getByTestId("open-cluster"));
    await userEvent.click(screen.getByText("Disconnect"));
    expect(onSelect).toHaveBeenCalledWith("kind-dev");
    expect(onDisconnect).toHaveBeenCalledWith("kind-dev");
  });

  it("lists kubeconfig issues so broken contexts are visible", () => {
    render(
      <ClusterCard
        context={context({ issues: ["cluster 'missing' is not defined"] })}
        onConnect={vi.fn()}
        onDisconnect={vi.fn()}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByTestId("cluster-issues")).toHaveTextContent("missing");
  });
});

describe("ResourceTable", () => {
  it("prompts to pick a type when no resource is selected", () => {
    render(
      <ResourceTable
        resource={null}
        view={view()}
        isFetching={false}
        error={null}
        selectedName={null}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText("Select a resource type.")).toBeInTheDocument();
  });

  it("virtualizes large lists to a window", () => {
    const rows = Array.from({ length: 5000 }, (_, i) => row(`u${i}`, `deployment-${i}`));
    render(
      <ResourceTable
        resource={deployment}
        view={view({ rows })}
        isFetching={false}
        error={null}
        selectedName={null}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByTestId("row-count")).toHaveTextContent("5000 items");
    const rendered = screen.getAllByTestId("resource-row");
    expect(rendered.length).toBeLessThan(60);
    expect(rendered.length).toBeGreaterThan(0);
  });

  it("calls onSelect with the row payload", async () => {
    const onSelect = vi.fn();
    render(
      <ResourceTable
        resource={deployment}
        view={view({ rows: [row("u1", "web")] })}
        isFetching={false}
        error={null}
        selectedName={null}
        onSelect={onSelect}
      />,
    );
    await userEvent.click(screen.getByTestId("resource-row"));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ name: "web", uid: "u1" }));
  });

  it("shows an error block when the list request failed", () => {
    render(
      <ResourceTable
        resource={deployment}
        view={view({ status: "error", error: "forbidden" })}
        isFetching={false}
        error="forbidden"
        selectedName={null}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByTestId("list-error")).toHaveTextContent("forbidden");
  });

  it("shows an empty state for an empty scope", () => {
    render(
      <ResourceTable
        resource={deployment}
        view={view({ rows: [] })}
        isFetching={false}
        error={null}
        selectedName={null}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByTestId("list-empty")).toHaveTextContent("No deployment");
  });

  it("hides the namespace column for cluster-scoped resources", () => {
    const clusterScoped = { ...deployment, namespaced: false, kind: "Node", gvr: "/v1/nodes" };
    render(
      <ResourceTable
        resource={clusterScoped}
        view={view({ rows: [row("u1", "node-a", { namespace: undefined })] })}
        isFetching={false}
        error={null}
        selectedName={null}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.queryByText("Namespace")).not.toBeInTheDocument();
  });

  it("renders Containers column for Pods and Pods ratio column for Deployments", () => {
    const podResource = { ...deployment, kind: "Pod", plural: "pods", gvr: "/v1/pods" };
    const { rerender } = render(
      <ResourceTable
        resource={podResource}
        view={view({ rows: [row("p1", "web-0", { kind: "Pod" })] })}
        isFetching={false}
        error={null}
        selectedName={null}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText("Containers")).toBeInTheDocument();
    expect(screen.queryByText("Pods")).not.toBeInTheDocument();

    rerender(
      <ResourceTable
        resource={deployment}
        view={view({ rows: [row("d1", "web", { kind: "Deployment" })] })}
        isFetching={false}
        error={null}
        selectedName={null}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText("Pods")).toBeInTheDocument();
  });
});

describe("NamespacePicker", () => {
  it("never offers all namespaces as a text-entry accident", async () => {
    const onChange = vi.fn();
    render(
      <NamespacePicker
        value="dev"
        defaultValue="dev"
        observed={["kube-system", "monitoring"]}
        onChange={onChange}
      />,
    );
    const trigger = screen.getByTestId("namespace-filter");
    expect(trigger).toHaveAttribute("data-value", "dev");
    expect(trigger).toHaveTextContent("dev");

    await userEvent.click(trigger);
    expect(screen.getByTestId("namespace-popover")).toBeInTheDocument();
    expect(screen.getByTestId("namespace-all-toggle")).toHaveAttribute("data-active", "false");
    const values = screen
      .getAllByTestId("namespace-option")
      .map((el) => el.getAttribute("data-namespace"));
    expect(values).toContain("dev");
    expect(values).toContain("monitoring");
  });

  it("toggles to all namespaces and selects a specific namespace", async () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <NamespacePicker value="dev" defaultValue="dev" observed={["kube-system"]} onChange={onChange} />,
    );
    await userEvent.click(screen.getByTestId("namespace-filter"));
    await userEvent.click(screen.getByTestId("namespace-all-toggle"));
    expect(onChange).toHaveBeenCalledWith("");

    onChange.mockClear();
    rerender(
      <NamespacePicker value="" defaultValue="dev" observed={["kube-system"]} onChange={onChange} />,
    );
    expect(screen.getByTestId("namespace-filter")).toHaveTextContent("All Namespaces");
    await userEvent.click(screen.getByTestId("namespace-filter"));
    expect(screen.getByTestId("namespace-all-toggle")).toHaveAttribute("data-active", "true");
    await userEvent.click(
      screen.getAllByTestId("namespace-option").find((el) => el.getAttribute("data-namespace") === "dev")!,
    );
    expect(onChange).toHaveBeenCalledWith("dev");
  });

  it("deduplicates and sorts observed namespaces", async () => {
    render(
      <NamespacePicker
        value="dev"
        defaultValue="dev"
        observed={["b", "a", "dev", ""]}
        onChange={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByTestId("namespace-filter"));
    const values = screen
      .getAllByTestId("namespace-option")
      .map((el) => el.getAttribute("data-namespace"));
    expect(values).toEqual(["a", "b", "dev"]);
  });

  it("supports selecting multiple namespaces, isolating with only, and searching", async () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <NamespacePicker
        value="dev"
        defaultValue="dev"
        observed={["kube-system", "monitoring", "prod", "staging"]}
        onChange={onChange}
      />,
    );

    await userEvent.click(screen.getByTestId("namespace-filter"));

    // Filter namespaces inside the popover
    await userEvent.type(screen.getByTestId("namespace-search-input"), "prod");
    expect(
      screen.getAllByTestId("namespace-option").map((el) => el.getAttribute("data-namespace")),
    ).toEqual(["prod"]);

    // Clicking prod adds it alongside dev (popover stays open for multi-select)
    await userEvent.click(screen.getByTestId("namespace-option"));
    expect(onChange).toHaveBeenCalledWith("dev,prod");
    expect(screen.getByTestId("namespace-popover")).toBeInTheDocument();

    // Rerender with both selected -> trigger shows both & count badge
    onChange.mockClear();
    rerender(
      <NamespacePicker
        value="dev,prod"
        defaultValue="dev"
        observed={["kube-system", "monitoring", "prod", "staging"]}
        onChange={onChange}
      />,
    );
    expect(screen.getByTestId("namespace-filter")).toHaveAttribute("data-value", "dev,prod");
    expect(screen.getByTestId("namespace-filter")).toHaveAttribute("data-selected-count", "2");

    // Clicking prod again unchecks it, leaving only dev
    await userEvent.click(screen.getByTestId("namespace-option"));
    expect(onChange).toHaveBeenCalledWith("dev");

    // Clicking `only` isolates prod immediately and closes popover
    onChange.mockClear();
    await userEvent.click(screen.getByTestId("namespace-only-prod"));
    expect(onChange).toHaveBeenCalledWith("prod");
    expect(screen.queryByTestId("namespace-popover")).not.toBeInTheDocument();
  });

  it("renders a sortable Taints column on Node tables with hover tooltips", async () => {
    const nodeResource: DiscoveredResourceDto = {
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
    const nodeRows: ResourceSummaryDto[] = [
      {
        uid: "n1",
        name: "node-std-1",
        kind: "Node",
        createdAt: "2026-01-01T00:00:00Z",
        labels: {},
        status: "Ready",
        node: "v1.36.5-eks-9adbfea",
        taints: 0,
      },
      {
        uid: "n2",
        name: "node-gpu-1",
        kind: "Node",
        createdAt: "2026-01-01T00:00:00Z",
        labels: {},
        status: "Ready",
        node: "v1.36.5-eks-9adbfea",
        taints: 2,
        message: "dedicated=gpu:NoSchedule, node.kubernetes.io/unschedulable:NoSchedule",
      },
    ];

    render(
      <ResourceTable
        resource={nodeResource}
        view={view({ rows: nodeRows })}
        isFetching={false}
        error={null}
        selectedName={null}
        onSelect={vi.fn()}
      />,
    );

    const taintCells = screen.getAllByTestId("node-taints-cell");
    expect(taintCells.map((el) => el.textContent)).toEqual(["0", "2"]);
    expect(taintCells[0]).toHaveAttribute("title", "No taints");
    expect(taintCells[1]).toHaveAttribute(
      "title",
      "dedicated=gpu:NoSchedule, node.kubernetes.io/unschedulable:NoSchedule",
    );

    // Click Taints header twice -> descending puts tainted node first
    const taintsHeader = screen.getByTestId("sort-col-taints");
    await userEvent.click(taintsHeader);
    expect(screen.getAllByTestId("node-taints-cell").map((el) => el.textContent)).toEqual(["0", "2"]);
    await userEvent.click(taintsHeader);
    expect(screen.getAllByTestId("node-taints-cell").map((el) => el.textContent)).toEqual(["2", "0"]);
  });

  it("displays only the controller type in Controlled By while keeping full Kind/name on hover", () => {
    const podResource: DiscoveredResourceDto = {
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
    const podRows: ResourceSummaryDto[] = [
      {
        uid: "p1",
        name: "api-6b6dd78866-nr2d4",
        namespace: "default",
        kind: "Pod",
        createdAt: "2026-01-01T00:00:00Z",
        labels: {},
        status: "Running",
        controlledBy: "ReplicaSet/api-6b6dd78866",
      },
      {
        uid: "p2",
        name: "backup-cron-29923740-ldpz5",
        namespace: "default",
        kind: "Pod",
        createdAt: "2026-01-01T00:00:00Z",
        labels: {},
        status: "Succeeded",
        controlledBy: "Job/backup-cron-29923740",
      },
    ];

    render(
      <ResourceTable
        resource={podResource}
        view={view({ rows: podRows })}
        isFetching={false}
        error={null}
        selectedName={null}
        onSelect={vi.fn()}
      />,
    );

    const rsCell = screen.getByText("ReplicaSet");
    expect(rsCell).toHaveAttribute("title", "ReplicaSet/api-6b6dd78866");
    expect(screen.queryByText("ReplicaSet/api-6b6dd78866")).not.toBeInTheDocument();

    const jobCell = screen.getByText("Job");
    expect(jobCell).toHaveAttribute("title", "Job/backup-cron-29923740");
    expect(screen.queryByText("Job/backup-cron-29923740")).not.toBeInTheDocument();
  });
});
