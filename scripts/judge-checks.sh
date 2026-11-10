#!/usr/bin/env bash
# Read-only checks of a Hat Tip deployment on NEAR testnet, each printed as PASS or FAIL.
#
#   scripts/judge-checks.sh [--section final|staging] [--rpc <url>]
#
# The accounts come from deploy/testnet.json, section `final` (the launched, keyless deployment) by
# default. Needs bash, curl and python3 (python3 only decodes the RPC's JSON); macOS or Linux. Sends no
# transaction and holds no key: every call is a read (`block`, then `query` for a view, an account,
# its code hash or its keys) on the public NEAR testnet RPC, all at the same final block.
#
# Exit code: the number of checks that failed (0 when all pass); 64 bad usage; 65 the section is not
# in deploy/testnet.json (before the launch the `final` section is empty: "not launched yet").
# On the staging deployment the contract and the token keep their keys on purpose; checks 1 and 2
# are then reported as INFO and not counted.
#
# RPC: FastNEAR's free endpoint answers HTTP 429 after a few quick calls, and dRPC's free plan
# sometimes times out. Every read is tried up to five times, alternating the two endpoints with
# growing pauses, and reads are spaced by $PAUSE seconds. curl runs with --fail and without its own
# --retry, so an error page is never taken for an answer and two answers are never concatenated. A
# read that gets no answer makes its check FAIL with the reason; it can never pass.

set -u

RPC=${RPC:-https://test.rpc.fastnear.com}
FALLBACK_RPC=${FALLBACK_RPC:-https://near-testnet.drpc.org}
PAUSE=${PAUSE:-0.3}
SECTION=final
while [ $# -gt 0 ]; do
  case "$1" in
    --rpc) RPC=${2:?--rpc needs a URL}; shift 2 ;;
    --section) SECTION=${2:?--section needs final or staging}; shift 2 ;;
    *) echo "usage: $0 [--section final|staging] [--rpc <url>]" >&2; exit 64 ;;
  esac
done
ROOT=$(cd "$(dirname "$0")/.." && pwd)

# The section's accounts, one per line: contract, token, DAO, gas account, DAO factory.
ACCOUNTS=$(python3 -I - "$ROOT/deploy/testnet.json" "$SECTION" <<'PY'
import json, sys
s = json.load(open(sys.argv[1], encoding="utf-8")).get(sys.argv[2])
if not s:
    sys.exit(3)
print("\n".join([s["contract"], s["token"], s["dao"], (s.get("gas") or {}).get("account", "-"),
                 s.get("factory", "sputnikv2.testnet")]))
PY
)
case $? in
  0) ;;
  3)
    if [ "$SECTION" = final ]; then
      echo "Hat Tip: not launched yet. deploy/testnet.json has no final deployment; the launch fills it in."
      echo "The staging deployment can be checked now: scripts/judge-checks.sh --section staging"
    else
      echo "deploy/testnet.json has no section \"$SECTION\""
    fi
    exit 65 ;;
  *) echo "cannot read the section \"$SECTION\" of deploy/testnet.json" >&2; exit 65 ;;
esac
{ read -r CONTRACT; read -r TOKEN; read -r DAO; read -r GAS_ACCOUNT; read -r FACTORY; } <<<"$ACCOUNTS"
EMPTY_ARGS=e30= # base64 of {}
b64() { printf '%s' "$1" | base64 | tr -d '\n'; }

CALLS=0
# rpc METHOD PARAMS: prints the first answer that has a "result"; if none comes, the last error
# answer (an RPC error, which check() reports) or nothing (which check() reports as "no answer").
rpc() {
  local body="{\"jsonrpc\":\"2.0\",\"id\":\"judge\",\"method\":\"$1\",\"params\":$2}"
  local url out last="" pause=1
  if [ "$CALLS" -gt 0 ]; then sleep "$PAUSE"; fi
  CALLS=$((CALLS + 1))
  for url in "$RPC" "$FALLBACK_RPC" "$RPC" "$FALLBACK_RPC" "$RPC"; do
    if out=$(curl -s --fail --max-time 20 -H 'Content-Type: application/json' -d "$body" "$url"); then
      case "$out" in *'"result"'*) printf '%s' "$out"; return 0 ;; esac
      [ -n "$out" ] && last=$out
      # answers a retry cannot change
      case "$out" in *UNKNOWN_ACCOUNT*|*NO_CONTRACT_CODE*|*CONTRACT_EXECUTION_ERROR*|*MethodNotFound*) break ;; esac
    fi
    sleep "$pause"
    pause=$((pause + 1))
  done
  printf '%s' "$last"
}

