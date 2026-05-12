import { describe, expect, test } from "vitest";
import { OracleDemoService } from "../src/demoService.js";

const ENTROPY_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ENTROPY_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function setupDemo(): OracleDemoService {
  const demo = new OracleDemoService();
  demo.registerOperator({
    id: "operator-alpha",
    rewardAddress: "addr-alpha",
    stakeAmount: 500n
  });
  demo.registerOperator({
    id: "operator-beta",
    rewardAddress: "addr-beta",
    stakeAmount: 500n
  });
  demo.registerOperator({
    id: "operator-gamma",
    rewardAddress: "addr-gamma",
    stakeAmount: 500n
  });
  return demo;
}

describe("OracleDemoService", () => {
  test("tracks round lifecycle and explorer state", () => {
    const demo = setupDemo();
    demo.startRound({
      roundId: "round-1",
      rewardPool: 7n,
      entropyDomainTag: "demo",
      maxSubmissions: 3
    });
    demo.submitEntropy("operator-alpha", ENTROPY_A);
    demo.submitEntropy("operator-beta", ENTROPY_B);
    const view = demo.finalizeRound();
    expect(view.finalSeedHex).toMatch(/^[a-f0-9]{64}$/);
    expect(view.rewards["operator-alpha"]).toBeDefined();
    expect(view.rewards["operator-beta"]).toBeDefined();
  });

  test("records invalid submissions instead of throwing", () => {
    const demo = setupDemo();
    demo.startRound({
      roundId: "round-2",
      rewardPool: 3n,
      entropyDomainTag: "demo",
      maxSubmissions: 3
    });
    const bad = demo.submitEntropy("operator-alpha", "not-hex");
    expect(bad.status).toBe("invalid");
    const state = demo.getState();
    expect(state.rounds[0].invalidOperatorIds).toContain("operator-alpha");
  });
});
