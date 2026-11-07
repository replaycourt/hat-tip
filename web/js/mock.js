// MOCK MODE, for development and for a look without a deployment: `?mock=1` in the URL. Never
// active otherwise, and never touches the network.
//
// A made-up Repair Café plays round after round in this tab, with the testnet launch parameters
// and the published house strategies of sim/params.json (I-2; test/mock.test.mjs checks both):
// honest helpers, a colluding pair, a free rider and a newcomer post notes and hand out their
// thanks during each round; the round closes on the clock through the same close as the
// contract (logic.js Hat, checked against the golden vectors); every payout becomes a proposal in a
// stand-in Sputnik DAO, where tier 1 is approved by the contract's own vote at once, tier 2 waits
// for one house council vote and tier 3 for two. The council votes by the published rule: it
// rejects a tier-2 payout whose points came mostly from one partner (a giver the receiver thanked
// back with at least COUNCIL_PARTNER_MIN thanks; a welcome is not one) and a tier-3 payout with
// fewer than three givers. The council votes seconds after filing, not minutes, so that a
// whole round fits in a few minutes. The history is played until a round closes with payouts in
// all three tiers and the live round will too (with the newcomer's first payout).
//
// MockClient has the methods of the real Client (js/chain.js) and returns the contract's, the
// DAO's and the token's JSON shapes, so the page cannot tell the difference except by `mock`.
// URL knobs: `&round=<seconds>` (length of a round, default 180), `&at=<0..0.95>` (how far the
// live round is at load, default 0.6), `&seed=<n>`.
import { Hat, TUSD, allocationMap, checkGifts, clockRound, cmp, isImplicit, limitsFor, namedMembers, proposalText, roundEndMs, roundStartMs } from './logic.js'

const ROOT = 'repair-cafe.testnet'
const acc = (name) => `${name}.${ROOT}`
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const s = (v) => String(v)
const U = (whole) => BigInt(Math.round(whole * 1_000_000))
const BOND = '10000000000000000000000'

export const MOCK_IDS = {
  contract: acc('hattip'),
  token: acc('tusd'),
  dao: 'repair-cafe.sputnikv2.testnet',
  gasAccount: acc('gas'),
  codeHash: '7xQZ3mVn2bWkS4dJpTf9hRcYgLuE1aK8oN5sPvBt6iMq',
  tokenCodeHash: '3fHk9QmZr5TjWv2NcLpXb8YsGd1uEo7Ai4KnRqMtV6Bz',
  daoCodeHash: 'AA4nA45vauiac3jdVwJTzSdUP3oj2r1fDaPAb2mHdgcH',
}

/** The testnet launch values of sim/params.json ("testnet"), with a round length for the mock. */
export function mockConfig({ roundMs = 180_000, genesisMs }) {
  return {
    dao: MOCK_IDS.dao,
    token: MOCK_IDS.token,
    members_role: 'members',
    council_role: 'council',
    thanks_role: 'thanks',
    genesis_ms: genesisMs,
    round_ms: roundMs,
    thanks_per_round: 100,
    cap_per_receiver: 25,
    max_receivers: 10,
    reciprocal_bp: 2500,
    quadratic: false,
    breadth_k: 3,
    breadth_bp: 2500,
    idle_bp: 10000,
    decay_bp: 750,
    round_budget: '120000000',
    min_payout: '5000000',
    carry_rounds: 12,
    reserve: '0',
    auto_rep_min: 200,
    auto_per_thanks: '60000',
    auto_max: '30000000',
    cosign_base: '14400000',
    cosign_per_thanks: '60000',
    cosign_max: '30000000',
    auto_share_bp: 8000,
    guest_seats: 6,
    guest_weight_bp: 5000,
    guest_cap_bp: 2000,
    max_members: 24,
    max_catchup: 36,
    log_keep: 108,
    note_max_bytes: 80,
    guest_receive_cap_bp: 800,
  }
}

// ---- the community -----------------------------------------------------------------------------

/** The published behaviour of sim/params.json, house.behaviour. */
export const BEHAVIOUR = { p_work: 0.9, items_sigma: 0.4, noise_sigma: 0.5, focus: 0.15, welcome_each: 5, welcome_max: 2, free_rider_claim: 0.5 }

/** The things each member fixes (the notes name them, as in the simulation's note templates). */
const ITEMS = {
  ana: [['fixed', 'kettle', 'kettles'], ['fixed', 'toaster', 'toasters']],
  ben: [['adjusted', 'bike brake', 'bike brakes']],
  cleo: [['mended', 'jacket', 'jackets']],
  dina: [['repaired', 'lamp', 'lamps'], ['glued', 'chair', 'chairs']],
  emil: [['soldered', 'radio', 'radios']],
  finn: [['repaired', 'lamp', 'lamps']],
  gus: [['glued', 'chair', 'chairs']],
  ivy: [['sharpened', 'knife', 'knives'], ['fixed', 'kettle', 'kettles']],
}
const VAGUE = ['helped at the front desk', 'made coffee for the volunteers', 'sorted a box of screws', 'tidied the workbench']

