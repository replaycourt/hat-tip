// The page's pure logic: counting and its explanations, the live preview (it must equal the close),
// tiers, giving, signing text, the DAO policy checks, proposals, records and formatting.
// The full close is checked against the simulation's golden vectors in golden.test.mjs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as L from '../js/logic.js'

const U = (whole) => String(Math.round(whole * 1_000_000))
const CFG = {
  dao: 'cafe.sputnikv2.testnet',
  token: 'tusd.testnet',
  members_role: 'members',
  council_role: 'council',
  thanks_role: 'thanks',
  genesis_ms: 1_800_000_000_000,
  round_ms: 1_200_000,
  thanks_per_round: 100,
  cap_per_receiver: 40,
  max_receivers: 10,
  reciprocal_bp: 5000,
  quadratic: false,
  breadth_k: 0,
  breadth_bp: 10000,
  idle_bp: 5000,
  decay_bp: 500,
  round_budget: U(100),
  min_payout: U(2),
  carry_rounds: 12,
  reserve: '0',
  auto_rep_min: 200,
  auto_per_thanks: U(0.02),
  auto_max: U(16),
  cosign_base: U(8),
  cosign_per_thanks: U(0.05),
  cosign_max: U(40),
  auto_share_bp: 6000,
  guest_seats: 6,
  guest_weight_bp: 5000,
  guest_cap_bp: 2000,
  max_members: 24,
  max_catchup: 36,
  log_keep: 108,
  note_max_bytes: 80,
}
const A = 'ana.cafe.testnet'
const B = 'ben.cafe.testnet'
const C = 'cleo.cafe.testnet'
const F = 'finn.cafe.testnet'
const G = 'gus.cafe.testnet'
const GUEST = 'a'.repeat(64)
const MEMBERS = [A, B, C, F, G]

test('isqrt is the exact floor square root', () => {
  for (const n of [0n, 1n, 2n, 3n, 4n, 15n, 16n, 17n, 99_999_999n, 10n ** 30n + 7n, 123_456_789_012_345_678_901n]) {
    const r = L.isqrt(n)
    assert.ok(r * r <= n && (r + 1n) * (r + 1n) > n, String(n))
  }
  assert.throws(() => L.isqrt(-1n))
})

test('implicit and 0x accounts in the members role are not members', () => {
  const m = L.namedMembers([A, GUEST, '0x' + 'ab'.repeat(20), B])
  assert.deepEqual([...m].sort(), [A, B])
  assert.ok(L.isImplicit(GUEST) && !L.isImplicit(A))
})

test('a colluding pair: they thanked each other 40, counted 20 each (DESIGN.md example)', () => {
  const cnt = L.countRound(CFG, new Set(MEMBERS), new Set(), new Map([[F, [[G, 40]]], [G, [[F, 40]]], [A, [[F, 10], [B, 30]]]]))
  const row = (g, r) => cnt.rows.find((x) => x.giver === g && x.receiver === r)
  assert.equal(row(F, G).counted, 20_000n)
  assert.equal(row(G, F).counted, 20_000n)
  assert.equal(row(A, F).counted, 10_000n, 'one-way thanks count in full')
  // B gave nothing: idle, counted at half
  assert.equal(row(A, B).counted, 15_000n)
  const ex = L.explainReceiver(CFG, cnt, G)
  assert.deepEqual(ex.reasons.map((r) => r.kind), ['mutual'])
  assert.equal(L.reasonText(ex.reasons[0], L.displayName), 'Thanked each other 40 with Finn: counted 20 each way.')
  const idle = L.explainReceiver(CFG, cnt, B).reasons[0]
  assert.equal(L.reasonText(idle, L.displayName), 'Gave no thanks this round: thanks received count 50 %.')
  assert.equal(L.reasonText(idle, L.displayName, { open: true }), 'Has not given thanks yet: thanks received count 50 % until they do.')
  // every point belongs to one giver
  for (const [acc, p] of cnt.points) assert.equal(p, cnt.rows.filter((r) => r.receiver === acc).reduce((a, r) => a + r.counted, 0n))
})

