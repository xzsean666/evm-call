import { describe, expect, it } from "vitest";

import {
  RpcPool,
  isHistoricalBlockTag,
  requiresArchiveRequest,
  EvmCallClient,
  type RpcEndpoint,
} from "../../src";
import type { HttpTransport, HttpRequest, HttpResponse } from "../../src/transport/HttpTransport";
import { ArchiveRpcTransport } from "../../src/transport/ArchiveRpcTransport";
import type { RandomSource } from "../../src/execution/clock";

const deterministicRandom: RandomSource = { next: () => 0 };

class MockHttpTransport implements HttpTransport {
  readonly calls: { url: string; body: unknown }[] = [];
  responsesByMethod: Record<string, unknown> = {};

  async request(req: HttpRequest): Promise<HttpResponse> {
    const parsed = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    this.calls.push({ url: req.url, body: parsed });

    if (Array.isArray(parsed)) {
      const items = parsed.map((item) => {
        let result: unknown = "0x1";
        if (item.method === "eth_chainId") result = "0x1";
        else if (item.method === "eth_getBlockByNumber") {
          result = {
            hash: "0x" + "a".repeat(64),
            number: item.params[0] === "latest" ? "0x1400000" : item.params[0],
            timestamp: "0x65000000",
          };
        } else if (this.responsesByMethod[item.method] !== undefined) {
          result = this.responsesByMethod[item.method];
        }
        return { jsonrpc: "2.0", id: item.id, result };
      });
      return { status: 200, headers: { "content-type": "application/json" }, body: items };
    }

    let result: unknown = "0x1";
    if (parsed.method === "eth_chainId") {
      result = "0x1";
    } else if (parsed.method === "eth_getBlockByNumber") {
      result = {
        hash: "0x" + "a".repeat(64),
        number: parsed.params[0] === "latest" ? "0x1400000" : parsed.params[0],
        timestamp: "0x65000000",
      };
    } else if (this.responsesByMethod[parsed.method] !== undefined) {
      result = this.responsesByMethod[parsed.method];
    }

    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: { jsonrpc: "2.0", id: parsed.id ?? 1, result },
    };
  }
}

