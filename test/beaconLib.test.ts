import { describe, expect, test } from "vitest";
import { HashChain, decodeEntry, encodeEntry, hashN, splitFee } from "../src/beacon/index.js";

describe("beacon library", () => {
  test("entries round-trip in the 40-byte Lithos layout", () => {
    const entry = { epoch: 123_456n, tipHex: "ab".repeat(32) };
    const bytes = encodeEntry(entry);
    expect(bytes.length).toBe(40);
    expect(decodeEntry(bytes)).toEqual(entry);
  });

  test("each reveal hashes to the one before it", () => {
    const chain = new HashChain("01".repeat(32), 10);
    expect(hashN(chain.valueAt(1), 1n)).toBe(chain.anchorHex);
    expect(hashN(chain.valueAt(4), 4n)).toBe(chain.anchorHex);
    expect(() => chain.valueAt(11)).toThrow("chain exhausted");
  });

  test("root keeps the pool alone and its share plus dust otherwise", () => {
    expect(splitFee(1_000n, 0, 2_000n)).toEqual({ rootPay: 1_000n, share: 0n });
    const split = splitFee(1_000n, 3, 2_000n);
    expect(split.share).toBe(266n);
    expect(split.rootPay + split.share * 3n).toBe(1_000n);
  });
});
