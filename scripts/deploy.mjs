#!/usr/bin/env node
// Deploys tUSD and the Hat Tip contract to their accounts and runs `new` in the same transaction,
// checks the result, and, asked to, locks the account by deleting every access key.
//
//   node scripts/deploy.mjs token    --root <root.testnet> [--section staging] [--wasm <path>]
//                                    [--lock | --verify-only | --lock-only]
//   node scripts/deploy.mjs contract --root <root.testnet> [--section staging] [--wasm <path>]
//                                    [--set <field>=<value> ...] [--genesis <ms> | --genesis-delay <minutes>]
//                                    [--lock | --verify-only | --lock-only]
//
// - Accounts: tusd.<root> and thanks.<root> (scripts/accounts.mjs create), DAO <root name>.sputnikv2.testnet
//   (scripts/create-dao.mjs). Each signs with its full-access key from the legacy keychain.
// - The wasm defaults to token/target/near/tusd.wasm and contract/target/near/hat_tip.wasm (what
//   build.sh prints) and must match token/WASM_SHA256 or contract/WASM_SHA256.
// - token: new(owner_id = the DAO, total_supply = 1,000,000 tUSD, metadata of token/README.md). Checks:
//   code hash, supply, the DAO holds all of it and is registered, metadata, keys.
// - contract: new(config) with the testnet block of sim/params.json, `dao`, `token` and
//   `genesis_ms` filled in (default: the next full minute plus --genesis-delay minutes, default 0).
//   --set changes one value, e.g. --set round_ms=300000 (repeatable; amounts in base units).
//   Then sync() reads the DAO policy. Checks: code hash, config() field by field, state() after
//   the sync (not paused, the eight house members, the three council members, the bond),
//   audit(), keys.
// - --lock deploys, checks, and only if every check passed deletes every access key, then waits
//   until view_access_key_list returns no keys. It cannot be undone; never on staging.
//   --verify-only and --lock-only skip the deployment (give the same --set values).
// Records code hashes, the config and every transaction in deploy/testnet.json. Testnet only.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  Signer, accessKeys, b58encode, deleteKeyAction, deployContractAction, functionCallAction, keyFromKeychain,
  nearPublicKey, rpc, view, viewAccount,
} from './near-lite.mjs'
import { GAS, NEAR, ROOT, Recorder, TGAS, cli, loadParams, names, nearStr, recordDeploy, recordTx, sleep, tg } from './hat-tip-lib.mjs'

const { argv, opt, flag, positional } = cli()
const what = positional[0]
const root = opt('root')
const section = opt('section', 'staging')
const modes = ['lock', 'verify-only', 'lock-only'].filter((m) => flag(m))
if (!['token', 'contract'].includes(what) || !root || modes.length > 1) {
  console.error('usage: deploy.mjs token|contract --root <root.testnet> [--section staging] [--wasm <path>] [--set f=v ...] [--genesis <ms>] [--lock | --verify-only | --lock-only]')
  process.exit(64)
}
const n = names(root)
const account = what === 'token' ? n.token : n.contract
const deploy = !flag('verify-only') && !flag('lock-only')
const lock = flag('lock') || flag('lock-only')
if (lock && section === 'staging') {
  console.error('--lock on the staging deployment: refused (staging keeps its keys, PLAN.md package c)')
  process.exit(64)
}
const dir = what === 'token' ? 'token' : 'contract'
const wasmPath = opt('wasm') ?? join(ROOT, dir, 'target', 'near', what === 'token' ? 'tusd.wasm' : 'hat_tip.wasm')
const code = readFileSync(wasmPath)
const sha = createHash('sha256').update(code).digest()
const codeHash = b58encode(sha)
const pinnedHex = readFileSync(join(ROOT, dir, 'WASM_SHA256'), 'utf8').trim()
console.log(`${what} wasm: ${code.length} bytes, sha256 ${sha.toString('hex')}, code hash ${codeHash}`)
if (pinnedHex !== sha.toString('hex')) {
  console.error(`the wasm does not match ${dir}/WASM_SHA256 (${pinnedHex}): build it with ${dir}/build.sh --check`)
  process.exit(65)
}
console.log(`matches ${dir}/WASM_SHA256`)