/** The house members of sim/params.json: name, strategy, items_mean; Ivy is the optional newcomer. */
function people(h) {
  return [
    { name: 'ana', kind: 'honest', items: 6.0, from: 1 },
    { name: 'ben', kind: 'honest', items: 5.0, from: 1 },
    { name: 'cleo', kind: 'honest', items: 4.0, from: 1 },
    { name: 'dina', kind: 'honest', items: 3.0, from: 1 },
    { name: 'emil', kind: 'honest', items: 2.5, from: 1 },
    { name: 'finn', kind: 'pair', items: 2.0, partner: 'gus', from: 1 },
    { name: 'gus', kind: 'pair', items: 2.0, partner: 'finn', from: 1 },
    { name: 'hugo', kind: 'free_rider', items: 0, from: 1 },
    { name: 'ivy', kind: 'newcomer', items: 4.0, from: h + 1 },
  ].map((p) => ({ ...p, account: acc(p.name) }))
}
const COUNCIL = ['council-a', 'council-b', 'council-c'].map(acc)
/** sim/params.json house.council_rule.partner_min: thanks back that make the top giver a partner. */
export const COUNCIL_PARTNER_MIN = 6
const VISITOR_NOTES = ['brought cake for the volunteers', 'swept the floor after closing', 'helped carry the toolbox', 'brought a broken radio']

// ---- deterministic randomness ------------------------------------------------------------------

function hash32(str) {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h || 1
}

export function rng(seed) {
  let x = seed >>> 0 || 1
  return () => {
    x ^= x << 13
    x >>>= 0
    x ^= x >>> 17
    x ^= x << 5
    x >>>= 0
    return x / 4294967296
  }
}

const hasAllTiers = (res) => !res.empty && [1, 2, 3].every((t) => res.payouts.some((x) => x.tier === t))

/** A copy of the close engine, to try a round without touching the world. */
function cloneHat(h) {
  const c = new Hat(h.cfg)
  c.rep = new Map(h.rep)
  c.hist = new Map([...h.hist].map(([a, m]) => [a, new Map(m)]))
  c.carry = new Map([...h.carry].map(([a, v]) => [a, [...v]]))
  c.payouts = h.payouts.map((x) => ({ ...x }))
  c.byKey = new Map(c.payouts.map((x) => [`${x.round}|${x.receiver}`, x]))
  c.open = new Map(h.open)
  c.strikes = [...h.strikes]
  c.closed = h.closed
  c.totals = { ...h.totals }
  return c
}

const gauss = (r) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r())
const fakeHex = (r) => Array.from({ length: 64 }, () => '0123456789abcdef'[Math.floor(r() * 16)]).join('')
const fakeHash = (r) => Array.from({ length: 44 }, () => B58[Math.floor(r() * 58)]).join('')

/** Splits `total` thanks over weighted receivers: whole numbers, each 1..cap, largest remainders first. */
export function splitThanks(total, weighted, cap) {
  const list = weighted.filter(([, w]) => w > 0)
  const sum = list.reduce((a, [, w]) => a + w, 0)
  if (!list.length || total <= 0) return []
  const raw = list.map(([a, w]) => [a, (total * w) / sum])
  const out = raw.map(([a, x]) => [a, Math.max(1, Math.min(cap, Math.floor(x)))])
  let left = total - out.reduce((a, [, t]) => a + t, 0)
  const order = raw.map(([, x], i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0])
  while (left > 0 && out.some(([, t]) => t < cap)) {
    for (const [, i] of order) {
      if (left <= 0) break
      if (out[i][1] < cap) {
        out[i][1]++
        left--
      }
    }
  }
  while (left < 0) {
    const i = out.reduce((b, x, k) => (x[1] > out[b][1] ? k : b), 0)
    out[i][1]--
    left++
  }
  return out.filter(([, t]) => t > 0)
}

// ---- the world ---------------------------------------------------------------------------------

export class MockWorld {
  constructor({ now = () => Date.now(), roundMs = 180_000, at = 0.6, seed = 11, history = null, pace = 1, probe = false } = {}) {
    if (history == null) history = MockWorld.pickHistory(seed)
    this.now = now
    this.seed = seed
    this.H = history
    this.probe = probe
    this.roundMs = roundMs
    const t0 = now()
    this.t0 = t0
    this.genesis = Math.floor(t0 - (history + at) * roundMs)
    this.cfg = mockConfig({ roundMs, genesisMs: this.genesis })
    this.hat = new Hat(this.cfg)
    this.people = people(history)
    this.byAccount = new Map(this.people.map((p) => [p.account, p]))
    this.house = Object.fromEntries([...this.people.map((p) => [p.account, p.kind]), ...COUNCIL.map((c) => [c, 'council'])])
    this.logs = new Map()
    this.meta = new Map() // payout id -> {proposal, givers, kind}
    this.dao = { balance: 1_000_000n * TUSD, proposals: new Map(), next: 0 }
    this.tusd = new Map([[MOCK_IDS.dao, this.dao.balance]])
    this.events = []
    this.closedUpTo = 0
    this.lastSync = t0
    this.r = rng(hash32(`hat-tip mock ${seed}`))
    const k = Math.max(0.05, pace)
    this.delays = { close: 1500 * k, file: 1200 * k, t1: 1200 * k, t2: 11_000 * k, t3a: 7000 * k, t3b: 19_000 * k, welcome: [2500 * k, 7000 * k] }
    this.setupProposals()
    if (probe) return
    for (let r = 1; r <= history; r++) this.playPast(r, r === history ? 'boot' : 'past')
    this.openRound(history + 1)
    this.tick()
  }

