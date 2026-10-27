import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Network } from "@fleet-sdk/core";
import { hex, randomBytes } from "@fleet-sdk/crypto";
import { ErgoHDKey, generateMnemonic } from "@fleet-sdk/wallet";
import { HashChain } from "../../src/beacon/chain.js";

/** Role 0 funds and requests; 1 is the ERGO.games root beacon; 2.. are contributor beacons. */
export const BEACON_NAMES = [
  "ergo-games-root",
  "lithos-1",
  "lithos-2",
  "lithos-3",
  "lithos-4",
  "lithos-5",
  "lithos-6",
  "withholder"
] as const;

export const CHAIN_LENGTH = 2_000;

export interface RoleKey {
  name: string;
  hd: ErgoHDKey;
  secretHex: string;
  publicKey: Uint8Array;
  ergoTree: string;
  address: string;
}

export interface PilotSecrets {
  mnemonic: string;
  /** One hash-chain secret per beacon, same order as BEACON_NAMES. */
  chainSecrets: string[];
}

export interface PilotKeys {
  funder: RoleKey;
  beacons: RoleKey[];
  chains: HashChain[];
}

/** Resolved from the repo root (run the pilot from there). */
export const SECRETS_PATH = resolve(process.cwd(), "pilot/.secrets.json");

/** Create the pilot secrets once (0600, gitignored). Never prints them. */
export function ensureSecrets(): PilotSecrets {
  if (existsSync(SECRETS_PATH)) {
    return JSON.parse(readFileSync(SECRETS_PATH, "utf8")) as PilotSecrets;
  }
  const secrets: PilotSecrets = {
    mnemonic: generateMnemonic(),
    chainSecrets: BEACON_NAMES.map(() => hex.encode(randomBytes(32)))
  };
  mkdirSync(dirname(SECRETS_PATH), { recursive: true });
  writeFileSync(SECRETS_PATH, JSON.stringify(secrets, null, 2), { mode: 0o600 });
  chmodSync(SECRETS_PATH, 0o600);
  return secrets;
}

function role(master: ErgoHDKey, index: number, name: string, network: Network): RoleKey {
  const hd = master.deriveChild(index);
  if (!hd.privateKey) throw new Error("derived key has no private key");
  return {
    name,
    hd,
    secretHex: hex.encode(hd.privateKey),
    publicKey: hd.publicKey,
    ergoTree: hd.address.ergoTree,
    address: hd.address.encode(network)
  };
}

export function loadKeys(secrets: PilotSecrets, network: Network = Network.Testnet): PilotKeys {
  const master = ErgoHDKey.fromMnemonicSync(secrets.mnemonic);
  return {
    funder: role(master, 0, "funder", network),
    beacons: BEACON_NAMES.map((name, i) => role(master, i + 1, name, network)),
    chains: secrets.chainSecrets.map((s) => new HashChain(s, CHAIN_LENGTH))
  };
}
