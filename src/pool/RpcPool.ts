import type { Clock, RandomSource } from "../execution/clock";
import { systemClock, systemRandom } from "../execution/clock";
import { CooldownTracker, type CooldownState } from "../execution/CooldownTracker";
import { shuffle } from "../execution/RandomSource";
import { ArchiveRpcTransport, type ArchiveRpcCallOptions } from "../transport/ArchiveRpcTransport";
import type { SqliteCooldownStore } from "../storage/SqliteCooldownStore";
import { BUILTIN_ETHEREUM_RPCS } from "./builtinEthereumRpcs";
import { BUILTIN_BASE_RPCS } from "./builtinBaseRpcs";
import { BUILTIN_BSC_RPCS } from "./builtinBscRpcs";
import { BUILTIN_BSC_TESTNET_RPCS } from "./builtinBscTestnetRpcs";
import { BUILTIN_POLYGON_RPCS } from "./builtinPolygonRpcs";
import { BUILTIN_POLYGON_AMOY_RPCS } from "./builtinPolygonAmoyRpcs";
import { BUILTIN_ARBITRUM_RPCS } from "./builtinArbitrumRpcs";
import { BUILTIN_ARBITRUM_SEPOLIA_RPCS } from "./builtinArbitrumSepoliaRpcs";
import { BUILTIN_SONEIUM_RPCS } from "./builtinSoneiumRpcs";
import { BUILTIN_SONEIUM_MINATO_RPCS } from "./builtinSoneiumMinatoRpcs";

export const BUILTIN_RPCS_BY_CHAIN: Readonly<Record<number, readonly RpcEndpoint[]>> = Object.freeze({
  1: BUILTIN_ETHEREUM_RPCS,
  56: BUILTIN_BSC_RPCS,
  97: BUILTIN_BSC_TESTNET_RPCS,
  137: BUILTIN_POLYGON_RPCS,
  80002: BUILTIN_POLYGON_AMOY_RPCS,
  1868: BUILTIN_SONEIUM_RPCS,
  1946: BUILTIN_SONEIUM_MINATO_RPCS,
  8453: BUILTIN_BASE_RPCS,
  42161: BUILTIN_ARBITRUM_RPCS,
  421614: BUILTIN_ARBITRUM_SEPOLIA_RPCS,
});

export type RpcEndpointTag = "archive" | "full";

export interface RpcEndpoint {
  readonly id: string;
  readonly url: string;
  readonly envKeyName?: string;
  readonly tag?: RpcEndpointTag | string;
}

export interface EndpointCooldownState {
  readonly id: string;
  readonly tag: string;
  readonly envKeyName?: string | undefined;
  readonly isMaxCooldown: boolean;
  readonly isCoolingDown: boolean;
  readonly currentCooldownMs: number;
  readonly totalCooldownDurationMs: number;
  readonly consecutiveFailures: number;
  readonly cooldownUntil: number | null;
}

export type RpcOutcome = "success" | "failure";

export interface CooldownChangeEvent {
  readonly id: string;
  readonly envKeyName?: string | undefined;
  readonly category: "rpc";
  readonly state: CooldownState;
}

export interface HealthySnapshotFilter {
  /** If true, only endpoints with tag "archive" (or default archive) are returned. */
  readonly requireArchive?: boolean;
  /**
   * If true (and requireArchive is not true), prefer healthy "full" endpoints first.
   * If any healthy "full" endpoints exist, return them.
   * If no healthy "full" endpoints exist, fallback to "archive" endpoints.
   * Defaults to true when requireArchive is false.
   */
  readonly preferFull?: boolean;
  /** Explicitly match a specific tag (e.g. "archive" or "full"). */
  readonly tag?: RpcEndpointTag | string;
  /**
   * If true and all matching endpoints are cooling down or probe-unhealthy,
   * fallback to returning the least-cooling-down (earliest expiring / lowest failure count)
   * endpoints instead of an empty array.
   */
  readonly fallbackToEarliestExpiring?: boolean;
}

