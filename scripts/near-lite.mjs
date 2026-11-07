// Minimal NEAR transaction signing and RPC with only Node's standard library (Node 20+).
// Adapted from the testnet scripts of Lantern Row (same author): multi-action transactions,
// contract deployment, access keys, and an RPC fallback. Testnet only.
// Copied from Bonfire (scripts/near-lite.mjs, same author) for Hat Tip; added: account creation
// and full-access keys (createAccountAction, addFullAccessKeyAction).
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

export function b58encode(bytes) {
  let n = BigInt('0x' + (Buffer.from(bytes).toString('hex') || '0'))
  let out = ''
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out
    n /= 58n
  }
  for (const b of bytes) {
    if (b !== 0) break
    out = '1' + out
  }
  return out
}

export function b58decode(s) {
  let n = 0n
  for (const c of s) {
    const i = B58.indexOf(c)
    if (i < 0) throw new Error('bad base58')
    n = n * 58n + BigInt(i)
  }
  let hex = n.toString(16)
  if (hex.length % 2) hex = '0' + hex
  const body = Buffer.from(n === 0n ? '' : hex, 'hex')
  const zeros = [...s].findIndex((c) => c !== '1')
  return Buffer.concat([Buffer.alloc(zeros < 0 ? s.length : zeros), body])
}

const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')

export function keyFromSeed(seed) {
  const privateKey = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' })
  const publicKey = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32)
  return { privateKey, publicKey, seed }
}

export function newKey() {
  return keyFromSeed(crypto.randomBytes(32))
}

/** Reads a NEAR key string "ed25519:<base58 of seed + public key>". */
export function keyFromNearString(s) {
  return keyFromSeed(b58decode(s.replace('ed25519:', '')).subarray(0, 32))
}

/** The NEAR secret key string of `key`, as the legacy keychain stores it. */
export const nearSecretKey = (key) => 'ed25519:' + b58encode(Buffer.concat([key.seed, key.publicKey]))

/** The full-access key of `account` from the legacy keychain (~/.near-credentials/testnet). */
export function keyFromKeychain(account) {
  const file = join(homedir(), '.near-credentials', 'testnet', `${account}.json`)
  return keyFromNearString(JSON.parse(readFileSync(file, 'utf8')).private_key)
}

export const sign = (key, msg) => crypto.sign(null, msg, key.privateKey)
export const nearPublicKey = (key) => 'ed25519:' + b58encode(key.publicKey)
export const hex = (bytes) => Buffer.from(bytes).toString('hex')
/** The implicit account of an ed25519 key: 64 lowercase hex characters. */
export const implicitAccount = (key) => hex(key.publicKey)

// ---- borsh, the parts these scripts need --------------------------------------------------------

const u8 = (n) => Buffer.from([n])
const u32 = (n) => {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n)
  return b
}
const u64 = (n) => {
  const b = Buffer.alloc(8)
  b.writeBigUInt64LE(BigInt(n))
  return b
}
const u128 = (n) => Buffer.concat([u64(BigInt(n) & 0xffffffffffffffffn), u64(BigInt(n) >> 64n)])
const str = (s) => {
  const b = Buffer.from(s, 'utf8')
  return Buffer.concat([u32(b.length), b])
}
const bytes = (b) => Buffer.concat([u32(b.length), Buffer.from(b)])
const pubKey = (raw32) => Buffer.concat([u8(0), Buffer.from(raw32)])
const pubKeyFromString = (s) => pubKey(b58decode(s.replace('ed25519:', '')))

function encodeTx({ signerId, key, nonce, receiverId, blockHash, actions }) {
  return Buffer.concat([
    str(signerId),
    pubKey(key.publicKey),
    u64(nonce),
    str(receiverId),
    blockHash,
    u32(actions.length),
    ...actions,
  ])
}

export function functionCallAction({ method, args, gas = 30_000_000_000_000n, deposit = 0n }) {
  const argBytes = Buffer.from(JSON.stringify(args), 'utf8')
  return Buffer.concat([u8(2), str(method), u32(argBytes.length), argBytes, u64(gas), u128(deposit)])
}

