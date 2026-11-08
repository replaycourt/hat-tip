// DOM helpers and HTML builders: member cards, payout cards, the close story, the ledger, the rules,
// the member record, a DAO proposal and the proof drawer. Everything that comes from the chain goes
// in through textContent or esc(). No style attributes anywhere (the CSP blocks them): widths are set
// through CSSOM from data-w by applyWidths().
import * as L from './logic.js'

export const $ = (id) => document.getElementById(id)

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

export function setText(id, text) {
  const el = typeof id === 'string' ? $(id) : id
  if (el && el.textContent !== text) el.textContent = text
}

/** Sets the width of every [data-w] element under `root` (a percentage) through CSSOM. */
export function applyWidths(root = document) {
  for (const el of root.querySelectorAll('[data-w]')) el.style.width = `${Math.max(0, Math.min(100, Number(el.dataset.w) || 0))}%`
}

let toastTimer = null
export function toast(text, kind = 'info', ms = 4200) {
  const el = $('toast')
  el.textContent = text
  el.className = `toast ${kind}`
  el.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (el.hidden = true), ms)
}

// ---- small pieces -------------------------------------------------------------------------------

export const tusd = (u) => `${L.fmtTusd(u)}\u00a0tUSD`
const capFirst = (t) => t.charAt(0).toUpperCase() + t.slice(1)

export function avatarHtml(account, name, cls = '') {
  const letter = L.isImplicit(account) ? '◦' : (name || '?').charAt(0)
  return `<span class="avatar av-${L.hue(account)} ${cls}" aria-hidden="true">${esc(letter)}</span>`
}

/** The visible label of a house member (a bot with a published strategy), or ''. */
export function houseChip(account, house, { short = false } = {}) {
  const kind = house?.[account]
  if (!kind) return ''
  const full = L.HOUSE_LABELS[kind] ?? 'house bot'
  const text = short ? (L.DEMO_LABELS[kind] ?? full) : full
  return `<span class="chip bot chip-${esc(kind)}" title="${esc(full)}: a labelled demo account run by a script with a published strategy"><span class="bot-ico" aria-hidden="true"></span><span class="chip-text">${esc(text)}</span></span>`
}

/** Strategies shown as a full label on a card: the ones a card is there to demonstrate. */
export const DEMO_KINDS = new Set(['pair', 'free_rider', 'newcomer'])

/** A small marker for a house member where there is no room for the whole label. */
export function botMark(account, house) {
  const kind = house?.[account]
  return kind ? `<span class="bot-mark" title="${esc(L.HOUSE_LABELS[kind] ?? 'house bot')}" aria-label="${esc(L.HOUSE_LABELS[kind] ?? 'house bot')}"><span class="bot-ico" aria-hidden="true"></span></span>` : ''
}

export const pill = (tier) => (tier ? `<span class="pill t${tier}">${esc(L.TIER_SHORT[tier])}</span>` : '')

export function link(explorer, mock, path, text) {
  return mock ? `<code>${esc(text)}</code>` : `<a href="${esc(explorer)}/${esc(path)}" target="_blank" rel="noopener"><code>${esc(text)}</code></a>`
}

// ---- member cards -------------------------------------------------------------------------------

/** Builds a member card once; updateCard fills it. Returns the element with its parts in `.refs`. */
export function makeCard(account, { name, house, caption = '' }) {
  const el = document.createElement('article')
  const kind = house?.[account]
  el.className = `card member${DEMO_KINDS.has(kind) ? ` demo demo-${esc(kind)}` : ''}`
  el.dataset.acc = account
  // the demo roles carry their label in full; every other house member a small bot mark
  const label = DEMO_KINDS.has(kind) ? houseChip(account, house, { short: true }) : botMark(account, house)
  el.innerHTML = `
    <header class="m-head">
      ${avatarHtml(account, name)}
      <div class="m-who"><b class="m-name">${esc(name)}</b>${label}</div>
      <button class="m-record" type="button" data-record="${esc(account)}" title="Open ${esc(name)}’s record: every point and payout"><span class="m-rep"></span> ›</button>
    </header>
    ${caption ? `<p class="m-role">${esc(caption)}</p>` : ''}
    <p class="m-note"></p>
    <p class="m-last" hidden></p>
    <div class="m-recv">
      <div class="m-recv-line"><span class="m-given"></span><span class="m-counted"></span></div>
      <div class="m-bar"><span class="m-bar-fill"></span><span class="m-bar-mine"></span></div>
    </div>
    <div class="m-preview"><span class="m-amount"></span><span class="m-tier"></span></div>
    <p class="m-why"></p>
    <div class="m-give" hidden>
      <button class="chip-btn minus" type="button" data-step="-10" aria-label="Ten thanks less to ${esc(name)}">−</button>
      <input class="m-range" type="range" min="0" max="40" step="1" value="0" aria-label="Thanks to ${esc(name)}">
      <output class="m-mine">0</output>
      <button class="chip-btn plus" type="button" data-step="10" aria-label="Ten thanks more to ${esc(name)}">+10</button>
    </div>`
  el.refs = Object.fromEntries(['m-note', 'm-last', 'm-given', 'm-counted', 'm-bar-fill', 'm-bar-mine', 'm-amount', 'm-tier', 'm-why', 'm-give', 'm-range', 'm-mine', 'm-rep', 'm-preview'].map((c) => [c, el.querySelector('.' + c)]))
  return el
}

