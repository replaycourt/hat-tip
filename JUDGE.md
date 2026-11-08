# Judging Hat Tip in five minutes

Everything runs on NEAR testnet: the Hat Tip contract `thanks.hat-tip.testnet`, the token `tusd.hat-tip.testnet` and the Sputnik v2 DAO `hat-tip.sputnikv2.testnet` (launched 2026-11-08, [docs/testnet-launch.md](docs/testnet-launch.md)). You need a browser for the page, and bash, `curl` and `python3` for the checks. No account, wallet or install. A round lasts 20 minutes, so the path below shows the last close as a replay and your own thanks in the running round.

## 1. The five-minute path

Open https://replaycourt.github.io/hat-tip/web/ in Chrome 137+, Safari 17+ or Firefox 130+. Giving thanks sends real testnet transactions, paid by the public relay keys. The same path as a 90-second video: https://x.com/replaycourt/status/2119435604131795220.

1. **Open the page.** See the Repair Café's round board: *Round N*, the countdown *until round N closes*, *Budget* (120 tUSD), *The DAO holds*, *Thanks given*, *Guest seats*, and a card per member with this round's note and the thanks received so far. Every house member carries a *house bot* label: five honest helpers, the pair labelled "demo: colluding pair", the one labelled "demo: free rider", and the three council members.
2. **Look at *Payouts of round N*,** the last round that paid. Three columns: *Paid automatically* (tier 1), *Needs one council vote* (tier 2), *Needs a council majority* (tier 3). Each card names the DAO proposal; tap it and see the proposal read live from the DAO: its kind (`Transfer` or `FunctionCall ft_transfer`), receiver, amount and the votes (on a tier-1 payout only *the contract*'s own). Tap *Replay the close* to see the last close in five steps: thanks counted, budget split, proposals filed, tier 1 executed.
3. **Tap *Give your 100 thanks*.** No wallet prompt; the browser makes a key and takes a guest seat. Tap *+10* on a few cards and watch every card's payout preview and tier move as you go, once members have given this round (before that, a card says *Guest thanks count once members have given*: guests together steer at most 20 % of a round). Put thanks on finn or gus and read why counted differs from given (reciprocity, breadth).
4. **Write a note and tap *Send my thanks*.** *Your thanks are in.* The transaction is listed under *Proof*, *Your transactions*, with its gas, linked to the explorer.
5. **Open a member** (*rep … ›* on a card). See the reputation line over the rounds, each round's points with every giver behind them (given → counted), each payout with tier, DAO proposal and status (gus's record shows a payout the council rejected, with its strike), and the auto and co-sign limits for the next close.
6. **Open *Rules*, then *Proof*.** *Rules* renders the DAO's `get_policy` (the three tiers as the DAO states them) and the contract's `config()`. *Proof* shows the contract and the token with *0 access keys*, the transaction that locked the contract, both code hashes against `WASM_SHA256` in this repository, the policy checks, `audit()`, the relay keys and the methods they may call, and your transactions.

To see your own payout: after the close (at most 20 minutes) the house members' welcome thanks give you a tier-2 payout if they thanked you; a house council member votes on it at least two minutes after it is filed, and the tUSD shows in your browser account. The README walks through the same steps: [How to use it](README.md#how-to-use-it).

## 2. One-command checks (read-only, about 10 seconds)

```sh
scripts/judge-checks.sh
```

It needs bash, curl and python3 (macOS or Linux), sends no transaction, reads everything at one final block, and prints PASS or FAIL for each check. Its exit code is the number of failed checks (65: the final deployment is not in `deploy/testnet.json` yet; it then says "not launched yet"). A read that gets no answer from FastNEAR or the dRPC fallback fails its check; it never passes.

Expected (the final deployment, read 2026-11-08 at 11:24 UTC, after the first three rounds; `--section staging` checks the staging deployment, where checks 1 and 2 are INFO because staging keeps its keys):

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

