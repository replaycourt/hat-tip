// Pure functions of the page, no DOM and no network, so they run in Node for the tests:
// - the round close in the contract's integer arithmetic (a port of the model in sim/hat_tip_sim.py,
//   replayed against every sim/golden/*.json by test/golden.test.mjs),
// - the live preview while a visitor drags their thanks, and why counted thanks differ from given,
// - tiers and limits, the DAO policy checks, DAO proposals, allocation edits, signing text,
// - formatting and the clock.
// Thanks are whole numbers; weights, points and reputation are milli-thanks (1 thanks = 1,000);
// tUSD amounts are base units (6 decimals). Every division rounds down, as in the contract.

export const BP = 10_000n
export const MILLI = 1_000n
const SQRT_SCALE = 1_000_000n
export const TUSD_DECIMALS = 6
export const TUSD = 10n ** BigInt(TUSD_DECIMALS)

export const big = (v) => (typeof v === 'bigint' ? v : BigInt(v ?? 0))
const minB = (a, b) => (a < b ? a : b)
const maxB = (a, b) => (a > b ? a : b)
/** Account ids compared as bytes (they are lowercase ASCII, so code units are bytes). */
export const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
const sumB = (xs) => xs.reduce((a, b) => a + b, 0n)

// ---- accounts ----------------------------------------------------------------------------------

/** A NEAR implicit account: 64 lowercase hex characters (a guest's browser key). */
export const isImplicit = (a) => typeof a === 'string' && /^[0-9a-f]{64}$/.test(a)
export const isEthImplicit = (a) => typeof a === 'string' && /^0x[0-9a-f]{40}$/.test(a)

/** The member set the contract uses: the named accounts of the members role. */
export const namedMembers = (list) => new Set((list ?? []).filter((a) => !isImplicit(a) && !isEthImplicit(a)))

/** Integer square root (floor) of a non-negative BigInt. */
export function isqrt(n) {
  n = big(n)
  if (n < 0n) throw new Error('isqrt of a negative number')
  if (n < 2n) return n
  let x = n
  let y = (x + 1n) / 2n
  while (y < x) {
    x = y
    y = (x + n / x) / 2n
  }
  return x
}

/** The numeric fields of a Config as BigInt (the JSON has u16 numbers and U128 strings). */
export function numCfg(cfg) {
  const n = (k) => big(cfg[k] ?? 0)
  return {
    thanksPerRound: n('thanks_per_round'),
    capPerReceiver: n('cap_per_receiver'),
    maxReceivers: n('max_receivers'),
    reciprocalBp: n('reciprocal_bp'),
    quadratic: Boolean(cfg.quadratic),
    breadthK: n('breadth_k'),
    breadthBp: n('breadth_bp'),
    idleBp: n('idle_bp'),
    decayBp: n('decay_bp'),
    roundBudget: n('round_budget'),
    minPayout: n('min_payout'),
    carryRounds: n('carry_rounds'),
    reserve: n('reserve'),
    autoRepMin: n('auto_rep_min'),
    autoPerThanks: n('auto_per_thanks'),
    autoMax: n('auto_max'),
    cosignBase: n('cosign_base'),
    cosignPerThanks: n('cosign_per_thanks'),
    cosignMax: n('cosign_max'),
    autoShareBp: n('auto_share_bp'),
    guestWeightBp: n('guest_weight_bp'),
    guestCapBp: n('guest_cap_bp'),
    // optional in the contract's Config, default 10,000 (off)
    guestReceiveCapBp: big(cfg.guest_receive_cap_bp ?? 10_000),
  }
}

// ---- counting (DESIGN.md "One round", step 5) -------------------------------------------------

/**
 * Normalises allocations to a Map giver -> [[receiver, thanks]], keeping only givers with gifts.
 * Accepts a Map, a plain object, or a list of {giver, gifts} in call order (the last one counts).
 */
export function allocationMap(allocations) {
  const out = new Map()
  const put = (g, gifts) => {
    const list = (gifts ?? []).map(([r, t]) => [r, Number(t)]).filter(([, t]) => t > 0)
    if (list.length) out.set(g, list)
    else out.delete(g)
  }
  if (allocations instanceof Map) for (const [g, gifts] of allocations) put(g, gifts)
  else if (Array.isArray(allocations)) for (const a of allocations) put(a.giver, a.gifts)
  else for (const [g, gifts] of Object.entries(allocations ?? {})) put(g, gifts)
  return out
}

/**
 * The counting of one round. `members` is the set of named member accounts at the close, `seats`
 * the guests seated in the round, `allocations` each giver's last allocation.
 * Returns every entry's intermediate values (in (giver, receiver) order) and the points.
 */