  /**
   * How many rounds to play before the live one: the first round from `from` on whose close has
   * payouts in all three tiers and after which the live round, with the newcomer's first payout,
   * closes with all three too: without a visitor, and with one who writes a note and gives 25
   * thanks to each of the four members whose notes name the most work.
   */
  static pickHistory(seed, from = 36, to = 160) {
    const w = new MockWorld({ seed, history: to, now: () => 0, probe: true })
    const ivy = w.people.find((p) => p.kind === 'newcomer')
    ivy.from = Infinity
    for (let r = 1; r <= to; r++) {
      const res = w.playPast(r, 'past')
      if (r < from || !hasAllTiers(res)) continue
      ivy.from = r + 1
      if (w.trial(r + 1, false) && w.trial(r + 1, true)) return r
      ivy.from = Infinity
    }
    return from
  }

  // -- helpers --
  roundEnd(r) {
    return roundEndMs(r, this.genesis, this.roundMs)
  }
  roundStart(r) {
    return roundStartMs(r, this.genesis, this.roundMs)
  }
  clock(t = this.now()) {
    return clockRound(t, this.genesis, this.roundMs)
  }
  log(r) {
    if (!this.logs.has(r)) this.logs.set(r, { n: r, closed: false, notes: new Map(), seats: [], allocs: new Map(), gifts: [], points: [], payouts: [], budget: 0n, dust: 0n, daoBalance: 0n })
    return this.logs.get(r)
  }
  membersAt(r) {
    return this.people.filter((p) => p.from <= r).map((p) => p.account).sort(cmp)
  }
  rand(...parts) {
    return rng(hash32([this.seed, ...parts].join('|')))
  }
  at(t, fn) {
    this.events.push({ at: t, fn })
  }

  /** Runs every event due by now, in time order (events may add events). */
  tick() {
    const t = this.now()
    for (let guard = 0; guard < 10_000; guard++) {
      this.events.sort((a, b) => a.at - b.at)
      if (!this.events.length || this.events[0].at > t) break
      this.events.shift().fn()
    }
  }

  /** Closes round r on a copy of the engine with the house's thanks (and a typical visitor). */
  trial(r, visitor) {
    const log = this.log(r)
    if (visitor) {
      const guest = 'f'.repeat(64)
      const top = this.people.filter((p) => p.from <= r && this.items(p, r) > 0).sort((a, b) => this.items(b, r) - this.items(a, r)).slice(0, 4)
      log.seats.push(guest)
      log.notes.set(guest, VISITOR_NOTES[0])
      log.allocs.set(guest, top.map((p) => [p.account, 25]))
    }
    for (const p of this.people) this.allocate(r, p.account, this.houseGifts(p, r))
    const res = cloneHat(this.hat).close(r, this.membersAt(r), log.seats, log.allocs, this.dao.balance)
    this.logs.delete(r)
    return hasAllTiers(res)
  }

  // -- behaviour (sim/params.json, house) --
  /** Whether a member works this round (nine rounds in ten), and how many items they fix. */
  items(p, r) {
    if (p.from > r || p.kind === 'free_rider') return 0
    const g = this.rand('work', p.name, r)
    if (g() >= BEHAVIOUR.p_work) return 0
    return Math.max(1, Math.round(p.items * Math.exp(BEHAVIOUR.items_sigma * gauss(g))))
  }

  /** A free rider claims one item now and then; the others read it as one item. */
  claims(p, r) {
    return p.kind === 'free_rider' && p.from <= r && this.rand('claim', p.name, r)() < BEHAVIOUR.free_rider_claim
  }

  works(p, r) {
    return p.kind === 'free_rider' ? p.from <= r : this.items(p, r) > 0
  }

  /** What a giver reads in a receiver's note this round, with the giver's own noise. */
  perceived(giver, p, r) {
    const read = p.kind === 'free_rider' ? (this.claims(p, r) ? 1 : 0) : this.items(p, r)
    return read * Math.exp(BEHAVIOUR.noise_sigma * gauss(this.rand('see', giver.name, p.name, r)))
  }

  /** A guest qualifies for the house welcome: a note and thanks given in this round. */
  welcomed(r) {
    const log = this.log(r)
    return log.seats.filter((g) => log.notes.has(g) && log.allocs.has(g)).slice(0, BEHAVIOUR.welcome_max)
  }

