import { useEffect, useRef, useState } from "react";

import { AppShell } from "@/components/ide/app-shell";
import type { SpecialNavTarget } from "@/components/ide/navigation-sidebar";
import { SettingsModal } from "@/components/ide/settings-modal";
import {
  useConnectMutation,
  useDisconnectMutation,
  useDiscoveryQuery,
  useIpcEventBridge,
} from "@/lib/hooks";
import { getIpcTransport, onCloseActiveTab, tauriTransport } from "@/lib/ipc/client";
import type { DiscoveredResourceDto } from "@/lib/ipc/types";
import type { ResourceNavigationTarget } from "@/lib/resource-telemetry";
import { ClusterPicker } from "@/routes/cluster-picker";
import { ClusterShell, type ClusterNavControls } from "@/routes/cluster-shell";
import { selectOrderedContexts, useClusterStore, type ContextRow } from "@/stores/cluster-store";
import { useExplorerStore } from "@/stores/explorer-store";
import { usePortForwardStore } from "@/stores/port-forward-store";
import { useTerminalStore } from "@/stores/terminal-store";

function savedTheme(): "dark" | "light" {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

export interface AppProps {
  onCloseWindow?: () => void;
}

async function closeCurrentDesktopWindow(): Promise<void> {
  if (getIpcTransport() !== tauriTransport) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().close();
  } catch {
    // Ignore when running outside a Tauri desktop window.
  }
}

