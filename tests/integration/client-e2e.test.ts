import { describe, expect, it } from "vitest";

import {
  EvmCallClient,
  SqliteStorageAdapter,
  ArchiveRpcTransport,
  RpcPool,
  JsonRpcBatchExecutor,
  EthereumArchiveRpcExecutor,
  type HttpTransport,
  type HttpResponse,
  HttpTransportError,
} from "../../src";

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

const BLOCK_HASH = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function wordUint(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

function wordBool(value: boolean): string {
  return wordUint(value ? 1n : 0n);
}

function encodeAggregate3Result(tuples: readonly { success: boolean; data: string }[]): string {
  const dataHexes = tuples.map((tuple) => tuple.data.replace(/^0x/, ""));
  const tupleBodies = dataHexes.map((dataHex) => {
    const lengthBytes = dataHex.length / 2;
    const padded = dataHex.padEnd(Math.ceil(dataHex.length / 64) * 64, "0");
    return { lengthBytes, padded };
  });

  let offset = BigInt(tuples.length * 32);
  const offsets: string[] = [];
  const bodies: string[] = [];
  tuples.forEach((tuple, index) => {
    offsets.push(wordUint(offset));
    const body = tupleBodies[index]!;
    const encodedTuple = `${wordBool(tuple.success)}${wordUint(64n)}${wordUint(BigInt(body.lengthBytes))}${body.padded}`;
    bodies.push(encodedTuple);
    offset += BigInt(encodedTuple.length / 2);
  });

  return `0x${wordUint(32n)}${wordUint(BigInt(tuples.length))}${offsets.join("")}${bodies.join("")}`;
}

describe("E2E Integration Tests", () => {
  it("verifies 10s short-term cache hit and TTL expiration", async () => {
    let mockTime = 1_000_000;
    let networkCallCount = 0;

    const mockHttp = new MockHttpTransport(async (_url, body) => {
      const isBatch = Array.isArray(body);
      const reqs = isBatch
        ? (body as { id: string | number; method: string }[])
        : [body as { id: string | number; method: string }];

      networkCallCount += 1;
      const responses = reqs.map((r) => {
        if (r.method === "eth_chainId") return { jsonrpc: "2.0", id: r.id, result: "0x1" };
        if (r.method === "eth_getBlockByNumber") {
          return {
            jsonrpc: "2.0",
            id: r.id,
            result: { number: "0x112a880", hash: BLOCK_HASH, timestamp: "0x60000000" },
          };
        }
        return { jsonrpc: "2.0", id: r.id, result: `block_${mockTime}` };
      });

      return { status: 200, body: isBatch ? responses : responses[0] };
    });

    const storageAdapter = new SqliteStorageAdapter({ path: ":memory:" });
    const transport = new ArchiveRpcTransport({ httpTransport: mockHttp });

    const client = new EvmCallClient({
      chainId: 1,
      storageAdapter,
      customRpcUrls: ["https://rpc1.example.com"],
      transport,
      now: () => mockTime,
    });

    // 1. Initial call -> hits network
    const call1 = await client.call<string>({ id: 1, method: "eth_blockNumber" });
    expect(call1).toBe("block_1000000");
    const countAfterCall1 = networkCallCount;

    // 2. Call at now + 5s -> should HIT cache, no network traffic
    mockTime += 5_000;
    const call2 = await client.call<string>({ id: 1, method: "eth_blockNumber" });
    expect(call2).toBe("block_1000000");
    expect(networkCallCount).toBe(countAfterCall1);

    // 3. Call at now + 11s (> 10s TTL) -> cache expired, hits network
    mockTime += 6_000; // now = 1011000
    const call3 = await client.call<string>({ id: 1, method: "eth_blockNumber" });
    expect(call3).toBe("block_1011000");
    expect(networkCallCount).toBeGreaterThan(countAfterCall1);

    client.close();
  });

  it("verifies long-term historical cache and cleanExpiredCache", async () => {
    let mockTime = 1_000_000;
    const THIRTY_DAYS_MS = 30 * 86_400 * 1000;

    const storageAdapter = new SqliteStorageAdapter({ path: ":memory:" });
    const client = new EvmCallClient({
      chainId: 1,
      storageAdapter,
      now: () => mockTime,
    });

    // Set historical state (block 500000)
    client.cacheService.set(1, "eth_getBalance", ["0x123", "0x7a120"], "1000", { now: mockTime });

    // Verify it hits at 10 days
    const hit10Days = client.cacheService.get(1, "eth_getBalance", ["0x123", "0x7a120"], {
      now: mockTime + 10 * 86_400 * 1000,
    });
    expect(hit10Days).toBe("1000");

    // Clean at 29 days -> should not be removed
    const cleanedBefore = client.cleanExpiredCache(mockTime + THIRTY_DAYS_MS - 1000);
    expect(cleanedBefore).toBe(0);

    // Clean at 31 days -> should be expired and removed
    const cleanedAfter = client.cleanExpiredCache(mockTime + THIRTY_DAYS_MS + 1000);
    expect(cleanedAfter).toBe(1);

    // Verify it is gone
    const hitAfter = client.cacheService.get(1, "eth_getBalance", ["0x123", "0x7a120"], {
      now: mockTime + THIRTY_DAYS_MS + 1000,
    });
    expect(hitAfter).toBeNull();

    client.close();
  });

  it("verifies batch chunking and failover across healthy endpoints", async () => {
    const attemptedUrls: string[] = [];
    let chunksProcessed = 0;

    const mockHttp = new MockHttpTransport(async (url, body) => {
      attemptedUrls.push(url);
      const isBatch = Array.isArray(body);
      const reqs = isBatch
        ? (body as { id: string | number; method: string }[])
        : [body as { id: string | number; method: string }];

      // Probe endpoints
      if (!isBatch && reqs[0]?.method === "eth_chainId") {
        return { status: 200, body: { jsonrpc: "2.0", id: reqs[0].id, result: "0x1" } };
      }
      if (!isBatch && reqs[0]?.method === "eth_getBlockByNumber") {
        return {
          status: 200,
          body: {
            jsonrpc: "2.0",
            id: reqs[0].id,
            result: { number: "0x112a880", hash: BLOCK_HASH, timestamp: "0x60000000" },
          },
        };
      }

      // If rpc1 is called for batch, simulate 429 rate limit
      if (url.includes("rpc1")) {
        throw new HttpTransportError({
          code: "NETWORK_ERROR",
          message: "Too Many Requests",
          status: 429,
          retryable: true,
        });
      }

      chunksProcessed += 1;
      return {
        status: 200,
        body: reqs.map((r) => ({ jsonrpc: "2.0", id: r.id, result: `data_${r.id}` })),
      };
    });

    const storageAdapter = new SqliteStorageAdapter({ path: ":memory:" });
    const transport = new ArchiveRpcTransport({ httpTransport: mockHttp });
    const pool = new RpcPool({
      chainId: 1,
      endpoints: ["https://rpc1.example.com", "https://rpc2.example.com"],
      transport,
    });
    const batchExecutor = new JsonRpcBatchExecutor({ pool, transport });

    const client = new EvmCallClient({
      chainId: 1,
      storageAdapter,
      pool,
      batchExecutor,
    });

    // 10 items chunked by 5 => 2 chunks
    const requests = Array.from({ length: 10 }, (_, i) => ({
      id: `req-${i}`,
      method: "eth_blockNumber",
    }));

    const results = await client.batch(requests, {
      batchChunkSize: 5,
      cacheTtlMs: 0,
    });

    expect(results).toHaveLength(10);
    expect(results[0]?.result).toBe("data_req-0");
    expect(results[9]?.result).toBe("data_req-9");
    expect(chunksProcessed).toBe(2);

    client.close();
  });

  it("verifies Multicall3 ERC-20 batch reads and error propagation", async () => {
    const mockHttp = new MockHttpTransport(async (_url, body) => {
      const isBatch = Array.isArray(body);
      const reqs = isBatch
        ? (body as { id: string | number; method: string; params?: unknown[] }[])
        : [body as { id: string | number; method: string; params?: unknown[] }];

      const responses = reqs.map((req) => {
        if (req.method === "eth_chainId") {
          return { jsonrpc: "2.0", id: req.id, result: "0x1" };
        }
        if (req.method === "eth_getBlockByNumber") {
          const tag = (req.params?.[0] as string) ?? "0x112a880";
          const num = tag === "latest" ? "0x112a880" : tag;
          return {
            jsonrpc: "2.0",
            id: req.id,
            result: { number: num, hash: BLOCK_HASH, timestamp: "0x60000000" },
          };
        }
        if (req.method === "eth_call") {
          return {
            jsonrpc: "2.0",
            id: req.id,
            result: encodeAggregate3Result([
              { success: true, data: `0x${wordUint(5_000_000n)}` }, // Success
              { success: false, data: "0x08c379a0" },                // Revert
            ]),
          };
        }
        throw new Error(`Unexpected ${req.method}`);
      });

      return { status: 200, body: isBatch ? responses : responses[0] };
    });

    const storageAdapter = new SqliteStorageAdapter({ path: ":memory:" });
    const transport = new ArchiveRpcTransport({ httpTransport: mockHttp });
    const pool = new RpcPool({
      chainId: 1,
      endpoints: ["https://rpc1.example.com"],
      transport,
    });
    const archiveExecutor = new EthereumArchiveRpcExecutor({ pool, transport });

    const client = new EvmCallClient({
      chainId: 1,
      storageAdapter,
      pool,
      archiveExecutor,
      multicall3DeploymentBlock: "1000",
    });

    const res = await client.multicallErc20({
      chain: "ethereum",
      blockNumber: "18000000",
      calls: [
        {
          id: "good",
          tokenAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
          method: "balanceOf",
          owner: "0x1111111111111111111111111111111111111111",
        },
        {
          id: "bad",
          tokenAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
          method: "balanceOf",
          owner: "0x2222222222222222222222222222222222222222",
        },
      ],
    });

    expect(res.results).toHaveLength(2);
    expect(res.results[0]?.id).toBe("good");
    expect(res.results[0]?.success).toBe(true);
    expect(res.results[0]?.value).toBe("5000000");

    expect(res.results[1]?.id).toBe("bad");
    expect(res.results[1]?.success).toBe(false);
    expect(res.results[1]?.error).toBe("CALL_FAILED");

    client.close();
  });
});
