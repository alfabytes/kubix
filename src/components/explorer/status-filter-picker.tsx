import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, Check } from "lucide-react";

import { cn } from "@/lib/utils";

export type StatusTone = "ok" | "warn" | "error" | "info" | "neutral";

export interface StatusFilterOption {
  status: string;
  count: number;
  tone: StatusTone;
}

export interface StatusFilterPickerProps {
  selected: string[];
  options: StatusFilterOption[];
  onChange: (next: string[]) => void;
}

function dotColorClass(tone: StatusTone): string {
  switch (tone) {
    case "ok":
      return "bg-success";
    case "warn":
      return "bg-warning";
    case "error":
      return "bg-destructive";
    case "info":
      return "bg-primary";
    default:
      return "bg-muted-foreground";
  }
}

function textColorClass(tone: StatusTone): string {
  switch (tone) {
    case "ok":
      return "text-success";
    case "warn":
      return "text-warning";
    case "error":
      return "text-destructive";
    case "info":
      return "text-primary";
    default:
      return "text-muted-foreground";
  }
}

export function StatusFilterPicker({
  selected,
  options,
  onChange,
}: StatusFilterPickerProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const allStatuses = selected.length === 0;

  const issueStatuses = useMemo(
    () =>
      options
        .filter((opt) => opt.tone === "error" || opt.tone === "warn")
        .map((opt) => opt.status),
    [options],
  );

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const singleOption =
    selected.length === 1 ? options.find((o) => o.status === selected[0]) : undefined;

  const triggerLabel = allStatuses
    ? "All Statuses"
    : selected.length === 1
      ? selected[0]!
      : `${selected.length} statuses`;

  const toggleStatus = (status: string) => {
    const next = new Set(selectedSet);
    if (next.has(status)) next.delete(status);
    else next.add(status);
    onChange([...next]);
  };

  return (
    <div ref={containerRef} className="relative" data-testid="status-filter-picker">
      <button
        type="button"
        data-testid="pod-status-filter"
        data-value={selected.join(",")}
        aria-label="Status filter"
        aria-haspopup="listbox"
        aria-expanded={open}
        title={allStatuses ? "All Statuses" : selected.join(", ")}
        onClick={() => setOpen((prev) => !prev)}
        className={cn(
          "inline-flex h-7 items-center gap-1.5 rounded border px-2.5 text-[11.5px] font-medium transition-colors",
          open
            ? "border-primary/70 bg-elevated text-foreground"
            : allStatuses
              ? "border-border-strong bg-elevated text-foreground hover:border-primary/60"
              : "border-primary/50 bg-elevated text-foreground hover:border-primary/80",
        )}
      >
        {singleOption ? (
          <span
            aria-hidden="true"
            className={cn("h-2 w-2 shrink-0 rounded-full", dotColorClass(singleOption.tone))}
          />
        ) : (
          <Activity size={11} className="text-muted-foreground" aria-hidden="true" />
        )}
        <span className="max-w-[10rem] truncate font-mono text-[11px]">{triggerLabel}</span>
        {selected.length > 1 ? (
          <span className="rounded bg-primary/15 px-1 py-0.2 font-mono text-[9.5px] font-semibold text-primary">
            {selected.length}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          role="listbox"
          aria-label="Pod statuses"
          aria-multiselectable="true"
          data-testid="pod-status-popover"
          className="absolute left-0 top-8 z-50 w-56 overflow-hidden rounded-md border border-border-strong bg-popover shadow-2xl"
        >
          <div className="flex items-center justify-between border-b border-border px-3 py-1.5 text-[11px]">
            <span className="font-semibold text-foreground">
              Status{selected.length > 0 ? ` (${selected.length})` : ""}
            </span>
            {selected.length > 0 ? (
              <button
                type="button"
                data-testid="status-clear-selection"
                onClick={() => onChange([])}
                className="text-[10px] text-muted-foreground transition-colors hover:text-primary"
              >
                Reset
              </button>
            ) : issueStatuses.length > 0 ? (
              <button
                type="button"
                data-testid="status-issues-only"
                onClick={() => {
                  onChange(issueStatuses);
                  setOpen(false);
                }}
                className="text-[10px] font-medium text-warning transition-colors hover:underline"
              >
                Issues only
              </button>
            ) : null}
          </div>

          <div className="max-h-64 overflow-y-auto py-1">
            <button
              type="button"
              role="option"
              aria-selected={allStatuses}
              data-testid="status-all-toggle"
              data-active={allStatuses}
              onClick={() => {
                onChange([]);
                setOpen(false);
              }}
              className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11.5px] text-foreground transition-colors hover:bg-hover"
            >
              <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                {allStatuses ? <Check size={12} className="text-primary" /> : null}
              </span>
              <span>All Statuses</span>
            </button>

            <div className="my-1 h-px bg-border" />

            {options.length === 0 ? (
              <div className="px-3 py-2 text-[11px] text-muted-foreground">
                No pods loaded yet
              </div>
            ) : (
              options.map((opt) => {
                const isSelected = selectedSet.has(opt.status);
                return (
                  <div
                    key={opt.status}
                    className="group flex items-center pr-1.5 transition-colors hover:bg-hover"
                  >
                    <button
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      data-testid="status-option"
                      data-status={opt.status}
                      onClick={() => toggleStatus(opt.status)}
                      className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-1.5 text-left text-[11.5px]"
                    >
                      <span
                        aria-hidden="true"
                        className={cn(
                          "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] border transition-colors",
                          isSelected
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border-strong bg-background",
                        )}
                      >
                        {isSelected ? <Check size={10} strokeWidth={2.75} /> : null}
                      </span>
                      <span
                        aria-hidden="true"
                        className={cn("h-2 w-2 shrink-0 rounded-full", dotColorClass(opt.tone))}
                      />
                      <span
                        className={cn(
                          "min-w-0 flex-1 truncate font-medium",
                          textColorClass(opt.tone),
                        )}
                      >
                        {opt.status}
                      </span>
                      <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
                        {opt.count}
                      </span>
                    </button>

                    <button
                      type="button"
                      data-testid={`status-only-${opt.status}`}
                      title={`Show only ${opt.status}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onChange([opt.status]);
                        setOpen(false);
                      }}
                      className="shrink-0 rounded px-1.5 py-0.5 text-[9.5px] font-medium text-muted-foreground opacity-0 transition-opacity hover:bg-elevated hover:text-primary group-hover:opacity-100 focus:opacity-100"
                    >
                      only
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
