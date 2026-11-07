// The page: boot, polling, the round board with the live preview, giving as a guest, the payouts
// in three tiers with the close story, the ledger, the rules, member records, DAO proposals and
// the proof drawer. The same code runs against NEAR testnet (js/chain.js) and in mock mode
// (`?mock=1`, js/mock.js), which is loaded only then.
import * as L from './logic.js'
import * as U from './ui.js'
import { COMMUNITY, DEPLOYMENT, EXPLORER, REPO } from './config.js'
import { ActionQueue, Client, loadIdentity, loadOrCreateIdentity, notDeployed } from './chain.js'
import { ed25519Supported } from './near.js'

const params = new URLSearchParams(location.search)
const MOCK = params.get('mock') === '1'
const KEY_STORE = MOCK ? 'hattip:mock-key:v1' : 'hattip:key:v1'
const reduced = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

const S = {
  cfg: null,
  state: null,
  policy: null,
  report: null,
  balance: 0n,
  open: null, // round(n) of the clock's round
  lastClosed: null,
  last: null, // round(n) whose payouts are shown
  lastPayouts: [],
  proposals: new Map(), // DAO proposal id -> get_proposal
  people: new Map(), // account -> member()
  preview: null,
  draft: new Map(),
  giving: false,
  identity: null,
  me: null,
  myBalance: 0n,
  myRecord: null,
  canSign: false,
  ledger: [],
  ledgerOpen: new Set(),
  ledgerFrom: null,
  audit: null,
  story: null,
  fresh: new Set(), // payout ids that just changed state
  helped: new Set(),
  phase: 'boot',
}
let client
let queue
const cards = new Map()

// ---- boot ---------------------------------------------------------------------------------------

async function boot() {
  wire()
  U.setText('community', COMMUNITY)
  U.$('link-repo').href = REPO
  if (MOCK) {
    const { MockClient } = await import('./mock.js')
    const sec = clamp(Number(params.get('round')) || 180, 30, 3600)
    const at = clamp(Number(params.get('at') ?? 0.6) || 0, 0, 0.95)
    client = new MockClient({ roundMs: sec * 1000, at, seed: Number(params.get('seed')) || 11 })
    U.$('mock-badge').hidden = false
    document.title = 'MOCK · ' + document.title
  } else if (!DEPLOYMENT.contract) {
    return notLive()
  } else {
    client = new Client()
  }
  client.onTx = () => U.drawerIs('proof') && openProof()
  queue = new ActionQueue(client, { onDone, onError, onChange: renderTray })
  S.canSign = await ed25519Supported()
  if (S.canSign) {
    S.identity = await loadIdentity(globalThis.localStorage, KEY_STORE).catch(() => null)
    if (S.identity) {
      S.me = S.identity.account
      client.setIdentity(S.identity).catch(() => null)
    }
  }
  try {
    S.cfg = await client.config()
  } catch (e) {
    return bootFailed(e)
  }
  S.phase = 'live'
  document.body.classList.add('live')
  await Promise.all([loadPolicy(), poll({ first: true })])
  renderRules()
  ledgerWhenSeen()
  setInterval(tick, 250)
  document.addEventListener('visibilitychange', () => !document.hidden && schedule(200))
}

function notLive() {
  S.phase = 'cold'
  document.body.classList.add('cold')
  U.setText('round-state', 'not live yet')
  U.setText('countdown', 'Soon')
  U.setText('until', 'the contract is not deployed on NEAR testnet yet')
  U.setText('give-title', 'See a round play')
  U.setText('give-sub', 'with made-up data, in this tab')
  const b = U.$('btn-give')
  b.disabled = false
  b.onclick = () => (location.search = '?mock=1')
}

function bootFailed(e) {
  console.info('boot', e?.message ?? e)
  if (notDeployed(e)) return notLive()
  S.phase = 'offline'
  document.body.classList.add('offline')
  U.setText('round-state', 'out of reach')
  U.setText('countdown', '–:––')
  U.setText('until', 'NEAR testnet did not answer. Retrying…')
  setTimeout(() => location.reload(), 30_000)
}

