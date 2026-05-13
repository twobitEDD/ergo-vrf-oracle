import { describe, expect, test } from "vitest";
import { OracleDemoService } from "../src/demoService.js";
import { deriveEntropyHex, OperatorClientLoop } from "../src/operatorClient.js";

const ENTROPY_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("OperatorClientLoop", () => {
  test("deriveEntropyHex is deterministic by operator and round", () => {
    const first = deriveEntropyHex({
      operatorSecret: "secret",
      operatorId: "op-1",
      roundId: "round-1"
    });
    const second = deriveEntropyHex({
      operatorSecret: "secret",
      operatorId: "op-1",
      roundId: "round-1"
    });
    const changedRound = deriveEntropyHex({
      operatorSecret: "secret",
      operatorId: "op-1",
      roundId: "round-2"
    });
    expect(first).toHaveLength(64);
    expect(first).toBe(second);
    expect(first).not.toBe(changedRound);
  });

  test("tick auto-registers and submits once per active round", async () => {
    const demo = new OracleDemoService();
    demo.startRound({
      roundId: "round-ops-1",
      rewardPool: 5n,
      entropyDomainTag: "demo",
      maxSubmissions: 3
    });

    // Minimal fetch stub wired to in-memory demo service.
    global.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const path = new URL(url).pathname;
      const method = (init?.method ?? "GET").toUpperCase();
      const jsonBody = init?.body ? JSON.parse(String(init.body)) : {};
      if (path === "/api/operators/ensure" && method === "POST") {
        const result = demo.ensureOperator({
          id: String(jsonBody.id),
          rewardAddress: String(jsonBody.rewardAddress),
          stakeAmount: BigInt(String(jsonBody.stakeAmount)),
          isWhitelisted: true
        });
        return new Response(JSON.stringify({ created: result.created }), { status: result.created ? 201 : 200 });
      }
      if (path === "/api/rounds/active" && method === "GET") {
        return new Response(JSON.stringify({ activeRound: demo.getActiveRound() }), { status: 200 });
      }
      if (path === "/api/rounds/submit" && method === "POST") {
        const submission = demo.submitEntropy(String(jsonBody.operatorId), String(jsonBody.entropyHex));
        return new Response(JSON.stringify(submission), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    }) as typeof fetch;

    const loop = new OperatorClientLoop({
      oracleUrl: "http://oracle.test",
      operatorId: "operator-alpha",
      operatorSecret: "ops-secret",
      rewardAddress: "addr-alpha",
      stakeAmount: 500n,
      intervalMs: 5000,
      isWhitelisted: true
    });

    await loop.tick();
    await loop.tick();
    const state = demo.getState();
    expect(state.operators).toHaveLength(1);
    expect(state.rounds[0].submissions).toHaveLength(1);
    expect(state.rounds[0].submissions[0].status).toBe("valid");
  });

  test("existing explicit entropy is still accepted in demo", () => {
    const demo = new OracleDemoService();
    demo.registerOperator({
      id: "operator-alpha",
      rewardAddress: "addr-alpha",
      stakeAmount: 500n
    });
    demo.startRound({
      roundId: "round-manual-1",
      rewardPool: 7n,
      entropyDomainTag: "demo",
      maxSubmissions: 2
    });
    const submission = demo.submitEntropy("operator-alpha", ENTROPY_A);
    expect(submission.status).toBe("valid");
  });
});
