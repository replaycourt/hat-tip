// The NEAR layer (taken over from Bonfire): base58, borsh, Ed25519 through WebCrypto, RPC with a
// fallback host, the gas pool, the action queue and the guest's identity; plus the Hat Tip client:
// which account and method each view reads, and what `act` signs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import * as N from '../js/near.js'
import { ActionQueue, Client, GasPool, loadIdentity, loadOrCreateIdentity, notDeployed } from '../js/chain.js'
import { allocateAction, joinAction } from '../js/logic.js'
const spki = (pub) => crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), pub]), format: 'der', type: 'spki' })
const keyStr = (k) => 'ed25519:' + N.b58encode(N.concat(k.seed, k.publicKey))

test('base58 round-trips, keeps leading zeros and refuses bad characters', () => {
  const bytes = new Uint8Array([0, 0, 7, 255, 1, 2, 3, 128])
  assert.deepEqual([...N.b58decode(N.b58encode(bytes))], [...bytes])
  assert.equal(N.b58encode(new Uint8Array([0, 0, 1])), '112')
  assert.equal(N.b58encode(new Uint8Array(32)), '1'.repeat(32))
  assert.throws(() => N.b58decode('0OIl'))
})

test('hex and base64 helpers', () => {
  assert.equal(N.hex(new Uint8Array([0, 15, 255])), '000fff')
  assert.deepEqual([...N.unhex('000fff')], [0, 15, 255])
  const b = new Uint8Array([1, 2, 3, 250])
  assert.deepEqual([...N.unbase64(N.base64(b))], [...b])
})

test('WebCrypto Ed25519: new key, rebuild from seed, sign, verify, implicit account', async () => {
  assert.ok(await N.ed25519Supported())
  const k = await N.newKey()
  assert.equal(k.seed.length, 32)
  assert.equal(k.publicKey.length, 32)
  const msg = N.utf8('hattip:v1:hattip.testnet:1:{"join":{"round":1}}')
  const sig = await N.sign(k, msg)
  assert.equal(sig.length, 64)
  assert.ok(crypto.verify(null, msg, spki(k.publicKey), sig))
  const again = await N.keyFromSeed(k.seed, k.publicKey)
  assert.ok(crypto.verify(null, msg, spki(k.publicKey), await N.sign(again, msg)))
  assert.match(N.implicitAccount(k), /^[0-9a-f]{64}$/)
  assert.equal(N.implicitAccount(k), Buffer.from(k.publicKey).toString('hex'))
  assert.equal(N.nearPublicKey(k), 'ed25519:' + N.b58encode(k.publicKey))
})

test('keyFromNearString reads the seed and public key of a NEAR key string', async () => {
  const k = await N.newKey()
  const back = await N.keyFromNearString(keyStr(k))
  assert.deepEqual([...back.publicKey], [...k.publicKey])
  assert.equal((await N.sign(back, N.utf8('x'))).length, 64)
})

test('borsh transaction encoding has the expected layout', () => {
  const pk = new Uint8Array(32).fill(7)
  const action = N.functionCallAction({ method: 'act', args: { a: 1 }, gas: 100_000_000_000_000n, deposit: 0n })
  assert.equal(action[0], 2)
  assert.deepEqual([...action.slice(1, 5)], [3, 0, 0, 0])
  assert.equal(new TextDecoder().decode(action.slice(5, 8)), 'act')
  assert.equal(new DataView(action.buffer).getUint32(8, true), 7)
  assert.equal(action.length, 1 + 4 + 3 + 4 + 7 + 8 + 16)
  const tx = N.encodeTx({ signerId: 'g.testnet', publicKey: pk, nonce: 5n, receiverId: 'c.testnet', blockHash: new Uint8Array(32), actions: [action] })
  assert.equal(tx.length, 4 + 9 + 1 + 32 + 8 + 4 + 9 + 32 + 4 + action.length)
  assert.equal(tx[4 + 9], 0, 'key type ed25519')
  assert.equal(tx[4 + 9 + 1 + 32], 5, 'nonce little-endian')
})

test('signTx appends a signature over the sha256 of the transaction; txHash is its base58', async () => {
  const k = await N.newKey()
  const tx = N.encodeTx({ signerId: 'g.testnet', publicKey: k.publicKey, nonce: 1n, receiverId: 'c.testnet', blockHash: new Uint8Array(32), actions: [] })
  const signed = N.unbase64(await N.signTx(k, tx))
  assert.equal(signed.length, tx.length + 1 + 64)
  const digest = crypto.createHash('sha256').update(tx).digest()
  assert.ok(crypto.verify(null, digest, spki(k.publicKey), signed.slice(tx.length + 1)))
  assert.equal(await N.txHash(tx), N.b58encode(digest))
})

