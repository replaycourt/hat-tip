// The whole NEAR layer of the client: base58, the few borsh shapes a function call needs,
// Ed25519 through WebCrypto, and JSON-RPC with a fallback host. No library, no wallet.
// Works in a browser and in Node 20+ (for the unit tests), because both have globalThis.crypto.
// (Taken over from Bonfire, an earlier entry by the same author.)

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

export function b58encode(bytes) {
  let n = 0n
  for (const b of bytes) n = (n << 8n) | BigInt(b)
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
    if (i < 0) throw new Error('not base58')
    n = n * 58n + BigInt(i)
  }
  const body = []
  while (n > 0n) {
    body.unshift(Number(n & 255n))
    n >>= 8n
  }
  let zeros = 0
  while (zeros < s.length && s[zeros] === '1') zeros++
  return new Uint8Array([...new Array(zeros).fill(0), ...body])
}

export const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
export const unhex = (s) => new Uint8Array(s.match(/../g).map((h) => parseInt(h, 16)))
export const utf8 = (s) => new TextEncoder().encode(s)

export function concat(...parts) {
  const n = parts.reduce((a, p) => a + p.length, 0)
  const out = new Uint8Array(n)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

// ---- Ed25519 via WebCrypto -----------------------------------------------------------------------

const PKCS8_PREFIX = unhex('302e020100300506032b657004220420')
const subtle = () => globalThis.crypto.subtle

export async function ed25519Supported() {
  try {
    const k = await subtle().generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
    return !!k.privateKey
  } catch {
    return false
  }
}

/** A new key. Returns { seed, publicKey } as bytes and the private CryptoKey. */
export async function newKey() {
  const pair = await subtle().generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
  const pkcs8 = new Uint8Array(await subtle().exportKey('pkcs8', pair.privateKey))
  const publicKey = new Uint8Array(await subtle().exportKey('raw', pair.publicKey))
  return { seed: pkcs8.slice(-32), publicKey, privateKey: pair.privateKey }
}

/** Rebuilds a key from its 32-byte seed and 32-byte public key. */
export async function keyFromSeed(seed, publicKey) {
  const privateKey = await subtle().importKey('pkcs8', concat(PKCS8_PREFIX, seed), { name: 'Ed25519' }, false, ['sign'])
  return { seed, publicKey, privateKey }
}

/** Reads a NEAR "ed25519:<base58 of seed + public key>" private key string. */
export async function keyFromNearString(s) {
  const bytes = b58decode(s.replace(/^ed25519:/, ''))
  return keyFromSeed(bytes.slice(0, 32), bytes.slice(32, 64))
}

export const sign = async (key, msg) => new Uint8Array(await subtle().sign({ name: 'Ed25519' }, key.privateKey, msg))
export const sha256 = async (bytes) => new Uint8Array(await subtle().digest('SHA-256', bytes))
export const nearPublicKey = (key) => 'ed25519:' + b58encode(key.publicKey)
export const implicitAccount = (key) => hex(key.publicKey)

// ---- borsh, just the parts a function call needs ------------------------------------------------

const u8 = (n) => new Uint8Array([n])
const u32 = (n) => {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, n, true)
  return b
}
const u64 = (n) => {
  const b = new Uint8Array(8)
  new DataView(b.buffer).setBigUint64(0, BigInt(n), true)
  return b
}
const u128 = (n) => concat(u64(BigInt(n) & 0xffffffffffffffffn), u64(BigInt(n) >> 64n))
const str = (s) => {
  const b = utf8(s)
  return concat(u32(b.length), b)
}

export function functionCallAction({ method, args, gas, deposit = 0n }) {
  const argBytes = utf8(JSON.stringify(args))
  return concat(u8(2), str(method), u32(argBytes.length), argBytes, u64(gas), u128(deposit))
}

export function encodeTx({ signerId, publicKey, nonce, receiverId, blockHash, actions }) {
  return concat(str(signerId), u8(0), publicKey, u64(nonce), str(receiverId), blockHash, u32(actions.length), ...actions)
}

/** Signs a transaction. Returns the base64 of the signed transaction, ready for send_tx. */
export async function signTx(key, tx) {
  const digest = await sha256(tx)
  const sig = await sign(key, digest)
  return base64(concat(tx, u8(0), sig))
}

/** The hash NEAR gives a transaction: sha256 of its unsigned bytes, in base58. Known before it is sent. */
export async function txHash(tx) {
  return b58encode(await sha256(tx))
}

export function base64(bytes) {
  if (typeof btoa === 'function') {
    let s = ''
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
    return btoa(s)
  }
  return Buffer.from(bytes).toString('base64')
}

export function unbase64(s) {
  if (typeof atob === 'function') return Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
  return new Uint8Array(Buffer.from(s, 'base64'))
}

// ---- RPC ----------------------------------------------------------------------------------------

export class Rpc {
  /**
   * @param {string[]} hosts in order of preference. A host that fails on the network is skipped for
   * `restMs`; then the first host is used again. (The fallback is for trouble only: the free dRPC
   * plan, for one, does not wait for transactions.)
   */
  constructor(hosts, { timeoutMs = 9000, restMs = 30_000, fetchImpl, now = () => Date.now() } = {}) {
    this.hosts = hosts
    this.timeoutMs = timeoutMs
    this.restMs = restMs
    this.now = now
    this.resting = new Map() // host -> until when it is skipped
    this.fetch = fetchImpl || ((...a) => globalThis.fetch(...a))
    this.onHostChange = null
    this.calls = 0
  }