function wire() {
  U.$('btn-proof').addEventListener('click', openProof)
  U.$('btn-give').addEventListener('click', () => S.phase === 'live' && onGive())
  U.$('tray-send').addEventListener('click', onSend)
  U.$('tray-cancel').addEventListener('click', () => {
    S.giving = false
    S.draft = new Map()
    recompute()
    render()
  })
  U.$('btn-replay').addEventListener('click', () => S.last && playStory(storyOf(S.last, S.lastPayouts), true))
  U.$('btn-older').addEventListener('click', () => loadLedger(true))
  U.$('btn-replay-open').addEventListener('click', openReplay)
  U.$('drawer-close').addEventListener('click', U.closeDrawer)
  U.$('drawer-backdrop').addEventListener('click', U.closeDrawer)
  document.addEventListener('keydown', (e) => e.key === 'Escape' && U.drawerOpen() && U.closeDrawer())
  // one listener for every button made from data: records, proposals, ledger rows, +10 and −
  document.addEventListener('click', (e) => {
    const t = e.target.closest?.('[data-record],[data-proposal],[data-round],[data-step]')
    if (!t || t.disabled) return
    if (t.dataset.step) return onStep(t.closest('[data-acc]').dataset.acc, Number(t.dataset.step))
    if (t.dataset.record) return openMember(t.dataset.record)
    if (t.dataset.proposal) return openProposal(Number(t.dataset.proposal))
    if (t.dataset.round) return toggleLedger(Number(t.dataset.round))
  })
  U.$('cards').addEventListener('input', (e) => {
    if (!e.target.classList.contains('m-range')) return
    const acc = e.target.closest('[data-acc]').dataset.acc
    const { draft, refused } = L.setGift(S.cfg, S.draft, acc, Number(e.target.value))
    S.draft = draft
    if (refused) hint(`At most: ${refused}.`)
    if ((S.draft.get(acc) ?? 0) !== Number(e.target.value)) e.target.value = String(S.draft.get(acc) ?? 0)
    recompute()
    renderBoard()
    renderTray()
  })
}

// ---- reading the chain --------------------------------------------------------------------------

let pollTimer = null
function schedule(ms) {
  clearTimeout(pollTimer)
  pollTimer = setTimeout(() => poll().catch((e) => console.info('poll', e?.message ?? e)), ms)
}

const pollEvery = () => (document.hidden ? 20_000 : MOCK ? 1200 : 5000)

async function loadPolicy() {
  try {
    S.policy = await client.policy()
    S.report = L.policyReport(S.policy, { contract: client.contract, councilRole: S.cfg.council_role, thanksRole: S.cfg.thanks_role, membersRole: S.cfg.members_role })
  } catch (e) {
    console.info('policy', e?.message ?? e)
  }
}

async function poll({ first = false } = {}) {
  try {
    const st = await client.state()
    S.state = st
    const [open, bal] = await Promise.all([client.round(st.round), client.daoBalance()])
    S.open = open
    S.balance = L.big(bal)
    const lastClosed = st.oldest_unclosed - 1
    const closedNow = S.lastClosed !== null && lastClosed > S.lastClosed
    if (lastClosed !== S.lastClosed) {
      S.lastClosed = lastClosed
      await Promise.all([loadLast(lastClosed), loadPeople()])
      if (closedNow) {
        const closed = await client.round(lastClosed).catch(() => null)
        if (closed?.gifts?.length) playStory(storyOf(closed, closed.n === S.last?.n ? S.lastPayouts : []))
        if (S.ledgerWanted) loadLedger()
        loadPolicy()
      }
    } else {
      await Promise.all([refreshPayouts(), first ? null : loadPeople({ only: newAccounts() })])
    }
    // the visitor's own record and tUSD: every third poll, or right after something happened
    S.polls = (S.polls ?? 0) + 1
    if (S.me && (first || closedNow || S.meDirty || S.polls % 3 === 0)) {
      S.meDirty = false
      const [bal2, rec] = await Promise.all([client.balanceOf(S.me).catch(() => '0'), client.member(S.me).catch(() => null)])
      S.myBalance = L.big(bal2)
      S.myRecord = rec
      if (rec) S.people.set(S.me, rec)
    }
    recompute()
    render()
    help(st)
  } finally {
    schedule(pollEvery())
  }
}

/** The last closed round with payouts (an empty round shows the one before it). */
async function loadLast(lastClosed) {
  // The newest payout names the newest round that paid anything; the rounds after it may be
  // empty (nobody gave) or have paid nothing.
  let n = lastClosed
  const next = Number(S.state?.next_payout ?? 0)
  if (next > 0) {
    const [p] = await client.payouts(next - 1, 1)
    if (p) n = Math.min(lastClosed, Number(p.round))
  }
  S.last = n >= 1 ? await client.round(n) : null
  S.lastPayouts = await payoutsOf(S.last)
  await loadProposals(S.lastPayouts)
}

async function payoutsOf(rv) {
  const ids = rv?.payouts ?? []
  if (!ids.length) return []
  const from = Math.min(...ids)
  const list = await client.payouts(from, Math.max(...ids) - from + 1)
  return list.filter((p) => p.round === rv.n)
}

