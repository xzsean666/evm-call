import { describe, expect, it } from "vitest";

import { EvmCallClient } from "../../src/client/EvmCallClient";
import {
  parseMulticallAtBlockRequest,
  parseNativeBalanceAtBlockRequest,
  resolveChainId,
} from "../../src/domain/multicallModels";
import {
  encodeGetEthBalance,
  decodeGetEthBalanceResult,
  decodeAggregate3Result,
  MULTICALL3_GET_ETH_BALANCE_SELECTOR,
} from "../../src/multicall/Multicall3Codec";
import { RpcCacheService } from "../../src/storage/RpcCacheService";
import { SqliteStorageAdapter } from "../../src/storage/SqliteStorageAdapter";
import { ArchiveRpcTransport } from "../../src/transport/ArchiveRpcTransport";
import { type HttpTransport, type HttpResponse } from "../../src/transport/HttpTransport";

class DummyHttpTransport implements HttpTransport {
  async request(): Promise<HttpResponse> {
    return {
      status: 200,
      headers: {},
      body: { jsonrpc: "2.0", id: 1, result: "0x123" },
    };
  }
}

describe("Security & Bug Fixes Audit", () => {
  describe("Bug Fix: pruneCache with olderThanMs must not wipe the entire table", () => {
    it("safely prunes only entries older than olderThanMs", () => {
      const storage = new SqliteStorageAdapter({ path: ":memory:" });
      const cacheService = new RpcCacheService(storage);
      const client = new EvmCallClient({ storageAdapter: storage, cacheService });

      const now = 1_000_000_000;
      // 1. Old entry (created at now - 2 hours)
      cacheService.set(1, "eth_call", ["old"], "0xold", { now: now - 7_200_000, cacheTtlMs: 86_400_000 });
      // 2. Fresh entry (created at now - 10 minutes)
      cacheService.set(1, "eth_call", ["new"], "0xnew", { now: now - 600_000, cacheTtlMs: 86_400_000 });

      // Call pruneCache with olderThanMs: 1 hour (3_600_000 ms)
      const prunedCount = client.pruneCache({ olderThanMs: 3_600_000, now });

      expect(prunedCount).toBe(1);
      // Old entry was deleted
      expect(cacheService.get(1, "eth_call", ["old"], { now })).toBeNull();
      // Fresh entry was PRESERVED (previously this would have been wiped!)
      expect(cacheService.get(1, "eth_call", ["new"], { now })).toBe("0xnew");
    });
  });

  describe("Flexible blockNumber parsing (hex, number, bigint, decimal string)", () => {
    const dummyCall = { id: "c1", target: "0x1111111111111111111111111111111111111111", callData: "0x" };

    it("parses decimal string blockNumber", () => {
      const parsed = parseMulticallAtBlockRequest({ chain: 1, blockNumber: "18000000", calls: [dummyCall] });
      expect(parsed.blockNumber).toBe("18000000");
    });

    it("parses hex blockNumber", () => {
      const parsed = parseMulticallAtBlockRequest({ chain: 1, blockNumber: "0x112a880", calls: [dummyCall] });
      expect(parsed.blockNumber).toBe("18000000");
    });

    it("parses number blockNumber", () => {
      const parsed = parseMulticallAtBlockRequest({ chain: 1, blockNumber: 18_000_000, calls: [dummyCall] });
      expect(parsed.blockNumber).toBe("18000000");
    });

    it("parses bigint blockNumber", () => {
      const parsed = parseNativeBalanceAtBlockRequest({
        chain: 1,
        address: "0x1111111111111111111111111111111111111111",
        blockNumber: 18_000_000n,
      });
      expect(parsed.blockNumber).toBe("18000000");
    });
  });

  describe("Multi-chain and Hex ChainId Resolution", () => {
    it("resolves canonical names and hex chainIds", () => {
      expect(resolveChainId("ethereum")).toBe(1);
      expect(resolveChainId("base")).toBe(8453);
      expect(resolveChainId("arbitrum")).toBe(42161);
      expect(resolveChainId("optimism")).toBe(10);
      expect(resolveChainId("polygon")).toBe(137);
      expect(resolveChainId("bsc")).toBe(56);
      expect(resolveChainId("avalanche")).toBe(43114);
      expect(resolveChainId("linea")).toBe(59144);
      expect(resolveChainId("scroll")).toBe(534352);
      expect(resolveChainId("sepolia")).toBe(11155111);
      expect(resolveChainId("base-sepolia")).toBe(84532);

      // Hex string chainIds
      expect(resolveChainId("0x1")).toBe(1);
      expect(resolveChainId("0xa")).toBe(10);
      expect(resolveChainId("0x2105")).toBe(8453);
    });
  });

  describe("Multicall3 getEthBalance encoding/decoding & safe bounds", () => {
    it("encodes getEthBalance selector 0x4d2301cc with address", () => {
      expect(MULTICALL3_GET_ETH_BALANCE_SELECTOR).toBe("4d2301cc");
      const encoded = encodeGetEthBalance("0x0000000000000000000000000000000000000001");
      expect(encoded.startsWith("0x4d2301cc")).toBe(true);
      expect(encoded.length).toBe(2 + 8 + 64);
    });

    it("decodes getEthBalance single uint256 result", () => {
      const hex = "0x" + "0".repeat(63) + "a"; // 10 wei
      const decoded = decodeGetEthBalanceResult(hex);
      expect(decoded).toBe(10n);
    });

    it("throws on truncated return data in aggregate3", () => {
      // Malformed return data that claims 1 tuple but has insufficient offset/length
      expect(() => decodeAggregate3Result("0x00", 1)).toThrow(/must be even-length hex|truncated|too short/);
    });
  });

  describe("ArchiveRpcTransport Localhost & Dev Support", () => {
    it("allows http for localhost / 127.0.0.1", async () => {
      const transport = new ArchiveRpcTransport({ httpTransport: new DummyHttpTransport() });
      await expect(
        transport.call({
          endpointUrl: "http://127.0.0.1:8545",
          method: "eth_chainId",
          params: [],
          timeoutMs: 1000,
        }),
      ).resolves.toBe("0x123");
    });

    it("blocks remote http by default", async () => {
      const transport = new ArchiveRpcTransport({ httpTransport: new DummyHttpTransport() });
      await expect(
        transport.call({
          endpointUrl: "http://remote-rpc.example.com",
          method: "eth_chainId",
          params: [],
          timeoutMs: 1000,
        }),
      ).rejects.toThrow(/must use HTTPS/);
    });

    it("allows remote http when allowInsecureHttp is explicitly enabled", async () => {
      const transport = new ArchiveRpcTransport({
        httpTransport: new DummyHttpTransport(),
        allowInsecureHttp: true,
      });
      await expect(
        transport.call({
          endpointUrl: "http://remote-rpc.example.com",
          method: "eth_chainId",
          params: [],
          timeoutMs: 1000,
        }),
      ).resolves.toBe("0x123");
    });
  });

  describe("Batch ID string and number cross-matching", () => {
    it("matches string response ID to number request ID and vice-versa", async () => {
      class MismatchedIdTransport implements HttpTransport {
        async request(): Promise<HttpResponse> {
          return {
            status: 200,
            headers: {},
            body: [
              { jsonrpc: "2.0", id: "1", result: "0xfirst" },   // node replied with string "1" for number 1
              { jsonrpc: "2.0", id: 2, result: "0xsecond" },   // node replied with number 2 for string "2"
            ],
          };
        }
      }

      const transport = new ArchiveRpcTransport({ httpTransport: new MismatchedIdTransport() });
      const results = await transport.batchCall({
        endpointUrl: "https://mock.rpc",
        requests: [
          { id: 1, method: "eth_call" },
          { id: "2", method: "eth_call" },
        ],
        timeoutMs: 1000,
      });

      expect(results.length).toBe(2);
      expect(results[0]?.success).toBe(true);
      expect(results[0]?.result).toBe("0xfirst");
      expect(results[1]?.success).toBe(true);
      expect(results[1]?.result).toBe("0xsecond");
    });
  });

  describe("RpcCacheService BigInt serialization safety", () => {
    it("safely serializes and caches results containing BigInt values without throwing TypeError", () => {
      const storage = new SqliteStorageAdapter({ path: ":memory:" });
      const cacheService = new RpcCacheService(storage);

      expect(() => {
        cacheService.set(1, "custom_method", [], { amount: 1000000000000000000n });
      }).not.toThrow();

      // L1 hot cache preserves original object
      const retrievedL1 = cacheService.get<{ amount: bigint }>(1, "custom_method", []);
      expect(retrievedL1?.amount).toBe(1000000000000000000n);

      // Create new service with empty L1 cache to test SQLite L2 deseralization
      const cacheService2 = new RpcCacheService(storage);
      const retrievedL2 = cacheService2.get<{ amount: string }>(1, "custom_method", []);
      expect(retrievedL2?.amount).toBe("1000000000000000000");
    });
  });

  describe("SqliteStorageAdapter nested transaction support", () => {
    it("handles nested transaction calls without throwing SQLite transaction error", () => {
      const storage = new SqliteStorageAdapter({ path: ":memory:" });
      storage.initialize();

      expect(() => {
        storage.transaction((adapter1) => {
          adapter1.run(
            "INSERT INTO evm_rpc_cache (cache_key, chain_id, method, is_historical, result_payload, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            ["k1", 1, "test", 0, "1", 100, 200],
          );
          // Nested transaction invocation
          adapter1.transaction((adapter2) => {
            adapter2.run(
              "INSERT INTO evm_rpc_cache (cache_key, chain_id, method, is_historical, result_payload, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
              ["k2", 1, "test", 0, "2", 100, 200],
            );
          });
        });
      }).not.toThrow();

      expect(storage.get("SELECT * FROM evm_rpc_cache WHERE cache_key = 'k1'")).toBeDefined();
      expect(storage.get("SELECT * FROM evm_rpc_cache WHERE cache_key = 'k2'")).toBeDefined();
      storage.close();
    });
  });

  describe("EvmCallClient input parameter bounds & negativity prevention", () => {
    it("rejects negative numeric values in estimateGas and batchEthCall", async () => {
      const client = new EvmCallClient({
        storageAdapter: new SqliteStorageAdapter({ path: ":memory:" }),
        transport: new ArchiveRpcTransport({ httpTransport: new DummyHttpTransport() }),
        customRpcUrls: ["https://mock.rpc"],
      });

      await expect(
        client.estimateGas({ to: "0x1111111111111111111111111111111111111111", value: -100n }),
      ).rejects.toThrow(/cannot be negative/);

      await expect(
        client.batchEthCall([{ to: "0x1111111111111111111111111111111111111111", value: -1 }]),
      ).rejects.toThrow(/cannot be negative/);

      client.close();
    });
  });
});

