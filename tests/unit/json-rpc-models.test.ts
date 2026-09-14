import { describe, expect, it } from "vitest";

import {
  parseJsonRpcRequests,
  parseMulticallAtBlockRequest,
  parseNativeBalanceAtBlockRequest,
  parseErc20MulticallAtBlockRequest,
} from "../../src/domain";

describe("JSON-RPC & Multicall models parsing", () => {
  it("auto-assigns sequential IDs and normalizes params", () => {
    const parsed = parseJsonRpcRequests([
      { method: "eth_blockNumber" },
      { method: "eth_getBalance", params: ["0x1111111111111111111111111111111111111111", "latest"] },
      { id: "custom-id-99", method: "eth_chainId" },
    ]);

    expect(parsed.requests).toHaveLength(3);
    expect(parsed.requests[0]).toEqual({
      id: 1,
      method: "eth_blockNumber",
      params: [],
    });
    expect(parsed.requests[1]).toEqual({
      id: 2,
      method: "eth_getBalance",
      params: ["0x1111111111111111111111111111111111111111", "latest"],
    });
    expect(parsed.requests[2]).toEqual({
      id: "custom-id-99",
      method: "eth_chainId",
      params: [],
    });
    expect(parsed.batchChunkSize).toBe(100);
    expect(parsed.maxConcurrency).toBe(3);
  });

  it("rejects non-array or malformed requests", () => {
    expect(() => parseJsonRpcRequests(null as unknown as [])).toThrowError(/must be an array/);
    expect(() => parseJsonRpcRequests([{ method: "" }])).toThrowError(/invalid method/);
  });

  it("parses and validates multicallAtBlock requests", () => {
    const req = {
      chain: "ethereum",
      blockNumber: "00019000000",
      calls: [
        {
          id: "call-1",
          target: "0x1234567890ABCDEF1234567890ABCDEF12345678",
          callData: "0x70a08231",
        },
      ],
    };
    const parsed = parseMulticallAtBlockRequest(req);
    expect(parsed.chainId).toBe(1);
    expect(parsed.blockNumber).toBe("19000000");
    expect(parsed.calls[0]?.target).toBe("0x1234567890abcdef1234567890abcdef12345678");
    expect(parsed.calls[0]?.allowFailure).toBe(true);
  });

  it("detects duplicate call IDs in multicallAtBlock", () => {
    const req = {
      chain: 8453,
      blockNumber: "2000000",
      calls: [
        { id: "call-dup", target: "0x1234567890abcdef1234567890abcdef12345678", callData: "0x" },
        { id: "call-dup", target: "0x1234567890abcdef1234567890abcdef12345678", callData: "0x" },
      ],
    };
    expect(() => parseMulticallAtBlockRequest(req)).toThrowError(/Duplicate call id/);
  });

  it("parses nativeBalanceAtBlock and ERC-20 multicall requests", () => {
    const nativeReq = parseNativeBalanceAtBlockRequest({
      chain: "base",
      address: "0x1234567890ABCDEF1234567890ABCDEF12345678",
      blockNumber: "15000000",
    });
    expect(nativeReq.chainId).toBe(8453);
    expect(nativeReq.address).toBe("0x1234567890abcdef1234567890abcdef12345678");

    const erc20Req = parseErc20MulticallAtBlockRequest({
      chain: 1,
      calls: [
        {
          id: "bal-1",
          tokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
          method: "balanceOf",
          owner: "0x1234567890ABCDEF1234567890ABCDEF12345678",
        },
        {
          id: "dec-1",
          tokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
          method: "decimals",
        },
      ],
    });
    expect(erc20Req.chainId).toBe(1);
    expect(erc20Req.calls).toHaveLength(2);
  });
});
