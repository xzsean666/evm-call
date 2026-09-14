import type { Clock } from "./clock";
import { systemClock } from "./clock";

export const COOLDOWN_TIERS_MS: readonly number[] = [
  60_000, // 1m
  300_000, // 5m
  900_000, // 15m
  1_800_000, // 30m
  3_600_000, // 1h
  7_200_000, // 2h
  14_400_000, // 4h
  28_800_000, // 8h
  43_200_000, // 12h
  86_400_000, // 24h
];

export const MAX_COOLDOWN_MS = 86_400_000;

export interface CooldownTrackerOptions {
  readonly clock?: Clock;
  readonly cooldownTiersMs?: readonly number[];
}

export interface CooldownState {
  readonly consecutiveFailures: number;
  readonly currentCooldownMs: number;
  readonly cooldownUntil: number | null;
  readonly firstFailureAt: number | null;
  readonly isCoolingDown: boolean;
  readonly isMaxCooldown: boolean;
  readonly totalCooldownDurationMs: number;
}

export class CooldownTracker {
  private readonly clock: Clock;
  private readonly tiers: readonly number[];
  private consecutiveFailures = 0;
  private currentCooldownMs = 0;
  private cooldownUntil: number | null = null;
  private firstFailureAt: number | null = null;

  constructor(options: CooldownTrackerOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.tiers = options.cooldownTiersMs ?? COOLDOWN_TIERS_MS;
  }

  recordFailure(now = this.clock.now()): number {
    this.consecutiveFailures += 1;
    const tierIndex = Math.min(this.consecutiveFailures - 1, this.tiers.length - 1);
    this.currentCooldownMs = this.tiers[tierIndex]!;
    if (this.firstFailureAt === null) {
      this.firstFailureAt = now;
    }
    this.cooldownUntil = now + this.currentCooldownMs;
    return this.currentCooldownMs;
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.currentCooldownMs = 0;
    this.cooldownUntil = null;
    this.firstFailureAt = null;
  }

  restoreState(state: {
    readonly consecutiveFailures: number;
    readonly currentCooldownMs: number;
    readonly cooldownUntil: number | null;
    readonly firstFailureAt: number | null;
  }): void {
    this.consecutiveFailures = Math.max(0, state.consecutiveFailures);
    this.currentCooldownMs = Math.max(0, state.currentCooldownMs);
    this.cooldownUntil = state.cooldownUntil;
    this.firstFailureAt = state.firstFailureAt;
  }

  isCoolingDown(now = this.clock.now()): boolean {
    return this.cooldownUntil !== null && this.cooldownUntil > now;
  }

  isMaxCooldown(): boolean {
    const maxTier = this.tiers[this.tiers.length - 1] ?? MAX_COOLDOWN_MS;
    return this.currentCooldownMs >= maxTier;
  }

  getTotalCooldownDuration(now = this.clock.now()): number {
    if (this.firstFailureAt === null) {
      return 0;
    }
    return Math.max(0, now - this.firstFailureAt);
  }

  getState(now = this.clock.now()): CooldownState {
    return Object.freeze({
      consecutiveFailures: this.consecutiveFailures,
      currentCooldownMs: this.currentCooldownMs,
      cooldownUntil: this.cooldownUntil,
      firstFailureAt: this.firstFailureAt,
      isCoolingDown: this.isCoolingDown(now),
      isMaxCooldown: this.isMaxCooldown(),
      totalCooldownDurationMs: this.getTotalCooldownDuration(now),
    });
  }
}
