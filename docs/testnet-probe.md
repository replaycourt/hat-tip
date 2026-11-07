# Hat Tip: testnet tier probe (D0, 2026-11-07)

The question before the contract is built (PLAN.md, package c, "D0 probe"): do the three payout tiers of DESIGN.md ("The three tiers, in the DAO") work with a real Sputnik DAO v2 from `sputnikv2.testnet`, with exactly the planned policy? The uncertain point was tier 2: a `FunctionCall ft_transfer` proposal that only the contract's role may add and that one council vote approves.

**Result: yes, all three tiers work with the policy of DESIGN.md unchanged.** 76 records (52 transactions, 24 state checks), every one as expected. Fallback B (`cosign` on the contract) is not needed and was not tried.

| Claim (PLAN.md probe item) | Result | Evidence (step ids below) |
|---|---|---|
| (1) Tier 1: the role files a tUSD `Transfer` and its own vote (`transfer: 1 of 1`) executes it at once | works | T1-file, T1-vote, T1-status |
| (2) Tier 2: a `call` proposal `ft_transfer` filed by the role passes on exactly one council vote | works | T2-file, T2-vote, T2-status |
| (2) ... and on nothing less: the role's own vote and a member's vote are refused, the proposal stays open and nothing is paid | works | T2-role-vote, T2-member-vote, T2-pending |
| (3) The council cannot file a `call`; members and outsiders cannot file anything | works (`ERR_PERMISSION_DENIED`) | C-council-call, C-member-transfer, C-outsider-transfer |
| (4) Tier 3: a `Transfer` filed without a vote needs two council votes; one approve or one reject leaves it open | works | T3-vote1, T3-pending, T3-vote2, T3-status, E-reject1, E-status |
| One council `VoteReject` rejects a tier-2 proposal; one `VoteRemove` removes it | works | T2R-vote, T2R-status, T2X-vote, T2X-status |
| (5) Bond back to the role on approve, reject and finalize-after-expiry; kept by the DAO on remove | works, all four | T1/T2/T3-bond, T2R-bond, E-expired-0/2/3, T2X-bond |
| (6) `ft_transfer` to an unregistered implicit account fails, to a registered one works | works; the proposal becomes `Failed` (bond held) and a `Finalize` by the role after registration pays it and returns the bond | U-vote, U-status, U-register, U-finalize, U-retry |
| Gas the executing vote must carry | 20 Tgas fails (`Exceeded the prepaid gas`, vote not recorded), 25 Tgas works | G-vote-20, G-untouched-20, G-vote-25, G-vote-call-25 |

## Setup

- **Accounts.** One faucet account, `tr-probe-759c20.testnet` (testnet faucet through the NEAR CLI `sponsor-by-faucet-service`, 10 NEAR, tx `9curmhHLYixHG6DRtsP6UhmwB9sdMqyu7DrS7RqJXTMx`), and six sub-accounts it created and funded. Neutral throwaway names, independent of the project name. Keys: legacy keychain `~/.near-credentials/testnet/` only (mode 600), none printed or committed.

  | Account | Role in the probe | Funded |
  |---|---|---|
  | `tr-probe-759c20.testnet` | root: faucet account, DAO creator, pays token registrations | 10 NEAR (faucet) |
  | `council-a`, `council-b`, `council-c` `.tr-probe-759c20.testnet` | role `council` | 0.2 NEAR each |
  | `standin.tr-probe-759c20.testnet` | role `thanks`: a plain account in the place of the keyless contract | 0.5 NEAR |
  | `recv.tr-probe-759c20.testnet` | role `members`, receives the payouts | 0.1 NEAR |
  | `outsider.tr-probe-759c20.testnet` | in no role | 0.1 NEAR |