test('guest thanks weigh guest_weight_bp, and all guests together at most guest_cap_bp', () => {
  const alloc = new Map([[A, [[B, 10]]], [GUEST, [[B, 40], [C, 40]]]])
  const cnt = L.countRound(CFG, new Set(MEMBERS), new Set([GUEST]), alloc)
  // members 10,000; guests 40,000 at 50 % -> 40,000 weight; cap 20 %: G*(8000) > M*2000 -> scaled
  assert.equal(cnt.membersWeight, 10_000n)
  assert.equal(cnt.guestsWeight, 40_000n)
  assert.ok(cnt.guestScaled)
  const g = cnt.rows.filter((r) => r.giver === GUEST)
  assert.deepEqual(g.map((r) => r.weight), [1250n, 1250n], 'guests steer 2,500 of 12,500 = 20 %')
  const reason = L.explainReceiver(CFG, cnt, C).reasons.find((r) => r.kind === 'guest')
  assert.match(L.reasonText(reason, (a) => L.displayName(a, GUEST)), /^You gave as a guest: guest thanks count 50 %, and all guests together at most 20 % of the round\.$/)
  // guest to guest is dropped
  const two = L.countRound(CFG, new Set(MEMBERS), new Set([GUEST, 'b'.repeat(64)]), new Map([[GUEST, [['b'.repeat(64), 5]]]]))
  assert.deepEqual(two.dropped, [[GUEST, 'b'.repeat(64), 5, 'guest to guest']])
})

test("guests together receive at most guest_receive_cap_bp (the contract's math.rs example)", () => {
  const g2 = 'b'.repeat(64)
  const g3 = 'c'.repeat(64)
  const cfg = { ...CFG, reciprocal_bp: 10000, idle_bp: 10000 }
  // Member A sends 90 thanks to three guests and 10 to member B; a guest thanks A.
  const alloc = new Map([[A, [[GUEST, 30], [g2, 30], [g3, 30], [B, 10]]], [GUEST, [[A, 10]]]])
  const seats = new Set([GUEST, g2, g3])
  const by = (cnt) => [[A, GUEST], [A, g2], [A, g3], [A, B], [GUEST, A]].map(([g, r]) => cnt.rows.find((x) => x.giver === g && x.receiver === r).counted)
  const open = L.countRound(cfg, new Set([A, B]), seats, alloc)
  assert.deepEqual(by(open), [30_000n, 30_000n, 30_000n, 10_000n, 5_000n])
  assert.equal(open.receiveScaled, false, 'off by default (10,000)')
  const capped = L.countRound({ ...cfg, guest_receive_cap_bp: 2000 }, new Set([A, B]), seats, alloc)
  assert.deepEqual(by(capped), [1_250n, 1_250n, 1_250n, 10_000n, 5_000n])
  assert.ok(capped.receiveScaled)
  const why = L.explainReceiver({ ...cfg, guest_receive_cap_bp: 2000 }, capped, g2).reasons.map((r) => L.reasonText(r))
  assert.deepEqual(why, ['Guests together receive at most 20 % of a round’s thanks: scaled down to that.'])
  assert.deepEqual(by(L.countRound({ ...cfg, guest_receive_cap_bp: 9000 }, new Set([A, B]), seats, alloc)), by(open), 'not binding: unchanged')
})

test('limits: none automatic for guests or below auto_rep_min; both capped', () => {
  assert.deepEqual(L.limitsFor(CFG, A, 0n), { auto: 0n, cosign: 8_000_000n })
  assert.deepEqual(L.limitsFor(CFG, A, 199_999n), { auto: 0n, cosign: 17_950_000n })
  assert.deepEqual(L.limitsFor(CFG, A, 200_000n), { auto: 4_000_000n, cosign: 18_000_000n })
  assert.deepEqual(L.limitsFor(CFG, A, 5_000_000n), { auto: 16_000_000n, cosign: 40_000_000n })
  assert.equal(L.limitsFor(CFG, GUEST, 5_000_000n).auto, 0n)
  assert.equal(L.tierOf(4_000_000n, { auto: 4_000_000n, cosign: 9n }), 1)
  assert.equal(L.tierOf(4_000_001n, { auto: 4_000_000n, cosign: 18_000_000n }), 2)
  assert.equal(L.tierOf(18_000_001n, { auto: 4_000_000n, cosign: 18_000_000n }), 3)
})

