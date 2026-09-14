export type EvmCallErrorCode =
  | "ARCHIVE_RPC_UNAVAILABLE"
  | "ARCHIVE_RPC_WRONG_CHAIN"
  | "ARCHIVE_STATE_UNAVAILABLE"
  | "RPC_BLOCK_NOT_FOUND"
  | "RPC_BLOCK_REORG_DETECTED"
  | "RPC_RESPONSE_INVALID"
  | "INVALID_REQUEST"
  | "INVALID_CONFIGURATION"
  | "UNSUPPORTED_CHAIN"
  | "MULTICALL_NOT_DEPLOYED_AT_BLOCK"
  | "MULTICALL_RESPONSE_INVALID"
  | "STORAGE_BUSY"
  | "STORAGE_ERROR"
  | "REQUEST_TIMEOUT"
  | "REQUEST_ABORTED";

export interface EvmCallErrorOptions {
  readonly code: EvmCallErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly chainId?: number | null;
  readonly rpcEndpointId?: string | null;
  readonly retryAfterMs?: number | null;
  readonly cause?: unknown;
}

export class EvmCallError extends Error {
  readonly code: EvmCallErrorCode;
  readonly retryable: boolean;
  readonly chainId: number | null;
  readonly rpcEndpointId: string | null;
  readonly retryAfterMs: number | null;
  override readonly cause: unknown;

