/**
 * Testnet pilot for the multi-root beacon VRF, with FishFight as the case study.
 *
 *   node dist/scripts/pilot/run.js keys       create pilot keys (once) and print the funder address
 *   node dist/scripts/pilot/run.js status     funder balance and chain height
 *   node dist/scripts/pilot/run.js dry-run    whole pilot on the Fleet mock chain
 *   node dist/scripts/pilot/run.js testnet    setup + scenarios on testnet (ERGO_NODE_URL)
 *
 * Every transaction is logged to pilot/runs/<kind>-<time>.jsonl and a summary is written beside it.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { mockUTxO } from "@fleet-sdk/mock-chain";
import type { EIP12UnsignedTransaction } from "@fleet-sdk/common";
import { DEFAULT_BEACON_PARAMS, type BeaconParams } from "../../src/beacon/params.js";
import { compileBeaconSuite } from "../../src/beacon/contracts.js";
import {
  epochAt,
  fulfillTx,
  joinTx,
  mintFactoryTx,
  openRequestTx,
  planFulfill,
  readBeacon,
  readRequest,
  refundTx,
  registerBeaconTx,
  revealTx,
  type FlowContext
} from "../../src/pilot/flows.js";
import { buildTx, type LedgerBox } from "../../src/pilot/tx.js";
import { BEACON_NAMES, ensureSecrets, loadKeys, type PilotKeys, type RoleKey } from "./keys.js";
import { MockLedger, NodeLedger, type Ledger, type SubmitResult } from "./ledger.js";

const PILOT_PARAMS: BeaconParams = { ...DEFAULT_BEACON_PARAMS, minBond: 100_000_000n };
const TICKET_SUPPLY = 1_000_000_000n;
const FACTORY_VALUE = 10_000_000n;
const FEE_BOX = 20_000_000n;
const FEE_BOXES = 40;
const POOL = 10_000_000n;
const ERG = 1_000_000_000n;
const NEEDED = 2n * ERG;

const ROOT = 0;
const WITHHOLDER = BEACON_NAMES.indexOf("withholder");

type ScenarioId = "spar" | "mint8" | "breed-join" | "contention" | "refund" | "partner-root";

interface Scenario {
  id: ScenarioId;
  purpose: string;
  note: string;
  /** Beacon indexes listed when the request is opened, root first. */
  listed: number[];
  joiner?: number;
  expect: "fulfill" | "refund";
  requestBoxId?: string;
  state: "pending" | "open" | "joined" | "done" | "failed";
  result?: Record<string, unknown>;
}

const SCENARIOS: Scenario[] = [
  { id: "spar", purpose: "fishfight:spar", note: "ERGO.games root alone keeps the whole fee", listed: [ROOT], expect: "fulfill", state: "pending" },
  {
    id: "mint8",
    purpose: "fishfight:mint",
    note: "root + 6 contributors + 1 withholder (8 participants, worst case size/cost); withholder left out after grace",
    listed: [0, 1, 2, 3, 4, 5, 6, WITHHOLDER],
    expect: "fulfill",
    state: "pending"
  },
  { id: "breed-join", purpose: "fishfight:breed", note: "root opens, lithos-1 joins before the target epoch", listed: [ROOT], joiner: 1, expect: "fulfill", state: "pending" },
  { id: "contention", purpose: "fishfight:spar", note: "two opens built on the same factory box; one must lose", listed: [ROOT], expect: "fulfill", state: "pending" },
  { id: "refund", purpose: "fishfight:lethal", note: "withholder is root and never reveals; requester refunds after grace", listed: [WITHHOLDER], expect: "refund", state: "pending" },
  { id: "partner-root", purpose: "partner:dice", note: "lithos-1 is root, ERGO.games contributes", listed: [1, ROOT], expect: "fulfill", state: "pending" }
];

class Recorder {
  readonly dir: string;
  readonly logPath: string;
  readonly started = Date.now();
  readonly txs: Array<Record<string, unknown>> = [];