export function updateCard(el, d) {
  const r = el.refs
  const quiet = !d.given && !d.giving && !d.note
  setText(r['m-note'], d.note ? `“${d.note}”` : quiet ? 'Nothing yet this round.' : 'No note yet this round.')
  r['m-note'].classList.toggle('empty', !d.note)
  // a card with nothing yet this round shows, dimmed, what its last round brought
  const last = quiet && d.last ? d.last : null
  r['m-last'].hidden = !last
  if (last) {
    const html = `<span class="ml-round">Round ${esc(last.round)}</span>${last.amount ? `<b>${esc(last.amount)}</b>${pill(last.tier)}` : '<span>carried, no payout</span>'}${last.note ? `<span class="ml-note">“${esc(last.note)}”</span>` : ''}`
    if (r['m-last'].dataset.html !== html) {
      r['m-last'].innerHTML = html
      r['m-last'].dataset.html = html
    }
  }
  setText(r['m-given'], d.given ? `${d.given} thanks from ${d.givers}` : 'No thanks yet')
  setText(r['m-counted'], d.given && d.countedText ? ` · counts ${d.countedText}` : '')
  r['m-bar-fill'].style.width = `${d.barPct}%`
  r['m-bar-mine'].style.width = `${d.minePct}%`
  r['m-bar-mine'].style.left = `${d.barPct - d.minePct}%`
  setText(r['m-amount'], d.amountText)
  r['m-tier'].innerHTML = d.tier ? pill(d.tier) : d.carried ? '<span class="pill carry">carried</span>' : ''
  r['m-preview'].classList.toggle('none', !d.tier && !d.carried)
  setText(r['m-why'], d.why ?? '')
  r['m-why'].hidden = !d.why
  r['m-why'].className = `m-why why-${d.whyKind || 'none'}${d.whyMine ? ' why-mine' : ''}`
  r['m-give'].hidden = !d.giving
  el.classList.toggle('giving', Boolean(d.giving))
  el.classList.toggle('mine', d.mine > 0)
  el.classList.toggle('quiet', !d.given && !d.giving)
  el.classList.toggle('empty-round', quiet)
  if (document.activeElement !== r['m-range']) r['m-range'].value = String(d.mine)
  r['m-range'].max = String(d.cap)
  setText(r['m-mine'], String(d.mine))
  setText(r['m-rep'], d.repText)
}

// ---- payouts ------------------------------------------------------------------------------------

const MARK = { yes: '✓', no: '✗', open: '○' }

/** The approvals of a payout as small marks: ✓ who said yes, ✗ who said no, ○ a vote still needed. */
export function marksHtml(marks = []) {
  if (!marks.length) return ''
  return `<span class="p-votes">${marks.map((m) => `<span class="vm ${esc(m.state)}" title="${esc(m.state === 'open' ? `waiting for ${m.who === 'council' ? 'a council vote' : m.who}` : `${m.who}: ${m.state === 'yes' ? 'approve' : 'reject'}`)}"><span class="vm-mark" aria-hidden="true">${MARK[m.state]}</span>${esc(m.state === 'open' && m.who === 'council' ? 'a council vote' : m.who)}</span>`).join('')}</span>`
}

