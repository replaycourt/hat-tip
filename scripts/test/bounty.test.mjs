// Bounties (scripts/bounty-lib.mjs): the DAO policy change is exactly the published diff, the board
// reads Sputnik's bounties, claims and proposals right, the house council's rule, and the poster's
// thanks and the finisher's note keep the round's limits and the other members' reading of notes.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { COUNCIL_PERMISSIONS, MEMBERS_PERMISSIONS, THANKS_PERMISSIONS, addOnTop, bountyBoard, bountyDecision, bountyNote, bountyPolicyState, bountyRoles, bountyText, withBountyThanks } from '../bounty-lib.mjs'
import { itemsOf, split } from '../hat-tip-lib.mjs'

const PARAMS = JSON.parse(readFileSync(new URL('../../sim/params.json', import.meta.url), 'utf8'))
const BR = PARAMS.house.bounties
const CONTRACT = 'thanks.hat-tip.testnet'
const TOKEN = 'tusd.hat-tip.testnet'
const COUNCIL = ['council-a.hat-tip.testnet', 'council-b.hat-tip.testnet', 'council-c.hat-tip.testnet']
const MEMBERS = ['ana', 'ben', 'cleo', 'dina', 'emil', 'finn', 'gus', 'hugo'].map((n) => `${n}.hat-tip.testnet`)
const [ANA, BEN, CLEO] = MEMBERS

/** The demo policy of DESIGN.md as get_policy returns it (before the change). */
const demoPolicy = () => ({
  roles: [
    { name: 'council', kind: { Group: [...COUNCIL] }, permissions: [...COUNCIL_PERMISSIONS].reverse(), vote_policy: { call: { weight_kind: 'RoleWeight', quorum: '0', threshold: '1' } } },
    { name: 'thanks', kind: { Group: [CONTRACT] }, permissions: [...THANKS_PERMISSIONS], vote_policy: { transfer: { weight_kind: 'RoleWeight', quorum: '0', threshold: [1, 1] } } },
    { name: 'members', kind: { Group: [...MEMBERS] }, permissions: [], vote_policy: {} },
  ],
  default_vote_policy: { weight_kind: 'RoleWeight', quorum: '0', threshold: [1, 2] },
  proposal_bond: '10000000000000000000000',
  proposal_period: '86400000000000',
  bounty_bond: '1000000000000000000000000',
  bounty_forgiveness_period: '86400000000000',
})
/** What Sputnik's add_or_update_role does: the role of that name is replaced. */
const apply = (policy, role) => ({ ...policy, roles: policy.roles.map((r) => (r.name === role.name ? structuredClone(role) : r)) })

test('the change is exactly the published diff, and nothing else moves', () => {
  const before = demoPolicy()
  assert.equal(bountyPolicyState(before, { contract: CONTRACT }).state, 'before')
  const { council, members } = bountyRoles(before)
  assert.deepEqual(council.kind, before.roles[0].kind, 'the council group stays')
  assert.deepEqual(council.permissions.filter((p) => !COUNCIL_PERMISSIONS.includes(p)), ['add_bounty:AddProposal'])
  assert.deepEqual(council.vote_policy, { call: { weight_kind: 'RoleWeight', quorum: '0', threshold: '1' }, bounty_done: { weight_kind: 'RoleWeight', quorum: '0', threshold: '1' } })
  assert.deepEqual(members, { name: 'members', kind: { Group: MEMBERS }, permissions: MEMBERS_PERMISSIONS, vote_policy: {} })
  const half = apply(before, members)
  assert.equal(bountyPolicyState(half).state, 'partial')
  assert.equal(bountyRoles(half).members, null, 'a role already changed is not filed again')
  const after = apply(half, council)
  assert.equal(bountyPolicyState(after, { contract: CONTRACT }).state, 'after')
  assert.deepEqual(bountyRoles(after), { council: null, members: null })
  assert.deepEqual(after.roles[1], before.roles[1], 'role thanks is untouched')
  assert.deepEqual([after.default_vote_policy, after.proposal_bond, after.bounty_bond], [before.default_vote_policy, before.proposal_bond, before.bounty_bond])
})