test('the round cap moves the largest tier-1 payouts to tier 2 (ties: lower account first)', () => {
  const lim = () => ({ auto: 50_000_000n, cosign: 50_000_000n })
  let plan = L.planPayouts(CFG, new Map([[A, 30_000n], [B, 30_000n], [C, 40_000n]]), 100_000_000n, 5, () => undefined, lim)
  assert.deepEqual(plan.planned.map((x) => [x.receiver, x.amount, x.tier]), [[A, 30_000_000n, 1], [B, 30_000_000n, 1], [C, 40_000_000n, 2]])
  assert.deepEqual(plan.moved, [C], 'at most 60 % of the round without a human')
  plan = L.planPayouts(CFG, new Map([[A, 35_000n], [B, 35_000n], [C, 30_000n]]), 100_000_000n, 5, () => undefined, lim)
  assert.deepEqual(plan.moved, [A, B], 'a tie moves the lower account first')
  assert.equal(plan.dust, 0n)
})

test('small shares are carried and stamped; a later share tops them up', () => {
  const hat = new L.Hat(CFG)
  const r1 = hat.close(1, MEMBERS, [], new Map([[A, [[B, 99], [C, 1]]], [B, [[A, 1]]]]), 1_000_000_000n)
  assert.ok(!r1.empty)
  assert.deepEqual(hat.carry.get(A)?.[1], 1, 'carry stamped with its round')
  assert.ok(hat.audit())
  assert.ok(L.isFinal('paid') && !L.isFinal('filed'))
  const p = hat.payouts.find((x) => x.receiver === B)
  hat.resolve(1, B, 'rejected')
  assert.equal(hat.strikes.length, 1)
  assert.throws(() => hat.resolve(1, B, 'paid'), /already rejected/)
  assert.equal(p.status, 'rejected')
})

test('the preview of a round equals its close when nothing changes before it', () => {
  const hat = new L.Hat(CFG)
  const rounds = [
    new Map([[A, [[B, 40], [C, 30], [F, 30]]], [B, [[A, 40], [C, 40]]], [C, [[A, 20], [B, 20]]], [F, [[G, 40], [A, 10]]], [G, [[F, 40]]]]),
    new Map([[A, [[B, 30], [C, 30]]], [B, [[A, 40], [C, 20], [G, 5]]], [C, [[A, 40], [B, 40]]], [F, [[G, 40]]], [G, [[F, 40]]], [GUEST, [[A, 50], [B, 50]]]]),
  ]
  rounds.forEach((alloc, i) => {
    const r = i + 1
    const seats = i === 1 ? [GUEST] : []
    const limits = new Map([...MEMBERS, GUEST].map((a) => [a, hat.limits(a, hat.rep.get(a) ?? 0n)]))
    const pv = L.previewRound(CFG, { round: r, members: MEMBERS, seats, allocations: alloc, limits, carry: new Map(hat.carry), daoBalance: 500_000_000n })
    const res = hat.close(r, MEMBERS, seats, alloc, 500_000_000n)
    assert.deepEqual(
      pv.planned.map((x) => [x.receiver, x.amount, x.tier]),
      res.payouts.map((x) => [x.receiver, x.amount, x.tier]),
      `round ${r}`,
    )
    assert.equal(pv.dust, res.dust)
    for (const x of res.payouts) assert.equal(pv.byAccount.get(x.receiver).amount, x.amount)
  })
})

test('giving: the draft is clamped by the cap, the total and the receiver count', () => {
  let d = new Map()
  ;({ draft: d } = L.bumpGift(CFG, d, A, 10))
  ;({ draft: d } = L.bumpGift(CFG, d, A, 10))
  assert.equal(d.get(A), 20)
  let r = L.setGift(CFG, d, A, 55)
  assert.equal(r.draft.get(A), 40)
  assert.equal(r.refused, 'at most 40 to one person')
  d = new Map([[A, 40], [B, 40]])
  r = L.bumpGift(CFG, d, C, 30)
  assert.equal(r.draft.get(C), 20)
  assert.equal(r.refused, '100 thanks in all')
  assert.equal(L.draftTotal(r.draft), 100)
  r = L.bumpGift(CFG, r.draft, C, -30)
  assert.ok(!r.draft.has(C), 'zero removes the receiver')
  const ten = new Map(Array.from({ length: 10 }, (_, i) => [`m${i}.testnet`, 1]))
  assert.equal(L.setGift(CFG, ten, 'x.testnet', 5).refused, 'at most 10 people a round')
  assert.deepEqual(L.draftGifts(new Map([[C, 5], [A, 7], [B, 0]])), [[A, 7], [C, 5]])
})

