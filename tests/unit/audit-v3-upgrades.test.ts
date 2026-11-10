import { describe, expect, it } from "vitest";

import { EvmCallClient } from "../../src/client/EvmCallClient";
import { JsonRpcBatchExecutor } from "../../src/batch/JsonRpcBatchExecutor";
import { RpcPool } from "../../src/pool/RpcPool";
import { SqliteStorageAdapter } from "../../src/storage/SqliteStorageAdapter";
import { RpcCacheService } from "../../src/storage/RpcCacheService";
import { ArchiveRpcTransport } from "../../src/transport/ArchiveRpcTransport";
import type { HttpTransport, HttpResponse, HttpRequest } from "../../src/transport/HttpTransport";
import { HttpTransportError } from "../../src/transport/HttpTransport";

class RecordingHttpTransport implements HttpTransport {
  public requests: HttpRequest[] = [];
  public handler?: (req: HttpRequest) => Promise<HttpResponse>;

  async request(req: HttpRequest): Promise<HttpResponse> {
    this.requests.push(req);
    if (this.handler !== undefined) {
      return this.handler(req);
    }
    return {
      status: 200,
      headers: {},
      body: { jsonrpc: "2.0", id: 1, result: "0x1" },
    };
  }
}

describe("Audit V3 Upgrades & Security Verifications", () => {
  describe("1. isAllNodeFailures & Failover on Server/Rate-Limit Errors", () => {
    it("fails over when node returns -32603 Internal Error across batch items", async () => {
      let callCount = 0;
      const transport: HttpTransport = {
        async request(req) {
          callCount += 1;
          const body = req.body as { id: number }[];
          if (callCount === 1) {
            // Node 1 fails all items with -32603
            return {
              status: 200,
              headers: {},
              body: body.map((it) => ({
                jsonrpc: "2.0",
                id: it.id,
                error: { code: -32603, message: "Internal server error: database unreachable" },
              })),
            };
          }
          // Node 2 succeeds!
          return {
            status: 200,
            headers: {},
            body: body.map((it) => ({
              jsonrpc: "2.0",
              id: it.id,
              result: "0x42",
            })),
          };
        },
      };

      const pool = {
        chainId: 1,
        healthySnapshot: () => [
          { id: "node-1", url: "https://node1.example.com" },
          { id: "node-2", url: "https://node2.example.com" },
        ],
        reportOutcome: () => {},
      };

      const executor = new JsonRpcBatchExecutor({
        pool: pool as any,
        transport: new ArchiveRpcTransport({ httpTransport: transport }),
      });

      const res = await executor.executeBatch([
        { id: 1, method: "eth_call", params: [] },
        { id: 2, method: "eth_call", params: [] },
      ]);

      // Successfully failed over to node 2
      expect(callCount).toBe(2);
      expect(res[0]?.success).toBe(true);
      expect(res[0]?.result).toBe("0x42");
      expect(res[1]?.success).toBe(true);
      expect(res[1]?.result).toBe("0x42");
    });

    it("does NOT fail over when failure is a smart contract execution revert", async () => {
      let callCount = 0;
      const transport: HttpTransport = {
        async request(req) {
          callCount += 1;
          const body = req.body as { id: number }[];
          // Revert is a contract application error, NOT a node failure!
          return {
            status: 200,
            headers: {},
            body: body.map((it) => ({
              jsonrpc: "2.0",
              id: it.id,
              error: { code: 3, message: "execution reverted: ERC20: insufficient allowance" },
            })),
          };
        },
      };

      const pool = {
        chainId: 1,
        healthySnapshot: () => [
          { id: "node-1", url: "https://node1.example.com" },
          { id: "node-2", url: "https://node2.example.com" },
        ],
        reportOutcome: () => {},
      };

      const executor = new JsonRpcBatchExecutor({
        pool: pool as any,
        transport: new ArchiveRpcTransport({ httpTransport: transport }),
      });

      const res = await executor.executeBatch([
        { id: 1, method: "eth_call", params: [] },
      ]);

      // Should not retry node 2 because contract revert is legitimate
      expect(callCount).toBe(1);
      expect(res[0]?.success).toBe(false);
      expect(res[0]?.error?.message).toContain("execution reverted");
    });
  });

  describe("2. IPv6 [::1] Localhost Support", () => {
    it("allows IPv6 localhost http://[::1]:8545 without allowInsecureHttp", async () => {
      const mockTransport = new RecordingHttpTransport();
      const transport = new ArchiveRpcTransport({ httpTransport: mockTransport });

      await expect(
        transport.call({
          endpointUrl: "http://[::1]:8545",
          method: "eth_chainId",
          params: [],
          timeoutMs: 1000,
        }),
      ).resolves.toBe("0x1");
    });
  });

  describe("3. Custom Headers Forwarding for Private/Authenticated RPCs", () => {
    it("forwards custom headers from RpcEndpoint to HTTP transport", async () => {
      const mockTransport = new RecordingHttpTransport();
      const transport = new ArchiveRpcTransport({ httpTransport: mockTransport });

      const pool = new RpcPool({
        chainId: 1,
        endpoints: [
          {
            id: "auth-node",
            url: "https://auth-node.example.com",
            headers: { Authorization: "Bearer test-token-123", "X-Custom-Key": "custom-val" },
          },
        ],
        transport,
      });

      await pool.initialize();

      expect(mockTransport.requests.length).toBeGreaterThan(0);
      const req = mockTransport.requests[0]!;
      expect(req.headers?.Authorization).toBe("Bearer test-token-123");
      expect(req.headers?.["X-Custom-Key"]).toBe("custom-val");
    });
  });

  describe("4. Disqualification of Wrong-Chain Endpoints from Fallback", () => {
    it("never falls back to an endpoint whose chainId failed verification", async () => {
      const transport: HttpTransport = {
        async request(req) {
          const body = req.body as { method: string; id: number };
          if (body.method === "eth_chainId") {
            // Node returns chainId 56 (BSC) when pool expects chainId 1 (Ethereum)
            return { status: 200, headers: {}, body: { jsonrpc: "2.0", id: body.id, result: "0x38" } };
          }
          return { status: 200, headers: {}, body: { jsonrpc: "2.0", id: 1, result: "0x1" } };
        },
      };

      const pool = new RpcPool({
        chainId: 1,
        endpoints: [{ id: "bad-chain-ep", url: "https://bad-chain.example.com" }],
        transport: new ArchiveRpcTransport({ httpTransport: transport }),
      });

      await pool.initialize();

      // Normal healthy snapshot is empty
      expect(pool.healthySnapshot()).toHaveLength(0);

      // Fallback must NOT return the bad chain endpoint!
      const fallbackSnapshot = pool.healthySnapshot(undefined, { fallbackToEarliestExpiring: true });
      expect(fallbackSnapshot).toHaveLength(0);
    });
  });

  describe("5. True LRU Cache Eviction & Near-Head Reorg Protection", () => {
    it("refreshes key recency on get for true LRU eviction", () => {
      const storage = new SqliteStorageAdapter({ path: ":memory:" });
      // Max 2 entries in L1 memory cache
      const cache = new RpcCacheService(storage, { maxMemoryEntries: 2 });
      const now = 1000;

      cache.set(1, "k1", [], "val1", { now });
      cache.set(1, "k2", [], "val2", { now });

      // Access k1 -> refreshes k1 to MRU (most recently used)
      expect(cache.get(1, "k1", [], { now })).toBe("val1");

      // Insert k3 -> exceeds capacity 2, so k2 (LRU) must be evicted, k1 must be retained!
      cache.set(1, "k3", [], "val3", { now });

      // Clear disk table to ensure L1 memory cache is tested directly
      storage.run("DELETE FROM evm_rpc_cache");

      expect(cache.get(1, "k1", [], { now })).toBe("val1"); // retained in L1!
      expect(cache.get(1, "k2", [], { now })).toBeNull();   // evicted from L1!
      expect(cache.get(1, "k3", [], { now })).toBe("val3"); // present in L1!
    });

    it("treats near-head unconfirmed blocks as volatile cache rather than 30-day historical", () => {
      const storage = new SqliteStorageAdapter({ path: ":memory:" });
      const cache = new RpcCacheService(storage, {
        finalityThresholdBlocks: 64,
        volatileTtlMs: 10_000,
        historicalTtlMs: 86_400_000,
      });

      // Latest head is 20,000,000.
      // Block 19,999,990 is only 10 blocks ago (< 64 finality threshold) -> must NOT be historical!
      const nearHead = cache.classifyRequest("eth_call", ["0xabc", "19999990"], {
        latestBlockNumber: 20_000_000n,
      });
      expect(nearHead.isHistorical).toBe(false);

      // Block 19,999,000 is 1000 blocks ago (> 64 finality threshold) -> historical!
      const confirmed = cache.classifyRequest("eth_call", ["0xabc", "19999000"], {
        latestBlockNumber: 20_000_000n,
      });
      expect(confirmed.isHistorical).toBe(true);
    });

    it("does not cache null transactions or receipts", () => {
      const storage = new SqliteStorageAdapter({ path: ":memory:" });
      const cache = new RpcCacheService(storage);

      // Pending transaction receipt returns null -> must not cache!
      cache.set(1, "eth_getTransactionReceipt", ["0xhash1"], null);
      expect(cache.get(1, "eth_getTransactionReceipt", ["0xhash1"])).toBeNull();

      // Mined transaction receipt with blockNumber -> should be cached
      cache.set(1, "eth_getTransactionReceipt", ["0xhash2"], { status: "0x1", blockNumber: "0x100" });
      expect(cache.get(1, "eth_getTransactionReceipt", ["0xhash2"])).toBeDefined();
    });
  });

  describe("6. Defensive formatBlockTag and toBlockNumberBigInt", () => {
    it("rejects negative block numbers in client calls", async () => {
      const client = new EvmCallClient({
        customRpcUrls: ["https://mock.rpc"],
        storageAdapter: new SqliteStorageAdapter({ path: ":memory:" }),
      });

      await expect(client.getBlock(-1)).rejects.toThrow(/cannot be negative/);
      await expect(client.getBlock("-5")).rejects.toThrow(/cannot be negative/);

      client.close();
    });
  });

  describe("7. Network Timeout does not trigger log adaptive range halving", () => {
    it("aborts instead of endlessly halving on network timeout", async () => {
      let callCount = 0;
      const transport: HttpTransport = {
        async request() {
          callCount += 1;
          // Simulates network timeout
          throw new HttpTransportError({
            code: "REQUEST_TIMEOUT",
            message: "Archive RPC request timed out.",
            retryable: true,
          });
        },
      };

      const client = new EvmCallClient({
        customRpcUrls: ["https://mock.rpc"],
        storageAdapter: new SqliteStorageAdapter({ path: ":memory:" }),
        transport: new ArchiveRpcTransport({ httpTransport: transport }),
      });

      // Query across 10,000 blocks with network timeouts
      await expect(
        client.getLogsChunked(
          { fromBlock: 1000n, toBlock: 11000n },
          { adaptiveChunking: true },
        ),
      ).rejects.toThrow(/timed out/i);

      // Should not endlessly divide range into dozens of queries
      expect(callCount).toBeLessThanOrEqual(6);

      client.close();
    });
  });
});
