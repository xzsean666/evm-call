import { invalidRequest, rpcResponseInvalid } from "../domain/errors";

/** Canonical deterministic-deployment Multicall3 address on Ethereum Mainnet and 200+ chains. */
export const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11";

/** `aggregate3((address,bool,bytes)[])` 4-byte selector. */
export const MULTICALL3_AGGREGATE3_SELECTOR = "82ad56cb";

/** First Ethereum Mainnet block containing deployed Multicall3 code. */
export const MULTICALL3_ETHEREUM_MAINNET_DEPLOYMENT_BLOCK = 14_353_601n;

/** First Base Mainnet block containing the canonical Multicall3 deployment. */
export const MULTICALL3_BASE_MAINNET_DEPLOYMENT_BLOCK = 5_022n;

/** Multicall3 `getBlockNumber()` 4-byte selector, used for archive-depth health probes. */
export const MULTICALL3_GET_BLOCK_NUMBER_SELECTOR = "42cbb15c";

/** Multicall3 `getEthBalance(address)` 4-byte selector. */
export const MULTICALL3_GET_ETH_BALANCE_SELECTOR = "4d2301cc";

/** Known deployment block per chain for canonical Multicall3 contract. */
export const MULTICALL3_DEPLOYMENT_BLOCKS: Readonly<Record<number, bigint>> = Object.freeze({
  1: MULTICALL3_ETHEREUM_MAINNET_DEPLOYMENT_BLOCK,
  8453: MULTICALL3_BASE_MAINNET_DEPLOYMENT_BLOCK,
  10: 4_218_602n,     // Optimism
  42161: 765_470n,    // Arbitrum One
  137: 25_770_160n,   // Polygon
  56: 15_921_452n,    // BSC
  43114: 11_907_934n, // Avalanche
  59144: 42n,         // Linea
  534352: 222_771n,   // Scroll
  11155111: 751_534n, // Sepolia
  84532: 1_059_647n,  // Base Sepolia
});

export function getMulticall3DeploymentBlock(chainId: number): bigint | undefined {
  return MULTICALL3_DEPLOYMENT_BLOCKS[chainId];
}

export interface Aggregate3CallInput {
  readonly target: string;
  readonly allowFailure: boolean;
  /** 0x-prefixed call data, even-length hex. */
  readonly callData: string;
}

export interface Aggregate3CallOutput {
  readonly success: boolean;
  /** 0x-prefixed return/revert data, even-length hex. */
  readonly returnData: string;
}

/**
 * Encodes a full `eth_call` payload (selector plus ABI-encoded argument) for
 * `aggregate3` given an ordered call list. Preserves input order.
 */
export function encodeAggregate3(calls: readonly Aggregate3CallInput[]): string {
  const encodedCalls = calls.map((call) => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(call.target)) {
      throw invalidRequest("Multicall3 aggregate3 call target must be a 20-byte address.");
    }
    const dataHex = normalizeCallDataHex(call.callData);
    // Tuple layout for (address,bool,bytes): target(32) + allowFailure(32) +
    // offset-to-bytes(32, relative to this tuple's start, always 96 because
    // the two static fields occupy exactly 3 words) + bytes length + data.
    return `${wordAddress(call.target)}${wordUint(call.allowFailure ? 1n : 0n)}${wordUint(96n)}${wordUint(BigInt(dataHex.length / 2))}${padRight(dataHex)}`;
  });

  const offsets: string[] = [];
  // Dynamic-tuple element offsets are relative to the start of the
  // element-offset table (immediately after the array length word), not to
  // the beginning of the whole array argument.
  let offset = BigInt(calls.length * 32);
  for (const encoded of encodedCalls) {
    offsets.push(wordUint(offset));
    offset += BigInt(encoded.length / 2);
  }

  return `0x${MULTICALL3_AGGREGATE3_SELECTOR}${wordUint(32n)}${wordUint(BigInt(calls.length))}${offsets.join("")}${encodedCalls.join("")}`;
}

/**
 * Decodes the single `uint256` result of Multicall3's own `getBlockNumber()`.
 */
export function decodeGetBlockNumberResult(returnData: string): bigint {
  if (typeof returnData !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(returnData)) {
    throw rpcResponseInvalid("Multicall3 getBlockNumber() return data must be exactly one 32-byte word.");
  }
  return BigInt(returnData);
}

/**
 * Encodes a call to Multicall3's `getEthBalance(address)`.
 */
export function encodeGetEthBalance(address: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw invalidRequest("Multicall3 getEthBalance target address must be a 20-byte address.");
  }
  return `0x${MULTICALL3_GET_ETH_BALANCE_SELECTOR}${wordAddress(address)}`;
}