| Check | What it shows |
|---|---|
| 1, 2 | `view_access_key_list` of the contract and of tUSD is empty: nobody can redeploy them, change a rule, mint tUSD or act as them. |
| 3, 4 | The chain's code hash, decoded from base58, equals `contract/WASM_SHA256` and `token/WASM_SHA256`. |
| 5 | The DAO policy states the three tiers exactly: role `thanks` is the contract alone with exactly `transfer:AddProposal`, `transfer:VoteApprove`, `call:AddProposal`, `transfer:Finalize`, `call:Finalize` and `transfer` 1 of 1; the council's `call` threshold is weight 1; the default policy is 1/2. |
| 6 | No `Everyone` role: nobody outside the roles can file anything. |
| 7 | Only role `thanks` holds `call:AddProposal` (or a wildcard covering it): every `call` proposal comes from the contract, so one council vote can approve those and nothing else. |
| 8 | `get_factory_info().auto_update` is false: the factory owner cannot replace the DAO's code. |
| 9 | `audit()`: budgets = planned + carry + lapsed + dust; every round's points equal their attributions; every payout has one status; every filed payout has a DAO proposal id; carries add up. |
| 10 | The oldest unclosed round is the current one or the one before: the rounds are being closed. |
| 11 | `config()` binds the contract to this DAO and this token. |
| 12 | The last 40 DAO proposals against the last 100 payouts, both ways: every proposal the contract filed belongs to a payout, and every payout's proposal was filed by the contract with its tier's kind, receiver, amount and a status that agrees. |
| 13 | Every function-call key on the gas account may only call `act`, `close_round`, `pay`, `check_payout`, `sync` on the contract; its one full-access key is not in the repository. |
| 14 | The DAO's code hash is one of the versions the factory `sputnikv2.testnet` publishes (`get_contracts_metadata`): an unmodified Sputnik v2. |

