import { blake2b256, hex } from "@fleet-sdk/crypto";

/** Lithos-style commitment entry: [epoch: 8-byte big-endian Long][tip: 32 bytes]. */
export const ENTRY_SIZE = 40;

export interface BeaconEntry {
  epoch: bigint;
  tipHex: string;
}

export function encodeEntry(entry: BeaconEntry): Uint8Array {
  const tip = hex.decode(entry.tipHex);
  if (tip.length !== 32) {
    throw new Error("tip must be 32 bytes");
  }
  const bytes = new Uint8Array(ENTRY_SIZE);
  new DataView(bytes.buffer).setBigInt64(0, entry.epoch);
  bytes.set(tip, 8);
  return bytes;
}

export function decodeEntry(bytes: Uint8Array): BeaconEntry {
  if (bytes.length !== ENTRY_SIZE) {
    throw new Error(`expected a ${ENTRY_SIZE}-byte entry, got ${bytes.length}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { epoch: view.getBigInt64(0), tipHex: hex.encode(bytes.slice(8)) };
}

/** blake2b256 applied k times; k <= 0 returns the input. */
export function hashN(valueHex: string, k: bigint): string {
  let value = hex.decode(valueHex);
  for (let i = 0n; i < k; i++) {
    value = blake2b256(value);
  }
  return hex.encode(value);
}

/**
 * A beacon's secret hash chain. `values[0]` is the secret, `values[i] = blake2b256(values[i - 1])`,
 * and the last value is the public anchor. Reveals walk back down from the anchor.
 */
export class HashChain {
  readonly values: string[];

  constructor(secretHex: string, length: number) {
    if (length < 1) {
      throw new Error("chain length must be positive");
    }
    this.values = [secretHex.toLowerCase()];
    for (let i = 1; i <= length; i++) {
      this.values.push(hashN(this.values[i - 1]!, 1n));
    }
  }

  get anchorHex(): string {
    return this.values[this.values.length - 1]!;
  }

  /** Value revealed `step` reveals after the anchor (step 0 is the anchor itself). */
  valueAt(step: number): string {
    const index = this.values.length - 1 - step;
    if (index < 0) {
      throw new Error("chain exhausted");
    }
    return this.values[index]!;
  }
}