  /** One house member's 100 thanks for round r, by its published strategy. */
  houseGifts(giver, r) {
    if (giver.kind === 'free_rider' || !this.works(giver, r)) return []
    const cap = Number(this.cfg.cap_per_receiver)
    let budget = Number(this.cfg.thanks_per_round)
    const out = []
    if (giver.kind === 'pair') {
      out.push([acc(giver.partner), cap])
      budget -= cap
    }
    for (const g of this.welcomed(r)) {
      out.push([g, BEHAVIOUR.welcome_each])
      budget -= BEHAVIOUR.welcome_each
    }
    const taken = new Set(out.map(([a]) => a))
    let weighted = this.people.filter((p) => p.from <= r && p.account !== giver.account && !taken.has(p.account)).map((p) => [p.account, this.perceived(giver, p, r)])
    const top = Math.max(0, ...weighted.map(([, w]) => w))
    weighted = weighted
      .filter(([, w]) => w > 0 && w >= BEHAVIOUR.focus * top)
      .sort((a, b) => b[1] - a[1])
      .slice(0, Number(this.cfg.max_receivers) - out.length)
    out.push(...splitThanks(budget, weighted, cap))
    return out
  }

  note(r, account, text) {
    this.log(r).notes.set(account, text)
  }

  noteOf(p, r) {
    if (p.kind === 'free_rider') return VAGUE[Math.floor(this.rand('note', p.name, r)() * VAGUE.length)]
    const n = this.items(p, r)
    const list = ITEMS[p.name] ?? ITEMS.ana
    const [verb, one, many] = list[Math.floor(this.rand('note', p.name, r)() * list.length)]
    return `${verb} ${n === 1 ? `1 ${one}` : `${n} ${many}`}`
  }

  setupProposals() {
    // What the setup filed before round 1: auto-update off (DESIGN.md "Factory auto-update").
    const t = this.genesis - 600_000
    this.newProposal({ proposer: COUNCIL[0], description: 'Turn off factory auto-update', kind: { FactoryInfoUpdate: { factory_info: { factory_id: 'sputnikv2.testnet', auto_update: false } } }, at: t, status: 'Approved', votes: { [COUNCIL[0]]: 'Approve', [COUNCIL[1]]: 'Approve' } })
  }

  newProposal({ proposer, description, kind, at, status = 'InProgress', votes = {} }) {
    const id = this.dao.next++
    const p = { id, proposer, description, kind, status, vote_counts: {}, votes: { ...votes }, submission_time: s(BigInt(Math.floor(at)) * 1_000_000n) }
    this.countVotes(p)
    this.dao.proposals.set(id, p)
    return p
  }

  /** Votes per role, as Sputnik keeps them: council members in `council`, the contract in `thanks`. */
  countVotes(p) {
    const counts = {}
    for (const [a, v] of Object.entries(p.votes)) {
      const role = COUNCIL.includes(a) ? 'council' : a === MOCK_IDS.contract ? 'thanks' : null
      if (!role) continue
      counts[role] = counts[role] ?? [0, 0, 0]
      counts[role][v === 'Approve' ? 0 : v === 'Reject' ? 1 : 2]++
    }
    p.vote_counts = Object.fromEntries(Object.entries(counts).map(([k, c]) => [k, c.map(String)]))
  }

  // -- rounds --
  allocate(r, giver, gifts) {
    const log = this.log(r)
    if (gifts.length) log.allocs.set(giver, gifts)
    else log.allocs.delete(giver)
  }

  /** A past round, played at once: notes, thanks, the close, the payouts and their votes. */
  playPast(r, mode) {
    const log = this.log(r)
    for (const p of this.people) if (this.works(p, r)) this.note(r, p.account, this.noteOf(p, r))
    // Now and then a visitor takes a guest seat, posts a note and thanks a few members.
    const v = this.rand('visitor', r)
    if (v() < 0.35) {
      const guest = fakeHex(v)
      log.seats.push(guest)
      if (v() < 0.8) this.note(r, guest, VISITOR_NOTES[Math.floor(v() * VISITOR_NOTES.length)])
      const picks = this.membersAt(r).filter((a) => this.byAccount.get(a).kind !== 'free_rider' && v() < 0.6).slice(0, 5)
      if (picks.length >= 2) this.allocate(r, guest, splitThanks(100, picks.map((a) => [a, 1 + v()]), Number(this.cfg.cap_per_receiver)))
    }
    for (const p of this.people) this.allocate(r, p.account, this.houseGifts(p, r))
    const end = this.roundEnd(r)
    const res = this.closeRound(r, end + this.delays.close)
    this.file(r, end + this.delays.close + this.delays.file, mode)
    return res
  }