export function countRound(cfg, members, seats, allocations) {
  const c = numCfg(cfg)
  members = members instanceof Set ? members : new Set(members)
  seats = seats instanceof Set ? seats : new Set(seats)
  const alloc = allocationMap(allocations)
  const dropped = []
  const rows = []
  for (const giver of [...alloc.keys()].sort(cmp)) {
    const gifts = [...alloc.get(giver)].sort((x, y) => cmp(x[0], y[0]) || x[1] - y[1])
    for (const [receiver, t] of gifts) {
      const gOk = members.has(giver) || seats.has(giver)
      const rOk = members.has(receiver) || seats.has(receiver)
      if (!(gOk && rOk)) dropped.push([giver, receiver, t, 'not a member or seated guest'])
      else if (seats.has(giver) && seats.has(receiver)) dropped.push([giver, receiver, t, 'guest to guest'])
      else rows.push({ giver, receiver, thanks: t })
    }
  }
  // 2. weight, and the guests' cap
  let membersWeight = 0n
  let guestsWeight = 0n
  for (const row of rows) {
    if (members.has(row.giver)) {
      row.weight = BigInt(row.thanks) * MILLI
      membersWeight += row.weight
    } else {
      row.weight = (BigInt(row.thanks) * c.guestWeightBp) / 10n
      guestsWeight += row.weight
    }
  }
  const cap = c.guestCapBp
  const guestScaled = guestsWeight * (BP - cap) > membersWeight * cap
  if (guestScaled) {
    const num = membersWeight * cap
    const den = guestsWeight * (BP - cap)
    for (const row of rows) if (!members.has(row.giver)) row.weight = (row.weight * num) / den
  }
  // 3. reciprocity: both directions lose the same amount, taken from the step-2 weights
  const index = new Map(rows.map((row, k) => [row.giver + '\n' + row.receiver, k]))
  for (const row of rows) row.reciprocal = row.weight
  if (c.reciprocalBp < BP) {
    rows.forEach((row, k) => {
      const j = index.get(row.receiver + '\n' + row.giver)
      if (j !== undefined && row.giver < row.receiver) {
        const d = (minB(row.weight, rows[j].weight) * (BP - c.reciprocalBp)) / BP
        rows[k].reciprocal -= d
        rows[j].reciprocal -= d
      }
    })
  }
  // 4. aggregation
  const W = sumB(rows.map((r) => r.reciprocal))
  let Q = 0n
  if (c.quadratic) {
    const S = new Map()
    for (const row of rows) {
      row.v = isqrt(row.reciprocal * SQRT_SCALE)
      S.set(row.receiver, (S.get(row.receiver) ?? 0n) + row.v)
    }
    Q = sumB([...S.values()].map((s) => s * s))
    for (const row of rows) row.aggregated = Q ? (W * row.v * S.get(row.receiver)) / Q : 0n
  } else {
    for (const row of rows) row.aggregated = row.reciprocal
  }
  // 5. breadth: givers with a counted share after aggregation
  const support = new Map()
  for (const row of rows) if (row.aggregated > 0n) support.set(row.receiver, (support.get(row.receiver) ?? 0) + 1)
  for (const row of rows) row.counted = row.aggregated
  const narrow = new Set()
  if (c.breadthK > 0n && c.breadthBp < BP) {
    for (const row of rows) {
      if (BigInt(support.get(row.receiver) ?? 0) < c.breadthK) {
        row.counted = (row.counted * c.breadthBp) / BP
        narrow.add(row.receiver)
      }
    }
  }
  // 6. idle: a member who gave nothing this round
  const givers = new Set(alloc.keys())
  const idle = new Set()
  if (c.idleBp < BP) {
    for (const row of rows) {
      if (members.has(row.receiver) && !givers.has(row.receiver)) {
        row.counted = (row.counted * c.idleBp) / BP
        idle.add(row.receiver)
      }
    }
  }
  // 7. the guests' receive cap: guests together receive at most guest_receive_cap_bp of the
  // round's points, by the same rule as the cap on what they give (contract/README.md)
  const toGuest = (row) => !members.has(row.receiver) && seats.has(row.receiver)
  const rcap = c.guestReceiveCapBp
  let receiveScaled = false
  if (rcap < BP) {
    let pg = 0n
    let pm = 0n
    for (const row of rows) {
      if (toGuest(row)) pg += row.counted
      else pm += row.counted
    }
    if (pg * (BP - rcap) > pm * rcap) {
      receiveScaled = true
      const num = pm * rcap
      const den = pg * (BP - rcap)
      for (const row of rows) if (toGuest(row)) row.counted = (row.counted * num) / den
    }
  }
  // 8. points
  const points = new Map()
  for (const row of rows) points.set(row.receiver, (points.get(row.receiver) ?? 0n) + row.counted)
  return { rows, dropped, membersWeight, guestsWeight, guestScaled, receiveScaled, W, Q, support, narrow, idle, givers, points, members, seats }
}

// ---- tiers and shares (steps 7-9) --------------------------------------------------------------

/** The auto and co-sign limits for a reputation `r0` (milli-thanks) before the round. */
export function limitsFor(cfg, account, r0) {
  const c = numCfg(cfg)
  r0 = big(r0)
  const units = r0 / MILLI
  const auto = isImplicit(account) || r0 < c.autoRepMin * MILLI ? 0n : minB(c.autoMax, units * c.autoPerThanks)
  const cosign = minB(c.cosignMax, c.cosignBase + units * c.cosignPerThanks)
  return { auto, cosign }
}

export const tierOf = (q, { auto, cosign }) => (q <= big(auto) ? 1 : q <= big(cosign) ? 2 : 3)

/**
 * What a round's budget is (contract/src/close.rs, step 7): the configured budget, or less if the
 * DAO holds less beyond the reserve and beyond what earlier rounds still owe (`owed`: payouts
 * without a final status, and carries). 0 when no points were counted.
 */
export function budgetOf(cfg, daoBalance, totalPoints = 1n, owed = 0n) {
  const c = numCfg(cfg)
  if (big(totalPoints) === 0n) return 0n
  return minB(c.roundBudget, maxB(0n, big(daoBalance) - c.reserve - big(owed)))
}

/**
 * What earlier rounds still owe, from state().totals as the contract keeps them: the payouts
 * without a final status (planned less paid, rejected, expired, removed and failed; the
 * contract's Totals::open) plus the carries.
 */
