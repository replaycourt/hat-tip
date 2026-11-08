# Hat Tip on testnet: the keyless launch

The final deployment went live on 2026-11-08: tUSD and the Hat Tip contract, both deployed from the wasm this repository records and then stripped of every access key, inside a Sputnik v2 DAO from the public factory with the demo policy of DESIGN.md and the factory's auto-update turned off. Round 1 began at 10:20:00 UTC; a round lasts 20 minutes (`round_ms` 1,200,000, the testnet launch value of `sim/params.json`). The staging runs before it are in [testnet-stage.md](testnet-stage.md); the public facts of the deployment are `deploy/testnet.json`, section `final`.

| | |
|---|---|
| Contract | `thanks.hat-tip.testnet`, code hash `ApXWMjk6wgykDyEdNAPBagSNYZHnvMwioQcqpykZKGQw` = base58 of `contract/WASM_SHA256` (`91e5f94a…4ab8`, 359,545 bytes) |
| tUSD | `tusd.hat-tip.testnet`, code hash `41kVaTjWBmhriofB8Q3QKzZNCWdE7TNqVhPiRe8eHFip` = base58 of `token/WASM_SHA256` (`2cc43cf6…46e1`); 1,000,000 tUSD minted to the DAO at init |
| DAO | `hat-tip.sputnikv2.testnet`, Sputnik v2 2.3.1 (code hash `AA4nA45vauiac3jdVwJTzSdUP3oj2r1fDaPAb2mHdgcH`), `get_factory_info().auto_update` = false |
| Access keys | none on the contract and none on tUSD: `view_access_key_list` returns `"keys":[]` for both |
| Lock | contract `3FSsP2Hcq81rxjeAm1Won8tSdW6VYedk2j59vk23q7xv` (block 276762765, 10:20:43 UTC); tUSD `CLaqUhBJMMfWzeRoyCmmE42qGpSArK3inASpnn3LzDED` (block 276762758, 10:20:39 UTC) |
| Relay | `hat-tip-gas.testnet`: 8 page keys (published in `web/js/config.js`) and 3 keeper keys, function-call keys for `thanks.hat-tip.testnet` that may only call `act`, `close_round`, `pay`, `check_payout`, `sync` |
| House | `ana`, `ben`, `cleo`, `dina`, `emil` (honest), `finn`, `gus` (labelled colluding pair), `hugo` (labelled free rider), `council-a`, `council-b`, `council-c`, all `.hat-tip.testnet`, each with one function-call key (members: `allocate`, `note` on the contract; council: `act_proposal` on the DAO) |

Anyone can repeat the key check:

```
curl -s https://test.rpc.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_access_key_list","finality":"final","account_id":"thanks.hat-tip.testnet"}}'
```

## How it ran

Every step is one of the scripts in `scripts/` with `--section final`; each records its transactions in `deploy/testnet.json`.

```
node scripts/accounts.mjs faucet hat-tip.testnet --section final          # and hat-tip-fund-3 ... -7
node scripts/accounts.mjs fund --from hat-tip-fund-3.testnet --to hat-tip.testnet --near 9.95 --section final   # ... -7, and the staging root
node scripts/accounts.mjs create --root hat-tip.testnet --section final --token-near 2.5 --member-near 0.7 --council-near 1.5 --key-allowance 2
node scripts/create-dao.mjs --root hat-tip.testnet --section final --deposit 6 --top-up 29 --auto-update-off
node scripts/deploy.mjs token --root hat-tip.testnet --section final
node scripts/deploy.mjs contract --root hat-tip.testnet --section final
node scripts/setup-gas-pool.mjs --gas hat-tip-gas.testnet --contract thanks.hat-tip.testnet --page 8 --keeper 3 --allowance 1 --keeper-allowance 5 --section final
scripts/judge-checks.sh; python3 scripts/compare-wasm.py <build> --deployment contract (and token)   # before the lock
node scripts/deploy.mjs token --root hat-tip.testnet --section final --lock-only
node scripts/deploy.mjs contract --root hat-tip.testnet --section final --lock-only
node scripts/house.mjs export-secret --section final
```

