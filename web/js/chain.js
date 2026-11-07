// Talks to NEAR testnet: the guest's local key, the public gas pool, the views of the contract, its
// DAO and its token, and the relayed calls `act`, `close_round`, `pay` and `check_payout`, with
// retries over keys and RPC hosts. The UI never sees a transaction; it sees promises that resolve
// to outcomes, and friendly errors when the network is in a mood.
// (The gas pool and the retry logic are taken over from Bonfire, an earlier entry by the same author.)
import { Rpc, RpcError, encodeTx, functionCallAction, hex, implicitAccount, keyFromNearString, keyFromSeed, newKey, sign, signTx, sleep, summarise, txHash, unhex, utf8 } from './near.js'
import { ACT_GAS, CHECK_GAS, CLOSE_GAS, DEPLOYMENT, PAY_GAS, PAY_MAX, RPC_HOSTS } from './config.js'
import { nextNonce, signingText } from './logic.js'

const STORE_KEY = 'hattip:key:v1'

export class FriendlyError extends Error {
  constructor(message, cause) {
    super(message)
    this.cause = cause
  }
}

// ---- the guest's identity -----------------------------------------------------------------------

export async function loadOrCreateIdentity(storage = globalThis.localStorage, storeKey = STORE_KEY) {
  const raw = storage?.getItem(storeKey)
  if (raw) {
    try {
      const { seed, pub } = JSON.parse(raw)
      const key = await keyFromSeed(unhex(seed), unhex(pub))
      return { key, account: implicitAccount(key), fresh: false }
    } catch {
      // fall through and make a new one
    }
  }
  const key = await newKey()
  storage?.setItem(storeKey, JSON.stringify({ seed: hex(key.seed), pub: hex(key.publicKey) }))
  return { key, account: implicitAccount(key), fresh: true }
}

/** The key, if this browser already has one (no key is made just by looking). */
export async function loadIdentity(storage = globalThis.localStorage, storeKey = STORE_KEY) {
  if (!storage?.getItem(storeKey)) return null
  return loadOrCreateIdentity(storage, storeKey)
}

// ---- the gas pool -------------------------------------------------------------------------------

export class GasPool {
  constructor(rpc, keys = DEPLOYMENT.gasKeys, account = DEPLOYMENT.gasAccount) {
    this.rpc = rpc
    this.account = account
    this.entries = (keys ?? []).map((k) => ({ ...k, key: null, nonce: null, dead: false, busy: false }))
    this.cursor = Math.floor(Math.random() * Math.max(1, this.entries.length))
  }

  get empty() {
    return this.entries.length === 0
  }

  alive() {
    return this.entries.filter((e) => !e.dead)
  }

  pick() {
    const alive = this.alive()
    if (!alive.length) throw new FriendlyError('The gas pool is empty. The round goes on; giving resumes once the pool is refilled.')
    for (let i = 0; i < alive.length; i++) {
      const e = alive[(this.cursor + i) % alive.length]
      if (!e.busy) {
        this.cursor = (this.cursor + i + 1) % alive.length
        return e
      }
    }
    return alive[this.cursor++ % alive.length]
  }

  async ready(e) {
    if (!e.key) e.key = await keyFromNearString(e.private_key)
    if (e.nonce === null) e.nonce = await this.rpc.accessKeyNonce(this.account, e.public_key)
  }

  /** Sends one function call with a pool key, rotating keys on trouble. Returns summarise(result). */
  async relay(receiver, method, args, gas, { attempts = 5 } = {}) {
    let lastErr
    for (let attempt = 0; attempt < attempts; attempt++) {
      const e = this.pick()
      e.busy = true
      try {
        await this.ready(e)
        const blockHash = await this.rpc.blockHash()
        e.nonce += 1n
        const tx = encodeTx({ signerId: this.account, publicKey: e.key.publicKey, nonce: e.nonce, receiverId: receiver, blockHash, actions: [functionCallAction({ method, args, gas })] })
        const signed = await signTx(e.key, tx)
        const hash = await txHash(tx)
        return summarise(await this.send(signed, hash))
      } catch (err) {
        lastErr = err
        if (err instanceof RpcError) {
          if (err.invalidNonce) e.nonce = null
          else if (err.noAllowance) e.dead = true
          else if (!err.expired && !err.transient) throw friendly(err)
        }
        await sleep(300 + attempt * 400)
      } finally {
        e.busy = false
      }
    }
    throw friendly(lastErr)
  }

