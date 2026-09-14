import { describe, expect, it } from "vitest";

import { shuffle } from "../../src/execution/RandomSource";
import type { RandomSource } from "../../src/execution/clock";

function sequenceSource(values: readonly number[]): RandomSource {
  let index = 0;
  return {
    next: () => {
      const value = values[index];
      if (value === undefined) {
        throw new Error("Random source sequence exhausted.");
      }
      index += 1;
      return value;
    },
  };
}

describe("shuffle", () => {
  it("does not mutate the input array", () => {
    const input = Object.freeze(["a", "b", "c"]);
    shuffle(input, sequenceSource([0, 0, 0]));
    expect(input).toEqual(["a", "b", "c"]);
  });

  it("returns a new array instance", () => {
    const input = ["a", "b", "c"];
    const result = shuffle(input, sequenceSource([0, 0, 0]));
    expect(result).not.toBe(input);
  });

  it("preserves every element exactly once (permutation, not resampling)", () => {
    const input = ["a", "b", "c", "d", "e"];
    const result = shuffle(input, sequenceSource([0.9, 0.1, 0.5, 0.99, 0]));
    expect([...result].sort()).toEqual([...input].sort());
    expect(result).toHaveLength(input.length);
  });

  it("handles an empty array", () => {
    expect(shuffle([], sequenceSource([]))).toEqual([]);
  });

  it("handles a single-element array without consuming randomness", () => {
    const result = shuffle(["only"], sequenceSource([]));
    expect(result).toEqual(["only"]);
  });

  it("always returning 0 reverses the array (deterministic worst case for Fisher-Yates)", () => {
    const input = [1, 2, 3, 4];
    const result = shuffle(input, sequenceSource([0, 0, 0]));
    expect(result).toEqual([2, 3, 4, 1]);
  });

  it("always returning just under 1 produces the expected fixed permutation", () => {
    const input = [1, 2, 3, 4];
    const result = shuffle(input, sequenceSource([0.999, 0.999, 0.999]));
    expect(result).toEqual([1, 2, 3, 4]);
  });

  it("covers every possible position over many distinct seeded shuffles", () => {
    const input = ["a", "b", "c"];
    const firstPositions = new Set<string>();
    for (let seed = 0; seed < 20; seed += 1) {
      const r1 = (seed * 0.13) % 1;
      const r2 = (seed * 0.37) % 1;
      const result = shuffle(input, sequenceSource([r1, r2]));
      firstPositions.add(result[0]!);
    }
    expect(firstPositions.size).toBe(3);
  });

  it("never calls the random source more times than values.length - 1", () => {
    let calls = 0;
    const source: RandomSource = {
      next: () => {
        calls += 1;
        return 0;
      },
    };
    shuffle([1, 2, 3, 4, 5], source);
    expect(calls).toBe(4);
  });
});