/** The DAO proposals of these payouts that may still change, in one get_proposals read. */
async function loadProposals(payouts) {
  const ids = payouts
    .map((p) => p.dao_proposal)
    .filter((id) => id != null)
    .map(Number)
    .filter((id) => (S.proposals.get(id)?.status ?? 'InProgress') === 'InProgress')
  if (!ids.length) return
  const from = Math.min(...ids)
  const limit = Math.min(100, Math.max(...ids) - from + 1)
  try {
    for (const x of await client.proposals(from, limit)) S.proposals.set(Number(x.id), x)
  } catch (e) {
    console.info('proposals', e?.message ?? e)
  }
}

/** Payouts that are not final yet: their status and their DAO proposal. */
async function refreshPayouts() {
  if (!S.last || S.lastPayouts.every((p) => L.isFinal(p.status))) return
  const before = new Map(S.lastPayouts.map((p) => [p.id, `${p.status}|${p.dao_proposal}`]))
  S.lastPayouts = await payoutsOf(S.last)
  for (const p of S.lastPayouts) if (before.get(p.id) !== `${p.status}|${p.dao_proposal}`) S.fresh.add(p.id)
  await loadProposals(S.lastPayouts)
  setTimeout(() => S.fresh.clear(), 2500)
}

const newAccounts = () => [...(S.state?.members ?? []), ...(S.open?.seats ?? [])].filter((a) => !S.people.has(a))

async function loadPeople({ only } = {}) {
  const accounts = only ?? [...new Set([...(S.state?.members ?? []), ...(S.open?.seats ?? []), ...S.lastPayouts.map((p) => p.receiver)])]
  const views = await Promise.all(accounts.map((a) => client.member(a).catch(() => null)))
  accounts.forEach((a, i) => views[i] && S.people.set(a, views[i]))
}

// ---- the preview --------------------------------------------------------------------------------

/** My standing allocation in the open round (what the contract holds). */
const myGifts = () => (S.open?.gifts ?? []).filter((g) => g[0] === S.me).map(([, r, t]) => [r, Number(t)])

function recompute() {
  if (!S.open || !S.state) return
  const alloc = L.giftsByGiver(S.open.gifts)
  const seats = new Set(S.open.seats)
  if (S.me && S.giving) {
    if (S.draft.size) alloc.set(S.me, L.draftGifts(S.draft))
    else alloc.delete(S.me)
    seats.add(S.me)
  }
  const limits = new Map()
  const carry = new Map()
  for (const [a, m] of S.people) {
    limits.set(a, { auto: L.big(m.limits.auto), cosign: L.big(m.limits.cosign) })
    if (L.big(m.carry) > 0n) carry.set(a, [L.big(m.carry), m.carry_since])
  }
  S.preview = L.previewRound(S.cfg, { round: S.open.n, members: S.state.members, seats, allocations: alloc, limits, carry, daoBalance: S.balance })
}

// ---- rendering ----------------------------------------------------------------------------------

const name = (a) => L.displayName(a, S.me)

function render() {
  renderHero()
  renderBoard()
  renderPayouts()
  renderYou()
  renderTray()
  if (U.drawerIs('proof')) openProof()
}

function renderHero() {
  const st = S.state
  if (!st) return
  U.setText('round-n', String(st.round))
  const budget = L.budgetOf(S.cfg, S.balance)
  U.setText('budget', U.tusd(budget))
  U.setText('dao-balance', U.tusd(S.balance))
  const given = (S.open?.gifts ?? []).reduce((a, g) => a + Number(g[2]), 0)
  const givers = new Set((S.open?.gifts ?? []).map((g) => g[0])).size
  U.setText('given-so-far', `${L.fmtInt(given)} from ${givers}`)
  U.setText('seats', `${S.open?.seats?.length ?? 0} of ${S.cfg.guest_seats} taken`)
  const btn = U.$('btn-give')
  const mine = myGifts()
  btn.disabled = !S.canSign
  U.setText('give-title', S.giving ? 'Giving…' : mine.length ? 'Change your thanks' : 'Give your 100 thanks')
  U.setText('give-sub', !S.canSign ? 'this browser cannot make a key (Ed25519)' : mine.length ? `you gave ${mine.reduce((a, g) => a + g[1], 0)} this round` : 'no wallet · your browser makes a key and takes a guest seat')
  btn.classList.toggle('done', mine.length > 0)
  tick()
}

function tick() {
  const st = S.state
  if (!st || !S.cfg) return
  const now = Date.now()
  const end = Number(st.round_ends_ms)
  const left = end - now
  const roundMs = Number(S.cfg.round_ms)
  U.setText('countdown', left > 0 ? L.fmtCountdown(left) : '0:00')
  U.setText('until', left > 0 ? `until round ${st.round} closes` : 'closing: the DAO is being asked…')
  U.setText('round-state', left > 0 ? `a round lasts ${L.fmtDuration(roundMs)}` : 'closing')
  const pct = clamp(100 - (left / roundMs) * 100, 0, 100)
  U.$('progress-fill').style.width = `${pct}%`
  U.$('progress').setAttribute('aria-valuenow', String(Math.round(pct)))
  document.body.classList.toggle('closing', left <= 0)
  if (left <= 0 && now - (S.lastCloseKick ?? 0) > 1500) {
    S.lastCloseKick = now
    schedule(400)
  }
}

