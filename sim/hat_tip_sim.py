#!/usr/bin/env python3
"""Hat Tip: simulation of peer thanks rounds paid from a Sputnik DAO.

Standard library only (Python 3.8+). Every run is deterministic for its seed.

The model `Hat` is the contract's round close in the contract's integer
arithmetic (DESIGN.md "One round", with the decisions written at the top of
docs/SIMULATION.md and in sim/golden/README.md): thanks in whole numbers,
weights and points in milli-thanks, token amounts in tUSD base units (6
decimals), rates in basis points, every division rounding down. The behaviour
models (honest members, free riders, colluding pairs and rings, a newcomer,
visitors, a guest farm, the house council) feed it allocations round by
round.

Commands:
  python3 sim/hat_tip_sim.py all        sweep (writes sim/params.json), scenarios, golden
                                        vectors, replay, charts, document tables
  python3 sim/hat_tip_sim.py sweep      the parameter sweep only (--write-params writes the pick)
  python3 sim/hat_tip_sim.py scenarios  scenarios, charts and tables with sim/params.json
  python3 sim/hat_tip_sim.py golden     write sim/golden/*.json and sim/replay.json
  python3 sim/hat_tip_sim.py --check    recompute the golden vectors, the replay and
                                        sim/params.json and compare them with the files
                                        (add --sweep to rerun the sweep as well)
"""

import argparse
import hashlib
import json
import math
import os
import random
import statistics
import sys
from multiprocessing import Pool

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PARAMS_FILE = os.path.join(HERE, "params.json")
GOLDEN_DIR = os.path.join(HERE, "golden")
REPLAY_FILE = os.path.join(HERE, "replay.json")
DOC_FILE = os.path.join(ROOT, "docs", "SIMULATION.md")
DOCS_SIM = os.path.join(ROOT, "docs", "sim")

NAME = "Hat Tip"
U = 10 ** 6          # tUSD base units per tUSD (6 decimals)
BP = 10_000          # basis points: 10,000 = 100 %
MILLI = 1_000        # milli-thanks per thanks
SQRT_SCALE = 1_000_000

# ---------------------------------------------------------------------------
# Config: the contract's field names (I-1), in its order
# ---------------------------------------------------------------------------

CONFIG_FIELDS = [
    "dao", "token", "members_role", "council_role", "thanks_role",
    "genesis_ms", "round_ms",
    "thanks_per_round", "cap_per_receiver", "max_receivers",
    "reciprocal_bp", "quadratic", "breadth_k", "breadth_bp", "idle_bp",
    "decay_bp",
    "round_budget", "min_payout", "carry_rounds", "reserve",
    "auto_rep_min", "auto_per_thanks", "auto_max",
    "cosign_base", "cosign_per_thanks", "cosign_max", "auto_share_bp",
    "guest_seats", "guest_weight_bp", "guest_cap_bp",
    "max_members", "max_catchup", "log_keep", "note_max_bytes",
]
# U128 in the contract: decimal strings in JSON.
U128_FIELDS = {"round_budget", "min_payout", "reserve", "auto_per_thanks", "auto_max",
               "cosign_base", "cosign_per_thanks", "cosign_max"}


def config_json(cfg):
    """A config dict (ints internally) in the contract's JSON form, field order of I-1."""
    out = {}
    for f in CONFIG_FIELDS:
        v = cfg[f]
        out[f] = str(v) if f in U128_FIELDS else v
    return out


def config_from_json(js):
    cfg = {}
    for f in CONFIG_FIELDS:
        v = js[f]
        cfg[f] = int(v) if f in U128_FIELDS else v
    return cfg


# ---------------------------------------------------------------------------
# The contract model
# ---------------------------------------------------------------------------

HEX = set("0123456789abcdef")


def is_implicit(acc):
    """A NEAR implicit account: 64 lowercase hex characters (a guest's browser key)."""
    return len(acc) == 64 and set(acc) <= HEX


def is_eth_implicit(acc):
    return len(acc) == 42 and acc.startswith("0x") and set(acc[2:]) <= HEX


def named_members(policy_members):
    """The member set the contract uses: the role's named accounts only."""
    return {a for a in policy_members if not is_implicit(a) and not is_eth_implicit(a)}


