#!/usr/bin/env node
// Sputnik bounties in a Hat Tip deployment (DESIGN.md, "Bounties"): the DAO policy change, the
// bounty keys of the house, the board, and single bounty actions by hand. The house plays the same
// actions on its own (scripts/house.mjs); this script is for the setup, the first cycle and checks.
//
//   node scripts/bounties.mjs policy [--section staging]
//       the policy's state and the change as two ChangePolicyAddOrUpdateRole roles (read-only)
//   node scripts/bounties.mjs policy --file [--as council-a] [--section staging]
//       files the two role proposals, signed with that council member's full-access key (legacy
//       keychain: add_proposal attaches the DAO's proposal bond, which a function-call key cannot)
//   node scripts/bounties.mjs policy --vote [--section staging]
//       VoteApprove on both by two house council members (their function-call keys, HOUSE_KEYS or
//       .secrets/house-keys-<contract>.json); stops unless the policy is the demo policy before or after
//   node scripts/bounties.mjs keys [--section staging]
//       adds a dedicated full-access bounty key to each bounty member of sim/params.json (signed with
//       the member's keychain key); seeds to .secrets/house-bounty-keys-<contract>.json (mode 600)
//   node scripts/bounties.mjs export-secret [--section staging]
//       .secrets/github-secret-HOUSE_BOUNTY_KEYS.txt, the value of the GitHub secret HOUSE_BOUNTY_KEYS
//   node scripts/bounties.mjs board [--section staging] [--json]       the bounty board (read-only)
//   node scripts/bounties.mjs post --as <name> [--task <i>] [--deadline-minutes <m>]
//       an AddBounty proposal; the claim deadline defaults to house.bounties.deadline_minutes
//   node scripts/bounties.mjs claim --as <name> --id <n>               bounty_claim with the bond
//   node scripts/bounties.mjs done --as <name> --id <n>                bounty_done with the task's report
//   node scripts/bounties.mjs giveup --as <name> --id <n>              bounty_giveup
//   node scripts/bounties.mjs vote [--proposal <n>] [--now]            the house council's rule on the
//       bounty proposals in the vote (at least two minutes old, unless --now)
//   node scripts/bounties.mjs thank --proposal <n> [--section final]
//       the poster's thanks and the finisher's note for approved work in the current round, put on
//       top of what the house sent this round (for a house that does not know bounties yet)
//
// post, claim, done and giveup sign with the member's bounty key (HOUSE_BOUNTY_KEYS or
// .secrets/house-bounty-keys-<contract>.json), or with --keychain its full-access key from the
// legacy keychain (the final deployment has no bounty keys); either way through BountySigner,
// which refuses every other call.

// Every transaction is recorded in deploy/testnet.json (the section's `bounties.txs`); no key is
// printed. Testnet only.
import { existsSync, readFileSync } from 'node:fs'
import { Signer, addFullAccessKeyAction, keyFromKeychain, newKey, nearPublicKey, view } from './near-lite.mjs'
import { BountySigner } from './bounty-chain.mjs'
import {
  Recorder, cli, deployment, houseKeysFile, loadParams, nearStr, recordDeploy, seedHexOf, seedSigner, short, stamp, tusd, writeSecret,
} from './hat-tip-lib.mjs'
import { addOnTop, bountyBoard, bountyDecision, bountyNote, bountyPolicyState, bountyRoles, bountyText } from './bounty-lib.mjs'
import { BOUNTY_GAS, BountyProposals, allBounties, bountyKeysFile, bountySigners, checkBountyKey, claimsAndCounts, loadBountyKeys } from './bounty-chain.mjs'

const { opt, flag, positional } = cli()
const cmd = positional[0]
const section = opt('section', 'staging')
const d = deployment(section)
const H = loadParams().house
const BR = H.bounties
const accountOf = (name) => (name.includes('.') ? name : `${name}.${d.root}`)
const COUNCIL_DELAY_MS = 120_000

