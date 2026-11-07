// Shared pieces of the Hat Tip testnet scripts: paths, the git-ignored secrets, the account names
// of one deployment, deploy/testnet.json (interface I-4), the relay pool, transaction records and
// the house members' published strategies. Node 20+, standard library only. Testnet only.
import crypto from 'node:crypto'
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Signer, assertTestnet, keyFromSeed, nearPublicKey, rpc, summarise, view, viewAccount } from './near-lite.mjs'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const SECRETS = join(ROOT, '.secrets')
export const DEPLOY_FILE = join(ROOT, 'deploy', 'testnet.json')
export const NEAR = 10n ** 24n
export const TGAS = 10n ** 12n
export const BYTE = 10n ** 19n // storage price: yoctoNEAR per byte
export const TUSD = 1_000_000n // base units per tUSD
export const FACTORY = 'sputnikv2.testnet'

/** Gas each relayed call attaches (contract/README.md, "Gas"). */
export const GAS = {
  sync: 70n * TGAS,
  close: 255n * TGAS,
  check: 140n * TGAS, // the contract panics "this call needs 140 Tgas" below that
  pay: 300n * TGAS,
  act: 30n * TGAS,
  allocate: 30n * TGAS,
  note: 15n * TGAS,
  vote: 30n * TGAS, // a council vote that executes a transfer needs at least 25 (testnet probe)
}

/** What a relay key may call on the contract (DESIGN.md, "Guests"). */
export const RELAY_METHODS = ['act', 'close_round', 'pay', 'check_payout', 'sync']
/** What a house member's function-call key may call on the contract. */
export const MEMBER_METHODS = ['allocate', 'note']
/** What a house council member's function-call key may call on the DAO. */
export const COUNCIL_METHODS = ['act_proposal']

export const sleep = (ms) => new Promise((s) => setTimeout(s, ms))
export const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))
export const stamp = () => new Date().toISOString().slice(11, 19)

/** Writes a secrets file readable by its owner only (JSON, or text as given). */
export function writeSecret(name, data) {
  mkdirSync(SECRETS, { recursive: true, mode: 0o700 })
  const file = join(SECRETS, name)
  writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
  chmodSync(file, 0o600)
  return file
}

export const houseKeysFile = (contract) => join(SECRETS, `house-keys-${contract}.json`)
export const poolFile = (contract) => join(SECRETS, `gas-pool-${contract}.json`)

/** Simple `--name value` / `--flag` parsing. */
export function cli(argv = process.argv.slice(2)) {
  const opt = (name, dflt) => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt
  }
  const flag = (name) => argv.includes(`--${name}`)
  const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && !isFlagOnly(argv[i - 1])))
  return { argv, opt, flag, positional }
}
const FLAG_ONLY = new Set(['--lock', '--lock-only', '--verify-only', '--dry-run', '--auto-update-off', '--always', '--no-funding', '--keep-going'])
const isFlagOnly = (a) => FLAG_ONLY.has(a)

// ---- the accounts of one deployment ---------------------------------------------------------------

/**
 * The account names of a deployment, all derived from its root account: the contract and the token
 * are sub-accounts (`thanks.`, `tusd.`), the house members and council are sub-accounts named as in
 * sim/params.json (`ana.`, ..., `council-a.`), and the DAO is `<root name>.sputnikv2.testnet`.
 */
export function names(root, params = loadParams()) {
  assertTestnet(root)
  const base = root.replace(/\.testnet$/, '')
  const sub = (n) => `${n}.${root}`
  return {
    root,
    contract: sub('thanks'),
    token: sub('tusd'),
    dao: `${base}.${FACTORY}`,
    daoName: base,
    members: params.house.members.map((m) => ({ ...m, account: sub(m.name) })),
    council: params.house.council.map((c) => ({ ...c, account: sub(c.name) })),
  }
}

export function loadParams() {
  return readJson(join(ROOT, 'sim', 'params.json'))
}

// ---- deploy/testnet.json (I-4) ----------------------------------------------------------------------

export function readDeploy() {
  return existsSync(DEPLOY_FILE) ? readJson(DEPLOY_FILE) : { network: 'testnet' }
}

/** Merges `patch` into deploy/testnet.json's `section` (deeply for plain objects). Public facts only. */
export function recordDeploy(section, patch) {
  const doc = readDeploy()
  doc[section] = merge(doc[section] ?? {}, patch)
  mkdirSync(dirname(DEPLOY_FILE), { recursive: true })
  writeFileSync(DEPLOY_FILE, JSON.stringify(doc, null, 1) + '\n')
  return doc[section]
}