/**
 * Decodes the single `uint256` result of Multicall3's `getEthBalance(address)`.
 */
export function decodeGetEthBalanceResult(returnData: string): bigint {
  if (typeof returnData !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(returnData)) {
    throw rpcResponseInvalid("Multicall3 getEthBalance return data must be exactly one 32-byte word.");
  }
  return BigInt(returnData);
}

/**
 * Decodes the `(bool success, bytes returnData)[]` result of `aggregate3`.
 * `expectedCount` must equal the number of calls submitted; a mismatch is
 * treated as malformed rather than silently truncated or padded.
 */
export function decodeAggregate3Result(
  returnData: string,
  expectedCount: number,
): readonly Aggregate3CallOutput[] {
  if (typeof returnData !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(returnData)) {
    throw rpcResponseInvalid("Multicall3 aggregate3 return data must be even-length hex.");
  }
  const hex = returnData.slice(2);
  const wordCount = hex.length / 64;

  const word = (offset: number): bigint => {
    if (offset < 0 || offset % 32 !== 0) {
      throw rpcResponseInvalid("Multicall3 aggregate3 return data word offset is misaligned.");
    }
    const slice = hex.slice(offset * 2, (offset + 32) * 2);
    if (slice.length !== 64) {
      throw rpcResponseInvalid("Multicall3 aggregate3 return data is truncated.");
    }
    return BigInt(`0x${slice}`);
  };

  if (wordCount < 1) {
    throw rpcResponseInvalid("Multicall3 aggregate3 return data is too short to contain an array offset.");
  }
  const arrayOffset = requireSafeOffset(word(0), "array");
  const length = requireSafeLength(word(arrayOffset));
  if (length !== expectedCount) {
    throw rpcResponseInvalid("Multicall3 aggregate3 returned a different result count than requested.");
  }

  const tupleBase = arrayOffset + 32;
  const results: Aggregate3CallOutput[] = [];
  for (let index = 0; index < length; index += 1) {
    const tupleOffset = requireSafeOffset(word(tupleBase + index * 32), "tuple");
    const tupleStart = tupleBase + tupleOffset;
    if (tupleOffset < length * 32) {
      throw rpcResponseInvalid("Multicall3 aggregate3 tuple offset points before the offset table.");
    }

    const success = word(tupleStart);
    if (success !== 0n && success !== 1n) {
      throw rpcResponseInvalid("Multicall3 aggregate3 tuple success flag must be a canonical bool.");
    }

    const dataOffset = requireSafeOffset(word(tupleStart + 32), "bytes");
    if (dataOffset !== 64) {
      throw rpcResponseInvalid("Multicall3 aggregate3 tuple bytes offset must be exactly 64.");
    }
    const dataStart = tupleStart + dataOffset;
    const dataLength = requireSafeLength(word(dataStart));
    const dataHexStart = (dataStart + 32) * 2;
    if (dataHexStart > hex.length) {
      throw rpcResponseInvalid("Multicall3 aggregate3 tuple bytes offset exceeds return data length.");
    }
    const dataHex = hex.slice(dataHexStart, dataHexStart + dataLength * 2);
    if (dataHex.length !== dataLength * 2) {
      throw rpcResponseInvalid("Multicall3 aggregate3 tuple bytes data is truncated.");
    }

    results.push(Object.freeze({ success: success === 1n, returnData: `0x${dataHex}` }));
  }

  return Object.freeze(results);
}

function requireSafeOffset(value: bigint, label: string): number {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0 || numeric % 32 !== 0) {
    throw rpcResponseInvalid(`Multicall3 aggregate3 ${label} offset is out of range.`);
  }
  return numeric;
}

function requireSafeLength(value: bigint): number {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw rpcResponseInvalid("Multicall3 aggregate3 length is out of range.");
  }
  return numeric;
}

function normalizeCallDataHex(value: string): string {
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) {
    throw invalidRequest("Multicall3 aggregate3 call data must be even-length hex.");
  }
  return value.slice(2).toLowerCase();
}

function wordUint(value: bigint): string {
  if (value < 0n || value >= 1n << 256n) {
    throw invalidRequest("ABI uint256 out of range.");
  }
  return value.toString(16).padStart(64, "0");
}

function wordAddress(value: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw invalidRequest("Invalid ABI address.");
  }
  return value.slice(2).toLowerCase().padStart(64, "0");
}

function padRight(value: string): string {
  return value.padEnd(Math.ceil(value.length / 64) * 64, "0");
}
