import { z } from "zod";

import { invalidRequest } from "./errors";

export interface MulticallAtBlockCall {
  readonly id: string;
  readonly target: string;
  readonly callData: string;
  readonly allowFailure?: boolean;
}

export interface MulticallAtBlockRequest {
  readonly chain: number | string;
  readonly blockNumber: string | number | bigint;
  readonly calls: readonly MulticallAtBlockCall[];
  readonly signal?: AbortSignal;
}

export interface NormalizedMulticallAtBlockCall {
  readonly id: string;
  readonly target: string;
  readonly callData: string;
  readonly allowFailure: boolean;
}

export interface NormalizedMulticallAtBlockRequest {
  readonly chainId: number;
  readonly blockNumber: string;
  readonly calls: readonly NormalizedMulticallAtBlockCall[];
  readonly signal?: AbortSignal;
}

export interface MulticallAtBlockCallResult {
  readonly id: string;
  readonly success: boolean;
  readonly returnData: string;
}

export interface MulticallAtBlockResult {
  readonly chainId: number;
  readonly blockNumber: string;
  readonly blockHash: string;
  readonly blockTimestamp: string;
  readonly rpcEndpointId: string;
  readonly multicallBatches: number;
  readonly results: readonly MulticallAtBlockCallResult[];
}

export interface NativeBalanceAtBlockRequest {
  readonly chain: number | string;
  readonly address: string;
  readonly blockNumber: string | number | bigint;
  readonly signal?: AbortSignal;
}

export interface NormalizedNativeBalanceAtBlockRequest {
  readonly chainId: number;
  readonly address: string;
  readonly blockNumber: string;
  readonly signal?: AbortSignal;
}

export interface NativeBalanceAtBlockResult {
  readonly chainId: number;
  readonly address: string;
  readonly blockNumber: string;
  /** Raw native-currency quantity in wei. */
  readonly amount: string;
  readonly blockHash: string;
  readonly blockTimestamp: string;
  readonly rpcEndpointId: string;
}

export interface BatchNativeBalancesRequest {
  readonly chain: number | string;
  readonly addresses: readonly string[];
  readonly blockNumber?: string | number | bigint;
  readonly signal?: AbortSignal;
}

export interface BatchNativeBalanceItemResult {
  readonly address: string;
  readonly amount: string;
  readonly success: boolean;
}

export interface BatchNativeBalancesResult {
  readonly chainId: number;
  readonly blockNumber: string;
  readonly blockHash: string;
  readonly blockTimestamp: string;
  readonly rpcEndpointId: string;
  readonly results: readonly BatchNativeBalanceItemResult[];
}

export type Erc20ReadMethod =
  | "balanceOf"
  | "allowance"
  | "decimals"
  | "name"
  | "symbol"
  | "totalSupply";

export type Erc20MulticallCall =
  | { readonly id: string; readonly tokenAddress: string; readonly method: "balanceOf"; readonly owner: string }
  | { readonly id: string; readonly tokenAddress: string; readonly method: "allowance"; readonly owner: string; readonly spender: string }
  | { readonly id: string; readonly tokenAddress: string; readonly method: "decimals" }
  | { readonly id: string; readonly tokenAddress: string; readonly method: "name" }
  | { readonly id: string; readonly tokenAddress: string; readonly method: "symbol" }
  | { readonly id: string; readonly tokenAddress: string; readonly method: "totalSupply" };

export interface Erc20MulticallAtBlockRequest {
  readonly chain: number | string;
  readonly blockNumber?: string | number | bigint;
  readonly calls: readonly Erc20MulticallCall[];
  readonly signal?: AbortSignal;
}

export interface NormalizedErc20MulticallAtBlockRequest {
  readonly chainId: number;
  readonly blockNumber?: string;
  readonly calls: readonly Erc20MulticallCall[];
  readonly signal?: AbortSignal;
}

export interface Erc20MulticallCallResult {
  readonly id: string;
  readonly tokenAddress: string;
  readonly method: Erc20ReadMethod;
  readonly success: boolean;
  readonly value: string | null;
  readonly error: "CALL_FAILED" | "DECODE_FAILED" | null;
}

export interface Erc20MulticallAtBlockResult {
  readonly chainId: number;
  readonly blockNumber: string;
  readonly blockHash: string;
  readonly blockTimestamp: string;
  readonly rpcEndpointId: string;
  readonly multicallBatches: number;
  readonly results: readonly Erc20MulticallCallResult[];
}

export const MAX_MULTICALL_CALLS_PER_REQUEST = 1000;

const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const callDataSchema = z
  .string()
  .regex(/^0x([0-9a-fA-F]{2})*$/)
  .max(1_000_000);
