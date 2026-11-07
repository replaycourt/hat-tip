#!/usr/bin/env node
// Empties and deletes the STAGING contract account, so that a contract whose stored records changed
// can be deployed fresh under the same name (the DAO role `thanks`, the relay keys and the page all
// name the account). The Hat Tip contract has no upgrade or migration method, and NEAR refuses to
// delete an account that stores more than 10,000 bytes (DeleteAccountWithLargeState), so this:
//
//   1. lists every storage key of the account (view_state),
//   2. deploys a 210-byte cleanup module in place of the contract (assembled below, byte by byte),
//   3. calls its `clean` with the keys, in batches, until view_state is empty,
//   4. deletes the account with the root as beneficiary (its NEAR goes back to the root),
//   5. moves the account's legacy-keychain files aside, so `accounts.mjs create` can recreate it.
//
//   node scripts/reset-contract.mjs --root <root.testnet> [--section staging] [--dry-run]
//
// Only for the staging section, only with the account's own full-access key; it refuses anything
// else (the final contract has no keys and cannot be reset by anyone). Testnet only.
import { existsSync, readdirSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Signer, accessKeys, deployContractAction, keyFromKeychain, nearPublicKey, viewAccount } from './near-lite.mjs'
import { TGAS, cli, names, nearStr, recordTx, sleep, tg } from './hat-tip-lib.mjs'

const KEYCHAIN = join(homedir(), '.near-credentials', 'testnet')
const { opt, flag } = cli()
const section = opt('section', 'staging')
const root = opt('root')
const main_ = import.meta.url === pathToFileURL(process.argv[1] ?? '').href
let account

// ---- the cleanup module -------------------------------------------------------------------------------
// (module
//   (import "env" "input" (func $input (param i64)))
//   (import "env" "register_len" (func $len (param i64) (result i64)))
//   (import "env" "read_register" (func $read (param i64 i64)))
//   (import "env" "storage_remove" (func $remove (param i64 i64 i64) (result i64)))
//   (memory 1) (export "memory" (memory 0))
//   (func (export "clean") (local $p i32) (local $n i32) (local $k i32)
//     input(0); n = register_len(0); read_register(0, 0)       ;; the input lands at address 0
//     loop while p < n: k = load32(p); storage_remove(k, p + 4, 1); p += 4 + k))
// Input: the keys, each as a little-endian u32 length followed by the key's bytes (at most 64 KiB).

const leb = (x) => {
  const out = []
  do {
    let b = x & 0x7f
    x >>>= 7
    if (x) b |= 0x80
    out.push(b)
  } while (x)
  return out
}
const name = (s) => [...leb(s.length), ...Buffer.from(s, 'utf8')]
const section_ = (id, body) => [id, ...leb(body.length), ...body]
const vec = (items) => [...leb(items.length), ...items.flat()]
const I64 = 0x7e
const I32 = 0x7f

export function cleanupWasm() {
  const types = vec([
    [0x60, 1, I64, 0], // 0: (i64) -> ()
    [0x60, 1, I64, 1, I64], // 1: (i64) -> i64
    [0x60, 2, I64, I64, 0], // 2: (i64, i64) -> ()
    [0x60, 3, I64, I64, I64, 1, I64], // 3: (i64, i64, i64) -> i64
    [0x60, 0, 0], // 4: () -> ()
  ])
  const imports = vec([
    [...name('env'), ...name('input'), 0x00, 0],
    [...name('env'), ...name('register_len'), 0x00, 1],
    [...name('env'), ...name('read_register'), 0x00, 2],
    [...name('env'), ...name('storage_remove'), 0x00, 3],
  ])
  const funcs = vec([[4]])
  const memory = vec([[0x00, 1]])
  const exports = vec([
    [...name('clean'), 0x00, 4],
    [...name('memory'), 0x02, 0],
  ])
  const code = [
    0x42, 0, 0x10, 0, // input(0)
    0x42, 0, 0x10, 1, 0xa7, 0x21, 1, // n = (i32) register_len(0)
    0x42, 0, 0x42, 0, 0x10, 2, // read_register(0, 0)
    0x02, 0x40, 0x03, 0x40, // block loop
    0x20, 0, 0x20, 1, 0x4f, 0x0d, 1, // br_if (p >= n) out
    0x20, 0, 0x28, 2, 0, 0x21, 2, // k = load32(p)
    0x20, 2, 0xad, // (i64) k
    0x20, 0, 0x41, 4, 0x6a, 0xad, // (i64) (p + 4)
    0x42, 1, 0x10, 3, 0x1a, // storage_remove(k, p + 4, 1); drop
    0x20, 0, 0x41, 4, 0x6a, 0x20, 2, 0x6a, 0x21, 0, // p = p + 4 + k
    0x0c, 0, // br loop
    0x0b, 0x0b, 0x0b, // end loop, end block, end func
  ]
  const body = [1, 3, I32, ...code] // one local entry: 3 x i32
  const codeSec = vec([[...leb(body.length), ...body]])
  return Buffer.from([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section_(1, types), ...section_(2, imports), ...section_(3, funcs), ...section_(5, memory),
    ...section_(7, exports), ...section_(10, codeSec),
  ])
}