export function owedOf(totals) {
  if (!totals) return 0n
  const done = ['paid', 'rejected', 'expired', 'removed', 'failed'].reduce((a, k) => a + big(totals[k] ?? 0), 0n)
  return big(totals.planned) - done + big(totals.carry)
}

/**
 * Shares, carry and tiers for the points of one round (steps 8-9, with the tier-1 round cap).
 * `carryOf(acc)` gives [amount, since] or undefined; `limitsOf(acc)` gives {auto, cosign}.
 * Returns the planned payouts in receiver order, the new carries, the dust and who the cap moved.
 */
export function planPayouts(cfg, points, budget, round, carryOf, limitsOf) {
  const c = numCfg(cfg)
  const accs = [...points.keys()].filter((a) => points.get(a) > 0n).sort(cmp)
  const total = sumB(accs.map((a) => points.get(a)))
  const shares = new Map()
  const carries = new Map() // acc -> [amount, since] after this round (only accounts with points)
  const planned = []
  for (const acc of accs) {
    const share = total ? (budget * points.get(acc)) / total : 0n
    shares.set(acc, share)
    const old = carryOf(acc)
    const q = share + (old ? big(old[0]) : 0n)
    if (q === 0n || q < c.minPayout) {
      if (q > 0n) carries.set(acc, [q, old ? old[1] : round])
    } else {
      carries.set(acc, null)
      const lim = limitsOf(acc)
      planned.push({ round, receiver: acc, amount: q, tier: tierOf(q, lim), autoLimit: big(lim.auto), cosignLimit: big(lim.cosign), points: points.get(acc) })
    }
  }
  const dust = budget - sumB([...shares.values()])
  const moved = []
  const t1 = planned.filter((x) => x.tier === 1)
  let t1Sum = sumB(t1.map((x) => x.amount))
  if (t1Sum * BP > budget * c.autoShareBp) {
    for (const x of [...t1].sort((a, b) => (a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : cmp(a.receiver, b.receiver)))) {
      if (t1Sum * BP <= budget * c.autoShareBp) break
      x.tier = 2
      x.moved = true
      t1Sum -= x.amount
      moved.push(x.receiver)
    }
  }
  return { shares, carries, planned, dust, moved, total }
}

/** One round of decay. A guest's reputation below one thanks becomes 0. */
export function decay(x, cfg, guest = false) {
  const y = (big(x) * (BP - numCfg(cfg).decayBp)) / BP
  return guest && y < MILLI ? 0n : y
}

const FINAL = new Set(['paid', 'rejected', 'removed', 'expired', 'failed'])
export const isFinal = (status) => FINAL.has(String(status).toLowerCase())

/**
 * The contract's state across rounds: reputation, carry, payouts. `close` is the close of a round
 * (with or without allocations), `closeEmpty` the close of a round nobody gave in, `resolve` a DAO
 * outcome read by check_payout. Same steps, same order, same rounding as the contract.
 */
export class Hat {
  constructor(cfg) {
    this.cfg = cfg
    this.rep = new Map() // account -> reputation (milli-thanks)
    this.hist = new Map() // account -> Map(round -> points)
    this.carry = new Map() // account -> [amount, since]
    this.payouts = [] // {id, round, receiver, amount, tier, status, ...}
    this.byKey = new Map() // `${round}|${receiver}` -> payout
    this.open = new Map()
    this.strikes = [] // {account, round, at, amount, status}
    this.closed = 0
    this.totals = { budget: 0n, planned: 0n, lapsed: 0n, dust: 0n, struck: 0n }
  }

  limits(acc, r0) {
    return limitsFor(this.cfg, acc, r0)
  }

  decayAll() {
    for (const [acc, v] of this.rep) this.rep.set(acc, decay(v, this.cfg, isImplicit(acc)))
  }

  lapse(r) {
    const lapsed = []
    const keep = numCfg(this.cfg).carryRounds
    for (const acc of [...this.carry.keys()].sort(cmp)) {
      const [amount, since] = this.carry.get(acc)
      if (BigInt(r - since) >= keep) {
        lapsed.push([acc, amount, since])
        this.carry.delete(acc)
      }
    }
    this.totals.lapsed += sumB(lapsed.map((x) => x[1]))
    return lapsed
  }

  closeEmpty(r) {
    if (r !== this.closed + 1) throw new Error(`round ${r} closed out of order`)
    this.decayAll()
    const lapsed = this.lapse(r)
    this.closed = r
    return { round: r, empty: true, lapsed }
  }