  /**
   * Sends one signed transaction and gets its outcome, even when the RPC times out after the chain
   * already took it: a timeout is followed by asking for the status by hash; an unknown hash is sent
   * again, the same bytes, so nothing is ever applied twice.
   */
  async send(signed, hash) {
    let timedOut = null
    for (let round = 0; round < 2; round++) {
      try {
        return await this.rpc.sendTx(signed)
      } catch (err) {
        if (!(err instanceof RpcError) || !err.transient) {
          if (round > 0 && err instanceof RpcError && err.invalidNonce) {
            const found = await this.lookup(hash, 8)
            if (found) return found
          }
          throw err
        }
        timedOut = err
      }
      const found = await this.lookup(hash, 6)
      if (found) return found
    }
    throw timedOut
  }

  async lookup(hash, tries) {
    for (let i = 0; i < tries; i++) {
      await sleep(1200)
      const r = await this.rpc.txStatus(hash, this.account).catch(() => null)
      if (r?.status) return r
    }
    return null
  }
}

export function friendly(err) {
  if (err instanceof FriendlyError) return err
  const t = String(err?.message ?? err)
  console.info('chain', t.slice(0, 300))
  if (/InvalidNonce/.test(t)) return new FriendlyError('The relay was busy. Nothing was lost; try again.', err)
  if (/NotEnoughAllowance|AccessKeyDoesNotExist/.test(t)) return new FriendlyError('The gas pool is running low. Try again in a moment.', err)
  if (/TIMEOUT|timeout|Failed to fetch|NetworkError|http 5|abort/i.test(t)) return new FriendlyError('The network hiccupped. Nothing was lost; try again.', err)
  return new FriendlyError('Something went wrong on the way. Nothing was lost.', err)
}

/** True when an RPC error says an account or its code does not exist (not deployed yet). */
export function notDeployed(err) {
  const t = JSON.stringify(err?.detail ?? '') + String(err?.message ?? '')
  return /UNKNOWN_ACCOUNT|does not exist|CodeDoesNotExist|NO_CONTRACT_CODE|MethodNotFound/.test(t)
}

// ---- the contract, its DAO and its token --------------------------------------------------------

export class Client {
  constructor({ rpc = new Rpc(RPC_HOSTS, { maxInFlight: 3, minGapMs: 120 }), deployment = DEPLOYMENT, pool } = {}) {
    this.mock = false
    this.rpc = rpc
    this.contract = deployment.contract
    this.gasAccount = deployment.gasAccount
    this.codeHash = deployment.codeHash
    this.tokenCodeHash = deployment.tokenCodeHash
    this.lockTx = deployment.lockTx
    this.house = deployment.house ?? {}
    this.pool = pool ?? new GasPool(rpc, deployment.gasKeys, deployment.gasAccount)
    this.identity = null
    this.nonce = 0
    this.dao = null
    this.token = null
    this.txs = [] // {kind, hash, gas, at, failure}
    this.onTx = null
  }

  get canAct() {
    return !this.pool.empty
  }
  get rpcHost() {
    return this.rpc.host
  }

  view(method, args = {}) {
    return this.rpc.view(this.contract, method, args)
  }

  async config() {
    const c = await this.view('config')
    this.dao = c.dao
    this.token = c.token
    return c
  }
  state() {
    return this.view('state')
  }
  round(n) {
    return this.view('round', { n })
  }
  member(account) {
    return this.view('member', { account_id: account })
  }
  payouts(from, limit) {
    return this.view('payouts', { from, limit })
  }
  audit() {
    return this.view('audit')
  }
  tiers(account) {
    return this.view('tiers', { account_id: account })
  }
  policy() {
    return this.rpc.view(this.dao, 'get_policy')
  }
  /**
   * One DAO proposal, or null if the DAO deleted it (Sputnik deletes a removed proposal). Read
   * with get_proposals, as the contract's check_payout does: get_proposal fails for a deleted id.
   */
  async proposal(id) {
    const list = await this.rpc.view(this.dao, 'get_proposals', { from_index: Number(id), limit: 1 })
    return list?.find((p) => Number(p.id) === Number(id)) ?? null
  }
  /** The DAO's proposals with ids from..from+limit-1 that still exist, in one read. */
  async proposals(from, limit) {
    return (await this.rpc.view(this.dao, 'get_proposals', { from_index: Number(from), limit: Number(limit) })) ?? []
  }
  daoBalance() {
    return this.rpc.view(this.token, 'ft_balance_of', { account_id: this.dao })
  }
  balanceOf(account) {
    return this.rpc.view(this.token, 'ft_balance_of', { account_id: account })
  }
  accessKeys(account) {
    return this.rpc.accessKeyList(account)
  }
  viewAccount(account) {
    return this.rpc.viewAccount(account)
  }

