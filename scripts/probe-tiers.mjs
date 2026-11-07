#!/usr/bin/env node
// Hat Tip, D0 feasibility probe: do the three payout tiers work with a real Sputnik DAO v2 on
// testnet, with the policy of DESIGN.md ("The three tiers, in the DAO")?
//
// A throwaway DAO from sputnikv2.testnet; a plain account (`standin`) stands in for the keyless
// contract in role `thanks`; wNEAR (wrap.testnet, a standard NEP-141) stands in for tUSD.
//
//   node scripts/probe-tiers.mjs setup  --root <faucet account>   accounts, wNEAR, DAO
//   node scripts/probe-tiers.mjs probe  --root <faucet account>   the tier checks
//   node scripts/probe-tiers.mjs gas    --root <faucet account>   gas a payout vote must carry
//   node scripts/probe-tiers.mjs expire --root <faucet account>   finalize after expiry (5 min)
//
// Every transaction lands in docs/testnet-probe.json (public facts only). Keys of the accounts this
// script creates go to the legacy keychain (~/.near-credentials/testnet, mode 600); none is printed.
// Testnet only.
import crypto from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  Signer, rpc, viewAccount, keyFromKeychain, newKey, nearPublicKey, nearSecretKey,
  functionCallAction, transferAction, createAccountAction, addFullAccessKeyAction, assertTestnet,
} from './near-lite.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const stage = args[0]
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : dflt
}
const ROOT = opt('root')
const OUT = opt('out', join(here, '..', 'docs', 'testnet-probe.json'))
if (!['setup', 'probe', 'expire', 'gas'].includes(stage) || !ROOT) {
  console.error('usage: probe-tiers.mjs setup|probe|gas|expire --root <account.testnet> [--out file]')
  process.exit(2)
}
assertTestnet(ROOT)

const NEAR = 10n ** 24n
const TGAS = 10n ** 12n
const FACTORY = 'sputnikv2.testnet'
const TOKEN = 'wrap.testnet' // stands in for tUSD: a standard NEP-141 anyone can fill
const BOND = 10n ** 22n // 0.01 NEAR, the demo bond of DESIGN.md
const PERIOD_NS = 300n * 10n ** 9n // 5 minutes instead of 24 h, so that expiry can be probed
const DAO_DEPOSIT = 6n * NEAR
const FT_REG = 1_250_000_000_000_000_000_000n // wrap.testnet storage_balance_bounds.min

const daoName = ROOT.replace(/\.testnet$/, '')
const DAO = `${daoName}.${FACTORY}`
const acc = (n) => `${n}.${ROOT}`
const A = {
  councilA: acc('council-a'), councilB: acc('council-b'), councilC: acc('council-c'),
  standin: acc('standin'), // the keyless contract's place in role `thanks`
  recv: acc('recv'), // a member who receives payouts
  outsider: acc('outsider'), // in no role
}
const FUND = {
  councilA: NEAR / 5n, councilB: NEAR / 5n, councilC: NEAR / 5n,
  standin: NEAR / 2n, recv: NEAR / 10n, outsider: NEAR / 10n,
}

// ---- evidence file ------------------------------------------------------------------------------

const ev = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { network: 'testnet', root: ROOT, dao: DAO, token: TOKEN, accounts: A, steps: [], ids: {} }
const save = () => {
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, JSON.stringify(ev, null, 1) + '\n')
}
const tg = (g) => Number((BigInt(g) * 100n) / TGAS) / 100
const nearStr = (y) => (Number(BigInt(y) / 10n ** 16n) / 1e8).toFixed(6)

