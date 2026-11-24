import { ArrowUpRight, Pin, RefreshCw, Sparkles } from "lucide-react";

import { StatusBadge } from "@/components/clusters/status-badge";
import { ClusterAvatar, getClusterProfileMeta } from "@/components/ide/cluster-avatar";
import { Button } from "@/components/ui/button";
import type { ClusterContextDto, ContextId } from "@/lib/ipc/types";
import { useClusterProfileStore } from "@/stores/cluster-profile-store";

export interface ClusterCardProps {
  context: ClusterContextDto & { pending?: boolean };
  onConnect: (id: ContextId) => void;
  onDisconnect: (id: ContextId) => void;
  onSelect: (id: ContextId) => void;
  onEditAvatar?: (id: ContextId) => void;
  busy?: boolean;
}

export function ClusterCard({
  context,
  onConnect,
  onDisconnect,
  onSelect,
  onEditAvatar,
  busy,
}: ClusterCardProps) {
  const pinned = useClusterProfileStore((s) => s.pinnedIds.includes(context.id));
  const togglePin = useClusterProfileStore((s) => s.togglePin);
  const avatarConfig = useClusterProfileStore((s) => s.avatars[context.id]);

  const connected = context.state === "ready" || context.state === "degraded";
  const inFlight = busy || context.pending;
  const profile = getClusterProfileMeta(context.name);
  const authLabel = context.authHint ? `${context.authKind}: ${context.authHint}` : context.authKind;

  return (
    <article
      data-testid="cluster-card"
      data-context-id={context.id}
      className="px-4 py-3 transition-colors hover:bg-hover/65"
    >
      <div className="flex items-center gap-3">
        {/* Clickable cluster avatar (opens avatar studio editor) */}
        <button
          type="button"
          data-testid="edit-cluster-avatar"
          aria-label={`Customize icon for ${profile.shortName}`}
          title="Click to customize avatar"
          onClick={() => onEditAvatar?.(context.id)}
          className="group/avatar relative shrink-0 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <ClusterAvatar contextName={context.name} config={avatarConfig} size="sm" />
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg bg-background/65 opacity-0 transition-opacity group-hover/avatar:opacity-100"
          >
            <Sparkles size={12} className="text-primary" />
          </span>
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2
              className="truncate text-[13px] font-semibold leading-snug text-foreground"
              title={context.name}
            >
              {profile.shortName}
            </h2>
            {context.isCurrent ? (
              <span className="shrink-0 rounded border border-primary/40 bg-primary/10 px-1.5 py-0.2 font-mono text-[9px] font-semibold uppercase tracking-wide text-primary">
                current
              </span>
            ) : null}
          </div>
          <div className="mt-0.5 flex items-center gap-2 truncate font-mono text-[11px] text-muted-foreground">
            <span className="truncate" title={context.server || undefined}>
              {context.server || "No API server"}
            </span>
            <span className="text-border" aria-hidden="true">
              ·
            </span>
            <span className="shrink-0">{authLabel}</span>
            <span className="text-border" aria-hidden="true">
              ·
            </span>
            <span className="shrink-0">ns:{context.namespaceDefault}</span>
          </div>
        </div>

        <StatusBadge
          compact
          context={{ state: context.state, lastError: context.lastError, pending: inFlight }}
        />

        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            data-testid="toggle-pin-cluster"
            aria-pressed={pinned}
            aria-label={
              pinned
                ? `Unpin ${profile.shortName} from sidebar`
                : `Pin ${profile.shortName} to sidebar`
            }
            title={pinned ? "Unpin from sidebar" : "Pin to sidebar"}
            onClick={() => togglePin(context.id)}
            className={`flex h-7 w-7 items-center justify-center rounded border transition-colors ${
              pinned
                ? "border-primary/45 bg-primary/15 text-primary hover:bg-primary/25"
                : "border-transparent text-muted-foreground/65 hover:border-border hover:bg-elevated hover:text-foreground"
            }`}
          >
            <Pin size={12} className={pinned ? "fill-current" : ""} aria-hidden="true" />
          </button>

          {connected ? (
            <>
              <Button
                size="sm"
                className="h-7 px-2.5 text-[11px]"
                onClick={() => onSelect(context.id)}
                data-testid="open-cluster"
              >
                Explore <ArrowUpRight size={12} aria-hidden="true" />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-[11px]"
                onClick={() => onDisconnect(context.id)}
                disabled={inFlight}
              >
                Disconnect
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2.5 text-[11px]"
              onClick={() => onConnect(context.id)}
              disabled={inFlight}
              data-testid="connect-cluster"
            >
              <RefreshCw
                size={12}
                className={inFlight ? "animate-spin text-primary" : ""}
                aria-hidden="true"
              />
              {inFlight ? "Connecting…" : context.state === "disconnected" ? "Connect" : "Retry"}
            </Button>
          )}
        </div>
      </div>

      {context.lastError ? (
        <p
          data-testid="cluster-error"
          className="mt-2 break-words rounded-sm border-l-2 border-destructive bg-destructive/10 px-2.5 py-1 text-[11px] text-destructive"
        >
          {context.lastError.message}
          {context.lastError.retryable ? " — retry when ready." : ""}
        </p>
      ) : null}

      {context.issues.length > 0 ? (
        <ul data-testid="cluster-issues" className="mt-2 space-y-0.5 text-[11px] text-warning">
          {context.issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}