/** Adds a transaction to the section's `txs` under `key` (a list keeps every repetition). */
export function recordTx(section, key, rec) {
  const doc = readDeploy()
  const s = (doc[section] ??= {})
  s.txs ??= {}
  const entry = { hash: rec.hash, tgas: rec.tgas, fee_near: rec.fee, ...(rec.note ? { note: rec.note } : {}) }
  if (s.txs[key] === undefined) s.txs[key] = entry
  else s.txs[key] = [].concat(s.txs[key], entry)
  writeFileSync(DEPLOY_FILE, JSON.stringify(doc, null, 1) + '\n')
}

function merge(a, b) {
  if (!isPlain(a) || !isPlain(b)) return b
  const out = { ...a }
  for (const [k, v] of Object.entries(b)) out[k] = isPlain(v) && isPlain(a[k]) ? merge(a[k], v) : v
  return out
}
const isPlain = (x) => x !== null && typeof x === 'object' && !Array.isArray(x)

/** A deployment section of deploy/testnet.json, refusing an incomplete one. */
export function deployment(section) {
  const d = readDeploy()[section]
  if (!d || !d.contract) throw new Error(`deploy/testnet.json has no ${section} deployment with a contract`)
  return d
}

// ---- transactions and their record --------------------------------------------------------------------

export const tg = (g) => Number((BigInt(g) * 100n) / TGAS) / 100
export const nearStr = (y, digits = 6) => (Number(BigInt(y) / 10n ** 16n) / 1e8).toFixed(digits)
export const tusd = (x) => {
  const v = BigInt(x)
  const frac = String(v % TUSD).padStart(6, '0').replace(/0+$/, '')
  return `${v / TUSD}${frac ? '.' + frac : ''}`
}

/** The NEP-297 events in a list of logs: [{standard, event, data}]. */
export function parseEvents(logs) {
  return (logs ?? []).filter((l) => l.startsWith('EVENT_JSON:')).map((l) => JSON.parse(l.slice('EVENT_JSON:'.length)))
}

/**
 * Sends one transaction and returns a compact record: hash, gas burnt (all receipts), fee, the
 * failure of the transaction or of any receipt it caused, the return value and the events.
 */
export async function send(signer, receiver, method, args, { gas = 30n * TGAS, deposit = 0n } = {}) {
  const res = await signer.call(receiver, method, args, { gas, deposit })
  return { ...res, signer: signer.accountId, receiver, method }
}

/** Every receipt of a transaction, with failures (a detached chain fails without failing the tx). */
export async function receiptsOf(hash, sender) {
  const r = await rpc('EXPERIMENTAL_tx_status', { tx_hash: hash, sender_account_id: sender, wait_until: 'EXECUTED_OPTIMISTIC' })
  const byId = new Map(r.receipts.map((x) => [x.receipt_id, x]))
  const out = []
  for (const o of r.receipts_outcome) {
    const rc = byId.get(o.id)
    if (rc && rc.predecessor_id === 'system') continue // gas refunds
    const actions = rc?.receipt?.Action?.actions ?? []
    const what = actions.map((a) => {
      if (typeof a === 'string') return a
      if (a.FunctionCall) return a.FunctionCall.method_name
      if (a.Transfer) return `Transfer ${nearStr(a.Transfer.deposit)}`
      return Object.keys(a)[0] ?? String(a)
    }).join(',')
    const st = o.outcome.status
    out.push({
      from: rc?.predecessor_id, to: o.outcome.executor_id, what, tgas: tg(o.outcome.gas_burnt),
      ok: st.Failure === undefined, failure: st.Failure ? JSON.stringify(st.Failure).slice(0, 300) : undefined,
    })
  }
  return out
}

/** The failures of all receipts of a sent transaction (from the send_tx answer). */
export function receiptFailures(res) {
  return (res.receipts ?? []).filter((r) => !r.ok)
}

// A Signer whose sends also report every receipt's status and the events.
export class Recorder {
  /** `log`: optional JSONL file every record is appended to. */
  constructor({ log = null, echo = console.log } = {}) {
    this.log = log
    this.echo = echo
    this.records = []
  }

