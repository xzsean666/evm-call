import {
  multicallNotDeployedAtBlock,
  unsupportedChain,
  invalidRequest,
} from "../domain/errors";
import {
  resolveChainId,
  parseMulticallAtBlockRequest,
  parseErc20MulticallAtBlockRequest,
  parseNativeBalanceAtBlockRequest,
  parseBatchNativeBalancesRequest,
  type MulticallAtBlockRequest,
  type MulticallAtBlockResult,
  type MulticallAtBlockCallResult,
  type Erc20MulticallAtBlockRequest,
  type Erc20MulticallAtBlockResult,
  type Erc20MulticallCallResult,
  type NativeBalanceAtBlockRequest,
  type NativeBalanceAtBlockResult,
  type BatchNativeBalancesRequest,
  type BatchNativeBalancesResult,
  type BatchNativeBalanceItemResult,
  type NormalizedMulticallAtBlockCall,
} from "../domain/multicallModels";
import type {
  JsonRpcBatchExecutionOptions,
  JsonRpcBatchItemResult,
  JsonRpcRequest,
  BlockTagOrNumber,
  EstimateGasRequest,
  EthCallRequest,
  FeeHistoryResult,
  TransactionWithReceipt,
} from "../domain/jsonRpcModels";
import {
  type LogFilter,
  type EvmLog,
  type LogChunk,
  type GetLogsChunkedOptions,
  parseLogFilter,
  normalizeEvmLog,
  sortEvmLogs,
} from "../domain/logModels";
import {
  MULTICALL3_ADDRESS,
  getMulticall3DeploymentBlock,
  encodeAggregate3,
  decodeAggregate3Result,
  encodeErc20Read,
  decodeErc20Read,
  encodeGetEthBalance,
  decodeGetEthBalanceResult,
  EthereumArchiveRpcExecutor,
} from "../multicall";
import { JsonRpcBatchExecutor } from "../batch";
import { RpcPool } from "../pool";
import { SqliteStorageAdapter, RpcCacheService, SqliteCooldownStore } from "../storage";
import { ArchiveRpcTransport } from "../transport";
import type { RandomSource } from "../execution/clock";
import { systemRandom } from "../execution/clock";
import type { RpcPoolLike } from "../batch";

export interface EvmCallClientOptions {
  readonly chainId?: number | string;
  readonly customRpcUrls?: readonly string[];
  readonly storagePath?: string;
  readonly storageAdapter?: SqliteStorageAdapter;
  readonly cacheService?: RpcCacheService;
  readonly pool?: RpcPoolLike;
  readonly transport?: ArchiveRpcTransport | undefined;
  readonly batchExecutor?: JsonRpcBatchExecutor;
  readonly archiveExecutor?: EthereumArchiveRpcExecutor;
  readonly attemptTimeoutMs?: number;
  readonly totalTimeoutMs?: number;
  readonly maxRpcAttempts?: number;
  readonly maxConcurrentRpcAttempts?: number;
  readonly defaultBatchChunkSize?: number;
  readonly defaultMaxConcurrency?: number;
  readonly maxCallsPerMulticall?: number;
  readonly multicall3Address?: string;
  readonly multicall3DeploymentBlock?: string | bigint;
  readonly randomSource?: RandomSource;
  readonly now?: () => number;
}

const DEFAULT_MAX_CALLS_PER_MULTICALL = 100;

export class EvmCallClient {
  readonly chainId: number;
  readonly pool: RpcPoolLike;
  readonly cacheService: RpcCacheService;
  readonly batchExecutor: JsonRpcBatchExecutor;
  readonly archiveExecutor: EthereumArchiveRpcExecutor;
  private readonly storageAdapter: SqliteStorageAdapter;
  private readonly ownsStorage: boolean;
  private readonly randomSource: RandomSource;
  private readonly maxCallsPerMulticall: number;
  private readonly multicall3Address: string;
  private readonly multicall3DeploymentBlock?: bigint | undefined;

  constructor(options: EvmCallClientOptions = {}) {
    this.chainId = resolveChainId(options.chainId ?? 1);
    this.randomSource = options.randomSource ?? systemRandom;
    this.maxCallsPerMulticall = Math.max(1, options.maxCallsPerMulticall ?? DEFAULT_MAX_CALLS_PER_MULTICALL);
    this.multicall3Address = options.multicall3Address ?? MULTICALL3_ADDRESS;

    if (options.multicall3DeploymentBlock !== undefined) {
      this.multicall3DeploymentBlock = BigInt(options.multicall3DeploymentBlock);
    } else {
      this.multicall3DeploymentBlock = getMulticall3DeploymentBlock(this.chainId);
    }

    if (options.storageAdapter !== undefined) {
      this.storageAdapter = options.storageAdapter;
      this.ownsStorage = false;
    } else {
      this.storageAdapter = new SqliteStorageAdapter({
        path: options.storagePath ?? "./data/evm-call.db",
      });
      this.ownsStorage = true;
    }

    this.cacheService = options.cacheService ?? new RpcCacheService(this.storageAdapter);

    this.pool =
      options.pool ??
      new RpcPool({
        chainId: this.chainId,
        ...(options.customRpcUrls !== undefined ? { endpoints: options.customRpcUrls } : {}),
        ...(options.transport !== undefined ? { transport: options.transport } : {}),
        cooldownStore: new SqliteCooldownStore(this.storageAdapter),
        ...(options.now !== undefined ? { clock: { now: options.now } } : {}),
      });

    this.batchExecutor =
      options.batchExecutor ??
      new JsonRpcBatchExecutor({
        pool: this.pool,
        chainId: this.chainId,
        cacheService: this.cacheService,
        randomSource: this.randomSource,
        ...(options.transport !== undefined ? { transport: options.transport } : {}),
        attemptTimeoutMs: options.attemptTimeoutMs,
        totalTimeoutMs: options.totalTimeoutMs,
        maxRpcAttempts: options.maxRpcAttempts,
        defaultBatchChunkSize: options.defaultBatchChunkSize,
        defaultMaxConcurrency: options.defaultMaxConcurrency,
        now: options.now,
      });

    this.archiveExecutor =
      options.archiveExecutor ??
      new EthereumArchiveRpcExecutor({
        pool: this.pool,
        randomSource: this.randomSource,
        ...(options.transport !== undefined ? { transport: options.transport } : {}),
        attemptTimeoutMs: options.attemptTimeoutMs,
        totalTimeoutMs: options.totalTimeoutMs,
        maxRpcAttempts: options.maxRpcAttempts,
        maxConcurrentRpcAttempts: options.maxConcurrentRpcAttempts,
        now: options.now,
      });
  }

