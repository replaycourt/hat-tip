#!/usr/bin/env node
// Adds function-call keys to the gas account that may call only `act`, `close_round`, `pay`,
// `check_payout` and `sync` on one contract, each capped by an allowance, in one transaction signed
// with the gas account's full-access key from the legacy keychain (Bonfire's setup-gas-pool.mjs).
//
//   node scripts/setup-gas-pool.mjs --gas <gas account> --contract <contract> [--page 8] [--keeper 2]
//        [--allowance 1] [--keeper-allowance 2] [--section staging]
//
// - Page keys: the relay of the page (guests' `act`, and anyone's close, pay and check). They are
//   public by design (DESIGN.md, "Guests"); their secrets go to the git-ignored
//   .secrets/gas-pool-<contract>.json (mode 600), from where package d publishes them.
// - Keeper keys: the house script's own relay keys (close, pay, check), so the keeper does not
//   race the page for nonces. Their seeds go into .secrets/house-keys-<contract>.json, the
//   HOUSE_KEYS secret.
// A gas price note: a transaction buys its gas up front at 10^9 yocto per gas (docs/testnet-probe.md),
// so a key needs 0.255 NEAR of allowance free for a close (255 Tgas) and 0.3 for a pay (300 Tgas);
// unused gas flows back into the allowance. The contract need not exist yet.
import { existsSync } from 'node:fs'
import { Signer, accessKeys, addFunctionCallKeyAction, assertTestnet, keyFromKeychain, nearPublicKey, nearSecretKey, newKey } from './near-lite.mjs'
import { RELAY_METHODS, cli, houseKeysFile, nearStr, poolFile, readJson, recordDeploy, recordTx, seedHexOf, tg, writeSecret } from './hat-tip-lib.mjs'

const { opt } = cli()
const gasAccount = opt('gas')
const contract = opt('contract')
const section = opt('section', 'staging')
const page = Number(opt('page', '8'))
const keeper = Number(opt('keeper', '2'))
assertTestnet(gasAccount, contract)
if (!(page >= 0 && keeper >= 0 && page + keeper >= 1 && page + keeper <= 32)) {
  console.error('usage: setup-gas-pool.mjs --gas <account> --contract <contract> [--page 0-32] [--keeper 0-32] [--allowance NEAR] [--keeper-allowance NEAR]')
  process.exit(64)
}
const yocto = (s) => BigInt(Math.round(Number(s) * 1e6)) * 10n ** 18n
const pageAllowance = yocto(opt('allowance', '1'))
const keeperAllowance = yocto(opt('keeper-allowance', '2'))
for (const a of [pageAllowance, keeperAllowance]) {
  if (a <= 0n || a > 5n * 10n ** 24n) {
    console.error('allowance: more than 0 and at most 5 NEAR per key')
    process.exit(64)
  }
}

const pageKeys = Array.from({ length: page }, () => newKey())
const keeperKeys = Array.from({ length: keeper }, () => newKey())
const actions = [
  ...pageKeys.map((k) => addFunctionCallKeyAction({ publicKey: nearPublicKey(k), receiverId: contract, methods: RELAY_METHODS, allowance: pageAllowance })),
  ...keeperKeys.map((k) => addFunctionCallKeyAction({ publicKey: nearPublicKey(k), receiverId: contract, methods: RELAY_METHODS, allowance: keeperAllowance })),
]
const owner = new Signer(gasAccount, keyFromKeychain(gasAccount))
const r = await owner.send(gasAccount, actions)
if (r.failure) {
  console.error(`add keys failed: ${r.failure} (${r.hash})`)
  process.exit(1)
}
console.log(`added ${page} page and ${keeper} keeper function-call keys to ${gasAccount} for ${contract} (${RELAY_METHODS.join(', ')}); tx ${r.hash}, ${tg(r.gas)} Tgas`)

const pool = existsSync(poolFile(contract)) ? readJson(poolFile(contract)) : []
for (const k of pageKeys) {
  pool.push({ account: gasAccount, contract, methods: RELAY_METHODS, allowance_near: nearStr(pageAllowance, 2), public_key: nearPublicKey(k), private_key: nearSecretKey(k) })
}
if (page) writeSecret(`gas-pool-${contract}.json`, pool)
if (keeper) {
  const file = houseKeysFile(contract)
  const house = existsSync(file) ? readJson(file) : { v: 1, section, contract, members: {}, council: {}, keeper: [] }
  house.keeper = [...(house.keeper ?? []), ...keeperKeys.map((k) => ({ account: gasAccount, seed: seedHexOf(k) }))]
  writeSecret(`house-keys-${contract}.json`, house)
}

const onChain = await accessKeys(gasAccount, 'final')
const mine = onChain.filter((k) => k.access_key.permission.FunctionCall?.receiver_id === contract)
console.log(`${mine.length} function-call keys for ${contract} on chain; page secrets in .secrets/gas-pool-${contract}.json, keeper seeds in .secrets/house-keys-${contract}.json`)
const prev = (await import('./hat-tip-lib.mjs')).readDeploy()[section]?.gas ?? {}
recordDeploy(section, {
  gas: {
    account: gasAccount,
    methods: RELAY_METHODS,
    relay_keys: [...(prev.relay_keys ?? []), ...pageKeys.map((k) => nearPublicKey(k))],
    relay_allowance_near: nearStr(pageAllowance, 2),
    keeper_keys: [...(prev.keeper_keys ?? []), ...keeperKeys.map((k) => nearPublicKey(k))],
    keeper_allowance_near: nearStr(keeperAllowance, 2),
    relay_private_keys: `.secrets/gas-pool-${contract}.json (git-ignored; public by design, for web/js/config.js)`,
  },
})
recordTx(section, 'gas pool keys', { hash: r.hash, tgas: tg(r.gas), fee: nearStr(r.tokensBurnt), note: `${page} page + ${keeper} keeper keys` })