  close(r, policyMembers, seats, allocations, daoBalance) {
    if (r !== this.closed + 1) throw new Error(`round ${r} closed out of order`)
    const members = namedMembers(policyMembers)
    const alloc = allocationMap(allocations)
    if (!alloc.size) return this.closeEmpty(r)
    const cnt = countRound(this.cfg, members, new Set(seats), alloc)
    const p = new Map([...cnt.points].filter(([, x]) => x > 0n))
    // reputation before this round (tiers use it), then decay and points
    const r0 = new Map([...p.keys()].map((a) => [a, this.rep.get(a) ?? 0n]))
    this.decayAll()
    for (const [acc, x] of p) {
      const v = (this.rep.get(acc) ?? 0n) + x
      this.rep.set(acc, isImplicit(acc) && v < MILLI ? 0n : v)
      if (!this.hist.has(acc)) this.hist.set(acc, new Map())
      this.hist.get(acc).set(r, x)
    }
    const total = sumB([...p.values()])
    // what earlier rounds still owe: payouts without an outcome, and the carries before this round
    const owed = sumB(this.payouts.filter((x) => !isFinal(x.status)).map((x) => x.amount)) + this.carryTotal()
    const budget = budgetOf(this.cfg, daoBalance, total, owed)
    const plan = planPayouts(this.cfg, p, budget, r, (a) => this.carry.get(a), (a) => this.limits(a, r0.get(a)))
    for (const [acc, cv] of plan.carries) {
      if (cv) this.carry.set(acc, cv)
      else this.carry.delete(acc)
    }
    const lapsed = this.lapse(r)
    for (const x of plan.planned) {
      x.status = 'planned'
      x.r0 = r0.get(x.receiver)
      x.id = this.payouts.length
      this.payouts.push(x)
      this.byKey.set(`${r}|${x.receiver}`, x)
      this.open.set(x.receiver, (this.open.get(x.receiver) ?? 0) + 1)
    }
    this.closed = r
    this.totals.budget += budget
    this.totals.planned += sumB(plan.planned.map((x) => x.amount))
    this.totals.dust += plan.dust
    return { round: r, empty: false, count: cnt, points: p, r0, budget, shares: plan.shares, dust: plan.dust, payouts: plan.planned, moved: plan.moved, lapsed }
  }

  /** A DAO outcome for the payout of `receiver` in round `rnd`. Rejected or removed is a strike. */
  resolve(rnd, receiver, status) {
    const x = this.byKey.get(`${rnd}|${receiver}`)
    if (!x) throw new Error(`no payout for ${receiver} in round ${rnd}`)
    if (isFinal(x.status)) throw new Error(`payout ${x.id} is already ${x.status}`)
    x.status = status
    this.open.set(receiver, (this.open.get(receiver) ?? 1) - 1)
    let strike = 0n
    if (status === 'rejected' || status === 'removed') {
      let pts = this.hist.get(receiver)?.get(rnd) ?? 0n
      for (let i = 0; i < this.closed - rnd; i++) pts = decay(pts, this.cfg) // the points, not a guest record
      const have = this.rep.get(receiver) ?? 0n
      strike = minB(have, pts)
      this.rep.set(receiver, have - strike)
      this.totals.struck += strike
      this.strikes.push({ account: receiver, round: rnd, at: this.closed, amount: strike, status })
    }
    return strike
  }

  carryTotal() {
    return sumB([...this.carry.values()].map((v) => v[0]))
  }

  audit() {
    const t = this.totals
    return t.budget === t.planned + this.carryTotal() + t.lapsed + t.dust
  }
}

// ---- the live preview --------------------------------------------------------------------------

/**
 * What the round would pay if it closed now with these allocations: the same counting, shares
 * and tiers as the close, with each account's limits as the contract states them now
 * (`member().limits`, from the reputation before this round) and its carry.
 * `limits` and `carry` are Maps account -> {auto, cosign} and account -> [amount, since];
 * `owed` is what earlier rounds still owe (owedOf(state().totals)).
 */
export function previewRound(cfg, { round, members, seats, allocations, limits = new Map(), carry = new Map(), daoBalance, owed = 0n }) {
  const memberSet = namedMembers(members)
  const cnt = countRound(cfg, memberSet, new Set(seats ?? []), allocations)
  const p = new Map([...cnt.points].filter(([, x]) => x > 0n))
  const total = sumB([...p.values()])
  const budget = budgetOf(cfg, daoBalance, total, owed)
  const plan = planPayouts(cfg, p, budget, round, (a) => carry.get(a), (a) => limits.get(a) ?? limitsFor(cfg, a, 0n))
  const byAccount = new Map()
  const given = new Map()
  for (const row of cnt.rows) given.set(row.receiver, (given.get(row.receiver) ?? 0) + row.thanks)
  for (const [acc, g] of given) byAccount.set(acc, { given: g, points: cnt.points.get(acc) ?? 0n, share: plan.shares.get(acc) ?? 0n, amount: 0n, tier: 0, carried: 0n })
  for (const x of plan.planned) Object.assign(byAccount.get(x.receiver), { amount: x.amount, tier: x.tier, moved: Boolean(x.moved) })
  for (const [acc, cv] of plan.carries) if (cv) byAccount.get(acc).carried = big(cv[0])
  return { count: cnt, budget, total, byAccount, ...plan }
}

/**
 * Why the thanks an account received count differently from what was given: structured reasons
 * (the page phrases them with reasonText).
 */
export function explainReceiver(cfg, cnt, account) {
  const c = numCfg(cfg)
  const rows = cnt.rows.filter((r) => r.receiver === account)
  const reasons = []
  const given = rows.reduce((a, r) => a + r.thanks, 0)
  const counted = sumB(rows.map((r) => r.counted))
  if (c.reciprocalBp < BP) {
    for (const r of rows) {
      const back = cnt.rows.find((x) => x.giver === account && x.receiver === r.giver)
      if (back) reasons.push({ kind: 'mutual', other: r.giver, given: r.thanks, back: back.thanks, counted: r.reciprocal, backCounted: back.reciprocal, bp: Number(c.reciprocalBp) })
    }
  }
  const guestRows = rows.filter((r) => !cnt.members.has(r.giver))
  if (guestRows.length) reasons.push({ kind: 'guest', givers: guestRows.length, who: guestRows.map((r) => r.giver), bp: Number(c.guestWeightBp), capped: cnt.guestScaled, capBp: Number(c.guestCapBp) })
  if (c.quadratic && rows.length) reasons.push({ kind: 'quadratic', givers: rows.length })
  if (cnt.narrow.has(account)) reasons.push({ kind: 'breadth', k: Number(c.breadthK), support: cnt.support.get(account) ?? 0, bp: Number(c.breadthBp) })
  if (cnt.idle.has(account)) reasons.push({ kind: 'idle', bp: Number(c.idleBp) })
  if (cnt.receiveScaled && !cnt.members.has(account) && cnt.seats.has(account)) reasons.push({ kind: 'receiveCap', bp: Number(c.guestReceiveCapBp) })
  return { given, counted, givers: rows.map((r) => ({ giver: r.giver, given: r.thanks, counted: r.counted })), reasons }
}

