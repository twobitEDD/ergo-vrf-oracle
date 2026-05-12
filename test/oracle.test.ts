import { describe, expect, test } from "vitest";
import { OracleCoordinator } from "../src/oracle.js";

describe("OracleCoordinator", () => {
  test("finalizes deterministic seed for same inputs", () => {
    const make = () => {
      const oracle = new OracleCoordinator();
      oracle.registerOperator({
        id: "operator-alpha",
        rewardAddress: "addr1",
        stakeAmount: 100n
      });
      oracle.registerOperator({
        id: "operator-beta",
        rewardAddress: "addr2",
        stakeAmount: 100n
      });
      oracle.startRound({
        roundId: "r1",
        rewardPool: 10n,
        entropyDomainTag: "demo",
        maxSubmissions: 5
      });
      oracle.submitEntropy(
        "operator-alpha",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      );
      oracle.submitEntropy(
        "operator-beta",
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      );
      return oracle.finalizeRound();
    };

    const result1 = make();
    const result2 = make();
    expect(result1.finalSeedHex).toBe(result2.finalSeedHex);
    expect(result1.rewards["operator-alpha"]).toBe(5n);
    expect(result1.rewards["operator-beta"]).toBe(5n);
  });

  test("rejects invalid entropy input", () => {
    const oracle = new OracleCoordinator();
    oracle.registerOperator({
      id: "operator-alpha",
      rewardAddress: "addr1",
      stakeAmount: 100n
    });
    oracle.startRound({
      roundId: "r1",
      rewardPool: 10n,
      entropyDomainTag: "demo",
      maxSubmissions: 5
    });
    expect(() => oracle.submitEntropy("operator-alpha", "xyz")).toThrow();
  });
});