test('summarise reads SuccessValue and sums gas', () => {
  const res = {
    transaction: { hash: 'H' },
    transaction_outcome: { outcome: { gas_burnt: 1 } },
    receipts_outcome: [{ outcome: { gas_burnt: 2, logs: [] } }],
    status: { SuccessValue: Buffer.from('{"settled":1}').toString('base64') },
  }
  const s = N.summarise(res)
  assert.equal(s.hash, 'H')
  assert.equal(s.gas, 3)
  assert.deepEqual(s.value, { settled: 1 })
  assert.equal(s.failure, null)
  assert.ok(N.summarise({ ...res, status: { Failure: { x: 1 } } }).failure)
})

test('RpcError classifies NEAR errors; notDeployed spots a missing contract', () => {
  assert.ok(new N.RpcError('x', { cause: { name: 'TIMEOUT_ERROR' } }).transient)
  assert.ok(new N.RpcError('x', { data: { InvalidNonce: {} } }).invalidNonce)
  assert.ok(new N.RpcError('x', { data: 'NotEnoughAllowance' }).noAllowance)
  assert.ok(new N.RpcError('x', { data: 'Expired' }).expired)
  assert.ok(new N.RpcError('http 408', { http: 408, text: 'http 408' }).transient)
  assert.ok(!new N.RpcError('x', { data: 'something else' }).transient)
  assert.ok(notDeployed(new N.RpcError('x', { cause: { name: 'UNKNOWN_ACCOUNT' } })))
  assert.ok(notDeployed(new N.RpcError('x', { data: 'CodeDoesNotExist' })))
  assert.ok(!notDeployed(new Error('Failed to fetch')))
})

function fakeRpc(script) {
  const calls = []
  return {
    calls,
    fetch: async (host, { body }) => {
      const req = JSON.parse(body)
      calls.push({ method: req.method, params: req.params })
      const next = script[req.method]?.shift()
      if (next instanceof Error) throw next
      return { ok: true, status: 200, json: async () => next ?? { error: { name: 'NO_SCRIPT', method: req.method } } }
    },
  }
}
const methods = (f) => f.calls.map((c) => c.method)

test('Rpc falls over to the fallback host on network failure', async () => {
  const f = fakeRpc({ block: [new TypeError('Failed to fetch'), { result: { header: { hash: '11111111111111111111111111111111' } } }] })
  const rpc = new N.Rpc(['https://a', 'https://b'], { fetchImpl: f.fetch })
  let switched = null
  rpc.onHostChange = (h) => (switched = h)
  assert.equal((await rpc.blockHash()).length, 32)
  assert.equal(switched, 'https://b')
  assert.equal(rpc.host, 'https://b')
})

test('Rpc: calls failing at once switch hosts once, and the first host is used again after its rest', async () => {
  let t = 1_000_000
  const seen = []
  const down = new Set(['https://a'])
  const fetchImpl = async (host, { body }) => {
    seen.push(host)
    if (down.has(host)) throw new TypeError('Failed to fetch')
    void body
    return { ok: true, status: 200, json: async () => ({ result: { header: { hash: '11111111111111111111111111111111' } } }) }
  }
  const rpc = new N.Rpc(['https://a', 'https://b'], { fetchImpl, restMs: 30_000, now: () => t })
  const switches = []
  rpc.onHostChange = (h) => switches.push(h)
  // three polls in flight when the first host drops: before, each failure flipped the host, so an
  // odd number of failures could land everyone back on the broken one
  await Promise.all([rpc.blockHash(), rpc.blockHash(), rpc.blockHash()])
  assert.deepEqual(switches, ['https://b'])
  assert.equal(rpc.host, 'https://b')
  assert.equal(seen.filter((h) => h === 'https://b').length, 3, 'every retry went to the working host')
  // still resting: calls stay on the fallback
  t += 29_000
  await rpc.blockHash()
  assert.equal(seen.at(-1), 'https://b')
  // the first host is preferred again once it has rested (it carries the transactions)
  down.clear()
  t += 2_000
  assert.equal(rpc.host, 'https://a')
  await rpc.blockHash()
  assert.equal(seen.at(-1), 'https://a')
})

