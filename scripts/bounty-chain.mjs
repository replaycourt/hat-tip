// Chain side of the bounties (scripts/bounty-lib.mjs has the rules): the bounty keys, a signer that
// may only post, claim, finish or give up bounties in the DAO, and the reads the board needs.
// Node 20+, standard library only. Testnet only.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Signer, accessKeys, view } from './near-lite.mjs'
import { NEAR, SECRETS, TGAS, freeBalance, nearStr, publicKeyOfSeed, seedSigner } from './hat-tip-lib.mjs'

export const bountyKeysFile = (contract) => join(SECRETS, `house-bounty-keys-${contract}.json`)

/** Gas of the bounty calls. A council vote that approves finished work runs the payout and returns two bonds. */
export const BOUNTY_GAS = { post: 30n * TGAS, claim: 30n * TGAS, done: 30n * TGAS, giveup: 30n * TGAS, vote: 30n * TGAS, voteDone: 60n * TGAS }

/**
 * The bounty keys: the environment variable HOUSE_BOUNTY_KEYS (the GitHub secret of that name), else
 * the git-ignored .secrets/house-bounty-keys-<contract>.json. Format:
 *   {"v":1,"section":"final","contract":"...","members":{"<account>":"<64 hex seed>",...}}
 * Full-access keys: posting, claiming and filing finished work attach a deposit (the DAO's proposal
 * and bounty bonds), which a function-call key cannot. They are used for nothing else (`BountySigner`).
 */
export function loadBountyKeys(d) {
  let raw = process.env.HOUSE_BOUNTY_KEYS
  if (!raw && existsSync(bountyKeysFile(d.contract))) raw = readFileSync(bountyKeysFile(d.contract), 'utf8')
  if (!raw || !raw.trim()) return null
  const k = JSON.parse(raw)
  if (k.contract !== d.contract) throw new Error(`the bounty keys are for ${k.contract}, not for ${d.contract}`)
  return k
}

/** Checks a bounty key on chain: a full-access key of `account`. Returns a problem or null. */
export async function checkBountyKey(account, seed) {
  const pk = publicKeyOfSeed(seed)
  const keys = await accessKeys(account, 'optimistic').catch(() => [])
  const k = keys.find((x) => x.public_key === pk)
  if (!k) return `no such key on ${account}`
  if (k.access_key.permission !== 'FullAccess') return `the bounty key of ${account} is a function-call key; bounties need deposits`
  return null
}

const DAO_METHODS = new Set(['add_proposal', 'bounty_claim', 'bounty_done', 'bounty_giveup'])

/**
 * A signer for one member's bounty key that refuses everything but the bounty calls on the DAO:
 * add_proposal with an AddBounty kind, bounty_claim, bounty_done and bounty_giveup, each with at
 * most `maxDeposit` attached. So a bug cannot spend the member's NEAR or act elsewhere with it.
 */
export class BountySigner {
  /** `key`: a 64-hex seed, or a near-lite Signer of `account` (a key from the legacy keychain). */
  constructor(account, key, dao, { maxDeposit = 2n * NEAR } = {}) {
    this.accountId = account
    this.dao = dao
    this.maxDeposit = maxDeposit
    this.inner = typeof key === 'string' ? seedSigner(account, key) : key
    if (this.inner.accountId !== account) throw new Error(`a key of ${this.inner.accountId}, not of ${account}`)
  }

  async call(receiver, method, args, { gas = 30n * TGAS, deposit = 0n } = {}) {
    if (receiver !== this.dao || !DAO_METHODS.has(method)) throw new Error(`the bounty key of ${this.accountId} may not call ${receiver}.${method}`)
    if (method === 'add_proposal' && !args?.proposal?.kind?.AddBounty) throw new Error('the bounty key files AddBounty proposals only')
    if (deposit > this.maxDeposit) throw new Error(`a deposit of ${nearStr(deposit, 3)} NEAR is more than a bounty call needs`)
    return this.inner.call(receiver, method, args, { gas, deposit })
  }
}

/** The bounty signers of `keys` for the accounts of `allowed`, each checked on chain. */
export async function bountySigners(keys, allowed, dao, log = console.log) {
  const out = new Map()
  for (const [account, seed] of Object.entries(keys?.members ?? {})) {
    if (!seed) continue
    if (!allowed.has(account)) {
      log(`bounty key of ${account}: not a bounty member; ignored`)
      continue
    }
    const problem = await checkBountyKey(account, seed)
    if (problem) log(`bounty key of ${account}: ${problem}; it does not work on bounties`)
    else out.set(account, new BountySigner(account, seed, dao))
  }
  return out
}

// ---- reads --------------------------------------------------------------------------------------------

const isBountyProposal = (q) => q && q.kind && ('AddBounty' in q.kind || 'BountyDone' in q.kind)

/**
 * The DAO's bounty proposals, kept up to date by `refresh()`: the first call reads the last `back`
 * proposals, later calls only the new ones, and every bounty proposal still in the vote (or approved
 * less than `settleMs` ago, since Sputnik shows Approved before the transfer ran) is read again.
 */
export class BountyProposals {
  constructor(dao, { back = 400, settleMs = 60_000 } = {}) {
    this.dao = dao
    this.back = back
    this.settleMs = settleMs
    this.byId = new Map()
    this.next = null
    this.seenApproved = new Map()
  }

  async refresh() {
    const last = await view(this.dao, 'get_last_proposal_id')
    if (this.next === null) this.next = Math.max(0, last - this.back)
    for (let at = this.next; at < last; at += 100) {
      for (const q of await view(this.dao, 'get_proposals', { from_index: at, limit: Math.min(100, last - at) })) if (isBountyProposal(q)) this.byId.set(q.id, q)
    }
    this.next = Math.max(this.next, last)
    const now = Date.now()
    for (const q of [...this.byId.values()]) {
      const recent = q.status === 'Approved' && now - (this.seenApproved.get(q.id) ?? now) < this.settleMs
      if (q.status !== 'InProgress' && !recent) continue
      const n = await view(this.dao, 'get_proposal', { id: q.id }).catch((e) => (/ERR_NO_PROPOSAL/.test(e.message) ? null : q))
      if (n) this.byId.set(q.id, n)
      else this.byId.delete(q.id) // removed
    }
    for (const q of this.byId.values()) if (q.status === 'Approved' && !this.seenApproved.has(q.id)) this.seenApproved.set(q.id, now)
    return [...this.byId.values()].sort((a, b) => a.id - b.id)
  }
}

/** The DAO's bounties (get_bounties pages of 100); with `recent`, only the newest that many. */
export async function allBounties(dao, { recent = Infinity } = {}) {
  const last = await view(dao, 'get_last_bounty_id')
  const out = []
  for (let at = Math.max(0, last - recent); at < last; at += 100) out.push(...(await view(dao, 'get_bounties', { from_index: at, limit: 100 })))
  return out
}

/** The claims of `accounts` ({ account: [...] }) and the claim counts of the bounties not done. */
export async function claimsAndCounts(dao, accounts, bounties) {
  const claims = {}
  for (const a of accounts) claims[a] = await view(dao, 'get_bounty_claims', { account_id: a }).catch(() => [])
  const counts = {}
  for (const b of bounties) if (Number(b.times) > 0) counts[b.id] = await view(dao, 'get_bounty_number_of_claims', { id: b.id })
  return { claims, counts }
}

/** NEAR an account can spend now (free balance above its storage), as a BigInt. */
export async function spendable(account) {
  return (await freeBalance(account)).free
}
