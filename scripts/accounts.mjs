#!/usr/bin/env node
// The accounts of a Hat Tip deployment on testnet.
//
//   node scripts/accounts.mjs faucet <account.testnet> [--section staging]
//       a new top-level account with 10 NEAR from the testnet faucet, through the NEAR CLI
//       (`sponsor-by-faucet-service`); its key goes to the legacy keychain (mode 600).
//   node scripts/accounts.mjs fund --from <account> --to <account> --near <amount> [--section staging]
//       moves NEAR between two accounts whose keys are in the legacy keychain.
//   node scripts/accounts.mjs create --root <root.testnet> --contract-near <n> --token-near <n>
//                                    [--member-near 0.25] [--council-near 0.3] [--key-allowance 0.25]
//                                    [--section staging]
//       the sub-accounts of the root, each in one transaction signed by the root: the contract
//       (`thanks.`) and the token (`tusd.`), funded for their code; the eight house members and the
//       three house council members of sim/params.json, each with a full-access key (legacy keychain)
//       and a function-call key for the house script: members may call only `allocate` and `note` on
//       the contract, council members only `act_proposal` on the DAO. The function-call seeds go to
//       the git-ignored .secrets/house-keys-<contract>.json (mode 600), the format of the
//       HOUSE_KEYS secret (scripts/house.mjs).
//
// Existing accounts are skipped. Every transaction is recorded in deploy/testnet.json (public facts);
// no key is printed. Testnet only.
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  Signer, addFullAccessKeyAction, addFunctionCallKeyAction, assertTestnet, createAccountAction, keyFromKeychain,
  near, nearPublicKey, nearSecretKey, newKey, transferAction, viewAccount,
} from './near-lite.mjs'
import {
  COUNCIL_METHODS, MEMBER_METHODS, NEAR, cli, houseKeysFile, names, nearStr, readJson, recordDeploy, recordTx,
  seedHexOf, tg, writeSecret,
} from './hat-tip-lib.mjs'

const { opt, positional } = cli()
const cmd = positional[0]
const section = opt('section', 'staging')
const KEYCHAIN = join(homedir(), '.near-credentials', 'testnet')
const toYocto = (s) => {
  if (!/^\d+(\.\d{1,6})?$/.test(String(s ?? ''))) throw new Error(`not an amount of NEAR: ${s}`)
  return BigInt(Math.round(Number(s) * 1e6)) * 10n ** 18n
}

async function exists(account) {
  try {
    await viewAccount(account, 'optimistic')
    return true
  } catch {
    return false
  }
}

/** Keeps every keychain file of `account` readable by the owner only (the CLI writes 0644). */
function lockDown(account) {
  const files = [join(KEYCHAIN, `${account}.json`)]
  const dir = join(KEYCHAIN, account)
  if (existsSync(dir)) for (const f of readdirSync(dir)) files.push(join(dir, f))
  for (const f of files) if (existsSync(f)) chmodSync(f, 0o600)
}

async function faucet() {
  const account = positional[1]
  assertTestnet(account)
  if (await exists(account)) {
    console.log(`exists ${account}`)
    return
  }
  const r = spawnSync('near', ['account', 'create-account', 'sponsor-by-faucet-service', account, 'autogenerate-new-keypair',
    'save-to-legacy-keychain', 'network-config', 'testnet', 'create'], { encoding: 'utf8' })
  lockDown(account)
  const out = `${r.stdout}\n${r.stderr}`
  const tx = /Transaction ID: ([1-9A-HJ-NP-Za-km-z]{43,44})/.exec(out)?.[1]
  // Only these lines are shown: the CLI's output names key files, never print it whole.
  for (const line of out.split('\n')) if (/created successfully|Transaction ID|error|Error|limit/i.test(line) && !/ed25519:/.test(line)) console.log(line.trim())
  let created = false
  for (let i = 0; i < 15 && !created; i++) {
    created = await exists(account)
    if (!created) await new Promise((s) => setTimeout(s, 1000))
  }
  if (r.status !== 0 || !created) {
    console.error(`faucet: ${account} was not created (exit ${r.status})`)
    process.exit(1)
  }
  const a = await viewAccount(account, 'optimistic')
  console.log(`${account}: ${near(a.amount)} NEAR`)
  recordDeploy(section, { accounts: { [account]: { created: 'testnet faucet (NEAR CLI sponsor-by-faucet-service)', near: nearStr(a.amount, 2) } } })
  if (tx) recordTx(section, `faucet ${account}`, { hash: tx, note: 'faucet, 10 NEAR' })
}

