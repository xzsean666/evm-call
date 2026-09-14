import { invalidRequest } from "./errors";

export type TopicFilterItem = string | readonly string[] | null;

export interface LogFilter {
  readonly address?: string | readonly string[] | undefined;
  readonly topics?: readonly TopicFilterItem[] | undefined;
  readonly fromBlock?: string | number | bigint | undefined;
  readonly toBlock?: string | number | bigint | undefined;
  readonly blockHash?: string | undefined;
}

export interface NormalizedLogFilter {
  readonly address?: string | readonly string[] | undefined;
  readonly topics?: readonly (string | readonly string[] | null)[] | undefined;
  readonly fromBlock?: string | undefined;
  readonly toBlock?: string | undefined;
  readonly blockHash?: string | undefined;
}

export interface RawRpcLog {
  readonly address?: unknown;
  readonly topics?: unknown;
  readonly data?: unknown;
  readonly blockNumber?: unknown;
  readonly transactionHash?: unknown;
  readonly transactionIndex?: unknown;
  readonly blockHash?: unknown;
  readonly logIndex?: unknown;
  readonly removed?: unknown;
}

export interface EvmLog {
  /** Normalized lowercase 20-byte contract address. */
  readonly address: string;
  /** Normalized lowercase 32-byte hex topics array. */
  readonly topics: readonly string[];
  /** 0x-prefixed hex unindexed event log data. */
  readonly data: string;
  /** Integer block number as BigInt. */
  readonly blockNumber: bigint;
  /** Canonical decimal string representation of blockNumber. */
  readonly blockNumberString: string;
  /** Transaction hash (0x + 64 hex characters). */
  readonly transactionHash: string;
  /** Transaction index inside the block. */
  readonly transactionIndex: number;
  /** Block hash (0x + 64 hex characters). */
  readonly blockHash: string;
  /** Log index inside the block. */
  readonly logIndex: number;
  /** Whether the log was removed due to a chain reorg. */
  readonly removed?: boolean | undefined;
}

export interface GetLogsChunkedOptions {
  /**
   * Maximum number of blocks to query per chunk.
   * Defaults to 2,000 blocks.
   */
  readonly maxBlockRange?: number | undefined;

  /**
   * Maximum number of chunks to fetch concurrently across the RPC pool.
   * Defaults to 3.
   */
  readonly chunkConcurrency?: number | undefined;

  /**
   * Whether to automatically halve the block range and retry when an RPC node
   * returns "query returned more than 10000 results" or "block range too large".
   * Defaults to true.
   */
  readonly adaptiveChunking?: boolean | undefined;

  /**
   * Minimum block range allowed during adaptive chunk splitting. Defaults to 5 blocks.
   */
  readonly minBlockRange?: number | undefined;

  /**
   * Optional cancellation signal.
   */
  readonly signal?: AbortSignal | undefined;

  /**
   * Request-specific cache TTL in milliseconds. Pass 0 to bypass cache.
   */
  readonly cacheTtlMs?: number | undefined;

  /**
   * Optional progress callback invoked after each chunk completes.
   */
  readonly onChunkProgress?: ((progress: {
    readonly fromBlock: bigint;
    readonly toBlock: bigint;
    readonly chunkLogsCount: number;
    readonly totalLogsSoFar: number;
  }) => void) | undefined;
}

const addressPattern = /^0[xX][0-9a-fA-F]{40}$/;
const hashPattern = /^0[xX][0-9a-fA-F]{64}$/;
const topicPattern = /^0[xX][0-9a-fA-F]{64}$/;

/**
 * Validates and normalizes an EVM log filter for JSON-RPC transmission.
 */