export interface RpcPoolOptions {
  readonly chainId?: number | undefined;
  readonly endpoints?: readonly (RpcEndpoint | string)[] | undefined;
  readonly appendBuiltins?: boolean | undefined;
  readonly transport?: ArchiveRpcTransport | undefined;
  readonly cooldownStore?: SqliteCooldownStore | undefined;
  /** Historical block to probe for Archive depth (e.g. "18000000"). Pass "latest" or null to probe latest head. */
  readonly probeBlockNumber?: string | number | bigint | null | undefined;
  readonly healthCheckTimeoutMs?: number | undefined;
  readonly maxConcurrentProbes?: number | undefined;
  readonly healthRefreshCooldownMs?: number | undefined;
  readonly clock?: Clock | undefined;
  readonly onCooldownChange?: ((event: CooldownChangeEvent) => void) | undefined;
  /**
   * For non-archive calls, whether to prioritize healthy "full" nodes to save archive quota.
   * If true: prefers "full" nodes, falling back to "archive" if no "full" nodes are available.
   * If false: pools all healthy "full" and "archive" nodes together in equal load balancing.
   * Defaults to true.
   */
  readonly preferFull?: boolean | undefined;
  /**
   * Enable decorrelated jitter on cooldown backoffs to prevent thundering herd.
   * Defaults to false for deterministic testing.
   */
  readonly enableCooldownJitter?: boolean | undefined;
  /**
   * If true, healthySnapshot defaults to falling back to earliest-expiring endpoints when all are cooling down.
   */
  readonly fallbackToEarliestExpiring?: boolean | undefined;
}

const DEFAULT_HEALTH_CHECK_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_CONCURRENT_PROBES = 5;
const DEFAULT_HEALTH_REFRESH_COOLDOWN_MS = 5_000;

export class RpcPool {
  readonly chainId: number;
  private readonly endpoints: readonly RpcEndpoint[];
  private readonly transport: ArchiveRpcTransport;
  private readonly cooldownStore?: SqliteCooldownStore | undefined;
  private readonly probeBlockNumber?: bigint | undefined;
  private readonly healthCheckTimeoutMs: number;
  private readonly maxConcurrentProbes: number;
  private readonly healthRefreshCooldownMs: number;
  private readonly clock: Clock;
  private readonly defaultPreferFull: boolean;
  private readonly defaultFallbackToEarliestExpiring: boolean;
  private readonly healthy = new Map<string, boolean>();
  private readonly trackers = new Map<string, CooldownTracker>();
  private readonly onCooldownChange?: ((event: CooldownChangeEvent) => void) | undefined;
  private lastHealthRefreshAt = 0;
  private healthRefreshPromise: Promise<void> | undefined;

  constructor(options: RpcPoolOptions = {}) {
    this.chainId = options.chainId ?? 1;
    this.transport = options.transport ?? new ArchiveRpcTransport();
    this.cooldownStore = options.cooldownStore;
    this.defaultPreferFull = options.preferFull ?? true;
    this.defaultFallbackToEarliestExpiring = options.fallbackToEarliestExpiring ?? false;
    if (options.probeBlockNumber === "latest" || options.probeBlockNumber === null) {
      this.probeBlockNumber = undefined;
    } else if (options.probeBlockNumber !== undefined) {
      this.probeBlockNumber = BigInt(options.probeBlockNumber);
    } else {
      this.probeBlockNumber = this.chainId === 1 ? 18_000_000n : undefined;
    }
    this.healthCheckTimeoutMs = options.healthCheckTimeoutMs ?? DEFAULT_HEALTH_CHECK_TIMEOUT_MS;
    this.maxConcurrentProbes = Math.max(1, options.maxConcurrentProbes ?? DEFAULT_MAX_CONCURRENT_PROBES);
    this.healthRefreshCooldownMs = Math.max(0, options.healthRefreshCooldownMs ?? DEFAULT_HEALTH_REFRESH_COOLDOWN_MS);
    this.clock = options.clock ?? systemClock;
    this.onCooldownChange = options.onCooldownChange;

    const resolvedEndpoints = resolveEndpoints(
      this.chainId,
      options.endpoints,
      options.appendBuiltins ?? false,
    );

    const ids = new Set<string>();
    for (const ep of resolvedEndpoints) {
      if (ids.has(ep.id)) {
        throw new Error(`Duplicate RPC endpoint id: ${ep.id}`);
      }
      ids.add(ep.id);
    }
    this.endpoints = Object.freeze(resolvedEndpoints);

    for (const ep of this.endpoints) {
      this.healthy.set(ep.id, false);
      const tracker = new CooldownTracker({
        clock: this.clock,
        enableJitter: options.enableCooldownJitter ?? false,
      });
      this.trackers.set(ep.id, tracker);
    }

    if (this.cooldownStore !== undefined) {
      this.restoreFromStore();
    }
  }

