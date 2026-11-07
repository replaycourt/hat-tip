# Hat Tip: design

A community that keeps its money in a Sputnik DAO pays its contributors from that DAO in rounds. In each round every member gets 100 thanks to hand to the people who helped them. When the round closes, the round's budget is split by the thanks each person received, after rules that blunt collusion. Every payout is a proposal in the community's own DAO, and how much of it leaves without a human depends on the receiver's track record: small payouts to members with a record execute at once, mid-size ones need one council member's vote, large ones (and most first payouts) need a council majority. Every reputation point traces to a round and to the members who gave it. The rules live in one NEAR contract with no access keys; custody and approvals stay in the DAO.

Track: Social Money (`social`). The track asks for shared budgets, programmable rewards, collective ownership and reputation-based access on top of Sputnik DAO and Trezu, without rebuilding the multisig. The example prompt asks for reputation tied to named accounts and traceable to finished work, three approval tiers (auto / one council member / full DAO vote), custody and approvals in an existing DAO, and a public board.

This file is the spec in words. The contract (`contract/`, API in `contract/README.md`) implements it, the simulation (`sim/`, `docs/SIMULATION.md`) models it with the same integer arithmetic and picks the parameters marked *sim*, and a golden test checks that both close the same rounds to the last base unit.

## Words

| Word | Meaning |
|---|---|
| community | one Sputnik DAO plus one `thanks` contract bound to it at init. One deployment serves one community. |
| DAO | the community's Sputnik v2 DAO, created by the public factory `sputnikv2.testnet`. It holds the money and does every approval. |
| member | a named NEAR account in the DAO policy role `members`. Only the DAO decides who is a member (an `AddMemberToRole` proposal). Implicit (64-hex) and `0x` accounts in that role are ignored. |
| council | the accounts in the DAO policy role `council`. They vote in the DAO. |
| guest | a wallet-less visitor (testnet demo only): a browser key, its implicit account, a seat in one round. |
| house member | a labelled demo account (named member or council member) run by a script in GitHub Actions with a published strategy. |
| round | one period of giving; length `round_ms` (testnet demo: 20 minutes). Rounds are numbered from 1 and follow the clock. |
| thanks | the 100 points a member (or seated guest) hands out in a round; whole numbers. Unspent thanks lapse. |
| note | one line (at most 80 bytes) an account posts in a round: what it did. It gives the givers something to go by. |
| counted thanks | thanks after the guest weight, the reciprocity discount and the other dampening rules. |
| points | a receiver's counted thanks in a round, kept in milli-thanks (1 thanks = 1,000). Each point is attributed to one giver. |
| reputation | an account's points over all rounds, decayed by `decay_bp` per round, minus strikes. |
| budget | what one round pays in total: `round_budget`, or less if the DAO holds less. |
| payout | one receiver's share of one round (plus carried change), paid by one DAO proposal. |
| tier | how a payout is approved: 1 auto, 2 one council vote, 3 council majority. |
| carry | a share too small to pay (`min_payout`), kept as a claim until a later round adds to it. |
| strike | reputation removed when the council rejects a payout. |
| tUSD | the demo's test dollar: an NEP-141 token with a fixed supply minted to the DAO at init, 6 decimals, no owner, no value. |

## Who holds what