  /**
   * Initializes the client and warms up the RPC endpoint pool with health probes.
   */
  async init(signal?: AbortSignal): Promise<void> {
    const p = this.pool as unknown as { initialize?: (signal?: AbortSignal) => Promise<void> };
    if (typeof p.initialize === "function") {
      await p.initialize(signal);
    }
  }

  /**
   * Closes database storage and releases resources.
   */
  close(): void {
    if (this.ownsStorage) {
      this.storageAdapter.close();
    }
  }

  /**
   * Executes a single JSON-RPC call over the healthy RPC pool with cache check.
   */
  async call<TResult = unknown>(
    request: JsonRpcRequest,
    options?: JsonRpcBatchExecutionOptions,
  ): Promise<TResult> {
    return this.batchExecutor.call<TResult>(request, options);
  }

  /**
   * Executes a batch of arbitrary JSON-RPC requests across the pool with
   * automatic chunking, cache-first lookup, and fault-tolerant failover.
   */
  async batch<TResult = unknown>(
    requests: readonly JsonRpcRequest[],
    options?: JsonRpcBatchExecutionOptions,
  ): Promise<readonly JsonRpcBatchItemResult<TResult>[]> {
    return this.batchExecutor.executeBatch<TResult>(requests, options);
  }

  /**
   * Executes a batch of JSON-RPC requests and throws on the first failed call.
   */
  async strictBatch<TResult = unknown>(
    requests: readonly JsonRpcRequest[],
    options?: JsonRpcBatchExecutionOptions,
  ): Promise<readonly TResult[]> {
    return this.batchExecutor.executeStrictBatch<TResult>(requests, options);
  }

  /**
   * Executes a Multicall3 batch read at a specified historical block
   * with pre/post block header hash validation to prevent reorg dirty reads.
   */
  async multicall(request: MulticallAtBlockRequest): Promise<MulticallAtBlockResult> {
    const normalized = parseMulticallAtBlockRequest(request);

    if (normalized.chainId !== this.chainId) {
      throw unsupportedChain(
        `This client is configured for chain ${this.chainId}, but request specified ${normalized.chainId}.`,
        normalized.chainId,
      );
    }

    if (
      this.multicall3DeploymentBlock !== undefined &&
      BigInt(normalized.blockNumber) < this.multicall3DeploymentBlock
    ) {
      throw multicallNotDeployedAtBlock(
        `Multicall3 is not deployed at block ${normalized.blockNumber} on chain ${this.chainId} ` +
          `(deployed at block ${this.multicall3DeploymentBlock}).`,
        this.chainId,
      );
    }

    const batches = chunk(normalized.calls, this.maxCallsPerMulticall);
    const encodedBatches = batches.map((batch) =>
      encodeAggregate3(
        batch.map((call) => ({
          target: call.target,
          allowFailure: call.allowFailure,
          callData: call.callData,
        })),
      ),
    );

    const execution = await this.archiveExecutor.executeMulticallBatches({
      blockNumber: normalized.blockNumber,
      multicall3Address: this.multicall3Address,
      batches: encodedBatches,
      ...(normalized.signal !== undefined ? { signal: normalized.signal } : {}),
    });

    if (execution.batchReturnData.length !== batches.length) {
      throw invalidRequest("Archive RPC executor returned a different batch count than requested.");
    }

    const results: MulticallAtBlockCallResult[] = [];
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
      const batch = batches[batchIndex]!;
      const decoded = decodeAggregate3Result(execution.batchReturnData[batchIndex]!, batch.length);
      for (let callIndex = 0; callIndex < batch.length; callIndex += 1) {
        const call = batch[callIndex]!;
        const decodedCall = decoded[callIndex]!;
        results.push(
          Object.freeze({
            id: call.id,
            success: decodedCall.success,
            returnData: decodedCall.returnData,
          }),
        );
      }
    }