test('checkGifts mirrors the contract refusals', () => {
  const ctx = { members: MEMBERS, seats: [GUEST], guest: true }
  assert.equal(L.checkGifts(CFG, GUEST, [[A, 40], [B, 40], [C, 20]], ctx), null)
  assert.equal(L.checkGifts(CFG, GUEST, [[A, 41]], ctx), 'each gift is 1 to 40 thanks')
  assert.equal(L.checkGifts(CFG, GUEST, [[A, 40], [B, 40], [C, 40]], ctx), 'at most 100 thanks a round')
  assert.equal(L.checkGifts(CFG, GUEST, [[GUEST, 5]], ctx), 'no thanks to yourself')
  assert.equal(L.checkGifts(CFG, GUEST, [['b'.repeat(64), 5]], { ...ctx, seats: [GUEST, 'b'.repeat(64)] }), 'guests give to members only')
  assert.equal(L.checkGifts(CFG, GUEST, [['zed.testnet', 5]], ctx), 'zed.testnet is not a member or a seated guest')
  assert.equal(L.checkGifts(CFG, GUEST, [[A, 5], [A, 5]], ctx), 'one entry per receiver')
})

test('guest actions and the text a browser key signs', () => {
  assert.equal(L.signingText('hattip.testnet', 7, '{"join":{"round":3}}'), 'hattip:v1:hattip.testnet:7:{"join":{"round":3}}')
  assert.equal(L.joinAction(3), '{"join":{"round":3}}')
  assert.equal(L.joinAction(3, 'brought cake'), '{"join":{"round":3,"note":"brought cake"}}')
  assert.equal(L.allocateAction(3, [[A, 40], [B, '60']]), `{"allocate":{"round":3,"gifts":[["${A}",40],["${B}",60]]}}`)
  assert.equal(L.noteAction(3, 'x'), '{"note":{"round":3,"text":"x"}}')
  assert.equal(L.nextNonce(5, 3), 6)
  assert.equal(L.nextNonce(5, 1_800_000_000_000.7), 1_800_000_000_000)
  assert.throws(() => L.nextNonce(Number.MAX_SAFE_INTEGER, 0))
  assert.equal(L.clipNote('café '.repeat(30), 80).length <= 80, true)
  assert.ok(L.utf8Length(L.clipNote('é'.repeat(100), 80)) <= 80)
  assert.equal(L.clipNote('  fixed   two\nkettles ', 80), ' fixed two kettles ')
})

test('the clock counts rounds as the contract does', () => {
  const g = 1_000_000
  assert.equal(L.clockRound(g - 1, g, 100), 0)
  assert.equal(L.clockRound(g, g, 100), 1)
  assert.equal(L.clockRound(g + 99, g, 100), 1)
  assert.equal(L.clockRound(g + 100, g, 100), 2)
  assert.equal(L.roundEndMs(2, g, 100), g + 200)
  assert.equal(L.roundStartMs(2, g, 100), g + 100)
})

// The demo policy of DESIGN.md as get_policy returns it.
const POLICY = {
  roles: [
    {
      name: 'council',
      kind: { Group: ['council-a.cafe.testnet', 'council-b.cafe.testnet', 'council-c.cafe.testnet'] },
      permissions: ['transfer:AddProposal', 'config:AddProposal', 'policy:AddProposal', 'add_member_to_role:AddProposal', 'remove_member_from_role:AddProposal', 'factory_info_update:AddProposal', 'vote:AddProposal', '*:VoteApprove', '*:VoteReject', '*:VoteRemove', '*:Finalize'],
      vote_policy: { call: { weight_kind: 'RoleWeight', quorum: '0', threshold: '1' } },
    },
    { name: 'thanks', kind: { Group: ['hattip.testnet'] }, permissions: ['transfer:AddProposal', 'transfer:VoteApprove', 'call:AddProposal', 'transfer:Finalize', 'call:Finalize'], vote_policy: { transfer: { weight_kind: 'RoleWeight', quorum: '0', threshold: [1, 1] } } },
    { name: 'members', kind: { Group: MEMBERS }, permissions: [], vote_policy: {} },
  ],
  default_vote_policy: { weight_kind: 'RoleWeight', quorum: '0', threshold: [1, 2] },
  proposal_bond: '10000000000000000000000',
  proposal_period: '86400000000000',
}

