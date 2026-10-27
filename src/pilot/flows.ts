import { hex } from "@fleet-sdk/crypto";
import { parse } from "@fleet-sdk/serializer";
import type { EIP12UnsignedTransaction } from "@fleet-sdk/common";
import { decodeEntry, hashN, type BeaconEntry } from "../beacon/chain.js";
import type { BeaconSuite } from "../beacon/contracts.js";
import { mixRandom, splitFee } from "../beacon/mix.js";
import type { BeaconParams } from "../beacon/params.js";
import { reserveOf } from "../beacon/params.js";
import {
  buildTx,
  bytesRegister,
  entriesRegister,
  entryRegister,
  idsRegister,
  longRegister,
  pkRegister,
  type LedgerBox,
  type OutputSpec
} from "./tx.js";

/** What every builder needs: the compiled contracts and the HEIGHT the tx will be checked against. */
export interface FlowContext {
  suite: BeaconSuite;
  params: BeaconParams;
  height: number;
}

export function epochAt(height: number, params: BeaconParams): bigint {
  return BigInt(Math.floor(height / params.epochLen));
}

export function p2pkTree(publicKey: Uint8Array): string {
  return `0008cd${hex.encode(publicKey)}`;
}

export interface BeaconView {
  nftId: string;
  entry: BeaconEntry;
  publicKey: Uint8Array;
}

export function readBeacon(box: LedgerBox): BeaconView {
  const entry = decodeEntry(parse<Uint8Array>(box.additionalRegisters.R4!));
  return { nftId: box.assets[0]!.tokenId, entry, publicKey: parse<Uint8Array>(box.additionalRegisters.R5!) };
}

export interface RequestView {
  ids: string[];
  entries: BeaconEntry[];
  requesterTree: string;
  target: bigint;
}

export function readRequest(box: LedgerBox): RequestView {
  const r = box.additionalRegisters;
  return {
    ids: parse<Uint8Array[]>(r.R4!).map((id) => hex.encode(id)),
    entries: parse<Uint8Array[]>(r.R5!).map((e) => decodeEntry(e)),
    requesterTree: hex.encode(parse<Uint8Array>(r.R6!)),
    target: parse<bigint>(r.R7!)
  };
}

function fee(ctx: FlowContext) {
  return ctx.params.minerFee;
}

/** Mint the ticket supply into a new factory box. The ticket id is `funding[0].boxId`. */
export function mintFactoryTx(ctx: FlowContext, funding: LedgerBox[], supply: bigint, value: bigint, changeTree: string) {
  if (funding[0]!.boxId !== ctx.suite.requestTokenId) {
    throw new Error("suite was compiled for a different ticket id than funding[0].boxId");
  }
  return buildTx(ctx.height, fee(ctx), funding.map((box) => ({ box })), [], [
    { ergoTree: ctx.suite.factory.ergoTreeHex, value, assets: [{ tokenId: funding[0]!.boxId, amount: supply }] }
  ], changeTree);
}

/** Register a beacon: mint its NFT (id = `funding[0].boxId`) into a bonded beacon box at its chain anchor. */
export function registerBeaconTx(
  ctx: FlowContext,
  funding: LedgerBox[],
  publicKey: Uint8Array,
  anchor: BeaconEntry,
  changeTree: string
) {
  return buildTx(ctx.height, fee(ctx), funding.map((box) => ({ box })), [], [
    {
      ergoTree: ctx.suite.beacon.ergoTreeHex,
      value: ctx.params.minBond,
      assets: [{ tokenId: funding[0]!.boxId, amount: 1n }],
      registers: { R4: entryRegister(anchor.epoch, anchor.tipHex), R5: pkRegister(publicKey) }
    }
  ], changeTree);
}

/** Reveal `valueHex` for `nextEpoch`. The beacon's key and the funding box's key both sign. */
export function revealTx(ctx: FlowContext, beacon: LedgerBox, funding: LedgerBox[], valueHex: string, nextEpoch: bigint, changeTree: string) {
  const view = readBeacon(beacon);
  return buildTx(ctx.height, fee(ctx), [{ box: beacon, action: 0 }, ...funding.map((box) => ({ box }))], [], [
    {
      ergoTree: beacon.ergoTree,
      value: beacon.value,
      assets: beacon.assets,
      registers: { R4: entryRegister(nextEpoch, valueHex), R5: pkRegister(view.publicKey) }
    }
  ], changeTree);
}