async function fund() {
  const from = opt('from')
  const to = opt('to')
  assertTestnet(from, to)
  const amount = toYocto(opt('near'))
  const s = new Signer(from, keyFromKeychain(from))
  const r = await s.send(to, [transferAction(amount)])
  console.log(`${from} -> ${to}: ${nearStr(amount, 4)} NEAR; tx ${r.hash}${r.failure ? ' FAILED ' + r.failure : ''}`)
  if (r.failure) process.exit(1)
  recordTx(section, `fund ${to} from ${from}`, { hash: r.hash, tgas: tg(r.gas), fee: nearStr(r.tokensBurnt), note: `${nearStr(amount, 4)} NEAR` })
}

async function create() {
  const root = opt('root')
  const n = names(root)
  const rootSigner = new Signer(root, keyFromKeychain(root))
  const keyAllowance = toYocto(opt('key-allowance', '0.25'))
  const plan = [
    { account: n.contract, role: 'contract', near: toYocto(opt('contract-near')) },
    { account: n.token, role: 'token', near: toYocto(opt('token-near')) },
    ...n.members.map((m) => ({ account: m.account, role: 'member', near: toYocto(opt('member-near', '0.25')), fc: { receiver: n.contract, methods: MEMBER_METHODS } })),
    ...n.council.map((c) => ({ account: c.account, role: 'council', near: toYocto(opt('council-near', '0.3')), fc: { receiver: n.dao, methods: COUNCIL_METHODS } })),
  ]
  const total = plan.reduce((s, p) => s + p.near, 0n)
  const have = BigInt((await viewAccount(root, 'final')).amount)
  console.log(`plan: ${plan.length} sub-accounts, ${nearStr(total, 3)} NEAR in all; ${root} holds ${nearStr(have, 3)} NEAR`)
  const keysFile = houseKeysFile(n.contract)
  const house = existsSync(keysFile) ? readJson(keysFile) : { v: 1, section, contract: n.contract, dao: n.dao, members: {}, council: {}, keeper: [] }
  for (const p of plan) {
    if (await exists(p.account)) {
      console.log(`exists ${p.account}`)
      continue
    }
    const full = newKey()
    const file = join(KEYCHAIN, `${p.account}.json`)
    if (existsSync(file)) throw new Error(`refusing to overwrite ${file}`)
    writeFileSync(file, JSON.stringify({ account_id: p.account, public_key: nearPublicKey(full), private_key: nearSecretKey(full) }), { mode: 0o600 })
    const actions = [createAccountAction(), transferAction(p.near), addFullAccessKeyAction(nearPublicKey(full))]
    let fcKey = null
    if (p.fc) {
      // The allowance covers the gas a call buys up front (10^9 yocto per gas, docs/testnet-probe.md);
      // unused gas flows back into it.
      fcKey = newKey()
      actions.push(addFunctionCallKeyAction({ publicKey: nearPublicKey(fcKey), receiverId: p.fc.receiver, methods: p.fc.methods, allowance: keyAllowance }))
    }
    const r = await rootSigner.send(p.account, actions)
    console.log(`create ${p.account} (${p.role}) with ${nearStr(p.near, 3)} NEAR${fcKey ? ` and a function-call key for ${p.fc.receiver} (${p.fc.methods.join(', ')})` : ''}: ${r.failure ? 'FAILED ' + r.failure : 'ok'}; ${tg(r.gas)} Tgas; ${r.hash}`)
    if (r.failure) process.exit(1)
    recordTx(section, `create ${p.account}`, { hash: r.hash, tgas: tg(r.gas), fee: nearStr(r.tokensBurnt), note: `${nearStr(p.near, 3)} NEAR` })
    recordDeploy(section, { accounts: { [p.account]: { role: p.role, funded_near: nearStr(p.near, 3), full_access_key: nearPublicKey(full), ...(fcKey ? { function_call_key: { public_key: nearPublicKey(fcKey), receiver: p.fc.receiver, methods: p.fc.methods, allowance_near: nearStr(keyAllowance, 2) } } : {}) } } })
    if (fcKey) {
      house[p.role === 'member' ? 'members' : 'council'][p.account] = seedHexOf(fcKey)
      writeSecret(`house-keys-${n.contract}.json`, house)
    }
  }
  recordDeploy(section, {
    root, contract: n.contract, token: n.token, dao: n.dao,
    house: {
      strategies: 'sim/params.json, house; played by scripts/house.mjs',
      members: n.members.map((m) => ({ account: m.account, name: m.name, kind: m.kind, label: m.label || null, strategy: m.strategy })),
      council: n.council.map((c) => ({ account: c.account, name: c.name, rule: c.strategy })),
    },
  })
  console.log(`house function-call keys: .secrets/house-keys-${n.contract}.json (${Object.keys(house.members).length} members, ${Object.keys(house.council).length} council)`)
}

const run = { faucet, fund, create }[cmd]
if (!run) {
  console.error('usage: accounts.mjs faucet <account> | fund --from <a> --to <b> --near <n> | create --root <root> --contract-near <n> --token-near <n>')
  process.exit(64)
}
run().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
