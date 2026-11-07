#!/usr/bin/env node
// Creates the community's Sputnik v2 DAO through the public factory `sputnikv2.testnet`, with the
// demo policy of DESIGN.md ("The three tiers, in the DAO"; confirmed on testnet by
// docs/testnet-probe.md), and checks what the DAO reports back.
//
//   node scripts/create-dao.mjs --root <root.testnet> [--section staging] [--payer <account>]
//        [--deposit 6] [--period-hours 24] [--top-up <NEAR>] [--auto-update-off]
//
// - The DAO is `<root name>.sputnikv2.testnet`; council = council-a/b/c.<root>, members = the eight
//   house members <name>.<root> of sim/params.json, role `thanks` = the contract thanks.<root>.
// - The payer (default: the root) attaches `--deposit` NEAR (the factory needs about 5.4 for the
//   DAO's code); `--top-up` sends more NEAR afterwards for the DAO's proposal storage (about 350
//   bytes, 0.0035 NEAR, per payout, kept for good).
// - `--auto-update-off`: council-a files a FactoryInfoUpdate proposal that turns the factory's
//   auto-update off, council-a and council-b approve it (council majority), and the script checks
//   get_factory_info().auto_update = false. Needs the council accounts (scripts/accounts.mjs create).
// Records the DAO, its code hash and version, the policy and every transaction in deploy/testnet.json.
// Testnet only.
import { Signer, keyFromKeychain, transferAction, viewAccount } from './near-lite.mjs'
import { FACTORY, NEAR, Recorder, TGAS, cli, names, nearStr, recordDeploy, recordTx, tryView } from './hat-tip-lib.mjs'
import { view } from './near-lite.mjs'

const { opt, flag } = cli()
const root = opt('root')
const section = opt('section', 'staging')
const n = names(root)
const payer = opt('payer', root)
const deposit = BigInt(Math.round(Number(opt('deposit', '6')) * 1e6)) * 10n ** 18n
const periodNs = BigInt(Math.round(Number(opt('period-hours', '24')) * 3600)) * 10n ** 9n
const BOND = 10n ** 22n // 0.01 NEAR, the demo bond of DESIGN.md

export function demoPolicy({ council, contract, members, bond = BOND, period = periodNs }) {
  return {
    roles: [
      {
        name: 'council',
        kind: { Group: council },
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
        kind: { Group: [contract] },
        permissions: ['transfer:AddProposal', 'transfer:VoteApprove', 'call:AddProposal', 'transfer:Finalize', 'call:Finalize'],
        vote_policy: { transfer: { weight_kind: 'RoleWeight', quorum: '0', threshold: [1, 1] } },
      },
      { name: 'members', kind: { Group: members }, permissions: [], vote_policy: {} },
    ],
    default_vote_policy: { weight_kind: 'RoleWeight', quorum: '0', threshold: [1, 2] },
    proposal_bond: bond.toString(),
    proposal_period: period.toString(),
    bounty_bond: NEAR.toString(),
    bounty_forgiveness_period: (86400n * 10n ** 9n).toString(),
  }
}

/** Canonical JSON of a policy: sorted keys and sorted permission and member sets (hash sets in the DAO). */
export function canon(p) {
  const q = JSON.parse(JSON.stringify(p))
  for (const r of q.roles) {
    r.permissions = [...r.permissions].sort()
    if (r.kind.Group) r.kind.Group = [...r.kind.Group].sort()
  }
  const sortKeys = (x) => Array.isArray(x) ? x.map(sortKeys)
    : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sortKeys(x[k])])) : x
  return JSON.stringify(sortKeys(q))
}