export function payoutHtml(p, { name, stage, marks = [], fresh = false, me, house }) {
  const mine = me && p.receiver === me
  return `<li class="payout ${esc(stage.state)}${fresh ? ' fresh' : ''}${mine ? ' mine' : ''}" data-payout="${esc(p.id)}">
    ${avatarHtml(p.receiver, name)}
    <div class="p-main">
      <div class="p-top"><button class="p-name" type="button" data-record="${esc(p.receiver)}">${esc(mine ? 'You' : name)}${botMark(p.receiver, house)}</button><b class="p-amt">${esc(tusd(p.amount))}</b></div>
      <div class="p-stage"><span class="p-dot" aria-hidden="true"></span><span>${esc(stage.text)}</span>${marksHtml(marks)}</div>
    </div>
    ${p.dao_proposal != null ? `<button class="p-prop" type="button" data-proposal="${esc(p.dao_proposal)}" title="Open DAO proposal #${esc(p.dao_proposal)}">#${esc(p.dao_proposal)}</button>` : ''}
  </li>`
}

/** The close of a round in five steps, revealed one by one (`step` 0..5; 5 shows all). */
export function storyHtml(s, step) {
  const none = s.points === 0n
  const t = s.tally ?? { 1: { n: 0, paid: 0, struck: 0 }, 2: { n: 0, paid: 0, struck: 0 }, 3: { n: 0, paid: 0, struck: 0 } }
  const paid = t[1].paid + t[2].paid + t[3].paid
  const struck = t[1].struck + t[2].struck + t[3].struck
  const open = s.payouts - paid - struck
  const chip = (n, k, text) => `<span class="pill t${k}${t[n] && t[n].n === 0 ? ' zero' : ''}">${esc(text)} <b>${esc(t[n]?.n ?? 0)}</b></span>`
  const approved = !s.payouts
    ? esc('No payouts; reputation decayed as every round.')
    : `<span class="story-chips">${chip(1, 1, 'paid at once')}${chip(2, 2, 'one council vote')}${chip(3, 3, 'council majority')}</span><span class="story-state">${esc(open ? `${paid} of ${s.payouts} paid, ${open} waiting for the council${struck ? `, ${struck} struck` : ''}.` : `All ${s.payouts} decided: ${paid} paid${struck ? `, ${struck} rejected with a strike` : ''}.`)}</span>`
  const steps = [
    ['Round closed', esc(`Round ${s.n}: ${s.givers} ${s.givers === 1 ? 'person' : 'people'} gave ${L.fmtInt(s.thanks)} thanks.`)],
    ['Counted', esc(none ? (s.guestsOnly ? `Nothing counted: guests steer at most ${L.fmtPct(s.guestCapBp ?? 0)} of a round, and no member gave.` : 'Nothing counted after the rules.') : `${L.fmtThanks(s.points)} thanks counted after the rules.`)],
    ['Split', esc(none || s.budget === 0n ? 'Nothing to split: the budget stays in the DAO.' : `${tusd(s.budget)} split by thanks: ${s.payouts} payout${s.payouts === 1 ? '' : 's'}${s.carried ? `, ${s.carried} carried` : ''}.`)],
    ['Filed in the DAO', esc(s.filed ?? (s.payouts ? `${s.payouts} proposals.` : 'No proposals this round.'))],
    ['Approved', approved],
  ]
  return `<ol class="story-list">${steps
    .map(([h, text], i) => `<li class="story-step${i < step ? ' on' : ''}${i === step - 1 ? ' now' : ''}"><span class="story-num" aria-hidden="true">${i + 1}</span><b>${esc(h)}</b><span class="story-text">${text}</span></li>`)
    .join('')}</ol>`
}

/**
 * The guest's own result for the newest closed round they were in (logic.js guestOutcome):
 * who thanked them back, and the payout with its tier and stage, or the share kept for them.
 */
export function outcomeHtml(out, { name, stage, window = { from: 0.5, to: 0.8 } }) {
  const who = out.givers.map((g) => name(g))
  const thanked = who.length
    ? `${L.joinNames(who)} thanked you back: ${L.fmtThanks(out.points)} counted.`
    : 'Nobody thanked you back this time.'
  let result = ''
  if (out.payout) {
    const p = out.payout
    result = `<p class="yr-pay"><b>${esc(tusd(p.amount))}</b>${pill(p.tier)}<span>${esc(stage?.text ?? '')}</span>${p.dao_proposal != null ? `<button class="p-prop" type="button" data-proposal="${esc(p.dao_proposal)}">#${esc(p.dao_proposal)}</button>` : ''}</p>`
  } else if (out.carried > 0n) {
    result = `<p class="yr-pay"><b>${esc(tusd(out.carried))}</b><span class="pill carry">kept for you</span><span>${esc(`below ${tusd(out.minPayout)}, so it waits: paid with a later round once your shares reach it${out.lapseRound ? ` (until round ${out.lapseRound})` : ''}.`)}</span></p>`
  } else if (!who.length) {
    result = `<p class="yr-hint">${esc(`Join early next round: house members thank guests who wrote a note and gave thanks, and they give between ${L.windowWord(window.from)} and ${L.windowWord(window.to)} through the round.`)}</p>`
  }
  return `<p class="yr-title">Round ${esc(out.round)} closed</p><p class="yr-line">${esc(thanked)}</p>${result}`
}

// ---- ledger -------------------------------------------------------------------------------------

export function ledgerHtml(rows, { name, open = new Set() }) {
  if (!rows.length) return '<p class="muted">No closed rounds yet.</p>'
  return `<div class="ledger-legend" aria-hidden="true"><span>Round</span><span>Givers and thanks</span><span>Paid</span><span class="lt-key"><span class="lt t1">auto</span><span class="lt t2">1 vote</span><span class="lt t3">majority</span></span></div><ol class="ledger-list">${rows
    .map((x) => {
      const s = x.summary
      const empty = s.givers === 0
      const tiers = [1, 2, 3].map((t) => `<span class="lt t${t}" title="${esc(L.TIER_NAMES[t])}">${s.byTier[t].n}</span>`).join('')
      const detail = open.has(s.n) && !empty ? ledgerDetailHtml(x, { name }) : ''
      return `<li class="ledger-row${empty ? ' empty' : ''}${open.has(s.n) ? ' open' : ''}">
        <button class="lr-head" type="button" data-round="${esc(s.n)}"${empty ? ' disabled' : ''} aria-expanded="${open.has(s.n)}">
          <span class="lr-n"><span class="lr-chev" aria-hidden="true"></span>Round ${esc(s.n)}</span>
          <span class="lr-givers">${empty ? 'nobody gave · only reputation decayed' : `${s.givers} giver${s.givers === 1 ? '' : 's'} · ${L.fmtInt(s.thanks)} thanks → ${L.fmtThanks(s.points)} counted`}</span>
          <span class="lr-paid">${empty ? '' : esc(tusd(s.paid))}</span>
          <span class="lr-tiers">${empty ? '' : tiers}</span>
        </button>
        ${detail}
      </li>`
    })
    .join('')}</ol>`
}

function ledgerDetailHtml(x, { name }) {
  const byReceiver = new Map()
  for (const [g, r, given, counted] of x.round.gifts) {
    if (!byReceiver.has(r)) byReceiver.set(r, [])
    byReceiver.get(r).push({ g, given: Number(given), counted: L.big(counted) })
  }
  const points = new Map(x.round.points.map(([a, p]) => [a, L.big(p)]))
  const pay = new Map(x.payouts.map((p) => [p.receiver, p]))
  const recv = [...byReceiver.keys()].sort((a, b) => Number((points.get(b) ?? 0n) - (points.get(a) ?? 0n)))
  return `<div class="lr-detail"><table class="gifts">
    <thead><tr><th>Receiver</th><th>From (given → counted)</th><th class="num">Counted</th><th class="num">Payout</th></tr></thead>
    <tbody>${recv
      .map((r) => {
        const p = pay.get(r)
        return `<tr><td class="who"><button class="lnk" type="button" data-record="${esc(r)}">${esc(name(r))}</button></td>
          <td class="from">${byReceiver
            .get(r)
            .map((e) => `<span class="gv" title="${esc(`${name(e.g)} gave ${e.given}, ${L.fmtThanks(e.counted) === String(e.given) ? 'counted in full' : `counted ${L.fmtThanks(e.counted)}`}`)}">${esc(name(e.g))} ${e.given}${L.fmtThanks(e.counted) !== String(e.given) ? ` → ${esc(L.fmtThanks(e.counted))}` : ''}</span>`)
            .join('')}</td>
          <td class="num counted" data-label="counted">${esc(L.fmtThanks(points.get(r) ?? 0n))}</td>
          <td class="num pay">${p ? `${esc(L.fmtTusd(p.amount))} ${pill(p.tier)}` : '<span class="muted">carried</span>'}</td></tr>`
      })
      .join('')}</tbody></table>
    <p class="muted fine">Budget ${esc(tusd(x.round.budget))} · rounding dust left in the DAO ${esc(L.fmtTusd(x.round.dust, { places: 6 }))} tUSD</p></div>`
}

// ---- rules --------------------------------------------------------------------------------------

export function rulesHtml(cfg, report, { roundMs }) {
  const c = cfg
  const on = (bp) => Number(bp) < 10000
  const damp = []
  if (on(c.reciprocal_bp)) damp.push(`thanks between two people who thank each other count ${L.fmtPct(c.reciprocal_bp)} of the smaller side, both ways`)
  if (c.quadratic) damp.push('support counts by breadth: many small givers beat one big one')
  if (Number(c.breadth_k) > 0 && on(c.breadth_bp)) damp.push(`fewer than ${c.breadth_k} givers count ${L.fmtPct(c.breadth_bp)}`)
  if (on(c.idle_bp)) damp.push(`a member who gave nothing that round receives ${L.fmtPct(c.idle_bp)}`)
  const receiveCap = on(c.guest_receive_cap_bp ?? 10000) ? `, and all guests together receive at most ${L.fmtPct(c.guest_receive_cap_bp)} of a round’s thanks` : ''
  const units = (u) => esc(tusd(u))
  const tiers = report?.tiers ?? []
  const t = (n) => tiers.find((x) => x.tier === n) ?? {}
  return `
    <ol class="how-list">
      <li><b>A round lasts ${esc(L.fmtDuration(roundMs))}.</b> Every member, and up to ${esc(c.guest_seats)} guests, hands out ${esc(c.thanks_per_round)} thanks: at most ${esc(c.cap_per_receiver)} to one person, up to ${esc(c.max_receivers)} people, never to oneself. Unspent thanks lapse.</li>
      <li><b>One line of what you did.</b> Each note is at most ${esc(c.note_max_bytes)} bytes and stays with the round, so givers have something to go by.</li>
      <li><b>Counting.</b> ${damp.length ? esc(capFirst(damp.join('; '))) + '.' : 'Thanks count as given.'} Guest thanks count ${esc(L.fmtPct(c.guest_weight_bp))}, and all guests together steer at most ${esc(L.fmtPct(c.guest_cap_bp))} of a round${esc(receiveCap)}. Every counted point belongs to one giver.</li>
      <li><b>Paying.</b> The round’s budget, ${units(c.round_budget)} (less if the DAO holds less beyond what earlier rounds still owe), is split by counted thanks. A share under ${units(c.min_payout)} is carried for up to ${esc(c.carry_rounds)} rounds.</li>
      <li><b>Reputation.</b> Counted thanks add up and fade ${esc(L.fmtPct(c.decay_bp))} a round. A payout the council rejects takes that round’s points back: a strike.</li>
    </ol>
    <h3 class="rules-h">The three tiers, as the DAO states them</h3>
    <div class="table-wrap"><table class="tier-table">
      <thead><tr><th>Tier</th><th>Payout up to</th><th>DAO proposal</th><th>Approved by</th></tr></thead>
      <tbody>
        <tr class="t1"><td>${pill(1)}</td><td data-label="Up to">${units(c.auto_per_thanks)} per thanks of reputation, at most ${units(c.auto_max)}; nothing below ${esc(c.auto_rep_min)} thanks of reputation, never for guests; at most ${esc(L.fmtPct(c.auto_share_bp))} of a round</td><td data-label="DAO proposal"><code>${esc(t(1).kind ?? 'Transfer')}</code></td><td data-label="Approved by">${esc(t(1).approvedBy ?? '')}</td></tr>
        <tr class="t2"><td>${pill(2)}</td><td data-label="Up to">${units(c.cosign_base)} plus ${units(c.cosign_per_thanks)} per thanks of reputation, at most ${units(c.cosign_max)}</td><td data-label="DAO proposal"><code>${esc(t(2).kind ?? 'FunctionCall')}</code></td><td data-label="Approved by">${esc(t(2).approvedBy ?? '')}</td></tr>
        <tr class="t3"><td>${pill(3)}</td><td data-label="Up to">anything larger</td><td data-label="DAO proposal"><code>${esc(t(3).kind ?? 'Transfer')}</code></td><td data-label="Approved by">${esc(t(3).approvedBy ?? '')}</td></tr>
      </tbody></table></div>
    <p class="muted fine">Sputnik has no amount limits. The amounts behind the tiers are the contract’s code; the DAO enforces who may file which kind and how many votes each needs. The contract has no keys, and the council can remove its role with one majority vote. Open <i>Proof</i> to check both.</p>
    <details class="params"><summary>Every parameter</summary><dl class="param-list">${Object.entries(c)
      .map(([k, v]) => `<div><dt><code>${esc(k)}</code></dt><dd>${esc(typeof v === 'object' ? JSON.stringify(v) : v)}</dd></div>`)
      .join('')}</dl></details>`
}

// ---- a member's record --------------------------------------------------------------------------

/** A small reputation line: SVG with attributes only. */
export function sparkHtml(series, { w = 520, h = 120 } = {}) {
  if (series.length < 2) return ''
  const max = series.reduce((m, x) => (x.rep > m ? x.rep : m), 1n)
  const xs = (i) => ((i / (series.length - 1)) * (w - 8) + 4).toFixed(1)
  const ys = (v) => (h - 6 - Number((v * 1000n) / max) / 1000 * (h - 16)).toFixed(1)
  const pts = series.map((x, i) => `${xs(i)},${ys(x.rep)}`).join(' ')
  const area = `M${xs(0)},${h - 6} L${pts.replaceAll(' ', ' L')} L${xs(series.length - 1)},${h - 6} Z`
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" role="img" aria-label="Reputation over rounds ${series[0].round} to ${series[series.length - 1].round}">
    <path class="spark-area" d="${area}"/><polyline class="spark-line" points="${pts}"/>
    <circle class="spark-dot" cx="${xs(series.length - 1)}" cy="${ys(series[series.length - 1].rep)}" r="4"/></svg>
    <span class="spark-max">${esc(L.fmtThanks(max))} at most</span>
    <div class="spark-axis"><span>round ${series[0].round}</span><span>round ${series[series.length - 1].round}</span></div>`
}

