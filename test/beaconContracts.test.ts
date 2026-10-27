import { beforeEach, describe, expect, test } from "vitest";
import type { KeyedMockChainParty, MockChain } from "@fleet-sdk/mock-chain";
import type { Box } from "@fleet-sdk/common";
import { HashChain, mixRandom, splitFee } from "../src/beacon/index.js";
import {
  REQUEST_TOKEN_ID,
  RESERVE,
  TICKET_SUPPLY,
  beaconBox,
  box,
  buildTx,
  bytesRegister,
  entriesRegister,
  entryHex,
  fundingBox,
  idsRegister,
  longRegister,
  newChain,
  params,
  pkRegister,
  randomId,
  run,
  suite
} from "./beaconHarness.js";

// Heights are picked mid-epoch (epochLen 5) so an off-by-one between the mock tip and HEIGHT
// never moves a check across an epoch boundary.
const at = (epoch: number, offset = 2) => epoch * params.epochLen + offset;

const ANCHOR_EPOCH = 10n;
const TARGET = 12n;
const POOL = 100_000_000n;

interface Author {
  party: KeyedMockChainParty;
  nft: string;
  chain: HashChain;
}

function author(chain: MockChain, name: string): Author {
  return { party: chain.newParty(name), nft: randomId(), chain: new HashChain(randomId(), 64) };
}

/** Beacon box for `a` after revealing up to `epoch` (anchor sits at ANCHOR_EPOCH). */
function beaconAt(a: Author, epoch: bigint): Box<bigint> {
  return beaconBox(a.party, a.nft, epoch, a.chain.valueAt(Number(epoch - ANCHOR_EPOCH)));
}

function requestBox(requester: KeyedMockChainParty, authors: Author[], opts: { ticket?: boolean; target?: bigint } = {}) {
  return box({
    ergoTree: suite.request.ergoTreeHex,
    value: RESERVE + POOL,
    assets: opts.ticket === false ? [] : [{ tokenId: REQUEST_TOKEN_ID, amount: 1n }],
    registers: {
      R4: idsRegister(authors.map((a) => a.nft)),
      R5: entriesRegister(authors.map((a) => ({ epoch: ANCHOR_EPOCH, tipHex: a.chain.anchorHex }))),
      R6: bytesRegister(requester.ergoTree),
      R7: longRegister(opts.target ?? TARGET)
    }
  });
}

function targetValue(a: Author): string {
  return a.chain.valueAt(Number(TARGET - ANCHOR_EPOCH));
}

describe("VrfBeacon", () => {
  let chain: MockChain;
  let op: Author;

  beforeEach(() => {
    chain = newChain(at(11));
    op = author(chain, "operator");
  });

  function reveal(from: Box<bigint>, nextEpoch: bigint, tipHex: string, action = 0) {
    return buildTx(
      chain,
      [{ box: from, action }, { box: fundingBox(op.party) }],
      [],
      [
        {
          ergoTree: suite.beacon.ergoTreeHex,
          value: from.value,
          assets: from.assets,
          registers: { R4: entryHex(nextEpoch, tipHex), R5: pkRegister(op.party) }
        }
      ],
      op.party.ergoTree
    );
  }

  test("reveals the next chain value once its epoch has started", () => {
    const tx = reveal(beaconAt(op, 10n), 11n, op.chain.valueAt(1));
    expect(run(chain, tx, [op.party])).toBe(true);
  });

  test("refuses to reveal an epoch early", () => {
    const tx = reveal(beaconAt(op, 11n), 12n, op.chain.valueAt(2));
    expect(run(chain, tx, [op.party])).toBe(false);
  });

  test("refuses a value that is not the preimage", () => {
    const tx = reveal(beaconAt(op, 10n), 11n, randomId());
    expect(run(chain, tx, [op.party])).toBe(false);
  });

  test("refuses a reveal signed by someone else", () => {
    const other = chain.newParty("other");
    const tx = reveal(beaconAt(op, 10n), 11n, op.chain.valueAt(1));
    expect(run(chain, tx, [other])).toBe(false);
  });

  test("rotates to a new chain labelled no earlier than the current epoch", () => {
    const fresh = new HashChain(randomId(), 8);
    expect(run(chain, reveal(beaconAt(op, 10n), 11n, fresh.anchorHex, 1), [op.party])).toBe(true);
    expect(run(chain, reveal(beaconAt(op, 10n), 10n, fresh.anchorHex, 1), [op.party])).toBe(false);
  });

  test("withdraws only after the unbond window", () => {
    const withdraw = (from: Box<bigint>) =>
      buildTx(chain, [{ box: from, action: 2 }], [], [], op.party.ergoTree);
    expect(run(chain, withdraw(beaconAt(op, 10n)), [op.party])).toBe(false);
    chain.jumpTo(at(10 + Number(params.unbondEpochs)));
    expect(run(chain, withdraw(beaconAt(op, 10n)), [op.party])).toBe(true);
  });
});

