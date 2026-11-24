import { useState } from "react";

import { defaultLocalPort, usePortForwardStore } from "@/stores/port-forward-store";

export function PortForwardControl({
  contextId,
  namespace,
  kind,
  name,
  remotePort,
}: {
  contextId: string;
  namespace: string;
  kind: string;
  name: string;
  remotePort: number;
}) {
  const forwards = usePortForwardStore((s) => s.forwards);
  const startForward = usePortForwardStore((s) => s.startForward);
  const stopForward = usePortForwardStore((s) => s.stopForward);

  const [promptOpen, setPromptOpen] = useState(false);
  const [localPortText, setLocalPortText] = useState(() => String(defaultLocalPort(remotePort)));
  const [busy, setBusy] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const active = forwards.find(
    (f) =>
      f.contextId === contextId &&
      f.namespace === (namespace || "default") &&
      f.kind.toLowerCase() === kind.toLowerCase() &&
      f.name === name &&
      f.remotePort === remotePort,
  );

  if (active) {
    return (
      <span className="inline-flex items-center gap-1">
        <span
          data-testid={`active-forward-${remotePort}`}
          className="inline-flex items-center gap-1 rounded border border-success/40 bg-success/15 px-1.5 py-0.2 font-mono text-[9.5px] font-semibold text-success"
          title={active.localUrl}
        >
          127.0.0.1:{active.localPort}
        </span>
        <button
          type="button"
          data-testid={`stop-forward-${remotePort}`}
          onClick={() => void stopForward(active.forwardId)}
          className="rounded border border-destructive/40 bg-destructive/10 px-1.5 py-0.2 font-mono text-[9.5px] text-destructive hover:bg-destructive/20"
        >
          Stop
        </button>
      </span>
    );
  }

  if (promptOpen) {
    return (
      <span className="inline-flex items-center gap-1">
        <input
          type="number"
          min={0}
          max={65535}
          aria-label={`Local port for ${remotePort}`}
          data-testid={`forward-local-input-${remotePort}`}
          value={localPortText}
          onChange={(e) => setLocalPortText(e.target.value)}
          className="h-5 w-16 rounded border border-border-strong bg-background px-1 font-mono text-[10px] text-foreground"
        />
        <button
          type="button"
          disabled={busy}
          data-testid={`confirm-forward-${remotePort}`}
          onClick={async () => {
            setBusy(true);
            setErrMsg(null);
            const parsedPort = Number.parseInt(localPortText, 10);
            const localPort =
              Number.isFinite(parsedPort) && parsedPort >= 0 && parsedPort <= 65535
                ? parsedPort
                : 0;
            try {
              await startForward({
                contextId,
                namespace: namespace || "default",
                kind,
                name,
                remotePort,
                localPort,
              });
              setPromptOpen(false);
            } catch (err) {
              setErrMsg(err instanceof Error ? err.message : String(err));
            } finally {
              setBusy(false);
            }
          }}
          className="rounded border border-primary/50 bg-primary/15 px-1.5 py-0.2 font-mono text-[9.5px] font-semibold text-primary hover:bg-primary/25"
        >
          {busy ? "…" : "Start"}
        </button>
        <button
          type="button"
          aria-label="Cancel port forward"
          onClick={() => {
            setPromptOpen(false);
            setErrMsg(null);
          }}
          className="rounded px-1 text-muted-foreground hover:text-foreground"
        >
          ×
        </button>
        {errMsg ? (
          <span className="font-mono text-[9.5px] text-destructive" title={errMsg}>
            {errMsg}
          </span>
        ) : null}
      </span>
    );
  }

  return (
    <button
      type="button"
      data-testid={`open-forward-${remotePort}`}
      onClick={() => {
        setLocalPortText(String(defaultLocalPort(remotePort)));
        setErrMsg(null);
        setPromptOpen(true);
      }}
      className="rounded border border-primary/40 bg-primary/10 px-1.5 py-0.2 font-mono text-[9.5px] font-semibold text-primary hover:bg-primary/20"
    >
      Forward
    </button>
  );
}