const rec = new Recorder({ log: opt('log', null) })
/** Records a transaction in deploy/testnet.json, section.bounties.txs, under `key`. */
function keep(key, r) {
  if (!r?.hash) return
  const entry = { hash: r.hash, tgas: r.tgas, fee_near: r.fee, ok: r.ok, at: r.at }
  const cur = (deployment(section).bounties?.txs ?? {})[key]
  recordDeploy(section, { bounties: { txs: { [key]: cur === undefined ? entry : [].concat(cur, entry) } } })
}
/**
 * Records the id of a bounty proposal (`add` or `done`) in deploy/testnet.json, section.bounties.
 * proposals: the page and judge-checks.sh read them by id, since Sputnik has no index by kind and a
 * busy DAO buries them under thousands of payout proposals.
 */
function keepProposal(kind, id) {
  if (!Number.isInteger(id)) return
  const cur = deployment(section).bounties?.proposals ?? { add: [], done: [] }
  const list = [...new Set([...(cur[kind] ?? []), id])].sort((a, b) => a - b)
  recordDeploy(section, { bounties: { proposals: { ...cur, [kind]: list } } })
}

function houseCouncilSigners() {
  let raw = process.env.HOUSE_KEYS
  if (!raw && existsSync(houseKeysFile(d.contract))) raw = readFileSync(houseKeysFile(d.contract), 'utf8')
  if (!raw) throw new Error('no house keys (HOUSE_KEYS or .secrets/house-keys-<contract>.json)')
  const k = JSON.parse(raw)
  if (k.contract !== d.contract) throw new Error(`the house keys are for ${k.contract}`)
  return H.council.map((c) => accountOf(c.name)).filter((a) => k.council?.[a]).map((a) => seedSigner(a, k.council[a]))
}

async function daoFacts() {
  const policy = await view(d.dao, 'get_policy')
  const role = (n) => new Set(policy.roles.find((r) => r.name === n)?.kind?.Group ?? [])
  return { policy, members: role('members'), council: role('council'), proposalBond: BigInt(policy.proposal_bond), bountyBond: BigInt(policy.bounty_bond) }
}

// ---- policy -------------------------------------------------------------------------------------------