| Thing | Where it lives | Who can change it |
|---|---|---|
| the money (tUSD, plus NEAR for the DAO's own storage) | the DAO account | only DAO proposals that pass the DAO's policy |
| who is a member, who is on the council | DAO policy roles `members` and `council` | DAO proposals (`AddMemberToRole`, `RemoveMemberFromRole`), council majority |
| what the `thanks` contract may do in the DAO | DAO policy role `thanks` (one member: the contract) | DAO proposals; the council can remove the role with one majority proposal at any time |
| rounds, allocations, notes, points, reputation, payouts and their DAO proposal ids | the `thanks` contract | nobody: the rules are fixed at init and the account has no keys |
| the tier rules and every other parameter | `thanks` contract config, set once at init | nobody |

The contract keeps a copy of the member and council lists and of the DAO's proposal bond, refreshed from `get_policy` at every close of a round with allocations and by `sync()` (a round nobody gave in closes without reading the DAO). The page reads the DAO live: `get_policy`, `get_proposals`, `get_proposal`, `get_last_proposal_id`, and the DAO's tUSD balance from `ft_balance_of`.

## One round

1. **Opening.** Round `r` runs from `genesis_ms + (r - 1) * round_ms` to `genesis_ms + r * round_ms`. Nothing opens a round; the clock does.

2. **Notes.** Any member or seated guest may post one note per round (`note(round, text)`, at most 80 bytes); a new note replaces the old one. Notes are shown on the page next to the account and kept with the round.

3. **Giving.** A member calls `allocate(round, gifts)` with a list of `(receiver, thanks)`. The call is refused unless:
   - `round` is the round the clock is in (a delayed transaction cannot land in the next round);
   - the caller is a member (from the last synced list) or a seated guest;
   - the thanks sum to at most `thanks_per_round` (100) and each is a whole number from 1 to `cap_per_receiver` (*sim*);
   - there are at most `max_receivers` receivers (10), none is the caller;
   - every receiver is a member or a seated guest, and a guest gives to members only.
   A new allocation replaces the giver's earlier one for the round. Only the last allocation before the close counts.

4. **Closing.** When the clock has passed a round's end, anyone may call `close_round()` (the page and the house script do it). Due rounds close in order. A round nobody gave in closes at once, with no payouts, and only reputation decays. A round with allocations fetches the DAO policy and the DAO's tUSD balance in one joined promise and is counted in the callback; one such round per call. Up to `max_catchup` empty rounds close in one call.

5. **Counting.** With `T[i][j]` the final allocation from giver `i` to receiver `j`:
   1. *Eligibility.* Drop entries whose giver or receiver is neither a member (by the policy just fetched) nor a guest seated in the round, and guest-to-guest entries.
   2. *Weight.* `w[i][j] = T[i][j] * 1000` for a member giver; `T[i][j] * guest_weight_bp / 10` for a guest giver. If the guests' total `G` exceeds `guest_cap_bp` of all weight (`G * (10000 - guest_cap_bp) > M * guest_cap_bp`, `M` the members' total), every guest weight is scaled down by `M * guest_cap_bp / (G * (10000 - guest_cap_bp))`, rounded down.
   3. *Reciprocity* (*sim*). For each pair that thanked each other, `m = min(w[i][j], w[j][i])`, and both directions lose `m * (10000 - reciprocal_bp) / 10000`. `reciprocal_bp = 10000` turns this off.
   4. *Aggregation* (*sim*). Linear: `a[i][j] = w[i][j]`. Quadratic: `v[i][j] = isqrt(w[i][j] * 1_000_000)`, `S[j] = sum_i v[i][j]`, `a[i][j] = W * v[i][j] * S[j] / Q` with `W = sum w` and `Q = sum_j S[j]^2`, so breadth of support counts more than size and the round's total stays `W`.
   5. *Breadth* (*sim*). If fewer than `breadth_k` givers support `j`, each `a[i][j]` is multiplied by `breadth_bp / 10000`.
   6. *Idle* (*sim*). If `j` is a member who gave nothing this round, each `a[i][j]` is multiplied by `idle_bp / 10000`.
   7. *Guests' receive cap* (*sim*). If the entries to guests `Pg` exceed `guest_receive_cap_bp` of the round's points (`Pg * (10000 - guest_receive_cap_bp) > Pm * guest_receive_cap_bp`, `Pm` the entries to members), every entry to a guest is scaled by `Pm * guest_receive_cap_bp / (Pg * (10000 - guest_receive_cap_bp))`, one floor per entry. `10000` turns it off.
   8. *Points.* `p[j] = sum_i a[i][j]`. Every point belongs to one giver, and the `points` event lists, for each receiver, every giver with the thanks given and the points counted.
   Every division rounds down. The simulation decides which of 3-7 are on (each has an off value), from the candidates in "Collusion and sybils"; `docs/SIMULATION.md` lists the exact integer rules.