    return Object.freeze({
      chainId: normalized.chainId,
      blockNumber: normalized.blockNumber,
      blockHash: execution.blockHash,
      blockTimestamp: execution.blockTimestamp,
      rpcEndpointId: execution.rpcEndpointId,
      multicallBatches: batches.length,
      results: Object.freeze(results),
    });
  }

  /**
   * Encodes and executes common ERC-20 read calls (balanceOf, allowance, decimals, name, symbol, totalSupply)
   * via Multicall3 at a specified block or latest block.
   */
  async multicallErc20(request: Erc20MulticallAtBlockRequest): Promise<Erc20MulticallAtBlockResult> {
    const normalized = parseErc20MulticallAtBlockRequest(request);

    if (normalized.chainId !== this.chainId) {
      throw unsupportedChain(
        `This client is configured for chain ${this.chainId}, but request specified ${normalized.chainId}.`,
        normalized.chainId,
      );
    }

    let blockNumber = normalized.blockNumber;
    if (blockNumber === undefined) {
      const latest = await this.archiveExecutor.findLatestBlockNumber(normalized.signal);
      blockNumber = latest.blockNumber;
    }

    const raw = await this.multicall({
      chain: normalized.chainId,
      blockNumber,
      calls: normalized.calls.map((call) => ({
        id: call.id,
        target: call.tokenAddress,
        callData: encodeErc20Read(call),
        allowFailure: true,
      })),
      ...(normalized.signal !== undefined ? { signal: normalized.signal } : {}),
    });

    const byId = new Map(raw.results.map((r) => [r.id, r]));
    const results: Erc20MulticallCallResult[] = normalized.calls.map((call) => {
      const item = byId.get(call.id)!;
      if (!item.success) {
        return Object.freeze({
          id: call.id,
          tokenAddress: call.tokenAddress,
          method: call.method,
          success: false,
          value: null,
          error: "CALL_FAILED" as const,
        });
      }
      try {
        const decoded = decodeErc20Read(call.method, item.returnData);
        return Object.freeze({
          id: call.id,
          tokenAddress: call.tokenAddress,
          method: call.method,
          success: true,
          value: decoded,
          error: null,
        });
      } catch {
        return Object.freeze({
          id: call.id,
          tokenAddress: call.tokenAddress,
          method: call.method,
          success: false,
          value: null,
          error: "DECODE_FAILED" as const,
        });
      }
    });

    return Object.freeze({
      chainId: raw.chainId,
      blockNumber: raw.blockNumber,
      blockHash: raw.blockHash,
      blockTimestamp: raw.blockTimestamp,
      rpcEndpointId: raw.rpcEndpointId,
      multicallBatches: raw.multicallBatches,
      results: Object.freeze(results),
    });
  }

  /**
   * Performs binary search on public RPC to find the highest block number whose timestamp <= targetTimestampSeconds.
   */
  async findBlockNumberByTimestamp(
    timestampSeconds: number | bigint | string,
    lowerBoundBlock?: number | bigint | string,
    signal?: AbortSignal,
  ): Promise<{ readonly blockNumber: string; readonly rpcEndpointId: string }> {
    const target = BigInt(timestampSeconds);
    const lower = lowerBoundBlock !== undefined ? BigInt(lowerBoundBlock) : 0n;
    return this.archiveExecutor.findBlockNumberByTimestamp(target, lower, signal);
  }

  /**
   * Reads current latest block number from the healthy RPC pool.
   */
  async findLatestBlockNumber(
    signal?: AbortSignal,
  ): Promise<{ readonly blockNumber: string; readonly rpcEndpointId: string }> {
    return this.archiveExecutor.findLatestBlockNumber(signal);
  }

  /**
   * Reads native currency balance (in wei) at a specified historical block.
   */
  async getNativeBalanceAtBlock(
    request: NativeBalanceAtBlockRequest,
  ): Promise<NativeBalanceAtBlockResult> {
    const normalized = parseNativeBalanceAtBlockRequest(request);

    if (normalized.chainId !== this.chainId) {
      throw unsupportedChain(
        `This client is configured for chain ${this.chainId}, but request specified ${normalized.chainId}.`,
        normalized.chainId,
      );
    }

    const res = await this.archiveExecutor.getNativeBalanceAtBlock({
      address: normalized.address,
      blockNumber: normalized.blockNumber,
      ...(normalized.signal !== undefined ? { signal: normalized.signal } : {}),
    });

    return Object.freeze({
      chainId: normalized.chainId,
      address: normalized.address,
      blockNumber: normalized.blockNumber,
      amount: res.amount,
      blockHash: res.blockHash,
      blockTimestamp: res.blockTimestamp,
      rpcEndpointId: res.rpcEndpointId,
    });
  }

  /**
   * Reads multiple addresses' native balances (in wei) via Multicall3 getEthBalance in a single batch.
   */
  async getNativeBalances(request: BatchNativeBalancesRequest): Promise<BatchNativeBalancesResult> {
    const normalized = parseBatchNativeBalancesRequest(request);

    if (normalized.chainId !== this.chainId) {
      throw unsupportedChain(
        `This client is configured for chain ${this.chainId}, but request specified ${normalized.chainId}.`,
        normalized.chainId,
      );
    }

    let blockNumber = normalized.blockNumber;
    if (blockNumber === undefined) {
      const latest = await this.archiveExecutor.findLatestBlockNumber(normalized.signal);
      blockNumber = latest.blockNumber;
    }

    const calls = normalized.addresses.map((addr, idx) => ({
      id: `bal-${idx}`,
      target: this.multicall3Address,
      callData: encodeGetEthBalance(addr),
      allowFailure: true,
    }));

    const raw = await this.multicall({
      chain: normalized.chainId,
      blockNumber,
      calls,
      ...(normalized.signal !== undefined ? { signal: normalized.signal } : {}),
    });

    const results: BatchNativeBalanceItemResult[] = normalized.addresses.map((addr, idx) => {
      const item = raw.results[idx];
      if (item === undefined || !item.success) {
        return Object.freeze({
          address: addr,
          amount: "0",
          success: false,
        });
      }
      try {
        const decoded = decodeGetEthBalanceResult(item.returnData);
        return Object.freeze({
          address: addr,
          amount: decoded.toString(10),
          success: true,
        });
      } catch {
        return Object.freeze({
          address: addr,
          amount: "0",
          success: false,
        });
      }
    });

    return Object.freeze({
      chainId: raw.chainId,
      blockNumber: raw.blockNumber,
      blockHash: raw.blockHash,
      blockTimestamp: raw.blockTimestamp,
      rpcEndpointId: raw.rpcEndpointId,
      results: Object.freeze(results),
    });
  }

  /**
   * Fetches block by block number or tag (e.g. "latest", "safe", "finalized", 18000000).
   */
  async getBlock(
    blockTagOrNumber: BlockTagOrNumber = "latest",
    fullTransactions = false,
    options?: JsonRpcBatchExecutionOptions,
  ): Promise<Record<string, unknown> | null> {
    const tag = formatBlockTag(blockTagOrNumber);
    return this.call<Record<string, unknown> | null>(
      { id: 1, method: "eth_getBlockByNumber", params: [tag, fullTransactions] },
      options,
    );
  }

  /**
   * Fetches block by 32-byte block hash.
   */
  async getBlockByHash(
    blockHash: string,
    fullTransactions = false,
    options?: JsonRpcBatchExecutionOptions,
  ): Promise<Record<string, unknown> | null> {
    return this.call<Record<string, unknown> | null>(
      { id: 1, method: "eth_getBlockByHash", params: [blockHash.toLowerCase(), fullTransactions] },
      options,
    );
  }

  /**
   * Batch fetches multiple blocks by their numbers or tags in a single efficient RPC batch.
   * Preserves exact input ordering and automatically handles large arrays via chunking.
   */
  async getBlocks(
    blockTagsOrNumbers: readonly BlockTagOrNumber[],
    fullTransactions = false,
    options?: JsonRpcBatchExecutionOptions,
  ): Promise<readonly (Record<string, unknown> | null)[]> {
    if (blockTagsOrNumbers.length === 0) {
      return Object.freeze([]);
    }
    const requests = blockTagsOrNumbers.map((tag, idx) => ({
      id: idx,
      method: "eth_getBlockByNumber",
      params: [formatBlockTag(tag), fullTransactions],
    }));
    const rawResults = await this.batch(requests, options);
    const results = rawResults.map((item) => {
      if (!item.success || item.result === null || typeof item.result !== "object") {
        return null;
      }
      return item.result as Record<string, unknown>;
    });
    return Object.freeze(results);
  }

  /**
   * Fetches all transaction receipts in a block.
   * Tries native eth_getBlockReceipts first (supported by Arbitrum, Base, Reth, Erigon, etc.),
   * and automatically falls back to fetching block transaction hashes followed by batch receipt queries.
   */
  async getBlockReceipts(
    blockTagOrNumber: BlockTagOrNumber = "latest",
    options?: JsonRpcBatchExecutionOptions,
  ): Promise<readonly Record<string, unknown>[]> {
    const tag = formatBlockTag(blockTagOrNumber);
    try {
      const nativeReceipts = await this.call<unknown[]>(
        { id: 1, method: "eth_getBlockReceipts", params: [tag] },
        options,
      );
      if (Array.isArray(nativeReceipts)) {
        return Object.freeze(
          nativeReceipts.filter(
            (r): r is Record<string, unknown> => r !== null && typeof r === "object",
          ),
        );
      }
    } catch {
      // Fallback below
    }

    const block = await this.getBlock(tag, false, options);
    if (!block || !Array.isArray(block.transactions) || block.transactions.length === 0) {
      return Object.freeze([]);
    }

    const txHashes = block.transactions.filter(
      (tx): tx is string => typeof tx === "string",
    );
    const receipts = await this.getTransactionReceipts(txHashes, options);
    return Object.freeze(
      receipts.filter(
        (r): r is Record<string, unknown> => r !== null && typeof r === "object",
      ),
    );
  }

  /**
   * Fetches contract bytecode at given address and block.
   */
  async getCode(
    address: string,
    blockTagOrNumber: BlockTagOrNumber = "latest",
    options?: JsonRpcBatchExecutionOptions,
  ): Promise<string> {
    const tag = formatBlockTag(blockTagOrNumber);
    return this.call<string>(
      { id: 1, method: "eth_getCode", params: [address.toLowerCase(), tag] },
      options,
    );
  }

  /**
   * Batch fetches bytecode for multiple addresses to identify contracts vs EOAs.
   */
  async getCodes(
    addresses: readonly string[],
    blockTagOrNumber: BlockTagOrNumber = "latest",
    options?: JsonRpcBatchExecutionOptions,
  ): Promise<readonly string[]> {
    if (addresses.length === 0) {
      return Object.freeze([]);
    }
    const tag = formatBlockTag(blockTagOrNumber);
    const requests = addresses.map((addr, idx) => ({
      id: idx,
      method: "eth_getCode",
      params: [addr.toLowerCase(), tag],
    }));
    const rawResults = await this.batch(requests, options);
    const results = rawResults.map((item) => {
      if (item.success && typeof item.result === "string") {
        return item.result.toLowerCase();
      }
      return "0x";
    });
    return Object.freeze(results);
  }

  /**
   * Fetches transaction details for a given transaction hash.
   */
  async getTransaction(
    txHash: string,
    options?: JsonRpcBatchExecutionOptions,
  ): Promise<Record<string, unknown> | null> {
    return this.call<Record<string, unknown> | null>(
      { id: 1, method: "eth_getTransactionByHash", params: [txHash.toLowerCase()] },
      options,
    );
  }

  /**
   * Batch fetches multiple transactions by their hashes.
   * Preserves exact input order and uses RPC batching and pool load balancing.
   */
  async getTransactions(
    txHashes: readonly string[],
    options?: JsonRpcBatchExecutionOptions,
  ): Promise<readonly (Record<string, unknown> | null)[]> {
    if (txHashes.length === 0) {
      return Object.freeze([]);
    }
    const requests = txHashes.map((hash, idx) => ({
      id: idx,
      method: "eth_getTransactionByHash",
      params: [hash.toLowerCase()],
    }));
    const rawResults = await this.batch(requests, options);
    const results = rawResults.map((item) => {
      if (!item.success || item.result === null || typeof item.result !== "object") {
        return null;
      }
      return item.result as Record<string, unknown>;
    });
    return Object.freeze(results);
  }

  /**
   * Fetches transaction receipt for a given transaction hash.
   */
  async getTransactionReceipt(
    txHash: string,
    options?: JsonRpcBatchExecutionOptions,
  ): Promise<Record<string, unknown> | null> {
    return this.call<Record<string, unknown> | null>(
      { id: 1, method: "eth_getTransactionReceipt", params: [txHash.toLowerCase()] },
      options,
    );
  }

  /**
   * Batch fetches multiple transaction receipts by their hashes.
   * Preserves exact input order and uses RPC batching and pool load balancing.
   */
  async getTransactionReceipts(
    txHashes: readonly string[],
    options?: JsonRpcBatchExecutionOptions,
  ): Promise<readonly (Record<string, unknown> | null)[]> {
    if (txHashes.length === 0) {
      return Object.freeze([]);
    }
    const requests = txHashes.map((hash, idx) => ({
      id: idx,
      method: "eth_getTransactionReceipt",
      params: [hash.toLowerCase()],
    }));
    const rawResults = await this.batch(requests, options);
    const results = rawResults.map((item) => {
      if (!item.success || item.result === null || typeof item.result !== "object") {
        return null;
      }
      return item.result as Record<string, unknown>;
    });
    return Object.freeze(results);
  }

  /**
   * Fetches both transaction details and receipt in a single roundtrip batch.
   */
  async getTransactionWithReceipt(
    txHash: string,
    options?: JsonRpcBatchExecutionOptions,
  ): Promise<TransactionWithReceipt> {
    const normalized = txHash.toLowerCase();
    const [txRes, rcRes] = await this.batch(
      [
        { id: "tx", method: "eth_getTransactionByHash", params: [normalized] },
        { id: "rc", method: "eth_getTransactionReceipt", params: [normalized] },
      ],
      options,
    );

    const transaction =
      txRes && txRes.success && typeof txRes.result === "object" && txRes.result !== null
        ? (txRes.result as Record<string, unknown>)
        : null;
    const receipt =
      rcRes && rcRes.success && typeof rcRes.result === "object" && rcRes.result !== null
        ? (rcRes.result as Record<string, unknown>)
        : null;

    return Object.freeze({ transaction, receipt });
  }

  /**
   * Reads account transaction count (nonce).
   */
  async getTransactionCount(
    address: string,
    blockTagOrNumber: BlockTagOrNumber = "latest",
    options?: JsonRpcBatchExecutionOptions,
  ): Promise<bigint> {
    const tag = formatBlockTag(blockTagOrNumber);
    const hex = await this.call<string>(
      { id: 1, method: "eth_getTransactionCount", params: [address.toLowerCase(), tag] },
      options,
    );
    return BigInt(hex);
  }

  /**
   * Batch reads nonces for multiple addresses in a single batch.
   */
  async getTransactionCounts(
    addresses: readonly string[],
    blockTagOrNumber: BlockTagOrNumber = "latest",
    options?: JsonRpcBatchExecutionOptions,
  ): Promise<readonly bigint[]> {
    if (addresses.length === 0) {
      return Object.freeze([]);
    }
    const tag = formatBlockTag(blockTagOrNumber);
    const requests = addresses.map((addr, idx) => ({
      id: idx,
      method: "eth_getTransactionCount",
      params: [addr.toLowerCase(), tag],
    }));
    const rawResults = await this.batch(requests, options);
    const results = rawResults.map((item) => {
      if (item.success && (typeof item.result === "string" || typeof item.result === "number")) {
        return BigInt(item.result);
      }
      return 0n;
    });
    return Object.freeze(results);
  }

  /**
   * Reads raw contract storage slot.
   */
  async getStorageAt(
    address: string,
    position: string | number | bigint,
    blockTagOrNumber: BlockTagOrNumber = "latest",
    options?: JsonRpcBatchExecutionOptions,
  ): Promise<string> {
    const tag = formatBlockTag(blockTagOrNumber);
    const slot = formatStorageSlot(position);
    return this.call<string>(
      { id: 1, method: "eth_getStorageAt", params: [address.toLowerCase(), slot, tag] },
      options,
    );
  }

  /**
   * Batch reads multiple contract storage slots.
   */
  async getStorageAts(
    requests: readonly { address: string; position: string | number | bigint }[],
    blockTagOrNumber: BlockTagOrNumber = "latest",
    options?: JsonRpcBatchExecutionOptions,
  ): Promise<readonly string[]> {
    if (requests.length === 0) {
      return Object.freeze([]);
    }
    const tag = formatBlockTag(blockTagOrNumber);
    const batchRequests = requests.map((req, idx) => ({
      id: idx,
      method: "eth_getStorageAt",
      params: [req.address.toLowerCase(), formatStorageSlot(req.position), tag],
    }));
    const rawResults = await this.batch(batchRequests, options);
    const results = rawResults.map((item) => {
      if (item.success && typeof item.result === "string") {
        return item.result.toLowerCase();
      }
      return "0x";
    });
    return Object.freeze(results);
  }

  /**
   * Simulates transaction and estimates gas usage.
   */
  async estimateGas(
    request: EstimateGasRequest,
    blockTagOrNumber: BlockTagOrNumber = "latest",
    options?: JsonRpcBatchExecutionOptions,
  ): Promise<bigint> {
    const txObj: Record<string, unknown> = {};
    if (request.to !== undefined) txObj.to = request.to.toLowerCase();
    if (request.from !== undefined) txObj.from = request.from.toLowerCase();
    if (request.data !== undefined) txObj.data = request.data.toLowerCase();
    if (request.value !== undefined) txObj.value = formatHexValue(request.value);
    if (request.gasPrice !== undefined) txObj.gasPrice = formatHexValue(request.gasPrice);

    const tag = formatBlockTag(blockTagOrNumber);
    const hex = await this.call<string>(
      { id: 1, method: "eth_estimateGas", params: [txObj, tag] },
      options,
    );
    return BigInt(hex);
  }

  /**
   * Retrieves transaction base fee history and priority fee rewards for EIP-1559 gas pricing.
   */
  async getFeeHistory(
    blockCount: number,
    newestBlock: BlockTagOrNumber = "latest",
    rewardPercentiles: readonly number[] = [],
    options?: JsonRpcBatchExecutionOptions,
  ): Promise<FeeHistoryResult> {
    const countHex = `0x${blockCount.toString(16)}`;
    const tag = formatBlockTag(newestBlock);
    const raw = await this.call<Record<string, unknown>>(
      { id: 1, method: "eth_feeHistory", params: [countHex, tag, rewardPercentiles] },
      options,
    );

    const oldestBlock =
      typeof raw.oldestBlock === "string" || typeof raw.oldestBlock === "number"
        ? BigInt(raw.oldestBlock)
        : 0n;

    const baseFeePerGas: bigint[] = Array.isArray(raw.baseFeePerGas)
      ? raw.baseFeePerGas.map((val) => (typeof val === "string" || typeof val === "number" ? BigInt(val) : 0n))
      : [];

    const gasUsedRatio: number[] = Array.isArray(raw.gasUsedRatio)
      ? raw.gasUsedRatio.map((val) => (typeof val === "number" ? val : 0))
      : [];

    let reward: (readonly bigint[])[] | undefined = undefined;
    if (Array.isArray(raw.reward)) {
      reward = raw.reward.map((row) =>
        Array.isArray(row)
          ? row.map((item) => (typeof item === "string" || typeof item === "number" ? BigInt(item) : 0n))
          : [],
      );
    }

    return Object.freeze({
      oldestBlock,
      baseFeePerGas: Object.freeze(baseFeePerGas),
      gasUsedRatio: Object.freeze(gasUsedRatio),
      ...(reward !== undefined ? { reward: Object.freeze(reward) } : {}),
    });
  }

  /**
   * Executes multiple raw eth_call simulations in a single batch.
   * Useful when Multicall3 is not available or when calls specify different 'from' addresses.
   */
  async batchEthCall(
    calls: readonly EthCallRequest[],
    blockTagOrNumber: BlockTagOrNumber = "latest",
    options?: JsonRpcBatchExecutionOptions,
  ): Promise<readonly string[]> {
    if (calls.length === 0) {
      return Object.freeze([]);
    }
    const tag = formatBlockTag(blockTagOrNumber);
    const requests = calls.map((c, idx) => {
      const obj: Record<string, unknown> = {
        to: c.to.toLowerCase(),
        data: c.data ?? "0x",
      };
      if (c.from !== undefined) obj.from = c.from.toLowerCase();
      if (c.value !== undefined) obj.value = formatHexValue(c.value);
      return {
        id: idx,
        method: "eth_call",
        params: [obj, tag],
      };
    });
    const rawResults = await this.batch(requests, options);
    const results = rawResults.map((item) => {
      if (item.success && typeof item.result === "string") {
        return item.result.toLowerCase();
      }
      return "0x";
    });
    return Object.freeze(results);
  }

  /**
   * Reads current gas price in wei.
   */
  async getGasPrice(options?: JsonRpcBatchExecutionOptions): Promise<bigint> {
    const hex = await this.call<string>({ id: 1, method: "eth_gasPrice", params: [] }, options);
    return BigInt(hex);
  }

  /**
   * Queries event logs matching a filter for a single request.
   */
  async getLogs(
    filter: LogFilter,
    options?: JsonRpcBatchExecutionOptions,
  ): Promise<readonly EvmLog[]> {
    const normalized = parseLogFilter(filter);
    const params: Record<string, unknown> = {};
    if (normalized.address !== undefined) params.address = normalized.address;
    if (normalized.topics !== undefined) params.topics = normalized.topics;
    if (normalized.fromBlock !== undefined) params.fromBlock = normalized.fromBlock;
    if (normalized.toBlock !== undefined) params.toBlock = normalized.toBlock;
    if (normalized.blockHash !== undefined) params.blockHash = normalized.blockHash;

    const rawLogs = await this.call<readonly unknown[]>(
      { id: 1, method: "eth_getLogs", params: [params] },
      options,
    );

    if (!Array.isArray(rawLogs)) {
      return Object.freeze([]);
    }

    const logs = rawLogs.map(normalizeEvmLog);
    return sortEvmLogs(logs);
  }

  /**
   * Fetches event logs across a potentially large block range by automatically
   * dividing the range into chunks, executing with bounded concurrency,
   * automatically adapting chunk size if the node rate limits or limits result count,
   * and returning all logs in strictly deterministic sorted order.
   */
  async getLogsChunked(
    filter: LogFilter,
    options?: GetLogsChunkedOptions,
  ): Promise<readonly EvmLog[]> {
    const allLogs: EvmLog[] = [];
    for await (const chunkLogs of this.iterateLogs(filter, options)) {
      allLogs.push(...chunkLogs);
    }
    return sortEvmLogs(allLogs);
  }

  /**
   * Async generator that streams event logs chunk by chunk with explicit block range boundaries.
   * Ideal for indexing pipelines to atomically commit contiguous ranges.
   */
  async *iterateLogChunks(
    filter: LogFilter,
    options?: GetLogsChunkedOptions,
  ): AsyncGenerator<LogChunk, void, unknown> {
    const batchOptions: JsonRpcBatchExecutionOptions = {
      ...(options?.signal !== undefined ? { signal: options.signal } : {}),
      ...(options?.cacheTtlMs !== undefined ? { cacheTtlMs: options.cacheTtlMs } : {}),
    };

    if (filter.blockHash !== undefined) {
      const logs = await this.getLogs(filter, batchOptions);
      yield {
        fromBlock: logs.length > 0 ? logs[0]!.blockNumber : 0n,
        toBlock: logs.length > 0 ? logs[logs.length - 1]!.blockNumber : 0n,
        logs,
      };
      return;
    }

    // Resolve toBlock
    let toBlockBigInt: bigint;
    if (filter.toBlock === undefined || filter.toBlock === "latest") {
      const latest = await this.archiveExecutor.findLatestBlockNumber(options?.signal);
      toBlockBigInt = BigInt(latest.blockNumber);
    } else if (filter.toBlock === "earliest") {
      toBlockBigInt = 0n;
    } else {
      toBlockBigInt = toBlockNumberBigInt(filter.toBlock);
    }

    // Resolve fromBlock
    let fromBlockBigInt: bigint;
    if (filter.fromBlock === undefined) {
      fromBlockBigInt = toBlockBigInt;
    } else if (filter.fromBlock === "latest") {
      fromBlockBigInt = toBlockBigInt;
    } else if (filter.fromBlock === "earliest") {
      fromBlockBigInt = 0n;
    } else {
      fromBlockBigInt = toBlockNumberBigInt(filter.fromBlock);
    }

    if (fromBlockBigInt > toBlockBigInt) {
      throw invalidRequest(
        `fromBlock (${fromBlockBigInt.toString(10)}) cannot be greater than toBlock (${toBlockBigInt.toString(10)}) in getLogsChunked.`,
      );
    }

    const maxBlockRange = BigInt(Math.max(1, options?.maxBlockRange ?? 2_000));
    const concurrency = Math.max(1, options?.chunkConcurrency ?? 3);
    const adaptive = options?.adaptiveChunking ?? true;
    const minRange = BigInt(Math.max(1, options?.minBlockRange ?? 5));

    // Build interval slices
    const intervals: { start: bigint; end: bigint }[] = [];
    let current = fromBlockBigInt;
    while (current <= toBlockBigInt) {
      let nextEnd = current + maxBlockRange - 1n;
      if (nextEnd > toBlockBigInt) {
        nextEnd = toBlockBigInt;
      }
      intervals.push({ start: current, end: nextEnd });
      current = nextEnd + 1n;
    }

    const fetchRange = async (startBlock: bigint, endBlock: bigint): Promise<readonly EvmLog[]> => {
      try {
        const subFilter: LogFilter = {
          ...(filter.address !== undefined ? { address: filter.address } : {}),
          ...(filter.topics !== undefined ? { topics: filter.topics } : {}),
          fromBlock: `0x${startBlock.toString(16)}`,
          toBlock: `0x${endBlock.toString(16)}`,
        };
        return await this.getLogs(subFilter, batchOptions);
      } catch (error: unknown) {
        if (adaptive && (endBlock - startBlock) >= minRange && isLogRangeOrCountError(error)) {
          const mid = startBlock + (endBlock - startBlock) / 2n;
          const left = await fetchRange(startBlock, mid);
          const right = await fetchRange(mid + 1n, endBlock);
          return Object.freeze([...left, ...right]);
        }
        throw error;
      }
    };

    let totalLogsSoFar = 0;

    // Process intervals in concurrent waves to preserve ordered streaming
    for (let i = 0; i < intervals.length; i += concurrency) {
      if (options?.signal?.aborted) {
        throw invalidRequest("getLogsChunked operation was aborted.");
      }

      const wave = intervals.slice(i, i + concurrency);
      const waveResults = await Promise.all(
        wave.map(async (interval) => {
          const chunkLogs = await fetchRange(interval.start, interval.end);
          return { interval, chunkLogs };
        }),
      );

      for (const { interval, chunkLogs } of waveResults) {
        totalLogsSoFar += chunkLogs.length;
        options?.onChunkProgress?.({
          fromBlock: interval.start,
          toBlock: interval.end,
          chunkLogsCount: chunkLogs.length,
          totalLogsSoFar,
        });
        yield {
          fromBlock: interval.start,
          toBlock: interval.end,
          logs: chunkLogs,
        };
      }
    }
  }

  /**
   * Async generator that streams event logs chunk by chunk in block order.
   * Ideal for indexing pipelines to avoid loading all logs in memory at once.
   */
  async *iterateLogs(
    filter: LogFilter,
    options?: GetLogsChunkedOptions,
  ): AsyncGenerator<readonly EvmLog[], void, unknown> {
    for await (const chunk of this.iterateLogChunks(filter, options)) {
      yield chunk.logs;
    }
  }

  /**
   * Clean expired cache entries from SQLite storage.
   */
  cleanExpiredCache(now?: number): number {
    return this.cacheService.cleanExpired(now);
  }

  /**
   * Prune cache entries matching conditions.
   */
  pruneCache(options?: {
    readonly olderThanMs?: number;
    readonly beforeTimestamp?: number;
    readonly isHistorical?: boolean;
    readonly chainId?: number;
    readonly now?: number;
  }): number {
    return this.cacheService.prune(options);
  }

  /**
   * Clear all cached RPC responses.
   */
  clearCache(): void {
    this.cacheService.clear();
  }

  /**
   * Gets a list of currently healthy RPC endpoints in the pool.
   */
  getHealthyEndpoints(): readonly { id: string; url: string }[] {
    return this.pool.healthySnapshot(this.randomSource);
  }
}