const signer = new Signer(account, keyFromKeychain(account))
const rec = new Recorder()
const problems = []
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== '' ? ': ' + detail : ''}`)
  if (!ok) problems.push(label)
}

// ---- init arguments ---------------------------------------------------------------------------------

const SUPPLY = '1000000000000' // 1,000,000 tUSD at 6 decimals
const METADATA = { spec: 'ft-1.0.0', name: 'Test dollar (Hat Tip demo, no value)', symbol: 'tUSD', icon: null, reference: null, reference_hash: null, decimals: 6 }

function contractConfig() {
  const params = loadParams().testnet.config
  const cfg = { ...params, dao: n.dao, token: n.token }
  for (const s of argv.flatMap((a, i) => (a === '--set' ? [argv[i + 1]] : []))) {
    const m = /^([a-z_]+)=(.+)$/.exec(s ?? '')
    if (!m || ['dao', 'token', 'genesis_ms'].includes(m[1])) throw new Error(`--set ${s}: expected <field>=<value> for a config field other than dao, token, genesis_ms`)
    const [, field, value] = m
    const old = params[field]
    if (typeof old === 'number') {
      if (!/^\d+$/.test(value)) throw new Error(`--set ${field}: a whole number`)
      cfg[field] = Number(value)
    } else if (typeof old === 'boolean') {
      cfg[field] = value === 'true'
    } else if (typeof old === 'string' && /^\d+$/.test(old)) {
      if (!/^\d+$/.test(value)) throw new Error(`--set ${field}: an amount in base units`)
      cfg[field] = value
    } else if (old === undefined && field === 'guest_receive_cap_bp') {
      cfg[field] = Number(value)
    } else {
      throw new Error(`--set ${field}: not a settable field`)
    }
    console.log(`--set ${field} = ${value} (sim/params.json: ${old ?? 'absent'})`)
  }
  return cfg
}

// ---- deploy -----------------------------------------------------------------------------------------

async function deployIt(initArgs) {
  const acc = await viewAccount(account, 'final')
  if (acc.code_hash !== '11111111111111111111111111111111') {
    console.error(`${account} already has code (${acc.code_hash}); \`new\` can run only once`)
    process.exit(65)
  }
  const need = BigInt(code.length + acc.storage_usage + 2_000) * 10n ** 19n
  if (BigInt(acc.amount) < need) {
    console.error(`${account} holds ${nearStr(acc.amount, 3)} NEAR, the code alone needs ${nearStr(need, 3)}`)
    process.exit(65)
  }
  const r = await signer.send(account, [deployContractAction(code), functionCallAction({ method: 'new', args: initArgs, gas: 100n * TGAS })])
  console.log(`deploy + new: tx ${r.hash}, ${tg(r.gas)} Tgas burnt${r.failure ? '  FAILED ' + r.failure : ''}`)
  if (r.failure) process.exit(1)
  recordTx(section, `deploy ${what}`, { hash: r.hash, tgas: tg(r.gas), fee: nearStr(r.tokensBurnt), note: `deploy + new, ${code.length} bytes` })
  for (let i = 0; i < 20; i++) {
    if ((await viewAccount(account, 'final')).code_hash === codeHash) break
    await sleep(1000)
  }
}

