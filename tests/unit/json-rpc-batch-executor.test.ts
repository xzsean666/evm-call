import { describe, expect, it, vi } from "vitest";

import { SqliteStorageAdapter } from "../../src/storage/SqliteStorageAdapter";
import { RpcCacheService } from "../../src/storage/RpcCacheService";
import {
  JsonRpcBatchExecutor,
  type RpcEndpointLike,
  type RpcPoolLike,
} from "../../src/batch/JsonRpcBatchExecutor";
import { ArchiveRpcTransport } from "../../src/transport/ArchiveRpcTransport";
import { type HttpTransport, type HttpResponse, HttpTransportError } from "../../src/transport/HttpTransport";

class MockHttpTransport implements HttpTransport {
  public handler: (url: string, body: unknown) => Promise<{ status: number; body: unknown }>;

  constructor(handler: (url: string, body: unknown) => Promise<{ status: number; body: unknown }>) {
    this.handler = handler;
  }

  async request(req: { url: string; body?: unknown }): Promise<HttpResponse> {
    const res = await this.handler(req.url, req.body);
    return {
      status: res.status,
      headers: { "content-type": "application/json" },
      body: res.body,
    };
  }
}

function createMockPool(endpoints: RpcEndpointLike[]): {
  pool: RpcPoolLike;
  reported: { id: string; outcome: "success" | "failure" }[];
} {
  const reported: { id: string; outcome: "success" | "failure" }[] = [];
  return {
    pool: {
      chainId: 1,
      healthySnapshot: () => [...endpoints],
      reportOutcome: (id, outcome) => {
        reported.push({ id, outcome });
      },
    },
    reported,
  };
}

