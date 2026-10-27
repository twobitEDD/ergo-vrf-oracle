import { readFileSync } from "node:fs";
import { compile } from "@fleet-sdk/compiler";
import { blake2b256, hex } from "@fleet-sdk/crypto";
import { type BeaconParams, DEFAULT_BEACON_PARAMS, reserveOf } from "./params.js";

const CONTRACTS_DIR = new URL("../../contracts/", import.meta.url);

export interface CompiledContract {
  source: string;
  ergoTreeHex: string;
  /** blake2b256 of the ergoTree bytes, as other contracts check it. */
  hashHex: string;
}

export interface BeaconSuite {
  beacon: CompiledContract;
  request: CompiledContract;
  factory: CompiledContract;
  params: BeaconParams;
  requestTokenId: string;
}

function bytesLiteral(hexValue: string): string {
  return `fromBase16("${hexValue}")`;
}

function render(name: string, constants: Record<string, string>): string {
  const template = readFileSync(new URL(`${name}.es`, CONTRACTS_DIR), "utf8");
  return template.replace(/\$([A-Z_]+)/g, (match, key: string) => {
    const value = constants[key];
    if (value === undefined) {
      throw new Error(`${name}.es: no value for ${match}`);
    }
    return value;
  });
}

function build(name: string, constants: Record<string, string>): CompiledContract {
  const source = render(name, constants);
  const tree = compile(source);
  const ergoTreeHex = tree.toHex();
  return { source, ergoTreeHex, hashHex: hex.encode(blake2b256(hex.decode(ergoTreeHex))) };
}

/**
 * Compile beacon → request → factory. Each later contract pins the hash of the earlier ones.
 * `requestTokenId` is the ticket token the factory box holds.
 */
export function compileBeaconSuite(
  requestTokenId: string,
  params: BeaconParams = DEFAULT_BEACON_PARAMS
): BeaconSuite {
  const maxSteps = Number(params.maxLookback + params.maxDist);
  const shared: Record<string, string> = {
    EPOCH_LEN: String(params.epochLen),
    TARGET_DELAY: `${params.targetDelay}L`,
    MAX_PARTICIPANTS: String(params.maxParticipants),
    MAX_LOOKBACK: `${params.maxLookback}L`,
    MAX_DIST: `${params.maxDist}L`,
    GRACE_BLOCKS: `${params.graceBlocks}L`,
    HARD_TIMEOUT_BLOCKS: `${params.hardTimeoutBlocks}L`,
    UNBOND_EPOCHS: `${params.unbondEpochs}L`,
    MIN_BOND: `${params.minBond}L`,
    ROOT_SHARE_BPS: `${params.rootShareBps}L`,
    RESULT_BOX_VALUE: `${params.resultBoxValue}L`,
    MINER_FEE: `${params.minerFee}L`,
    RESERVE: `${reserveOf(params)}L`,
    STEPS: `Coll(${Array.from({ length: maxSteps }, (_, i) => i + 1).join(", ")})`,
    REQUEST_TOKEN_ID: bytesLiteral(requestTokenId)
  };
  const beacon = build("VrfBeacon", shared);
  const request = build("VrfRequest", { ...shared, BEACON_HASH: bytesLiteral(beacon.hashHex) });
  const factory = build("VrfFactory", {
    ...shared,
    BEACON_HASH: bytesLiteral(beacon.hashHex),
    REQUEST_HASH: bytesLiteral(request.hashHex)
  });
  return { beacon, request, factory, params, requestTokenId };
}