test('the DAO policy states the three tiers, and every check passes on the demo policy', () => {
  const r = L.policyReport(POLICY, { contract: 'hattip.testnet' })
  assert.ok(r.ok, JSON.stringify(r.checks.filter((c) => !c.ok)))
  assert.deepEqual(r.tiers.map((t) => t.votes), [1, 1, 2])
  assert.match(r.tiers[2].approvedBy, /^2 of 3 council members/)
  assert.deepEqual(r.members, MEMBERS)
  assert.equal(r.council.length, 3)
})

test('the policy checks catch what would break the tiers', () => {
  const clone = () => JSON.parse(JSON.stringify(POLICY))
  const fails = (p, contract = 'hattip.testnet') => L.policyReport(p, { contract }).checks.filter((c) => !c.ok).map((c) => c.label)
  let p = clone()
  p.roles.push({ name: 'all', kind: 'Everyone', permissions: ['*:AddProposal'], vote_policy: {} })
  assert.ok(fails(p).some((l) => /No Everyone role/.test(l)))
  assert.ok(fails(p).some((l) => /Only role thanks may file call/.test(l)))
  p = clone()
  p.roles[0].permissions.push('call:AddProposal')
  assert.deepEqual(fails(p), ['Only role thanks may file call proposals (the tier-2 payouts)'])
  p = clone()
  p.roles[1].permissions.push('call:VoteApprove')
  assert.deepEqual(fails(p), ['The contract cannot vote on call proposals'])
  p = clone()
  p.roles[0].vote_policy.call.threshold = '2'
  assert.deepEqual(fails(p), ['Tier 2: one council vote passes a call proposal'])
  p = clone()
  p.roles[0].vote_policy.transfer = { weight_kind: 'RoleWeight', quorum: '0', threshold: '1' }
  assert.ok(fails(p).some((l) => /Tier 3/.test(l)))
  assert.ok(fails(POLICY, 'other.testnet').some((l) => /holds the contract/.test(l)))
  assert.equal(L.votesNeeded([1, 2], 3), 2)
  assert.equal(L.votesNeeded([1, 2], 4), 3)
  assert.equal(L.votesNeeded('1', 3), 1)
  assert.equal(L.thresholdText([1, 1]), '1 of 1')
  assert.equal(L.thresholdText('1'), '1 vote')
})

test('DAO proposals: transfers and ft_transfer calls read alike; stages read from them', () => {
  const t = L.proposalInfo({ id: 4, status: 'InProgress', description: 'd', kind: { Transfer: { token_id: 'tusd.testnet', receiver_id: A, amount: '5000000' } }, votes: { 'council-b.cafe.testnet': 'Approve' }, submission_time: '1800000000000000000' })
  assert.deepEqual([t.kind, t.receiver, t.amount, t.approvals, t.submittedMs], ['Transfer', A, 5_000_000n, 1, 1_800_000_000_000])
  const args = Buffer.from(JSON.stringify({ receiver_id: GUEST, amount: '6010000' })).toString('base64')
  const c = L.proposalInfo({ id: 5, status: 'Approved', kind: { FunctionCall: { receiver_id: 'tusd.testnet', actions: [{ method_name: 'ft_transfer', args, deposit: '1', gas: '10000000000000' }] } }, votes: { 'council-a.cafe.testnet': 'Approve' } })
  assert.deepEqual([c.kind, c.receiver, c.amount], ['FunctionCall ft_transfer', GUEST, 6_010_000n])
  const name = L.displayName
  assert.equal(L.payoutStage({ status: 'filed', tier: 2 }).text, 'Waiting for one council vote')
  assert.equal(L.payoutStage({ status: 'filed', tier: 3 }, t).text, '1 of 2 council votes')
  assert.equal(L.payoutStage({ status: 'paid', tier: 1 }).text, 'Paid at once')
  assert.equal(L.payoutStage({ status: 'paid', tier: 2 }, c, { name }).text, 'Paid · approved by Council A')
  assert.equal(L.payoutStage({ status: 'rejected', tier: 2 }).state, 'struck')
  assert.equal(L.payoutStage({ status: 'expired', tier: 3 }).state, 'lapsed')
  assert.equal(L.payoutStage({ status: 'planned', tier: 1 }).state, 'waiting')
  assert.equal(L.proposalText({ round: 42, points: 31_500n, givers: 5, receiver: 'ana.repaircafe.testnet', tier: 1 }), 'Hat Tip r42: 31.5 thanks from 5 -> ana.repaircafe.testnet (auto)')
  assert.match(L.proposalText({ round: 42, points: 31_500n, givers: 5, receiver: 'x.testnet', tier: 2 }), / \(one council vote\)$/)
  assert.match(L.proposalText({ round: 42, points: 31_500n, givers: 5, receiver: 'x.testnet', tier: 3 }), / \(council majority\)$/)
})

