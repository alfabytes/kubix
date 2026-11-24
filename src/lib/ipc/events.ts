import type {
  ClusterContextDto,
  CommandArgs,
  CommandName,
  CommandResults,
  KubixErrorDto,
  PodLogLineDto,
  ResourceDeltaDto,
  ShellOutputDto,
  WatchEvictedDto,
} from "./types";

export const CONTEXT_STATE_EVENT = "kubix://context-state";
export const RESOURCE_DELTA_EVENT = "kubix://resource-delta";
export const WATCH_EVICTED_EVENT = "kubix://watch-evicted";
export const SHELL_OUTPUT_EVENT = "kubix://shell-output";
export const POD_LOG_LINE_EVENT = "kubix://pod-log-line";
export const CLOSE_ACTIVE_TAB_EVENT = "kubix://close-active-tab";

export interface EventPayloads {
  [CONTEXT_STATE_EVENT]: ClusterContextDto;
  [RESOURCE_DELTA_EVENT]: ResourceDeltaDto;
  [WATCH_EVICTED_EVENT]: WatchEvictedDto;
  [SHELL_OUTPUT_EVENT]: ShellOutputDto;
  [POD_LOG_LINE_EVENT]: PodLogLineDto;
  [CLOSE_ACTIVE_TAB_EVENT]: null;
}

export type EventName = keyof EventPayloads;

export type UnlistenFn = () => void;

/**
 * Minimal transport surface. The real implementation is Tauri's `invoke`/`listen`;
 * tests inject a fake so components never touch Tauri globals.
 */
export interface IpcTransport {
  invoke<C extends CommandName>(command: C, args: CommandArgs[C]): Promise<CommandResults[C]>;
  listen<E extends EventName>(event: E, handler: (payload: EventPayloads[E]) => void): Promise<UnlistenFn>;
}

/** Normalized failure surface for every IPC call. */
export class KubixIpcError extends Error {
  readonly code: KubixErrorDto["code"];
  readonly retryable: boolean;
  readonly contextId?: string;

  constructor(dto: KubixErrorDto) {
    super(dto.message);
    this.name = "KubixIpcError";
    this.code = dto.code;
    this.retryable = dto.retryable;
    this.contextId = dto.contextId;
  }
}

const ERROR_CODES = new Set<string>([
  "kubeconfigNotFound",
  "kubeconfigParseFailed",
  "unknownContext",
  "authRequired",
  "authFailed",
  "clusterUnreachable",
  "forbidden",
  "discoveryFailed",
  "resourceNotFound",
  "watchEvicted",
  "internal",
]);

function looksLikeDto(value: unknown): value is KubixErrorDto {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.code === "string" &&
    ERROR_CODES.has(candidate.code) &&
    typeof candidate.message === "string" &&
    typeof candidate.retryable === "boolean"
  );
}

/** Tauri rejects with the serialized error DTO; anything else is wrapped as `internal`. */
export function normalizeIpcError(raw: unknown): KubixIpcError {
  if (raw instanceof KubixIpcError) return raw;
  if (looksLikeDto(raw)) return new KubixIpcError(raw);
  if (raw instanceof Error) {
    return new KubixIpcError({
      code: "internal",
      message: raw.message,
      retryable: false,
    });
  }
  if (typeof raw === "object" && raw !== null) {
    // Tauri may wrap the DTO in `{ error: ... }` or `{ payload: ... }`.
    const record = raw as Record<string, unknown>;
    for (const key of ["error", "payload"]) {
      if (looksLikeDto(record[key])) return new KubixIpcError(record[key] as KubixErrorDto);
    }
  }
  if (typeof raw === "string") {
    // Tauri sometimes surfaces the JSON-encoded DTO as a string.
    try {
      const parsed: unknown = JSON.parse(raw);
      if (looksLikeDto(parsed)) return new KubixIpcError(parsed);
      if (typeof parsed === "object" && parsed !== null) {
        const record = parsed as Record<string, unknown>;
        if (looksLikeDto(record.error)) return new KubixIpcError(record.error);
      }
    } catch {
      // fall through to plain message
    }
    return new KubixIpcError({ code: "internal", message: raw, retryable: false });
  }
  return new KubixIpcError({
    code: "internal",
    message: "unexpected IPC failure",
    retryable: false,
  });
}