test('Rpc: an HTTP 408 from a host (dRPC free plan on send_tx) rests that host too', async () => {
  const seen = []
  const fetchImpl = async (host) => {
    seen.push(host)
    return host === 'https://b' ? { ok: false, status: 408, json: async () => ({ error: { message: 'Request timeout on the free plan', code: 30 } }) } : { ok: true, status: 200, json: async () => ({ result: { header: { hash: '11111111111111111111111111111111' } } }) }
  }
  const rpc = new N.Rpc(['https://a', 'https://b'], { fetchImpl })
  rpc.rest('https://a')
  assert.equal(rpc.host, 'https://b')
  await assert.rejects(rpc.sendTx('AAAA'), (e) => e instanceof N.RpcError && e.transient)
  // both resting now: the one that rests the shortest comes first
  assert.equal(rpc.host, 'https://a')
})

test('Rpc view decodes the result bytes; access keys and the account come from queries', async () => {
  const bytes = [...Buffer.from(JSON.stringify({ night: 3 }))]
  const f = fakeRpc({ query: [{ result: { result: bytes } }, { result: { keys: [] } }, { result: { code_hash: 'H' } }] })
  const rpc = new N.Rpc(['https://a'], { fetchImpl: f.fetch })
  assert.deepEqual(await rpc.view('c', 'state'), { night: 3 })
  assert.deepEqual(await rpc.accessKeyList('c'), [])
  assert.equal(f.calls[1].params.request_type, 'view_access_key_list')
  assert.equal((await rpc.viewAccount('c')).code_hash, 'H')
})

const okTx = (hash) => ({ result: { transaction: { hash }, transaction_outcome: { outcome: { gas_burnt: 1 } }, receipts_outcome: [], status: { SuccessValue: '' } } })
const blocks = (n) => Array.from({ length: n }, () => ({ result: { header: { hash: '11111111111111111111111111111111' } } }))

test('GasPool retires a key without allowance and re-reads a nonce on InvalidNonce', async () => {
  const k1 = await N.newKey()
  const k2 = await N.newKey()
  const f = fakeRpc({
    query: [{ result: { nonce: 10 } }, { result: { nonce: 20 } }, { result: { nonce: 30 } }],
    block: blocks(6),
    send_tx: [{ error: { data: 'NotEnoughAllowance' } }, { error: { data: { InvalidNonce: {} } } }, okTx('T')],
  })
  const rpc = new N.Rpc(['https://a'], { fetchImpl: f.fetch })
  const pool = new GasPool(rpc, [{ public_key: N.nearPublicKey(k1), private_key: keyStr(k1) }, { public_key: N.nearPublicKey(k2), private_key: keyStr(k2) }], 'gas.testnet')
  pool.cursor = 0
  const r = await pool.relay('c.testnet', 'settle', {}, 1n)
  assert.equal(r.hash, 'T')
  assert.equal(pool.alive().length, 1)
  assert.equal(methods(f).filter((m) => m === 'send_tx').length, 3)
})

test('GasPool looks a timed-out transaction up by hash instead of sending it twice', async () => {
  const k1 = await N.newKey()
  const f = fakeRpc({
    query: [{ result: { nonce: 10 } }],
    block: blocks(1),
    send_tx: [{ error: { name: 'REQUEST_TIMEOUT', cause: { name: 'TIMEOUT_ERROR' } } }],
    tx: [{ error: { cause: { name: 'UNKNOWN_TRANSACTION' } } }, okTx('T2')],
  })
  const rpc = new N.Rpc(['https://a'], { fetchImpl: f.fetch })
  const pool = new GasPool(rpc, [{ public_key: N.nearPublicKey(k1), private_key: keyStr(k1) }], 'gas.testnet')
  const r = await pool.relay('c.testnet', 'act', {}, 1n)
  assert.equal(r.hash, 'T2')
  assert.equal(methods(f).filter((m) => m === 'send_tx').length, 1, 'sent once')
  assert.equal(methods(f).filter((m) => m === 'tx').length, 2)
})

test('an empty gas pool says so instead of sending anything', async () => {
  const f = fakeRpc({})
  const pool = new GasPool(new N.Rpc(['https://a'], { fetchImpl: f.fetch }), [], 'gas.testnet')
  assert.ok(pool.empty)
  await assert.rejects(pool.relay('c', 'act', {}, 1n), /gas pool is empty/)
  assert.equal(f.calls.length, 0)
})


const DEP = { contract: 'hattip.testnet', gasAccount: 'gas.testnet', gasKeys: [], house: { 'ana.cafe.testnet': 'honest' } }