/** Open a request listing `beacons` (root first) for `target`. Needs no signature beyond the funding. */
export function openRequestTx(
  ctx: FlowContext,
  factory: LedgerBox,
  beacons: LedgerBox[],
  funding: LedgerBox[],
  requesterTree: string,
  target: bigint,
  pool: bigint,
  changeTree: string
) {
  const ticket = factory.assets[0]!;
  const views = beacons.map(readBeacon);
  return buildTx(ctx.height, fee(ctx), [{ box: factory }, ...funding.map((box) => ({ box }))], beacons, [
    { ergoTree: factory.ergoTree, value: factory.value, assets: [{ tokenId: ticket.tokenId, amount: ticket.amount - 1n }] },
    {
      ergoTree: ctx.suite.request.ergoTreeHex,
      value: reserveOf(ctx.params) + pool,
      assets: [{ tokenId: ticket.tokenId, amount: 1n }],
      registers: {
        R4: idsRegister(views.map((v) => v.nftId)),
        R5: entriesRegister(views.map((v) => v.entry)),
        R6: bytesRegister(requesterTree),
        R7: longRegister(target)
      }
    }
  ], changeTree);
}

/** A contributor joins before the target epoch starts. The joining beacon's key signs. */
export function joinTx(ctx: FlowContext, request: LedgerBox, beacon: LedgerBox, funding: LedgerBox[], changeTree: string) {
  const req = readRequest(request);
  const view = readBeacon(beacon);
  return buildTx(ctx.height, fee(ctx), [{ box: request, action: 0 }, ...funding.map((box) => ({ box }))], [beacon], [
    {
      ergoTree: request.ergoTree,
      value: request.value,
      assets: request.assets,
      registers: {
        R4: idsRegister([...req.ids, view.nftId]),
        R5: entriesRegister([...req.entries, view.entry]),
        R6: bytesRegister(req.requesterTree),
        R7: longRegister(req.target)
      }
    }
  ], changeTree);
}

export type BeaconStatus = 1 | 0 | -1;

export interface FulfillPlan {
  status: BeaconStatus[];
  values: string[];
  ready: boolean;
  random: string;
  rootPay: bigint;
  share: bigint;
}

/** Same decision the request contract makes, so the fulfiller knows when it can go and what to pay. */
export function planFulfill(ctx: FlowContext, request: LedgerBox, beacons: LedgerBox[]): FulfillPlan {
  const req = readRequest(request);
  const epochLen = BigInt(ctx.params.epochLen);
  const graceOver = BigInt(ctx.height) >= req.target * epochLen + epochLen + ctx.params.graceBlocks;
  const values: string[] = req.ids.map(() => "");
  const status = req.ids.map((id, i): BeaconStatus => {
    const box = beacons[i];
    if (!box || box.assets[0]?.tokenId !== id || box.value < ctx.params.minBond) return -1;
    const { entry } = readBeacon(box);
    const value = hashN(entry.tipHex, entry.epoch - req.target);
    values[i] = value;
    const rec = req.entries[i]!;
    if (entry.epoch >= req.target && entry.epoch - req.target <= ctx.params.maxLookback) {
      return hashN(value, req.target - rec.epoch) === rec.tipHex ? 1 : 0;
    }
    if (entry.epoch < req.target && graceOver) return 0;
    return -1;
  });
  const ready = status.length === req.ids.length && status.every((s) => s >= 0) && status[0] === 1;
  const included = status.flatMap((s, i) => (s === 1 ? [values[i]!] : []));
  const pool = request.value - reserveOf(ctx.params);
  const { rootPay, share } = splitFee(pool, Math.max(0, included.length - 1), ctx.params.rootShareBps);
  return { status, values, ready, random: mixRandom(request.boxId, included), rootPay, share };
}

/** Fulfill: result box to the requester, then root pay, then each included contributor in order. */
export function fulfillTx(ctx: FlowContext, request: LedgerBox, beacons: LedgerBox[], plan: FulfillPlan) {
  const req = readRequest(request);
  const pays: OutputSpec[] = [];
  plan.status.forEach((s, i) => {
    if (s !== 1) return;
    pays.push({ ergoTree: p2pkTree(readBeacon(beacons[i]!).publicKey), value: i === 0 ? plan.rootPay : plan.share });
  });
  return buildTx(ctx.height, fee(ctx), [{ box: request, action: 1 }], beacons, [
    {
      ergoTree: req.requesterTree,
      value: ctx.params.resultBoxValue,
      assets: [{ tokenId: request.boxId, amount: 1n }],
      registers: { R4: bytesRegister(plan.random), R5: longRegister(req.target) }
    },
    ...pays
  ]);
}

/** Refund the whole request, less the miner fee, once the root is provably out. */
export function refundTx(ctx: FlowContext, request: LedgerBox, rootBeacon: LedgerBox): EIP12UnsignedTransaction {
  const req = readRequest(request);
  return buildTx(ctx.height, fee(ctx), [{ box: request, action: 2 }], [rootBeacon], [
    { ergoTree: req.requesterTree, value: request.value - fee(ctx) }
  ]);
}
