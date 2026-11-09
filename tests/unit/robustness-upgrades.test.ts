import { describe, expect, it } from "vitest";
import { RpcPool, BUILTIN_RPCS_BY_CHAIN } from "../../src/pool";
import { CooldownTracker } from "../../src/execution/CooldownTracker";
import { JsonRpcBatchExecutor } from "../../src/batch/JsonRpcBatchExecutor";
import { EthereumArchiveRpcExecutor } from "../../src/multicall/EthereumArchiveRpcExecutor";
import type { ArchiveRpcCallOptions, ArchiveRpcTransport } from "../../src/transport/ArchiveRpcTransport";
import type { Clock } from "../../src/execution/clock";

class FakeClock implements Clock {
  current = 1_000_000;
  now(): number {
    return this.current;
  }
  advance(ms: number): void {
    this.current += ms;
  }
}

function fakeTransport(handlerByEndpoint: Readonly<Record<string, (method: string) => unknown>>): ArchiveRpcTransport {
  return {
    call: (options: ArchiveRpcCallOptions) => {
      const handler = handlerByEndpoint[options.endpointUrl];
      if (handler === undefined) {
        throw new Error(`No fake handler registered for ${options.endpointUrl}.`);
      }
      const result = handler(options.method);
      if (result instanceof Error) {
        return Promise.reject(result);
      }
      return Promise.resolve(result);
    },
    batchCall: () => Promise.resolve([]),
  } as unknown as ArchiveRpcTransport;
}