  /** `receipts: false` skips reading every receipt (one RPC call less, for single-receipt calls). */
  async call(signer, receiver, method, args, { gas = 30n * TGAS, deposit = 0n, label = '', round = null, expect = 'ok', receipts: wantReceipts = true } = {}) {
    let res
    try {
      res = await signer.call(receiver, method, args, { gas, deposit })
    } catch (e) {
      const rec = { at: new Date().toISOString(), round, label, signer: signer.accountId, receiver, method, ok: false, error: String(e.message).slice(0, 400) }
      this.push(rec)
      throw e
    }
    let receipts = []
    try {
      if (wantReceipts) receipts = await receiptsOf(res.hash, signer.accountId)
    } catch (e) {
      receipts = [{ ok: true, note: `receipts not read: ${e.message.slice(0, 80)}` }]
    }
    const failed = receipts.filter((r) => !r.ok)
    const events = parseEvents(res.logs).filter((e) => e.standard === 'hattip')
    const rec = {
      at: new Date().toISOString(), round, label, signer: signer.accountId, receiver, method,
      hash: res.hash, tgas: tg(res.gas), fee: nearStr(res.tokensBurnt), ok: !res.failure && failed.length === 0,
      failure: res.failure ? res.failure.slice(0, 300) : undefined,
      receiptFailures: failed.length ? failed.map((f) => `${f.to}.${f.what}: ${f.failure}`.slice(0, 300)) : undefined,
      value: compactValue(res.value),
      events: events.length ? Object.fromEntries(countBy(events.map((e) => [e.event, e.data.length]))) : undefined,
      receipts: receipts.map((r) => `${r.to}.${r.what} ${r.tgas}${r.ok ? '' : ' FAILED'}`),
      expected: expect,
    }
    rec.asExpected = expect === 'ok' ? rec.ok : !rec.ok && JSON.stringify([rec.failure, rec.receiptFailures]).includes(expect)
    rec.eventsFull = events
    this.push(rec)
    return rec
  }

  push(rec) {
    this.records.push(rec)
    if (this.log) {
      const { eventsFull, ...line } = rec
      appendFileSync(this.log, JSON.stringify({ ...line, eventsFull }) + '\n')
    }
    const status = rec.ok ? 'ok' : `FAILED ${rec.error ?? rec.failure ?? (rec.receiptFailures ?? []).join('; ')}`
    const ev = rec.events ? ' ' + Object.entries(rec.events).map(([k, n]) => `${k}${n > 1 ? 'x' + n : ''}`).join(',') : ''
    this.echo(`[${stamp()}] ${rec.round != null ? 'r' + rec.round + ' ' : ''}${rec.label || rec.method} by ${short(rec.signer)}: ${status}${rec.hash ? `; ${rec.tgas} Tgas, ${rec.fee} NEAR; ${rec.hash}` : ''}${ev}`)
  }
}

function countBy(pairs) {
  const m = new Map()
  for (const [k, n] of pairs) m.set(k, (m.get(k) ?? 0) + n)
  return m
}

function compactValue(v) {
  if (v === null || v === undefined) return undefined
  const s = JSON.stringify(v)
  return s.length > 300 ? s.slice(0, 300) + '...' : v
}

/** A short form of an account for log lines. */
export const short = (a) => (/^[0-9a-f]{64}$/.test(a ?? '') ? a.slice(0, 8) + '...' : a)

// ---- keys -----------------------------------------------------------------------------------------------

/** A signer for `account` from a 64-hex-character seed (a function-call key), nonces read fresh. */
export function seedSigner(account, seedHex, { shared = true } = {}) {
  if (!/^[0-9a-f]{64}$/.test(seedHex)) throw new Error(`bad seed for ${account}`)
  return new Signer(account, keyFromSeed(Buffer.from(seedHex, 'hex')), { shared })
}

export const seedHexOf = (key) => Buffer.from(key.seed).toString('hex')
export const publicKeyOfSeed = (seedHex) => nearPublicKey(keyFromSeed(Buffer.from(seedHex, 'hex')))

/** Free balance of an account: amount above its storage stake, in yoctoNEAR. */
export async function freeBalance(account) {
  const a = await viewAccount(account, 'optimistic')
  return { amount: BigInt(a.amount), storage: a.storage_usage, free: BigInt(a.amount) - BigInt(a.storage_usage) * BYTE, codeHash: a.code_hash }
}

export async function accessKey(account, publicKey) {
  try {
    return await rpc('query', { request_type: 'view_access_key', finality: 'optimistic', account_id: account, public_key: publicKey })
  } catch {
    return null
  }
}

/** A view that returns null when the contract panics or does not exist. */
export async function tryView(contract, method, args = {}) {
  try {
    return await view(contract, method, args)
  } catch {
    return null
  }
}

// ---- seeded randomness (independent streams per purpose) ----------------------------------------------

export function stream(...parts) {
  const h = crypto.createHash('sha256').update(parts.join('|')).digest()
  let a = h.readUInt32LE(0)
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  next.normal = () => {
    let u = 0
    while (u === 0) u = next()
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next())
  }
  next.lognormal = (sigma) => Math.exp(sigma * next.normal())
  next.pick = (xs) => xs[Math.floor(next() * xs.length)]
  next.sample = (xs, k) => {
    const pool = [...xs]
    const out = []
    while (out.length < k && pool.length) out.push(pool.splice(Math.floor(next() * pool.length), 1)[0])
    return out
  }
  return next
}

