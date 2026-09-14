import { createHash } from "node:crypto";

import type { SqliteStorageAdapter } from "./SqliteStorageAdapter";

export interface RpcCacheOptions {
  /** TTL for non-historical / latest / volatile calls in milliseconds. Defaults to 10,000 (10 seconds). */
  readonly volatileTtlMs?: number;
  /** TTL for immutable historical block calls in milliseconds. Defaults to 30 days (2,592,000,000 ms). */
  readonly historicalTtlMs?: number;
  /** Maximum number of entries in the in-memory L1 hot cache. Defaults to 500 (set to 0 to disable). */
  readonly maxMemoryEntries?: number;
}

export const DEFAULT_VOLATILE_TTL_MS = 10_000; // 10s
export const DEFAULT_HISTORICAL_TTL_MS = 30 * 86_400_000; // 30 days
export const DEFAULT_MAX_MEMORY_ENTRIES = 500;

export interface CacheEntryMetadata {
  readonly isHistorical: boolean;
  readonly blockTag: string | null;
}

export interface RpcCacheBatchEntry {
  readonly chainId: number;
  readonly method: string;
  readonly params: unknown;
  readonly result: unknown;
  readonly cacheTtlMs?: number;
}

export class RpcCacheService {
  private readonly storage: SqliteStorageAdapter;
  private readonly volatileTtlMs: number;
  private readonly historicalTtlMs: number;
  private readonly maxMemoryEntries: number;
  private readonly memoryCache = new Map<string, { value: unknown; expiresAt: number }>();

  constructor(storage: SqliteStorageAdapter, options: RpcCacheOptions = {}) {
    this.storage = storage;
    this.volatileTtlMs = options.volatileTtlMs ?? DEFAULT_VOLATILE_TTL_MS;
    this.historicalTtlMs = options.historicalTtlMs ?? DEFAULT_HISTORICAL_TTL_MS;
    this.maxMemoryEntries = Math.max(0, options.maxMemoryEntries ?? DEFAULT_MAX_MEMORY_ENTRIES);
  }

  /**
   * Generates a deterministic SHA-256 cache key.
   */
  computeKey(chainId: number, method: string, params: unknown): string {
    const canonical = canonicalStringify(params);
    return createHash("sha256")
      .update(`${chainId}:${method.trim().toLowerCase()}:${canonical}`)
      .digest("hex");
  }

  /**
   * Evaluates whether a call targets an immutable historical block.
   */
  classifyRequest(method: string, params: unknown): CacheEntryMetadata {
    const normalizedMethod = method.trim().toLowerCase();
    let blockTag: string | null = null;

    if (Array.isArray(params)) {
      if (
        normalizedMethod === "eth_call" ||
        normalizedMethod === "eth_getbalance" ||
        normalizedMethod === "eth_getcode" ||
        normalizedMethod === "eth_gettransactioncount"
      ) {
        if (typeof params[1] === "string" || typeof params[1] === "number" || typeof params[1] === "bigint") {
          blockTag = String(params[1]);
        }
      } else if (normalizedMethod === "eth_getstorageat") {
        if (typeof params[2] === "string" || typeof params[2] === "number" || typeof params[2] === "bigint") {
          blockTag = String(params[2]);
        }
      } else if (normalizedMethod === "eth_getblockbynumber") {
        if (typeof params[0] === "string" || typeof params[0] === "number" || typeof params[0] === "bigint") {
          blockTag = String(params[0]);
        }
      } else if (normalizedMethod === "eth_getblockbyhash") {
        return { isHistorical: true, blockTag: typeof params[0] === "string" ? params[0].toLowerCase() : null };
      }
    } else if (typeof params === "object" && params !== null) {
      const candidate = params as Record<string, unknown>;
      if (typeof candidate.blockNumber === "string" || typeof candidate.blockNumber === "number" || typeof candidate.blockNumber === "bigint") {
        blockTag = String(candidate.blockNumber);
      } else if (typeof candidate.blockTag === "string" || typeof candidate.blockTag === "number" || typeof candidate.blockTag === "bigint") {
        blockTag = String(candidate.blockTag);
      }
    }

    if (blockTag !== null) {
      const tagLower = blockTag.trim().toLowerCase();
      if (
        tagLower === "latest" ||
        tagLower === "pending" ||
        tagLower === "safe" ||
        tagLower === "finalized"
      ) {
        return { isHistorical: false, blockTag: tagLower };
      }
      if (tagLower === "earliest") {
        return { isHistorical: true, blockTag: tagLower };
      }
      // Exact hex block (0x...) or decimal integer
      if (/^0x[0-9a-f]+$/i.test(tagLower) || /^[0-9]+$/.test(tagLower)) {
        return { isHistorical: true, blockTag: tagLower };
      }
    }

    return { isHistorical: false, blockTag };
  }

