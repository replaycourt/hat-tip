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
17. **Guests' receive cap** (`guest_receive_cap_bp`, the last `Config` field, optional, default 10000 = off; added after the first vectors). Applied after rule 8 (idle), before the points: `Pg` = sum of `a` over entries to guests, `Pm` over entries to members. If `Pg * (10000 - guest_receive_cap_bp) > Pm * guest_receive_cap_bp`, every entry to a guest becomes `a * (Pm * guest_receive_cap_bp) / (Pg * (10000 - guest_receive_cap_bp))`, one floor per entry (the same rule as the giving cap of rule 4). With `Pm = 0` and `Pg > 0` the guests get 0.

Units: thanks are whole numbers; weights, points and reputation are milli-thanks (1 thanks = 1,000); tUSD amounts are base units (6 decimals).

## Result in short

- **Collusion rules (both settings):** `cap_per_receiver` 25, reciprocity at 25 % (`reciprocal_bp` 2500), breadth on (fewer than 3 givers count 25 %: `breadth_k` 3, `breadth_bp` 2500), quadratic off, idle off. Against no dampening (cap 50), the colluders' excess payout share falls from +3.5 / +13.8 / +17.9 percentage points (pair / ring of three / ring of four) to -0.7 / +2.0 / +5.4, with colluders playing their best response. Honest members' payouts track their work as well as without dampening (rank correlation 0.85 against 0.83); the honest pair loses 11 % of its payout (limit 15 %).
- **Quadratic aggregation** cuts collusion the most (objective below 0), but the honest pair loses 28-33 %: it fails the pre-registered limit. **Idle** makes collusion slightly worse (it discounts honest members who skip a round) and is evaded by a free rider who hands out token thanks.
- **Testnet demo:** budget 120 tUSD, `min_payout` 5 tUSD (6.9 payouts per round, 91 % of visitors thanked by three house members get paid); decay 7.5 % per round; tier 1 from 200 thanks of reputation at 0.06 tUSD per thanks up to 30 tUSD, at most 80 % of a round's budget automatic; co-sign up to 14.4 tUSD plus 0.06 per thanks, at most 30 tUSD. Steady state: 72 % of payouts in tier 1, 23 % in tier 2, 5 % in tier 3; a newcomer reaches tier 1 after 8 rounds.
- **Community example:** decay 10 % per week; tier 1 from 100 thanks at 0.1 tUSD per thanks up to 60 tUSD, at most 60 % automatic; co-sign 20 tUSD plus 0.05 per thanks up to 200 tUSD. 70 / 24 / 6 % by tier; a newcomer reaches tier 1 after 7 rounds.
- **Not stopped** (details below): a ring of four keeps +5.4 points; colluders who thank one way only pass the council's rule; four free riders still collect 3.2 % of payouts; a member who feeds his thanks to a guest farm moves about a quarter of the testnet budget to himself and the farm.

## Rerun it

```
python3 sim/hat_tip_sim.py
```

Python 3.8 or later, standard library only. It runs the sweep (stages A, C and B; about 10 minutes on four idle cores), writes `sim/params.json` and `sim/sweep.json`, runs the scenarios with the picked values, draws the charts, writes the golden vectors and the replay, and fills the generated blocks of this document. `python3 sim/hat_tip_sim.py scenarios` redoes everything after the sweep in about a minute; `python3 sim/hat_tip_sim.py --check` recomputes the golden vectors, the replay and `sim/params.json` and fails on any difference (`--check --sweep` reruns the sweep as well). Every run is deterministic: the same seeds give the same numbers to the last unit. Tables between `generated` markers are written by the script; the prose around them rounds the same numbers.

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

### Stage D: the guests' receive cap (testnet demo)

Added after stages A, C and B had run, when the contract gained `guest_receive_cap_bp` (rule 17) to close the gap those stages found: a member who feeds his thanks to a farm of guest seats. Written and committed before stage D ran.

**Setting.** The testnet launch values of stages A, C and B, 144 rounds, 8 seeds, four variants: the house community with visitors at 0.5 per round and the newcomer (as in stages B and C); a busy demo with visitors at 2 per round; the guest farm with the free rider as accomplice; the outsider farm (reported only).

**Candidates.** `guest_receive_cap_bp` in {10000 (off), 2000, 1500, 1000, 800, 600, 500, 400, 300}.

**Criteria** (medians over seeds; visitors pooled over seeds):
- the farm seats' take (tUSD per round, accomplice variant) is at most 50 % of their take without the cap;
- visitors at 0.5 per round keep at least 80 % of their share of planned payouts without the cap, and at least 75 % of the visitors thanked by three or more house members get a payout (the stage C criterion);
- in the busy demo, visitors keep at least 50 % of their share of planned payouts without the cap.

