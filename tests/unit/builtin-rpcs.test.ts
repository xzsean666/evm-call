import { describe, expect, it } from "vitest";

import { BUILTIN_ETHEREUM_RPCS } from "../../src/pool/builtinEthereumRpcs";
import { BUILTIN_BASE_RPCS } from "../../src/pool/builtinBaseRpcs";

describe("BUILTIN_ETHEREUM_RPCS and BUILTIN_BASE_RPCS", () => {
  it("contains at least two candidates for failover on Ethereum and Base", () => {
    expect(BUILTIN_ETHEREUM_RPCS.length).toBeGreaterThanOrEqual(2);
    expect(BUILTIN_BASE_RPCS.length).toBeGreaterThanOrEqual(2);
  });

  it("has unique, non-empty stable ids", () => {
    for (const list of [BUILTIN_ETHEREUM_RPCS, BUILTIN_BASE_RPCS]) {
      const ids = list.map((candidate) => candidate.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) {
        expect(id.length).toBeGreaterThan(0);
        expect(id).toMatch(/^[a-z0-9-]+$/);
      }
    }
  });

  it("has unique HTTPS urls without path, query, or credentials", () => {
    for (const list of [BUILTIN_ETHEREUM_RPCS, BUILTIN_BASE_RPCS]) {
      const urls = list.map((candidate) => candidate.url);
      expect(new Set(urls).size).toBe(urls.length);
      for (const url of urls) {
        const parsed = new URL(url);
        expect(parsed.protocol).toBe("https:");
        expect(parsed.username).toBe("");
        expect(parsed.password).toBe("");
        expect(parsed.search).toBe("");
        expect(parsed.hash).toBe("");
      }
    }
  });

  it("is deeply frozen so callers cannot mutate the registry", () => {
    expect(Object.isFrozen(BUILTIN_ETHEREUM_RPCS)).toBe(true);
    expect(Object.isFrozen(BUILTIN_ETHEREUM_RPCS[0])).toBe(true);
    expect(Object.isFrozen(BUILTIN_BASE_RPCS)).toBe(true);
    expect(Object.isFrozen(BUILTIN_BASE_RPCS[0])).toBe(true);
  });
});