  async setIdentity(identity) {
    this.identity = identity
    this.nonce = Number(globalThis.localStorage?.getItem(`hattip:nonce:${this.contract}:${identity.account}`) ?? 0)
    return this.member(identity.account).catch(() => null)
  }

  saveNonce() {
    globalThis.localStorage?.setItem(`hattip:nonce:${this.contract}:${this.identity.account}`, String(this.nonce))
  }

  record(kind, r) {
    const entry = { kind, hash: r.hash, gas: r.gas, at: Date.now(), failure: r.failure }
    this.txs.unshift(entry)
    this.txs = this.txs.slice(0, 40)
    this.onTx?.(entry)
    return entry
  }

  /** Signs one action (a JSON string) and relays it. Returns the ActOutcome; refusals come back in `error`. */
  async act(action) {
    if (!this.identity) throw new FriendlyError('No key yet.')
    for (let attempt = 0; attempt < 3; attempt++) {
      const nonce = nextNonce(this.nonce, Date.now())
      this.nonce = nonce
      this.saveNonce()
      const signature = hex(await sign(this.identity.key, utf8(signingText(this.contract, nonce, action))))
      const r = await this.pool.relay(this.contract, 'act', { pubkey: this.identity.account, nonce, action, signature }, ACT_GAS)
      this.record('act', r)
      if (r.failure) {
        if (/nonce/i.test(r.failure) && attempt < 2) {
          this.nonce = Date.now() + 1000 * (attempt + 1)
          continue
        }
        throw new FriendlyError('The contract refused that. Nothing was lost.', new Error(r.failure))
      }
      return r.value
    }
    throw new FriendlyError('The action could not be signed in. Try again.')
  }

  async relayed(kind, method, args, gas) {
    const r = await this.pool.relay(this.contract, method, args, gas, { attempts: 3 })
    this.record(kind, r)
    if (r.failure) throw new FriendlyError(`${kind} did not go through.`, new Error(r.failure))
    return r.value
  }

  /** Anyone may close a due round, file planned payouts and read a payout's outcome. */
  closeRound() {
    return this.relayed('close', 'close_round', {}, CLOSE_GAS)
  }
  /** Files as many planned payouts as the gas allows (40-130 Tgas each, contract/README.md). */
  pay(max = PAY_MAX) {
    return this.relayed('pay', 'pay', { max }, PAY_GAS)
  }
  checkPayout(id) {
    return this.relayed('check', 'check_payout', { payout: Number(id) }, CHECK_GAS)
  }
}

// ---- the action queue ---------------------------------------------------------------------------

/** One `act` in flight at a time, so nonces never overtake each other. */
export class ActionQueue {
  constructor(client, { onDone, onError, onChange } = {}) {
    this.client = client
    this.items = []
    this.inflight = null
    this.onDone = onDone
    this.onError = onError
    this.onChange = onChange
  }

  get busy() {
    return !!this.inflight || this.items.length > 0
  }

  push(item) {
    this.items.push(item)
    this.onChange?.()
    this.pump()
  }

  async pump() {
    if (this.inflight || !this.items.length) return
    const item = this.items.shift()
    this.inflight = item
    this.onChange?.()
    try {
      const out = await this.client.act(item.build())
      this.onDone?.(out, item)
    } catch (e) {
      this.onError?.(e, item)
    } finally {
      this.inflight = null
      this.onChange?.()
      this.pump()
    }
  }
}
