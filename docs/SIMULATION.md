# Hat Tip: simulation of peer thanks rounds

DESIGN.md leaves the collusion rules, the tier limits and some budget values to a simulation (*sim* in its parameter table). This document is that simulation. It models the contract's round close in the contract's integer arithmetic, plays communities of honest members, free riders, colluding pairs and rings, a newcomer, visitors and a guest farm through it, and picks the launch values in `sim/params.json` by a decision rule written down before the sweep ran.

## Integer rules decided here (the contract must match)

DESIGN.md "One round" and I-1 leave some details open. Each was decided in favour of the simplest exact integer rule. The golden vectors in `sim/golden/` fix them, and `sim/golden/README.md` carries the same list.

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
11. **Budget.** `B = min(round_budget, max(0, dao_balance - reserve))`; if the round's points sum to 0, `B = 0`.
12. **Shares and carry.** For every account with `p > 0`, in account order: `share = B * p / sum p`, `q = share + carry`. If `0 < q < min_payout`, `q` becomes the carry; its stamp is the round the carry began (kept while it grows, this round for a new carry). If `q >= min_payout` (and `q > 0`), a payout of `q` is planned and the carry is cleared. `dust = B - sum of shares`.
13. **Tiers.** `units = R0 / 1000`. `auto = 0` for a guest or if `R0 < auto_rep_min * 1000`, else `min(auto_max, units * auto_per_thanks)`; `cosign = min(cosign_max, cosign_base + units * cosign_per_thanks)`. Tier 1 if `q <= auto`, tier 2 if `q <= cosign`, else tier 3. **Round cap:** while the tier-1 sum `* 10000 > B * auto_share_bp`, the largest tier-1 payout moves to tier 2 (ties: the lower account id first); it goes to tier 2 even if it is above its co-sign limit.
14. **Carry lapse.** At every close (empty or not), after the shares, every carry with `r - stamp >= carry_rounds` lapses.
15. **Guest records.** A guest record with reputation 0, no carry and no open payout may be deleted; that changes no number.
16. **Strikes.** A payout found `rejected` or `removed` costs its receiver that round's points decayed `c - r` times (per-round floors), `c` the last closed round when the outcome is read: `R = R - min(R, strike)`. `paid`, `expired` and `failed` cost nothing.

Units: thanks are whole numbers; weights, points and reputation are milli-thanks (1 thanks = 1,000); tUSD amounts are base units (6 decimals).

## Rerun it

```
python3 sim/hat_tip_sim.py
```

Python 3.8 or later, standard library only. Every run is deterministic: the same seeds give the same numbers to the last unit.

## Pre-registered decision rule

Written and committed before the sweep ran. The sweep applies it mechanically; the launch values are what it returns.

### Stage A: the collusion rules (community setting)

**Candidates.** `cap_per_receiver` in {25, 34, 40, 50}; `reciprocal_bp` in {10000 (off), 7500, 5000, 2500}; `quadratic` off or on; breadth (`breadth_k`, `breadth_bp`) in {off, (2, 5000), (3, 5000), (4, 5000), (3, 2500)}; `idle_bp` in {10000 (off), 7500, 5000, 2500}. 640 rule sets. The baseline "no dampening" is cap 50 with R, Q, B and I off.

**Communities.** 52 weekly rounds of a 24-member community, `round_budget` 500 tUSD, `min_payout` 5 tUSD, `carry_rounds` 8. Every community has honest members of uneven contribution, among them an honest pair that works closely together and thanks each other a lot, and a newcomer who joins at round 13. Scenarios: honest only; four free riders (who give nothing); a colluding pair; a colluding ring of three; a colluding ring of four. 8 seeds.

**Colluders play their best response.** Each ring has two strategies: *mutual* (every member thanks every other member the cap every round) and *one-way* (each pair of ring members thanks in one direction only, alternating by round, so no entry is reciprocal). For each rule set and seed, the colluders use whichever pays them more over the 52 rounds.