  getEndpoints(): readonly RpcEndpoint[] {
    return this.endpoints;
  }

  /**
   * Concurrently probes every configured endpoint bounded by `maxConcurrentProbes`.
   * @param options.reviveCooldown If true, endpoints that pass probe will have active cooldowns cleared. Defaults to false.
   */
  async initialize(
    signal?: AbortSignal,
    options?: { readonly reviveCooldown?: boolean },
  ): Promise<void> {
    this.lastHealthRefreshAt = this.clock.now();
    const reviveCooldown = options?.reviveCooldown ?? false;
    await runBounded(this.endpoints, this.maxConcurrentProbes, async (endpoint) => {
      const isOk = await this.probeEndpoint(endpoint, signal);
      this.healthy.set(endpoint.id, isOk);
      if (isOk && reviveCooldown) {
        const tracker = this.trackers.get(endpoint.id);
        if (tracker !== undefined && tracker.isCoolingDown(this.clock.now())) {
          tracker.recordSuccess();
          this.cooldownStore?.delete(endpoint.id);
        }
      }
    });
  }

  /**
   * Re-probes endpoints when all are unhealthy or cooling down, debounced by cooldown.
   * On successful re-probe, revives cooling down endpoints to break deadlock.
   */
  async refreshIfNeeded(
    signal?: AbortSignal,
    filter?: HealthySnapshotFilter,
    options?: { readonly reviveCooldown?: boolean },
  ): Promise<void> {
    const now = this.clock.now();
    const available = this.filterHealthyEndpoints(filter, now);
    if (available.length > 0) {
      return;
    }

    if (this.healthRefreshPromise !== undefined) {
      return this.healthRefreshPromise;
    }

    if (now - this.lastHealthRefreshAt < this.healthRefreshCooldownMs) {
      return;
    }

    this.healthRefreshPromise = this.initialize(signal, {
      reviveCooldown: options?.reviveCooldown ?? true,
    }).finally(() => {
      this.healthRefreshPromise = undefined;
    });

    return this.healthRefreshPromise;
  }

  isHealthy(id: string, now = this.clock.now()): boolean {
    const probeHealthy = this.healthy.get(id) ?? false;
    if (!probeHealthy) {
      return false;
    }
    const tracker = this.trackers.get(id);
    if (tracker !== undefined && tracker.isCoolingDown(now)) {
      return false;
    }
    return true;
  }

  /**
   * Filters healthy endpoints matching given tag or archive requirements.
   */
  private filterHealthyEndpoints(
    filter?: HealthySnapshotFilter,
    now = this.clock.now(),
  ): readonly RpcEndpoint[] {
    const healthyEndpoints = this.endpoints.filter((ep) => this.isHealthy(ep.id, now));

    let candidates: readonly RpcEndpoint[];
    if (filter?.tag !== undefined) {
      candidates = healthyEndpoints.filter((ep) => (ep.tag ?? "archive") === filter.tag);
    } else if (filter?.requireArchive) {
      candidates = healthyEndpoints.filter((ep) => (ep.tag ?? "archive") === "archive");
    } else {
      // Non-archive requests: prefer healthy "full" nodes to save archive quota,
      // falling back to "archive" nodes if no healthy "full" nodes exist.
      const preferFull = filter?.preferFull ?? this.defaultPreferFull;
      if (preferFull) {
        const fullCandidates = healthyEndpoints.filter((ep) => (ep.tag ?? "archive") === "full");
        if (fullCandidates.length > 0) {
          candidates = fullCandidates;
        } else {
          candidates = healthyEndpoints.filter((ep) => (ep.tag ?? "archive") === "archive");
        }
      } else {
        candidates = healthyEndpoints;
      }
    }

    const allowFallback =
      filter?.fallbackToEarliestExpiring ?? this.defaultFallbackToEarliestExpiring;
    if (candidates.length === 0 && allowFallback) {
      let poolCandidates = this.endpoints;
      if (filter?.tag !== undefined) {
        poolCandidates = poolCandidates.filter((ep) => (ep.tag ?? "archive") === filter.tag);
      } else if (filter?.requireArchive) {
        poolCandidates = poolCandidates.filter((ep) => (ep.tag ?? "archive") === "archive");
      }
      if (poolCandidates.length > 0) {
        const sorted = [...poolCandidates].sort((a, b) => {
          const healthyA = this.healthy.get(a.id) ? 1 : 0;
          const healthyB = this.healthy.get(b.id) ? 1 : 0;
          if (healthyA !== healthyB) return healthyB - healthyA;

          const stateA = this.trackers.get(a.id)?.getState(now);
          const stateB = this.trackers.get(b.id)?.getState(now);
          const untilA = stateA?.cooldownUntil ?? 0;
          const untilB = stateB?.cooldownUntil ?? 0;
          if (untilA !== untilB) return untilA - untilB;

          return (stateA?.consecutiveFailures ?? 0) - (stateB?.consecutiveFailures ?? 0);
        });
        return sorted.slice(0, 3);
      }
    }

    return candidates;
  }

