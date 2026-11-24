import type { ReactNode } from "react";
import { Activity, Network, Terminal, Wifi } from "lucide-react";

import { GlobalCommandBar } from "@/components/ide/global-command-bar";
import { getClusterProfileMeta, IconRail } from "@/components/ide/icon-rail";
import {
  NavigationSidebar,
  type SpecialNavTarget,
} from "@/components/ide/navigation-sidebar";
import type { DiscoveredResourceDto } from "@/lib/ipc/types";
import type { ResourceNavigationTarget } from "@/lib/resource-telemetry";
import type { ContextRow } from "@/stores/cluster-store";
import { usePortForwardStore } from "@/stores/port-forward-store";
import { useTerminalStore } from "@/stores/terminal-store";

export interface AppShellProps {
  contexts: ContextRow[];
  activeContext: ContextRow | null;
  resources: DiscoveredResourceDto[];
  isLoadingDiscovery: boolean;
  discoveryError: string | null;
  onRetryDiscovery?: () => void;
  activeGvr: string | null;
  activeSpecialView: SpecialNavTarget | null;
  sidebarOpen: boolean;
  theme: "dark" | "light";
  canGoBack?: boolean;
  canGoForward?: boolean;
  onGoBack?: () => void;
  onGoForward?: () => void;
  onCloseMobileSidebar: () => void;
  onSelectHome: () => void;
  onSelectContext: (context: ContextRow) => void;
  onDisconnectContext?: (contextId: string) => void;
  onSelectResource: (item: DiscoveredResourceDto) => void;
  onSelectResourceInstance?: (target: ResourceNavigationTarget) => void;
  onSelectSpecial: (target: SpecialNavTarget) => void;
  onSwitchTheme: () => void;
  onOpenSettings?: () => void;
  overlay?: ReactNode;
  children: ReactNode;
}

export function AppShell({
  contexts,
  activeContext,
  resources,
  isLoadingDiscovery,
  discoveryError,
  onRetryDiscovery,
  activeGvr,
  activeSpecialView,
  sidebarOpen,
  theme,
  canGoBack,
  canGoForward,
  onGoBack,
  onGoForward,
  onCloseMobileSidebar,
  onSelectHome,
  onSelectContext,
  onDisconnectContext,
  onSelectResource,
  onSelectResourceInstance,
  onSelectSpecial,
  onSwitchTheme,
  onOpenSettings,
  overlay,
  children,
}: AppShellProps) {
  const connectedCount = contexts.filter(
    (c) => c.state === "ready" || c.state === "degraded",
  ).length;
  const activeShellCount = useTerminalStore((s) =>
    activeContext
      ? s.tabs.filter((t) => t.contextId === activeContext.id && t.status === "connected").length
      : 0,
  );
  const activeForwardCount = usePortForwardStore((s) =>
    activeContext ? s.forwards.filter((f) => f.contextId === activeContext.id).length : 0,
  );

  return (
    <div className="flex h-full min-w-0 flex-col bg-background text-foreground">
      {/* Top Global Command & Window Bar */}
      <GlobalCommandBar
        contexts={contexts}
        activeContext={activeContext}
        resources={resources}
        theme={theme}
        canGoBack={canGoBack}
        canGoForward={canGoForward}
        onBack={onGoBack}
        onForward={onGoForward}
        onSelectContext={onSelectContext}
        onSelectResource={onSelectResource}
        onSelectResourceInstance={onSelectResourceInstance}
        onSelectTopology={activeContext ? () => onSelectSpecial("topology") : undefined}
        onSwitchTheme={onSwitchTheme}
      />

      {/* Main Split: Lens Cluster Profile Hotbar + Single-Cluster Sidebar + Workspace */}
      <div className="relative flex min-h-0 flex-1">
        <IconRail
          contexts={contexts}
          selectedContextId={activeContext?.id ?? null}
          theme={theme}
          onSelectHome={onSelectHome}
          onSelectContext={onSelectContext}
          onSwitchTheme={onSwitchTheme}
          onOpenSettings={onOpenSettings}
        />

        {activeContext && sidebarOpen ? (
          <button
            type="button"
            className="absolute inset-0 z-20 bg-background/70 md:hidden"
            aria-label="Close resource navigation"
            onClick={onCloseMobileSidebar}
          />
        ) : null}

        <NavigationSidebar
          activeContext={activeContext}
          resources={resources}
          isLoadingDiscovery={isLoadingDiscovery}
          discoveryError={discoveryError}
          onRetryDiscovery={onRetryDiscovery}
          activeGvr={activeGvr}
          activeSpecialView={activeSpecialView}
          open={sidebarOpen}
          onCloseMobile={onCloseMobileSidebar}
          onSelectResource={onSelectResource}
          onSelectSpecial={onSelectSpecial}
          onBackToClusters={onSelectHome}
          onDisconnectContext={onDisconnectContext}
        />

        <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
          {children}
          {overlay}
        </div>
      </div>

      {/* Bottom IDE Status Bar */}
      <footer className="flex h-6 shrink-0 items-center justify-between border-t border-border bg-rail px-2.5 text-[10px] text-muted-foreground select-none">
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            className="flex min-w-0 items-center gap-1.5 truncate"
            title={activeContext ? `${activeContext.name}${activeContext.server ? ` · ${activeContext.server}` : ""}` : undefined}
          >
            <Wifi
              size={10}
              className={activeContext ? "shrink-0 text-success" : "shrink-0 text-muted-foreground"}
              aria-hidden="true"
            />
            <span className="truncate font-mono text-foreground/90">
              {activeContext
                ? getClusterProfileMeta(activeContext.name).shortName
                : "No cluster selected"}
            </span>
          </span>
          {activeContext ? (
            <span className="hidden items-center gap-1 font-mono text-muted-foreground sm:flex">
              <span className="text-border">·</span>
              ns:{activeContext.namespaceDefault}
            </span>
          ) : null}
          {activeShellCount > 0 ? (
            <>
              <span className="text-border">·</span>
              <span
                data-testid="interactive-shell-badge"
                className="flex items-center gap-1 font-mono font-medium text-primary"
              >
                <Terminal size={11} aria-hidden="true" />
                INTERACTIVE SHELL ({activeShellCount})
              </span>
            </>
          ) : null}
          {activeForwardCount > 0 ? (
            <>
              <span className="text-border">·</span>
              <button
                type="button"
                data-testid="active-forwards-badge"
                onClick={() => onSelectSpecial("port-forwards")}
                className="flex items-center gap-1 font-mono font-medium text-success hover:underline"
                title="View active port-forwards"
              >
                <Network size={11} aria-hidden="true" />
                FORWARDS ({activeForwardCount})
              </button>
            </>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-2.5 font-mono">
          <span className="hidden items-center gap-1 sm:flex">
            <Activity size={10} className="text-primary" aria-hidden="true" />
            {connectedCount}/{contexts.length} online
          </span>
        </div>
      </footer>
    </div>
  );
}
