import { describe, expect, it } from "vitest";

import type { Clock } from "../../src/execution/clock";
import { CooldownTracker, COOLDOWN_TIERS_MS, MAX_COOLDOWN_MS } from "../../src/execution/CooldownTracker";

class FakeClock implements Clock {
  current = 1_000_000;

  now(): number {
    return this.current;
  }

  advance(ms: number): void {
    this.current += ms;
  }
}

describe("CooldownTracker", () => {
  it("initializes with clean state", () => {
    const clock = new FakeClock();
    const tracker = new CooldownTracker({ clock });

    expect(tracker.isCoolingDown()).toBe(false);
    expect(tracker.isMaxCooldown()).toBe(false);
    expect(tracker.getTotalCooldownDuration()).toBe(0);

    const state = tracker.getState();
    expect(state).toEqual({
      consecutiveFailures: 0,
      currentCooldownMs: 0,
      cooldownUntil: null,
      firstFailureAt: null,
      isCoolingDown: false,
      isMaxCooldown: false,
      totalCooldownDurationMs: 0,
    });
  });

  it("sets 1 minute cooldown on first failure and 5 minutes on second failure", () => {
    const clock = new FakeClock();
    const tracker = new CooldownTracker({ clock });

    const cd1 = tracker.recordFailure();
    expect(cd1).toBe(60_000);
    expect(tracker.isCoolingDown()).toBe(true);
    expect(tracker.isMaxCooldown()).toBe(false);
    expect(tracker.getTotalCooldownDuration()).toBe(0);

    // Advance 30 seconds: still cooling down
    clock.advance(30_000);
    expect(tracker.isCoolingDown()).toBe(true);
    expect(tracker.getTotalCooldownDuration()).toBe(30_000);

    // Advance 30 more seconds: cooldown expired (total 60s)
    clock.advance(30_000);
    expect(tracker.isCoolingDown()).toBe(false);
    expect(tracker.getTotalCooldownDuration()).toBe(60_000);

    // Second failure: 5 minutes (300,000 ms)
    const cd2 = tracker.recordFailure();
    expect(cd2).toBe(300_000);
    expect(tracker.isCoolingDown()).toBe(true);
    expect(tracker.isMaxCooldown()).toBe(false);
    expect(tracker.getState().firstFailureAt).toBe(1_000_000);

    clock.advance(300_000);
    expect(tracker.isCoolingDown()).toBe(false);
    expect(tracker.getTotalCooldownDuration()).toBe(360_000);
  });

  it("steps through tiers and caps at 24 hours (86,400,000 ms)", () => {
    const clock = new FakeClock();
    const tracker = new CooldownTracker({ clock });

    for (let i = 0; i < COOLDOWN_TIERS_MS.length; i += 1) {
      const cd = tracker.recordFailure();
      expect(cd).toBe(COOLDOWN_TIERS_MS[i]);
      if (i < COOLDOWN_TIERS_MS.length - 1) {
        expect(tracker.isMaxCooldown()).toBe(false);
      } else {
        expect(tracker.isMaxCooldown()).toBe(true);
      }
    }

    // 10th failure reaches max 24h
    expect(tracker.isMaxCooldown()).toBe(true);
    expect(tracker.getState().currentCooldownMs).toBe(MAX_COOLDOWN_MS);

    // 11th and 12th failure remains capped at 24h
    const cd11 = tracker.recordFailure();
    expect(cd11).toBe(MAX_COOLDOWN_MS);
    expect(tracker.isMaxCooldown()).toBe(true);

    const cd12 = tracker.recordFailure();
    expect(cd12).toBe(MAX_COOLDOWN_MS);
    expect(tracker.isMaxCooldown()).toBe(true);
  });

  it("resets all state on recordSuccess()", () => {
    const clock = new FakeClock();
    const tracker = new CooldownTracker({ clock });

    tracker.recordFailure();
    tracker.recordFailure();
    clock.advance(10_000);
    expect(tracker.isCoolingDown()).toBe(true);
    expect(tracker.getTotalCooldownDuration()).toBe(10_000);

    tracker.recordSuccess();
    expect(tracker.isCoolingDown()).toBe(false);
    expect(tracker.isMaxCooldown()).toBe(false);
    expect(tracker.getTotalCooldownDuration()).toBe(0);

    const state = tracker.getState();
    expect(state).toEqual({
      consecutiveFailures: 0,
      currentCooldownMs: 0,
      cooldownUntil: null,
      firstFailureAt: null,
      isCoolingDown: false,
      isMaxCooldown: false,
      totalCooldownDurationMs: 0,
    });

    // After success, next failure starts back at tier 1 (1 min)
    const cdNext = tracker.recordFailure();
    expect(cdNext).toBe(60_000);
    expect(tracker.getState().firstFailureAt).toBe(clock.now());
  });

  it("restores state properly", () => {
    const tracker = new CooldownTracker();
    tracker.restoreState({
      consecutiveFailures: 3,
      currentCooldownMs: 900_000,
      cooldownUntil: 2_000_000,
      firstFailureAt: 1_100_000,
    });

    const state = tracker.getState(1_500_000);
    expect(state.consecutiveFailures).toBe(3);
    expect(state.currentCooldownMs).toBe(900_000);
    expect(state.isCoolingDown).toBe(true);
    expect(state.totalCooldownDurationMs).toBe(400_000);
  });

  it("supports explicit now argument overrides", () => {
    const tracker = new CooldownTracker();
    const startTime = 2_000_000;

    tracker.recordFailure(startTime);
    expect(tracker.isCoolingDown(startTime + 30_000)).toBe(true);
    expect(tracker.isCoolingDown(startTime + 60_000)).toBe(false);
    expect(tracker.isCoolingDown(startTime + 70_000)).toBe(false);
    expect(tracker.getTotalCooldownDuration(startTime + 45_000)).toBe(45_000);
  });
});