  /**
   * Returns healthy endpoints in an unbiased random permutation,
   * intelligently filtered by archive requirement or endpoint tag.
   */
  healthySnapshot(
    arg1?: RandomSource | (HealthySnapshotFilter & { readonly randomSource?: RandomSource; readonly now?: number }),
    arg2?: HealthySnapshotFilter | number,
    arg3?: number,
  ): readonly RpcEndpoint[] {
    let randomSource: RandomSource = systemRandom;
    let filter: HealthySnapshotFilter | undefined;
    let now = this.clock.now();

    if (arg1 !== undefined) {
      if (isRandomSource(arg1)) {
        randomSource = arg1;
        if (typeof arg2 === "number") {
          now = arg2;
        } else if (arg2 !== undefined && typeof arg2 === "object") {
          filter = arg2;
          if (typeof arg3 === "number") {
            now = arg3;
          }
        }
      } else if (typeof arg1 === "object" && arg1 !== null) {
        filter = arg1;
        if (arg1.randomSource !== undefined) {
          randomSource = arg1.randomSource;
        }
        if (typeof arg1.now === "number") {
          now = arg1.now;
        }
      }
    } else if (arg2 !== undefined) {
      if (typeof arg2 === "number") {
        now = arg2;
      } else if (typeof arg2 === "object" && arg2 !== null) {
        filter = arg2;
        if (typeof arg3 === "number") {
          now = arg3;
        }
      }
    }

    const candidates = this.filterHealthyEndpoints(filter, now);
    if (filter?.fallbackToEarliestExpiring) {
      return Object.freeze(candidates);
    }
    return Object.freeze(shuffle(candidates, randomSource));
  }

  /**
   * Reports the outcome of a request against endpoint `id`.
   */
  reportOutcome(id: string, outcome: RpcOutcome, now = this.clock.now()): void {
    const tracker = this.trackers.get(id);
    if (tracker === undefined || !this.healthy.has(id)) {
      return;
    }

    if (outcome === "success") {
      tracker.recordSuccess();
      this.healthy.set(id, true);
      this.cooldownStore?.delete(id);
    } else {
      tracker.recordFailure(now);
      const state = tracker.getState(now);
      this.cooldownStore?.save(id, state, now);
    }

    const endpoint = this.endpoints.find((candidate) => candidate.id === id);
    this.onCooldownChange?.({
      id,
      envKeyName: endpoint?.envKeyName,
      category: "rpc",
      state: tracker.getState(now),
    });
  }

  restoreCooldownState(
    id: string,
    state: {
      readonly consecutiveFailures: number;
      readonly currentCooldownMs: number;
      readonly cooldownUntil: number | null;
      readonly firstFailureAt: number | null;
    },
  ): boolean {
    const tracker = this.trackers.get(id);
    if (tracker === undefined) {
      return false;
    }
    tracker.restoreState(state);
    return true;
  }

  getEndpointCooldownState(id: string, now = this.clock.now()): EndpointCooldownState | null {
    const endpoint = this.endpoints.find((candidate) => candidate.id === id);
    const tracker = this.trackers.get(id);
    if (endpoint === undefined || tracker === undefined) {
      return null;
    }
    const state = tracker.getState(now);
    return Object.freeze({
      id: endpoint.id,
      tag: endpoint.tag ?? "archive",
      ...(endpoint.envKeyName !== undefined ? { envKeyName: endpoint.envKeyName } : {}),
      isMaxCooldown: state.isMaxCooldown,
      isCoolingDown: state.isCoolingDown,
      currentCooldownMs: state.currentCooldownMs,
      totalCooldownDurationMs: state.totalCooldownDurationMs,
      consecutiveFailures: state.consecutiveFailures,
      cooldownUntil: state.cooldownUntil,
    });
  }

