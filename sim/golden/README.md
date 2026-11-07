# Golden vectors (I-3)

Each `*.json` file here is a fixed script of rounds played through the reference model in `sim/hat_tip_sim.py` (class `Hat`), with every number the contract's close must produce. The contract (Rust test through the mock VM) and the page's `logic.js` (node test) must reproduce every expected value exactly, to the base unit and the milli-thanks.

Regenerate and compare: `python3 sim/hat_tip_sim.py --check` (fails if a file differs from what the model computes now); write: `python3 sim/hat_tip_sim.py golden`.

| File | What it exercises |
|---|---|
| `linear.json` | all dampening off; a replaced allocation; `0x` and implicit accounts in the members role (ignored); two empty rounds (one lapses a carry); a DAO holding less than the budget, then nothing; a member removed at a close; a round whose only entries are dropped (no points, no budget); carries growing and lapsing; tiers growing with reputation; the tier-1 round cap |
| `dampening.json` | reciprocity, quadratic aggregation, breadth and idle all on; a colluding pair; a one-way ring of three; strikes from a rejected and a removed payout (one decayed across rounds, one across an empty round); expired and paid payouts; a five-way tie in the round cap |
| `guests.json` | seated guests; guest weight with rounding (3,333 bp); the guests' cap binding and not binding; reciprocity between a guest and a member; a guest entry dropped because its member left the DAO; a guest never in tier 1, even with the reputation for it; a guest's reputation set to 0 below one thanks; a carry lapsing |
| `receive_cap.json` | the guests' receive cap (rule 17) at 10 %: a member feeding three guest seats that thank him back, with reciprocity, breadth and the giving cap on; the cap binding (with rounding) and not binding; a round whose only entry goes to a guest (no points, no budget) |
| `launch_testnet.json`, `launch_community.json` | the launch parameters of `sim/params.json` with allocations drawn by the behaviour models (house community with visitors and council outcomes; a 24-member community at full size) |

## Format

```text
{
  "name", "about", "format",
  "config":          the contract's Config (I-1 field names; U128 fields as decimal strings;
                     guest_receive_cap_bp is left out where it is 10000, its default)
  "initial_members": the members role before round 1 (what the first sync() sees)
  "rounds": [{
    "round":        n (rounds are numbered from 1 and closed in order)
    "outcomes":     [{"round", "receiver", "status"}]  DAO outcomes read by check_payout during
                    this round, before its close; status paid | rejected | removed | expired
    "seats":        guest accounts seated in this round
    "notes":        [[account, text]]  (do not affect any number)
    "allocations":  [{"giver", "gifts": [[receiver, thanks]]}]  allocate calls in call order;
                    a later call replaces the giver's earlier one. Every call is valid against
                    the members list in force during the round (the last fetched list) and the seats.
    "members":      the members role as get_policy returns it at this close (null for an empty round)
    "dao_balance":  the DAO's tUSD balance read at this close (null for an empty round)
    "expected": {
      "empty":        true if no allocation exists at the close
      "strikes":      [[receiver, payout round, status, amount]]  from this round's outcomes
      "entries":      [[giver, receiver, thanks, weight, after_reciprocity, aggregated, counted]]
                      eligible entries in (giver, receiver) order; weight after the guest weight
                      and cap, counted after breadth, idle and the receive cap (milli-thanks)
      "dropped":      [[giver, receiver, thanks, reason]]
      "members_weight", "guests_weight", "guest_scaled"   M and G before the cap, and whether it bound
      "to_guests", "to_members", "receive_scaled"   Pg and Pm before the receive cap, and whether
                      it bound (only in vectors with guest_receive_cap_bp below 10000)
      "points":       [[account, points]]  every account with an entry, points may be 0
      "budget", "dust"
      "payouts":      [{"receiver", "amount", "tier", "r0", "auto_limit", "cosign_limit"}]
                      in receiver order, after the round cap
      "moved_to_tier2": receivers the round cap moved, in the order moved
      "lapsed":       [[account, amount, stamp]]  carries that lapsed at this close (also in empty rounds)
      "reputation":   [[account, reputation]]  every account with reputation > 0 after the close;
                      an account not listed has 0
      "carry":        [[account, amount, stamp: the round the carry began]] after the close
      "audit":        cumulative budget, planned, carry, lapsed, dust; budget = planned + carry +
                      lapsed + dust
    }
  }]
}
```

Units: thanks are whole numbers; weights, points and reputation are milli-thanks (1 thanks = 1,000); tUSD amounts are base units (6 decimals: 1 tUSD = 1,000,000). All u128 values are decimal strings.

## The integer rules the vectors fix

DESIGN.md "One round" leaves some details open. The simulation decided each in favour of the simplest exact integer rule; the contract must match. The same list heads `docs/SIMULATION.md`. Rule 17 follows the contract's README ("Counting, exactly", step 7).

