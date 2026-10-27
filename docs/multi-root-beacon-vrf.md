# Multi-root beacon VRF on Ergo (v0)

Status: contracts compile and pass mock-chain tests (`test/beaconContracts.test.ts`). **Not deployed** to
testnet or mainnet. No audit.

## The idea

Anyone can run a **randomness beacon**: a bonded box on Ergo that reveals one value per epoch from a
hash chain it committed to in advance. Every beacon is the same contract; the role is chosen per request.

- A request names a **root**, its own choice. ERGO.games uses the ERGO.games beacon as root. Another
  project can make its own beacon the root and list the ERGO.games beacon as a contributor.
- Any other beacon can be a **contributor**: named when the request is opened, or joining before the
  target epoch starts.
- `random = blake2b256(requestBoxId ++ every included beacon's value for the target epoch)`, in request order.
- The fee pool is paid on fulfill. **If no contributor revealed, the root keeps all of it.** Otherwise the
  root takes `ROOT_SHARE_BPS` (default 20%) and the contributors who revealed split the rest evenly.

The result is fair as long as **one** included beacon kept its chain secret until the target epoch,
because nobody can know that value before the epoch starts.

## Commitment format (Lithos-compatible)

Every beacon box holds one 40-byte entry in R4, the same layout as a Lithos NISP commitment entry
(`NispCommitment.scala`: `[score: 8][blake2b256: 32]`):

```
[epoch: Long, 8 bytes big-endian][tip: 32 bytes]
```

`tip` is the latest revealed chain value (or the anchor). A Lithos operator who already runs the Lithos
client only needs a sidecar that keeps a secret chain, reveals once per epoch, and joins requests. No
Lithos contract changes.

## Boxes

| Contract | Holds | Registers |
|----------|-------|-----------|
| `contracts/VrfBeacon.es` | beacon NFT (id = author id), bond ≥ `MIN_BOND` | R4 entry · R5 `GroupElement` author key |
| `contracts/VrfFactory.es` | request ticket supply | — |
| `contracts/VrfRequest.es` | 1 ticket, `RESERVE` + fee pool | R4 beacon ids (root first) · R5 entries recorded at listing · R6 requester propBytes · R7 target epoch |
| result box (requester's address) | 1 token whose id = request box id | R4 random · R5 target epoch |

Actions are passed as context var 0 (`Byte`) on the spent box.

## Flows

1. **Reveal** (`VrfBeacon` action 0, author signs) — new entry `[epoch+1][v]` with `blake2b256(v) == tip`,
   only once epoch `epoch+1` has started. One step per epoch; missed epochs are caught up in order.
2. **Rotate** (action 1) — new anchor labelled no earlier than the current epoch. Requests that recorded
   the old chain will not verify against it, which counts as not revealing.
3. **Withdraw** (action 2) — after `UNBOND_EPOCHS` without a reveal.
4. **Open request** (`VrfFactory`, no signature) — target is 1..`TARGET_DELAY` epochs after the current one,
   checked against the real `HEIGHT` (a window, so a request mined one epoch late still opens). Each listed beacon is a data input, so each recorded entry is that beacon's real
   current one. The request takes one ticket; only factory-opened requests carry one.
5. **Join** (`VrfRequest` action 0, joining author signs) — before the target epoch starts; appends the
   beacon id and its current entry.
6. **Fulfill** (action 1, anyone) — `dataInputs(i)` is the beacon box for `ids(i)`. Each listed beacon is:
   - **in**: it has revealed the target (up to `MAX_LOOKBACK` epochs past it) and that value hashes back
     to its recorded entry;
   - **out**: it has not revealed and the grace period after the target epoch is over, or it revealed off
     its recorded chain;
   - otherwise fulfill must wait.
   The root must be in. Outputs: result box, root pay, then each included contributor's pay. The ticket is burned.
7. **Refund** (action 2) — the root is provably out, or `HARD_TIMEOUT_BLOCKS` passed.

Consumers (a fish mint, a lethal fight) read the result box as a data input and match its token id to the
request box they opened.

## What it protects against, and what it does not

| Threat | v0 |
|--------|----|
| Opening a request after the target values are public | Factory sets the target from `HEIGHT`; tickets prove factory origin |
| An author revealing early | Beacon refuses a reveal before its epoch starts |
| Swapping chains to fit a request | Values must hash back to the entry recorded at listing |
| Fulfiller dropping a contributor that revealed | Every listed beacon must be proven in or out |
| One author biasing the result alone | Needs every included author to collude |
| An author withholding a reveal after seeing the others | **Not prevented.** It only loses its fee share. One bit of bias per withholding author. Slashing is v1 |
| Requester stalling until refund | Root is paid on fulfill, so it fulfills. Refund needs the root provably out, or the hard timeout |
| A beacon NFT minted with supply > 1 | Only lets that author choose to drop out (same as withholding) |

## Parameters (`src/beacon/params.ts`)

`EPOCH_LEN` 5 blocks (~10 min) · `TARGET_DELAY` 2 epochs · `MAX_PARTICIPANTS` 8 · `MAX_LOOKBACK` 4 ·
`MAX_DIST` 6 · `GRACE_BLOCKS` 5 · `HARD_TIMEOUT_BLOCKS` 720 · `UNBOND_EPOCHS` 30 · `MIN_BOND` 1 ERG ·
`ROOT_SHARE_BPS` 2000 · result box 0.001 ERG · miner fee 0.0011 ERG. All are placeholders until testnet.

A request resolves about 2–3 epochs (~20–30 min) after it is opened. Use it for mints, breeding and lethal
fights, not per-move game rolls.

## Use from TypeScript

```ts
import { compileBeaconSuite, HashChain, mixRandom, splitFee } from "ergo-vrf-oracle";

const suite = compileBeaconSuite(requestTicketTokenId); // beacon → request → factory, hashes pinned
const chain = new HashChain(secretHex, 10_000);           // anchor = chain.anchorHex
```

## Not done yet

1. **Testnet deploy** — mint the ticket supply, compile with its token id, create the factory box, register
   the ERGO.games beacon (needs a funded testnet wallet).
2. **Beacon sidecar** — reveal every epoch, auto-join open requests, fulfill requests it is root of.
   Package it for Lithos operators (`twobitEDD/Lithos-Launcher`).
3. **Slashing** for listed beacons that never reveal (v1).
4. **`ergo-rng` chain mode** — read result boxes and expose them through `/v1/rng/verify`.
5. **Consumer contracts** — fish mint / breed / lethal fight reading the result box.
6. Fee and bond economics, cost limits with 8 participants on a real node, and an audit before mainnet.
