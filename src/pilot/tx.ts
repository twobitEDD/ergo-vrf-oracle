import { FEE_CONTRACT } from "@fleet-sdk/core";
import { SByte, SColl, SGroupElement, SLong } from "@fleet-sdk/serializer";
import { hex } from "@fleet-sdk/crypto";
import type { Box, EIP12UnsignedTransaction } from "@fleet-sdk/common";
import { encodeEntry, type BeaconEntry } from "../beacon/chain.js";

export type Registers = Record<string, string>;
export type LedgerBox = Box<bigint>;

export interface TokenSpec {
  tokenId: string;
  amount: bigint;
}

export interface OutputSpec {
  ergoTree: string;
  value: bigint;
  assets?: TokenSpec[];
  registers?: Registers;
}

export interface InputSpec {
  box: LedgerBox;
  /** Context var 0 (Byte) on this input — the contract action. */
  action?: number;
}

export function entryRegister(epoch: bigint, tipHex: string): string {
  return SColl(SByte, encodeEntry({ epoch, tipHex })).toHex();
}

export function pkRegister(publicKey: Uint8Array): string {
  return SGroupElement(publicKey).toHex();
}

export function idsRegister(ids: string[]): string {
  return SColl(SColl(SByte), ids.map((id) => hex.decode(id))).toHex();
}

export function entriesRegister(entries: BeaconEntry[]): string {
  return SColl(SColl(SByte), entries.map((e) => encodeEntry(e))).toHex();
}

export function bytesRegister(value: string): string {
  return SColl(SByte, hex.decode(value)).toHex();
}

export function longRegister(value: bigint): string {
  return SLong(value).toHex();
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
 * EIP-12 transaction with inputs and outputs in exactly the given order, then the miner fee output
 * and, when ERG is left over, a change output to `changeTree`. Leftover tokens are burned.
 */
export function buildTx(
  creationHeight: number,
  minerFee: bigint,
  inputs: InputSpec[],
  dataInputs: LedgerBox[],
  outputs: OutputSpec[],
  changeTree?: string
): EIP12UnsignedTransaction {
  const totalIn = inputs.reduce((sum, i) => sum + i.box.value, 0n);
  const totalOut = outputs.reduce((sum, o) => sum + o.value, 0n) + minerFee;
  const all: OutputSpec[] = [...outputs, { ergoTree: FEE_CONTRACT, value: minerFee }];
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
      creationHeight,
      assets: (o.assets ?? []).map((a) => ({ tokenId: a.tokenId, amount: a.amount.toString() })),
      additionalRegisters: o.registers ?? {}
    }))
  } as unknown as EIP12UnsignedTransaction;
}