export function App({ onCloseWindow }: AppProps = {}) {
  useIpcEventBridge();
  const selectedId = useClusterStore((s) => s.selectedId);
  const select = useClusterStore((s) => s.select);
  const patchState = useClusterStore((s) => s.patchState);
  const contexts = useClusterStore(selectOrderedContexts);
  const activeGvr = useExplorerStore((s) => s.activeGvr);
  const setActiveGvr = useExplorerStore((s) => s.setActiveGvr);
  const clearContext = useExplorerStore((s) => s.clearContext);
  const discoveryError = useExplorerStore((s) =>
    selectedId ? s.discoveryError[selectedId] ?? null : null,
  );

  const [theme, setTheme] = useState<"dark" | "light">(savedTheme);
  const [specialView, setSpecialView] = useState<SpecialNavTarget | null>(null);
  const [navIntentNonce, setNavIntentNonce] = useState(0);
  const [clusterNav, setClusterNav] = useState<ClusterNavControls | null>(null);
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const clusterNavRef = useRef(clusterNav);
  clusterNavRef.current = clusterNav;
  const onCloseWindowRef = useRef(onCloseWindow);
  onCloseWindowRef.current = onCloseWindow;
  const jumpNonceRef = useRef(0);
  const [pendingJump, setPendingJump] = useState<
    (ResourceNavigationTarget & { nonce: number }) | null
  >(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const connect = useConnectMutation();
  const disconnect = useDisconnectMutation();
  const discovery = useDiscoveryQuery(selectedId);

  const active = selectedId ? contexts.find((c) => c.id === selectedId) : null;

  function switchTheme() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.classList.toggle("dark", next === "dark");
    try {
      localStorage.setItem("kubix-theme", next);
    } catch {
      // A WebView without storage can still switch theme for this session.
    }
  }

  function handleSelectContext(context: ContextRow) {
    const ready = context.state === "ready" || context.state === "degraded";
    // Single-cluster profile rule: switching away from an active cluster disconnects it.
    if (selectedId && selectedId !== context.id) {
      patchState(selectedId, "disconnected", false);
      clearContext(selectedId);
      useTerminalStore.getState().closeContextTabs(selectedId);
      usePortForwardStore.getState().clearContextForwards(selectedId);
      disconnect.mutate(selectedId);
    }
    select(context.id);
    setSpecialView(null);
    setClusterNav(null);
    setPendingJump(null);
    if (!ready && context.state !== "connecting" && !context.pending) {
      connect.mutate(context.id);
    }
  }

  function handleSelectResource(item: DiscoveredResourceDto) {
    setSpecialView(null);
    setActiveGvr(item.gvr);
    setNavIntentNonce((n) => n + 1);
  }

  const handleGoBack = () => {
    if (clusterNav?.canGoBack) {
      clusterNav.goBack();
      return;
    }
    if (activeGvr || specialView) {
      setSpecialView(null);
      setActiveGvr(null);
    } else {
      select(null);
      setClusterNav(null);
    }
  };

  const handleGoForward = () => {
    clusterNav?.goForward();
  };

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | null = null;

    void onCloseActiveTab(() => {
      if (selectedIdRef.current !== null) {
        clusterNavRef.current?.closeActiveTab();
      } else if (onCloseWindowRef.current) {
        onCloseWindowRef.current();
      } else {
        void closeCurrentDesktopWindow();
      }
    }).then((fn) => {
      if (!active) {
        fn();
      } else {
        unlisten = fn;
      }
    });

    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inEditable =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable);

      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        setSettingsOpen((open) => !open);
        return;
      }

      if (inEditable) return;

      if (
        ((e.metaKey || e.ctrlKey) && e.key === "[") ||
        (e.altKey && e.key === "ArrowLeft")
      ) {
        if (selectedId) {
          e.preventDefault();
          handleGoBack();
        }
        return;
      }

      if (
        ((e.metaKey || e.ctrlKey) && e.key === "]") ||
        (e.altKey && e.key === "ArrowRight")
      ) {
        if (selectedId && clusterNav?.canGoForward) {
          e.preventDefault();
          handleGoForward();
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const overlay = settingsOpen ? (
    <SettingsModal
      theme={theme}
      onSwitchTheme={switchTheme}
      onClose={() => setSettingsOpen(false)}
    />
  ) : null;

  return (
    <AppShell
      contexts={contexts}
      activeContext={active ?? null}
      resources={discovery.data ?? []}
      isLoadingDiscovery={
        discovery.isLoading ||
        Boolean(active && (active.state === "connecting" || active.pending))
      }
      discoveryError={
        active && (active.state === "ready" || active.state === "degraded") && !(discovery.data?.length)
          ? discovery.error
            ? String((discovery.error as Error).message)
            : discoveryError
          : null
      }
      onRetryDiscovery={
        selectedId
          ? () => {
              useExplorerStore.getState().setDiscoveryError(selectedId, null);
              void discovery.refetch();
            }
          : undefined
      }
      activeGvr={activeGvr}
      activeSpecialView={specialView}
      sidebarOpen={sidebarOpen}
      theme={theme}
      canGoBack={Boolean(selectedId)}
      canGoForward={Boolean(selectedId && clusterNav?.canGoForward)}
      onGoBack={handleGoBack}
      onGoForward={handleGoForward}
      onCloseMobileSidebar={() => setSidebarOpen(false)}
      onSelectHome={() => {
        select(null);
        setSpecialView(null);
        setClusterNav(null);
      }}
      onSelectContext={handleSelectContext}
      onDisconnectContext={(contextId) => {
        useTerminalStore.getState().closeContextTabs(contextId);
        usePortForwardStore.getState().clearContextForwards(contextId);
        disconnect.mutate(contextId);
      }}
      onSelectResource={handleSelectResource}
      onSelectResourceInstance={(target) => {
        jumpNonceRef.current += 1;
        setPendingJump({ ...target, nonce: jumpNonceRef.current });
      }}
      onSelectSpecial={(target) => {
        setSpecialView(target);
        setNavIntentNonce((n) => n + 1);
      }}
      onSwitchTheme={switchTheme}
      onOpenSettings={() => setSettingsOpen((v) => !v)}
      overlay={overlay}
    >
      {selectedId && active ? (
        <ClusterShell
          key={selectedId}
          contextId={selectedId}
          specialView={specialView}
          navIntentNonce={navIntentNonce}
          onChangeSpecialView={setSpecialView}
          onNavControlsChange={setClusterNav}
          pendingResourceJump={pendingJump}
          onConsumedResourceJump={() => setPendingJump(null)}
          onToggleSidebar={() => setSidebarOpen((v) => !v)}
          onBack={() => {
            select(null);
            setSpecialView(null);
            setClusterNav(null);
          }}
          theme={theme}
        />
      ) : (
        <ClusterPicker />
      )}
    </AppShell>
  );
}