async function policy() {
  const { policy: pol, proposalBond } = await daoFacts()
  const st = bountyPolicyState(pol, { contract: d.contract })
  console.log(`DAO ${d.dao}: the policy is ${st.state}${st.problems.length ? ': ' + st.problems.join('; ') : ''}${st.state === 'partial' ? ` (council ${st.council}, members ${st.members})` : ''}`)
  if (st.state === 'other') process.exit(2)
  const roles = bountyRoles(pol)
  const before = Object.fromEntries(pol.roles.filter((r) => r.name !== 'thanks').map((r) => [r.name, { permissions: [...r.permissions].sort(), vote_policy: r.vote_policy }]))
  for (const [name, role] of Object.entries(roles)) {
    if (!role) continue
    const add = role.permissions.filter((p) => !before[name].permissions.includes(p))
    const vp = Object.keys(role.vote_policy).filter((k) => !(k in before[name].vote_policy))
    console.log(`  role ${name}: + permissions ${JSON.stringify(add)}${vp.length ? `, + vote_policy ${JSON.stringify(Object.fromEntries(vp.map((k) => [k, role.vote_policy[k]])))}` : ''}`)
  }
  // the role proposals already in the DAO (a rerun reuses them)
  const last = await view(d.dao, 'get_last_proposal_id')
  const recent = await view(d.dao, 'get_proposals', { from_index: Math.max(0, last - 100), limit: 100 })
  const mine = (name) => recent.filter((q) => q.kind.ChangePolicyAddOrUpdateRole?.role?.name === name && q.status === 'InProgress')
  if (flag('file')) {
    const as = accountOf(opt('as', 'council-a'))
    const signer = new Signer(as, keyFromKeychain(as))
    const text = {
      council: 'Bounties: the council may also post bounties (add_bounty), and one council vote approves finished work (bounty_done). Hat Tip DESIGN.md, Bounties.',
      members: 'Bounties: members may post bounties (add_bounty) and file their finished work (bounty_done), nothing else. Hat Tip DESIGN.md, Bounties.',
    }
    for (const [name, role] of Object.entries(roles)) {
      if (!role) continue
      if (mine(name).length) {
        console.log(`  role ${name}: DAO #${mine(name)[0].id} is in the vote already`)
        continue
      }
      const r = await rec.call(signer, d.dao, 'add_proposal', { proposal: { description: text[name], kind: { ChangePolicyAddOrUpdateRole: { role } } } },
        { gas: BOUNTY_GAS.post, deposit: proposalBond, label: `file ChangePolicyAddOrUpdateRole ${name}` })
      keep(`policy: file role ${name} (DAO #${r.value})`, r)
      if (!r.ok) process.exit(1)
    }
  }
  if (flag('vote')) {
    const voters = houseCouncilSigners()
    const now = await view(d.dao, 'get_proposals', { from_index: Math.max(0, last - 100), limit: 110 })
    for (const name of ['council', 'members']) {
      for (const q of now.filter((x) => x.kind.ChangePolicyAddOrUpdateRole?.role?.name === name && x.status === 'InProgress')) {
        // only a proposal whose role is exactly the change is approved
        const want = bountyRoles(await view(d.dao, 'get_policy'))[name]
        if (!want || JSON.stringify(canonRole(q.kind.ChangePolicyAddOrUpdateRole.role)) !== JSON.stringify(canonRole(want))) {
          console.log(`  DAO #${q.id} (role ${name}) is not exactly the change; not voting`)
          continue
        }
        for (const v of voters) {
          const cur = await view(d.dao, 'get_proposal', { id: q.id })
          if (cur.status !== 'InProgress') break
          if (v.accountId in (cur.votes ?? {})) continue
          const r = await rec.call(v, d.dao, 'act_proposal', { id: q.id, action: 'VoteApprove', proposal: cur.kind }, { gas: BOUNTY_GAS.vote, label: `${short(v.accountId).split('.')[0]} VoteApprove DAO #${q.id} (role ${name})` })
          keep(`policy: vote role ${name} (DAO #${q.id})`, r)
          if (!r.ok) process.exit(1)
        }
        const after = await view(d.dao, 'get_proposal', { id: q.id })
        console.log(`  DAO #${q.id} (role ${name}): ${after.status}`)
      }
    }
    const fin = bountyPolicyState(await view(d.dao, 'get_policy'), { contract: d.contract })
    console.log(`DAO ${d.dao}: the policy is now ${fin.state}`)
    if (fin.state === 'after') recordDeploy(section, { bounties: { policy: 'after', policy_changed: new Date().toISOString() } })
  }
}

const canonRole = (r) => ({ name: r.name, kind: { Group: [...r.kind.Group].sort() }, permissions: [...r.permissions].sort(), vote_policy: Object.fromEntries(Object.entries(r.vote_policy).sort()) })

// ---- keys ---------------------------------------------------------------------------------------------

async function addBountyKeys() {
  const file = bountyKeysFile(d.contract)
  const have = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { v: 1, section, contract: d.contract, members: {} }
  for (const name of BR.members) {
    const account = accountOf(name)
    if (have.members[account] && !(await checkBountyKey(account, have.members[account]))) {
      console.log(`${account}: bounty key in place`)
      continue
    }
    const key = newKey()
    const signer = new Signer(account, keyFromKeychain(account))
    const res = await signer.send(account, [addFullAccessKeyAction(nearPublicKey(key))])
    console.log(`[${stamp()}] ${account}: bounty key ${nearPublicKey(key)} added: ${res.failure ? 'FAILED ' + res.failure : 'ok'}; ${res.hash}`)
    if (res.failure) process.exit(1)
    have.members[account] = seedHexOf(key)
    writeSecret(`house-bounty-keys-${d.contract}.json`, have)
    recordDeploy(section, { bounties: { keys: { [account]: { public_key: nearPublicKey(key), added_tx: res.hash, kind: 'full access (bounty calls attach deposits); used only for add_proposal AddBounty, bounty_claim, bounty_done, bounty_giveup' } } } })
  }
  console.log(`bounty keys: ${file.replace(/.*\/\.secrets\//, '.secrets/')} (${Object.keys(have.members).length} members)`)
}

