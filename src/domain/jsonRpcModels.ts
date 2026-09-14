import { z } from "zod";

import { invalidRequest } from "./errors";

/**
 * Universal JSON-RPC 2.0 request representation for batch and single calls.
 */
export interface JsonRpcRequest<TParams = readonly unknown[]> {
  /** Optional custom identifier. If omitted, sequential identifiers are auto-assigned. */
  readonly id?: string | number;
  /** JSON-RPC method name, e.g. "eth_call", "eth_getBlockByNumber", "eth_getBalance". */
  readonly method: string;
  /** Method parameters array or object. Defaults to empty array if omitted. */
  readonly params?: TParams;
}

export interface JsonRpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

/**
 * Individual result of a JSON-RPC batch call.
 * Uses a discriminated union on `success` for type-safe handling of partial failures.
 */
export type JsonRpcBatchItemResult<TResult = unknown> =
  | {
      readonly id: string | number;
      readonly success: true;
      readonly result: TResult;
      readonly error?: never;
    }
  | {
      readonly id: string | number;
      readonly success: false;
      readonly error: JsonRpcError;
      readonly result?: never;
    };

export type BlockTagOrNumber = string | number | bigint;

export interface EstimateGasRequest {
  readonly to?: string | undefined;
  readonly from?: string | undefined;
  readonly data?: string | undefined;
  readonly value?: string | number | bigint | undefined;
  readonly gasPrice?: string | number | bigint | undefined;
}

export interface EthCallRequest {
  readonly to: string;
  readonly data?: string | undefined;
  readonly from?: string | undefined;
  readonly value?: string | number | bigint | undefined;
}

export interface FeeHistoryResult {
  readonly oldestBlock: bigint;
  readonly baseFeePerGas: readonly bigint[];
  readonly gasUsedRatio: readonly number[];
  readonly reward?: readonly (readonly bigint[])[] | undefined;
}

export interface TransactionWithReceipt {
  readonly transaction: Record<string, unknown> | null;
  readonly receipt: Record<string, unknown> | null;
}

export interface JsonRpcBatchExecutionOptions {
  /** Maximum number of calls in a single JSON-RPC HTTP batch payload. Defaults to 100. */
  readonly batchChunkSize?: number;
  /** Maximum number of concurrent chunk HTTP requests across the RPC pool. Defaults to 3. */
  readonly maxConcurrency?: number;
  /** Request-specific cache TTL in milliseconds. Pass 0 to force bypass cache. */
  readonly cacheTtlMs?: number;
  readonly signal?: AbortSignal;
}

export interface NormalizedJsonRpcRequest {
  readonly id: string | number;
  readonly method: string;
  readonly params: readonly unknown[];
}

export interface NormalizedJsonRpcBatchRequest {
  readonly requests: readonly NormalizedJsonRpcRequest[];
  readonly batchChunkSize: number;
  readonly maxConcurrency: number;
  readonly cacheTtlMs?: number;
  readonly signal?: AbortSignal;
}

const jsonRpcIdSchema = z.union([z.string().min(1).max(256), z.number().int()]);
const jsonRpcMethodSchema = z.string().trim().min(1).max(256);

const DEFAULT_BATCH_CHUNK_SIZE = 100;
const DEFAULT_MAX_CONCURRENCY = 3;

/**
 * Validates and normalizes JSON-RPC batch requests, assigning deterministic
 * unique identifiers when not explicitly provided by the caller.
 */
export function parseJsonRpcRequests(
  requests: readonly JsonRpcRequest[],
  options?: JsonRpcBatchExecutionOptions,
): NormalizedJsonRpcBatchRequest {
  if (!Array.isArray(requests)) {
    throw invalidRequest("JSON-RPC batch requests must be an array.");
  }

  const normalizedRequests: NormalizedJsonRpcRequest[] = [];
  for (let index = 0; index < requests.length; index += 1) {
    const req = requests[index];
    if (typeof req !== "object" || req === null) {
      throw invalidRequest(`JSON-RPC request at index ${index} must be an object.`);
    }

    const methodParsed = jsonRpcMethodSchema.safeParse(req.method);
    if (!methodParsed.success) {
      throw invalidRequest(`JSON-RPC request at index ${index} has an invalid method.`);
    }

    let id: string | number;
    if (req.id !== undefined) {
      const idParsed = jsonRpcIdSchema.safeParse(req.id);
      if (!idParsed.success) {
        throw invalidRequest(`JSON-RPC request at index ${index} has an invalid id.`);
      }
      id = idParsed.data;
    } else {
      id = index + 1;
    }

    const params = Array.isArray(req.params)
      ? req.params
      : req.params === undefined
        ? []
        : [req.params];

    normalizedRequests.push(
      Object.freeze({
        id,
        method: methodParsed.data,
        params: Object.freeze(params),
      }),
    );
  }

  const batchChunkSize = Math.max(1, options?.batchChunkSize ?? DEFAULT_BATCH_CHUNK_SIZE);
  const maxConcurrency = Math.max(1, options?.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY);

  return {
    requests: Object.freeze(normalizedRequests),
    batchChunkSize,
    maxConcurrency,
    ...(options?.cacheTtlMs === undefined ? {} : { cacheTtlMs: options.cacheTtlMs }),
    ...(options?.signal === undefined ? {} : { signal: options.signal }),
  };
}