6. **Reputation.** For every account with a record: `R = R * (10000 - decay_bp) / 10000 + p` (rounded down; `decay_bp` *sim*). Records of guests whose reputation falls below one thanks and who have no carry and no open payout are deleted.

7. **Budget.** `B = min(round_budget, dao_balance - reserve - owed)`, at least 0, with `dao_balance` the DAO's tUSD balance read at the close and `owed` what earlier rounds still owe: their payouts without a final outcome and the carries. A DAO that holds less pays less; a DAO that holds nothing pays nothing, and the round still counts for reputation. No round plans into the reserve, also while earlier payouts wait for the council.

8. **Shares.** `share[j] = B * p[j] / sum p` (rounded down), then `q[j] = share[j] + carry[j]`. If `q[j] < min_payout`, it becomes the new carry; a carry older than `carry_rounds` lapses back to the DAO (event `carry_lapsed`). Otherwise a payout of `q[j]` is planned and the carry is cleared. The rounding dust is never planned: it stays in the DAO.

9. **Tier.** With `R0` the receiver's reputation *before* this round's points (a burst of thanks cannot unlock itself):
   - `auto_limit = min(auto_max, R0 / 1000 * auto_per_thanks)`, or 0 if `R0 < auto_rep_min * 1000` or the receiver is a guest;
   - `cosign_limit = min(cosign_max, cosign_base + R0 / 1000 * cosign_per_thanks)`;
   - tier 1 if `q <= auto_limit`, else tier 2 if `q <= cosign_limit`, else tier 3.
   - Round cap: if tier-1 payouts add up to more than `auto_share_bp` of `B`, the largest are moved to tier 2 until they do not. No round sends more than that share out without a human.
   All limits are *sim*.

10. **Filing.** Anyone may call `pay(max)`; it files up to `max` planned payouts in order. For each: if the receiver is not yet registered with tUSD, the contract pays its `storage_deposit` (`registration_only`, 0.00125 NEAR) first; then it calls the DAO's `add_proposal` with the DAO's `proposal_bond` attached; the callback stores the DAO's proposal id. Tier 1: the callback then calls `act_proposal(id, VoteApprove, kind)`, and the DAO executes the transfer in the same chain. Tiers 2 and 3 wait in the DAO for the council. If `add_proposal` fails (role removed, bond changed), the payout stays planned and the contract marks itself `paused` until `sync()` or a later close of a round with allocations sees the role again.

11. **Outcome.** Anyone may call `check_payout(id)`: the contract reads the DAO proposal and records `paid` (Approved), `rejected`, `expired`, `removed` or `failed`. A council rejection or removal is a **strike**: the receiver loses that round's points, decayed to the present round, and the `struck` event names the payout. An expired proposal is finalized (`act_proposal(id, Finalize)`) so the DAO returns the bond; its amount stays in the DAO, without a strike. A failed transfer (the receiver left the token) is not refiled: the contract registers the receiver again and finalizes the proposal once, which makes the DAO run the approved transfer again; a second failure is final (`failed`, the bond stays in the DAO until someone finalizes it after expiry). While that retry runs, checks change nothing. Sputnik shows `Approved` before the transfer has run and `Failed` two blocks later, so `paid` is recorded only when a check sees `Approved` a second time, asked for at least three blocks after the first.

12. **Proposal text.** Short, to keep the DAO's storage small: `Hat Tip r42: 31.5 thanks from 5 -> ana.repaircafe.testnet (auto)`.

## The three tiers, in the DAO