test('no call filer, no Everyone role, no wider member rights: anything else is "other"', () => {
  const after = apply(apply(demoPolicy(), bountyRoles(demoPolicy()).members), bountyRoles(demoPolicy()).council)
  const everyone = structuredClone(after)
  everyone.roles.push({ name: 'all', kind: 'Everyone', permissions: ['bounty_done:AddProposal'], vote_policy: {} })
  assert.equal(bountyPolicyState(everyone).state, 'other')
  const wide = structuredClone(after)
  wide.roles[2].permissions.push('call:AddProposal')
  assert.equal(bountyPolicyState(wide).state, 'other')
  const council = structuredClone(after)
  council.roles[0].vote_policy.add_bounty = { weight_kind: 'RoleWeight', quorum: '0', threshold: '1' }
  assert.equal(bountyPolicyState(council).state, 'other', 'posting a bounty keeps the council majority')
  const thanks = structuredClone(after)
  thanks.roles[1].permissions.push('bounty_done:VoteApprove')
  assert.equal(bountyPolicyState(thanks).state, 'other')
  assert.throws(() => bountyRoles(thanks), /not the demo policy/)
})

// ---- the board ----

const NS = 1_000_000n
const MIN = 60_000n * NS
const bounty = (id, task, poster, round, amount, times = 1) => ({ id, description: bountyText(task, poster, round), token: TOKEN, amount: String(amount * 1_000_000), times, max_deadline: String(120n * MIN) })
const addProp = (id, b, proposer, status) => ({ id, proposer, description: 'Bounty', status, submission_time: String(BigInt(id) * MIN), votes: {}, kind: { AddBounty: { bounty: { ...b, id: undefined } } } })
const doneProp = (id, bountyId, who, status, proposer = who, description = 'Done: new fuse, tested.') => ({ id, proposer, description, status, submission_time: String(BigInt(id) * MIN), votes: {}, kind: { BountyDone: { bounty_id: bountyId, receiver_id: who } } })
const strip = ({ id, ...b }) => b

test('the board: posters by content (also after times went to 0), claims, review, done, expired, blocked', () => {
  const b0 = bounty(0, 'Fix the toaster that trips the fuse', 'ana', 916, 10)
  const b1 = bounty(1, 'Mend the torn tool bag', 'ben', 917, 5)
  const b2 = bounty(2, 'Sort the screw box by size', 'cleo', 918, 5)
  const b3 = bounty(3, 'Repair the coffee grinder', 'ana', 919, 20)
  const b4 = bounty(4, 'Fix the radio\'s volume knob', 'ben', 920, 6)
  const proposals = [
    addProp(10, strip(b0), ANA, 'Approved'), addProp(11, strip(b1), BEN, 'Approved'), addProp(12, strip(b2), CLEO, 'Approved'),
    addProp(13, strip(b3), ANA, 'Approved'), addProp(14, strip(b4), BEN, 'Approved'),
    addProp(15, strip(bounty(9, 'Replace the vacuum cleaner belt', 'cleo', 921, 9)), CLEO, 'InProgress'),
    addProp(16, strip(bounty(9, 'Rewire the frayed extension lead', 'ana', 921, 50)), ANA, 'Rejected'),
    doneProp(20, 0, BEN, 'Approved'), doneProp(21, 1, CLEO, 'InProgress'),
  ]
  const done0 = { ...b0, times: 0 }
  const now = 500n * MIN
  const claims = {
    [CLEO]: [{ bounty_id: 1, start_time: String(400n * MIN), deadline: String(120n * MIN), completed: true }],
    [ANA]: [{ bounty_id: 2, start_time: String(450n * MIN), deadline: String(120n * MIN), completed: false }],
    [BEN]: [{ bounty_id: 3, start_time: String(100n * MIN), deadline: String(120n * MIN), completed: false }],
  }
  const counts = { 1: 1, 2: 1, 3: 1, 4: 1 }
  const board = bountyBoard({ bounties: [done0, b1, b2, b3, b4], proposals, claims, counts, nowNs: now })
  const by = Object.fromEntries(board.bounties.map((x) => [x.id, x]))
  assert.equal(by[0].state, 'done')
  assert.equal(by[0].poster, ANA, 'a bounty done (times 0) still finds its AddBounty')
  assert.deepEqual(by[0].done.map((x) => [x.proposal, x.finisher, x.status]), [[20, BEN, 'Approved']])
  assert.equal(by[0].paid, 1)
  assert.equal(by[1].state, 'review')
  assert.equal(by[2].state, 'claimed')
  assert.equal(by[2].claims[0].endNs, String(570n * MIN))
  assert.equal(by[3].state, 'expired', 'a claim past its deadline holds the slot until someone frees it')
  assert.equal(by[4].state, 'blocked', 'claimed by an account the board did not ask about')
  assert.deepEqual(board.pending.map((p) => [p.proposal, p.poster]), [[15, CLEO]])
  assert.deepEqual(board.declined.map((p) => [p.proposal, p.status]), [[16, 'Rejected']])
  const fresh = bountyBoard({ bounties: [b1], proposals: [], claims: {}, counts: { 1: 0 }, nowNs: now })
  assert.equal(fresh.bounties[0].state, 'open')
  assert.equal(fresh.bounties[0].poster, null, 'an AddBounty outside the window leaves the poster unknown')
})