- **DAO.** `tr-probe-759c20.sputnikv2.testnet`, created by `sputnikv2.testnet.create` with 6 NEAR (tx `wkkFv4i3UsWuejEKYGhfBknCs8CvYiHMaJUY4X193Pa`). Code hash `AA4nA45vauiac3jdVwJTzSdUP3oj2r1fDaPAb2mHdgcH`, `version()` "2.3.1": the factory default, the same code the real DAO will get.
- **Token.** `wrap.testnet` (wNEAR, a standard NEP-141 with `storage_deposit` registration) stands in for tUSD; the root wrapped 0.06 NEAR and sent 0.05 wNEAR to the DAO. Payouts were 0.001, 0.002 and 0.003 wNEAR. The DAO's `Transfer` calls the token's `ft_transfer` the same way for any NEP-141, so nothing here depends on wNEAR.
- **Policy.** Exactly the demo policy of DESIGN.md, with the probe's accounts and one change: `proposal_period` 5 minutes instead of 24 hours, so that expiry could be probed. `get_policy` returned it unchanged (step S-policy compares the canonical JSON); the threshold forms `"1"` (weight) and `[1, 1]` (ratio) are accepted by the 2.3.1 code. As `get_policy` returns it (permission and member lists are hash sets, so their order is arbitrary):

```json
{
 "roles": [
  {"name": "council",
   "kind": {"Group": ["council-a.tr-probe-759c20.testnet", "council-b.tr-probe-759c20.testnet", "council-c.tr-probe-759c20.testnet"]},
   "permissions": ["transfer:AddProposal", "config:AddProposal", "policy:AddProposal",
     "policy_add_or_update_role:AddProposal", "policy_remove_role:AddProposal",
     "policy_update_default_vote_policy:AddProposal", "policy_update_parameters:AddProposal",
     "add_member_to_role:AddProposal", "remove_member_from_role:AddProposal",
     "factory_info_update:AddProposal", "vote:AddProposal",
     "*:VoteApprove", "*:VoteReject", "*:VoteRemove", "*:Finalize"],
   "vote_policy": {"call": {"weight_kind": "RoleWeight", "quorum": "0", "threshold": "1"}}},
  {"name": "thanks",
   "kind": {"Group": ["standin.tr-probe-759c20.testnet"]},
   "permissions": ["transfer:AddProposal", "transfer:VoteApprove", "call:AddProposal", "transfer:Finalize", "call:Finalize"],
   "vote_policy": {"transfer": {"weight_kind": "RoleWeight", "quorum": "0", "threshold": [1, 1]}}},
  {"name": "members", "kind": {"Group": ["recv.tr-probe-759c20.testnet"]}, "permissions": [], "vote_policy": {}}
 ],
 "default_vote_policy": {"weight_kind": "RoleWeight", "quorum": "0", "threshold": [1, 2]},
 "proposal_bond": "10000000000000000000000",
 "proposal_period": "300000000000",
 "bounty_bond": "1000000000000000000000000",
 "bounty_forgiveness_period": "86400000000000"
}
```

The proposal kinds were built the way the contract will build them and passed back unchanged as the `proposal` argument of `act_proposal`; the DAO accepted them (no `ERR_WRONG_KIND`):

```json
{"Transfer": {"token_id": "<token>", "receiver_id": "<receiver>", "amount": "<base units>"}}
{"FunctionCall": {"receiver_id": "<token>", "actions": [{"method_name": "ft_transfer",
  "args": "<base64 of {\"receiver_id\":\"<receiver>\",\"amount\":\"<base units>\"}>",
  "deposit": "1", "gas": "10000000000000"}]}}
```

## What the probe shows