/** One reason as a short sentence. `name(acc)` gives a display name; `open` while the round runs. */
export function reasonText(r, name = (a) => a, { open = false } = {}) {
  switch (r.kind) {
    case 'mutual':
      return r.given === r.back
        ? `Thanked each other ${r.given} with ${name(r.other)}: counted ${fmtThanks(r.counted)} each way.`
        : `${name(r.other)} gave ${r.given} and got ${r.back} back: mutual thanks count ${fmtPct(r.bp)}, ${fmtThanks(r.counted)} counted.`
    case 'guest': {
      const who = r.givers === 1 ? (r.who ? name(r.who[0]) : 'A guest') : `${r.givers} guests`
      const verb = who === 'You' ? 'gave as a guest' : r.givers === 1 ? (r.who ? 'gave as a guest' : 'gave thanks here') : 'gave thanks here'
      return `${who} ${verb}: guest thanks count ${fmtPct(r.bp)}${r.capped ? `, and all guests together at most ${fmtPct(r.capBp)} of the round` : ''}.`
    }
    case 'quadratic':
      return 'Support is counted by breadth: many small givers count more than one big one.'
    case 'breadth':
      return `Fewer than ${r.k} givers: counted at ${fmtPct(r.bp)}.`
    case 'receiveCap':
      return `Guests together receive at most ${fmtPct(r.bp)} of a round’s thanks: scaled down to that.`
    case 'idle':
      return open ? `Has not given thanks yet: thanks received count ${fmtPct(r.bp)} until they do.` : `Gave no thanks this round: thanks received count ${fmtPct(r.bp)}.`
    default:
      return ''
  }
}

// ---- giving: the visitor's draft ---------------------------------------------------------------

export const draftTotal = (draft) => [...draft.values()].reduce((a, b) => a + b, 0)

/** Sets one receiver's thanks in a draft, clamped by the rules. Returns {draft, refused}. */
export function setGift(cfg, draft, account, value) {
  const c = numCfg(cfg)
  const out = new Map(draft)
  const others = draftTotal(out) - (out.get(account) ?? 0)
  let v = Math.max(0, Math.floor(Number(value) || 0))
  let refused = null
  if (v > Number(c.capPerReceiver)) {
    v = Number(c.capPerReceiver)
    refused = `at most ${c.capPerReceiver} to one person`
  }
  if (others + v > Number(c.thanksPerRound)) {
    v = Math.max(0, Number(c.thanksPerRound) - others)
    refused = `${c.thanksPerRound} thanks in all`
  }
  if (v > 0 && !out.has(account) && out.size >= Number(c.maxReceivers)) {
    return { draft: draft, refused: `at most ${c.maxReceivers} people a round` }
  }
  if (v === 0) out.delete(account)
  else out.set(account, v)
  return { draft: out, refused }
}

export const bumpGift = (cfg, draft, account, delta) => setGift(cfg, draft, account, (draft.get(account) ?? 0) + delta)

/** The draft as the contract's gift list: [[receiver, thanks]] in account order. */
export const draftGifts = (draft) => [...draft].filter(([, v]) => v > 0).sort((a, b) => cmp(a[0], b[0]))

/** The refusals `allocate` would give, checked before sending (null if the gifts are fine). */
export function checkGifts(cfg, giver, gifts, { members, seats = [], guest = false }) {
  const c = numCfg(cfg)
  const m = namedMembers(members)
  const s = new Set(seats)
  const seen = new Set()
  let total = 0
  if (gifts.length > Number(c.maxReceivers)) return `at most ${c.maxReceivers} receivers`
  for (const [r, t] of gifts) {
    if (r === giver) return 'no thanks to yourself'
    if (seen.has(r)) return 'one entry per receiver'
    seen.add(r)
    if (!Number.isInteger(t) || t < 1 || t > Number(c.capPerReceiver)) return `each gift is 1 to ${c.capPerReceiver} thanks`
    if (!(m.has(r) || s.has(r))) return `${r} is not a member or a seated guest`
    if (guest && !m.has(r)) return 'guests give to members only'
    total += t
  }
  if (total > Number(c.thanksPerRound)) return `at most ${c.thanksPerRound} thanks a round`
  return null
}

// ---- guest actions and signing -----------------------------------------------------------------

export const SIGNING_PREFIX = 'hattip:v1'
export const signingText = (contract, nonce, action) => `${SIGNING_PREFIX}:${contract}:${nonce}:${action}`
export const joinAction = (round, note) => JSON.stringify({ join: note ? { round, note } : { round } })
export const allocateAction = (round, gifts) => JSON.stringify({ allocate: { round, gifts: gifts.map(([r, t]) => [r, Number(t)]) } })
export const noteAction = (round, text) => JSON.stringify({ note: { round, text } })