const callIdSchema = z.string().trim().min(1).max(256);
const blockNumberSchema = z
  .union([
    z.string().trim(),
    z.number().int().nonnegative(),
    z.bigint().nonnegative(),
  ])
  .transform((value) => {
    if (typeof value === "bigint") return value.toString(10);
    if (typeof value === "number") return value.toString(10);
    if (value.startsWith("0x") || value.startsWith("0X")) {
      try {
        return BigInt(value).toString(10);
      } catch {
        throw invalidRequest(`Invalid hex blockNumber: ${value}`);
      }
    }
    if (/^[0-9]+$/.test(value)) {
      return canonicalDecimal(value);
    }
    throw invalidRequest(`Invalid blockNumber format: ${value}`);
  });

export function resolveChainId(chain: number | string): number {
  if (typeof chain === "number" && Number.isInteger(chain) && chain > 0) {
    return chain;
  }
  if (typeof chain === "string") {
    const trimmed = chain.trim().toLowerCase();
    if (trimmed.startsWith("0x")) {
      const hexParsed = Number.parseInt(trimmed, 16);
      if (Number.isInteger(hexParsed) && hexParsed > 0) return hexParsed;
    }
    if (trimmed === "ethereum" || trimmed === "mainnet" || trimmed === "eth") return 1;
    if (trimmed === "base") return 8453;
    if (trimmed === "optimism" || trimmed === "op") return 10;
    if (trimmed === "arbitrum" || trimmed === "arb" || trimmed === "arbitrum-one") return 42161;
    if (trimmed === "polygon" || trimmed === "matic") return 137;
    if (trimmed === "bsc" || trimmed === "binance") return 56;
    if (trimmed === "avalanche" || trimmed === "avax") return 43114;
    if (trimmed === "linea") return 59144;
    if (trimmed === "scroll") return 534352;
    if (trimmed === "sepolia") return 11155111;
    if (trimmed === "base-sepolia") return 84532;
    if (/^[0-9]+$/.test(trimmed)) {
      const parsed = parseInt(trimmed, 10);
      if (parsed > 0) return parsed;
    }
  }
  throw invalidRequest(`Unsupported chain reference: ${String(chain)}`);
}

const multicallCallSchema = z
  .object({
    id: callIdSchema,
    target: addressSchema.transform((val) => val.toLowerCase()),
    callData: callDataSchema.transform((val) => val.toLowerCase()),
    allowFailure: z.boolean().optional().default(true),
  })
  .strict();

export function parseMulticallAtBlockRequest(input: unknown): NormalizedMulticallAtBlockRequest {
  if (typeof input !== "object" || input === null) {
    throw invalidRequest("Invalid multicallAtBlock request: payload must be an object.");
  }
  const candidate = input as Record<string, unknown>;
  const chainId = resolveChainId(candidate.chain as number | string);
  const blockParsed = blockNumberSchema.safeParse(candidate.blockNumber);
  if (!blockParsed.success) {
    throw invalidRequest("Invalid blockNumber in multicallAtBlock request.");
  }

  if (!Array.isArray(candidate.calls) || candidate.calls.length === 0 || candidate.calls.length > MAX_MULTICALL_CALLS_PER_REQUEST) {
    throw invalidRequest(`multicallAtBlock calls must be an array between 1 and ${MAX_MULTICALL_CALLS_PER_REQUEST} items.`);
  }

  const seenIds = new Set<string>();
  const calls: NormalizedMulticallAtBlockCall[] = [];

  for (let i = 0; i < candidate.calls.length; i += 1) {
    const parsed = multicallCallSchema.safeParse(candidate.calls[i]);
    if (!parsed.success) {
      throw invalidRequest(`Invalid call at index ${i} in multicallAtBlock request.`);
    }
    if (seenIds.has(parsed.data.id)) {
      throw invalidRequest(`Duplicate call id '${parsed.data.id}' in multicallAtBlock.`);
    }
    seenIds.add(parsed.data.id);
    calls.push(Object.freeze(parsed.data));
  }

  return {
    chainId,
    blockNumber: blockParsed.data,
    calls: Object.freeze(calls),
    ...(candidate.signal instanceof AbortSignal ? { signal: candidate.signal } : {}),
  };
}

export function parseNativeBalanceAtBlockRequest(input: unknown): NormalizedNativeBalanceAtBlockRequest {
  if (typeof input !== "object" || input === null) {
    throw invalidRequest("Invalid nativeBalanceAtBlock request: payload must be an object.");
  }
  const candidate = input as Record<string, unknown>;
  const chainId = resolveChainId(candidate.chain as number | string);
  const addrParsed = addressSchema.safeParse(candidate.address);
  if (!addrParsed.success) {
    throw invalidRequest("Invalid address in nativeBalanceAtBlock request.");
  }
  const blockParsed = blockNumberSchema.safeParse(candidate.blockNumber);
  if (!blockParsed.success) {
    throw invalidRequest("Invalid blockNumber in nativeBalanceAtBlock request.");
  }

  return {
    chainId,
    address: addrParsed.data.toLowerCase(),
    blockNumber: blockParsed.data,
    ...(candidate.signal instanceof AbortSignal ? { signal: candidate.signal } : {}),
  };
}