Before the keys were deleted, the chain matched the plan: both code hashes equal `WASM_SHA256`, `compare-wasm.py` found both deployed modules byte-identical to the builds, `config()` equals the testnet block of `sim/params.json` field by field (with `dao`, `token`, `genesis_ms` 1794133200000), the DAO's `get_policy` equals the demo policy, auto-update is off, the contract was synced (8 members, 3 council, bond 0.01 NEAR, not paused), tUSD's whole supply sits in the DAO, and `judge-checks.sh` failed only checks 1 and 2 (the keys still there) and 12 (no payout yet). `deploy.mjs --lock-only` checked everything again and deleted the keys only then.

## Transactions

| Step | Tx | Tgas |
|---|---|---|
| Faucet `hat-tip.testnet` (10 NEAR) | `XXbjpb4jkgb8ZDkgBJANn7FnPkPVKAmCHu1VSPsu8KX` | |
| Faucet `hat-tip-fund-3` … `-7` (10 NEAR each) | `4cCCgWC16x8PrpHAzxXAqTWchmdd2QC9ML7nUuCWHeWK`, `5wzoLh73BFYm37LQhhkon7eajvBiKk9BWSnMaU4HzxjR`, `BwBA3sDUHRcG839BXW2yBnVjqrNP9uMbRog4A7Ak3eV8`, `ENR6WUZTZ3xb5jYJUUyqru2QH9pG6AUVaumZH2STYwHT`, `GauFJKeCD2uYD6bYgwjBcYVddQXnMFRYwqLk4JbBvYw` | |
| 9.95 NEAR from each funder to the root | `C5jUpoiTBkKDSgEBxhskQNBPV4Bq76TmuzFWX6CmLY2s`, `PuVKdLxjYxj8YN928HQEQx57iybZNXAypEnLf1NcryG`, `BgndD7dkzEBjAXDZayBHagtNbXfQ8Gy5pB9HskdGJdnB`, `5WQNvtEkMyoAg5RB6GUfyqvLajJ1gLkGzoaDyZBK47tL`, `3nFq5i4K2VU9vkRP8gGy6KqUQqQuGL7Rq9vngbDSzTZS` | 0.44 each |
| Spare staging NEAR: 5.3 from `hat-tip-stage.testnet` to the root, 5 from `thanks.hat-tip-stage.testnet` to the gas account | `D1FqsdQgQgQvSmMeMP87UfqanSFozpPSJpqQdcnM9JvJ`, `GzYXpoCX3sfkQJHQsSMHdRbUU5Xvt5cZoorQFT3Dzjbj` | 0.44 each |
| Create `thanks.hat-tip.testnet` (11 NEAR) and `tusd.hat-tip.testnet` (2.5 NEAR) | `BEi4nZm5Nf4zFY2pQZqTj34EMNFx6kDMcayAHfQaBGaz`, `126Z1rLPhh747w7SgbWckfw4fJgnSwB5V7b92ELJFQWU` | 8.34 each |
| Create the house members (0.7 NEAR each) and the council (1.5 NEAR each), each with its function-call key | ana `84uJ18e6bvsJKRymetWHYaMoGZeGWniRzi99E38NY5Qo`, ben `2KiAzoXV9Y8hJUhaG6h1dRC7VrKSmFHsEgzw2XbCzx59`, cleo `EJCjzTs8on75RyNF5q7h9dcUs5j7MPBorhaWabenJxFC`, dina `3xE1EWqxZsAuYPv7erPsrh44Dd5ydpPSjnd1GmCVXKVX`, emil `HPHaGGg8LNfC5mYtgMRZ4nBpkRfpiRhbWUEh99p78nDB`, finn `5vyPkXoQsDGwpRjr4VzCfe1VRnixoLCkXQa9r3u3Rr1q`, gus `7iyZV2iycW2bwGxf5tHsQ8mw1oDmmJLbusWdnQh3jvCh`, hugo `DFH26V3PHLrU4iDXQA7s1QCja9UFkgwAmchWYag9xx6X`, council-a `DUYoP1GyiU74FxoS2TrQa2AfaixZ59hrSVBp7k2Y674a`, council-b `C36pXtPQUw7hhfBGFnDmJHNQyRoL3if6BM7diU9oYsnL`, council-c `7vqMvgbStERTWpT8kHFzq48aD8D4BgWM86s2nYA6KVSi` | 8.55 each |
| Create the DAO (6 NEAR) | `7L74Nhy14y4sy1jrL5oQ1w2qNKKqgB9CcXChCc5XS1q2` | 89.24 |
| 29 NEAR to the DAO for proposal storage | `HohuDv53w6rqmjC7dpjS9NJBC7Spnf2Gwx4EPDvVEKKq` | 0.44 |
| Auto-update off: council-a files `FactoryInfoUpdate` (DAO #0), council-a and council-b approve | `Fw4s86RZ4sAdGDP6RuiKfxHyA2Kztfi4krDXQ8KARLBG`, `DMPevEz83Ne1LyCKnPkHZw2vq2Dwx4umQtsV7YSewoRL`, `BqDHAfLm8trtNKwpWgvziVYBMZuzFc45htpzykxTaaLG` | 2.54, 2.72, 3.55 |
| 5 NEAR from the root to the gas account | `CughNCcX5drS3D8APyR9sY6R3MAz3CisA4zof5Rx3auc` | 0.44 |
| Deploy tUSD and `new` | `DHhXPW3rBCJqBu5dYHy7fe94XCmduDUAJi4rssh9cnyU` | 14.55 |
| Deploy the contract and `new(config)` (round 1 at 10:20:00 UTC) | `9vWXckVuNoJavfiFJj2Rvd8CY6vCKAZa5gS1CUmr5Rbe` | 27.97 |
| First `sync()` | `BwNrena544uUUDwdngJXCoS4sP42xeSzZy91rYem93BB` | 7.34 |
| Relay keys: 8 page, 3 keeper | `BVpsWfDSqwAzwudKNEZYLvAv9Rz53r65oPQheQre9fNq` | 2.46 |
| **Lock tUSD**: delete its only key | `CLaqUhBJMMfWzeRoyCmmE42qGpSArK3inASpnn3LzDED` | 0.40 |
| **Lock the contract**: delete its only key | `3FSsP2Hcq81rxjeAm1Won8tSdW6VYedk2j59vk23q7xv` | 0.40 |

## Funding and how long it lasts

The demo runs until 2026-11-25: about 1,224 rounds of 20 minutes from the launch. Costs per round measured on staging ([testnet-stage.md](testnet-stage.md#gas-measured)): keeper 0.0105 NEAR, council 0.0034, members 0.0032, and about 0.0038 NEAR of DAO storage per payout (about 6 payouts a round).

| Account | At launch | Spends | Lasts |
|---|---|---|---|
| DAO `hat-tip.sputnikv2.testnet` | 35 NEAR (5.4 held for its code) | about 0.023 NEAR a round of proposal storage | about 29.6 NEAR free: about 1,290 rounds, past 2026-11-25 |
| Contract `thanks.hat-tip.testnet` | 11 NEAR (`contract_near`; 3.6 for the code) | its state (about 2,300 bytes a round, `log_keep` 108 rounds: about 2.5 NEAR at most), bonds it gets back, 0.00125 NEAR per new receiver | refuses guests below 1 NEAR free; anyone can send it NEAR |
| Gas account `hat-tip-gas.testnet` | 19.3 NEAR (9.5 before, +5 from the staging contract, +5 from the root) | keeper about 12.9 NEAR to 2026-11-25; page relays what visitors cause | to 2026-11-25 with about 6 NEAR for the page |
| House members | 0.7 NEAR each | about 0.0005 NEAR a round (note and thanks) | about 0.6 NEAR to 2026-11-25 |
| Council members | 1.5 NEAR each | about 0.0011 NEAR a round each | about 1.4 NEAR to 2026-11-25 |
| tUSD `tusd.hat-tip.testnet` | 2.5 NEAR (1.7 for its code) | registrations are paid by the registering account | - |
| Root `hat-tip.testnet` | 1.34 NEAR left | - | reserve |

**Relay allowances.** Page keys: 1 NEAR each. A key must prepay its dearest call (`pay`, 300 Tgas = 0.3 NEAR at the pessimistic gas price of 10^9 yocto per gas, docs/testnet-probe.md) and keeps about 0.7 NEAR for burnt gas, which returns unused prepaid gas to the allowance: about 1,400 relayed calls per key at 0.0005 NEAR. Eight keys cap what a script draining the page relay can burn at 8 NEAR. Keeper keys: 5 NEAR each, three of them (15 NEAR), above the keeper's 12.9 NEAR to 2026-11-25. All keys draw on the gas account's balance; `house.mjs` reports when it or any allowance runs low.

`deploy/testnet.json` (`final.funding`, `final.gas.allowances_why`) records the same.

## The first rounds

`scripts/house.mjs run --section final --rounds 3` ran locally right after the lock (keys from the environment only), 10:21 to 11:23 UTC: 102 transactions, none failed or refused. Rounds 1-3 closed with 16 payouts, all filed in the DAO by the keyless contract: 3 in tier 2 (one council vote each), 13 in tier 3 (two votes each), 340.91 tUSD paid; the council's published rule rejected gus's tier-3 payout of round 2 (16.44 tUSD, "only 2 givers behind it"), with its strike. Every paid payout was booked on the second `check_payout` of its `Approved` proposal. No tier 1 yet: it needs 200 thanks of reputation, which the first members reach after a few rounds. The events of all transactions rebuild every reputation exactly (`house.mjs summary`), and `audit()` is balanced. From now on `.github/workflows/house.yml` keeps the house running, with the final `HOUSE_KEYS` secret.

| Path | Transactions |
|---|---|
| close of round 1 | `B1o9KZQtpwZAJFFmAkKJGtJrEZEiqCsrZ4LNYmyQktR6` |
| tier 3, ana, DAO #1: two votes, then paid | `3EkQL42pWZKqxb8SsEDtf9LmLYBjrHJ1eqZdEF9HAoGi`, `CEsspTSr87WsUAfQoTgrs39f9rUPLx57LMBFUL5LtUDC`; check `Fgpi5zoMEXy88sbGbCrizDyun6gZSrYCvhnet3L4K86r` |
| tier 2, dina, DAO #4: one vote, Approved noted, then paid | `HWqF8TwFMpYpBou1yYogmphbxQmogxkvpjtA8bRrRAu5`; checks `E77Bg8Wt8kSxDWKKkte4K1Y5BYK4PHAyaLmb9LUYXCHh`, `CYwpLHZeKczgfuRUidmQLVzfrTwqBmtK6mGv1YGjGc6c` |
| tier 3 rejected, gus, DAO #11 | check `rejected` + `struck` `FES7kqe6RPn9mi1Snv1igx78yTkunmcSfmPpqypjTepj` |

## Checks after the launch

`python3 scripts/compare-wasm.py contract/target/near/hat_tip.wasm --deployment contract` and the same for tUSD: byte-identical. `scripts/judge-checks.sh` (read 2026-11-08, 11:24 UTC):

```
Hat Tip (final): read-only checks of thanks.hat-tip.testnet, tusd.hat-tip.testnet and hat-tip.sputnikv2.testnet at block 276769163
RPC: https://test.rpc.fastnear.com, fallback https://near-testnet.drpc.org
PASS  1. thanks.hat-tip.testnet has no access keys
PASS  2. tusd.hat-tip.testnet has no access keys
PASS  3. code hash of thanks.hat-tip.testnet = contract/WASM_SHA256
PASS  4. code hash of tusd.hat-tip.testnet = token/WASM_SHA256
PASS  5. DAO policy: the three tiers exactly (council of 3)
PASS  6. DAO policy: no Everyone role
PASS  7. DAO policy: call:AddProposal only in role thanks
PASS  8. DAO factory auto-update off
PASS  9. audit(): balanced, attributed, statuses, ids, carry (16 payouts)
PASS  10. the last close is less than two rounds old (round 4)
PASS  11. config(): dao = hat-tip.sputnikv2.testnet, token = tusd.hat-tip.testnet
PASS  12. a sample of the DAO's proposals matches payouts() (proposer, kind, receiver, amount, status) (16 payouts and DAO #0-#16, 16 by the contract)
PASS  13. relay keys only call act, close_round, pay, check_payout, sync (11 relay keys)
PASS  14. the DAO's code is one the factory sputnikv2.testnet publishes (version 3.31)
All 14 checks passed.
```
