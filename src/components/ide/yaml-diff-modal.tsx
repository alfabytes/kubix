import { DiffEditor } from "@monaco-editor/react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeftRight, Columns2, Loader2, Rows2, Sparkles, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { ipc } from "@/lib/ipc/client";
import { stripYamlNoise } from "@/lib/yaml-utils";
import { useSettingsStore } from "@/stores/settings-store";

export interface DiffResourceRef {
  gvr: string;
  kind?: string;
  name: string;
  namespace?: string;
}

export interface YamlDiffModalProps {
  contextId: string;
  left: DiffResourceRef;
  right: DiffResourceRef;
  theme?: "dark" | "light";
  onClose: () => void;
}

export function YamlDiffModal({
  contextId,
  left: initialLeft,
  right: initialRight,
  theme = "dark",
  onClose,
}: YamlDiffModalProps) {
  const yamlFontSize = useSettingsStore((s) => s.yamlFontSize);
  const [swapped, setSwapped] = useState(false);
  const [cleanMode, setCleanMode] = useState(true);
  const [sideBySide, setSideBySide] = useState(true);

  const left = swapped ? initialRight : initialLeft;
  const right = swapped ? initialLeft : initialRight;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const leftQuery = useQuery({
    queryKey: ["resource", contextId, left.gvr, left.namespace ?? "", left.name],
    queryFn: () => ipc.getResource(contextId, left.gvr, left.name, left.namespace),
    retry: false,
  });

  const rightQuery = useQuery({
    queryKey: ["resource", contextId, right.gvr, right.namespace ?? "", right.name],
    queryFn: () => ipc.getResource(contextId, right.gvr, right.name, right.namespace),
    retry: false,
  });

  const originalYaml = useMemo(() => {
    const raw = leftQuery.data?.yaml ?? "";
    return cleanMode ? stripYamlNoise(raw) : raw;
  }, [cleanMode, leftQuery.data?.yaml]);

  const modifiedYaml = useMemo(() => {
    const raw = rightQuery.data?.yaml ?? "";
    return cleanMode ? stripYamlNoise(raw) : raw;
  }, [cleanMode, rightQuery.data?.yaml]);

  const loading = leftQuery.isLoading || rightQuery.isLoading;
  const error = leftQuery.error || rightQuery.error;

  const formatRef = (ref: DiffResourceRef) =>
    ref.namespace ? `${ref.namespace}/${ref.name}` : ref.name;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="YAML Diff Comparison"
      data-testid="yaml-diff-modal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        className="flex h-[84vh] w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-border-strong bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header Toolbar */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-elevated/60 px-3.5 py-2.5">
          <div className="flex min-w-0 flex-wrap items-center gap-2 text-[11.5px]">
            <span
              data-testid="diff-left-label"
              className="max-w-[240px] truncate rounded border border-border bg-panel px-2 py-0.5 font-mono font-semibold text-foreground"
              title={formatRef(left)}
            >
              {formatRef(left)}
            </span>
            <button
              type="button"
              data-testid="diff-swap-sides"
              onClick={() => setSwapped((s) => !s)}
              title="Swap left and right manifests"
              aria-label="Swap left and right manifests"
              className="flex h-6 w-6 items-center justify-center rounded border border-border bg-panel text-muted-foreground transition-colors hover:border-primary/60 hover:text-primary"
            >
              <ArrowLeftRight size={12} aria-hidden="true" />
            </button>
            <span
              data-testid="diff-right-label"
              className="max-w-[240px] truncate rounded border border-primary/40 bg-primary/10 px-2 py-0.5 font-mono font-semibold text-primary"
              title={formatRef(right)}
            >
              {formatRef(right)}
            </span>
          </div>

          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              variant={cleanMode ? "secondary" : "outline"}
              className="h-7 px-2.5 text-[11px]"
              data-testid="diff-toggle-clean"
              aria-pressed={cleanMode}
              title="Strip managedFields, uid, resourceVersion, and status from both sides"
              onClick={() => setCleanMode((v) => !v)}
            >
              <Sparkles size={11} aria-hidden="true" />
              Clean YAML
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2.5 text-[11px]"
              data-testid="diff-toggle-layout"
              onClick={() => setSideBySide((v) => !v)}
            >
              {sideBySide ? (
                <>
                  <Rows2 size={11} aria-hidden="true" /> Inline
                </>
              ) : (
                <>
                  <Columns2 size={11} aria-hidden="true" /> Side-by-side
                </>
              )}
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              aria-label="Close diff"
              onClick={onClose}
            >
              <X size={14} />
            </Button>
          </div>
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 bg-background">
          {loading ? (
            <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin text-primary" aria-hidden="true" />
              Loading manifests for comparison…
            </div>
          ) : error ? (
            <div className="m-4 rounded border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
              {String((error as Error).message)}
            </div>
          ) : (
            <DiffEditor
              height="100%"
              language="yaml"
              original={originalYaml}
              modified={modifiedYaml}
              theme={theme === "dark" ? "vs-dark" : "vs"}
              options={{
                readOnly: true,
                domReadOnly: true,
                renderSideBySide: sideBySide,
                fontSize: yamlFontSize,
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                automaticLayout: true,
                wordWrap: "on",
                ignoreTrimWhitespace: false,
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
