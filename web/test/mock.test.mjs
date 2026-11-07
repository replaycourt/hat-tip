// Mock mode plays a full round without any chain: a live round with house members and a guest,
// the close, payouts in all three tiers filed as DAO proposals, tier 1 paid at once, tier 2 on one
// council vote, tier 3 on two, a strike for a rejected payout, and the guest paid in tUSD.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as L from '../js/logic.js'
import { BEHAVIOUR, MOCK_IDS, MockClient, MockWorld, mockConfig, splitThanks, COUNCIL_PARTNER_MIN } from '../js/mock.js'
import * as N from '../js/near.js'

const ROUND = 180_000
function world(at = 0.6) {
  const clock = { t: 1_900_000_000_000 }
  const w = new MockWorld({ now: () => clock.t, roundMs: ROUND, at })
  const advance = (ms) => {
    clock.t += ms
    w.tick()
  }
  return { w, clock, advance }
}
const tiersOf = (w, r) => new Set(w.log(r).payouts.map((id) => w.hat.payouts[id].tier))
const statusOf = (w, id) => w.hat.payouts[id].status

test('at load, the last closed round has payouts in all three tiers, in the DAO', () => {
  const { w } = world()
  const last = w.closedUpTo
  assert.equal(last, w.H)
  assert.deepEqual([...tiersOf(w, last)].sort(), [1, 2, 3])
  for (const id of w.log(last).payouts) {
    const x = w.hat.payouts[id]
    const p = w.dao.proposals.get(w.meta.get(id).proposal)
    assert.ok(p, 'every payout is a DAO proposal')
    assert.equal(p.proposer, MOCK_IDS.contract)
    assert.ok(x.tier === 2 ? 'FunctionCall' in p.kind : 'Transfer' in p.kind, 'tier 2 is an ft_transfer call, tiers 1 and 3 transfers')
    if (x.tier === 1) assert.equal(x.status, 'paid', 'tier 1 executes at once')
    else assert.equal(x.status, 'filed', 'tiers 2 and 3 wait for the council')
  }
  assert.ok(w.hat.audit())
})

test('house council votes: one vote passes or vetoes tier 2, tier 3 needs two', () => {
  const { w, advance } = world()
  const ids = w.log(w.H).payouts
  const t3 = ids.filter((id) => w.hat.payouts[id].tier === 3)
  advance(w.delays.t3a + 6100) // after the first vote (staggered up to 6 s), before the second
  for (const id of t3) {
    const p = w.dao.proposals.get(w.meta.get(id).proposal)
    assert.equal(Object.keys(p.votes).length, 1)
    assert.equal(p.status, 'InProgress', 'one council vote does not pass tier 3')
  }
  advance(40_000)
  for (const id of ids) assert.ok(L.isFinal(statusOf(w, id)), `payout ${id} decided`)
  for (const id of ids.filter((i) => w.hat.payouts[i].tier === 2)) {
    const p = w.dao.proposals.get(w.meta.get(id).proposal)
    assert.equal(Object.keys(p.votes).length, 1, 'tier 2: exactly one council vote')
    assert.equal(statusOf(w, id), w.meta.get(id).partner ? 'rejected' : 'paid', 'rejected only when mostly from one reciprocal partner')
  }
  for (const id of t3) assert.equal(Object.keys(w.dao.proposals.get(w.meta.get(id).proposal).votes).length, 2)
})

