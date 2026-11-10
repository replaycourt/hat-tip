// The track's requirements under the hero and the links behind them: which hash opens which drawer,
// which DAO proposal the tier link names, the DAO policy drawer (escaped, tiers marked), the
// proposal drawer's "filed by", and the strip itself in index.html.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as L from '../js/logic.js'
import { policyHtml, proposalHtml } from '../js/ui.js'

const WEB = fileURLToPath(new URL('..', import.meta.url))
const html = readFileSync(join(WEB, 'index.html'), 'utf8')
const main = readFileSync(join(WEB, 'js/main.js'), 'utf8')

const CONTRACT = 'thanks.cafe.testnet'
const POLICY = {
  roles: [
    { name: 'council', kind: { Group: ['council-c.cafe.testnet', 'council-a.cafe.testnet', 'council-b.cafe.testnet'] }, permissions: ['*:VoteApprove', '*:VoteReject', 'transfer:AddProposal'], vote_policy: { call: { weight_kind: 'RoleWeight', quorum: '0', threshold: '1' } } },
    { name: 'thanks', kind: { Group: [CONTRACT] }, permissions: ['transfer:VoteApprove', 'transfer:AddProposal', 'call:AddProposal'], vote_policy: { transfer: { weight_kind: 'RoleWeight', quorum: '0', threshold: [1, 1] } } },
    { name: 'members', kind: { Group: ['ben.cafe.testnet', 'ana.cafe.testnet'] }, permissions: [], vote_policy: {} },
  ],
  default_vote_policy: { weight_kind: 'RoleWeight', quorum: '0', threshold: [1, 2] },
  proposal_bond: '10000000000000000000000',
  proposal_period: '86400000000000',
}
const opts = { dao: 'cafe.sputnikv2.testnet', explorer: 'https://testnet.nearblocks.io', mock: false, contract: CONTRACT, name: L.displayName }

test('a hash opens a drawer only when it names one exactly', () => {
  assert.deepEqual(L.parseRoute('#policy'), { kind: 'policy' })
  assert.deepEqual(L.parseRoute('#proof'), { kind: 'proof' })
  assert.deepEqual(L.parseRoute('#record=ana.hat-tip.testnet'), { kind: 'record', account: 'ana.hat-tip.testnet' })
  assert.deepEqual(L.parseRoute('record=ana.hat-tip.testnet'), { kind: 'record', account: 'ana.hat-tip.testnet' }, 'without the #')
  assert.deepEqual(L.parseRoute('#record=' + 'a'.repeat(64)), { kind: 'record', account: 'a'.repeat(64) }, 'an implicit account')
  assert.deepEqual(L.parseRoute('#proposal=41'), { kind: 'proposal', id: 41 })
  assert.deepEqual(L.parseRoute('#proposal=0'), { kind: 'proposal', id: 0 })
  for (const bad of ['', '#', '#board', '#flows', '#rules', '#policy=1', '#record=', '#record=Ana.testnet', '#record=%3Cimg%20src%3Dx%3E', '#record=<b>x</b>', '#record=%E0%A4%A', '#record=a..b.testnet', '#record=' + 'a'.repeat(65), '#proposal=-1', '#proposal=1e3', '#proposal=41x', '#proposal=1234567890123', null, undefined]) {
    assert.equal(L.parseRoute(bad), null, String(bad))
  }
})

test('the tier link names the newest tier-1 payout of the round, else the newest one filed', () => {
  const p = (id, tier) => ({ dao_proposal: id, tier })
  assert.deepEqual(L.reqProposal([p(90, 2), p(91, 1), p(92, 1), p(93, 3)]), { id: 92, tier: 1 })
  assert.deepEqual(L.reqProposal([p(90, 2), p(93, 3)]), { id: 93, tier: 3 })
  assert.deepEqual(L.reqProposal([{ dao_proposal: null, tier: 1 }, p(5, 2)]), { id: 5, tier: 2 }, 'a payout not filed yet has no proposal to link')
  assert.equal(L.reqProposal([]), null)
  assert.equal(L.reqProposal(), null)
})

test('the DAO’s roles as get_policy states them', () => {
  const roles = L.policyRoles(POLICY)
  assert.deepEqual(roles.map((r) => r.name), ['council', 'thanks', 'members'])
  assert.deepEqual(roles[0].who.group, ['council-a.cafe.testnet', 'council-b.cafe.testnet', 'council-c.cafe.testnet'])
  assert.deepEqual(roles[0].votes, [{ kind: 'call', threshold: '1' }])
  assert.deepEqual(roles[1].votes, [{ kind: 'transfer', threshold: [1, 1] }])
  assert.deepEqual(roles[1].permissions, ['call:AddProposal', 'transfer:AddProposal', 'transfer:VoteApprove'])
  assert.deepEqual(roles[2].permissions, [])
  assert.deepEqual(L.policyRoles({ roles: [{ name: 'all', kind: 'Everyone', permissions: ['*:AddProposal'], vote_policy: {} }] })[0].who, { everyone: true })
  assert.deepEqual(L.policyRoles({ roles: [{ name: 'tok', kind: { Member: '5' }, permissions: [], vote_policy: {} }] })[0].who, { member: '5' })
  assert.deepEqual(L.policyRoles(null), [])
  assert.equal(L.defaultPolicyText(POLICY), 'more than 1/2')
  assert.equal(L.defaultPolicyText({ default_vote_policy: { threshold: '3' } }), '3 votes')
})

