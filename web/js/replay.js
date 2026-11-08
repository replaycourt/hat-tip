// The second replay of DESIGN.md ("The page", item 4): the same community, the same thanks,
// counted twice, round by round: with plain counting and with the rules the contract applies. The
// data is the simulation's own (js/replay-data.js, derived from sim/replay.json); this module and
// its data are loaded only when a visitor opens the replay. Pure parts first (tested in Node),
// then the DOM: SVG and nodes only, every name as text, widths through CSSOM.
import { REPLAY } from './replay-data.js'

export const SIDES = ['plain', 'rules']
const sum = (xs) => xs.reduce((a, b) => a + b, 0)
const fmtPct = (bp) => `${Number(bp) / 100}\u00a0%`

/** Everything one frame shows after round k: per person and side, cents paid so far, the share of
 * all payouts, and how far that share is above or below the person's share of the work. */
export function frame(data, k) {
  k = Math.max(1, Math.min(data.rounds, Math.floor(k)))
  const upTo = (row) => sum(row.slice(0, k))
  const work = data.work.map(upTo)
  const W = sum(work)
  const total = Object.fromEntries(SIDES.map((s) => [s, sum(data.paid[s].map(upTo))]))
  const people = data.people.map((p, i) => {
    const row = { name: p.name, kind: p.kind, work: W ? (work[i] / W) * 100 : 0 }
    for (const s of SIDES) {
      const cents = upTo(data.paid[s][i])
      const share = total[s] ? (cents / total[s]) * 100 : 0
      // what the person's share of the work would have earned of this side's payouts
      const fair = Math.round((row.work / 100) * total[s])
      row[s] = { cents, share, fair, excess: p.kind === 'guests' ? null : share - row.work }
    }
    return row
  })
  const groups = {}
  for (const r of people) {
    const g = (groups[r.kind] = groups[r.kind] ?? { kind: r.kind, n: 0, work: 0, plain: 0, rules: 0 })
    g.n++
    g.work += r.work
    for (const s of SIDES) g[s] += r[s].share
  }
  return { k, total, people, groups }
}

/** The widest bar or tick of the whole replay (totals only grow, so the last round holds it),
 * so bars grow against a fixed scale and no tick runs past its track. */
export function scaleMax(data) {
  const f = frame(data, data.rounds)
  return Math.max(1, ...f.people.flatMap((r) => SIDES.flatMap((s) => [r[s].cents, r.kind === 'guests' ? 0 : r[s].fair])))
}

export const fmtPts = (x) => `${x > 0.05 ? '+' : x < -0.05 ? '−' : '±'}${Math.abs(x).toFixed(1)}`
export const fmtCents = (c) => `${Math.floor(c / 100).toLocaleString('en-US')}`

/** The sentences under the panels, for frame f. */
export function summary(f) {
  const g = f.groups
  const p = (x) => `${x.toFixed(1)}\u00a0%`
  const lines = []
  if (g.pair) lines.push({ kind: 'pair', text: `The colluding pair: ${p(g.pair.plain)} of all payouts with plain counting, ${p(g.pair.rules)} with the rules, for ${p(g.pair.work)} of the work.` })
  if (g.honest) lines.push({ kind: 'honest', text: `The ${g.honest.n} honest helpers: ${p(g.honest.plain)} plain, ${p(g.honest.rules)} with the rules, for ${p(g.honest.work)} of the work.` })
  if (g.free_rider) lines.push({ kind: 'free_rider', text: `The free rider: ${p(g.free_rider.plain)} plain, ${p(g.free_rider.rules)} with the rules, for no work.` })
  return lines
}

/** What the rules side applies, in words, from the rules the replay ran with. */
export function rulesText(r) {
  const parts = [`at most ${r.cap_per_receiver} thanks to one person`]
  if (r.reciprocal_bp < 10000) parts.push(`mutual thanks count ${fmtPct(r.reciprocal_bp)}`)
  if (r.breadth_k > 0 && r.breadth_bp < 10000) parts.push(`fewer than ${r.breadth_k} givers count ${fmtPct(r.breadth_bp)}`)
  if (r.quadratic) parts.push('breadth of support counts quadratically')
  if (r.idle_bp < 10000) parts.push(`members who gave nothing receive ${fmtPct(r.idle_bp)}`)
  parts.push(`guests steer at most ${fmtPct(r.guest_cap_bp)} and receive at most ${fmtPct(r.guest_receive_cap_bp)} of a round`)
  return parts.join('; ')
}

/** The dumbbell rows: x positions (0..1) of plain and rules on a shared axis that holds zero. */
export function dumbbell(rows) {
  const lo = Math.min(0, ...rows.flatMap((r) => [r.plain, r.rules]))
  const hi = Math.max(0, ...rows.flatMap((r) => [r.plain, r.rules]))
  const min = Math.floor(lo / 5) * 5
  const max = Math.ceil(hi / 5) * 5
  const x = (v) => (v - min) / (max - min || 1)
  const ticks = []
  for (let v = min; v <= max; v += 5) ticks.push({ v, x: x(v) })
  return { min, max, zero: x(0), ticks, rows: rows.map((r) => ({ ...r, x0: x(r.plain), x1: x(r.rules) })) }
}

