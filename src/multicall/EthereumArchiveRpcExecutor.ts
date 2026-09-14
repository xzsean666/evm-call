import {
  archiveRpcUnavailable,
  isEvmCallError,
  rpcBlockNotFound,
  rpcBlockReorgDetected,
  rpcResponseInvalid,
} from "../domain/errors";
import type { RandomSource } from "../execution/clock";
import { systemRandom } from "../execution/clock";
import {
  ArchiveRpcTransport,
  isJsonRpcCallError,
  type ArchiveRpcCallOptions,
} from "../transport/ArchiveRpcTransport";
import type { RpcEndpointLike, RpcPoolLike } from "../batch/JsonRpcBatchExecutor";

export interface EthereumArchiveRpcExecutorOptions {
  readonly pool: RpcPoolLike;
  readonly randomSource?: RandomSource | undefined;
  readonly transport?: ArchiveRpcTransport | undefined;
  readonly attemptTimeoutMs?: number | undefined;
  readonly totalTimeoutMs?: number | undefined;
  readonly maxRpcAttempts?: number | undefined;
  /** Bounded endpoint race width. Defaults to serial failover (1). */
  readonly maxConcurrentRpcAttempts?: number | undefined;
  readonly now?: (() => number) | undefined;
}

interface BlockHeader {
  readonly hash: string;
  /** Canonical non-negative base-10 Unix timestamp. */
  readonly timestamp: string;
}

const DEFAULT_ATTEMPT_TIMEOUT_MS = 10_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RPC_ATTEMPTS = 5;

export class EthereumArchiveRpcExecutor {
  private readonly pool: RpcPoolLike;
  private readonly randomSource: RandomSource;
  private readonly transport: ArchiveRpcTransport;
  private readonly attemptTimeoutMs: number;
  private readonly totalTimeoutMs: number;
  private readonly maxRpcAttempts: number;
  private readonly maxConcurrentRpcAttempts: number;
  private readonly now: () => number;

