// The page's promises about itself: a strict CSP that matches the configured RPC hosts, no inline
// script or style anywhere, mock mode only when asked for, one config file for the deployment, and
// nothing private in any shipped file.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ACT_GAS, CHECK_GAS, CLOSE_GAS, DEFAULT, DEPLOYMENTS, PAY_GAS, PAY_MAX, RPC_HOSTS, pickDeployment } from '../js/config.js'
import { b58decode, keyFromNearString, nearPublicKey } from '../js/near.js'

const WEB = fileURLToPath(new URL('..', import.meta.url))
const html = readFileSync(join(WEB, 'index.html'), 'utf8')
const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1]
const directive = (name) => csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(name + ' '))

function files(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? files(p) : [p]
  })
}
const shipped = files(WEB).filter((p) => !p.includes('/test/') && /\.(html|js|css|svg|md)$/.test(p))

test('the CSP is strict and connects only to the configured RPC hosts', () => {
  assert.equal(directive('default-src'), "default-src 'self'")
  assert.equal(directive('script-src'), "script-src 'self'")
  assert.equal(directive('style-src'), "style-src 'self'")
  assert.equal(directive('img-src'), "img-src 'self' data:")
  assert.equal(directive('object-src'), "object-src 'none'")
  assert.deepEqual(directive('connect-src').split(/\s+/).slice(1).sort(), [...RPC_HOSTS].sort())
  assert.ok(!/unsafe-inline|unsafe-eval/.test(csp))
  for (const h of RPC_HOSTS) assert.match(h, /^https:\/\/[a-z0-9.-]+$/)
})