export function parseLogFilter(filter: LogFilter): NormalizedLogFilter {
  if (typeof filter !== "object" || filter === null) {
    throw invalidRequest("LogFilter must be an object.");
  }

  const result: {
    address?: string | string[];
    topics?: (string | string[] | null)[];
    fromBlock?: string;
    toBlock?: string;
    blockHash?: string;
  } = {};

  if (filter.blockHash !== undefined) {
    if (typeof filter.blockHash !== "string" || !hashPattern.test(filter.blockHash)) {
      throw invalidRequest("LogFilter blockHash must be a valid 32-byte hex hash.");
    }
    result.blockHash = filter.blockHash.toLowerCase();
  }

  if (filter.address !== undefined) {
    if (typeof filter.address === "string") {
      if (!addressPattern.test(filter.address)) {
        throw invalidRequest("LogFilter address must be a valid 20-byte hex address.");
      }
      result.address = filter.address.toLowerCase();
    } else if (Array.isArray(filter.address)) {
      const addresses: string[] = [];
      for (let i = 0; i < filter.address.length; i += 1) {
        const item = filter.address[i];
        if (typeof item !== "string" || !addressPattern.test(item)) {
          throw invalidRequest(`LogFilter address at index ${i} must be a valid 20-byte hex address.`);
        }
        addresses.push(item.toLowerCase());
      }
      result.address = addresses;
    } else {
      throw invalidRequest("LogFilter address must be a string or array of strings.");
    }
  }

  if (filter.topics !== undefined) {
    if (!Array.isArray(filter.topics)) {
      throw invalidRequest("LogFilter topics must be an array.");
    }
    const normalizedTopics: (string | string[] | null)[] = [];
    for (let i = 0; i < filter.topics.length; i += 1) {
      const topicItem = filter.topics[i];
      if (topicItem === null || topicItem === undefined) {
        normalizedTopics.push(null);
      } else if (typeof topicItem === "string") {
        if (!topicPattern.test(topicItem)) {
          throw invalidRequest(`LogFilter topic at index ${i} must be a 32-byte hex string.`);
        }
        normalizedTopics.push(topicItem.toLowerCase());
      } else if (Array.isArray(topicItem)) {
        const subTopics: string[] = [];
        for (let j = 0; j < topicItem.length; j += 1) {
          const sub = topicItem[j];
          if (typeof sub !== "string" || !topicPattern.test(sub)) {
            throw invalidRequest(`LogFilter nested topic at index [${i}][${j}] must be a 32-byte hex string.`);
          }
          subTopics.push(sub.toLowerCase());
        }
        normalizedTopics.push(subTopics);
      } else {
        throw invalidRequest(`LogFilter topic at index ${i} has invalid format.`);
      }
    }
    result.topics = normalizedTopics;
  }

  if (filter.fromBlock !== undefined) {
    result.fromBlock = formatBlockTag(filter.fromBlock);
  }

  if (filter.toBlock !== undefined) {
    result.toBlock = formatBlockTag(filter.toBlock);
  }

  return Object.freeze(result);
}

/**
 * Normalizes a raw JSON-RPC log item into a strongly typed `EvmLog`.
 */
export function normalizeEvmLog(raw: unknown): EvmLog {
  if (typeof raw !== "object" || raw === null) {
    throw invalidRequest("Raw log must be an object.");
  }

  const log = raw as RawRpcLog;

  const address = typeof log.address === "string" ? log.address.toLowerCase() : "";
  const data = typeof log.data === "string" ? log.data.toLowerCase() : "0x";
  const blockHash = typeof log.blockHash === "string" ? log.blockHash.toLowerCase() : "";
  const transactionHash = typeof log.transactionHash === "string" ? log.transactionHash.toLowerCase() : "";

  const topics: string[] = [];
  if (Array.isArray(log.topics)) {
    for (const t of log.topics) {
      if (typeof t === "string") {
        topics.push(t.toLowerCase());
      }
    }
  }

  let blockNumber = 0n;
  if (typeof log.blockNumber === "string" || typeof log.blockNumber === "number" || typeof log.blockNumber === "bigint") {
    blockNumber = toBigIntSafe(log.blockNumber);
  }

  let transactionIndex = 0;
  if (typeof log.transactionIndex === "string" || typeof log.transactionIndex === "number") {
    transactionIndex = toNumberSafe(log.transactionIndex);
  }

  let logIndex = 0;
  if (typeof log.logIndex === "string" || typeof log.logIndex === "number") {
    logIndex = toNumberSafe(log.logIndex);
  }

  const removed = typeof log.removed === "boolean" ? log.removed : undefined;

  return Object.freeze({
    address,
    topics: Object.freeze(topics),
    data,
    blockNumber,
    blockNumberString: blockNumber.toString(10),
    transactionHash,
    transactionIndex,
    blockHash,
    logIndex,
    ...(removed !== undefined ? { removed } : {}),
  });
}

/**
 * Strictly sorts EVM logs deterministically by:
 * 1. blockNumber ASC
 * 2. transactionIndex ASC
 * 3. logIndex ASC
 */
export function sortEvmLogs(logs: readonly EvmLog[]): readonly EvmLog[] {
  return Object.freeze(
    [...logs].sort((a, b) => {
      if (a.blockNumber !== b.blockNumber) {
        return a.blockNumber < b.blockNumber ? -1 : 1;
      }
      if (a.transactionIndex !== b.transactionIndex) {
        return a.transactionIndex - b.transactionIndex;
      }
      return a.logIndex - b.logIndex;
    }),
  );
}

function toBigIntSafe(val: string | number | bigint): bigint {
  if (typeof val === "bigint") return val;
  if (typeof val === "number") return BigInt(Math.trunc(val));
  try {
    const str = val.trim();
    return BigInt(str);
  } catch {
    return 0n;
  }
}

function toNumberSafe(val: string | number): number {
  if (typeof val === "number") return Number.isSafeInteger(val) ? Math.trunc(val) : 0;
  const str = val.trim();
  const num =
    str.startsWith("0x") || str.startsWith("0X")
      ? Number.parseInt(str, 16)
      : Number.parseInt(str, 10);
  return Number.isSafeInteger(num) ? num : 0;
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
