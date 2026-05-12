export interface OperatorProfile {
  id: string;
  rewardAddress: string;
  stakeAmount: bigint;
  reputationScore?: number;
  isWhitelisted?: boolean;
}

export interface EntropyContribution {
  operatorId: string;
  entropyHex: string;
  submittedAtEpochMs: number;
}

export interface FinalizedRound {
  roundId: string;
  entropyDomainTag: string;
  finalSeedHex: string;
  rewardPool: bigint;
  rewards: Record<string, bigint>;
  validOperatorIds: string[];
  finalizedAtEpochMs: number;
}