The same checks by hand, as curl one-liners: [Check it without an account](README.md#check-it-without-an-account). Checks 3 and 4 compare two numbers; that `WASM_SHA256` is the build of this source is shown by a rebuild: `cd contract && ./build.sh --check` (and `cd token && ./build.sh --check`) rebuild the wasm with cargo-near 0.22 and the toolchain pinned in `rust-toolchain.toml` and compare the sha256, and `python3 scripts/compare-wasm.py contract/target/near/hat_tip.wasm --deployment contract` (`token/target/near/tusd.wasm --deployment token`) compares the result with the code on chain, section by section. On the Intel Mac that built the deployed wasm, both rebuilds took about 4.5 minutes from a cold target directory and were byte-identical to the chain. CI repeats both rebuilds on every push on Linux, an Intel Mac and an arm64 Mac, reads the deployed code from the chain in the same job and fails on any difference. Its first run on the public repository ([run 42491248652](https://github.com/replaycourt/hat-tip/actions/runs/42491248652), 2026-11-08) found all six rebuilds byte-identical to the code on `thanks.hat-tip.testnet` and `tusd.hat-tip.testnet`.

## 3. Where each claim lives

Line numbers are at the deployed source (`contract/WASM_SHA256` `91e5f94a…4ab8`, the final build).

| Claim | Code | Tests | On chain (staging tx) |
|---|---|---|---|
| No owner, admin, upgrade or withdraw method | `new` is `#[init] #[private]`, `contract/src/lib.rs:87-89`; the export list, `contract/build.sh:118` and `token/build.sh:117` | `contract/tests/init.rs` | checks 1-4 |
| Every parameter fixed at init and checked | `Config::validate`, `contract/src/config.rs:166`; `config()`, `contract/src/views.rs:168` | `every_parameter_is_checked`, `the_launch_parameters_of_sim_params_json_are_accepted` in `contract/tests/init.rs` | check 11 |
| The hard rules of giving (100 thanks, cap 25, 10 receivers, no self, members and seated guests only, the clock's round) | `allocate`, `contract/src/lib.rs:119`; `member_gate`, `:214` | `every_hard_rule_refuses`, `membership_comes_from_the_last_sync` in `contract/tests/allocate.rs` | |
| Guests: signature, nonce, seats, weight and both caps | `act`, `contract/src/lib.rs:161`; `signing_message`, `:79`; `math::count`, `contract/src/math.rs:74` | `contract/tests/guests.rs` (9 tests) | join `8khdJg8Xr9NcJ8yLoGXhyERNvDsLPM2qvBmZzZQb4oKN`, allocate `BDz2iCfGtrkJPss6jfoH7Ev6XGxEJR4xRR21HNznJwY7` |
| Counting: reciprocity, breadth, guests' caps, every point attributed to a giver | `math::count`, `contract/src/math.rs:74`; the `points` event, `contract/src/close.rs:528` | `contract/tests/counting.rs`; `src/math.rs` unit tests | close `EVJtH5aZ56bc4gZzYmsZwUznLvQcAtGmKYZbYnAp2tHk` |
| The contract closes rounds exactly like the simulation | `close_counted`, `contract/src/close.rs:314`; the model `Hat` in `sim/hat_tip_sim.py` | `contract/tests/golden.rs` (6 vectors, 61 rounds); `web/test/golden.test.mjs` | |
| Tiers from the reputation before the round; the 80 % round cap | `math::limits`, `math::tier`, `math::round_cap`, `contract/src/math.rs:227`, `:239`, `:252`; applied in `contract/src/close.rs:383-407` | `tiers_come_from_reputation_before_the_round`, `the_round_cap_moves_the_largest_auto_payouts_to_one_council_vote`, `a_newcomer_with_steady_help_reaches_tier_1` in `contract/tests/reputation.rs` | |
| Tier 1: filed and approved by the contract, paid in the same chain | `pay`, `contract/src/pay.rs:64`; `file`, `:319`; `on_filed`, `:138`; the proposal kinds, `contract/src/dao.rs:122` | `tier_1_is_approved_by_the_contract_and_paid_in_the_filing_chain` in `contract/tests/dao.rs` | `G4gSufPJgvmM2EKSecj8kj4njgg3n2hXqPChhGmPZ6Vm` |
| Tier 2: one council vote approves or vetoes | as above (`FunctionCall ft_transfer`) | `tier_2_is_a_function_call_that_one_council_vote_approves_or_rejects` | approve `BXaba7A14xDfBjzctzLe1SoiAtuhn6PuBffwRWbzK1VX`, reject `2D2LPmDd4HL13F6UeA4zydKbmfq3AcqGH3vbjNEgb4SE` |
| Tier 3: the council majority | as above (`Transfer`, no vote by the contract) | `tier_3_needs_the_council_majority_and_a_removal_strikes` | votes `GkVrTavePMekFEqWesJUq1QQm9YJTgda4FGgFqCHcPsM`, `8eMiTd69e5svSE2ubw1bTNRgS1Y3PvbUF2FmkW97S5F3` |
| Outcomes recorded from the DAO; a rejection or removal is a strike | `check_payout`, `contract/src/pay.rs:191`; `on_checked`, `:219`; the strike, `:398-404` | `a_rejected_payout_strikes_the_rounds_points_decayed` in `contract/tests/reputation.rs`; `contract/tests/dao.rs` | rejected and struck `BYs7RPocVYTiWd6LewYDq2rVPgXfB8DSagMU8haHCtf8`, removed and struck `ARApvmDHctxbtLSfYfhL28HCm86QQaVQSmFNMB5bVpGC` |
| Expired proposals are finalized (bond back), failed transfers retried once | `on_checked`, `contract/src/pay.rs:219` | `an_expired_proposal_is_finalized_and_recorded_on_the_next_check`, `a_failed_transfer_is_retried_once_after_registering_the_receiver` | |
| The DAO can stop the contract: a role without the contract or a permission pauses it | `parse_policy`, `contract/src/dao.rs:72`; `on_policy`, `contract/src/close.rs:40` | `a_dao_role_without_the_contract_or_a_permission_pauses_it`, `a_failing_add_proposal_pauses_until_a_sync_sees_the_dao_fit_again` | |
| Carry, lapse, budget capped by the DAO, dust stays in the DAO | `close_counted`, `contract/src/close.rs:314`; `lapse_carries`, `:290` | `contract/tests/carry.rs` | |
| The books add up; the events alone rebuild every reputation | `audit`, `contract/src/views.rs:298`; `contract/src/events.rs` | `many_random_rounds_keep_the_books` in `contract/tests/invariant.rs` (600 random rounds) | check 9; staging: every reputation rebuilt from the events of 744 transactions |
| Gas: the largest round closes in one receipt; every chain fits its gas | `contract/src/config.rs:69-90`; `contract/src/pay.rs:27-56` | `contract/tests/gas.rs` | burnt gas per call: [docs/testnet-stage.md](docs/testnet-stage.md#gas-measured) |
| The three tiers are the DAO's own policy | the policy in [DESIGN.md](DESIGN.md#the-three-tiers-in-the-dao); created and compared by `scripts/create-dao.mjs` | the tier probe on testnet, [docs/testnet-probe.md](docs/testnet-probe.md) | checks 5-8, 14 |
| tUSD: fixed supply to the DAO, no mint | `new`, `token/src/lib.rs:47` | `token/tests/token.rs` | check 2, 4 |
| The page counts like the contract and checks what it shows | `countRound`, `web/js/logic.js:101`; `policyReport`, `web/js/logic.js:614`; `proofHtml`, `web/js/ui.js:333` | `web/test/golden.test.mjs`, `web/test/logic.test.mjs` | |
| House members: labelled, published strategies, same rules | `scripts/house.mjs`; `house` in `sim/params.json`; `.github/workflows/house.yml` | the staging run | every house transaction in `docs/testnet-stage.json` |
| The parameters were picked by a pre-registered rule | [docs/SIMULATION.md](docs/SIMULATION.md), `sim/hat_tip_sim.py` | `python3 sim/hat_tip_sim.py --check` | |

More evidence transactions (each path once) are in `deploy/testnet.json`, `staging.evidence_txs`; the whole staging run, transaction by transaction, in `docs/testnet-stage.json`. On the final deployment ([docs/testnet-launch.md](docs/testnet-launch.md)): the keys were deleted by `3FSsP2Hcq81rxjeAm1Won8tSdW6VYedk2j59vk23q7xv` (contract) and `CLaqUhBJMMfWzeRoyCmmE42qGpSArK3inASpnn3LzDED` (tUSD); round 1's tier-3 payout to ana (DAO #1) was approved by `3EkQL42pWZKqxb8SsEDtf9LmLYBjrHJ1eqZdEF9HAoGi` and `CEsspTSr87WsUAfQoTgrs39f9rUPLx57LMBFUL5LtUDC` and booked paid by `Fgpi5zoMEXy88sbGbCrizDyun6gZSrYCvhnet3L4K86r`; its tier-2 payout to dina (DAO #4) by one vote `HWqF8TwFMpYpBou1yYogmphbxQmogxkvpjtA8bRrRAu5`, booked paid by `CYwpLHZeKczgfuRUidmQLVzfrTwqBmtK6mGv1YGjGc6c` after `E77Bg8Wt8kSxDWKKkte4K1Y5BYK4PHAyaLmb9LUYXCHh` had noted the first `Approved`. The first tier-1 payout, payout 40 of round 9 to ana (16.70 tUSD, DAO #41, *Paid automatically*), was filed, approved by the contract's own vote and transferred to ana in one relayed `pay` transaction: `E7SnGkS6Z4oHJcqYLuSbXjDKzQa21sSspYmWDRVzS2zD` ([explorer](https://testnet.nearblocks.io/txns/E7SnGkS6Z4oHJcqYLuSbXjDKzQa21sSspYmWDRVzS2zD)).

## 4. Run the tests

Measured 2026-11-08 on a 4-core Intel laptop (macOS 15), cold builds from an empty target directory:

```sh
node --test 'web/test/*.test.mjs'      # 82 tests; Node 20+, no install; about 6 seconds
node --test 'scripts/test/*.test.mjs'  # 12 tests (the house council's rule, the keeper's window); under 1 second
(cd contract && cargo test)           # 82 tests in the SDK's mock VM with a model of the Sputnik DAO; cold build 11 minutes, tests about 2 seconds
(cd token && cargo test)              # 6 tests (NEP-141, storage, fixed supply); cold build 14 minutes
python3 sim/hat_tip_sim.py --check    # golden vectors, replay and launch parameters reproduced; about 1.5 seconds
scripts/judge-checks.sh               # 14 read-only checks of the live deployment; about 9 seconds
```

The contract's tests run the real contract in near-sdk's mock VM against a model of the Sputnik v2 DAO (2.3.1: bonds, per-kind permissions, role thresholds, execution, removal, expiry) and of the token, executing every receipt the contract creates and feeding the answers back into the callbacks with the gas each receipt attached. The table of test files is in [contract/README.md](contract/README.md#tests). Not done: an integration test in near-sandbox; the staging run on testnet covers the same paths against the real DAO.

## 5. What is real and what is not

Testnet only; tUSD has no value; the Repair Café's eight members and three council members are labelled house bots with published strategies, run by GitHub Actions, voting and giving by the same rules as everyone; guests are real; public relay keys; rounds close when someone calls; AI-written code that no human reviewed line by line; no audit. What the rules do not stop: rings, one-way thanks, a guest farm, a colluding council, popularity. Details: [What is real and what is not](README.md#what-is-real-and-what-is-not), [Honest limits](README.md#honest-limits).
