import { describe, expect, it } from "vitest";

import { EvmCallClient } from "../../src/client/EvmCallClient";
import { SqliteStorageAdapter } from "../../src/storage/SqliteStorageAdapter";
import { ArchiveRpcTransport } from "../../src/transport/ArchiveRpcTransport";
import { type HttpTransport } from "../../src/transport/HttpTransport";

function createMockTransport(
  handler: (method: string, params: unknown[] | undefined) => unknown | { error: { code: number; message: string } },
): HttpTransport {
  const defaultMock = (method: string, params?: unknown[]) => {
    if (method === "eth_chainId") return "0x1";
    if (method === "eth_getBlockByNumber") {
      const tag = params?.[0];
      const num = typeof tag === "string" && tag.startsWith("0x") ? tag : "0x112a880";
      return {
        number: num,
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
          const res = handler(item.method ?? "", item.params);
          if (res !== undefined) {
            if (res && typeof res === "object" && "error" in res) {
              return { jsonrpc: "2.0", id: item.id, error: (res as { error: unknown }).error };
            }
            return { jsonrpc: "2.0", id: item.id, result: res };
          }
          const def = defaultMock(item.method ?? "", item.params);
          if (def !== undefined) {
            return { jsonrpc: "2.0", id: item.id, result: def };
          }
          return { jsonrpc: "2.0", id: item.id, result: null };
        });
        return { status: 200, headers: {}, body: responses };
      }

      const res = handler(body.method ?? "", body.params);
      if (res !== undefined) {
        if (res && typeof res === "object" && "error" in res) {
          return { status: 200, headers: {}, body: { jsonrpc: "2.0", id: body.id, error: (res as { error: unknown }).error } };
        }
        return { status: 200, headers: {}, body: { jsonrpc: "2.0", id: body.id, result: res } };
      }
      const def = defaultMock(body.method ?? "", body.params);
      if (def !== undefined) {
        return { status: 200, headers: {}, body: { jsonrpc: "2.0", id: body.id, result: def } };
      }
      return { status: 200, headers: {}, body: { jsonrpc: "2.0", id: body.id, result: null } };
    },
  };
}

