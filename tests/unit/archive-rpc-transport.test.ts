import { describe, expect, it, vi } from "vitest";

import {
  ArchiveRpcTransport,
  JsonRpcCallError,
  isJsonRpcCallError,
} from "../../src/transport/ArchiveRpcTransport";
import {
  HttpTransportError,
  type HttpRequest,
  type HttpResponse,
  type HttpTransport,
} from "../../src/transport/HttpTransport";

function fakeTransport(
  handler: (request: HttpRequest) => HttpResponse | Promise<HttpResponse>,
): HttpTransport & { readonly request: ReturnType<typeof vi.fn> } {
  return { request: vi.fn((request: HttpRequest) => Promise.resolve(handler(request))) };
}

const ENDPOINT = "https://archive-rpc.example/rpc";

describe("ArchiveRpcTransport", () => {
  it("sends a well-formed JSON-RPC 2.0 POST request", async () => {
    const httpTransport = fakeTransport(() => ({
      status: 200,
      headers: {},
      body: { jsonrpc: "2.0", id: 1, result: "0x1" },
    }));
    const transport = new ArchiveRpcTransport({ httpTransport });

    const result = await transport.call({
      endpointUrl: ENDPOINT,
      method: "eth_chainId",
      params: [],
      timeoutMs: 5_000,
    });

    expect(result).toBe("0x1");
    expect(httpTransport.request).toHaveBeenCalledTimes(1);
    const request = httpTransport.request.mock.calls[0]![0] as HttpRequest;
    expect(request.method).toBe("POST");
    expect(request.url).toBe(ENDPOINT);
    expect(request.body).toEqual({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] });
    expect(request.headers).toEqual({ "content-type": "application/json" });
    expect(request.timeoutMs).toBe(5_000);
  });

  it("forwards params and an AbortSignal when provided", async () => {
    const httpTransport = fakeTransport(() => ({
      status: 200,
      headers: {},
      body: { jsonrpc: "2.0", id: 1, result: {} },
    }));
    const transport = new ArchiveRpcTransport({ httpTransport });
    const controller = new AbortController();

    await transport.call({
      endpointUrl: ENDPOINT,
      method: "eth_getBlockByNumber",
      params: ["0x112a880", false],
      timeoutMs: 5_000,
      signal: controller.signal,
    });

    const request = httpTransport.request.mock.calls[0]![0] as HttpRequest;
    expect(request.body).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getBlockByNumber",
      params: ["0x112a880", false],
    });
    expect(request.signal).toBe(controller.signal);
  });

  it("omits signal from the underlying request when not provided", async () => {
    const httpTransport = fakeTransport(() => ({
      status: 200,
      headers: {},
      body: { jsonrpc: "2.0", id: 1, result: "0x1" },
    }));
    const transport = new ArchiveRpcTransport({ httpTransport });

    await transport.call({ endpointUrl: ENDPOINT, method: "eth_chainId", params: [], timeoutMs: 5_000 });

    const request = httpTransport.request.mock.calls[0]![0] as HttpRequest;
    expect("signal" in request).toBe(false);
  });

  it("rejects a non-HTTPS endpoint URL without calling the transport", async () => {
    const httpTransport = fakeTransport(() => ({ status: 200, headers: {}, body: {} }));
    const transport = new ArchiveRpcTransport({ httpTransport });

    await expect(
      transport.call({ endpointUrl: "http://insecure.example/rpc", method: "eth_chainId", params: [], timeoutMs: 5_000 }),
    ).rejects.toMatchObject({ code: "ARCHIVE_RPC_UNAVAILABLE" });
    expect(httpTransport.request).not.toHaveBeenCalled();
  });

  it("rejects a malformed endpoint URL without calling the transport", async () => {
    const httpTransport = fakeTransport(() => ({ status: 200, headers: {}, body: {} }));
    const transport = new ArchiveRpcTransport({ httpTransport });

    await expect(
      transport.call({ endpointUrl: "not-a-url", method: "eth_chainId", params: [], timeoutMs: 5_000 }),
    ).rejects.toMatchObject({ code: "ARCHIVE_RPC_UNAVAILABLE" });
    expect(httpTransport.request).not.toHaveBeenCalled();
  });

  it("treats a non-2xx HTTP status as archive RPC unavailable", async () => {
    const httpTransport = fakeTransport(() => ({ status: 502, headers: {}, body: {} }));
    const transport = new ArchiveRpcTransport({ httpTransport });

    await expect(
      transport.call({ endpointUrl: ENDPOINT, method: "eth_chainId", params: [], timeoutMs: 5_000 }),
    ).rejects.toMatchObject({ code: "ARCHIVE_RPC_UNAVAILABLE" });
  });

  it("rejects a response body that is not a JSON-RPC envelope", async () => {
    const httpTransport = fakeTransport(() => ({ status: 200, headers: {}, body: "not-an-object" }));
    const transport = new ArchiveRpcTransport({ httpTransport });

    await expect(
      transport.call({ endpointUrl: ENDPOINT, method: "eth_chainId", params: [], timeoutMs: 5_000 }),
    ).rejects.toMatchObject({ code: "RPC_RESPONSE_INVALID" });
  });

  it("rejects a response with neither result nor error", async () => {
    const httpTransport = fakeTransport(() => ({ status: 200, headers: {}, body: { jsonrpc: "2.0", id: 1 } }));
    const transport = new ArchiveRpcTransport({ httpTransport });

    await expect(
      transport.call({ endpointUrl: ENDPOINT, method: "eth_chainId", params: [], timeoutMs: 5_000 }),
    ).rejects.toMatchObject({ code: "RPC_RESPONSE_INVALID" });
  });

  it("throws JsonRpcCallError for a well-formed node-level error envelope", async () => {
    const httpTransport = fakeTransport(() => ({
      status: 200,
      headers: {},
      body: { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "archive state unavailable" } },
    }));
    const transport = new ArchiveRpcTransport({ httpTransport });

    const error = await transport
      .call({ endpointUrl: ENDPOINT, method: "eth_call", params: [], timeoutMs: 5_000 })
      .catch((thrown: unknown) => thrown);

    expect(isJsonRpcCallError(error)).toBe(true);
    expect((error as JsonRpcCallError).rpcCode).toBe(-32000);
    expect((error as JsonRpcCallError).rpcMessage).toBe("archive state unavailable");
    expect((error as JsonRpcCallError).message).not.toContain(ENDPOINT);
  });

  it("maps a REQUEST_TIMEOUT transport error to a retryable archive RPC unavailable error", async () => {
    const httpTransport = fakeTransport(() => {
      throw new HttpTransportError({ code: "REQUEST_TIMEOUT", message: "timed out", retryable: true });
    });
    const transport = new ArchiveRpcTransport({ httpTransport });

    await expect(
      transport.call({ endpointUrl: ENDPOINT, method: "eth_chainId", params: [], timeoutMs: 5_000 }),
    ).rejects.toMatchObject({ code: "ARCHIVE_RPC_UNAVAILABLE", retryable: true });
  });

  it("maps a REQUEST_ABORTED transport error to archive RPC unavailable", async () => {
    const httpTransport = fakeTransport(() => {
      throw new HttpTransportError({ code: "REQUEST_ABORTED", message: "aborted", retryable: false });
    });
    const transport = new ArchiveRpcTransport({ httpTransport });

    await expect(
      transport.call({ endpointUrl: ENDPOINT, method: "eth_chainId", params: [], timeoutMs: 5_000 }),
    ).rejects.toMatchObject({ code: "ARCHIVE_RPC_UNAVAILABLE" });
  });

  it("never includes the endpoint URL in any thrown error message", async () => {
    const httpTransport = fakeTransport(() => ({ status: 502, headers: {}, body: {} }));
    const transport = new ArchiveRpcTransport({ httpTransport });

    const error = await transport
      .call({ endpointUrl: ENDPOINT, method: "eth_chainId", params: [], timeoutMs: 5_000 })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(ENDPOINT);
  });

  describe("batchCall", () => {
    it("returns empty array immediately if requests are empty", async () => {
      const httpTransport = fakeTransport(() => ({ status: 200, headers: {}, body: [] }));
      const transport = new ArchiveRpcTransport({ httpTransport });

      const results = await transport.batchCall({
        endpointUrl: ENDPOINT,
        requests: [],
        timeoutMs: 5_000,
      });

      expect(results).toEqual([]);
      expect(httpTransport.request).not.toHaveBeenCalled();
    });

    it("sends a JSON-RPC batch POST and aligns out-of-order responses by id", async () => {
      const httpTransport = fakeTransport((request) => {
        expect(request.body).toEqual([
          { jsonrpc: "2.0", id: "req-1", method: "eth_blockNumber", params: [] },
          { jsonrpc: "2.0", id: "req-2", method: "eth_getBalance", params: ["0x1234", "latest"] },
        ]);
        return {
          status: 200,
          headers: {},
          body: [
            { jsonrpc: "2.0", id: "req-2", result: "0x100" },
            { jsonrpc: "2.0", id: "req-1", result: "0x12" },
          ],
        };
      });
      const transport = new ArchiveRpcTransport({ httpTransport });

      const results = await transport.batchCall({
        endpointUrl: ENDPOINT,
        requests: [
          { id: "req-1", method: "eth_blockNumber", params: [] },
          { id: "req-2", method: "eth_getBalance", params: ["0x1234", "latest"] },
        ],
        timeoutMs: 5_000,
      });

      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({ id: "req-1", success: true, result: "0x12" });
      expect(results[1]).toEqual({ id: "req-2", success: true, result: "0x100" });
    });

    it("handles item-level errors without failing entire batch", async () => {
      const httpTransport = fakeTransport(() => ({
        status: 200,
        headers: {},
        body: [
          { jsonrpc: "2.0", id: 1, result: "0xabc" },
          { jsonrpc: "2.0", id: 2, error: { code: 3, message: "execution reverted", data: "0x" } },
        ],
      }));
      const transport = new ArchiveRpcTransport({ httpTransport });

      const results = await transport.batchCall({
        endpointUrl: ENDPOINT,
        requests: [
          { id: 1, method: "eth_call", params: [] },
          { id: 2, method: "eth_call", params: [] },
        ],
        timeoutMs: 5_000,
      });

      expect(results[0]).toEqual({ id: 1, success: true, result: "0xabc" });
      expect(results[1]).toEqual({
        id: 2,
        success: false,
        error: { code: 3, message: "execution reverted", data: "0x" },
      });
    });

    it("throws JsonRpcCallError if node rejects the whole batch with a single error envelope", async () => {
      const httpTransport = fakeTransport(() => ({
        status: 200,
        headers: {},
        body: { jsonrpc: "2.0", error: { code: -32600, message: "Batch requests not supported" } },
      }));
      const transport = new ArchiveRpcTransport({ httpTransport });

      await expect(
        transport.batchCall({
          endpointUrl: ENDPOINT,
          requests: [{ id: 1, method: "eth_blockNumber" }],
          timeoutMs: 5_000,
        }),
      ).rejects.toThrow(JsonRpcCallError);
    });

    it("handles missing item response from node as an item error", async () => {
      const httpTransport = fakeTransport(() => ({
        status: 200,
        headers: {},
        body: [{ jsonrpc: "2.0", id: 1, result: "0x1" }],
      }));
      const transport = new ArchiveRpcTransport({ httpTransport });

      const results = await transport.batchCall({
        endpointUrl: ENDPOINT,
        requests: [
          { id: 1, method: "eth_blockNumber" },
          { id: 2, method: "eth_blockNumber" },
        ],
        timeoutMs: 5_000,
      });

      expect(results[0]?.success).toBe(true);
      expect(results[1]?.success).toBe(false);
      expect(results[1]?.error?.code).toBe(-32603);
    });
  });
});