test('two approved AddBounty proposals with the same content map to bounties in proposal order', () => {
  const b = bounty(0, 'Sort the screw box by size', 'ana', 5, 5)
  const board = bountyBoard({ bounties: [b, { ...b, id: 1 }], proposals: [addProp(7, strip(b), BEN, 'Approved'), addProp(3, strip(b), ANA, 'Approved')], counts: { 0: 0, 1: 0 } })
  assert.deepEqual(board.bounties.map((x) => [x.id, x.addProposal, x.poster]), [[0, 3, ANA], [1, 7, BEN]])
})

// ---- the council's rule ----

const ctx = (over = {}) => ({
  token: TOKEN, members: new Set(MEMBERS), council: new Set(COUNCIL), open: 1,
  posterOf: (id) => ({ 0: ANA, 1: BEN })[id] ?? null,
  claimOf: (who, id) => (who === BEN && id === 0 ? { bounty_id: 0, completed: true } : null),
  ...over,
})

test('AddBounty: a member or council task in tUSD, 5-20, one finisher, short deadline, while few are open', () => {
  const b = strip(bounty(0, 'Fix the toaster that trips the fuse', 'ana', 916, 10))
  const ok = (p) => bountyDecision(p, BR, ctx()).approve
  assert.equal(ok(addProp(1, b, ANA, 'InProgress')), true)
  assert.equal(ok(addProp(1, b, COUNCIL[0], 'InProgress')), true)
  assert.equal(ok(addProp(1, b, 'stranger.testnet', 'InProgress')), false)
  assert.equal(ok(addProp(1, { ...b, token: '' }, ANA, 'InProgress')), false, 'NEAR bounties are not paid by this rule')
  assert.equal(ok(addProp(1, { ...b, amount: '25000000' }, ANA, 'InProgress')), false)
  assert.equal(ok(addProp(1, { ...b, amount: '4999999' }, ANA, 'InProgress')), false)
  assert.equal(ok(addProp(1, { ...b, times: 3 }, ANA, 'InProgress')), false)
  assert.equal(ok(addProp(1, { ...b, max_deadline: String(15n * 24n * 60n * MIN) }, ANA, 'InProgress')), false, 'a claim deadline over two weeks')
  assert.equal(ok(addProp(1, { ...b, max_deadline: String(10n * 24n * 60n * MIN) }, ANA, 'InProgress')), true, 'ten days is within the rule')
  assert.equal(bountyDecision(addProp(1, b, ANA, 'InProgress'), BR, ctx({ open: BR.max_open })).approve, false)
  for (const [task, amount] of BR.tasks) {
    const p = addProp(1, { ...b, description: bountyText(task, 'ana', 1), amount: String(amount * 1_000_000), max_deadline: String(BigInt(BR.deadline_minutes) * MIN) }, ANA, 'InProgress')
    assert.equal(bountyDecision(p, BR, ctx()).approve, true, `the house's own task "${task}" passes the house rule`)
  }
})

