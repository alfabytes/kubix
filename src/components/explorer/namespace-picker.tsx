import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Filter, Search, X } from "lucide-react";

import { cn } from "@/lib/utils";
import type { Namespace } from "@/lib/ipc/types";

export const ALL_NAMESPACES = "";

/** Parse a namespace filter string (`""`, `"dev"`, or `"dev,prod"`) into unique sorted names. */
export function parseNamespaceSelection(value: Namespace): string[] {
  if (!value) return [];
  const seen = new Set<string>();
  for (const part of value.split(",")) {
    const trimmed = part.trim();
    if (trimmed) seen.add(trimmed);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

/** Serialize an array of namespace names back into the canonical comma-separated filter string. */
export function formatNamespaceSelection(namespaces: string[]): Namespace {
  const unique = uniqueNonEmpty(namespaces);
  return unique.join(",");
}

export interface NamespacePickerProps {
  value: Namespace;
  defaultValue: string;
  observed: string[];
  onChange: (namespace: Namespace) => void;
  /** Allow toggling multiple namespaces simultaneously (default: true). */
  multi?: boolean;
}

/**
 * Lens-style namespace scope selector supporting All Namespaces, single selection,
 * and multi-namespace selection with quick search and hover-to-isolate ("only").
 */
export function NamespacePicker({
  value,
  defaultValue,
  observed,
  onChange,
  multi = true,
}: NamespacePickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  const selectedList = useMemo(() => parseNamespaceSelection(value), [value]);
  const selectedSet = useMemo(() => new Set(selectedList), [selectedList]);
  const options = useMemo(
    () => uniqueNonEmpty([defaultValue, ...observed, ...selectedList]),
    [defaultValue, observed, selectedList],
  );
  const filteredOptions = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return options;
    return options.filter((ns) => ns.toLowerCase().includes(needle));
  }, [options, query]);

  const allNamespaces = selectedList.length === 0;

  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
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

  const triggerLabel = allNamespaces
    ? "All Namespaces"
    : selectedList.length === 1
      ? selectedList[0]!
      : selectedList.join(", ").length <= 20
        ? selectedList.join(", ")
        : `${selectedList.length} namespaces`;

  const handleToggleNamespace = (ns: string) => {
    if (!multi) {
      onChange(ns);
      setOpen(false);
      return;
    }
    const next = new Set(selectedSet);
    if (next.has(ns)) {
      next.delete(ns);
    } else {
      next.add(ns);
    }
    onChange(formatNamespaceSelection([...next]));
  };

  return (
    <div ref={containerRef} className="relative" data-testid="namespace-picker">
      <button
        type="button"
        data-testid="namespace-filter"
        data-value={value}
        data-selected-count={selectedList.length}
        aria-label="Namespace filter"
        aria-haspopup="listbox"
        aria-expanded={open}
        title={allNamespaces ? "All Namespaces" : selectedList.join(", ")}
        onClick={() => setOpen((prev) => !prev)}
        className={cn(
          "inline-flex h-7 items-center gap-1.5 rounded border px-2.5 text-[11.5px] font-medium transition-colors",
          open
            ? "border-primary/70 bg-elevated text-foreground"
            : allNamespaces
              ? "border-border-strong bg-elevated text-foreground hover:border-primary/60"
              : "border-primary/50 bg-elevated text-foreground hover:border-primary/80",
        )}
      >
        <Filter size={11} className="text-muted-foreground" aria-hidden="true" />
        <span className="max-w-[12rem] truncate font-mono text-[11px]">{triggerLabel}</span>
        {selectedList.length > 1 ? (
          <span className="rounded bg-primary/15 px-1 py-0.2 font-mono text-[9.5px] font-semibold text-primary">
            {selectedList.length}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          role="listbox"
          aria-label="Namespaces"
          aria-multiselectable={multi}
          data-testid="namespace-popover"
          className="absolute left-0 top-8 z-50 w-60 overflow-hidden rounded-md border border-border-strong bg-popover shadow-2xl"
        >
          <div className="flex items-center justify-between border-b border-border px-3 py-1.5 text-[11px]">
            <span className="font-semibold text-foreground">
              Namespaces{selectedList.length > 0 ? ` (${selectedList.length})` : ""}
            </span>
            {selectedList.length > 0 ? (
              <button
                type="button"
                data-testid="namespace-clear-selection"
                onClick={() => onChange(ALL_NAMESPACES)}
                className="text-[10px] text-muted-foreground transition-colors hover:text-primary"
              >
                Reset
              </button>
            ) : null}
          </div>

          {options.length > 4 ? (
            <div className="border-b border-border/80 px-2 py-1.5">
              <div className="relative">
                <Search
                  size={11}
                  className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground"
                  aria-hidden="true"
                />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Filter namespaces…"
                  aria-label="Filter namespaces"
                  data-testid="namespace-search-input"
                  className="h-6 w-full rounded border border-border bg-background pl-6 pr-6 font-mono text-[11px] text-foreground placeholder:text-muted-foreground focus:border-primary/70 focus:outline-none"
                />
                {query ? (
                  <button
                    type="button"
                    aria-label="Clear namespace search"
                    onClick={() => setQuery("")}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    <X size={10} />
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}

          <div className="max-h-64 overflow-y-auto py-1">
            <button
              type="button"
              role="option"
              aria-selected={allNamespaces}
              data-testid="namespace-all-toggle"
              data-active={allNamespaces}
              onClick={() => {
                onChange(ALL_NAMESPACES);
                setOpen(false);
              }}
              className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11.5px] text-foreground transition-colors hover:bg-hover"
            >
              <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                {allNamespaces ? <Check size={12} className="text-primary" /> : null}
              </span>
              <span>All Namespaces</span>
            </button>

            <div className="my-1 h-px bg-border" />

            {filteredOptions.length === 0 ? (
              <div className="px-3 py-2 text-[11px] text-muted-foreground">
                No namespaces match &ldquo;{query}&rdquo;
              </div>
            ) : (
              filteredOptions.map((namespace) => {
                const selected = !allNamespaces && selectedSet.has(namespace);
                return (
                  <div
                    key={namespace}
                    className="group flex items-center pr-1.5 transition-colors hover:bg-hover"
                  >
                    <button
                      type="button"
                      role="option"
                      aria-selected={selected}
                      data-testid="namespace-option"
                      data-namespace={namespace}
                      onClick={() => handleToggleNamespace(namespace)}
                      className={cn(
                        "flex min-w-0 flex-1 items-center gap-2 px-2.5 py-1.5 text-left font-mono text-[11px]",
                        selected
                          ? "font-medium text-foreground"
                          : "text-muted-foreground group-hover:text-foreground",
                      )}
                    >
                      {multi ? (
                        <span
                          aria-hidden="true"
                          className={cn(
                            "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] border transition-colors",
                            selected
                              ? "border-primary bg-primary text-primary-foreground"
                              : "border-border-strong bg-background",
                          )}
                        >
                          {selected ? <Check size={10} strokeWidth={2.75} /> : null}
                        </span>
                      ) : (
                        <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                          {selected ? <Check size={12} className="text-primary" /> : null}
                        </span>
                      )}
                      <span className="truncate">{namespace}</span>
                    </button>

                    {multi ? (
                      <button
                        type="button"
                        data-testid={`namespace-only-${namespace}`}
                        title={`Select only ${namespace}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onChange(namespace);
                          setOpen(false);
                        }}
                        className="shrink-0 rounded px-1.5 py-0.5 text-[9.5px] font-medium text-muted-foreground opacity-0 transition-opacity hover:bg-elevated hover:text-primary group-hover:opacity-100 focus:opacity-100"
                      >
                        only
                      </button>
                    ) : null}
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

function uniqueNonEmpty(values: string[]): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed) seen.add(trimmed);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}
