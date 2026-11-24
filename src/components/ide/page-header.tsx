import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";

export interface PageHeaderProps {
  title: string;
  breadcrumbs?: string[];
  badge?: ReactNode;
  scopeLabel?: string;
  meta?: string;
  controls?: ReactNode;
  actions?: ReactNode;
}

export function PageHeader({
  title,
  breadcrumbs,
  badge,
  scopeLabel,
  meta,
  controls,
  actions,
}: PageHeaderProps) {
  return (
    <header className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border bg-panel px-3 py-2">
      <div className="min-w-0">
        {breadcrumbs && breadcrumbs.length > 0 ? (
          <div className="mb-0.5 flex items-center gap-1 text-[10px] text-muted-foreground">
            {breadcrumbs.map((crumb, idx) => (
              <span key={`${crumb}-${idx}`} className="flex items-center gap-1 truncate">
                {idx > 0 ? <ChevronRight size={10} className="shrink-0 opacity-60" aria-hidden="true" /> : null}
                <span className={idx === breadcrumbs.length - 1 ? "text-primary font-medium" : "truncate"}>
                  {crumb}
                </span>
              </span>
            ))}
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="truncate text-sm font-semibold tracking-tight text-foreground">{title}</h1>
          {badge}
          {scopeLabel ? (
            <span className="rounded border border-border bg-elevated px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              {scopeLabel}
            </span>
          ) : null}
          {meta ? (
            <span className="hidden truncate font-mono text-[10.5px] text-muted-foreground lg:inline">
              {meta}
            </span>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {controls}
        {actions}
      </div>
    </header>
  );
}
