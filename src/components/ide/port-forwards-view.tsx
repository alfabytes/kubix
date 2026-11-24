import { useEffect, useMemo, useState } from "react";
import { Copy, Lock, Network, Server, Square } from "lucide-react";

import { ResourceStatusChip } from "@/components/clusters/status-badge";
import { MetricsCard } from "@/components/ide/metrics-card";
import { SectionCard } from "@/components/ide/section-card";
import { Button } from "@/components/ui/button";
import type { ContextRow } from "@/stores/cluster-store";
import { usePortForwardStore } from "@/stores/port-forward-store";

export function PortForwardsView({ context }: { context: ContextRow }) {
  const allForwards = usePortForwardStore((s) => s.forwards);
  const stopForward = usePortForwardStore((s) => s.stopForward);
  const refreshForwards = usePortForwardStore((s) => s.refreshForwards);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    void refreshForwards(context.id);
  }, [context.id, refreshForwards]);

  const forwards = useMemo(
    () => allForwards.filter((f) => f.contextId === context.id),
    [allForwards, context.id],
  );

  return (
    <div data-testid="port-forwards-view" className="h-full overflow-y-auto p-3 space-y-3">
      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-3">
        <MetricsCard
          label="Active Tunnels"
          value={forwards.length}
          sublabel="Localhost TCP port-forwards"
          icon={<Network size={14} />}
          tone={forwards.length > 0 ? "success" : "neutral"}
        />
        <MetricsCard
          label="Bind Interface"
          value="127.0.0.1"
          sublabel="Loopback-only listener"
          icon={<Lock size={14} />}
          tone="primary"
        />
        <MetricsCard
          label="Cluster Context"
          value={context.name}
          sublabel={context.server || context.clusterName}
          icon={<Server size={14} />}
          tone="neutral"
        />
      </div>

      <SectionCard
        title="Active Port Forwards"
        subtitle="Manage local TCP tunnels forwarded to Pod, Workload, and Service ports"
        icon={<Network size={13} />}
        bodyClassName="p-0"
      >
        {forwards.length === 0 ? (
          <div className="p-8 text-center text-xs text-muted-foreground">
            No active port-forwards in <strong className="text-foreground">{context.name}</strong>.
            Open any <strong className="text-foreground">Pod</strong>,{" "}
            <strong className="text-foreground">Deployment</strong>, or{" "}
            <strong className="text-foreground">Service</strong> with exposed ports and click{" "}
            <code className="font-mono text-[10.5px] text-primary">Forward</code>.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-[11.5px]">
              <thead>
                <tr className="border-b border-border bg-elevated/80 ide-table-header">
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Resource</th>
                  <th className="px-3 py-2">Target Pod</th>
                  <th className="px-3 py-2">Namespace</th>
                  <th className="px-3 py-2">Remote Port</th>
                  <th className="px-3 py-2">Local Endpoint</th>
                  <th className="px-3 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/70">
                {forwards.map((fwd) => (
                  <tr
                    key={fwd.forwardId}
                    data-testid={`port-forward-row-${fwd.forwardId}`}
                    className="hover:bg-hover/60"
                  >
                    <td className="px-3 py-2">
                      <ResourceStatusChip label="Forwarding" tone="ok" />
                    </td>
                    <td className="px-3 py-2 font-mono font-medium text-foreground">
                      <span className="text-muted-foreground">{fwd.kind}/</span>
                      {fwd.name}
                    </td>
                    <td className="px-3 py-2 font-mono text-muted-foreground">{fwd.targetPod}</td>
                    <td className="px-3 py-2 font-mono text-muted-foreground">{fwd.namespace}</td>
                    <td className="px-3 py-2 font-mono tabular-nums">:{fwd.remotePort}</td>
                    <td className="px-3 py-2 font-mono font-semibold text-primary tabular-nums">
                      {fwd.localUrl}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-end gap-1.5">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 px-2 text-[10.5px]"
                          onClick={() => {
                            void navigator.clipboard?.writeText(fwd.localUrl);
                            setCopiedId(fwd.forwardId);
                            setTimeout(() => setCopiedId(null), 1500);
                          }}
                        >
                          <Copy size={10} />
                          {copiedId === fwd.forwardId ? "Copied" : "Copy URL"}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 border-destructive/40 px-2 text-[10.5px] text-destructive hover:bg-destructive/10"
                          data-testid={`stop-forward-id-${fwd.forwardId}`}
                          onClick={() => void stopForward(fwd.forwardId)}
                        >
                          <Square size={10} />
                          Stop
                        </Button>
                      </div>
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
