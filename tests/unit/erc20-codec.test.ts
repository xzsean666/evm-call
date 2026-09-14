import { describe, expect, it } from "vitest";

import {
  decodeErc20Read,
  encodeErc20Read,
  ERC20_READ_SELECTORS,
} from "../../src/multicall/Erc20Codec";
import type { Erc20MulticallCall } from "../../src/domain/multicallModels";

const TOKEN = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const OWNER = "0x1111111111111111111111111111111111111111";
const SPENDER = "0x2222222222222222222222222222222222222222";

function wordUint(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

function wordAddress(address: string): string {
  return address.slice(2).toLowerCase().padStart(64, "0");
}

function encodeAbiString(text: string): string {
  const bytes = Buffer.from(text, "utf-8");
  const lengthHex = wordUint(BigInt(bytes.length));
  const textHex = bytes.toString("hex").padEnd(Math.ceil(bytes.length / 32) * 64, "0");
  return `0x${wordUint(32n)}${lengthHex}${textHex}`;
}

describe("Erc20Codec.encodeErc20Read", () => {
  it("encodes balanceOf", () => {
    const call: Erc20MulticallCall = {
      id: "c1",
      tokenAddress: TOKEN,
      method: "balanceOf",
      owner: OWNER,
    };
    expect(encodeErc20Read(call)).toBe(
      `0x${ERC20_READ_SELECTORS.balanceOf}${wordAddress(OWNER)}`,
    );
  });

  it("encodes allowance", () => {
    const call: Erc20MulticallCall = {
      id: "c2",
      tokenAddress: TOKEN,
      method: "allowance",
      owner: OWNER,
      spender: SPENDER,
    };
    expect(encodeErc20Read(call)).toBe(
      `0x${ERC20_READ_SELECTORS.allowance}${wordAddress(OWNER)}${wordAddress(SPENDER)}`,
    );
  });

  it("encodes zero-argument metadata methods", () => {
    expect(
      encodeErc20Read({ id: "c3", tokenAddress: TOKEN, method: "decimals" }),
    ).toBe(`0x${ERC20_READ_SELECTORS.decimals}`);
    expect(
      encodeErc20Read({ id: "c4", tokenAddress: TOKEN, method: "name" }),
    ).toBe(`0x${ERC20_READ_SELECTORS.name}`);
    expect(
      encodeErc20Read({ id: "c5", tokenAddress: TOKEN, method: "symbol" }),
    ).toBe(`0x${ERC20_READ_SELECTORS.symbol}`);
    expect(
      encodeErc20Read({ id: "c6", tokenAddress: TOKEN, method: "totalSupply" }),
    ).toBe(`0x${ERC20_READ_SELECTORS.totalSupply}`);
  });

  it("rejects invalid address in balanceOf and allowance", () => {
    expect(() =>
      encodeErc20Read({
        id: "c1",
        tokenAddress: TOKEN,
        method: "balanceOf",
        owner: "0x123",
      }),
    ).toThrow();
  });
});

describe("Erc20Codec.decodeErc20Read", () => {
  it("decodes uint numeric methods into decimal strings", () => {
    expect(decodeErc20Read("balanceOf", `0x${wordUint(1_000_000_000_000_000_000n)}`)).toBe(
      "1000000000000000000",
    );
    expect(decodeErc20Read("allowance", `0x${wordUint(500n)}`)).toBe("500");
    expect(decodeErc20Read("totalSupply", `0x${wordUint(21_000_000n)}`)).toBe("21000000");
    expect(decodeErc20Read("decimals", `0x${wordUint(18n)}`)).toBe("18");
    expect(decodeErc20Read("decimals", `0x${wordUint(6n)}`)).toBe("6");
  });

  it("rejects decimals out of range", () => {
    expect(() => decodeErc20Read("decimals", `0x${wordUint(256n)}`)).toThrow(/decimals is out of range/);
  });

  it("decodes standard ABI encoded dynamic strings for name and symbol", () => {
    expect(decodeErc20Read("name", encodeAbiString("USD Coin"))).toBe("USD Coin");
    expect(decodeErc20Read("symbol", encodeAbiString("USDC"))).toBe("USDC");
    expect(decodeErc20Read("name", encodeAbiString("Wrapped Ether"))).toBe("Wrapped Ether");
  });

  it("decodes legacy bytes32 encoded strings (null-padded, e.g. MakerDAO MKR)", () => {
    const mkrHex = Buffer.from("MKR", "utf-8").toString("hex").padEnd(64, "0");
    expect(decodeErc20Read("symbol", `0x${mkrHex}`)).toBe("MKR");

    const makerHex = Buffer.from("Maker", "utf-8").toString("hex").padEnd(64, "0");
    expect(decodeErc20Read("name", `0x${makerHex}`)).toBe("Maker");
  });

  it("rejects malformed return data", () => {
    expect(() => decodeErc20Read("balanceOf", "0x")).toThrow();
    expect(() => decodeErc20Read("balanceOf", "0x123")).toThrow();
    expect(() => decodeErc20Read("balanceOf", "not-hex")).toThrow();
    expect(() => decodeErc20Read("name", `0x${"00".repeat(40)}`)).toThrow(/truncated/);
    expect(() => decodeErc20Read("name", `0x${wordUint(33n)}${wordUint(1n)}${wordUint(0n)}`)).toThrow(/invalid offset/);
  });
});
