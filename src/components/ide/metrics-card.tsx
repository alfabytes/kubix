import { useId, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface MetricsCardProps {
  label: string;
  value: string | number;
  sublabel?: string;
  icon?: ReactNode;
  progressPct?: number;
  tone?: "primary" | "success" | "warning" | "destructive" | "neutral";
  sparkline?: number[];
  onClick?: () => void;
  className?: string;
}

const TONE_ACCENT = {
  primary: {
    bar: "bg-primary",
    stroke: "hsl(var(--primary))",
    text: "text-primary",
  },
  success: {
    bar: "bg-success",
    stroke: "hsl(var(--success))",
    text: "text-success",
  },
  warning: {
    bar: "bg-warning",
    stroke: "hsl(var(--warning))",
    text: "text-warning",
  },
  destructive: {
    bar: "bg-destructive",
    stroke: "hsl(var(--destructive))",
    text: "text-destructive",
  },
  neutral: {
    bar: "bg-muted-foreground",
    stroke: "hsl(var(--muted-foreground))",
    text: "text-muted-foreground",
  },
};

export function MetricsCard({
  label,
  value,
  sublabel,
  icon,
  progressPct,
  tone = "primary",
  sparkline,
  onClick,
  className,
}: MetricsCardProps) {
  const gradId = useId();
  const accent = TONE_ACCENT[tone];

  let linePoints: string | null = null;
  let areaPoints: string | null = null;
  let lastCoord: { x: number; y: number } | null = null;

  if (sparkline && sparkline.length > 1) {
    const min = Math.min(...sparkline);
    const max = Math.max(...sparkline);
    const span = Math.max(max - min, 4);
    const coords = sparkline.map((v, i) => {
      const x = (i / (sparkline.length - 1)) * 76;
      const norm = (v - min) / span;
      const y = 21 - (norm * 15 + 3);
      return { x, y };
    });
    linePoints = coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");
    areaPoints = `0,24 ${linePoints} 76,24`;
    lastCoord = coords[coords.length - 1] ?? null;
  }

  const valueText = String(value);

  const content = (
    <>
      <div className="flex w-full min-w-0 items-center justify-between gap-2">
        <span className="ide-meta-label truncate">{label}</span>
        {icon ? <span className={cn("shrink-0", accent.text)}>{icon}</span> : null}
      </div>
      <div className="flex w-full min-w-0 items-end justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div
            className={cn(
              "truncate font-mono font-semibold leading-tight tabular-nums text-foreground",
              valueText.length > 14 ? "text-[13px]" : "text-base",
            )}
            title={valueText}
          >
            {value}
          </div>
          {sublabel ? (
            <div
              className="mt-0.5 truncate text-[10.5px] text-muted-foreground"
              title={sublabel}
            >
              {sublabel}
            </div>
          ) : null}
        </div>
        {linePoints && areaPoints ? (
          <svg
            width="78"
            height="26"
            viewBox="0 0 78 26"
            className="shrink-0 overflow-visible"
            aria-hidden="true"
          >
            <defs>
              <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={accent.stroke} stopOpacity="0.32" />
                <stop offset="100%" stopColor={accent.stroke} stopOpacity="0.0" />
              </linearGradient>
            </defs>
            <polygon points={areaPoints} fill={`url(#${gradId})`} />
            <polyline
              fill="none"
              stroke={accent.stroke}
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              points={linePoints}
            />
            {lastCoord ? (
              <circle
                cx={lastCoord.x}
                cy={lastCoord.y}
                r="2.2"
                fill={accent.stroke}
              />
            ) : null}
          </svg>
        ) : null}
      </div>
      {typeof progressPct === "number" ? (
        <div className="mt-0.5 h-1 w-full overflow-hidden rounded-sm bg-secondary">
          <div
            className={cn("h-full transition-all", accent.bar)}
            style={{ width: `${Math.max(2, Math.min(100, progressPct))}%` }}
          />
        </div>
      ) : null}
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "flex min-w-0 flex-col justify-between gap-1.5 overflow-hidden rounded border border-border bg-panel px-3 py-2 text-left transition-colors hover:border-primary/40 hover:bg-hover/40",
          className,
        )}
      >
        {content}
      </button>
    );
  }

  return (
    <div
      className={cn(
        "flex min-w-0 flex-col justify-between gap-1.5 overflow-hidden rounded border border-border bg-panel px-3 py-2",
        className,
      )}
    >
      {content}
    </div>
  );
}
