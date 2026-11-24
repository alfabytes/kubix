import { useEffect, useRef, useState } from "react";
import {
  Activity,
  Boxes,
  FileCode2,
  LayoutDashboard,
  Network,
  Package,
  ShieldAlert,
  X,
} from "lucide-react";

export type WorkspaceTabKind =
  | "overview"
  | "resource-list"
  | "resource-detail"
  | "topology"
  | "events"
  | "security"
  | "helm"
  | "port-forwards";

export interface WorkspaceTabItem {
  id: string;
  kind: WorkspaceTabKind;
  title: string;
  subtitle?: string;
  gvr?: string;
  resourceName?: string;
  resourceNamespace?: string;
  detailTab?: "overview" | "yaml" | "logs" | "events" | "security" | "metrics" | "topology";
  closable?: boolean;
}

export interface WorkspaceTabsProps {
  tabs: WorkspaceTabItem[];
  activeTabId: string;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onCloseOtherTabs?: (id: string) => void;
  onCloseTabsToRight?: (id: string) => void;
  rightActions?: React.ReactNode;
}

interface ContextMenuState {
  tabId: string;
  x: number;
  y: number;
}

function TabIcon({ kind }: { kind: WorkspaceTabKind }) {
  switch (kind) {
    case "overview":
      return <LayoutDashboard size={12} className="shrink-0 text-primary" aria-hidden="true" />;
    case "topology":
      return <Network size={12} className="shrink-0 text-info" aria-hidden="true" />;
    case "events":
      return <Activity size={12} className="shrink-0 text-warning" aria-hidden="true" />;
    case "security":
      return <ShieldAlert size={12} className="shrink-0 text-warning" aria-hidden="true" />;
    case "helm":
      return <Package size={12} className="shrink-0 text-primary" aria-hidden="true" />;
    case "port-forwards":
      return <Network size={12} className="shrink-0 text-success" aria-hidden="true" />;
    case "resource-detail":
      return <FileCode2 size={12} className="shrink-0 text-primary" aria-hidden="true" />;
    case "resource-list":
    default:
      return <Boxes size={12} className="shrink-0 text-primary" aria-hidden="true" />;
  }
}