# Every read at one final block, so that the contract, the DAO and the token are seen at the same
# moment. If no block height comes back, each read takes the final block of its own moment.
BLOCK=$(rpc block '{"finality":"final"}' | python3 -I -c '
import json, sys
print(json.load(sys.stdin)["result"]["header"]["height"])' 2>/dev/null)
case "$BLOCK" in
  "" | *[!0-9]*) AT='"finality":"final"'; WHERE="the final block of each read (no block height came back)" ;;
  *) AT="\"block_id\":$BLOCK"; WHERE="block $BLOCK" ;;
esac
query() { rpc query "{\"request_type\":\"$1\",$AT,\"account_id\":\"$2\"}"; }  # $1: request type, $2: account
view() { # $1: account, $2: method, $3: base64 of the JSON args
  rpc query "{\"request_type\":\"call_function\",$AT,\"account_id\":\"$1\",\"method_name\":\"$2\",\"args_base64\":\"$3\"}"
}

# Reads an RPC answer on stdin and runs the python code in $1 with `r` the result object, `v` a
# view's decoded JSON, ROOT the repository root, the accounts as CONTRACT, TOKEN, DAO, GAS and any
# further arguments of check() in sys.argv[7:]; the code sets `out`, which is printed. A missing answer, an RPC error or any exception prints
# "error: ...", which never equals what a check expects.
check() {
  python3 -I -c '
import base64, json, sys, collections
ROOT, CONTRACT, TOKEN, DAO, GAS = sys.argv[2:7]
B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
def hexhash(b58):
    n = 0
    for c in b58:
        n = n * 58 + B58.index(c)
    return n.to_bytes(32, "big").hex()
try:
    raw = sys.stdin.read()
    if not raw.strip():
        raise ValueError("no answer from the RPC (both endpoints, five tries)")
    ans = json.loads(raw)
    if "result" not in ans:
        raise ValueError("RPC error: %s" % json.dumps(ans.get("error"))[:200])
    r = ans["result"]
    if "error" in r:
        raise ValueError("RPC error: %s" % r["error"][:200])
    v = json.loads(bytes(r["result"]).decode()) if "result" in r else None
    out = None
    exec(sys.argv[1])
    print(out)
except Exception as e:
    print("error: %s" % (e,))
' "$1" "$ROOT" "$CONTRACT" "$TOKEN" "$DAO" "$GAS_ACCOUNT" "${@:2}"
}

FAILED=0
TOTAL=0
report() { # $1: name, $2: what was seen, $3: what passes (the seen text may add " (details)")
  TOTAL=$((TOTAL + 1))
  case "$2" in
    "$3" | "$3 ("*) printf 'PASS  %s%s\n' "$1" "${2#"$3"}" ;;
    *)
      printf 'FAIL  %s\n      expected: %s\n      got:      %s\n' "$1" "$3" "$2"
      FAILED=$((FAILED + 1)) ;;
  esac
}
info() { printf 'INFO  %s: %s\n' "$1" "$2"; }

echo "Hat Tip ($SECTION): read-only checks of $CONTRACT, $TOKEN and $DAO at $WHERE"
echo "RPC: $RPC, fallback $FALLBACK_RPC"

# 1, 2. The contract and the token have no access keys: nobody can redeploy them, change a rule or
#       act as them.
for acc in "$CONTRACT" "$TOKEN"; do
  n=$([ "$acc" = "$CONTRACT" ] && echo 1 || echo 2)
  got=$(query view_access_key_list "$acc" | check 'out = "%d access keys" % len(r["keys"])')
  if [ "$SECTION" = staging ]; then info "$n. $acc access keys (staging keeps them)" "$got"
  else report "$n. $acc has no access keys" "$got" "0 access keys"; fi
done

