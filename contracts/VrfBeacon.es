{
  // VrfBeacon — one box per randomness author (root or contributor; the role is chosen per request).
  //
  // TOKENS
  //   tokens(0): beacon NFT (amount 1). Its id is the author's id in requests.
  // VALUE
  //   Bond in nanoERG. Never decreases while the beacon lives. Requests only count beacons with
  //   value >= MIN_BOND.
  // REGISTERS
  //   R4 Coll[Byte] 40 — Lithos-style commitment entry [epoch: Long 8][tip: 32].
  //                      `tip` is the latest revealed hash-chain value, or the chain anchor.
  //   R5 GroupElement   — author key. Signs every spend; fee shares are paid to proveDlog(R5).
  // CONTEXT VARS (SELF)
  //   0 Byte — action: 0 reveal, 1 rotate, 2 withdraw
  //
  // A reveal publishes the next value down the chain: blake2b256(newTip) == tip, one epoch at a
  // time, and never before that epoch has started. Nobody (other than the author) knows a beacon's
  // value for an epoch before the epoch begins.

  val entry  = SELF.R4[Coll[Byte]].get
  val pk     = SELF.R5[GroupElement].get
  val epoch  = byteArrayToLong(entry.slice(0, 8))
  val curEpoch = (HEIGHT / $EPOCH_LEN).toLong
  val action = getVar[Byte](0).get

  if (action == 2.toByte) {
    // Withdraw: only once the beacon has stopped revealing for UNBOND_EPOCHS, so it cannot pull out
    // from under requests that still need to read it.
    sigmaProp(curEpoch >= epoch + $UNBOND_EPOCHS) && proveDlog(pk)
  } else {
    val out      = OUTPUTS(0)
    val nextEntry = out.R4[Coll[Byte]].get
    val nextEpoch = byteArrayToLong(nextEntry.slice(0, 8))
    val kept =
      out.propositionBytes == SELF.propositionBytes &&
      out.value >= SELF.value &&
      out.tokens == SELF.tokens &&
      out.R5[GroupElement].get == pk &&
      nextEntry.size == 40

    val step =
      if (action == 0.toByte) {
        // Reveal the value for the next epoch.
        nextEpoch == epoch + 1L &&
        nextEpoch <= curEpoch &&
        blake2b256(nextEntry.slice(8, 40)) == entry.slice(8, 40)
      } else {
        // Rotate to a new chain. Its anchor is labelled no earlier than the current epoch, so its
        // first reveal is for a future epoch. Requests that recorded the old chain will not verify
        // against the new one, which counts the same as not revealing.
        action == 1.toByte && nextEpoch >= curEpoch && nextEpoch >= epoch
      }

    sigmaProp(kept && step) && proveDlog(pk)
  }
}