async function exportSecret() {
  const k = loadBountyKeys(d)
  if (!k) throw new Error('no bounty keys')
  const ok = await bountySigners(k, new Set(BR.members.map(accountOf)), d.dao)
  if (ok.size !== BR.members.length) throw new Error('not every bounty key checks out on chain; not writing the secret')
  const value = JSON.stringify({ v: 1, section, contract: d.contract, members: k.members })
  const file = writeSecret('github-secret-HOUSE_BOUNTY_KEYS.txt', value + '\n')
  console.log(`wrote ${file.replace(/.*\/\.secrets\//, '.secrets/')} (mode 600): ${ok.size} bounty keys, ${value.length} bytes; full-access keys, checked on chain`)
}

// ---- board and actions ------------------------------------------------------------------------------

async function readBoard() {
  const facts = await daoFacts()
  const proposals = await new BountyProposals(d.dao, { back: Number(opt('back', '600')) }).refresh()
  const bounties = await allBounties(d.dao)
  const accounts = [...H.members.map((m) => accountOf(m.name))]
  const { claims, counts } = await claimsAndCounts(d.dao, accounts, bounties)
  const board = bountyBoard({ bounties, proposals, claims, counts, nowNs: BigInt(Date.now()) * 1_000_000n })
  return { facts, proposals, bounties, claims, counts, board }
}

