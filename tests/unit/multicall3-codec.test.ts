import { describe, expect, it } from "vitest";

import {
  MULTICALL3_ADDRESS,
  MULTICALL3_AGGREGATE3_SELECTOR,
  MULTICALL3_ETHEREUM_MAINNET_DEPLOYMENT_BLOCK,
  MULTICALL3_BASE_MAINNET_DEPLOYMENT_BLOCK,
  MULTICALL3_GET_BLOCK_NUMBER_SELECTOR,
  decodeAggregate3Result,
  decodeGetBlockNumberResult,
  encodeAggregate3,
  getMulticall3DeploymentBlock,
  type Aggregate3CallInput,
} from "../../src/multicall/Multicall3Codec";

const ADDRESS_A = "0x1111111111111111111111111111111111111111";
const ADDRESS_B = "0x2222222222222222222222222222222222222222";

function wordUint(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

function wordBool(value: boolean): string {
  return wordUint(value ? 1n : 0n);
}

/** Hand-assembles a syntactically valid `(bool,bytes)[]` aggregate3 result. */
function encodeResultTuples(tuples: readonly { success: boolean; data: string }[]): string {
  const dataHexes = tuples.map((tuple) => tuple.data.replace(/^0x/, ""));
  const tupleBodies = dataHexes.map((dataHex) => {
    const lengthBytes = dataHex.length / 2;
    const padded = dataHex.padEnd(Math.ceil(dataHex.length / 64) * 64, "0");
    return { lengthBytes, padded };
  });

  let offset = BigInt(tuples.length * 32);
  const offsets: string[] = [];
  const bodies: string[] = [];
  tuples.forEach((tuple, index) => {
    offsets.push(wordUint(offset));
    const body = tupleBodies[index]!;
    const encodedTuple = `${wordBool(tuple.success)}${wordUint(64n)}${wordUint(BigInt(body.lengthBytes))}${body.padded}`;
    bodies.push(encodedTuple);
    offset += BigInt(encodedTuple.length / 2);
  });

  return `0x${wordUint(32n)}${wordUint(BigInt(tuples.length))}${offsets.join("")}${bodies.join("")}`;
}

describe("Multicall3Codec.constants and deployment blocks", () => {
  it("has canonical address and selectors", () => {
    expect(MULTICALL3_ADDRESS).toBe("0xcA11bde05977b3631167028862bE2a173976CA11");
    expect(MULTICALL3_AGGREGATE3_SELECTOR).toBe("82ad56cb");
    expect(MULTICALL3_GET_BLOCK_NUMBER_SELECTOR).toBe("42cbb15c");
  });

  it("resolves known deployment blocks", () => {
    expect(getMulticall3DeploymentBlock(1)).toBe(MULTICALL3_ETHEREUM_MAINNET_DEPLOYMENT_BLOCK);
    expect(getMulticall3DeploymentBlock(8453)).toBe(MULTICALL3_BASE_MAINNET_DEPLOYMENT_BLOCK);
    expect(getMulticall3DeploymentBlock(10)).toBe(4_218_602n);
    expect(getMulticall3DeploymentBlock(999999)).toBeUndefined();
  });
});

describe("Multicall3Codec.encodeAggregate3", () => {
  it("encodes an empty call array", () => {
    const encoded = encodeAggregate3([]);
    expect(encoded.startsWith(`0x${MULTICALL3_AGGREGATE3_SELECTOR}`)).toBe(true);
    // selector(4) + head offset(32) + length(32) with no elements.
    expect(encoded.length).toBe(2 + 8 + 64 + 64);
  });

  it("preserves input order and dynamic offsets across multiple calls", () => {
    const calls: Aggregate3CallInput[] = [
      { target: ADDRESS_A, allowFailure: true, callData: "0xfeaf968c" },
      { target: ADDRESS_B, allowFailure: false, callData: "0x313ce567" },
    ];
    const encoded = encodeAggregate3(calls);
    expect(encoded.startsWith(`0x${MULTICALL3_AGGREGATE3_SELECTOR}`)).toBe(true);

    const bodyHex = encoded.slice(2 + 8);
    const addressAWord = ADDRESS_A.slice(2).toLowerCase().padStart(64, "0");
    const addressBWord = ADDRESS_B.slice(2).toLowerCase().padStart(64, "0");
    const indexA = bodyHex.indexOf(addressAWord);
    const indexB = bodyHex.indexOf(addressBWord);
    expect(indexA).toBeGreaterThanOrEqual(0);
    expect(indexB).toBeGreaterThan(indexA);
  });

  it("rejects a malformed target address", () => {
    expect(() => encodeAggregate3([{ target: "0x1234", allowFailure: true, callData: "0x" }])).toThrow();
  });

  it("rejects odd-length call data", () => {
    expect(() =>
      encodeAggregate3([{ target: ADDRESS_A, allowFailure: true, callData: "0xabc" }]),
    ).toThrow();
  });
});

describe("Multicall3Codec.decodeAggregate3Result", () => {
  it("decodes an empty result array", () => {
    const encoded = encodeResultTuples([]);
    expect(decodeAggregate3Result(encoded, 0)).toEqual([]);
  });

  it("decodes success and revert tuples in input order with allowFailure semantics", () => {
    const encoded = encodeResultTuples([
      { success: true, data: "0x0000000000000000000000000000000000000000000000000000000000000005" },
      { success: false, data: "0x08c379a0" },
    ]);
    const decoded = decodeAggregate3Result(encoded, 2);
    expect(decoded).toHaveLength(2);
    expect(decoded[0]?.success).toBe(true);
    expect(decoded[0]?.returnData).toBe(
      "0x0000000000000000000000000000000000000000000000000000000000000005",
    );
    expect(decoded[1]?.success).toBe(false);
    expect(decoded[1]?.returnData).toBe("0x08c379a0");
  });

  it("decodes a zero-length return payload (undeployed contract)", () => {
    const encoded = encodeResultTuples([{ success: true, data: "0x" }]);
    const decoded = decodeAggregate3Result(encoded, 1);
    expect(decoded[0]).toEqual({ success: true, returnData: "0x" });
  });

  it("rejects a result count mismatch", () => {
    const encoded = encodeResultTuples([{ success: true, data: "0x01" }]);
    expect(() => decodeAggregate3Result(encoded, 2)).toThrow();
  });

  it("rejects non-hex or odd-length return data", () => {
    expect(() => decodeAggregate3Result("0xzz", 0)).toThrow();
    expect(() => decodeAggregate3Result("0xabc", 0)).toThrow();
  });

  it("rejects a misaligned array offset", () => {
    const malformed = `0x${wordUint(33n)}${wordUint(0n)}`;
    expect(() => decodeAggregate3Result(malformed, 0)).toThrow();
  });

  it("rejects a tuple offset that points before the offset table", () => {
    const malformed = `0x${wordUint(32n)}${wordUint(1n)}${wordUint(0n)}${wordBool(true)}${wordUint(64n)}${wordUint(0n)}`;
    expect(() => decodeAggregate3Result(malformed, 1)).toThrow();
  });

  it("rejects a non-canonical bool success flag", () => {
    const malformed = `0x${wordUint(32n)}${wordUint(1n)}${wordUint(32n)}${wordUint(2n)}${wordUint(64n)}${wordUint(0n)}`;
    expect(() => decodeAggregate3Result(malformed, 1)).toThrow();
  });

  it("rejects a bytes offset that is not exactly 64", () => {
    const malformed = `0x${wordUint(32n)}${wordUint(1n)}${wordUint(32n)}${wordBool(true)}${wordUint(96n)}${wordUint(0n)}${wordUint(0n)}`;
    expect(() => decodeAggregate3Result(malformed, 1)).toThrow();
  });

  it("rejects truncated return data", () => {
    const malformed = `0x${wordUint(32n)}${wordUint(1n)}${wordUint(32n)}${wordBool(true)}${wordUint(64n)}${wordUint(32n)}`;
    expect(() => decodeAggregate3Result(malformed, 1)).toThrow();
  });

  it("round-trips a maximum-size batch (1000 calls) preserving order", () => {
    const calls: Aggregate3CallInput[] = Array.from({ length: 1000 }, (_, index) => ({
      target: ADDRESS_A,
      allowFailure: true,
      callData: `0x${index.toString(16).padStart(8, "0")}`,
    }));
    const encoded = encodeAggregate3(calls);
    expect(encoded.startsWith(`0x${MULTICALL3_AGGREGATE3_SELECTOR}`)).toBe(true);

    const resultDataHex = (index: number): string => {
      const hex = index.toString(16);
      return hex.padStart(hex.length % 2 === 0 ? hex.length : hex.length + 1, "0");
    };
    const results = calls.map((_, index) => ({
      success: true,
      data: `0x${resultDataHex(index)}`,
    }));
    const decoded = decodeAggregate3Result(encodeResultTuples(results), calls.length);
    expect(decoded).toHaveLength(1000);
    decoded.forEach((result, index) => {
      expect(result.success).toBe(true);
      expect(result.returnData).toBe(`0x${resultDataHex(index)}`);
    });
  });
});

describe("Multicall3Codec.decodeGetBlockNumberResult", () => {
  it("decodes a single uint256 word into a bigint", () => {
    expect(decodeGetBlockNumberResult(`0x${wordUint(18_000_000n)}`)).toBe(18_000_000n);
  });

  it("decodes zero", () => {
    expect(decodeGetBlockNumberResult(`0x${wordUint(0n)}`)).toBe(0n);
  });

  it("rejects a payload that is not exactly one 32-byte word", () => {
    expect(() => decodeGetBlockNumberResult("0x")).toThrow();
    expect(() => decodeGetBlockNumberResult(`0x${wordUint(1n)}${wordUint(2n)}`)).toThrow();
    expect(() => decodeGetBlockNumberResult("0xabc")).toThrow();
  });

  it("rejects non-hex input", () => {
    expect(() => decodeGetBlockNumberResult("not-hex")).toThrow();
  });
});