# 3, 4. The deployed code is the wasm this repository records (base58 code hash = WASM_SHA256). That
#       WASM_SHA256 is the build of this source is shown by a rebuild (build.sh --check, CI).
for pair in "contract:$CONTRACT" "token:$TOKEN"; do
  dir=${pair%%:*}; acc=${pair#*:}
  want=$(tr -d '[:space:]' <"$ROOT/$dir/WASM_SHA256")
  got=$(query view_account "$acc" | check 'out = hexhash(r["code_hash"])')
  report "$([ "$dir" = contract ] && echo 3 || echo 4). code hash of $acc = $dir/WASM_SHA256" "$got" "$want"
done

# 5. The DAO policy states the three tiers and the bounties exactly: role `thanks` is the contract
#    alone with exactly transfer:AddProposal, transfer:VoteApprove, call:AddProposal,
#    transfer:Finalize, call:Finalize and `transfer` 1 of 1 (tier 1); the council approves a `call`
#    (tier 2) and a `bounty_done` (finished bounty work) with one vote; everything else, an
#    `add_bounty` (posting a bounty) too, needs the default council majority, 1/2 (tier 3).
POLICY=$(view "$DAO" get_policy "$EMPTY_ARGS")
got=$(printf '%s' "$POLICY" | check '
roles = {x["name"]: x for x in v["roles"]}
t, c = roles.get("thanks"), roles.get("council")
one = {"weight_kind": "RoleWeight", "quorum": "0", "threshold": "1"}
problems = []
if not t or t["kind"] != {"Group": [CONTRACT]}: problems.append("role thanks is not the contract alone")
elif sorted(t["permissions"]) != sorted(["transfer:AddProposal", "transfer:VoteApprove", "call:AddProposal", "transfer:Finalize", "call:Finalize"]): problems.append("role thanks permissions %s" % t["permissions"])
elif t["vote_policy"] != {"transfer": {"weight_kind": "RoleWeight", "quorum": "0", "threshold": [1, 1]}}: problems.append("role thanks vote policy %s" % t["vote_policy"])
if not c: problems.append("no council role")
elif c["vote_policy"] != {"call": one, "bounty_done": one}: problems.append("council vote policy %s" % c["vote_policy"])
if v["default_vote_policy"] != {"weight_kind": "RoleWeight", "quorum": "0", "threshold": [1, 2]}: problems.append("default vote policy %s" % v["default_vote_policy"])
out = "; ".join(problems) or "tier 1 thanks transfer 1/1, tier 2 council call 1 vote, tier 3 council 1/2, bounty work 1 vote"
if not problems: out += " (council of %d)" % len(c["kind"].get("Group", []))')
report "5. DAO policy: the three tiers and the bounty vote exactly" "$got" "tier 1 thanks transfer 1/1, tier 2 council call 1 vote, tier 3 council 1/2, bounty work 1 vote"

# 6, 7. Nobody else can file: there is no Everyone role; only role `thanks` may add a `call`
#       proposal (no other role holds call:AddProposal or a wildcard covering it); role `members`
#       may file exactly two kinds, a bounty (add_bounty) and its finished work (bounty_done), and
#       vote on nothing; the council may file what the demo policy lists and add_bounty.
got=$(printf '%s' "$POLICY" | check '
out = "no Everyone role" if all(x["kind"] != "Everyone" for x in v["roles"]) else "an Everyone role exists"')
report "6. DAO policy: no Everyone role" "$got" "no Everyone role"
got=$(printf '%s' "$POLICY" | check '
cover = {"call:AddProposal", "call:*", "*:AddProposal", "*:*"}
who = sorted(x["name"] for x in v["roles"] if cover & set(x["permissions"]))
roles = {x["name"]: x for x in v["roles"]}
m, c = roles.get("members") or {}, roles.get("council") or {}
council = {"transfer:AddProposal", "config:AddProposal", "policy:AddProposal", "policy_add_or_update_role:AddProposal",
    "policy_remove_role:AddProposal", "policy_update_default_vote_policy:AddProposal", "policy_update_parameters:AddProposal",
    "add_member_to_role:AddProposal", "remove_member_from_role:AddProposal", "factory_info_update:AddProposal",
    "vote:AddProposal", "add_bounty:AddProposal", "*:VoteApprove", "*:VoteReject", "*:VoteRemove", "*:Finalize"}
out = "call:AddProposal only in %s" % (",".join(who) or "no role")
if sorted(m.get("permissions", [])) != ["add_bounty:AddProposal", "bounty_done:AddProposal"] or m.get("vote_policy") != {}:
    out += "; members %s" % m.get("permissions")
else:
    out += "; members file only add_bounty, bounty_done"
if set(c.get("permissions", [])) != council: out += "; council permissions %s" % sorted(set(c.get("permissions", [])) ^ council)')
report "7. DAO policy: call:AddProposal only in role thanks; members file only bounties" "$got" "call:AddProposal only in thanks; members file only add_bounty, bounty_done"

# 8. The factory cannot upgrade the DAO's code: get_factory_info().auto_update is false.
got=$(view "$DAO" get_factory_info "$EMPTY_ARGS" | check 'out = "auto_update %s" % str(v["auto_update"]).lower()')
report "8. DAO factory auto-update off" "$got" "auto_update false"

# 9. audit(): budgets add up, points equal their attributions, statuses, proposal ids and carries add up.
got=$(view "$CONTRACT" audit "$EMPTY_ARGS" | check '
flags = ["balanced", "points_attributed", "statuses_ok", "filed_have_ids", "carry_ok"]
bad = [f for f in flags if v.get(f) is not True]
out = ("false: " + ",".join(bad)) if bad else "all true (%d payouts)" % v["payouts"]')
report "9. audit(): balanced, attributed, statuses, ids, carry" "$got" "all true"

# 10. The rounds are being closed: the oldest unclosed round is the current one or the one before.
STATE=$(view "$CONTRACT" state "$EMPTY_ARGS")
got=$(printf '%s' "$STATE" | check '
lag = v["round"] - v["oldest_unclosed"]
out = ("last close less than two rounds old (round %d)" % v["round"]) if lag <= 1 else \
    "%d rounds wait for a close (round %d, oldest unclosed %d)" % (lag, v["round"], v["oldest_unclosed"])')
report "10. the last close is less than two rounds old" "$got" "last close less than two rounds old"

# 11. The contract is bound to this DAO and this token.
got=$(view "$CONTRACT" config "$EMPTY_ARGS" | check 'out = "dao and token match" if v["dao"] == DAO and v["token"] == TOKEN else "config names %s, %s" % (v["dao"], v["token"])')
report "11. config(): dao = $DAO, token = $TOKEN" "$got" "dao and token match"

# 12. A sample of the DAO's proposals matches the contract's payouts, both ways: the last 40 DAO
#     proposals and the last 100 payouts. Every proposal the contract filed belongs to a payout
#     (or to one whose filing chain is still running), and every payout's proposal was filed by the
#     contract with the tier's kind (Transfer for tiers 1 and 3, FunctionCall ft_transfer for tier
#     2), the payout's receiver and amount, and a DAO status that agrees with the payout's status.
PFROM=$(printf '%s' "$STATE" | check 'out = max(v["oldest_payout"], v["next_payout"] - 100)')
case "$PFROM" in
  "" | *[!0-9]*) PAYOUTS="" ;;
  *) ARGS=$(printf '{"from":%s,"limit":100}' "$PFROM"); PAYOUTS=$(view "$CONTRACT" payouts "$(b64 "$ARGS")") ;;
esac
DFROM=$(view "$DAO" get_last_proposal_id "$EMPTY_ARGS" | check 'out = max(0, v - 40)')
case "$DFROM" in
  "" | *[!0-9]*) PROPOSALS="" ;;
  *) ARGS=$(printf '{"from_index":%s,"limit":40}' "$DFROM"); PROPOSALS=$(view "$DAO" get_proposals "$(b64 "$ARGS")") ;;
esac
got=$(python3 -I - "$CONTRACT" "$TOKEN" "$PAYOUTS" "$PROPOSALS" <<'PY'
import base64, json, sys
CONTRACT, TOKEN = sys.argv[1:3]
def decode(raw, what):
    if not raw.strip():
        raise ValueError("no answer from the RPC for %s" % what)
    ans = json.loads(raw)
    r = ans.get("result")
    if r is None or "error" in r:
        raise ValueError("RPC error for %s: %s" % (what, json.dumps(ans.get("error") or r)[:200]))
    return json.loads(bytes(r["result"]).decode())
try:
    payouts = decode(sys.argv[3], "payouts()")
    props = decode(sys.argv[4], "get_proposals()")
    ours = [q for q in props if q["proposer"] == CONTRACT]
    by_id = {q["id"]: q for q in props}
    by_dao = {p["dao_proposal"]: p for p in payouts if p["dao_proposal"] is not None}
    lo = min(q["id"] for q in props) if props else 0
    hi = max(q["id"] for q in props) if props else -1
    want = {"paid": {"Approved"}, "approved": {"Approved", "Failed"},
            "filed": {"InProgress", "Approved", "Rejected", "Removed", "Expired", "Failed", None},
            "rejected": {"Rejected"}, "removed": {None, "Removed"}, "expired": {"Expired"}, "failed": {"Failed", "Moved"}}
    def amount_receiver(q):
        k = q["kind"]
        if "Transfer" in k:
            t = k["Transfer"]
            return t.get("token_id"), t.get("receiver_id"), t.get("amount")
        fc = k.get("FunctionCall") or {}
        acts = fc.get("actions") or []
        if fc.get("receiver_id") != TOKEN or len(acts) != 1 or acts[0].get("method_name") != "ft_transfer" or acts[0].get("deposit") != "1":
            return None, None, None
        args = json.loads(base64.b64decode(acts[0]["args"]))
        return TOKEN, args.get("receiver_id"), args.get("amount")
    bad, matched, outside = [], 0, 0
    oldest_payout_proposal = min(by_dao) if by_dao else None
    for q in ours:  # DAO -> contract
        if q["id"] in by_dao:
            continue
        if oldest_payout_proposal is None or q["id"] < oldest_payout_proposal:
            outside += 1
            continue
        tok, rec, amt = amount_receiver(q)
        if not any(p["status"] == "filing" and p["receiver"] == rec and p["amount"] == amt for p in payouts):
            bad.append("DAO #%d by the contract has no payout" % q["id"])
    for pid, p in sorted(by_dao.items()):  # contract -> DAO
        if not lo <= pid <= hi:
            continue
        q = by_id.get(pid)
        st = q["status"] if q else None
        if st not in want.get(p["status"], set()):
            bad.append("payout %d is %s, DAO #%d is %s" % (p["id"], p["status"], pid, st))
            continue
        if q is None:
            continue
        if q["proposer"] != CONTRACT:
            bad.append("DAO #%d proposer %s" % (pid, q["proposer"]))
            continue
        kind = "Transfer" if p["tier"] in (1, 3) else "FunctionCall"
        if kind not in q["kind"] or amount_receiver(q) != (TOKEN, p["receiver"], p["amount"]):
            bad.append("DAO #%d kind does not match payout %d (tier %d)" % (pid, p["id"], p["tier"]))
            continue
        matched += 1
    if bad:
        print("%d differ: %s" % (len(bad), "; ".join(bad[:3])))
    elif matched == 0:
        print("no payout with a DAO proposal in the sample yet")
    else:
        print("all match (%d payouts and DAO #%d-#%d, %d by the contract)" % (matched, lo, hi, len(ours)))
except Exception as e:
    print("error: %s" % (e,))
PY
)
report "12. a sample of the DAO's proposals matches payouts() (proposer, kind, receiver, amount, status)" "$got" "all match"

# 13. The public relay keys can only call act, close_round, pay, check_payout and sync on a Hat Tip
#     contract; the gas account's one full-access key is not in the repository.
got=$(query view_access_key_list "$GAS_ACCOUNT" | check '
def kind(p):
    if p == "FullAccess":
        return "full access"
    f = p["FunctionCall"]
    return f["receiver_id"] + " " + ",".join(sorted(f["method_names"]))
kinds = collections.Counter(kind(k["access_key"]["permission"]) for k in r["keys"])
relay = kinds.pop(CONTRACT + " act,check_payout,close_round,pay,sync", 0)
other = {k: n for k, n in kinds.items() if k != "full access" and not k.endswith(" act,check_payout,close_round,pay,sync")}
full = kinds.get("full access", 0)
out = ("unexpected keys: %s" % other) if other else "%s relay keys for the contract (relay methods only), %d full access" % ("some" if relay else "no", full)
if not other and relay: out += " (%d relay keys)" % relay')
report "13. relay keys only call act, close_round, pay, check_payout, sync" "$got" "some relay keys for the contract (relay methods only), 1 full access"

# 14. The DAO runs Sputnik v2 code the factory publishes (not a modified copy): its code hash is one
#     of the factory's get_contracts_metadata() versions.
DAO_HASH=$(query view_account "$DAO" | check 'out = r["code_hash"]')
got=$(view "$FACTORY" get_contracts_metadata "$EMPTY_ARGS" | check '
h = sys.argv[7]
found = [m for c, m in v if c == h]
out = ("code the factory publishes (version %s)" % ".".join(map(str, found[0]["version"]))) if found else "code hash %s is not among the factory versions" % h' "$DAO_HASH")
report "14. the DAO's code is one the factory $FACTORY publishes" "$got" "code the factory publishes"

# 15. Bounties run: the DAO holds bounties in tUSD, at least one is open or being worked on (times
#     left), and a member's finished work (a BountyDone proposal) was approved and paid: Sputnik
#     counts a bounty's `times` down only when its payout succeeded. The BountyDone proposals are
#     the ones deploy/testnet.json records (bounties.proposals.done) and any among the DAO's last
#     100 proposals; each is read live.
BLAST=$(view "$DAO" get_last_bounty_id "$EMPTY_ARGS" | check 'out = v')
case "$BLAST" in
  "" | *[!0-9]*) BOUNTIES="" ;;
  *) ARGS=$(printf '{"from_index":%s,"limit":100}' "$(( BLAST > 100 ? BLAST - 100 : 0 ))"); BOUNTIES=$(view "$DAO" get_bounties "$(b64 "$ARGS")") ;;
esac
DONE_IDS=$(python3 -I - "$ROOT/deploy/testnet.json" "$SECTION" <<'PY'
import json, sys
s = json.load(open(sys.argv[1], encoding="utf-8")).get(sys.argv[2]) or {}
print(" ".join(str(i) for i in ((s.get("bounties") or {}).get("proposals") or {}).get("done", [])[-5:]))
PY
)
RECENT=""
for id in $DONE_IDS; do
  RECENT="$RECENT$(view "$DAO" get_proposals "$(b64 "$(printf '{"from_index":%s,"limit":1}' "$id")")")
"
done
DFROM=$(view "$DAO" get_last_proposal_id "$EMPTY_ARGS" | check 'out = max(0, v - 100)')
case "$DFROM" in
  "" | *[!0-9]*) ;;
  *) RECENT="$RECENT$(view "$DAO" get_proposals "$(b64 "$(printf '{"from_index":%s,"limit":100}' "$DFROM")")")" ;;