/** Receipts of a transaction: who ran what, gas, status; refunds left out. */
async function receiptsOf(hash, sender) {
  const r = await rpc('EXPERIMENTAL_tx_status', { tx_hash: hash, sender_account_id: sender, wait_until: 'EXECUTED_OPTIMISTIC' })
  const byId = new Map(r.receipts.map((x) => [x.receipt_id, x]))
  const out = []
  for (const o of r.receipts_outcome) {
    const rc = byId.get(o.id)
    if (rc && rc.predecessor_id === 'system') continue // gas refunds
    const actions = rc?.receipt?.Action?.actions ?? []
    const what = actions.map((a) => {
      if (typeof a === 'string') return a // CreateAccount
      if (a.FunctionCall) return `${a.FunctionCall.method_name}(${a.FunctionCall.deposit === '0' ? '' : 'deposit ' + a.FunctionCall.deposit})`
      if (a.Transfer) return `Transfer ${nearStr(a.Transfer.deposit)} NEAR`
      return Object.keys(a)[0] ?? String(a)
    }).join(', ')
    const st = o.outcome.status
    out.push({
      from: rc?.predecessor_id, to: o.outcome.executor_id, what, tgas: tg(o.outcome.gas_burnt),
      ok: st.Failure === undefined, failure: st.Failure ? JSON.stringify(st.Failure).slice(0, 300) : undefined,
      logs: o.outcome.logs.length ? o.outcome.logs.map((l) => l.slice(0, 200)) : undefined,
    })
  }
  const all = [r.transaction_outcome, ...r.receipts_outcome]
  return {
    receipts: out,
    gasTotal: tg(all.reduce((n, o) => n + BigInt(o.outcome.gas_burnt), 0n)),
    fee: nearStr(all.reduce((n, o) => n + BigInt(o.outcome.tokens_burnt), 0n)),
  }
}

/** A view call; a contract panic becomes an Error whose message carries the panic text. */
async function view(contract, method, a = {}) {
  const r = await rpc('query', {
    request_type: 'call_function', finality: 'optimistic', account_id: contract, method_name: method,
    args_base64: Buffer.from(JSON.stringify(a)).toString('base64'),
  })
  if (r.error) throw new Error(`view ${contract}.${method}: ${r.error}`)
  return JSON.parse(Buffer.from(r.result).toString('utf8'))
}

const signers = {}
const signer = (account) => (signers[account] ??= new Signer(account, keyFromKeychain(account)))

/**
 * Sends one transaction and records it. `expect`: 'ok' or a substring the failure must contain.
 * Returns the record. In `setup` an unexpected outcome stops the run; in the probe stages it is
 * recorded as FAIL and the run goes on, so that one broken tier does not hide the others.
 */
async function step(id, label, from, to, actionsOrCall, { expect = 'ok', soft = stage !== 'setup' } = {}) {
  const s = signer(from)
  const res = Array.isArray(actionsOrCall)
    ? await s.send(to, actionsOrCall)
    : await s.call(to, actionsOrCall.method, actionsOrCall.args, actionsOrCall)
  const det = await receiptsOf(res.hash, from)
  const rec = {
    id, label, signer: from, receiver: to,
    method: Array.isArray(actionsOrCall) ? 'actions' : actionsOrCall.method,
    hash: res.hash, ok: !res.failure, failure: res.failure ? res.failure.slice(0, 400) : undefined,
    value: res.value ?? undefined, gasTotal: det.gasTotal, fee: det.fee, receipts: det.receipts,
    at: new Date().toISOString(), run: stage === 'probe' ? ev.probeRuns : stage,
  }
  const allOk = det.receipts.every((r) => r.ok)
  const okAsExpected = expect === 'ok' ? rec.ok && allOk
    : expect === 'inner-fail' ? rec.ok && !allOk // the call succeeds, a later receipt (the payout) fails
    : !rec.ok && rec.failure.includes(expect)
  rec.expected = expect
  rec.asExpected = okAsExpected
  ev.steps.push(rec)
  save()
  const line = `${okAsExpected ? 'PASS' : 'FAIL'} ${id} ${label}: ${rec.ok ? 'ok' : 'failed ' + (rec.failure.match(/ERR_[A-Z_]+|[A-Za-z ]*not registered[^"]*/)?.[0] ?? rec.failure.slice(0, 120))}; ${rec.gasTotal} Tgas, fee ${rec.fee} NEAR; ${rec.hash}`
  console.log(line)
  for (const r of det.receipts) console.log(`      ${r.from} -> ${r.to}: ${r.what} ${r.tgas} Tgas${r.ok ? '' : ' FAILED ' + (r.failure ?? '')}`)
  if (!okAsExpected && !soft) throw new Error(`${id}: outcome not as expected`)
  return rec
}

