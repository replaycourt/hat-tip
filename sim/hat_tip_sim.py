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
    "guest_receive_cap_bp",
]
# Fields the contract accepts without a value, and their defaults.
CONFIG_DEFAULTS = {"guest_receive_cap_bp": 10_000}
# U128 in the contract: decimal strings in JSON.
U128_FIELDS = {"round_budget", "min_payout", "reserve", "auto_per_thanks", "auto_max",
               "cosign_base", "cosign_per_thanks", "cosign_max"}


def config_json(cfg, omit_defaults=False):
    """A config dict (ints internally) in the contract's JSON form, field order of I-1.
    omit_defaults leaves out optional fields at their default (the golden vectors do, so
    vectors written before a field existed stay unchanged)."""
    out = {}
    for f in CONFIG_FIELDS:
        v = cfg.get(f, CONFIG_DEFAULTS.get(f))
        if omit_defaults and f in CONFIG_DEFAULTS and v == CONFIG_DEFAULTS[f]:
            continue
        out[f] = str(v) if f in U128_FIELDS else v
    return out


def config_from_json(js):
    cfg = {}
    for f in CONFIG_FIELDS:
        v = js.get(f, CONFIG_DEFAULTS.get(f))
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
    # 7. guests' receive cap: guests together receive at most guest_receive_cap_bp of the
    # round's points, by the same rule as the cap on what they give (one floor per entry)
    rcap = cfg.get("guest_receive_cap_bp", BP)
    to_guests = to_members = 0
    receive_scaled = False
    if rcap < BP:
        for k, (g, r, t) in enumerate(rows):
            if r in seats:
                to_guests += a[k]
            else:
                to_members += a[k]
        receive_scaled = to_guests * (BP - rcap) > to_members * rcap
        if receive_scaled:
            num, den = to_members * rcap, to_guests * (BP - rcap)
            for k, (g, r, t) in enumerate(rows):
                if r in seats:
                    a[k] = a[k] * num // den
    # 8. points
    points = {}
    for k, (g, r, t) in enumerate(rows):
        points[r] = points.get(r, 0) + a[k]
    return {
        "rows": rows, "dropped": dropped, "weight": w_weight, "reciprocal": w_recip,
        "aggregated": a_agg, "counted": a, "members_weight": m_total, "guests_weight": g_total,
        "guest_scaled": guest_scaled, "W": big_w, "Q": big_q, "support": support,
        "narrow": narrow, "idle": idle, "givers": givers, "points": points,
        "receive_cap": rcap < BP, "to_guests": to_guests, "to_members": to_members,
        "receive_scaled": receive_scaled,
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
    "guest_receive_cap_bp": 10_000,
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
    "receive_cap": {
        "about": "The guests' receive cap (guest_receive_cap_bp 10 %): a member feeding three "
                 "guest seats that thank him back, with reciprocity, breadth and the guests' "
                 "giving cap on; the receive cap binding (one floor per entry), not binding, and "
                 "a round whose only entry goes to a guest, so the cap leaves no points and no "
                 "budget.",
        "config": {"guest_receive_cap_bp": 1_000, "cap_per_receiver": 25, "reciprocal_bp": 2_500,
                   "breadth_k": 3, "breadth_bp": 2_500, "guest_weight_bp": 5_000,
                   "guest_cap_bp": 2_000, "decay_bp": 750, "min_payout": 2 * U,
                   "auto_rep_min": 10},
        "initial_members": FIVE,
        "rounds": [
            (1, {"seats": [X1, X2, X3],
                 "calls": [(DINA, [(X1, 25), (X2, 25), (X3, 25), (ANA, 25)]),
                           (X1, [(DINA, 25), (ANA, 25), (BEN, 25)]),
                           (X2, [(DINA, 25), (ANA, 25), (BEN, 25)]),
                           (X3, [(DINA, 25), (ANA, 25), (CLEO, 25)]),
                           (ANA, [(BEN, 25), (CLEO, 25), (X1, 5), (X2, 5)]),
                           (BEN, [(ANA, 25), (CLEO, 25), (EMIL, 25), (X3, 5)]),
                           (CLEO, [(ANA, 25), (BEN, 25), (EMIL, 25), (X1, 5), (X2, 5), (X3, 5)]),
                           (EMIL, [(ANA, 20), (BEN, 20), (CLEO, 20), (X1, 5), (X2, 5), (X3, 5)])],
                 "members": FIVE, "balance": 1_000 * U}),
            (2, {"seats": [X4],
                 "calls": [(X4, [(ANA, 25), (EMIL, 25)]),
                           (ANA, [(BEN, 25), (CLEO, 25), (DINA, 25), (X4, 5)]),
                           (BEN, [(ANA, 25), (CLEO, 25), (EMIL, 25), (X4, 5)]),
                           (CLEO, [(ANA, 25), (BEN, 25), (DINA, 25), (X4, 5)]),
                           (DINA, [(ANA, 25), (BEN, 25), (EMIL, 25)]),
                           (EMIL, [(ANA, 25), (CLEO, 25), (DINA, 25)])],
                 "members": FIVE, "balance": 1_000 * U}),
            (3, {"seats": [X1],
                 "calls": [(ANA, [(X1, 25)])],
                 "members": FIVE, "balance": 1_000 * U}),
            (4, {"seats": [X2, X3],
                 "calls": [(DINA, [(X2, 25), (X3, 25), (ANA, 25), (BEN, 25)]),
                           (X2, [(DINA, 25), (CLEO, 25)]),
                           (X3, [(DINA, 25), (EMIL, 25)]),
                           (ANA, [(BEN, 25), (CLEO, 25), (EMIL, 25), (X2, 5)]),
                           (BEN, [(ANA, 25), (CLEO, 25), (DINA, 25), (X3, 5)]),
                           (CLEO, [(ANA, 25), (BEN, 25), (X2, 5), (X3, 5)]),
                           (EMIL, [(ANA, 25), (BEN, 25), (X2, 5), (X3, 5)])],
                 "members": FIVE, "balance": 1_000 * U}),
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
            }
            if cnt["receive_cap"]:
                exp.update({"to_guests": _s(cnt["to_guests"]), "to_members": _s(cnt["to_members"]),
                            "receive_scaled": cnt["receive_scaled"]})
            exp.update({
                "points": [[a, _s(p)] for a, p in sorted(cnt["points"].items())],
                "budget": _s(res["budget"]),
                "dust": _s(res["dust"]),
                "payouts": [{"receiver": x["receiver"], "amount": _s(x["amount"]),
                             "tier": x["tier"], "r0": _s(x["r0"]),
                             "auto_limit": _s(x["auto_limit"]),
                             "cosign_limit": _s(x["cosign_limit"])} for x in res["payouts"]],
                "moved_to_tier2": res["moved"],
                "lapsed": [[a, _s(v), since] for a, v, since in res["lapsed"]],
            })
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
        "config": config_json(cfg, omit_defaults=True),
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


# ---------------------------------------------------------------------------
# Measures
# ---------------------------------------------------------------------------

def ranks(xs):
    order = sorted(range(len(xs)), key=lambda i: xs[i])
    rk = [0.0] * len(xs)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and xs[order[j + 1]] == xs[order[i]]:
            j += 1
        for k in range(i, j + 1):
            rk[order[k]] = (i + j) / 2 + 1
        i = j + 1
    return rk


def spearman(xs, ys):
    if len(xs) < 3:
        return float("nan")
    rx, ry = ranks(xs), ranks(ys)
    mx, my = statistics.mean(rx), statistics.mean(ry)
    num = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
    den = math.sqrt(sum((a - mx) ** 2 for a in rx) * sum((b - my) ** 2 for b in ry))
    return num / den if den else float("nan")


def med(xs):
    return statistics.median(xs) if xs else float("nan")


HONEST_KINDS = ("honest", "honest_pair", "newcomer")


# ---------------------------------------------------------------------------
# Configurations
# ---------------------------------------------------------------------------

# DESIGN.md "Launch parameters": the values that are not *sim*.
COMMUNITY_FIXED = {
    "dao": None, "token": None, "members_role": "members", "council_role": "council",
    "thanks_role": "thanks", "genesis_ms": None, "round_ms": 604_800_000,
    "thanks_per_round": 100, "max_receivers": 10,
    "round_budget": 500 * U, "min_payout": 5 * U, "carry_rounds": 8, "reserve": 0,
    "guest_seats": 0, "guest_weight_bp": 0, "guest_cap_bp": 0,
    "max_members": 48, "max_catchup": 8, "log_keep": 52, "note_max_bytes": 80,
}
TESTNET_FIXED = {
    "dao": None, "token": None, "members_role": "members", "council_role": "council",
    "thanks_role": "thanks", "genesis_ms": None, "round_ms": 1_200_000,
    "thanks_per_round": 100, "max_receivers": 10,
    "carry_rounds": 12, "reserve": 0, "guest_seats": 6,
    "max_members": 24, "max_catchup": 36, "log_keep": 108, "note_max_bytes": 80,
}
# First guesses for the *sim* values (DESIGN.md's "about" values where it gives one).
RULES_OFF = {"cap_per_receiver": 50, "reciprocal_bp": BP, "quadratic": False,
             "breadth_k": 0, "breadth_bp": BP, "idle_bp": BP}
TIER_GUESS = {"decay_bp": 500, "auto_rep_min": 200, "auto_per_thanks_bp": 2,
              "auto_max_bp": 1200, "auto_share_bp": 6000, "cosign_base_bp": 800,
              "cosign_per_thanks_bp": 5, "cosign_max_bp": 4000}
TESTNET_GUESS = {"round_budget": 120, "min_payout": 2, "guest_weight_bp": 5000,
                 "guest_cap_bp": 2000}


def tier_values(tiers, budget):
    """Tier knobs relative to the budget (basis points of B, per thanks where noted) in
    contract units."""
    return {
        "decay_bp": tiers["decay_bp"],
        "auto_rep_min": tiers["auto_rep_min"],
        "auto_per_thanks": budget * tiers["auto_per_thanks_bp"] // BP,
        "auto_max": budget * tiers["auto_max_bp"] // BP,
        "auto_share_bp": tiers["auto_share_bp"],
        "cosign_base": budget * tiers["cosign_base_bp"] // BP,
        "cosign_per_thanks": budget * tiers["cosign_per_thanks_bp"] // BP,
        "cosign_max": budget * tiers["cosign_max_bp"] // BP,
    }


def community_config(rules, tiers=TIER_GUESS, receive_cap=BP):
    cfg = dict(COMMUNITY_FIXED)
    cfg.update(rules)
    cfg.update(tier_values(tiers, cfg["round_budget"]))
    cfg["guest_receive_cap_bp"] = receive_cap
    return cfg


def testnet_config(rules, budget=TESTNET_GUESS, tiers=TIER_GUESS, receive_cap=BP):
    cfg = dict(TESTNET_FIXED)
    cfg["guest_receive_cap_bp"] = receive_cap
    cfg.update(rules)
    cfg["round_budget"] = budget["round_budget"] * U
    cfg["min_payout"] = budget["min_payout"] * U
    cfg["guest_weight_bp"] = budget["guest_weight_bp"]
    cfg["guest_cap_bp"] = budget["guest_cap_bp"]
    cfg.update(tier_values(tiers, cfg["round_budget"]))
    return cfg


# ---------------------------------------------------------------------------
# Stage A: the collusion rules
# ---------------------------------------------------------------------------

A_GRID = {
    "cap_per_receiver": [25, 34, 40, 50],
    "reciprocal_bp": [10_000, 7_500, 5_000, 2_500],
    "quadratic": [False, True],
    "breadth": [(0, 10_000), (2, 5_000), (3, 5_000), (4, 5_000), (3, 2_500)],
    "idle_bp": [10_000, 7_500, 5_000, 2_500],
}
A_SCENARIOS = ["honest", "free_riders", "pair", "ring3", "ring4"]
A_COLLUSION = ["pair", "ring3", "ring4"]
A_SEEDS = list(range(1, 9))
A_TIE_PP = 0.25


def rule_key(rules):
    return (rules["cap_per_receiver"], rules["reciprocal_bp"], rules["quadratic"],
            rules["breadth_k"], rules["breadth_bp"], rules["idle_bp"])


def rules_from_key(k):
    return {"cap_per_receiver": k[0], "reciprocal_bp": k[1], "quadratic": k[2],
            "breadth_k": k[3], "breadth_bp": k[4], "idle_bp": k[5]}


def staged_totals(cfg, script, combos):
    """Planned payouts per account for many rule combinations at once: steps 1-2 once per
    round, reciprocity once per reciprocal_bp, aggregation once per (reciprocal_bp,
    quadratic), breadth and idle per combination. Same integer steps as count_round (the
    sweep checks that on samples). combos: [(rbp, quad, bk, bbp, ibp)]."""
    base_cfg = dict(cfg, reciprocal_bp=BP, quadratic=False, breadth_k=0, breadth_bp=BP,
                    idle_bp=BP)
    rbps = sorted({c[0] for c in combos})
    quads = sorted({c[1] for c in combos})
    state = {c: ({}, {}) for c in combos}     # combo -> (carry, totals)
    min_payout, keep = cfg["min_payout"], cfg["carry_rounds"]
    members_cache = {}
    for row in script:
        r = row["round"]
        allocs = {g: a for g, a in row["allocs"].items() if a}
        if not allocs:
            for carry, _ in state.values():
                for acc in [a for a, v in carry.items() if r - v[1] >= keep]:
                    del carry[acc]
            continue
        key = tuple(row["members"])
        members = members_cache.get(key)
        if members is None:
            members = members_cache[key] = named_members(row["members"])
        base = count_round(base_cfg, members, set(row["seats"]), allocs)
        rows, w = base["rows"], base["weight"]
        n = len(rows)
        recv = [rr for _, rr, _ in rows]
        idle_r = [rr in members and rr not in allocs for rr in recv]
        index = {(g, rr): k for k, (g, rr, t) in enumerate(rows)}
        for rbp in rbps:
            w3 = list(w)
            if rbp < BP:
                for k, (g, rr, t) in enumerate(rows):
                    j = index.get((rr, g))
                    if j is not None and g < rr:
                        d = min(w[k], w[j]) * (BP - rbp) // BP
                        w3[k] -= d
                        w3[j] -= d
            for quad in quads:
                if quad:
                    v = [math.isqrt(x * SQRT_SCALE) for x in w3]
                    s = {}
                    for k in range(n):
                        s[recv[k]] = s.get(recv[k], 0) + v[k]
                    big_w = sum(w3)
                    big_q = sum(x * x for x in s.values())
                    a4 = [big_w * v[k] * s[recv[k]] // big_q if big_q else 0 for k in range(n)]
                else:
                    a4 = w3
                support, shares_of, plain = {}, {}, {}
                for k in range(n):
                    rk = recv[k]
                    if a4[k] > 0:
                        support[rk] = support.get(rk, 0) + 1
                    shares_of.setdefault(rk, []).append(a4[k])
                    plain[rk] = plain.get(rk, 0) + a4[k]
                idle_set = {recv[k] for k in range(n) if idle_r[k]}
                receivers = sorted(plain)
                for c in combos:
                    if c[0] != rbp or c[1] != quad:
                        continue
                    bk, bbp, ibp = c[2], c[3], c[4]
                    p = {}
                    for rk in receivers:
                        f1 = bbp if (bk > 0 and bbp < BP and support.get(rk, 0) < bk) else BP
                        f2 = ibp if (ibp < BP and rk in idle_set) else BP
                        if f1 == BP and f2 == BP:
                            x = plain[rk]
                        else:
                            x = sum((a * f1 // BP) * f2 // BP for a in shares_of[rk])
                        if x > 0:
                            p[rk] = x
                    total_p = sum(p.values())
                    budget = min(cfg["round_budget"], BIG_BALANCE - cfg["reserve"]) if total_p else 0
                    carry, totals = state[c]
                    for acc in p:
                        old = carry.get(acc)
                        q = budget * p[acc] // total_p + (old[0] if old else 0)
                        if q < min_payout:
                            if q > 0:
                                carry[acc] = (q, old[1] if old else r)
                        elif q > 0:
                            carry.pop(acc, None)
                            totals[acc] = totals.get(acc, 0) + q
                    for acc in [a for a, v in carry.items() if r - v[1] >= keep]:
                        del carry[acc]
    return {c: st[1] for c, st in state.items()}


def _task_a(args):
    scenario, seed, cap, strategy = args
    pop, script = community_script(scenario, seed, cap, strategy)
    combos = [(rbp, q, bk, bbp, ibp) for rbp in A_GRID["reciprocal_bp"]
              for q in A_GRID["quadratic"] for (bk, bbp) in A_GRID["breadth"]
              for ibp in A_GRID["idle_bp"]]
    cfg = community_config(dict(RULES_OFF, cap_per_receiver=cap))
    totals = staged_totals(cfg, script, combos)
    # check the staged evaluation against the model on two combinations
    rng = random.Random(_h("check", scenario, seed, cap, strategy))
    for c in rng.sample(combos, 2):
        full = payout_totals(dict(cfg, reciprocal_bp=c[0], quadratic=c[1], breadth_k=c[2],
                                  breadth_bp=c[3], idle_bp=c[4]), script)
        assert full == totals[c], ("staged evaluation differs", scenario, seed, cap, c)
    work = {}
    for row in script:
        for name, x in row["work"].items():
            work[name] = work.get(name, 0.0) + x
    kinds = {m.name: m.kind for m in pop}
    total_work = sum(work.values())
    coll_work = sum(work.get(n, 0) for n, k in kinds.items() if k == "colluder")
    honest = [n for n, k in kinds.items() if k in HONEST_KINDS]
    out = {}
    for c, tot in totals.items():
        total_pay = sum(tot.values())
        coll = sum(tot.get(n, 0) for n, k in kinds.items() if k == "colluder")
        fr = sum(tot.get(n, 0) for n, k in kinds.items() if k == "free_rider")
        pair = sum(tot.get(n, 0) for n, k in kinds.items() if k == "honest_pair")
        rho = spearman([tot.get(n, 0) for n in honest], [work.get(n, 0) for n in honest])
        out[(cap,) + c] = (coll, fr, pair, total_pay, rho)
    return (scenario, seed, strategy), {"coll_work": coll_work, "total_work": total_work,
                                        "fr_work": 0.0}, out


def run_pool(fn, tasks, workers):
    if workers <= 1:
        return [fn(t) for t in tasks]
    with Pool(workers) as pool:
        return pool.map(fn, tasks, chunksize=1)


def stage_a(workers, seeds=A_SEEDS, log=print):
    tasks = []
    for cap in A_GRID["cap_per_receiver"]:
        for sc in A_SCENARIOS:
            strategies = ["mutual", "one_way"] if sc in A_COLLUSION else ["mutual"]
            for seed in seeds:
                for st in strategies:
                    tasks.append((sc, seed, cap, st))
    log("stage A: %d runs of %d rule sets each" % (len(tasks), len(tasks) and 160))
    results = run_pool(_task_a, tasks, workers)
    # data[scenario][seed][strategy] = (work, {combo: metrics})
    data = {}
    for (sc, seed, st), wk, out in results:
        d = data.setdefault(sc, {}).setdefault(seed, {}).setdefault(st, [wk, {}])
        d[1].update(out)
    keys = sorted(next(iter(data["honest"].values()))["mutual"][1])
    base_key = rule_key(RULES_OFF)
    rows = []
    for k in keys:
        row = {"key": k, "scenarios": {}}
        for sc in A_SCENARIOS:
            ex, rho, fr_ex, pair_loss, strat = [], [], [], [], {}
            for seed in seeds:
                runs = data[sc][seed]
                # colluders' best response: the strategy that pays them more
                st = max(sorted(runs), key=lambda s: runs[s][1][k][0])
                strat[st] = strat.get(st, 0) + 1
                wk, m = runs[st][0], runs[st][1][k]
                coll, fr, pair, total, r_ = m
                ex.append(100 * (coll / total - wk["coll_work"] / wk["total_work"]) if total else 0)
                fr_ex.append(100 * fr / total if total else 0)
                rho.append(r_)
                if sc == "honest":
                    bpair = runs["mutual"][1][base_key][2]
                    pair_loss.append(100 * (1 - pair / bpair) if bpair else 0)
            row["scenarios"][sc] = {"excess": med(ex), "rho": med(rho), "fr_excess": med(fr_ex),
                                    "pair_loss": med(pair_loss) if pair_loss else None,
                                    "strategy": strat, "excess_all": ex}
        row["objective"] = statistics.mean(row["scenarios"][s]["excess"] for s in A_COLLUSION)
        rows.append(row)
    base = next(r for r in rows if r["key"] == base_key)
    for row in rows:
        fails = []
        for sc in A_SCENARIOS:
            if row["scenarios"][sc]["rho"] < base["scenarios"][sc]["rho"] - 0.05:
                fails.append("tracking (%s)" % sc)
        if row["scenarios"]["honest"]["pair_loss"] > 15:
            fails.append("honest pair")
        row["fails"] = fails
    passing = [r for r in rows if not r["fails"]]
    best = min(r["objective"] for r in passing)
    tied = [r for r in passing if r["objective"] <= best + A_TIE_PP]

    def n_rules(k):
        return (k[1] < BP) + bool(k[2]) + (k[3] > 0 and k[4] < BP) + (k[5] < BP)

    def offness(k):
        return (A_GRID["reciprocal_bp"].index(k[1]) + int(k[2])
                + A_GRID["breadth"].index((k[3], k[4])) + A_GRID["idle_bp"].index(k[5]))

    tied.sort(key=lambda r: (n_rules(r["key"]), r["scenarios"]["free_riders"]["fr_excess"],
                             -r["key"][0], offness(r["key"])))
    pick = tied[0]
    log("stage A pick %s objective %.2f pp (best %.2f, %d pass, %d tied)"
        % (pick["key"], pick["objective"], best, len(passing), len(tied)))
    return {"rows": rows, "base": base, "pick": pick, "best": best, "n_pass": len(passing),
            "n_tied": len(tied)}


# ---------------------------------------------------------------------------
# Stage C: budget and minimum payout (testnet demo)
# ---------------------------------------------------------------------------

C_GRID = {"round_budget": [100, 120, 150], "min_payout": [1, 2, 3, 5]}
C_SEEDS = list(range(1, 7))
C_MAX_PAYOUTS = 7.0
C_MIN_VISITORS_PAID = 75.0
C_MAX_LAPSED = 2.0


def visitor_stats(script, res):
    """Visitors thanked by at least three house members (over their visit), and how many
    of them got a payout."""
    house = {n for n, _, _ in HOUSE} | {HOUSE_NEWCOMER[0]}
    welcomed = {}
    for row in script:
        for g, gifts in row["allocs"].items():
            if g in house:
                for recv, _ in gifts:
                    if is_implicit(recv):
                        welcomed.setdefault(recv, set()).add(g)
    many = [v for v, s in welcomed.items() if len(s) >= 3]
    paid = [v for v in many if res["acc"].get(v, {}).get("n", 0) > 0]
    return len(many), len(paid)


def _task_c(args):
    seed, rules = args
    cfg0 = testnet_config(rules)
    _, script = house_script(seed, cfg0)
    out = {}
    for b in C_GRID["round_budget"]:
        for mp in C_GRID["min_payout"]:
            cfg = testnet_config(rules, dict(TESTNET_GUESS, round_budget=b, min_payout=mp))
            res = play(cfg, script)
            n = sum(r["n"] for r in res["rounds"])
            budget = sum(r["budget"] for r in res["rounds"])
            lapsed = sum(r["lapsed"] for r in res["rounds"])
            many, paid = visitor_stats(script, res)
            out[(b, mp)] = {"per_round": n / len(script), "lapsed": 100 * lapsed / budget,
                            "visitors": many, "visitors_paid": paid}
    return seed, out


def stage_c(rules, workers, seeds=C_SEEDS, log=print):
    results = run_pool(_task_c, [(s, rules) for s in seeds], workers)
    rows = []
    for b in C_GRID["round_budget"]:
        for mp in C_GRID["min_payout"]:
            ms = [o[(b, mp)] for _, o in results]
            many = sum(m["visitors"] for m in ms)
            row = {"key": (b, mp), "per_round": med([m["per_round"] for m in ms]),
                   "lapsed": med([m["lapsed"] for m in ms]),
                   "visitors_paid": 100 * sum(m["visitors_paid"] for m in ms) / many if many else 0,
                   "visitors": many}
            fails = []
            if row["per_round"] > C_MAX_PAYOUTS:
                fails.append("payouts per round")
            if row["visitors_paid"] < C_MIN_VISITORS_PAID:
                fails.append("visitors paid")
            if row["lapsed"] > C_MAX_LAPSED:
                fails.append("lapsed carry")
            row["fails"] = fails
            rows.append(row)

    def steps(k):
        return (abs(C_GRID["round_budget"].index(k[0]) - C_GRID["round_budget"].index(120))
                + abs(C_GRID["min_payout"].index(k[1]) - C_GRID["min_payout"].index(2)))

    passing = [r for r in rows if not r["fails"]]
    pool = passing or rows
    pick = min(pool, key=lambda r: (steps(r["key"]), r["key"][1], -r["key"][0]))
    log("stage C pick %s (%d pass)" % (pick["key"], len(passing)))
    return {"rows": rows, "pick": pick, "n_pass": len(passing)}


# ---------------------------------------------------------------------------
# Stage B: tier limits and decay
# ---------------------------------------------------------------------------

B_GRID = {
    "decay_bp": [300, 500, 750, 1000],
    "auto_rep_min": [100, 200, 300, 500],
    "auto_per_thanks_bp": [0.5, 1, 2, 5],      # basis points of B per thanks of reputation
    "auto_max_bp": [800, 1200, 1600, 2500],
    "auto_share_bp": [5000, 6000, 7000, 8000],
    "cosign_base_bp": [400, 800, 1200, 1600],
    "cosign_per_thanks_bp": [1, 2, 5, 10],
    "cosign_max_bp": [2500, 4000, 6000, 8000],
}
B_GROUPS = [["decay_bp", "auto_rep_min", "auto_per_thanks_bp"],
            ["auto_max_bp", "auto_share_bp"],
            ["cosign_base_bp", "cosign_per_thanks_bp", "cosign_max_bp"]]
B_SEEDS = list(range(1, 7))
B_TARGET = (70.0, 25.0, 5.0)
B_BANDS = ((60, 80), (15, 35), (2, 10))
B_NEWCOMER = (6, 10)
COMMUNITY_B_ROUNDS = 104


def tier_values(tiers, budget):   # noqa: F811 (fractional basis points allowed)
    def part(bp):
        return int(budget * bp) // BP
    return {
        "decay_bp": tiers["decay_bp"],
        "auto_rep_min": tiers["auto_rep_min"],
        "auto_per_thanks": part(tiers["auto_per_thanks_bp"]),
        "auto_max": part(tiers["auto_max_bp"]),
        "auto_share_bp": tiers["auto_share_bp"],
        "cosign_base": part(tiers["cosign_base_bp"]),
        "cosign_per_thanks": part(tiers["cosign_per_thanks_bp"]),
        "cosign_max": part(tiers["cosign_max_bp"]),
    }


def tier_metrics(res, steady_from, newcomer, join):
    t = [0, 0, 0, 0]
    bound = 0
    for rec in res["rounds"]:
        if rec["round"] >= steady_from:
            for k in (1, 2, 3):
                t[k] += rec["tiers"][k]
            bound += rec["moved"] > 0
    n = sum(t)
    share = [100 * t[k] / n if n else 0 for k in (1, 2, 3)]
    first = next((r for r, tier in res["acc"].get(newcomer, new_acc())["tier_rounds"]
                  if tier == 1), None)
    to_t1 = first - join + 1 if first is not None else 99
    return {"share": share, "newcomer": to_t1, "cap_rounds": bound,
            "steady_rounds": sum(1 for r in res["rounds"] if r["round"] >= steady_from)}


def _setting_script(setting, seed, ctx):
    if setting == "testnet":
        cfg = ctx["testnet_cfg"]
        _, script = house_script(seed, cfg)
        return script, "ivy", HOUSE_NEWCOMER_JOIN
    _, script = community_script("mixed", seed, ctx["rules"]["cap_per_receiver"],
                                 ctx["strategy"], rounds=COMMUNITY_B_ROUNDS,
                                 newcomer_join=STEADY_FROM["community"])
    return script, "new", STEADY_FROM["community"]


def _setting_config(setting, ctx, tiers):
    if setting == "testnet":
        return testnet_config(ctx["rules"], ctx["budget"], tiers)
    return community_config(ctx["rules"], tiers)


def _task_b(args):
    setting, seed, ctx, tier_list = args
    script, newcomer, join = _setting_script(setting, seed, ctx)
    out = []
    for tiers in tier_list:
        res = play(_setting_config(setting, ctx, tiers), script)
        out.append(tier_metrics(res, STEADY_FROM[setting], newcomer, join))
    return out


def b_score(share, newcomer):
    d = sum(abs(s - t) for s, t in zip(share, B_TARGET))
    lo, hi = B_NEWCOMER
    off = max(0, lo - newcomer, newcomer - hi)
    return d + 5 * off


def b_passes(share, newcomer):
    return (all(lo <= s <= hi for s, (lo, hi) in zip(share, B_BANDS))
            and B_NEWCOMER[0] <= newcomer <= B_NEWCOMER[1])


def eval_tiers(setting, ctx, tier_list, workers, seeds=B_SEEDS):
    tasks = [(setting, s, ctx, tier_list) for s in seeds]
    results = run_pool(_task_b, tasks, workers)
    agg = []
    for i in range(len(tier_list)):
        ms = [res[i] for res in results]
        share = [med([m["share"][k] for m in ms]) for k in range(3)]
        newcomer = med([m["newcomer"] for m in ms])
        agg.append({"share": share, "newcomer": newcomer,
                    "cap_rounds": med([m["cap_rounds"] for m in ms]),
                    "steady_rounds": ms[0]["steady_rounds"],
                    "score": b_score(share, newcomer), "pass": b_passes(share, newcomer)})
    return agg


def stage_b(setting, ctx, workers, log=print, max_passes=4):
    cur = dict(TIER_GUESS)
    history = []
    for npass in range(max_passes):
        changed = False
        for group in B_GROUPS:
            combos = [dict()]
            for k in group:
                combos = [dict(c, **{k: v}) for c in combos for v in B_GRID[k]]
            tier_list = [dict(cur, **c) for c in combos]
            agg = eval_tiers(setting, ctx, tier_list, workers)

            def steps(t):
                return sum(abs(B_GRID[k].index(t[k]) - B_GRID[k].index(cur[k])) for k in group)

            best = min(a["score"] for a in agg)
            cands = [(steps(t), a["score"], i) for i, (t, a) in enumerate(zip(tier_list, agg))
                     if a["score"] <= best + 1]
            i = min(cands)[2]
            new = tier_list[i]
            history.append({"pass": npass + 1, "group": group, "tiers": dict(new),
                            "metrics": agg[i], "n": len(tier_list),
                            "n_pass": sum(a["pass"] for a in agg)})
            log("stage B %s pass %d %s -> %s score %.1f share %s newcomer %s"
                % (setting, npass + 1, group, {k: new[k] for k in group}, agg[i]["score"],
                   ["%.0f" % x for x in agg[i]["share"]], agg[i]["newcomer"]))
            if any(new[k] != cur[k] for k in group):
                changed = True
            cur = new
        if not changed:
            break
    final = eval_tiers(setting, ctx, [cur], workers)[0]
    return {"pick": cur, "metrics": final, "history": history}


# ---------------------------------------------------------------------------
# Stage D: the guests' receive cap (testnet demo)
# ---------------------------------------------------------------------------

D_GRID = [10_000, 2_000, 1_500, 1_000, 800, 600, 500, 400, 300]
D_SEEDS = list(range(1, 9))
D_FARM_MAX = 50.0          # the farm's take with the cap, % of its take without
D_VISITORS_KEEP = 80.0     # visitors' payout share with the cap, % of their share without
D_VISITORS_PAID = 75.0     # % of visitors thanked by 3+ house members who get a payout
D_BUSY_KEEP = 50.0         # busy demo: visitors' payout share kept, % of the share without
D_SCENARIOS = [("visitors", {}), ("busy", {"visit_rate": 2.0}),
               ("accomplice", {"farm": "accomplice"}), ("outsider", {"farm": "outsider"})]


def _task_d(args):
    seed, pick = args
    _, cfg0 = launch_configs(dict(pick, guest_receive_cap_bp=BP))
    farm_ids = {guest_id("farm %d" % k) for k in range(cfg0["guest_seats"])}
    out = {}
    for name, kw in D_SCENARIOS:
        _, script = house_script(seed, cfg0, **kw)
        for rc in D_GRID:
            cfg = dict(cfg0, guest_receive_cap_bp=rc)
            res = play(cfg, script)
            acc = res["acc"]
            total = sum(a["planned"] for a in acc.values())
            guests = sum(a["planned"] for n, a in acc.items() if is_implicit(n))
            farm = sum(a["planned"] for n, a in acc.items() if n in farm_ids)
            many, paid = visitor_stats(script, res)
            n = len(script)
            out[(name, rc)] = {"guest_share": 100 * guests / total if total else 0,
                               "farm": farm / n / U, "hugo": acc.get("hugo", new_acc())["planned"] / n / U,
                               "visitors": many, "visitors_paid": paid,
                               "per_round": sum(r["n"] for r in res["rounds"]) / n}
    return seed, out


def stage_d(pick, workers, seeds=D_SEEDS, log=print):
    results = run_pool(_task_d, [(s, pick) for s in seeds], workers)

    def agg(name, rc, key):
        return med([o[(name, rc)][key] for _, o in results])

    rows = []
    for rc in D_GRID:
        many = sum(o[("visitors", rc)]["visitors"] for _, o in results)
        paid = sum(o[("visitors", rc)]["visitors_paid"] for _, o in results)
        row = {"cap": rc,
               "visitors_share": agg("visitors", rc, "guest_share"),
               "visitors_paid": 100 * paid / many if many else 0.0,
               "busy_share": agg("busy", rc, "guest_share"),
               "farm": agg("accomplice", rc, "farm"), "hugo": agg("accomplice", rc, "hugo"),
               "outsider": agg("outsider", rc, "farm"),
               "per_round": agg("visitors", rc, "per_round")}
        rows.append(row)
    base = rows[0]
    for row in rows:
        row["farm_pct"] = 100 * row["farm"] / base["farm"] if base["farm"] else 0.0
        row["visitors_keep"] = (100 * row["visitors_share"] / base["visitors_share"]
                                if base["visitors_share"] else 0.0)
        row["busy_keep"] = 100 * row["busy_share"] / base["busy_share"] if base["busy_share"] else 0.0
        fails = []
        if row["farm_pct"] > D_FARM_MAX:
            fails.append("farm")
        if row["visitors_keep"] < D_VISITORS_KEEP:
            fails.append("visitors' share")
        if row["visitors_paid"] < D_VISITORS_PAID:
            fails.append("visitors paid")
        if row["busy_keep"] < D_BUSY_KEEP:
            fails.append("busy demo")
        row["fails"] = fails
    passing = [r for r in rows if not r["fails"]]
    fallback = False
    if passing:
        pick_row = max(passing, key=lambda r: r["cap"])
    else:
        fallback = True
        core = [r for r in rows if not (set(r["fails"]) - {"busy demo"})]
        pick_row = max(core, key=lambda r: r["cap"]) if core else rows[0]
    log("stage D pick %d (%d pass%s)" % (pick_row["cap"], len(passing),
                                         ", fallback" if fallback else ""))
    return {"rows": rows, "pick": pick_row["cap"], "n_pass": len(passing), "fallback": fallback}


# ---------------------------------------------------------------------------
# Scenarios with the launch values
# ---------------------------------------------------------------------------

S_SEEDS = list(range(1, 9))
S_COMMUNITY = ["honest", "free_riders", "free_riders_giving", "pair", "ring3", "ring4", "mixed"]


def kinds_of(pop):
    return {m.name: m.kind for m in pop}


def community_metrics(pop, res, base_pair=None):
    kinds = kinds_of(pop)
    acc = res["acc"]
    total_pay = sum(a["planned"] for a in acc.values())
    total_work = sum(a["work"] for a in acc.values())

    def group(kind_set):
        names = [n for n, k in kinds.items() if k in kind_set]
        pay = sum(acc.get(n, new_acc())["planned"] for n in names)
        paid = sum(acc.get(n, new_acc())["paid"] for n in names)
        work = sum(acc.get(n, new_acc())["work"] for n in names)
        n_pay = sum(acc.get(n, new_acc())["n"] for n in names)
        t1 = sum(acc.get(n, new_acc())["tiers"][1] for n in names)
        struck = sum(acc.get(n, new_acc())["struck"] for n in names)
        return {"names": names, "pay": pay, "paid": paid, "work": work, "n": n_pay, "t1": t1,
                "struck": struck,
                "excess": 100 * (pay / total_pay - work / total_work) if total_pay else 0.0}

    honest = [n for n, k in kinds.items() if k in HONEST_KINDS]
    m = {
        "colluders": group({"colluder"}),
        "free_riders": group({"free_rider"}),
        "honest_pair": group({"honest_pair"}),
        "rho": spearman([acc.get(n, new_acc())["planned"] for n in honest],
                        [acc.get(n, new_acc())["work"] for n in honest]),
        "total_pay": total_pay,
    }
    new = acc.get("new", new_acc())
    first = next((r for r, t in new["tier_rounds"] if t == 1), None)
    m["newcomer_t1"] = first - NEWCOMER_JOIN + 1 if first else 99
    return m


def _task_s(args):
    scenario, seed, launch_rules, launch_tiers = args
    out = {}
    for label, rules, tiers in (("none", RULES_OFF, launch_tiers),
                                ("launch", launch_rules, launch_tiers)):
        cfg = community_config(rules, tiers)
        best = None
        strategies = ["mutual", "one_way"] if COMMUNITY_SCENARIOS[scenario]["ring"] else ["mutual"]
        for st in strategies:
            pop, script = community_script(scenario, seed, rules["cap_per_receiver"], st)
            res = play(cfg, script)
            m = community_metrics(pop, res)
            m["strategy"] = st
            if best is None or m["colluders"]["pay"] > best["colluders"]["pay"]:
                best = m
        out[label] = best
    return scenario, seed, out


def run_community(launch_rules, launch_tiers, workers, seeds=S_SEEDS):
    tasks = [(sc, s, launch_rules, launch_tiers) for sc in S_COMMUNITY for s in seeds]
    out = {}
    for sc, seed, m in run_pool(_task_s, tasks, workers):
        out.setdefault(sc, {})[seed] = m
    summary = {}
    for sc in S_COMMUNITY:
        row = {}
        for label in ("none", "launch"):
            ms = [out[sc][s][label] for s in seeds]
            row[label] = {
                "coll_excess": med([m["colluders"]["excess"] for m in ms]),
                "coll_paid": med([100 * m["colluders"]["paid"] / m["colluders"]["pay"]
                                  for m in ms if m["colluders"]["pay"]]),
                "coll_t1": med([100 * m["colluders"]["t1"] / m["colluders"]["n"]
                                for m in ms if m["colluders"]["n"]]),
                "fr_excess": med([m["free_riders"]["excess"] for m in ms]),
                "rho": med([m["rho"] for m in ms]),
                "pair_pay": [m["honest_pair"]["pay"] for m in ms],
                "newcomer_t1": med([m["newcomer_t1"] for m in ms]),
                "strategy": sorted({m["strategy"] for m in ms}),
                "strategies": [m["strategy"] for m in ms],
            }
        row["pair_change"] = med([100 * (a / b - 1) for a, b in
                                  zip(row["launch"]["pair_pay"], row["none"]["pair_pay"]) if b])
        summary[sc] = row
    return summary


def testnet_metrics(house, script, res, cfg):
    acc = res["acc"]
    kinds = {m.name: m.kind for m in house}
    total_pay = sum(a["planned"] for a in acc.values())
    total_work = sum(a["work"] for a in acc.values())
    budget = sum(r["budget"] for r in res["rounds"])

    def share(names, key="planned"):
        return 100 * sum(acc.get(n, new_acc())[key] for n in names) / total_pay if total_pay else 0

    pair = [n for n, k in kinds.items() if k == "pair"]
    honest = [n for n, k in kinds.items() if k == "honest"]
    guests = [n for n in acc if is_implicit(n)]
    pair_work = 100 * sum(acc.get(n, new_acc())["work"] for n in pair) / total_work
    pair_n = sum(acc.get(n, new_acc())["n"] for n in pair)
    pair_t23 = sum(acc.get(n, new_acc())["tiers"][2] + acc.get(n, new_acc())["tiers"][3]
                   for n in pair)
    pair_struck = sum(acc.get(n, new_acc())["struck"] for n in pair)
    tm = tier_metrics(res, STEADY_FROM["testnet"], "ivy", HOUSE_NEWCOMER_JOIN)
    many, paid = visitor_stats(script, res)
    rounds = len(res["rounds"])
    farm_ids = {guest_id("farm %d" % k) for k in range(cfg["guest_seats"])}
    farm = [n for n in guests if n in farm_ids]
    return {
        "per_round": sum(r["n"] for r in res["rounds"]) / rounds,
        "share": tm["share"], "newcomer": tm["newcomer"], "cap_rounds": tm["cap_rounds"],
        "pair_excess": share(pair) - pair_work,
        "pair_paid_share": share(pair, "paid") - pair_work,
        "pair_t23": 100 * pair_t23 / pair_n if pair_n else 0,
        "pair_rejected": 100 * pair_struck / pair_t23 if pair_t23 else 0,
        "free_rider_share": share(["hugo"]),
        "honest_share": share(honest), "honest_work": 100 * sum(
            acc.get(n, new_acc())["work"] for n in honest) / total_work,
        "guest_share": share(guests),
        "guest_per_round": sum(acc.get(n, new_acc())["planned"] for n in guests) / rounds / U,
        "farm_per_round": sum(acc.get(n, new_acc())["planned"] for n in farm) / rounds / U,
        "hugo_per_round": acc.get("hugo", new_acc())["planned"] / rounds / U,
        "visitors": many, "visitors_paid": paid,
        "turned_away": script[-1]["turned_away"],
        "rejected": sum(r["rejected"] for r in res["rounds"]) / rounds,
        "lapsed": 100 * sum(r["lapsed"] for r in res["rounds"]) / budget if budget else 0,
    }


TESTNET_VARIANTS = [
    # label, kwargs for house_script, rules: "launch", "none" (every dampening rule and the
    # receive cap off) or "nocap" (launch without the guests' receive cap)
    ("House, visitors and a newcomer", {}, "launch"),
    ("The same without dampening", {}, "none"),
    ("House only (no visitors, no newcomer)", {"visitors": False, "newcomer": False}, "launch"),
    ("Busy demo: visitors at 2 per round", {"visit_rate": 2.0}, "launch"),
    ("Guest farm, outsider", {"farm": "outsider"}, "launch"),
    ("Guest farm with the free rider as accomplice", {"farm": "accomplice"}, "launch"),
    ("The same without the receive cap", {"farm": "accomplice"}, "nocap"),
    ("Accomplice farm without dampening", {"farm": "accomplice"}, "none"),
]


def _task_t(args):
    seed, cfgs = args
    out = []
    for label, kw, which in TESTNET_VARIANTS:
        cfg = cfgs[which]
        house, script = house_script(seed, cfg, **kw)
        res = play(cfg, script)
        out.append(testnet_metrics(house, script, res, cfg))
    return seed, out


def run_testnet(cfg_launch, cfg_none, workers, seeds=S_SEEDS):
    cfgs = {"launch": cfg_launch, "none": cfg_none,
            "nocap": dict(cfg_launch, guest_receive_cap_bp=BP)}
    results = run_pool(_task_t, [(s, cfgs) for s in seeds], workers)
    rows = []
    for i, (label, kw, which) in enumerate(TESTNET_VARIANTS):
        ms = [o[i] for _, o in results]
        row = {"label": label}
        for k in ms[0]:
            if k == "share":
                row[k] = [med([m[k][j] for m in ms]) for j in range(3)]
            else:
                row[k] = med([m[k] for m in ms])
        row["visitors_paid_pct"] = (100 * sum(m["visitors_paid"] for m in ms)
                                    / max(1, sum(m["visitors"] for m in ms)))
        rows.append(row)
    return rows


# ---------------------------------------------------------------------------
# Charts: static SVG, no plotting library
# ---------------------------------------------------------------------------

# The first three categorical slots of a palette validated for all-pairs use (light and
# dark steps), a neutral for context, and the page's surfaces. Each SVG carries its own
# background and switches to the dark steps with the reader's colour scheme.
SVG_STYLE = """
.c{--bg:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--muted:#6f6e69;--grid:#e1e0d9;--axis:#c3c2b7;
--s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a;--ctx:#b5b4ad}
@media (prefers-color-scheme: dark){.c{--bg:#1a1a19;--ink:#f0efec;--ink2:#c3c2b7;--muted:#a3a29b;
--grid:#2c2c2a;--axis:#4a4a46;--s1:#3987e5;--s2:#d95926;--s3:#199e70;--ctx:#5c5b56}}
.bg{fill:var(--bg)}
text{font-family:system-ui,-apple-system,"Segoe UI",Helvetica,Arial,sans-serif;fill:var(--ink2);font-size:12px}
.t{fill:var(--ink);font-size:18px;font-weight:600}
.st{fill:var(--ink2);font-size:13px}
.ax{fill:var(--muted);font-size:11px;font-variant-numeric:tabular-nums}
.axt{fill:var(--ink2);font-size:12px}
.pt{fill:var(--ink);font-size:13px;font-weight:600}
.val{fill:var(--ink2);font-size:11px;font-variant-numeric:tabular-nums}
.grid{stroke:var(--grid);stroke-width:1;fill:none}
.axis{stroke:var(--axis);stroke-width:1;fill:none}
.ref{stroke:var(--muted);stroke-width:1;stroke-dasharray:4 3;fill:none}
.f1{fill:var(--s1)}.f2{fill:var(--s2)}.f3{fill:var(--s3)}.fc{fill:var(--ctx)}
.l1{stroke:var(--s1);stroke-width:2;fill:none;stroke-linejoin:round}
.l2{stroke:var(--s2);stroke-width:2;fill:none;stroke-linejoin:round}
.l3{stroke:var(--s3);stroke-width:2;fill:none;stroke-linejoin:round}
.lc{stroke:var(--ctx);stroke-width:1.5;fill:none;stroke-linejoin:round}
.dot{stroke:var(--bg);stroke-width:2}
"""


def _esc(x):
    return str(x).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


class Svg:
    def __init__(self, w, h, title, desc):
        self.w, self.h, self.title, self.desc = w, h, title, desc
        self.parts = []

    def add(self, x):
        self.parts.append(x)

    def text(self, x, y, s, cls="", anchor="start"):
        self.add('<text x="%.1f" y="%.1f" class="%s" text-anchor="%s">%s</text>'
                 % (x, y, cls, anchor, _esc(s)))

    def line(self, x1, y1, x2, y2, cls):
        self.add('<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" class="%s"/>'
                 % (x1, y1, x2, y2, cls))

    def rect(self, x, y, w, h, cls, tip=None, rx=0):
        t = "<title>%s</title>" % _esc(tip) if tip else ""
        self.add('<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" rx="%g" class="%s">%s</rect>'
                 % (x, y, max(0.0, w), max(0.0, h), rx, cls, t))

    def circle(self, x, y, r, cls, tip=None):
        t = "<title>%s</title>" % _esc(tip) if tip else ""
        self.add('<circle cx="%.1f" cy="%.1f" r="%g" class="%s">%s</circle>' % (x, y, r, cls, t))

    def render(self):
        head = ('<svg xmlns="http://www.w3.org/2000/svg" class="c" width="%d" height="%d" '
                'viewBox="0 0 %d %d" role="img" aria-labelledby="title desc">'
                '<title id="title">%s</title><desc id="desc">%s</desc><style>%s</style>'
                '<rect class="bg" width="%d" height="%d" rx="8"/>'
                % (self.w, self.h, self.w, self.h, _esc(self.title), _esc(self.desc),
                   SVG_STYLE, self.w, self.h))
        return head + "\n".join(self.parts) + "</svg>\n"

    def save(self, name):
        os.makedirs(DOCS_SIM, exist_ok=True)
        with open(os.path.join(DOCS_SIM, name), "w") as fh:
            fh.write(self.render())


def nice_step(span, n=4):
    raw = span / n
    mag = 10 ** math.floor(math.log10(raw))
    for m in (1, 2, 2.5, 5, 10):
        if raw <= m * mag:
            return m * mag
    return 10 * mag


def legend(svg, x, y, items):
    """items: [(css class, label)]; square swatches, labels in text ink."""
    for cls, label in items:
        svg.rect(x, y - 10, 12, 12, cls, rx=2)
        svg.text(x + 18, y, label)
        x += 30 + 7 * len(label)


def chart_excess(rows, path_name):
    """Grouped horizontal bars: colluders' excess payout share by rule set and scenario."""
    series = [("pair", "f1", "Colluding pair"), ("ring3", "f2", "Ring of three"),
              ("ring4", "f3", "Ring of four")]
    vals = [r["values"][k] for r in rows for k, _, _ in series]
    hi = max(1.0, max(vals))
    lo = min(0.0, min(vals))
    step = nice_step(hi - lo, 5)
    x1 = math.ceil(hi / step) * step
    x0 = math.floor(lo / step) * step
    band = 54
    top = 112
    h = top + band * len(rows) + 56
    svg = Svg(1000, h, "Colluders' excess payout share by rule set",
              "Horizontal grouped bars. For each rule set, the colluders' share of planned "
              "payouts minus their share of the work, in percentage points, for a colluding "
              "pair, a ring of three and a ring of four, each playing its best response. "
              "Medians over 8 seeds, 52 weekly rounds of a 24-member community.")
    svg.text(32, 40, "Colluders' excess payout share, by rule set", "t")
    svg.text(32, 62, "Payout share minus work share, percentage points; colluders play their "
             "best response. Median of 8 seeds, 52 rounds, 24 members.", "st")
    legend(svg, 32, 90, [(c, l) for _, c, l in series])
    xa, xb = 330, 940

    def X(v):
        return xa + (xb - xa) * (v - x0) / (x1 - x0)

    v = x0
    while v <= x1 + 1e-9:
        svg.line(X(v), top - 6, X(v), top + band * len(rows), "grid")
        svg.text(X(v), top + band * len(rows) + 18, "%g" % v, "ax", "middle")
        v += step
    svg.line(X(0), top - 6, X(0), top + band * len(rows), "axis")
    svg.text((xa + xb) / 2, top + band * len(rows) + 40, "Excess payout share (percentage "
             "points)", "axt", "middle")
    for i, r in enumerate(rows):
        y = top + i * band
        svg.text(xa - 12, y + 20, r["label"], "pt" if r.get("bold") else "", "end")
        if r.get("note"):
            svg.text(xa - 12, y + 36, r["note"], "ax", "end")
        for j, (k, cls, lab) in enumerate(series):
            val = r["values"][k]
            yy = y + 6 + j * 14
            a, b = sorted((X(0), X(val)))
            svg.rect(a, yy, max(1.0, b - a), 12, cls, "%s, %s: %+.2f pp" % (r["label"], lab, val),
                     rx=2)
            if r.get("bold") or i == 0:
                svg.text(max(a, b) + 6, yy + 10, "%+.1f" % val, "val")
    svg.save(path_name)


def chart_tracking(panels, path_name):
    """Two scatter panels: work share vs payout share per member, no dampening and launch."""
    allv = [v for p in panels for d in p["dots"] for v in d[1:3]]
    hi = max(allv) * 1.08
    step = nice_step(hi, 4)
    top_v = math.ceil(hi / step) * step
    svg = Svg(1000, 560, "Payout share against work share, per member",
              "Two scatter panels, one per rule set, the same community and seed. Each dot is "
              "a member: share of the work on the x-axis, share of the planned payouts on the "
              "y-axis, both in percent. The dashed diagonal is payout equal to work.")
    svg.text(32, 40, "Payout share against work share, per member", "t")
    svg.text(32, 62, "Mixed community (honest members, two free riders, a colluding pair), "
             "seed 1, 52 rounds. Dashed: payout share equal to work share.", "st")
    legend(svg, 32, 90, [("f1", "Honest member"), ("f2", "Colluder"), ("f3", "Free rider")])
    for pi, p in enumerate(panels):
        px = 40 + pi * 480
        xa, xb, ya, yb = px + 50, px + 430, 140, 500

        def X(v):
            return xa + (xb - xa) * v / top_v

        def Y(v):
            return yb - (yb - ya) * v / top_v

        svg.text(px + 10, 124, p["title"], "pt")
        v = 0.0
        while v <= top_v + 1e-9:
            svg.line(xa, Y(v), xb, Y(v), "grid")
            svg.text(xa - 8, Y(v) + 4, "%g" % v, "ax", "end")
            svg.text(X(v), yb + 18, "%g" % v, "ax", "middle")
            v += step
        svg.line(xa, yb, xb, yb, "axis")
        svg.line(X(0), Y(0), X(top_v), Y(top_v), "ref")
        svg.text((xa + xb) / 2, yb + 40, "Share of the work (%)", "axt", "middle")
        svg.add('<text x="%.1f" y="%.1f" class="axt" text-anchor="middle" '
                'transform="rotate(-90 %.1f %.1f)">Share of payouts (%%)</text>'
                % (px + 12, (ya + yb) / 2, px + 12, (ya + yb) / 2))
        cls = {"honest": "f1", "colluder": "f2", "free_rider": "f3"}
        for kind in ("honest", "free_rider", "colluder"):
            for name, wv, pv, k in p["dots"]:
                if k == kind:
                    svg.circle(X(wv), Y(pv), 5, cls[k] + " dot",
                               "%s (%s): work %.1f %%, payouts %.1f %%" % (name, k, wv, pv))
    svg.save(path_name)


def chart_tiers(rounds, join, path_name, title_extra):
    """Stacked bars: payouts per round by tier, testnet demo, one seed."""
    n = len(rounds)
    hi = max(sum(r) for r in rounds)
    top_v = max(4, int(math.ceil(hi / 2.0) * 2))
    svg = Svg(1000, 420, "Payouts per round by tier, testnet demo",
              "Stacked bars, one per 20-minute round over 48 hours: the number of payouts "
              "approved automatically (tier 1), by one council vote (tier 2) and by a council "
              "majority (tier 3). A dashed line marks the round the newcomer joins.")
    svg.text(32, 40, "Payouts per round by tier, testnet demo", "t")
    svg.text(32, 62, "House community with visitors and a newcomer, launch values, seed 1, %s."
             % title_extra, "st")
    legend(svg, 32, 90, [("f1", "Tier 1: automatic"), ("f2", "Tier 2: one council vote"),
                         ("f3", "Tier 3: council majority")])
    xa, xb, ya, yb = 70, 960, 120, 360
    bw = (xb - xa) / n

    def Y(v):
        return yb - (yb - ya) * v / top_v

    for v in range(0, top_v + 1, 2):
        svg.line(xa, Y(v), xb, Y(v), "grid")
        svg.text(xa - 8, Y(v) + 4, str(v), "ax", "end")
    for k in range(0, n + 1, 12):
        svg.text(xa + k * bw, yb + 18, str(k), "ax", "middle")
    svg.text((xa + xb) / 2, yb + 44, "Round (20 minutes each; 72 rounds = 24 hours)", "axt",
             "middle")
    svg.add('<text x="%.1f" y="%.1f" class="axt" text-anchor="middle" '
            'transform="rotate(-90 %.1f %.1f)">Payouts</text>' % (24, (ya + yb) / 2, 24, (ya + yb) / 2))
    for i, counts in enumerate(rounds):
        base = 0
        for t, cls in ((0, "f1"), (1, "f2"), (2, "f3")):
            c = counts[t]
            if c:
                y_top = Y(base + c)
                svg.rect(xa + i * bw + 0.5, y_top + 1, bw - 1.5, Y(base) - y_top - 1, cls,
                         "round %d: tier %d, %d payouts" % (i + 1, t + 1, c))
            base += c
    svg.line(xa, yb, xb, yb, "axis")
    xj = xa + (join - 1) * bw
    svg.line(xj, ya - 14, xj, yb, "ref")
    svg.text(xj + 4, ya - 6, "newcomer joins", "ax")
    svg.save(path_name)


def chart_reputation(series, rounds, thresh, path_name):
    """Lines: reputation of house members over the rounds; the pair, the free rider and the
    newcomer highlighted, the honest members as context."""
    hi = max(v for _, _, vals in series for v in vals if v is not None)
    step = nice_step(hi, 4)
    top_v = math.ceil(hi / step) * step
    svg = Svg(1000, 440, "Reputation of the house members, testnet demo",
              "Line chart over 144 rounds. Grey lines: the five honest house members. "
              "Coloured: the newcomer, the colluding pair and the free rider. The dashed "
              "line is the reputation needed for automatic payouts.")
    svg.text(32, 40, "Reputation of the house members, testnet demo", "t")
    svg.text(32, 62, "Thanks of reputation (decayed points minus strikes); launch values, "
             "seed 1. Dashed: the minimum for tier 1.", "st")
    legend(svg, 32, 90, [("f1", "Newcomer"), ("f2", "Colluding pair"), ("f3", "Free rider"),
                         ("fc", "Honest members")])
    xa, xb, ya, yb = 80, 900, 120, 380

    def X(k):
        return xa + (xb - xa) * (k - 1) / (rounds - 1)

    def Y(v):
        return yb - (yb - ya) * v / top_v

    v = 0
    while v <= top_v + 1e-9:
        svg.line(xa, Y(v), xb, Y(v), "grid")
        svg.text(xa - 8, Y(v) + 4, "{:,.0f}".format(v), "ax", "end")
        v += step
    for k in range(0, rounds + 1, 12):
        svg.text(X(max(1, k)), yb + 18, str(k), "ax", "middle")
    svg.line(xa, yb, xb, yb, "axis")
    svg.line(xa, Y(thresh), xb, Y(thresh), "ref")
    svg.text((xa + xb) / 2, yb + 44, "Round", "axt", "middle")
    order = sorted(series, key=lambda s: s[0] != "lc")
    for cls, name, vals in order:
        pts = ["%.1f,%.1f" % (X(k + 1), Y(v)) for k, v in enumerate(vals) if v is not None]
        svg.add('<polyline class="%s" points="%s"><title>%s</title></polyline>'
                % (cls, " ".join(pts), _esc(name)))
        if cls != "lc":
            last = max(k for k, v in enumerate(vals) if v is not None)
            svg.text(X(last + 1) + 8, Y(vals[last]) + 4, name, "val")
    svg.save(path_name)


# ---------------------------------------------------------------------------
# sim/params.json (I-2)
# ---------------------------------------------------------------------------

NOTE_ITEMS = [("fixed", "kettle", "kettles"), ("repaired", "lamp", "lamps"),
              ("mended", "jacket", "jackets"), ("fixed", "toaster", "toasters"),
              ("adjusted", "bike brake", "bike brakes"), ("soldered", "radio", "radios"),
              ("sharpened", "knife", "knives"), ("glued", "chair", "chairs")]
NOTE_VAGUE = ["helped at the front desk", "made coffee for the volunteers",
              "sorted a box of screws", "tidied the workbench"]
HOUSE_TEXT = {
    "honest": ("Works in about nine rounds out of ten. When working: fixes "
               "round(items_mean * lognormal(0, items_sigma)) items, posts a note naming them, "
               "and hands out 100 thanks: first welcome_each thanks to each of up to "
               "welcome_max guests who posted a note and gave thanks this round (picked at "
               "random), then the rest to the other house members in proportion to the items "
               "in their notes times lognormal(0, noise_sigma) noise, whole thanks, at most "
               "cap_per_receiver each and max_receivers in all, dropping anyone below focus of "
               "the top pick. Skips the round (no note, no thanks) otherwise."),
    "pair": ("Labelled 'demo: colluding pair'. Works like an honest member, but every round it "
             "works gives its partner cap_per_receiver thanks first, then welcomes guests and "
             "spreads the rest like an honest member."),
    "free_rider": ("Labelled 'demo: free rider'. Fixes nothing, posts a vague note every round "
                   "(it claims one item with probability free_rider_claim, which the others "
                   "read as one item), and never gives thanks."),
    "council": ("Votes in the DAO by the published rule, at least two minutes after the payout "
                "is filed. Tier 2: approve, unless more than half of the receiver's points this "
                "round came from one giver whom the receiver also thanked this round; then "
                "reject. Tier 3: approve if at least three givers stand behind the receiver's "
                "points this round; otherwise reject."),
}


def house_document():
    hb = HOUSE_BEH
    members = []
    for name, kind, items in HOUSE:
        m = {"name": name, "kind": kind,
             "label": {"pair": "demo: colluding pair",
                       "free_rider": "demo: free rider"}.get(kind, ""),
             "parameters": {"items_mean": items}}
        if kind == "pair":
            m["parameters"]["partner"] = [n for n, k, _ in HOUSE if k == "pair" and n != name][0]
        m["strategy"] = HOUSE_TEXT[kind]
        m["notes"] = (NOTE_VAGUE if kind == "free_rider" else
                      ["%s {n} %s" % (v, many) for v, one, many in NOTE_ITEMS])
        members.append(m)
    n, k, items = HOUSE_NEWCOMER
    return {
        "about": "The labelled house members of the testnet demo and their published "
                 "strategies (DESIGN.md, 'House members'). Accounts are <name>.<root>. "
                 "Packages d and e read this block; the simulation plays exactly these rules.",
        "behaviour": {k2: (list(v) if isinstance(v, tuple) else v) for k2, v in hb.items()
                      if not k2.startswith("visit")},
        "visitors_in_the_simulation": {k2: (list(v) if isinstance(v, tuple) else v)
                                       for k2, v in hb.items() if k2.startswith("visit")},
        "members": members,
        "council": [{"name": c, "kind": "council", "strategy": HOUSE_TEXT["council"]}
                    for c in HOUSE_COUNCIL],
        "optional_newcomer": {"name": n, "kind": k, "parameters": {"items_mean": items},
                              "join_round": HOUSE_NEWCOMER_JOIN,
                              "note": "Simulated to check the newcomer target; the demo may "
                                      "add it through an AddMemberToRole proposal or leave "
                                      "it out."},
        "note_singular": {"{n} %s" % many: "1 %s" % one for _, one, many in NOTE_ITEMS},
    }


def params_document(pick):
    cfg_c, cfg_t = launch_configs(pick)
    return {
        "about": "Launch values picked by sim/hat_tip_sim.py by the pre-registered decision "
                 "rule; reasons and evidence in docs/SIMULATION.md. Field names and units are "
                 "the contract's Config (I-1).",
        "units": "tUSD amounts in base units (6 decimals) as decimal strings; *_bp in basis "
                 "points (10,000 = 100 %); auto_rep_min in whole thanks; auto_per_thanks and "
                 "cosign_per_thanks in base units per whole thanks of reputation; round_ms in "
                 "milliseconds. dao, token and genesis_ms are null here: they are set at "
                 "deployment.",
        "integer_rules": "docs/SIMULATION.md, 'Integer rules decided here' (also "
                         "sim/golden/README.md)",
        "community": {"about": "Example for a real community with weekly rounds "
                               "(DESIGN.md's 'Community' column).",
                      "config": config_json(cfg_c)},
        "testnet": {"about": "The testnet demo (DESIGN.md's 'Testnet demo' column).",
                    "config": config_json(cfg_t)},
        "pick": {"rules": pick["rules"], "testnet_budget": pick["testnet_budget"],
                 "tiers_testnet": pick["tiers_testnet"],
                 "tiers_community": pick["tiers_community"],
                 "colluder_strategy": pick.get("colluder_strategy", "mutual"),
                 "guest_receive_cap_bp": pick.get("guest_receive_cap_bp", BP)},
        "house": house_document(),
    }


def load_pick():
    with open(PARAMS_FILE) as fh:
        doc = json.load(fh)
    pick = doc["pick"]
    if params_document(pick) != doc:
        raise SystemExit("sim/params.json differs from what its pick block produces")
    return pick


def launch_configs(pick):
    rules = pick["rules"]
    rc = pick.get("guest_receive_cap_bp", BP)
    return (community_config(rules, pick["tiers_community"], rc),
            testnet_config(rules, pick["testnet_budget"], pick["tiers_testnet"], rc))


# ---------------------------------------------------------------------------
# Launch golden vectors and the page's replay
# ---------------------------------------------------------------------------

def _acct(name):
    return name if is_implicit(name) else name + ".test"


def script_to_golden(script, cfg, balance0, council=True):
    """A behaviour script as a golden script: allocations, members (the policy at each
    close includes members who join next round), outcomes by the council rule, and the
    DAO balance falling as payouts are paid."""
    hat = Hat(cfg)
    rounds = []
    balance = balance0
    pending = []
    for i, row in enumerate(script):
        r = row["round"]
        nxt = script[i + 1]["members"] if i + 1 < len(script) else row["members"]
        members = sorted(set(row["members"]) | set(nxt))
        outcomes = pending
        for pr, recv, status in outcomes:
            hat.resolve(pr, recv, status)
        at_close = balance
        res = hat.close(r, members, row["seats"], row["allocs"], at_close)
        pending = []
        if not res["empty"]:
            index = round_index(res)
            for x in res["payouts"]:
                status = council_decision(x, res, index) if council else "paid"
                pending.append((r, x["receiver"], status))
                if status == "paid":
                    balance -= x["amount"]
        spec = {"outcomes": [(pr, _acct(rc), st) for pr, rc, st in outcomes],
                "seats": [_acct(s) for s in row["seats"]],
                "notes": [(_acct(n), "%d items" % v) for n, v in
                          sorted(row.get("notes", {}).items()) if v],
                "calls": [(_acct(g), [(_acct(rc), t) for rc, t in gifts])
                          for g, gifts in sorted(row["allocs"].items())],
                "members": [_acct(m) for m in members],
                "balance": at_close}
        rounds.append((r, spec))
    return rounds


GOLDEN_DEPLOY = {"dao": "dao.test", "token": "tusd.test", "genesis_ms": 1_800_000_000_000}


def launch_golden_docs(pick):
    cfg_c, cfg_t = launch_configs(pick)
    cfg_c = dict(cfg_c, **GOLDEN_DEPLOY)
    cfg_t = dict(cfg_t, **GOLDEN_DEPLOY)
    docs = {}
    _, script = house_script(1, cfg_t, rounds=24, newcomer_join=9)
    rounds = script_to_golden(script, cfg_t, 1_000_000 * U)
    docs["launch_testnet"] = golden_doc("launch_testnet", {
        "about": "The testnet launch values with the house community (five honest members, "
                 "the colluding pair, the free rider), visitors and a newcomer who joins at "
                 "round 9, drawn by the behaviour models (seed 1, 24 rounds); outcomes by the "
                 "house council's rule; the DAO balance falls as payouts are paid.",
        "initial_members": [_acct(m) for m in script[0]["members"]],
        "rounds": rounds}, cfg_t)
    _, script = community_script("mixed", 1, pick["rules"]["cap_per_receiver"],
                                 pick.get("colluder_strategy", "mutual"), rounds=12,
                                 newcomer_join=7)
    rounds = script_to_golden(script, cfg_c, 20_000 * U)
    docs["launch_community"] = golden_doc("launch_community", {
        "about": "The community launch values with a 24-member community (honest members, "
                 "two free riders, a colluding pair, a newcomer from round 7), drawn by the "
                 "behaviour models (seed 1, 12 rounds); outcomes by the council rule.",
        "initial_members": [_acct(m) for m in script[0]["members"]],
        "rounds": rounds}, cfg_c)
    return docs


REPLAY_ROUNDS = 36


def replay_document(pick):
    """The same house community (seed 1, visitors, no newcomer) with the launch rules and
    with every dampening rule off, same gifts: for the page's second replay."""
    _, cfg_t = launch_configs(pick)
    cfg_none = dict(cfg_t, reciprocal_bp=BP, quadratic=False, breadth_k=0, breadth_bp=BP,
                    idle_bp=BP, guest_receive_cap_bp=BP)
    _, script = house_script(1, cfg_t, rounds=REPLAY_ROUNDS, newcomer=False)
    out = {"about": "The testnet house community over %d rounds (seed 1, with visitors), "
                    "played twice with the same gifts: with the launch rules and with "
                    "reciprocity, quadratic, breadth, idle and the guests' receive cap off "
                    "(cap per receiver kept). Points and "
                    "reputation in milli-thanks, amounts in tUSD base units. Generated by "
                    "sim/hat_tip_sim.py." % REPLAY_ROUNDS,
           "accounts": [_acct(n) for n, _, _ in HOUSE],
           "labels": {_acct(n): {"pair": "demo: colluding pair",
                                 "free_rider": "demo: free rider"}.get(k, "")
                      for n, k, _ in HOUSE},
           "rounds": []}
    hats = {"launch": Hat(cfg_t), "none": Hat(cfg_none)}
    pending = {"launch": [], "none": []}
    for row in script:
        r = row["round"]
        entry = {"round": r, "notes": {_acct(n): v for n, v in sorted(row["notes"].items())},
                 "seats": [_acct(s) for s in row["seats"]]}
        for label, hat in hats.items():
            for pr, recv, st in pending[label]:
                hat.resolve(pr, recv, st)
            res = hat.close(r, row["members"], row["seats"], row["allocs"], BIG_BALANCE)
            pending[label] = []
            side = {}
            if not res["empty"]:
                cnt = res["count"]
                index = round_index(res)
                pays = []
                for x in res["payouts"]:
                    st = council_decision(x, res, index)
                    pending[label].append((r, x["receiver"], st))
                    pays.append([_acct(x["receiver"]), str(x["amount"]), x["tier"], st])
                side = {"gifts": [[_acct(g), _acct(rc), t, str(cnt["counted"][k])]
                                  for k, (g, rc, t) in enumerate(cnt["rows"])],
                        "points": {_acct(a): str(v) for a, v in sorted(res["points"].items())},
                        "budget": str(res["budget"]), "payouts": pays}
            side["reputation"] = {_acct(a): str(v) for a, v in sorted(hat.rep.items()) if v}
            entry[label] = side
        out["rounds"].append(entry)
    return out


# ---------------------------------------------------------------------------
# The sweep, end to end
# ---------------------------------------------------------------------------

SWEEP_FILE = os.path.join(HERE, "sweep.json")


def a_row_json(r):
    return {"key": list(r["key"]), "objective": round(r["objective"], 4), "fails": r["fails"],
            "scenarios": {sc: {"excess": round(v["excess"], 4), "rho": round(v["rho"], 4),
                               "fr_excess": round(v["fr_excess"], 4),
                               "pair_loss": None if v["pair_loss"] is None else round(v["pair_loss"], 4),
                               "strategy": v["strategy"]}
                          for sc, v in r["scenarios"].items()}}


def sweep(workers, log=print, stage_a_result=None):
    a = stage_a_result or stage_a(workers, log=log)
    rules = rules_from_key(a["pick"]["key"])
    # the colluding pair's best response under the picked rules (stage A, pair scenario)
    strat = a["pick"]["scenarios"]["pair"]["strategy"]
    colluder_strategy = max(sorted(strat), key=lambda k: strat[k])
    c = stage_c(rules, workers, log=log)
    b_pick = c["pick"]["key"]
    budget = dict(TESTNET_GUESS, round_budget=b_pick[0], min_payout=b_pick[1])
    ctx = {"rules": rules, "budget": budget, "strategy": colluder_strategy,
           "testnet_cfg": testnet_config(rules, budget)}
    b_t = stage_b("testnet", ctx, workers, log=log)
    b_c = stage_b("community", ctx, workers, log=log)
    pick = {"rules": rules, "testnet_budget": budget, "tiers_testnet": b_t["pick"],
            "tiers_community": b_c["pick"], "colluder_strategy": colluder_strategy}
    d = stage_d(pick, workers, log=log)
    pick["guest_receive_cap_bp"] = d["pick"]
    rows = a["rows"]
    by_key = {r["key"]: r for r in rows}
    passing = sorted([r for r in rows if not r["fails"]], key=lambda r: r["objective"])
    failing = sorted([r for r in rows if r["fails"]], key=lambda r: r["objective"])
    cap = a["pick"]["key"][0]
    compare = {}
    for k in [rule_key(RULES_OFF), (cap, BP, False, 0, BP, BP)]:
        compare[k] = by_key[k]
    for rbp in A_GRID["reciprocal_bp"][1:]:
        compare[(cap, rbp, False, 0, BP, BP)] = by_key[(cap, rbp, False, 0, BP, BP)]
    compare[(cap, BP, True, 0, BP, BP)] = by_key[(cap, BP, True, 0, BP, BP)]
    for bk, bbp in A_GRID["breadth"][1:]:
        compare[(cap, BP, False, bk, bbp, BP)] = by_key[(cap, BP, False, bk, bbp, BP)]
    for ibp in A_GRID["idle_bp"][1:]:
        compare[(cap, BP, False, 0, BP, ibp)] = by_key[(cap, BP, False, 0, BP, ibp)]
    for capv in A_GRID["cap_per_receiver"]:
        k = (capv,) + a["pick"]["key"][1:]
        compare[k] = by_key[k]
    summary = {
        "about": "Summary of the last sweep (sim/hat_tip_sim.py sweep); the tables in "
                 "docs/SIMULATION.md are rendered from it.",
        "stage_a": {"n": len(rows), "n_pass": a["n_pass"], "n_tied": a["n_tied"],
                    "best": round(a["best"], 4), "base": a_row_json(a["base"]),
                    "pick": a_row_json(a["pick"]),
                    "top_passing": [a_row_json(r) for r in passing[:12]],
                    "top_failing": [a_row_json(r) for r in failing[:5]],
                    "compare": [a_row_json(r) for r in compare.values()],
                    "colluder_strategy": colluder_strategy},
        "stage_c": {"rows": [dict(r, key=list(r["key"])) for r in c["rows"]],
                    "pick": list(c["pick"]["key"]), "n_pass": c["n_pass"]},
        "stage_b": {"testnet": b_t, "community": b_c},
        "stage_d": d,
    }
    return pick, summary


def write_json(path, doc):
    with open(path, "w") as fh:
        fh.write(dumps(doc))


# ---------------------------------------------------------------------------
# Report: generated blocks in docs/SIMULATION.md
# ---------------------------------------------------------------------------

def table(head, rows):
    out = ["| " + " | ".join(head) + " |", "|" + "---|" * len(head)]
    out += ["| " + " | ".join(str(c) for c in r) + " |" for r in rows]
    return "\n".join(out)


def rules_label(k):
    k = tuple(k)
    parts = ["cap %d" % k[0]]
    if k[1] < BP:
        parts.append("R %g %%" % (k[1] / 100))
    if k[2]:
        parts.append("Q")
    if k[3] > 0 and k[4] < BP:
        parts.append("B %d at %g %%" % (k[3], k[4] / 100))
    if k[5] < BP:
        parts.append("I %g %%" % (k[5] / 100))
    return ", ".join(parts)


def pp(v, digits=1):
    return ("%+." + str(digits) + "f") % v


def strat_label(st):
    return ", ".join("%s %d" % (k.replace("_", "-"), v) for k, v in sorted(st.items()))


def md_stage_a(sa):
    base = sa["base"]
    rows = []
    for r in sa["compare"] + [sa["pick"]]:
        sc = r["scenarios"]
        label = rules_label(r["key"])
        if tuple(r["key"]) == rule_key(RULES_OFF):
            label = "cap 50, no dampening"
        if r["key"] == sa["pick"]["key"]:
            label = "**%s (launch)**" % label
        rows.append([label, pp(sc["pair"]["excess"]), pp(sc["ring3"]["excess"]),
                     pp(sc["ring4"]["excess"]), "%.2f" % r["objective"],
                     "%.1f %%" % sc["honest"]["pair_loss"],
                     "%+.3f" % (min(sc[s]["rho"] - base["scenarios"][s]["rho"]
                                    for s in A_SCENARIOS)),
                     pp(sc["free_riders"]["fr_excess"]),
                     "; ".join(r["fails"]) or "-"])
    seen = []
    uniq = []
    for row in rows:
        if row[0] not in seen:
            seen.append(row[0])
            uniq.append(row)
    head = ["Rule set", "Pair", "Ring of 3", "Ring of 4", "Objective (mean)",
            "Honest pair loses", "Tracking vs none (worst scenario)", "Free riders' excess",
            "Constraints failed"]
    out = [table(head, uniq), "",
           "Colluders' excess payout share in percentage points (payout share minus work "
           "share, colluders combined, best response), medians over %d seeds. The objective "
           "is the mean of the three. R: reciprocity, Q: quadratic, B: breadth (fewer than k "
           "givers count at the given rate), I: idle." % len(A_SEEDS), ""]
    rows = []
    for r in sa["top_passing"][:8] + sa["top_failing"][:3]:
        sc = r["scenarios"]
        rows.append([rules_label(r["key"]), pp(sc["pair"]["excess"]),
                     pp(sc["ring3"]["excess"]), pp(sc["ring4"]["excess"]),
                     "%.2f" % r["objective"], "%.1f %%" % sc["honest"]["pair_loss"],
                     strat_label(sc["ring4"]["strategy"]), "; ".join(r["fails"]) or "-"])
    out += ["The best rule sets that meet both constraints, then the best that do not:", "",
            table(["Rule set", "Pair", "Ring of 3", "Ring of 4", "Objective",
                   "Honest pair loses", "Ring of 4 plays (seeds)", "Constraints failed"],
                  rows), "",
            "%d of %d rule sets meet both constraints; the best objective among them is "
            "%.2f points, and %d lie within %.2f points of it." %
            (sa["n_pass"], sa["n"], sa["best"], sa["n_tied"], A_TIE_PP)]
    return "\n".join(out)


def md_stage_c(sc):
    rows = []
    for r in sc["rows"]:
        label = "%d / %d" % tuple(r["key"])
        if list(r["key"]) == sc["pick"]:
            label = "**%s**" % label
        rows.append([label, "%.2f" % r["per_round"], "%.0f %% of %d" % (r["visitors_paid"], r["visitors"]),
                     "%.2f %%" % r["lapsed"], "; ".join(r["fails"]) or "-"])
    return "\n".join([table(["Budget / min. payout (tUSD)", "Payouts per round",
                             "Visitors thanked by 3+ house members who got a payout",
                             "Lapsed carry (of budgets)", "Criteria failed"], rows), "",
                      "Medians over %d seeds (visitors: all seeds pooled); %d of %d pass." %
                      (len(C_SEEDS), sc["n_pass"], len(sc["rows"]))])


def tiers_label(t, budget):
    v = tier_values(t, budget)
    return ("decay %g %%, auto from %d thanks at %s per thanks up to %s, round cap %g %%, "
            "co-sign %s + %s per thanks up to %s" % (
                t["decay_bp"] / 100, t["auto_rep_min"], tusd(v["auto_per_thanks"]),
                tusd(v["auto_max"]), t["auto_share_bp"] / 100, tusd(v["cosign_base"]),
                tusd(v["cosign_per_thanks"]), tusd(v["cosign_max"])))


def tusd(x):
    s = "%.4f" % (x / U)
    s = s.rstrip("0").rstrip(".")
    return s


def md_stage_b(sb, budgets):
    out = []
    for setting in ("testnet", "community"):
        b = sb[setting]
        rows = []
        for h_ in b["history"]:
            m = h_["metrics"]
            rows.append([h_["pass"], ", ".join("`%s`" % g for g in h_["group"]),
                         ", ".join("%s" % h_["tiers"][g] for g in h_["group"]),
                         "%.0f / %.0f / %.0f" % tuple(m["share"]), "%g" % m["newcomer"],
                         "%.1f" % m["score"], "%d of %d" % (h_["n_pass"], h_["n"])])
        m = b["metrics"]
        out += ["**%s.** %s." % ({"testnet": "Testnet demo", "community": "Community"}[setting],
                                tiers_label(b["pick"], budgets[setting])), "",
                table(["Pass", "Group", "Pick (grid units)", "Tier 1 / 2 / 3 (%)",
                       "Newcomer to tier 1 (rounds)", "Score", "Combinations meeting all "
                       "criteria"], rows), "",
                "Final: tiers %.0f / %.0f / %.0f %% in steady state, newcomer in tier 1 after "
                "%g rounds, the round cap binds in %g of %d steady rounds; criteria %s." % (
                    m["share"][0], m["share"][1], m["share"][2], m["newcomer"],
                    m["cap_rounds"], m["steady_rounds"], "met" if m["pass"] else "NOT met"), ""]
    return "\n".join(out).rstrip()


def md_community(summary):
    rows = []
    for sc in S_COMMUNITY:
        r = summary[sc]
        n, l = r["none"], r["launch"]
        has_c = COMMUNITY_SCENARIOS[sc]["ring"] > 0
        has_f = COMMUNITY_SCENARIOS[sc]["free_riders"] > 0
        rows.append([COMMUNITY_SCENARIOS[sc]["title"],
                     "%s -> %s" % (pp(n["coll_excess"]), pp(l["coll_excess"])) if has_c else "-",
                     ", ".join(sorted(set(l["strategies"]))).replace("_", "-") if has_c else "-",
                     "%.0f %%" % l["coll_paid"] if has_c else "-",
                     "%s -> %s" % (pp(n["fr_excess"]), pp(l["fr_excess"])) if has_f else "-",
                     "%.3f -> %.3f" % (n["rho"], l["rho"]),
                     "%+.1f %%" % r["pair_change"],
                     "%g" % l["newcomer_t1"]])
    return "\n".join([table(["Scenario", "Colluders' excess (pp), none -> launch",
                             "Colluders play", "Colluders' payouts the council lets through",
                             "Free riders' excess (pp)", "Tracking (rank correlation)",
                             "Honest pair's payout", "Newcomer to tier 1 (rounds)"], rows), "",
                      "Medians over %d seeds, 52 weekly rounds, community launch values; "
                      "\"none\" is cap 50 with every dampening rule off and the same tier "
                      "limits. Colluders play their best response under each rule set. The "
                      "council column applies the house council's rule (reject tier-2 payouts "
                      "that come mostly from one reciprocal partner, tier-3 payouts with fewer "
                      "than three givers)." % len(S_SEEDS)])


def md_testnet(rows):
    out = []
    for r in rows:
        out.append([r["label"], "%.2f" % r["per_round"], "%.0f / %.0f / %.0f" % tuple(r["share"]),
                    "%g" % r["newcomer"] if r["newcomer"] < 99 else "-",
                    pp(r["pair_excess"]), "%.0f %%" % r["pair_rejected"],
                    "%.1f %%" % r["free_rider_share"], "%.1f %%" % r["guest_share"],
                    "%.2f" % r["farm_per_round"] if r["farm_per_round"] else "-",
                    "%.2f" % r["hugo_per_round"]])
    return "\n".join([table(["Variant", "Payouts per round", "Tier 1 / 2 / 3 (%)",
                             "Newcomer to tier 1", "Pair's excess (pp)",
                             "Pair's tier-2/3 payouts rejected", "Free rider's share",
                             "Guests' share", "Farm's take per round (tUSD)",
                             "Free rider's take per round (tUSD)"], out), "",
                      "Medians over %d seeds, 144 rounds of 20 minutes, testnet launch values. "
                      "Tier shares count payouts in rounds 49-144." % len(S_SEEDS)])


def md_params(doc):
    cc = doc["community"]["config"]
    tc = doc["testnet"]["config"]
    rows = []
    for f in CONFIG_FIELDS:
        if f in ("dao", "token", "genesis_ms", "members_role", "council_role", "thanks_role"):
            continue

        def fmt(v):
            if f in U128_FIELDS:
                return tusd(int(v)) + " tUSD"
            if isinstance(v, bool):
                return "on" if v else "off"
            return "{:,}".format(v) if isinstance(v, int) else str(v)
        rows.append(["`%s`" % f, fmt(cc[f]), fmt(tc[f])])
    return table(["Field", "Community (weekly)", "Testnet demo (20 minutes)"], rows)


def inject(blocks):
    with open(DOC_FILE) as fh:
        doc = fh.read()
    for name, text in blocks.items():
        b = "<!-- BEGIN generated:%s -->" % name
        e = "<!-- END generated:%s -->" % name
        if b not in doc:
            continue
        i, j = doc.index(b) + len(b), doc.index(e)
        doc = doc[:i] + "\n" + text + "\n" + doc[j:]
    with open(DOC_FILE, "w") as fh:
        fh.write(doc)


# ---------------------------------------------------------------------------
# Scenarios, charts and blocks with the launch values
# ---------------------------------------------------------------------------

def scenarios(pick, summary, workers, log=print):
    cfg_c, cfg_t = launch_configs(pick)
    rules = pick["rules"]
    log("community scenarios")
    comm = run_community(rules, pick["tiers_community"], workers)
    log("testnet variants")
    cfg_t_none = dict(cfg_t, guest_receive_cap_bp=BP, **RULES_OFF)
    tn = run_testnet(cfg_t, cfg_t_none, workers)
    # charts
    sa = summary["stage_a"]
    by_key = {tuple(r["key"]): r for r in sa["compare"] + sa["top_passing"] + sa["top_failing"]
              + [sa["pick"], sa["base"]]}
    pk = tuple(sa["pick"]["key"])
    cap = pk[0]
    chart_rows = [("No dampening (cap 50)", rule_key(RULES_OFF), None),
                  ("Cap %d only" % cap, (cap, BP, False, 0, BP, BP), None)]
    if pk[1] < BP:
        chart_rows.append(("Cap %d + reciprocity %g %%" % (cap, pk[1] / 100),
                           (cap, pk[1], False, 0, BP, BP), None))
    if pk[3] > 0:
        chart_rows.append(("Cap %d + breadth %d at %g %%" % (cap, pk[3], pk[4] / 100),
                           (cap, BP, False, pk[3], pk[4], BP), None))
    chart_rows.append(("Cap %d + quadratic" % cap, (cap, BP, True, 0, BP, BP),
                       "fails: honest pair loses too much"))
    chart_rows.append(("Cap %d + idle 50 %%" % cap, (cap, BP, False, 0, BP, 5000), None))
    chart_rows.append(("Launch: " + rules_label(pk), pk, None))
    rows = []
    for label, k, note in chart_rows:
        r = by_key.get(tuple(k))
        if r is None:
            continue
        if note is None and r["fails"]:
            note = "fails: " + "; ".join(r["fails"])
        rows.append({"label": label, "note": note, "bold": tuple(k) == pk,
                     "values": {s: r["scenarios"][s]["excess"] for s in A_COLLUSION}})
    chart_excess(rows, "excess.svg")
    panels = []
    for title, rl in (("No dampening (cap 50)", RULES_OFF), ("Launch rules: " + rules_label(pk), rules)):
        cfg = community_config(rl, pick["tiers_community"])
        best = None
        for st in ("mutual", "one_way"):
            pop, script = community_script("mixed", 1, rl["cap_per_receiver"], st)
            res = play(cfg, script)
            coll = sum(res["acc"].get(m.name, new_acc())["planned"] for m in pop
                       if m.kind == "colluder")
            if best is None or coll > best[0]:
                best = (coll, pop, res)
        _, pop, res = best
        tp = sum(a["planned"] for a in res["acc"].values())
        tw = sum(a["work"] for a in res["acc"].values())
        dots = []
        for m in pop:
            a = res["acc"].get(m.name, new_acc())
            k = {"colluder": "colluder", "free_rider": "free_rider"}.get(m.kind, "honest")
            dots.append((m.name, 100 * a["work"] / tw, 100 * a["planned"] / tp, k))
        panels.append({"title": title, "dots": dots})
    chart_tracking(panels, "tracking.svg")
    house, script = house_script(1, cfg_t)
    res = play(cfg_t, script, keep=True)
    chart_tiers([rec["tiers"][1:] for rec in res["rounds"]], HOUSE_NEWCOMER_JOIN, "tiers.svg",
                "144 rounds of 20 minutes")
    series = []
    for m in house:
        vals = [rec["rep"].get(m.name) / MILLI if m.join <= rec["round"] and rec["rep"].get(m.name) is not None
                else (0.0 if m.join <= rec["round"] else None) for rec in res["rounds"]]
        cls = {"pair": "l2", "free_rider": "l3"}.get(m.kind, "lc")
        if m.name == HOUSE_NEWCOMER[0]:
            cls = "l1"
        label = {"pair": "%s (pair)" % m.name, "free_rider": "%s (free rider)" % m.name}.get(
            m.kind, m.name if cls == "l1" else m.name)
        if m.name == HOUSE_NEWCOMER[0]:
            label = "%s (newcomer)" % m.name
        series.append((cls, label, vals))
    chart_reputation(series, len(res["rounds"]), cfg_t["auto_rep_min"], "reputation.svg")
    doc = params_document(pick)
    blocks = {
        "stage_a": md_stage_a(sa),
        "stage_c": md_stage_c(summary["stage_c"]),
        "stage_b": md_stage_b(summary["stage_b"], {"testnet": cfg_t["round_budget"],
                                                   "community": cfg_c["round_budget"]}),
        "community": md_community(comm),
        "testnet": md_testnet(tn),
        "params": md_params(doc),
    }
    inject(blocks)
    return comm, tn


# ---------------------------------------------------------------------------
# Command line
# ---------------------------------------------------------------------------

def outputs(pick):
    """Every generated file that --check compares: golden vectors and the replay."""
    files = {os.path.join(GOLDEN_DIR, n + ".json"): dumps(d)
             for n, d in golden_docs(pick).items()}
    files[REPLAY_FILE] = dumps(replay_document(pick))
    return files


def write_outputs(pick):
    for path, text in outputs(pick).items():
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as fh:
            fh.write(text)


def check(rerun_sweep, workers):
    selftest()
    pick = load_pick()
    bad = []
    for path, text in outputs(pick).items():
        try:
            with open(path) as fh:
                have = fh.read()
        except FileNotFoundError:
            have = None
        if have != text:
            bad.append(os.path.relpath(path, ROOT))
    if rerun_sweep:
        new_pick, summary = sweep(workers, log=lambda *a: None)
        if params_document(new_pick) != params_document(pick):
            bad.append("sim/params.json (the sweep picks other values)")
        with open(SWEEP_FILE) as fh:
            if json.load(fh) != json.loads(dumps(summary)):
                bad.append("sim/sweep.json")
    if bad:
        print("differs from the model: " + ", ".join(bad))
        return 1
    print("ok: golden vectors, replay and params.json match the model" +
          (" and the sweep" if rerun_sweep else ""))
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description=NAME + " simulation")
    ap.add_argument("command", nargs="?", default="all",
                    choices=["all", "sweep", "scenarios", "golden"])
    ap.add_argument("--check", action="store_true",
                    help="recompute the golden vectors, the replay and params.json and "
                         "compare them with the files")
    ap.add_argument("--sweep", action="store_true", help="with --check: rerun the sweep too")
    ap.add_argument("--write-params", action="store_true",
                    help="with sweep: write sim/params.json and sim/sweep.json")
    ap.add_argument("--workers", type=int, default=max(1, min(4, os.cpu_count() or 1)))
    args = ap.parse_args(argv)
    sys.dont_write_bytecode = True
    if args.check:
        return check(args.sweep, args.workers)
    if args.command in ("all", "sweep"):
        pick, summary = sweep(args.workers)
        if args.command == "all" or args.write_params:
            write_json(PARAMS_FILE, params_document(pick))
            write_json(SWEEP_FILE, summary)
        if args.command == "sweep":
            return 0
    pick = load_pick()
    with open(SWEEP_FILE) as fh:
        summary = json.load(fh)
    if args.command in ("all", "scenarios"):
        scenarios(pick, summary, args.workers)
    write_outputs(pick)
    return 0


if __name__ == "__main__":
    sys.exit(main())