function renderBoard() {
  const st = S.state
  const pv = S.preview
  if (!st || !pv) return
  const host = U.$('cards')
  const members = [...L.namedMembers(st.members)].sort((a, b) => L.cmp(name(a), name(b)))
  for (const [a, el] of cards) if (!members.includes(a)) (el.remove(), cards.delete(a))
  const notes = new Map(S.open?.notes ?? [])
  const rows = pv.count.rows
  const givenTo = new Map()
  const giversTo = new Map()
  for (const r of rows) {
    givenTo.set(r.receiver, (givenTo.get(r.receiver) ?? 0) + r.thanks)
    giversTo.set(r.receiver, (giversTo.get(r.receiver) ?? 0) + 1)
  }
  const max = Math.max(40, ...givenTo.values())
  const mineMap = S.giving ? S.draft : new Map(myGifts())
  const cap = Number(S.cfg.cap_per_receiver)
  members.forEach((a, i) => {
    let el = cards.get(a)
    if (!el) {
      el = U.makeCard(a, { name: name(a), house: client.house })
      cards.set(a, el)
    }
    if (host.children[i] !== el) host.insertBefore(el, host.children[i] ?? null)
    const x = pv.byAccount.get(a)
    const ex = L.explainReceiver(S.cfg, pv.count, a)
    const reason = pickReason(ex.reasons)
    const m = S.people.get(a)
    const mine = mineMap.get(a) ?? 0
    const given = givenTo.get(a) ?? 0
    U.updateCard(el, {
      note: notes.get(a),
      given,
      givers: giversTo.get(a) ?? 0,
      countedText: x && L.fmtThanks(x.points) !== String(given) ? L.fmtThanks(x.points) : '',
      barPct: (given / max) * 100,
      minePct: (Math.min(mine, given) / max) * 100,
      amountText: x?.tier ? `≈ ${U.tusd(x.amount)}` : x?.carried ? `${U.tusd(x.carried)} kept for later` : given ? 'nothing yet' : '',
      tier: x?.tier ?? 0,
      carried: x?.carried ?? 0n,
      why: reason ? L.reasonText(reason, name, { open: true }) : '',
      whyKind: reason?.kind ?? '',
      giving: S.giving,
      mine,
      cap,
      repText: m ? `rep ${L.fmtThanks(L.big(m.reputation) - (L.big(m.reputation) % 1000n))}` : 'record',
    })
  })
  renderGuests(notes, givenTo)
}

/**
 * The reason worth a line on a card: a strong mutual pair first (small mutual thanks between
 * helpers are discounted too, but are not worth a line), then idle, breadth, guests.
 */
function pickReason(reasons) {
  const strong = reasons.filter((x) => x.kind === 'mutual' && Math.min(x.given, x.back) * 4 >= Number(S.cfg.cap_per_receiver) * 3).sort((a, b) => Math.min(b.given, b.back) - Math.min(a.given, a.back))
  if (strong.length) return strong[0]
  const mine = reasons.find((x) => x.kind === 'guest' && S.me && x.who?.includes(S.me))
  if (mine) return mine
  for (const k of ['receiveCap', 'idle', 'breadth', 'guest']) {
    const r = reasons.find((x) => x.kind === k)
    if (r) return r
  }
  return null
}

function renderGuests(notes, givenTo) {
  const seats = [...(S.open?.seats ?? [])]
  if (S.me && S.giving && !seats.includes(S.me)) seats.push(S.me)
  U.$('guests').hidden = seats.length === 0
  U.$('guest-list').innerHTML = seats
    .map((g) => {
      const x = S.preview.byAccount.get(g)
      const gave = (S.open?.gifts ?? []).filter((e) => e[0] === g).reduce((a, e) => a + Number(e[2]), 0)
      const pay = x?.tier ? `≈ ${U.esc(U.tusd(x.amount))} ${U.pill(x.tier)}` : x?.carried ? `<span class="muted">${U.esc(U.tusd(x.carried))} kept for later</span>` : ''
      const reasons = L.explainReceiver(S.cfg, S.preview.count, g).reasons
      const mutual = reasons.find((r) => r.kind === 'mutual')
      const why = mutual
        ? `Thanks between ${g === S.me ? 'you and the people you thanked' : 'this guest and the people they thanked'} count ${L.fmtPct(mutual.bp)} both ways.`
        : reasons.find((r) => r.kind === 'receiveCap')
          ? L.reasonText(reasons.find((r) => r.kind === 'receiveCap'))
          : ''
      return `<div class="guest${g === S.me ? ' me' : ''}">${U.avatarHtml(g, name(g))}<div class="g-body">
        <div class="g-top"><b>${U.esc(name(g))}</b>${pay ? `<span class="g-pay">${pay}</span>` : ''}</div>
        <span class="muted">gave ${gave} thanks${givenTo.get(g) ? ` · got ${givenTo.get(g)} from members` : ''}</span>
        <p class="g-note">${notes.get(g) ? `“${U.esc(notes.get(g))}”` : '<span class="muted">no note</span>'}</p>
        ${why ? `<p class="g-why">${U.esc(why)}</p>` : ''}</div></div>`
    })
    .join('')
}