- **Tier 1.** `add_proposal(Transfer)` by the role, then `act_proposal(id, VoteApprove, kind)` by the role: status `Approved`, the DAO calls `ft_transfer`, `on_proposal_callback` returns the 0.01 NEAR bond to the role, all in the voting transaction. Receiver +0.001 wNEAR.
- **Tier 2.** `add_proposal(FunctionCall ft_transfer)` by the role works; the role's `VoteApprove` and a member's `VoteApprove` fail with `ERR_PERMISSION_DENIED`; status stays `InProgress`, nothing paid. One `VoteApprove` by `council-a` approves and executes it (votes: only `council-a`), the receiver gets +0.002 wNEAR, the bond goes back to the role. One council `VoteReject` rejects a tier-2 proposal (bond returned); one council `VoteRemove` removes it: the DAO deletes the proposal (`get_proposal` then panics `ERR_NO_PROPOSAL`) and keeps the bond.
- **Who files.** `council-a` filing a `call` (to pay itself), `recv` filing a `Transfer` and `outsider` filing a `Transfer` all fail with `ERR_PERMISSION_DENIED` (`proposals.rs:518` in the deployed code; votes fail at `:546`). There is no `Everyone` role, so every `call` proposal in this DAO comes from role `thanks`.
- **Tier 3.** The role files a `Transfer` and does not vote. After `council-a` approves it is still `InProgress` and nothing is paid; `council-b`'s approval executes it (+0.003 wNEAR, bond back). A single council reject on another tier-3 transfer also left it `InProgress`.
- **Expiry.** Three proposals left open (two tier-3 transfers, one with a council reject, and one tier-2 call left by the first run) were finalized by the role after `proposal_period`: status `Expired`, bond returned each time. So both `transfer:Finalize` and `call:Finalize` of role `thanks` are used and work.
- **Unregistered receiver.** A tier-1 transfer to an unregistered implicit account: the vote succeeds, the token's `ft_transfer` panics `The account ... is not registered`, the DAO marks the proposal `Failed` and keeps the bond. After `storage_deposit` for that account, `act_proposal(id, Finalize)` by the role re-ran the transfer: `Approved`, paid, bond returned. The contract's plan (register the receiver before filing) avoids this; `Finalize` is a retry path if it happens anyway.

## Gas

Burnt gas per receipt, the same in every repetition to within 0.05 Tgas:

| Step | Receipts (Tgas burnt) | Whole tx |
|---|---|---|
| `add_proposal` (`Transfer` / `FunctionCall`) | DAO 2.18 / 2.20 | 2.5 |
| non-executing vote (first tier-3 approve, a reject without bond) | DAO 2.36 | 2.7 |
| executing vote (tier 1 by the role, tier 2 by one council member, tier 3 second vote) | DAO `act_proposal` 3.13 + token `ft_transfer` 1.85 + DAO `on_proposal_callback` 2.48 + bond transfer 0.22 | 8.7 |
| reject (tier 2, one vote) | DAO 2.63 + bond transfer 0.22 | 3.4 |
| remove (tier 2, one vote) | DAO 2.34 | 2.7 |
| `Finalize` of an expired proposal | DAO 2.56 + bond transfer 0.22 | 3.3 |
| failed payout (receiver not registered) | DAO 3.15 + `ft_transfer` 1.54 (fails) + callback 2.01 | 7.7 |
| refused action (`ERR_PERMISSION_DENIED`) | DAO 2.0 | 2.3-2.7 |
| DAO creation through the factory | factory 41.17 + DAO `new` 44.73 + `on_create` 2.36 | 89.1 |

**Attached gas.** The executing vote must carry at least about 25 Tgas: the DAO reserves 10 Tgas for `ft_transfer` (or the `FunctionCall` action's own gas) and 10 Tgas for `on_proposal_callback`. With 20 Tgas the vote failed with `Exceeded the prepaid gas` after burning only 2.83 Tgas, and the proposal stayed untouched (G-untouched-20); with 25 and 30 Tgas it executed, a council vote on a tier-2 call too. **PLAN.md's budget of 20 Tgas for the contract's `act_proposal` is too low; use 30.** `add_proposal` needs about 5 Tgas (PLAN's 15 is ample). The `FunctionCall` action's `gas` of 10 Tgas covers `ft_transfer` (1.85 burnt).

**Prepaid gas and small balances.** Testnet burns gas at 10^8 yocto per gas (0.0001 NEAR per Tgas), but a transaction's gas is bought up front at 10^9 yocto per gas and the difference refunded. A signer therefore needs 0.1 NEAR free for 100 Tgas attached: the first probe run stopped when `recv` (0.1 NEAR) could not prepay a 100 Tgas vote. House and council accounts and relay-key allowances must cover attached gas at that price; votes with 30 Tgas need 0.03 NEAR free.