export const createAccountAction = () => u8(0)
export const deployContractAction = (code) => Buffer.concat([u8(1), bytes(code)])
export const transferAction = (deposit) => Buffer.concat([u8(3), u128(deposit)])
export const deleteKeyAction = (publicKey) => Buffer.concat([u8(6), pubKeyFromString(publicKey)])

/** AddKey with full access (nonce 0). */
export const addFullAccessKeyAction = (publicKey) => Buffer.concat([u8(5), pubKeyFromString(publicKey), u64(0), u8(1)])

/** AddKey with a function-call permission: `receiverId` only, `methods` only, capped by `allowance`. */
export function addFunctionCallKeyAction({ publicKey, receiverId, methods, allowance }) {
  return Buffer.concat([
    u8(5),
    pubKeyFromString(publicKey),
    u64(0), // nonce
    u8(0), // FunctionCall permission
    u8(1), u128(allowance), // Some(allowance)
    str(receiverId),
    u32(methods.length),
    ...methods.map(str),
  ])
}

// ---- RPC ----------------------------------------------------------------------------------------

// rpc.testnet.near.org is deprecated and rate-limited: FastNEAR first, dRPC as fallback.
export const RPCS = (process.env.NEAR_RPC ? [process.env.NEAR_RPC] : []).concat([
  'https://test.rpc.fastnear.com',
  'https://near-testnet.drpc.org',
])
let rpcIndex = 0

const sleep = (ms) => new Promise((s) => setTimeout(s, ms))

const stamp = () => new Date().toISOString().slice(11, 19)

export async function rpc(method, params) {
  let lastError
  // A hanging request is cut short and retried on the next endpoint; send_tx may take a while.
  const timeout = method === 'send_tx' ? 45_000 : 15_000
  for (let attempt = 0; attempt < 8; attempt++) {
    const url = RPCS[rpcIndex % RPCS.length]
    const t0 = Date.now()
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: '1', method, params }),
        signal: AbortSignal.timeout(timeout),
      })
      if (r.status === 429 || r.status >= 500) throw new Error(`http ${r.status} from ${url}`)
      const j = await r.json()
      if (Date.now() - t0 > 8_000) console.error(`[${stamp()}] slow rpc ${method} ${url}: ${Date.now() - t0} ms`)
      if (j.error) {
        const text = JSON.stringify(j.error)
        // A transaction still in flight, or a node behind: ask again (the same signed transaction
        // is idempotent). Everything else is a real answer.
        if (/TIMEOUT|UNKNOWN_BLOCK|NO_SYNCED_BLOCKS|InternalError|Server error.*timeout|free plan/i.test(text) && attempt < 7) {
          // dRPC's free plan cuts long requests (send_tx waiting for execution): ask FastNEAR instead.
          if (/free plan/i.test(text)) rpcIndex++
          console.error(`[${stamp()}] rpc ${method} ${url}: ${text.slice(0, 160)}; retrying`)
          await sleep(1500)
          continue
        }
        const e = new Error(`rpc ${method}: ${text.slice(0, 600)}`)
        e.rpcError = j.error
        throw e
      }
      return j.result
    } catch (e) {
      if (String(e.message).startsWith('rpc ')) throw e
      lastError = e
      console.error(`[${stamp()}] rpc ${method} ${url} failed after ${Date.now() - t0} ms: ${e.message}${e.cause ? ' (' + (e.cause.code || e.cause.message || e.cause) + ')' : ''}; next endpoint`)
      rpcIndex++ // network trouble, a hang or a rate limit: try the next endpoint
      await sleep(500 + 500 * attempt)
    }
  }
  throw lastError
}

export async function view(contract, method, args = {}, finality = 'optimistic') {
  const r = await rpc('query', {
    request_type: 'call_function',
    finality,
    account_id: contract,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
  })
  return JSON.parse(Buffer.from(r.result).toString('utf8'))
}

export async function viewAccount(account, finality = 'final') {
  return rpc('query', { request_type: 'view_account', finality, account_id: account })
}

export async function accessKeys(account, finality = 'final') {
  return (await rpc('query', { request_type: 'view_access_key_list', finality, account_id: account })).keys
}

