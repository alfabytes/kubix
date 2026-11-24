import { useEffect, useMemo, useRef, useState } from "react";
import { LayoutList, Settings } from "lucide-react";

import { ClusterAvatar, getClusterProfileMeta } from "@/components/ide/cluster-avatar";
import { describeConnectionState } from "@/lib/utils";
import { useClusterProfileStore } from "@/stores/cluster-profile-store";
import type { ContextRow } from "@/stores/cluster-store";

export { getClusterProfileMeta };

export type PrimarySection = "clusters" | "explorer" | "topology" | "security" | "helm";

export interface IconRailProps {
  contexts: ContextRow[];
  selectedContextId: string | null;
  activeSection?: PrimarySection;
  theme: "dark" | "light";
  onSelectHome: () => void;
  onSelectSection?: (section: PrimarySection) => void;
  onSelectContext: (context: ContextRow) => void;
  onSwitchTheme?: () => void;
  onOpenSettings?: () => void;
}

function K8sWheelBadge() {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-rail text-white/90 shadow-sm ring-1 ring-border"
    >
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="2" />
        <circle cx="12" cy="12" r="7.5" stroke="currentColor" strokeWidth="1.8" />
        <path
          d="M12 1.5V4.5M12 19.5V22.5M1.5 12H4.5M19.5 12H22.5M4.6 4.6L6.8 6.8M17.2 17.2L19.4 19.4M19.4 4.6L17.2 6.8M6.8 17.2L4.6 19.4"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}

const DRAG_THRESHOLD_PX = 5;

