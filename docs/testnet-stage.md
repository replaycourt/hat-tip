# Hat Tip on testnet: the staging deployment

Before the final keyless launch, the whole setup ran on a staging deployment on NEAR testnet: tUSD, the Hat Tip contract and a Sputnik v2 DAO from the public factory, with the demo policy of DESIGN.md, the eight labelled house members, the three house council members and the keeper, all driven by the scripts in `scripts/`. This file lists every account, what ran, the result per tier, the real gas, and the problems found. The machine-readable record is `deploy/testnet.json` (section `staging`, interface I-4) and `docs/testnet-stage.json` (every transaction of the house runs).

**Result: everything works end to end on the real chain, and no contract bug was found.** 28 five-minute rounds (2026-11-07, 12:55 to 15:18 UTC) and 744 transactions: the eight house members sent 202 notes and 163 allocations, three browser-style guests joined and gave thanks through the relay, the keeper closed every round, filed all 154 payouts in the DAO and recorded every outcome, and the house council voted 147 times. All three tiers paid through the DAO: **48 tier-1 payouts executed by the contract's own vote, 60 tier-2 payouts approved by one council vote, 39 tier-3 payouts approved by two council votes**; six payouts were rejected by the council's published rule (four tier 2, two tier 3) and one was removed in a staging test, each with its strike. `audit()` is balanced after every round, the events of all transactions rebuild every reputation exactly, and `scripts/judge-checks.sh --section staging` passes 11 of 11 checks. The only failed transactions (6) were the house script's own: `check_payout` with the 135 Tgas that `contract/README.md` names, where the contract asks for 140 ("Problems found", 1).

## Accounts

All on testnet. Keys: the legacy keychain `~/.near-credentials/testnet/` (mode 600) for the full-access keys; the house's function-call keys in the git-ignored `.secrets/house-keys-thanks.hat-tip-stage.testnet.json` (mode 600), which is also the value of the `HOUSE_KEYS` secret (`.secrets/github-secret-HOUSE_KEYS.txt`). No key is in the repository or in this file.

| Account | Role | Created | Funded | Keys |
|---|---|---|---|---|
| `hat-tip-stage.testnet` | root: creates the sub-accounts and the DAO | testnet faucet (NEAR CLI `sponsor-by-faucet-service`), tx `eYRAXbSbGLbTosZC3EDccpKSnBSUcSTJmXzGuy4bUFc` | 10 + 9.95 NEAR | full access |
| `hat-tip-fund-1.testnet` | funder: sent 9.95 NEAR to the root (tx `GBgPD3dWSNvLfiAK7ixPutsjCwmiX3sJrqZ1M6V5NPkG`) | faucet, tx `HSSW1B9g3TjJrHFVpYToTyfRXAE5sZSisbeExs6cFRCr` | 10 NEAR | full access |
| `hat-tip-gas.testnet` | gas account: the relay keys (page and keeper); will also hold the final deployment's | faucet, tx `FWpZ2m1QRH2PED1Ciq4JDpcpEhstQivVwDYwRXZEkHSC` | 10 NEAR | full access + 10 function-call keys |
| `thanks.hat-tip-stage.testnet` | the Hat Tip contract, DAO role `thanks` | root, tx `31ActW3r4nxtqofuzGRu6vcHBpyJQrAKW6q4eyT5pH7Q` | 5.5 NEAR | full access, kept (staging is not locked) |
| `tusd.hat-tip-stage.testnet` | tUSD | root, tx `4WJdCUXoQh5FU2hajMXBGPFftGedWiDrx6EXd2i9fj8m` | 3.0 NEAR | full access, kept |
| `hat-tip-stage.sputnikv2.testnet` | the DAO (factory `sputnikv2.testnet`) | root, tx `7hh29heRvAjfrg6UfZbv6RQRLeEf6dpF5iDAaSdLvgK` | 6 NEAR attached + 1.5 NEAR top-up (tx `AQchRh2mc84Je7brhwFSyLeWvBhVeUKPwoineRYpmWVe`) | none (a contract) |
| `ana`, `ben`, `cleo`, `dina`, `emil` `.hat-tip-stage.testnet` | house members, honest contributors | root, one tx each (below) | 0.25 NEAR each | full access + one function-call key: `allocate`, `note` on the contract, 0.25 NEAR allowance |
| `finn`, `gus` `.hat-tip-stage.testnet` | house members, labelled "demo: colluding pair" | root | 0.25 NEAR each | the same |
| `hugo.hat-tip-stage.testnet` | house member, labelled "demo: free rider" | root | 0.25 NEAR | the same |
| `council-a`, `council-b`, `council-c` `.hat-tip-stage.testnet` | house council (DAO role `council`) | root | 0.3 NEAR each | full access + one function-call key: `act_proposal` on the DAO, 0.25 NEAR allowance |