test('BountyDone: the finisher files its own claimed work with a report, not its own bounty', () => {
  assert.deepEqual(bountyDecision(doneProp(30, 0, BEN, 'InProgress'), BR, ctx()).approve, true)
  assert.equal(bountyDecision(doneProp(30, 0, BEN, 'InProgress', CLEO), BR, ctx()).approve, false, 'filed for someone else (Sputnik would return the bond to the filer)')
  assert.equal(bountyDecision(doneProp(30, 0, BEN, 'InProgress', BEN, 'ok'), BR, ctx()).approve, false, 'no report')
  assert.equal(bountyDecision(doneProp(30, 0, BEN, 'InProgress'), BR, ctx({ posterOf: () => BEN })).approve, false, 'the poster finishing its own bounty')
  const noClaim = bountyDecision(doneProp(30, 1, BEN, 'InProgress'), BR, ctx())
  assert.equal(noClaim.vote, false, 'without a completed claim every vote would fail: left alone')
})

// ---- thanks and notes ----

test("the poster's thanks: regular split from 90, then 10 on top; at most 100 and the cap", () => {
  const cap = 25
  const extra = [[CLEO, BR.thanks_each]]
  const prefs = MEMBERS.slice(1).map((a, i) => [8 - i, a])
  const regular = split(100 - BR.thanks_each, prefs, cap, 10 - extra.length, 0.15)
  const gifts = withBountyThanks(regular, extra, cap)
  assert.ok(gifts.reduce((s, [, t]) => s + t, 0) <= 100)
  assert.ok(gifts.length <= 10)
  assert.ok(gifts.every(([, t]) => t >= 1 && t <= cap))
  const before = regular.find(([a]) => a === CLEO)?.[1] ?? 0
  assert.equal(gifts.find(([a]) => a === CLEO)[1], Math.min(cap, before + BR.thanks_each))
  assert.deepEqual(gifts.map(([a]) => a), [...gifts.map(([a]) => a)].sort())
  assert.deepEqual(withBountyThanks([[BEN, 20]], [[BEN, 10]], cap), [[BEN, 25]], 'over the cap lapses')
})

test('thanks put on top of an allocation already sent take from the largest gifts', () => {
  const sent = [[BEN, 25], [CLEO, 20], [MEMBERS[3], 30], [MEMBERS[4], 25]]
  const out = addOnTop(sent, [[CLEO, 10]], 34)
  assert.equal(out.reduce((s, [, t]) => s + t, 0), 100)
  assert.equal(out.find(([a]) => a === CLEO)[1], 30)
  assert.deepEqual(addOnTop([], [[CLEO, 10]], 34), [[CLEO, 10]], 'a poster that gave nothing this round gives just the bounty thanks')
})

test("the finisher's note names the bounty, fits 80 bytes and claims no items for it", () => {
  assert.equal(bountyNote('fixed 4 kettles', [12]), 'fixed 4 kettles + bounty #12')
  assert.equal(itemsOf(bountyNote('fixed 4 kettles', [12])), 4)
  assert.equal(bountyNote(null, [12, 13]), 'bounty #12, #13 done')
  assert.equal(itemsOf('bounty #12, #13 done'), 0)
  assert.equal(bountyNote('fixed 4 kettles', []), 'fixed 4 kettles')
  const long = bountyNote('x'.repeat(79), [123])
  assert.ok(Buffer.byteLength(long) <= 80 && long.endsWith('+ bounty #123'))
  assert.equal(itemsOf('repaired 3 lamps'), 3, 'notes without a bounty read as before')
})

test('the published strategy is consistent', () => {
  const honest = PARAMS.house.members.filter((m) => m.kind === 'honest').map((m) => m.name)
  assert.ok(BR.members.every((n) => honest.includes(n)), 'only honest members work on bounties')
  assert.ok(BR.tasks.every(([, a]) => a >= BR.min_tusd && a <= BR.max_tusd))
  assert.ok(BR.deadline_minutes <= BR.max_deadline_minutes)
  assert.ok(BR.work_minutes[1] + 5 <= BR.deadline_minutes, 'the house files its work before the claim runs out')
  assert.ok(BR.thanks_each < PARAMS.house.council_rule.partner_min * 2)
  assert.equal(new Set(BR.tasks.map(([t]) => t)).size, BR.tasks.length)
  assert.ok(BR.tasks.every(([t, , report]) => bountyText(t, 'cleo', 9999).length < 120 && `Done: ${report}`.length >= BR.report_min_chars))
})
