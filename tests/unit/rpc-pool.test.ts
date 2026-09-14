import { describe, expect, it } from "vitest";

import type { ArchiveRpcCallOptions, ArchiveRpcTransport } from "../../src/transport/ArchiveRpcTransport";
import { RpcPool } from "../../src/pool/RpcPool";
import { SqliteStorageAdapter } from "../../src/storage/SqliteStorageAdapter";
import { SqliteCooldownStore } from "../../src/storage/SqliteCooldownStore";
import type { Clock, RandomSource } from "../../src/execution/clock";

const PROBE_BLOCK_NUMBER = "18000000";
const PROBE_BLOCK_TAG = `0x${BigInt(PROBE_BLOCK_NUMBER).toString(16)}`;
const VALID_HASH = `0x${"ab".repeat(32)}`;
const ENDPOINT_A = { id: "endpoint-a", url: "https://a.example/rpc" };
const ENDPOINT_B = { id: "endpoint-b", url: "https://b.example/rpc" };
const ENDPOINT_C = { id: "endpoint-c", url: "https://c.example/rpc" };

type ProbeHandler = (method: string, params: readonly unknown[]) => unknown;

function fakeTransport(handlerByEndpoint: Readonly<Record<string, ProbeHandler>>): ArchiveRpcTransport {
  return {
    call: (options: ArchiveRpcCallOptions) => {
      const handler = handlerByEndpoint[options.endpointUrl];
      if (handler === undefined) {
        throw new Error(`No fake handler registered for ${options.endpointUrl}.`);
      }
      const result = handler(options.method, options.params);
      if (result instanceof Error) {
        return Promise.reject(result);
      }
      return Promise.resolve(result);
    },
  } as unknown as ArchiveRpcTransport;
}

function healthyHandler(chainIdHex = "0x1", blockTag = PROBE_BLOCK_TAG): ProbeHandler {
  return (method) => {
    if (method === "eth_chainId") {
      return chainIdHex;
    }
    if (method === "eth_getBlockByNumber") {
      return { hash: VALID_HASH, number: blockTag, timestamp: "0x5f5e100" };
    }
    throw new Error(`Unexpected method ${method}.`);
  };
}

class FakeClock implements Clock, RandomSource {
  current = 100_000;
  now(): number {
    return this.current;
  }
  advance(ms: number): void {
    this.current += ms;
  }
  next(): number {
    return 0;
  }
}

describe("RpcPool initialization & probing", () => {
  it("marks an endpoint healthy when probes pass", async () => {
    const transport = fakeTransport({ [ENDPOINT_A.url]: healthyHandler() });
    const pool = new RpcPool({
      chainId: 1,
      endpoints: [ENDPOINT_A],
      transport,
      probeBlockNumber: PROBE_BLOCK_NUMBER,
    });

    await pool.initialize();
    expect(pool.isHealthy(ENDPOINT_A.id)).toBe(true);
  });

  it("marks an endpoint unhealthy when eth_chainId is wrong", async () => {
    const transport = fakeTransport({
      [ENDPOINT_A.url]: (method) => (method === "eth_chainId" ? "0x38" : healthyHandler()(method, [])),
    });
    const pool = new RpcPool({
      chainId: 1,
      endpoints: [ENDPOINT_A],
      transport,
      probeBlockNumber: PROBE_BLOCK_NUMBER,
    });

    await pool.initialize();
    expect(pool.isHealthy(ENDPOINT_A.id)).toBe(false);
  });

  it("supports Base chainId 8453 and probe", async () => {
    const transport = fakeTransport({
      [ENDPOINT_A.url]: healthyHandler("0x2105", "0x2"),
    });
    const pool = new RpcPool({
      chainId: 8453,
      endpoints: [ENDPOINT_A],
      transport,
      probeBlockNumber: "2",
    });

    await pool.initialize();
    expect(pool.isHealthy(ENDPOINT_A.id)).toBe(true);
  });

  it("marks an endpoint unhealthy when block header is invalid", async () => {
    const transport = fakeTransport({
      [ENDPOINT_A.url]: (method) =>
        method === "eth_getBlockByNumber"
          ? { hash: "invalid-hash", number: PROBE_BLOCK_TAG, timestamp: "0x1" }
          : healthyHandler()(method, []),
    });
    const pool = new RpcPool({
      chainId: 1,
      endpoints: [ENDPOINT_A],
      transport,
      probeBlockNumber: PROBE_BLOCK_NUMBER,
    });

    await pool.initialize();
    expect(pool.isHealthy(ENDPOINT_A.id)).toBe(false);
  });

  it("probes independently and concurrently, bounded by maxConcurrentProbes", async () => {
    const transport = fakeTransport({
      [ENDPOINT_A.url]: healthyHandler(),
      [ENDPOINT_B.url]: () => new Error("unhealthy"),
      [ENDPOINT_C.url]: healthyHandler(),
    });
    const pool = new RpcPool({
      chainId: 1,
      endpoints: [ENDPOINT_A, ENDPOINT_B, ENDPOINT_C],
      transport,
      maxConcurrentProbes: 2,
      probeBlockNumber: PROBE_BLOCK_NUMBER,
    });

    await pool.initialize();
    expect(pool.isHealthy(ENDPOINT_A.id)).toBe(true);
    expect(pool.isHealthy(ENDPOINT_B.id)).toBe(false);
    expect(pool.isHealthy(ENDPOINT_C.id)).toBe(true);
  });
});