export function createEvmCallClient(options?: EvmCallClientOptions): EvmCallClient {
  return new EvmCallClient(options);
}

function chunk<T>(values: readonly T[], size: number): readonly (readonly T[])[] {
  const result: (readonly T[])[] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function formatBlockTag(tag: string | number | bigint): string {
  if (typeof tag === "bigint" || typeof tag === "number") {
    return `0x${BigInt(tag).toString(16)}`;
  }
  const trimmed = tag.trim().toLowerCase();
  if (
    trimmed === "latest" ||
    trimmed === "pending" ||
    trimmed === "earliest" ||
    trimmed === "safe" ||
    trimmed === "finalized"
  ) {
    return trimmed;
  }
  if (trimmed.startsWith("0x")) {
    return trimmed;
  }
  return `0x${BigInt(trimmed).toString(16)}`;
}

function toBlockNumberBigInt(tag: string | number | bigint): bigint {
  if (typeof tag === "bigint") return tag;
  if (typeof tag === "number") return BigInt(Math.trunc(tag));
  const str = tag.trim();
  if (str.startsWith("0x") || str.startsWith("0X")) {
    return BigInt(str);
  }
  return BigInt(str);
}

function isLogRangeOrCountError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message.toLowerCase() : "";
  return (
    msg.includes("more than") ||
    msg.includes("too large") ||
    msg.includes("exceed") ||
    msg.includes("limit") ||
    msg.includes("query returned") ||
    msg.includes("10000") ||
    msg.includes("response size") ||
    msg.includes("max block range") ||
    msg.includes("timeout") ||
    msg.includes("-32005") ||
    msg.includes("-32000")
  );
}

function formatStorageSlot(position: string | number | bigint): string {
  if (typeof position === "bigint" || typeof position === "number") {
    return `0x${BigInt(position).toString(16)}`;
  }
  const trimmed = position.trim().toLowerCase();
  if (trimmed.startsWith("0x")) {
    return trimmed;
  }
  return `0x${BigInt(trimmed).toString(16)}`;
}

function formatHexValue(val: string | number | bigint): string {
  if (typeof val === "bigint" || typeof val === "number") {
    const big = BigInt(val);
    if (big < 0n) throw invalidRequest("EVM numeric values cannot be negative.");
    return `0x${big.toString(16)}`;
  }
  const trimmed = val.trim().toLowerCase();
  if (trimmed.startsWith("0x")) {
    return trimmed;
  }
  const big = BigInt(trimmed);
  if (big < 0n) throw invalidRequest("EVM numeric values cannot be negative.");
  return `0x${big.toString(16)}`;
}

