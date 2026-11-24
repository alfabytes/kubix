import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface SectionCardProps {
  title: string;
  subtitle?: string;
  icon?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}

export function SectionCard({
  title,
  subtitle,
  icon,
  actions,
  children,
  className,
  bodyClassName,
}: SectionCardProps) {
  return (
    <section
      className={cn(
        "flex flex-col overflow-hidden rounded border border-border bg-panel",
        className,
      )}
    >
      <header className="flex min-h-8 items-center justify-between gap-2 border-b border-border bg-elevated/70 px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-2">
          {icon ? <span className="shrink-0 text-primary">{icon}</span> : null}
          <h3 className="truncate text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground">
            {title}
          </h3>
          {subtitle ? (
            <span className="truncate font-mono text-[10px] text-muted-foreground">
              {subtitle}
            </span>
          ) : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
      </header>
      <div className={cn("p-3", bodyClassName)}>{children}</div>
    </section>
  );
}