**Measures** (per scenario and seed, over all rounds, on the payouts the rules plan, before any council vote):
- *colluders' excess*: the colluders' share of all planned payouts minus their share of all contribution, in percentage points;
- *tracking*: the Spearman rank correlation between honest members' total planned payout and their total contribution;
- *honest-pair loss*: 1 minus the honest pair's planned payout under the rule set divided by its payout under the baseline, same seed.

**Constraints.**
- (a) Tracking: in each of the five scenarios, the median over seeds is at least the baseline's median minus 0.05.
- (b) Honest pair: the median over seeds of the honest-pair loss (honest-only scenario) is at most 15 %.

**Objective.** The lowest mean, over the pair, ring-of-three and ring-of-four scenarios, of the median-over-seeds colluders' excess.

**Ties.** Rule sets within 0.25 percentage points of the best objective count as equal. Among them: fewest of R, Q, B, I switched on; then the lowest free riders' excess (free-rider scenario); then the larger `cap_per_receiver`; then the values closest to off.

Pair memory (P in DESIGN.md) is not in I-1. The simulation does not implement it; it reports what the chosen rules leave to the one-way strategy, which is what P would target.

### Stage C: budget and minimum payout (testnet demo)

**Setting.** The testnet house community of DESIGN.md (five honest contributors, a colluding pair, a free rider; the house council's published rule) with visitors arriving at 0.5 per round on average and a newcomer joining at round 61, over 144 rounds of 20 minutes, with the stage A rules and the first-guess tier limits. 6 seeds.

**Candidates.** `round_budget` in {100, 120, 150} tUSD; `min_payout` in {1, 2, 3, 5} tUSD.

**Criteria.** On average at most 7.0 planned payouts per round (PLAN.md's NEAR budget assumes about 6 at 0.006 NEAR each in storage and gas; 7 costs about 6 NEAR more over the demo); at least 75 % of the visitors thanked by at least three house members get a payout; carry that lapses is at most 2 % of the budgets.

**Pick.** Among the candidates that pass, the one fewest grid steps from the first guess (120, 2); ties go to the lower `min_payout`, then the larger budget.

### Stage B: tier limits and decay (both settings)

**Settings.** Testnet: as stage C with its pick; the steady state is rounds 49-144. Community: the mixed community (19 honest members, two free riders, a colluding pair with its stage-A best response, a newcomer joining at round 53), 104 weekly rounds, `round_budget` 500 tUSD, `min_payout` 5 tUSD; the steady state is rounds 53-104. Both with the house council's published rule (rejections are strikes). 6 seeds.

**Knobs and grids** (amounts relative to `round_budget` B): `decay_bp` in {300, 500, 750, 1000}; `auto_rep_min` in {100, 200, 300, 500} thanks; `auto_per_thanks` in {0.005, 0.01, 0.02, 0.05} % of B per thanks; `auto_max` in {8, 12, 16, 25} % of B; `auto_share_bp` in {5000, 6000, 7000, 8000}; `cosign_base` in {4, 8, 12, 16} % of B; `cosign_per_thanks` in {0.01, 0.02, 0.05, 0.1} % of B per thanks; `cosign_max` in {25, 40, 60, 80} % of B. First guess: 500, 200, 0.02 %, 12 %, 6000, 8 %, 0.05 %, 40 %.

**Criteria.** In steady state, by count of planned payouts: tier 1 between 60 and 80 %, tier 2 between 15 and 35 %, tier 3 between 2 and 10 %; the newcomer's first tier-1 payout comes 6 to 10 rounds after it joins (median over seeds; the joining round counts as round 1).

**Pick.** A coordinate search in three groups (B1: `decay_bp`, `auto_rep_min`, `auto_per_thanks`; B2: `auto_max`, `auto_share_bp`; B3: `cosign_base`, `cosign_per_thanks`, `cosign_max`), repeated until a pass changes nothing (at most four passes). In each group the combination with the lowest score wins: score = `|t1 - 70| + |t2 - 25| + |t3 - 5|` (steady-state tier shares in percentage points) plus 5 for every round the newcomer's median lies outside 6-10. Scores within 1 count as equal, and then the combination fewest grid steps from the current values wins. The final values must meet the criteria; if they do not, this document says so.
