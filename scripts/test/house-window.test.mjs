// The keeper's window of open payouts (scripts/hat-tip-lib.mjs `nextWindow`, `readWindow`): a payout
// whose filing chain is running or lost must not pin the window, the window pages past 100 payouts,
// and held payouts below the pruning line are still read.
import assert from 'node:assert/strict'
import test from 'node:test'
import { nextWindow, readWindow } from '../hat-tip-lib.mjs'

const P = (id, status, dao = status === 'planned' || status === 'filing' ? null : 1000 + id) => ({ id, status, dao_proposal: dao })

/** A model of the contract's payouts(): ids from..from+limit, pruned ids skipped, held ids kept. */
function chain() {
  const payouts = new Map()
  let oldest = 0
  const held = new Set()
  return {
    payouts,
    add: (status) => {
      const id = payouts.size ? Math.max(...payouts.keys()) + 1 : 0
      payouts.set(id, P(id, status))
      return id
    },
    set: (id, status, dao) => payouts.set(id, P(id, status, dao)),
    prune: (below) => {
      for (const [id, p] of payouts) {
        if (id >= below) continue
        if (['paid', 'rejected', 'expired', 'removed', 'failed'].includes(p.status)) payouts.delete(id)
        else held.add(id)
      }
      oldest = below
    },
    view: async (from, limit) => [...payouts.values()].filter((p) => p.id >= from && p.id < from + Math.min(limit, 100)),
    get oldest() { return oldest },
    get held() { return [...held].filter((id) => payouts.has(id) && !['paid', 'rejected', 'expired', 'removed', 'failed'].includes(payouts.get(id).status)) },
    get next() { return payouts.size ? Math.max(...payouts.keys()) + 1 : 0 },
  }
}

test('nothing open: the window moves to the newest payout', () => {
  const w = nextWindow([P(0, 'paid'), P(1, 'rejected'), P(2, 'removed')], 0, 3)
  assert.deepEqual(w, { openFrom: 3, earlier: [] })
})

test('the first open payout starts the window', () => {
  const w = nextWindow([P(0, 'paid'), P(1, 'filed'), P(2, 'planned')], 0, 3)
  assert.deepEqual(w, { openFrom: 1, earlier: [] })
})

test('a payout in filing without a proposal id does not hold the window, but stays watched', () => {
  const w = nextWindow([P(4, 'paid'), P(5, 'filing'), P(6, 'filed'), P(7, 'approved')], 4, 8)
  assert.deepEqual(w, { openFrom: 6, earlier: [5] })
  // it lands later: it is still read (earlier) until it is final
  const w2 = nextWindow([P(5, 'filed'), P(6, 'paid'), P(7, 'paid')], 6, 8)
  assert.deepEqual(w2, { openFrom: 8, earlier: [5] })
  const w3 = nextWindow([P(5, 'paid')], 8, 8)
  assert.deepEqual(w3, { openFrom: 8, earlier: [] })
})

test('a lost filing never pins the window: 400 payouts later the keeper still sees every new one', async () => {
  const c = chain()
  let st = { openFrom: 0, earlier: [] }
  const lostId = 3
  for (let round = 0; round < 50; round++) {
    for (let k = 0; k < 8; k++) c.add('filed')
    if (round === 0) c.set(lostId, 'filing') // its chain never lands
    const w = await readWindow(c.view, { ...st, held: c.held, oldest: c.oldest, nextPayout: c.next })
    st = { openFrom: w.openFrom, earlier: w.earlier }
    const seen = new Set(w.list.map((p) => p.id))
    // every open payout is in this tick's list, the lost one included
    for (const p of c.payouts.values()) if (p.status !== 'paid') assert.ok(seen.has(p.id), `round ${round}: payout ${p.id} unseen`)
    // the keeper decides everything it saw this tick, except the lost filing
    for (const p of w.list) if (p.id !== lostId && p.status === 'filed') c.set(p.id, 'paid')
    if (round === 30) c.prune(200) // the lost payout is now held, below the pruning line
  }
  assert.equal(c.next, 400)
  const last = await readWindow(c.view, { ...st, held: c.held, oldest: c.oldest, nextPayout: c.next })
  assert.equal(last.openFrom, c.next, 'the window keeps up with the newest payout')
  assert.deepEqual(last.earlier, [lostId], 'the lost filing is still read, as a held payout')
  assert.deepEqual(c.held, [lostId])
})

test('pages past 100: payouts 0-249 all open are all read in one tick', async () => {
  const c = chain()
  for (let i = 0; i < 250; i++) c.add('filed')
  const w = await readWindow(c.view, { openFrom: 0, earlier: [], held: [], oldest: 0, nextPayout: c.next })
  assert.equal(w.list.length, 250)
  assert.equal(w.openFrom, 0)
})

test('held payouts below the pruning line are read even when the window starts above them', async () => {
  const c = chain()
  for (let i = 0; i < 20; i++) c.add('paid')
  c.set(7, 'filed') // an old one still waiting in the DAO
  c.prune(15)
  const w = await readWindow(c.view, { openFrom: 15, earlier: [], held: c.held, oldest: c.oldest, nextPayout: c.next })
  assert.deepEqual(w.list.map((p) => p.id), [7, 15, 16, 17, 18, 19])
  assert.deepEqual(w.earlier, [7])
})
