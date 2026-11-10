// Sputnik bounties in the Hat Tip demo community (DESIGN.md, "Bounties"): the DAO policy change that
// lets members post and finish bounties, the house council's published rule for bounty proposals,
// the board (each bounty with its poster, claims and payout proposals) and the poster's thanks.
// Pure functions only, tested in scripts/test/bounty.test.mjs; the chain calls are in
// scripts/bounties.mjs and scripts/house.mjs. JSON shapes as Sputnik v2 (2.3.1) writes and reads them.

/** The council's permissions before the change (DESIGN.md, demo policy). */
export const COUNCIL_PERMISSIONS = [
  'transfer:AddProposal', 'config:AddProposal', 'policy:AddProposal',
  'policy_add_or_update_role:AddProposal', 'policy_remove_role:AddProposal',
  'policy_update_default_vote_policy:AddProposal', 'policy_update_parameters:AddProposal',
  'add_member_to_role:AddProposal', 'remove_member_from_role:AddProposal',
  'factory_info_update:AddProposal', 'vote:AddProposal',
  '*:VoteApprove', '*:VoteReject', '*:VoteRemove', '*:Finalize',
]
export const THANKS_PERMISSIONS = ['transfer:AddProposal', 'transfer:VoteApprove', 'call:AddProposal', 'transfer:Finalize', 'call:Finalize']
const ONE_VOTE = { weight_kind: 'RoleWeight', quorum: '0', threshold: '1' }
const THANKS_VOTE = { transfer: { weight_kind: 'RoleWeight', quorum: '0', threshold: [1, 1] } }
const MAJORITY = { weight_kind: 'RoleWeight', quorum: '0', threshold: [1, 2] }

/** What the change adds: the council may post bounties, and one council vote approves finished work. */
export const COUNCIL_ADDS = 'add_bounty:AddProposal'
export const BOUNTY_DONE_VOTE = ONE_VOTE
/** The members' only permissions after the change: post a bounty, and file finished work. */
export const MEMBERS_PERMISSIONS = ['add_bounty:AddProposal', 'bounty_done:AddProposal']

const sameSet = (a, b) => Array.isArray(a) && a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n')
const canon = (x) => JSON.stringify(x, (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort()) : v))
const same = (a, b) => canon(a) === canon(b)
const roleOf = (policy, name) => (policy?.roles ?? []).find((r) => r.name === name) ?? null
const groupOf = (role) => (Array.isArray(role?.kind?.Group) ? role.kind.Group : null)

/**
 * Where a DAO policy stands with the bounty change: `before` (the demo policy of DESIGN.md),
 * `after` (exactly that plus the change), `partial` (one of the two roles changed) or `other`
 * (anything else; `problems` says what). Group members are not compared, only the role shapes.
 */
export function bountyPolicyState(policy, { contract } = {}) {
  const problems = []
  const council = roleOf(policy, 'council')
  const thanks = roleOf(policy, 'thanks')
  const members = roleOf(policy, 'members')
  if ((policy?.roles ?? []).some((r) => r.kind === 'Everyone' || (r.kind && typeof r.kind === 'object' && 'Everyone' in r.kind))) problems.push('an Everyone role exists')
  if ((policy?.roles ?? []).length !== 3) problems.push(`${(policy?.roles ?? []).length} roles, not council, thanks and members`)
  if (!council || !groupOf(council)) problems.push('no council group')
  if (!members || !groupOf(members)) problems.push('no members group')
  if (!thanks || !groupOf(thanks)) problems.push('no thanks group')
  else {
    if (contract && !(groupOf(thanks).length === 1 && groupOf(thanks)[0] === contract)) problems.push('role thanks is not the contract alone')
    if (!sameSet(thanks.permissions, THANKS_PERMISSIONS)) problems.push(`role thanks permissions ${JSON.stringify(thanks.permissions)}`)
    if (!same(thanks.vote_policy, THANKS_VOTE)) problems.push(`role thanks vote policy ${JSON.stringify(thanks.vote_policy)}`)
  }
  if (!same(policy?.default_vote_policy, MAJORITY)) problems.push(`default vote policy ${JSON.stringify(policy?.default_vote_policy)}`)
  if (problems.length) return { state: 'other', problems }
  const councilBefore = sameSet(council.permissions, COUNCIL_PERMISSIONS) && same(council.vote_policy, { call: ONE_VOTE })
  const councilAfter = sameSet(council.permissions, [...COUNCIL_PERMISSIONS, COUNCIL_ADDS]) && same(council.vote_policy, { call: ONE_VOTE, bounty_done: ONE_VOTE })
  const membersBefore = sameSet(members.permissions, []) && same(members.vote_policy, {})
  const membersAfter = sameSet(members.permissions, MEMBERS_PERMISSIONS) && same(members.vote_policy, {})
  if (!councilBefore && !councilAfter) problems.push(`council permissions ${JSON.stringify(council.permissions)}, vote policy ${JSON.stringify(council.vote_policy)}`)
  if (!membersBefore && !membersAfter) problems.push(`members permissions ${JSON.stringify(members.permissions)}, vote policy ${JSON.stringify(members.vote_policy)}`)
  if (problems.length) return { state: 'other', problems }
  if (councilBefore && membersBefore) return { state: 'before', problems }
  if (councilAfter && membersAfter) return { state: 'after', problems }
  return { state: 'partial', problems, council: councilAfter ? 'after' : 'before', members: membersAfter ? 'after' : 'before' }
}