  /** The first host that is not resting; if all are, the one that rests the shortest. */
  get host() {
    const t = this.now()
    const ok = this.hosts.find((h) => !(this.resting.get(h) > t))
    if (ok) return ok
    return [...this.hosts].sort((a, b) => this.resting.get(a) - this.resting.get(b))[0]
  }

  /** Lets a host rest after network trouble. Several calls failing at once count as one switch. */
  rest(host) {
    if (this.hosts.length < 2) return
    const before = this.host
    this.resting.set(host, this.now() + this.restMs)
    if (this.host !== before) this.onHostChange?.(this.host)
  }

  async call(method, params, { retries = 2 } = {}) {
    let lastErr
    for (let attempt = 0; attempt <= retries; attempt++) {
      const host = this.host
      try {
        this.calls++
        const r = await this.fetch(host, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: String(this.calls), method, params }),
          signal: AbortSignal.timeout(this.timeoutMs),
        })
        if (!r.ok && r.status !== 200) throw new RpcError(`http ${r.status}`, { http: r.status, text: `http ${r.status}` })
        const j = await r.json()
        if (j.error) {
          const text = JSON.stringify(j.error)
          const err = new RpcError(text, j.error)
          if (/TIMEOUT_ERROR|UNKNOWN_BLOCK|UNAVAILABLE_SHARD|INTERNAL_ERROR|HANDLER_ERROR.*Timeout/.test(text) && attempt < retries) {
            lastErr = err
            await sleep(600 * (attempt + 1))
            continue
          }
          throw err
        }
        return j.result
      } catch (e) {
        if (e instanceof RpcError && !e.transient) throw e
        lastErr = e
        // Network trouble: let this host rest, for the retry and for whoever calls next.
        this.rest(host)
        if (attempt < retries) await sleep(400 * (attempt + 1))
      }
    }
    throw lastErr
  }

  async view(contract, method, args = {}) {
    const r = await this.call('query', {
      request_type: 'call_function',
      finality: 'optimistic',
      account_id: contract,
      method_name: method,
      args_base64: base64(utf8(JSON.stringify(args))),
    })
    return JSON.parse(new TextDecoder().decode(new Uint8Array(r.result)))
  }

  async accessKeyNonce(accountId, publicKey) {
    const k = await this.call('query', { request_type: 'view_access_key', finality: 'optimistic', account_id: accountId, public_key: publicKey })
    return BigInt(k.nonce)
  }

  /** Every access key of an account. The contract account must have none. */
  async accessKeyList(accountId) {
    const r = await this.call('query', { request_type: 'view_access_key_list', finality: 'final', account_id: accountId })
    return r.keys || []
  }

  /** Balance, storage and the base58 sha256 of the deployed code. */
  async viewAccount(accountId) {
    return this.call('query', { request_type: 'view_account', finality: 'final', account_id: accountId })
  }

  async blockHash() {
    const b = await this.call('block', { finality: 'final' })
    return b58decode(b.header.hash)
  }

  async sendTx(signedBase64) {
    return this.call('send_tx', { signed_tx_base64: signedBase64, wait_until: 'EXECUTED_OPTIMISTIC' }, { retries: 0 })
  }

  /** The outcome of a transaction already sent, or null while the chain does not know it yet. */
  async txStatus(hash, sender) {
    try {
      return await this.call('tx', { tx_hash: hash, sender_account_id: sender, wait_until: 'EXECUTED_OPTIMISTIC' }, { retries: 0 })
    } catch (e) {
      if (e instanceof RpcError && (e.unknownTx || e.transient)) return null
      throw e
    }
  }
}

export class RpcError extends Error {
  constructor(message, detail) {
    super(message)
    this.detail = detail
    const t = JSON.stringify(detail ?? '')
    this.transient = /TIMEOUT_ERROR|UNKNOWN_BLOCK|INTERNAL_ERROR|UNAVAILABLE_SHARD|Timeout|http 5|http 408|http 429/.test(t)
    this.unknownTx = /UNKNOWN_TRANSACTION|does not exist/.test(t)
    this.invalidNonce = /InvalidNonce/.test(t)
    this.expired = /Expired/.test(t)
    this.noAllowance = /NotEnoughAllowance|AccessKeyDoesNotExist|InvalidAccessKey/.test(t)
  }
}

/** Reads the result of a successful send_tx into something small. */
export function summarise(res) {
  const outcomes = [res.transaction_outcome, ...(res.receipts_outcome || [])]
  const gas = outcomes.reduce((n, o) => n + (o?.outcome?.gas_burnt || 0), 0)
  const failure = res.status?.Failure ? JSON.stringify(res.status.Failure) : null
  let value = null
  if (res.status?.SuccessValue) {
    try {
      value = JSON.parse(new TextDecoder().decode(unbase64(res.status.SuccessValue)))
    } catch {
      value = res.status.SuccessValue
    }
  }
  return { hash: res.transaction?.hash, gas, failure, value }
}

export const sleep = (ms) => new Promise((s) => setTimeout(s, ms))