describe("RPC Endpoint Tags & Intelligent Routing", () => {
  describe("Default tag assignment and tagging", () => {
    it("defaults to 'archive' tag when tag is omitted or endpoint is a string URL", () => {
      const pool = new RpcPool({
        chainId: 1,
        endpoints: [
          "https://eth-node-1.example.com",
          { id: "node-2", url: "https://eth-node-2.example.com" },
          { id: "node-3", url: "https://eth-node-3.example.com", tag: "full" },
          { id: "node-4", url: "https://eth-node-4.example.com", tag: "archive" },
        ],
      });

      const endpoints = pool.getEndpoints();
      expect(endpoints).toHaveLength(4);
      expect(endpoints[0]?.tag).toBe("archive");
      expect(endpoints[1]?.tag).toBe("archive");
      expect(endpoints[2]?.tag).toBe("full");
      expect(endpoints[3]?.tag).toBe("archive");

      const states = pool.getAllCooldownStates();
      expect(states.find((s) => s.id === "node-3")?.tag).toBe("full");
      expect(states.find((s) => s.id === "node-4")?.tag).toBe("archive");
    });
  });

  describe("Health check probing by tag", () => {
    it("probes 'latest' for full nodes and probeBlockNumber for archive nodes", async () => {
      const mockHttp = new MockHttpTransport();
      const transport = new ArchiveRpcTransport({ httpTransport: mockHttp });

      const pool = new RpcPool({
        chainId: 1,
        probeBlockNumber: 18_000_000n,
        endpoints: [
          { id: "arch-node", url: "https://arch.example.com", tag: "archive" },
          { id: "full-node", url: "https://full.example.com", tag: "full" },
        ],
        transport,
      });

      await pool.initialize();

      expect(pool.isHealthy("arch-node")).toBe(true);
      expect(pool.isHealthy("full-node")).toBe(true);

      const archCalls = mockHttp.calls.filter((c) => c.url === "https://arch.example.com");
      const fullCalls = mockHttp.calls.filter((c) => c.url === "https://full.example.com");

      // Archive node was probed with 18000000 (0x112a880)
      const archGetBlock = archCalls.find((c: any) => c.body.method === "eth_getBlockByNumber");
      expect((archGetBlock?.body as any).params[0]).toBe("0x112a880");

      // Full node was probed with "latest"
      const fullGetBlock = fullCalls.find((c: any) => c.body.method === "eth_getBlockByNumber");
      expect((fullGetBlock?.body as any).params[0]).toBe("latest");
    });
  });

  describe("Intelligent healthy snapshot routing", () => {
    it("routes archive requests only to archive endpoints, and non-archive requests prefer full endpoints", async () => {
      const pool = new RpcPool({
        chainId: 1,
        endpoints: [
          { id: "arch-1", url: "https://arch-1.example.com", tag: "archive" },
          { id: "arch-2", url: "https://arch-2.example.com", tag: "archive" },
          { id: "full-1", url: "https://full-1.example.com", tag: "full" },
          { id: "full-2", url: "https://full-2.example.com", tag: "full" },
        ],
      });

      // Mock them all as healthy
      (pool as any).healthy.set("arch-1", true);
      (pool as any).healthy.set("arch-2", true);
      (pool as any).healthy.set("full-1", true);
      (pool as any).healthy.set("full-2", true);

      // 1. Archive required -> only archive nodes returned
      const archiveSnapshot = pool.healthySnapshot(deterministicRandom, { requireArchive: true });
      expect(archiveSnapshot.map((ep) => ep.id).sort()).toEqual(["arch-1", "arch-2"]);

      // 2. Non-archive request -> prefers full nodes
      const nonArchiveSnapshot = pool.healthySnapshot(deterministicRandom, { requireArchive: false });
      expect(nonArchiveSnapshot.map((ep) => ep.id).sort()).toEqual(["full-1", "full-2"]);

      // 3. Fallback when all full nodes are in CD -> falls back to archive nodes
      pool.reportOutcome("full-1", "failure", 1000);
      pool.reportOutcome("full-2", "failure", 1000);
      expect(pool.isHealthy("full-1", 1000)).toBe(false);
      expect(pool.isHealthy("full-2", 1000)).toBe(false);

      const fallbackSnapshot = pool.healthySnapshot(deterministicRandom, { requireArchive: false }, 1000);
      expect(fallbackSnapshot.map((ep) => ep.id).sort()).toEqual(["arch-1", "arch-2"]);

      // 4. Specific tag filter
      expect(pool.healthySnapshot(deterministicRandom, { tag: "full" }, 1000)).toHaveLength(0);
      // At t=70_000 (after 60s cooldown tier), nodes are no longer cooling down
      expect(pool.healthySnapshot(deterministicRandom, { tag: "full" }, 70_000).map((e) => e.id).sort()).toEqual([
        "full-1",
        "full-2",
      ]);

      // 5. When preferFull is false: normal calls pool all healthy full and archive nodes together
      const mixedSnapshot = pool.healthySnapshot(deterministicRandom, { requireArchive: false, preferFull: false }, 70_000);
      expect(mixedSnapshot.map((ep) => ep.id).sort()).toEqual(["arch-1", "arch-2", "full-1", "full-2"]);
    });

    it("handles normal calls seamlessly when pool only contains archive endpoints", () => {
      const pool = new RpcPool({
        chainId: 1,
        endpoints: [
          { id: "arch-1", url: "https://arch-1.example.com", tag: "archive" },
          { id: "arch-2", url: "https://arch-2.example.com", tag: "archive" },
        ],
      });
      (pool as any).healthy.set("arch-1", true);
      (pool as any).healthy.set("arch-2", true);

      // Both archive calls and non-archive calls route to the archive nodes
      const nonArchSnapshot = pool.healthySnapshot(deterministicRandom, { requireArchive: false });
      expect(nonArchSnapshot.map((ep) => ep.id).sort()).toEqual(["arch-1", "arch-2"]);

      const archSnapshot = pool.healthySnapshot(deterministicRandom, { requireArchive: true });
      expect(archSnapshot.map((ep) => ep.id).sort()).toEqual(["arch-1", "arch-2"]);
    });
  });

  describe("Request classification helpers", () => {
    it("isHistoricalBlockTag correctly classifies blocks", () => {
      // Non-historical tags
      expect(isHistoricalBlockTag("latest")).toBe(false);
      expect(isHistoricalBlockTag("pending")).toBe(false);
      expect(isHistoricalBlockTag("safe")).toBe(false);
      expect(isHistoricalBlockTag("finalized")).toBe(false);
      expect(isHistoricalBlockTag(undefined)).toBe(false);
      expect(isHistoricalBlockTag(null)).toBe(false);

      // Historical tags
      expect(isHistoricalBlockTag("earliest")).toBe(true);
      expect(isHistoricalBlockTag("0x112a880")).toBe(true);
      expect(isHistoricalBlockTag("18000000")).toBe(true);
      expect(isHistoricalBlockTag(18_000_000)).toBe(true);
      expect(isHistoricalBlockTag(18_000_000n)).toBe(true);
    });

    it("requiresArchiveRequest correctly inspects EVM JSON-RPC calls", () => {
      // Methods that do not need archive
      expect(requiresArchiveRequest({ method: "eth_blockNumber" })).toBe(false);
      expect(requiresArchiveRequest({ method: "eth_gasPrice" })).toBe(false);
      expect(requiresArchiveRequest({ method: "eth_chainId" })).toBe(false);
      expect(requiresArchiveRequest({ method: "eth_getTransactionReceipt", params: ["0x123"] })).toBe(false);
      expect(requiresArchiveRequest({ method: "eth_getTransactionByHash", params: ["0x123"] })).toBe(false);

      // eth_call: latest vs historical
      expect(requiresArchiveRequest({ method: "eth_call", params: [{ to: "0x123" }, "latest"] })).toBe(false);
      expect(requiresArchiveRequest({ method: "eth_call", params: [{ to: "0x123" }] })).toBe(false);
      expect(requiresArchiveRequest({ method: "eth_call", params: [{ to: "0x123" }, "0x112a880"] })).toBe(true);

      // eth_getBalance: latest vs historical
      expect(requiresArchiveRequest({ method: "eth_getBalance", params: ["0x123", "latest"] })).toBe(false);
      expect(requiresArchiveRequest({ method: "eth_getBalance", params: ["0x123", 18_000_000] })).toBe(true);

      // eth_getStorageAt: latest vs historical
      expect(requiresArchiveRequest({ method: "eth_getStorageAt", params: ["0x123", "0x0", "latest"] })).toBe(false);
      expect(requiresArchiveRequest({ method: "eth_getStorageAt", params: ["0x123", "0x0", "0x1000"] })).toBe(true);

      // eth_getLogs: latest vs historical
      expect(requiresArchiveRequest({ method: "eth_getLogs", params: [{ address: "0x123" }] })).toBe(false);
      expect(requiresArchiveRequest({ method: "eth_getLogs", params: [{ fromBlock: "latest" }] })).toBe(false);
      expect(requiresArchiveRequest({ method: "eth_getLogs", params: [{ fromBlock: "0x1000", toBlock: "0x1050" }] })).toBe(true);
    });
  });

  describe("EvmCallClient end-to-end intelligent routing", () => {
    it("automatically dispatches latest calls to full nodes and historical calls to archive nodes", async () => {
      const mockHttp = new MockHttpTransport();
      mockHttp.responsesByMethod["eth_gasPrice"] = "0x4a817c800";
      mockHttp.responsesByMethod["eth_getCode"] = "0x60806040";

      const transport = new ArchiveRpcTransport({ httpTransport: mockHttp });

      const client = new EvmCallClient({
        chainId: 1,
        transport,
        endpoints: [
          { id: "arch-rpc", url: "https://arch.example.com", tag: "archive" },
          { id: "full-rpc", url: "https://full.example.com", tag: "full" },
        ],
      });

      // Warm up / mark healthy
      (client.pool as any).healthy.set("arch-rpc", true);
      (client.pool as any).healthy.set("full-rpc", true);

      // 1. Non-archive call: getGasPrice -> should route to full-rpc
      const initialCallCount = mockHttp.calls.length;
      await client.getGasPrice({ cacheTtlMs: 0 });
      const gasPriceCall = mockHttp.calls[mockHttp.calls.length - 1];
      expect(gasPriceCall?.url).toBe("https://full.example.com");

      // 2. Non-archive call: getBlock("latest") -> should route to full-rpc
      await client.getBlock("latest", false, { cacheTtlMs: 0 });
      const latestBlockCall = mockHttp.calls[mockHttp.calls.length - 1];
      expect(latestBlockCall?.url).toBe("https://full.example.com");

      // 3. Historical call: getBlock(18_000_000) -> should route to arch-rpc
      await client.getBlock(18_000_000, false, { cacheTtlMs: 0 });
      const histBlockCall = mockHttp.calls[mockHttp.calls.length - 1];
      expect(histBlockCall?.url).toBe("https://arch.example.com");

      // 4. Historical call: getCode at historical block -> should route to arch-rpc
      await client.getCode("0x" + "1".repeat(40), 17_000_000, { cacheTtlMs: 0 });
      const histCodeCall = mockHttp.calls[mockHttp.calls.length - 1];
      expect(histCodeCall?.url).toBe("https://arch.example.com");

      // 5. Latest call: getCode at latest block -> should route to full-rpc
      await client.getCode("0x" + "1".repeat(40), "latest", { cacheTtlMs: 0 });
      const latestCodeCall = mockHttp.calls[mockHttp.calls.length - 1];
      expect(latestCodeCall?.url).toBe("https://full.example.com");

      client.close();
    });
  });
});
