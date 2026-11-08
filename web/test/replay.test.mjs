// The second replay: its data is exactly what scripts/replay-data.mjs derives from the
// simulation's files (so it cannot drift), and the pure parts of js/replay.js compute shares,
// excess over the work share, the sentences and the dumbbell axis correctly.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { REPLAY } from '../js/replay-data.js'
import { SIDES, dumbbell, fmtCents, fmtPts, frame, rulesText, scaleMax, summary } from '../js/replay.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const WEB = join(ROOT, 'web')
const SIM = join(ROOT, 'sim/replay.json')
const haveSim = existsSync(SIM) && existsSync(join(ROOT, 'sim/sweep.json')) && existsSync(join(ROOT, 'scripts/replay-data.mjs'))

test('replay-data.js is what scripts/replay-data.mjs derives from sim/replay.json, sweep.json and params.json', { skip: !haveSim && 'no simulation files' }, async () => {
  const { load, moduleText } = await import(join(ROOT, 'scripts/replay-data.mjs'))
  const fresh = load()
  assert.deepEqual(REPLAY, fresh)
  assert.equal(readFileSync(join(WEB, 'js/replay-data.js'), 'utf8'), moduleText(fresh), 'byte for byte: regenerate with node scripts/replay-data.mjs')
})

test('the data is small and has the house community of the simulation', () => {
  assert.ok(readFileSync(join(WEB, 'js/replay-data.js')).length < 12_000)
  assert.equal(REPLAY.rounds, 36)
  const kinds = Object.fromEntries(REPLAY.people.map((p) => [p.name, p.kind]))
  assert.deepEqual(kinds, { Ana: 'honest', Ben: 'honest', Cleo: 'honest', Dina: 'honest', Emil: 'honest', Finn: 'pair', Gus: 'pair', Hugo: 'free_rider', Visitors: 'guests' })
  for (const rows of [REPLAY.work, REPLAY.paid.plain, REPLAY.paid.rules]) {
    assert.equal(rows.length, REPLAY.people.length)
    for (const r of rows) assert.ok(r.length === REPLAY.rounds && r.every((x) => Number.isInteger(x) && x >= 0))
  }
  assert.ok(REPLAY.work[REPLAY.people.findIndex((p) => p.kind === 'free_rider')].every((x) => x === 0), 'a free rider claims work it did not do')
  assert.ok(REPLAY.paid.plain[REPLAY.people.findIndex((p) => p.kind === 'guests')].some((x) => x > 0), 'visitors were paid too')
})

test('a frame: shares add up, excess is share minus work share, guests have no work', () => {
  for (const k of [1, 12, 36, 99]) {
    const f = frame(REPLAY, k)
    assert.equal(f.k, Math.min(k, 36))
    for (const s of SIDES) {
      assert.ok(Math.abs(f.people.reduce((a, r) => a + r[s].share, 0) - 100) < 1e-9)
      assert.equal(f.people.reduce((a, r) => a + r[s].cents, 0), f.total[s])
      for (const r of f.people) {
        if (r.kind === 'guests') assert.equal(r[s].excess, null)
        else assert.ok(Math.abs(r[s].excess - (r[s].share - r.work)) < 1e-9)
      }
    }
    assert.ok(Math.abs(f.people.reduce((a, r) => a + r.work, 0) - 100) < 1e-9)
  }
})

test('the colluding pair earns less with the rules, as the simulation itself says', { skip: !existsSync(SIM) && 'no sim/replay.json' }, () => {
  // computed straight from sim/replay.json, independently of the derived module
  const replay = JSON.parse(readFileSync(SIM, 'utf8'))
  const share = (side, who) => {
    let all = 0n
    let mine = 0n
    for (const row of replay.rounds) {
      for (const [r, amount, , status] of row[side].payouts ?? []) {
        if (status !== 'paid') continue
        all += BigInt(amount)
        if (who(r)) mine += BigInt(amount)
      }
    }
    return Number((mine * 1_000_000n) / all) / 10_000
  }
  const pair = (a) => /^(finn|gus)\./.test(a)
  const f = frame(REPLAY, REPLAY.rounds)
  const g = f.groups
  assert.ok(Math.abs(g.pair.plain - share('none', pair)) < 0.05)
  assert.ok(Math.abs(g.pair.rules - share('launch', pair)) < 0.05)
  assert.ok(g.pair.rules < g.pair.plain, 'the rules take part of the pair’s edge')
  assert.ok(g.pair.plain > g.pair.work, 'plain counting pays the pair more than its work')
  const lines = summary(f)
  assert.deepEqual(lines.map((l) => l.kind), ['pair', 'honest', 'free_rider'])
  assert.match(lines[0].text, /^The colluding pair: \d+\.\d % of all payouts with plain counting, \d+\.\d % with the rules, for \d+\.\d % of the work\.$/)
})

test('the bigger communities: colluders keep less with the rules; the axis holds zero', () => {
  const rows = REPLAY.scenarios.rows
  assert.deepEqual(rows.map((r) => r.label), ['Colluding pair', 'Ring of three', 'Ring of four', 'Four free riders'])
  for (const r of rows.slice(0, 3)) assert.ok(r.rules < r.plain, r.label)
  const d = dumbbell(rows)
  assert.ok(d.min <= 0 && d.max >= 0 && d.min % 5 === 0 && d.max % 5 === 0)
  assert.ok(d.zero >= 0 && d.zero <= 1)
  for (const r of d.rows) assert.ok(r.x0 >= 0 && r.x0 <= 1 && r.x1 >= 0 && r.x1 <= 1)
  assert.equal(d.ticks[0].v, d.min)
  assert.equal(d.ticks.at(-1).v, d.max)
  const max = scaleMax(REPLAY)
  for (const k of [1, 9, 36]) {
    for (const r of frame(REPLAY, k).people) for (const s of SIDES) assert.ok(r[s].cents <= max && (r.kind === 'guests' || r[s].fair <= max), 'every bar and tick stays on its track')
  }
})

test('words and numbers of the replay', () => {
  assert.equal(rulesText(REPLAY.rules), 'at most 25 thanks to one person; mutual thanks count 25\u00a0%; fewer than 3 givers count 25\u00a0%; guests steer at most 20\u00a0% and receive at most 8\u00a0% of a round')
  assert.equal(fmtPts(3.46), '+3.5')
  assert.equal(fmtPts(-0.7), '−0.7')
  assert.equal(fmtPts(0.01), '±0.0')
  assert.equal(fmtCents(123456), '1,234')
})

test('the replay loads only when opened, and builds its view from text nodes only', () => {
  const main = readFileSync(join(WEB, 'js/main.js'), 'utf8')
  assert.ok(!/^import .*replay/m.test(main), 'replay.js is not imported statically')
  assert.match(main, /await import\('\.\/replay\.js'\)/)
  const html = readFileSync(join(WEB, 'index.html'), 'utf8')
  assert.ok(!/replay(-data)?\.js/.test(html))
  const src = readFileSync(join(WEB, 'js/replay.js'), 'utf8')
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML/.test(src), 'names go in as text')
  assert.ok(!/setAttribute\('style'|\sstyle=/.test(src), 'no style attributes (CSP)')
})
