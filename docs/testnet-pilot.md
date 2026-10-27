# Testnet pilot — FishFight case study

Runs the multi-root beacon VRF ([design](./multi-root-beacon-vrf.md)) end to end on Ergo testnet and
records what the mock chain cannot tell us: real script cost and size, confirmation timing, mempool
chaining, and what happens when two transactions race for the factory box.

## Cast

| Role | Who |
|------|-----|
| `funder` | Pays every fee and opens every request (stands in for the FishFight backend) |
| `ergo-games-root` | The ERGO.games beacon |
| `lithos-1` … `lithos-6` | Contributor beacons (stand-ins for Lithos operators) |
| `withholder` | Registers, then never reveals |

Keys and hash-chain secrets live in `pilot/.secrets.json` (created on first run, `0600`, gitignored, never
printed). Pilot parameters: defaults from `src/beacon/params.ts` with `MIN_BOND` = 0.1 ERG.

## Scenarios

| Id | Purpose | What it proves |
|----|---------|----------------|
| `spar` | `fishfight:spar` | ERGO.games root alone; root keeps the whole fee |
| `mint8` | `fishfight:mint` | 8 participants (worst case size/cost); withholder left out after the grace period |
| `breed-join` | `fishfight:breed` | A contributor joins before the target epoch |
| `contention` | `fishfight:spar` | Two opens race for the same factory box; one must lose |
| `refund` | `fishfight:lethal` | Withholder is root; requester refunds once it is provably out |
| `partner-root` | `partner:dice` | Another project's beacon is root, ERGO.games contributes |

## Run

```bash
npm run pilot -- keys      # prints the funder testnet address
npm run pilot -- dry-run   # whole pilot on the Fleet mock chain
npm run pilot -- status    # funder balance on testnet
npm run pilot -- testnet   # setup + scenarios on testnet (ERGO_NODE_URL, default 213.239.193.208:9052)
```

The node must have the extra index (`/blockchain/*`). Each run writes `pilot/runs/<ledger>-<time>.jsonl`
(every transaction, confirmation and decision) and a `.summary.json`.

A FishFight duel from a result box:

```bash
cd ../ergo-games-fishfight
npm run duel:ergo-vrf -- --result <resultBoxId> --a 1 --b 2
```

## Results

### Mock chain dry run (2026-10-26)

59 transactions, all 6 scenarios ended as designed. The only failed transaction is the intended
`contention` loser, caught by the ledger's own double-spend check (testnet decides this for real).
`mint8` paid 7 authors and left out `withholder`; root 2,000,002 + 6 × 1,333,333 nanoERG.

### Testnet (2026-10-26, heights 609121–609146, node `213.239.193.208:9052`)

**All 6 scenarios ended as designed in 18 minutes of wall time.**

| | |
|---|---|
| Transactions | 59 submitted, 58 confirmed, 0 dropped. The one rejection is the intended `contention` loser |
| Reveals | 35, none failed |
| Build → inclusion | 1–2 blocks (median 1); ~42 s median from submit to confirmation, 53 s max |
| Mempool chaining | Split → factory mint → 8 beacon mints were chained unconfirmed and all landed in block 609123 |
| Factory race | The node rejected the second open itself: `400 Double spending attempt` |
| Script trees | beacon 225 B · request 1,353 B · factory 508 B |
| Signed tx sizes | open (1 author) 2,357 B · open (8 authors) 3,099 B · join 1,967 B · fulfill (1) 347 B · fulfill (2) 423 B · **fulfill (8 listed, 7 included) 834 B** · refund 231 B · reveal 596 B |

The node accepted the 8-participant fulfill, so it fits the per-transaction cost limit. The node does not
report the exact cost; measuring it is still open.

| Scenario | Outcome |
|----------|---------|
| `spar` | Root alone, paid the whole 0.01 ERG pool |
| `mint8` | 7 included, `withholder` left out once the grace period ended; root 2,000,002 + 6 × 1,333,333 nanoERG |
| `breed-join` | `lithos-1` joined before the target epoch; root 0.002, contributor 0.008 ERG |
| `contention` | One open won, one was rejected by the node; the winner fulfilled normally |
| `refund` | `withholder` as root never revealed; refunded after grace |
| `partner-root` | `lithos-1` as root, ERGO.games contributing; split 0.002 / 0.008 ERG |

Deployment (testnet only): ticket token `fbfc98c32c1267c3698f9bd9bb35806c065968aecaedd67c56d631fcced43b32`,
contract hashes beacon `a1625b6a…`, request `2570c80e…`, factory `17fa42d4…`. Key transactions:
factory mint `4f576387adcdaadf5a2140eed3b14c4054158779b199c74b5ef735fd51c0d68b`,
8-author fulfill `d0569cb51436261e7befe6a6f8974eaa4ae6266ecdedb5f6b6f12f02c8f2bdc5`,
refund `ac0dcd71a42fb19b79328f0f5c57f2c6cb6bc170b8503f4930c8fb7b6d321f68`.

**FishFight:** `npm run duel:ergo-vrf -- --result 5e81f277df11e3c973b5c5279d8049f013d476a23522e18fd41fdaf1f7493791`
reads the `spar` result box from the node (request `1ae6d67d…`, random `e81d6483…`, target epoch 121827) and
resolves Tuna #1 vs Tuna #2: AGI 119–130, STR 168–101, INT 180–115 → Tuna #1 wins 2–1.

#### Found during the pilot

1. **Factory target had to be a window.** An exact `current + TARGET_DELAY` would reject a request mined one
   epoch after it was built. Fixed (1..`TARGET_DELAY` ahead).
2. **The node returns `/blocks/lastHeaders` oldest first.** Taking element 0 as the tip read heights nine blocks
   stale. Fixed in the pilot ledger. `fishfight-legacy-archive/reissue/ergo/mint-ergo-reissue.mjs` makes the same
   assumption and needs the same fix.

#### Still not covered

- Exact script cost per transaction (only "accepted under the limit").
- A chain reorg, an offline root during a live request, slashing, and fee economics over days.
- Factory throughput beyond one block: opens were chained one after another; real concurrent users would
  collide the way `contention` did.