test('a full live round: a guest gives, is welcomed, and is paid after one council vote', async () => {
  const { w, clock, advance } = world(0.5)
  const r = w.H + 1
  const c = new MockClient({ world: w, latencyMs: 0 })
  const key = await N.newKey()
  const me = N.implicitAccount(key)
  await c.setIdentity({ key, account: me })
  const st = await c.state()
  assert.equal(st.round, r)
  assert.ok(st.members.includes('ivy.repair-cafe.testnet'), 'the newcomer synced at the start of the round')
  const out1 = await c.act(L.joinAction(r, 'brought cake for the volunteers'))
  assert.equal(out1.ok, true)
  const gifts = [['ana.repair-cafe.testnet', 25], ['ivy.repair-cafe.testnet', 25], ['emil.repair-cafe.testnet', 25], ['dina.repair-cafe.testnet', 25]]
  const out2 = await c.act(L.allocateAction(r, gifts))
  assert.equal(out2.ok, true)
  assert.ok(out2.nonce > out1.nonce)
  assert.equal(c.txs.length, 2)
  assert.deepEqual(w.log(r).seats, [me])
  // refusals come back as ok:false, the contract's words
  assert.equal((await c.act(L.allocateAction(r, [[me, 5]]))).error, 'no thanks to yourself')
  assert.equal((await c.act(L.allocateAction(r, [['ana.repair-cafe.testnet', 26]]))).error, 'each gift is 1 to 25 thanks')
  assert.match((await c.act(L.allocateAction(r + 1, gifts))).error, /but this is round/)
  // the house welcome: members who already gave add 5 thanks for the guest
  advance(w.delays.welcome[1] + 100)
  const rv = await c.round(r)
  const toMe = rv.gifts.filter((g) => g[1] === me)
  assert.ok(toMe.length >= 1 && toMe.every((g) => g[2] === 5), 'house members thank the guest 5 each')
  // what the page previews just before the close is what the close plans
  clock.t = w.roundEnd(r) - 1
  w.tick()
  const st2 = await c.state()
  const people = new Map(await Promise.all([...st2.members, me].map(async (a) => [a, await c.member(a)])))
  const open = await c.round(r)
  const pv = L.previewRound(w.cfg, {
    round: r,
    members: st2.members,
    seats: open.seats,
    allocations: L.giftsByGiver(open.gifts),
    limits: new Map([...people].map(([a, m]) => [a, { auto: BigInt(m.limits.auto), cosign: BigInt(m.limits.cosign) }])),
    carry: new Map([...people].filter(([, m]) => BigInt(m.carry) > 0n).map(([a, m]) => [a, [BigInt(m.carry), m.carry_since]])),
    daoBalance: BigInt(await c.daoBalance()),
    owed: L.owedOf(st2.totals),
  })
  // the close
  advance(w.delays.close + w.delays.file + 50)
  assert.equal(w.closedUpTo, r)
  const planned = w.log(r).payouts.map((id) => w.hat.payouts[id])
  assert.deepEqual(planned.map((x) => [x.receiver, x.amount, x.tier]), pv.planned.map((x) => [x.receiver, x.amount, x.tier]), 'preview equals close')
  assert.deepEqual([...tiersOf(w, r)].sort(), [1, 2, 3])
  const mine = planned.find((x) => x.receiver === me)
  assert.ok(mine, 'the guest has a payout')
  assert.equal(mine.tier, 2, 'a guest is never in tier 1')
  assert.ok(mine.amount >= BigInt(w.cfg.min_payout))
  for (const x of planned) assert.ok(x.tier === 1 ? x.status === 'approved' || x.status === 'paid' : x.status === 'filed')
  assert.equal(await c.balanceOf(me), '0')
  advance(60_000)
  assert.equal(mine.status, 'paid')
  assert.equal(await c.balanceOf(me), String(mine.amount), 'the tUSD is in the browser account')
  for (const x of planned) assert.ok(L.isFinal(x.status))
  const view = await c.member(me)
  assert.equal(view.kind, 'guest')
  assert.equal(view.payouts.at(-1).status, 'paid')
  assert.ok(view.history.some((h) => h.round === r && h.givers.every(([, given]) => given === 5)))
})

test('the books balance and every point has its giver, across rounds', async () => {
  const { w, advance } = world(0.9)
  for (let i = 0; i < 4; i++) advance(ROUND)
  const c = new MockClient({ world: w, latencyMs: 0 })
  const a = await c.audit()
  assert.equal(a.balanced, true)
  assert.equal(a.points_attributed, true)
  assert.equal(a.filed_have_ids, true)
  assert.equal(BigInt(a.budgets), BigInt(a.planned) + BigInt(a.carry) + BigInt(a.lapsed) + BigInt(a.dust))
  for (let n = 1; n <= w.closedUpTo; n++) {
    const rv = await c.round(n)
    assert.equal(rv.closed, true)
    const sum = rv.gifts.reduce((s, g) => s + BigInt(g[3]), 0n)
    assert.equal(sum, rv.points.reduce((s, p) => s + BigInt(p[1]), 0n), `round ${n}`)
  }
  // a member's record: limits come from the reputation, every history row from its round
  const m = await c.member('ana.repair-cafe.testnet')
  const lim = L.limitsFor(w.cfg, m.account, BigInt(m.reputation))
  assert.deepEqual([m.limits.auto, m.limits.cosign], [String(lim.auto), String(lim.cosign)])
  for (const h of m.history.slice(-5)) assert.equal(h.givers.reduce((s, g) => s + BigInt(g[2]), 0n), BigInt(h.points))
})