/**
 * What a demo member's record shows, in one or two sentences from the record itself: for the
 * colluding pair, how much of its points the partner's thanks made; for the free rider, that
 * everything it got was given by others for its notes.
 */
export function roleNote(m, { kind, partner, name }) {
  if (kind === 'pair' && partner) {
    const sh = L.partnerShare(m.history, partner)
    if (!sh.total) return ''
    const pct = Number((sh.fromPartner * 1000n) / sh.total) / 10
    const strikes = Number(m.strikes)
    return `${name(partner)}’s thanks made ${pct.toFixed(1)}\u00a0% of ${name(m.account)}’s points over the rounds kept: their thanks to each other count at the mutual rate. The rest is thanks from others for ${name(m.account)}’s notes, so the council’s rule (more than half from one partner) lets most payouts through${strikes ? `; ${strikes} were rejected, each a strike` : ''}.`
  }
  if (kind === 'free_rider') {
    const givers = new Set(m.history.flatMap((h) => h.givers.map(([g]) => g)))
    return `Never gives thanks. Every point here is thanks others gave for his vague notes (${givers.size} different givers over the rounds kept), and none is discounted, since only mutual thanks are. The council’s rule lets him through as well: no giver is his partner, and a tier-3 payout needs only three givers.`
  }
  return ''
}

