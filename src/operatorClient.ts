import { createHash } from "node:crypto";

export interface OperatorClientConfig {
  oracleUrl: string;
  operatorId: string;
  operatorSecret: string;
  rewardAddress: string;
  stakeAmount: bigint;
  intervalMs: number;
  isWhitelisted: boolean;
}

interface DemoSubmission {
  operatorId: string;
  entropyHex: string;
  submittedAtEpochMs: number;
  status: "valid" | "invalid";
  note?: string;
}

interface ActiveRoundView {
  roundId: string;
  submissions: DemoSubmission[];
  finalizedAtEpochMs?: number;
}

interface EnsureOperatorResponse {
  created: boolean;
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function isAlreadySubmittedError(message: string): boolean {
  return message.includes("already submitted this round");
}

function assertResponseOk(response: Response, body: unknown): void {
  if (response.ok) {
    return;
  }
  if (body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string") {
    throw new Error((body as { error: string }).error);
  }
  throw new Error(`request failed: ${response.status}`);
}

export function deriveEntropyHex(input: {
  operatorSecret: string;
  operatorId: string;
  roundId: string;
}): string {
  return createHash("sha256")
    .update(input.operatorSecret)
    .update(":")
    .update(input.operatorId)
    .update(":")
    .update(input.roundId)
    .digest("hex");
}

export class OperatorClientLoop {
  private timer: NodeJS.Timeout | undefined;
  private readonly baseUrl: string;

  constructor(private readonly config: OperatorClientConfig) {
    this.baseUrl = trimTrailingSlash(config.oracleUrl);
  }

  async tick(): Promise<void> {
    await this.ensureRegistered();
    const activeRound = await this.getActiveRound();
    if (!activeRound) {
      return;
    }
    if (activeRound.finalizedAtEpochMs) {
      return;
    }
    const hasSubmitted = activeRound.submissions.some(
      (submission) =>
        submission.operatorId === this.config.operatorId && submission.status === "valid"
    );
    if (hasSubmitted) {
      return;
    }
    const entropyHex = deriveEntropyHex({
      operatorSecret: this.config.operatorSecret,
      operatorId: this.config.operatorId,
      roundId: activeRound.roundId
    });
    await this.submitEntropy(activeRound.roundId, entropyHex);
  }

  start(): void {
    if (this.timer) {
      return;
    }
    void this.tick().catch((error) => {
      console.error(`[operator:${this.config.operatorId}] initial tick failed`, error);
    });
    this.timer = setInterval(() => {
      void this.tick().catch((error) => {
        console.error(`[operator:${this.config.operatorId}] tick failed`, error);
      });
    }, this.config.intervalMs);
  }

  stop(): void {
    if (!this.timer) {
      return;
    }
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private async ensureRegistered(): Promise<void> {
    const payload = await this.postJson<EnsureOperatorResponse>("/api/operators/ensure", {
      id: this.config.operatorId,
      rewardAddress: this.config.rewardAddress,
      stakeAmount: this.config.stakeAmount.toString(),
      isWhitelisted: this.config.isWhitelisted
    });
    if (payload.created) {
      console.log(`[operator:${this.config.operatorId}] registered with coordinator`);
    }
  }

  private async getActiveRound(): Promise<ActiveRoundView | null> {
    const payload = await this.getJson<{ activeRound: ActiveRoundView | null }>("/api/rounds/active");
    return payload.activeRound;
  }

  private async submitEntropy(roundId: string, entropyHex: string): Promise<void> {
    try {
      await this.postJson("/api/rounds/submit", {
        operatorId: this.config.operatorId,
        entropyHex
      });
      console.log(`[operator:${this.config.operatorId}] submitted entropy for round ${roundId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isAlreadySubmittedError(message)) {
        return;
      }
      throw error;
    }
  }

  private async getJson<T>(path: string): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "GET",
      headers: {
        "content-type": "application/json"
      }
    });
    const body = await response.json().catch(() => undefined);
    assertResponseOk(response, body);
    return body as T;
  }

  private async postJson<T = unknown>(path: string, payload: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    const body = await response.json().catch(() => undefined);
    assertResponseOk(response, body);
    return body as T;
  }
}
