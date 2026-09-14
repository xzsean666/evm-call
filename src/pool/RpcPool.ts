import type { Clock, RandomSource } from "../execution/clock";
import { systemClock, systemRandom } from "../execution/clock";
import { CooldownTracker, type CooldownState } from "../execution/CooldownTracker";
import { shuffle } from "../execution/RandomSource";
import { ArchiveRpcTransport, type ArchiveRpcCallOptions } from "../transport/ArchiveRpcTransport";
import type { SqliteCooldownStore } from "../storage/SqliteCooldownStore";
import { BUILTIN_ETHEREUM_RPCS } from "./builtinEthereumRpcs";
import { BUILTIN_BASE_RPCS } from "./builtinBaseRpcs";

export interface RpcEndpoint {
  readonly id: string;
  readonly url: string;
  readonly envKeyName?: string;
}

export interface EndpointCooldownState {
  readonly id: string;
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
  private readonly healthy = new Map<string, boolean>();
  private readonly trackers = new Map<string, CooldownTracker>();
  private readonly onCooldownChange?: ((event: CooldownChangeEvent) => void) | undefined;
  private lastHealthRefreshAt = 0;
  private healthRefreshPromise: Promise<void> | undefined;

  constructor(options: RpcPoolOptions = {}) {
    this.chainId = options.chainId ?? 1;
    this.transport = options.transport ?? new ArchiveRpcTransport();
    this.cooldownStore = options.cooldownStore;
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
      const tracker = new CooldownTracker({ clock: this.clock });
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
   */
  async initialize(signal?: AbortSignal): Promise<void> {
    this.lastHealthRefreshAt = this.clock.now();
    await runBounded(this.endpoints, this.maxConcurrentProbes, async (endpoint) => {
      const isOk = await this.probeEndpoint(endpoint, signal);
      this.healthy.set(endpoint.id, isOk);
    });
  }

  /**
   * Re-probes endpoints when all are unhealthy or cooling down, debounced by cooldown.
   */
  async refreshIfNeeded(signal?: AbortSignal): Promise<void> {
    const now = this.clock.now();
    const anyAvailable = this.endpoints.some((ep) => this.isHealthy(ep.id, now));
    if (anyAvailable) {
      return;
    }

    if (this.healthRefreshPromise !== undefined) {
      return this.healthRefreshPromise;
    }

    if (now - this.lastHealthRefreshAt < this.healthRefreshCooldownMs) {
      return;
    }

    this.healthRefreshPromise = this.initialize(signal).finally(() => {
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
   * Returns healthy endpoints in an unbiased random permutation.
   */
  healthySnapshot(randomSource: RandomSource = systemRandom, now = this.clock.now()): readonly RpcEndpoint[] {
    const candidates = this.endpoints.filter((ep) => this.isHealthy(ep.id, now));
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
      const blockTag =
        this.probeBlockNumber !== undefined
          ? `0x${this.probeBlockNumber.toString(16)}`
          : "latest";

      const block = await this.callProbe(endpoint, "eth_getBlockByNumber", [blockTag, false], signal);
      if (!isValidBlockHeader(block, this.probeBlockNumber)) {
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
      return { id: `custom-${index + 1}-${host}`, url: entry };
    }
    return entry;
  });

  result.push(...normalizedCustom);

  if (result.length === 0 || appendBuiltins) {
    if (chainId === 1) {
      result.push(...BUILTIN_ETHEREUM_RPCS);
    } else if (chainId === 8453) {
      result.push(...BUILTIN_BASE_RPCS);
    }
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