test('Client.act signs hattip:v1:<contract>:<nonce>:<action> with the guest key and relays act', async () => {
  const id = { key: await N.newKey() }
  id.account = N.implicitAccount(id.key)
  const relayed = []
  const pool = { empty: false, relay: async (receiver, method, args) => (relayed.push({ receiver, method, args }), { hash: 'H', gas: 5, failure: null, value: { ok: true, error: null, nonce: args.nonce, round: 7 } }) }
  const rpc = { view: async () => ({ account: id.account, payouts: [] }) }
  const c = new Client({ rpc, deployment: DEP, pool })
  await c.setIdentity(id)
  const action = allocateAction(7, [['ana.cafe.testnet', 40], ['ben.cafe.testnet', 60]])
  const before = Date.now()
  const out = await c.act(action)
  assert.equal(out.ok, true)
  const { receiver, method, args } = relayed[0]
  assert.equal(receiver, 'hattip.testnet')
  assert.equal(method, 'act')
  assert.equal(args.pubkey, id.account, 'the implicit account is the hex public key')
  assert.equal(args.action, action)
  assert.ok(args.nonce >= before, 'millisecond nonces')
  assert.match(args.signature, /^[0-9a-f]{128}$/)
  const text = `hattip:v1:hattip.testnet:${args.nonce}:${action}`
  assert.ok(crypto.verify(null, Buffer.from(text), spki(id.key.publicKey), Buffer.from(args.signature, 'hex')))
  assert.equal(c.txs[0].hash, 'H')
  await c.act(joinAction(7, 'brought cake'))
  assert.ok(relayed[1].args.nonce > args.nonce, 'nonces rise')
})

test('Client reads the contract, then its DAO and token from config()', async () => {
  const views = []
  const answers = { config: { dao: 'cafe.sputnikv2.testnet', token: 'tusd.testnet' }, get_proposals: [{ id: 12, status: 'Approved' }] }
  const rpc = { view: async (account, method, args) => (views.push([account, method, args]), answers[method] ?? null), accessKeyList: async (a) => (views.push([a, 'keys']), []), viewAccount: async (a) => ({ code_hash: 'X' + a }) }
  const c = new Client({ rpc, deployment: DEP, pool: { empty: true } })
  await c.config()
  await c.state()
  await c.round(4)
  await c.member('ana.cafe.testnet')
  await c.payouts(10, 5)
  await c.audit()
  await c.policy()
  assert.equal((await c.proposal('12')).status, 'Approved')
  await c.daoBalance()
  await c.balanceOf('abc')
  await c.accessKeys('hattip.testnet')
  assert.deepEqual(views, [
    ['hattip.testnet', 'config', {}],
    ['hattip.testnet', 'state', {}],
    ['hattip.testnet', 'round', { n: 4 }],
    ['hattip.testnet', 'member', { account_id: 'ana.cafe.testnet' }],
    ['hattip.testnet', 'payouts', { from: 10, limit: 5 }],
    ['hattip.testnet', 'audit', {}],
    ['cafe.sputnikv2.testnet', 'get_policy', undefined],
    ['cafe.sputnikv2.testnet', 'get_proposals', { from_index: 12, limit: 1 }],
    ['tusd.testnet', 'ft_balance_of', { account_id: 'cafe.sputnikv2.testnet' }],
    ['tusd.testnet', 'ft_balance_of', { account_id: 'abc' }],
    ['hattip.testnet', 'keys'],
  ])
  assert.equal(c.canAct, false, 'no gas keys: the page offers no actions')
  // a removed proposal is deleted by Sputnik: get_proposals answers [] (or the next id)
  const gone = new Client({ rpc: { view: async () => [{ id: 13 }] }, deployment: DEP, pool: { empty: true } })
  gone.dao = 'cafe.sputnikv2.testnet'
  assert.equal(await gone.proposal(12), null)
  assert.deepEqual(c.house, DEP.house)
})

test('Client relays close_round, pay and check_payout with their arguments', async () => {
  const relayed = []
  const pool = { empty: false, relay: async (receiver, method, args, gas) => (relayed.push([receiver, method, args, gas]), { hash: 'R', gas: 1, failure: null, value: {} }) }
  const c = new Client({ rpc: {}, deployment: DEP, pool })
  await c.closeRound()
  await c.pay(4)
  await c.checkPayout('9')
  assert.deepEqual(relayed.map((r) => [r[0], r[1], r[2]]), [
    ['hattip.testnet', 'close_round', {}],
    ['hattip.testnet', 'pay', { max: 4 }],
    ['hattip.testnet', 'check_payout', { payout: 9 }],
  ])
  assert.deepEqual(c.txs.map((t) => t.kind), ['check', 'pay', 'close'])
  const failing = new Client({ rpc: {}, deployment: DEP, pool: { empty: false, relay: async () => ({ hash: 'F', gas: 1, failure: '{"ActionError":1}', value: null }) } })
  await assert.rejects(failing.closeRound(), /did not go through/)
})