  constructor(kind: string) {
    this.dir = resolve(process.cwd(), "pilot/runs");
    mkdirSync(this.dir, { recursive: true });
    this.logPath = resolve(this.dir, `${kind}-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
  }

  log(event: Record<string, unknown>): void {
    const line = { t: new Date().toISOString(), ...event };
    if (event.kind === "tx") this.txs.push(line);
    appendFileSync(this.logPath, `${JSON.stringify(line, (_, v) => (typeof v === "bigint" ? v.toString() : v))}\n`);
    const short = event.kind === "tx" ? `${event.ok ? "ok  " : "FAIL"} ${event.label} ${event.txId ?? ""} ${event.bytes ? `${event.bytes}B` : ""} ${event.reason ?? ""}` : JSON.stringify(event, (_, v) => (typeof v === "bigint" ? v.toString() : v));
    console.log(short.slice(0, 300));
  }
}

class Pilot {
  ctx!: FlowContext;
  beaconNfts: string[] = [];
  anchorEpoch = 0n;
  factoryTree = "";
  private revealPending = new Set<number>();
  private confirms: Array<Promise<void>> = [];

  constructor(
    private ledger: Ledger,
    private keys: PilotKeys,
    private rec: Recorder
  ) {}

  private async context(): Promise<FlowContext> {
    const height = await this.ledger.height();
    return { ...this.ctx, height };
  }

  private async send(label: string, tx: EIP12UnsignedTransaction, signers: RoleKey[], extra: Record<string, unknown> = {}): Promise<SubmitResult> {
    const height = await this.ledger.height();
    const res = await this.ledger.submit(tx, signers);
    this.rec.log({ kind: "tx", label, ok: res.ok, txId: res.txId, bytes: res.bytes, reason: res.reason, builtAt: height, ...extra });
    if (res.ok) {
      const sentAt = Date.now();
      this.confirms.push(
        this.ledger.waitConfirmed(res.txId).then((inclusion) => {
          this.rec.log({ kind: "confirm", label, txId: res.txId, inclusionHeight: inclusion ?? null, dropped: inclusion === undefined, waitedMs: Date.now() - sentAt, blocksAfterBuild: inclusion === undefined ? null : inclusion - height });
        })
      );
    }
    return res;
  }

  /** Smallest funder box (excluding the big setup leftovers) that covers `need` plus a change box. */
  private async feeBox(need = 2n * PILOT_PARAMS.minerFee): Promise<LedgerBox> {
    const boxes = (await this.ledger.unspentByErgoTree(this.keys.funder.ergoTree)).filter((b) => b.assets.length === 0 && b.value >= need + 1_000_000n && b.value <= FEE_BOX);
    if (!boxes.length) throw new Error("no fee box left; fund the pilot wallet or rerun setup");
    return boxes.sort((a, b) => (a.value < b.value ? -1 : 1))[0]!;
  }

  async setup(): Promise<void> {
    const height = await this.ledger.height();
    const funding = (await this.ledger.unspentByErgoTree(this.keys.funder.ergoTree)).filter((b) => b.assets.length === 0);
    const total = funding.reduce((s, b) => s + b.value, 0n);
    this.rec.log({ kind: "setup", height, funderBoxes: funding.length, funderNanoErg: total });
    if (total < NEEDED) throw new Error(`pilot wallet holds ${total} nanoERG; needs ${NEEDED}. Fund ${this.keys.funder.address}`);

    // 1. Split funds: one box per mint (factory + each beacon) and FEE_BOXES fee boxes.
    const minerFee = PILOT_PARAMS.minerFee;
    const mintFund = PILOT_PARAMS.minBond + 2n * minerFee + 1_000_000n;
    const outputs = [
      { ergoTree: this.keys.funder.ergoTree, value: FACTORY_VALUE + 2n * minerFee + 1_000_000n },
      ...BEACON_NAMES.map(() => ({ ergoTree: this.keys.funder.ergoTree, value: mintFund })),
      ...Array.from({ length: FEE_BOXES }, () => ({ ergoTree: this.keys.funder.ergoTree, value: FEE_BOX }))
    ];
    const split = buildTx(height, minerFee, funding.map((box) => ({ box })), [], outputs, this.keys.funder.ergoTree);
    const splitRes = await this.send("setup:split", split, [this.keys.funder]);
    if (!splitRes.ok) throw new Error(`split failed: ${splitRes.reason}`);
    const [factoryFund, ...rest] = splitRes.outputs;
    const beaconFunds = rest.slice(0, BEACON_NAMES.length);

    // 2. Ticket token id = the factory funding box id. Contracts are compiled against it.
    const suite = compileBeaconSuite(factoryFund!.boxId, PILOT_PARAMS);
    this.ctx = { suite, params: PILOT_PARAMS, height };
    this.factoryTree = suite.factory.ergoTreeHex;
    const factoryRes = await this.send("setup:factory", mintFactoryTx(this.ctx, [factoryFund!], TICKET_SUPPLY, FACTORY_VALUE, this.keys.funder.ergoTree), [this.keys.funder]);
    if (!factoryRes.ok) throw new Error(`factory mint failed: ${factoryRes.reason}`);

    // 3. One bonded beacon per author, anchored at the current epoch.
    this.anchorEpoch = epochAt(height, PILOT_PARAMS);
    for (const [i, key] of this.keys.beacons.entries()) {
      const anchor = { epoch: this.anchorEpoch, tipHex: this.keys.chains[i]!.anchorHex };
      const res = await this.send(`setup:beacon:${key.name}`, registerBeaconTx(this.ctx, [beaconFunds[i]!], key.publicKey, anchor, this.keys.funder.ergoTree), [this.keys.funder]);
      if (!res.ok) throw new Error(`beacon ${key.name} failed: ${res.reason}`);
      this.beaconNfts.push(beaconFunds[i]!.boxId);
    }
    this.rec.log({
      kind: "setup-done",
      ticketTokenId: suite.requestTokenId,
      beaconHash: suite.beacon.hashHex,
      requestHash: suite.request.hashHex,
      factoryHash: suite.factory.hashHex,
      treeBytes: { beacon: suite.beacon.ergoTreeHex.length / 2, request: suite.request.ergoTreeHex.length / 2, factory: suite.factory.ergoTreeHex.length / 2 },
      beacons: Object.fromEntries(BEACON_NAMES.map((n, i) => [n, this.beaconNfts[i]])),
      anchorEpoch: this.anchorEpoch
    });
  }

  private async beacon(i: number): Promise<LedgerBox> {
    const boxes = (await this.ledger.unspentByTokenId(this.beaconNfts[i]!)).filter((b) => b.ergoTree === this.ctx.suite.beacon.ergoTreeHex);
    if (boxes.length !== 1) throw new Error(`beacon ${BEACON_NAMES[i]} has ${boxes.length} live boxes`);
    return boxes[0]!;
  }

  private async factory(): Promise<LedgerBox> {
    const boxes = (await this.ledger.unspentByTokenId(this.ctx.suite.requestTokenId)).filter((b) => b.ergoTree === this.factoryTree);
    if (!boxes.length) throw new Error("factory box not found");
    return boxes.sort((a, b) => (a.assets[0]!.amount < b.assets[0]!.amount ? -1 : 1))[0]!;
  }

  private async request(s: Scenario): Promise<LedgerBox | undefined> {
    const boxes = (await this.ledger.unspentByErgoTree(this.ctx.suite.request.ergoTreeHex)).filter((b) => b.boxId === s.requestBoxId);
    return boxes[0];
  }

  /** Every beacon except the withholder reveals one step per call when it is behind. */
  async revealRound(): Promise<void> {
    const ctx = await this.context();
    const cur = epochAt(ctx.height, PILOT_PARAMS);
    for (const [i, key] of this.keys.beacons.entries()) {
      if (i === WITHHOLDER || this.revealPending.has(i)) continue;
      const box = await this.beacon(i);
      const { entry } = readBeacon(box);
      if (entry.epoch >= cur) continue;
      const next = entry.epoch + 1n;
      const value = this.keys.chains[i]!.valueAt(Number(next - this.anchorEpoch));
      this.revealPending.add(i);
      const res = await this.send(`reveal:${key.name}:e${next}`, revealTx(ctx, box, [await this.feeBox()], value, next, this.keys.funder.ergoTree), [key, this.keys.funder]);
      this.revealPending.delete(i);
      if (!res.ok) this.rec.log({ kind: "warn", msg: `reveal ${key.name} e${next} failed` });
    }
  }

  private async open(s: Scenario, factory?: LedgerBox): Promise<SubmitResult> {
    const ctx = await this.context();
    const target = epochAt(ctx.height, PILOT_PARAMS) + PILOT_PARAMS.targetDelay;
    const beacons = await Promise.all(s.listed.map((i) => this.beacon(i)));
    const tx = openRequestTx(ctx, factory ?? (await this.factory()), beacons, [await this.feeBox(POOL + 2n * PILOT_PARAMS.resultBoxValue + 2n * PILOT_PARAMS.minerFee)], this.keys.funder.ergoTree, target, POOL, this.keys.funder.ergoTree);
    return this.send(`open:${s.id}`, tx, [this.keys.funder], { scenario: s.id, purpose: s.purpose, target, listed: s.listed.map((i) => BEACON_NAMES[i]) });
  }

  async openAll(): Promise<void> {
    for (const s of SCENARIOS) {
      if (s.id === "contention") {
        // Two opens from the same factory box. The second conflicts with the first.
        const factory = await this.factory();
        const a = await this.open(s, factory);
        const b = await this.open({ ...s, id: "contention" }, factory);
        this.rec.log({ kind: "contention", firstOk: a.ok, secondOk: b.ok, secondReason: b.reason ?? null });
        const winner = a.ok ? a : b;
        s.requestBoxId = winner.outputs[1]?.boxId;
        s.state = winner.ok ? "open" : "failed";
        continue;
      }
      const res = await this.open(s);
      s.requestBoxId = res.outputs[1]?.boxId;
      s.state = res.ok ? "open" : "failed";
    }
  }

  async progress(): Promise<void> {
    for (const s of SCENARIOS) {
      if (s.state !== "open" && s.state !== "joined") continue;
      const request = await this.request(s);
      if (!request) continue;
      const ctx = await this.context();
      const req = readRequest(request);

      if (s.joiner !== undefined && s.state === "open") {
        if (BigInt(ctx.height) >= req.target * BigInt(PILOT_PARAMS.epochLen)) {
          s.state = "failed";
          this.rec.log({ kind: "warn", msg: `${s.id}: join window closed before joining` });
          continue;
        }
        const joiner = this.keys.beacons[s.joiner]!;
        const res = await this.send(`join:${s.id}:${joiner.name}`, joinTx(ctx, request, await this.beacon(s.joiner), [await this.feeBox()], this.keys.funder.ergoTree), [joiner, this.keys.funder], { scenario: s.id });
        if (res.ok) {
          s.requestBoxId = res.outputs[0]!.boxId;
          s.state = "joined";
        }
        continue;
      }

      const listedIdx = req.ids.map((id) => this.beaconNfts.indexOf(id));
      const beacons = await Promise.all(listedIdx.map((i) => this.beacon(i)));

      if (s.expect === "refund") {
        const plan = planFulfill(ctx, request, beacons);
        if (plan.status[0] !== 0) continue;
        const res = await this.send(`refund:${s.id}`, refundTx(ctx, request, beacons[0]!), [], { scenario: s.id });
        if (res.ok) {
          s.state = "done";
          s.result = { refunded: true, txId: res.txId, atHeight: ctx.height, target: req.target };
        }
        continue;
      }

      const plan = planFulfill(ctx, request, beacons);
      if (!plan.ready) continue;
      const res = await this.send(`fulfill:${s.id}`, fulfillTx(ctx, request, beacons, plan), [], { scenario: s.id, status: plan.status });
      if (res.ok) {
        s.state = "done";
        s.result = {
          purpose: s.purpose,
          requestBoxId: request.boxId,
          resultBoxId: res.outputs[0]!.boxId,
          random: plan.random,
          target: req.target,
          included: plan.status.flatMap((st, i) => (st === 1 ? [BEACON_NAMES[listedIdx[i]!]] : [])),
          leftOut: plan.status.flatMap((st, i) => (st === 0 ? [BEACON_NAMES[listedIdx[i]!]] : [])),
          rootPay: plan.rootPay,
          share: plan.share,
          fulfillTxId: res.txId,
          bytes: res.bytes,
          atHeight: ctx.height
        };
      } else {
        s.state = "failed";
        s.result = { fulfillError: res.reason };
      }
    }
  }

  done(): boolean {
    return SCENARIOS.every((s) => s.state === "done" || s.state === "failed");
  }

  async settle(): Promise<void> {
    await Promise.all(this.confirms);
  }
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "dry-run";
  const keys = loadKeys(ensureSecrets());
  const nodeUrl = process.env.ERGO_NODE_URL ?? "http://213.239.193.208:9052";

  if (command === "keys") {
    console.log(JSON.stringify({ funderAddress: keys.funder.address, network: "testnet", fundWith: `${NEEDED / ERG} testnet ERG` }, null, 2));
    return;
  }
  if (command === "status") {
    const ledger = new NodeLedger(nodeUrl);
    const boxes = await ledger.unspentByErgoTree(keys.funder.ergoTree);
    const total = boxes.reduce((s, b) => s + b.value, 0n);
    console.log(JSON.stringify({ nodeUrl, height: await ledger.height(), funderAddress: keys.funder.address, funderNanoErg: total.toString(), boxes: boxes.length }, null, 2));
    return;
  }

  let ledger: Ledger;
  if (command === "dry-run") {
    const mock = new MockLedger(600_002);
    mock.seed([mockUTxO({ ergoTree: keys.funder.ergoTree, value: 5n * ERG, creationHeight: 600_000, assets: [], additionalRegisters: {} })]);
    ledger = mock;
  } else if (command === "testnet") {
    ledger = new NodeLedger(nodeUrl);
  } else {
    throw new Error(`unknown command ${command}`);
  }

  const rec = new Recorder(ledger.kind);
  const pilot = new Pilot(ledger, keys, rec);
  rec.log({ kind: "start", ledger: ledger.kind, nodeUrl: ledger.kind === "testnet" ? nodeUrl : null, params: PILOT_PARAMS });
  await pilot.setup();

  const pollMs = ledger.kind === "mock" ? 0 : 15_000;
  const startEpoch = epochAt(await ledger.height(), PILOT_PARAMS);
  let opened = false;
  while (!pilot.done()) {
    const height = await ledger.height();
    const cur = epochAt(height, PILOT_PARAMS);
    if (cur > startEpoch + 14n) {
      rec.log({ kind: "timeout", height });
      break;
    }
    await pilot.revealRound();
    // Open once every beacon has made its first reveal, so the reveal path is proven first.
    if (!opened && cur > startEpoch) {
      await pilot.openAll();
      opened = true;
    } else if (opened) {
      await pilot.progress();
    }
    if (ledger.kind === "mock") await ledger.waitForHeight(height + 1);
    else await new Promise((r) => setTimeout(r, pollMs));
  }

  await pilot.settle();
  const summary = {
    ledger: ledger.kind,
    finishedAt: new Date().toISOString(),
    wallMinutes: Math.round((Date.now() - rec.started) / 600) / 100,
    scenarios: SCENARIOS.map((s) => ({ id: s.id, purpose: s.purpose, note: s.note, state: s.state, result: s.result ?? null })),
    txCount: rec.txs.length,
    txFailures: rec.txs.filter((t) => !t.ok).map((t) => ({ label: t.label, reason: t.reason }))
  };
  const summaryPath = rec.logPath.replace(/\.jsonl$/, ".summary.json");
  writeFileSync(summaryPath, JSON.stringify(summary, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  console.log(`summary: ${summaryPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
