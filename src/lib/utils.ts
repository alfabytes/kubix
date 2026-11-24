import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import type { ConnectionState, KubixErrorDto } from "@/lib/ipc/types";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export interface ConnectionLabel {
  label: string;
  tone: "neutral" | "busy" | "ok" | "warn" | "error";
  description: string;
}

/** Single place that maps backend state to human copy. */
export function describeConnectionState(
  state: ConnectionState,
  lastError?: KubixErrorDto,
): ConnectionLabel {
  switch (state) {
    case "disconnected":
      return {
        label: "Disconnected",
        tone: "neutral",
        description: "Not connected. Select this cluster to authenticate.",
      };
    case "connecting":
      return { label: "Connecting", tone: "busy", description: "Authenticating with the cluster…" };
    case "ready":
      return { label: "Connected", tone: "ok", description: "Read-only access is available." };
    case "authRequired":
      return {
        label: "Auth required",
        tone: "warn",
        description: "The credential plugin needs interaction. Re-run the plugin and retry.",
      };
    case "authFailed":
      return {
        label: "Auth failed",
        tone: "error",
        description: lastError?.message ?? "Credentials were rejected by the cluster.",
      };
    case "unreachable":
      return {
        label: "Unreachable",
        tone: "error",
        description: lastError?.message ?? "The API server could not be reached. Retry when it is up.",
      };
    case "forbidden":
      return {
        label: "Forbidden",
        tone: "warn",
        description: lastError?.message ?? "Authenticated, but RBAC denies this request.",
      };
    case "degraded":
      return {
        label: "Degraded",
        tone: "warn",
        description: lastError?.message ?? "Connected with errors. Some data may be unavailable.",
      };
  }
}

export function formatTimestamp(value: string): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function shortGvr(gvr: string): string {
  const parts = gvr.split("/");
  if (parts.length === 2) return parts[1] ?? gvr;
  return parts.slice(1).join("/");
}