export function memberHtml(m, { name, house, series, explorer, mock, me, proposals, contract, partner = null }) {
  const role = roleNote(m, { kind: house?.[m.account], partner, name })
  const hist = [...m.history].reverse()
  const payouts = [...m.payouts].reverse()
  const kind = m.kind === 'guest' ? 'guest (browser key)' : m.kind === 'member' ? 'member of the DAO' : 'not a member now'
  return `
    <div class="rec-head">${avatarHtml(m.account, name(m.account), 'lg')}<div><b class="rec-name">${esc(name(m.account))}</b>${houseChip(m.account, house)}<div class="muted">${link(explorer, mock, `address/${m.account}`, L.shortAccount(m.account))} · ${esc(kind)}</div></div></div>
    <dl class="rec-facts">
      <div><dt>Reputation</dt><dd>${esc(L.fmtThanks(m.reputation))}</dd></div>
      <div><dt>Auto limit</dt><dd>${esc(tusd(m.limits.auto))}</dd></div>
      <div><dt>Co-sign limit</dt><dd>${esc(tusd(m.limits.cosign))}</dd></div>
      <div><dt>Carry</dt><dd>${esc(tusd(m.carry))}</dd></div>
    </dl>
    <p class="muted fine">Next close: a payout up to the auto limit is paid at once; up to the co-sign limit it needs one council vote; above it, a council majority.${Number(m.strikes) ? ` ${m.strikes} strike${Number(m.strikes) === 1 ? '' : 's'} so far.` : ''}</p>
    ${role ? `<p class="rec-role">${esc(role)}</p>` : ''}
    ${series.length > 1 ? `<h3>Reputation</h3><div class="spark-wrap">${sparkHtml(series)}</div>` : ''}
    <h3>Rounds and who gave the points</h3>
    ${hist.length ? `<ol class="rec-rounds">${hist
      .map(
        (h) => `<li><div class="rr-head"><b>Round ${esc(h.round)}</b><span>+${esc(L.fmtThanks(h.points))}</span></div>
        <div class="rr-from">${h.givers
          .map(([g, given, counted]) => `<span class="gv" title="${esc(`${g} gave ${given}, ${L.fmtThanks(counted) === String(given) ? 'counted in full' : `counted ${L.fmtThanks(counted)}`}`)}">${esc(name(g))} ${esc(given)}${L.fmtThanks(counted) !== String(given) ? ` → ${esc(L.fmtThanks(counted))}` : ''}</span>`)
          .join('')}</div></li>`,
      )
      .join('')}</ol>` : '<p class="muted">No counted thanks in the rounds kept on chain.</p>'}
    <h3>Payouts</h3>
    ${payouts.length ? `<ol class="rec-payouts">${payouts
      .map((p) => {
        const st = L.payoutStage(p, L.proposalInfo(proposals?.get(Number(p.dao_proposal))), { name, contract })
        return `<li class="${esc(st.state)}"><span>Round ${esc(p.round)}</span><b>${esc(tusd(p.amount))}</b>${pill(p.tier)}<span class="rp-stage">${esc(st.text)}</span>${p.dao_proposal != null ? `<button class="p-prop" type="button" data-proposal="${esc(p.dao_proposal)}">#${esc(p.dao_proposal)}</button>` : ''}</li>`
      })
      .join('')}</ol>` : '<p class="muted">No payouts yet.</p>'}`
}

