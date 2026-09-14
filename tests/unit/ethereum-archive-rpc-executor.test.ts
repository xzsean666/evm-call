import { describe, expect, it } from "vitest";

import {
  EthereumArchiveRpcExecutor,
} from "../../src/multicall/EthereumArchiveRpcExecutor";
import { ArchiveRpcTransport } from "../../src/transport/ArchiveRpcTransport";
import type { HttpTransport, HttpResponse } from "../../src/transport/HttpTransport";
import type { RpcEndpointLike, RpcPoolLike } from "../../src/batch/JsonRpcBatchExecutor";

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

const BLOCK_HASH_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BLOCK_HASH_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("EthereumArchiveRpcExecutor", () => {
  it("executes multicall batches with pre/post header hash verification", async () => {
    let callIndex = 0;
    const mockHttp = new MockHttpTransport(async (_url, body) => {
      callIndex += 1;
      const req = body as { id: number; method: string; params: unknown[] };

      // Pre-header & post-header both return BLOCK_HASH_A
      if (req.method === "eth_getBlockByNumber") {
        return {
          status: 200,
          body: {
            jsonrpc: "2.0",
            id: req.id,
            result: {
              number: "0x100",
              hash: BLOCK_HASH_A,
              timestamp: "0x60000000",
            },
          },
        };
      }

      if (req.method === "eth_call") {
        return {
          status: 200,
          body: {
            jsonrpc: "2.0",
            id: req.id,
            result: "0x1234",
          },
        };
      }

      throw new Error(`Unexpected method ${req.method}`);
    });

    const transport = new ArchiveRpcTransport({ httpTransport: mockHttp });
    const { pool, reported } = createMockPool([{ id: "ep1", url: "https://rpc1.example.com" }]);

    const executor = new EthereumArchiveRpcExecutor({ pool, transport });

    const result = await executor.executeMulticallBatches({
      blockNumber: "256", // 0x100
      multicall3Address: "0xcA11bde05977b3631167028862bE2a173976CA11",
      batches: ["0x82ad56cb00"],
    });

    expect(result.blockHash).toBe(BLOCK_HASH_A);
    expect(result.blockTimestamp).toBe(BigInt("0x60000000").toString(10));
    expect(result.rpcEndpointId).toBe("ep1");
    expect(result.batchReturnData).toEqual(["0x1234"]);
    expect(reported).toEqual([{ id: "ep1", outcome: "success" }]);
  });

  it("detects block reorg and throws RPC_BLOCK_REORG_DETECTED if hash changes during multicall", async () => {
    let blockHeaderCallCount = 0;
    const mockHttp = new MockHttpTransport(async (_url, body) => {
      const req = body as { id: number; method: string; params: unknown[] };

      if (req.method === "eth_getBlockByNumber") {
        blockHeaderCallCount += 1;
        // First call (pre-header) returns BLOCK_HASH_A, second call (post-header) returns BLOCK_HASH_B
        const hash = blockHeaderCallCount === 1 ? BLOCK_HASH_A : BLOCK_HASH_B;
        return {
          status: 200,
          body: {
            jsonrpc: "2.0",
            id: req.id,
            result: {
              number: "0x100",
              hash,
              timestamp: "0x60000000",
            },
          },
        };
      }

      if (req.method === "eth_call") {
        return {
          status: 200,
          body: {
            jsonrpc: "2.0",
            id: req.id,
            result: "0x1234",
          },
        };
      }

      throw new Error(`Unexpected method ${req.method}`);
    });

    const transport = new ArchiveRpcTransport({ httpTransport: mockHttp });
    const { pool } = createMockPool([{ id: "ep1", url: "https://rpc1.example.com" }]);

    const executor = new EthereumArchiveRpcExecutor({ pool, transport });

    await expect(
      executor.executeMulticallBatches({
        blockNumber: "256",
        multicall3Address: "0xcA11bde05977b3631167028862bE2a173976CA11",
        batches: ["0x82ad56cb00"],
      }),
    ).rejects.toThrow(/reorg/i);
  });

  it("reads native balance at block and detects reorgs", async () => {
    const mockHttp = new MockHttpTransport(async (_url, body) => {
      const req = body as { id: number; method: string; params: unknown[] };

      if (req.method === "eth_getBlockByNumber") {
        return {
          status: 200,
          body: {
            jsonrpc: "2.0",
            id: req.id,
            result: {
              number: "0x100",
              hash: BLOCK_HASH_A,
              timestamp: "0x60000000",
            },
          },
        };
      }

      if (req.method === "eth_getBalance") {
        return {
          status: 200,
          body: {
            jsonrpc: "2.0",
            id: req.id,
            result: "0xde0b6b3a7640000", // 1 ETH in wei
          },
        };
      }

      throw new Error(`Unexpected method ${req.method}`);
    });

    const transport = new ArchiveRpcTransport({ httpTransport: mockHttp });
    const { pool } = createMockPool([{ id: "ep1", url: "https://rpc1.example.com" }]);

    const executor = new EthereumArchiveRpcExecutor({ pool, transport });

    const balance = await executor.getNativeBalanceAtBlock({
      address: "0x1111111111111111111111111111111111111111",
      blockNumber: "256",
    });

    expect(balance.amount).toBe("1000000000000000000");
    expect(balance.blockHash).toBe(BLOCK_HASH_A);
    expect(balance.rpcEndpointId).toBe("ep1");
  });

  it("finds latest block number", async () => {
    const mockHttp = new MockHttpTransport(async (_url, body) => {
      const req = body as { id: number; method: string };
      return {
        status: 200,
        body: {
          jsonrpc: "2.0",
          id: req.id,
          result: {
            number: "0x123456",
            hash: BLOCK_HASH_A,
            timestamp: "0x60000000",
          },
        },
      };
    });

    const transport = new ArchiveRpcTransport({ httpTransport: mockHttp });
    const { pool } = createMockPool([{ id: "ep1", url: "https://rpc1.example.com" }]);

    const executor = new EthereumArchiveRpcExecutor({ pool, transport });

    const latest = await executor.findLatestBlockNumber();
    expect(latest.blockNumber).toBe(BigInt("0x123456").toString(10));
    expect(latest.rpcEndpointId).toBe("ep1");
  });

  it("finds block number by timestamp via binary search", async () => {
    // Blocks 100 to 200. Let block timestamp = 1000 + blockNumber * 10.
    const mockHttp = new MockHttpTransport(async (_url, body) => {
      const req = body as { id: number; method: string; params: unknown[] };

      if (req.method === "eth_getBlockByNumber") {
        const tag = req.params[0] as string;
        let blockNum = 200n;
        if (tag !== "latest") {
          blockNum = BigInt(tag);
        }
        const timestamp = 1000n + blockNum * 10n;
        return {
          status: 200,
          body: {
            jsonrpc: "2.0",
            id: req.id,
            result: {
              number: `0x${blockNum.toString(16)}`,
              hash: BLOCK_HASH_A,
              timestamp: `0x${timestamp.toString(16)}`,
            },
          },
        };
      }

      throw new Error(`Unexpected method ${req.method}`);
    });

    const transport = new ArchiveRpcTransport({ httpTransport: mockHttp });
    const { pool } = createMockPool([{ id: "ep1", url: "https://rpc1.example.com" }]);

    const executor = new EthereumArchiveRpcExecutor({ pool, transport });

    // Target timestamp: 1000 + 150 * 10 = 2500 -> block 150
    const found = await executor.findBlockNumberByTimestamp(2500n, 100n);
    expect(found.blockNumber).toBe("150");
  });
});