function check(id, label, pass, detail) {
  const rec = { id, label, check: true, asExpected: !!pass, detail, at: new Date().toISOString(), run: stage === 'probe' ? ev.probeRuns : stage }
  ev.steps.push(rec)
  save()
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id} ${label}${detail !== undefined ? ': ' + JSON.stringify(detail) : ''}`)
  return pass
}

const ft = async (who) => BigInt(await view(TOKEN, 'ft_balance_of', { account_id: who }))
const proposal = async (pid) => {
  try {
    return await view(DAO, 'get_proposal', { id: pid })
  } catch (e) {
    if (/ERR_NO_PROPOSAL/.test(e.message)) return null // removed proposals are deleted
    throw e
  }
}
const storage = async (who) => (await viewAccount(who, 'optimistic')).storage_usage
const bondBack = (rec) => rec.receipts.some((r) => r.from === DAO && r.to === A.standin && r.what === `Transfer ${nearStr(BOND)} NEAR`)

// ---- the policy ---------------------------------------------------------------------------------

const POLICY = {
  roles: [
    {
      name: 'council',
      kind: { Group: [A.councilA, A.councilB, A.councilC] },
      permissions: [
        'transfer:AddProposal', 'config:AddProposal', 'policy:AddProposal',
        'policy_add_or_update_role:AddProposal', 'policy_remove_role:AddProposal',
        'policy_update_default_vote_policy:AddProposal', 'policy_update_parameters:AddProposal',
        'add_member_to_role:AddProposal', 'remove_member_from_role:AddProposal',
        'factory_info_update:AddProposal', 'vote:AddProposal',
        '*:VoteApprove', '*:VoteReject', '*:VoteRemove', '*:Finalize',
      ],
      vote_policy: { call: { weight_kind: 'RoleWeight', quorum: '0', threshold: '1' } },
    },
    {
      name: 'thanks',
      kind: { Group: [A.standin] },
      permissions: ['transfer:AddProposal', 'transfer:VoteApprove', 'call:AddProposal', 'transfer:Finalize', 'call:Finalize'],
      vote_policy: { transfer: { weight_kind: 'RoleWeight', quorum: '0', threshold: [1, 1] } },
    },
    { name: 'members', kind: { Group: [A.recv] }, permissions: [], vote_policy: {} },
  ],
  default_vote_policy: { weight_kind: 'RoleWeight', quorum: '0', threshold: [1, 2] },
  proposal_bond: BOND.toString(),
  proposal_period: PERIOD_NS.toString(),
  bounty_bond: NEAR.toString(),
  bounty_forgiveness_period: (86400n * 10n ** 9n).toString(),
}

// ---- proposal kinds, built the way the contract will build them ---------------------------------

const transferKind = (receiver, amount) => ({ Transfer: { token_id: TOKEN, receiver_id: receiver, amount: amount.toString() } })
const callKind = (receiver, amount) => ({
  FunctionCall: {
    receiver_id: TOKEN,
    actions: [{
      method_name: 'ft_transfer',
      args: Buffer.from(JSON.stringify({ receiver_id: receiver, amount: amount.toString() })).toString('base64'),
      deposit: '1',
      gas: (10n * TGAS).toString(),
    }],
  },
})
const addProposal = (description, kind, gas = 30n * TGAS) => ({ method: 'add_proposal', args: { proposal: { description, kind } }, deposit: BOND, gas })
const act = (pid, action, kind, gas = 100n * TGAS) => ({ method: 'act_proposal', args: { id: pid, action, proposal: kind }, gas })

/** Files a proposal from `from` and returns its id (the DAO returns it as the call's value). */
async function file(id, label, from, description, kind, opts) {
  const before = await storage(DAO)
  const rec = await step(id, label, from, DAO, addProposal(description, kind), opts)
  if (rec.ok && typeof rec.value === 'number') {
    rec.proposalId = rec.value
    rec.daoStorageDelta = (await storage(DAO)) - before
    save()
    console.log(`      proposal id ${rec.value}, DAO storage +${rec.daoStorageDelta} bytes`)
  }
  return rec
}

// ---- stages -------------------------------------------------------------------------------------

async function setup() {
  const root = signer(ROOT)
  // Sub-accounts with fresh full-access keys, stored in the legacy keychain.
  for (const [k, account] of Object.entries(A)) {
    let exists = true
    try { await viewAccount(account, 'optimistic') } catch { exists = false }
    if (exists) { console.log(`exists ${account}`); continue }
    const key = newKey()
    const file = join(homedir(), '.near-credentials', 'testnet', `${account}.json`)
    if (existsSync(file)) throw new Error(`refusing to overwrite ${file}`)
    writeFileSync(file, JSON.stringify({ account_id: account, public_key: nearPublicKey(key), private_key: nearSecretKey(key) }), { mode: 0o600 })
    await step(`S-${k}`, `create ${account} with ${nearStr(FUND[k])} NEAR`, ROOT, account,
      [createAccountAction(), transferAction(FUND[k]), addFullAccessKeyAction(nearPublicKey(key))])
  }
  // wNEAR: register root, the DAO-to-be is registered after creation; recv is registered now.
  for (const who of [ROOT, A.recv]) {
    const sb = await view(TOKEN, 'storage_balance_of', { account_id: who })
    if (!sb) await step(`S-reg-${who.split('.')[0]}`, `register ${who} with ${TOKEN}`, ROOT, TOKEN, { method: 'storage_deposit', args: { account_id: who, registration_only: true }, deposit: FT_REG })
  }
  if ((await ft(ROOT)) < 6n * 10n ** 22n) await step('S-wrap', 'wrap 0.06 NEAR into wNEAR', ROOT, TOKEN, { method: 'near_deposit', args: {}, deposit: 6n * 10n ** 22n })
  // The DAO.
  let daoExists = true
  try { await viewAccount(DAO, 'optimistic') } catch { daoExists = false }
  if (!daoExists) {
    const daoArgs = { config: { name: daoName, purpose: 'Hat Tip tier probe (throwaway)', metadata: '' }, policy: POLICY }
    await step('S-dao', `create DAO ${DAO} with ${nearStr(DAO_DEPOSIT)} NEAR`, ROOT, FACTORY,
      { method: 'create', args: { name: daoName, args: Buffer.from(JSON.stringify(daoArgs)).toString('base64') }, deposit: DAO_DEPOSIT, gas: 300n * TGAS })
  }
  ev.policy = await view(DAO, 'get_policy')
  ev.daoVersion = await view(DAO, 'version').catch(() => null)
  ev.daoCodeHash = (await viewAccount(DAO, 'optimistic')).code_hash
  save()
  check('S-policy', 'get_policy equals the policy sent', canon(ev.policy) === canon(POLICY), { version: ev.daoVersion, code_hash: ev.daoCodeHash })
  if (!(await view(TOKEN, 'storage_balance_of', { account_id: DAO }))) {
    await step('S-reg-dao', `register ${DAO} with ${TOKEN}`, ROOT, TOKEN, { method: 'storage_deposit', args: { account_id: DAO, registration_only: true }, deposit: FT_REG })
  }
  if ((await ft(DAO)) < 5n * 10n ** 22n) await step('S-fund-dao', 'send 0.05 wNEAR to the DAO', ROOT, TOKEN, { method: 'ft_transfer', args: { receiver_id: DAO, amount: (5n * 10n ** 22n).toString() }, deposit: 1n })
  console.log(`DAO wNEAR ${nearStr(await ft(DAO))}`)
}

// Canonical JSON of a policy: sorted keys, sorted permission and member sets (the DAO keeps them
// in hash sets, so their order is not stable).
function canon(p) {
  const q = JSON.parse(JSON.stringify(p))
  for (const r of q.roles) {
    r.permissions = [...r.permissions].sort()
    if (r.kind.Group) r.kind.Group = [...r.kind.Group].sort()
  }
  const sortKeys = (x) => Array.isArray(x) ? x.map(sortKeys)
    : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sortKeys(x[k])])) : x
  return JSON.stringify(sortKeys(q))
}

async function probe() {
  ev.probeRuns = (ev.probeRuns ?? 0) + 1
  const unregistered = crypto.randomBytes(32).toString('hex') // an implicit account no token knows
  ev.ids.unregistered = unregistered
  const amt = { t1: 10n ** 21n, t2: 2n * 10n ** 21n, t3: 3n * 10n ** 21n }

  // E: a tier-3 transfer that gets one council reject and is then left to expire (stage `expire`).
  const e = await file('E-file', 'tier 3 transfer, to be left to expire', A.standin, 'probe: tier 3 left to expire', transferKind(A.recv, amt.t3))
  ev.ids.expire = e.value
  await step('E-reject1', 'one council VoteReject on a tier-3 transfer', A.councilC, DAO, act(e.value, 'VoteReject', transferKind(A.recv, amt.t3)))
  check('E-status', 'one reject of three leaves a tier-3 transfer InProgress', (await proposal(e.value)).status === 'InProgress', (await proposal(e.value)).status)

  // T1: tier 1, the role files a Transfer and approves it alone.
  let r0 = await ft(A.recv)
  const t1 = await file('T1-file', 'tier 1: role files a Transfer', A.standin, 'probe: tier 1 auto', transferKind(A.recv, amt.t1))
  const t1v = await step('T1-vote', 'tier 1: role votes VoteApprove (1 of 1)', A.standin, DAO, act(t1.value, 'VoteApprove', transferKind(A.recv, amt.t1)))
  let p = await proposal(t1.value)
  check('T1-status', 'tier 1 Approved and paid by the role alone', p.status === 'Approved' && (await ft(A.recv)) - r0 === amt.t1, { status: p.status, paid: ((await ft(A.recv)) - r0).toString() })
  check('T1-bond', 'tier 1 bond returned to the role', bondBack(t1v))

  // T2: tier 2, the role files a FunctionCall ft_transfer; only a council vote passes it.
  r0 = await ft(A.recv)
  const t2 = await file('T2-file', 'tier 2: role files FunctionCall ft_transfer', A.standin, 'probe: tier 2 one council vote', callKind(A.recv, amt.t2))
  await step('T2-role-vote', 'tier 2: role tries VoteApprove on a call', A.standin, DAO, act(t2.value, 'VoteApprove', callKind(A.recv, amt.t2)), { expect: 'ERR_PERMISSION_DENIED' })
  // 30 Tgas: the signer must hold the prepaid gas at the receipt purchase price (10^9 yocto/gas,
  // ten times the burn price), and recv holds only 0.1 NEAR.
  await step('T2-member-vote', 'tier 2: member tries VoteApprove on a call', A.recv, DAO, act(t2.value, 'VoteApprove', callKind(A.recv, amt.t2), 30n * TGAS), { expect: 'ERR_PERMISSION_DENIED' })
  check('T2-pending', 'tier 2 still InProgress, nothing paid', (await proposal(t2.value)).status === 'InProgress' && (await ft(A.recv)) === r0)
  const t2v = await step('T2-vote', 'tier 2: one council VoteApprove', A.councilA, DAO, act(t2.value, 'VoteApprove', callKind(A.recv, amt.t2)))
  p = await proposal(t2.value)
  check('T2-status', 'tier 2 Approved and paid on one council vote', p.status === 'Approved' && (await ft(A.recv)) - r0 === amt.t2, { status: p.status, votes: p.votes, paid: ((await ft(A.recv)) - r0).toString() })
  check('T2-bond', 'tier 2 bond returned to the role', bondBack(t2v))

  // Who may file a call: only the role.
  await file('C-council-call', 'council tries to file a FunctionCall', A.councilA, 'probe: council call', callKind(A.councilA, amt.t2), { expect: 'ERR_PERMISSION_DENIED' })
  await file('C-member-transfer', 'member tries to file a Transfer', A.recv, 'probe: member transfer', transferKind(A.recv, amt.t1), { expect: 'ERR_PERMISSION_DENIED' })
  await file('C-outsider-transfer', 'outsider tries to file a Transfer', A.outsider, 'probe: outsider transfer', transferKind(A.outsider, amt.t1), { expect: 'ERR_PERMISSION_DENIED' })

  // T2 reject and remove: one council vote each.
  r0 = await ft(A.recv)
  const t2r = await file('T2R-file', 'tier 2 to be rejected', A.standin, 'probe: tier 2 reject', callKind(A.recv, amt.t2))
  const t2rv = await step('T2R-vote', 'tier 2: one council VoteReject', A.councilB, DAO, act(t2r.value, 'VoteReject', callKind(A.recv, amt.t2)))
  p = await proposal(t2r.value)
  check('T2R-status', 'tier 2 Rejected on one council vote, nothing paid', p.status === 'Rejected' && (await ft(A.recv)) === r0, p.status)
  check('T2R-bond', 'rejected: bond returned to the role', bondBack(t2rv))
  const t2x = await file('T2X-file', 'tier 2 to be removed', A.standin, 'probe: tier 2 remove', callKind(A.recv, amt.t2))
  const t2xv = await step('T2X-vote', 'tier 2: one council VoteRemove', A.councilC, DAO, act(t2x.value, 'VoteRemove', callKind(A.recv, amt.t2)))
  check('T2X-status', 'tier 2 Removed on one council vote (proposal gone)', (await proposal(t2x.value)) === null)
  check('T2X-bond', 'removed: bond kept by the DAO', !bondBack(t2xv))

  // T3: tier 3, the role files a Transfer without voting; the council needs two votes.
  r0 = await ft(A.recv)
  const t3 = await file('T3-file', 'tier 3: role files a Transfer, no vote', A.standin, 'probe: tier 3 council majority', transferKind(A.recv, amt.t3))
  await step('T3-vote1', 'tier 3: first council VoteApprove', A.councilA, DAO, act(t3.value, 'VoteApprove', transferKind(A.recv, amt.t3)))
  check('T3-pending', 'tier 3 InProgress after one council vote, nothing paid', (await proposal(t3.value)).status === 'InProgress' && (await ft(A.recv)) === r0)
  const t3v = await step('T3-vote2', 'tier 3: second council VoteApprove', A.councilB, DAO, act(t3.value, 'VoteApprove', transferKind(A.recv, amt.t3)))
  p = await proposal(t3.value)
  check('T3-status', 'tier 3 Approved and paid on the second council vote', p.status === 'Approved' && (await ft(A.recv)) - r0 === amt.t3, { status: p.status, votes: p.votes })
  check('T3-bond', 'tier 3 bond returned to the role', bondBack(t3v))

  // U: ft_transfer to an unregistered account fails; register, then Finalize re-runs it.
  const u = await file('U-file', 'tier 1 Transfer to an unregistered implicit account', A.standin, 'probe: unregistered receiver', transferKind(unregistered, amt.t1))
  const uv = await step('U-vote', 'role approves it: ft_transfer must fail', A.standin, DAO, act(u.value, 'VoteApprove', transferKind(unregistered, amt.t1)), { expect: 'inner-fail' })
  p = await proposal(u.value)
  check('U-status', 'unregistered receiver: proposal Failed, bond held', p.status === 'Failed' && !bondBack(uv), p.status)
  await step('U-register', 'register the implicit account with the token', ROOT, TOKEN, { method: 'storage_deposit', args: { account_id: unregistered, registration_only: true }, deposit: FT_REG })
  const uf = await step('U-finalize', 'role calls Finalize on the Failed proposal', A.standin, DAO, act(u.value, 'Finalize', transferKind(unregistered, amt.t1)))
  p = await proposal(u.value)
  check('U-retry', 'Finalize re-executes it: Approved, paid, bond returned', p.status === 'Approved' && (await ft(unregistered)) === amt.t1 && bondBack(uf), p.status)

  const sub = BigInt((await proposal(ev.ids.expire)).submission_time)
  ev.ids.expireAfterMs = Number((sub + PERIOD_NS) / 1_000_000n)
  save()
  console.log(`expire stage possible after ${new Date(ev.ids.expireAfterMs).toISOString()}`)
}

/**
 * Every proposal still InProgress (the tier-3 transfer with one reject, and any proposal a stopped
 * run left open) is finalized by the role after it expired: the DAO must mark it Expired and return
 * the bond. Covers both `transfer:Finalize` and `call:Finalize` of role `thanks`.
 */
async function expire() {
  const last = await view(DAO, 'get_last_proposal_id')
  const open = []
  for (let pid = 0; pid < last; pid++) {
    const p = await proposal(pid)
    if (p && p.status === 'InProgress') open.push(p)
  }
  const until = Math.max(...open.map((p) => Number((BigInt(p.submission_time) + PERIOD_NS) / 1_000_000n)))
  const wait = until + 5_000 - Date.now()
  if (open.length && wait > 0) {
    console.log(`waiting ${Math.ceil(wait / 1000)} s for proposals ${open.map((p) => p.id).join(', ')} to expire`)
    await new Promise((r) => setTimeout(r, wait))
  }
  for (const p of open) {
    const label = p.kind.FunctionCall ? 'tier-2 call' : 'tier-3 transfer'
    const f = await step(`E-finalize-${p.id}`, `role calls Finalize on expired ${label} #${p.id}`, A.standin, DAO, act(p.id, 'Finalize', p.kind))
    const q = await proposal(p.id)
    check(`E-expired-${p.id}`, `expired ${label} #${p.id}: status Expired, bond returned to the role`, q.status === 'Expired' && bondBack(f), q.status)
  }
  ev.final = {
    daoNear: (await viewAccount(DAO, 'optimistic')).amount,
    daoStorage: await storage(DAO),
    daoLocked: await view(DAO, 'get_locked_storage_amount').catch(() => null),
    daoWnear: (await ft(DAO)).toString(),
    lastProposalId: await view(DAO, 'get_last_proposal_id'),
    balances: Object.fromEntries(await Promise.all([ROOT, ...Object.values(A)].map(async (a) => [a, (await viewAccount(a, 'optimistic')).amount]))),
  }
  save()
}