/** Nonces only have to rise. Milliseconds keep two tabs of one guest from colliding. */
export function nextNonce(last, nowMs) {
  const n = Math.max(Number(last || 0) + 1, Math.floor(nowMs))
  if (n > Number.MAX_SAFE_INTEGER) throw new Error('nonce out of range')
  return n
}

export const utf8Length = (s) => new TextEncoder().encode(String(s ?? '')).length

/** Cuts a note to at most `max` UTF-8 bytes, never inside a character. */
export function clipNote(text, max = 80) {
  let out = ''
  for (const ch of String(text ?? '').replace(/\s+/g, ' ')) {
    if (utf8Length(out + ch) > max) break
    out += ch
  }
  return out
}

// ---- the clock ---------------------------------------------------------------------------------

/** The round the clock is in (0 before genesis), as the contract counts it. */
export const clockRound = (nowMs, genesisMs, roundMs) => (nowMs < genesisMs ? 0 : Math.floor((nowMs - genesisMs) / roundMs) + 1)
export const roundEndMs = (r, genesisMs, roundMs) => genesisMs + r * roundMs
export const roundStartMs = (r, genesisMs, roundMs) => genesisMs + (r - 1) * roundMs

// ---- the DAO -----------------------------------------------------------------------------------

const roleNamed = (policy, name) => (policy?.roles ?? []).find((r) => r.name === name)
const groupOf = (role) => (role?.kind?.Group ? [...role.kind.Group] : [])
const isEveryone = (role) => role?.kind === 'Everyone' || (role?.kind && Object.hasOwn(role.kind, 'Everyone'))

/** Sputnik's permission test: `kind:action`, either part may be `*`. */
export function hasPermission(role, kind, action) {
  const p = new Set(role?.permissions ?? [])
  return p.has(`${kind}:${action}`) || p.has(`*:${action}`) || p.has(`${kind}:*`) || p.has('*:*')
}

/** A threshold as Sputnik states it: "1" (a weight) or [1, 2] (a ratio). */
export function thresholdText(t) {
  if (Array.isArray(t)) return `${t[0]} of ${t[1]}`
  if (t !== undefined && t !== null) return `${t} vote${String(t) === '1' ? '' : 's'}`
  return '–'
}

/** Votes a ratio or weight threshold needs in a role of `n` members (Sputnik's to_weight). */
export function votesNeeded(threshold, n) {
  if (Array.isArray(threshold)) return Math.min(Math.floor((n * Number(threshold[0])) / Number(threshold[1])) + 1, n)
  return Math.min(Number(threshold), n)
}

const sameThreshold = (t, want) => JSON.stringify(Array.isArray(t) ? t.map(Number) : String(t)) === JSON.stringify(want)

/**
 * Reads the DAO policy (as get_policy returns it) against the design: the three tiers as the DAO
 * itself states them, and the checks a judge would make. Role names come from the contract config.
 */
export function policyReport(policy, { contract, councilRole = 'council', thanksRole = 'thanks', membersRole = 'members' }) {
  const roles = policy?.roles ?? []
  const council = roleNamed(policy, councilRole)
  const thanks = roleNamed(policy, thanksRole)
  const members = roleNamed(policy, membersRole)
  const def = policy?.default_vote_policy ?? {}
  const councilAccounts = groupOf(council)
  const callFilers = roles.filter((r) => hasPermission(r, 'call', 'AddProposal')).map((r) => r.name)
  const transferVoters = roles.filter((r) => hasPermission(r, 'transfer', 'VoteApprove')).map((r) => r.name)
  const councilCall = council?.vote_policy?.call
  const thanksTransfer = thanks?.vote_policy?.transfer
  const councilTransfer = council?.vote_policy?.transfer ?? def
  const tier3Votes = votesNeeded(councilTransfer.threshold ?? [1, 2], councilAccounts.length || 1)
  const n = councilAccounts.length
  const tier2Votes = councilCall ? votesNeeded(councilCall.threshold, n || 1) : null
  const tiers = [
    { tier: 1, kind: 'Transfer', who: `role ${thanksRole} (the contract)`, rule: thanksTransfer ? thresholdText(thanksTransfer.threshold) : '–', votes: 1, approvedBy: `the contract’s own vote (role ${thanksRole}, threshold ${thanksTransfer ? thresholdText(thanksTransfer.threshold) : '–'})` },
    { tier: 2, kind: 'FunctionCall ft_transfer', who: `role ${councilRole}`, rule: councilCall ? thresholdText(councilCall.threshold) : thresholdText(def.threshold), votes: tier2Votes, approvedBy: `any ${tier2Votes === 1 ? 'one' : tier2Votes} of ${n} council members (role ${councilRole}, threshold ${councilCall ? thresholdText(councilCall.threshold) : '–'})` },
    { tier: 3, kind: 'Transfer', who: `role ${councilRole}`, rule: thresholdText(councilTransfer.threshold), votes: tier3Votes, approvedBy: `${tier3Votes} of ${n} council members (default policy, more than ${Array.isArray(councilTransfer.threshold) ? councilTransfer.threshold.join('/') : councilTransfer.threshold})` },
  ]
  const checks = [
    { ok: !roles.some(isEveryone), label: 'No Everyone role: only named roles can file or vote' },
    { ok: callFilers.length === 1 && callFilers[0] === thanksRole, label: `Only role ${thanksRole} may file call proposals (the tier-2 payouts)` },
    { ok: groupOf(thanks).length === 1 && groupOf(thanks)[0] === contract, label: `Role ${thanksRole} holds the contract and nothing else` },
    { ok: Boolean(thanksTransfer) && sameThreshold(thanksTransfer.threshold, [1, 1]) && hasPermission(thanks, 'transfer', 'VoteApprove'), label: 'Tier 1: the contract approves its own transfers, 1 of 1' },
    { ok: !hasPermission(thanks, 'call', 'VoteApprove'), label: 'The contract cannot vote on call proposals' },
    { ok: Boolean(councilCall) && sameThreshold(councilCall.threshold, '1') && hasPermission(council, 'call', 'VoteApprove'), label: 'Tier 2: one council vote passes a call proposal' },
    { ok: tier3Votes >= 2 && !council?.vote_policy?.transfer, label: `Tier 3: other transfers need ${tier3Votes} council votes` },
    { ok: transferVoters.every((n) => n === councilRole || n === thanksRole), label: 'Nobody else can approve a transfer' },
  ]
  return { tiers, checks, ok: checks.every((c) => c.ok), council: councilAccounts, members: groupOf(members), bond: policy?.proposal_bond ?? null, periodNs: policy?.proposal_period ?? null }
}