describe("VrfFactory", () => {
  let chain: MockChain;
  let root: Author;
  let lithos: Author;
  let requester: KeyedMockChainParty;

  beforeEach(() => {
    chain = newChain(at(10));
    root = author(chain, "ergo-games-root");
    lithos = author(chain, "lithos");
    requester = chain.newParty("requester");
  });

  function open(authors: Author[], target: bigint, beacons: Box<bigint>[] = authors.map((a) => beaconAt(a, 10n))) {
    const factory = box({
      ergoTree: suite.factory.ergoTreeHex,
      value: 1_000_000n,
      assets: [{ tokenId: REQUEST_TOKEN_ID, amount: TICKET_SUPPLY }]
    });
    const request = requestBox(requester, authors, { target });
    return buildTx(
      chain,
      [{ box: factory }, { box: fundingBox(requester) }],
      beacons,
      [
        { ergoTree: suite.factory.ergoTreeHex, value: factory.value, assets: [{ tokenId: REQUEST_TOKEN_ID, amount: TICKET_SUPPLY - 1n }] },
        { ergoTree: request.ergoTree, value: request.value, assets: request.assets, registers: request.additionalRegisters as Record<string, string> }
      ],
      requester.ergoTree
    );
  }

  test("opens a request for a target 1..TARGET_DELAY epochs ahead", () => {
    expect(run(chain, open([root, lithos], TARGET), [requester])).toBe(true);
    expect(run(chain, open([root], TARGET - 1n), [requester])).toBe(true);
  });

  test("refuses the current epoch or a target too far ahead", () => {
    expect(run(chain, open([root], TARGET - 2n), [requester])).toBe(false);
    expect(run(chain, open([root], TARGET + 1n), [requester])).toBe(false);
  });

  test("refuses a recorded entry that is not the beacon's current one", () => {
    expect(run(chain, open([root], TARGET, [beaconAt(root, 11n)]), [requester])).toBe(false);
  });
});

