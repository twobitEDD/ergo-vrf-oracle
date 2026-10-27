import { blake2b256, hex } from "@fleet-sdk/crypto";

/** random = blake2b256(requestBoxId ++ each included author's target value, in request order). */
export function mixRandom(requestBoxIdHex: string, includedValuesHex: string[]): string {
  return hex.encode(blake2b256(hex.decode(requestBoxIdHex + includedValuesHex.join(""))));
}

export interface FeeSplit {
  rootPay: bigint;
  share: bigint;
}

/** Root keeps the whole pool when no contributor revealed; otherwise contributors split the rest. */
export function splitFee(pool: bigint, contributors: number, rootShareBps: bigint): FeeSplit {
  if (contributors === 0) {
    return { rootPay: pool, share: 0n };
  }
  const n = BigInt(contributors);
  const share = (pool - (pool * rootShareBps) / 10_000n) / n;
  return { rootPay: pool - share * n, share };
}