The eleven house accounts were created by `scripts/accounts.mjs create`, one transaction each (create, fund, full-access key, function-call key; 8.55 Tgas, 0.0071 NEAR): ana `Gjo9JstMfUztcuj2JVgj3q6qDpFyjo89xp4LJyZiqzXX`, ben `XhBrh1Et7oiyLfFa35dWKNtTGq2jAxa1tDagZBq6tqK`, cleo `CnzKciHRVmK4iBLHsZXmsvK3X1jxYKhuSZYrhPsdSw6S`, dina `Gr1kdgjTvx69mNnr1BjC66niqzUQ7moTqsof2J5HeyE8`, emil `8FNpRe6sgS36MUdBqJMm7wa93YwXQ2JgzaP2gAqVybzK`, finn `56V2ZVrveDzYcm4XnBPWjmmdzCZwa1mDeg9mwMs1qx2z`, gus `5cQp1qrMUHXy1NPHyREfqP4ScbMczruiH5DPAaK6Hf9a`, hugo `nCqDtYmF4KbroAPgquPX7v7zd3hx9of1DB8XK9PhdLU`, council-a `GVfpkCGJtamWpegbUSk44xWpv6KbaqKm46oQUDbvukWL`, council-b `2jwwaL1mFefpDETPM94qSPFHcGMxo1VxY2yHxCT4v9C6`, council-c `2zB8zycfKYcTuMtUSFzqRfXv9qNRa9nebN8QTsFb99fK`.

## What was deployed