const shown = new Map() // tier -> the HTML of its list now on the page

function renderPayouts() {
  if (!S.last) return
  U.setText('pay-round', String(S.last.n))
  const tier3 = S.report?.tiers.find((t) => t.tier === 3)?.votes ?? 2
  U.setText('tier-3-rule', `Larger, or a first payout: ${tier3} council votes decide.`)
  for (const t of [1, 2, 3]) {
    const list = S.lastPayouts.filter((p) => Number(p.tier) === t).sort((a, b) => Number(L.big(b.amount) - L.big(a.amount)))
    const story = S.story && S.story.n === S.last.n && S.story.step < 4
    const html = list.length
      ? list
          .map((p) => {
            const info = L.proposalInfo(S.proposals.get(Number(p.dao_proposal)))
            const stage = story ? { state: 'waiting', text: 'Filing in the DAO…' } : L.payoutStage(p, info, { tier3Votes: tier3, name })
            return U.payoutHtml(p, { name: name(p.receiver), stage, fresh: S.fresh.has(p.id), me: S.me, house: client.house })
          })
          .join('')
      : `<li class="tier-empty">${t === 1 ? 'None this round.' : 'Nobody this round.'}</li>`
    // only when something changed: a new list replays the cards' entrance
    if (shown.get(t) !== html) {
      U.$(`tier-${t}`).innerHTML = html
      shown.set(t, html)
    }
  }
  const paid = new Set(S.lastPayouts.map((p) => p.receiver))
  const carried = (S.last.points ?? []).filter(([a]) => !paid.has(a))
  U.setText('carried', carried.length ? `Kept for a later round (below ${U.tusd(S.cfg.min_payout)}): ${carried.map(([a]) => name(a)).join(', ')}.` : '')
  U.$('btn-replay').hidden = !S.lastPayouts.length
}

function renderYou() {
  const box = U.$('you')
  const seated = S.me && (S.open?.seats ?? []).includes(S.me)
  const rec = S.myRecord
  const has = S.me && (seated || S.myBalance > 0n || (rec && (rec.payouts?.length || L.big(rec.reputation) > 0n)))
  box.hidden = !has
  if (!has) return
  U.setText('you-name', 'You, a guest')
  U.setText('you-acct', ` · ${L.shortAccount(S.me)}`)
  const lines = []
  const mine = myGifts()
  if (seated) lines.push(`Seat ${S.open.seats.indexOf(S.me) + 1} of ${S.cfg.guest_seats} in round ${S.open.n}${mine.length ? ` · you gave ${mine.reduce((a, g) => a + g[1], 0)} thanks to ${mine.length}` : ''}.`)
  const x = S.preview?.byAccount.get(S.me)
  const note = (S.open?.notes ?? []).find(([a]) => a === S.me)
  if (x?.tier) lines.push(`If the round closed now: ≈ ${U.tusd(x.amount)} to you; it ${x.tier === 2 ? 'needs one council vote' : x.tier === 3 ? 'needs a council majority' : 'is paid at once'}.`)
  else if (x?.carried) lines.push(`If the round closed now: ${U.tusd(x.carried)} to you, below the ${U.tusd(S.cfg.min_payout)} minimum, so it waits for a later round.`)
  else if (seated && !note) lines.push('House members thank guests who write a note and give thanks.')
  else if (seated && x?.given) lines.push(`Members gave you ${x.given} thanks so far.`)
  else if (seated && mine.length) lines.push('House members thank guests who write a note and give thanks; give them a moment.')
  for (const p of [...(rec?.payouts ?? [])].reverse().slice(0, 3)) {
    const st = L.payoutStage(p, L.proposalInfo(S.proposals.get(Number(p.dao_proposal))), { name })
    lines.push(`Round ${p.round}: ${U.tusd(p.amount)} · ${st.text}.`)
  }
  if (S.myBalance > 0n) lines.push(`Your browser account holds ${U.tusd(S.myBalance)}.`)
  U.$('you-lines').innerHTML = lines.map((l) => `<li>${U.esc(l)}</li>`).join('')
}