function decodeArgs(b64) {
  try {
    const bin = globalThis.atob(b64)
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))))
  } catch {
    return null
  }
}

/** A DAO proposal (get_proposal) in a small shape: receiver, amount, votes. */
export function proposalInfo(p) {
  if (!p) return null
  let kind = Object.keys(p.kind ?? {})[0] ?? '?'
  let receiver = null
  let amount = null
  if (p.kind?.Transfer) {
    receiver = p.kind.Transfer.receiver_id
    amount = big(p.kind.Transfer.amount)
  } else if (p.kind?.FunctionCall) {
    const a = p.kind.FunctionCall.actions?.[0]
    const args = a ? decodeArgs(a.args) : null
    kind = `FunctionCall ${a?.method_name ?? ''}`.trim()
    receiver = args?.receiver_id ?? null
    amount = args?.amount ? big(args.amount) : null
  }
  const votes = Object.entries(p.votes ?? {}).sort((a, b) => cmp(a[0], b[0]))
  return {
    id: p.id,
    status: p.status,
    kind,
    receiver,
    amount,
    description: p.description ?? '',
    proposer: p.proposer,
    votes,
    approvals: votes.filter(([, v]) => v === 'Approve').length,
    rejections: votes.filter(([, v]) => v === 'Reject').length,
    submittedMs: p.submission_time ? Number(big(p.submission_time) / 1_000_000n) : null,
  }
}