describe("Robustness & Load Balancing Upgrades", () => {
  describe("Builtin RPC Auto-Routing", () => {
    const supportedChains = [
      { chainId: 1, name: "Ethereum" },
      { chainId: 56, name: "BSC" },
      { chainId: 97, name: "BSC Testnet" },
      { chainId: 137, name: "Polygon" },
      { chainId: 80002, name: "Polygon Amoy" },
      { chainId: 8453, name: "Base" },
      { chainId: 42161, name: "Arbitrum" },
      { chainId: 421614, name: "Arbitrum Sepolia" },
      { chainId: 1868, name: "Soneium" },
      { chainId: 1946, name: "Soneium Minato" },
    ];

    for (const { chainId, name } of supportedChains) {
      it(`auto-resolves builtin RPCs for ${name} (chain ${chainId})`, () => {
        const pool = new RpcPool({ chainId });
        const endpoints = pool.getEndpoints();
        expect(endpoints.length).toBeGreaterThan(0);
        expect(BUILTIN_RPCS_BY_CHAIN[chainId]).toBeDefined();
        expect(endpoints.length).toBe(BUILTIN_RPCS_BY_CHAIN[chainId]!.length);
      });
    }
  });

  describe("Cooldown Deadlock Recovery (refreshIfNeeded)", () => {
    it("revives cooling down endpoints when probe passes during refreshIfNeeded", async () => {
      const clock = new FakeClock();
      const endpoint = { id: "ep-1", url: "https://ep1.example.com" };

      let isNodeHealthy = true;
      const transport = fakeTransport({
        [endpoint.url]: (method) => {
          if (!isNodeHealthy) {
            throw new Error("Node connection refused");
          }
          if (method === "eth_chainId") return "0x1";
          if (method === "eth_getBlockByNumber") {
            return { hash: `0x${"11".repeat(32)}`, number: "0x112a880", timestamp: "0x5f5e100" };
          }
          throw new Error(`Unexpected probe method ${method}`);
        },
      });

      const pool = new RpcPool({
        chainId: 1,
        endpoints: [endpoint],
        transport,
        clock,
        probeBlockNumber: "18000000",
      });

      await pool.initialize();
      expect(pool.isHealthy(endpoint.id)).toBe(true);

      // Node encounters a failure and enters 60s cooldown
      pool.reportOutcome(endpoint.id, "failure");
      expect(pool.isHealthy(endpoint.id)).toBe(false);
      expect(pool.healthySnapshot()).toHaveLength(0);

      // Advance clock past the 5s refresh debounce window
      clock.advance(6_000);

      // Node is now back online. Calling refreshIfNeeded probes the node and clears cooldown!
      await pool.refreshIfNeeded();
      expect(pool.isHealthy(endpoint.id)).toBe(true);
      expect(pool.healthySnapshot()).toHaveLength(1);
    });
  });

  describe("Graceful Degradation (fallbackToEarliestExpiring)", () => {
    it("falls back to the earliest-expiring endpoints when all endpoints are in cooldown", () => {
      const clock = new FakeClock();
      const ep1 = { id: "ep-1", url: "https://ep1.example.com", tag: "archive" };
      const ep2 = { id: "ep-2", url: "https://ep2.example.com", tag: "archive" };

      const pool = new RpcPool({
        chainId: 1,
        endpoints: [ep1, ep2],
        clock,
      });

      // Mock both as initially probe-healthy
      (pool as unknown as { healthy: Map<string, boolean> }).healthy.set("ep-1", true);
      (pool as unknown as { healthy: Map<string, boolean> }).healthy.set("ep-2", true);

      // ep1 fails twice (5m cooldown), ep2 fails once (1m cooldown)
      pool.reportOutcome("ep-1", "failure", clock.now());
      pool.reportOutcome("ep-1", "failure", clock.now());
      pool.reportOutcome("ep-2", "failure", clock.now());

      expect(pool.isHealthy("ep-1")).toBe(false);
      expect(pool.isHealthy("ep-2")).toBe(false);

      // Normal healthySnapshot without fallback is empty
      expect(pool.healthySnapshot()).toHaveLength(0);

      // Fallback returns ep2 first (earliest cooldown expiration / fewest failures)
      const degraded = pool.healthySnapshot(undefined, { fallbackToEarliestExpiring: true });
      expect(degraded.length).toBeGreaterThan(0);
      expect(degraded[0]?.id).toBe("ep-2");
    });
  });

  describe("AbortSignal Safety (No Unfair Failure Penalties)", () => {
    it("does not report failure when batch executor encounters client AbortError", async () => {
      let reportedFailure = false;
      const pool = {
        chainId: 1,
        healthySnapshot: () => [{ id: "ep-1", url: "https://ep1.example.com" }],
        reportOutcome: (_id: string, outcome: string) => {
          if (outcome === "failure") {
            reportedFailure = true;
          }
        },
      };

      const controller = new AbortController();
      controller.abort(); // pre-aborted

      const executor = new JsonRpcBatchExecutor({
        pool: pool as unknown as any,
        transport: {
          batchCall: () => Promise.reject(new Error("This operation was aborted")),
        } as unknown as ArchiveRpcTransport,
      });

      await expect(
        executor.call({ id: 1, method: "eth_blockNumber", params: [] }, { signal: controller.signal }),
      ).rejects.toThrow();

      // Ensure failure was NOT reported against the node
      expect(reportedFailure).toBe(false);
    });

    it("does not report failure when archive executor encounters client abort", async () => {
      let reportedFailure = false;
      const pool = {
        chainId: 1,
        healthySnapshot: () => [{ id: "ep-1", url: "https://ep1.example.com" }],
        reportOutcome: (_id: string, outcome: string) => {
          if (outcome === "failure") {
            reportedFailure = true;
          }
        },
      };

      const controller = new AbortController();
      controller.abort();

      const executor = new EthereumArchiveRpcExecutor({
        pool: pool as unknown as any,
        transport: {
          call: () => Promise.reject(new Error("aborted")),
        } as unknown as ArchiveRpcTransport,
      });

      await expect(
        executor.findLatestBlockNumber(controller.signal),
      ).rejects.toThrow();

      expect(reportedFailure).toBe(false);
    });
  });

  describe("Cooldown Jitter Support", () => {
    it("applies jitter variation when enableJitter is enabled", () => {
      const clock = new FakeClock();
      const tracker = new CooldownTracker({
        clock,
        enableJitter: true,
        jitterRatio: 0.2, // 20% jitter
      });

      const cd = tracker.recordFailure();
      // Base is 60_000, 20% jitter means range [48_000, 72_000]
      expect(cd).toBeGreaterThanOrEqual(48_000);
      expect(cd).toBeLessThanOrEqual(72_000);
    });
  });
});