/**
 * The two `ChangePolicyAddOrUpdateRole` roles of the change, built from the current policy so that
 * the groups stay as they are. A role that already has its new shape is null.
 */
export function bountyRoles(policy) {
  const st = bountyPolicyState(policy)
  if (st.state === 'other') throw new Error(`the DAO policy is not the demo policy: ${st.problems.join('; ')}`)
  const council = roleOf(policy, 'council')
  const members = roleOf(policy, 'members')
  const councilDone = st.state === 'after' || st.council === 'after'
  const membersDone = st.state === 'after' || st.members === 'after'
  return {
    council: councilDone ? null : {
      name: 'council', kind: { Group: [...groupOf(council)] },
      permissions: [...council.permissions, COUNCIL_ADDS],
      vote_policy: { ...council.vote_policy, bounty_done: { ...BOUNTY_DONE_VOTE } },
    },
    members: membersDone ? null : {
      name: 'members', kind: { Group: [...groupOf(members)] },
      permissions: [...MEMBERS_PERMISSIONS],
      vote_policy: {},
    },
  }
}

// ---- the board ----------------------------------------------------------------------------------------

const kindName = (p) => Object.keys(p?.kind ?? {})[0] ?? null
// `times` counts down as the bounty is done (Sputnik keeps it at 0), so the bounty may have fewer.
const sameBounty = (proposed, b) => proposed.description === b.description && String(proposed.token) === String(b.token) && String(proposed.amount) === String(b.amount) && Number(b.times) <= Number(proposed.times) && String(proposed.max_deadline) === String(b.max_deadline)

/**
 * The bounties as one list: every bounty of `get_bounties` with its poster (the proposer of the
 * approved `AddBounty` proposal with the same content, matched in proposal order), its claims, its
 * `BountyDone` proposals and a state; the `AddBounty` proposals still in the vote (`proposed`) and
 * the declined ones. `claims`: { account: get_bounty_claims(account) } for the accounts asked;
 * `counts`: { id: get_bounty_number_of_claims(id) } (claims by accounts not asked show only there).
 * `proposals` may be a recent window: a bounty whose `AddBounty` is older has `poster` null.
 * Times are nanoseconds (strings or numbers) as Sputnik gives them; `nowNs` likewise.
 *
 * States: `open` (claimable), `claimed` (a claim runs), `review` (the finisher filed its work and
 * the council has not decided), `done` (claimed and paid as often as `times` allowed: Sputnik keeps
 * a finished bounty with times 0), `expired` (every slot is held by a claim past its deadline,
 * until someone frees it with bounty_done), `blocked` (claimed by an account not asked about).
 */