test('no inline script, no inline style, no style attributes, no external resources', () => {
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(html), 'every script has a src')
  assert.ok(!/<style/.test(html))
  for (const p of shipped.filter((f) => /\.(html|js)$/.test(f))) {
    const text = readFileSync(p, 'utf8')
    assert.ok(!/\sstyle=["'`$]/.test(text), `${p}: style attribute (blocked by the CSP; use classes or CSSOM)`)
    assert.ok(!/\son[a-z]+=["']/.test(text), `${p}: inline event handler`)
    assert.ok(!/(src|href)=["']https?:\/\/(?!github\.com\/replaycourt)/.test(text), `${p}: external resource`)
  }
  assert.ok(!/@import|url\(\s*["']?https?:/.test(readFileSync(join(WEB, 'css/style.css'), 'utf8')), 'no web fonts or remote images')
})

test('one config module names the deployments; only known names are accepted', () => {
  assert.equal(DEFAULT, 'final')
  assert.equal(pickDeployment('?contract=stage').name, 'stage')
  assert.equal(pickDeployment('?contract=final').name, 'final')
  assert.equal(pickDeployment('?contract=evil.testnet').name, 'final')
  assert.equal(pickDeployment('?contract=__proto__').name, 'final')
  assert.equal(pickDeployment('').name, 'final')
  for (const [name, d] of Object.entries(DEPLOYMENTS)) {
    assert.deepEqual(Object.keys(d).sort(), ['codeHash', 'contract', 'gasAccount', 'gasKeys', 'house', 'lockTx', 'tokenCodeHash'], name)
    if (d.contract) assert.match(d.contract, /^[a-z0-9_-]+(\.[a-z0-9_-]+)*\.testnet$/, name)
    if (d.gasAccount) assert.match(d.gasAccount, /^[a-z0-9_-]+(\.[a-z0-9_-]+)*\.testnet$/, name)
    for (const h of [d.codeHash, d.tokenCodeHash].filter(Boolean)) assert.equal(b58decode(h).length, 32, `${name}: a base58 sha256`)
    for (const [acc, kind] of Object.entries(d.house)) {
      assert.match(acc, /\.testnet$/)
      assert.ok(['honest', 'pair', 'free_rider', 'newcomer', 'council'].includes(kind), `${name}: ${acc} has a published strategy`)
    }
  }
  const other = shipped.filter((p) => /\.js$/.test(p) && !/config\.js$|mock\.js$/.test(p))
  for (const p of other) assert.ok(!/\.testnet['"`]/.test(readFileSync(p, 'utf8').replace(/sputnikv2\.testnet|test\.rpc|testnet\.nearblocks/g, '')), `${p} names no account (config.js does)`)
})

test('every gas key is a well-formed ed25519 pair whose secret matches its public key', async () => {
  for (const [name, d] of Object.entries(DEPLOYMENTS)) {
    for (const k of d.gasKeys) {
      assert.deepEqual(Object.keys(k).sort(), ['private_key', 'public_key'], `${name}: only the two key strings`)
      assert.equal(nearPublicKey(await keyFromNearString(k.private_key)), k.public_key, `${name}: secret and public key belong together`)
    }
  }
})

test('mock mode needs ?mock=1 and is loaded only then', () => {
  const main = readFileSync(join(WEB, 'js/main.js'), 'utf8')
  assert.match(main, /const MOCK = params\.get\('mock'\) === '1'/)
  assert.ok(!/^import .*mock\.js/m.test(main), 'mock.js is not imported statically')
  assert.match(main, /if \(MOCK\) \{\s+const \{ MockClient \} = await import\('\.\/mock\.js'\)/)
  assert.match(html, /id="mock-badge"[^>]*hidden/, 'the mock badge is hidden unless mock mode shows it')
})

// The only private keys a shipped file may hold: the public function-call gas keys in config.js.
const PUBLIC_GAS_SECRETS = new Set(Object.values(DEPLOYMENTS).flatMap((d) => d.gasKeys.map((k) => k.private_key)))

test('nothing private ships: no local paths, no user names, no secret keys', () => {
  for (const p of shipped) {
    const text = readFileSync(p, 'utf8')
    assert.ok(!/\/Users\/|\/home\/|C:\\\\|\/private\/tmp|\.secrets/.test(text), `${p}: a local path`)
    assert.ok(!/@[a-z0-9.-]+\.(de|com|org|net)\b/i.test(text.replace(/@NEARProtocol/g, '')), `${p}: an email address`)
    for (const m of text.matchAll(/ed25519:[1-9A-HJ-NP-Za-km-z]{80,90}/g)) assert.ok(PUBLIC_GAS_SECRETS.has(m[0]), `${p}: a private key that is not a published gas key`)
    assert.ok(!/seed phrase|mnemonic/i.test(text), `${p}: mentions a seed phrase`)
  }
})

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const DEPLOY = join(REPO, 'deploy/testnet.json')
const CONTRACT_CONFIG = join(REPO, 'contract/src/config.rs')

for (const [name, section] of [['stage', 'staging'], ['final', 'final']]) {
  test(`the ${name} deployment is the one deploy/testnet.json records (${section}), ready to play`, { skip: !existsSync(DEPLOY) && 'no deploy/testnet.json' }, () => {
    const dep = JSON.parse(readFileSync(DEPLOY, 'utf8'))[section]
    const st = DEPLOYMENTS[name]
    assert.equal(st.contract, dep.contract)
    assert.equal(st.gasAccount, dep.gas.account)
    assert.equal(st.codeHash, dep.code_hashes.contract)
    assert.equal(st.tokenCodeHash, dep.code_hashes.token)
    if (name === 'stage') assert.equal(st.lockTx, null, 'staging keeps its keys')
    else {
      assert.equal(st.lockTx, dep.txs['lock contract'].hash, 'the transaction that deleted the contract\'s keys')
      assert.deepEqual(dep.locked, { token: true, contract: true }, 'the launch deleted every key of both')
    }
    assert.deepEqual(st.gasKeys.map((k) => k.public_key).sort(), [...dep.gas.relay_keys].sort(), 'exactly the page relay keys')
    for (const k of dep.gas.keeper_keys ?? []) assert.ok(!st.gasKeys.some((g) => g.public_key === k), 'never the keeper keys')
    const house = Object.fromEntries([...dep.house.members.map((m) => [m.account, m.kind]), ...dep.house.council.map((c) => [c.account, 'council'])])
    assert.deepEqual(st.house, house, 'every house member and council member labelled with its strategy')
  })
}

test('gas: every relayed call carries at least what the contract asks for', { skip: !existsSync(CONTRACT_CONFIG) && 'no contract source' }, () => {
  const src = readFileSync(CONTRACT_CONFIG, 'utf8')
  const g = (name) => {
    const m = src.match(new RegExp(`pub const ${name}: Gas = Gas::from_tgas\\((\\d+)\\)`))
    assert.ok(m, name)
    return BigInt(m[1])
  }
  const T = 1_000_000_000_000n
  const [LINK, OWN, MARGIN] = [g('GAS_LINK'), g('GAS_OWN'), g('GAS_MARGIN')]
  // close.rs: a round with allocations; the contract's message names need + 5
  const close = 2n * LINK + g('GAS_GET_POLICY') + g('GAS_FT_BALANCE') + g('GAS_ON_CLOSE') + MARGIN
  assert.ok(CLOSE_GAS >= (close + 5n) * T, `close_round needs ${close + 5n} Tgas`)
  // pay.rs: check_payout = link + get_proposals + on_checked (own + 2 links + storage_deposit + act_proposal + on_finalized) + margin
  const onChecked = OWN + 2n * LINK + g('GAS_STORAGE_DEPOSIT') + g('GAS_ACT_PROPOSAL') + g('GAS_ON_FINALIZED')
  const check = LINK + g('GAS_GET_PROPOSAL') + onChecked + MARGIN
  assert.equal(check + 5n, 140n, 'the figure the contract names')
  assert.ok(CHECK_GAS >= (check + 5n) * T, `check_payout needs ${check + 5n} Tgas`)
  // pay.rs: the dearest payout (tier 1 with registration) must fit, with the margin, in one pay
  const filing1 = LINK + g('GAS_ADD_PROPOSAL') + (OWN + LINK + g('GAS_ACT_PROPOSAL') + g('GAS_ON_VOTED'))
  const registering1 = LINK + g('GAS_STORAGE_DEPOSIT') + OWN + filing1
  assert.ok(PAY_GAS >= (registering1 + MARGIN + 5n) * T, `pay needs ${registering1 + MARGIN + 5n} Tgas for one payout`)
  assert.ok(PAY_GAS <= 300n * T, 'at most 300 Tgas, the most a relay key should prepay')
  assert.ok(PAY_MAX >= 1)
  assert.ok(ACT_GAS >= 10n * T && ACT_GAS <= 50n * T, 'act burns about 3 Tgas')
})

test("a relay key's allowance covers the dearest call prepaid at the pessimistic gas price", { skip: !existsSync(DEPLOY) && 'no deploy/testnet.json' }, () => {
  for (const section of ['staging', 'final']) {
    const dep = JSON.parse(readFileSync(DEPLOY, 'utf8'))[section]
    const allowance = BigInt(Math.round(Number(dep.gas.relay_allowance_near) * 1000)) * 10n ** 21n
    const pessimistic = 1_000_000_000n // yocto per gas: 10x testnet's 10^8 (docs/testnet-probe.md, "Gas")
    for (const gas of [ACT_GAS, CLOSE_GAS, PAY_GAS, CHECK_GAS]) assert.ok(gas * pessimistic <= allowance, `${section}: ${gas} gas prepaid fits in ${dep.gas.relay_allowance_near} NEAR`)
  }
})

test('the round length is read from the contract, never written into the page', () => {
  for (const f of ['index.html', 'js/main.js', 'js/ui.js']) {
    const text = readFileSync(join(WEB, f), 'utf8')
    assert.ok(!/\b\d+[ -](second|minute|hour)s?\b/i.test(text), `${f}: a fixed round length`)
  }
  assert.match(readFileSync(join(WEB, 'js/main.js'), 'utf8'), /a round lasts \$\{L\.fmtDuration\(roundMs\)\}/)
})
