{
  // VrfFactory — the only way to open a valid VrfRequest.
  //
  // TOKENS
  //   tokens(0): request tickets (large supply). Each request carries exactly one; holding one is
  //              what proves the request was opened here, at a real HEIGHT.
  //
  // Opening a request (anyone, no signature):
  //   OUTPUTS(0) — this factory again, one ticket fewer
  //   OUTPUTS(1) — the request: VrfRequest script, exactly 1 ticket, and
  //                R4 Coll[Coll[Byte]] beacon ids, index 0 = root, the rest = named contributors
  //                R5 Coll[Coll[Byte]] each beacon's current 40-byte entry, same order
  //                R6 Coll[Byte]       requester proposition bytes (result + refund go here)
  //                R7 Long             target epoch = current epoch + TARGET_DELAY
  //   dataInputs(i) — the beacon box for R4(i), so every recorded entry is the real current one.
  //
  // The target is fixed from HEIGHT here, so a request can never be opened for an epoch whose
  // values are already public.

  val tok = SELF.tokens(0)
  val out = OUTPUTS(0)
  val req = OUTPUTS(1)

  val ids    = req.R4[Coll[Coll[Byte]]].get
  val recs   = req.R5[Coll[Coll[Byte]]].get
  val target = req.R7[Long].get
  val curEpoch = (HEIGHT / $EPOCH_LEN).toLong

  val factoryKept =
    out.propositionBytes == SELF.propositionBytes &&
    out.value >= SELF.value &&
    out.tokens.size == 1 &&
    out.tokens(0)._1 == tok._1 &&
    out.tokens(0)._2 == tok._2 - 1L

  val requestShape =
    blake2b256(req.propositionBytes) == $REQUEST_HASH &&
    req.tokens.size == 1 &&
    req.tokens(0)._1 == tok._1 &&
    req.tokens(0)._2 == 1L &&
    req.R6[Coll[Byte]].isDefined &&
    target == curEpoch + $TARGET_DELAY

  val listed =
    ids.size >= 1 &&
    ids.size <= $MAX_PARTICIPANTS &&
    recs.size == ids.size &&
    CONTEXT.dataInputs.size == ids.size &&
    ids.indices.forall { (i: Int) =>
      val d   = CONTEXT.dataInputs(i)
      val rec = recs(i)
      val recEpoch = byteArrayToLong(rec.slice(0, 8))
      blake2b256(d.propositionBytes) == $BEACON_HASH &&
      d.tokens.size == 1 &&
      d.tokens(0)._1 == ids(i) &&
      d.value >= $MIN_BOND &&
      rec.size == 40 &&
      d.R4[Coll[Byte]].get == rec &&
      recEpoch < target &&
      target - recEpoch <= $MAX_DIST
    }

  val unique = ids.indices.forall { (i: Int) =>
    ids.indices.forall { (j: Int) => i == j || ids(i) != ids(j) }
  }

  sigmaProp(factoryKept && requestShape && listed && unique)
}