// ---- a DAO proposal -----------------------------------------------------------------------------

export function proposalHtml(p, { name, dao, explorer, mock, payout, house, contract }) {
  const info = L.proposalInfo(p)
  const votes = info.votes.length ? info.votes.map(([a, v]) => `<li><span>${esc(L.voterName(a, { contract, name }))} ${botMark(a, house)}</span><b class="${v === 'Approve' ? 'good' : 'bad'}">${esc(v)}</b></li>`).join('') : '<li class="muted">No votes yet.</li>'
  return `
    <p class="prop-desc"><code>${esc(info.description)}</code></p>
    <dl class="rec-facts">
      <div><dt>Status</dt><dd>${esc(info.status)}</dd></div>
      <div><dt>Kind</dt><dd>${esc(info.kind)}</dd></div>
      <div><dt>Amount</dt><dd>${info.amount != null ? esc(tusd(info.amount)) : '–'}</dd></div>
      <div><dt>To</dt><dd>${info.receiver ? esc(name(info.receiver)) : '–'}</dd></div>
    </dl>
    ${payout ? `<p>Tier ${esc(payout.tier)}: ${esc(L.TIER_NAMES[payout.tier])}. Filed by the contract for round ${esc(payout.round)}.</p>` : ''}
    <h3>Votes</h3><ul class="votes">${votes}</ul>
    <p class="muted fine">Read live from the DAO ${link(explorer, mock, `address/${dao}`, dao)} with <code>get_proposal({"id": ${esc(info.id)}})</code>.</p>
    <details class="raw"><summary>The proposal as the DAO returns it</summary><pre>${esc(JSON.stringify(p, null, 1))}</pre></details>`
}

// ---- proof --------------------------------------------------------------------------------------

const keysLine = (keys, stage = false, what = 'nobody can change the rules') =>
  keys == null
    ? '<span class="muted">checking…</span>'
    : keys.length === 0
      ? `<b class="good">0 access keys</b> <span class="muted">· ${what}</span>`
      : `<b class="bad">${keys.length} access key${keys.length === 1 ? '' : 's'}</b>${stage ? ' <span class="muted">· this is staging, which keeps its keys; the launch deletes them</span>' : ''}`

function hashLine(got, want) {
  if (!got) return '<span class="muted">checking…</span>'
  if (!want) return `<code>${esc(got)}</code> <span class="muted">· no expected hash configured</span>`
  return got === want ? `<code>${esc(got)}</code> <b class="good">· matches WASM_SHA256 in the repository</b>` : `<code>${esc(got)}</code> <b class="bad">· expected ${esc(want)}</b>`
}

const RELAY_METHODS = new Set(['act', 'close_round', 'pay', 'check_payout', 'sync'])

/**
 * The gas account's keys as the proof drawer lists them: each key for this contract, checked to
 * call nothing beyond the relay's five methods; keys the same account holds for another contract
 * (the staging one) in one line, since they cannot call this one; a full-access key, neutral.
 */
export function relayLines(keys, contract) {
  const out = []
  const others = new Map()
  for (const k of keys ?? []) {
    const fc = k.access_key?.permission?.FunctionCall
    if (!fc) out.push({ ok: null, full: true, key: k.public_key })
    else if (fc.receiver_id !== contract) others.set(fc.receiver_id, (others.get(fc.receiver_id) ?? 0) + 1)
    else out.push({ ok: fc.method_names.length > 0 && fc.method_names.every((m) => RELAY_METHODS.has(m)), key: k.public_key, methods: fc.method_names, allowance: fc.allowance ?? null })
  }
  for (const [other, n] of others) out.push({ ok: true, other, n })
  return out
}