## Costs

| Item | NEAR |
|---|---|
| Faucet accounts used | 1 of the 3 budgeted (10 NEAR) |
| DAO creation: attached and held by the DAO; 541,042 bytes (5.41 NEAR) are locked for its code and state | 6.000 |
| Funding of the six sub-accounts (they still hold 1.274) | 1.300 |
| wNEAR wrapped (0.038 of it is still in the DAO) and four token registrations | 0.065 |
| Gas burnt by all 52 transactions | 0.0745 |
| of which: creating six sub-accounts with a key (0.0071 each) and the DAO (0.0151) | 0.0578 |
| Left on the root | 2.576 |

Per payout, with a plain account in the role: tier 1 burns 0.00025 (file) + 0.0008 (executing vote) NEAR; tier 2 the same, the vote paid by the council member; tier 3 0.00025 + 0.00027 + 0.0008. The DAO's storage grew 190-202 bytes per `Transfer` proposal and 270-280 bytes per `FunctionCall` proposal at filing (descriptions of 20-30 bytes); over all 13 proposals it keeps (one was removed) it grew 4,078 bytes including votes, about 314 bytes each (0.0031 NEAR of the DAO's balance). With the longer description of DESIGN.md (about 70 bytes) DESIGN's estimate of about 350 bytes (0.0035 NEAR) per payout holds; tier-2 payouts cost about 80 bytes more than tier 1 and 3.

## Recommended policy

The demo policy of DESIGN.md, unchanged. Notes for package (a) and the stage setup:

- Keep `transfer:Finalize` and `call:Finalize` in role `thanks`: both are needed to return the bonds of expired proposals (and allow the `Failed` retry).
- The contract attaches 30 Tgas to `act_proposal` (tier 1, in `on_filed`) and to `Finalize`; the house council votes with 30 Tgas.
- `check_payout` reads `ERR_NO_PROPOSAL` as `removed` (the DAO deletes removed proposals and keeps the 0.01 NEAR bond, so the contract's bond float shrinks by one bond per removal). `Failed` keeps the bond until a `Finalize`.
- Register every receiver with the token before filing; a `Failed` payout otherwise locks a bond.

## Every transaction

Run 2 (proposal ids 3-9), the gas run (10-13), the expiry run, and the setup. Fee = tokens burnt by the whole transaction. `DAO` = `tr-probe-759c20.sputnikv2.testnet`, short names are sub-accounts of `tr-probe-759c20.testnet`. The full record with every receipt, log and failure text is `docs/testnet-probe.json`.

| Step | What | Signer | Result | Tgas | Fee (NEAR) | Tx |
|---|---|---|---|---|---|---|
| faucet | create `tr-probe-759c20.testnet`, 10 NEAR | `testnet` (faucet) | ok | | | `9curmhHLYixHG6DRtsP6UhmwB9sdMqyu7DrS7RqJXTMx` |
| S-councilA | create council-a with 0.2 NEAR | root | ok | 8.34 | 0.007115 | `2bqwF3SnB5nUyeRQydFUgkETB1JVUFKnSRReKoznCiA8` |
| S-councilB | create council-b with 0.2 NEAR | root | ok | 8.34 | 0.007115 | `J8ymJ4i51NgMZeqbeJZrRAQxfBC198hibg8v95u2HW6b` |
| S-councilC | create council-c with 0.2 NEAR | root | ok | 8.34 | 0.007115 | `DR9iMY8kPM5S6JrerZtwv3AjSm2DrVgqQL11WRUA39yX` |
| S-standin | create standin with 0.5 NEAR | root | ok | 8.34 | 0.007115 | `e7KLuWuAVm6fdsxufDsmjbHKUQysD81z5stDDDjtZFC` |
| S-recv | create recv with 0.1 NEAR | root | ok | 8.34 | 0.007115 | `4A7CJgp8mve7qjDgRQQJYvaeAmscYgasym2WRGhVXKNc` |
| S-outsider | create outsider with 0.1 NEAR | root | ok | 8.34 | 0.007115 | `4j3PVZniQDAXrnNqLsPTafuZxaxaxCZ3grkn93tnkCeS` |
| S-reg-root | register root with wrap.testnet | root | ok | 1.89 | 0.000190 | `3rGvGCxFujpa4DB4JwbgkTi9NnJKZuPW6W5XfwGn4NU1` |
| S-reg-recv | register recv with wrap.testnet | root | ok | 1.89 | 0.000190 | `AQQ8qwhotgCYtBmTc8ADra9qEpEkDTvZzQAM14Q3uVCd` |
| S-wrap | wrap 0.06 NEAR into wNEAR | root | ok | 1.93 | 0.000194 | `3gMP7oW8NoVqNRmUJWykPhRWJLyrfRteHY1wZWKMNoQi` |
| S-dao | create the DAO with 6 NEAR | root | ok | 89.11 | 0.015147 | `wkkFv4i3UsWuejEKYGhfBknCs8CvYiHMaJUY4X193Pa` |
| S-reg-dao | register the DAO with wrap.testnet | root | ok | 1.89 | 0.000190 | `7JSGaEdJZ1jTz8hTiYRZQdDs34pBzHPSfdRwJS6yVCvu` |
| S-fund-dao | send 0.05 wNEAR to the DAO | root | ok | 2.14 | 0.000214 | `J7px7FoS1oLuY9Ujo7U18sRHt2mhDZ3baVro5hzZNNyY` |
| E-file | tier-3 transfer #3, to be left to expire | standin | ok | 2.50 | 0.000250 | `AyS25ayNbLxC76okXE8nJwMQSXxzFFYfLxxaN88sRchd` |
| E-reject1 | one council VoteReject on #3 | council-c | ok, still InProgress | 2.68 | 0.000269 | `DtX8oEjW1hx7aMSEYJb8RxwDLjnqJL1eHFtaVhPMc4j6` |
| T1-file | tier 1: role files Transfer #4 | standin | ok | 2.50 | 0.000250 | `29LmUwkHTiPa2PXHS1n7GYHuway94pe4Ly9txcXMzXBp` |
| T1-vote | tier 1: role votes VoteApprove (1 of 1) | standin | ok, paid, bond back | 8.68 | 0.000801 | `GGfSEUkktSuA2z9XwzkaecioyqSqnmtMB6V9VWV6xYKh` |
| T2-file | tier 2: role files FunctionCall `ft_transfer` #5 | standin | ok | 2.53 | 0.000253 | `6AudNM6MfRJoJoqCuw5is4NZJM5ypoTwnmrADQuoAMWd` |
| T2-role-vote | tier 2: role tries VoteApprove | standin | refused: `ERR_PERMISSION_DENIED` | 2.34 | 0.000235 | `Fjj9DNryzGGT2dp6Qmuz9D71KCs8fbYM3RYUuAzENacL` |
| T2-member-vote | tier 2: member tries VoteApprove | recv | refused: `ERR_PERMISSION_DENIED` | 2.34 | 0.000235 | `4Pv14DpDc6DengD8tJ579JpBFYJY4jkpM6kqzK28bb64` |
| T2-vote | tier 2: one council VoteApprove | council-a | ok, paid, bond back | 8.69 | 0.000803 | `EtUvUYTByDWg3NGHWRhWoktgj8A2NBvGNj3DCuK1dHeS` |
| C-council-call | council tries to file a FunctionCall | council-a | refused: `ERR_PERMISSION_DENIED` | 2.74 | 0.000230 | `vtRpdnjZ5Wmvcqmxq5hYwhGMswRGW5ZTsrEDnfmcSVM` |
| C-member-transfer | member tries to file a Transfer | recv | refused: `ERR_PERMISSION_DENIED` | 2.72 | 0.000227 | `6BQ8ZZ5za1Bu7ksicoBzPeaH7K8AkVnc3LiJi5ePVS1p` |
| C-outsider-transfer | outsider tries to file a Transfer | outsider | refused: `ERR_PERMISSION_DENIED` | 2.70 | 0.000226 | `HKtuQn6dPpGCz6tfszyWDvZVSRMbZTE6H2XuCv1FSxKk` |
| T2R-file | tier-2 call #6, to be rejected | standin | ok | 2.52 | 0.000253 | `62gN3uxtkkQ9fvuJcsHf6d7jN3zrxRNAEGVo5uN3aDAn` |
| T2R-vote | one council VoteReject | council-b | Rejected, bond back | 3.40 | 0.000318 | `5MfyG723ysSjHp6LYB6DW2SLrXnnKE55XPgs1HgFNG8V` |
| T2X-file | tier-2 call #7, to be removed | standin | ok | 2.52 | 0.000253 | `Bjf1STJhit6cyvpwvMDPxxP1Uq4xv3Yghdxxzurqh8FF` |
| T2X-vote | one council VoteRemove | council-c | Removed (deleted), bond kept | 2.66 | 0.000267 | `EjiakFBbSW5iVW5g2NiSAvgqmymZmgSSnpL454fA3jWR` |
| T3-file | tier 3: role files Transfer #8, no vote | standin | ok | 2.50 | 0.000250 | `9v7MjLZ2qbCRe5xxhqDjnKYoWrd4H3BdAx2xMt35znAV` |
| T3-vote1 | first council VoteApprove | council-a | ok, still InProgress | 2.68 | 0.000269 | `4oFWpq6Y98RvXvnbGCioygVkzjVmR3bYso3jMUBr7jFY` |
| T3-vote2 | second council VoteApprove | council-b | Approved, paid, bond back | 8.73 | 0.000807 | `B9ymSbVtWUEMiLqtkcPNQP8W1smrUo2SCqsVTsGKhpkp` |
| U-file | tier-1 Transfer #9 to an unregistered implicit account | standin | ok | 2.50 | 0.000251 | `3vyagpDTCr83rVSfrixBSoTfuwudSrX6bUpzahxmsoNu` |
| U-vote | role approves #9 | standin | ok; `ft_transfer` fails, proposal Failed, bond held | 7.69 | 0.000703 | `6RcgeK1SuigpEcYibqzF8F5ZrmwpebKcj3jo21h7jBFM` |
| U-register | register the implicit account with the token | root | ok | 1.91 | 0.000191 | `BTMw6bmPxhbcG6VRJ895s9x2FMJ7Y9ayAqb9Hh6zU3Mb` |
| U-finalize | role calls Finalize on Failed #9 | standin | Approved, paid, bond back | 8.69 | 0.000802 | `DwBfSPBRJ4W84XgboKjyrVrzzCZ5HmHjNcrbRQsSLHZL` |
| G-file-20 | tier-1 Transfer #10 | standin | ok | 2.50 | 0.000250 | `FYsBMWi1EZLAgtzVitNq3oKAM52WJ1LsWnKiD98tAZ2r` |
| G-vote-20 | role votes with 20 Tgas | standin | fails: `Exceeded the prepaid gas`, #10 untouched | 3.15 | 0.000316 | `45ASGuWDcAourDj9y58WPbiGfQr7onNEbN64CaAVCRvT` |
| G-revote-20 | same vote with 30 Tgas | standin | Approved, paid, bond back | 8.68 | 0.000801 | `F4U6GBC5nXGaYn2tPtGa3JnhV4GyyewUR7cSFCNaZEvf` |
| G-file-25 | tier-1 Transfer #11 | standin | ok | 2.50 | 0.000250 | `BoAZPsLwCEsCwdYWN2pZ7wg5QQuNXAhr5jCa3fgypbDh` |
| G-vote-25 | role votes with 25 Tgas | standin | Approved, paid, bond back | 8.68 | 0.000801 | `EPsRuopuK5FNrXu3MT5vokLoLcQY5QxX2tbCBB4vxkeR` |
| G-file-30 | tier-1 Transfer #12 | standin | ok | 2.50 | 0.000250 | `8QxdR7Kb6HTxcMAUcYwDbgPtjHPsMcbfiTuuXCR7T9g9` |
| G-vote-30 | role votes with 30 Tgas | standin | Approved, paid, bond back | 8.68 | 0.000801 | `8LVagszCTdEWWySpbm9HZGjeH7BZwnnLstNnRJHAVqv1` |
| G-file-call | tier-2 call #13 | standin | ok | 2.52 | 0.000253 | `8zpZUWEq6797VbzcsZraRiXoUpfcVQNpCPZNYW1qk8gA` |
| G-vote-call-25 | council votes with 25 Tgas | council-a | Approved, paid, bond back | 8.69 | 0.000803 | `EHG5AZtWSaRM9pM88zsg8aswamMK4aRwW4sF6y2GKa8Q` |
| E-finalize-0 | role finalizes expired tier-3 transfer #0 | standin | Expired, bond back | 3.32 | 0.000310 | `6Ax5syW85UtS6NSBeMymehJRFYwJ4SgBw6aaKArop3Rv` |
| E-finalize-2 | role finalizes expired tier-2 call #2 | standin | Expired, bond back | 3.31 | 0.000309 | `4Bs3w2wwhSvTegAW22Z732z52QndSZnT9s7sLKvJ22Am` |
| E-finalize-3 | role finalizes expired tier-3 transfer #3 | standin | Expired, bond back | 3.32 | 0.000310 | `7AanToffUQhvtEJBg7P9m795bAa69YH8KcA32BhnL3og` |

Run 1 (same steps, proposal ids 0-2) stopped after T2-role-vote, before any finding, because `recv` could not prepay a 100 Tgas vote (see "Gas"); its transactions, all as expected: E-file #0 `3NvgCr4UrNmGSkFnT3oQzRxkwbjDEJgKh4g48VzXpT75`, E-reject1 `EW4kCdgVCJBXLBV3ShYpjHLzUv3eoLkEsnyxnATwfDzM`, T1-file #1 `9fSsDdiUxq7MyRVtYrKGJ8e9SydDEtdmLGgXNpgrsyeN`, T1-vote (paid, bond back) `Goyj2iGWQfacWgdZaSseXDgzwWaUJELwunq3hVWesXi`, T2-file #2 `Hj3qZDXuvEas6XmSLmS7NMyZD17A3mgbBCZ8ennAeZGm`, T2-role-vote (refused) `6sE4f8jYC9EUfpdaX8y6Dx8WtHu9cJVCxzyiVENsbMXn`. Proposals #0 and #2 were finalized in the expiry run.

## Run it again

```sh
near account create-account sponsor-by-faucet-service <root>.testnet autogenerate-new-keypair save-to-legacy-keychain network-config testnet create
M="python3 ~/Entwicklung/Dashboard/tools/memcap.py --limit 4G --timeout 10m --"
$M node scripts/probe-tiers.mjs setup  --root <root>.testnet --out <file>.json   # sub-accounts, wNEAR, DAO (about 7.4 NEAR)
$M node scripts/probe-tiers.mjs probe  --root <root>.testnet --out <file>.json   # tiers, permissions, reject, remove, unregistered receiver
$M node scripts/probe-tiers.mjs gas    --root <root>.testnet --out <file>.json   # attached gas for the executing vote
$M node scripts/probe-tiers.mjs expire --root <root>.testnet --out <file>.json   # waits for proposal_period, finalizes what is open
```

`scripts/probe-tiers.mjs` uses only Node's standard library and `scripts/near-lite.mjs` (from Bonfire, same author). Each line of its output is PASS or FAIL against the expected outcome; the JSON keeps every receipt. The accounts and the DAO stay on testnet; the root's remaining 2.58 NEAR can fund the stage setup.
