import { OracleCoordinator, RoundConfig } from "./oracle.js";
import { OperatorProfile } from "./types.js";

export interface DemoSubmission {
  operatorId: string;
  entropyHex: string;
  submittedAtEpochMs: number;
  status: "valid" | "invalid";
  note?: string;
}

export interface DemoRoundExplorerView {
  roundId: string;
  entropyDomainTag: string;
  maxSubmissions: number;
  rewardPool: string;
  startedAtEpochMs: number;
  finalizedAtEpochMs: number | undefined;
  submissions: DemoSubmission[];
  validOperatorIds: string[];
  invalidOperatorIds: string[];
  rewards: Record<string, string>;
  finalSeedHex: string | undefined;
}

interface DemoRoundState {
  config: RoundConfig;
  startedAtEpochMs: number;
  finalizedAtEpochMs: number | undefined;
  submissions: Map<string, DemoSubmission>;
  validOperatorIds: string[];
  invalidOperatorIds: string[];
  rewards: Record<string, bigint>;
  finalSeedHex: string | undefined;
}

export class OracleDemoService {
  private readonly coordinator = new OracleCoordinator();
  private readonly rounds = new Map<string, DemoRoundState>();
  private activeRoundId: string | undefined;

  registerOperator(profile: OperatorProfile): OperatorProfile {
    return this.coordinator.registerOperator(profile);
  }

  ensureOperator(profile: OperatorProfile): { operator: OperatorProfile; created: boolean } {
    const existing = this.listOperators().find((operator) => operator.id === profile.id);
    if (existing) {
      return { operator: existing, created: false };
    }
    const created = this.coordinator.registerOperator(profile);
    return { operator: created, created: true };
  }

  listOperators(): OperatorProfile[] {
    return this.coordinator.listOperators();
  }

  startRound(config: RoundConfig): DemoRoundExplorerView {
    this.coordinator.startRound(config);
    const state: DemoRoundState = {
      config,
      startedAtEpochMs: Date.now(),
      finalizedAtEpochMs: undefined,
      submissions: new Map(),
      validOperatorIds: [],
      invalidOperatorIds: [],
      rewards: {},
      finalSeedHex: undefined
    };
    this.rounds.set(config.roundId, state);
    this.activeRoundId = config.roundId;
    return this.toExplorerView(state);
  }

  submitEntropy(operatorId: string, entropyHex: string): DemoSubmission {
    const active = this.requireActiveRound();
    try {
      const accepted = this.coordinator.submitEntropy(operatorId, entropyHex);
      const record: DemoSubmission = {
        operatorId,
        entropyHex: accepted.entropyHex,
        submittedAtEpochMs: accepted.submittedAtEpochMs,
        status: "valid"
      };
      active.submissions.set(operatorId, record);
      if (!active.validOperatorIds.includes(operatorId)) {
        active.validOperatorIds.push(operatorId);
      }
      return record;
    } catch (error) {
      const record: DemoSubmission = {
        operatorId,
        entropyHex,
        submittedAtEpochMs: Date.now(),
        status: "invalid",
        note: error instanceof Error ? error.message : "unknown error"
      };
      active.submissions.set(`${operatorId}:${active.submissions.size}`, record);
      active.invalidOperatorIds.push(operatorId);
      return record;
    }
  }

  finalizeRound(): DemoRoundExplorerView {
    const active = this.requireActiveRound();
    const finalized = this.coordinator.finalizeRound();
    active.finalizedAtEpochMs = finalized.finalizedAtEpochMs;
    active.finalSeedHex = finalized.finalSeedHex;
    active.rewards = finalized.rewards;
    active.validOperatorIds = finalized.validOperatorIds;
    this.activeRoundId = undefined;
    return this.toExplorerView(active);
  }

  getState() {
    return {
      activeRoundId: this.activeRoundId,
      operators: this.listOperators().map((operator) => ({
        ...operator,
        stakeAmount: operator.stakeAmount.toString()
      })),
      rounds: [...this.rounds.values()]
        .map((round) => this.toExplorerView(round))
        .sort((a, b) => b.startedAtEpochMs - a.startedAtEpochMs)
    };
  }

  getActiveRound() {
    if (!this.activeRoundId) {
      return null;
    }
    const active = this.rounds.get(this.activeRoundId);
    if (!active) {
      return null;
    }
    return this.toExplorerView(active);
  }

  private requireActiveRound(): DemoRoundState {
    if (!this.activeRoundId) {
      throw new Error("no active round");
    }
    const active = this.rounds.get(this.activeRoundId);
    if (!active) {
      throw new Error("active round data not found");
    }
    return active;
  }

  private toExplorerView(state: DemoRoundState): DemoRoundExplorerView {
    const rewards: Record<string, string> = {};
    for (const [key, value] of Object.entries(state.rewards)) {
      rewards[key] = value.toString();
    }
    return {
      roundId: state.config.roundId,
      entropyDomainTag: state.config.entropyDomainTag,
      maxSubmissions: state.config.maxSubmissions,
      rewardPool: state.config.rewardPool.toString(),
      startedAtEpochMs: state.startedAtEpochMs,
      finalizedAtEpochMs: state.finalizedAtEpochMs,
      submissions: [...state.submissions.values()].sort(
        (a, b) => a.submittedAtEpochMs - b.submittedAtEpochMs
      ),
      validOperatorIds: [...state.validOperatorIds].sort(),
      invalidOperatorIds: [...state.invalidOperatorIds].sort(),
      rewards,
      finalSeedHex: state.finalSeedHex
    };
  }
}