test('records: a reputation line from points, decay and strikes; ledger rows from round views', () => {
  const s = L.repSeries(CFG, { history: [{ round: 2, points: '10000' }, { round: 4, points: '20000' }], strikes: [{ at: 5, amount: 5000n }], from: 1, to: 5 })
  assert.deepEqual(s.map((x) => x.rep), [0n, 10_000n, 9_500n, 29_025n, 22_573n])
  const rv = { n: 9, closed: true, budget: U(100), dust: '3', gifts: [[A, B, 40, '20000'], [C, B, 10, '10000'], [B, A, 40, '20000']], points: [[A, '20000'], [B, '30000']], payouts: [1, 2] }
  const sm = L.roundSummary(rv, [{ tier: 1, amount: '40000000' }, { tier: 3, amount: '59999997' }])
  assert.deepEqual([sm.givers, sm.receivers, sm.thanks, sm.points, sm.byTier[1].n, sm.byTier[3].n, sm.paid], [3, 2, 90, 50_000n, 1, 1, 99_999_997n])
  assert.deepEqual([...L.giftsByGiver(rv.gifts)], [[A, [[B, 40]]], [C, [[B, 10]]], [B, [[A, 40]]]])
  assert.deepEqual(L.giversOf(rv.gifts, B), [{ giver: A, given: 40, counted: 20_000n }, { giver: C, given: 10, counted: 10_000n }])
})

test('names and numbers on the page', () => {
  assert.equal(L.displayName('ana.cafe.testnet'), 'Ana')
  assert.equal(L.displayName('council-b.cafe.testnet'), 'Council B')
  assert.equal(L.displayName(GUEST), 'Guest aaaa')
  assert.equal(L.displayName(GUEST, GUEST), 'You')
  assert.equal(L.shortAccount(GUEST), 'aaaaaa…aaaa')
  assert.equal(L.shortAccount('finn.repair-cafe.testnet'), 'finn.repair-cafe.testnet')
  assert.equal(L.fmtTusd(1_234_567_890n), '1,234.56')
  assert.equal(L.fmtTusd(0n), '0.00')
  assert.equal(L.fmtTusd(4_000n), '<0.01')
  assert.equal(L.fmtTusd(3n, { places: 6 }), '0.000003')
  assert.equal(L.fmtThanks(31_533n), '31.5')
  assert.equal(L.fmtThanks(20_000n), '20')
  assert.equal(L.fmtThanks(1_234_000n), '1,234')
  assert.equal(L.fmtPct(5000), '50 %')
  assert.equal(L.fmtPct(3333), '33.3 %')
  assert.equal(L.fmtCountdown(61_000), '1:01')
  assert.equal(L.fmtCountdown(3_723_000), '1:02:03')
  assert.equal(L.fmtDuration(1_200_000), '20 minutes')
  assert.equal(L.fmtDuration(604_800_000), '7 days')
  assert.equal(L.fmtAgo(5_000), '5 s ago')
  assert.ok(L.hue('ana') >= 0 && L.hue('ana') < 8)
  assert.equal(L.HOUSE_LABELS.pair, 'house bot · demo: colluding pair')
})
