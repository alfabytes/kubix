import { useMemo, useState } from "react";
import { AlertCircle, FolderOpen, RefreshCw, Search } from "lucide-react";

import { ClusterCard } from "@/components/clusters/cluster-card";
import { ClusterAvatarEditor } from "@/components/ide/cluster-avatar-editor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  useConnectMutation,
  useContextsQuery,
  useDisconnectMutation,
  useRescanMutation,
} from "@/lib/hooks";
import { selectOrderedContexts, useClusterStore } from "@/stores/cluster-store";

export function ClusterPicker() {
  const { isLoading, isError, error } = useContextsQuery();
  const rows = useClusterStore(selectOrderedContexts);
  const loading = useClusterStore((s) => s.loading);
  const loadError = useClusterStore((s) => s.error);
  const select = useClusterStore((s) => s.select);

  const connect = useConnectMutation();
  const disconnect = useDisconnectMutation();
  const rescan = useRescanMutation();

  const [filter, setFilter] = useState("");
  const [editingContextId, setEditingContextId] = useState<string | null>(null);

  const editingContext = useMemo(
    () => (editingContextId ? rows.find((r) => r.id === editingContextId) ?? null : null),
    [editingContextId, rows],
  );

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter(
      (row) =>
        row.name.toLowerCase().includes(needle) ||
        row.server.toLowerCase().includes(needle) ||
        row.clusterName.toLowerCase().includes(needle),
    );
  }, [filter, rows]);

  const busyId = connect.isPending ? (connect.variables as string | undefined) : undefined;
  const failure = loadError ?? (isError ? String((error as Error)?.message ?? error) : null);

  return (
    <div className="flex h-full min-w-0 flex-col bg-background">
      {/* Single unified 42px toolbar matching resource views */}
      <header className="flex min-h-[42px] shrink-0 flex-wrap items-center justify-between gap-2.5 border-b border-border bg-panel px-3 py-1.5">
        <div className="flex items-center gap-2">
          <h1 className="text-[14px] font-semibold tracking-tight text-foreground">
            Your clusters
          </h1>
          <span
            className="rounded border border-border bg-elevated px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-muted-foreground"
            data-testid="cluster-count"
          >
            {visible.length} of {rows.length}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <div className="relative w-52">
            <Search
              className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Filter contexts"
              className="h-7 bg-background pl-7 text-[11.5px]"
              aria-label="Filter contexts"
            />
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2.5 text-[11px]"
            onClick={() => rescan.mutate()}
            disabled={rescan.isPending || loading || isLoading}
            data-testid="rescan-kubeconfig"
          >
            <RefreshCw
              className={`h-3 w-3 ${rescan.isPending || loading ? "animate-spin text-primary" : ""}`}
              aria-hidden
            />
            Rescan
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto px-4 py-4">
        <div className="mx-auto w-full max-w-4xl overflow-hidden rounded-md border border-border bg-panel">
          {loading || isLoading ? (
            <div
              className="flex items-center gap-2 p-4 text-xs text-muted-foreground"
              data-testid="clusters-loading"
            >
              <RefreshCw className="h-3 w-3 animate-spin text-primary" aria-hidden />
              Reading kubeconfig…
            </div>
          ) : null}

          {failure ? (
            <div
              role="alert"
              data-testid="clusters-error"
              className="m-3 flex items-start gap-2 rounded border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive"
            >
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              <div>
                <p className="font-medium">Could not read kubeconfig</p>
                <p className="mt-1 opacity-90">{failure}</p>
                <p className="mt-2 opacity-80">
                  Kubix looks at <code>$KUBECONFIG</code> first, then <code>~/.kube/config</code>.
                </p>
              </div>
            </div>
          ) : null}

          {!loading && !isLoading && !failure && rows.length === 0 ? (
            <div
              className="flex flex-col items-center justify-center gap-2 py-16 text-center text-xs text-muted-foreground"
              data-testid="clusters-empty"
            >
              <FolderOpen className="h-5 w-5" aria-hidden />
              <p className="font-medium text-foreground">No contexts found</p>
              <p>Add a context to your kubeconfig and rescan.</p>
            </div>
          ) : null}

          <div className="divide-y divide-border/70">
            {visible.map((row) => (
              <ClusterCard
                key={row.id}
                context={row}
                busy={busyId === row.id}
                onConnect={(id) => {
                  select(id);
                  connect.mutate(id);
                }}
                onDisconnect={(id) => disconnect.mutate(id)}
                onSelect={(id) => select(id)}
                onEditAvatar={(id) => setEditingContextId(id)}
              />
            ))}
          </div>

          {!loading && rows.length > 0 && visible.length === 0 ? (
            <p className="py-10 text-center text-xs text-muted-foreground">
              No contexts match “{filter}”.
            </p>
          ) : null}
        </div>
      </div>

      {editingContext ? (
        <ClusterAvatarEditor
          contextId={editingContext.id}
          contextName={editingContext.name}
          onClose={() => setEditingContextId(null)}
        />
      ) : null}
    </div>
  );
}
