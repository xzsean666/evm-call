import { invalidRequest, rpcResponseInvalid } from "../domain/errors";
import type { Erc20MulticallCall, Erc20ReadMethod } from "../domain/multicallModels";

export const ERC20_READ_SELECTORS = Object.freeze({
  balanceOf: "70a08231",
  allowance: "dd62ed3e",
  decimals: "313ce567",
  name: "06fdde03",
  symbol: "95d89b41",
  totalSupply: "18160ddd",
});

/**
 * Encodes an ERC-20 read call into hex call data.
 */
export function encodeErc20Read(call: Erc20MulticallCall): string {
  switch (call.method) {
    case "balanceOf":
      return `0x${ERC20_READ_SELECTORS.balanceOf}${wordAddress(call.owner)}`;
    case "allowance":
      return `0x${ERC20_READ_SELECTORS.allowance}${wordAddress(call.owner)}${wordAddress(call.spender)}`;
    case "decimals":
      return `0x${ERC20_READ_SELECTORS.decimals}`;
    case "name":
      return `0x${ERC20_READ_SELECTORS.name}`;
    case "symbol":
      return `0x${ERC20_READ_SELECTORS.symbol}`;
    case "totalSupply":
      return `0x${ERC20_READ_SELECTORS.totalSupply}`;
  }
}

/**
 * Decodes ERC-20 return data into a normalized string value.
 * For numeric values (balanceOf, allowance, decimals, totalSupply), returns decimal string.
 * For string values (name, symbol), decodes standard ABI string or legacy bytes32.
 */
export function decodeErc20Read(method: Erc20ReadMethod, returnData: string): string {
  if (typeof returnData !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(returnData)) {
    throw rpcResponseInvalid("ERC-20 return data must be even-length hex.");
  }
  const hex = returnData.slice(2);
  if (hex.length === 0) {
    throw rpcResponseInvalid("ERC-20 return data is empty.");
  }

  if (method === "name" || method === "symbol") {
    return decodeText(hex);
  }

  if (hex.length !== 64) {
    throw rpcResponseInvalid("ERC-20 uint return data must be exactly one 32-byte word.");
  }

  const value = BigInt(`0x${hex}`);
  if (method === "decimals" && value > 255n) {
    throw rpcResponseInvalid("ERC-20 decimals is out of range (> 255).");
  }
  return value.toString(10);
}

function wordAddress(address: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw invalidRequest("ERC-20 address argument must be a 20-byte address.");
  }
  return address.slice(2).toLowerCase().padStart(64, "0");
}

function decodeText(hex: string): string {
  // Legacy bytes32 format (e.g. MKR)
  if (hex.length === 64) {
    return decodeBytes32(hex);
  }

  // Standard dynamic string: offset (32 bytes) + length (32 bytes) + data
  if (hex.length < 128) {
    throw rpcResponseInvalid("ERC-20 text return data is truncated (less than 64 bytes).");
  }

  const offsetBig = BigInt(`0x${hex.slice(0, 64)}`);
  const offset = Number(offsetBig);
  if (!Number.isSafeInteger(offset) || offset < 32 || offset % 32 !== 0 || offset * 2 + 64 > hex.length) {
    throw rpcResponseInvalid("ERC-20 text return data has an invalid offset.");
  }

  const lengthStart = offset * 2;
  const length = Number(BigInt(`0x${hex.slice(lengthStart, lengthStart + 64)}`));
  const dataStart = lengthStart + 64;
  if (!Number.isSafeInteger(length) || length < 0 || dataStart + length * 2 > hex.length) {
    throw rpcResponseInvalid("ERC-20 text return data length is invalid or truncated.");
  }

  const bytesHex = hex.slice(dataStart, dataStart + length * 2);
  try {
    const bytes = hexToBytes(bytesHex);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw rpcResponseInvalid("ERC-20 text return data is not valid UTF-8.");
  }
}

function decodeBytes32(hex: string): string {
  const bytes = hexToBytes(hex);
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) {
    end -= 1;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes.slice(0, end));
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length === 0) {
    return new Uint8Array(0);
  }
  return Buffer.from(hex, "hex");
}
