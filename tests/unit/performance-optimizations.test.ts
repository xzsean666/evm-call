import { describe, expect, it } from "vitest";

import { RpcCacheService } from "../../src/storage/RpcCacheService";
import { SqliteStorageAdapter } from "../../src/storage/SqliteStorageAdapter";

describe("Performance Optimizations Audit", () => {
  describe("SqliteStorageAdapter statement caching and WAL mode", () => {
    it("caches prepared statements across multiple calls with zero errors", () => {
      const storage = new SqliteStorageAdapter({ path: ":memory:" });
      storage.initialize();

      // Repeated runs of the same query should reuse the compiled statement
      for (let i = 1; i <= 20; i += 1) {
        storage.run(
          "INSERT OR REPLACE INTO evm_rpc_cache (cache_key, chain_id, method, is_historical, block_tag, result_payload, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          [`key-${i}`, 1, "eth_blockNumber", 0, "latest", `"0x${i}"`, 1000, 2000],
        );
      }

      // Repeated gets of the same query
      for (let i = 1; i <= 20; i += 1) {
        const row = storage.get<{ result_payload: string }>(
          "SELECT result_payload FROM evm_rpc_cache WHERE cache_key = ?",
          [`key-${i}`],
        );
        expect(row?.result_payload).toBe(`"0x${i}"`);
      }

      storage.close();
    });
  });

  describe("RpcCacheService L1 In-Memory Hot Cache", () => {
    it("serves repeated reads from L1 memory cache without re-querying disk", () => {
      const storage = new SqliteStorageAdapter({ path: ":memory:" });
      const service = new RpcCacheService(storage, { maxMemoryEntries: 100 });
      const now = 1_000_000;

      service.set(1, "eth_blockNumber", [], "0x123", { now });

      // First get hits L1 memory cache
      const hit1 = service.get<string>(1, "eth_blockNumber", [], { now: now + 1000 });
      expect(hit1).toBe("0x123");

      // Verify that mutating the disk table underneath does not affect unexpired L1 memory reads
      storage.run("DELETE FROM evm_rpc_cache");
      const hit2 = service.get<string>(1, "eth_blockNumber", [], { now: now + 2000 });
      expect(hit2).toBe("0x123");

      // Once expired, L1 is purged and returns null
      const expired = service.get<string>(1, "eth_blockNumber", [], { now: now + 15_000 });
      expect(expired).toBeNull();
    });
  });

  describe("RpcCacheService setBatch atomic transaction", () => {
    it("persists multiple entries in a single atomic batch transaction", () => {
      const storage = new SqliteStorageAdapter({ path: ":memory:" });
      const service = new RpcCacheService(storage);
      const now = 1_000_000;

      const entries = [
        { chainId: 1, method: "eth_getBalance", params: ["0xaaa", "latest"], result: "100" },
        { chainId: 1, method: "eth_getBalance", params: ["0xbbb", "latest"], result: "200" },
        { chainId: 1, method: "eth_getBalance", params: ["0xccc", "latest"], result: "300" },
      ];

      service.setBatch(entries, { now });

      expect(service.get(1, "eth_getBalance", ["0xaaa", "latest"], { now })).toBe("100");
      expect(service.get(1, "eth_getBalance", ["0xbbb", "latest"], { now })).toBe("200");
      expect(service.get(1, "eth_getBalance", ["0xccc", "latest"], { now })).toBe("300");
    });
  });

  describe("RpcCacheService extended classification for immutable methods", () => {
    it("correctly classifies eth_getCode, eth_getTransactionCount, and eth_getBlockByHash", () => {
      const storage = new SqliteStorageAdapter({ path: ":memory:" });
      const service = new RpcCacheService(storage);

      // eth_getCode at historical block
      const codeHist = service.classifyRequest("eth_getCode", ["0xaaa", "0x112a880"]);
      expect(codeHist.isHistorical).toBe(true);

      // eth_getCode at latest
      const codeLatest = service.classifyRequest("eth_getCode", ["0xaaa", "latest"]);
      expect(codeLatest.isHistorical).toBe(false);

      // eth_getTransactionCount at historical block
      const nonceHist = service.classifyRequest("eth_getTransactionCount", ["0xaaa", "18000000"]);
      expect(nonceHist.isHistorical).toBe(true);

      // eth_getBlockByHash is always immutable
      const blockHashMeta = service.classifyRequest("eth_getBlockByHash", ["0x" + "a".repeat(64), false]);
      expect(blockHashMeta.isHistorical).toBe(true);
    });
  });
});