export function bountyBoard({ bounties = [], proposals = [], claims = {}, counts = {}, nowNs = 0n }) {
  const now = BigInt(nowNs)
  const props = [...proposals].sort((a, b) => a.id - b.id)
  const adds = props.filter((p) => kindName(p) === 'AddBounty')
  const dones = props.filter((p) => kindName(p) === 'BountyDone')
  const used = new Set()
  const out = []
  for (const b of [...bounties].sort((x, y) => x.id - y.id)) {
    const add = adds.find((p) => p.status === 'Approved' && !used.has(p.id) && sameBounty(p.kind.AddBounty.bounty, b)) ?? null
    if (add) used.add(add.id)
    const cl = []
    for (const [account, list] of Object.entries(claims)) {
      for (const c of list ?? []) {
        if (Number(c.bounty_id) !== Number(b.id)) continue
        const end = BigInt(c.start_time) + BigInt(c.deadline)
        cl.push({ account, startNs: String(c.start_time), endNs: String(end), completed: Boolean(c.completed), expired: !c.completed && now > end })
      }
    }
    cl.sort((x, y) => (BigInt(x.startNs) < BigInt(y.startNs) ? -1 : 1))
    const done = dones.filter((p) => Number(p.kind.BountyDone.bounty_id) === Number(b.id)).map((p) => ({
      proposal: p.id, finisher: p.kind.BountyDone.receiver_id, proposer: p.proposer, status: p.status, report: p.description, submittedNs: String(p.submission_time),
    }))
    const count = Number(counts[b.id] ?? cl.length)
    const times = Number(b.times)
    const running = cl.filter((c) => !c.completed && !c.expired)
    let state
    if (times === 0) state = 'done'
    else if (cl.some((c) => c.completed)) state = 'review'
    else if (running.length && count >= times) state = 'claimed'
    else if (count > cl.length && count >= times) state = 'blocked'
    else if (count >= times) state = 'expired' // every slot is held by an expired claim until someone frees it
    else state = 'open'
    out.push({
      id: Number(b.id), description: b.description, token: b.token, amount: String(b.amount), times, maxDeadlineNs: String(b.max_deadline),
      poster: add?.proposer ?? null, addProposal: add?.id ?? null, claims: cl, done, claimCount: count, state,
      paid: done.filter((x) => x.status === 'Approved').length,
    })
  }
  const pending = adds.filter((p) => p.status === 'InProgress').map((p) => ({ proposal: p.id, poster: p.proposer, ...pickBounty(p.kind.AddBounty.bounty), submittedNs: String(p.submission_time), votes: p.votes ?? {} }))
  const declined = adds.filter((p) => ['Rejected', 'Removed', 'Expired'].includes(p.status)).map((p) => ({ proposal: p.id, poster: p.proposer, status: p.status, ...pickBounty(p.kind.AddBounty.bounty) }))
  return { bounties: out, pending, declined }
}

const pickBounty = (b) => ({ description: b.description, token: b.token, amount: String(b.amount), times: Number(b.times), maxDeadlineNs: String(b.max_deadline) })

// ---- the house council's rule for bounty proposals --------------------------------------------------

/**
 * The house council's published rule for a bounty proposal in the vote (sim/params.json,
 * house.bounties.council). `rule`: that block; `ctx`: { token, members: Set, council: Set,
 * open: number of bounties open or claimed now, posterOf(id), claimOf(account, id) }.
 *
 * AddBounty (needs a council majority): approve a task a member or council member posts, paid in
 * tUSD, between min_tusd and max_tusd, for one finisher (times 1), with a claim deadline of at most
 * max_deadline_minutes, while fewer than max_open bounties are open; otherwise reject.
 * BountyDone (one council vote): approve the work a member files itself for a bounty it claimed
 * and did not post, with a report of at least report_min_chars characters; otherwise reject. A
 * BountyDone without a matching completed claim is left alone (Sputnik cannot approve, reject or
 * remove it: every outcome removes the claim), `vote: false`.
 */
