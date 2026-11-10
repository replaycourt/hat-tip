# Hat Tip: Sputnik bounties on testnet (2026-11-10)

The track's starter idea, run with Sputnik's own bounties in the café's DAO next to the rounds of thanks (DESIGN.md, "Bounties"; README, "Bounties"). This file records the policy change, the first cycles on staging and on the final deployment, and what was left on the board for judging. Every transaction is also in `deploy/testnet.json` (`staging.bounties`, `final.bounties`, and the funding under `txs`).

## The policy change

Two `ChangePolicyAddOrUpdateRole` proposals, filed by `council-a` (its full-access key: `add_proposal` attaches the 0.01 NEAR proposal bond, which the house's function-call keys cannot) and passed by two votes of the house council's function-call keys each. `scripts/bounties.mjs policy` builds both roles from the DAO's current policy, so the groups stay as they are, and votes only on a proposal whose role is exactly the change.

```diff
 role council   permissions: transfer, config, policy, policy_add_or_update_role, policy_remove_role,
                policy_update_default_vote_policy, policy_update_parameters, add_member_to_role,
                remove_member_from_role, factory_info_update, vote (each :AddProposal),
                *:VoteApprove, *:VoteReject, *:VoteRemove, *:Finalize
+               add_bounty:AddProposal
 role council   vote_policy: call {"weight_kind": "RoleWeight", "quorum": "0", "threshold": "1"}
+                            bounty_done {"weight_kind": "RoleWeight", "quorum": "0", "threshold": "1"}
 role members   permissions: []
+               add_bounty:AddProposal, bounty_done:AddProposal
 role thanks, default_vote_policy (1/2), proposal_bond, proposal_period, bounty_bond (1 NEAR),
 bounty_forgiveness_period (1 day): unchanged
```

Before filing on final, the role shapes planned for final were compared with the staging DAO's roles after its change (groups aside), and the rest of both policies with each other: equal.

| | Staging `hat-tip-stage.sputnikv2.testnet` | Final `hat-tip.sputnikv2.testnet` |
|---|---|---|
| council role, filed | DAO #331, `49BEZfV1KgoyajMH8rNAQyPbYKvXQwwDb6ZuJWhq8gqD` | DAO #1101, `4Eg9shBKkKpnAYFxTyKUWo4bkZGUyNTrrhAgSJR26j33` |
| votes (council-a, council-b) | `G4qyfxWn5WWM7DmpwocE1YkqnszNtnHt3spKwF1BMBYa`, `FK1a3wYD2XFWkrcgb5eud3EKAzb6kV29ZF716axjvpdF` | `4UnfPQAazaHCByLjdsjYK7vjcQehPEu6feXuwiH7CJy6`, `HEzbVgKj6PNDk92DSqHK8XDfNGqoY5NThHkQT873PVBJ` |
| members role, filed | DAO #332, `94nXtaeUTeR2g6rC5kkFk4grKTeKaBK67GjbJ2reXyhF` | DAO #1102, `ErXendLVG3fsz5Qefe9spUV1A8CyPXCzmTLVRU4tCnNW` |
| votes (council-a, council-b) | `Gz15YBbtmetm9n9bXnarHhz4fx8YjoB3RVHUjQSmb4ux`, `FVYafPqC9q2okU3RuD1N3gK256RAu2vGHrhYqHv74GUj` | `3ybHJzUVXNsCBkuB8SM2CgVQjoxcW6NadwFgc3n5G55B`, `6141Hk54UYeiAVotyWr1MHQXQGp2TkXpufuCuTD5Lrps` |
| policy changed | 21:56:37 UTC | 22:17:59 UTC |

**The contract under the new policy.** It reads only the members and council groups, the bond, the period and role `thanks` from `get_policy` (`contract/src/dao.rs`, `parse_policy`), so nothing in it depends on the new entries. Staging: a planned tier-1 payout was filed and approved by the contract under the new policy (`GCZsnQTCxR1DgVZ1qe8aDkpAbZRj44i6HLbGR4KXLfNT`); round 917, the first close after the change, read the new policy and planned six payouts, tier 2 (DAO #339 and #340, one council vote each) and tier 3 (DAO #336-#338, #341, two votes each), all paid. Final, the first three closes after the change (the GitHub house closing and paying):

| Round | Closed (read the policy) | Payouts |
|---|---|---|
| 180 | 22:20:04 UTC | three in tier 3 (DAO #1109-#1111); the house council rejected them by its published rule (fewer than three givers: only ana, finn and gus gave that round, the other house members skipped it by their random draw), each with its strike |
| 181 | 22:40 UTC | five in tier 1, filed and approved by the contract's own vote (DAO #1116, #1118-#1121), two in tier 3 paid on two council votes (DAO #1115, #1117) |
| 182 | 23:00 UTC | six in tier 1 (DAO #1122-#1124, #1126-#1128) and one in tier 2 paid on one council vote (DAO #1125) |

`state()` not paused, the last close current; `audit()` balanced over 1,117 payouts; `scripts/judge-checks.sh` 15 of 15 PASS (JUDGE.md has the output).

## The first cycle, by hand (staging)

`scripts/bounties.mjs`, the council's votes by the published rule (`--now`: without the two-minute delay):

| Step | Transaction | What happened |
|---|---|---|
| ana posts *Fix the toaster that trips the fuse*, 10 tUSD (DAO #333) | `5oSqZHgwTc4CgmGoqjYf7VVNnEpsW8Lgs7AMdu5R8miR` | 0.01 NEAR proposal bond |
| council-a, council-b approve | `6Desmx4Qrvd9efu2ERNu3jJm5W3WNBW4UwwxAhrEYQcg`, `8mKiBTLzrphNNsgg9VdFH7VhXapH8BnGvcoV1CVaTCLZ` | bounty #0 stored, ana's bond back |
| ben claims #0 | `FRtpF8Tviq2GAv2UQtxEw4oJ2Ymq8UyuYCjzundVXzZ4` | 1 NEAR bounty bond: ben 1.426 → 0.416 NEAR with the next step |
| ben files the work (DAO #334) | `A7HcnmFr4oovFwS4etzx5vRvAzVeUFYoTm1NBpC79ehe` | 0.01 NEAR proposal bond |
| council-a approves (one vote) | `61Vvk1PDsKaBoMSRMVbUAifA3Lw1gQtCiRvWeDa4NJB` (9.97 Tgas) | ben +10 tUSD (1,206.415391 → 1,216.415391), both bonds back (0.416 → 1.426 NEAR) |
| round 917 | the house: ana's allocation gave ben the cap of 25 (her 10 bounty thanks on top of her split), ben's note *mended 5 jackets + bounty #0* (`FRhggwbcUkZz2ooFNoNe3WFFMwxATLydYTZJuP7cCHqd`) | |

## The house on staging

`scripts/house.mjs run --section staging --rounds 12 --bounty-scale 0.2 --seed 2026111022`, 2026-11-10 22:02-23:05 UTC, rounds 917-928 of five minutes, with the five honest members' bounty keys (full-access keys added for this, `staging.bounties.keys`; the house uses them only through `BountySigner`) and the bounty timings scaled by 0.2 (a post at most every 12 minutes, claims 2-10 minutes after a bounty opens, work 2-9 minutes). It first closed the 858 rounds staging had left open since 2026-11-07 (empty rounds, 36 per call). 482 transactions, none failed or refused.

The house on its own, after the first cycle by hand:

| Bounty | Posted (house) | Approved | Claimed | Work filed | Paid (one vote) | The finisher's note, the poster's thanks |
|---|---|---|---|---|---|---|
| #1 *Calibrate the soldering station*, 7 tUSD, emil | `3V8UyJ3uGVz8QDc6nkJfW4VsLKrihWwphA3AgoLtSBEJ` (DAO #342) | `vYjNXHAoqNSjb9jHAxixoVnACpszhHHJ94qLyLVwoFx`, `Eyeegb76eN9GcWKEM1pFZVaxvjDQ8h9PpWn9LMo6w2kk` | cleo `DzqCFY1NadUQnckkEWiUffYyXig7NZbckYYJVjFpyHdS` | `hyBtoumoFuXuSpB3AdZA4Hgfg55ePJjQJSGLjN6A7i4` (DAO #361) | `946kpu3FGchz3apVNLcHAtCwAUKQH5ZfMnEAyvtg5qjT` | *bounty #1 done* (cleo did not work that round); emil gave cleo 10 in round 922 |
| #2 *Replace the cracked lamp socket*, 8 tUSD, cleo | `6iWaS3kzo2e99QhXvsTCdGQSKCYp3Fpo54AJHGX7nV6X` (DAO #360) | `2FH4YofDeAgNPcX4xZFNLZBfr8YLzyicEVUwhZrz8jnp`, `Gsg3apvR6Xn3iL4dY9PN4xzubB7c65geHShUhCXjGTKp` | ben `7qDBiG3nGPgcAbmNTjWo9h1nAHVVkS7S81RFowinM2r1` | `5pK49WK2gog5SYMMbw3TzVBfp1Ph6eLetZRFRZAXZgkw` (DAO #380) | `J5ZJqTd9jyq68oyF3ca6eNDeUjAL1CCFhazotia12iEQ` | *mended 3 jackets + bounty #2*; cleo's allocation of round 924 sent again with ben 22 → 25 (the cap) |
| #3 *Sharpen the kitchen knives of the cafe*, 6 tUSD, ana | `797Euus5WDMnRSdQhBNcErBVZrQThfehTHTRy3xeib53` (DAO #373) | `3vGh9YjFRYXgNUMacvXtg4Xnqpy799SfZTgpgtPurAoA`, `7SsHuxC8nr3xs82TQfSi6UrJkPajUuEPxzoMWCaj65zi` | ben `59BapRuZtfwn2VQPWuHe4fy5NZ71BSvgK7VQBPuQjojD` | `CYvwEL8K4JV27o7YDh19WQwrQbvtoS7Kp5dKfNBEJWsC` (DAO #396) | `6jrkQCQhQEzZdLDb7gMzWc7jA5mmVJnMShUenSwsbUhr` | *glued 5 chairs + bounty #3*; ana gave ben 25 (the cap) in round 927 |
| #4 *Replace the cracked lamp socket*, 8 tUSD, cleo | `2v3RnH63kgQJShxaYDQF6LWaR34cijBgzz7gKUs8bT1f` (DAO #395) | `HG56kFLEoK8VZRLHVutZnLV2jM6cj3T4fQ4xgvthkSez`, `C5ZowoiW4M9cHJrDGV4kkBFfEMHeEn9QVVWGpfD4BGtG` | ana `3tK2caXW1A7Tij7xvH8ibTz7zbd9m3ogVRqu7T4S2pYC` | `7ZmJutpsnh2nDHaDQCGfNmX9wsjFs8V2FFEw66oUAt5M` (DAO #408) | `GgwjpqUQBWJsAk61svZwBaH2J4iF9CGfbmLTD8MUwUBr` | approved in round 929, after the run's last played round: its thanks were not sent |
| #5 *Re-glue the wobbly chair from the reading corner*, 5 tUSD, dina | `HbSH7NPmryPRjyNhCHhkc3TEFN5nuS9sXX3oFivBX4aW` (DAO #407) | `HHUgrxS11j6VANAwqKYYFsPgTTpuckZurCpa8WmcbF7p`, `DV485mxrwS816AKuJ72qRM4txyUW5zPhCv4JDk9TSiTV` | open when the run ended | | | |

Each member held one claim at a time, claimed only bounties it had not posted, and the council approved every bounty proposal by the rule (none broke it). Next to the bounties the rounds ran as before: 32 tier-2 payouts paid and 4 rejected by the council's rule, 33 tier-3 payouts paid (staging's reputations had decayed over the 858 idle rounds, so nobody had an auto limit in these twelve rounds); `audit()` balanced over 246 payouts.

## Final: the first bounties and the board for judging

The final house runs in GitHub Actions on function-call keys only, so it votes on bounty proposals and thanks finishers but cannot post or claim (no deposits). The bounties below were posted, claimed and filed with the members' own full-access keys (`scripts/bounties.mjs --keychain`), the council's votes cast with the house council's function-call keys by the published rule, two minutes after each filing. Funding (testnet faucet): `hat-tip-fund-8.testnet` (`DLJrQzw9Hy1Nm5C8cjXyvJDwf8f8N4zd9aJ1URz7Y5xN`) and `hat-tip-fund-9.testnet` (`AtVYB3iixZvHA5o819rxNcgDuHTC5dknaRSEDmaYwgB8`), 10 NEAR each; 1.2 NEAR to each of the five honest members on final for the claim bond, 1.2 NEAR to ana, ben and cleo on staging, and 5 NEAR to the final DAO for the storage of the bounty proposals.

| Bounty | Posted (DAO, tx) | Approved (two votes) | Claimed | Work filed (DAO, tx) | Paid (one vote) |
|---|---|---|---|---|---|
| #0 *Fix the toaster that trips the fuse*, 10 tUSD, by ana | #1103 `FwMPyqiDCSaa4AnNad4me2jBxDWKVSg4JvJfzkdfSpHy` | `CgD7U9BFJMmKBSgLAfeM95x8gFnJKfvhN7dwGuqUkr7W`, `EmEh6oA1LzZHysveYqE4KBV4cL2Rqg5xWKKM6G3dJjKk` | dina `BDMbRmPDTEtV46HkufUNt6QxLrem4zfZQVwJcuNNHFPU` | #1112 `8Gue5CMb7aorMpmBnhMZeziQVyEXRENAwt5wJdQuEhYt` | `A9BDpTUXRdeXczGbdCmGmn3thSw4XMgmMVNV3bPgrUny`: dina +10 tUSD |
| #1 *Replace the cracked lamp socket*, 8 tUSD, by ben | #1104 `FasntvGBTeQFEiuUBXKQPt96nSYoP78rdRwnoy1KZDT8` | `8o4f8D14q3d96A1xnNdGQQneU2TVTtztyk5byRk2KkZd`, `HGeMwgT5EBbbmyh9d7nWRx2nqAegSroHPfNLyTSca3ut` | emil `D4bsHCwSiqfNPvDQB3EBju5iM6uMmWHZsXcvf8iJQMEe` | #1113 `V9dBx9pJcCS9LFuLBXdVgzE5w7Tm6aCEY1jWMHuyyX4` | `AiuaDXY4ABRzmRypBPDtfiuK9nNHBg2XxwSNPmgk5hEn`: emil +8 tUSD |
| #2 *Free the jammed sewing machine*, 15 tUSD, by cleo | #1105 `B8ECPuf51h2GdTgDAjXq48n1kRdeTCFnsGvoZa6N7gp5` | `5CxMbtek3BJWxyGf85W6XVRWAAmtzZZMtyBY93EfyM9v`, `2HtubbN35ay3YXhZY8QpWyR3anWrYtypg17T9TuFQ6nm` | ana `GFoyZWKYwBvBZY11rngUTibTHbvAF4WcDqvXw7uogDBQ` | #1114 `DPWfi1stvvkGv214kre7a526ZxDUokDFxXiSfBQ5mmMQ` | `DE6psLJEZoxvDkPiiC2C5tRUT6JUsegM94JDZ55xWshJ`: ana +15 tUSD |
| #3 *Sort the screw box by size*, 5 tUSD, by dina | #1106 `3kekXbBDsdPSop49WK3QL6Bp8zsZ8VkMA7LDsiDEaB9U` | `EgNSAcqc1NYq3i58NCmwVcRggpVmEavD9ugzProAWd5N`, `GgSjBWcsTXBJV23a5BVSjsLfTgeN2EfVRnDPT4rwwXYz` | open | | |
| #4 *Repair the coffee grinder*, 20 tUSD, by emil | #1107 `EmcCU62yPgZF883BFvWwXrG6cuAMiwVYQ2VrwKehgE8J` | `HsvVkQBXDhtW4kkfPofcPEZf2DKJY86BAgubq4EcosQ7`, `BeRgZzS7ESmyMKQqpGQNGD1gtAWDEb4wF8b1d6jrx3VN` | open | | |
| #5 *Fix the radio's volume knob*, 6 tUSD, by ana | #1108 `4CBVwGVo79YasbB9uAxdyRzN5yDcdb9jvTVZKqdP2dUW` | `GAfsdAezTv9BD3HjK9yv9pqAriy3BQ4RpHVoGuKw13jw`, `E22Y6fk1vwkDdtvQeegKCc6X1Zkfas5fnfbAfKSeEazJ` | ben, 2026-11-10 22:22 UTC, `GBYeA3wtataweq81hbsogx26UAfBQqErPEksH74djTFm` | | |

Each paying vote burnt about 9.95 Tgas (the DAO's `act_proposal`, the token's `ft_transfer`, the callback and two bond transfers); posting, claiming and filing about 2.6-2.8 Tgas each.

**The thanks, round 181.** After the house had sent its allocations for round 181 (GitHub house, function-call keys), `scripts/bounties.mjs thank` put each poster's 10 thanks for the approved work on top, taking them from the poster's largest other gifts so the sum stays 100, and re-posted the finisher's note with the bounty's number:

| Work | The house's allocation | With the bounty thanks | The finisher's note |
|---|---|---|---|
| #0, ana → dina | dina 24 (`C7NdYBivzd76mFWnSnz2QohvfpjNvgTtZi2gBSpCt1JR`) | dina 25, the cap: one more (`9a9PARRGYYoTavWgNdnCArjvsKd25d3aUHG9Ayf4MZSc`) | *mended 3 jackets + bounty #0* (`5icLizfBeUtp2GYcf9zd4xoP5Nw9X4gkxrovseVdaTCz`) |
| #1, ben → emil | emil 12 (`BSLWXEiSkfDggGWpdLVDW5Qkddc2rTwxXrM91s53SiZx`) | emil 22 (`HcDNg21MZQt77pjtUcvnrMmSog2oGrkMqjsQ2wRtkAFj`) | *mended 2 jackets + bounty #1* (`GxBz1sXRK98qZh34kpwFG1BzyZEtp1VbwDHhtn9q2aW9`) |
| #2, cleo → ana | ana 25, the cap already (`4hyjN4PV4H67Q9SksA6oH3s9xowLSZDKEEBAwGeFPgye`) | unchanged (`7Uf6pynZ2bSaDjP1kfBo4Gn3j17cfwuqvXCnPm9AgCj8`) | *glued 10 chairs + bounty #2* (`8akApqxk6qwjGSNysRw5M7w7HhNkpCwA21RnQ877Td7s`) |

The cap of 25 thanks per receiver is a hard rule of the contract; a poster that already values the finisher at the cap has nothing left to add.

**Left for judging (2026-11-16 to 18).** Bounties #0-#2 done and paid, #3 and #4 open, #5 claimed. #3, #4 and #5 were posted with a claim deadline of ten days (`max_deadline` 864,000 s, within the council's rule of two weeks): an open bounty does not expire, and whoever claims it has ten days to file the work. Ben's claim on #5 runs until 2026-11-20 22:22 UTC; nobody will file its work, so after that the claim is past its deadline: anyone may free the slot with `bounty_done(5, "ben.hat-tip.testnet")`, and the DAO keeps the 1 NEAR bond (a testnet amount, on purpose). The House workflow cannot claim the open ones, so the board stays as it is unless a visitor claims one with the bond.

**Why the page and check 15 know these proposal ids.** Sputnik has no index by proposal kind, and the contract files about 18 payout proposals an hour, so by the judging days the bounty proposals sit a few thousand proposals deep. `deploy/testnet.json` records them (`final.bounties.proposals`), `web/js/config.js` names them (`bountyProposals`, checked against the record by `web/test/bounty.test.mjs`), and both read them live by id. The newest 300 proposals are scanned as well, for bounties posted later.
