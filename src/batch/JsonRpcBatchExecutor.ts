import {
  archiveRpcUnavailable,
  isEvmCallError,
  rpcResponseInvalid,
} from "../domain/errors";
import type { RandomSource } from "../execution/clock";
import { systemRandom } from "../execution/clock";
import {
  parseJsonRpcRequests,
  type JsonRpcBatchExecutionOptions,
  type JsonRpcBatchItemResult,
  type JsonRpcRequest,
  type NormalizedJsonRpcRequest,
} from "../domain/jsonRpcModels";
import {
  ArchiveRpcTransport,
  isJsonRpcCallError,
  type JsonRpcBatchResponseItem,
} from "../transport/ArchiveRpcTransport";
import type { RpcCacheService, RpcCacheBatchEntry } from "../storage/RpcCacheService";

export interface RpcEndpointLike {
  readonly id: string;
  readonly url: string;
}

export interface RpcPoolLike {
  readonly chainId?: number;
  healthySnapshot(randomSource: RandomSource): readonly RpcEndpointLike[];
  reportOutcome(id: string, outcome: "success" | "failure"): void;
  refreshIfNeeded?(signal?: AbortSignal): Promise<void>;
}

export interface JsonRpcBatchExecutorOptions {
  readonly pool: RpcPoolLike;
  readonly chainId?: number | undefined;
  readonly cacheService?: RpcCacheService | undefined;
  readonly randomSource?: RandomSource | undefined;
  readonly transport?: ArchiveRpcTransport | undefined;
  readonly attemptTimeoutMs?: number | undefined;
  readonly totalTimeoutMs?: number | undefined;
  readonly maxRpcAttempts?: number | undefined;
  readonly defaultBatchChunkSize?: number | undefined;
  readonly defaultMaxConcurrency?: number | undefined;
  readonly now?: (() => number) | undefined;
}

const DEFAULT_ATTEMPT_TIMEOUT_MS = 10_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RPC_ATTEMPTS = 5;
const DEFAULT_BATCH_CHUNK_SIZE = 100;
const DEFAULT_MAX_CONCURRENCY = 3;

/**
 * High-performance, fault-tolerant JSON-RPC batch executor with SQLite cache integration.
 */
export class JsonRpcBatchExecutor {
  private readonly pool: RpcPoolLike;
  readonly chainId: number;
  private readonly cacheService?: RpcCacheService | undefined;
  private readonly randomSource: RandomSource;
  private readonly transport: ArchiveRpcTransport;
  private readonly attemptTimeoutMs: number;
  private readonly totalTimeoutMs: number;
  private readonly maxRpcAttempts: number;
  private readonly defaultBatchChunkSize: number;
  private readonly defaultMaxConcurrency: number;
  private readonly now: () => number;

