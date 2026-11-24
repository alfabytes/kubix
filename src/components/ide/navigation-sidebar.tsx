import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  Activity,
  Boxes,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Cloud,
  Database,
  FileKey2,
  Globe,
  HardDrive,
  Layers,
  LayoutDashboard,
  Network,
  Package,
  PowerOff,
  RefreshCw,
  Search,
  Shield,
  ShieldAlert,
  X,
} from "lucide-react";

import { ClusterAvatar } from "@/components/ide/cluster-avatar";
import { ClusterAvatarEditor } from "@/components/ide/cluster-avatar-editor";
import { getClusterProfileMeta } from "@/components/ide/icon-rail";
import {
  clampSidebarWidth,
  loadSidebarWidth,
  saveSidebarWidth,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from "@/components/ide/sidebar-width";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { DiscoveredResourceDto } from "@/lib/ipc/types";
import { categorizeResources } from "@/lib/resource-telemetry";
import { describeConnectionState, shortGvr } from "@/lib/utils";
import { useClusterProfileStore } from "@/stores/cluster-profile-store";
import type { ContextRow } from "@/stores/cluster-store";
import { usePortForwardStore } from "@/stores/port-forward-store";

export type SpecialNavTarget =
  | "cluster-overview"
  | "topology"
  | "events"
  | "security"
  | "helm"
  | "port-forwards";

export interface NavigationSidebarProps {
  activeContext: ContextRow | null;
  resources: DiscoveredResourceDto[];
  isLoadingDiscovery: boolean;
  discoveryError: string | null;
  onRetryDiscovery?: () => void;
  activeGvr: string | null;
  activeSpecialView: SpecialNavTarget | null;
  open: boolean;
  onCloseMobile: () => void;
  onSelectResource: (item: DiscoveredResourceDto) => void;
  onSelectSpecial: (target: SpecialNavTarget) => void;
  onBackToClusters?: () => void;
  onDisconnectContext?: (contextId: string) => void;
}

export function NavigationSidebar({
  activeContext,
  resources,
  isLoadingDiscovery,
  discoveryError,
  onRetryDiscovery,
  activeGvr,
  activeSpecialView,
  open,
  onCloseMobile,
  onSelectResource,
  onSelectSpecial,
  onDisconnectContext,
}: NavigationSidebarProps) {
  const [navFilter, setNavFilter] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [avatarEditorOpen, setAvatarEditorOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState<number>(() =>
    loadSidebarWidth(undefined, typeof window !== "undefined" ? window.innerWidth : undefined),
  );
  const [resizing, setResizing] = useState(false);
  const sidebarWidthRef = useRef(sidebarWidth);
  sidebarWidthRef.current = sidebarWidth;
  const stopResizeRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const handleWindowResize = () => {
      const clamped = clampSidebarWidth(sidebarWidthRef.current, window.innerWidth);
      if (clamped !== sidebarWidthRef.current) {
        sidebarWidthRef.current = clamped;
        setSidebarWidth(clamped);
      }
    };
    window.addEventListener("resize", handleWindowResize);
    return () => {
      window.removeEventListener("resize", handleWindowResize);
      stopResizeRef.current?.();
    };
  }, []);

  const startSidebarResize = (startX: number) => {
    stopResizeRef.current?.();
    const startWidth = sidebarWidthRef.current;
    const prevCursor = document.body.style.cursor;
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    setResizing(true);

    let cleanedUp = false;
    const stopResize = (persist = true) => {
      if (cleanedUp) return;
      cleanedUp = true;
      stopResizeRef.current = null;
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevUserSelect;
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleEnd);
      window.removeEventListener("pointercancel", handleEnd);
      window.removeEventListener("blur", handleEnd);
      setResizing(false);
      if (persist) {
        saveSidebarWidth(sidebarWidthRef.current);
      }
    };

    const handleEnd = () => stopResize(true);

    const handleMove = (event: PointerEvent) => {
      if (event.pointerType === "mouse" && (event.buttons & 1) === 0) {
        stopResize(true);
        return;
      }
      const nextWidth = clampSidebarWidth(
        startWidth + (event.clientX - startX),
        window.innerWidth,
      );
      sidebarWidthRef.current = nextWidth;
      setSidebarWidth(nextWidth);
    };

    stopResizeRef.current = () => stopResize(false);
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleEnd);
    window.addEventListener("pointercancel", handleEnd);
    window.addEventListener("blur", handleEnd);
  };

  useEffect(() => {
    setAvatarEditorOpen(false);
  }, [activeContext?.id]);
  const activeAvatarConfig = useClusterProfileStore((s) =>
    activeContext ? s.avatars[activeContext.id] : undefined,
  );
  const activeForwardsCount = usePortForwardStore((s) =>
    activeContext ? s.forwards.filter((f) => f.contextId === activeContext.id).length : 0,
  );

  const toggleGroup = (id: string) =>
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));

  const filteredResources = useMemo(() => {
    const needle = navFilter.trim().toLowerCase();
    if (!needle) return resources;
    return resources.filter(
      (item) =>
        item.kind.toLowerCase().includes(needle) ||
        item.plural.toLowerCase().includes(needle) ||
        item.group.toLowerCase().includes(needle) ||
        item.shortNames.some((s) => s.toLowerCase().includes(needle)) ||
        (item.kind === "CustomResourceDefinition" && "definitions".includes(needle)),
    );
  }, [navFilter, resources]);

  const { primaryGroups, crdSection } = useMemo(
    () => categorizeResources(filteredResources),
    [filteredResources],
  );

  // Auto-expand the category (and Custom Resource API subgroup) when an item is opened via Cmd+K or navigation
  useEffect(() => {
    if (activeSpecialView === "cluster-overview") {
      setExpanded((prev) => (prev.cluster ? prev : { ...prev, cluster: true }));
      return;
    }
    if (activeSpecialView === "port-forwards") {
      setExpanded((prev) => (prev.network ? prev : { ...prev, network: true }));
      return;
    }
    if (!activeGvr || activeSpecialView) return;
    const matchPrimary = primaryGroups.find((g) => g.items.some((i) => i.gvr === activeGvr));
    if (matchPrimary) {
      setExpanded((prev) =>
        prev[matchPrimary.id] ? prev : { ...prev, [matchPrimary.id]: true },
      );
      return;
    }
    if (crdSection.pinnedCrd?.gvr === activeGvr) {
      setExpanded((prev) =>
        prev["custom-resources"] ? prev : { ...prev, "custom-resources": true },
      );
      return;
    }
    const matchOperator = crdSection.operatorGroups.find((g) =>
      g.items.some((i) => i.gvr === activeGvr),
    );
    if (matchOperator) {
      setExpanded((prev) =>
        prev["custom-resources"] && prev[matchOperator.id]
          ? prev
          : { ...prev, "custom-resources": true, [matchOperator.id]: true },
      );
      return;
    }
    if (crdSection.builtInGroup?.items.some((i) => i.gvr === activeGvr)) {
      setExpanded((prev) => (prev["k8s-apis"] ? prev : { ...prev, "k8s-apis": true }));
    }
  }, [activeGvr, activeSpecialView, primaryGroups, crdSection]);

  // Only render the cluster resource sidebar when a cluster profile is active
  if (!activeContext) {
    return null;
  }

  const profile = getClusterProfileMeta(activeContext.name);
  const stateDesc = describeConnectionState(activeContext.state, activeContext.lastError);

  const needle = navFilter.trim().toLowerCase();
  const showClusterStatic = !needle || "cluster overview".includes(needle);
  const showPortForwardsStatic = !needle || "port forwards tunnels".includes(needle);
  const showVisualizer = !needle || "visualizer topology graph".includes(needle);
  const showEvents = !needle || "events timeline warnings incidents".includes(needle);
  const showSecurity = !needle || "security rbac audit secrets".includes(needle);
  const showHelm = !needle || "helm releases charts".includes(needle);

  const clusterItems = primaryGroups.find((g) => g.id === "cluster")?.items ?? [];
  const workloadItems = primaryGroups.find((g) => g.id === "workload")?.items ?? [];
  const networkItems = primaryGroups.find((g) => g.id === "network")?.items ?? [];
  const storageItems = primaryGroups.find((g) => g.id === "storage")?.items ?? [];
  const configItems = primaryGroups.find((g) => g.id === "config")?.items ?? [];
  const rbacItems = primaryGroups.find((g) => g.id === "rbac")?.items ?? [];
  const customResourceSectionItems = [
    ...(crdSection.pinnedCrd ? [crdSection.pinnedCrd] : []),
    ...crdSection.operatorGroups.flatMap((g) => g.items),
  ];
  const builtInApiItems = crdSection.builtInGroup?.items ?? [];

  const hasActiveGvrIn = (items: DiscoveredResourceDto[]) =>
    !activeSpecialView && Boolean(activeGvr && items.some((i) => i.gvr === activeGvr));

  const renderResourceButton = (item: DiscoveredResourceDto, labelOverride?: string) => {
    const active = item.gvr === activeGvr && !activeSpecialView;
    const displayLabel = typeof labelOverride === "string" ? labelOverride : item.kind;
    return (
      <button
        key={item.gvr}
        type="button"
        data-testid="resource-type"
        data-gvr={item.gvr}
        data-active={active}
        onClick={() => {
          onSelectResource(item);
          onCloseMobile();
        }}
        className={`group flex w-full items-center justify-between gap-2 rounded-sm px-3 py-1.5 text-left text-[12px] transition-colors ${
          active
            ? "bg-primary/15 font-semibold text-foreground"
            : "text-muted-foreground hover:bg-hover/70 hover:text-foreground"
        }`}
        title={`${shortGvr(item.gvr)} (${item.kind})`}
      >
        <span className="truncate">{displayLabel}</span>
        <span className="shrink-0 font-mono text-[9.5px] opacity-45 group-hover:opacity-80">
          {item.version}
        </span>
      </button>
    );
  };

  const updateSidebarWidth = (next: number) => {
    const clamped = clampSidebarWidth(next, typeof window !== "undefined" ? window.innerWidth : undefined);
    sidebarWidthRef.current = clamped;
    setSidebarWidth(clamped);
    saveSidebarWidth(clamped);
  };

  return (
    <aside
      aria-label="Workspace navigation"
      data-testid="cluster-sidebar"
      style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
      className={`${
        open ? "absolute inset-y-0 left-14 z-30 flex shadow-2xl" : "hidden"
      } w-56 shrink-0 flex-col border-r border-border bg-panel md:relative md:inset-auto md:left-auto md:z-auto md:flex md:w-[var(--sidebar-width)] md:shadow-none select-none`}
    >
      {/* Lens-Style Active Cluster Profile Header */}
      <div className="flex h-13 shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <button
            type="button"
            onClick={() => setAvatarEditorOpen(true)}
            title="Customize cluster icon & sidebar pin"
            aria-label={`Customize icon for ${profile.shortName}`}
            className="shrink-0 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <ClusterAvatar
              contextName={activeContext.name}
              config={activeAvatarConfig}
              size="sm"
            />
          </button>
          <div className="min-w-0">
            <div className="flex items-center gap-1">
              <span
                data-testid="active-cluster-title"
                className="truncate text-[13px] font-bold text-foreground"
                title={activeContext.name}
              >
                {profile.shortName}
              </span>
              <ChevronDown size={12} className="shrink-0 text-muted-foreground" aria-hidden="true" />
            </div>
            <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  activeContext.state === "ready" || activeContext.state === "degraded"
                    ? "bg-success"
                    : "bg-warning"
                }`}
              />
              <span className="truncate">{stateDesc.label}</span>
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          {onDisconnectContext ? (
            <button
              type="button"
              onClick={() => onDisconnectContext(activeContext.id)}
              title={`Disconnect ${activeContext.name}`}
              aria-label={`Disconnect ${activeContext.name}`}
              data-testid="sidebar-disconnect-cluster"
              className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive"
            >
              <PowerOff size={13} aria-hidden="true" />
            </button>
          ) : null}
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 md:hidden"
            aria-label="Close resource navigation"
            onClick={onCloseMobile}
          >
            <X size={14} />
          </Button>
        </div>
      </div>

      {/* Resource Quick Filter */}
      <div className="border-b border-border px-2.5 py-2">
        <div className="relative">
          <Search
            size={12}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            value={navFilter}
            onChange={(e) => setNavFilter(e.target.value)}
            placeholder="Find resource type"
            aria-label="Find resource type"
            className="h-7 bg-background/80 pl-7 text-[11.5px]"
          />
        </div>
      </div>

      {/* Single-Cluster Resource Category Tree (Lens Style) */}
      <nav
        aria-label="Resource types"
        className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 py-2"
      >
        {isLoadingDiscovery ? (
          <p className="flex items-center gap-2 px-2.5 py-1.5 text-[11px] text-muted-foreground">
            <RefreshCw className="h-3 w-3 animate-spin text-primary" aria-hidden />
            Discovering APIs…
          </p>
        ) : null}

        {discoveryError ? (
          <div className="mx-1 space-y-1.5 rounded border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-[10.5px] text-destructive">
            <p>{discoveryError}</p>
            {onRetryDiscovery ? (
              <button
                type="button"
                data-testid="retry-discovery"
                onClick={onRetryDiscovery}
                className="inline-flex items-center gap-1 rounded border border-destructive/40 bg-background/80 px-2 py-0.5 text-[10px] font-medium text-destructive transition-colors hover:bg-destructive/15"
              >
                <RefreshCw size={10} aria-hidden="true" />
                Retry discovery
              </button>
            ) : null}
          </div>
        ) : null}

        {(showClusterStatic || clusterItems.length > 0) && (
          <TreeGroup
            id="cluster"
            title="Cluster"
            icon={<Cloud size={13} />}
            active={activeSpecialView === "cluster-overview" || hasActiveGvrIn(clusterItems)}
            collapsed={!expanded.cluster && !needle}
            onToggle={() => toggleGroup("cluster")}
          >
            {showClusterStatic ? (
              <SpecialNavButton
                label="Overview"
                active={activeSpecialView === "cluster-overview"}
                icon={<LayoutDashboard size={12} />}
                onClick={() => {
                  onSelectSpecial("cluster-overview");
                  onCloseMobile();
                }}
              />
            ) : null}
            {clusterItems.map((item) => renderResourceButton(item))}
          </TreeGroup>
        )}

        {workloadItems.length > 0 && (
          <TreeGroup
            id="workload"
            title="WorkLoad"
            icon={<Layers size={13} />}
            active={hasActiveGvrIn(workloadItems)}
            collapsed={!expanded.workload && !needle}
            onToggle={() => toggleGroup("workload")}
          >
            {workloadItems.map((item) => renderResourceButton(item))}
          </TreeGroup>
        )}

        {configItems.length > 0 && (
          <TreeGroup
            id="config"
            title="Config"
            icon={<FileKey2 size={13} />}
            active={hasActiveGvrIn(configItems)}
            collapsed={!expanded.config && !needle}
            onToggle={() => toggleGroup("config")}
          >
            {configItems.map((item) => renderResourceButton(item))}
          </TreeGroup>
        )}

        {(showPortForwardsStatic || networkItems.length > 0) && (
          <TreeGroup
            id="network"
            title="Network"
            icon={<Globe size={13} />}
            active={activeSpecialView === "port-forwards" || hasActiveGvrIn(networkItems)}
            collapsed={!expanded.network && !needle}
            onToggle={() => toggleGroup("network")}
          >
            {networkItems.map((item) => renderResourceButton(item))}
            {showPortForwardsStatic ? (
              <SpecialNavButton
                label="Port Forwards"
                active={activeSpecialView === "port-forwards"}
                icon={<Network size={12} />}
                badgeCount={activeForwardsCount}
                onClick={() => {
                  onSelectSpecial("port-forwards");
                  onCloseMobile();
                }}
              />
            ) : null}
          </TreeGroup>
        )}

        {storageItems.length > 0 && (
          <TreeGroup
            id="storage"
            title="Storage"
            icon={<HardDrive size={13} />}
            active={hasActiveGvrIn(storageItems)}
            collapsed={!expanded.storage && !needle}
            onToggle={() => toggleGroup("storage")}
          >
            {storageItems.map((item) => renderResourceButton(item))}
          </TreeGroup>
        )}

        {showVisualizer ? (
          <SpecialNavButton
            label="Visualizer"
            active={activeSpecialView === "topology"}
            icon={<Network size={13} />}
            topLevel
            onClick={() => {
              onSelectSpecial("topology");
              onCloseMobile();
            }}
          />
        ) : null}

        {showEvents ? (
          <SpecialNavButton
            label="Events"
            active={activeSpecialView === "events"}
            icon={<Activity size={13} />}
            topLevel
            onClick={() => {
              onSelectSpecial("events");
              onCloseMobile();
            }}
          />
        ) : null}

        {showHelm ? (
          <SpecialNavButton
            label="Helm"
            active={activeSpecialView === "helm"}
            icon={<Package size={13} />}
            topLevel
            onClick={() => {
              onSelectSpecial("helm");
              onCloseMobile();
            }}
          />
        ) : null}

        {showSecurity ? (
          <SpecialNavButton
            label="Security"
            active={activeSpecialView === "security"}
            icon={<ShieldAlert size={13} />}
            topLevel
            onClick={() => {
              onSelectSpecial("security");
              onCloseMobile();
            }}
          />
        ) : null}

        {rbacItems.length > 0 && (
          <TreeGroup
            id="rbac"
            title="RBAC"
            icon={<Shield size={13} />}
            active={hasActiveGvrIn(rbacItems)}
            collapsed={!expanded.rbac && !needle}
            onToggle={() => toggleGroup("rbac")}
          >
            {rbacItems.map((item) => renderResourceButton(item))}
          </TreeGroup>
        )}

        {customResourceSectionItems.length > 0 && (
          <TreeGroup
            id="custom-resources"
            title="Custom Resources"
            icon={<Database size={13} />}
            badgeCount={crdSection.operatorResourceCount}
            active={hasActiveGvrIn(customResourceSectionItems)}
            collapsed={!expanded["custom-resources"] && !needle}
            onToggle={() => toggleGroup("custom-resources")}
          >
            {crdSection.pinnedCrd
              ? renderResourceButton(crdSection.pinnedCrd, "Definitions")
              : null}

            {crdSection.operatorGroups.map((subGroup) => (
              <SubTreeGroup
                key={subGroup.id}
                id={subGroup.id}
                title={subGroup.title}
                count={subGroup.items.length}
                active={hasActiveGvrIn(subGroup.items)}
                collapsed={!expanded[subGroup.id] && !needle}
                onToggle={() => toggleGroup(subGroup.id)}
              >
                {subGroup.items.map((item) => renderResourceButton(item))}
              </SubTreeGroup>
            ))}
          </TreeGroup>
        )}

        {builtInApiItems.length > 0 && (
          <TreeGroup
            id="k8s-apis"
            title="Kubernetes APIs"
            icon={<Boxes size={13} />}
            badgeCount={builtInApiItems.length}
            active={hasActiveGvrIn(builtInApiItems)}
            collapsed={!expanded["k8s-apis"] && !needle}
            onToggle={() => toggleGroup("k8s-apis")}
          >
            {builtInApiItems.map((item) => renderResourceButton(item))}
          </TreeGroup>
        )}

        {!isLoadingDiscovery &&
        filteredResources.length === 0 &&
        !showClusterStatic &&
        !showVisualizer &&
        !showSecurity &&
        !showHelm ? (
          <p className="px-2.5 py-2 text-[11px] text-muted-foreground">
            No resource types match.
          </p>
        ) : null}
      </nav>

      {avatarEditorOpen ? (
        <ClusterAvatarEditor
          contextId={activeContext.id}
          contextName={activeContext.name}
          onClose={() => setAvatarEditorOpen(false)}
        />
      ) : null}

      {/* Flush desktop right-edge resize handle */}
      <div
        data-testid="sidebar-resize-handle"
        role="separator"
        aria-label="Resize resource navigation"
        aria-orientation="vertical"
        aria-valuemin={SIDEBAR_MIN_WIDTH}
        aria-valuemax={SIDEBAR_MAX_WIDTH}
        aria-valuenow={sidebarWidth}
        tabIndex={0}
        title="Drag to resize sidebar (double-click to reset)"
        onPointerDown={(event) => {
          if (typeof event.button === "number" && event.button !== 0) return;
          event.preventDefault();
          startSidebarResize(event.clientX);
        }}
        onDoubleClick={() => updateSidebarWidth(SIDEBAR_DEFAULT_WIDTH)}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight") {
            event.preventDefault();
            updateSidebarWidth(sidebarWidthRef.current + 16);
          } else if (event.key === "ArrowLeft") {
            event.preventDefault();
            updateSidebarWidth(sidebarWidthRef.current - 16);
          } else if (event.key === "Home") {
            event.preventDefault();
            updateSidebarWidth(SIDEBAR_MIN_WIDTH);
          } else if (event.key === "End") {
            event.preventDefault();
            updateSidebarWidth(SIDEBAR_MAX_WIDTH);
          }
        }}
        className="group absolute inset-y-0 -right-[3px] z-20 hidden w-[6px] cursor-col-resize outline-none md:block"
      >
        <span
          aria-hidden="true"
          className={`mx-auto block h-full w-[2px] transition-colors ${
            resizing
              ? "bg-primary"
              : "bg-transparent group-hover:bg-primary/60 group-focus-visible:bg-primary"
          }`}
        />
      </div>
    </aside>
  );
}

function TreeGroup({
  id,
  title,
  icon,
  badgeCount,
  active,
  collapsed,
  onToggle,
  children,
}: {
  id: string;
  title: string;
  icon?: React.ReactNode;
  badgeCount?: number;
  active?: boolean;
  collapsed: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div data-group-id={id}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        className={`flex w-full items-center justify-between gap-1.5 rounded-sm px-2.5 py-1.5 text-[12px] font-medium transition-colors ${
          active
            ? "bg-primary text-primary-foreground shadow-sm"
            : "text-muted-foreground hover:bg-hover/65 hover:text-foreground"
        }`}
      >
        <span className="flex min-w-0 items-center gap-2.5 truncate">
          {icon ? <span className="shrink-0">{icon}</span> : null}
          <span className="truncate">{title}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          {typeof badgeCount === "number" && badgeCount > 0 ? (
            <span
              className={`rounded px-1.5 py-0.2 font-mono text-[9.5px] font-semibold tabular-nums ${
                active
                  ? "bg-primary-foreground/20 text-primary-foreground"
                  : "bg-secondary text-muted-foreground"
              }`}
            >
              {badgeCount}
            </span>
          ) : null}
          {collapsed ? (
            <ChevronRight size={13} className="shrink-0 opacity-75" aria-hidden="true" />
          ) : (
            <ChevronUp size={13} className="shrink-0 opacity-75" aria-hidden="true" />
          )}
        </span>
      </button>
      {!collapsed ? (
        <div
          className={`ml-2 mt-0.5 space-y-0.5 border-l-2 pl-1.5 ${
            active ? "border-primary" : "border-border/80"
          }`}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}

function SubTreeGroup({
  id,
  title,
  count,
  active,
  collapsed,
  subtle = false,
  onToggle,
  children,
}: {
  id: string;
  title: string;
  count: number;
  active?: boolean;
  collapsed: boolean;
  subtle?: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div data-crd-group={title} data-subgroup-id={id}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        title={`${title} (${count})`}
        className={`flex w-full items-center justify-between gap-1.5 rounded-sm px-2 py-1 text-left text-[11px] transition-colors ${
          active
            ? "bg-primary/10 font-semibold text-foreground"
            : subtle
              ? "text-muted-foreground/80 hover:bg-hover/60 hover:text-foreground"
              : "font-medium text-muted-foreground hover:bg-hover/60 hover:text-foreground"
        }`}
      >
        <span className="flex min-w-0 items-center gap-1.5 truncate">
          {collapsed ? (
            <ChevronRight size={11} className="shrink-0 opacity-70" aria-hidden="true" />
          ) : (
            <ChevronDown size={11} className="shrink-0 opacity-70" aria-hidden="true" />
          )}
          <span className={subtle ? "truncate" : "truncate font-mono text-[10.5px]"}>
            {title}
          </span>
        </span>
        <span className="shrink-0 rounded bg-secondary/80 px-1 py-0.2 font-mono text-[9px] tabular-nums text-muted-foreground">
          {count}
        </span>
      </button>
      {!collapsed ? (
        <div className="ml-2 mt-0.5 space-y-0.5 border-l border-border/70 pl-1">
          {children}
        </div>
      ) : null}
    </div>
  );
}

function SpecialNavButton({
  label,
  active,
  icon,
  badgeCount,
  topLevel = false,
  onClick,
}: {
  label: string;
  active: boolean;
  icon: React.ReactNode;
  badgeCount?: number;
  topLevel?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-active={active}
      className={`flex w-full items-center gap-2.5 rounded-sm ${
        topLevel ? "px-2.5 py-1.5 text-[12px] font-medium" : "px-3 py-1.5 text-[12px]"
      } text-left transition-colors ${
        active
          ? topLevel
            ? "bg-primary text-primary-foreground shadow-sm"
            : "bg-primary/15 font-semibold text-foreground"
          : "text-muted-foreground hover:bg-hover/65 hover:text-foreground"
      }`}
    >
      <span className="shrink-0">{icon}</span>
      <span className="flex-1 truncate">{label}</span>
      {typeof badgeCount === "number" && badgeCount > 0 ? (
        <span className="rounded bg-success/15 px-1.5 py-0.2 font-mono text-[10px] font-semibold text-success">
          {badgeCount}
        </span>
      ) : null}
    </button>
  );
}