// ---- the DOM ------------------------------------------------------------------------------------

const KIND_LABEL = { pair: 'colluding pair', free_rider: 'free rider', guests: 'guests', honest: '' }
const SVG = 'http://www.w3.org/2000/svg'

function el(tag, cls, text) {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text != null) e.textContent = text
  return e
}

function svg(name, attrs = {}, parent, text) {
  const e = document.createElementNS(SVG, name)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v))
  if (text != null) e.textContent = text
  parent?.appendChild(e)
  return e
}

function panel(side, title, sub, data) {
  const box = el('section', `rp-panel rp-${side}`)
  const head = el('div', 'rp-panel-head')
  head.append(el('span', 'rp-swatch'), el('h3', null, title))
  box.append(head, el('p', 'rp-panel-sub', sub))
  const list = el('ol', 'rp-rows')
  const rows = data.people.map((p) => {
    const li = el('li', `rp-row kind-${p.kind}`)
    const who = el('span', 'rp-who')
    who.append(el('span', 'rp-name', p.name))
    if (KIND_LABEL[p.kind]) who.append(el('span', 'rp-kind', KIND_LABEL[p.kind]))
    const track = el('span', 'rp-track')
    const bar = el('span', 'rp-bar')
    const tick = el('span', 'rp-tick')
    track.append(bar, tick)
    const val = el('span', 'rp-val')
    const ex = el('span', 'rp-ex')
    li.append(who, track, val, ex)
    list.append(li)
    return { li, bar, tick, val, ex, kind: p.kind }
  })
  box.append(list)
  return { box, rows }
}

/** The dumbbell chart, drawn at the width it is shown at (`width` px), so its text keeps its size. */
function dumbbellSvg(rows, width = 640) {
  const d = dumbbell(rows)
  const W = Math.max(320, Math.min(1000, Math.round(width)))
  const left = W < 520 ? 118 : 170
  const right = 24
  const rowH = 38
  const H = 34 + rowH * d.rows.length + 26
  const X = (x) => left + x * (W - left - right)
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'rp-dumbbell', role: 'img', 'aria-label': 'Colluders’ excess share of payouts, plain counting against the rules' })
  for (const t of d.ticks) {
    svg('line', { x1: X(t.x), x2: X(t.x), y1: 22, y2: H - 22, class: t.v === 0 ? 'db-zero' : 'db-grid' }, root)
    svg('text', { x: X(t.x), y: H - 6, class: 'db-tick', 'text-anchor': 'middle' }, root, `${t.v > 0 ? '+' : t.v < 0 ? '−' : ''}${Math.abs(t.v)}`)
  }
  svg('text', { x: X(d.zero) + 6, y: 14, class: 'db-axis' }, root, 'paid for their work')
  d.rows.forEach((r, i) => {
    const y = 40 + i * rowH
    svg('text', { x: 0, y: y + 4, class: 'db-label' }, root, r.label)
    svg('line', { x1: X(r.x0), x2: X(r.x1), y1: y, y2: y, class: 'db-link' }, root)
    svg('circle', { cx: X(r.x0), cy: y, r: 6, class: 'db-plain' }, root)
    svg('circle', { cx: X(r.x1), cy: y, r: 6, class: 'db-rules' }, root)
    const before = r.x0 > r.x1
    svg('text', { x: X(r.x0) + (before ? 10 : -10), y: y + 4, class: 'db-val', 'text-anchor': before ? 'start' : 'end' }, root, fmtPts(r.plain))
    svg('text', { x: X(r.x1) + (before ? -10 : 10), y: y + 4, class: 'db-val db-val-rules', 'text-anchor': before ? 'end' : 'start' }, root, fmtPts(r.rules))
  })
  return root
}

function tableView(data) {
  const details = el('details', 'rp-table')
  details.append(el('summary', null, 'As a table'))
  const table = el('table', 'gifts')
  const head = el('tr')
  for (const h of ['Who', 'Work', 'Plain: tUSD', 'Plain: share', 'Rules: tUSD', 'Rules: share']) head.append(el('th', h === 'Who' ? null : 'num', h))
  const thead = el('thead')
  thead.append(head)
  const tbody = el('tbody')
  table.append(thead, tbody)
  details.append(table)
  const fill = (f) => {
    tbody.replaceChildren(
      ...f.people.map((r) => {
        const tr = el('tr')
        tr.append(
          el('td', null, KIND_LABEL[r.kind] ? `${r.name} (${KIND_LABEL[r.kind]})` : r.name),
          el('td', 'num', r.kind === 'guests' ? '–' : `${r.work.toFixed(1)} %`),
          el('td', 'num', fmtCents(r.plain.cents)),
          el('td', 'num', `${r.plain.share.toFixed(1)} %`),
          el('td', 'num', fmtCents(r.rules.cents)),
          el('td', 'num', `${r.rules.share.toFixed(1)} %`),
        )
        return tr
      }),
    )
  }
  return { details, fill }
}