  constructor(options: EvmCallErrorOptions) {
    const safeCause = sanitizeCause(options.cause);
    if (safeCause !== undefined) {
      super(options.message, { cause: safeCause });
    } else {
      super(options.message);
    }

    this.name = "EvmCallError";
    this.code = options.code;
    this.retryable = options.retryable;
    this.chainId = options.chainId ?? null;
    this.rpcEndpointId = options.rpcEndpointId ?? null;
    this.retryAfterMs = options.retryAfterMs ?? null;

    if (safeCause !== undefined) {
      Object.defineProperty(this, "cause", {
        configurable: true,
        enumerable: false,
        value: safeCause,
        writable: false,
      });
    }
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function sanitizeCause(value: unknown): unknown {
  if (value === undefined) {
    return undefined;
  }
  if (value instanceof Error) {
    const result: Record<string, string | number> = { name: value.name };
    const candidate = value as Error & { code?: unknown; status?: unknown };
    if (typeof candidate.code === "string" || typeof candidate.code === "number") {
      result.code = candidate.code;
    }
    if (typeof candidate.status === "number") {
      result.status = candidate.status;
    }
    return Object.freeze(result);
  }
  if (value === null) {
    return Object.freeze({ type: "null" });
  }
  return Object.freeze({ type: typeof value });
}

export function isEvmCallError(value: unknown): value is EvmCallError {
  return value instanceof EvmCallError;
}

export function invalidConfiguration(message: string, cause?: unknown): EvmCallError {
  return new EvmCallError({
    code: "INVALID_CONFIGURATION",
    message,
    retryable: false,
    ...(cause === undefined ? {} : { cause }),
  });
}

export function invalidRequest(message: string, cause?: unknown): EvmCallError {
  return new EvmCallError({
    code: "INVALID_REQUEST",
    message,
    retryable: false,
    ...(cause === undefined ? {} : { cause }),
  });
}

export function unsupportedChain(message: string, chainId?: number | null): EvmCallError {
  return new EvmCallError({
    code: "UNSUPPORTED_CHAIN",
    message,
    retryable: false,
    chainId: chainId ?? null,
  });
}

export function archiveRpcUnavailable(
  message: string,
  options?: { cause?: unknown; chainId?: number | null; rpcEndpointId?: string | null; retryAfterMs?: number | null },
): EvmCallError {
  return new EvmCallError({
    code: "ARCHIVE_RPC_UNAVAILABLE",
    message,
    retryable: true,
    chainId: options?.chainId ?? null,
    rpcEndpointId: options?.rpcEndpointId ?? null,
    retryAfterMs: options?.retryAfterMs ?? null,
    ...(options?.cause === undefined ? {} : { cause: options.cause }),
  });
}

export function archiveRpcWrongChain(
  message: string,
  options?: { cause?: unknown; chainId?: number | null; rpcEndpointId?: string | null },
): EvmCallError {
  return new EvmCallError({
    code: "ARCHIVE_RPC_WRONG_CHAIN",
    message,
    retryable: false,
    chainId: options?.chainId ?? null,
    rpcEndpointId: options?.rpcEndpointId ?? null,
    ...(options?.cause === undefined ? {} : { cause: options.cause }),
  });
}

export function archiveStateUnavailable(
  message: string,
  options?: { cause?: unknown; chainId?: number | null; rpcEndpointId?: string | null },
): EvmCallError {
  return new EvmCallError({
    code: "ARCHIVE_STATE_UNAVAILABLE",
    message,
    retryable: true,
    chainId: options?.chainId ?? null,
    rpcEndpointId: options?.rpcEndpointId ?? null,
    ...(options?.cause === undefined ? {} : { cause: options.cause }),
  });
}

export function rpcBlockNotFound(
  message: string,
  options?: { cause?: unknown; chainId?: number | null; rpcEndpointId?: string | null },
): EvmCallError {
  return new EvmCallError({
    code: "RPC_BLOCK_NOT_FOUND",
    message,
    retryable: true,
    chainId: options?.chainId ?? null,
    rpcEndpointId: options?.rpcEndpointId ?? null,
    ...(options?.cause === undefined ? {} : { cause: options.cause }),
  });
}

export function rpcBlockReorgDetected(
  message: string,
  options?: { chainId?: number | null; rpcEndpointId?: string | null },
): EvmCallError {
  return new EvmCallError({
    code: "RPC_BLOCK_REORG_DETECTED",
    message,
    retryable: true,
    chainId: options?.chainId ?? null,
    rpcEndpointId: options?.rpcEndpointId ?? null,
  });
}

export function rpcResponseInvalid(
  message: string,
  options?: { cause?: unknown; chainId?: number | null; rpcEndpointId?: string | null },
): EvmCallError {
  return new EvmCallError({
    code: "RPC_RESPONSE_INVALID",
    message,
    retryable: false,
    chainId: options?.chainId ?? null,
    rpcEndpointId: options?.rpcEndpointId ?? null,
    ...(options?.cause === undefined ? {} : { cause: options.cause }),
  });
}

export function multicallNotDeployedAtBlock(message: string, chainId?: number | null): EvmCallError {
  return new EvmCallError({
    code: "MULTICALL_NOT_DEPLOYED_AT_BLOCK",
    message,
    retryable: false,
    chainId: chainId ?? null,
  });
}

export function multicallResponseInvalid(message: string, cause?: unknown): EvmCallError {
  return new EvmCallError({
    code: "MULTICALL_RESPONSE_INVALID",
    message,
    retryable: false,
    ...(cause === undefined ? {} : { cause }),
  });
}

export function storageBusy(message: string, cause?: unknown): EvmCallError {
  return new EvmCallError({
    code: "STORAGE_BUSY",
    message,
    retryable: true,
    ...(cause === undefined ? {} : { cause }),
  });
}

export function storageError(message: string, cause?: unknown): EvmCallError {
  return new EvmCallError({
    code: "STORAGE_ERROR",
    message,
    retryable: false,
    ...(cause === undefined ? {} : { cause }),
  });
}

export function requestTimeout(
  message: string,
  options?: { chainId?: number | null; rpcEndpointId?: string | null },
): EvmCallError {
  return new EvmCallError({
    code: "REQUEST_TIMEOUT",
    message,
    retryable: true,
    chainId: options?.chainId ?? null,
    rpcEndpointId: options?.rpcEndpointId ?? null,
  });
}

export function requestAborted(message: string, cause?: unknown): EvmCallError {
  return new EvmCallError({
    code: "REQUEST_ABORTED",
    message,
    retryable: false,
    ...(cause === undefined ? {} : { cause }),
  });
}