test('the mock speaks the contract and DAO shapes', async () => {
  const { w } = world()
  const c = new MockClient({ world: w, latencyMs: 0 })
  const st = await c.state()
  for (const k of ['round', 'round_ends_ms', 'oldest_unclosed', 'due', 'members', 'council', 'guests_seated', 'paused', 'bond', 'planned', 'open_payouts', 'next_payout', 'totals']) assert.ok(k in st, k)
  const cfg = await c.config()
  assert.equal(cfg.dao, MOCK_IDS.dao)
  const report = L.policyReport(await c.policy(), { contract: c.contract })
  assert.ok(report.ok, 'the stand-in DAO has the demo policy')
  const p = (await c.payouts(0, 5))[0]
  for (const k of ['id', 'round', 'receiver', 'amount', 'tier', 'status', 'dao_proposal', 'kind', 'points', 'givers']) assert.ok(k in p, k)
  const prop = await c.proposal(p.dao_proposal)
  assert.equal(L.proposalInfo(prop).receiver, p.receiver)
  assert.equal(await c.proposal(99_999), null, 'a deleted proposal reads as null')
  const range = await c.proposals(p.dao_proposal, 3)
  assert.deepEqual(range.map((x) => x.id), [p.dao_proposal, p.dao_proposal + 1, p.dao_proposal + 2])
  assert.deepEqual(await c.tiers(p.receiver), (await c.member(p.receiver)).limits)
  for (const k of ['rounds_closed', 'budgets', 'planned', 'carry', 'lapsed', 'dust', 'points', 'attributed', 'paid', 'rejected', 'expired', 'removed', 'failed', 'strikes', 'by_status']) assert.ok(k in st.totals, `totals.${k}`)
  // a tier-2 proposal is the contract's ft_transfer call, as filed (contract/README.md, "The proposals")
  const call = [...w.dao.proposals.values()].find((x) => x.kind.FunctionCall)
  const act = call.kind.FunctionCall.actions[0]
  assert.deepEqual([act.method_name, act.deposit, act.gas], ['ft_transfer', '1', '15000000000000'])
  assert.deepEqual(Object.keys(JSON.parse(Buffer.from(act.args, 'base64').toString())), ['amount', 'receiver_id'])
  assert.match(call.description, /^Hat Tip r\d+: [\d.]+ thanks from \d+ -> .+ \(one council vote\)$/)
  assert.deepEqual(await c.accessKeys(c.contract), [], 'the contract has no keys')
  const relay = await c.accessKeys(c.gasAccount)
  assert.ok(relay.every((k) => k.access_key.permission.FunctionCall.receiver_id === c.contract))
  assert.equal((await c.viewAccount(c.contract)).code_hash, c.codeHash)
  assert.equal(await c.round(0), null)
  assert.equal(await c.round(st.round + 1), null)
})

test('splitThanks gives whole numbers, at most the cap, summing to the total', () => {
  const s = splitThanks(100, [['a', 5], ['b', 1], ['c', 1]], 40)
  assert.deepEqual(s, [['a', 40], ['b', 30], ['c', 30]])
  const t = splitThanks(100, [['a', 9], ['b', 1]], 40)
  assert.equal(t.reduce((a, [, n]) => a + n, 0), 80, 'two receivers take at most twice the cap; the rest lapses')
  const u = splitThanks(97, [['a', 3], ['b', 2], ['c', 2], ['d', 1]], 40)
  assert.equal(u.reduce((a, [, n]) => a + n, 0), 97)
  assert.ok(u.every(([, n]) => n >= 1 && n <= 40))
  assert.deepEqual(splitThanks(10, [], 40), [])
})

const PARAMS = fileURLToPath(new URL('../../sim/params.json', import.meta.url))

test('the mock plays the launch parameters and the published house of sim/params.json', { skip: !existsSync(PARAMS) && 'no sim/params.json' }, () => {
  const p = JSON.parse(readFileSync(PARAMS, 'utf8'))
  const mine = mockConfig({ roundMs: 1, genesisMs: 1 })
  for (const [k, v] of Object.entries(p.testnet.config)) {
    if (v === null || k === 'round_ms') continue
    assert.deepEqual(mine[k], v, k)
  }
  for (const [k, v] of Object.entries(BEHAVIOUR)) assert.equal(p.house.behaviour[k], v, k)
  assert.equal(COUNCIL_PARTNER_MIN, p.house.council_rule.partner_min, 'the council rule of the mock is the published one')
  const { w } = world()
  const house = new Map(w.people.map((x) => [x.name, x]))
  for (const m of p.house.members) {
    assert.equal(house.get(m.name)?.kind, m.kind, m.name)
    assert.equal(house.get(m.name).items, m.parameters.items_mean, m.name)
    if (m.parameters.partner) assert.equal(house.get(m.name).partner, m.parameters.partner)
  }
  const n = p.house.optional_newcomer
  assert.equal(house.get(n.name)?.items, n.parameters.items_mean, 'the optional newcomer joins in the live round')
  assert.deepEqual(Object.entries(w.house).filter(([, k]) => k === 'council').map(([a]) => a.split('.')[0]), p.house.council.map((c) => c.name))
})