Sputnik v2 has no amount limits. It has roles, per-role permissions per proposal kind (`<kind>:<action>`), and per-role vote policies per kind; a vote counts in every role of the voter that allows the action, and a proposal passes as soon as one of those roles reaches its threshold (`policy.rs`, `proposal_status`). Hat Tip maps its tiers onto two proposal kinds:

| Tier | DAO proposal | Who files | What approves it | Money path |
|---|---|---|---|---|
| 1 auto | `Transfer` (token tUSD) | `thanks` | the contract's own vote: role `thanks` has `transfer: 1 of 1` | DAO -> receiver, in the filing chain |
| 2 one council vote | `FunctionCall` on the tUSD contract: `ft_transfer(receiver, amount)`, 1 yoctoNEAR | `thanks` (only the `thanks` role may add `call` proposals) | any one council member: role `council` has `call: threshold 1` | DAO -> receiver, when the council member votes |
| 3 council majority | `Transfer` (token tUSD) | `thanks`, without voting | council majority (default vote policy 1/2 of a council of 3 = 2 votes) | DAO -> receiver, on the second vote |

Demo policy (passed to the factory at creation; JSON as `get_policy` returns it):

```json
{
  "roles": [
    {"name": "council", "kind": {"Group": ["council-a.<root>", "council-b.<root>", "council-c.<root>"]},
     "permissions": ["transfer:AddProposal", "config:AddProposal", "policy:AddProposal",
       "policy_add_or_update_role:AddProposal", "policy_remove_role:AddProposal",
       "policy_update_default_vote_policy:AddProposal", "policy_update_parameters:AddProposal",
       "add_member_to_role:AddProposal", "remove_member_from_role:AddProposal",
       "factory_info_update:AddProposal", "vote:AddProposal",
       "*:VoteApprove", "*:VoteReject", "*:VoteRemove", "*:Finalize"],
     "vote_policy": {"call": {"weight_kind": "RoleWeight", "quorum": "0", "threshold": "1"}}},
    {"name": "thanks", "kind": {"Group": ["<thanks contract>"]},
     "permissions": ["transfer:AddProposal", "transfer:VoteApprove", "call:AddProposal",
       "transfer:Finalize", "call:Finalize"],
     "vote_policy": {"transfer": {"weight_kind": "RoleWeight", "quorum": "0", "threshold": [1, 1]}}},
    {"name": "members", "kind": {"Group": ["ana.<root>", "ben.<root>", "..."]}, "permissions": [], "vote_policy": {}}
  ],
  "default_vote_policy": {"weight_kind": "RoleWeight", "quorum": "0", "threshold": [1, 2]},
  "proposal_bond": "10000000000000000000000",
  "proposal_period": "86400000000000",
  "bounty_bond": "1000000000000000000000000",
  "bounty_forgiveness_period": "86400000000000"
}
```

Why this holds:
- There is no `Everyone` role, so nobody else can file anything. The council cannot file `call` proposals, so every `call` proposal in the DAO comes from the contract, and the contract files only `ft_transfer` on the configured token for a planned tier-2 payout. One council vote can approve exactly those and nothing else; a council member who wanted more would need a majority `ChangePolicy` first.
- The contract never votes on a `call` (it lacks `call:VoteApprove`), so a tier-2 payout cannot pass without a council vote. The contract does not vote on tier-3 transfers, so they need two council votes.
- A single council `VoteReject` on a tier-2 proposal rejects it (threshold 1 applies to reject too): one council member can veto a mid-size payout. Tier 3 needs two votes either way.

What Sputnik enforces and what the contract enforces, stated plainly: Sputnik enforces who may file which kind and how many votes each kind needs. The *amounts* behind the tiers are enforced only by the contract's code, because Sputnik cannot limit amounts: the `thanks` role could in principle approve any transfer. The DAO's protections are that the contract has no keys and its code hash matches this repository, and that the council can remove the role with one majority proposal. The page and `judge-checks.sh` check all three.

