import { describe, expect, it } from "vitest";

import { EvmCallClient, createEvmCallClient } from "../../src/client/EvmCallClient";
import { SqliteStorageAdapter } from "../../src/storage/SqliteStorageAdapter";
import { ArchiveRpcTransport } from "../../src/transport/ArchiveRpcTransport";
import type { HttpTransport, HttpResponse } from "../../src/transport/HttpTransport";
import { RpcPool } from "../../src/pool/RpcPool";
import { JsonRpcBatchExecutor } from "../../src/batch/JsonRpcBatchExecutor";
import { EthereumArchiveRpcExecutor } from "../../src/multicall/EthereumArchiveRpcExecutor";

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

describe("EvmCallClient", () => {
  it("initializes client with defaults and memory storage", () => {
    const storageAdapter = new SqliteStorageAdapter({ path: ":memory:" });
    const client = createEvmCallClient({
      chainId: "ethereum",
      storageAdapter,
      customRpcUrls: ["https://eth1.example.com"],
    });

    expect(client.chainId).toBe(1);
    expect(client.cacheService).toBeDefined();
    expect(client.pool).toBeDefined();
    expect(client.batchExecutor).toBeDefined();
    expect(client.archiveExecutor).toBeDefined();
    client.close();
  });

  it("executes single call, batch, and strictBatch through facade", async () => {
    const storageAdapter = new SqliteStorageAdapter({ path: ":memory:" });
    const mockHttp = new MockHttpTransport(async (_url, body) => {
      const isBatch = Array.isArray(body);
      const reqs = isBatch ? (body as { id: string | number; method: string }[]) : [body as { id: string | number; method: string }];

      const responses = reqs.map((r) => {
        if (r.method === "eth_chainId") {
          return { jsonrpc: "2.0", id: r.id, result: "0x1" };
        }
        if (r.method === "eth_getBlockByNumber") {
          return {
            jsonrpc: "2.0",
            id: r.id,
            result: { number: "0x112a880", hash: BLOCK_HASH, timestamp: "0x60000000" },
          };
        }
        return {
          jsonrpc: "2.0",
          id: r.id,
          result: `res_${r.id}`,
        };
      });

      return {
        status: 200,
        body: isBatch ? responses : responses[0],
      };
    });

    const transport = new ArchiveRpcTransport({ httpTransport: mockHttp });
    const pool = new RpcPool({
      chainId: 1,
      endpoints: ["https://eth1.example.com"],
      transport,
    });
    const batchExecutor = new JsonRpcBatchExecutor({ pool, transport });

    const client = new EvmCallClient({
      chainId: 1,
      storageAdapter,
      pool,
      batchExecutor,
    });

    // Single call
    const single = await client.call<string>({ id: "s1", method: "eth_blockNumber" });
    expect(single).toBe("res_s1");

    // Batch call
    const batch = await client.batch([
      { id: "b1", method: "eth_blockNumber" },
      { id: "b2", method: "eth_blockNumber" },
    ]);
    expect(batch).toHaveLength(2);
    expect(batch[0]?.result).toBe("res_b1");

    // Strict batch call
    const strict = await client.strictBatch([
      { id: "sb1", method: "eth_blockNumber" },
      { id: "sb2", method: "eth_blockNumber" },
    ]);
    expect(strict).toEqual(["res_sb1", "res_sb2"]);

    client.close();
  });

  it("executes multicall with Multicall3 at historical block", async () => {
    const storageAdapter = new SqliteStorageAdapter({ path: ":memory:" });
    const mockHttp = new MockHttpTransport(async (_url, body) => {
      const isBatch = Array.isArray(body);
      const reqs = isBatch ? (body as { id: string | number; method: string; params?: unknown[] }[]) : [body as { id: string | number; method: string; params?: unknown[] }];

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
            result: {
              number: num,
              hash: BLOCK_HASH,
              timestamp: "0x60000000",
            },
          };
        }

        if (req.method === "eth_call") {
          return {
            jsonrpc: "2.0",
            id: req.id,
            result: encodeAggregate3Result([
              { success: true, data: `0x${wordUint(42n)}` },
              { success: true, data: `0x${wordUint(99n)}` },
            ]),
          };
        }

        throw new Error(`Unexpected method ${req.method}`);
      });

      return {
        status: 200,
        body: isBatch ? responses : responses[0],
      };
    });

    const transport = new ArchiveRpcTransport({ httpTransport: mockHttp });
    const pool = new RpcPool({
      chainId: 1,
      endpoints: ["https://eth1.example.com"],
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

    const res = await client.multicall({
      chain: "ethereum",
      blockNumber: "16777216", // 0x1000000
      calls: [
        { id: "call-1", target: "0x1111111111111111111111111111111111111111", callData: "0x" },
        { id: "call-2", target: "0x2222222222222222222222222222222222222222", callData: "0x" },
      ],
    });

    expect(res.blockHash).toBe(BLOCK_HASH);
    expect(res.results).toHaveLength(2);
    expect(res.results[0]?.id).toBe("call-1");
    expect(res.results[0]?.success).toBe(true);
    expect(res.results[0]?.returnData).toBe(`0x${wordUint(42n)}`);
    expect(res.results[1]?.id).toBe("call-2");
    expect(res.results[1]?.success).toBe(true);
    expect(res.results[1]?.returnData).toBe(`0x${wordUint(99n)}`);

    client.close();
  });

  it("executes multicallErc20 and decodes metadata and balances", async () => {
    const storageAdapter = new SqliteStorageAdapter({ path: ":memory:" });
    const mockHttp = new MockHttpTransport(async (_url, body) => {
      const isBatch = Array.isArray(body);
      const reqs = isBatch ? (body as { id: string | number; method: string; params?: unknown[] }[]) : [body as { id: string | number; method: string; params?: unknown[] }];

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
            result: {
              number: num,
              hash: BLOCK_HASH,
              timestamp: "0x60000000",
            },
          };
        }

        if (req.method === "eth_call") {
          return {
            jsonrpc: "2.0",
            id: req.id,
            result: encodeAggregate3Result([
              { success: true, data: `0x${wordUint(1_000_000n)}` }, // balanceOf: 1,000,000
              { success: true, data: `0x${wordUint(6n)}` },         // decimals: 6
            ]),
          };
        }

        throw new Error(`Unexpected method ${req.method}`);
      });

      return {
        status: 200,
        body: isBatch ? responses : responses[0],
      };
    });

    const transport = new ArchiveRpcTransport({ httpTransport: mockHttp });
    const pool = new RpcPool({
      chainId: 1,
      endpoints: ["https://eth1.example.com"],
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
      blockNumber: "16777216",
      calls: [
        {
          id: "bal",
          tokenAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
          method: "balanceOf",
          owner: "0x1111111111111111111111111111111111111111",
        },
        {
          id: "dec",
          tokenAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
          method: "decimals",
        },
      ],
    });

    expect(res.results).toHaveLength(2);
    expect(res.results[0]?.id).toBe("bal");
    expect(res.results[0]?.success).toBe(true);
    expect(res.results[0]?.value).toBe("1000000");
    expect(res.results[1]?.id).toBe("dec");
    expect(res.results[1]?.success).toBe(true);
    expect(res.results[1]?.value).toBe("6");

    client.close();
  });

  it("manages cache cleanup through facade methods", () => {
    const storageAdapter = new SqliteStorageAdapter({ path: ":memory:" });
    const client = createEvmCallClient({
      chainId: 1,
      storageAdapter,
    });

    // Write a volatile key
    client.cacheService.set(1, "eth_blockNumber", [], "0x100", { now: 1000 });

    // Clean expired at now = 20000 (after 10s default TTL)
    const cleaned = client.cleanExpiredCache(20000);
    expect(cleaned).toBe(1);

    // Clear cache
    client.clearCache();
    expect(client.cacheService.get(1, "eth_blockNumber", [])).toBeNull();

    client.close();
  });
});