describe("JsonRpcBatchExecutor", () => {
  it("executes requests hitting cache and network transparently, merging in order", async () => {
    const storage = new SqliteStorageAdapter({ path: ":memory:" });
    const cacheService = new RpcCacheService(storage);

    // Pre-populate cache for block 1000
    cacheService.set(1, "eth_getBlockByNumber", ["0x3e8", false], { number: "0x3e8", hash: "0xaaa" });

    const requestsSent: unknown[] = [];
    const mockHttp = new MockHttpTransport(async (_url, body) => {
      requestsSent.push(body);
      const reqArray = body as { id: string | number; method: string; params: unknown[] }[];
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: reqArray.map((r) => ({
          jsonrpc: "2.0",
          id: r.id,
          result: `result_for_${r.method}_${JSON.stringify(r.params)}`,
        })),
      };
    });

    const transport = new ArchiveRpcTransport({ httpTransport: mockHttp });
    const { pool, reported } = createMockPool([{ id: "ep1", url: "https://rpc1.example.com" }]);

    const executor = new JsonRpcBatchExecutor({
      pool,
      cacheService,
      transport,
    });

    const results = await executor.executeBatch([
      { id: "req-1", method: "eth_getBlockByNumber", params: ["0x3e8", false] }, // Hit cache!
      { id: "req-2", method: "eth_getBlockByNumber", params: ["0x3e9", false] }, // Miss
      { id: "req-3", method: "eth_getBalance", params: ["0x123", "0x3e9"] },     // Miss
    ]);

    expect(results).toHaveLength(3);
    // Req 1 from cache
    expect(results[0]).toEqual({
      id: "req-1",
      success: true,
      result: { number: "0x3e8", hash: "0xaaa" },
    });
    // Req 2 from network
    expect(results[1]?.success).toBe(true);
    expect(results[1]?.id).toBe("req-2");
    // Req 3 from network
    expect(results[2]?.success).toBe(true);
    expect(results[2]?.id).toBe("req-3");

    // Check that only req-2 and req-3 were sent via network
    expect(requestsSent).toHaveLength(1);
    const sentBatch = requestsSent[0] as { id: string | number }[];
    expect(sentBatch).toHaveLength(2);
    expect(sentBatch.map((s) => s.id)).toEqual(["req-2", "req-3"]);

    // Check that outcome was reported
    expect(reported).toEqual([{ id: "ep1", outcome: "success" }]);

    // Check that req-2 and req-3 are now cached
    const cachedReq2 = cacheService.get(1, "eth_getBlockByNumber", ["0x3e9", false]);
    expect(cachedReq2).toBeDefined();
    expect(cachedReq2).toContain("0x3e9");
  });

  it("bypasses cache when cacheTtlMs is 0", async () => {
    const storage = new SqliteStorageAdapter({ path: ":memory:" });
    const cacheService = new RpcCacheService(storage);

    cacheService.set(1, "eth_blockNumber", [], "0x100");

    let networkCallCount = 0;
    const mockHttp = new MockHttpTransport(async (_url, body) => {
      networkCallCount += 1;
      const reqArray = body as { id: string | number }[];
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: reqArray.map((r) => ({
          jsonrpc: "2.0",
          id: r.id,
          result: "0x101",
        })),
      };
    });

    const transport = new ArchiveRpcTransport({ httpTransport: mockHttp });
    const { pool } = createMockPool([{ id: "ep1", url: "https://rpc1.example.com" }]);

    const executor = new JsonRpcBatchExecutor({ pool, cacheService, transport });

    const results = await executor.executeBatch(
      [{ id: 1, method: "eth_blockNumber", params: [] }],
      { cacheTtlMs: 0 },
    );

    expect(networkCallCount).toBe(1);
    expect(results[0]?.result).toBe("0x101");
  });

  it("chunks large requests and executes with bounded concurrency", async () => {
    let chunkCount = 0;
    const mockHttp = new MockHttpTransport(async (_url, body) => {
      chunkCount += 1;
      const reqArray = body as { id: string | number }[];
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: reqArray.map((r) => ({
          jsonrpc: "2.0",
          id: r.id,
          result: `val_${r.id}`,
        })),
      };
    });

    const transport = new ArchiveRpcTransport({ httpTransport: mockHttp });
    const { pool } = createMockPool([{ id: "ep1", url: "https://rpc1.example.com" }]);

    const executor = new JsonRpcBatchExecutor({ pool, transport });

    const requests = Array.from({ length: 5 }, (_, i) => ({
      id: `req-${i}`,
      method: "eth_call",
      params: [{ to: `0x${i}`, data: "0x" }, "latest"],
    }));

    const results = await executor.executeBatch(requests, {
      batchChunkSize: 2,
      maxConcurrency: 2,
    });

    // 5 items chunked by 2 => 3 chunks ([2, 2, 1])
    expect(chunkCount).toBe(3);
    expect(results).toHaveLength(5);
    for (let i = 0; i < 5; i += 1) {
      expect(results[i]?.id).toBe(`req-${i}`);
      expect(results[i]?.result).toBe(`val_req-${i}`);
    }
  });

  it("correctly matches shuffled/out-of-order responses from node", async () => {
    const mockHttp = new MockHttpTransport(async (_url, body) => {
      const reqArray = body as { id: string | number }[];
      // Return in reverse order
      const reversed = [...reqArray].reverse();
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: reversed.map((r) => ({
          jsonrpc: "2.0",
          id: r.id,
          result: `reversed_${r.id}`,
        })),
      };
    });

    const transport = new ArchiveRpcTransport({ httpTransport: mockHttp });
    const { pool } = createMockPool([{ id: "ep1", url: "https://rpc1.example.com" }]);

    const executor = new JsonRpcBatchExecutor({ pool, transport });

    const results = await executor.executeBatch([
      { id: "first", method: "eth_blockNumber" },
      { id: "second", method: "eth_blockNumber" },
      { id: "third", method: "eth_blockNumber" },
    ]);

    expect(results[0]?.id).toBe("first");
    expect(results[0]?.result).toBe("reversed_first");
    expect(results[1]?.id).toBe("second");
    expect(results[1]?.result).toBe("reversed_second");
    expect(results[2]?.id).toBe("third");
    expect(results[2]?.result).toBe("reversed_third");
  });

  it("fails over to next healthy endpoint when first endpoint encounters retryable error", async () => {
    const triedUrls: string[] = [];
    const mockHttp = new MockHttpTransport(async (url, body) => {
      triedUrls.push(url);
      if (url.includes("rpc1")) {
        throw new HttpTransportError({
          code: "NETWORK_ERROR",
          message: "Rate limit exceeded (429)",
          status: 429,
          retryable: true,
        });
      }
      const reqArray = body as { id: string | number }[];
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: reqArray.map((r) => ({
          jsonrpc: "2.0",
          id: r.id,
          result: "recovered_from_ep2",
        })),
      };
    });

    const transport = new ArchiveRpcTransport({ httpTransport: mockHttp });
    const { pool, reported } = createMockPool([
      { id: "ep1", url: "https://rpc1.example.com" },
      { id: "ep2", url: "https://rpc2.example.com" },
    ]);

    const executor = new JsonRpcBatchExecutor({ pool, transport });

    const results = await executor.executeBatch([
      { id: "q1", method: "eth_blockNumber" },
    ]);

    expect(results[0]?.result).toBe("recovered_from_ep2");
    expect(triedUrls).toEqual(["https://rpc1.example.com", "https://rpc2.example.com"]);
    expect(reported).toEqual([
      { id: "ep1", outcome: "failure" },
      { id: "ep2", outcome: "success" },
    ]);
  });

  it("throws archiveRpcUnavailable when pool has no healthy endpoints", async () => {
    const { pool } = createMockPool([]);
    const executor = new JsonRpcBatchExecutor({ pool });

    await expect(
      executor.executeBatch([{ id: 1, method: "eth_blockNumber" }]),
    ).rejects.toThrow(/No healthy RPC endpoint/);
  });

  it("executeStrictBatch returns unwrapped results on success and throws on error", async () => {
    const mockHttp = new MockHttpTransport(async (_url, body) => {
      const reqArray = body as { id: string | number; method: string }[];
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: reqArray.map((r) => {
          if (r.id === "bad") {
            return {
              jsonrpc: "2.0",
              id: r.id,
              error: { code: -32000, message: "execution reverted" },
            };
          }
          return {
            jsonrpc: "2.0",
            id: r.id,
            result: `ok_${r.id}`,
          };
        }),
      };
    });

    const transport = new ArchiveRpcTransport({ httpTransport: mockHttp });
    const { pool } = createMockPool([{ id: "ep1", url: "https://rpc1.example.com" }]);

    const executor = new JsonRpcBatchExecutor({ pool, transport });

    // Success case
    const strictSuccess = await executor.executeStrictBatch([
      { id: "req-1", method: "eth_blockNumber" },
      { id: "req-2", method: "eth_blockNumber" },
    ]);
    expect(strictSuccess).toEqual(["ok_req-1", "ok_req-2"]);

    // Failure case
    await expect(
      executor.executeStrictBatch([
        { id: "req-1", method: "eth_blockNumber" },
        { id: "bad", method: "eth_call" },
      ]),
    ).rejects.toThrow(/execution reverted/);
  });

  it("call provides single request convenience wrapper", async () => {
    const mockHttp = new MockHttpTransport(async (_url, _body) => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: [{ jsonrpc: "2.0", id: 1, result: "0x12345" }],
    }));

    const transport = new ArchiveRpcTransport({ httpTransport: mockHttp });
    const { pool } = createMockPool([{ id: "ep1", url: "https://rpc1.example.com" }]);

    const executor = new JsonRpcBatchExecutor({ pool, transport });

    const res = await executor.call<string>({ id: 1, method: "eth_blockNumber" });
    expect(res).toBe("0x12345");
  });

  it("returns empty array immediately when request list is empty", async () => {
    const { pool } = createMockPool([{ id: "ep1", url: "https://rpc1.example.com" }]);
    const executor = new JsonRpcBatchExecutor({ pool });

    const res = await executor.executeBatch([]);
    expect(res).toEqual([]);
  });
});