  getAllCooldownStates(now = this.clock.now()): readonly EndpointCooldownState[] {
    return Object.freeze(
      this.endpoints.map((endpoint) => this.getEndpointCooldownState(endpoint.id, now)!),
    );
  }

  private restoreFromStore(): void {
    if (this.cooldownStore === undefined) return;
    const records = this.cooldownStore.loadAll();
    for (const record of records) {
      this.restoreCooldownState(record.endpointId, record);
    }
  }

  private async probeEndpoint(endpoint: RpcEndpoint, signal?: AbortSignal): Promise<boolean> {
    try {
      // 1. eth_chainId check
      const chainIdHex = await this.callProbe(endpoint, "eth_chainId", [], signal);
      if (typeof chainIdHex !== "string") {
        return false;
      }
      try {
        if (BigInt(chainIdHex) !== BigInt(this.chainId)) {
          return false;
        }
      } catch {
        return false;
      }

      // 2. eth_getBlockByNumber check
      // Archive nodes probe probeBlockNumber; full nodes probe "latest".
      const isArchive = (endpoint.tag ?? "archive") === "archive";
      const targetBlockNumber = isArchive ? this.probeBlockNumber : undefined;
      const blockTag =
        targetBlockNumber !== undefined
          ? `0x${targetBlockNumber.toString(16)}`
          : "latest";

      const block = await this.callProbe(endpoint, "eth_getBlockByNumber", [blockTag, false], signal);
      if (!isValidBlockHeader(block, targetBlockNumber)) {
        return false;
      }

      return true;
    } catch {
      return false;
    }
  }

  private async callProbe(
    endpoint: RpcEndpoint,
    method: string,
    params: readonly unknown[],
    signal?: AbortSignal,
  ): Promise<unknown> {
    const options: ArchiveRpcCallOptions = {
      endpointUrl: endpoint.url,
      method,
      params,
      timeoutMs: this.healthCheckTimeoutMs,
      ...(signal === undefined ? {} : { signal }),
    };
    return this.transport.call(options);
  }
}

function resolveEndpoints(
  chainId: number,
  customEndpoints?: readonly (RpcEndpoint | string)[],
  appendBuiltins = false,
): RpcEndpoint[] {
  const result: RpcEndpoint[] = [];
  const normalizedCustom: RpcEndpoint[] = (customEndpoints ?? []).map((entry, index) => {
    if (typeof entry === "string") {
      let host = `custom-${index + 1}`;
      try {
        const parsed = new URL(entry);
        host = parsed.hostname.replace(/[^a-zA-Z0-9-]/g, "-");
      } catch {
        // fallback
      }
      return { id: `custom-${index + 1}-${host}`, url: entry, tag: "archive" };
    }
    return {
      ...entry,
      tag: entry.tag ?? "archive",
    };
  });

  result.push(...normalizedCustom);

  if (result.length === 0 || appendBuiltins) {
    const builtins = BUILTIN_RPCS_BY_CHAIN[chainId] ?? [];
    result.push(
      ...builtins.map((ep) => ({
        ...ep,
        tag: ep.tag ?? "archive",
      })),
    );
  }

  return result;
}

function isValidBlockHeader(value: unknown, expectedBlockNumber?: bigint): boolean {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const block = value as { hash?: unknown; number?: unknown; timestamp?: unknown };
  if (typeof block.hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(block.hash)) {
    return false;
  }
  if (typeof block.number !== "string" || !/^0x[0-9a-fA-F]+$/.test(block.number)) {
    return false;
  }
  if (expectedBlockNumber !== undefined) {
    if (BigInt(block.number) !== expectedBlockNumber) {
      return false;
    }
  }
  if (typeof block.timestamp !== "string" || !/^0x[0-9a-fA-F]+$/.test(block.timestamp)) {
    return false;
  }
  return true;
}

async function runBounded<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  async function next(): Promise<void> {
    for (;;) {
      const current = index;
      index += 1;
      if (current >= items.length) {
        return;
      }
      await worker(items[current]!);
    }
  }
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, () => next());
  await Promise.all(runners);
}

function isRandomSource(val: unknown): val is RandomSource {
  return typeof val === "object" && val !== null && typeof (val as { next?: unknown }).next === "function";
}