esac
# The answers go through files, not argv: 100 proposals exceed Linux's 128 KB limit for one argument.
BFILE=$(mktemp) && RFILE=$(mktemp) || exit 70
printf '%s' "$BOUNTIES" >"$BFILE"
printf '%s' "$RECENT" >"$RFILE"
got=$(python3 -I - "$TOKEN" "$BLAST" "$BFILE" "$RFILE" <<'PY'
import json, sys
TOKEN, last = sys.argv[1], sys.argv[2]
sys.argv[3] = open(sys.argv[3], encoding="utf-8").read()
sys.argv[4] = open(sys.argv[4], encoding="utf-8").read()
def decode(raw, what):
    ans = json.loads(raw)
    r = ans.get("result")
    if r is None or "error" in r:
        raise ValueError("RPC error for %s: %s" % (what, json.dumps(ans.get("error") or r)[:200]))
    return json.loads(bytes(r["result"]).decode())
try:
    if not sys.argv[3].strip() or not sys.argv[4].strip():
        raise ValueError("no answer from the RPC for get_bounties or get_proposals")
    bounties = {b["id"]: b for b in decode(sys.argv[3], "get_bounties()")}
    props = {q["id"]: q for line in sys.argv[4].splitlines() if line.strip() for q in decode(line, "get_proposals()")}
    live = [b for b in bounties.values() if b["times"] > 0 and b["token"] == TOKEN]
    paid = [q for q in sorted(props.values(), key=lambda q: q["id"]) if "BountyDone" in q["kind"] and q["status"] == "Approved"
            and (bounties.get(q["kind"]["BountyDone"]["bounty_id"]) or {}).get("times") == 0]
    done = [b for b in bounties.values() if b["times"] == 0]
    if not bounties:
        print("no bounties in the DAO")
    elif not live:
        print("%s bounties, none open or being worked on" % last)
    elif not paid:
        print("%s bounties, %d open or being worked on, no approved and paid bounty work found" % (last, len(live)))
    else:
        q = paid[-1]
        b = bounties[q["kind"]["BountyDone"]["bounty_id"]]
        print("bounties live (%s posted, %d open or being worked on, %d done and paid; DAO #%d paid bounty #%d, %s tUSD, to %s)" % (
            last, len(live), len(done), q["id"], b["id"], int(b["amount"]) / 1e6, q["kind"]["BountyDone"]["receiver_id"]))
except Exception as e:
    print("error: %s" % (e,))
PY
)
rm -f "$BFILE" "$RFILE"
report "15. bounties: open ones in tUSD, and finished work paid by the DAO" "$got" "bounties live"

if [ "$FAILED" -eq 0 ]; then echo "All $TOTAL checks passed."; else echo "$FAILED of $TOTAL checks failed."; fi
exit "$FAILED"