  /** The live round: house notes and thanks spread over the round; events already past run now. */
  openRound(r) {
    const start = this.roundStart(r)
    for (const p of this.people) {
      if (p.from > r) continue
      const g = this.rand('when', p.name, r)
      if (this.works(p, r)) this.at(start + g() * 0.35 * this.roundMs, () => this.note(r, p.account, this.noteOf(p, r)))
      if (p.kind !== 'free_rider') this.at(start + (0.12 + g() * 0.78) * this.roundMs, () => this.allocate(r, p.account, this.houseGifts(p, r)))
    }
    this.at(this.roundEnd(r) + this.delays.close, () => {
      this.closeRound(r, this.roundEnd(r) + this.delays.close)
      this.openRound(r + 1)
      this.at(this.roundEnd(r) + this.delays.close + this.delays.file, () => this.file(r, this.now(), 'live'))
    })
  }

  closeRound(r, t) {
    const log = this.log(r)
    const res = this.hat.close(r, this.membersAt(r), log.seats, log.allocs, this.dao.balance)
    log.closed = true
    log.closedAt = t
    this.closedUpTo = r
    this.lastSync = t
    if (res.empty) return res
    log.daoBalance = this.dao.balance
    log.budget = res.budget
    log.dust = res.dust
    const counted = new Map(res.count.rows.map((x) => [`${x.giver}|${x.receiver}`, x.counted]))
    log.gifts = []
    for (const g of [...log.allocs.keys()].sort(cmp)) for (const [rc, t2] of log.allocs.get(g)) log.gifts.push([g, rc, t2, counted.get(`${g}|${rc}`) ?? 0n])
    log.points = [...res.points].sort((a, b) => cmp(a[0], b[0]))
    log.payouts = res.payouts.map((x) => x.id)
    for (const x of res.payouts) {
      const rows = res.count.rows.filter((y) => y.receiver === x.receiver && y.counted > 0n)
      // the council's rule: mostly from one partner (thanked back with at least COUNCIL_PARTNER_MIN)?
      const partner = rows.find((y) => res.count.rows.some((z) => z.giver === x.receiver && z.receiver === y.giver && z.thanks >= COUNCIL_PARTNER_MIN) && y.counted * 2n > x.points)
      this.meta.set(x.id, { proposal: null, givers: rows.length, kind: x.tier === 2 ? 'function_call' : 'transfer', partner: Boolean(partner) })
    }
    return res
  }

  /** `pay`: every planned payout of round r becomes a DAO proposal; tier 1 is voted at once. */
  file(r, t, mode) {
    for (const id of this.log(r).payouts) {
      const x = this.hat.payouts[id]
      if (x.status !== 'planned') continue
      const m = this.meta.get(id)
      const kind =
        x.tier === 2
          ? { FunctionCall: { receiver_id: MOCK_IDS.token, actions: [{ method_name: 'ft_transfer', args: b64(JSON.stringify({ amount: s(x.amount), receiver_id: x.receiver })), deposit: '1', gas: '15000000000000' }] } }
          : { Transfer: { token_id: MOCK_IDS.token, receiver_id: x.receiver, amount: s(x.amount), msg: null } }
      const p = this.newProposal({ proposer: MOCK_IDS.contract, description: proposalText({ round: r, points: x.points, givers: m.givers, receiver: x.receiver, tier: x.tier }), kind, at: t })
      m.proposal = p.id
      m.filedAt = t
      x.status = 'filed'
      const k = id % 3
      if (x.tier === 1) {
        this.vote(id, MOCK_IDS.contract, 'Approve')
        if (mode === 'past') this.check(id)
        else this.at(t + this.delays.t1, () => this.check(id))
      } else if (mode === 'past') {
        this.decide(id, k)
      } else {
        const base = mode === 'boot' ? this.t0 : t
        const stagger = (this.log(r).payouts.indexOf(id) % 5) * 1500
        if (x.tier === 2) this.at(base + this.delays.t2 + stagger, () => this.decide(id, k, 1))
        else {
          this.at(base + this.delays.t3a + stagger, () => this.decide(id, k, 1))
          this.at(base + this.delays.t3b + stagger, () => this.decide(id, (k + 1) % 3, 2))
        }
      }
    }
  }

  /** A house council member votes by the published rule (`step` 2 is the second tier-3 vote). */
  decide(id, k, step = 0) {
    const x = this.hat.payouts[id]
    const m = this.meta.get(id)
    const ok = x.tier === 2 ? !m.partner : m.givers >= 3
    const voter = COUNCIL[k]
    this.vote(id, voter, ok ? 'Approve' : 'Reject')
    if (x.tier === 3 && step === 0) this.vote(id, COUNCIL[(k + 1) % 3], ok ? 'Approve' : 'Reject')
    this.check(id)
  }

