// The house council's published rule (scripts/hat-tip-lib.mjs `councilDecision`): a welcome is not
// a partnership, the colluding pair is still caught, and the script decides exactly as the
// simulation does (sim/hat_tip_sim.py `council_decision`, through sim/replay.json).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { councilDecision } from '../hat-tip-lib.mjs'

const PARAMS = JSON.parse(readFileSync(new URL('../../sim/params.json', import.meta.url), 'utf8'))
const MIN = PARAMS.house.council_rule.partner_min
const GUEST = '5b92bb7dc270050bae160aa8bbf8c9eec10fa02f619d65c85d7a0159579dffc5'
const round = (gifts) => ({ gifts: gifts.map(([g, r, given, counted]) => [g, r, given, String(counted)]) })

test('the threshold is above a welcome and the published text names it', () => {
  assert.ok(MIN > PARAMS.house.behaviour.welcome_each, 'a welcome alone never makes a partner')
  for (const c of PARAMS.house.council) assert.match(c.strategy, /council_rule\.partner_min thanks/)
})

test("a guest welcomed with 5 thanks is not a partner (staging, round 2: emil's payout)", () => {
  const rv = round([
    [GUEST, 'emil', 25, 4000], ['ana', 'emil', 4, 1000], ['ben', 'emil', 3, 750],
    ['emil', GUEST, 5, 2500], ['emil', 'ana', 25, 25000],
  ])
  const d = councilDecision(2, 'emil', rv, MIN)
  assert.equal(d.approve, true, d.why)
  assert.equal(councilDecision(2, 'emil', rv, 1).approve, false, 'the old rule (any thanks back) rejected it')
})

test('the colluding pair is still caught: the partner gave most of the points and got the cap back', () => {
  const rv = round([['gus', 'finn', 25, 6250], ['ana', 'finn', 2, 2000], ['finn', 'gus', 25, 6250], ['finn', 'ana', 10, 10000]])
  const d = councilDecision(2, 'finn', rv, MIN)
  assert.equal(d.approve, false)
  assert.match(d.why, /thanked back with 25/)
})

test('the threshold is inclusive', () => {
  const at = (back) => councilDecision(2, 'r', round([['g', 'r', 30, 30000], ['h', 'r', 1, 1000], ['r', 'g', back, back * 1000]]), MIN)
  assert.equal(at(MIN).approve, false)
  assert.equal(at(MIN - 1).approve, true)
})

test('tier 3: three givers or more', () => {
  const two = round([['a', 'r', 30, 30000], ['b', 'r', 20, 20000]])
  const three = round([['a', 'r', 30, 30000], ['b', 'r', 20, 20000], ['c', 'r', 5, 5000]])
  assert.equal(councilDecision(3, 'r', two, MIN).approve, false)
  assert.equal(councilDecision(3, 'r', three, MIN).approve, true)
})

test('the script decides every tier-2 and tier-3 payout of sim/replay.json as the simulation did', () => {
  const replay = JSON.parse(readFileSync(new URL('../../sim/replay.json', import.meta.url), 'utf8'))
  let n = 0
  for (const r of replay.rounds) {
    for (const side of ['launch', 'none']) {
      const s = r[side]
      for (const [receiver, , tier, status] of s.payouts ?? []) {
        if (tier === 1) continue
        const d = councilDecision(tier, receiver, { gifts: s.gifts }, MIN)
        assert.equal(d.approve ? 'paid' : 'rejected', status, `round ${r.round} ${side} ${receiver} tier ${tier}: ${d.why}`)
        n++
      }
    }
  }
  assert.ok(n > 100, `${n} payouts compared`)
})