  /**
   * Retrieves an item from cache if present and unexpired.
   * Checks L1 memory cache first; falls back to L2 SQLite storage.
   */
  get<T = unknown>(
    chainId: number,
    method: string,
    params: unknown,
    options?: { now?: number },
  ): T | null {
    const key = this.computeKey(chainId, method, params);
    const now = options?.now ?? Date.now();

    // 1. Check L1 memory cache
    const mem = this.memoryCache.get(key);
    if (mem !== undefined) {
      if (mem.expiresAt > now) {
        return mem.value as T;
      }
      this.memoryCache.delete(key);
    }

    // 2. Check L2 SQLite storage
    const row = this.storage.get<{
      result_payload: string;
      expires_at: number;
    }>(
      "SELECT result_payload, expires_at FROM evm_rpc_cache WHERE cache_key = ?",
      [key],
    );

    if (row === undefined || row.expires_at <= now) {
      return null;
    }

    try {
      const parsed = JSON.parse(row.result_payload) as T;
      this.setMemoryCache(key, parsed, row.expires_at);
      return parsed;
    } catch {
      return null;
    }
  }

  /**
   * Persists an item in cache according to tiered or custom TTL.
   */
  set(
    chainId: number,
    method: string,
    params: unknown,
    result: unknown,
    options?: { cacheTtlMs?: number; now?: number },
  ): void {
    if (options?.cacheTtlMs === 0) {
      // 0 explicitly means bypass / don't cache
      return;
    }

    const { isHistorical, blockTag } = this.classifyRequest(method, params);
    const now = options?.now ?? Date.now();
    const ttlMs =
      options?.cacheTtlMs ??
      (isHistorical ? this.historicalTtlMs : this.volatileTtlMs);

    if (ttlMs <= 0) {
      return;
    }

    const key = this.computeKey(chainId, method, params);
    const expiresAt = now + ttlMs;
    const payload = safeJsonStringify(result);

    this.setMemoryCache(key, result, expiresAt);

    this.storage.run(
      `INSERT OR REPLACE INTO evm_rpc_cache (
        cache_key, chain_id, method, is_historical, block_tag, result_payload, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        key,
        chainId,
        method.trim(),
        isHistorical ? 1 : 0,
        blockTag,
        payload,
        now,
        expiresAt,
      ],
    );
  }

  /**
   * Persists multiple items in cache atomically within a single SQLite transaction.
   */
  setBatch(
    entries: readonly RpcCacheBatchEntry[],
    options?: { now?: number },
  ): void {
    if (entries.length === 0) {
      return;
    }

    const now = options?.now ?? Date.now();
    this.storage.transaction(() => {
      for (const entry of entries) {
        this.set(entry.chainId, entry.method, entry.params, entry.result, {
          ...(entry.cacheTtlMs !== undefined ? { cacheTtlMs: entry.cacheTtlMs } : {}),
          now,
        });
      }
    });
  }

  /**
   * Actively deletes expired cache entries.
   * @returns number of deleted rows
   */
  cleanExpired(now = Date.now()): number {
    for (const [key, item] of this.memoryCache.entries()) {
      if (item.expiresAt <= now) {
        this.memoryCache.delete(key);
      }
    }
    const res = this.storage.run(
      "DELETE FROM evm_rpc_cache WHERE expires_at <= ?",
      [now],
    );
    return res.changes;
  }

  /**
   * Conditionally prunes cache entries.
   */
  prune(options?: {
    chainId?: number;
    isHistorical?: boolean;
    beforeTimestamp?: number;
    olderThanMs?: number;
    now?: number;
  }): number {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (options?.chainId !== undefined) {
      conditions.push("chain_id = ?");
      params.push(options.chainId);
    }
    if (options?.isHistorical !== undefined) {
      conditions.push("is_historical = ?");
      params.push(options.isHistorical ? 1 : 0);
    }

    let cutoff = options?.beforeTimestamp;
    if (options?.olderThanMs !== undefined) {
      const now = options.now ?? Date.now();
      cutoff = now - options.olderThanMs;
    }

    if (cutoff !== undefined) {
      conditions.push("created_at <= ?");
      params.push(cutoff);
    }

    const sql =
      conditions.length > 0
        ? `DELETE FROM evm_rpc_cache WHERE ${conditions.join(" AND ")}`
        : "DELETE FROM evm_rpc_cache";

    const res = this.storage.run(sql, params);
    this.memoryCache.clear();
    return res.changes;
  }

  /**
   * Empties the entire RPC cache.
   */
  clear(): void {
    this.memoryCache.clear();
    this.storage.run("DELETE FROM evm_rpc_cache");
  }

  private setMemoryCache(key: string, value: unknown, expiresAt: number): void {
    if (this.maxMemoryEntries <= 0) {
      return;
    }
    if (this.memoryCache.size >= this.maxMemoryEntries) {
      const firstKey = this.memoryCache.keys().next().value;
      if (firstKey !== undefined) {
        this.memoryCache.delete(firstKey);
      }
    }
    this.memoryCache.set(key, { value, expiresAt });
  }
}

/**
 * Deterministic JSON stringification for caching.
 */
function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "bigint") {
      return value.toString();
    }
    return JSON.stringify(value) ?? "";
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalStringify(item)).join(",")}]`;
  }

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const entries: string[] = [];
  for (const k of keys) {
    const val = obj[k];
    if (val !== undefined) {
      entries.push(`${JSON.stringify(k)}:${canonicalStringify(val)}`);
    }
  }
  return `{${entries.join(",")}}`;
}

/**
 * Safely stringifies objects containing BigInt values without throwing TypeError.
 */
function safeJsonStringify(value: unknown): string {
  return (
    JSON.stringify(value, (_key, val) =>
      typeof val === "bigint" ? val.toString(10) : val,
    ) ?? ""
  );
}
