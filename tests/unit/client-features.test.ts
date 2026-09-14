import { describe, expect, it } from "vitest";

import { EvmCallClient } from "../../src/client/EvmCallClient";
import { SqliteStorageAdapter } from "../../src/storage/SqliteStorageAdapter";
import { ArchiveRpcTransport } from "../../src/transport/ArchiveRpcTransport";
import { type HttpTransport, type HttpResponse } from "../../src/transport/HttpTransport";
import { encodeGetEthBalance } from "../../src/multicall/Multicall3Codec";

class MockRpcTransport implements HttpTransport {
  public lastRequest: unknown = null;

  async request(req: { body?: unknown }): Promise<HttpResponse> {
    this.lastRequest = req.body;
    const body = req.body as { method?: string; id?: string | number; params?: unknown[] } | { method?: string; id?: string | number; params?: unknown[] }[];

    // Handle single or batch calls
    if (Array.isArray(body)) {
      const results = body.map((item) => ({
        jsonrpc: "2.0",
        id: item.id,
        result: this.mockResult(item.method, item.params),
      }));
      return { status: 200, headers: {}, body: results };
    }

    return {
      status: 200,
      headers: {},
      body: {
        jsonrpc: "2.0",
        id: (body as { id?: string | number }).id ?? 1,
        result: this.mockResult((body as { method?: string }).method, (body as { params?: unknown[] }).params),
      },
    };
  }

  private mockResult(method?: string, params?: unknown[]): unknown {
    if (method === "eth_chainId") return "0x1";
    if (method === "eth_blockNumber") return "0x112a880";
    if (method === "eth_gasPrice") return "0x3b9aca00"; // 1 gwei
    if (method === "eth_getCode") return "0x608060405234801561001057600080fd5b50";
    if (method === "eth_getTransactionReceipt") {
      return { status: "0x1", transactionHash: params?.[0], blockNumber: "0x112a880" };
    }
    if (method === "eth_getBlockByNumber") {
      return {
        number: "0x112a880",
        hash: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
        timestamp: "0x64000000",
      };
    }
    if (method === "eth_getLogs") {
      return [
        {
          address: "0x1111111111111111111111111111111111111111",
          topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"],
          data: "0x01",
        },
      ];
    }
    return "0x";
  }
}

describe("EvmCallClient Extended Features", () => {
  it("queries getBlock, getCode, getTransactionReceipt, getGasPrice, and getLogs cleanly", async () => {
    const mockTransport = new MockRpcTransport();
    const transport = new ArchiveRpcTransport({ httpTransport: mockTransport });
    const storage = new SqliteStorageAdapter({ path: ":memory:" });
    const client = new EvmCallClient({
      storageAdapter: storage,
      transport,
      customRpcUrls: ["https://mock-rpc.example.com"],
    });

    // 1. getBlock
    const block = await client.getBlock("latest");
    expect(block).toBeDefined();
    expect(block?.number).toBe("0x112a880");

    // 2. getCode
    const code = await client.getCode("0x1111111111111111111111111111111111111111");
    expect(code.startsWith("0x6080")).toBe(true);

    // 3. getTransactionReceipt
    const receipt = await client.getTransactionReceipt("0x1234567890123456789012345678901234567890123456789012345678901234");
    expect(receipt?.status).toBe("0x1");

    // 4. getGasPrice
    const gasPrice = await client.getGasPrice();
    expect(gasPrice).toBe(1_000_000_000n);

    // 5. getLogs
    const logs = await client.getLogs({
      address: "0x1111111111111111111111111111111111111111",
      fromBlock: 18_000_000n,
      toBlock: "latest",
    });
    expect(logs.length).toBe(1);
    expect(logs[0]?.address).toBe("0x1111111111111111111111111111111111111111");

    client.close();
  });

  it("batches native balances via Multicall3 getNativeBalances", async () => {
    const addr1 = "0x1111111111111111111111111111111111111111";
    const addr2 = "0x2222222222222222222222222222222222222222";

    // Build multicall mock response for 2 balances: 1000 wei and 2000 wei
    const wordUint = (val: bigint) => val.toString(16).padStart(64, "0");
    const tuple1 = `${wordUint(1n)}${wordUint(64n)}${wordUint(32n)}${wordUint(1000n)}`;
    const tuple2 = `${wordUint(1n)}${wordUint(64n)}${wordUint(32n)}${wordUint(2000n)}`;
    const multicallReturnData = `0x${wordUint(32n)}${wordUint(2n)}${wordUint(64n)}${wordUint(192n)}${tuple1}${tuple2}`;

    const mockHttp: HttpTransport = {
      async request(req) {
        const body = req.body as { method?: string; id?: string | number; params?: unknown[] };
        if (body.method === "eth_chainId") {
          return { status: 200, headers: {}, body: { jsonrpc: "2.0", id: body.id, result: "0x1" } };
        }
        if (body.method === "eth_getBlockByNumber") {
          return {
            status: 200,
            headers: {},
            body: {
              jsonrpc: "2.0",
              id: body.id,
              result: {
                number: "0x112a880",
                hash: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
                timestamp: "0x64000000",
              },
            },
          };
        }
        if (body.method === "eth_call") {
          return {
            status: 200,
            headers: {},
            body: { jsonrpc: "2.0", id: body.id, result: multicallReturnData },
          };
        }
        return { status: 200, headers: {}, body: { jsonrpc: "2.0", id: 1, result: "0x" } };
      },
    };

    const transport = new ArchiveRpcTransport({ httpTransport: mockHttp });
    const storage = new SqliteStorageAdapter({ path: ":memory:" });
    const client = new EvmCallClient({
      storageAdapter: storage,
      transport,
      customRpcUrls: ["https://mock-rpc.example.com"],
    });

    const result = await client.getNativeBalances({
      chain: 1,
      addresses: [addr1, addr2],
      blockNumber: "18000000",
    });

    expect(result.results.length).toBe(2);
    expect(result.results[0]?.address).toBe(addr1);
    expect(result.results[0]?.amount).toBe("1000");
    expect(result.results[0]?.success).toBe(true);

    expect(result.results[1]?.address).toBe(addr2);
    expect(result.results[1]?.amount).toBe("2000");
    expect(result.results[1]?.success).toBe(true);

    client.close();
  });
});