  /** A vote in the DAO; the proposal passes or fails as the demo policy says. */
  vote(id, voter, v) {
    const x = this.hat.payouts[id]
    const p = this.dao.proposals.get(this.meta.get(id).proposal)
    if (p.status !== 'InProgress') return
    p.votes[voter] = v
    this.countVotes(p)
    const c = (p.vote_counts.council ?? ['0', '0', '0']).map(Number)
    const need = x.tier === 3 ? 2 : 1
    if (voter === MOCK_IDS.contract && x.tier === 1) p.status = 'Approved'
    else if (c[0] >= need) p.status = 'Approved'
    else if (c[1] >= need) p.status = 'Rejected'
    if (p.status === 'Approved') {
      this.dao.balance -= x.amount
      this.tusd.set(MOCK_IDS.dao, this.dao.balance)
      this.tusd.set(x.receiver, (this.tusd.get(x.receiver) ?? 0n) + x.amount)
      if (x.status === 'filed') x.status = 'approved'
    }
  }

  /** `check_payout`: the contract reads the proposal and records the outcome (strike on reject). */
  check(id) {
    const x = this.hat.payouts[id]
    const p = this.dao.proposals.get(this.meta.get(id).proposal)
    if (p.status === 'Approved') this.hat.resolve(x.round, x.receiver, 'paid')
    else if (p.status === 'Rejected') this.hat.resolve(x.round, x.receiver, 'rejected')
  }

  // -- a guest --
  guestAct(guest, action) {
    const t = this.now()
    const r = this.clock(t)
    let parsed
    try {
      parsed = JSON.parse(action)
    } catch {
      throw new Error('malformed action')
    }
    const [name] = Object.keys(parsed)
    const body = parsed[name]
    const fail = (error) => ({ ok: false, error, round: r })
    if (body.round !== r) return fail(`the action is for round ${body.round}, but this is round ${r}`)
    const log = this.log(r)
    const note = name === 'note' ? body.text : name === 'join' ? body.note : null
    if (note != null && new TextEncoder().encode(note).length > Number(this.cfg.note_max_bytes)) return fail(`a note is at most ${this.cfg.note_max_bytes} bytes`)
    if (name === 'allocate') {
      const err = checkGifts(this.cfg, guest, body.gifts, { members: this.membersAt(r), seats: log.seats, guest: true })
      if (err) return fail(err)
    } else if (name !== 'join' && name !== 'note') throw new Error('malformed action')
    if (!log.seats.includes(guest)) {
      if (log.seats.length >= Number(this.cfg.guest_seats)) return fail(`all ${this.cfg.guest_seats} guest seats of round ${r} are taken`)
      log.seats.push(guest)
    }
    if (note) this.note(r, guest, note)
    if (name === 'allocate') this.allocate(r, guest, body.gifts.map(([a, n]) => [a, Number(n)]))
    if (log.notes.has(guest) && log.allocs.has(guest)) this.welcome(r, guest)
    return { ok: true, error: null, round: r }
  }

  /** House members who already gave this round update their thanks for a newly qualified guest. */
  welcome(r, guest) {
    const log = this.log(r)
    if (log.welcomed?.has(guest)) return
    log.welcomed = log.welcomed ?? new Set()
    log.welcomed.add(guest)
    const [lo, hi] = this.delays.welcome
    for (const p of this.people) {
      if (p.kind === 'free_rider' || p.from > r || !log.allocs.has(p.account)) continue
      const g = this.rand('welcome', p.name, guest)
      this.at(this.now() + lo + g() * (hi - lo), () => {
        if (this.clock() === r && !log.closed) this.allocate(r, p.account, this.houseGifts(p, r))
      })
    }
  }

  // -- views, in the contract's JSON --
  payoutView(id) {
    const x = this.hat.payouts[id]
    const m = this.meta.get(id)
    return { id, round: x.round, receiver: x.receiver, amount: s(x.amount), tier: x.tier, status: x.status, dao_proposal: m.proposal, kind: m.kind, points: s(x.points), givers: m.givers }
  }

  stateView() {
    const t = this.now()
    const round = this.clock(t)
    let due = 0
    while (this.roundEnd(this.closedUpTo + due + 1) <= t) due++
    const by = (st) => this.hat.payouts.filter((x) => x.status === st).length
    const sum = (st) => s(this.hat.payouts.filter((x) => x.status === st).reduce((a, x) => a + x.amount, 0n))
    const t2 = this.hat.totals
    const pointsTotal = [...this.logs.values()].reduce((a, l) => a + l.points.reduce((b, [, p]) => b + p, 0n), 0n)
    return {
      name: 'Hat Tip',
      round,
      round_ends_ms: this.roundEnd(round),
      oldest_unclosed: this.closedUpTo + 1,
      due,
      closing: null,
      members: this.membersAt(round), // the house script syncs when the DAO adds a member
      council: [...COUNCIL],
      guests_seated: [...this.log(round).seats],
      paused: false,
      pause_reason: null,
      last_sync_ms: this.lastSync,
      bond: BOND,
      proposal_period_ns: '86400000000000',
      planned: by('planned'),
      open_payouts: by('filing') + by('filed') + by('approved'),
      next_payout: this.hat.payouts.length,
      oldest_payout: 0,
      totals: {
        rounds_closed: this.closedUpTo,
        budgets: s(t2.budget),
        planned: s(t2.planned),
        carry: s(this.hat.carryTotal()),
        lapsed: s(t2.lapsed),
        dust: s(t2.dust),
        points: s(pointsTotal),
        attributed: s(pointsTotal),
        paid: sum('paid'),
        rejected: sum('rejected'),
        expired: sum('expired'),
        removed: sum('removed'),
        failed: sum('failed'),
        strikes: this.hat.strikes.length,
        by_status: ['planned', 'filing', 'filed', 'approved', 'paid', 'rejected', 'expired', 'removed', 'failed'].map(by),
      },
    }
  }

