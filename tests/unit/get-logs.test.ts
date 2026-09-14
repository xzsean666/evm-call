import { describe, expect, it } from "vitest";

import { EvmCallClient } from "../../src/client/EvmCallClient";
import {
  parseLogFilter,
  normalizeEvmLog,
  sortEvmLogs,
  type EvmLog,
  type LogFilter,
} from "../../src/domain/logModels";
import { SqliteStorageAdapter } from "../../src/storage/SqliteStorageAdapter";
import { ArchiveRpcTransport } from "../../src/transport/ArchiveRpcTransport";
import { type HttpTransport, type HttpResponse } from "../../src/transport/HttpTransport";

describe("Log Filter Parsing & Normalization", () => {
  it("normalizes addresses and converts to lowercase", () => {
    const single = parseLogFilter({
      address: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    });
    expect(single.address).toBe("0xdac17f958d2ee523a2206206994597c13d831ec7");

    const multi = parseLogFilter({
      address: [
        "0xdAC17F958D2ee523a2206206994597C13D831ec7",
        "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      ],
    });
    expect(multi.address).toEqual([
      "0xdac17f958d2ee523a2206206994597c13d831ec7",
      "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    ]);
  });

  it("throws on invalid addresses", () => {
    expect(() => parseLogFilter({ address: "0xinvalid" })).toThrow(/must be a valid 20-byte/);
    expect(() => parseLogFilter({ address: ["0x123"] })).toThrow(/must be a valid 20-byte/);
    // @ts-expect-error test invalid type
    expect(() => parseLogFilter({ address: 12345 })).toThrow(/must be a string or array/);
  });

  it("normalizes topics and nested topics", () => {
    const transferSig = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
    const userTopic = "0x000000000000000000000000dac17f958d2ee523a2206206994597c13d831ec7";

    const filter = parseLogFilter({
      topics: [
        transferSig.toUpperCase(),
        null,
        [userTopic.toUpperCase(), userTopic],
      ],
    });

    expect(filter.topics).toEqual([
      transferSig,
      null,
      [userTopic, userTopic],
    ]);
  });

  it("throws on invalid topic formats", () => {
    expect(() => parseLogFilter({ topics: ["0xshort"] })).toThrow(/must be a 32-byte hex/);
    expect(() => parseLogFilter({ topics: [["0xshort"]] })).toThrow(/nested topic/);
  });

  it("normalizes block tags and numbers", () => {
    expect(parseLogFilter({ fromBlock: 18000000 }).fromBlock).toBe("0x112a880");
    expect(parseLogFilter({ fromBlock: 18000000n }).fromBlock).toBe("0x112a880");
    expect(parseLogFilter({ fromBlock: "latest" }).fromBlock).toBe("latest");
    expect(parseLogFilter({ toBlock: "0x112a880" }).toBlock).toBe("0x112a880");
    expect(parseLogFilter({ blockHash: "0x" + "a".repeat(64) }).blockHash).toBe("0x" + "a".repeat(64));
  });

  it("throws on invalid blockHash", () => {
    expect(() => parseLogFilter({ blockHash: "0x1234" })).toThrow(/blockHash must be a valid 32-byte/);
  });
});

describe("Log Normalization & Sorting", () => {
  it("normalizes raw RPC log entries into typed EvmLog", () => {
    const raw = {
      address: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"],
      data: "0x00000000000000000000000000000000000000000000000000000000000003e8",
      blockNumber: "0x112a880",
      transactionIndex: "0x5",
      logIndex: "0xa",
      transactionHash: "0x" + "1".repeat(64),
      blockHash: "0x" + "2".repeat(64),
      removed: false,
    };

    const log = normalizeEvmLog(raw);
    expect(log.address).toBe("0xdac17f958d2ee523a2206206994597c13d831ec7");
    expect(log.blockNumber).toBe(18000000n);
    expect(log.blockNumberString).toBe("18000000");
    expect(log.transactionIndex).toBe(5);
    expect(log.logIndex).toBe(10);
    expect(log.removed).toBe(false);
  });

  it("strictly sorts logs by (blockNumber, transactionIndex, logIndex)", () => {
    const makeLog = (block: bigint, txIdx: number, logIdx: number): EvmLog => ({
      address: "0x1111111111111111111111111111111111111111",
      topics: [],
      data: "0x",
      blockNumber: block,
      blockNumberString: block.toString(10),
      transactionHash: "0x" + "0".repeat(64),
      transactionIndex: txIdx,
      blockHash: "0x" + "0".repeat(64),
      logIndex: logIdx,
    });

    const unsorted: EvmLog[] = [
      makeLog(100n, 2, 5),
      makeLog(100n, 1, 1),
      makeLog(99n, 0, 0),
      makeLog(100n, 2, 2),
      makeLog(105n, 0, 1),
    ];

    const sorted = sortEvmLogs(unsorted);

    expect(sorted[0]?.blockNumber).toBe(99n);
    expect(sorted[1]?.blockNumber).toBe(100n);
    expect(sorted[1]?.transactionIndex).toBe(1);
    expect(sorted[2]?.transactionIndex).toBe(2);
    expect(sorted[2]?.logIndex).toBe(2);
    expect(sorted[3]?.transactionIndex).toBe(2);
    expect(sorted[3]?.logIndex).toBe(5);
    expect(sorted[4]?.blockNumber).toBe(105n);
  });
});

function createMockTransport(
  handler: (method: string, params: unknown[] | undefined) => unknown | { error: { code: number; message: string } },
): HttpTransport {
  const defaultMock = (method: string) => {
    if (method === "eth_chainId") return "0x1";
    if (method === "eth_getBlockByNumber") {
      return {
        number: "0x112a880",
        hash: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
        timestamp: "0x64000000",
      };
    }
    return undefined;
  };

  return {
    async request(req) {
      const body = req.body as
        | { method?: string; id?: string | number; params?: unknown[] }
        | { method?: string; id?: string | number; params?: unknown[] }[];

      if (Array.isArray(body)) {
        const responses = body.map((item) => {
          const def = defaultMock(item.method ?? "");
          if (def !== undefined) {
            return { jsonrpc: "2.0", id: item.id, result: def };
          }
          const res = handler(item.method ?? "", item.params);
          if (res && typeof res === "object" && "error" in res) {
            return { jsonrpc: "2.0", id: item.id, error: (res as { error: unknown }).error };
          }
          return { jsonrpc: "2.0", id: item.id, result: res };
        });
        return { status: 200, headers: {}, body: responses };
      }

      const def = defaultMock(body.method ?? "");
      if (def !== undefined) {
        return { status: 200, headers: {}, body: { jsonrpc: "2.0", id: body.id, result: def } };
      }
      const res = handler(body.method ?? "", body.params);
      if (res && typeof res === "object" && "error" in res) {
        return { status: 200, headers: {}, body: { jsonrpc: "2.0", id: body.id, error: (res as { error: unknown }).error } };
      }
      return { status: 200, headers: {}, body: { jsonrpc: "2.0", id: body.id, result: res } };
    },
  };
}

describe("Client getLogs, getLogsChunked and iterateLogs", () => {
  it("getLogs sends parsed query and returns sorted logs", async () => {
    const mockTransport = createMockTransport((method, params) => {
      if (method === "eth_getLogs") {
        const filterParam = params?.[0] as { address?: string };
        expect(filterParam?.address).toBe("0x1111111111111111111111111111111111111111");
        return [
          {
            address: "0x1111111111111111111111111111111111111111",
            topics: ["0x" + "1".repeat(64)],
            data: "0x12",
            blockNumber: "0x10",
            transactionIndex: "0x1",
            logIndex: "0x2",
            transactionHash: "0x" + "a".repeat(64),
            blockHash: "0x" + "b".repeat(64),
          },
        ];
      }
      return "0x";
    });

    const client = new EvmCallClient({
      storageAdapter: new SqliteStorageAdapter({ path: ":memory:" }),
      transport: new ArchiveRpcTransport({ httpTransport: mockTransport }),
      customRpcUrls: ["https://mock.rpc"],
    });

    const logs = await client.getLogs({
      address: "0x1111111111111111111111111111111111111111",
      fromBlock: 16,
      toBlock: 16,
    });

    expect(logs.length).toBe(1);
    expect(logs[0]?.blockNumber).toBe(16n);
    expect(logs[0]?.logIndex).toBe(2);

    client.close();
  });

  it("getLogsChunked splits large range into chunks and fires onChunkProgress", async () => {
    const chunkCalls: { fromBlock: string; toBlock: string }[] = [];

    const mockTransport = createMockTransport((method, params) => {
      if (method === "eth_getLogs") {
        const filterParam = params?.[0] as { fromBlock: string; toBlock: string };
        chunkCalls.push({ fromBlock: filterParam.fromBlock, toBlock: filterParam.toBlock });

        const blockNum = BigInt(filterParam.fromBlock);
        return [
          {
            address: "0x1111111111111111111111111111111111111111",
            topics: [],
            data: "0x",
            blockNumber: `0x${blockNum.toString(16)}`,
            transactionIndex: "0x0",
            logIndex: "0x0",
            transactionHash: "0x" + "a".repeat(64),
            blockHash: "0x" + "b".repeat(64),
          },
        ];
      }
      return "0x";
    });

    const client = new EvmCallClient({
      storageAdapter: new SqliteStorageAdapter({ path: ":memory:" }),
      transport: new ArchiveRpcTransport({ httpTransport: mockTransport }),
      customRpcUrls: ["https://mock.rpc"],
    });

    const progressReports: number[] = [];

    // Query 10,000 to 14,999 (5,000 blocks) with maxBlockRange = 2,000
    // Expected chunks: [10000, 11999], [12000, 13999], [14000, 14999] (3 chunks)
    const logs = await client.getLogsChunked(
      {
        address: "0x1111111111111111111111111111111111111111",
        fromBlock: 10000n,
        toBlock: 14999n,
      },
      {
        maxBlockRange: 2000,
        chunkConcurrency: 2,
        onChunkProgress: (p) => {
          progressReports.push(p.totalLogsSoFar);
        },
      },
    );

    expect(chunkCalls.length).toBe(3);
    expect(chunkCalls[0]?.fromBlock).toBe("0x2710"); // 10000
    expect(chunkCalls[0]?.toBlock).toBe("0x2edf");   // 11999
    expect(chunkCalls[1]?.fromBlock).toBe("0x2ee0"); // 12000
    expect(chunkCalls[1]?.toBlock).toBe("0x36af");   // 13999
    expect(chunkCalls[2]?.fromBlock).toBe("0x36b0"); // 14000
    expect(chunkCalls[2]?.toBlock).toBe("0x3a97");   // 14999

    expect(logs.length).toBe(3);
    expect(logs[0]?.blockNumber).toBe(10000n);
    expect(logs[1]?.blockNumber).toBe(12000n);
    expect(logs[2]?.blockNumber).toBe(14000n);
    expect(progressReports).toEqual([1, 2, 3]);

    client.close();
  });

  it("adaptive chunking halves range when node errors with result limit", async () => {
    // Range: 100 to 199 (100 blocks)
    // If full range [100, 199] queried -> returns JSON-RPC error "query returned more than 10000 results"
    // Adaptive splits into [100, 149] and [150, 199], which succeed!
    const queryRanges: string[] = [];

    const mockTransport = createMockTransport((method, params) => {
      if (method === "eth_getLogs") {
        const filterParam = params?.[0] as { fromBlock: string; toBlock: string };
        const from = BigInt(filterParam.fromBlock);
        const to = BigInt(filterParam.toBlock);
        queryRanges.push(`${from}-${to}`);

        if (from === 100n && to === 199n) {
          return {
            error: {
              code: -32005,
              message: "query returned more than 10000 results",
            },
          };
        }

        return [
          {
            address: "0x1111111111111111111111111111111111111111",
            topics: [],
            data: "0x",
            blockNumber: `0x${from.toString(16)}`,
            transactionIndex: "0x0",
            logIndex: "0x0",
            transactionHash: "0x" + "a".repeat(64),
            blockHash: "0x" + "b".repeat(64),
          },
        ];
      }
      return "0x";
    });

    const client = new EvmCallClient({
      storageAdapter: new SqliteStorageAdapter({ path: ":memory:" }),
      transport: new ArchiveRpcTransport({ httpTransport: mockTransport }),
      customRpcUrls: ["https://mock.rpc"],
    });

    const logs = await client.getLogsChunked(
      {
        fromBlock: 100n,
        toBlock: 199n,
      },
      {
        maxBlockRange: 1000,
        adaptiveChunking: true,
      },
    );

    // Initial query 100-199 failed, then split into 100-149 and 150-199
    expect(queryRanges).toContain("100-199");
    expect(queryRanges).toContain("100-149");
    expect(queryRanges).toContain("150-199");
    expect(logs.length).toBe(2);
    expect(logs[0]?.blockNumber).toBe(100n);
    expect(logs[1]?.blockNumber).toBe(150n);

    client.close();
  });

  it("iterateLogs streams chunks sequentially", async () => {
    const mockTransport = createMockTransport((method, params) => {
      if (method === "eth_getLogs") {
        const filterParam = params?.[0] as { fromBlock: string; toBlock: string };
        const from = BigInt(filterParam.fromBlock);
        return [
          {
            address: "0x1111111111111111111111111111111111111111",
            topics: [],
            data: "0x",
            blockNumber: `0x${from.toString(16)}`,
            transactionIndex: "0x0",
            logIndex: "0x0",
            transactionHash: "0x" + "a".repeat(64),
            blockHash: "0x" + "b".repeat(64),
          },
        ];
      }
      return "0x";
    });

    const client = new EvmCallClient({
      storageAdapter: new SqliteStorageAdapter({ path: ":memory:" }),
      transport: new ArchiveRpcTransport({ httpTransport: mockTransport }),
      customRpcUrls: ["https://mock.rpc"],
    });

    const receivedChunks: number[] = [];
    for await (const chunk of client.iterateLogs(
      { fromBlock: 1000n, toBlock: 1299n },
      { maxBlockRange: 100 },
    )) {
      expect(chunk.length).toBe(1);
      receivedChunks.push(Number(chunk[0]!.blockNumber));
    }

    // 1000..1299 in steps of 100 -> 1000, 1100, 1200
    expect(receivedChunks).toEqual([1000, 1100, 1200]);

    client.close();
  });

  it("throws when fromBlock is greater than toBlock in getLogsChunked", async () => {
    const mockTransport = createMockTransport(() => []);
    const client = new EvmCallClient({
      storageAdapter: new SqliteStorageAdapter({ path: ":memory:" }),
      transport: new ArchiveRpcTransport({ httpTransport: mockTransport }),
      customRpcUrls: ["https://mock.rpc"],
    });

    await expect(
      client.getLogsChunked({
        fromBlock: 2000n,
        toBlock: 1000n,
      }),
    ).rejects.toThrow(/cannot be greater than toBlock/);

    client.close();
  });

  it("handles blockHash directly in iterateLogs", async () => {
    const hash = "0x" + "c".repeat(64);
    const mockTransport = createMockTransport((method, params) => {
      if (method === "eth_getLogs") {
        const filterParam = params?.[0] as { blockHash?: string };
        expect(filterParam.blockHash).toBe(hash);
        return [
          {
            address: "0x1111111111111111111111111111111111111111",
            topics: [],
            data: "0x",
            blockNumber: "0x100",
            transactionIndex: "0x0",
            logIndex: "0x0",
            transactionHash: "0x" + "a".repeat(64),
            blockHash: hash,
          },
        ];
      }
      return [];
    });

    const client = new EvmCallClient({
      storageAdapter: new SqliteStorageAdapter({ path: ":memory:" }),
      transport: new ArchiveRpcTransport({ httpTransport: mockTransport }),
      customRpcUrls: ["https://mock.rpc"],
    });

    const logs = await client.getLogsChunked({ blockHash: hash });
    expect(logs.length).toBe(1);
    expect(logs[0]?.blockHash).toBe(hash);

    client.close();
  });

  it("aborts iterateLogs when signal is already aborted", async () => {
    const mockTransport = createMockTransport(() => []);
    const client = new EvmCallClient({
      storageAdapter: new SqliteStorageAdapter({ path: ":memory:" }),
      transport: new ArchiveRpcTransport({ httpTransport: mockTransport }),
      customRpcUrls: ["https://mock.rpc"],
    });

    const controller = new AbortController();
    controller.abort();

    await expect(
      client.getLogsChunked(
        { fromBlock: 100n, toBlock: 200n },
        { signal: controller.signal },
      ),
    ).rejects.toThrow(/aborted/);

    client.close();
  });
});

