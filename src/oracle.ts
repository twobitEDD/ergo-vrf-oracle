import { createHash } from "node:crypto";
import { EntropyContribution, FinalizedRound, OperatorProfile } from "./types.js";

export interface RoundConfig {
  roundId: string;
  rewardPool: bigint;
  entropyDomainTag: string;
  maxSubmissions: number;
}

interface RoundState {
  config: RoundConfig;
  submissions: Map<string, EntropyContribution>;
  validOperatorIds: string[];
  startedAtEpochMs: number;
}

function assertHex32(entropyHex: string): void {
  if (!/^[0-9a-fA-F]{64}$/.test(entropyHex)) {
    throw new Error("entropyHex must be a 32-byte hex string");
  }
}

export class OracleCoordinator {
  private operators = new Map<string, OperatorProfile>();
  private activeRound: RoundState | undefined;

  registerOperator(profile: OperatorProfile): OperatorProfile {
    if (this.operators.has(profile.id)) {
      throw new Error(`operator already exists: ${profile.id}`);
    }
    this.operators.set(profile.id, profile);
    return profile;
  }

  listOperators(): OperatorProfile[] {
    return [...this.operators.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  startRound(config: RoundConfig): void {
    if (this.activeRound) {
      throw new Error("round already active");
    }
    if (config.maxSubmissions <= 0) {
      throw new Error("maxSubmissions must be positive");
    }
    this.activeRound = {
      config,
      submissions: new Map(),
      validOperatorIds: [],
      startedAtEpochMs: Date.now()
    };
  }

  submitEntropy(operatorId: string, entropyHex: string): EntropyContribution {
    if (!this.activeRound) {
      throw new Error("no active round");
    }
    const operator = this.operators.get(operatorId);
    if (!operator) {
      throw new Error(`unknown operator: ${operatorId}`);
    }
    if (this.activeRound.submissions.has(operatorId)) {
      throw new Error(`operator already submitted this round: ${operatorId}`);
    }
    if (this.activeRound.submissions.size >= this.activeRound.config.maxSubmissions) {
      throw new Error("round submission limit reached");
    }
    assertHex32(entropyHex);
    const contribution: EntropyContribution = {
      operatorId,
      entropyHex: entropyHex.toLowerCase(),
      submittedAtEpochMs: Date.now()
    };
    this.activeRound.submissions.set(operatorId, contribution);
    this.activeRound.validOperatorIds.push(operatorId);
    return contribution;
  }

  finalizeRound(): FinalizedRound {
    if (!this.activeRound) {
      throw new Error("no active round");
    }
    const round = this.activeRound;
    if (round.submissions.size === 0) {
      throw new Error("cannot finalize empty round");
    }

    const ordered = [...round.submissions.values()].sort((a, b) =>
      a.operatorId.localeCompare(b.operatorId)
    );
    const hash = createHash("sha256");
    hash.update(round.config.entropyDomainTag);
    hash.update(round.config.roundId);
    for (const item of ordered) {
      hash.update(item.operatorId);
      hash.update(item.entropyHex);
    }
    const finalSeedHex = hash.digest("hex");

    const rewards = splitRewards(round.config.rewardPool, ordered.map((it) => it.operatorId));
    const result: FinalizedRound = {
      roundId: round.config.roundId,
      entropyDomainTag: round.config.entropyDomainTag,
      finalSeedHex,
      rewardPool: round.config.rewardPool,
      rewards,
      validOperatorIds: ordered.map((it) => it.operatorId),
      finalizedAtEpochMs: Date.now()
    };
    this.activeRound = undefined;
    return result;
  }

  getActiveRoundSubmissionCount(): number {
    return this.activeRound?.submissions.size ?? 0;
  }
}

function splitRewards(rewardPool: bigint, operatorIds: string[]): Record<string, bigint> {
  const ordered = [...operatorIds].sort();
  const count = BigInt(ordered.length);
  const each = rewardPool / count;
  let remainder = rewardPool % count;
  const rewards: Record<string, bigint> = {};
  for (const operatorId of ordered) {
    rewards[operatorId] = each + (remainder > 0n ? 1n : 0n);
    if (remainder > 0n) {
      remainder -= 1n;
    }
  }
  return rewards;
}
