// The page's port of the round close must reproduce every golden vector of the simulation
// (sim/golden/*.json, I-3) exactly: every entry's weights, points, budget, dust, payouts and tiers,
// reputation, carry, strikes and the audit, round by round.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Hat, cmp } from '../js/logic.js'

const GOLDEN = fileURLToPath(new URL('../../sim/golden/', import.meta.url))
const files = existsSync(GOLDEN) ? readdirSync(GOLDEN).filter((f) => f.endsWith('.json')).sort() : []
const s = (v) => String(v)

test('golden vectors are there to test against', () => {
  assert.ok(files.length >= 3, `expected sim/golden/*.json, found ${files.length}`)
})

for (const file of files) {
  test(`golden ${file}: every close matches to the base unit`, () => {
    const doc = JSON.parse(readFileSync(join(GOLDEN, file), 'utf8'))
    const hat = new Hat(doc.config)
    for (const row of doc.rounds) {
      const at = `${file} round ${row.round}`
      const exp = row.expected
      const strikes = []
      for (const o of row.outcomes ?? []) {
        const st = hat.resolve(o.round, o.receiver, o.status)
        if (o.status === 'rejected' || o.status === 'removed') strikes.push([o.receiver, o.round, o.status, s(st)])
      }
      assert.deepEqual(strikes, exp.strikes ?? [], `${at}: strikes`)
      const res = row.members == null ? hat.closeEmpty(row.round) : hat.close(row.round, row.members, row.seats ?? [], row.allocations, row.dao_balance)
      assert.equal(res.empty, exp.empty, `${at}: empty`)
      if (!exp.empty) {
        const cnt = res.count
        assert.deepEqual(
          cnt.rows.map((r) => [r.giver, r.receiver, r.thanks, s(r.weight), s(r.reciprocal), s(r.aggregated), s(r.counted)]),
          exp.entries,
          `${at}: entries`,
        )
        assert.deepEqual(cnt.dropped, exp.dropped, `${at}: dropped`)
        assert.equal(s(cnt.membersWeight), exp.members_weight, `${at}: members weight`)
        assert.equal(s(cnt.guestsWeight), exp.guests_weight, `${at}: guests weight`)
        assert.equal(cnt.guestScaled, exp.guest_scaled, `${at}: guest cap`)
        assert.deepEqual([...cnt.points].sort((a, b) => cmp(a[0], b[0])).map(([a, p]) => [a, s(p)]), exp.points, `${at}: points`)
        assert.equal(s(res.budget), exp.budget, `${at}: budget`)
        assert.equal(s(res.dust), exp.dust, `${at}: dust`)
        assert.deepEqual(
          res.payouts.map((x) => ({ receiver: x.receiver, amount: s(x.amount), tier: x.tier, r0: s(x.r0), auto_limit: s(x.autoLimit), cosign_limit: s(x.cosignLimit) })),
          exp.payouts,
          `${at}: payouts`,
        )
        assert.deepEqual(res.moved, exp.moved_to_tier2, `${at}: round cap`)
      }
      assert.deepEqual(res.lapsed.map(([a, v, since]) => [a, s(v), since]), exp.lapsed, `${at}: lapsed`)
      assert.deepEqual(
        [...hat.rep].filter(([, v]) => v > 0n).sort((a, b) => cmp(a[0], b[0])).map(([a, v]) => [a, s(v)]),
        exp.reputation,
        `${at}: reputation`,
      )
      assert.deepEqual(
        [...hat.carry].sort((a, b) => cmp(a[0], b[0])).map(([a, [v, since]]) => [a, s(v), since]),
        exp.carry,
        `${at}: carry`,
      )
      const t = hat.totals
      assert.deepEqual(
        { budget: s(t.budget), planned: s(t.planned), carry: s(hat.carryTotal()), lapsed: s(t.lapsed), dust: s(t.dust), balanced: hat.audit() },
        exp.audit,
        `${at}: audit`,
      )
    }
  })
}