  constructor(options: EthereumArchiveRpcExecutorOptions) {
    this.pool = options.pool;
    this.randomSource = options.randomSource ?? systemRandom;
    this.transport = options.transport ?? new ArchiveRpcTransport();
    this.attemptTimeoutMs = options.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
    this.totalTimeoutMs = options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
    this.maxRpcAttempts = Math.max(1, options.maxRpcAttempts ?? DEFAULT_MAX_RPC_ATTEMPTS);
    this.maxConcurrentRpcAttempts = Math.max(
      1,
      Math.min(this.maxRpcAttempts, options.maxConcurrentRpcAttempts ?? 1),
    );
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Binary-searches for the highest block whose timestamp is less than or
   * equal to `targetTimestampSeconds`. Pins search to one healthy endpoint,
   * restarting on the next endpoint on retryable failure.
   */
  async findBlockNumberByTimestamp(
    targetTimestampSeconds: bigint,
    lowerBoundBlock: bigint = 0n,
    signal?: AbortSignal,
  ): Promise<{ readonly blockNumber: string; readonly rpcEndpointId: string }> {
    const deadline = this.now() + this.totalTimeoutMs;
    const snapshot = await this.healthySnapshotWithRefresh(signal);
    if (snapshot.length === 0) {
      throw archiveRpcUnavailable("No healthy RPC endpoint is available in the pool.");
    }

    return this.runEndpointAttempts(snapshot, signal, deadline, async (endpoint, attemptSignal) => {
      const blockNumber = await this.binarySearchOnEndpoint(
        endpoint,
        targetTimestampSeconds,
        lowerBoundBlock,
        attemptSignal,
        deadline,
      );
      return { blockNumber: blockNumber.toString(10), rpcEndpointId: endpoint.id };
    });
  }

  /**
   * Reads the current chain head via `eth_getBlockByNumber` ("latest").
   */
  async findLatestBlockNumber(
    signal?: AbortSignal,
  ): Promise<{ readonly blockNumber: string; readonly rpcEndpointId: string }> {
    const deadline = this.now() + this.totalTimeoutMs;
    const snapshot = await this.healthySnapshotWithRefresh(signal);
    if (snapshot.length === 0) {
      throw archiveRpcUnavailable("No healthy RPC endpoint is available in the pool.");
    }

    return this.runEndpointAttempts(snapshot, signal, deadline, async (endpoint, attemptSignal) => {
      const latest = await this.readBlockHeaderByTag(endpoint, "latest", attemptSignal, deadline);
      return { blockNumber: latest.number.toString(10), rpcEndpointId: endpoint.id };
    });
  }

  /**
   * Executes one or more independent `aggregate3` batches pinned to one endpoint with pre/post block-hash check.
   */
  async executeMulticallBatches(request: {
    readonly blockNumber: string;
    readonly multicall3Address: string;
    readonly batches: readonly string[];
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly blockHash: string;
    readonly blockTimestamp: string;
    readonly rpcEndpointId: string;
    readonly batchReturnData: readonly string[];
  }> {
    const deadline = this.now() + this.totalTimeoutMs;
    const snapshot = await this.healthySnapshotWithRefresh(request.signal);
    if (snapshot.length === 0) {
      throw archiveRpcUnavailable("No healthy RPC endpoint is available in the pool.");
    }

    return this.runEndpointAttempts(snapshot, request.signal, deadline, (endpoint, attemptSignal) =>
      this.executeOnEndpoint(endpoint, { ...request, signal: attemptSignal }, deadline),
    );
  }

  /**
   * Reads an address's native balance at one exact block with pre/post block-hash check.
   */
  async getNativeBalanceAtBlock(request: {
    readonly address: string;
    readonly blockNumber: string;
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly amount: string;
    readonly blockHash: string;
    readonly blockTimestamp: string;
    readonly rpcEndpointId: string;
  }> {
    const deadline = this.now() + this.totalTimeoutMs;
    const snapshot = await this.healthySnapshotWithRefresh(request.signal);
    if (snapshot.length === 0) {
      throw archiveRpcUnavailable("No healthy RPC endpoint is available in the pool.");
    }
    return this.runEndpointAttempts(snapshot, request.signal, deadline, (endpoint, attemptSignal) =>
      this.getNativeBalanceOnEndpoint(endpoint, { ...request, signal: attemptSignal }, deadline),
    );
  }

  private async binarySearchOnEndpoint(
    endpoint: RpcEndpointLike,
    targetTimestampSeconds: bigint,
    lowerBoundBlock: bigint,
    signal: AbortSignal | undefined,
    deadline: number,
  ): Promise<bigint> {
    const latest = await this.readBlockHeaderByTag(endpoint, "latest", signal, deadline);

    if (latest.timestamp <= targetTimestampSeconds) {
      return latest.number;
    }

    let low = lowerBoundBlock;
    let high = latest.number;
    const lowHeader = await this.readBlockHeader(endpoint, toBlockTag(low.toString(10)), signal, deadline);
    let lowTimestamp = BigInt(lowHeader.timestamp);

    if (lowTimestamp > targetTimestampSeconds) {
      // Target predates the lower bound entirely
      return low;
    }

    let highTimestamp = latest.timestamp;

    while (low < high) {
      // Interpolated midpoint estimate with safe binary fallback
      let mid: bigint;
      const timeDiff = highTimestamp - lowTimestamp;
      const blockDiff = high - low;

      if (timeDiff > 0n && targetTimestampSeconds >= lowTimestamp && targetTimestampSeconds <= highTimestamp) {
        const estimatedOffset = ((targetTimestampSeconds - lowTimestamp) * blockDiff) / timeDiff;
        const step = estimatedOffset <= 0n ? 1n : estimatedOffset >= blockDiff ? blockDiff : estimatedOffset;
        mid = low + step;
      } else {
        mid = low + (blockDiff + 1n) / 2n;
      }

      const header = await this.readBlockHeader(endpoint, toBlockTag(mid.toString(10)), signal, deadline);
      const headerTimestamp = BigInt(header.timestamp);

      if (headerTimestamp <= targetTimestampSeconds) {
        low = mid;
        lowTimestamp = headerTimestamp;
      } else {
        high = mid - 1n;
        highTimestamp = headerTimestamp;
      }
    }

    return low;
  }

  private async readBlockHeaderByTag(
    endpoint: RpcEndpointLike,
    blockTag: string,
    signal: AbortSignal | undefined,
    deadline: number,
  ): Promise<{ readonly number: bigint; readonly timestamp: bigint }> {
    const result = await this.call(endpoint, "eth_getBlockByNumber", [blockTag, false], signal, deadline);
    if (result === null) {
      throw rpcBlockNotFound(`RPC endpoint has no block at ${blockTag}.`);
    }
    if (result === undefined || typeof result !== "object") {
      throw rpcResponseInvalid("RPC endpoint returned a malformed block header.");
    }
    const block = result as { number?: unknown; timestamp?: unknown };
    if (typeof block.number !== "string" || !/^0x[0-9a-fA-F]+$/.test(block.number)) {
      throw rpcResponseInvalid("RPC endpoint returned a malformed block number.");
    }
    if (typeof block.timestamp !== "string" || !/^0x[0-9a-fA-F]+$/.test(block.timestamp)) {
      throw rpcResponseInvalid("RPC endpoint returned a malformed block timestamp.");
    }
    return { number: BigInt(block.number), timestamp: BigInt(block.timestamp) };
  }

  private async healthySnapshotWithRefresh(signal?: AbortSignal): Promise<readonly RpcEndpointLike[]> {
    const snapshot = this.pool.healthySnapshot(this.randomSource);
    if (snapshot.length > 0) return snapshot;
    if (this.pool.refreshIfNeeded !== undefined) {
      await this.pool.refreshIfNeeded(signal);
    }
    return this.pool.healthySnapshot(this.randomSource);
  }

  private async runEndpointAttempts<T>(
    snapshot: readonly RpcEndpointLike[],
    signal: AbortSignal | undefined,
    deadline: number,
    operation: (endpoint: RpcEndpointLike, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const endpoints = snapshot.slice(0, this.maxRpcAttempts);
    let lastError: unknown = archiveRpcUnavailable("No RPC attempt was made.");

    if (this.maxConcurrentRpcAttempts === 1) {
      for (const endpoint of endpoints) {
        if (isAborted(signal)) throw lastError;
        if (this.now() >= deadline) {
          throw archiveRpcUnavailable("RPC total timeout was exceeded.");
        }
        try {
          const result = await operation(endpoint, signal ?? new AbortController().signal);
          this.pool.reportOutcome(endpoint.id, "success");
          return result;
        } catch (error: unknown) {
          this.pool.reportOutcome(endpoint.id, "failure");
          lastError = error;
          if (isAborted(signal) || !isRetryableFailure(error)) throw error;
        }
      }
      throw lastError;
    }

    for (let start = 0; start < endpoints.length; start += this.maxConcurrentRpcAttempts) {
      if (isAborted(signal)) throw lastError;
      if (this.now() >= deadline) {
        throw archiveRpcUnavailable("RPC total timeout was exceeded.");
      }

      const wave = endpoints.slice(start, start + this.maxConcurrentRpcAttempts);
      const controllers = wave.map(() => new AbortController());
      const abortWave = () => controllers.forEach((controller) => controller.abort());
      signal?.addEventListener("abort", abortWave, { once: true });
      let won = false;
      const failures: unknown[] = [];
      try {
        const result = await Promise.any(
          wave.map((endpoint, index) =>
            operation(endpoint, controllers[index]!.signal)
              .then((value) => {
                won = true;
                this.pool.reportOutcome(endpoint.id, "success");
                abortWave();
                return value;
              })
              .catch((error: unknown) => {
                if (!won && !controllers[index]!.signal.aborted) {
                  this.pool.reportOutcome(endpoint.id, "failure");
                  failures.push(error);
                }
                throw error;
              }),
          ),
        );
        return result;
      } catch {
        const nonRetryable = failures.find((error) => !isRetryableFailure(error));
        if (signal?.aborted || nonRetryable !== undefined) {
          throw nonRetryable ?? failures.at(-1) ?? lastError;
        }
        lastError = failures.at(-1) ?? lastError;
      } finally {
        signal?.removeEventListener("abort", abortWave);
        abortWave();
      }
    }

    throw lastError;
  }

  private async executeOnEndpoint(
    endpoint: RpcEndpointLike,
    request: {
      readonly blockNumber: string;
      readonly multicall3Address: string;
      readonly batches: readonly string[];
      readonly signal?: AbortSignal;
    },
    deadline: number,
  ): Promise<{
    readonly blockHash: string;
    readonly blockTimestamp: string;
    readonly rpcEndpointId: string;
    readonly batchReturnData: readonly string[];
  }> {
    const blockTag = toBlockTag(request.blockNumber);

    const preHeader = await this.readBlockHeader(endpoint, blockTag, request.signal, deadline);

    let batchReturnData: string[];
    if (request.batches.length === 1) {
      const returnData = await this.callAggregate3(
        endpoint,
        request.multicall3Address,
        request.batches[0]!,
        blockTag,
        request.signal,
        deadline,
      );
      batchReturnData = [returnData];
    } else {
      const remainingMs = Math.max(1, deadline - this.now());
      const timeoutMs = Math.min(this.attemptTimeoutMs, remainingMs);
      const batchRequests = request.batches.map((batch, idx) => ({
        id: idx,
        method: "eth_call",
        params: [{ to: request.multicall3Address, data: batch }, blockTag],
      }));
      const items = await this.transport.batchCall({
        endpointUrl: endpoint.url,
        requests: batchRequests,
        timeoutMs,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      batchReturnData = items.map((item) => {
        if (!item.success || typeof item.result !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(item.result)) {
          throw rpcResponseInvalid(
            `Archive RPC endpoint returned an invalid result for multicall batch item: ${item.error?.message ?? "unknown error"}`,
            { rpcEndpointId: endpoint.id },
          );
        }
        return item.result;
      });
    }

    const postHeader = await this.readBlockHeader(endpoint, blockTag, request.signal, deadline);
    if (preHeader.hash !== postHeader.hash) {
      throw rpcBlockReorgDetected(
        "Block hash changed while executing Multicall batches; potential reorg detected.",
        { rpcEndpointId: endpoint.id },
      );
    }

    return {
      blockHash: preHeader.hash,
      blockTimestamp: preHeader.timestamp,
      rpcEndpointId: endpoint.id,
      batchReturnData: Object.freeze(batchReturnData),
    };
  }

  private async getNativeBalanceOnEndpoint(
    endpoint: RpcEndpointLike,
    request: {
      readonly address: string;
      readonly blockNumber: string;
      readonly signal?: AbortSignal;
    },
    deadline: number,
  ): Promise<{
    readonly amount: string;
    readonly blockHash: string;
    readonly blockTimestamp: string;
    readonly rpcEndpointId: string;
  }> {
    const blockTag = toBlockTag(request.blockNumber);
    const preHeader = await this.readBlockHeader(endpoint, blockTag, request.signal, deadline);
    const rawBalance = await this.call(
      endpoint,
      "eth_getBalance",
      [request.address, blockTag],
      request.signal,
      deadline,
    );
    if (typeof rawBalance !== "string" || !/^0x[0-9a-fA-F]+$/.test(rawBalance)) {
      throw rpcResponseInvalid("RPC endpoint returned a malformed native balance.");
    }
    const postHeader = await this.readBlockHeader(endpoint, blockTag, request.signal, deadline);
    if (preHeader.hash !== postHeader.hash) {
      throw rpcBlockReorgDetected(
        "Block hash changed while reading native balance; potential reorg detected.",
        { rpcEndpointId: endpoint.id },
      );
    }
    return {
      amount: BigInt(rawBalance).toString(10),
      blockHash: preHeader.hash,
      blockTimestamp: preHeader.timestamp,
      rpcEndpointId: endpoint.id,
    };
  }

  private async readBlockHeader(
    endpoint: RpcEndpointLike,
    blockTag: string,
    signal: AbortSignal | undefined,
    deadline: number,
  ): Promise<BlockHeader> {
    const result = await this.call(endpoint, "eth_getBlockByNumber", [blockTag, false], signal, deadline);
    if (result === null) {
      throw rpcBlockNotFound(`RPC endpoint has no block at ${blockTag}.`);
    }
    if (result === undefined || typeof result !== "object") {
      throw rpcResponseInvalid("RPC endpoint returned a malformed block header.");
    }
    const block = result as { hash?: unknown; number?: unknown; timestamp?: unknown };
    if (typeof block.hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(block.hash)) {
      throw rpcResponseInvalid("RPC endpoint returned a malformed block hash.");
    }
    if (
      typeof block.number !== "string" ||
      !/^0x[0-9a-fA-F]+$/.test(block.number) ||
      BigInt(block.number) !== BigInt(blockTag)
    ) {
      throw rpcResponseInvalid("RPC endpoint returned a block header for the wrong block.");
    }
    if (typeof block.timestamp !== "string" || !/^0x[0-9a-fA-F]+$/.test(block.timestamp)) {
      throw rpcResponseInvalid("RPC endpoint returned a malformed block timestamp.");
    }
    return Object.freeze({ hash: block.hash, timestamp: BigInt(block.timestamp).toString(10) });
  }

  private async callAggregate3(
    endpoint: RpcEndpointLike,
    multicall3Address: string,
    callData: string,
    blockTag: string,
    signal: AbortSignal | undefined,
    deadline: number,
  ): Promise<string> {
    const result = await this.call(
      endpoint,
      "eth_call",
      [{ to: multicall3Address, data: callData }, blockTag],
      signal,
      deadline,
    );
    if (typeof result !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(result)) {
      throw rpcResponseInvalid("RPC endpoint returned a malformed eth_call result.");
    }
    return result;
  }

  private async call(
    endpoint: RpcEndpointLike,
    method: string,
    params: readonly unknown[],
    signal: AbortSignal | undefined,
    deadline: number,
  ): Promise<unknown> {
    const remainingMs = Math.max(1, deadline - this.now());
    const timeoutMs = Math.min(this.attemptTimeoutMs, remainingMs);
    const options: ArchiveRpcCallOptions = {
      endpointUrl: endpoint.url,
      method,
      params,
      timeoutMs,
      ...(signal === undefined ? {} : { signal }),
    };
    try {
      return await this.transport.call(options);
    } catch (error: unknown) {
      if (isJsonRpcCallError(error)) {
        throw archiveRpcUnavailable(
          `RPC endpoint returned a JSON-RPC error: ${error.rpcMessage}`,
          { cause: error, rpcEndpointId: endpoint.id },
        );
      }
      throw error;
    }
  }
}

function isRetryableFailure(error: unknown): boolean {
  return isEvmCallError(error) && error.retryable;
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

function toBlockTag(blockNumber: string): string {
  return `0x${BigInt(blockNumber).toString(16)}`;
}