async function board() {
  const { board: b, facts } = await readBoard()
  if (flag('json')) return console.log(JSON.stringify(b, null, 1))
  console.log(`DAO ${d.dao}: ${b.bounties.length} bounties, bond ${nearStr(facts.bountyBond, 2)} NEAR, policy ${bountyPolicyState(facts.policy).state}`)
  const n = (a) => (a ? a.split('.')[0] : '?')
  for (const x of b.bounties) {
    const cl = x.claims.map((c) => `${n(c.account)}${c.completed ? ' (filed)' : c.expired ? ' (expired)' : ''}`).join(', ')
    const dn = x.done.map((p) => `DAO #${p.proposal} ${n(p.finisher)} ${p.status}`).join(', ')
    console.log(`  #${x.id} ${x.state.padEnd(7)} ${tusd(x.amount).padStart(3)} tUSD  ${x.description}  poster ${n(x.poster)}${x.addProposal != null ? ` (DAO #${x.addProposal})` : ''}${cl ? `; claims ${cl}` : ''}${dn ? `; ${dn}` : ''}`)
  }
  for (const p of b.pending) console.log(`  proposed DAO #${p.proposal} by ${n(p.poster)}: ${tusd(p.amount)} tUSD, ${p.description} (votes ${Object.keys(p.votes).map(n).join(', ') || 'none'})`)
  for (const p of b.declined) console.log(`  declined DAO #${p.proposal} by ${n(p.poster)} (${p.status}): ${p.description}`)
}

async function signerOf(name) {
  const account = accountOf(name)
  if (flag('keychain')) return new BountySigner(account, new Signer(account, keyFromKeychain(account)), d.dao)
  const k = loadBountyKeys(d)
  const s = (await bountySigners({ members: { [account]: k?.members?.[account] } }, new Set([account]), d.dao)).get(account)
  if (!s) throw new Error(`no working bounty key for ${account} (--keychain uses its key from the legacy keychain)`)
  return s
}

async function post() {
  const name = opt('as')
  const s = await signerOf(name)
  const { proposalBond } = await daoFacts()
  const cfg = await view(d.contract, 'config')
  const round = Math.floor((Date.now() - Number(cfg.genesis_ms)) / Number(cfg.round_ms)) + 1
  const [task, amount] = BR.tasks[Number(opt('task', '0'))]
  const minutes = BigInt(opt('deadline-minutes', String(BR.deadline_minutes)))
  const bounty = { description: bountyText(task, name, round), token: d.token, amount: String(BigInt(amount) * 1_000_000n), times: 1, max_deadline: String(minutes * 60_000_000_000n) }
  const r = await rec.call(s, d.dao, 'add_proposal', { proposal: { description: `Bounty: ${task}, ${amount} tUSD`, kind: { AddBounty: { bounty } } } }, { gas: BOUNTY_GAS.post, deposit: proposalBond, label: `${name} posts "${task}" (${amount} tUSD)` })
  keep(`post by ${name} (DAO #${r.value})`, r)
  if (!r.ok) process.exit(1)
  keepProposal('add', r.value)
}

async function claim() {
  const name = opt('as')
  const id = Number(opt('id'))
  const s = await signerOf(name)
  const { bountyBond } = await daoFacts()
  const b = await view(d.dao, 'get_bounty', { id })
  const r = await rec.call(s, d.dao, 'bounty_claim', { id, deadline: String(b.max_deadline) }, { gas: BOUNTY_GAS.claim, deposit: bountyBond, label: `${name} claims bounty #${id} (bond ${nearStr(bountyBond, 2)} NEAR)` })
  keep(`claim #${id} by ${name}`, r)
  if (!r.ok) process.exit(1)
}

async function done() {
  const name = opt('as')
  const id = Number(opt('id'))
  const s = await signerOf(name)
  const { proposalBond } = await daoFacts()
  const b = await view(d.dao, 'get_bounty', { id })
  const task = BR.tasks.find(([t]) => b.description.startsWith(t))
  const report = opt('report', task ? `Done: ${task[2]}` : 'Done, as described in the bounty.')
  const r = await rec.call(s, d.dao, 'bounty_done', { id, description: report }, { gas: BOUNTY_GAS.done, deposit: proposalBond, label: `${name} files bounty #${id} as done` })
  keep(`done #${id} by ${name}`, r)
  if (!r.ok) process.exit(1)
  // bounty_done returns nothing: its proposal is the newest BountyDone of this account for the bounty
  const last = await view(d.dao, 'get_last_proposal_id')
  const mine = (await view(d.dao, 'get_proposals', { from_index: Math.max(0, last - 20), limit: 20 })).filter((q) => q.kind.BountyDone && Number(q.kind.BountyDone.bounty_id) === id && q.proposer === s.accountId)
  if (mine.length) {
    keepProposal('done', mine[mine.length - 1].id)
    console.log(`DAO #${mine[mine.length - 1].id}: the work, in the vote`)
  }
}

async function giveup() {
  const name = opt('as')
  const id = Number(opt('id'))
  const s = await signerOf(name)
  const r = await rec.call(s, d.dao, 'bounty_giveup', { id }, { gas: BOUNTY_GAS.giveup, label: `${name} gives up bounty #${id}` })
  keep(`giveup #${id} by ${name}`, r)
  if (!r.ok) process.exit(1)
}

async function vote() {
  const { board: b, facts, proposals, claims } = await readBoard()
  const only = opt('proposal') ? Number(opt('proposal')) : null
  const voters = houseCouncilSigners()
  const open = b.bounties.filter((x) => x.state !== 'done').length
  const posterOf = (id) => b.bounties.find((x) => x.id === Number(id))?.poster ?? null
  const claimOf = (who, id) => (claims[who] ?? []).find((c) => Number(c.bounty_id) === Number(id)) ?? null
  for (const q of proposals) {
    if (q.status !== 'InProgress' || (only !== null && q.id !== only)) continue
    const age = Date.now() - Number(BigInt(q.submission_time) / 1_000_000n)
    if (age < COUNCIL_DELAY_MS && !flag('now')) {
      console.log(`DAO #${q.id}: ${Math.ceil((COUNCIL_DELAY_MS - age) / 1000)} s until the council's delay is over`)
      continue
    }
    const dec = bountyDecision(q, BR, { token: d.token, members: facts.members, council: facts.council, open, posterOf, claimOf })
    const kind = Object.keys(q.kind)[0]
    console.log(`DAO #${q.id} ${kind}: ${dec.vote ? (dec.approve ? 'approve' : 'reject') : 'no vote'}, ${dec.why}`)
    if (!dec.vote) continue
    const need = kind === 'AddBounty' ? 2 : 1
    const action = dec.approve ? 'VoteApprove' : 'VoteReject'
    let cast = Object.entries(q.votes ?? {}).filter(([a, v]) => facts.council.has(a) && v === (dec.approve ? 'Approve' : 'Reject')).length
    for (const v of voters) {
      if (cast >= need) break
      const cur = await view(d.dao, 'get_proposal', { id: q.id })
      if (cur.status !== 'InProgress') break
      if (v.accountId in (cur.votes ?? {})) continue
      const r = await rec.call(v, d.dao, 'act_proposal', { id: q.id, action, proposal: cur.kind }, { gas: kind === 'BountyDone' ? BOUNTY_GAS.voteDone : BOUNTY_GAS.vote, label: `${v.accountId.split('.')[0]} ${action} DAO #${q.id} (${kind})` })
      keep(`vote ${kind} DAO #${q.id}`, r)
      if (!r.ok) process.exit(1)
      cast++
    }
    const after = await view(d.dao, 'get_proposal', { id: q.id })
    console.log(`DAO #${q.id}: ${after.status}`)
  }
}

async function thank() {
  const id = Number(opt('proposal'))
  const q = await view(d.dao, 'get_proposal', { id })
  if (!q.kind.BountyDone || q.status !== 'Approved') throw new Error(`DAO #${id} is not approved finished work`)
  const { board: b } = await readBoard()
  const bounty = b.bounties.find((x) => x.id === Number(q.kind.BountyDone.bounty_id))
  const poster = bounty?.poster
  const finisher = q.kind.BountyDone.receiver_id
  if (!poster) throw new Error('the poster of this bounty is unknown')
  let raw = process.env.HOUSE_KEYS
  if (!raw) raw = readFileSync(houseKeysFile(d.contract), 'utf8')
  const hk = JSON.parse(raw)
  const cfg = await view(d.contract, 'config')
  const r = Math.floor((Date.now() - Number(cfg.genesis_ms)) / Number(cfg.round_ms)) + 1
  const rv = await view(d.contract, 'round', { n: r })
  const mine = rv.gifts.filter(([g]) => g === poster).map(([, to, given]) => [to, given])
  const gifts = addOnTop(mine, [[finisher, BR.thanks_each]], cfg.cap_per_receiver, cfg.thanks_per_round)
  const pSigner = seedSigner(poster, hk.members[poster])
  const a = await rec.call(pSigner, d.contract, 'allocate', { round: r, gifts, note: null }, { gas: 30n * 10n ** 12n, label: `${poster.split('.')[0]} thanks ${finisher.split('.')[0]} for bounty #${bounty.id}: ${gifts.map(([x, t]) => `${x.split('.')[0]}:${t}`).join(' ')}`, round: r, receipts: false })
  keep(`thank r${r}: ${poster.split('.')[0]} -> ${finisher.split('.')[0]} (bounty #${bounty.id})`, a)
  const note = (rv.notes.find(([x]) => x === finisher) ?? [])[1] ?? null
  const text = bountyNote(note && !note.includes(`#${bounty.id}`) ? note : note?.replace(/ \+ bounty .*$/, '') ?? null, [bounty.id])
  const fSigner = seedSigner(finisher, hk.members[finisher])
  const nr = await rec.call(fSigner, d.contract, 'note', { round: r, text }, { gas: 15n * 10n ** 12n, label: `${finisher.split('.')[0]} note "${text}"`, round: r, receipts: false })
  keep(`note r${r}: ${finisher.split('.')[0]} (bounty #${bounty.id})`, nr)
}

const cmds = { policy, keys: addBountyKeys, 'export-secret': exportSecret, board, post, claim, done, giveup, vote, thank }
if (!cmds[cmd]) {
  console.error('usage: bounties.mjs policy [--file|--vote] | keys | export-secret | board | post | claim | done | giveup | vote | thank  [--section staging|final]')
  process.exit(64)
}
cmds[cmd]().catch((e) => {
  console.error(e.stack || e.message)
  process.exit(1)
})