/**
 * sim/hat_tip_sim.py `split`: whole thanks proportional to `prefs` [[y, name]], at most `cap` each,
 * at most `maxN` receivers, dropping those below `focus` of the top pick; largest remainder.
 */
export function split(total, prefs, cap, maxN, focus) {
  const ps = prefs.filter((p) => p[0] > 0).sort((a, b) => b[0] - a[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)).slice(0, maxN)
  if (!ps.length || total <= 0) return []
  const top = ps[0][0]
  let rest = ps.filter((p) => p[0] >= focus * top)
  const alloc = new Map()
  let left = total
  while (rest.length) {
    const sy = rest.reduce((n, p) => n + p[0], 0)
    const over = rest.filter(([y]) => (left * y) / sy > cap).map((p) => p[1])
    if (!over.length) break
    for (const n of over) {
      alloc.set(n, cap)
      left -= cap
    }
    rest = rest.filter((p) => !alloc.has(p[1]))
  }
  if (rest.length && left > 0) {
    const sy = rest.reduce((n, p) => n + p[0], 0)
    const raw = rest.map(([y, n]) => [(left * y) / sy, n])
    const fl = new Map(raw.map(([v, n]) => [n, Math.floor(v)]))
    let extra = left - [...fl.values()].reduce((a, b) => a + b, 0)
    const order = [...raw].sort((a, b) => (b[0] - Math.floor(b[0])) - (a[0] - Math.floor(a[0])) || (a[1] < b[1] ? -1 : 1))
    for (const [, n] of order) {
      if (extra-- <= 0) break
      fl.set(n, fl.get(n) + 1)
    }
    for (const [n, t] of fl) alloc.set(n, t)
  }
  return [...alloc].filter(([, t]) => t >= 1).sort((a, b) => (a[0] < b[0] ? -1 : 1))
}

/** The number of items a note claims: its first whole number, else 0 (sim/params.json, house). */
export function itemsOf(note) {
  const m = /\b(\d+)\b/.exec(note ?? '')
  return m ? Number(m[1]) : 0
}

// ---- the keeper's window of open payouts ---------------------------------------------------------------

export const FINAL_STATUSES = new Set(['paid', 'rejected', 'expired', 'removed', 'failed'])

/**
 * Where the keeper looks next tick. `read`: the payout views it read this tick (the pages from
 * `openFrom` up to the newest payout, the earlier open ones, the held ones). The new window starts
 * at the first payout at or after `openFrom` that is neither final nor in `filing` without a DAO
 * proposal id: a filing chain that is still running, or was lost and never lands, must not pin the
 * window (pages then grow until the house stops seeing new payouts). Every open payout below the new
 * start (such a filing, or one that left filing since) is returned in `earlier`, to be read one by one
 * until it is final or pruned. With nothing open from `openFrom` on, the window moves to `nextPayout`.
 */
export function nextWindow(read, openFrom, nextPayout) {
  const open = read.filter((p) => !FINAL_STATUSES.has(p.status))
  const lost = (p) => p.status === 'filing' && (p.dao_proposal === null || p.dao_proposal === undefined)
  const holds = open.filter((p) => p.id >= openFrom && !lost(p)).map((p) => p.id)
  const start = holds.length ? Math.min(...holds) : Math.max(openFrom, nextPayout)
  const earlier = [...new Set(open.filter((p) => p.id < start).map((p) => p.id))].sort((a, b) => a - b)
  return { openFrom: start, earlier }
}

/**
 * One tick's read of the keeper: every page of `payouts(from, 100)` from the window's start to the
 * newest payout, then the earlier open payouts and the held ones one by one. `viewPayouts(from,
 * limit)` is the contract's view (injected, so the window logic is testable without a chain).
 * Returns { list (by id), openFrom, earlier } for the next tick.
 */
export async function readWindow(viewPayouts, { openFrom, earlier = [], held = [], oldest = 0, nextPayout }) {
  const from = Math.max(openFrom, oldest)
  const read = new Map()
  for (let at = from; at < nextPayout; at += 100) {
    for (const p of await viewPayouts(at, 100)) read.set(p.id, p)
  }
  for (const id of [...earlier, ...held]) {
    if (read.has(id)) continue
    for (const p of await viewPayouts(id, 1)) if (p.id === id) read.set(id, p)
  }
  const list = [...read.values()].sort((a, b) => a.id - b.id)
  return { list, ...nextWindow(list, from, nextPayout) }
}