/** "Council A and C" for ["Council A", "Council C"]; "Ana, Ben and Cleo" otherwise. */
export function joinNames(names) {
  if (names.length < 2) return names.join('')
  const words = names.map((n) => n.split(' '))
  const head = words[0][0]
  const shared = words.every((w) => w.length === 2 && w[0] === head)
  const parts = shared ? words.map((w, i) => (i === 0 ? w.join(' ') : w[1])) : names
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/** The column a payout sits in and the one line under it. */
export function payoutStage(payout, info = null, { tier3Votes = 2, name = (a) => a } = {}) {
  const s = String(payout.status).toLowerCase()
  const voters = (info?.votes ?? []).filter(([, v]) => v === 'Approve').map(([a]) => name(a))
  const by = voters.length ? ` by ${joinNames(voters)}` : ''
  const tier = Number(payout.tier)
  switch (s) {
    case 'planned':
      return { state: 'waiting', text: 'Planned · filing in the DAO soon' }
    case 'filing':
      return { state: 'waiting', text: 'Filing in the DAO…' }
    case 'filed':
      if (tier === 1) return { state: 'waiting', text: 'Filed · the contract is voting' }
      if (tier === 2) return { state: 'waiting', text: 'Waiting for one council vote' }
      return { state: 'waiting', text: `${Math.min(info?.approvals ?? 0, tier3Votes)} of ${tier3Votes} council votes` }
    case 'approved':
      return { state: 'waiting', text: `Approved${by} · transfer on its way` }
    case 'paid':
      return { state: 'paid', text: tier === 1 ? 'Paid at once' : `Paid · approved${by || ' by the council'}` }
    case 'rejected':
      return { state: 'struck', text: 'Rejected by the council · strike' }
    case 'removed':
      return { state: 'struck', text: 'Removed by the council · strike' }
    case 'expired':
      return { state: 'lapsed', text: 'Expired unvoted · stays in the DAO' }
    case 'failed':
      return { state: 'lapsed', text: 'Transfer failed · stays in the DAO' }
    default:
      return { state: 'waiting', text: s }
  }
}

export const TIER_NAMES = { 1: 'Paid automatically', 2: 'Needs one council vote', 3: 'Needs a council majority' }
export const TIER_SHORT = { 1: 'auto', 2: '1 council vote', 3: 'council majority' }

/** The proposal text the contract files (DESIGN.md "Proposal text"). */
export function proposalText({ round, points, givers, receiver, tier }) {
  const label = tier === 1 ? 'auto' : tier === 2 ? 'one council vote' : 'council majority'
  return `Hat Tip r${round}: ${fmtThanks(points)} thanks from ${givers} -> ${receiver} (${label})`
}

// ---- records -----------------------------------------------------------------------------------

/**
 * An account's reputation after each round from `from` to `to`, from its points per round and its
 * strikes (each taken off at the round it was read), with the contract's per-round decay.
 */
export function repSeries(cfg, { history = [], strikes = [], from, to, start = 0n, guest = false }) {
  const pts = new Map(history.map((h) => [Number(h.round), big(h.points)]))
  const off = new Map()
  for (const s of strikes) off.set(Number(s.at), (off.get(Number(s.at)) ?? 0n) + big(s.amount))
  const out = []
  let r = big(start)
  for (let n = from; n <= to; n++) {
    r = decay(r, cfg, guest) + (pts.get(n) ?? 0n)
    if (guest && r < MILLI) r = 0n
    if (off.has(n)) r = r - minB(r, off.get(n))
    out.push({ round: n, rep: r })
  }
  return out
}

/** One row of the ledger of rounds, from round(n) and the payouts of that round. */
export function roundSummary(rv, payouts = []) {
  const givers = new Set((rv?.gifts ?? []).map((g) => g[0]))
  const receivers = new Set((rv?.gifts ?? []).map((g) => g[1]))
  const thanks = (rv?.gifts ?? []).reduce((a, g) => a + Number(g[2]), 0)
  const points = sumB((rv?.points ?? []).map((p) => big(p[1])))
  const byTier = { 1: { n: 0, amount: 0n }, 2: { n: 0, amount: 0n }, 3: { n: 0, amount: 0n } }
  for (const p of payouts) {
    const t = byTier[Number(p.tier)]
    if (!t) continue
    t.n++
    t.amount += big(p.amount)
  }
  return { n: rv?.n, closed: Boolean(rv?.closed), givers: givers.size, receivers: receivers.size, thanks, points, budget: big(rv?.budget), dust: big(rv?.dust), payouts: payouts.length, byTier, paid: sumB(payouts.map((p) => big(p.amount))) }
}

/** Groups a round view's gifts as allocations (giver -> [[receiver, thanks]]). */
export function giftsByGiver(gifts = []) {
  const m = new Map()
  for (const [g, r, t] of gifts) {
    if (!m.has(g)) m.set(g, [])
    m.get(g).push([r, Number(t)])
  }
  return m
}

/** Points per giver behind one receiver in a closed round: [{giver, given, counted}]. */
export function giversOf(gifts = [], receiver) {
  return gifts.filter((g) => g[1] === receiver).map(([giver, , given, counted]) => ({ giver, given: Number(given), counted: big(counted) }))
}

// ---- names and labels --------------------------------------------------------------------------

/** House strategies (sim/params.json, I-2) and how the page labels them. */
export const HOUSE_LABELS = {
  honest: 'house bot · honest helper',
  pair: 'house bot · demo: colluding pair',
  free_rider: 'house bot · demo: free rider',
  newcomer: 'house bot · newcomer',
  council: 'house bot · council',
}

/** Implicit accounts as "a1b2c3…d4e5"; named accounts stay whole unless very long. */
export const shortAccount = (a) => (a && (isImplicit(a) || a.length > 44) ? `${a.slice(0, 6)}…${a.slice(-4)}` : (a ?? ''))

/**
 * A short name for an account: "You" for the visitor, "Guest 1a2b" for other implicit accounts,
 * else the first label of a named account, capitalised ("Ana" for ana.cafe.testnet).
 */
export function displayName(account, me = null) {
  if (!account) return ''
  if (me && account === me) return 'You'
  if (isImplicit(account)) return `Guest ${account.slice(0, 4)}`
  return account
    .split('.')[0]
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

/** A stable small number for an account, for picking its avatar colour. */
export function hue(account, n = 8) {
  let h = 2166136261
  for (let i = 0; i < account.length; i++) {
    h ^= account.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h % n
}

// ---- formatting --------------------------------------------------------------------------------

function group(v) {
  return v.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

export function fmtInt(n) {
  const v = typeof n === 'bigint' ? n : BigInt(Math.round(Number(n) || 0))
  return (v < 0n ? '-' : '') + group(v < 0n ? -v : v)
}

/** tUSD base units as text with two decimals, rounded down: "1,234.50". Tiny amounts show "<0.01". */
export function fmtTusd(units, { places = 2 } = {}) {
  const u = big(units)
  const neg = u < 0n
  const a = neg ? -u : u
  if (a > 0n && a < TUSD / 10n ** BigInt(places)) return (neg ? '-' : '') + '<0.' + '0'.repeat(places - 1) + '1'
  const frac = ((a % TUSD) * 10n ** BigInt(places)) / TUSD
  return (neg ? '-' : '') + group(a / TUSD) + (places ? '.' + frac.toString().padStart(places, '0') : '')
}

/** Milli-thanks as thanks with at most one decimal, rounded down: 31_533 -> "31.5", 20_000 -> "20". */
export function fmtThanks(milli) {
  const m = big(milli)
  const whole = m / MILLI
  const tenth = (m % MILLI) / 100n
  return group(whole) + (tenth ? '.' + tenth : '')
}

export function fmtPct(bp) {
  const v = Number(bp) / 100
  return `${Number.isInteger(v) ? v : v.toFixed(1).replace(/\.0$/, '')} %`
}

export function fmtCountdown(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const two = (n) => String(n).padStart(2, '0')
  return h ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`
}

export function fmtDuration(ms) {
  const units = [
    [86_400_000, 'day'],
    [3_600_000, 'hour'],
    [60_000, 'minute'],
    [1000, 'second'],
  ]
  for (const [u, name] of units) {
    if (ms >= u && ms % u === 0) {
      const n = ms / u
      return `${n} ${name}${n === 1 ? '' : 's'}`
    }
  }
  const s = Math.round(ms / 1000)
  return `${s} seconds`
}

export function fmtAgo(ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  return `${Math.round(m / 60)} h ago`
}