def count_round(cfg, members, seats, allocations):
    """Counting (DESIGN.md "One round", step 5) in the contract's integer arithmetic.

    members: set of named member accounts (the policy fetched at the close)
    seats: set of guest accounts seated in the round
    allocations: {giver: [(receiver, thanks), ...]}, the giver's last allocation

    Returns a dict with every entry's intermediate values and the points per receiver.
    Every division rounds down. Entries are ordered by (giver, receiver).
    """
    dropped = []
    rows = []  # [giver, receiver, thanks]
    for giver in sorted(allocations):
        for recv, t in sorted(allocations[giver]):
            g_ok = giver in members or giver in seats
            r_ok = recv in members or recv in seats
            if not (g_ok and r_ok):
                dropped.append([giver, recv, t, "not a member or seated guest"])
            elif giver in seats and recv in seats:
                dropped.append([giver, recv, t, "guest to guest"])
            else:
                rows.append([giver, recv, t])
    n = len(rows)
    # 2. weight
    w = [0] * n
    m_total = g_total = 0
    for k, (g, r, t) in enumerate(rows):
        if g in members:
            w[k] = t * MILLI
            m_total += w[k]
        else:
            w[k] = t * cfg["guest_weight_bp"] // 10
            g_total += w[k]
    cap = cfg["guest_cap_bp"]
    guest_scaled = g_total * (BP - cap) > m_total * cap
    if guest_scaled:
        num, den = m_total * cap, g_total * (BP - cap)
        for k, (g, r, t) in enumerate(rows):
            if g not in members:
                w[k] = w[k] * num // den
    w_weight = list(w)
    # 3. reciprocity: both directions lose the same amount, from the step-2 weights
    index = {(g, r): k for k, (g, r, t) in enumerate(rows)}
    rbp = cfg["reciprocal_bp"]
    w_recip = list(w_weight)
    if rbp < BP:
        for k, (g, r, t) in enumerate(rows):
            j = index.get((r, g))
            if j is not None and g < r:
                d = min(w_weight[k], w_weight[j]) * (BP - rbp) // BP
                w_recip[k] -= d
                w_recip[j] -= d
    # 4. aggregation
    if cfg["quadratic"]:
        v = [math.isqrt(x * SQRT_SCALE) for x in w_recip]
        s = {}
        for k, (g, r, t) in enumerate(rows):
            s[r] = s.get(r, 0) + v[k]
        big_w = sum(w_recip)
        big_q = sum(x * x for x in s.values())
        a_agg = [big_w * v[k] * s[rows[k][1]] // big_q if big_q else 0 for k in range(n)]
    else:
        v, s, big_q = None, None, 0
        big_w = sum(w_recip)
        a_agg = list(w_recip)
    # 5. breadth: givers with a counted share after aggregation
    support = {}
    for k, (g, r, t) in enumerate(rows):
        if a_agg[k] > 0:
            support[r] = support.get(r, 0) + 1
    a = list(a_agg)
    bk = cfg["breadth_k"]
    narrow = set()
    if bk > 0 and cfg["breadth_bp"] < BP:
        for k, (g, r, t) in enumerate(rows):
            if support.get(r, 0) < bk:
                a[k] = a[k] * cfg["breadth_bp"] // BP
                narrow.add(r)
    # 6. idle: a member with no allocation in the round (before eligibility)
    givers = {g for g, gifts in allocations.items() if gifts}
    idle = set()
    if cfg["idle_bp"] < BP:
        for k, (g, r, t) in enumerate(rows):
            if r in members and r not in givers:
                a[k] = a[k] * cfg["idle_bp"] // BP
                idle.add(r)
    # 7. points
    points = {}
    for k, (g, r, t) in enumerate(rows):
        points[r] = points.get(r, 0) + a[k]
    return {
        "rows": rows, "dropped": dropped, "weight": w_weight, "reciprocal": w_recip,
        "aggregated": a_agg, "counted": a, "members_weight": m_total, "guests_weight": g_total,
        "guest_scaled": guest_scaled, "W": big_w, "Q": big_q, "support": support,
        "narrow": narrow, "idle": idle, "givers": givers, "points": points,
    }


def decay(x, cfg, guest=False):
    """One round of decay. A guest's reputation below one thanks becomes 0."""
    y = x * (BP - cfg["decay_bp"]) // BP
    return 0 if guest and y < MILLI else y


class Hat:
    """The contract's state across rounds: reputation, carry, payouts.

    `close(...)` is the close of a round with allocations, `close_empty(...)` the
    close of a round nobody gave in, `resolve(...)` a DAO outcome read by
    check_payout. The order of the steps inside a close is the contract's.
    """

    def __init__(self, cfg):
        self.cfg = cfg
        self.rep = {}         # account -> reputation (milli-thanks)
        self.hist = {}        # account -> {round: points}
        self.carry = {}       # account -> [amount, round of the last points that left it]
        self.payouts = []     # dicts: round, receiver, amount, tier, status
        self.by_key = {}      # (round, receiver) -> payout
        self.open = {}        # receiver -> number of payouts still planned
        self.closed = 0
        self.totals = {"budget": 0, "planned": 0, "lapsed": 0, "dust": 0, "struck": 0}

    # tiers --------------------------------------------------------------
    def limits(self, acc, r0):
        c = self.cfg
        units = r0 // MILLI
        if is_implicit(acc) or r0 < c["auto_rep_min"] * MILLI:
            auto = 0
        else:
            auto = min(c["auto_max"], units * c["auto_per_thanks"])
        cosign = min(c["cosign_max"], c["cosign_base"] + units * c["cosign_per_thanks"])
        return auto, cosign

    # closes -------------------------------------------------------------
    def _decay_all(self):
        for acc in self.rep:
            self.rep[acc] = decay(self.rep[acc], self.cfg, is_implicit(acc))

    def _lapse(self, r):
        lapsed = []
        for acc in sorted(self.carry):
            amount, since = self.carry[acc]
            if r - since >= self.cfg["carry_rounds"]:
                lapsed.append([acc, amount, since])
                del self.carry[acc]
        self.totals["lapsed"] += sum(x[1] for x in lapsed)
        return lapsed

    def close_empty(self, r):
        assert r == self.closed + 1
        self._decay_all()
        lapsed = self._lapse(r)
        self.closed = r
        return {"round": r, "empty": True, "lapsed": lapsed}

    def close(self, r, policy_members, seats, allocations, dao_balance):
        assert r == self.closed + 1
        c = self.cfg
        members = named_members(policy_members)
        seats = set(seats)
        allocations = {g: gifts for g, gifts in allocations.items() if gifts}
        if not allocations:
            return self.close_empty(r)
        cnt = count_round(c, members, seats, allocations)
        p = {a: x for a, x in cnt["points"].items() if x > 0}
        # reputation before this round (tiers use it), then decay and points
        r0 = {}
        for acc in p:
            r0[acc] = self.rep.get(acc, 0)
        self._decay_all()
        for acc, x in p.items():
            v = self.rep.get(acc, 0) + x
            self.rep[acc] = 0 if is_implicit(acc) and v < MILLI else v
            self.hist.setdefault(acc, {})[r] = x
        # budget and shares (no points, no budget)
        total_p = sum(p.values())
        budget = min(c["round_budget"], max(0, dao_balance - c["reserve"])) if total_p else 0
        shares = {}
        planned = []
        for acc in sorted(p):
            share = budget * p[acc] // total_p
            shares[acc] = share
            old = self.carry.get(acc)
            q = share + (old[0] if old else 0)
            if q == 0 or q < c["min_payout"]:
                if q > 0:
                    # stamped with the round the carry began
                    self.carry[acc] = [q, old[1] if old else r]
            else:
                self.carry.pop(acc, None)
                auto, cosign = self.limits(acc, r0[acc])
                tier = 1 if q <= auto else (2 if q <= cosign else 3)
                planned.append({"round": r, "receiver": acc, "amount": q, "tier": tier,
                                "status": "planned", "r0": r0[acc], "auto_limit": auto,
                                "cosign_limit": cosign})
        dust = budget - sum(shares.values())
        # round cap on tier 1: move the largest to tier 2 until within auto_share_bp of B
        t1 = [x for x in planned if x["tier"] == 1]
        t1_sum = sum(x["amount"] for x in t1)
        moved = []
        if t1_sum * BP > budget * c["auto_share_bp"]:
            for x in sorted(t1, key=lambda y: (-y["amount"], y["receiver"])):
                if t1_sum * BP <= budget * c["auto_share_bp"]:
                    break
                x["tier"] = 2
                t1_sum -= x["amount"]
                moved.append(x["receiver"])
        # carry lapse
        lapsed = self._lapse(r)
        for x in planned:
            self.payouts.append(x)
            self.by_key[(r, x["receiver"])] = x
            self.open[x["receiver"]] = self.open.get(x["receiver"], 0) + 1
        self.closed = r
        t = self.totals
        t["budget"] += budget
        t["planned"] += sum(x["amount"] for x in planned)
        t["dust"] += dust
        return {"round": r, "empty": False, "count": cnt, "points": p, "r0": r0,
                "budget": budget, "shares": shares, "dust": dust, "payouts": planned,
                "moved": moved, "lapsed": lapsed}

    def resolve(self, rnd, receiver, status):
        """A DAO outcome for the payout of `receiver` in round `rnd`. Rejected or removed
        is a strike: that round's points, decayed to the last closed round, come off."""
        x = self.by_key[(rnd, receiver)]
        assert x["status"] == "planned", (rnd, receiver, x["status"])
        x["status"] = status
        self.open[receiver] -= 1
        strike = 0
        if status in ("rejected", "removed"):
            pts = self.hist.get(receiver, {}).get(rnd, 0)
            for _ in range(self.closed - rnd):
                pts = decay(pts, self.cfg)   # the points, not a guest record: no zeroing
            have = self.rep.get(receiver, 0)
            strike = min(have, pts)
            self.rep[receiver] = have - strike
            self.totals["struck"] += strike
        return strike

    def audit(self):
        t = self.totals
        carried = sum(v[0] for v in self.carry.values())
        return t["budget"] == t["planned"] + carried + t["lapsed"] + t["dust"]


# ---------------------------------------------------------------------------
# Golden vectors (I-3): fixed scripts played through the model
# ---------------------------------------------------------------------------

def guest_id(label):
    """A deterministic implicit account (64 hex) standing in for a guest's browser key."""
    return hashlib.sha256(("hat-tip golden " + label).encode()).hexdigest()


ANA, BEN, CLEO, DINA, EMIL, FINN, GUS, HUGO = (
    "ana.test", "ben.test", "cleo.test", "dina.test", "emil.test", "finn.test", "gus.test",
    "hugo.test")
ETH = "0x" + "ab" * 20
IMPLICIT_MEMBER = guest_id("an implicit account in the members role")
X1, X2, X3, X4 = (guest_id("guest 1"), guest_id("guest 2"), guest_id("guest 3"),
                  guest_id("guest 4"))

GOLDEN_BASE = {
    "dao": "dao.test", "token": "tusd.test",
    "members_role": "members", "council_role": "council", "thanks_role": "thanks",
    "genesis_ms": 1_800_000_000_000, "round_ms": 1_200_000,
    "thanks_per_round": 100, "cap_per_receiver": 50, "max_receivers": 10,
    "reciprocal_bp": 10_000, "quadratic": False, "breadth_k": 0, "breadth_bp": 10_000,
    "idle_bp": 10_000, "decay_bp": 1_000,
    "round_budget": 100 * U, "min_payout": 5 * U, "carry_rounds": 2, "reserve": 0,
    "auto_rep_min": 50, "auto_per_thanks": 200_000, "auto_max": 25 * U,
    "cosign_base": 10 * U, "cosign_per_thanks": 250_000, "cosign_max": 40 * U,
    "auto_share_bp": 6_000,
    "guest_seats": 6, "guest_weight_bp": 5_000, "guest_cap_bp": 2_000,
    "max_members": 24, "max_catchup": 36, "log_keep": 108, "note_max_bytes": 80,
}

FIVE = [ANA, BEN, CLEO, DINA, EMIL]
EIGHT = [ANA, BEN, CLEO, DINA, EMIL, FINN, GUS, HUGO]

# Each round: (round, {
#   "outcomes": [(payout round, receiver, status)]   DAO outcomes read before this close
#   "seats": [guest], "notes": [(account, text)],
#   "calls": [(giver, [(receiver, thanks)])]          allocate calls in order; the last counts
#   "members": [...]                                  policy members fetched at the close
#   "balance": tUSD base units                        DAO balance read at the close
# }). A round without calls is empty: nothing is fetched and only reputation decays.
GOLDEN_SCRIPTS = {
    "linear": {
        "about": "All dampening off (reciprocal_bp 10000, linear, no breadth or idle rule). "
                 "A replaced allocation, policy entries the contract ignores (0x and implicit "
                 "accounts), two empty rounds, a DAO that holds less than the budget and then "
                 "nothing, a member removed at a close, a round whose only entries are dropped "
                 "(no points, so no budget), carry topped up and lapsing, tiers growing with "
                 "reputation and the round cap on tier 1.",
        "config": {},
        "initial_members": FIVE + [ETH, IMPLICIT_MEMBER],
        "rounds": [
            (1, {"notes": [(ANA, "fixed two kettles and a lamp")],
                 "calls": [(ANA, [(BEN, 50), (CLEO, 30), (DINA, 20)]),
                           (BEN, [(ANA, 40), (CLEO, 50), (EMIL, 10)]),
                           (BEN, [(ANA, 45), (CLEO, 45), (EMIL, 10)]),
                           (CLEO, [(ANA, 25), (DINA, 25), (EMIL, 7)]),
                           (DINA, [(EMIL, 3)])],
                 "members": FIVE + [ETH, IMPLICIT_MEMBER], "balance": 1_000 * U}),
            (2, {"calls": [(ANA, [(BEN, 40), (CLEO, 40), (EMIL, 2)]),
                           (BEN, [(ANA, 50), (DINA, 50)]),
                           (CLEO, [(ANA, 30), (BEN, 30), (DINA, 30)]),
                           (DINA, [(ANA, 33), (CLEO, 33), (BEN, 33)])],
                 "members": FIVE, "balance": 900 * U}),
            (3, {}),
            (4, {}),
            (5, {"calls": [(ANA, [(BEN, 50), (CLEO, 50)]),
                           (BEN, [(ANA, 50), (CLEO, 20), (DINA, 30)]),
                           (CLEO, [(ANA, 50), (DINA, 50)]),
                           (DINA, [(ANA, 10), (EMIL, 1)])],
                 "members": FIVE, "balance": 70 * U}),
            (6, {"calls": [(ANA, [(BEN, 50), (DINA, 50)]),
                           (BEN, [(ANA, 50), (EMIL, 1)]),
                           (CLEO, [(ANA, 40), (BEN, 40)])],
                 "members": FIVE, "balance": 0}),
            (7, {"calls": [(EMIL, [(ANA, 50), (BEN, 50)])],
                 "members": [ANA, BEN, CLEO, DINA], "balance": 500 * U}),
            (8, {"calls": [(ANA, [(BEN, 30), (CLEO, 30), (DINA, 40)]),
                           (BEN, [(ANA, 50), (CLEO, 50)]),
                           (CLEO, [(ANA, 50), (BEN, 25), (DINA, 25)]),
                           (DINA, [(ANA, 50), (BEN, 50)])],
                 "members": [ANA, BEN, CLEO, DINA], "balance": 400 * U}),
            (9, {"calls": [(ANA, [(BEN, 50), (CLEO, 50)]),
                           (BEN, [(ANA, 50), (CLEO, 50)]),
                           (CLEO, [(ANA, 50), (BEN, 50)]),
                           (DINA, [(ANA, 1)])],
                 "members": [ANA, BEN, CLEO, DINA], "balance": 300 * U}),
            (10, {"calls": [(ANA, [(BEN, 40), (CLEO, 40), (DINA, 20)]),
                            (BEN, [(ANA, 40), (CLEO, 40), (DINA, 20)]),
                            (CLEO, [(ANA, 40), (BEN, 40), (DINA, 20)]),
                            (DINA, [(ANA, 34), (BEN, 33), (CLEO, 33)])],
                  "members": [ANA, BEN, CLEO, DINA], "balance": 200 * U}),
        ],
    },
    "dampening": {
        "about": "Every dampening rule on at a non-trivial value: reciprocity 50 %, quadratic "
                 "aggregation, breadth (fewer than 3 givers count half), idle (a member who gave "
                 "nothing counts half), cap 34 per receiver. A colluding pair, a one-way ring of "
                 "three, a member who rarely gives, strikes from a rejected and a removed payout "
                 "(one of them two rounds old, across an empty round), an expired and a paid one, "
                 "and a five-way tie in the tier-1 round cap (equal amounts move in account order).",
        "config": {"cap_per_receiver": 34, "reciprocal_bp": 5_000, "quadratic": True,
                   "breadth_k": 3, "breadth_bp": 5_000, "idle_bp": 5_000, "decay_bp": 500,
                   "min_payout": 2 * U, "carry_rounds": 3, "auto_rep_min": 20,
                   "auto_per_thanks": 150_000, "auto_max": 13 * U, "cosign_base": 8 * U,
                   "cosign_per_thanks": 100_000, "cosign_max": 30 * U, "auto_share_bp": 3_000},
        "initial_members": [ANA, BEN, CLEO, DINA, EMIL, FINN, GUS, HUGO],
        "rounds": [
            (1, {"calls": [(ANA, [(BEN, 20), (CLEO, 20), (DINA, 20), (EMIL, 20), (HUGO, 20)]),
                           (BEN, [(ANA, 30), (CLEO, 30), (EMIL, 30), (FINN, 10)]),
                           (CLEO, [(ANA, 34), (BEN, 33), (DINA, 33)]),
                           (DINA, [(ANA, 25), (CLEO, 25), (EMIL, 25), (HUGO, 25)]),
                           (EMIL, [(ANA, 10), (BEN, 10), (CLEO, 10), (DINA, 10), (GUS, 10),
                                   (HUGO, 10)]),
                           (FINN, [(GUS, 34), (ANA, 33), (BEN, 33)]),
                           (GUS, [(FINN, 34), (CLEO, 33), (DINA, 33)])],
                 "members": [ANA, BEN, CLEO, DINA, EMIL, FINN, GUS, HUGO], "balance": 10_000 * U}),
            (2, {"calls": [(ANA, [(BEN, 34), (CLEO, 33), (DINA, 33)]),
                           (BEN, [(ANA, 34), (CLEO, 33), (DINA, 33)]),
                           (CLEO, [(ANA, 34), (BEN, 33), (DINA, 33)]),
                           (DINA, [(ANA, 34), (BEN, 33), (CLEO, 33)]),
                           (FINN, [(GUS, 34)]),
                           (GUS, [(FINN, 34)])],
                 "members": [ANA, BEN, CLEO, DINA, EMIL, FINN, GUS, HUGO], "balance": 9_900 * U}),
            (3, {"outcomes": [(2, FINN, "rejected"), (2, GUS, "removed"), (1, ANA, "paid")],
                 "calls": [(ANA, [(BEN, 25), (CLEO, 25), (HUGO, 25), (EMIL, 25)]),
                           (BEN, [(ANA, 25), (CLEO, 25), (HUGO, 25), (EMIL, 25)]),
                           (CLEO, [(DINA, 34)]),
                           (DINA, [(EMIL, 34)]),
                           (EMIL, [(CLEO, 34)]),
                           (FINN, [(GUS, 34), (ANA, 10)]),
                           (GUS, [(FINN, 34), (BEN, 10)])],
                 "members": [ANA, BEN, CLEO, DINA, EMIL, FINN, GUS, HUGO], "balance": 9_800 * U}),
            (4, {"calls": [(CLEO, [(ANA, 30), (BEN, 30), (DINA, 20), (EMIL, 20)]),
                           (DINA, [(ANA, 30), (BEN, 30), (CLEO, 20), (EMIL, 20)]),
                           (EMIL, [(ANA, 30), (BEN, 30), (CLEO, 20), (DINA, 20)]),
                           (HUGO, [(ANA, 5), (BEN, 5)])],
                 "members": [ANA, BEN, CLEO, DINA, EMIL, FINN, GUS, HUGO], "balance": 9_700 * U}),
            (5, {"outcomes": [(2, BEN, "expired"), (3, HUGO, "rejected")]}),
            (6, {"calls": [(ANA, [(BEN, 34), (CLEO, 33), (DINA, 33)]),
                           (BEN, [(ANA, 34), (CLEO, 33), (DINA, 33)]),
                           (CLEO, [(ANA, 34), (BEN, 34), (DINA, 32)]),
                           (DINA, [(ANA, 34), (BEN, 34), (CLEO, 32)]),
                           (EMIL, [(ANA, 1), (FINN, 1)]),
                           (FINN, [(GUS, 34), (HUGO, 34), (EMIL, 32)]),
                           (GUS, [(FINN, 34), (HUGO, 34), (EMIL, 32)])],
                 "members": [ANA, BEN, CLEO, DINA, EMIL, FINN, GUS, HUGO], "balance": 9_600 * U}),
            (7, {"calls": [(m, [(o, 14) for o in EIGHT if o != m]) for m in EIGHT],
                 "members": EIGHT, "balance": 9_500 * U}),
        ],
    },
    "guests": {
        "about": "Seated guests (testnet demo): guest weight 33.33 % (rounding of thanks * "
                 "guest_weight_bp / 10), the guests' cap at 20 % binding and not binding, "
                 "reciprocity between a guest and a member at 75 %, a guest never in tier 1, "
                 "a guest's entry to a member removed at the close, a guest's reputation set to 0 "
                 "once it falls below one thanks, a carry lapsing, a guest whose reputation "
                 "would allow tier 1 filed in tier 2.",
        "config": {"guest_weight_bp": 3_333, "guest_cap_bp": 2_000, "reciprocal_bp": 7_500,
                   "decay_bp": 5_000, "min_payout": 2 * U, "carry_rounds": 1,
                   "auto_rep_min": 10, "auto_per_thanks": 1_000_000, "auto_max": 50 * U,
                   "cosign_base": 5 * U, "cosign_per_thanks": 100_000, "cosign_max": 40 * U,
                   "auto_share_bp": 10_000},
        "initial_members": [ANA, BEN, CLEO, DINA],
        "rounds": [
            (1, {"seats": [X1, X2, X3],
                 "notes": [(X1, "brought a broken toaster"), (X3, "first visit")],
                 "calls": [(X1, [(ANA, 50), (BEN, 50)]),
                           (X2, [(ANA, 50), (CLEO, 50)]),
                           (X3, [(ANA, 40), (DINA, 30), (BEN, 29)]),
                           (ANA, [(X1, 10), (BEN, 45), (CLEO, 45)]),
                           (BEN, [(X2, 1), (ANA, 49), (DINA, 50)]),
                           (CLEO, [(ANA, 50), (BEN, 50)])],
                 "members": [ANA, BEN, CLEO, DINA], "balance": 1_000 * U}),
            (2, {"seats": [X1],
                 "calls": [(X1, [(DINA, 30), (ANA, 7)]),
                           (ANA, [(X1, 50), (BEN, 50)]),
                           (BEN, [(X1, 50), (ANA, 50)]),
                           (CLEO, [(X1, 40), (ANA, 30), (BEN, 30)]),
                           (DINA, [(ANA, 50), (BEN, 50)])],
                 "members": [ANA, BEN, CLEO], "balance": 1_000 * U}),
            (3, {"outcomes": [(1, X1, "paid")],
                 "calls": [(ANA, [(BEN, 50), (CLEO, 50)]),
                           (BEN, [(ANA, 50), (CLEO, 50)]),
                           (CLEO, [(ANA, 50), (BEN, 50)])],
                 "members": [ANA, BEN, CLEO], "balance": 1_000 * U}),
            (4, {"seats": [X1, X2, X4],
                 "calls": [(X2, [(ANA, 50), (BEN, 50)]),
                           (X4, [(CLEO, 50), (BEN, 50)]),
                           (ANA, [(X2, 20), (X1, 10), (BEN, 40), (CLEO, 30)]),
                           (BEN, [(X2, 20), (X4, 20), (ANA, 30), (CLEO, 30)]),
                           (CLEO, [(X4, 5), (ANA, 45), (BEN, 50)])],
                 "members": [ANA, BEN, CLEO], "balance": 1_000 * U}),
        ],
    },
}


def _s(x):
    return str(x)


def play_golden(cfg, initial_members, rounds):
    """Plays a golden script through the model. Returns the rounds in I-3 form."""
    hat = Hat(cfg)
    synced = list(initial_members)
    out = []
    for rnd, spec in rounds:
        strikes = []
        for (pr, recv, status) in spec.get("outcomes", []):
            st = hat.resolve(pr, recv, status)
            if status in ("rejected", "removed"):
                strikes.append([recv, pr, status, _s(st)])
        calls = spec.get("calls", [])
        final = {}
        valid_members = named_members(synced)
        seats = set(spec.get("seats", []))
        for giver, gifts in calls:
            # every call must pass the contract's allocate checks
            assert giver in valid_members or giver in seats, (rnd, giver)
            assert sum(t for _, t in gifts) <= cfg["thanks_per_round"], (rnd, giver)
            assert len(gifts) <= cfg["max_receivers"], (rnd, giver)
            assert len({r for r, _ in gifts}) == len(gifts), (rnd, giver)
            for recv, t in gifts:
                assert recv != giver and 1 <= t <= cfg["cap_per_receiver"], (rnd, giver, recv)
                assert recv in valid_members or recv in seats, (rnd, giver, recv)
                assert not (giver in seats and recv in seats), (rnd, giver, recv)
            final[giver] = gifts
        row = {"round": rnd,
               "outcomes": [{"round": pr, "receiver": rc, "status": stt}
                            for pr, rc, stt in spec.get("outcomes", [])],
               "seats": sorted(seats),
               "notes": [[a, t] for a, t in spec.get("notes", [])],
               "allocations": [{"giver": g, "gifts": [[r, t] for r, t in gifts]}
                               for g, gifts in calls]}
        if not final:
            res = hat.close_empty(rnd)
            row["members"] = None
            row["dao_balance"] = None
            exp = {"empty": True, "strikes": strikes,
                   "lapsed": [[a, _s(v), since] for a, v, since in res["lapsed"]]}
        else:
            res = hat.close(rnd, spec["members"], seats, final, spec["balance"])
            synced = list(spec["members"])
            row["members"] = list(spec["members"])
            row["dao_balance"] = _s(spec["balance"])
            cnt = res["count"]
            exp = {
                "empty": False,
                "strikes": strikes,
                "entries": [[g, r, t, _s(cnt["weight"][k]), _s(cnt["reciprocal"][k]),
                             _s(cnt["aggregated"][k]), _s(cnt["counted"][k])]
                            for k, (g, r, t) in enumerate(cnt["rows"])],
                "dropped": cnt["dropped"],
                "members_weight": _s(cnt["members_weight"]),
                "guests_weight": _s(cnt["guests_weight"]),
                "guest_scaled": cnt["guest_scaled"],
                "points": [[a, _s(p)] for a, p in sorted(cnt["points"].items())],
                "budget": _s(res["budget"]),
                "dust": _s(res["dust"]),
                "payouts": [{"receiver": x["receiver"], "amount": _s(x["amount"]),
                             "tier": x["tier"], "r0": _s(x["r0"]),
                             "auto_limit": _s(x["auto_limit"]),
                             "cosign_limit": _s(x["cosign_limit"])} for x in res["payouts"]],
                "moved_to_tier2": res["moved"],
                "lapsed": [[a, _s(v), since] for a, v, since in res["lapsed"]],
            }
        exp["reputation"] = [[a, _s(v)] for a, v in sorted(hat.rep.items()) if v > 0]
        exp["carry"] = [[a, _s(v[0]), v[1]] for a, v in sorted(hat.carry.items())]
        t = hat.totals
        exp["audit"] = {"budget": _s(t["budget"]), "planned": _s(t["planned"]),
                        "carry": _s(sum(v[0] for v in hat.carry.values())),
                        "lapsed": _s(t["lapsed"]), "dust": _s(t["dust"]),
                        "balanced": hat.audit()}
        assert hat.audit(), rnd
        row["expected"] = exp
        out.append(row)
    return out


def golden_doc(name, spec, cfg):
    return {
        "name": name,
        "about": spec["about"],
        "format": "hat-tip golden v1; see sim/golden/README.md",
        "config": config_json(cfg),
        "initial_members": list(spec["initial_members"]),
        "rounds": play_golden(cfg, spec["initial_members"], spec["rounds"]),
    }


def golden_docs(launch=None):
    """All golden documents: the hand-written scripts and, with launch parameters, the
    launch scripts generated by the behaviour models."""
    docs = {}
    for name, spec in GOLDEN_SCRIPTS.items():
        cfg = dict(GOLDEN_BASE, **spec["config"])
        docs[name] = golden_doc(name, spec, cfg)
    if launch is not None:
        docs.update(launch_golden_docs(launch))
    return docs


def _flat(x):
    return not isinstance(x, (list, dict)) or (
        isinstance(x, list) and all(not isinstance(y, (list, dict)) for y in x)) or (
        isinstance(x, dict) and all(not isinstance(y, (list, dict)) for y in x.values()))


def _dump(x, ind):
    pad, pad1 = " " * ind, " " * (ind + 1)
    one = json.dumps(x, ensure_ascii=False)
    if _flat(x) and (not isinstance(x, dict) or len(one) <= 200):
        return one
    if isinstance(x, list):
        if not x:
            return "[]"
        return "[\n" + ",\n".join(pad1 + _dump(y, ind + 1) for y in x) + "\n" + pad + "]"
    items = [pad1 + json.dumps(k) + ": " + _dump(v, ind + 1) for k, v in x.items()]
    return "{\n" + ",\n".join(items) + "\n" + pad + "}"


def dumps(doc):
    """JSON with one line per entry, payout or row: readable and stable for diffs."""
    return _dump(doc, 0) + "\n"


def write_golden(docs):
    os.makedirs(GOLDEN_DIR, exist_ok=True)
    for name, doc in docs.items():
        with open(os.path.join(GOLDEN_DIR, name + ".json"), "w") as fh:
            fh.write(dumps(doc))


# ---------------------------------------------------------------------------
# Behaviour models
# ---------------------------------------------------------------------------

BEH = {
    "base_sigma": 0.7,        # spread of members' base contribution (lognormal, median 1)
    "round_sigma": 0.35,      # a member's round-to-round variation
    "p_work": 0.9,            # chance a member works in a round
    "p_give": 0.85,           # chance a member hands out thanks in a round
    "noise_sigma": 0.5,       # a giver's perception noise (lognormal, per receiver and round)
    "vis_sigma": 0.3,         # popularity: how visible a member's work is (lognormal, fixed)
    "close_links": 6,         # collaborators per member (affinity 1); everyone else 0.25
    "far_affinity": 0.25,
    "pair_affinity": 4.0,     # the honest pair works together and sees each other's work 4x
    "focus": 0.15,            # givers drop receivers below 15 % of their top pick
    "colluder_work": 0.5,     # colluders do half the work their base suggests
    "free_rider_claim": 0.3,  # a free rider's notes look like 0.3 of a median member's work
}


def _h(*parts):
    """A deterministic 64-bit integer from the parts (seeds the per-member streams)."""
    return int.from_bytes(hashlib.blake2b(":".join(str(p) for p in parts).encode(),
                                          digest_size=8).digest(), "big")


class Member:
    __slots__ = ("name", "kind", "base", "vis", "join", "group", "items")

    def __init__(self, name, kind, base=1.0, vis=1.0, join=1, group=None, items=0.0):
        self.name, self.kind, self.base, self.vis = name, kind, base, vis
        self.join, self.group, self.items = join, group, items


def split(total, prefs, cap, max_n, focus):
    """Whole thanks proportional to `prefs` [(y, name)], at most `cap` each, at most `max_n`
    receivers, dropping those below `focus` of the top pick. Largest remainder rounding."""
    prefs = sorted([p for p in prefs if p[0] > 0], key=lambda t: (-t[0], t[1]))[:max_n]
    if not prefs or total <= 0:
        return []
    top = prefs[0][0]
    rest = [p for p in prefs if p[0] >= focus * top]
    alloc = {}
    left = total
    while rest:
        sy = sum(y for y, _ in rest)
        over = [n for y, n in rest if left * y / sy > cap]
        if not over:
            break
        for n in over:
            alloc[n] = cap
            left -= cap
        rest = [p for p in rest if p[1] not in alloc]
    if rest and left > 0:
        sy = sum(y for y, _ in rest)
        raw = [(left * y / sy, n) for y, n in rest]
        fl = {n: int(v) for v, n in raw}
        extra = left - sum(fl.values())
        for v, n in sorted(raw, key=lambda t: (-(t[0] - int(t[0])), t[1]))[:extra]:
            fl[n] += 1
        alloc.update(fl)
    return sorted((n, t) for n, t in alloc.items() if t >= 1)


def ring_targets(group, me, r, strategy):
    """The ring members a colluder thanks this round. mutual: all of them. one_way: each
    pair in one direction only, alternating by round, so no entry is reciprocal."""
    if strategy == "mutual":
        return [m for m in group if m != me]
    out = []
    i = group.index(me)
    for j, other in enumerate(group):
        if other == me:
            continue
        a, b = min(i, j), max(i, j)
        forward = (r + a + b) % 2 == 0        # a -> b this round
        if (forward and i == a) or (not forward and i == b):
            out.append(other)
    return out


def ring_gifts(targets, total, cap):
    if not targets:
        return []
    each = min(cap, total // len(targets))
    gifts = {t: each for t in targets}
    spare = min(total - each * len(targets), sum(cap - each for _ in targets))
    for t in targets:
        if spare <= 0:
            break
        add = min(cap - gifts[t], spare)
        gifts[t] += add
        spare -= add
    return sorted(gifts.items())


# Community scenarios (weekly rounds, a 24-member community). Each has the honest pair
# (m01, m02) among its honest members and a newcomer who joins at round `join`.
COMMUNITY_SCENARIOS = {
    "honest": {"title": "Honest community", "honest": 23, "free_riders": 0, "ring": 0},
    "free_riders": {"title": "Free riders", "honest": 19, "free_riders": 4, "ring": 0},
    "free_riders_giving": {"title": "Free riders who give", "honest": 19, "free_riders": 4,
                           "ring": 0, "riders_give": True},
    "pair": {"title": "Colluding pair", "honest": 21, "free_riders": 0, "ring": 2},
    "ring3": {"title": "Colluding ring of three", "honest": 20, "free_riders": 0, "ring": 3},
    "ring4": {"title": "Colluding ring of four", "honest": 19, "free_riders": 0, "ring": 4},
    "mixed": {"title": "Mixed: free riders and a colluding pair", "honest": 19,
              "free_riders": 2, "ring": 2},
}
COMMUNITY_ROUNDS = 52
NEWCOMER_JOIN = 13


def community_population(scenario, seed, newcomer_join=NEWCOMER_JOIN):
    spec = COMMUNITY_SCENARIOS[scenario]
    b = BEH
    pop = []

    def draw(name):
        rng = random.Random(_h(seed, "member", name))
        return rng.lognormvariate(0, b["base_sigma"]), rng.lognormvariate(0, b["vis_sigma"])

    for k in range(spec["honest"]):
        name = "m%02d" % (k + 1)
        base, vis = draw(name)
        pop.append(Member(name, "honest_pair" if k < 2 else "honest", base, vis))
    for k in range(spec["free_riders"]):
        name = "fr%d" % (k + 1)
        base, vis = draw(name)
        pop.append(Member(name, "free_rider", base, vis))
    ring = ["c%d" % (k + 1) for k in range(spec["ring"])]
    for name in ring:
        base, vis = draw(name)
        pop.append(Member(name, "colluder", base, vis, group=ring))
    pop.append(Member("new", "newcomer", 1.0, 1.0, join=newcomer_join))
    return pop


def affinity_matrix(pop, seed):
    b = BEH
    n = len(pop)
    p_close = b["close_links"] / max(1, n - 1)
    aff = {}
    for i in range(n):
        for j in range(i + 1, n):
            a, c = pop[i], pop[j]
            u = _h(seed, "aff", min(a.name, c.name), max(a.name, c.name)) / 2 ** 64
            v = 1.0 if u < p_close else b["far_affinity"]
            if a.kind == "honest_pair" and c.kind == "honest_pair":
                v = b["pair_affinity"]
            aff[(a.name, c.name)] = aff[(c.name, a.name)] = v
    return aff


def community_script(scenario, seed, cap, strategy="mutual", rounds=COMMUNITY_ROUNDS,
                     newcomer_join=NEWCOMER_JOIN):
    """Allocations of a community scenario, round by round. Returns (pop, script), script a
    list of dicts: round, members, allocs, work (contribution per member)."""
    b = BEH
    spec = COMMUNITY_SCENARIOS[scenario]
    pop = community_population(scenario, seed, newcomer_join)
    aff = affinity_matrix(pop, seed)
    script = []
    for r in range(1, rounds + 1):
        active = [m for m in pop if m.join <= r]
        work, signal, gives, noise = {}, {}, {}, {}
        for m in active:
            rng = random.Random(_h(seed, "round", r, m.name))
            works = rng.random() < b["p_work"]
            z = rng.lognormvariate(0, b["round_sigma"])
            gives[m.name] = rng.random() < b["p_give"]
            sig = b["noise_sigma"]
            noise[m.name] = {o.name: math.exp(sig * rng.gauss(0.0, 1.0))
                             for o in active if o.name != m.name}
            if m.kind == "free_rider":
                work[m.name] = 0.0
                signal[m.name] = b["free_rider_claim"] * z if works else 0.0
            elif m.kind == "colluder":
                work[m.name] = b["colluder_work"] * m.base * z if works else 0.0
                signal[m.name] = work[m.name]
            else:
                work[m.name] = m.base * z if works else 0.0
                signal[m.name] = work[m.name]
        allocs = {}
        for m in active:
            def prefs(exclude):
                return [(signal[o.name] * o.vis * aff[(m.name, o.name)] * noise[m.name][o.name],
                         o.name) for o in active if o.name != m.name and o.name not in exclude]
            if m.kind == "colluder":
                targets = ring_targets(m.group, m.name, r, strategy)
                ring = ring_gifts(targets, 100, cap)
                spent = sum(t for _, t in ring)
                rest = split(100 - spent, prefs(set(m.group)), cap, 10 - len(ring), b["focus"])
                allocs[m.name] = ring + rest
            elif m.kind == "free_rider":
                if spec.get("riders_give"):
                    allocs[m.name] = split(100, prefs(()), cap, 10, b["focus"])
            elif gives[m.name]:
                allocs[m.name] = split(100, prefs(()), cap, 10, b["focus"])
        script.append({"round": r, "members": [m.name for m in active], "seats": [],
                       "allocs": {g: a for g, a in allocs.items() if a}, "work": work})
    return pop, script


# The testnet house community (DESIGN.md "House members"): five honest contributors, a
# colluding pair, a free rider; three council members vote by the published rule.
HOUSE = [
    # name, kind, items per round (mean when working)
    ("ana", "honest", 6.0), ("ben", "honest", 5.0), ("cleo", "honest", 4.0),
    ("dina", "honest", 3.0), ("emil", "honest", 2.5),
    ("finn", "pair", 2.0), ("gus", "pair", 2.0),
    ("hugo", "free_rider", 0.0),
]
HOUSE_NEWCOMER = ("ivy", "honest", 4.0)
HOUSE_COUNCIL = ["council-a", "council-b", "council-c"]
HOUSE_BEH = {
    "p_work": 0.9,            # a house member skips about one round in ten (no note, no thanks)
    "items_sigma": 0.4,       # items fixed this round: round(mean * lognormal(0, 0.4))
    "noise_sigma": 0.5,       # thanks proportional to the items in the notes, times this noise
    "focus": 0.15,
    "welcome_each": 5,        # thanks to each welcomed guest
    "welcome_max": 2,         # guests welcomed per house member and round
    "free_rider_claim": 0.5,  # chance the free rider's note claims one item
    "visit_rate": 0.5,        # visitors arriving per round (Poisson)
    "visit_stay": 0.4,        # chance a visitor comes back for the next round
    "visit_note": 0.8,        # chance a visitor posts a note
    "visit_give": 0.9,        # chance a visitor gives its thanks
    "visit_receivers": (2, 5),
}
TESTNET_ROUNDS = 144          # 48 hours of 20-minute rounds
HOUSE_NEWCOMER_JOIN = 61
STEADY_FROM = {"testnet": 49, "community": 53}


def poisson(rng, lam):
    k, p, l = 0, 1.0, math.exp(-lam)
    while True:
        p *= rng.random()
        if p < l:
            return k
        k += 1


def house_script(seed, cfg, rounds=TESTNET_ROUNDS, newcomer=True, visitors=True, farm=None,
                 newcomer_join=HOUSE_NEWCOMER_JOIN, visit_rate=None):
    """The testnet house community round by round. farm: None, "outsider" (one person holds
    every guest seat and spreads its thanks) or "accomplice" (the farm and the free rider
    thank each other)."""
    hb = HOUSE_BEH
    cap = cfg["cap_per_receiver"]
    seats_max = cfg["guest_seats"]
    house = [Member(n, k, items=i) for n, k, i in HOUSE]
    if newcomer:
        n, k, i = HOUSE_NEWCOMER
        house.append(Member(n, k, items=i, join=newcomer_join))
    pair = [m.name for m in house if m.kind == "pair"]
    script = []
    visitors_on = []          # [name, rounds left]
    vcount = 0
    rate = hb["visit_rate"] if visit_rate is None else visit_rate
    farm_names = [guest_id("farm %d" % k) for k in range(seats_max)] if farm else []
    turned_away = 0
    for r in range(1, rounds + 1):
        rng = random.Random(_h(seed, "house", r))
        active = [m for m in house if m.join <= r]
        items, work, skip = {}, {}, {}
        for m in active:
            mr = random.Random(_h(seed, "house", r, m.name))
            works = mr.random() < hb["p_work"]
            z = mr.lognormvariate(0, hb["items_sigma"])
            skip[m.name] = not works
            if m.kind == "free_rider":
                items[m.name] = 1 if mr.random() < hb["free_rider_claim"] else 0
                work[m.name] = 0.0
                skip[m.name] = False
            else:
                items[m.name] = max(0, int(round(m.items * z))) if works else 0
                work[m.name] = float(items[m.name])
        # guests: the farm holds every seat; otherwise visitors arrive and stay
        seats, guest_note, guest_gives = [], {}, {}
        allocs = {}
        member_names = [m.name for m in active]
        if farm:
            seats = list(farm_names)
            for gname in seats:
                guest_note[gname] = True
                if farm == "accomplice":
                    gifts = [("hugo", cap)]
                    others = [(rng.random() + 0.01, n) for n in member_names if n != "hugo"]
                    gifts += split(100 - cap, others, cap, 3, 0)
                else:
                    others = [(rng.random() + 0.01, n) for n in member_names]
                    gifts = split(100, others, cap, 3, 0)
                allocs[gname] = sorted(gifts)
                guest_gives[gname] = True
            turned_away += poisson(rng, rate) if visitors else 0
        elif visitors:
            stay = []
            for v in visitors_on:
                if rng.random() < hb["visit_stay"]:
                    stay.append(v)
            visitors_on = stay
            for _ in range(poisson(rng, rate)):
                if len(visitors_on) < seats_max:
                    vcount += 1
                    visitors_on.append(guest_id("visitor %d %d" % (seed, vcount)))
                else:
                    turned_away += 1
            seats = list(visitors_on)
            for gname in seats:
                gr = random.Random(_h(seed, "visit", r, gname))
                guest_note[gname] = gr.random() < hb["visit_note"]
                if gr.random() < hb["visit_give"]:
                    k = gr.randint(*hb["visit_receivers"])
                    prefs = [((items[n] + 0.5) * gr.lognormvariate(0, hb["noise_sigma"]), n)
                             for n in member_names]
                    allocs[gname] = split(100, prefs, cap, k, 0)
                    guest_gives[gname] = bool(allocs[gname])
        welcome_pool = sorted(g for g in seats if guest_note.get(g) and guest_gives.get(g))
        for m in active:
            if m.kind == "free_rider" or skip[m.name]:
                if farm == "accomplice" and m.name == "hugo":
                    k0 = r % len(farm_names)
                    targets = [farm_names[(k0 + d) % len(farm_names)] for d in range(3)]
                    allocs["hugo"] = ring_gifts(targets, 100, cap)
                continue
            mr = random.Random(_h(seed, "give", r, m.name))
            gifts = []
            if welcome_pool:
                pick = mr.sample(welcome_pool, min(hb["welcome_max"], len(welcome_pool)))
                gifts += [(g, hb["welcome_each"]) for g in pick]
            left = 100 - sum(t for _, t in gifts)
            if m.kind == "pair":
                partner = [p for p in pair if p != m.name][0]
                gifts.append((partner, cap))
                left -= cap
                exclude = {partner}
            else:
                exclude = set()
            prefs = [(items[o] * mr.lognormvariate(0, hb["noise_sigma"]), o)
                     for o in member_names if o != m.name and o not in exclude]
            gifts += split(left, prefs, cap, 10 - len(gifts), hb["focus"])
            allocs[m.name] = sorted(gifts)
        script.append({"round": r, "members": member_names, "seats": seats,
                       "allocs": {g: a for g, a in allocs.items() if a}, "work": work,
                       "notes": {n: items[n] for n in member_names},
                       "welcome_pool": welcome_pool, "turned_away": turned_away})
    return house, script


# ---------------------------------------------------------------------------
# Playing a script through the model, with the house council's rule
# ---------------------------------------------------------------------------

def round_index(res):
    """Per receiver: counted points by giver; per giver: the receivers it thanked."""
    cnt = res["count"]
    by_recv, gave_to = {}, {}
    for k, (g, r, t) in enumerate(cnt["rows"]):
        by_recv.setdefault(r, {})[g] = cnt["counted"][k]
        gave_to.setdefault(g, set()).add(r)
    return by_recv, gave_to


def council_decision(x, res, index):
    """The house council's published rule. Tier 2: approve unless more than half of the
    receiver's points came from one giver whom the receiver also thanked this round.
    Tier 3: approve only if at least three givers stand behind the points."""
    if x["tier"] == 1:
        return "paid"
    recv = x["receiver"]
    givers = index[0].get(recv, {})
    gave_to = index[1].get(recv, set())
    p = res["points"].get(recv, 0)
    if x["tier"] == 2:
        if givers:
            top_g = max(sorted(givers), key=lambda g: givers[g])
            if givers[top_g] * 2 > p and top_g in gave_to:
                return "rejected"
        return "paid"
    return "paid" if sum(1 for v in givers.values() if v > 0) >= 3 else "rejected"


BIG_BALANCE = 10 ** 6 * U


def play(cfg, script, council=True, balance=BIG_BALANCE, keep=False):
    """Plays a script through the model. Returns totals per account and per round."""
    hat = Hat(cfg)
    acc = {}
    rounds = []
    for row in script:
        r = row["round"]
        res = hat.close(r, row["members"], row["seats"], row["allocs"], balance)
        rec = {"round": r, "n": 0, "tiers": [0, 0, 0, 0], "planned": 0, "budget": 0,
               "moved": 0, "lapsed": 0, "rejected": 0}
        if res["empty"]:
            for name, v, _ in res["lapsed"]:
                acc.setdefault(name, new_acc())["lapsed"] += v
            rec["lapsed"] = sum(v for _, v, _ in res["lapsed"])
        else:
            rec["budget"] = res["budget"]
            rec["moved"] = len(res["moved"])
            rec["lapsed"] = sum(v for _, v, _ in res["lapsed"])
            index = round_index(res) if council else None
            for x in res["payouts"]:
                a = acc.setdefault(x["receiver"], new_acc())
                a["planned"] += x["amount"]
                a["n"] += 1
                a["tiers"][x["tier"]] += 1
                a["tier_rounds"].append((r, x["tier"]))
                rec["n"] += 1
                rec["tiers"][x["tier"]] += 1
                rec["planned"] += x["amount"]
                status = council_decision(x, res, index) if council else "paid"
                hat.resolve(r, x["receiver"], status)
                if status == "paid":
                    a["paid"] += x["amount"]
                else:
                    a["struck"] += 1
                    rec["rejected"] += 1
            for name, v, _ in res["lapsed"]:
                acc.setdefault(name, new_acc())["lapsed"] += v
            for name, p in res["points"].items():
                acc.setdefault(name, new_acc())["points"] += p
        for name, w in row["work"].items():
            acc.setdefault(name, new_acc())["work"] += w
        if keep:
            rec["res"] = res
            rec["rep"] = dict(hat.rep)
        rounds.append(rec)
    assert hat.audit()
    return {"acc": acc, "rounds": rounds, "hat": hat}


def new_acc():
    return {"planned": 0, "paid": 0, "n": 0, "tiers": [0, 0, 0, 0], "tier_rounds": [],
            "struck": 0, "lapsed": 0, "points": 0, "work": 0.0}


def payout_totals(cfg, script):
    """Planned payouts per account over a script: the model's counting, shares and carry
    without reputation and tiers (they do not change amounts). Used by the sweep; equal to
    the planned totals of play(...)."""
    members_cache = {}
    carry = {}
    total = {}
    min_payout = cfg["min_payout"]
    for row in script:
        r = row["round"]
        allocs = {g: a for g, a in row["allocs"].items() if a}
        if not allocs:
            for acc in [a for a, v in carry.items() if r - v[1] >= cfg["carry_rounds"]]:
                del carry[acc]
            continue
        key = tuple(row["members"])
        members = members_cache.get(key)
        if members is None:
            members = members_cache[key] = named_members(row["members"])
        cnt = count_round(cfg, members, set(row["seats"]), allocs)
        p = {a: x for a, x in cnt["points"].items() if x > 0}
        total_p = sum(p.values())
        budget = min(cfg["round_budget"], max(0, BIG_BALANCE - cfg["reserve"])) if total_p else 0
        for acc in sorted(p):
            old = carry.get(acc)
            q = budget * p[acc] // total_p + (old[0] if old else 0)
            if q == 0 or q < min_payout:
                if q > 0:
                    carry[acc] = (q, old[1] if old else r)
            else:
                carry.pop(acc, None)
                total[acc] = total.get(acc, 0) + q
        for acc in [a for a, v in carry.items() if r - v[1] >= cfg["carry_rounds"]]:
            del carry[acc]
    return total


def selftest():
    """A few numbers worked out by hand, independent of the golden files."""
    docs = golden_docs()
    r1 = docs["linear"]["rounds"][0]["expected"]
    # ana: 45 from ben (the replacing call) + 25 from cleo = 70 thanks of 260; budget 100 tUSD
    assert dict(r1["points"])[ANA] == "70000"
    assert r1["payouts"][0] == {"receiver": ANA, "amount": str(100 * U * 70_000 // 260_000),
                                "tier": 3, "r0": "0", "auto_limit": "0",
                                "cosign_limit": str(10 * U)}
    # guests round 1: guests give 100 + 100 + 99 thanks at 33.33 %: G = 16,665 * 4 +
    # 13,332 + 9,999 + 9,665 = 99,656 > M / 4 = 75,000, so the cap scales every guest entry
    # by M * 2000 / (G * 8000) = 600,000,000 / 797,248,000: X1 -> ana 16,665 becomes
    # 12,541 (12,541.7 rounded down). ana gave X1 10 (10,000), so both lose
    # 10,000 * 25 % = 2,500: X1 counts 7,500 and ana 10,041 from X1.
    g1 = docs["guests"]["rounds"][0]["expected"]
    assert g1["guests_weight"] == "99656" and g1["guest_scaled"]
    ent = {(e[0], e[1]): e for e in g1["entries"]}
    assert ent[(X1, ANA)][3:5] == ["12541", "10041"], ent[(X1, ANA)]
    assert ent[(ANA, X1)][3:7] == ["10000", "7500", "7500", "7500"], ent[(ANA, X1)]
    # dampening round 1: hugo never gives, so each share in hugo counts half after
    # aggregation; finn has two givers (< 3), so his shares count half
    d1 = docs["dampening"]["rounds"][0]["expected"]
    for e in d1["entries"]:
        if e[1] == HUGO or e[1] == FINN:
            assert int(e[6]) == int(e[5]) // 2, e
    # dampening round 3: the strike on finn is his round-2 points, read before the close of
    # round 3 (no decay); on hugo (round 5) his round-3 points decayed once
    d3 = docs["dampening"]["rounds"][2]["expected"]
    d2 = docs["dampening"]["rounds"][1]["expected"]
    assert d3["strikes"][0] == [FINN, 2, "rejected", dict(d2["points"])[FINN]]
    d5 = docs["dampening"]["rounds"][4]["expected"]
    assert d5["strikes"][0][3] == str(int(dict(d3["points"])[HUGO]) * 9_500 // 10_000)
    return True