export function IconRail({
  contexts,
  selectedContextId,
  onSelectHome,
  onSelectContext,
  onOpenSettings,
}: IconRailProps) {
  const pinnedIds = useClusterProfileStore((s) => s.pinnedIds);
  const avatars = useClusterProfileStore((s) => s.avatars);
  const swapPinned = useClusterProfileStore((s) => s.swapPinned);

  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOffsetY, setDragOffsetY] = useState(0);
  const [swapTargetId, setSwapTargetId] = useState<string | null>(null);

  const itemRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const suppressClickRef = useRef(false);
  const cleanupDragRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      cleanupDragRef.current?.();
    };
  }, []);

  const contextById = useMemo(
    () => new Map(contexts.map((c) => [c.id, c])),
    [contexts],
  );

  const pinnedContexts = useMemo(
    () =>
      pinnedIds
        .map((id) => contextById.get(id))
        .filter((c): c is ContextRow => Boolean(c)),
    [pinnedIds, contextById],
  );

  /** Finds which pinned slot is closest to clientY; returns null when still over its own slot. */
  const findSwapTarget = (dragId: string, clientY: number): string | null => {
    let closestId: string | null = null;
    let closestDist = Number.POSITIVE_INFINITY;

    for (const item of pinnedContexts) {
      const el = itemRefs.current.get(item.id);
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      const center = rect.top + rect.height / 2;
      const dist = Math.abs(clientY - center);
      if (dist < closestDist) {
        closestDist = dist;
        closestId = item.id;
      }
    }

    if (!closestId || closestId === dragId) return null;
    return closestId;
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLButtonElement>, contextId: string) => {
    if (e.button !== 0 || pinnedContexts.length < 2) return;

    cleanupDragRef.current?.();

    const startY = e.clientY;
    let active = false;
    let latestTargetId: string | null = null;

    const onMove = (moveEvt: PointerEvent) => {
      const dy = moveEvt.clientY - startY;
      if (!active) {
        if (Math.abs(dy) < DRAG_THRESHOLD_PX) return;
        active = true;
        setDraggingId(contextId);
      }

      moveEvt.preventDefault();
      setDragOffsetY(dy);

      const nextTarget = findSwapTarget(contextId, moveEvt.clientY);
      latestTargetId = nextTarget;
      setSwapTargetId((prev) => (prev === nextTarget ? prev : nextTarget));
    };

    const finish = (commit: boolean) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      cleanupDragRef.current = null;

      if (active) {
        suppressClickRef.current = true;
        window.setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);
        if (commit && latestTargetId) {
          swapPinned(contextId, latestTargetId);
        }
      }

      setDraggingId(null);
      setDragOffsetY(0);
      setSwapTargetId(null);
    };

    const onUp = () => finish(true);
    const onCancel = () => finish(false);

    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    cleanupDragRef.current = () => finish(false);
  };

  return (
    <nav
      aria-label="Clusters"
      data-testid="cluster-profile-rail"
      className="z-20 flex w-14 shrink-0 flex-col items-center border-r border-border bg-rail py-2.5 select-none"
    >
      {/* Top Lens-style Catalog / All Clusters Switcher */}
      <div className="relative mb-3">
        <button
          type="button"
          aria-label="Home"
          title="Cluster Catalog (All clusters)"
          data-testid="catalog-home-button"
          onClick={onSelectHome}
          className={`relative flex h-10 w-10 items-center justify-center rounded-xl transition-all ${
            !selectedContextId
              ? "bg-primary text-primary-foreground ring-2 ring-foreground ring-offset-2 ring-offset-rail shadow-md"
              : "bg-primary/85 text-primary-foreground opacity-90 hover:opacity-100"
          }`}
        >
          <LayoutList size={18} aria-hidden="true" />
          <span
            aria-hidden="true"
            className="pointer-events-none absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-rail text-foreground ring-1 ring-border"
          >
            <Settings size={10} />
          </span>
        </button>
      </div>

      {/* Pinned Cluster Profiles (drag onto another pinned profile to switch positions) */}
      <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-2.5 overflow-y-auto px-1.5 py-1">
        {pinnedContexts.map((context) => {
          const ready = context.state === "ready" || context.state === "degraded";
          const chosen = selectedContextId === context.id;
          const isDragging = draggingId === context.id;
          const isSwapTarget = Boolean(draggingId) && swapTargetId === context.id;
          const stateLabel = describeConnectionState(context.state, context.lastError).label;
          const label = `${context.name}, ${stateLabel}`;

          return (
            <div
              key={context.id}
              ref={(node) => {
                if (node) itemRefs.current.set(context.id, node);
                else itemRefs.current.delete(context.id);
              }}
              className="relative flex w-full flex-col items-center"
            >
              <button
                type="button"
                draggable={false}
                onDragStart={(e) => e.preventDefault()}
                aria-label={label}
                title={`${context.name} (${stateLabel}) — drag onto another profile to switch`}
                data-testid="cluster-rail-item"
                data-context-id={context.id}
                data-swap-target={isSwapTarget ? "true" : "false"}
                aria-current={chosen ? "page" : undefined}
                onPointerDown={(e) => handlePointerDown(e, context.id)}
                onClick={() => {
                  if (suppressClickRef.current) {
                    suppressClickRef.current = false;
                    return;
                  }
                  onSelectContext(context);
                }}
                style={
                  isDragging
                    ? {
                        transform: `translateY(${dragOffsetY}px) scale(1.06)`,
                        zIndex: 40,
                      }
                    : undefined
                }
                className={`group relative flex h-10 w-10 shrink-0 touch-none items-center justify-center rounded-xl ${
                  isDragging
                    ? "cursor-grabbing opacity-90 shadow-xl ring-2 ring-primary/80"
                    : isSwapTarget
                      ? "scale-95 transition-all ring-2 ring-primary ring-offset-2 ring-offset-rail shadow-[0_0_12px_hsl(var(--primary)/0.45)]"
                      : `cursor-grab transition-all active:cursor-grabbing ${
                          chosen
                            ? avatars[context.id]?.kind === "character"
                              ? "scale-105 drop-shadow-[0_0_8px_rgba(255,255,255,0.35)] ring-1 ring-foreground/60 ring-offset-2 ring-offset-rail"
                              : "ring-2 ring-foreground ring-offset-2 ring-offset-rail shadow-lg"
                            : ready
                              ? "opacity-95 hover:scale-105 hover:opacity-100"
                              : "opacity-85 hover:scale-105 hover:opacity-100"
                        }`
                }`}
              >
                <ClusterAvatar
                  contextName={context.name}
                  config={avatars[context.id]}
                  size="md"
                />

                {/* Top-left connection status dot */}
                <span
                  aria-hidden="true"
                  className={`pointer-events-none absolute left-1.5 top-1.5 h-2 w-2 rounded-full ${
                    ready
                      ? "bg-emerald-400 shadow-[0_0_5px_rgba(52,211,153,0.9)]"
                      : context.state === "connecting" || context.pending
                        ? "animate-pulse bg-sky-300"
                        : context.state === "disconnected"
                          ? "bg-white/35"
                          : "bg-rose-400"
                  }`}
                />

                {/* Bottom-right Kubernetes wheel badge */}
                <K8sWheelBadge />
              </button>
            </div>
          );
        })}
      </div>

      {/* Bottom Workspace Preferences */}
      {onOpenSettings ? (
        <div className="mt-2 flex flex-col items-center border-t border-border pt-2">
          <button
            type="button"
            aria-label="Workspace settings"
            title="Workspace settings"
            onClick={onOpenSettings}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
          >
            <Settings size={15} aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </nav>
  );
}
