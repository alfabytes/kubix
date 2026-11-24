import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Package, RefreshCw, Server, ShieldCheck } from "lucide-react";

import { ResourceStatusChip } from "@/components/clusters/status-badge";
import { MetricsCard } from "@/components/ide/metrics-card";
import { SectionCard } from "@/components/ide/section-card";
import { useStopWatchOnUnmount } from "@/lib/hooks";
import { ipc } from "@/lib/ipc/client";
import { formatAge } from "@/lib/resource-telemetry";
import type { ContextRow } from "@/stores/cluster-store";

interface HelmReleaseRow {
  name: string;
  namespace: string;
  revision: number;
  status: string;
  updated: string;
  secretName: string;
}

export function HelmReleasesView({ context }: { context: ContextRow }) {
  const ready = context.state === "ready" || context.state === "degraded";
  const secretsQuery = useQuery({
    queryKey: ["helm-secrets", context.id],
    queryFn: () => ipc.listResources(context.id, "/v1/secrets", ""),
    enabled: ready,
    retry: false,
  });
  useStopWatchOnUnmount(context.id, ready ? "/v1/secrets" : null, "");

  const releases = useMemo<HelmReleaseRow[]>(() => {
    const rows = Array.isArray(secretsQuery.data) ? secretsQuery.data : [];
    const byKey = new Map<string, HelmReleaseRow>();

    for (const s of rows) {
      const isHelm =
        s.labels?.owner === "helm" ||
        s.node === "helm.sh/release.v1" ||
        s.name.startsWith("sh.helm.release.v1.");
      if (!isHelm) continue;

      let relName = s.labels?.name ?? "";
      let rev = Number(s.labels?.version ?? 0);
      if (!relName && s.name.startsWith("sh.helm.release.v1.")) {
        const rest = s.name.slice("sh.helm.release.v1.".length);
        const m = rest.match(/^(.+)\.v(\d+)$/);
        if (m?.[1]) {
          relName = m[1];
          rev = Number(m[2] ?? 1);
        } else {
          relName = rest;
        }
      }
      if (!relName) relName = s.name;
      if (!rev) rev = 1;

      const ns = s.namespace ?? "default";
      const key = `${ns}/${relName}`;
      const existing = byKey.get(key);
      if (!existing || rev >= existing.revision) {
        byKey.set(key, {
          name: relName,
          namespace: ns,
          revision: rev,
          status: s.labels?.status ?? "deployed",
          updated: formatAge(s.createdAt),
          secretName: s.name,
        });
      }
    }

    return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [secretsQuery.data]);

  const deployedCount = releases.filter(
    (r) => r.status.toLowerCase() === "deployed",
  ).length;
  const failedCount = releases.length - deployedCount;

  return (
    <div data-testid="helm-view" className="h-full overflow-y-auto p-3 space-y-3">
      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <MetricsCard
          label="Discovered Releases"
          value={releases.length}
          sublabel="helm.sh/release.v1 secrets"
          icon={<Package size={14} />}
          tone="primary"
        />
        <MetricsCard
          label="Deployed"
          value={deployedCount}
          sublabel="Active revisions"
          icon={<CheckCircle2 size={14} />}
          tone="success"
        />
        <MetricsCard
          label="Other / Failed"
          value={failedCount}
          sublabel={failedCount > 0 ? "Needs review" : "No stuck upgrades"}
          icon={<ShieldCheck size={14} />}
          tone={failedCount > 0 ? "warning" : "neutral"}
        />
        <MetricsCard
          label="Default Namespace"
          value={context.namespaceDefault}
          sublabel="Helm secret backend"
          icon={<Server size={14} />}
          tone="primary"
        />
      </div>

      <SectionCard
        title="Helm Releases"
        subtitle="Read-only release inventory discovered from cluster secrets"
        icon={<Package size={13} />}
        bodyClassName="p-0"
      >
        {secretsQuery.isLoading ? (
          <div className="flex items-center gap-2 p-4 text-xs text-muted-foreground">
            <RefreshCw className="h-3.5 w-3.5 animate-spin text-primary" aria-hidden />
            Scanning cluster for Helm release secrets…
          </div>
        ) : releases.length === 0 ? (
          <div className="p-8 text-center text-xs text-muted-foreground">
            No Helm releases found in <strong className="text-foreground">{context.name}</strong>{" "}
            (checked <code className="font-mono text-[10.5px]">helm.sh/release.v1</code> secrets
            across all namespaces).
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-[11.5px]">
              <thead>
                <tr className="border-b border-border bg-elevated/80 ide-table-header">
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Release</th>
                  <th className="px-3 py-2">Namespace</th>
                  <th className="px-3 py-2">Revision</th>
                  <th className="px-3 py-2">Storage Secret</th>
                  <th className="px-3 py-2">Age</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/70">
                {releases.map((rel) => (
                  <tr key={`${rel.namespace}/${rel.name}`} className="hover:bg-hover/60">
                    <td className="px-3 py-2">
                      <ResourceStatusChip
                        label={rel.status}
                        tone={rel.status.toLowerCase() === "deployed" ? "ok" : "warn"}
                      />
                    </td>
                    <td className="px-3 py-2 font-medium text-primary">{rel.name}</td>
                    <td className="px-3 py-2 font-mono text-muted-foreground">{rel.namespace}</td>
                    <td className="px-3 py-2 font-mono tabular-nums">{rel.revision}</td>
                    <td className="px-3 py-2 font-mono text-muted-foreground">{rel.secretName}</td>
                    <td className="px-3 py-2 font-mono tabular-nums text-muted-foreground">
                      {rel.updated}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}