/**
 * The proof drawer's verdict over every check it makes: null while any is still being read,
 * else {ok, n, failed}.
 */
export function proofVerdict(x) {
  const lines = relayLines(x.relayKeys, x.contract).filter((r) => !r.full)
  const checks = [
    x.contractKeys == null ? null : x.contractKeys.length === 0 || Boolean(x.stage),
    x.tokenKeys == null ? null : x.tokenKeys.length === 0 || Boolean(x.stage),
    x.contractHash == null ? null : !x.expectedHash || x.contractHash === x.expectedHash,
    x.tokenHash == null ? null : !x.expectedTokenHash || x.tokenHash === x.expectedTokenHash,
    ...(x.report ? x.report.checks.map((c) => c.ok) : [null]),
    ...(x.audit ? [x.audit.balanced, x.audit.points_attributed, x.audit.statuses_ok, x.audit.filed_have_ids] : [null]),
    ...(x.relayKeys == null ? [null] : lines.map((r) => r.ok)),
  ]
  if (checks.some((c) => c == null)) return null
  const failed = checks.filter((c) => !c).length
  return { ok: failed === 0, n: checks.length, failed }
}

export function proofHtml(x) {
  const lk = (path, text) => link(x.explorer, x.mock, path, text)
  const check = (ok, label) => `<li class="${ok == null ? 'wait' : ok ? 'ok' : 'no'}"><span class="mark" aria-hidden="true"></span>${label}</li>`
  const v = proofVerdict(x)
  const verdict = v == null
    ? '<p class="verdict wait"><span class="mark" aria-hidden="true"></span>Reading every check live from NEAR testnet…</p>'
    : v.ok
      ? `<p class="verdict ok"><span class="mark" aria-hidden="true"></span>All ${esc(v.n)} checks pass · read live from NEAR ${x.mock ? '(here: a stand-in)' : 'testnet'} just now</p>`
      : `<p class="verdict no"><span class="mark" aria-hidden="true"></span>${esc(v.failed)} of ${esc(v.n)} checks fail · see below</p>`
  const rl = relayLines(x.relayKeys, x.contract)
  const forThis = rl.filter((r) => !r.other && !r.full)
  const allOk = forThis.length > 0 && forThis.every((r) => r.ok)
  const caps = forThis.map((r) => (r.allowance ? L.big(r.allowance) : null))
  const maxCap = caps.every((c) => c != null) && caps.length ? caps.reduce((a, b) => (a > b ? a : b)) : null
  const summary = x.relayKeys == null
    ? ''
    : check(allOk, `${esc(forThis.length)} relay key${forThis.length === 1 ? '' : 's'}: each may call only <code>${esc([...RELAY_METHODS].join(', '))}</code> on the contract${maxCap != null ? `, allowance at most ${esc(L.fmtThanks(maxCap / 10n ** 21n))} NEAR` : ''}`)
  const relay = x.relayKeys == null
    ? '<li class="wait"><span class="mark"></span>checking…</li>'
    : rl
        .map((r) =>
          r.other
            ? check(true, `${esc(r.n)} more key${r.n === 1 ? '' : 's'} of this account ${r.n === 1 ? 'is' : 'are'} bound to <code>${esc(r.other)}</code>: ${r.n === 1 ? 'it' : 'they'} cannot call this contract`)
            : r.full
              ? check(null, `<code>${esc(r.key.slice(0, 18))}…</code> full access (the pool owner’s key; not on this page)`)
              : check(r.ok, `<code>${esc(r.key.slice(0, 18))}…</code> may call only <code>${esc(r.methods.join(', ') || 'any method')}</code> on the contract, ${r.allowance ? `allowance ${esc(L.fmtThanks(L.big(r.allowance) / 10n ** 21n))} NEAR` : 'no allowance cap'}`),
        )
        .join('')
  const audit = x.audit
  const txs = x.txs.length
    ? x.txs.map((t) => `<li><span class="kind">${esc(t.kind)}</span>${lk(`txns/${t.hash}`, `${t.hash.slice(0, 12)}…`)}${t.failure ? ' <b class="bad">failed</b>' : ''}<span class="gas">${(t.gas / 1e12).toFixed(1)} Tgas</span></li>`).join('')
    : '<li class="muted">No transactions from this tab yet.</li>'
  return `
    ${x.mock ? '<p class="mock-note">Mock mode: a stand-in community in this tab. Nothing below is on chain.</p>' : ''}
    ${verdict}
    <p>Everything on this page is read from NEAR ${x.mock ? '(here: a stand-in)' : 'testnet'}. The rules live in one contract without keys; the money and every approval stay in the community’s Sputnik DAO.</p>
    <h3>The contract</h3>
    <ul class="proof-list">
      <li><span>Account</span><span>${lk(`address/${x.contract}`, x.contract)}</span></li>
      <li><span>Its keys</span><span>${keysLine(x.contractKeys, x.stage)}</span></li>
      <li><span>Code hash</span><span>${hashLine(x.contractHash, x.expectedHash)}</span></li>
      ${x.lockTx && !x.mock ? `<li><span>Locked</span><span>${lk(`txns/${x.lockTx}`, `${x.lockTx.slice(0, 10)}…`)} <span class="muted">· the last key deleted</span></span></li>` : ''}
    </ul>
    <h3>The token (tUSD)</h3>
    <ul class="proof-list">
      <li><span>Account</span><span>${lk(`address/${x.token}`, x.token)}</span></li>
      <li><span>Its keys</span><span>${keysLine(x.tokenKeys, x.stage, 'fixed supply, nobody can mint')}</span></li>
      <li><span>Code hash</span><span>${hashLine(x.tokenHash, x.expectedTokenHash)}</span></li>
    </ul>
    <h3>The DAO’s policy, read live</h3>
    <p class="muted fine">${lk(`address/${x.dao}`, x.dao)} · <code>get_policy</code></p>
    <ul class="checks">${x.report ? x.report.checks.map((c) => check(c.ok, esc(c.label))).join('') : check(null, 'reading the policy…')}</ul>
    <h3>The contract’s own books: <code>audit()</code></h3>
    <ul class="checks">${
      audit
        ? [check(audit.balanced, `Budgets add up: ${esc(tusd(audit.budgets))} = planned ${esc(tusd(audit.planned))} + carry ${esc(tusd(audit.carry))} + lapsed ${esc(tusd(audit.lapsed))} + dust`), check(audit.points_attributed, 'Every counted point is attributed to one giver'), check(audit.statuses_ok, `Every one of ${esc(audit.payouts)} payouts has exactly one status`), check(audit.filed_have_ids, 'Every filed payout has a DAO proposal id')].join('')
        : check(null, 'reading…')
    }</ul>
    <h3>Relay keys</h3>
    <p class="muted fine">Guests sign with their own browser key; these public keys of ${lk(`address/${x.gasAccount}`, x.gasAccount ?? '–')} only carry the transaction.</p>
    <ul class="checks">${summary || relay}</ul>
    ${summary ? `<details class="relay-all"><summary>Every key, one by one</summary><ul class="checks">${relay}</ul></details>` : ''}
    <h3>You</h3>
    <ul class="proof-list">
      <li><span>Your account</span><span>${x.me ? lk(`address/${x.me}`, L.shortAccount(x.me)) : '<span class="muted">no key yet: one is made when you give</span>'}</span></li>
      <li><span>RPC</span><code>${esc(x.rpcHost)}</code></li>
    </ul>
    <h3>Your transactions</h3>
    <ul class="tx-list">${txs}</ul>`
}