  roundView(n) {
    const clock = this.clock()
    if (!Number.isInteger(n) || n < 1 || n > Math.max(clock, this.closedUpTo)) return null
    const l = this.log(n)
    const open = !l.closed
    const gifts = open
      ? [...l.allocs.keys()].sort(cmp).flatMap((g) => l.allocs.get(g).map(([r, t]) => [g, r, t, '0']))
      : l.gifts.map(([g, r, t, c]) => [g, r, t, s(c)])
    return {
      n,
      closed: !open,
      starts_ms: this.roundStart(n),
      ends_ms: this.roundEnd(n),
      dao_balance: s(l.daoBalance),
      budget: s(l.budget),
      dust: s(l.dust),
      notes: [...l.notes].sort((a, b) => cmp(a[0], b[0])),
      seats: [...l.seats],
      gifts,
      points: l.points.filter(([, p]) => p > 0n).map(([a, p]) => [a, s(p)]),
      payouts: [...l.payouts],
    }
  }

  memberView(account) {
    const rep = this.hat.rep.get(account) ?? 0n
    const lim = limitsFor(this.cfg, account, rep)
    const carry = this.hat.carry.get(account)
    const hist = [...(this.hat.hist.get(account) ?? new Map())].sort((a, b) => a[0] - b[0])
    return {
      account,
      kind: namedMembers(this.membersAt(this.clock())).has(account) ? 'member' : isImplicit(account) ? 'guest' : 'other',
      reputation: s(rep),
      carry: s(carry ? carry[0] : 0n),
      carry_since: carry ? carry[1] : 0,
      limits: { auto: s(lim.auto), cosign: s(lim.cosign), reputation: s(rep) },
      strikes: this.hat.strikes.filter((x) => x.account === account).length,
      open_payouts: this.hat.payouts.filter((x) => x.receiver === account && ['planned', 'filing', 'filed', 'approved'].includes(x.status)).length,
      history: hist.map(([round, points]) => ({ round, points: s(points), givers: this.log(round).gifts.filter((g) => g[1] === account).map(([g, , t, c]) => [g, t, s(c)]) })),
      payouts: this.hat.payouts.filter((x) => x.receiver === account).map((x) => this.payoutView(x.id)),
    }
  }

  auditView() {
    const t = this.hat.totals
    const all = this.hat.payouts
    const rounds = [...this.logs.values()].filter((l) => l.closed)
    const attributed = rounds.every((l) => l.points.every(([a, p]) => l.gifts.filter((g) => g[1] === a).reduce((x, g) => x + g[3], 0n) === p))
    return {
      balanced: this.hat.audit(),
      points_attributed: attributed,
      statuses_ok: true,
      filed_have_ids: all.every((x) => x.status === 'planned' || this.meta.get(x.id).proposal !== null),
      carry_ok: true,
      budgets: s(t.budget),
      planned: s(t.planned),
      carry: s(this.hat.carryTotal()),
      lapsed: s(t.lapsed),
      dust: s(t.dust),
      payouts: all.length,
      by_status: ['planned', 'filing', 'filed', 'approved', 'paid', 'rejected', 'expired', 'removed', 'failed'].map((st) => [st, all.filter((x) => x.status === st).length]),
    }
  }

  policyView() {
    const members = this.membersAt(this.clock())
    return {
      roles: [
        {
          name: 'council',
          kind: { Group: [...COUNCIL] },
          permissions: ['transfer:AddProposal', 'config:AddProposal', 'policy:AddProposal', 'policy_add_or_update_role:AddProposal', 'policy_remove_role:AddProposal', 'policy_update_default_vote_policy:AddProposal', 'policy_update_parameters:AddProposal', 'add_member_to_role:AddProposal', 'remove_member_from_role:AddProposal', 'factory_info_update:AddProposal', 'vote:AddProposal', '*:VoteApprove', '*:VoteReject', '*:VoteRemove', '*:Finalize'],
          vote_policy: { call: { weight_kind: 'RoleWeight', quorum: '0', threshold: '1' } },
        },
        {
          name: 'thanks',
          kind: { Group: [MOCK_IDS.contract] },
          permissions: ['transfer:AddProposal', 'transfer:VoteApprove', 'call:AddProposal', 'transfer:Finalize', 'call:Finalize'],
          vote_policy: { transfer: { weight_kind: 'RoleWeight', quorum: '0', threshold: [1, 1] } },
        },
        { name: 'members', kind: { Group: members }, permissions: [], vote_policy: {} },
      ],
      default_vote_policy: { weight_kind: 'RoleWeight', quorum: '0', threshold: [1, 2] },
      proposal_bond: BOND,
      proposal_period: '86400000000000',
      bounty_bond: '1000000000000000000000000',
      bounty_forgiveness_period: '86400000000000',
    }
  }
}