/**
 * How much gas must `act_proposal` carry when the vote executes the payout? The DAO reserves
 * 10 Tgas for ft_transfer (Transfer) or the action's own gas (FunctionCall), plus 10 Tgas for
 * on_proposal_callback. Votes with too little gas fail and leave the proposal untouched.
 */
async function gas() {
  const amt = 10n ** 21n
  for (const g of [20n, 25n, 30n]) {
    const k = transferKind(A.recv, amt)
    const f = await file(`G-file-${g}`, `tier 1 Transfer for a vote with ${g} Tgas`, A.standin, `probe: vote gas ${g}`, k, {})
    const v = await step(`G-vote-${g}`, `tier 1 vote with ${g} Tgas attached`, A.standin, DAO, act(f.value, 'VoteApprove', k, g * TGAS), { expect: g < 25n ? 'Exceeded the prepaid gas' : 'ok', soft: true })
    if (!v.ok) {
      check(`G-untouched-${g}`, `failed ${g} Tgas vote left proposal #${f.value} InProgress`, (await proposal(f.value)).status === 'InProgress')
      await step(`G-revote-${g}`, `same vote again with 30 Tgas`, A.standin, DAO, act(f.value, 'VoteApprove', k, 30n * TGAS))
    }
  }
  // A council vote on a tier-2 call with 25 Tgas (action gas 10 Tgas + callback 10 Tgas).
  const k2 = callKind(A.recv, amt)
  const f2 = await file('G-file-call', 'tier 2 call for a council vote with 25 Tgas', A.standin, 'probe: council vote gas 25', k2)
  await step('G-vote-call-25', 'council vote on tier 2 with 25 Tgas attached', A.councilA, DAO, act(f2.value, 'VoteApprove', k2, 25n * TGAS))
  check('G-call-status', 'tier 2 paid with a 25 Tgas council vote', (await proposal(f2.value)).status === 'Approved')
}

const run = { setup, probe, expire, gas }[stage]
run().then(() => {
  const fails = ev.steps.filter((s) => !s.asExpected).length
  console.log(`done: ${ev.steps.length} records, ${fails} not as expected`)
}, (e) => {
  console.error(e.message)
  process.exit(1)
})