export function WorkspaceTabs({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onCloseOtherTabs,
  onCloseTabsToRight,
  rightActions,
}: WorkspaceTabsProps) {
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const tabNodesRef = useRef<Map<string, HTMLDivElement>>(new Map());

  useEffect(() => {
    const activeNode = tabNodesRef.current.get(activeTabId);
    if (activeNode && typeof activeNode.scrollIntoView === "function") {
      activeNode.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [activeTabId, tabs.length]);

  useEffect(() => {
    if (!contextMenu) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setContextMenu(null);
      }
    };

    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (menuRef.current && target && menuRef.current.contains(target)) {
        return;
      }
      setContextMenu(null);
    };

    window.addEventListener("keydown", handleKeyDown);
    document.addEventListener("mousedown", handleMouseDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("mousedown", handleMouseDown);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (contextMenu && !tabs.some((t) => t.id === contextMenu.tabId)) {
      setContextMenu(null);
    }
  }, [contextMenu, tabs]);

  const menuTabIndex = contextMenu ? tabs.findIndex((t) => t.id === contextMenu.tabId) : -1;
  const menuTab = menuTabIndex >= 0 ? tabs[menuTabIndex] : null;
  const canCloseMenuTab = Boolean(menuTab && menuTab.closable !== false && tabs.length > 1);
  const canCloseOthers = Boolean(menuTab && tabs.length > 1 && onCloseOtherTabs);
  const canCloseToRight = Boolean(
    menuTab && menuTabIndex >= 0 && menuTabIndex < tabs.length - 1 && onCloseTabsToRight,
  );

  return (
    <div
      role="tablist"
      aria-label="Workspace tabs"
      data-testid="workspace-tabs"
      className="flex h-9 shrink-0 items-center justify-between border-b border-border bg-rail px-1.5 select-none"
    >
      <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
        {tabs.map((tab) => {
          const active = tab.id === activeTabId;
          const canClose = tab.closable !== false && tabs.length > 1;
          return (
            <div
              key={tab.id}
              ref={(el) => {
                if (el) tabNodesRef.current.set(tab.id, el);
                else tabNodesRef.current.delete(tab.id);
              }}
              role="tab"
              aria-selected={active}
              data-testid="workspace-tab"
              data-active={active}
              onAuxClick={(event) => {
                if (event.button === 1 && canClose) {
                  event.preventDefault();
                  onCloseTab(tab.id);
                }
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                const maxX = Math.max(8, (window.innerWidth || 800) - 180);
                const maxY = Math.max(8, (window.innerHeight || 600) - 120);
                setContextMenu({
                  tabId: tab.id,
                  x: Math.min(Math.max(8, event.clientX), maxX),
                  y: Math.min(Math.max(8, event.clientY), maxY),
                });
              }}
              className={`group relative flex h-7 max-w-[210px] shrink-0 items-center gap-1.5 rounded-t border px-2.5 text-[11.5px] transition-colors ${
                active
                  ? "border-border border-b-transparent bg-panel font-medium text-foreground shadow-[inset_0_2px_0_0_hsl(var(--primary))]"
                  : "border-transparent bg-transparent text-muted-foreground hover:bg-hover/70 hover:text-foreground"
              }`}
            >
              <button
                type="button"
                onClick={() => onSelectTab(tab.id)}
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left focus-visible:outline-none"
                title={tab.subtitle ? `${tab.title} (${tab.subtitle})` : tab.title}
              >
                <TabIcon kind={tab.kind} />
                <span className="truncate">{tab.title}</span>
                {tab.subtitle ? (
                  <span className="truncate font-mono text-[9.5px] text-muted-foreground">
                    {tab.subtitle}
                  </span>
                ) : null}
              </button>
              {canClose ? (
                <button
                  type="button"
                  aria-label={`Close tab ${tab.title}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseTab(tab.id);
                  }}
                  className={`rounded p-0.5 text-muted-foreground transition-opacity hover:bg-hover hover:text-foreground ${
                    active ? "opacity-80" : "opacity-0 group-hover:opacity-80 focus:opacity-100"
                  }`}
                >
                  <X size={11} aria-hidden="true" />
                </button>
              ) : null}
            </div>
          );
        })}
      </div>

      {rightActions ? (
        <div className="ml-2 flex shrink-0 items-center gap-1.5 pl-1">{rightActions}</div>
      ) : null}

      {contextMenu && menuTab ? (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Tab actions"
          data-testid="tab-context-menu"
          style={{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }}
          className="fixed z-50 min-w-[160px] rounded-md border border-border-strong bg-panel py-1 text-[11.5px] shadow-xl"
        >
          <button
            type="button"
            role="menuitem"
            disabled={!canCloseMenuTab}
            onClick={() => {
              if (!canCloseMenuTab) return;
              const id = menuTab.id;
              setContextMenu(null);
              onCloseTab(id);
            }}
            className="flex w-full items-center justify-between px-3 py-1.5 text-left text-foreground hover:bg-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            <span>Close</span>
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!canCloseOthers}
            onClick={() => {
              if (!canCloseOthers) return;
              const id = menuTab.id;
              setContextMenu(null);
              onCloseOtherTabs?.(id);
            }}
            className="flex w-full items-center justify-between px-3 py-1.5 text-left text-foreground hover:bg-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            <span>Close Others</span>
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!canCloseToRight}
            onClick={() => {
              if (!canCloseToRight) return;
              const id = menuTab.id;
              setContextMenu(null);
              onCloseTabsToRight?.(id);
            }}
            className="flex w-full items-center justify-between px-3 py-1.5 text-left text-foreground hover:bg-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            <span>Close to the Right</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