export function bountyDecision(prop, rule, ctx) {
  const kind = kindName(prop)
  const name = (a) => String(a).split('.')[0]
  if (kind === 'AddBounty') {
    const b = prop.kind.AddBounty.bounty
    const amount = BigInt(b.amount)
    const unit = 10n ** 6n
    if (!ctx.members.has(prop.proposer) && !ctx.council.has(prop.proposer)) return { vote: true, approve: false, why: `posted by ${prop.proposer}, not a member or council member` }
    if (String(b.token) !== ctx.token) return { vote: true, approve: false, why: `paid in ${b.token || 'NEAR'}, not tUSD` }
    if (amount < BigInt(rule.min_tusd) * unit || amount > BigInt(rule.max_tusd) * unit) return { vote: true, approve: false, why: `${Number(amount) / 1e6} tUSD is outside ${rule.min_tusd}-${rule.max_tusd} tUSD` }
    if (Number(b.times) !== 1) return { vote: true, approve: false, why: `times ${b.times}, not one finisher` }
    if (BigInt(b.max_deadline) > BigInt(rule.max_deadline_minutes) * 60n * 10n ** 9n || BigInt(b.max_deadline) <= 0n) return { vote: true, approve: false, why: `a claim deadline of ${Number(BigInt(b.max_deadline) / 10n ** 9n) / 60} minutes, more than ${rule.max_deadline_minutes}` }
    if (ctx.open >= rule.max_open) return { vote: true, approve: false, why: `${ctx.open} bounties are open already (at most ${rule.max_open})` }
    return { vote: true, approve: true, why: `${name(prop.proposer)} posts ${Number(amount) / 1e6} tUSD for one finisher` }
  }
  if (kind === 'BountyDone') {
    const { bounty_id: id, receiver_id: who } = prop.kind.BountyDone
    const claim = ctx.claimOf(who, id)
    if (!claim || !claim.completed) return { vote: false, approve: false, why: `${name(who)} holds no completed claim on bounty #${id}: Sputnik cannot settle this proposal` }
    if (prop.proposer !== who) return { vote: true, approve: false, why: `filed by ${name(prop.proposer)} for ${name(who)}: only the finisher files its own work` }
    if (!ctx.members.has(who)) return { vote: true, approve: false, why: `${who} is not a member` }
    const poster = ctx.posterOf(id)
    if (poster && poster === who) return { vote: true, approve: false, why: `${name(who)} posted bounty #${id} itself` }
    if (String(prop.description ?? '').trim().length < rule.report_min_chars) return { vote: true, approve: false, why: 'no report of the work' }
    return { vote: true, approve: true, why: `${name(who)} claimed bounty #${id}${poster ? ` (posted by ${name(poster)})` : ''} and reports the work` }
  }
  return { vote: false, approve: false, why: `not a bounty proposal (${kind})` }
}

// ---- the poster's thanks and the finisher's note ----------------------------------------------------

/**
 * A member's allocation with the bounty thanks added: `extra` [[finisher, thanks]] on top of the
 * regular gifts, each receiver capped at `cap` (thanks over the cap lapse), receivers sorted. The
 * regular gifts must have been split from 100 minus the extra thanks, over at most max_receivers
 * minus the extra receivers, so the sum stays at most 100 and the receivers at most max_receivers.
 */
export function withBountyThanks(gifts, extra, cap) {
  const m = new Map(gifts.map(([a, t]) => [a, t]))
  for (const [a, t] of extra) m.set(a, Math.min(cap, (m.get(a) ?? 0) + t))
  return [...m].filter(([, t]) => t >= 1).sort((a, b) => (a[0] < b[0] ? -1 : 1))
}

/**
 * An allocation already sent, with the bounty thanks put on top afterwards (scripts/bounties.mjs
 * thank, beside a house that does not know bounties yet): the extra thanks are taken from the other
 * receivers, one at a time from the largest gift, so the sum stays at most `total` (100).
 */
export function addOnTop(gifts, extra, cap, total = 100) {
  const m = new Map(gifts.map(([a, t]) => [a, t]))
  for (const [a, t] of extra) m.set(a, Math.min(cap, (m.get(a) ?? 0) + t))
  const keep = new Set(extra.map(([a]) => a))
  let over = [...m.values()].reduce((s, t) => s + t, 0) - total
  while (over > 0) {
    const others = [...m].filter(([a, t]) => !keep.has(a) && t > 0).sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))
    if (!others.length) break
    m.set(others[0][0], others[0][1] - 1)
    over--
  }
  return [...m].filter(([, t]) => t >= 1).sort((a, b) => (a[0] < b[0] ? -1 : 1))
}

const bytes = (s) => Buffer.byteLength(s, 'utf8')

/**
 * The note of a member that finished bounties this round: its regular note (or none) and the
 * bounty numbers, at most `max` bytes. The numbers follow a `#`, which itemsOf does not read as
 * items (hat-tip-lib.mjs), so the other members' thanks for the note are unchanged.
 */
export function bountyNote(note, ids, max = 80) {
  if (!ids.length) return note
  const tag = ids.map((i) => `#${i}`).join(', ')
  if (!note) return `bounty ${tag} done`
  const tail = ` + bounty ${tag}`
  let base = note
  while (base && bytes(base + tail) > max) base = base.slice(0, -1)
  return (base.trimEnd() + tail).slice(0, max)
}

/** The bounty text a poster files: the task and who posted it in which round (unique per round). */
export const bountyText = (task, poster, round) => `${task} (posted by ${poster}, round ${round})`
