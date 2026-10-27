{
  // VrfRequest — one randomness request, opened by VrfFactory.
  //
  // TOKENS
  //   tokens(0): one request ticket (REQUEST_TOKEN_ID). Burned on fulfill or refund.
  // VALUE
  //   RESERVE (result box + miner fee) plus the fee pool paid to the authors.
  // REGISTERS
  //   R4 Coll[Coll[Byte]] beacon ids — index 0 is the root this requester chose, the rest contribute
  //   R5 Coll[Coll[Byte]] each beacon's 40-byte entry when it was listed
  //   R6 Coll[Byte]       requester proposition bytes
  //   R7 Long             target epoch
  // CONTEXT VARS (SELF)
  //   0 Byte — action: 0 join, 1 fulfill, 2 refund
  //
  // random = blake2b256(requestBoxId ++ value of every author who revealed, in R4 order)
  // It is fair as long as one included author kept their chain secret until the target epoch.
  //
  // Fee pool: the root takes all of it when nobody else revealed. Otherwise the root takes
  // ROOT_SHARE_BPS and the contributors who revealed split the rest evenly.

  val ids       = SELF.R4[Coll[Coll[Byte]]].get
  val recs      = SELF.R5[Coll[Coll[Byte]]].get
  val requester = SELF.R6[Coll[Byte]].get
  val target    = SELF.R7[Long].get
  val n         = ids.size
  val h         = HEIGHT.toLong
  val epochLen  = $EPOCH_LEN.toLong
  val targetStart = target * epochLen
  val graceOver   = h >= targetStart + epochLen + $GRACE_BLOCKS
  val action    = getVar[Byte](0).get

  val ticket =
    SELF.tokens.size == 1 &&
    SELF.tokens(0)._1 == $REQUEST_TOKEN_ID &&
    SELF.tokens(0)._2 == 1L

  val ticketBurned = OUTPUTS.forall { (o: Box) =>
    o.tokens.forall { (t: (Coll[Byte], Long)) => t._1 != $REQUEST_TOKEN_ID }
  }

  // blake2b256 applied k times (k <= MAX_STEPS; k <= 0 leaves v unchanged).
  val hashN = { (p: (Coll[Byte], Long)) =>
    $STEPS.fold(p._1, { (acc: Coll[Byte], s: Int) => if (s.toLong <= p._2) blake2b256(acc) else acc })
  }

  val isBeacon = { (p: (Box, Coll[Byte])) =>
    blake2b256(p._1.propositionBytes) == $BEACON_HASH &&
    p._1.tokens.size == 1 &&
    p._1.tokens(0)._1 == p._2 &&
    p._1.value >= $MIN_BOND
  }

  // On fulfill and refund, dataInputs(i) is the beacon box for ids(i).
  // values(i) — that beacon's value for the target epoch, read back from its current entry.
  // status(i) — 1 revealed, and chains back to the entry recorded when it was listed
  //             0 provably left out: past the grace period without revealing, or revealed off its
  //               recorded chain (rotated away)
  //            -1 cannot be decided yet, or not the right beacon box; fulfill is not allowed
  val m = if (CONTEXT.dataInputs.size < n) CONTEXT.dataInputs.size else n
  val values: Coll[Coll[Byte]] = ids.indices.slice(0, m).map { (i: Int) =>
    val entry = CONTEXT.dataInputs(i).R4[Coll[Byte]].get
    hashN((entry.slice(8, 40), byteArrayToLong(entry.slice(0, 8)) - target))
  }
  val status: Coll[Int] = ids.indices.slice(0, m).map { (i: Int) =>
    val d   = CONTEXT.dataInputs(i)
    val e   = byteArrayToLong(d.R4[Coll[Byte]].get.slice(0, 8))
    val rec = recs(i)
    if (isBeacon((d, ids(i))) == false) -1
    else if (e >= target && e - target <= $MAX_LOOKBACK) {
      if (hashN((values(i), target - byteArrayToLong(rec.slice(0, 8)))) == rec.slice(8, 40)) 1 else 0
    } else if (e < target && graceOver) 0
    else -1
  }

  if (action == 0.toByte) {
    // Join as a contributor before the target epoch starts. dataInputs(0) is the joining beacon.
    val d     = CONTEXT.dataInputs(0)
    val id    = d.tokens(0)._1
    val entry = d.R4[Coll[Byte]].get
    val pk    = d.R5[GroupElement].get
    val out   = OUTPUTS(0)
    val ok =
      ticket &&
      h < targetStart &&
      n < $MAX_PARTICIPANTS &&
      isBeacon((d, id)) &&
      byteArrayToLong(entry.slice(0, 8)) < target &&
      target - byteArrayToLong(entry.slice(0, 8)) <= $MAX_DIST &&
      ids.forall { (x: Coll[Byte]) => x != id } &&
      out.propositionBytes == SELF.propositionBytes &&
      out.value >= SELF.value &&
      out.tokens == SELF.tokens &&
      out.R4[Coll[Coll[Byte]]].get == ids.append(Coll(id)) &&
      out.R5[Coll[Coll[Byte]]].get == recs.append(Coll(entry)) &&
      out.R6[Coll[Byte]].get == requester &&
      out.R7[Long].get == target
    sigmaProp(ok) && proveDlog(pk)
  } else if (action == 1.toByte) {
    // Fulfill. dataInputs(i) is the beacon box for ids(i), for every i.
    val decided = m == n && status.forall { (s: Int) => s >= 0 } && status(0) == 1

    val seed = ids.indices.fold(SELF.id, { (acc: Coll[Byte], i: Int) =>
      if (status(i) == 1) acc ++ values(i) else acc
    })
    val random = blake2b256(seed)

    val others  = status.slice(1, n).filter { (s: Int) => s == 1 }.size.toLong
    val pool    = SELF.value - $RESERVE
    val share   = if (others == 0L) 0L else (pool - pool * $ROOT_SHARE_BPS / 10000L) / others
    val rootPay = pool - share * others

    val payTo = { (i: Int) => proveDlog(CONTEXT.dataInputs(i).R5[GroupElement].get).propBytes }

    // OUTPUTS(0): result box, holding a token whose id is this request's box id (minted here, so
    // SELF must be INPUTS(0)). Consumers read it as a data input and match the token to their request.
    val result = OUTPUTS(0)
    val resultOk =
      result.propositionBytes == requester &&
      result.value >= $RESULT_BOX_VALUE &&
      result.tokens.size == 1 &&
      result.tokens(0)._1 == SELF.id &&
      result.tokens(0)._2 == 1L &&
      result.R4[Coll[Byte]].get == random &&
      result.R5[Long].get == target

    // OUTPUTS(1): root. OUTPUTS(1 + k): k-th contributor that revealed, in R4 order.
    val rootPaid = OUTPUTS(1).propositionBytes == payTo(0) && OUTPUTS(1).value >= rootPay
    val othersPaid = ids.indices.forall { (i: Int) =>
      if (i == 0 || status(i) != 1) true
      else {
        val k = 1 + status.slice(1, i).filter { (s: Int) => s == 1 }.size
        OUTPUTS(1 + k).propositionBytes == payTo(i) && OUTPUTS(1 + k).value >= share
      }
    }

    sigmaProp(ticket && decided && resultOk && rootPaid && othersPaid && ticketBurned)
  } else {
    // Refund: the root provably did not reveal (dataInputs(0) is its beacon), or the hard timeout passed.
    val rootLeftOut = if (m > 0) status(0) == 0 else false
    val timedOut    = h >= targetStart + epochLen + $HARD_TIMEOUT_BLOCKS
    val back =
      OUTPUTS(0).propositionBytes == requester &&
      OUTPUTS(0).value >= SELF.value - $MINER_FEE
    sigmaProp(action == 2.toByte && ticket && (rootLeftOut || timedOut) && back && ticketBurned)
  }
}