/** Builds the replay into `host` and plays it (or shows the end state with reduced motion). */
export function mountReplay(host, { reduced = false, data = REPLAY, stepMs = 170 } = {}) {
  const max = scaleMax(data)
  const root = el('div', 'rp')
  root.append(el('p', 'rp-note', `A simulation of the contract’s own arithmetic (sim/hat_tip_sim.py), not the live café. Same people, same notes, same thanks; only the counting differs.`))
  const controls = el('div', 'rp-controls')
  const play = el('button', 'btn-quiet rp-play', 'Play')
  play.type = 'button'
  const range = el('input', 'rp-range')
  Object.assign(range, { type: 'range', min: '1', max: String(data.rounds), step: '1' })
  range.setAttribute('aria-label', 'Round of the replay')
  const label = el('span', 'rp-round')
  controls.append(play, range, label)
  const plain = panel('plain', 'Plain counting', `every thanks counts as given (at most ${data.rules.cap_per_receiver} to one person)`, data)
  const rules = panel('rules', 'With the rules', rulesText(data.rules), data)
  const panels = el('div', 'rp-panels')
  panels.append(plain.box, rules.box)
  const legend = el('p', 'rp-legend', 'Bar: tUSD paid so far. Tick: what the person’s share of the work would have earned. The number on the right: share of payouts above (+) or below (−) the share of work, in percentage points.')
  const sums = el('ul', 'rp-sum')
  const table = tableView(data)
  const sc = data.scenarios
  const bigger = el('div', 'rp-bigger')
  bigger.append(
    el('h3', null, 'Every scenario, in a community of 24'),
    el('p', 'rp-panel-sub', `Medians over ${sc.seeds} seeds. Share of payouts above the share of work, in percentage points: plain counting → with the rules.`),
    dumbbellSvg(sc.rows, host.clientWidth - 40),
  )
  const keyRow = el('p', 'rp-key')
  keyRow.append(el('span', 'rp-key-plain', 'plain counting'), el('span', 'rp-key-rules', 'with the rules'))
  bigger.append(keyRow)
  const caveat = el(
    'p',
    'rp-caveat',
    `What the rules do not do: they aim at collusion, not at free riding. A member who thanks nobody loses nothing to the discount on mutual thanks, so free riders keep a little more (${fmtPts(sc.rows.find((r) => r.label === 'Four free riders')?.plain ?? 0)} → ${fmtPts(sc.rows.find((r) => r.label === 'Four free riders')?.rules ?? 0)} points). Rings keep some of their edge, and an honest pair that really thanks each other a lot pays ${sc.honestPairCost}\u00a0% of its payout for the rules.`,
  )
  const cafe = el('h3', 'rp-cafe-head', `The café’s house community over ${data.rounds} rounds, with visitors`)
  // the result first (every scenario and what the rules do not do), then the café round by round
  root.append(bigger, caveat, cafe, controls, panels, legend, sums, table.details)
  host.replaceChildren(root)

  const draw = (k) => {
    const f = frame(data, k)
    label.textContent = `Round ${f.k} of ${data.rounds}`
    range.value = String(f.k)
    for (const [side, view] of [['plain', plain], ['rules', rules]]) {
      f.people.forEach((r, i) => {
        const v = view.rows[i]
        v.bar.style.width = `${(r[side].cents / max) * 100}%`
        v.tick.hidden = r.kind === 'guests' || f.total[side] === 0
        v.tick.style.left = `${(r[side].fair / max) * 100}%`
        v.val.textContent = fmtCents(r[side].cents)
        v.ex.textContent = r[side].excess == null ? '' : fmtPts(r[side].excess)
        v.ex.className = `rp-ex ${r[side].excess == null ? '' : r[side].excess > 0.05 ? 'over' : r[side].excess < -0.05 ? 'under' : ''}`
        v.li.title = `${r.name}: ${fmtCents(r[side].cents)} tUSD after ${f.k} rounds, ${r[side].share.toFixed(1)} % of all payouts${r.kind === 'guests' ? '' : `; ${r.work.toFixed(1)} % of the work`}`
      })
    }
    sums.replaceChildren(...summary(f).map((s) => el('li', `rp-sum-${s.kind}`, s.text)))
    table.fill(f)
  }

  let k = reduced ? data.rounds : 1
  let timer = null
  const stop = () => {
    clearInterval(timer)
    timer = null
    play.textContent = k >= data.rounds ? 'Play again' : 'Play'
  }
  const start = () => {
    if (k >= data.rounds) k = 1
    play.textContent = 'Pause'
    draw(k)
    timer = setInterval(() => {
      k++
      draw(k)
      if (k >= data.rounds) stop()
    }, stepMs)
  }
  play.addEventListener('click', () => (timer ? stop() : start()))
  range.addEventListener('input', () => {
    stop()
    k = Number(range.value)
    draw(k)
    play.textContent = k >= data.rounds ? 'Play again' : 'Play'
  })
  draw(k)
  if (reduced) stop()
  else start()
  return { draw, stop, frame: () => frame(data, k) }
}