1. **Members and guests.** The member set is the named accounts of the members role; 64-hex implicit accounts and `0x` accounts in the role are ignored. A guest is an implicit account seated in the round.
2. **Order.** Entries are processed in (giver, receiver) order of the account ids compared as bytes, payouts are planned in receiver order. Only the round cap's tie-break depends on an order.
3. **Eligibility at the close.** An entry counts if its giver and its receiver are each a member (by the policy fetched at this close) or a guest seated in the round, and they are not both guests. A round is empty when no giver holds an allocation with at least one gift at the close; an empty round fetches nothing and plans nothing: reputation decays and old carries lapse (rule 14).
4. **Guest weight and cap.** A guest entry weighs `thanks * guest_weight_bp / 10`. `M` and `G` are the members' and guests' total weight after eligibility. If `G * (10000 - guest_cap_bp) > M * guest_cap_bp`, every guest entry becomes `w * (M * guest_cap_bp) / (G * (10000 - guest_cap_bp))`: one floor per entry, not a rounded factor.
5. **Reciprocity.** For each pair with entries both ways, `d = min(w_ij, w_ji) * (10000 - reciprocal_bp) / 10000`, from the weights of rule 4; both entries lose the same `d`.
6. **Quadratic.** `v = isqrt(w * 1_000_000)`, `S_j = sum of v` over j's entries, `W = sum of all w` after reciprocity, `Q = sum over receivers of S_j^2`, `a = W * v * S_j / Q` (multiply first, one floor; u128). `Q = 0` gives 0.
7. **Breadth.** `n_j` = the number of j's entries with `a > 0` after aggregation (guests count as givers). If `breadth_k > 0` and `n_j < breadth_k`: `a = a * breadth_bp / 10000`.
8. **Idle.** If j is a member without an allocation in this round (none, or an empty one; judged before eligibility): `a = a * idle_bp / 10000`, after the breadth rule (two floors). Guests are never idle.
9. **Points.** `p_j = sum of a`. Only accounts with `p_j > 0` take part in reputation, shares and tiers.
10. **Reputation.** `R0`, used for tiers, is the reputation after the previous close and any strikes since: before this round's decay and points. At every close (empty or not) every record decays once, with its own floor: `R = R * (10000 - decay_bp) / 10000`; then `p` is added. A lazy implementation must apply the floor round by round, not one power. A guest's reputation below 1,000 becomes 0, after each decay step and after its points are added.
11. **Budget.** `B = min(round_budget, max(0, dao_balance - reserve - owed))`; if the round's points sum to 0, `B = 0`. `owed` is what earlier rounds still owe when the round closes: the amounts of their payouts without an outcome and the carries (added after the pre-lock review; no vector has owed amounts at a close where the DAO's balance binds, so the vectors are the same as before but for `linear.json`'s outcomes).
12. **Shares and carry.** For every account with `p > 0`, in account order: `share = B * p / sum p`, `q = share + carry`. If `0 < q < min_payout`, `q` becomes the carry; its stamp is the round the carry began (kept while it grows, this round for a new carry). If `q >= min_payout` (and `q > 0`), a payout of `q` is planned and the carry is cleared. `dust = B - sum of shares`.
13. **Tiers.** `units = R0 / 1000`. `auto = 0` for a guest or if `R0 < auto_rep_min * 1000`, else `min(auto_max, units * auto_per_thanks)`; `cosign = min(cosign_max, cosign_base + units * cosign_per_thanks)`. Tier 1 if `q <= auto`, tier 2 if `q <= cosign`, else tier 3. **Round cap:** while the tier-1 sum `* 10000 > B * auto_share_bp`, the largest tier-1 payout moves to tier 2 (ties: the lower account id first); it goes to tier 2 even if it is above its co-sign limit.
14. **Carry lapse.** At every close (empty or not), after the shares, every carry with `r - stamp >= carry_rounds` lapses.
15. **Guest records.** A guest record with reputation 0, no carry and no open payout may be deleted; that changes no number.
16. **Strikes.** A payout found `rejected` or `removed` costs its receiver that round's points decayed `c - r` times (per-round floors), `c` the last closed round when the outcome is read: `R = R - min(R, strike)`. `paid`, `expired` and `failed` cost nothing.
17. **Guests' receive cap** (`guest_receive_cap_bp`, the last `Config` field, optional, default 10000 = off; added after the first vectors). Applied after rule 8 (idle), before the points: `Pg` = sum of `a` over entries to guests, `Pm` over entries to members. If `Pg * (10000 - guest_receive_cap_bp) > Pm * guest_receive_cap_bp`, every entry to a guest becomes `a * (Pm * guest_receive_cap_bp) / (Pg * (10000 - guest_receive_cap_bp))`, one floor per entry (the same rule as the giving cap of rule 4). With `Pm = 0` and `Pg > 0` the guests get 0.
