import { describe, expect, it } from "vitest";

import { SqliteStorageAdapter } from "../../src/storage/SqliteStorageAdapter";
import { RpcCacheService } from "../../src/storage/RpcCacheService";

describe("RpcCacheService", () => {
  it("produces deterministic keys regardless of object property ordering", () => {
    const adapter = new SqliteStorageAdapter({ path: ":memory:" });
    const service = new RpcCacheService(adapter);

    const key1 = service.computeKey(1, "eth_call", [{ to: "0x123", data: "0xabc" }, "latest"]);
    const key2 = service.computeKey(1, "eth_call", [{ data: "0xabc", to: "0x123" }, "latest"]);
    expect(key1).toBe(key2);
  });

  it("classifies historical vs latest calls correctly", () => {
    const adapter = new SqliteStorageAdapter({ path: ":memory:" });
    const service = new RpcCacheService(adapter);

    // Latest / volatile
    expect(service.classifyRequest("eth_blockNumber", [])).toEqual({ isHistorical: false, blockTag: null });
    expect(service.classifyRequest("eth_call", [{}, "latest"])).toEqual({ isHistorical: false, blockTag: "latest" });
    expect(service.classifyRequest("eth_call", [{}, "pending"])).toEqual({ isHistorical: false, blockTag: "pending" });

    // Historical
    expect(service.classifyRequest("eth_call", [{}, "0x112a880"])).toEqual({ isHistorical: true, blockTag: "0x112a880" });
    expect(service.classifyRequest("eth_getBalance", ["0x123", "18000000"])).toEqual({ isHistorical: true, blockTag: "18000000" });
    expect(service.classifyRequest("eth_getBlockByNumber", ["0x123", false])).toEqual({ isHistorical: true, blockTag: "0x123" });
    expect(service.classifyRequest("multicallAtBlock", { blockNumber: "19000000" })).toEqual({ isHistorical: true, blockTag: "19000000" });
  });

  it("applies 10s default TTL for volatile latest calls", () => {
    const adapter = new SqliteStorageAdapter({ path: ":memory:" });
    const service = new RpcCacheService(adapter);
    const now = 1_000_000;

    service.set(1, "eth_blockNumber", [], "0x100", { now });

    // Hits at now + 5s
    const hit = service.get(1, "eth_blockNumber", [], { now: now + 5_000 });
    expect(hit).toBe("0x100");

    // Hits at now + 10s - 1ms
    expect(service.get(1, "eth_blockNumber", [], { now: now + 9_999 })).toBe("0x100");

    // Misses after 10s
    const expired = service.get(1, "eth_blockNumber", [], { now: now + 10_001 });
    expect(expired).toBeNull();
  });

  it("applies long-term TTL for historical calls", () => {
    const adapter = new SqliteStorageAdapter({ path: ":memory:" });
    const service = new RpcCacheService(adapter);
    const now = 1_000_000;

    service.set(1, "eth_call", [{ to: "0x123" }, "0x112a880"], "0xbeef", { now });

    // Hits even after 7 days
    const sevenDays = 7 * 86_400_000;
    const hit = service.get(1, "eth_call", [{ to: "0x123" }, "0x112a880"], { now: now + sevenDays });
    expect(hit).toBe("0xbeef");
  });

  it("bypasses caching when cacheTtlMs is 0", () => {
    const adapter = new SqliteStorageAdapter({ path: ":memory:" });
    const service = new RpcCacheService(adapter);

    service.set(1, "eth_blockNumber", [], "0x100", { cacheTtlMs: 0 });
    const cached = service.get(1, "eth_blockNumber", []);
    expect(cached).toBeNull();
  });

  it("actively cleans expired entries with cleanExpired()", () => {
    const adapter = new SqliteStorageAdapter({ path: ":memory:" });
    const service = new RpcCacheService(adapter);
    const now = 1_000_000;

    // Insert 2 volatile entries (expires at now + 10s = 1_010_000)
    service.set(1, "eth_blockNumber", [], "0x100", { now });
    service.set(1, "eth_gasPrice", [], "0x50", { now });

    // Insert 1 historical entry (expires in 30 days)
    service.set(1, "eth_call", [{}, "0x100"], "0x1", { now });

    // At now + 5s: nothing expired
    const deleted0 = service.cleanExpired(now + 5_000);
    expect(deleted0).toBe(0);

    // At now + 15s: 2 volatile entries expired
    const deleted2 = service.cleanExpired(now + 15_000);
    expect(deleted2).toBe(2);

    // Volatile entries are cleaned from DB
    expect(service.get(1, "eth_blockNumber", [], { now: now + 15_000 })).toBeNull();
    expect(service.get(1, "eth_gasPrice", [], { now: now + 15_000 })).toBeNull();

    // Historical remains
    expect(service.get(1, "eth_call", [{}, "0x100"], { now: now + 15_000 })).toBe("0x1");
  });

  it("prunes and clears cache correctly", () => {
    const adapter = new SqliteStorageAdapter({ path: ":memory:" });
    const service = new RpcCacheService(adapter);

    service.set(1, "eth_blockNumber", [], "0x1");
    service.set(8453, "eth_blockNumber", [], "0x2");

    expect(service.prune({ chainId: 1 })).toBe(1);
    expect(service.get(1, "eth_blockNumber", [])).toBeNull();
    expect(service.get(8453, "eth_blockNumber", [])).toBe("0x2");

    service.clear();
    expect(service.get(8453, "eth_blockNumber", [])).toBeNull();
  });
});
