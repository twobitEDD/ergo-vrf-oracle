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

### Testnet

Not run yet: waiting for the pilot wallet to be funded.