export class Signer {
  /**
   * `shared`: the key is used by others too (gas keys shared with the page), so its nonce is read
   * fresh before every transaction instead of counted locally.
   */
  constructor(accountId, key, { shared = false } = {}) {
    this.accountId = accountId
    this.key = key
    this.nonce = null
    this.shared = shared
  }

  async call(receiverId, method, args, { gas = 30_000_000_000_000n, deposit = 0n } = {}) {
    return this.send(receiverId, [functionCallAction({ method, args, gas, deposit })])
  }

  /** Sends NEAR. To an implicit account that does not exist yet, this creates it. */
  async transfer(receiverId, yocto) {
    return this.send(receiverId, [transferAction(yocto)])
  }

  /**
   * Signs and sends one transaction. On InvalidNonce (another user of the key got there first) it
   * reads the key's nonce afresh and tries once more; a second InvalidNonce is thrown.
   */
  async send(receiverId, actions, { retryNonce = true } = {}) {
    if (this.nonce === null || this.shared) {
      const k = await rpc('query', {
        request_type: 'view_access_key',
        finality: 'optimistic',
        account_id: this.accountId,
        public_key: nearPublicKey(this.key),
      })
      this.nonce = BigInt(k.nonce)
    }
    this.nonce += 1n
    const block = await rpc('block', { finality: 'final' })
    const tx = encodeTx({ signerId: this.accountId, key: this.key, nonce: this.nonce, receiverId, blockHash: b58decode(block.header.hash), actions })
    const digest = crypto.createHash('sha256').update(tx).digest()
    const signed = Buffer.concat([tx, u8(0), sign(this.key, digest)])
    const sentMs = Date.now()
    let res
    try {
      res = await rpc('send_tx', { signed_tx_base64: signed.toString('base64'), wait_until: 'EXECUTED_OPTIMISTIC' })
    } catch (e) {
      // An invalid transaction never reached the chain: forget the nonce.
      if (/InvalidTxError|InvalidNonce/.test(e.message)) this.nonce = null
      if (retryNonce && /InvalidNonce/.test(e.message)) {
        console.error(`[${stamp()}] ${this.accountId}: nonce taken by another user of the key; reading it afresh and trying once more`)
        return this.send(receiverId, actions, { retryNonce: false })
      }
      throw e
    }
    return { ...summarise(res), sentMs, doneMs: Date.now() }
  }
}

export function summarise(res) {
  const receipts = res.receipts_outcome
  const gas = res.transaction_outcome.outcome.gas_burnt + receipts.reduce((n, o) => n + o.outcome.gas_burnt, 0)
  const tokensBurnt = [res.transaction_outcome, ...receipts].reduce((n, o) => n + BigInt(o.outcome.tokens_burnt), 0n)
  // The receipt that ran the contract: the first after the transaction itself.
  const contractGas = receipts[0]?.outcome.gas_burnt ?? 0
  const txGas = res.transaction_outcome.outcome.gas_burnt
  const failure = res.status.Failure ? JSON.stringify(res.status.Failure) : null
  let value = null
  if (res.status.SuccessValue !== undefined && res.status.SuccessValue !== '') {
    try {
      value = JSON.parse(Buffer.from(res.status.SuccessValue, 'base64').toString('utf8'))
    } catch {
      value = res.status.SuccessValue
    }
  }
  return {
    hash: res.transaction.hash,
    gas,
    txGas,
    contractGas,
    tokensBurnt,
    failure,
    value,
    logs: receipts.flatMap((o) => o.outcome.logs),
  }
}

export const tgas = (g) => (Number(g) / 1e12).toFixed(2)
export const near = (yocto) => (Number(BigInt(yocto) / 10n ** 18n) / 1e6).toFixed(4)

/** Refuses anything but a testnet account. */
export function assertTestnet(...accounts) {
  for (const a of accounts) {
    if (!/\.testnet$/.test(a) && !/^[0-9a-f]{64}$/.test(a)) {
      throw new Error(`refusing ${a}: these scripts are for testnet accounts only`)
    }
  }
}
