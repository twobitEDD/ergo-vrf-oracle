import { FEE_CONTRACT } from "@fleet-sdk/core";
import { type KeyedMockChainParty, MockChain, mockUTxO } from "@fleet-sdk/mock-chain";
import { SByte, SColl, SGroupElement, SLong } from "@fleet-sdk/serializer";
import { hex, randomBytes } from "@fleet-sdk/crypto";
import type { Box, EIP12UnsignedTransaction } from "@fleet-sdk/common";
import { type BeaconSuite, DEFAULT_BEACON_PARAMS, compileBeaconSuite, encodeEntry, reserveOf } from "../src/beacon/index.js";

export type Registers = Record<string, string>;

export interface OutputSpec {
  ergoTree: string;
  value: bigint;
  assets?: { tokenId: string; amount: bigint }[];
  registers?: Registers;
}

export interface InputSpec {
  box: Box<bigint>;
  action?: number;
}

export const params = DEFAULT_BEACON_PARAMS;
export const RESERVE = reserveOf(params);
export const REQUEST_TOKEN_ID = hex.encode(randomBytes(32));
export const TICKET_SUPPLY = 1_000_000n;

export const suite: BeaconSuite = compileBeaconSuite(REQUEST_TOKEN_ID, params);

export function randomId(): string {
  return hex.encode(randomBytes(32));
}

export function entryHex(epoch: bigint, tipHex: string): string {
  return SColl(SByte, encodeEntry({ epoch, tipHex })).toHex();
}

export function pkRegister(party: KeyedMockChainParty): string {
  return SGroupElement(party.key.publicKey).toHex();
}

export function idsRegister(ids: string[]): string {
  return SColl(SColl(SByte), ids.map((id) => hex.decode(id))).toHex();
}

export function entriesRegister(entries: { epoch: bigint; tipHex: string }[]): string {
  return SColl(SColl(SByte), entries.map((e) => encodeEntry(e))).toHex();
}

export function bytesRegister(value: string): string {
  return SColl(SByte, hex.decode(value)).toHex();
}

export function longRegister(value: bigint): string {
  return SLong(value).toHex();
}

export function box(spec: OutputSpec, creationHeight = 1): Box<bigint> {
  return mockUTxO({
    ergoTree: spec.ergoTree,
    value: spec.value,
    assets: spec.assets ?? [],
    additionalRegisters: spec.registers ?? {},
    creationHeight
  });
}

export function beaconBox(owner: KeyedMockChainParty, nftId: string, epoch: bigint, tipHex: string, bond = params.minBond): Box<bigint> {
  return box({
    ergoTree: suite.beacon.ergoTreeHex,
    value: bond,
    assets: [{ tokenId: nftId, amount: 1n }],
    registers: { R4: entryHex(epoch, tipHex), R5: pkRegister(owner) }
  });
}

export function fundingBox(party: KeyedMockChainParty, value = 10_000_000_000n): Box<bigint> {
  return box({ ergoTree: party.ergoTree, value });
}

function inputJson(input: InputSpec) {
  return {
    boxId: input.box.boxId,
    transactionId: input.box.transactionId,
    index: input.box.index,
    ergoTree: input.box.ergoTree,
    creationHeight: input.box.creationHeight,
    value: input.box.value.toString(),
    assets: input.box.assets.map((a) => ({ tokenId: a.tokenId, amount: a.amount.toString() })),
    additionalRegisters: input.box.additionalRegisters,
    extension: input.action === undefined ? {} : { "0": SByte(input.action).toHex() }
  };
}

/**
 * Build an EIP-12 transaction with inputs and outputs in exactly the given order, plus the miner
 * fee output and, when ERG is left over, a change output to `changeTree`.
 */
export function buildTx(
  chain: MockChain,
  inputs: InputSpec[],
  dataInputs: Box<bigint>[],
  outputs: OutputSpec[],
  changeTree?: string
): EIP12UnsignedTransaction {
  const fee = params.minerFee;
  const totalIn = inputs.reduce((sum, i) => sum + i.box.value, 0n);
  const totalOut = outputs.reduce((sum, o) => sum + o.value, 0n) + fee;
  const all: OutputSpec[] = [...outputs, { ergoTree: FEE_CONTRACT, value: fee }];
  if (totalIn > totalOut) {
    if (!changeTree) {
      throw new Error(`unbalanced: ${totalIn - totalOut} nanoERG left over and no change address`);
    }
    all.push({ ergoTree: changeTree, value: totalIn - totalOut });
  } else if (totalIn < totalOut) {
    throw new Error(`unbalanced: outputs exceed inputs by ${totalOut - totalIn}`);
  }
  return {
    inputs: inputs.map(inputJson),
    dataInputs: dataInputs.map((d) => ({ ...inputJson({ box: d }), extension: undefined })),
    outputs: all.map((o) => ({
      ergoTree: o.ergoTree,
      value: o.value.toString(),
      creationHeight: chain.height,
      assets: (o.assets ?? []).map((a) => ({ tokenId: a.tokenId, amount: a.amount.toString() })),
      additionalRegisters: o.registers ?? {}
    }))
  } as unknown as EIP12UnsignedTransaction;
}

export function run(chain: MockChain, tx: EIP12UnsignedTransaction, signers: KeyedMockChainParty[] = []): boolean {
  return chain.execute(tx, { signers, throw: false, log: process.env.VRF_LOG === "1" });
}

export function newChain(height: number): MockChain {
  return new MockChain({ height });
}
