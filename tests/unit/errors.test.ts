import { describe, expect, it } from "vitest";

import {
  EvmCallError,
  archiveRpcUnavailable,
  archiveRpcWrongChain,
  archiveStateUnavailable,
  invalidConfiguration,
  invalidRequest,
  isEvmCallError,
  multicallNotDeployedAtBlock,
  multicallResponseInvalid,
  requestAborted,
  requestTimeout,
  rpcBlockNotFound,
  rpcBlockReorgDetected,
  rpcResponseInvalid,
  storageBusy,
  storageError,
  unsupportedChain,
} from "../../src/domain/errors";

describe("EvmCallError and error hierarchy", () => {
  it("exposes expected fields with correct retryable semantics", () => {
    const err = new EvmCallError({
      code: "ARCHIVE_RPC_UNAVAILABLE",
      message: "Node timed out",
      retryable: true,
      chainId: 1,
      rpcEndpointId: "node-1",
      retryAfterMs: 5000,
    });

    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("EvmCallError");
    expect(err.code).toBe("ARCHIVE_RPC_UNAVAILABLE");
    expect(err.retryable).toBe(true);
    expect(err.chainId).toBe(1);
    expect(err.rpcEndpointId).toBe("node-1");
    expect(err.retryAfterMs).toBe(5000);
    expect(isEvmCallError(err)).toBe(true);
    expect(isEvmCallError(new Error("standard"))).toBe(false);
  });

  it("sanitizes causes to prevent sensitive data leakage", () => {
    const rawCause = { secretToken: "sensitive-token-12345", key: "supersecret" };
    const err = new EvmCallError({
      code: "ARCHIVE_RPC_UNAVAILABLE",
      message: "Failed request",
      retryable: true,
      cause: rawCause,
    });

    expect(err.cause).toEqual({ type: "object" });
    expect(JSON.stringify(err)).not.toContain("sensitive-token-12345");

    const errorCause = Object.assign(new Error("Net error"), { code: "ECONNREFUSED", status: 502 });
    const errWithErrCause = new EvmCallError({
      code: "ARCHIVE_RPC_UNAVAILABLE",
      message: "Failed request",
      retryable: true,
      cause: errorCause,
    });
    expect(errWithErrCause.cause).toEqual({ name: "Error", code: "ECONNREFUSED", status: 502 });
  });

  it("produces correct retryable flags across helper factories", () => {
    expect(archiveRpcUnavailable("down").retryable).toBe(true);
    expect(archiveStateUnavailable("missing").retryable).toBe(true);
    expect(rpcBlockNotFound("not synced").retryable).toBe(true);
    expect(rpcBlockReorgDetected("reorg").retryable).toBe(true);
    expect(storageBusy("busy").retryable).toBe(true);
    expect(requestTimeout("timeout").retryable).toBe(true);

    expect(archiveRpcWrongChain("wrong chain").retryable).toBe(false);
    expect(rpcResponseInvalid("bad json").retryable).toBe(false);
    expect(invalidRequest("bad param").retryable).toBe(false);
    expect(invalidConfiguration("bad config").retryable).toBe(false);
    expect(unsupportedChain("chain unknown").retryable).toBe(false);
    expect(multicallNotDeployedAtBlock("early block").retryable).toBe(false);
    expect(multicallResponseInvalid("malformed data").retryable).toBe(false);
    expect(storageError("disk error").retryable).toBe(false);
    expect(requestAborted("aborted").retryable).toBe(false);
  });
});