// ---- keeping the reader's place -----------------------------------------------------------------

/**
 * Which block anchors the view: the first whose top is on screen, else the first still partly on
 * screen. `rects` are [{top, bottom}] in document order, relative to the viewport.
 */
export function pickAnchor(rects, viewportHeight) {
  const i = rects.findIndex((r) => r.top >= 0 && r.top < viewportHeight)
  if (i >= 0) return i
  return rects.findIndex((r) => r.bottom > 0)
}

/** How far to scroll so the anchor stays where it was; nothing at the very top of the page. */
export const scrollFix = (before, after, scrollY) => (scrollY > 0 && Math.abs(after - before) >= 1 ? after - before : 0)

const ANCHORS = '.round-card, #story, .card.member, .guest, .tier, #payouts .section-head, #replay, #ledger, #rules'

/** Runs `change` and scrolls so that what the reader looks at does not move. */
export function keepView(change) {
  const blocks = [...document.querySelectorAll(ANCHORS)].filter((el) => !el.closest('[hidden]'))
  const i = pickAnchor(blocks.map((el) => el.getBoundingClientRect()), window.innerHeight)
  const anchor = i >= 0 ? blocks[i] : null
  const before = anchor?.getBoundingClientRect().top
  const out = change()
  if (anchor && anchor.isConnected) {
    const d = scrollFix(before, anchor.getBoundingClientRect().top, window.scrollY)
    if (d) window.scrollBy(0, d)
  }
  return out
}

// ---- drawer -------------------------------------------------------------------------------------

/** A drawer opens at its top, unless it is the one already open being drawn again (a refresh). */
export const freshDrawer = (open, prevKey, key) => !open || prevKey !== key

let lastFocus = null
let drawerKind = null
let drawerKey = null
export function openDrawer(kind, title, html, key = kind) {
  const fresh = freshDrawer(drawerOpen(), drawerKey, key)
  if (!drawerOpen()) lastFocus = document.activeElement
  drawerKind = kind
  drawerKey = key
  setText('drawer-title', title)
  const body = $('drawer-body')
  body.innerHTML = html
  applyWidths(body)
  $('drawer').hidden = false
  $('drawer-backdrop').hidden = false
  // only once it is shown: a hidden element keeps the offset it had and ignores a new one
  if (fresh) body.scrollTop = 0
  document.body.classList.add('drawer-on')
  $('drawer-close').focus()
}

export function closeDrawer() {
  drawerKey = null
  $('drawer-body').scrollTop = 0
  $('drawer').hidden = true
  $('drawer-backdrop').hidden = true
  document.body.classList.remove('drawer-on')
  drawerKind = null
  lastFocus?.focus?.()
}

export const drawerOpen = () => !$('drawer').hidden
export const drawerIs = (kind) => drawerOpen() && drawerKind === kind