  constructor(options: JsonRpcBatchExecutorOptions) {
    this.pool = options.pool;
    this.chainId = options.chainId ?? options.pool.chainId ?? 1;
    this.cacheService = options.cacheService;
    this.randomSource = options.randomSource ?? systemRandom;
    this.transport = options.transport ?? new ArchiveRpcTransport();
    this.attemptTimeoutMs = options.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
    this.totalTimeoutMs = options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
    this.maxRpcAttempts = Math.max(1, options.maxRpcAttempts ?? DEFAULT_MAX_RPC_ATTEMPTS);
    this.defaultBatchChunkSize = Math.max(1, options.defaultBatchChunkSize ?? DEFAULT_BATCH_CHUNK_SIZE);
    this.defaultMaxConcurrency = Math.max(1, options.defaultMaxConcurrency ?? DEFAULT_MAX_CONCURRENCY);
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Executes a batch of arbitrary JSON-RPC requests across the RPC pool.
   * Cached entries are retrieved directly without network traffic.
   * Uncached entries are automatically chunked and executed with bounded concurrency.
   */
  async executeBatch<TResult = unknown>(
    requests: readonly JsonRpcRequest[],
    options?: JsonRpcBatchExecutionOptions,
  ): Promise<readonly JsonRpcBatchItemResult<TResult>[]> {
    const normalized = parseJsonRpcRequests(requests, {
      batchChunkSize: options?.batchChunkSize ?? this.defaultBatchChunkSize,
      maxConcurrency: options?.maxConcurrency ?? this.defaultMaxConcurrency,
      ...(options?.cacheTtlMs !== undefined ? { cacheTtlMs: options.cacheTtlMs } : {}),
      ...(options?.signal !== undefined ? { signal: options.signal } : {}),
    });

    if (normalized.requests.length === 0) {
      return Object.freeze([]);
    }

    const totalCount = normalized.requests.length;
    const finalResults: (JsonRpcBatchItemResult<TResult> | undefined)[] = new Array(totalCount);
    const missing: { request: NormalizedJsonRpcRequest; originalIndex: number }[] = [];

    // 1. Cache lookup
    const shouldCheckCache = this.cacheService !== undefined && options?.cacheTtlMs !== 0;
    for (let index = 0; index < totalCount; index += 1) {
      const req = normalized.requests[index]!;
      if (shouldCheckCache) {
        const cached = this.cacheService!.get<TResult>(this.chainId, req.method, req.params, {
          now: this.now(),
        });
        if (cached !== null) {
          finalResults[index] = Object.freeze({
            id: req.id,
            success: true as const,
            result: cached,
          });
          continue;
        }
      }
      missing.push({ request: req, originalIndex: index });
    }

    // If everything hit cache, return immediately
    if (missing.length === 0) {
      return Object.freeze(finalResults as JsonRpcBatchItemResult<TResult>[]);
    }

    // 2. Network execution for uncached requests
    const deadline = this.now() + this.totalTimeoutMs;
    const chunks = chunk(missing, normalized.batchChunkSize);

    await runBounded(chunks, normalized.maxConcurrency, async (chunkSlice) => {
      const rawRequests = chunkSlice.map((m) => m.request);
      const chunkResponse = await this.executeChunkWithFailover(
        rawRequests,
        normalized.signal,
        deadline,
      );

      const cacheEntries: RpcCacheBatchEntry[] = [];
      for (let i = 0; i < chunkSlice.length; i += 1) {
        const itemResp = chunkResponse[i];
        const { request: origReq, originalIndex } = chunkSlice[i]!;

        if (itemResp !== undefined && itemResp.success) {
          if (this.cacheService !== undefined && options?.cacheTtlMs !== 0) {
            cacheEntries.push({
              chainId: this.chainId,
              method: origReq.method,
              params: origReq.params,
              result: itemResp.result,
              ...(options?.cacheTtlMs !== undefined ? { cacheTtlMs: options.cacheTtlMs } : {}),
            });
          }

          finalResults[originalIndex] = Object.freeze({
            id: origReq.id,
            success: true as const,
            result: itemResp.result as TResult,
          });
        } else {
          finalResults[originalIndex] = Object.freeze({
            id: origReq.id,
            success: false as const,
            error: Object.freeze({
              code: itemResp?.error?.code ?? -32603,
              message: itemResp?.error?.message ?? "JSON-RPC call failed.",
              ...(itemResp?.error?.data !== undefined ? { data: itemResp.error.data } : {}),
            }),
          });
        }
      }

      if (cacheEntries.length > 0 && this.cacheService !== undefined) {
        this.cacheService.setBatch(cacheEntries, { now: this.now() });
      }
    });

    return Object.freeze(finalResults as JsonRpcBatchItemResult<TResult>[]);
  }

  /**
   * Executes a batch of JSON-RPC requests and directly returns the unwrapped results.
   * Throws on the first failed call.
   */
  async executeStrictBatch<TResult = unknown>(
    requests: readonly JsonRpcRequest[],
    options?: JsonRpcBatchExecutionOptions,
  ): Promise<readonly TResult[]> {
    const results = await this.executeBatch<TResult>(requests, options);
    const firstFailure = results.find((item) => !item.success);
    if (firstFailure !== undefined && !firstFailure.success) {
      throw rpcResponseInvalid(
        `JSON-RPC batch call (id: ${firstFailure.id}) failed: [${firstFailure.error.code}] ${firstFailure.error.message}`,
      );
    }
    return Object.freeze(results.map((item) => (item as { readonly result: TResult }).result));
  }

  /**
   * Single call convenience wrapper.
   */
  async call<TResult = unknown>(
    request: JsonRpcRequest,
    options?: JsonRpcBatchExecutionOptions,
  ): Promise<TResult> {
    const results = await this.executeStrictBatch<TResult>([request], {
      ...options,
      batchChunkSize: 1,
      maxConcurrency: 1,
    });
    return results[0]!;
  }

  private async executeChunkWithFailover(
    requests: readonly NormalizedJsonRpcRequest[],
    signal: AbortSignal | undefined,
    deadline: number,
  ): Promise<readonly JsonRpcBatchResponseItem[]> {
    const snapshot = await this.healthySnapshotWithRefresh(signal);
    if (snapshot.length === 0) {
      throw archiveRpcUnavailable("No healthy RPC endpoint is available in the pool.");
    }

    const endpoints = snapshot.slice(0, this.maxRpcAttempts);
    let lastError: unknown = archiveRpcUnavailable("No RPC attempt was made.");

    for (const endpoint of endpoints) {
      if (isAborted(signal)) {
        throw lastError;
      }
      if (this.now() >= deadline) {
        throw archiveRpcUnavailable("Archive RPC total timeout was exceeded.");
      }

      const remainingMs = Math.max(1, deadline - this.now());
      const timeoutMs = Math.min(this.attemptTimeoutMs, remainingMs);

      try {
        const result = await this.transport.batchCall({
          endpointUrl: endpoint.url,
          requests,
          timeoutMs,
          ...(signal !== undefined ? { signal } : {}),
        });

        if (result.length > 0 && isAllNodeFailures(result)) {
          throw archiveRpcUnavailable(
            `RPC endpoint failed all batch items: ${result[0]?.error?.message ?? "node error"}`,
            { rpcEndpointId: endpoint.id },
          );
        }

        this.pool.reportOutcome(endpoint.id, "success");
        return result;
      } catch (error: unknown) {
        this.pool.reportOutcome(endpoint.id, "failure");
        lastError = error;
        if (isAborted(signal) || !isRetryableFailure(error)) {
          throw error;
        }
      }
    }

    throw lastError;
  }

  private async healthySnapshotWithRefresh(signal?: AbortSignal): Promise<readonly RpcEndpointLike[]> {
    const snapshot = this.pool.healthySnapshot(this.randomSource);
    if (snapshot.length > 0) {
      return snapshot;
    }
    if (this.pool.refreshIfNeeded !== undefined) {
      await this.pool.refreshIfNeeded(signal);
    }
    return this.pool.healthySnapshot(this.randomSource);
  }
}

function isRetryableFailure(error: unknown): boolean {
  if (isJsonRpcCallError(error)) {
    return true;
  }
  if (isEvmCallError(error)) {
    return error.retryable;
  }
  return error instanceof Error && error.name !== "AbortError";
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

function chunk<T>(values: readonly T[], size: number): readonly (readonly T[])[] {
  const result: (readonly T[])[] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

async function runBounded<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let index = 0;
  async function next(): Promise<void> {
    for (;;) {
      const current = index;
      index += 1;
      if (current >= items.length) {
        return;
      }
      await worker(items[current]!, current);
    }
  }
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, () => next());
  await Promise.all(runners);
}

function isAllNodeFailures(results: readonly JsonRpcBatchResponseItem[]): boolean {
  if (results.length === 0) return true;
  return results.every((item) => {
    if (item.success) return false;
    const msg = item.error?.message?.toLowerCase() ?? "";
    // Query parameter limitations and smart contract reverts are NOT node health failures
    if (
      msg.includes("more than") ||
      msg.includes("too large") ||
      msg.includes("execution reverted") ||
      msg.includes("revert")
    ) {
      return false;
    }
    if (
      msg.includes("omitted response") ||
      msg.includes("daily request count") ||
      msg.includes("quota exceeded") ||
      msg.includes("credits exhausted") ||
      msg.includes("rate limit exceeded") ||
      msg.includes("compute units")
    ) {
      return true;
    }
    return false;
  });
}