describe("EvmCallClient Remote APIs & Batch Operations", () => {
  it("fetches blocks by hash and multiple blocks in a batch (getBlocks)", async () => {
    const mockTransport = createMockTransport((method, params) => {
      if (method === "eth_getBlockByHash") {
        return {
          hash: params?.[0],
          number: "0x100",
          timestamp: "0x1000",
        };
      }
      if (method === "eth_getBlockByNumber") {
        const tag = params?.[0];
        const num = tag === "latest" ? "0x112a880" : tag;
        return {
          number: num,
          hash: "0x" + "a".repeat(64),
          timestamp: "0x1000",
        };
      }
      return undefined;
    });

    const client = new EvmCallClient({
      storageAdapter: new SqliteStorageAdapter({ path: ":memory:" }),
      transport: new ArchiveRpcTransport({ httpTransport: mockTransport }),
      customRpcUrls: ["https://mock.rpc"],
    });

    // 1. getBlockByHash
    const block = await client.getBlockByHash("0x" + "1".repeat(64));
    expect(block?.number).toBe("0x100");

    // 2. getBlocks batch
    const blocks = await client.getBlocks([100n, 101n, "latest"]);
    expect(blocks.length).toBe(3);
    expect(blocks[0]?.number).toBe("0x64");
    expect(blocks[1]?.number).toBe("0x65");
    expect(blocks[2]?.number).toBe("0x112a880");

    // Empty array returns immediately
    const empty = await client.getBlocks([]);
    expect(empty).toEqual([]);

    client.close();
  });

  it("fetches transactions, receipts, and combined transaction with receipt", async () => {
    const tx1 = "0x" + "1".repeat(64);
    const tx2 = "0x" + "2".repeat(64);

    const mockTransport = createMockTransport((method, params) => {
      if (method === "eth_getTransactionByHash") {
        const hash = params?.[0];
        return { hash, value: "0x100" };
      }
      if (method === "eth_getTransactionReceipt") {
        const hash = params?.[0];
        return { transactionHash: hash, status: "0x1" };
      }
      return undefined;
    });

    const client = new EvmCallClient({
      storageAdapter: new SqliteStorageAdapter({ path: ":memory:" }),
      transport: new ArchiveRpcTransport({ httpTransport: mockTransport }),
      customRpcUrls: ["https://mock.rpc"],
    });

    // 1. Single getTransaction
    const singleTx = await client.getTransaction(tx1);
    expect(singleTx?.hash).toBe(tx1);

    // 2. Batch getTransactions
    const txs = await client.getTransactions([tx1, tx2]);
    expect(txs.length).toBe(2);
    expect(txs[0]?.hash).toBe(tx1);
    expect(txs[1]?.hash).toBe(tx2);

    // 3. Batch getTransactionReceipts
    const receipts = await client.getTransactionReceipts([tx1, tx2]);
    expect(receipts.length).toBe(2);
    expect(receipts[0]?.transactionHash).toBe(tx1);
    expect(receipts[0]?.status).toBe("0x1");

    // 4. getTransactionWithReceipt in a single roundtrip
    const combined = await client.getTransactionWithReceipt(tx1);
    expect(combined.transaction?.hash).toBe(tx1);
    expect(combined.receipt?.status).toBe("0x1");

    client.close();
  });

  it("getBlockReceipts supports native eth_getBlockReceipts and falls back gracefully", async () => {
    // Mode A: Native getBlockReceipts supported
    const mockTransportNative = createMockTransport((method) => {
      if (method === "eth_getBlockReceipts") {
        return [
          { transactionHash: "0x111", status: "0x1" },
          { transactionHash: "0x222", status: "0x1" },
        ];
      }
      return undefined;
    });

    const clientNative = new EvmCallClient({
      storageAdapter: new SqliteStorageAdapter({ path: ":memory:" }),
      transport: new ArchiveRpcTransport({ httpTransport: mockTransportNative }),
      customRpcUrls: ["https://mock.rpc"],
    });

    const nativeReceipts = await clientNative.getBlockReceipts("latest");
    expect(nativeReceipts.length).toBe(2);
    expect(nativeReceipts[0]?.transactionHash).toBe("0x111");
    clientNative.close();

    const mockTransportFallback = createMockTransport((method, params) => {
      if (method === "eth_getBlockReceipts") {
        return { error: { code: -32601, message: "Method not found" } };
      }
      if (method === "eth_getBlockByNumber") {
        return {
          hash: "0x" + "c".repeat(64),
          number: params?.[0] ?? "0x112a880",
          timestamp: "0x1000",
          transactions: ["0xaaa", "0xbbb"],
        };
      }
      if (method === "eth_getTransactionReceipt") {
        return {
          transactionHash: params?.[0],
          status: "0x1",
        };
      }
      return undefined;
    });

    const clientFallback = new EvmCallClient({
      storageAdapter: new SqliteStorageAdapter({ path: ":memory:" }),
      transport: new ArchiveRpcTransport({ httpTransport: mockTransportFallback }),
      customRpcUrls: ["https://mock.rpc"],
    });

    const fallbackReceipts = await clientFallback.getBlockReceipts(256);
    expect(fallbackReceipts.length).toBe(2);
    expect(fallbackReceipts[0]?.transactionHash).toBe("0xaaa");
    expect(fallbackReceipts[1]?.transactionHash).toBe("0xbbb");
    clientFallback.close();
  });

  it("reads account nonces, contract bytecodes, and storage slots in batch", async () => {
    const addr1 = "0x1111111111111111111111111111111111111111";
    const addr2 = "0x2222222222222222222222222222222222222222";

    const mockTransport = createMockTransport((method, params) => {
      if (method === "eth_getTransactionCount") {
        const addr = params?.[0];
        return addr === addr1 ? "0x5" : "0xa";
      }
      if (method === "eth_getCode") {
        const addr = params?.[0];
        return addr === addr1 ? "0x60806040" : "0x";
      }
      if (method === "eth_getStorageAt") {
        const slot = params?.[1];
        return slot === "0x0" ? "0x0000000000000000000000000000000000000000000000000000000000000001" : "0x02";
      }
      return undefined;
    });

    const client = new EvmCallClient({
      storageAdapter: new SqliteStorageAdapter({ path: ":memory:" }),
      transport: new ArchiveRpcTransport({ httpTransport: mockTransport }),
      customRpcUrls: ["https://mock.rpc"],
    });

    // 1. getTransactionCount & getTransactionCounts
    const nonce1 = await client.getTransactionCount(addr1);
    expect(nonce1).toBe(5n);

    const nonces = await client.getTransactionCounts([addr1, addr2]);
    expect(nonces).toEqual([5n, 10n]);

    // 2. getCodes (batch check contracts)
    const codes = await client.getCodes([addr1, addr2]);
    expect(codes).toEqual(["0x60806040", "0x"]);

    // 3. getStorageAt & getStorageAts
    const slot0 = await client.getStorageAt(addr1, 0);
    expect(slot0.endsWith("1")).toBe(true);

    const slots = await client.getStorageAts([
      { address: addr1, position: 0 },
      { address: addr1, position: 1 },
    ]);
    expect(slots.length).toBe(2);
    expect(slots[0]?.endsWith("1")).toBe(true);
    expect(slots[1]).toBe("0x02");

    client.close();
  });

  it("handles estimateGas, getFeeHistory, and batchEthCall", async () => {
    const mockTransport = createMockTransport((method, params) => {
      if (method === "eth_estimateGas") {
        return "0x5208"; // 21000 gas
      }
      if (method === "eth_feeHistory") {
        return {
          oldestBlock: "0x1000",
          baseFeePerGas: ["0x3b9aca00", "0x3b9aca05"], // ~1 gwei
          gasUsedRatio: [0.5, 0.6],
          reward: [["0x77359400"]],
        };
      }
      if (method === "eth_call") {
        const tx = params?.[0] as { to?: string };
        return tx?.to === "0x1111111111111111111111111111111111111111" ? "0x01" : "0x02";
      }
      return undefined;
    });

    const client = new EvmCallClient({
      storageAdapter: new SqliteStorageAdapter({ path: ":memory:" }),
      transport: new ArchiveRpcTransport({ httpTransport: mockTransport }),
      customRpcUrls: ["https://mock.rpc"],
    });

    // 1. estimateGas
    const gas = await client.estimateGas({
      to: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      value: 1000000n,
    });
    expect(gas).toBe(21000n);

    // 2. getFeeHistory
    const feeHistory = await client.getFeeHistory(2, "latest", [50]);
    expect(feeHistory.oldestBlock).toBe(4096n);
    expect(feeHistory.baseFeePerGas.length).toBe(2);
    expect(feeHistory.baseFeePerGas[0]).toBe(1_000_000_000n);
    expect(feeHistory.gasUsedRatio).toEqual([0.5, 0.6]);
    expect(feeHistory.reward?.[0]?.[0]).toBe(2_000_000_000n);

    // 3. batchEthCall
    const simResults = await client.batchEthCall([
      { to: "0x1111111111111111111111111111111111111111", data: "0x" },
      { to: "0x2222222222222222222222222222222222222222", data: "0x" },
    ]);
    expect(simResults).toEqual(["0x01", "0x02"]);

    client.close();
  });
});