async function main() {
  let cfg
  if (what === 'token') {
    if (deploy) await deployIt({ owner_id: n.dao, total_supply: SUPPLY, metadata: METADATA })
  } else {
    cfg = contractConfig()
    if (deploy) {
      const delay = Number(opt('genesis-delay', '0'))
      cfg.genesis_ms = opt('genesis') ? Number(opt('genesis')) : Math.ceil(Date.now() / 60_000) * 60_000 + delay * 60_000
      console.log(`genesis_ms ${cfg.genesis_ms} (${new Date(cfg.genesis_ms).toISOString()}), round_ms ${cfg.round_ms}`)
      await deployIt({ config: cfg })
      const s = await rec.call(signer, account, 'sync', {}, { gas: GAS.sync, label: 'sync (first read of the DAO policy)' })
      recordTx(section, 'first sync', { hash: s.hash, tgas: s.tgas, fee: s.fee })
      for (let i = 0; i < 20; i++) {
        if ((await view(account, 'state', {}, 'final')).last_sync_ms > 0) break
        await sleep(1000)
      }
    } else {
      cfg.genesis_ms = (await view(account, 'config', {}, 'final')).genesis_ms
    }
  }

  // ---- verify ---------------------------------------------------------------------------------------
  const onChain = await viewAccount(account, 'final')
  check(`code hash on chain equals ${dir}/WASM_SHA256`, onChain.code_hash === codeHash, onChain.code_hash)
  if (what === 'token') {
    const [supply, daoBal, meta, reg] = await Promise.all([
      view(account, 'ft_total_supply', {}, 'final'),
      view(account, 'ft_balance_of', { account_id: n.dao }, 'final'),
      view(account, 'ft_metadata', {}, 'final'),
      view(account, 'storage_balance_of', { account_id: n.dao }, 'final'),
    ])
    check('ft_total_supply = 1,000,000 tUSD', supply === SUPPLY, supply)
    check('the DAO holds the whole supply', daoBal === SUPPLY, daoBal)
    check('the DAO is registered with the token', reg !== null, JSON.stringify(reg))
    check('ft_metadata as in token/README.md', JSON.stringify(meta) === JSON.stringify(METADATA), `${meta.symbol}, ${meta.decimals} decimals`)
  } else {
    const shown = await view(account, 'config', {}, 'final')
    const keys = [...new Set([...Object.keys(cfg), ...Object.keys(shown)])].sort()
    for (const k of keys) {
      const want = cfg[k] ?? (k === 'guest_receive_cap_bp' ? 10000 : undefined)
      check(`config().${k}`, String(shown[k]) === String(want), `${shown[k]}${String(shown[k]) === String(want) ? '' : ' (intended ' + want + ')'}`)
    }
    const st = await view(account, 'state', {}, 'final')
    const members = n.members.map((m) => m.account).sort()
    check('state(): not paused after the sync', st.paused === false, st.pause_reason ?? '')
    check('state().members = the eight house members', JSON.stringify([...st.members].sort()) === JSON.stringify(members), st.members.length)
    check('state().council = the three house council members', JSON.stringify([...st.council].sort()) === JSON.stringify(n.council.map((c) => c.account).sort()), st.council.length)
    check('state().bond = 0.01 NEAR', st.bond === String(10n ** 22n), st.bond)
    const audit = await view(account, 'audit', {}, 'final')
    check('audit() balanced', audit.balanced && audit.points_attributed && audit.statuses_ok && audit.filed_have_ids && audit.carry_ok)
    recordDeploy(section, { config: shown, genesis_iso: new Date(shown.genesis_ms).toISOString() })
  }
  const keys = await accessKeys(account, 'final')
  const mine = nearPublicKey(signer.key)
  check("only the deployer's full-access key exists", keys.length === 1 && keys[0].public_key === mine && keys[0].access_key.permission === 'FullAccess',
    keys.map((k) => `${k.public_key} ${typeof k.access_key.permission === 'string' ? k.access_key.permission : 'FunctionCall'}`).join(', '))
  const bal = await viewAccount(account, 'final')
  console.log(`${account}: ${nearStr(bal.amount, 4)} NEAR, ${bal.storage_usage} bytes (${nearStr(BigInt(bal.storage_usage) * 10n ** 19n, 4)} NEAR staked)`)
  recordDeploy(section, {
    code_hashes: { [what]: codeHash },
    wasm_sha256: { [what]: sha.toString('hex') },
    locked: { [what]: false },
  })
  if (problems.length) {
    console.error(`${problems.length} checks failed${lock ? ': NOT locking' : ''}`)
    process.exit(1)
  }
  console.log('all checks passed')

  if (lock) {
    console.log(`--lock: deleting the ${keys.length} access key(s) of ${account}; this cannot be undone`)
    const d = await signer.send(account, keys.map((k) => deleteKeyAction(k.public_key)))
    console.log(`delete keys: tx ${d.hash}, ${tg(d.gas)} Tgas${d.failure ? '  FAILED ' + d.failure : ''}`)
    if (d.failure) process.exit(1)
    recordTx(section, `lock ${what}`, { hash: d.hash, tgas: tg(d.gas), fee: nearStr(d.tokensBurnt), note: 'every access key deleted' })
    let proof
    for (let i = 0; i < 20; i++) {
      proof = await rpc('query', { request_type: 'view_access_key_list', finality: 'final', account_id: account })
      if (proof.keys.length === 0) break
      await sleep(1500)
    }
    console.log(`view_access_key_list(${account}, final): ${JSON.stringify(proof)}`)
    if (proof.keys.length !== 0) {
      console.error('WARNING: keys remain')
      process.exit(1)
    }
    recordDeploy(section, { locked: { [what]: true } })
    console.log(`${account} has no access keys: nobody can change it`)
  }
}

main().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