The bond: `add_proposal` requires the attached deposit to equal `proposal_bond` exactly (`ERR_MIN_BOND`). The DAO returns it to the proposer (the contract) when the proposal is approved, rejected or finalized after expiry, and keeps it when the proposal is removed. The contract holds a bond float from its own balance (demo bond 0.01 NEAR).

Factory auto-update: a DAO from `sputnikv2.testnet` starts with `get_factory_info().auto_update = true`, so the factory owner could upgrade its code. The setup files a `FactoryInfoUpdate` proposal that turns it off, and the judge checks look for `false`.

## Collusion and sybils

Hard rules (always on): 100 thanks per round, at most `cap_per_receiver` to one receiver, no self-thanks, at most `max_receivers` receivers, only DAO members and seated guests take part, guests give to members only, reputation used for tiers is the reputation before the round, at most `auto_share_bp` of a round leaves without a human, and the council can reject (and strike) any tier-2 or tier-3 payout.

Dampening candidates; the simulation picks a combination and its values:

| Candidate | Rule | Hurts | Cost to honest members |
|---|---|---|---|
| R reciprocity | mutual thanks count at `reciprocal_bp` | a pair thanking each other | real mutual help is discounted too |
| Q quadratic | support counted as `(sum sqrt)^2`: breadth beats size | one big giver, a pair | a member helped mostly by one person |
| B breadth | fewer than `breadth_k` givers count at `breadth_bp` | pairs, solo patrons | quiet niche work |
| I idle | a member who gave nothing counts at `idle_bp` | free riders | members who skip a round |
| P pair memory (only if R, Q, B are not enough) | thanks to the same receiver beyond `pair_share_bp` of a giver's last `W` rounds count less | long-running pairs | stable working pairs |

The simulation runs many rounds of a community with honest members of uneven contribution, free riders, a colluding pair, a colluding ring of three and four, a newcomer, and a guest farm, and pre-registers its decision rule: lowest excess payout share of colluders (payout share minus contribution share) such that honest members' payouts still track contribution (rank correlation within 0.05 of no dampening) and an honest pair that really helps each other loses at most 15 % of its payout.

What these rules do **not** prevent, said plainly:
- A ring of members that thanks only itself still gets paid, less than it would without dampening, and its first payouts land in tier 2 or 3, in front of the council. A ring as large as the community wins: there is nothing left to compare it with.
- Sybils are kept out only by DAO membership. A DAO that admits fake members pays them.
- A council that colludes approves what it likes; that is the DAO's own trust assumption and no contract changes it.
- Popular people get thanked more than quiet ones. Peer thanks measure how the community sees the work, not the work.

## Guests: playing without a wallet (testnet demo)

As in Bonfire and Lantern Row (same author, independent projects): the browser makes an ed25519 key; the guest is the implicit account of that key (64 hex characters). Actions are JSON, signed by that key over `hattip:v1:<contract>:<nonce>:<action>`, and relayed through public function-call keys on a gas account that may only call `act`, `close_round`, `pay`, `check_payout` and `sync` on the contract. The contract checks the signature and a strictly rising nonce per key.

- `join` takes one of `guest_seats` seats in the current round (first come); a seat lasts one round and is renewed by acting in the next one while seats are free.
- A guest gives its 100 thanks to members only. Its thanks count at `guest_weight_bp` (5,000), and all guests together steer at most `guest_cap_bp` (2,000) of the round.
- Members may thank a guest; all guests together receive at most `guest_receive_cap_bp` (800: 8 %) of the round's points. House members thank guests by a published rule: each gives up to 5 thanks to at most two guests who posted a note and gave thanks this round. A guest's payout is tUSD to its browser account; a guest is never in tier 1, so its payouts need a council vote, which the house council casts by its published rule, and the page shows who voted.