function b64(text) {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return globalThis.btoa(bin)
}

const clone = (v) => JSON.parse(JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? x.toString() : x)))
const later = (v, ms = 120) => new Promise((res) => setTimeout(() => res(clone(v)), ms))

/** The page's client, against the world above. Same methods and shapes as Client in chain.js. */
export class MockClient {
  constructor({ world, now, roundMs, at, seed, latencyMs = 90 } = {}) {
    this.mock = true
    this.world = world ?? new MockWorld({ now, roundMs, at, seed })
    this.latency = latencyMs
    this.contract = MOCK_IDS.contract
    this.gasAccount = MOCK_IDS.gasAccount
    this.codeHash = MOCK_IDS.codeHash
    this.tokenCodeHash = MOCK_IDS.tokenCodeHash
    this.house = this.world.house
    this.identity = null
    this.txs = []
    this.onTx = null
    this.canAct = true
    this.rpcHost = 'mock (this tab)'
    this.r = rng(hash32(`mock tx ${this.world.seed}`))
    this.nonce = 0
  }

  read(fn) {
    try {
      this.world.tick()
      return later(fn(), this.latency)
    } catch (e) {
      return Promise.reject(e)
    }
  }

  config() {
    return this.read(() => this.world.cfg)
  }
  state() {
    return this.read(() => this.world.stateView())
  }
  round(n) {
    return this.read(() => this.world.roundView(Number(n)))
  }
  member(account) {
    return this.read(() => this.world.memberView(account))
  }
  payouts(from, limit) {
    return this.read(() => {
      const all = this.world.hat.payouts
      return all.slice(from, from + Math.min(limit, 100)).map((x) => this.world.payoutView(x.id))
    })
  }
  audit() {
    return this.read(() => this.world.auditView())
  }
  policy() {
    return this.read(() => this.world.policyView())
  }
  /** One DAO proposal, or null if the DAO deleted it (as get_proposals answers). */
  proposal(id) {
    return this.read(() => this.world.dao.proposals.get(Number(id)) ?? null)
  }
  proposals(from, limit) {
    return this.read(() => [...this.world.dao.proposals.values()].filter((p) => p.id >= from && p.id < from + limit))
  }
  tiers(account) {
    return this.read(() => this.world.memberView(account).limits)
  }
  daoBalance() {
    return this.read(() => s(this.world.dao.balance))
  }
  balanceOf(account) {
    return this.read(() => s(this.world.tusd.get(account) ?? 0n))
  }
  accessKeys(account) {
    return this.read(() => {
      if (account !== this.gasAccount) return []
      return ['8vK2', 'Gq7d', '3TfR', 'Wm9x'].map((k) => ({
        public_key: `ed25519:${k}${'MockMockMockMockMockMockMockMockMock'.slice(0, 40)}`,
        access_key: { nonce: 0, permission: { FunctionCall: { allowance: '500000000000000000000000', receiver_id: this.contract, method_names: ['act', 'close_round', 'pay', 'check_payout', 'sync'] } } },
      }))
    })
  }
  viewAccount(account) {
    return this.read(() => ({
      code_hash: account === this.contract ? MOCK_IDS.codeHash : account === MOCK_IDS.token ? MOCK_IDS.tokenCodeHash : account === MOCK_IDS.dao ? MOCK_IDS.daoCodeHash : '11111111111111111111111111111111',
    }))
  }

  async setIdentity(identity) {
    this.identity = identity
    return this.member(identity.account)
  }

  record(kind, failure = null) {
    const entry = { kind, hash: fakeHash(this.r), gas: 3_000_000_000_000 + Math.floor(this.r() * 2e12), at: Date.now(), failure }
    this.txs.unshift(entry)
    this.txs = this.txs.slice(0, 40)
    this.onTx?.(entry)
    return entry
  }

  /** A guest action, as `act` would take it (the signature is made by the page, not checked here). */
  async act(action) {
    if (!this.identity) throw new Error('No key yet.')
    await later(null, 350 + this.latency)
    this.world.tick()
    this.nonce = Math.max(this.nonce + 1, Date.now())
    const out = this.world.guestAct(this.identity.account, action)
    this.record('act')
    return { ...out, nonce: this.nonce }
  }

  /** The mock closes and pays on its own clock, like the house script on testnet. */
  async closeRound() {
    this.world.tick()
    return { closed: 0, last_closed: this.world.closedUpTo, waiting: null, error: null }
  }
  async pay() {
    return { filing: [], error: null }
  }
  async checkPayout(id) {
    this.world.tick()
    return { payout: id, status: this.world.hat.payouts[id]?.status ?? 'planned', changed: false }
  }
}