| | |
|---|---|
| DAO | `hat-tip-stage.sputnikv2.testnet`, created by `sputnikv2.testnet.create` with 6 NEAR (89.27 Tgas, 0.0152 NEAR); code hash `AA4nA45vauiac3jdVwJTzSdUP3oj2r1fDaPAb2mHdgcH`, `version()` 2.3.1 (the factory default, the same code as the probe's DAO); 541,283 bytes |
| DAO policy | exactly the demo policy of DESIGN.md (`get_policy` compared in canonical form by `scripts/create-dao.mjs`): council = council-a/b/c, `thanks` = the contract, `members` = the eight house members, bond 0.01 NEAR, `proposal_period` 24 hours |
| Factory auto-update | turned off by a `FactoryInfoUpdate` proposal (DAO #0) that council-a filed and council-a and council-b approved: `get_factory_info()` = `{"factory_id":"sputnikv2.testnet","auto_update":false}`. Txs: proposal `99tntTEWZhVdBwQDPL3EQLmZTtRKBrEWne18bYzJcQWd`, votes `7uCQXzaF836Lgp2auaL3wPa8qqzwjaTaiGLSxmUE5fKf`, `GCEPyrz92LbCZFJZvEvBSKUbH2WzmtbuSJFN2LDV3wiT`. This is a launch step, run once on staging to see it work |
| tUSD | `tusd.hat-tip-stage.testnet`, code hash `41kVaTjWBmhriofB8Q3QKzZNCWdE7TNqVhPiRe8eHFip` = base58 of `token/WASM_SHA256` (`2cc43cf6...6e1`, 167,062 bytes, rebuilt with `token/build.sh --check`). Deploy and `new(owner_id = the DAO, total_supply = 1,000,000 tUSD)` in one tx `HU613FXhoq7L3ujz1KJFfsTzvXHLn3NxWLEy8x24om5P` (14.54 Tgas). Checked: supply 1,000,000, all of it held by the DAO, the DAO registered, metadata as in `token/README.md` |
| Contract | `thanks.hat-tip-stage.testnet`, code hash `9o7sKeDvmHwKkMFXz3cVm36QP72aa6iCzy3DsGm1P3Xm` = base58 of `contract/WASM_SHA256` (`82adfa55...baf0`, 349,776 bytes, rebuilt with `contract/build.sh --check`). Deploy and `new(config)` in one tx `BjFqHqcRt4hDbuyB2DgdEnR9Vyb882R5HoJo6qTNftb5` (27.26 Tgas); first `sync()` `9hsttbPKhhkKG6U1tGHDQd6Fftobm5LFaMbYUzxSUogJ` (7.34 Tgas): 8 members, 3 council, bond 0.01 NEAR, unpaused |
| Config | the `testnet` block of `sim/params.json` as committed at deployment (including `guest_receive_cap_bp` 800) with one change: **`round_ms` 300,000 (5-minute rounds instead of 20)**, so that a two-hour run covers 24 rounds. Every other value is the launch value; `config()` was compared field by field. Round 1 began at `genesis_ms` 1794056100000 (2026-11-07 12:55:00 UTC) |
| Relay | `hat-tip-gas.testnet`: 8 page keys (1 NEAR allowance each) and 2 keeper keys (2 NEAR each), all function-call keys for `thanks.hat-tip-stage.testnet` limited to `act`, `close_round`, `pay`, `check_payout`, `sync`; one tx `cg1h9FK9EJbT3g286HGpzYcjJvuwF7u4A1iinmP8nTd`. Public keys in `deploy/testnet.json`; the page keys' secrets in `.secrets/gas-pool-thanks.hat-tip-stage.testnet.json` (public by design, for `web/js/config.js`), the keeper keys' in the `HOUSE_KEYS` value |
| Keys | the contract and the token keep their full-access keys: staging is not locked. `scripts/deploy.mjs` refuses `--lock` on the staging section |

## Scripts

All in `scripts/`, Node 20+ and no dependencies (`near-lite.mjs` from Bonfire); testnet accounts only; every key they make goes to the legacy keychain or the git-ignored `.secrets/` with mode 600, and none is printed. Each records what it did in `deploy/testnet.json` (`--section staging` or `final`).

| Script | What it does |
|---|---|
| `hat-tip-lib.mjs` | names of a deployment from its root account, `deploy/testnet.json`, transaction records with every receipt and event, seeded random streams, the strategies' `split` (a port of `sim/hat_tip_sim.py`) |
| `accounts.mjs faucet <account>` | a top-level account with 10 NEAR from the testnet faucet through the NEAR CLI |
| `accounts.mjs fund --from --to --near` | moves NEAR between two keychain accounts |
| `accounts.mjs create --root <root> --contract-near --token-near [--member-near] [--council-near] [--key-allowance]` | the sub-accounts: `thanks.`, `tusd.`, the eight house members and the three council members, each with a full-access key and (house) a function-call key |
| `create-dao.mjs --root <root> [--deposit 6] [--period-hours 24] [--top-up <NEAR>] [--auto-update-off]` | the DAO from `sputnikv2.testnet` with the demo policy, checked against `get_policy`; optionally turns the factory auto-update off through a council proposal |
| `deploy.mjs token\|contract --root <root> [--wasm] [--set f=v] [--genesis] [--lock\|--verify-only\|--lock-only]` | deploy and `new` in one transaction, the first `sync`, the checks above; `--lock` deletes every key after all checks passed (refused on staging) |
| `setup-gas-pool.mjs --gas <account> --contract <contract> [--page 8] [--keeper 2]` | the relay keys |
| `house.mjs run\|report\|export-secret\|summary` | the house (below), the balance report, the `HOUSE_KEYS` value, and the per-round summary with an event replay |
| `judge-checks.sh [--section final\|staging]` | 13 read-only checks (below) |

The staging deployment, step by step:

```
node scripts/accounts.mjs faucet hat-tip-stage.testnet
node scripts/accounts.mjs faucet hat-tip-gas.testnet
node scripts/accounts.mjs faucet hat-tip-fund-1.testnet
node scripts/accounts.mjs fund --from hat-tip-fund-1.testnet --to hat-tip-stage.testnet --near 9.95
node scripts/accounts.mjs create --root hat-tip-stage.testnet --contract-near 5.5 --token-near 3
node scripts/create-dao.mjs --root hat-tip-stage.testnet --deposit 6 --top-up 1.5 --auto-update-off
node scripts/deploy.mjs token --root hat-tip-stage.testnet --wasm <token/build.sh output>
node scripts/deploy.mjs contract --root hat-tip-stage.testnet --wasm <contract/build.sh output> --set round_ms=300000
node scripts/setup-gas-pool.mjs --gas hat-tip-gas.testnet --contract thanks.hat-tip-stage.testnet --page 8 --keeper 2 --allowance 1 --keeper-allowance 2
node scripts/house.mjs export-secret
node scripts/house.mjs run --rounds 24 --quiet 10 --guest 2,13 --seed <s> --log <file.jsonl>
bash scripts/judge-checks.sh --section staging
```

## The house

`scripts/house.mjs run` plays the house of `sim/params.json` ("house") on the chain, by the clock of the contract (round r runs from `genesis_ms + (r - 1) * round_ms`):

- **Notes** between 5 % and 30 % of the round: each member that works this round (chance `p_work` 0.9) posts what it fixed, `round(items_mean * lognormal(0, 0.4))` items ("fixed 4 kettles"); the free rider hugo posts a vague note every round and claims one item with chance 0.5 ("sorted a box of screws (1 item)").
- **Thanks** between 50 % and 80 % of the round: each working member reads the round from `round(n)` and calls `allocate`: 5 thanks to each of up to two guests who posted a note and gave thanks, then (the pair finn and gus) 25 to the partner, then the rest to the other house members in proportion to the items in their notes times `lognormal(0, 0.5)` noise, whole thanks, at most 25 each and 10 receivers, dropping anyone below 15 % of the top pick (`split` of `sim/hat_tip_sim.py`). hugo never gives thanks.
- **Keeper**, through its own relay keys: `close_round` (255 Tgas) as soon as a round is due, `pay(10)` (300 Tgas) while payouts are planned, and `check_payout` (140 Tgas) once the DAO proposal has an outcome.
- **Council**, at least two minutes after a tier-2 or tier-3 payout was filed, by the published rule (`council_decision` of `sim/hat_tip_sim.py`, on the round as `round(n)` records it): tier 2 gets one vote, approve unless more than half of the receiver's points came from one giver whom the receiver also thanked that round; tier 3 gets two votes, approve if at least three givers stand behind the points, else reject. Voters rotate by payout id. Votes attach 30 Tgas.
- **Reports**: the DAO's tUSD and free NEAR, the contract's free NEAR (bond float), the gas account, the keeper keys' allowances and every house account's balance and key allowance; a `LOW` line (a `::warning::` in GitHub Actions) when one runs low.

Every key it signs with is a function-call key, checked on chain at start; a full-access key is refused. Three flags exist only to exercise paths on staging: `--quiet k` (on the run's k-th round the five honest members skip, their one-in-ten skip all at once), `--guest k` (on the run's k-th round a fresh browser-style guest key joins with a note and gives its 100 thanks through the relay, as the page does) and `--remove k` (the first tier-2 payout of the run's k-th round gets one council `VoteRemove` instead of the rule).

`.github/workflows/house.yml` runs `house.mjs run --minutes 350` every six hours (Bonfire's `fire.yml` pattern) with the keys only from the secret `HOUSE_KEYS`; the deployment is the `section` named in that secret. Without the secret it logs "no house keys, nothing to do". The value for the staging deployment is in `.secrets/github-secret-HOUSE_KEYS.txt` (8 member, 3 council and 2 keeper function-call keys, 1,388 bytes); the secret itself is not set.

## The run

Three runs of `scripts/house.mjs`, all transactions in `docs/testnet-stage.json`:

| Run | Rounds | What | Transactions |
|---|---|---|---|
| smoke | 1-2 | `--rounds 2 --guest 1`, seed 20261107; stopped during round 2 after the six `check_payout` failures, so in round 2 only three members gave thanks | 46 |
| main | 3-26 | `--rounds 24 --first 3 --quiet 10 --guest 2,13`, seed 2026110713 (started at 13:03 and closed and checked rounds 1-2 with 24 transactions; restarted at 13:07 with fewer RPC reads, resuming round 3): 24 rounds, 0 failed, 0 refused | 24 + 648 |
| remove test | 28 | `--rounds 1 --remove 1`, seed 2026110715; round 27 was closed empty | 26 |

### Payouts by tier

| Tier | DAO proposal | Approved by | Payouts | Paid | Not paid |
|---|---|---|---|---|---|
| 1 | `Transfer` | the contract's own `VoteApprove` in the filing chain | 48 (31 %) | 48, 739.56 tUSD | - |
| 2 | `FunctionCall ft_transfer` | one council vote | 65 (42 %) | 60, 1,101.85 tUSD | 4 rejected by one `VoteReject`, 1 removed by one `VoteRemove` (test) |
| 3 | `Transfer` | two council votes | 41 (27 %) | 39, 1,216.16 tUSD | 2 rejected by two `VoteReject` |

Tier 1 starts in round 5 (ben, whose reputation passed 200 thanks first) and grows as reputation builds: in rounds 16-28 the mix is 52 % / 28 % / 20 % (36 / 19 / 14 of 69 payouts), against DESIGN.md's steady-state target of about 70 / 25 / 5. The sim's steady state starts at round 49; 28 rounds are early in it. After round 28 the honest members have 312-534 thanks of reputation (auto limits 18.66-30 tUSD); finn has 4 strikes, gus, hugo and cleo (the removal test) 1 each. Every round's budget was the full 120 tUSD; the DAO paid 3,057.57 tUSD and still holds 996,942.43.

Example transactions per path (more in `deploy/testnet.json`, `staging.evidence_txs`):

| Path | Transactions |
|---|---|
| close a round with allocations (r1): `get_policy` + `ft_balance_of` joined, `on_close`, events `round_closed`, `points`, `payout_planned` x6, `carry` | `EVJtH5aZ56bc4gZzYmsZwUznLvQcAtGmKYZbYnAp2tHk` |
| close an empty round (r27) | `Bt7LW48vFgf8xo2GqBzf8u2DmCmipa2vHqDDwKLYWVip` |
| tier 1: `pay` files three payouts, the tier-1 one (gus, r12, DAO #64) is approved by the contract and transferred in the same chain; `check_payout` records `paid` | `G4gSufPJgvmM2EKSecj8kj4njgg3n2hXqPChhGmPZ6Vm`, `9pNwn6guBzuGdbKSS9w12i7uXXt8rPw8Z6Af7CVcgbLL` |
| tier 2 approved: one council vote executes the `ft_transfer` (guest 9ff2c1c9, r4, DAO #21), check `paid` | `BXaba7A14xDfBjzctzLe1SoiAtuhn6PuBffwRWbzK1VX`, `6x6KoYiQPfeySHHeRcQF5uv2KzMr3aYP2cHuLeAWXKhE` |
| tier 2 rejected: finn r12, "gus gave more than half of the points and was thanked back"; one `VoteReject`, check `rejected` + `struck` | `2D2LPmDd4HL13F6UeA4zydKbmfq3AcqGH3vbjNEgb4SE`, `BYs7RPocVYTiWd6LewYDq2rVPgXfB8DSagMU8haHCtf8` |
| tier 3 approved: ana r1, first vote leaves it open, the second executes it, check `paid` | `GkVrTavePMekFEqWesJUq1QQm9YJTgda4FGgFqCHcPsM`, `8eMiTd69e5svSE2ubw1bTNRgS1Y3PvbUF2FmkW97S5F3`, `9coRuPkpepjJyBFWaXidTTTg9RoTHELrmoQDMVBXhrjt` |
| tier 3 rejected: the free rider's 96.01 tUSD in the quiet round 12 ("only 2 givers behind it"), two `VoteReject`, check `rejected` + `struck` | `3NRAL84pZFYDsvH2cWaobFS8m36vt6F1d2pVBJjeEEBZ`, `73tNMcRvV6ytMLUuzqg3BHWuSUDpA3U58bxQpdpASUaV`, `5E1Qczw73TbB94XqvG3UV58EN5dpTihTwTLADkd8sjVb` |
| removed (test): one council `VoteRemove`, the DAO deletes the proposal, `check_payout` reads `[]` from `get_proposals` and records `removed` + `struck` | `7fHFJi2e7hepzdzJkmafkgB7te2JY32dBSdLCYfPPQRY`, `ARApvmDHctxbtLSfYfhL28HCm86QQaVQSmFNMB5bVpGC` |
| guest: `act` join with a note and `act` allocate, relayed by a keeper key; the contract registers the implicit account with tUSD before filing; one council vote pays it | `8khdJg8Xr9NcJ8yLoGXhyERNvDsLPM2qvBmZzZQb4oKN`, `BDz2iCfGtrkJPss6jfoH7Ev6XGxEJR4xRR21HNznJwY7`, check `AQ7AjBbwswexAN2qd4UrP1tAVaEyWFE84JxcignUK9Jd` |

**Rejections and strikes (7).** All six rejections came from the published rule, none was forced: round 2 (finn tier 2, emil as the reciprocal top giver; gus tier 3 with two givers; both in the round the smoke run left with three givers), round 11 (finn tier 2, ben as the reciprocal top giver), round 12, the quiet round (finn tier 2 from gus; hugo's 96.01 tUSD tier 3 with two givers), round 21 (finn tier 2 from gus). The seventh strike is the removal test of round 28. In the quiet round gus's 12.00 tUSD went out in tier 1, from finn's thanks alone: the council cannot stop a tier-1 payout, as DESIGN.md says; the auto limit (17.76 tUSD for gus after the round) bounds it.

**Guests.** Three fresh browser keys (rounds 1, 4, 15) joined with a note and gave 100 thanks to members through the relay. The house members welcomed each with 5 thanks; all three were paid in tier 2 after one council vote: `1d9c5c10...` 5.19 tUSD, `9ff2c1c9...` 5.80, `3ae885e9...` 9.60 (`ft_balance_of` on tUSD), each registered with the token by the contract before filing (`storage_deposit` -> `on_registered` in the `pay` chain). Their accounts do not exist as NEAR accounts; the token holds their balance.

**Events and audit.** The 744 transactions logged 205 `note` (202 by members, some of them re-sent when the main run resumed round 3, and 3 with a guest's `join`), 3 `joined`, 166 `allocated`, 28 `round_closed`, 27 `points`, 154 `payout_planned`, 28 `carry`, 154 `filed`, 48 `approved`, 147 `paid`, 6 `rejected`, 1 `removed` and 7 `struck` entries. `house.mjs summary --log ...` replays them (`round_closed` decays every record once, `points` adds, `struck` subtracts) and gets every reputation of `member()` exactly, for all 11 accounts with a record (8 members, 3 guests), and every strike's `reputation` field. `audit()` after round 28: balanced (budgets 3,240 tUSD = planned 3,236.499325 + carry 3.500583 + dust 0.000092), points attributed, statuses, ids and carries all true; 154 payouts: 147 paid, 6 rejected, 1 removed, none open.

### Rounds

The receiver, tUSD, tier (t1-t3), outcome and DAO proposal id of every payout; givers = accounts whose thanks counted in the round.

| Round | Givers | Budget (tUSD) | Payouts: receiver, tUSD, tier, outcome, DAO proposal |
|---|---|---|---|
| 1 | 7 | 120 | guest 1d9c5c10… 5.187339 t2 paid #1; ana 20.864633 t3 paid #2; ben 26.167247 t3 paid #3; cleo 22.247924 t3 paid #4; emil 24.783956 t3 paid #5; finn 19.711891 t3 paid #6 |
| 2 | 3 | 120 | ben 87.168758 t3 paid #7; finn 7.336122 t2 rejected #8; gus 15.565132 t3 rejected #9 |
| 3 | 7 | 120 | ana 20.994698 t3 paid #10; ben 22.018348 t2 paid #11; cleo 13.746901 t2 paid #12; dina 20.036697 t3 paid #16; emil 14.867592 t2 paid #13; finn 11.779816 t2 paid #14; gus 10.78899 t2 paid #15; hugo 16.733944 t3 paid #17 |
| 4 | 6 | 120 | guest 9ff2c1c9… 5.795365 t2 paid #21; ana 21.297968 t3 paid #18; ben 47.521998 t3 paid #19; emil 37.669876 t3 paid #20 |
| 5 | 7 | 120 | ana 27.145242 t3 paid #22; ben 11.819699 t1 paid #23; cleo 21.63606 t3 paid #24; dina 16.518599 t2 paid #25; emil 18.230383 t2 paid #26; finn 10.412149 t2 paid #27; gus 21.952653 t3 paid #28 |
| 6 | 6 | 120 | ana 22.106838 t2 paid #29; ben 18.932523 t2 paid #30; dina 17.00526 t2 paid #31; emil 33.33031 t3 paid #32; gus 7.482314 t2 paid #33; hugo 19.952838 t3 paid #34 |
| 7 | 7 | 120 | ana 23.623395 t2 paid #35; ben 30.898716 t3 paid #36; dina 20.370898 t2 paid #37; emil 6.84736 t1 paid #38; finn 13.087203 t2 paid #39; gus 6.676176 t2 paid #40; hugo 14.721825 t2 paid #41 |
| 8 | 6 | 120 | ana 12.590582 t1 paid #42; ben 40.050042 t3 paid #43; cleo 28.946397 t3 paid #44; dina 15.468429 t2 paid #45; gus 24.341792 t3 paid #46 |
| 9 | 6 | 120 | ana 35.436317 t3 paid #47; cleo 19.586619 t2 paid #48; dina 19.3289 t2 paid #49; emil 19.640515 t2 paid #50; gus 25.771867 t3 paid #51 |
| 10 | 7 | 120 | ana 23.565203 t2 paid #52; ben 23.939254 t2 paid #53; cleo 15.52311 t2 paid #54; dina 19.918207 t2 paid #55; emil 20.479283 t2 paid #56; gus 15.990673 t2 paid #57 |
| 11 | 6 | 120 | ben 23.875647 t1 paid #58; cleo 34.196891 t3 paid #59; dina 24.870466 t2 paid #60; finn 15.578846 t2 rejected #61; gus 24.497409 t2 paid #62 |
| 12 | 2 | 120 | finn 11.996927 t2 rejected #63; gus 11.996927 t1 paid #64; hugo 96.006144 t3 rejected #65 |
| 13 | 7 | 120 | ana 20.976377 t2 paid #66; ben 24.850393 t2 paid #67; cleo 20.881889 t2 paid #68; dina 24.566929 t2 paid #69; emil 5.430867 t1 paid #70; finn 14.929133 t2 paid #71; gus 9.732283 t1 paid #72 |
| 14 | 7 | 120 | ana 24.647392 t2 paid #73; ben 14.193828 t1 paid #74; cleo 20.3317 t2 paid #75; dina 21.866168 t2 paid #76; emil 13.042977 t1 paid #77; gus 25.318721 t2 paid #78 |
| 15 | 8 | 120 | guest 3ae885e9… 9.599042 t2 paid #83; ana 25.026588 t2 paid #79; ben 31.706992 t3 paid #80; cleo 11.366657 t1 paid #81; dina 9.173092 t1 paid #82; emil 24.428343 t2 paid #84; gus 7.876894 t1 paid #85 |
| 16 | 7 | 120 | ana 23.374824 t1 paid #86; ben 28.665422 t1 paid #87; cleo 14.525096 t1 paid #88; dina 17.699455 t1 paid #89; finn 13.253297 t2 paid #90; gus 23.567209 t2 paid #91 |
| 17 | 6 | 120 | ana 26.301485 t1 paid #92; ben 36.164542 t3 paid #93; cleo 46.027599 t3 paid #94; gus 9.863056 t1 paid #95 |
| 18 | 6 | 120 | ana 30.00015 t3 paid #96; cleo 14.10007 t1 paid #97; dina 34.500172 t3 paid #98; emil 9.557989 t1 paid #99; finn 30.821808 t3 paid #100 |
| 19 | 5 | 120 | ana 17.321739 t1 paid #101; ben 20.869565 t1 paid #102; cleo 19.2 t1 paid #103; dina 20.869565 t1 paid #104; finn 5.217391 t2 paid #105; gus 38.021146 t3 paid #106 |
| 20 | 5 | 120 | ana 34.285938 t3 paid #107; dina 14.693973 t1 paid #108; emil 48.979911 t3 paid #109; gus 19.591964 t2 paid #110 |
| 21 | 7 | 120 | ana 28.074627 t2 paid #111; ben 38.060903 t3 paid #112; cleo 26.284634 t2 paid #113; emil 16.015726 t1 paid #114; finn 6.028196 t2 rejected #115; gus 6.21787 t1 paid #116 |
| 22 | 5 | 120 | cleo 20 t1 paid #117; dina 36.295201 t3 paid #118; emil 30 t2 paid #119; finn 15 t2 paid #120; gus 20 t2 paid #121 |
| 23 | 7 | 120 | ana 26.759259 t1 paid #122; ben 16.296296 t1 paid #123; cleo 6.111111 t1 paid #124; dina 23.703703 t2 paid #125; emil 16.203703 t1 paid #126; finn 10.277777 t2 paid #127; hugo 17.896982 t3 paid #128 |
| 24 | 7 | 120 | ana 26.812816 t1 paid #129; ben 30.354131 t3 paid #130; cleo 13.456998 t1 paid #131; dina 23.473861 t2 paid #132; emil 8.600337 t1 paid #133; finn 5.767284 t2 paid #134; gus 16.256791 t1 paid #135 |
| 25 | 7 | 120 | ana 24.184689 t2 paid #136; ben 24.184689 t1 paid #137; cleo 10.615417 t1 paid #138; dina 16.153895 t1 paid #139; emil 16.430819 t1 paid #140; gus 14.769276 t1 paid #141; hugo 12.923116 t2 paid #142 |
| 26 | 7 | 120 | ana 16.208053 t1 paid #143; ben 27.281879 t1 paid #144; dina 10.268456 t1 paid #145; emil 24.563758 t2 paid #146; finn 22.382389 t2 paid #147; gus 15.604026 t1 paid #148 |
| 28 | 5 | 120 | ana 14.002333 t1 paid #149; ben 19.883313 t1 paid #150; cleo 26.413193 t2 removed #151; dina 6.441073 t1 paid #152; finn 27.864644 t3 paid #153; hugo 26.324387 t3 paid #154 |

## Gas, measured

Gas burnt by the whole transaction (all receipts), median over the runs, with the gas each call attaches:

| Call | Attached | Burnt (median, range) | Fee (NEAR) | n |
|---|---|---|---|---|
| `note` (member, own function-call key) | 15 | 2.31 (2.23-2.59) | 0.00023 | 196 |
| `allocate` (member) | 30 | 2.53 (2.37-2.70) | 0.00025 | 158 |
| `act` join with note / allocate (guest, relayed) | 30 | 3.06 / 2.98 | 0.00031 / 0.00030 | 3 / 3 |
| `close_round`, a round with allocations | 255 | 14.56 (12.24-15.76); `on_close` itself 7.25 (4.99-8.44) | 0.0014 | 26 |
| `close_round`, an empty round | 255 | 3.07 | 0.0003 | 1 |
| `pay`, per payout filed (tier 2 or 3, receiver registered) | 300 per call | about 6 (`add_proposal` 2.21, `on_filed` 2.00) | 0.0006 | |
| `pay`, per tier-1 payout (file, the contract's vote, `ft_transfer`, the DAO's callback, `on_voted`) | | about 18 (19.45 for a call with one) | 0.0018 | |
| `pay`, first payout to a receiver (adds `storage_deposit` 1.53, `on_registered` 2.79) | | about 11 for tier 2 or 3 | 0.0011 | |
| `check_payout` -> `paid` / `rejected` + `struck` / `removed` + `struck` | 140 | 7.42 / 7.53 / 7.31 | 0.0007 | 142 / 6 / 1 |
| council vote that executes the transfer (tier 2, second tier-3 vote) | 30 | 8.77 (8.77-8.83) | 0.00081 | 97 |
| council vote that does not execute (first tier-3 vote, reject without bond return, remove) | 30 | 2.74; a reject that returns the bond 3.45 | 0.00027-0.00032 | 45 |

A whole payout, filed and decided: tier 1 about 25 Tgas (0.0025 NEAR), tier 2 about 22, tier 3 about 25. One round of the house (8 members, about 6 payouts) burnt about 0.017 NEAR: keeper 0.0105, council 0.0034, members 0.0032 (0.476 NEAR for all 744 transactions). The static gas budgets of `contract/README.md` are far above what is burnt (`on_close` gets 180 Tgas and burns 5-8.5 for 8 members), as intended; 255 Tgas for a close and 300 for `pay` were always enough.

## Costs and budget

| | NEAR |
|---|---|
| Faucet accounts used | 3 of the budgeted (30 NEAR): `hat-tip-stage`, `hat-tip-gas`, `hat-tip-fund-1` |
| Held by all staging accounts after the run | 29.41 |
| Burnt (gas of setup and 744 house transactions) | about 0.59 |
| Locked as storage: DAO 600,915 bytes, contract 415,815, token 168,588 | 6.01, 4.16, 1.69 |
| Left free: root 0.94, gas account 9.71, DAO 1.50, contract 1.31, token 1.32, house accounts 0.24-0.27 each | |

Per round on chain: the DAO's storage grew 59,632 bytes for 155 proposals (about 385 bytes, 0.0038 NEAR, per payout including its votes); the contract's state grew about 2,300 bytes a round (it keeps `log_keep` = 108 rounds); one removed proposal kept its 0.01 NEAR bond in the DAO.

## Problems found

1. **`check_payout` needs 140 Tgas, not 135.** `contract/README.md` ("Gas": "Attach ... `check_payout` 135"; under "Outcomes": "Needs 120 Tgas attached") and `web/js/config.js` (`CHECK_GAS = 135_000_000_000_000n`) name too little: the contract checks that 135 Tgas remain after its own use and panics `this call needs 140 Tgas` (its own message). Six calls failed this way in the smoke run (txs `CZpB1scPAx4gZygC93vJZuMopaAbYcRB2AbXBKjVksAf`, `DS4aLAeaU1B9uRU4XeNxRH5M5cfWoivvdfxsg2zCq7mi`, `7zv3WJjutZ73JEWgn59kZFoidLcGKuynETEDTJhQ8Xnj`, `8iiwT2voAYwp22QuPqaYriQRazY7e1mi5WZsXSHmX9Fh`, `BrgjLVjc4akebAwf8tbVv2qoaVn4zpLZiLFhH3pqUMuf`, `G6CTMpfcvDMq3Am1M8HqUBkZd5xNv2hQDp6wJSzMJyHq`); nothing changed on chain, and the next checks with 140 Tgas recorded them. The house script attaches 140. Not a contract bug; the README and the page's constant need 140.
2. **RPC limits.** FastNEAR's free endpoint answers HTTP 429 after about three quick calls from one address, and dRPC's free plan cuts a `send_tx` that waits for execution ("Request timeout on the free plan"). `near-lite.mjs` switches endpoints and retries, which held, but the first main run hit 429s constantly; the restarted run reads all open DAO proposals in one `get_proposals` call, reads tier-2/3 proposals only once the council may vote, and skips the receipt read for single-receipt calls. The page should expect the same limits per visitor.
3. **`curl --retry` in Bonfire's `judge-checks.sh` pattern.** Without `--fail`, a rate-limited answer and the retried one are concatenated into invalid JSON. Hat Tip's `judge-checks.sh` uses `--fail`, retries, falls back to dRPC and accepts only answers with a `result`. Bonfire's script has the same latent problem.
4. Small: a second `close_round` right after a close sometimes found nothing to do because the RPC node was a block behind (1.95 Tgas, harmless); `deploy.mjs` waits for the first `sync` to be final before it checks `state()`.

## For the launch

- Fund the house for 20-minute rounds until 2026-11-25 (about 1,080 rounds): per member about 0.0004 NEAR a round (0.45 NEAR in all), per council member about 0.0011 (1.2 NEAR), keeper about 0.0105 (11.3 NEAR on the gas account). Give the house function-call keys more allowance (`accounts.mjs create --key-allowance 1`): 0.25 NEAR lasts a member about 550 rounds.
- The DAO needs about 0.0038 NEAR of storage per payout, about 23 NEAR for 1,080 rounds of 5-6 payouts (`create-dao.mjs --top-up`); the contract about 2.5 NEAR of state at `log_keep` 108 plus its code (3.5) and a bond float.
- `deploy.mjs contract --root <final root> --section final --lock` and `deploy.mjs token ... --lock` delete the keys only after every check passed; `create-dao.mjs --auto-update-off` worked on staging.
- Set `HOUSE_KEYS` to the final deployment's value (`house.mjs export-secret --section final`); the staging value is in `.secrets/github-secret-HOUSE_KEYS.txt`.

## Read-only checks

`bash scripts/judge-checks.sh --section staging` after the run (2026-11-07 15:18 UTC):

```
INFO  1. thanks.hat-tip-stage.testnet access keys (staging keeps them): 1 access keys
INFO  2. tusd.hat-tip-stage.testnet access keys (staging keeps them): 1 access keys
PASS  3. code hash of thanks.hat-tip-stage.testnet = contract/WASM_SHA256
PASS  4. code hash of tusd.hat-tip-stage.testnet = token/WASM_SHA256
PASS  5. DAO policy: the three tiers exactly
PASS  6. DAO policy: no Everyone role
PASS  7. DAO policy: call:AddProposal only in role thanks
PASS  8. DAO factory auto-update off
PASS  9. audit(): balanced, attributed, statuses, ids, carry
PASS  10. the last close is less than two rounds old
PASS  11. config(): dao = hat-tip-stage.sputnikv2.testnet, token = tusd.hat-tip-stage.testnet
PASS  12. the last filed payouts match their DAO proposals (proposer, kind, receiver, amount, status)
PASS  13. relay keys only call act, close_round, pay, check_payout, sync
All 11 checks passed.
```

On the final deployment checks 1 and 2 count (0 access keys expected).