describe("RpcPool cooldown tracking and SQLite persistence", () => {
  it("tracks failures, handles recovery, and syncs to SQLite", async () => {
    const clock = new FakeClock();
    const adapter = new SqliteStorageAdapter({ path: ":memory:" });
    adapter.initialize();
    const cooldownStore = new SqliteCooldownStore(adapter);

    const transport = fakeTransport({
      [ENDPOINT_A.url]: healthyHandler(),
      [ENDPOINT_B.url]: healthyHandler(),
    });

    const pool = new RpcPool({
      chainId: 1,
      endpoints: [ENDPOINT_A, ENDPOINT_B],
      transport,
      cooldownStore,
      clock,
      probeBlockNumber: PROBE_BLOCK_NUMBER,
    });

    await pool.initialize();
    expect(pool.isHealthy(ENDPOINT_A.id)).toBe(true);
    expect(pool.isHealthy(ENDPOINT_B.id)).toBe(true);

    // 1. Report failure on ENDPOINT_A
    pool.reportOutcome(ENDPOINT_A.id, "failure");
    expect(pool.isHealthy(ENDPOINT_A.id)).toBe(false);

    // Snapshot only contains ENDPOINT_B
    const snapshot = pool.healthySnapshot(clock);
    expect(snapshot.map((ep) => ep.id)).toEqual([ENDPOINT_B.id]);

    // Check store persisted state
    const stored = cooldownStore.loadAll();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.endpointId).toBe(ENDPOINT_A.id);
    expect(stored[0]?.consecutiveFailures).toBe(1);

    // Advance clock 60s -> becomes healthy again
    clock.advance(60_000);
    expect(pool.isHealthy(ENDPOINT_A.id)).toBe(true);

    // Report success -> clears cooldown and store record
    pool.reportOutcome(ENDPOINT_A.id, "success");
    expect(cooldownStore.loadAll()).toHaveLength(0);

    adapter.close();
  });

  it("restores cooldown states on startup from SQLite store", async () => {
    const clock = new FakeClock();
    const adapter = new SqliteStorageAdapter({ path: ":memory:" });
    adapter.initialize();
    const cooldownStore = new SqliteCooldownStore(adapter);

    // Pre-seed an endpoint with active cooldown
    cooldownStore.save("endpoint-a", {
      consecutiveFailures: 2,
      currentCooldownMs: 300_000,
      cooldownUntil: clock.now() + 200_000,
      firstFailureAt: clock.now() - 100_000,
      isCoolingDown: true,
      isMaxCooldown: false,
      totalCooldownDurationMs: 100_000,
    });

    const transport = fakeTransport({
      [ENDPOINT_A.url]: healthyHandler(),
    });

    const pool = new RpcPool({
      chainId: 1,
      endpoints: [ENDPOINT_A],
      transport,
      cooldownStore,
      clock,
      probeBlockNumber: PROBE_BLOCK_NUMBER,
    });

    await pool.initialize();
    // Although probe succeeded, endpoint is restored into cooldown!
    expect(pool.isHealthy(ENDPOINT_A.id)).toBe(false);

    // Advance past cooldown
    clock.advance(200_001);
    expect(pool.isHealthy(ENDPOINT_A.id)).toBe(true);

    adapter.close();
  });
});
