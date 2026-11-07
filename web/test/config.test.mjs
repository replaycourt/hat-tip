// The page's promises about itself: a strict CSP that matches the configured RPC hosts, no inline
// script or style anywhere, mock mode only when asked for, one config file for the deployment, and
// nothing private in any shipped file.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT, DEPLOYMENTS, RPC_HOSTS, pickDeployment } from '../js/config.js'
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
