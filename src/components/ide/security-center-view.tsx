import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowUpRight,
  EyeOff,
  Lock,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";

import { ResourceStatusChip } from "@/components/clusters/status-badge";
import { MetricsCard } from "@/components/ide/metrics-card";
import { SectionCard } from "@/components/ide/section-card";
import { Button } from "@/components/ui/button";
import { ipc } from "@/lib/ipc/client";
import type { ResourceNavigationTarget } from "@/lib/resource-telemetry";
import type { ContextRow } from "@/stores/cluster-store";

export function SecurityCenterView({
  context,
  onNavigateResource,
}: {
  context: ContextRow;
  onNavigateResource?: (target: ResourceNavigationTarget) => void;
}) {
  const [severityFilter, setSeverityFilter] = useState<
    "all" | "critical" | "high" | "medium" | "low"
  >("all");
  const [searchFilter, setSearchFilter] = useState("");

  const ready = context.state === "ready" || context.state === "degraded";
  const auditQuery = useQuery({
    queryKey: ["cluster-security-audit", context.id],
    queryFn: () => ipc.getClusterSecurityAudit(context.id),
    enabled: ready,
    refetchInterval: 30000,
    retry: false,
  });

  const audit =
    auditQuery.data &&
    typeof auditQuery.data === "object" &&
    Array.isArray(auditQuery.data.findings)
      ? auditQuery.data
      : null;

  const filteredFindings = useMemo(() => {
    const list = audit?.findings ?? [];
    const needle = searchFilter.trim().toLowerCase();
    return list.filter((f) => {
      if (severityFilter !== "all" && f.severity !== severityFilter) return false;
      if (!needle) return true;
      return (
        f.podName.toLowerCase().includes(needle) ||
        f.namespace.toLowerCase().includes(needle) ||
        f.checkName.toLowerCase().includes(needle) ||
        f.category.toLowerCase().includes(needle) ||
        (f.containerName ?? "").toLowerCase().includes(needle)
      );
    });
  }, [audit?.findings, severityFilter, searchFilter]);

  const checks = [
    {
      name: "Cluster Mutation Guard",
      scope: "Rust IPC Boundary",
      status: "Enforced",
      tone: "ok" as const,
      detail: "All create, patch, apply, and delete commands are structurally blocked.",
    },
    {
      name: "Secret Payload Masking",
      scope: "v1/Secret manifests",
      status: "Active",
      tone: "ok" as const,
      detail: "Secret data/stringData keys are replaced with <masked by kubix> before crossing IPC.",
    },
    {
      name: "Lazy Auth Isolation",
      scope: context.authKind,
      status: "Verified",
      tone: "ok" as const,
      detail: "Credentials never leave kubeconfig or exec plugin subprocesses.",
    },
  ];

  return (
    <div data-testid="security-view" className="h-full overflow-y-auto p-3 space-y-3">
      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <MetricsCard
          label="Scanned Workloads"
          value={audit ? audit.scannedPods : "—"}
          sublabel={
            audit ? `${audit.scannedContainers} containers audited` : "Scanning cluster pods…"
          }
          icon={<ShieldCheck size={14} />}
          tone="primary"
        />
        <MetricsCard
          label="Critical / High"
          value={audit ? `${audit.criticalCount} / ${audit.highCount}` : "—"}
          sublabel="Privileged, root, host namespaces"
          icon={<ShieldAlert size={14} />}
          tone={
            audit && (audit.criticalCount > 0 || audit.highCount > 0) ? "warning" : "success"
          }
        />
        <MetricsCard
          label="Medium / Low"
          value={audit ? `${audit.mediumCount} / ${audit.lowCount}` : "—"}
          sublabel="Limits, :latest, default SA"
          icon={<EyeOff size={14} />}
          tone="primary"
        />
        <MetricsCard
          label="Write Operations"
          value="0"
          sublabel="Read-only guard + Secret masking"
          icon={<Lock size={14} />}
          tone="success"
        />
      </div>

      <SectionCard
        title="Live Cluster Security Audit"
        subtitle={
          audit
            ? `${filteredFindings.length} of ${audit.findings.length} findings across ${audit.scannedPods} pods`
            : context.name
        }
        icon={<ShieldAlert size={13} />}
        bodyClassName="p-0"
        actions={
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-[10.5px]"
            disabled={auditQuery.isFetching}
            onClick={() => void auditQuery.refetch()}
          >
            <RefreshCw
              size={11}
              className={auditQuery.isFetching ? "animate-spin text-primary" : ""}
              aria-hidden="true"
            />
            Rescan
          </Button>
        }
      >
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-elevated/40 px-3 py-2">
          <div className="flex flex-wrap items-center gap-1 text-[10.5px]">
            {(
              [
                { id: "all", label: `All (${audit?.findings.length ?? 0})` },
                { id: "critical", label: `Critical (${audit?.criticalCount ?? 0})` },
                { id: "high", label: `High (${audit?.highCount ?? 0})` },
                { id: "medium", label: `Medium (${audit?.mediumCount ?? 0})` },
                { id: "low", label: `Low (${audit?.lowCount ?? 0})` },
              ] as const
            ).map((opt) => (
              <button
                key={opt.id}
                type="button"
                data-testid={`security-filter-${opt.id}`}
                onClick={() => setSeverityFilter(opt.id)}
                className={`rounded border px-2 py-0.5 font-mono transition-colors ${
                  severityFilter === opt.id
                    ? "border-primary bg-primary/15 font-semibold text-primary"
                    : "border-border bg-background text-muted-foreground hover:text-foreground"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <input
            type="text"
            value={searchFilter}
            onChange={(e) => setSearchFilter(e.target.value)}
            placeholder="Filter pod, namespace, check…"
            aria-label="Filter security findings"
            className="h-6 w-52 rounded border border-border bg-background px-2 font-mono text-[11px] text-foreground placeholder:text-muted-foreground focus:border-primary/70 focus:outline-none"
          />
        </div>

        {auditQuery.isLoading ? (
          <div className="flex items-center gap-2 p-4 text-xs text-muted-foreground">
            <RefreshCw className="h-3.5 w-3.5 animate-spin text-primary" aria-hidden />
            Auditing pod security contexts across cluster…
          </div>
        ) : auditQuery.error ? (
          <div className="p-4 text-xs text-destructive">
            {String((auditQuery.error as Error).message)}
          </div>
        ) : filteredFindings.length === 0 ? (
          <div className="p-6 text-center text-xs text-muted-foreground" data-testid="security-audit-empty">
            {audit && audit.findings.length === 0
              ? `No security posture issues detected across ${audit.scannedPods} pods.`
              : "No security findings match the active filter."}
          </div>
        ) : (
          <div className="max-h-[26rem] divide-y divide-border overflow-y-auto" data-testid="security-audit-list">
            {filteredFindings.map((finding) => {
              const tone =
                finding.severity === "critical"
                  ? "error"
                  : finding.severity === "high"
                    ? "warn"
                    : finding.severity === "medium"
                      ? "info"
                      : "neutral";
              return (
                <div
                  key={finding.id}
                  className="flex flex-wrap items-start justify-between gap-3 px-3 py-2 text-[11.5px] hover:bg-hover/40"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <ResourceStatusChip label={finding.severity.toUpperCase()} tone={tone} />
                      <span className="font-semibold text-foreground">{finding.checkName}</span>
                      <span className="rounded border border-border bg-elevated px-1.5 py-0.2 font-mono text-[10px] text-muted-foreground">
                        {finding.category}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">{finding.message}</p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-0.5">
                    {onNavigateResource ? (
                      <button
                        type="button"
                        data-testid={`security-finding-link-${finding.id}`}
                        onClick={() =>
                          onNavigateResource({
                            kind: "Pod",
                            gvr: "/v1/pods",
                            name: finding.podName,
                            namespace: finding.namespace,
                          })
                        }
                        className="inline-flex items-center gap-1 font-mono text-[11px] text-primary underline-offset-2 hover:underline"
                      >
                        {finding.namespace}/{finding.podName}
                        <ArrowUpRight size={10} aria-hidden="true" />
                      </button>
                    ) : (
                      <span className="font-mono text-[11px] text-foreground">
                        {finding.namespace}/{finding.podName}
                      </span>
                    )}
                    {finding.containerName ? (
                      <span className="font-mono text-[10px] text-muted-foreground">
                        container: {finding.containerName}
                      </span>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="Kubix Client Safety Controls"
        subtitle={context.name}
        icon={<Lock size={13} />}
        bodyClassName="p-0"
      >
        <div className="divide-y divide-border">
          {checks.map((item) => (
            <div key={item.name} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2 hover:bg-hover/50">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-foreground">{item.name}</span>
                  <span className="rounded border border-border bg-elevated px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                    {item.scope}
                  </span>
                </div>
                <p className="mt-0.5 text-[11px] text-muted-foreground">{item.detail}</p>
              </div>
              <ResourceStatusChip label={item.status} tone={item.tone} />
            </div>
          ))}
        </div>
      </SectionCard>
    </div>
  );
}