function renderTray() {
  const tray = U.$('tray')
  tray.hidden = !S.giving
  document.body.classList.toggle('giving', S.giving)
  if (!S.giving || !S.cfg) return
  const per = Number(S.cfg.thanks_per_round)
  const used = L.draftTotal(S.draft)
  U.setText('tray-left', String(per - used))
  U.setText('tray-left-word', per - used === 1 ? 'thanks left' : 'thanks left')
  U.$('tray-fill').style.width = `${(used / per) * 100}%`
  const busy = queue?.busy
  U.$('tray-send').disabled = busy || used === 0
  U.setText('tray-send', busy ? 'Sending…' : 'Send my thanks')
}

let hintTimer = null
function hint(text) {
  const el = U.$('tray-hint')
  el.textContent = text
  el.classList.add('warn')
  clearTimeout(hintTimer)
  hintTimer = setTimeout(() => {
    el.innerHTML = 'Tap <b>+10</b> on the people whose work you value.'
    el.classList.remove('warn')
  }, 2600)
}

// ---- giving -------------------------------------------------------------------------------------

async function onGive() {
  if (!S.canSign) return U.toast('This browser cannot make an Ed25519 key, so it cannot take part.', 'warn')
  if (!client.canAct) U.toast('Giving opens once the gas pool is set up. You can still try the sliders.', 'warn')
  if (!S.identity) {
    S.identity = await loadOrCreateIdentity(globalThis.localStorage, KEY_STORE)
    S.me = S.identity.account
    await client.setIdentity(S.identity).catch(() => null)
  }
  S.giving = true
  S.draft = new Map(myGifts())
  const note = (S.open?.notes ?? []).find(([a]) => a === S.me)
  U.$('tray-note').value = note ? note[1] : ''
  recompute()
  render()
  U.$('cards').scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' })
}

function onStep(acc, delta) {
  if (!S.giving) return
  const { draft, refused } = L.bumpGift(S.cfg, S.draft, acc, delta)
  if (refused) hint(`At most: ${refused}.`)
  S.draft = draft
  recompute()
  renderBoard()
  renderTray()
}

function onSend() {
  const round = S.state.round
  const gifts = L.draftGifts(S.draft)
  const err = L.checkGifts(S.cfg, S.me, gifts, { members: S.state.members, seats: [...S.open.seats, S.me], guest: true })
  if (err) return U.toast(`Not sent: ${err}.`, 'warn')
  if (!gifts.length) return
  const note = L.clipNote(U.$('tray-note').value, Number(S.cfg.note_max_bytes))
  const had = (S.open?.notes ?? []).find(([a]) => a === S.me)?.[1]
  if (note && note !== had) queue.push({ kind: 'note', build: () => L.joinAction(round, note) })
  queue.push({ kind: 'allocate', gifts, round, build: () => L.allocateAction(round, gifts) })
  renderTray()
}

function onDone(out, item) {
  if (!out?.ok) {
    U.toast(`The contract said no: ${out?.error ?? 'refused'}.`, 'warn', 6000)
    return
  }
  S.meDirty = true
  if (item.kind === 'allocate') {
    S.giving = false
    S.draft = new Map()
    U.toast(`Your thanks are in. They count when round ${item.round} closes.`, 'ok')
  }
  schedule(150)
}

function onError(err, item) {
  console.info('act', item?.kind, err?.cause?.message ?? err?.message)
  U.toast(err?.message ?? 'Something went wrong. Nothing was lost.', 'warn', 6000)
  renderTray()
}

// ---- the close story ----------------------------------------------------------------------------

function storyOf(rv, payouts) {
  const sm = L.roundSummary(rv, payouts)
  const props = payouts.map((p) => p.dao_proposal).filter((x) => x != null)
  const paid = new Set(payouts.map((p) => p.receiver))
  const guestsOnly = (rv.gifts ?? []).every((g) => L.isImplicit(g[0]))
  return { ...sm, carried: (rv.points ?? []).filter(([a]) => !paid.has(a)).length, firstProposal: props.length ? Math.min(...props) : null, lastProposal: props.length ? Math.max(...props) : null, guestsOnly, guestCapBp: S.cfg.guest_cap_bp }
}