const callBase = { id: callIdSchema, tokenAddress: addressSchema.transform((val) => val.toLowerCase()) };
const erc20CallSchema = z.discriminatedUnion("method", [
  z.object({ ...callBase, method: z.literal("balanceOf"), owner: addressSchema.transform((val) => val.toLowerCase()) }).strict(),
  z.object({ ...callBase, method: z.literal("allowance"), owner: addressSchema.transform((val) => val.toLowerCase()), spender: addressSchema.transform((val) => val.toLowerCase()) }).strict(),
  z.object({ ...callBase, method: z.literal("decimals") }).strict(),
  z.object({ ...callBase, method: z.literal("name") }).strict(),
  z.object({ ...callBase, method: z.literal("symbol") }).strict(),
  z.object({ ...callBase, method: z.literal("totalSupply") }).strict(),
]);

export function parseErc20MulticallAtBlockRequest(input: unknown): NormalizedErc20MulticallAtBlockRequest {
  if (typeof input !== "object" || input === null) {
    throw invalidRequest("Invalid ERC-20 multicall request: payload must be an object.");
  }
  const candidate = input as Record<string, unknown>;
  const chainId = resolveChainId(candidate.chain as number | string);
  let blockNumber: string | undefined;
  if (candidate.blockNumber !== undefined) {
    const blockParsed = blockNumberSchema.safeParse(candidate.blockNumber);
    if (!blockParsed.success) {
      throw invalidRequest("Invalid blockNumber in ERC-20 multicall request.");
    }
    blockNumber = blockParsed.data;
  }

  if (!Array.isArray(candidate.calls) || candidate.calls.length === 0 || candidate.calls.length > MAX_MULTICALL_CALLS_PER_REQUEST) {
    throw invalidRequest(`ERC-20 multicall calls must be an array between 1 and ${MAX_MULTICALL_CALLS_PER_REQUEST} items.`);
  }

  const seenIds = new Set<string>();
  const calls: Erc20MulticallCall[] = [];

  for (let i = 0; i < candidate.calls.length; i += 1) {
    const parsed = erc20CallSchema.safeParse(candidate.calls[i]);
    if (!parsed.success) {
      throw invalidRequest(`Invalid call at index ${i} in ERC-20 multicall request.`);
    }
    if (seenIds.has(parsed.data.id)) {
      throw invalidRequest(`Duplicate call id '${parsed.data.id}' in ERC-20 multicall.`);
    }
    seenIds.add(parsed.data.id);
    calls.push(Object.freeze(parsed.data));
  }

  return {
    chainId,
    ...(blockNumber !== undefined ? { blockNumber } : {}),
    calls: Object.freeze(calls),
    ...(candidate.signal instanceof AbortSignal ? { signal: candidate.signal } : {}),
  };
}

export interface NormalizedBatchNativeBalancesRequest {
  readonly chainId: number;
  readonly addresses: readonly string[];
  readonly blockNumber?: string;
  readonly signal?: AbortSignal;
}

export function parseBatchNativeBalancesRequest(input: unknown): NormalizedBatchNativeBalancesRequest {
  if (typeof input !== "object" || input === null) {
    throw invalidRequest("Invalid batchNativeBalances request: payload must be an object.");
  }
  const candidate = input as Record<string, unknown>;
  const chainId = resolveChainId(candidate.chain as number | string);
  let blockNumber: string | undefined;
  if (candidate.blockNumber !== undefined) {
    const blockParsed = blockNumberSchema.safeParse(candidate.blockNumber);
    if (!blockParsed.success) {
      throw invalidRequest("Invalid blockNumber in batchNativeBalances request.");
    }
    blockNumber = blockParsed.data;
  }

  if (!Array.isArray(candidate.addresses) || candidate.addresses.length === 0 || candidate.addresses.length > MAX_MULTICALL_CALLS_PER_REQUEST) {
    throw invalidRequest(`batchNativeBalances addresses must be an array between 1 and ${MAX_MULTICALL_CALLS_PER_REQUEST} items.`);
  }

  const addresses: string[] = [];
  for (let i = 0; i < candidate.addresses.length; i += 1) {
    const parsed = addressSchema.safeParse(candidate.addresses[i]);
    if (!parsed.success) {
      throw invalidRequest(`Invalid address at index ${i} in batchNativeBalances request.`);
    }
    addresses.push(parsed.data.toLowerCase());
  }

  return {
    chainId,
    addresses: Object.freeze(addresses),
    ...(blockNumber !== undefined ? { blockNumber } : {}),
    ...(candidate.signal instanceof AbortSignal ? { signal: candidate.signal } : {}),
  };
}

function canonicalDecimal(value: string): string {
  const canonical = value.replace(/^0+(?=\d)/, "");
  return canonical === "" ? "0" : canonical;
}