**Pick.** The largest value (the loosest cap) that meets all criteria. If none does, the largest value that meets the first two, and this document says what the busy demo loses. The community column gets the same value; with `guest_seats` 0 it never binds there.

## Method

**The model.** `Hat` in `sim/hat_tip_sim.py` is the contract's round close: counting (eligibility, weight and the guests' cap, reciprocity, aggregation, breadth, idle, points), reputation with decay, budget, shares and carry, tiers with the round cap, carry lapse, and strikes from DAO outcomes, all in the integer rules above. After every close it checks that the budgets add up: every budget unit is planned, carried, lapsed or dust. The sweep evaluates the counting for many rule sets at once (`staged_totals`); in every sweep run it checks two random rule sets against the full model and stops if a single base unit differs.

**Rounds.** Every round each member draws, from its own random stream, whether it works, how much, and whether it hands out thanks. Allocations are then counted and the round closed. The council decides every tier-2 and tier-3 payout before the next close by the house council's published rule (below); a rejection is a strike. The DAO always holds more than the budget, except in the golden vectors.

**Behaviour models.**

| Behaviour | Works | Gives | How it gives |
|---|---|---|---|
| honest member | 9 rounds in 10; work = base x lognormal(0, 0.35); bases lognormal(0, 0.7), so contributions are uneven | 85 % of rounds | to the members whose work it sees: work x visibility x affinity x lognormal(0, 0.5) noise; the top 10, dropping anyone below 15 % of its top pick; 100 thanks in proportion, whole numbers, at most the cap each. Affinity is 1 for about six collaborators and 0.25 for everyone else; visibility (popularity) is lognormal(0, 0.3) per member |
| honest pair | as honest | as honest | two honest members who work together: affinity 4 to each other, so they thank each other a lot |
| free rider | never; its notes look like 0.3 of a median member's work | never (in "free riders who give": every round, like an honest member) | - |
| colluder | half of what its base suggests | every round | first the cap to ring members (mutual: every other ring member; one-way: each pair of ring members in one direction only, alternating by round), the rest like an honest member |
| newcomer | as an honest member with base 1 (the median) | as honest | as honest; joins at round 13 (52-round runs) or 53 (104-round runs) |
| house member (testnet) | 9 rounds in 10; items = round(mean x lognormal(0, 0.4)), means 6, 5, 4, 3, 2.5 for the five honest members, 2 for each of the pair | every round it works | welcome thanks to guests first (5 each to up to two guests who posted a note and gave), then the rest by items in the notes x lognormal(0, 0.5) noise; the pair gives each other the cap first |
| free rider (testnet) | never; its note claims one item half of the time | never | - |
| visitor (testnet) | - | 9 times in 10 | arrives at 0.5 per round (Poisson), comes back for the next round with chance 0.4, posts a note 8 times in 10, gives 100 thanks to 2-5 members by the items in their notes x noise |
| guest farm (testnet) | - | every round | one person holds all six guest seats every round and posts a note in each; outsider: spreads each seat's thanks over three random members; with an accomplice: each seat gives the free rider the cap, and the free rider gives its 100 thanks to three of the seats |
| house council | - | - | approves a tier-2 payout unless more than half of the receiver's points came from one giver whom the receiver also thanked that round; approves a tier-3 payout only if at least three givers stand behind it; rejects otherwise |

Every member has its own random stream, so scenarios that share members draw the same work and noise for them, and the two colluder strategies and all rule sets of a seed see the same honest community.

**Scenarios.**

| Scenario | Members (24 in all) |
|---|---|
| Honest community | 23 honest members (two of them the honest pair) and the newcomer |
| Free riders | 19 honest, 4 free riders, the newcomer |
| Free riders who give | as "Free riders", but the free riders hand out thanks every round |
| Colluding pair | 21 honest, a colluding pair, the newcomer |
| Colluding ring of three / four | 20 / 19 honest, the ring, the newcomer |
| Mixed | 19 honest, 2 free riders, a colluding pair, the newcomer |
| Testnet house community | the five honest house members, the colluding pair, the free rider; visitors; optionally a newcomer at round 61 (144 rounds); variants with a guest farm |

**Measures.** Colluders' and free riders' *excess* is their share of all planned payouts minus their share of all work, in percentage points, for the group combined. *Tracking* is the rank correlation between honest members' payouts and their work. Payouts are what the rules plan, before the council; the council's effect is reported separately.

## Results

### Stage A: the collusion rules