Not prevented: one person can open many tabs and take every guest seat, which also keeps real visitors out. That person steers at most `guest_cap_bp` of the round among members (guests cannot give to guests) and collects what the house members' welcome rule hands out (about 10 thanks per house member and round), each payout behind a council vote: in the simulation about 8.8 tUSD of a 120 tUSD round. A member who works with such a farm, giving his thanks to its seats while the seats thank him, is limited twice: the seats receive at most 8 % of the round (their take falls from about 20 to 9.5 tUSD a round with the receive cap), and what the seats give him counts within `guest_cap_bp` (about 10 tUSD a round for him). Together that is still about a sixth of the budget, behind council votes. The receive cap also limits honest visitors: with the demo's usual traffic they keep about 85 % of what they would get without it, and in a busy hour (two new visitors a round) about 70 %. The relay keys can be drained by a script; each key has an allowance and the house script reports when the pool runs low.

## House members

The demo community (working idea: a volunteer *Repair Café*, notes like "fixed two kettles and a lamp") has about eight labelled house members and three house council members, named sub-accounts of the community's root account. Their strategies are published in `sim/params.json` and shown on the page: five honest contributors (contribution drawn per round, notes from it, thanks proportional to the notes plus noise), a colluding pair (labelled "demo: colluding pair"), and a free rider (labelled). The house council approves tier-2 payouts after at least two minutes unless the receiver's points this round came mostly from one reciprocal partner, and approves tier-3 payouts only when at least three givers stand behind them; otherwise it rejects. A GitHub Actions workflow runs the house script for just under six hours at a time, four times a day (Bonfire's `fire.yml` pattern): close due rounds, pay, check open payouts, post notes, give thanks, vote. The keys come only from a repository secret; without it the job does nothing. A real person (the owner) may hold one council seat.

## The page

A static page (GitHub Pages), no build step, no wallet, reading testnet RPC.

**20 seconds.** The round board: the Repair Café's members as cards with this round's note and the thanks they have received so far, a countdown to the close, the round's budget and the DAO's balance. Under it, last round's payouts in three columns: *Paid automatically*, *Waiting for one council vote*, *Council vote (1 of 2)*, each card linked to its DAO proposal. One button: *Give your 100 thanks*. Tapping +10 on a card moves the payout preview at once.

**2 minutes.**
1. *Give your 100 thanks* takes a guest seat (no wallet prompt) and sends the allocation; the card shows *given* and *counted*. On the colluding pair the page says why the numbers differ ("they thanked each other 25; counted 6.25 each").
2. Open a member: the reputation line over the rounds; every round's points with the givers behind them; every payout with its tier, DAO proposal id, votes and status; the member's current auto and co-sign limits.
3. *The rules*: the DAO policy rendered from `get_policy`, with the three tiers as the DAO itself states them, and the contract's parameters from `config()`.
4. *Replay*: the last close in five seconds (thanks become points, points become payouts, proposals appear in the DAO, tier 1 executes), and a second replay of the simulation: the same community with and without dampening.
5. *Proof*: the contract and the token with 0 access keys, the code hash checked against this repository, the DAO policy check, `audit()`, and every transaction this tab sent.
6. After the close: if members thanked you, your payout sits in *Waiting for one council vote* until a house council member votes in the DAO; then the tUSD shows in your browser account.

## No owner

Parameters are init arguments, stored once and shown by `config()`; there is no method that changes them. After deployment every access key of the contract account, and of the token account, is deleted. The build checks that the wasm exports no method beyond the round, the relay, the callbacks and the views. The DAO is the only party that can stop the contract (remove its role), and that is visible in the policy.

## Log and views

- NEP-297 events, standard `hattip`: `synced`, `paused`, `joined`, `note`, `allocated`, `round_closed`, `points`, `payout_planned`, `carry`, `carry_lapsed`, `filed`, `approved`, `paid`, `rejected`, `expired`, `removed`, `failed`, `struck`. Replaying them rebuilds every reputation and every payout.
- Views: `config()`, `state()`, `round(n)` (last `log_keep` rounds in full), `member(account)`, `payouts(from, limit)`, `tiers(account)`, `audit()`, `signing_text(nonce, action)`. Exact signatures in `contract/README.md`.
- `audit()`: budgets add up (`sum budgets = sum planned + sum carry + sum lapsed carry + dust`), every round's points equal the sum of their attributions, every payout has exactly one status, and every filed payout has a DAO proposal id.

## Launch parameters

*sim* = picked by the simulation, recorded in `sim/params.json` and `docs/SIMULATION.md`. "Community" is an example for a real community with weekly rounds; "Testnet demo" is what the demo runs.

| Parameter | Community (example) | Testnet demo |
|---|---|---|
| `round_ms` | 604,800,000 (one week) | 1,200,000 (20 minutes) |
| `thanks_per_round` | 100 | 100 |
| `cap_per_receiver` | *sim* (candidates 25, 34, 40, 50) | same |
| `max_receivers` | 10 | 10 |
| `reciprocal_bp`, `quadratic`, `breadth_k`, `breadth_bp`, `idle_bp` | *sim* | same |
| `decay_bp` (per round) | *sim* (about 500-1,000) | *sim*, scaled to 20-minute rounds |
| `round_budget` | 500 tUSD | *sim* (about 100-150 tUSD) |
| `min_payout` | 5 tUSD | 5 tUSD (*sim*; at 2 tUSD the demo files more than 7 payouts a round) |
| `carry_rounds` | 8 | 12 |
| `reserve` | 0 | 0 |
| `auto_rep_min`, `auto_per_thanks`, `auto_max` | *sim* | *sim* |
| `cosign_base`, `cosign_per_thanks`, `cosign_max` | *sim* | *sim* |
| `auto_share_bp` | *sim* (about 6,000) | *sim* |
| `guest_seats`, `guest_weight_bp`, `guest_cap_bp` | 0, -, - | 6, *sim* (about 5,000), *sim* (about 2,000) |
| `guest_receive_cap_bp` | 800 (never binds without guests) | 800 (*sim*: 8 % of a round's points to all guests together) |
| `max_members` | 48 | 24 |
| `max_catchup` | 8 | 36 |
| `log_keep` | 52 rounds | 108 rounds (36 hours) |
| DAO `proposal_bond` | 0.1 NEAR | 0.01 NEAR |
| DAO `proposal_period` | 7 days | 24 hours |
| tUSD supply (to the DAO) | - | 1,000,000 |

Target for the testnet values: in steady state roughly 70 % of payouts in tier 1, 25 % in tier 2 and 5 % in tier 3, so all three show up every hour; and a newcomer with honest help reaches tier 1 within about 6-10 rounds.

## Honest limits

- The tier amounts are enforced by the contract, not by Sputnik, which has no amount limits (see "The three tiers"). The DAO trusts verifiable code and keeps the off switch.
- Collusion is dampened, not stopped; sybil resistance is DAO membership; guests are a demo device with caps.
- Activity in the demo comes mostly from labelled house members with scripted strategies, including the colluding pair and the free rider.
- Sputnik never deletes proposals: each payout leaves about 350 bytes (about 0.0035 NEAR) in the DAO's storage for good. That is why small shares are carried rather than paid.
- The contract's copy of the member and council lists is as fresh as the last close of a round with allocations or `sync()`.
- Testnet only. tUSD is a test token. Trezu's hosted app is mainnet-only; on mainnet a Trezu treasury is a Sputnik DAO (`*.sputnik-dao.near`) and the same contract works with it, but this was not run.
- The testnet DAO code (factory default, `version()` 2.3.1) has no `get_actions_log`; the page reads proposals by id.

## Prior art

Peer allocation is not new: Coordinape (GIVE circles per epoch), SourceCred, Colony's decaying reputation, Gitcoin's quadratic funding, Optimism RetroPGF. New here: the payouts go through the community's existing Sputnik DAO with the three tiers written into the DAO's own policy; the collusion rules are chosen by a published simulation and checked by a golden test against the contract; the contract has no keys; and a visitor can take part without a wallet.

## Fits the prompt

| Prompt asks | Hat Tip |
|---|---|
| Shared budgets, programmable rewards, collective ownership, reputation-based access | programmable rewards: the round budget, split by peer thanks under published rules; reputation-based access: the auto and co-sign limits grow with reputation |
| Build on Sputnik DAO and Trezu, don't rebuild the multisig | custody, approvals, membership and council all live in a Sputnik v2 DAO from the public factory; no multisig code. Trezu: compatible by construction (a Trezu treasury is a Sputnik DAO), not run (mainnet-only app) |
| Members post bounties, contributors claim and finish them (example) | not built as bounties: the unit of work is a round's help, stated in a note and recognised by the people helped. Honest gap against the example, deliberate |
| Payouts flow from the treasury | every payout is a DAO proposal paid by the DAO |
| Reputation tied to named accounts, every point traceable | members are named accounts in the DAO's `members` role; every point is attributed to a round and a giver (`points` events, `member()` view) |
| Tiers: auto for trusted / one council member / full DAO vote | tier 1 `Transfer` approved by the contract's role; tier 2 `FunctionCall ft_transfer` approved by one council vote; tier 3 `Transfer` by council majority. All three visible in `get_policy` |
| Use the existing DAO for custody and approvals | yes; the contract never holds the money |
| A public board | the page: round board, payouts by tier with DAO links, every member's record |
| Which approval flows exist, which must be added | exist: per-kind permissions and per-role vote policies, bonds, expiry, finalize, bounties. Added: nothing in the DAO; the contract decides which kind (and so which tier) each payout is filed as |
| Hint: named accounts (near.social) | named members; optional: near.social profile names on the cards |

## Feasibility evidence (2026-11-07, read-only)

- Factory `sputnikv2.testnet` is live: 5,451 DAOs, default code `AA4nA45vauiac3jdVwJTzSdUP3oj2r1fDaPAb2mHdgcH` (metadata version 3.31, `version()` "2.3.1"). Its last 25 transactions are `create` calls with 6 NEAR attached, about 89 Tgas burnt and a fee of about 0.015 NEAR; a call with 4 NEAR failed with `ERR_NOT_ENOUGH_DEPOSIT:5396790000000000000000000` (tx `6isi1FnLR3ZtAyJjAJi99N6yqpDBwzPEMonoLywnfpap`). The testnet factory deploys the full wasm (about 540 KB), not a global contract.
- `create(name, args)`: `args` is base64 of `{"config": {"name", "purpose", "metadata"}, "policy": <list of council accounts | full policy>}` (`VersionedPolicy` is untagged).
- A keyless contract in a DAO role filing and approving transfers works today: Petty Cash's `pettycash.testnet` (0 keys) in DAO `harbor-builders.sputnikv2.testnet`, tx `2F1uJZHSLuFjYV9c5tEcWRUetcd9q28eNQ8gzvqzTnPx`: `add_proposal` 2.2 Tgas (0.1 NEAR bond attached), callback 2.9, `act_proposal(id, VoteApprove, proposal: <kind>)` 3.1, `ft_transfer` 1.8, `on_proposal_callback` 2.4, bond returned to the contract; whole chain 24 Tgas, fee 0.0022 NEAR. The `proposal` argument of `act_proposal` is accepted by the testnet code.
- A weight threshold `"threshold": "1"` per kind is in use on testnet (Patch Fund's DAO, `bounty_done`).
- Testnet protocol 88: 1,000 Tgas per transaction and per receipt; storage 10^19 yoctoNEAR per byte.
- Sources read: `near-daos/sputnik-dao-contract` at `5434a59` (`policy.rs` roles, thresholds and `proposal_status`; `proposals.rs` `add_proposal`, `act_proposal`, bonds, `FunctionCall` execution; factory `create`), `NEAR-DevHub/trezu` at `a6aaaf6` (`nt-fe/README.md`: "The production backend is mainnet-only"; testnet DAOs only through a local mock).
