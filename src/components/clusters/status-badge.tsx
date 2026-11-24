import { describeConnectionState } from "@/lib/utils";
import type { ConnectionState, KubixErrorDto } from "@/lib/ipc/types";

export interface StatusBadgeProps {
  context: {
    state: ConnectionState;
    lastError?: KubixErrorDto;
    pending?: boolean;
  };
  compact?: boolean;
}

const TONE_CLASSES: Record<string, string> = {
  neutral: "border-border bg-secondary/80 text-muted-foreground",
  busy: "border-primary/40 bg-primary/10 text-primary",
  ok: "border-success/35 bg-success/10 text-success",
  warn: "border-warning/45 bg-warning/10 text-warning",
  error: "border-destructive/45 bg-destructive/10 text-destructive",
};

export function StatusBadge({ context, compact }: StatusBadgeProps) {
  const state = context.pending ? "connecting" : context.state;
  const described = describeConnectionState(state, context.lastError as KubixErrorDto | undefined);
  const tone = TONE_CLASSES[described.tone] ?? TONE_CLASSES.neutral;
  return (
    <span
      data-testid="status-badge"
      data-state={state}
      data-tone={described.tone}
      title={described.description}
      className={`inline-flex items-center gap-1.5 rounded border font-medium uppercase tracking-wide ${
        compact ? "px-1.5 py-0.5 text-[9.5px]" : "px-2 py-0.5 text-[10px]"
      } ${tone}`}
    >
      <span
        aria-hidden
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
          described.tone === "ok"
            ? "bg-success"
            : described.tone === "error"
              ? "bg-destructive"
              : described.tone === "warn"
                ? "bg-warning"
                : described.tone === "busy"
                  ? "animate-pulse bg-primary"
                  : "bg-muted-foreground"
        }`}
      />
      {described.label}
    </span>
  );
}

export interface ResourceStatusChipProps {
  label: string;
  tone: "ok" | "warn" | "error" | "info" | "neutral";
}

const RESOURCE_TONE_CLASSES: Record<ResourceStatusChipProps["tone"], string> = {
  ok: "border-success/30 bg-success/10 text-success",
  warn: "border-warning/35 bg-warning/10 text-warning",
  error: "border-destructive/40 bg-destructive/10 text-destructive",
  info: "border-primary/35 bg-primary/10 text-primary",
  neutral: "border-border bg-secondary/70 text-muted-foreground",
};

export function ResourceStatusChip({ label, tone }: ResourceStatusChipProps) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium leading-none ${RESOURCE_TONE_CLASSES[tone]}`}
    >
      <span
        aria-hidden="true"
        className={`h-1.5 w-1.5 rounded-full ${
          tone === "ok"
            ? "bg-success"
            : tone === "warn"
              ? "bg-warning"
              : tone === "error"
                ? "bg-destructive"
                : tone === "info"
                  ? "bg-primary"
                  : "bg-muted-foreground"
        }`}
      />
      <span className="truncate">{label}</span>
    </span>
  );
}