test('ActionQueue keeps one act in flight, in order, and reports errors', async () => {
  const sent = []
  const fake = {
    act: async (action) => {
      sent.push(action)
      await new Promise((r) => setTimeout(r, 15))
      if (action === 'bad') throw new Error('boom')
      return { ok: true }
    },
  }
  const done = []
  const errors = []
  const q = new ActionQueue(fake, { onDone: (out, item) => done.push(item.kind), onError: (e) => errors.push(e.message) })
  q.push({ kind: 'note', build: () => 'a' })
  q.push({ kind: 'bad', build: () => 'bad' })
  q.push({ kind: 'allocate', build: () => 'b' })
  assert.ok(q.busy)
  await new Promise((r) => setTimeout(r, 120))
  assert.deepEqual(sent, ['a', 'bad', 'b'])
  assert.deepEqual(done, ['note', 'allocate'])
  assert.deepEqual(errors, ['boom'])
  assert.equal(q.busy, false)
})

test('a key is made only when asked for, then loaded again from storage', async () => {
  const store = new Map()
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) }
  assert.equal(await loadIdentity(storage), null, 'looking makes no key')
  const a = await loadOrCreateIdentity(storage)
  assert.ok(a.fresh)
  const b = await loadIdentity(storage)
  assert.ok(!b.fresh)
  assert.equal(a.account, b.account)
  assert.match(a.account, /^[0-9a-f]{64}$/)
  assert.ok(store.has('hattip:key:v1'))
})

test('Rpc keeps at most maxInFlight calls on the wire (public nodes answer bursts with 429)', async () => {
  let now = 0
  let peak = 0
  const fetchImpl = async () => {
    now++
    peak = Math.max(peak, now)
    await new Promise((r) => setTimeout(r, 5))
    now--
    return { ok: true, status: 200, json: async () => ({ result: { header: { hash: '11111111111111111111111111111111' } } }) }
  }
  const rpc = new N.Rpc(['https://a'], { fetchImpl, maxInFlight: 3 })
  await Promise.all(Array.from({ length: 12 }, () => rpc.blockHash()))
  assert.equal(peak, 3)
  assert.equal(rpc.inFlight, 0, 'every slot handed back')
})

test('Rpc: an HTTP 429 rests the host and the call goes through on the other one', async () => {
  const seen = []
  const fetchImpl = async (host) => {
    seen.push(host)
    return host === 'https://a' ? { ok: false, status: 429, json: async () => ({}) } : { ok: true, status: 200, json: async () => ({ result: { header: { hash: '11111111111111111111111111111111' } } }) }
  }
  const rpc = new N.Rpc(['https://a', 'https://b'], { fetchImpl })
  assert.equal((await rpc.blockHash()).length, 32)
  assert.deepEqual(seen, ['https://a', 'https://b'])
  assert.equal(rpc.host, 'https://b', 'the first host rests')
})

test('Client.proposals reads a range of DAO proposals in one get_proposals call', async () => {
  const views = []
  const rpc = { view: async (account, method, args) => (views.push([account, method, args]), [{ id: 4 }, { id: 6 }]) }
  const c = new Client({ rpc, deployment: DEP, pool: { empty: true } })
  c.dao = 'cafe.sputnikv2.testnet'
  assert.deepEqual((await c.proposals(4, 3)).map((p) => p.id), [4, 6])
  assert.deepEqual(views, [['cafe.sputnikv2.testnet', 'get_proposals', { from_index: 4, limit: 3 }]])
})

test('Rpc keeps call starts at least minGapMs apart', async () => {
  const starts = []
  const fetchImpl = async () => (starts.push(Date.now()), { ok: true, status: 200, json: async () => ({ result: { header: { hash: '11111111111111111111111111111111' } } }) })
  const rpc = new N.Rpc(['https://a'], { fetchImpl, maxInFlight: 4, minGapMs: 40 })
  await Promise.all(Array.from({ length: 5 }, () => rpc.blockHash()))
  // each start is scheduled minGapMs after the one before; timers may fire late, never much early
  assert.ok(starts.at(-1) - starts[0] >= 4 * 40 - 5, JSON.stringify(starts.map((t) => t - starts[0])))
})
