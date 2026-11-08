// The pure parts of the page's DOM layer: when a drawer opens at its top, which block anchors the
// reader's view and how far to scroll to keep it, and how payouts and their voters are named.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as L from '../js/logic.js'
import { freshDrawer, pickAnchor, relayLines, scrollFix } from '../js/ui.js'

test('a drawer opens at its top; only a refresh of the same drawer keeps its scroll', () => {
  assert.equal(freshDrawer(false, null, 'proof'), true, 'opening from closed')
  assert.equal(freshDrawer(true, 'member:finn.x.testnet', 'proof'), true, 'Record, then Proof')
  assert.equal(freshDrawer(true, 'member:finn.x.testnet', 'member:ana.x.testnet'), true, 'another member')
  assert.equal(freshDrawer(true, 'proof', 'proof'), false, 'the proof drawer redrawn by a poll')
  assert.equal(freshDrawer(true, 'proposal:7', 'proposal:7'), false, 'reading, then the proposal')
})

test('the view anchor: the first block whose top is on screen, else the first still visible', () => {
  const rects = [
    { top: -900, bottom: -300 },
    { top: -300, bottom: 120 },
    { top: 140, bottom: 600 },
    { top: 620, bottom: 1000 },
  ]
  assert.equal(pickAnchor(rects, 844), 2)
  assert.equal(pickAnchor([{ top: -900, bottom: -10 }, { top: -10, bottom: 2000 }], 844), 1, 'one tall block over the screen')
  assert.equal(pickAnchor([{ top: -900, bottom: -10 }], 844), -1)
  // the board above grew by 180 px: scroll the same 180 so the payouts stay where they were
  assert.equal(scrollFix(140, 320, 1200), 180)
  assert.equal(scrollFix(140, 140.4, 1200), 0, 'sub-pixel noise is not a move')
  assert.equal(scrollFix(140, 320, 0), 0, 'at the very top of the page nothing is corrected')
  assert.equal(scrollFix(300, 200, 900), -100, 'a block above shrank')
})

test('the contract’s own vote is “the contract”; council members keep their names', () => {
  const contract = 'thanks.cafe.testnet'
  const name = L.displayName
  assert.equal(L.voterName(contract, { contract, name }), 'the contract')
  assert.equal(L.voterName('council-b.cafe.testnet', { contract, name }), 'Council B')
  const info = L.proposalInfo({ id: 3, status: 'Approved', kind: { Transfer: { receiver_id: 'ana.cafe.testnet', amount: '1' } }, votes: { [contract]: 'Approve' } })
  assert.equal(L.payoutStage({ status: 'approved', tier: 1 }, { ...info, status: 'InProgress' }, { name, contract }).text, 'Approved by the contract · transfer on its way')
  assert.doesNotMatch(L.payoutStage({ status: 'approved', tier: 1 }, { ...info, status: 'InProgress' }, { name, contract }).text, /Thanks/)
})

test('a payout the DAO has decided shows the DAO’s outcome, though the contract has not read it yet', () => {
  const name = L.displayName
  const voted = L.proposalInfo({ id: 9, status: 'Approved', kind: { Transfer: { receiver_id: 'a'.repeat(64), amount: '7880000' } }, votes: { 'council-a.cafe.testnet': 'Approve' } })
  // the guest's card: the contract still says `filed`, the tUSD is already in the browser account
  assert.equal(L.currentStatus({ status: 'filed', tier: 2 }, voted), 'paid')
  assert.deepEqual(L.payoutStage({ status: 'filed', tier: 2 }, voted, { name }), { state: 'paid', text: 'Paid · approved by Council A' })
  assert.equal(L.currentStatus({ status: 'filed', tier: 2 }, { ...voted, status: 'Rejected' }), 'rejected')
  assert.equal(L.currentStatus({ status: 'filed', tier: 3 }, { ...voted, status: 'InProgress' }), 'filed', 'still open in the DAO')
  assert.equal(L.currentStatus({ status: 'filed', tier: 2 }, null), 'filed', 'no DAO reading: the contract’s status')
  assert.equal(L.currentStatus({ status: 'rejected', tier: 2 }, voted), 'rejected', 'a final status of the contract stands')
})

test('early in a round a guest’s thanks count 0, and the card says why', () => {
  const cfg = { thanks_per_round: 100, cap_per_receiver: 25, max_receivers: 10, reciprocal_bp: 10000, quadratic: false, breadth_k: 0, breadth_bp: 10000, idle_bp: 10000, guest_weight_bp: 5000, guest_cap_bp: 2000 }
  const guest = 'a'.repeat(64)
  const cnt = L.countRound(cfg, new Set(['ana.x.testnet']), new Set([guest]), new Map([[guest, [['ana.x.testnet', 25]]]]))
  assert.equal(cnt.points.get('ana.x.testnet'), 0n, 'no member gave: guests steer 20 % of nothing')
  const r = L.explainReceiver(cfg, cnt, 'ana.x.testnet').reasons.find((x) => x.kind === 'guest')
  assert.equal(r.noMembers, true)
  assert.equal(L.reasonText(r, (a) => L.displayName(a, guest)), 'Guest thanks count as soon as members start giving: guests together steer at most 20\u00a0% of a round.')
  const later = L.countRound(cfg, new Set(['ana.x.testnet', 'ben.x.testnet']), new Set([guest]), new Map([[guest, [['ana.x.testnet', 25]]], ['ben.x.testnet', [['ana.x.testnet', 25]]]]))
  assert.equal(L.explainReceiver(cfg, later, 'ana.x.testnet').reasons.find((x) => x.kind === 'guest').noMembers, false)
})

test('relay keys: this contract’s keys are checked, keys bound to another contract are no failure', () => {
  const fc = (receiver_id, method_names, allowance = '1000000000000000000000000') => ({ public_key: `ed25519:${receiver_id}${method_names.join('')}`, access_key: { permission: { FunctionCall: { receiver_id, method_names, allowance } } } })
  const keys = [
    fc('thanks.hat-tip.testnet', ['act', 'close_round', 'pay', 'check_payout', 'sync']),
    fc('thanks.hat-tip.testnet', ['act', 'withdraw']),
    fc('thanks.hat-tip.testnet', []),
    fc('thanks.hat-tip-stage.testnet', ['act']),
    fc('thanks.hat-tip-stage.testnet', ['pay']),
    { public_key: 'ed25519:owner', access_key: { permission: 'FullAccess' } },
  ]
  const lines = relayLines(keys, 'thanks.hat-tip.testnet')
  assert.deepEqual(lines.map((l) => l.ok), [true, false, false, null, true], 'a method beyond the five, or any method, fails; the owner key is neutral')
  assert.deepEqual(lines.at(-1), { ok: true, other: 'thanks.hat-tip-stage.testnet', n: 2 })
  assert.deepEqual(relayLines(null, 'x'), [])
})
