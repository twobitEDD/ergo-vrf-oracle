/** Compile-time parameters baked into the beacon contracts. */
export interface BeaconParams {
  /** Blocks per epoch. One reveal per beacon per epoch. */
  epochLen: number;
  /** A request opened in epoch e targets epoch e + targetDelay. */
  targetDelay: bigint;
  /** Root + contributors per request. */
  maxParticipants: number;
  /** A beacon may be this many epochs past the target and still prove its target value. */
  maxLookback: bigint;
  /** A listed entry may be at most this many epochs before the target. */
  maxDist: bigint;
  /** Blocks after the target epoch ends before a missing reveal counts as left out. */
  graceBlocks: bigint;
  /** Blocks after the target epoch ends before the requester can always refund. */
  hardTimeoutBlocks: bigint;
  /** Epochs a beacon must sit unrevealed before its bond can be withdrawn. */
  unbondEpochs: bigint;
  minBond: bigint;
  /** Root share of the fee pool when contributors also revealed (basis points). */
  rootShareBps: bigint;
  resultBoxValue: bigint;
  minerFee: bigint;
}

export const DEFAULT_BEACON_PARAMS: BeaconParams = {
  epochLen: 5,
  targetDelay: 2n,
  maxParticipants: 8,
  maxLookback: 4n,
  maxDist: 6n,
  graceBlocks: 5n,
  hardTimeoutBlocks: 720n,
  unbondEpochs: 30n,
  minBond: 1_000_000_000n,
  rootShareBps: 2_000n,
  resultBoxValue: 1_000_000n,
  minerFee: 1_100_000n
};

/** Result box value + miner fee, taken off the request value before the fee pool is split. */
export function reserveOf(params: BeaconParams): bigint {
  return params.resultBoxValue + params.minerFee;
}
