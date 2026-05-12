import { OracleCoordinator } from "../src/oracle.js";

const oracle = new OracleCoordinator();

oracle.registerOperator({
  id: "operator-alpha",
  rewardAddress: "9falpha",
  stakeAmount: 1000n,
  isWhitelisted: true
});
oracle.registerOperator({
  id: "operator-beta",
  rewardAddress: "9fbeta",
  stakeAmount: 1200n,
  isWhitelisted: true
});
oracle.registerOperator({
  id: "operator-gamma",
  rewardAddress: "9fgamma",
  stakeAmount: 900n,
  isWhitelisted: true
});

oracle.startRound({
  roundId: "round-1",
  rewardPool: 100n,
  entropyDomainTag: "ergo-vrf-oracle-demo",
  maxSubmissions: 10
});

oracle.submitEntropy(
  "operator-alpha",
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
);
oracle.submitEntropy(
  "operator-beta",
  "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
);
oracle.submitEntropy(
  "operator-gamma",
  "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
);

const finalized = oracle.finalizeRound();

console.log("Round finalized:");
console.log(JSON.stringify(finalized, (_k, value) => (typeof value === "bigint" ? value.toString() : value), 2));
