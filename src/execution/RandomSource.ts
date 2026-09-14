import type { RandomSource } from "./clock";
import { systemRandom } from "./clock";

export type { RandomSource };
export { systemRandom };

/**
 * Fisher-Yates shuffle. Produces an unbiased permutation given a uniform
 * `randomSource.next()` returning values in `[0, 1)`. Does not mutate input.
 */
export function shuffle<T>(values: readonly T[], randomSource: RandomSource = systemRandom): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(randomSource.next() * (index + 1));
    const temp = result[index]!;
    result[index] = result[swapIndex]!;
    result[swapIndex] = temp;
  }
  return result;
}