// ---- helpers ----------------------------------------------------------------------------------------

/** Every storage key of the account. FastNEAR answers view_state for a few hundred kB; others refuse. */
async function stateKeys() {
  const urls = ['https://test.rpc.fastnear.com', 'https://rpc.testnet.near.org']
  for (let attempt = 0; attempt < 6; attempt++) {
    const url = urls[attempt % urls.length]
    try {
      const r = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'view_state', finality: 'final', account_id: account, prefix_base64: '', include_proof: false } }),
      })
      const j = await r.json()
      if (j.result) return j.result.values.map((v) => Buffer.from(v.key, 'base64'))
      console.error(`view_state from ${url}: ${JSON.stringify(j.error).slice(0, 200)}`)
    } catch (e) {
      console.error(`view_state from ${url}: ${e.message}`)
    }
    await sleep(1500)
  }
  throw new Error('view_state failed on every endpoint')
}

const u32 = (x) => {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(x)
  return b
}
const u64 = (x) => {
  const b = Buffer.alloc(8)
  b.writeBigUInt64LE(BigInt(x))
  return b
}
const str = (s) => Buffer.concat([u32(Buffer.byteLength(s)), Buffer.from(s, 'utf8')])
/** A FunctionCall action with raw (non-JSON) argument bytes. */
const rawCall = (method, bytes, gas) => Buffer.concat([Buffer.from([2]), str(method), u32(bytes.length), bytes, u64(gas), Buffer.alloc(16)])
const deleteAccountAction = (beneficiary) => Buffer.concat([Buffer.from([7]), str(beneficiary)])

// ---- run ---------------------------------------------------------------------------------------------

async function main() {
  if (section !== 'staging' || !root) {
    console.error('usage: reset-contract.mjs --root <root.testnet> [--section staging] [--dry-run]; staging only')
    process.exit(64)
  }
  account = names(root).contract
  const wasm = cleanupWasm()
  let acc
  try {
    acc = await viewAccount(account, 'final')
  } catch {
    console.log(`${account} does not exist: nothing to reset`)
    return
  }
  const signer = new Signer(account, keyFromKeychain(account))
  const keys = await accessKeys(account, 'final')
  if (!keys.some((k) => k.public_key === nearPublicKey(signer.key) && k.access_key.permission === 'FullAccess')) {
    throw new Error(`${account}: the keychain key is not a full-access key on chain; refusing`)
  }
  const stored = await stateKeys()
  console.log(`${account}: ${nearStr(acc.amount, 4)} NEAR, ${acc.storage_usage} bytes, ${stored.length} storage keys; cleanup module ${wasm.length} bytes`)
  if (flag('dry-run')) return

  const send = async (label, actions) => {
    const r = await signer.send(account, actions)
    console.log(`${label}: ${r.failure ? 'FAILED ' + r.failure : 'ok'}; ${tg(r.gas)} Tgas, ${nearStr(r.tokensBurnt)} NEAR; ${r.hash}`)
    if (r.failure) process.exit(1)
    recordTx(section, `reset ${label}`, { hash: r.hash, tgas: tg(r.gas), fee: nearStr(r.tokensBurnt) })
    return r
  }
  if (stored.length) {
    if (acc.code_hash !== '11111111111111111111111111111111') {
      await send('deploy the cleanup module', [deployContractAction(wasm)])
    }
    // batches of at most 32 KiB of keys
    let batch = []
    let size = 0
    const flush = async () => {
      if (!batch.length) return
      await send(`clean ${batch.length} keys`, [rawCall('clean', Buffer.concat(batch.map((k) => Buffer.concat([u32(k.length), k]))), 300n * TGAS)])
      batch = []
      size = 0
    }
    for (const k of stored) {
      if (size + 4 + k.length > 32_768) await flush()
      batch.push(k)
      size += 4 + k.length
    }
    await flush()
  }
  for (let i = 0; i < 10; i++) {
    const left = await stateKeys()
    acc = await viewAccount(account, 'final')
    if (left.length === 0 && acc.storage_usage <= 10_000) break
    if (i === 9) throw new Error(`${left.length} keys left, ${acc.storage_usage} bytes: not deleting`)
    await sleep(1500)
  }
  console.log(`${account}: empty, ${acc.storage_usage} bytes; deleting it, beneficiary ${root}`)
  await send(`delete ${account}`, [deleteAccountAction(root)])
  for (let i = 0; i < 15; i++) {
    try {
      await viewAccount(account, 'final')
      await sleep(1000)
    } catch {
      break
    }
  }
  const stamp = Math.floor(Date.now() / 1000)
  for (const f of [join(KEYCHAIN, `${account}.json`), ...(existsSync(join(KEYCHAIN, account)) ? readdirSync(join(KEYCHAIN, account)).map((x) => join(KEYCHAIN, account, x)) : [])]) {
    if (existsSync(f) && f.endsWith('.json')) renameSync(f, `${f}.deleted-${stamp}`)
  }
  console.log(`${account} deleted; its keychain files are kept as *.deleted-${stamp}. Recreate it with accounts.mjs create.`)
}

if (main_) {
  main().catch((e) => {
    console.error(e.message)
    process.exit(1)
  })
}
