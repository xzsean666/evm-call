export interface Clock {
  now(): number;
}

export interface RandomSource {
  next(): number;
}

export const systemClock: Clock = Object.freeze({
  now: () => Date.now(),
});

export const systemRandom: RandomSource = Object.freeze({
  next: () => Math.random(),
});

export type WaitFunction = (delayMs: number, signal?: AbortSignal) => Promise<void>;

export const systemWait: WaitFunction = (delayMs, signal) => {
  if (delayMs <= 0) {
    if (signal?.aborted === true) {
      return Promise.reject(abortedError());
    }
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      signal?.removeEventListener("abort", onAbort);
      reject(abortedError());
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    if (signal !== undefined) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
};

function abortedError(): Error {
  const error = new Error("Operation aborted while waiting.");
  error.name = "AbortError";
  return error;
}
