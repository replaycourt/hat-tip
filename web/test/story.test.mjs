// What the page tells about a round: the reason line on a card and its partner, the demo roles'
// captions, the close strip (proposals filed so far, tiers and their state), the approvals as
// marks, when a guest should join and the guest's own result, the proof drawer's verdict, and the
// static parts of index.html that must agree with the data (the simulation's result, the link
// preview, the bundled font).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as L from '../js/logic.js'
import { outcomeHtml, proofVerdict, roleNote, storyHtml } from '../js/ui.js'
import { REPLAY } from '../js/replay-data.js'

const WEB = fileURLToPath(new URL('..', import.meta.url))
const html = readFileSync(join(WEB, 'index.html'), 'utf8')
const A = (n) => `${n}.cafe.testnet`
const house = { [A('ana')]: 'honest', [A('finn')]: 'pair', [A('gus')]: 'pair', [A('hugo')]: 'free_rider', [A('council-a')]: 'council' }
const cfg = { cap_per_receiver: 25, reciprocal_bp: 2500, idle_bp: 10000, thanks_per_round: 100 }
const name = (a) => L.displayName(a)

test('the colluding pair’s partner comes from the published house list', () => {
  assert.equal(L.housePartner(house, A('finn')), A('gus'))
  assert.equal(L.housePartner(house, A('gus')), A('finn'))
  assert.equal(L.housePartner(house, A('ana')), null, 'an honest helper has no partner')
  assert.equal(L.housePartner({ ...house, [A('ivy')]: 'pair' }, A('finn')), null, 'three pair members: no single partner')
  assert.equal(L.housePartner(undefined, A('finn')), null)
})

test('a card names the real partner when two mutual pairs are equally strong', () => {
  const mutual = (other, given, back) => ({ kind: 'mutual', other, given, back, counted: 6250n, backCounted: 6250n, bp: 2500 })
  // finn thanked cleo 25 and got 25 back in the same round as gus: rows come in account order
  const reasons = [mutual(A('cleo'), 25, 25), mutual(A('gus'), 25, 25)]
  assert.equal(L.pickReason(reasons, { cap: 25 }).other, A('cleo'), 'without a partner: the first of equals')
  assert.equal(L.pickReason(reasons, { cap: 25, partner: A('gus') }).other, A('gus'), 'the published partner first')
  assert.equal(L.reasonText(L.pickReason(reasons, { cap: 25, partner: A('gus') }), name), 'Thanked each other 25 with Gus: counted 6.2 each way.')
  // a stronger pair still wins over the partner, and weak mutual thanks are no line at all
  assert.equal(L.pickReason([mutual(A('gus'), 20, 20), mutual(A('cleo'), 25, 25)], { cap: 25, partner: A('gus') }).other, A('cleo'))
  assert.equal(L.pickReason([mutual(A('gus'), 10, 25)], { cap: 25, partner: A('gus') }), null)
  const guest = 'b'.repeat(64)
  assert.equal(L.pickReason([{ kind: 'breadth' }, { kind: 'guest', who: [guest] }], { cap: 25, me: guest }).kind, 'guest', 'the visitor’s own thanks before the rest')
})