async function main() {
  const rec = new Recorder()
  const policy = demoPolicy({ council: n.council.map((c) => c.account), contract: n.contract, members: n.members.map((m) => m.account) })
  let exists = true
  try { await viewAccount(n.dao, 'optimistic') } catch { exists = false }
  if (!exists) {
    const args = {
      config: { name: n.daoName, purpose: `Hat Tip ${section}: the demo Repair Cafe's treasury (testnet, tUSD has no value)`, metadata: '' },
      policy,
    }
    const s = new Signer(payer, keyFromKeychain(payer))
    const r = await rec.call(s, FACTORY, 'create', { name: n.daoName, args: Buffer.from(JSON.stringify(args)).toString('base64') }, { gas: 300n * TGAS, deposit, label: `create DAO ${n.dao}` })
    if (!r.ok) process.exit(1)
    recordTx(section, 'create DAO', { hash: r.hash, tgas: r.tgas, fee: r.fee, note: `${nearStr(deposit, 2)} NEAR attached by ${payer}` })
  } else {
    console.log(`exists ${n.dao}`)
  }
  if (opt('top-up')) {
    const amount = BigInt(Math.round(Number(opt('top-up')) * 1e6)) * 10n ** 18n
    const s = new Signer(payer, keyFromKeychain(payer))
    const r = await s.send(n.dao, [transferAction(amount)])
    console.log(`top-up ${n.dao} with ${nearStr(amount, 3)} NEAR: ${r.failure ? 'FAILED ' + r.failure : 'ok'}; ${r.hash}`)
    if (r.failure) process.exit(1)
    recordTx(section, 'top up DAO', { hash: r.hash, tgas: Number((BigInt(r.gas) * 100n) / TGAS) / 100, fee: nearStr(r.tokensBurnt), note: `${nearStr(amount, 3)} NEAR for proposal storage` })
  }

  const got = await view(n.dao, 'get_policy')
  const version = await tryView(n.dao, 'version')
  const acc = await viewAccount(n.dao, 'final')
  const factoryInfo = await tryView(n.dao, 'get_factory_info')
  const same = canon(got) === canon(policy)
  console.log(`${same ? 'PASS' : 'FAIL'} get_policy equals the demo policy of DESIGN.md (${n.members.length} members, ${n.council.length} council, thanks = ${n.contract})`)
  console.log(`DAO ${n.dao}: version ${version}, code hash ${acc.code_hash}, ${nearStr(acc.amount, 3)} NEAR, ${acc.storage_usage} bytes, factory auto_update ${factoryInfo?.auto_update}`)
  recordDeploy(section, {
    dao: n.dao,
    dao_policy: got,
    code_hashes: { dao: acc.code_hash },
    dao_version: version,
    factory: FACTORY,
    factory_auto_update: factoryInfo?.auto_update ?? null,
  })
  if (!same) process.exit(1)

  if (flag('auto-update-off') && factoryInfo?.auto_update !== false) {
    const [a, b] = n.council.map((c) => new Signer(c.account, keyFromKeychain(c.account)))
    const kind = { FactoryInfoUpdate: { factory_info: { factory_id: FACTORY, auto_update: false } } }
    const f = await rec.call(a, n.dao, 'add_proposal', { proposal: { description: 'Turn the factory auto-update off: nobody but this DAO changes its code', kind } }, { gas: 30n * TGAS, deposit: BOND, label: 'file FactoryInfoUpdate (auto-update off)' })
    if (!f.ok || typeof f.value !== 'number') process.exit(1)
    recordTx(section, 'auto-update off: proposal', { hash: f.hash, tgas: f.tgas, fee: f.fee, note: `proposal ${f.value} by council-a` })
    for (const s of [a, b]) {
      const v = await rec.call(s, n.dao, 'act_proposal', { id: f.value, action: 'VoteApprove', proposal: kind }, { gas: 50n * TGAS, label: `approve auto-update off (${s.accountId.split('.')[0]})` })
      if (!v.ok) process.exit(1)
      recordTx(section, 'auto-update off: vote', { hash: v.hash, tgas: v.tgas, fee: v.fee, note: s.accountId })
      const p = await view(n.dao, 'get_proposal', { id: f.value })
      if (p.status !== 'InProgress') break
    }
    const info = await view(n.dao, 'get_factory_info')
    console.log(`${info.auto_update === false ? 'PASS' : 'FAIL'} get_factory_info(): ${JSON.stringify(info)}`)
    recordDeploy(section, { factory_auto_update: info.auto_update })
    if (info.auto_update !== false) process.exit(1)
  }
}

main().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
