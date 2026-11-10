// The bounty board on the page: the same reading as the house script (scripts/bounty-lib.mjs), the
// three columns in words, names as text, and the made-up board of mock mode in the DAO's shapes.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import * as L from '../js/logic.js'
import { mockBounties } from '../js/mock.js'
import { bountyBoard as scriptBoard } from '../../scripts/bounty-lib.mjs'

const TOKEN = 'tusd.cafe.testnet'
const T = 1_900_000_000_000

test('the page reads bounties exactly as the house script does', () => {
  const data = mockBounties(T, TOKEN)
  const nowNs = BigInt(T) * 1_000_000n
  assert.deepEqual(L.bountyBoard({ ...data, nowNs }), scriptBoard({ ...data, nowNs }))
})

test('the columns: open and proposed, being worked on, done and paid, in words', () => {
  const data = mockBounties(T, TOKEN)
  const board = L.bountyBoard({ ...data, nowNs: BigInt(T) * 1_000_000n })
  const cols = L.bountyColumns(board, { nowMs: T, tokenId: TOKEN, majority: 2 })
  assert.deepEqual(cols.open.map((b) => [b.id, b.state]), [[3, 'open'], [4, 'open'], [null, 'proposed']])
  assert.equal(cols.open[0].title, 'Sort the screw box by size')
  assert.equal(cols.open[0].line, '2 h to finish once claimed')
  assert.equal(cols.open[2].line, 'proposed: the council majority decides (1 of 2)')
  assert.deepEqual(cols.work.map((b) => [b.id, b.state, b.proposal]), [[1, 'review', 907], [2, 'claimed', 902]])
  assert.equal(cols.work[1].line, '1 h 42 min left to file the work')
  assert.deepEqual(cols.done.map((b) => [b.id, b.proposal, b.people.map(([w, a]) => `${w} ${a.split('.')[0]}`)]), [[0, 906, ['done by ben', 'posted by ana']]])
  assert.equal(cols.done[0].unit, 'tUSD')
})

test('a bounty row shows names and texts as text, never as markup', async () => {
  const { bountyHtml } = await import('../js/ui.js')
  const row = { id: 7, title: '<img src=x onerror=alert(1)>', description: '<b>x</b>', amount: '5000000', unit: 'tUSD', state: 'open', proposal: 12, line: '<i>', people: [['posted by', 'evil<script>.testnet']] }
  const html = bountyHtml(row, { name: (a) => a, house: {} })
  assert.ok(!html.includes('<img') && !html.includes('<script') && !html.includes('<i>') && !html.includes('<b>x'))
  assert.match(html, /data-proposal="12"/)
  assert.match(html, /data-record="evil&lt;script&gt;\.testnet"/)
})

test('a house bounty text loses its "posted by" tail; anything else stays whole', () => {
  assert.equal(L.bountyTitle('Fix the toaster that trips the fuse (posted by ana, round 916)'), 'Fix the toaster that trips the fuse')
  assert.equal(L.bountyTitle('Paint the shed (two coats)'), 'Paint the shed (two coats)')
  assert.equal(L.bountyTitle(''), 'A bounty')
  const long = L.bountyColumns(L.bountyBoard({ bounties: [{ id: 9, description: 'x', token: TOKEN, amount: '5000000', times: 1, max_deadline: String(10n * 86_400_000_000_000n) }], counts: { 9: 0 } }), { nowMs: T, tokenId: TOKEN })
  assert.equal(long.open[0].line, '10 days to finish once claimed')
})

test('the page section, its link in the requirements strip, and the bond in NEAR', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
  for (const id of ['bounties', 'b-open', 'b-work', 'b-done', 'b-foot-state', 'req-bounties']) assert.match(html, new RegExp(`id="${id}"`))
  assert.match(html, /<a class="req-link req-link-2" id="req-bounties" href="#bounties">/)
  assert.equal(L.fmtNear('1000000000000000000000000'), '1')
  assert.equal(L.fmtNear('10000000000000000000000'), '0.01')
})

test('proposalInfo reads the two bounty kinds', () => {
  const add = L.proposalInfo({ id: 1, status: 'InProgress', proposer: 'ana.cafe.testnet', kind: { AddBounty: { bounty: { description: 'x', token: TOKEN, amount: '10000000', times: 1, max_deadline: '1' } } } })
  assert.deepEqual([add.kind, String(add.amount), add.receiver], ['AddBounty', '10000000', null])
  const done = L.proposalInfo({ id: 2, status: 'Approved', proposer: 'ben.cafe.testnet', kind: { BountyDone: { bounty_id: 3, receiver_id: 'ben.cafe.testnet' } } })
  assert.deepEqual([done.kind, done.receiver], ['BountyDone (bounty #3)', 'ben.cafe.testnet'])
})

test("config.js names the bounty proposals deploy/testnet.json records, so the page finds them however old", async () => {
  const { DEPLOYMENTS } = await import('../js/config.js')
  const deploy = JSON.parse(readFileSync(new URL('../../deploy/testnet.json', import.meta.url), 'utf8'))
  for (const [section, name] of [['final', 'final'], ['staging', 'stage']]) {
    const rec = deploy[section]?.bounties?.proposals
    const want = rec ? [...new Set([...(rec.add ?? []), ...(rec.done ?? [])])].sort((a, b) => a - b) : []
    assert.deepEqual([...(DEPLOYMENTS[name].bountyProposals ?? [])].sort((a, b) => a - b), want, `${name}: bountyProposals = ${section}.bounties.proposals`)
  }
})