test('the demo roles say what they show', () => {
  assert.equal(L.roleCaption('pair', { cfg, partnerName: 'Gus' }), 'Shows collusion: gives Gus 25 a round and gets 25 back. Mutual thanks count 25 %: 6.2 each way.')
  assert.match(L.roleCaption('free_rider', { cfg }), /^Shows free riding: fixes nothing, thanks nobody\. Only mutual thanks are discounted, so what he gets counts in full\.$/)
  assert.match(L.roleCaption('free_rider', { cfg: { ...cfg, idle_bp: 5000 } }), /counts 50 %\.$/)
  assert.equal(L.roleCaption('honest', { cfg }), '')
  // the record: how much of gus's points finn's thanks made
  const history = [
    { round: 1, points: '20000', givers: [[A('finn'), 25, '6250'], [A('ana'), 25, '13750']] },
    { round: 2, points: '10000', givers: [[A('ana'), 10, '10000']] },
  ]
  assert.deepEqual(L.partnerShare(history, A('finn')), { fromPartner: 6250n, total: 30000n, rounds: 1 })
  const note = roleNote({ account: A('gus'), history, strikes: 2 }, { kind: 'pair', partner: A('finn'), name })
  assert.match(note, /^Finn’s thanks made 20\.8 % of Gus’s points/)
  assert.match(note, /2 were rejected, each a strike\.$/)
  assert.match(roleNote({ account: A('hugo'), history, strikes: 0 }, { kind: 'free_rider', name }), /\(2 different givers over the rounds kept\)/)
  assert.equal(roleNote({ account: A('ana'), history, strikes: 0 }, { kind: 'honest', name }), '')
})

test('the close strip never shows a range that hides proposals still to come', () => {
  const p = (id, tier, dao, status = 'filed') => ({ id, tier, dao_proposal: dao, status, amount: '10000000' })
  assert.equal(L.filedText([]), 'No proposals this round.')
  assert.equal(L.filedText([p(1, 1, null, 'planned'), p(2, 2, null, 'planned')]), '2 proposals, being filed now.')
  // round 23 of the final deployment: 8 payouts, the first pay call filed three of them
  const r23 = [127, 128, 129, null, null, null, null, null].map((d, i) => p(i, 1, d, d == null ? 'planned' : 'filed'))
  assert.equal(L.filedText(r23), '8 proposals: 3 filed so far, from #127.')
  assert.equal(L.filedText(r23.map((x, i) => ({ ...x, dao_proposal: 127 + i }))), '8 proposals, #127–#134.')
  assert.equal(L.filedText([p(1, 3, 41)]), '1 proposal, #41.')
})