let storyTimer = null
function playStory(summary, scroll = false) {
  if (!summary?.n) return
  clearInterval(storyTimer)
  clearTimeout(storyTimer)
  S.story = { n: summary.n, step: reduced ? 5 : 0, summary }
  const el = U.$('story')
  el.hidden = false
  const draw = () => {
    // the proposals are filed a moment after the close: read the summary again at every step
    if (S.last?.n === S.story.n) S.story.summary = storyOf(S.last, S.lastPayouts)
    el.innerHTML = U.storyHtml(S.story.summary, S.story.step)
    renderPayouts()
  }
  draw()
  if (scroll) U.$('payouts').scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' })
  storyTimer = setInterval(() => {
    S.story.step++
    draw()
    if (S.story.step >= 5) {
      clearInterval(storyTimer)
      // the summary stays a while, then the payouts below tell the rest; Replay brings it back
      storyTimer = setTimeout(() => (el.hidden = true), 40_000)
    }
  }, 900)
}

// ---- helping the round along (live only) --------------------------------------------------------

/** If a round is due and nobody closed it (the house script normally does), close it from here. */
function help(st) {
  if (MOCK || !client.canAct || document.hidden) return
  const late = Date.now() - L.roundEndMs(st.oldest_unclosed, Number(S.cfg.genesis_ms), Number(S.cfg.round_ms))
  const key = `close:${st.oldest_unclosed}`
  if (st.due > 0 && st.closing == null && late > 25_000 && !S.helped.has(key)) {
    S.helped.add(key)
    client.closeRound().catch((e) => console.info('close', e?.message))
  } else if (st.planned > 0 && st.due === 0 && !S.helped.has(`pay:${st.next_payout}`)) {
    S.helped.add(`pay:${st.next_payout}`)
    setTimeout(() => client.pay().catch((e) => console.info('pay', e?.message)), 20_000 + Math.random() * 5000)
  }
}

// ---- the second replay: the same thanks, counted twice ------------------------------------------

/** Loads the replay and its data only now (they are not part of the first page load). */
async function openReplay() {
  const btn = U.$('btn-replay-open')
  btn.disabled = true
  try {
    const { mountReplay } = await import('./replay.js')
    mountReplay(U.$('replay-host'), { reduced })
  } catch (e) {
    console.info('replay', e?.message ?? e)
    btn.disabled = false
    U.toast('The simulation could not be loaded. Try again.', 'warn')
  }
}

// ---- ledger -------------------------------------------------------------------------------------

const LEDGER_PAGE = 8

/** The ledger costs ten reads: load it when it comes near the screen, not in the first burst. */
function ledgerWhenSeen() {
  const el = U.$('ledger')
  if (!globalThis.IntersectionObserver) return loadLedger()
  const io = new IntersectionObserver(
    (entries) => {
      if (!entries.some((e) => e.isIntersecting)) return
      io.disconnect()
      S.ledgerWanted = true
      loadLedger()
    },
    { rootMargin: '600px 0px' },
  )
  io.observe(el)
}

async function loadLedger(older = false) {
  if (S.lastClosed == null || S.lastClosed < 1) {
    U.$('ledger-host').innerHTML = '<p class="muted">No closed rounds yet.</p>'
    return
  }
  const top = older ? (S.ledgerFrom ?? S.lastClosed + 1) - 1 : S.lastClosed
  const ns = []
  for (let n = top; n >= 1 && ns.length < LEDGER_PAGE; n--) ns.push(n)
  const rounds = (await Promise.all(ns.map((n) => client.round(n).catch(() => null)))).filter(Boolean)
  const ids = rounds.flatMap((r) => r.payouts)
  let pays = []
  if (ids.length) {
    const from = Math.min(...ids)
    const to = Math.max(...ids)
    for (let f = from; f <= to; f += 100) pays.push(...(await client.payouts(f, Math.min(100, to - f + 1))))
  }
  const rows = rounds.map((r) => ({ round: r, payouts: pays.filter((p) => p.round === r.n), summary: L.roundSummary(r, pays.filter((p) => p.round === r.n)) }))
  S.ledger = older ? [...S.ledger, ...rows] : rows
  S.ledgerFrom = Math.min(...S.ledger.map((x) => x.round.n))
  renderLedger()
  U.$('btn-older').hidden = S.ledgerFrom <= 1
  client
    .audit()
    .then((a) => {
      S.audit = a
      U.setText('audit-line', a.balanced && a.points_attributed ? `audit(): every budget adds up and every point has its giver, over ${a.payouts} payouts.` : 'audit(): not balanced — see Proof.')
    })
    .catch(() => null)
}

function renderLedger() {
  U.$('ledger-host').innerHTML = U.ledgerHtml(S.ledger, { name, open: S.ledgerOpen })
}

function toggleLedger(n) {
  if (S.ledgerOpen.has(n)) S.ledgerOpen.delete(n)
  else S.ledgerOpen.add(n)
  renderLedger()
}

// ---- rules --------------------------------------------------------------------------------------

function renderRules() {
  U.$('rules-body').innerHTML = U.rulesHtml(S.cfg, S.report, { roundMs: Number(S.cfg.round_ms) })
}