![Colluders' excess payout share by rule set](sim/excess.svg)

<!-- BEGIN generated:stage_a -->
| Rule set | Pair | Ring of 3 | Ring of 4 | Objective (mean) | Honest pair loses | Tracking vs none (worst scenario) | Free riders' excess | Constraints failed |
|---|---|---|---|---|---|---|---|---|
| cap 50, no dampening | +3.5 | +13.8 | +17.9 | 11.71 | 0.0 % | +0.000 | +2.8 | - |
| cap 25 | +1.2 | +6.8 | +13.9 | 7.31 | 7.2 % | -0.005 | +3.2 | - |
| cap 25, R 75 % | +0.7 | +5.6 | +11.7 | 5.99 | 7.2 % | -0.001 | +3.5 | - |
| cap 25, R 50 % | -0.0 | +4.2 | +8.9 | 4.34 | 7.1 % | +0.005 | +3.8 | - |
| cap 25, R 25 % | -0.1 | +3.7 | +7.9 | 3.83 | 8.8 % | -0.006 | +4.2 | - |
| cap 25, Q | -1.6 | +1.8 | +6.0 | 2.07 | 28.1 % | -0.008 | +1.3 | honest pair |
| cap 25, B 2 at 50 % | +1.0 | +6.9 | +13.9 | 7.26 | 7.3 % | -0.010 | +3.0 | - |
| cap 25, B 3 at 50 % | +1.0 | +6.0 | +14.0 | 6.99 | 8.1 % | -0.011 | +2.7 | - |
| cap 25, B 4 at 50 % | +0.6 | +5.4 | +11.4 | 5.81 | 9.1 % | -0.022 | +2.5 | - |
| cap 25, B 3 at 25 % | +0.8 | +5.5 | +14.1 | 6.79 | 8.3 % | -0.010 | +2.4 | - |
| cap 25, I 75 % | +1.5 | +7.3 | +14.5 | 7.78 | 6.9 % | -0.019 | +2.5 | - |
| cap 25, I 50 % | +1.8 | +7.9 | +15.3 | 8.32 | 5.9 % | -0.021 | +1.8 | - |
| cap 25, I 25 % | +2.1 | +8.5 | +16.2 | 8.93 | 4.7 % | -0.021 | +0.9 | - |
| **cap 25, R 25 %, B 3 at 25 % (launch)** | -0.7 | +2.0 | +5.4 | 2.22 | 10.8 % | -0.006 | +3.2 | - |
| cap 34, R 25 %, B 3 at 25 % | -0.4 | +3.0 | +8.4 | 3.69 | 11.9 % | -0.014 | +2.9 | - |
| cap 40, R 25 %, B 3 at 25 % | -0.1 | +3.9 | +8.9 | 4.22 | 10.5 % | -0.017 | +2.9 | - |
| cap 50, R 25 %, B 3 at 25 % | +0.4 | +5.6 | +12.1 | 6.03 | 7.5 % | -0.008 | +2.8 | - |

Colluders' excess payout share in percentage points (payout share minus work share, colluders combined, best response), medians over 8 seeds. The objective is the mean of the three. R: reciprocity, Q: quadratic, B: breadth (fewer than k givers count at the given rate), I: idle.

The best rule sets that meet both constraints, then the best that do not:

| Rule set | Pair | Ring of 3 | Ring of 4 | Objective | Honest pair loses | Ring of 4 plays (seeds) | Constraints failed |
|---|---|---|---|---|---|---|---|
| cap 25, R 25 %, B 4 at 50 % | -0.8 | +2.3 | +5.1 | 2.21 | 12.4 % | mutual 2, one-way 6 | - |
| cap 25, R 25 %, B 3 at 25 % | -0.7 | +2.0 | +5.4 | 2.22 | 10.8 % | mutual 6, one-way 2 | - |
| cap 25, R 25 %, B 4 at 50 %, I 75 % | -0.6 | +2.7 | +5.6 | 2.58 | 12.6 % | mutual 2, one-way 6 | - |
| cap 25, R 25 %, B 3 at 50 % | -0.6 | +2.6 | +5.7 | 2.59 | 10.7 % | mutual 2, one-way 6 | - |
| cap 25, R 25 %, B 3 at 25 %, I 75 % | -0.5 | +2.4 | +6.0 | 2.61 | 11.5 % | mutual 6, one-way 2 | - |
| cap 25, R 25 %, B 3 at 50 %, I 75 % | -0.4 | +3.0 | +6.3 | 2.98 | 11.2 % | mutual 2, one-way 6 | - |
| cap 25, R 25 %, B 4 at 50 %, I 50 % | -0.4 | +3.2 | +6.2 | 3.01 | 14.0 % | mutual 2, one-way 6 | - |
| cap 25, R 25 %, B 3 at 25 %, I 50 % | -0.2 | +2.8 | +6.6 | 3.06 | 11.3 % | mutual 6, one-way 2 | - |
| cap 25, R 25 %, Q, B 4 at 50 % | -2.2 | -0.4 | +1.7 | -0.29 | 32.9 % | mutual 8 | honest pair |
| cap 25, R 25 %, Q, B 3 at 25 % | -2.1 | -0.3 | +2.0 | -0.17 | 32.2 % | mutual 8 | honest pair |
| cap 25, R 25 %, Q, B 3 at 50 % | -2.1 | -0.3 | +2.0 | -0.14 | 32.1 % | mutual 8 | honest pair |

320 of 640 rule sets meet both constraints; the best objective among them is 2.21 points, and 2 lie within 0.25 points of it.
<!-- END generated:stage_a -->

- **The cap does the first half.** Cap 25 alone takes the mean excess from 11.7 to 7.3 points: a ring member can hand each partner at most a quarter of its thanks.
- **Reciprocity at 25 %** halves what is left (3.8). It also changes how colluders play: the pair and the ring of three switch to one-way thanks (each pair of ring members in one direction per round, alternating), which reciprocity cannot see. Reciprocity still pays: one-way thanks reach each partner only every other round.
- **Breadth** alone does little (6.8), because colluders also get honest thanks and so have three givers anyway. Together with reciprocity it helps more (3.8 to 2.2): one-way thanks give a ring member fewer ring givers per round, so a pair or a ring of three is more often below three givers.
- **Quadratic** is the strongest single rule (2.1); with reciprocity it brings the pair and the ring of three below their work share and the ring of four to +1.7 to +2.0. Its cost falls on honest members whose support is concentrated: the honest pair loses 28-33 % of its payout. That fails the pre-registered limit of 15 %, so it is off.
- **Idle** makes the colluders' excess *larger* (8.3 at 50 %): it discounts honest members who skip giving in a round, while colluders always give. It lowers free riders' excess, but only for free riders who give nothing; the scenario "free riders who give" shows that a token allocation evades it.
- **The pick.** Two rule sets tie within 0.25 points (2.21 and 2.22); both use two rules, and the tie goes to the lower free riders' excess: cap 25, R 25 %, B 3 at 25 %.

### The community with the launch rules

![Payout share against work share, per member](sim/tracking.svg)

<!-- BEGIN generated:community -->
| Scenario | Colluders' excess (pp), none -> launch | Colluders play | Colluders' payouts the council lets through | Free riders' excess (pp) | Tracking (rank correlation) | Honest pair's payout | Newcomer to tier 1 (rounds) |
|---|---|---|---|---|---|---|---|
| Honest community | - | - | - | - | 0.831 -> 0.853 | -10.8 % | 6.5 |
| Free riders | - | - | - | +2.8 -> +3.2 | 0.838 -> 0.847 | -13.4 % | 6.5 |
| Free riders who give | - | - | - | +2.9 -> +2.1 | 0.871 -> 0.867 | -13.3 % | 5 |
| Colluding pair | +3.5 -> -0.7 | one-way | 99 % | - | 0.864 -> 0.863 | -8.1 % | 6.5 |
| Colluding ring of three | +13.8 -> +2.0 | mutual, one-way | 100 % | - | 0.844 -> 0.838 | -1.7 % | 5.5 |
| Colluding ring of four | +17.9 -> +5.4 | mutual, one-way | 100 % | - | 0.841 -> 0.843 | +2.9 % | 6.5 |
| Mixed: free riders and a colluding pair | +3.7 -> -0.7 | one-way | 99 % | +1.1 -> +1.2 | 0.835 -> 0.847 | -6.9 % | 6 |

Medians over 8 seeds, 52 weekly rounds, community launch values; "none" is cap 50 with every dampening rule off and the same tier limits. Colluders play their best response under each rule set. The council column applies the house council's rule (reject tier-2 payouts that come mostly from one reciprocal partner, tier-3 payouts with fewer than three givers).
<!-- END generated:community -->

- **Colluders.** Under the launch rules the colluding pair ends below its work share (-0.7 points against +3.5), the ring of three keeps +2.0 points (from +13.8) and the ring of four +5.4 (from +17.9), about 1.4 points per ring member. The house council's rule lets 99-100 % of the colluders' payouts through: colluders who thank one way have no reciprocal partner, and they have at least three givers.
- **Free riders** who give nothing collect +3.2 points with the launch rules (+2.8 without): four members who do nothing get 3 % of the payouts, from honest members who read their padded notes. The launch rules move money from colluders to everyone else, free riders included.
- **Tracking.** Honest members' payouts follow their work about as well as without dampening (rank correlation 0.84-0.87 against 0.83-0.87; the largest drop is 0.006). The chart above shows one seed of the mixed community: without dampening the colluding pair sits above the diagonal; with the launch rules both colluders sit on or below it.
- **The honest pair** pays for the rules: -7 % to -13 % of its payout in the scenarios without a ring, because its real mutual thanks are discounted like the colluders'. Where a ring is present, the rules move money from the ring to everyone, the honest pair included.

### Stage C: budget and minimum payout

<!-- BEGIN generated:stage_c -->
| Budget / min. payout (tUSD) | Payouts per round | Visitors thanked by 3+ house members who got a payout | Lapsed carry (of budgets) | Criteria failed |
|---|---|---|---|---|
| 100 / 1 | 7.60 | 100 % of 327 | 0.00 % | payouts per round |
| 100 / 2 | 7.42 | 99 % of 327 | 0.01 % | payouts per round |
| 100 / 3 | 7.18 | 98 % of 327 | 0.04 % | payouts per round |
| 100 / 5 | 6.64 | 76 % of 327 | 0.46 % | - |
| 120 / 1 | 7.64 | 100 % of 327 | 0.00 % | payouts per round |
| 120 / 2 | 7.48 | 99 % of 327 | 0.00 % | payouts per round |
| 120 / 3 | 7.30 | 99 % of 327 | 0.02 % | payouts per round |
| **120 / 5** | 6.90 | 91 % of 327 | 0.17 % | - |
| 150 / 1 | 7.73 | 100 % of 327 | 0.00 % | payouts per round |
| 150 / 2 | 7.55 | 100 % of 327 | 0.00 % | payouts per round |
| 150 / 3 | 7.42 | 99 % of 327 | 0.01 % | payouts per round |
| 150 / 5 | 7.09 | 96 % of 327 | 0.04 % | payouts per round |

Medians over 6 seeds (visitors: all seeds pooled); 2 of 12 pass.
<!-- END generated:stage_c -->

The house alone produces about seven payees a round, and visitors and the newcomer add one more, so every minimum payout up to 3 tUSD gives more than 7 payouts a round. Only a minimum of 5 tUSD stays below 7.0 (with budgets of 100 and 120 tUSD); the pick is 120 / 5, two grid steps from the first guess. Small shares (the free rider, a visitor with one welcome) are then carried until they reach 5 tUSD. At 6.9 payouts a round, 1,080 demo rounds leave about 7,450 proposals in the DAO, about 26 NEAR of storage (PLAN.md budgets 23).

### Stage B: tier limits and decay

<!-- BEGIN generated:stage_b -->
**Testnet demo.** decay 7.5 %, auto from 200 thanks at 0.06 per thanks up to 30, round cap 80 %, co-sign 14.4 + 0.06 per thanks up to 30.

| Pass | Group | Pick (grid units) | Tier 1 / 2 / 3 (%) | Newcomer to tier 1 (rounds) | Score | Combinations meeting all criteria |
|---|---|---|---|---|---|---|
| 1 | `decay_bp`, `auto_rep_min`, `auto_per_thanks_bp` | 1000, 100, 5 | 32 / 63 / 5 | 6 | 75.8 | 0 of 64 |
| 1 | `auto_max_bp`, `auto_share_bp` | 2500, 8000 | 66 / 29 / 5 | 6 | 7.9 | 2 of 16 |
| 1 | `cosign_base_bp`, `cosign_per_thanks_bp`, `cosign_max_bp` | 800, 5, 4000 | 66 / 29 / 5 | 6 | 7.9 | 16 of 64 |
| 2 | `decay_bp`, `auto_rep_min`, `auto_per_thanks_bp` | 750, 100, 5 | 72 / 26 / 2 | 6 | 5.9 | 2 of 64 |
| 2 | `auto_max_bp`, `auto_share_bp` | 2500, 8000 | 72 / 26 / 2 | 6 | 5.9 | 0 of 16 |
| 2 | `cosign_base_bp`, `cosign_per_thanks_bp`, `cosign_max_bp` | 1200, 5, 2500 | 72 / 23 / 5 | 6 | 4.4 | 21 of 64 |
| 3 | `decay_bp`, `auto_rep_min`, `auto_per_thanks_bp` | 750, 200, 5 | 72 / 23 / 5 | 8 | 3.4 | 7 of 64 |
| 3 | `auto_max_bp`, `auto_share_bp` | 2500, 8000 | 72 / 23 / 5 | 8 | 3.4 | 2 of 16 |
| 3 | `cosign_base_bp`, `cosign_per_thanks_bp`, `cosign_max_bp` | 1200, 5, 2500 | 72 / 23 / 5 | 8 | 3.4 | 21 of 64 |
| 4 | `decay_bp`, `auto_rep_min`, `auto_per_thanks_bp` | 750, 200, 5 | 72 / 23 / 5 | 8 | 3.4 | 7 of 64 |
| 4 | `auto_max_bp`, `auto_share_bp` | 2500, 8000 | 72 / 23 / 5 | 8 | 3.4 | 2 of 16 |
| 4 | `cosign_base_bp`, `cosign_per_thanks_bp`, `cosign_max_bp` | 1200, 5, 2500 | 72 / 23 / 5 | 8 | 3.4 | 21 of 64 |

Final: tiers 72 / 23 / 5 % in steady state, newcomer in tier 1 after 8 rounds, the round cap binds in 43 of 96 steady rounds; criteria met.

**Community.** decay 10 %, auto from 100 thanks at 0.1 per thanks up to 60, round cap 60 %, co-sign 20 + 0.05 per thanks up to 200.

| Pass | Group | Pick (grid units) | Tier 1 / 2 / 3 (%) | Newcomer to tier 1 (rounds) | Score | Combinations meeting all criteria |
|---|---|---|---|---|---|---|
| 1 | `decay_bp`, `auto_rep_min`, `auto_per_thanks_bp` | 500, 200, 2 | 73 / 26 / 0 | 7.5 | 9.9 | 0 of 64 |
| 1 | `auto_max_bp`, `auto_share_bp` | 1200, 6000 | 73 / 26 / 0 | 7.5 | 9.9 | 0 of 16 |
| 1 | `cosign_base_bp`, `cosign_per_thanks_bp`, `cosign_max_bp` | 400, 1, 4000 | 73 / 26 / 1 | 7.5 | 8.6 | 0 of 64 |
| 2 | `decay_bp`, `auto_rep_min`, `auto_per_thanks_bp` | 1000, 100, 2 | 70 / 24 / 6 | 7 | 2.9 | 5 of 64 |
| 2 | `auto_max_bp`, `auto_share_bp` | 1200, 6000 | 70 / 24 / 6 | 7 | 2.9 | 14 of 16 |
| 2 | `cosign_base_bp`, `cosign_per_thanks_bp`, `cosign_max_bp` | 400, 1, 4000 | 70 / 24 / 6 | 7 | 2.9 | 4 of 64 |
| 3 | `decay_bp`, `auto_rep_min`, `auto_per_thanks_bp` | 1000, 100, 2 | 70 / 24 / 6 | 7 | 2.9 | 5 of 64 |
| 3 | `auto_max_bp`, `auto_share_bp` | 1200, 6000 | 70 / 24 / 6 | 7 | 2.9 | 14 of 16 |
| 3 | `cosign_base_bp`, `cosign_per_thanks_bp`, `cosign_max_bp` | 400, 1, 4000 | 70 / 24 / 6 | 7 | 2.9 | 4 of 64 |

Final: tiers 70 / 24 / 6 % in steady state, newcomer in tier 1 after 7 rounds, the round cap binds in 21 of 52 steady rounds; criteria met.
<!-- END generated:stage_b -->

Both settings meet every criterion. Several picks sit at the edge of their grid, which means the optimum may lie beyond it: on testnet `auto_per_thanks` (top), `auto_max` (top), `auto_share_bp` (top) and `cosign_max` (bottom); in the community `decay_bp` (top), `auto_rep_min`, `cosign_base` and `cosign_per_thanks` (bottom). The reason on testnet: with seven or eight payees a round, a typical payout is 10-20 % of the budget, so a tier-1 limit of 12 % (the first guess) leaves most payouts to the council. Even at 80 %, the round cap moves a payout from tier 1 to tier 2 in 43 of 96 steady rounds. `cosign_max` equals `auto_max` on testnet (30 tUSD): above that only a council majority pays.

### The testnet demo

![Payouts per round by tier, testnet demo](sim/tiers.svg)

![Reputation of the house members, testnet demo](sim/reputation.svg)

<!-- BEGIN generated:testnet -->
| Variant | Payouts per round | Tier 1 / 2 / 3 (%) | Newcomer to tier 1 | Pair's excess (pp) | Pair's tier-2/3 payouts rejected | Free rider's share | Guests' share | Farm's take per round (tUSD) | Free rider's take per round (tUSD) |
|---|---|---|---|---|---|---|---|---|---|
| House, visitors and a newcomer | 6.90 | 72 / 23 / 5 | 8 | +2.6 | 4 % | 2.7 % | 3.0 % | - | 3.18 |
| The same without dampening | 7.40 | 76 / 18 / 6 | 5 | +10.0 | 14 % | 1.2 % | 2.3 % | - | 1.45 |
| House only (no visitors, no newcomer) | 6.10 | 70 / 19 / 10 | - | +4.5 | 3 % | 3.8 % | 0.0 % | - | 4.59 |
| Guest farm, outsider | 8.91 | 72 / 27 / 0 | 5 | +4.2 | 0 % | 5.7 % | 7.9 % | 9.50 | 6.80 |
| Guest farm with the free rider as accomplice | 10.40 | 68 / 32 / 0 | 5.5 | +1.9 | 0 % | 7.5 % | 16.7 % | 20.02 | 9.03 |
| Accomplice farm without dampening | 10.62 | 66 / 34 / 0 | 4 | +4.8 | 9 % | 10.7 % | 17.4 % | 20.85 | 12.89 |

Medians over 8 seeds, 144 rounds of 20 minutes, testnet launch values. Tier shares count payouts in rounds 49-144.
<!-- END generated:testnet -->

- **Tiers.** In steady state 72 % of payouts are automatic, 23 % wait for one council vote and 5 % for a majority. Tier 3 is mostly the largest payouts (above 30 tUSD: the top contributors in their best rounds) and the newcomer's first ones; guests' payouts land in tier 2. The first rounds are all tier 2 and 3: nobody has reputation yet. A newcomer reaches tier 1 after 8 rounds (2 h 40 min).
- **The labelled pair** (mutual thanks, the demo's published strategy) still gets +2.6 points more than its work share, against +10.0 without dampening; the council rejects 4 % of its tier-2 and tier-3 payouts. On the page, 25 thanks from the partner count 6.25.
- **The labelled free rider** gets 2.7 % of the payouts (3.18 tUSD a round): idle is off, so a member who never gives is not discounted, and honest house members thank its vague notes a little.
- **Guest farm.** One person holding all six seats takes 9.5 tUSD a round (8 % of the budget) from the house members' welcome thanks alone, and keeps every real visitor out. With a member as accomplice, who gives his 100 thanks to the farm's seats while the seats give him the cap, the farm takes 20 tUSD and the accomplice 9 tUSD a round: about a quarter of the budget. Dampening hardly changes it (34 tUSD without). The guests' cap limits what guests *give*; thanks *to* guests count at full weight.

## Launch parameters

`sim/params.json` holds both configurations with the contract's field names and units, the pick in grid units, and the house members' published strategies (I-2). Amounts below in tUSD.

<!-- BEGIN generated:params -->
| Field | Community (weekly) | Testnet demo (20 minutes) |
|---|---|---|
| `round_ms` | 604,800,000 | 1,200,000 |
| `thanks_per_round` | 100 | 100 |
| `cap_per_receiver` | 25 | 25 |
| `max_receivers` | 10 | 10 |
| `reciprocal_bp` | 2,500 | 2,500 |
| `quadratic` | off | off |
| `breadth_k` | 3 | 3 |
| `breadth_bp` | 2,500 | 2,500 |
| `idle_bp` | 10,000 | 10,000 |
| `decay_bp` | 1,000 | 750 |
| `round_budget` | 500 tUSD | 120 tUSD |
| `min_payout` | 5 tUSD | 5 tUSD |
| `carry_rounds` | 8 | 12 |
| `reserve` | 0 tUSD | 0 tUSD |
| `auto_rep_min` | 100 | 200 |
| `auto_per_thanks` | 0.1 tUSD | 0.06 tUSD |
| `auto_max` | 60 tUSD | 30 tUSD |
| `cosign_base` | 20 tUSD | 14.4 tUSD |
| `cosign_per_thanks` | 0.05 tUSD | 0.06 tUSD |
| `cosign_max` | 200 tUSD | 30 tUSD |
| `auto_share_bp` | 6,000 | 8,000 |
| `guest_seats` | 0 | 6 |
| `guest_weight_bp` | 0 | 5,000 |
| `guest_cap_bp` | 0 | 2,000 |
| `max_members` | 48 | 24 |
| `max_catchup` | 8 | 36 |
| `log_keep` | 52 | 108 |
| `note_max_bytes` | 80 | 80 |
<!-- END generated:params -->

Why each *sim* value:

- `cap_per_receiver` 25, `reciprocal_bp` 2500, `breadth_k` 3, `breadth_bp` 2500, `quadratic` off, `idle_bp` 10000 (off): stage A, the same in both settings (DESIGN.md: "same").
- `round_budget` 120 tUSD and `min_payout` 5 tUSD (testnet): stage C. The community keeps DESIGN.md's 500 and 5 tUSD.
- `decay_bp` and the tier limits: stage B, per setting. In the community, reputation halves in about 7 weeks; on testnet in about 9 rounds (3 hours), so the demo reaches its steady state within a day.
- `guest_weight_bp` 5000 and `guest_cap_bp` 2000 (testnet) were not swept; they stay at DESIGN.md's values. The guest farm results show that the cap on what guests give works (the outsider farm steers at most 20 % of the weight) and that what guests receive is the open flank.
- Not simulated, from DESIGN.md: `round_ms`, `thanks_per_round`, `max_receivers`, `carry_rounds`, `reserve`, `guest_seats`, `max_members`, `max_catchup`, `log_keep`; `note_max_bytes` 80 from DESIGN.md's notes.

## What the rules do not stop

- **Rings.** A ring of four keeps +5.4 points of excess payout share in a 24-member community (about 1.4 points per member) and a ring of three +2.0. Breadth needs three givers, and a ring of four supplies three. Larger rings keep more; a ring as large as the community has nothing left to be compared with.
- **One-way thanks.** Colluders who thank in one direction per round, alternating, are invisible to reciprocity and to the house council's rule, which looks for a reciprocal partner. Under the launch rules this is the colluders' best response in most seeds. Pair memory (P in DESIGN.md) would target it; it is not in I-1 and not simulated.
- **Free riders.** Four free riders who never give collect 3.2 % of the community's payouts, from honest members who thank their padded notes. Idle would reduce that, but it costs honest members who skip a round, raises the colluders' take, and is evaded by any token allocation.
- **Honest mutual help** is discounted like collusion: the honest pair loses 7-13 % of its payout (11 % in the honest community).
- **Guests.** One person can hold every guest seat, keep real visitors out, and collect the welcome thanks (8 % of the testnet budget). A member who works with such a farm moves about a quarter of the budget to himself and the farm, because thanks *to* guests are not capped. A fix would be to apply the guests' cap to the points guests receive as well; that is a contract rule and is not in I-1.
- **The council's rule** is a heuristic: it catches mutual pairs that live off each other, not one-way rings or a member feeding a guest farm. A human council sees more, but the contract cannot make it look.
- **Sybils** are kept out only by DAO membership. Every scenario here assumes the DAO admits real people.

## What the simulation cannot show

- **People are not these behaviour models.** Honest members thank by what they see of each other's work, with noise and popularity; real people also thank friends, reciprocate out of courtesy and copy each other. Colluders here choose between two fixed strategies; real ones can mix strategies, recruit honest members, or trade thanks outside the system.
- **Work is an input.** Each member's contribution is drawn, not measured, and the measures compare payouts with that drawn number. Peer thanks measure how the community sees the work; the simulation cannot say how well that matches the work itself.
- **The council is a rule.** The house council votes by its published rule, at once. A human council can see more (notes, history), miss more, and vote late; a payout that waits past `proposal_period` expires without a strike.
- **The chain is idealised.** Every round is closed on time, every allocation lands in its round, and the DAO always has the money. Gas, storage, failed transfers, a paused contract and catch-up closes do not appear; the golden vectors cover the arithmetic of those paths, not their timing.
- **Few seeds.** Medians over 8 seeds (6 in stages B and C) hide the tails; the stage tables show the medians the rule used.
- **The grids are coarse.** Each knob has three to five values. The pick is the best of the grid by the pre-registered rule, not an optimum between grid points; where a pick sits at the edge of its grid, this document says so.

## Golden vectors, replay and files

- `sim/hat_tip_sim.py`: the model, the behaviour models, the sweep, the scenarios, the charts, the golden vectors, the replay and this document's generated blocks. `python3 sim/hat_tip_sim.py --check` recomputes the golden vectors, the replay and `sim/params.json` from the model and fails on any difference (`--check --sweep` also reruns the sweep).
- `sim/params.json`: the launch values (I-2) and the house strategies.
- `sim/sweep.json`: the sweep's summary, from which the stage tables here are rendered.
- `sim/golden/*.json`: fixed rounds with every intermediate number (I-3); format and the integer rules in `sim/golden/README.md`. Three are hand-written to reach every rule and edge case (`linear`, `dampening`, `guests`), two use the launch values with allocations from the behaviour models (`launch_testnet`, `launch_community`; the latter is a full 24-member community with up to 10 receivers per giver, a size test for the close).
- `sim/replay.json`: the testnet house community over 36 rounds, with and without dampening, the same gifts; for the page's second replay.
- `docs/sim/excess.svg`, `tracking.svg`, `tiers.svg`, `reputation.svg`: the charts.