test('the strip’s last step: payouts per tier, how many are paid, and its text', () => {
  const p = (tier, status) => ({ tier, status, amount: '5000000' })
  const payouts = [p(1, 'paid'), p(1, 'paid'), p(2, 'filed'), p(3, 'rejected')]
  const t = L.tierTally(payouts)
  assert.deepEqual([t[1].n, t[1].paid, t[2].n, t[2].paid, t[3].struck], [2, 2, 1, 0, 1])
  assert.equal(t[1].amount, 10_000_000n)
  const s = { n: 23, givers: 9, thanks: 810, points: 411_000n, budget: 120_000_000n, payouts: 4, carried: 1, filed: L.filedText([]), tally: t, guestsOnly: false }
  const h = storyHtml(s, 5)
  assert.equal((h.match(/class="story-step on/g) ?? []).length, 5, 'all five steps shown')
  assert.match(h, /paid at once <b>2<\/b>/)
  assert.match(h, /2 of 4 paid, 1 waiting for the council, 1 struck\./)
  assert.equal((storyHtml(s, 2).match(/class="story-step on/g) ?? []).length, 2, 'while it plays, step by step')
  const done = storyHtml({ ...s, tally: L.tierTally([p(1, 'paid'), p(2, 'paid')]), payouts: 2 }, 5)
  assert.match(done, /All 2 decided: 2 paid\./)
  assert.match(storyHtml({ ...s, n: 1, givers: 1, thanks: 1, points: 0n, payouts: 0, guestsOnly: true, guestCapBp: 2000 }, 5), /Nothing counted: guests steer at most 20 % of a round/)
})

test('approvals as marks: the contract’s vote, one council vote, the majority, a veto', () => {
  const contract = A('thanks')
  const info = (votes, status = 'InProgress') => ({ votes: Object.entries(votes), status })
  const o = { tier3Votes: 2, contract, name }
  assert.deepEqual(L.voteMarks({ tier: 1, status: 'paid' }, null, o), [{ who: 'the contract', state: 'yes' }], 'a paid tier 1 was the contract’s own vote')
  assert.deepEqual(L.voteMarks({ tier: 1, status: 'paid' }, info({ [contract]: 'Approve' }, 'Approved'), o), [{ who: 'the contract', state: 'yes' }])
  assert.deepEqual(L.voteMarks({ tier: 2, status: 'filed' }, info({}), o), [{ who: 'council', state: 'open' }])
  assert.deepEqual(L.voteMarks({ tier: 3, status: 'filed' }, info({ [A('council-a')]: 'Approve' }), o), [
    { who: 'Council A', state: 'yes' },
    { who: 'council', state: 'open' },
  ])
  assert.deepEqual(L.voteMarks({ tier: 3, status: 'paid' }, info({ [A('council-a')]: 'Approve', [A('council-c')]: 'Approve' }, 'Approved'), o).map((m) => m.who), ['Council A', 'Council C'])
  assert.deepEqual(L.voteMarks({ tier: 2, status: 'filed' }, info({ [A('council-b')]: 'Reject' }, 'Rejected'), o), [{ who: 'Council B', state: 'no' }], 'a veto, and nothing more to wait for')
  // with marks next to it, the stage line does not name the voters a second time
  assert.equal(L.payoutStage({ tier: 2, status: 'paid' }, info({ [A('council-a')]: 'Approve' }, 'Approved'), { name, brief: true }).text, 'Paid')
  assert.equal(L.payoutStage({ tier: 2, status: 'paid' }, info({ [A('council-a')]: 'Approve' }, 'Approved'), { name }).text, 'Paid · approved by Council A')
})

test('when a guest should join: before the house members give, and what a late guest gets', () => {
  assert.equal(L.guestTiming(0.2).phase, 'early')
  assert.match(L.guestTiming(0.2).text, /between halfway and four fifths through the round/)
  assert.equal(L.guestTiming(0.6).phase, 'mid')
  const late = L.guestTiming(0.9)
  assert.equal(late.phase, 'late')
  assert.match(late.text, /nobody will thank you back this round/)
  assert.equal(L.guestTiming(0.05, { from: 0.1, to: 0.9 }).phase, 'early')
  assert.equal(L.windowWord(0.5), 'halfway')
  assert.equal(L.windowWord(0.33), '33 %')
})

test('the guest’s own result after a close: thanked back, paid or kept, or nobody', () => {
  const me = 'c'.repeat(64)
  const opts = { lastClosed: 23, minPayout: 5_000_000n, carryRounds: 12 }
  assert.equal(L.guestOutcome(null, opts), null, 'never seated, no record: nothing to tell')
  // round 23: three members thanked back, 3.28 tUSD below the minimum, kept
  const rec = { account: me, carry: '3284671', carry_since: 23, history: [{ round: 23, points: '11250', givers: [[A('ana'), 5, '1250'], [A('finn'), 5, '5000'], [A('ben'), 5, '5000']] }], payouts: [] }
  const kept = L.guestOutcome(rec, { ...opts, seated: new Set([23]) })
  assert.deepEqual([kept.round, kept.givers.length, kept.carried, kept.lapseRound, kept.payout], [23, 3, 3_284_671n, 35, null])
  const h = outcomeHtml(kept, { name, stage: null })
  assert.match(h, /Round 23 closed/)
  assert.match(h, /Ana, Finn and Ben thanked you back: 11\.2 counted\./)
  assert.match(h, /3\.28 tUSD<\/b><span class="pill carry">kept for you/)
  // a payout of that round, with its stage and proposal
  const payout = { id: 133, round: 23, tier: 2, status: 'filed', amount: '7880000', dao_proposal: 134 }
  const paid = L.guestOutcome({ ...rec, carry: '0', payouts: [payout] }, opts)
  assert.equal(paid.payout, payout)
  assert.match(outcomeHtml(paid, { name, stage: { text: 'Waiting for one council vote' } }), /7\.88 tUSD<\/b><span class="pill t2">1 council vote<\/span><span>Waiting for one council vote<\/span><button class="p-prop" type="button" data-proposal="134">#134/)
  // seated in round 23, nobody thanked back: say so, and when to come
  const none = L.guestOutcome({ history: [], payouts: [], carry: '0' }, { ...opts, seated: new Set([23, 24]) })
  assert.deepEqual([none.round, none.givers.length], [23, 0], 'the open round 24 does not count yet')
  assert.match(outcomeHtml(none, { name }), /Nobody thanked you back this time\..*Join early next round.*between halfway and four fifths through the round/)
})

test('the proof drawer’s verdict: waits for every read, then counts what fails', () => {
  const report = { checks: [{ ok: true }, { ok: true }] }
  const audit = { balanced: true, points_attributed: true, statuses_ok: true, filed_have_ids: true }
  const relay = [{ public_key: 'k', access_key: { permission: { FunctionCall: { receiver_id: 'c', method_names: ['act'], allowance: '1' } } } }]
  const x = { contract: 'c', contractKeys: [], tokenKeys: [], contractHash: 'h', expectedHash: 'h', tokenHash: 't', expectedTokenHash: 't', report, audit, relayKeys: relay }
  assert.equal(proofVerdict({ ...x, audit: null }), null, 'still reading')
  assert.deepEqual(proofVerdict(x), { ok: true, n: 11, failed: 0 })
  assert.deepEqual(proofVerdict({ ...x, contractKeys: [{}] }), { ok: false, n: 11, failed: 1 })
  assert.equal(proofVerdict({ ...x, contractKeys: [{}], stage: true }).ok, true, 'staging keeps its keys on purpose')
})

test('the simulation’s result on the page is the simulation’s data', () => {
  const shown = [...html.matchAll(/data-scenario="([^"]+)"><dt>[^<]+<\/dt><dd><span class="rp-from">([^<]+)<\/span>.*?<b class="rp-to">([^<]+)<\/b>/g)]
  assert.equal(shown.length, 3)
  const num = (t) => Number(t.replace('−', '-'))
  for (const [, label, from, to] of shown) {
    const row = REPLAY.scenarios.rows.find((r) => r.label === label)
    assert.ok(row, label)
    assert.equal(num(from), row.plain, `${label}: plain`)
    assert.equal(num(to), row.rules, `${label}: with the rules`)
  }
  assert.match(html, new RegExp(`${REPLAY.scenarios.members} members, ${REPLAY.scenarios.rounds} weekly rounds`))
})

test('a link preview and one bundled font, both from this repository', () => {
  const meta = (k) => html.match(new RegExp(`<meta (?:property|name)="${k}" content="([^"]+)"`))?.[1]
  assert.equal(meta('og:image'), 'https://replaycourt.github.io/hat-tip/web/og.png')
  assert.equal(meta('twitter:card'), 'summary_large_image')
  assert.equal(meta('og:title'), html.match(/<title>([^<]+)<\/title>/)[1])
  const png = readFileSync(join(WEB, 'og.png'))
  assert.equal(png.subarray(1, 4).toString(), 'PNG')
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1200, 630], 'og.png is 1200 x 630')
  const font = readFileSync(join(WEB, 'fonts/source-serif-4-latin.woff2'))
  assert.equal(font.subarray(0, 4).toString(), 'wOF2')
  assert.ok(font.length < 60_000, 'a Latin subset')
  assert.ok(existsSync(join(WEB, 'fonts/OFL-source-serif-4.md')), 'the licence next to the font')
  assert.match(readFileSync(join(WEB, 'fonts/OFL-source-serif-4.md'), 'utf8'), /SIL Open Font License, Version 1\.1/)
  assert.match(readFileSync(join(WEB, 'css/style.css'), 'utf8'), /src: url\('\.\.\/fonts\/source-serif-4-latin\.woff2'\) format\('woff2'\)/)
})