// ---- drawers ------------------------------------------------------------------------------------

async function openMember(account) {
  U.openDrawer('member', 'Record', '<p class="muted">Reading the record…</p>')
  let m
  try {
    m = await client.member(account)
  } catch {
    return U.openDrawer('member', 'Record', '<p class="muted">Could not read this record. Try again.</p>')
  }
  // the votes behind the last few payouts, in one read
  const recent = m.payouts.slice(-6).filter((p) => p.dao_proposal != null && !S.proposals.has(Number(p.dao_proposal)))
  if (recent.length) {
    const ids = recent.map((p) => Number(p.dao_proposal))
    const from = Math.min(...ids)
    const want = new Set(ids)
    try {
      for (const x of await client.proposals(from, Math.min(100, Math.max(...ids) - from + 1))) if (want.has(Number(x.id))) S.proposals.set(Number(x.id), x)
    } catch (e) {
      console.info('proposals', e?.message ?? e)
    }
  }
  // a strike takes the round's points back, decayed to when the council's answer was read (about a round later)
  const strikes = m.payouts.filter((p) => p.status === 'rejected' || p.status === 'removed').map((p) => ({ at: p.round + 1, amount: L.decay(p.points, S.cfg) }))
  const to = S.lastClosed ?? 0
  const from = Math.max(1, to - Number(S.cfg.log_keep) + 1, (m.history[0]?.round ?? to) - 1)
  const series = L.repSeries(S.cfg, { history: m.history.map((h) => ({ round: h.round, points: h.points })), strikes, from, to, guest: m.kind === 'guest' })
  U.openDrawer('member', 'Record', U.memberHtml(m, { name, house: client.house, series, explorer: EXPLORER, mock: MOCK, me: S.me, proposals: S.proposals }))
}

async function openProposal(id) {
  U.openDrawer('proposal', `DAO proposal #${id}`, '<p class="muted">Reading the DAO…</p>')
  try {
    const p = await client.proposal(id)
    if (!p) throw new Error('removed')
    S.proposals.set(id, p)
    const payout = S.lastPayouts.find((x) => Number(x.dao_proposal) === id) ?? null
    U.openDrawer('proposal', `DAO proposal #${id}`, U.proposalHtml(p, { name, dao: S.cfg.dao, explorer: EXPLORER, mock: MOCK, payout, house: client.house }))
  } catch {
    U.openDrawer('proposal', `DAO proposal #${id}`, '<p class="muted">The DAO has no such proposal (a removed proposal is deleted).</p>')
  }
}

const proof = { keys: null }
async function openProof() {
  if (!client) return U.openDrawer('proof', 'Proof', '<p>The contract is not deployed on NEAR testnet yet, so there is nothing to check here. Once it is, this drawer reads its keys, its code hash, the DAO’s policy and the contract’s own books live.</p>')
  const draw = () =>
    U.proofHtml({
      mock: MOCK,
      explorer: EXPLORER,
      contract: client?.contract ?? DEPLOYMENT.contract ?? '–',
      token: S.cfg?.token ?? '–',
      dao: S.cfg?.dao ?? '–',
      gasAccount: client?.gasAccount,
      contractKeys: proof.contractKeys,
      tokenKeys: proof.tokenKeys,
      contractHash: proof.contractHash,
      tokenHash: proof.tokenHash,
      expectedHash: client?.codeHash,
      expectedTokenHash: client?.tokenCodeHash,
      stage: !MOCK && DEPLOYMENT.name === 'stage',
      lockTx: client?.lockTx,
      report: S.report,
      audit: S.audit,
      relayKeys: proof.relayKeys,
      me: S.me,
      rpcHost: client?.rpcHost ?? '–',
      txs: client?.txs ?? [],
    })
  U.openDrawer('proof', 'Proof', draw())
  if (!client || !S.cfg || proof.loading || proof.loaded) return
  proof.loading = true
  const get = (p) => p.catch(() => null)
  const [ck, tk, ca, ta, rk, au] = await Promise.all([
    get(client.accessKeys(client.contract)),
    get(client.accessKeys(S.cfg.token)),
    get(client.viewAccount(client.contract)),
    get(client.viewAccount(S.cfg.token)),
    client.gasAccount ? get(client.accessKeys(client.gasAccount)) : Promise.resolve([]),
    get(client.audit()),
  ])
  Object.assign(proof, { contractKeys: ck, tokenKeys: tk, contractHash: ca?.code_hash, tokenHash: ta?.code_hash, relayKeys: rk, loading: false, loaded: true })
  if (au) S.audit = au
  if (!S.report) await loadPolicy()
  if (U.drawerIs('proof')) U.$('drawer-body').innerHTML = draw()
}

boot()
