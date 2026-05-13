import { OperatorClientLoop, type OperatorClientConfig } from "../src/operatorClient.js";

function readRequired(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`missing required env var: ${name}`);
  }
  return value;
}

function parsePositiveInt(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive number`);
  }
  return Math.floor(parsed);
}

const config: OperatorClientConfig = {
  oracleUrl: readRequired("VRF_ORACLE_URL"),
  operatorId: readRequired("VRF_OPERATOR_ID"),
  operatorSecret: readRequired("VRF_OPERATOR_SECRET"),
  rewardAddress: process.env.VRF_OPERATOR_REWARD_ADDRESS?.trim() || "operator-reward-placeholder",
  stakeAmount: BigInt(process.env.VRF_OPERATOR_STAKE_AMOUNT ?? "1000"),
  intervalMs: parsePositiveInt(process.env.VRF_OPERATOR_INTERVAL_MS ?? "5000", "VRF_OPERATOR_INTERVAL_MS"),
  isWhitelisted: (process.env.VRF_OPERATOR_WHITELISTED ?? "true").trim().toLowerCase() !== "false"
};

const loop = new OperatorClientLoop(config);
loop.start();

console.log(
  `[operator:${config.operatorId}] started (oracle=${config.oracleUrl}, intervalMs=${config.intervalMs})`
);

const shutdown = () => {
  loop.stop();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