describe("VrfRequest", () => {
  let chain: MockChain;
  let root: Author;
  let lithosA: Author;
  let lithosB: Author;
  let requester: KeyedMockChainParty;

  beforeEach(() => {
    chain = newChain(at(12));
    root = author(chain, "ergo-games-root");
    lithosA = author(chain, "lithos-a");
    lithosB = author(chain, "lithos-b");
    requester = chain.newParty("requester");
  });

  /** Fulfill `request` with each author's beacon box; `paid` are the authors expected to be paid. */
  function fulfill(
    request: Box<bigint>,
    beacons: Box<bigint>[],
    paid: Author[],
    random = mixRandom(request.boxId, paid.map(targetValue))
  ) {
    const { rootPay, share } = splitFee(POOL, paid.length - 1, params.rootShareBps);
    return buildTx(chain, [{ box: request, action: 1 }], beacons, [
      {
        ergoTree: requester.ergoTree,
        value: params.resultBoxValue,
        assets: [{ tokenId: request.boxId, amount: 1n }],
        registers: { R4: bytesRegister(random), R5: longRegister(TARGET) }
      },
      ...paid.map((a, i) => ({ ergoTree: a.party.ergoTree, value: i === 0 ? rootPay : share }))
    ]);
  }

  test("root alone keeps the whole fee pool", () => {
    const request = requestBox(requester, [root]);
    expect(run(chain, fulfill(request, [beaconAt(root, 12n)], [root]))).toBe(true);
  });

  test("root plus contributors split the pool and every value is mixed in", () => {
    const request = requestBox(requester, [root, lithosA, lithosB]);
    const beacons = [beaconAt(root, 12n), beaconAt(lithosA, 12n), beaconAt(lithosB, 13n)];
    expect(run(chain, fulfill(request, beacons, [root, lithosA, lithosB]))).toBe(true);
  });

  test("another project can be root with ERGO.games as its contributor", () => {
    const request = requestBox(requester, [lithosA, root]);
    expect(run(chain, fulfill(request, [beaconAt(lithosA, 12n), beaconAt(root, 12n)], [lithosA, root]))).toBe(true);
  });

  test("refuses a random that leaves out a contributor who revealed", () => {
    const request = requestBox(requester, [root, lithosA]);
    const beacons = [beaconAt(root, 12n), beaconAt(lithosA, 12n)];
    const random = mixRandom(request.boxId, [targetValue(root)]);
    expect(run(chain, fulfill(request, beacons, [root, lithosA], random))).toBe(false);
  });

  test("waits for a missing contributor until the grace period ends, then leaves it out", () => {
    const request = requestBox(requester, [root, lithosA]);
    const beacons = [beaconAt(root, 12n), beaconAt(lithosA, 11n)];
    expect(run(chain, fulfill(request, beacons, [root]))).toBe(false);
    chain.jumpTo(Number((TARGET + 1n) * BigInt(params.epochLen) + params.graceBlocks) + 1);
    expect(run(chain, fulfill(request, beacons, [root]))).toBe(true);
  });

  test("leaves out a contributor that rotated off its recorded chain", () => {
    const request = requestBox(requester, [root, lithosA]);
    const rotated = beaconBox(lithosA.party, lithosA.nft, 12n, randomId());
    expect(run(chain, fulfill(request, [beaconAt(root, 12n), rotated], [root]))).toBe(true);
  });

  test("underpaying a contributor is refused", () => {
    const request = requestBox(requester, [root, lithosA]);
    const tx = fulfill(request, [beaconAt(root, 12n), beaconAt(lithosA, 12n)], [root, lithosA]);
    const outputs = tx.outputs as unknown as { value: string }[];
    outputs[1]!.value = (BigInt(outputs[1]!.value) + 1_000n).toString();
    outputs[2]!.value = (BigInt(outputs[2]!.value) - 1_000n).toString();
    expect(run(chain, tx)).toBe(false);
  });

  test("a box without a factory ticket cannot be fulfilled", () => {
    const forged = requestBox(requester, [root], { ticket: false });
    expect(run(chain, fulfill(forged, [beaconAt(root, 12n)], [root]))).toBe(false);
  });

  test("a contributor joins before the target epoch, not after", () => {
    chain.jumpTo(at(11));
    const request = requestBox(requester, [root]);
    const joiner = beaconAt(lithosA, 11n);
    const join = () =>
      buildTx(
        chain,
        [{ box: request, action: 0 }, { box: fundingBox(lithosA.party) }],
        [joiner],
        [
          {
            ergoTree: request.ergoTree,
            value: request.value,
            assets: request.assets,
            registers: {
              ...(request.additionalRegisters as Record<string, string>),
              R4: idsRegister([root.nft, lithosA.nft]),
              R5: entriesRegister([
                { epoch: ANCHOR_EPOCH, tipHex: root.chain.anchorHex },
                { epoch: 11n, tipHex: lithosA.chain.valueAt(1) }
              ])
            }
          }
        ],
        lithosA.party.ergoTree
      );
    expect(run(chain, join(), [lithosA.party])).toBe(true);
    chain.jumpTo(at(12));
    expect(run(chain, join(), [lithosA.party])).toBe(false);
  });

  test("refunds when the root provably did not reveal, not before", () => {
    const request = requestBox(requester, [root]);
    const refund = () =>
      buildTx(chain, [{ box: request, action: 2 }], [beaconAt(root, 11n)], [
        { ergoTree: requester.ergoTree, value: request.value - params.minerFee }
      ]);
    expect(run(chain, refund())).toBe(false);
    chain.jumpTo(Number((TARGET + 1n) * BigInt(params.epochLen) + params.graceBlocks) + 1);
    expect(run(chain, refund())).toBe(true);
  });
});