test('the policy drawer marks the tiers in the DAO’s own vote policies', () => {
  const report = L.policyReport(POLICY, { contract: CONTRACT })
  const out = policyHtml(POLICY, report, opts)
  assert.match(out, /<code>transfer<\/code> passes with 1 of 1 of this role <span class="pill t1">/, 'tier 1: the role thanks')
  assert.match(out, /<code>call<\/code> passes with 1 vote of this role <span class="pill t2">/, 'tier 2: one council vote')
  assert.match(out, /needs 2 council votes <span class="pill t3">/, 'tier 3: the default policy')
  assert.match(out, /the contract \(thanks\.cafe\.testnet\)/)
  assert.match(out, /Council A, B and C/)
  assert.match(out, /bond is 0\.01 NEAR; a proposal expires after 1 day/)
  assert.equal((out.match(/<li class="ok">/g) ?? []).length, report.checks.filter((c) => c.ok).length)
  assert.match(out, /href="https:\/\/testnet\.nearblocks\.io\/address\/cafe\.sputnikv2\.testnet"/)
  assert.match(policyHtml(null, null, opts), /Could not read/)
  assert.match(policyHtml({ roles: [{ name: 'all', kind: 'Everyone', permissions: [], vote_policy: {} }] }, null, opts), /<b class="bad">everyone<\/b>/)
})

test('the policy drawer shows names from the chain as text, never as HTML', () => {
  const evil = {
    ...POLICY,
    roles: [
      { name: '<img src=x onerror=alert(1)>', kind: { Group: ['<script>alert(1)</script>'] }, permissions: ['<b>x</b>:AddProposal'], vote_policy: { '<i>k</i>': { threshold: '<u>1</u>' } } },
      { name: 'odd', kind: { '<svg>': 1 }, permissions: [], vote_policy: {} },
    ],
  }
  const out = policyHtml(evil, null, { ...opts, name: (a) => a })
  for (const raw of ['<img', '<script', '<b>x', '<i>k', '<u>1', '<svg']) assert.ok(!out.includes(raw), raw)
  assert.match(out, /&lt;img src=x onerror=alert\(1\)&gt;/)
  assert.match(out, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
})

test('a proposal says who filed it: the contract, which has no keys, or the account by name', () => {
  const p = { id: 41, status: 'Approved', proposer: CONTRACT, description: 'Hat Tip r9 (auto)', kind: { Transfer: { receiver_id: 'ana.cafe.testnet', amount: '16690000' } }, votes: { [CONTRACT]: 'Approve' } }
  const args = { name: L.displayName, dao: opts.dao, explorer: opts.explorer, mock: false, payout: null, house: {}, contract: CONTRACT }
  assert.match(proposalHtml(p, args), /Filed by <b>the contract<\/b>, <code>thanks\.cafe\.testnet<\/code>, which has no keys\./)
  assert.match(proposalHtml({ ...p, proposer: 'council-a.cafe.testnet' }, args), /Filed by <b>Council A<\/b>\./)
  const out = proposalHtml({ ...p, proposer: '<img src=x>' }, { ...args, name: (a) => a })
  assert.ok(!out.includes('<img src=x>'))
})

test('the requirements strip sits right under the hero: five items, each with its link', () => {
  const strip = html.match(/<section class="reqs" id="reqs"[\s\S]*?<\/section>/)?.[0]
  assert.ok(strip, 'the strip is in index.html')
  assert.ok(html.indexOf('id="reqs"') > html.indexOf('class="hero"') && html.indexOf('id="reqs"') < html.indexOf('id="story"'), 'between the hero and the close story')
  const items = strip.match(/<li class="req[^"]*">[\s\S]*?<\/li>/g)
  assert.equal(items.length, 5, 'four requirements and the checkpoint')
  for (const it of items) assert.match(it, /<b class="req-name">[\s\S]+<span class="req-how">[^<]+<\/span><a class="req-link"[^>]* href="#[a-z]+"/)
  // every in-page link lands on something that exists
  for (const [, target] of strip.matchAll(/href="#([a-z]+)"/g)) {
    if (target === 'policy') continue // a drawer, opened by main.js
    assert.match(html, new RegExp(`id="${target}"`), `#${target} exists`)
  }
  for (const id of ['req-policy', 'req-record', 'req-proposal']) assert.match(strip, new RegExp(`id="${id}"`))
  assert.match(html, /<div class="flows" id="flows">[\s\S]*?Which approval flows exist, and which Hat Tip adds/)
  // the strip's live links get their text through textContent, never innerHTML
  assert.ok(!/\$\('req-[a-z]+'\)\.innerHTML/.test(main))
  assert.match(main, /U\.setText\('req-record', `\$\{name\(acc\)\}’s record ›`\)/)
  assert.match(main, /globalThis\.addEventListener\('hashchange', \(\) => route\(\)\)/)
})
