#!/usr/bin/env bash
# Read-only checks of a Hat Tip deployment on NEAR testnet, each printed as PASS or FAIL.
#
#   scripts/judge-checks.sh [--section final|staging] [--rpc <url>]
#
# The accounts come from deploy/testnet.json (the `final` section by default). Needs bash, curl and
# python3 (python3 only decodes the RPC's JSON). Sends no transaction: every call is a `query` (a view
# or an account read) on the public NEAR testnet RPC. Exit code: the number of checks that failed.
# On the staging deployment the contract and the token keep their keys on purpose; checks 1 and 2
# are then reported as INFO and not counted.

set -u

RPC=${RPC:-https://test.rpc.fastnear.com}
SECTION=final
while [ $# -gt 0 ]; do
  case "$1" in
    --rpc) RPC=$2; shift 2 ;;
    --section) SECTION=$2; shift 2 ;;
    *) echo "usage: $0 [--section final|staging] [--rpc <url>]" >&2; exit 64 ;;
  esac
done
ROOT=$(cd "$(dirname "$0")/.." && pwd)
field() { # $1: python expression on `s`, the section of deploy/testnet.json
  python3 -I -c '
import json, sys
s = json.load(open(sys.argv[1] + "/deploy/testnet.json", encoding="utf-8")).get(sys.argv[2])
if not s:
    sys.exit("deploy/testnet.json has no section %s" % sys.argv[2])
print(eval(sys.argv[3]))' "$ROOT" "$SECTION" "$1"
}
CONTRACT=$(field 's["contract"]') || exit 64
TOKEN=$(field 's["token"]') || exit 64
DAO=$(field 's["dao"]') || exit 64
GAS_ACCOUNT=$(field 's["gas"]["account"]') || exit 64
EMPTY_ARGS=e30= # base64 of {}
b64() { printf '%s' "$1" | base64 | tr -d '\n'; }

FAILED=0
TOTAL=0
FALLBACK_RPC=${FALLBACK_RPC:-https://near-testnet.drpc.org}
query() { # $1: JSON params of a `query` call
  # --fail: a rate-limited or failed attempt prints nothing, so a retry cannot append a second body.
  # FastNEAR's free tier answers 429 after a few quick calls; then the fallback endpoint answers.
  local out url
  for url in "$RPC" "$FALLBACK_RPC" "$RPC"; do
    out=$(curl -s --fail --max-time 20 --retry 2 --retry-delay 2 "$url" -H 'Content-Type: application/json' \
      -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":$1}")
    # an answer with a result (a contract panic is a result too); RPC errors such as rate limits are retried
    if printf '%s' "$out" | grep -q '"result"'; then printf '%s' "$out"; return; fi
    sleep 1
  done
}
view() { # $1: account, $2: method, $3: base64 of the JSON args
  query "{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$1\",\"method_name\":\"$2\",\"args_base64\":\"$3\"}"
}
# Reads the RPC answer on stdin and runs the python code in $1 with `r` the result object, `v` a
# view's decoded JSON, ROOT the repository root and the accounts as CONTRACT, TOKEN, DAO, GAS; the
# code sets `out`, which is printed. Any error prints "error: ...".
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
        raise ValueError("no answer from the RPC")
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
' "$1" "$ROOT" "$CONTRACT" "$TOKEN" "$DAO" "$GAS_ACCOUNT"
}
report() { # $1: name, $2: what was seen, $3: what passes
  TOTAL=$((TOTAL + 1))
  if [ "$2" = "$3" ]; then
    printf 'PASS  %s\n' "$1"
  else
    printf 'FAIL  %s\n      expected: %s\n      got:      %s\n' "$1" "$3" "$2"
    FAILED=$((FAILED + 1))
  fi
}
info() { printf 'INFO  %s: %s\n' "$1" "$2"; }

echo "Hat Tip ($SECTION): read-only checks of $CONTRACT, $TOKEN and $DAO against $RPC"

# 1, 2. The contract and the token have no access keys: nobody can redeploy them, change a rule or
#       act as them.
for acc in "$CONTRACT" "$TOKEN"; do
  n=$([ "$acc" = "$CONTRACT" ] && echo 1 || echo 2)
  got=$(query "{\"request_type\":\"view_access_key_list\",\"finality\":\"final\",\"account_id\":\"$acc\"}" \
    | check 'out = "%d access keys" % len(r["keys"])')
  if [ "$SECTION" = staging ]; then info "$n. $acc access keys (staging keeps them)" "$got"
  else report "$n. $acc has no access keys" "$got" "0 access keys"; fi
done

# 3, 4. The deployed code is the wasm this repository records (base58 code hash = WASM_SHA256).
for pair in "contract:$CONTRACT" "token:$TOKEN"; do
  dir=${pair%%:*}; acc=${pair#*:}
  want=$(tr -d '[:space:]' <"$ROOT/$dir/WASM_SHA256")
  got=$(query "{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$acc\"}" | check 'out = hexhash(r["code_hash"])')
  report "$([ "$dir" = contract ] && echo 3 || echo 4). code hash of $acc = $dir/WASM_SHA256" "$got" "$want"
done

# 5. The DAO policy states the three tiers exactly: role `thanks` is the contract alone with exactly
#    transfer:AddProposal, transfer:VoteApprove, call:AddProposal, transfer:Finalize, call:Finalize
#    and `transfer` 1 of 1 (tier 1); the council approves a `call` with one vote (tier 2); everything
#    else needs the default council majority, 1/2 (tier 3).
POLICY=$(view "$DAO" get_policy "$EMPTY_ARGS")
got=$(printf '%s' "$POLICY" | check '
roles = {x["name"]: x for x in v["roles"]}
t, c = roles.get("thanks"), roles.get("council")
problems = []
if not t or t["kind"] != {"Group": [CONTRACT]}: problems.append("role thanks is not the contract alone")
elif sorted(t["permissions"]) != sorted(["transfer:AddProposal", "transfer:VoteApprove", "call:AddProposal", "transfer:Finalize", "call:Finalize"]): problems.append("role thanks permissions %s" % t["permissions"])
elif t["vote_policy"] != {"transfer": {"weight_kind": "RoleWeight", "quorum": "0", "threshold": [1, 1]}}: problems.append("role thanks vote policy %s" % t["vote_policy"])
if not c: problems.append("no council role")
elif c["vote_policy"] != {"call": {"weight_kind": "RoleWeight", "quorum": "0", "threshold": "1"}}: problems.append("council vote policy %s" % c["vote_policy"])
if v["default_vote_policy"] != {"weight_kind": "RoleWeight", "quorum": "0", "threshold": [1, 2]}: problems.append("default vote policy %s" % v["default_vote_policy"])
out = "; ".join(problems) or "tier 1 thanks transfer 1/1, tier 2 council call 1 vote, tier 3 council 1/2"')
report "5. DAO policy: the three tiers exactly" "$got" "tier 1 thanks transfer 1/1, tier 2 council call 1 vote, tier 3 council 1/2"

# 6, 7. Nobody else can file: there is no Everyone role, and only role `thanks` may add a `call`
#       proposal (no other role holds call:AddProposal or a wildcard covering it).
got=$(printf '%s' "$POLICY" | check '
out = "no Everyone role" if all(x["kind"] != "Everyone" for x in v["roles"]) else "an Everyone role exists"')
report "6. DAO policy: no Everyone role" "$got" "no Everyone role"
got=$(printf '%s' "$POLICY" | check '
cover = {"call:AddProposal", "call:*", "*:AddProposal", "*:*"}
who = sorted(x["name"] for x in v["roles"] if cover & set(x["permissions"]))
out = "call:AddProposal only in %s" % ",".join(who)')
report "7. DAO policy: call:AddProposal only in role thanks" "$got" "call:AddProposal only in thanks"

# 8. The factory cannot upgrade the DAO's code: get_factory_info().auto_update is false.
got=$(view "$DAO" get_factory_info "$EMPTY_ARGS" | check 'out = "auto_update %s" % str(v["auto_update"]).lower()')
report "8. DAO factory auto-update off" "$got" "auto_update false"

# 9. audit(): budgets add up, points equal their attributions, statuses and carries add up.
got=$(view "$CONTRACT" audit "$EMPTY_ARGS" | check '
flags = ["balanced", "points_attributed", "statuses_ok", "filed_have_ids", "carry_ok"]
bad = [f for f in flags if not v[f]]
out = ("false: " + ",".join(bad)) if bad else "all true (%d payouts)" % v["payouts"]
if not bad: out = "all true"')
report "9. audit(): balanced, attributed, statuses, ids, carry" "$got" "all true"

# 10. The rounds are being closed: the oldest unclosed round is the current one or the one before.
got=$(view "$CONTRACT" state "$EMPTY_ARGS" | check '
lag = v["round"] - v["oldest_unclosed"]
out = "last close less than two rounds old" if lag <= 1 else "%d rounds wait for a close (round %d, oldest unclosed %d)" % (lag, v["round"], v["oldest_unclosed"])')
report "10. the last close is less than two rounds old" "$got" "last close less than two rounds old"

# 11. The contract is bound to this DAO and this token.
got=$(view "$CONTRACT" config "$EMPTY_ARGS" | check 'out = "dao and token match" if v["dao"] == DAO and v["token"] == TOKEN else "config names %s, %s" % (v["dao"], v["token"])')
report "11. config(): dao = $DAO, token = $TOKEN" "$got" "dao and token match"

# 12. A sample of the contract's payouts (the last 20 filed) matches the DAO: each proposal was
#     filed by the contract, its kind is the tier's (Transfer for tiers 1 and 3, FunctionCall
#     ft_transfer for tier 2) with the payout's receiver and amount, and the statuses agree.
STATE=$(view "$CONTRACT" state "$EMPTY_ARGS")
FROM=$(printf '%s' "$STATE" | check 'out = max(v["oldest_payout"], v["next_payout"] - 40)')
ARGS=$(b64 "$(printf '{"from":%s,"limit":40}' "$FROM")")
PAYOUTS=$(view "$CONTRACT" payouts "$ARGS")
IDS=$(printf '%s' "$PAYOUTS" | check 'out = " ".join(str(p["dao_proposal"]) for p in [p for p in v if p["dao_proposal"] is not None][-20:])')
PROPS=""
for id in $IDS; do
  case "$id" in *[!0-9]*) break ;; esac
  ARGS=$(b64 "$(printf '{"from_index":%s,"limit":1}' "$id")")
  PROPS="$PROPS$(view "$DAO" get_proposals "$ARGS" | check 'out = json.dumps(v[0] if v else None)')
"
done
got=$(printf '%s' "$PAYOUTS" | python3 -I -c '
import base64, json, sys
CONTRACT, TOKEN, props_raw = sys.argv[1:4]
try:
    v = json.loads(bytes(json.load(sys.stdin)["result"]["result"]).decode())
    props = [json.loads(l) for l in props_raw.splitlines() if l.strip()]
    by_id = {p["id"]: p for p in props if p}
    filed = [p for p in v if p["dao_proposal"] is not None][-20:]
    want = {"paid": {"Approved"}, "approved": {"Approved"}, "filed": {"InProgress", "Approved", "Rejected", "Expired", "Failed", None},
            "rejected": {"Rejected"}, "removed": {None, "Removed"}, "expired": {"Expired"}, "failed": {"Failed", "Moved"}}
    bad = []
    for p in filed:
        q = by_id.get(p["dao_proposal"])
        st = q["status"] if q else None
        if st not in want[p["status"]]:
            bad.append("payout %d is %s, DAO #%d is %s" % (p["id"], p["status"], p["dao_proposal"], st))
            continue
        if not q:
            continue
        if q["proposer"] != CONTRACT:
            bad.append("DAO #%d proposer %s" % (q["id"], q["proposer"]))
            continue
        k = q["kind"]
        if p["tier"] in (1, 3):
            t = {kk: vv for kk, vv in (k.get("Transfer") or {}).items() if kk != "msg"}
            ok = t == {"token_id": TOKEN, "receiver_id": p["receiver"], "amount": p["amount"]}
        else:
            fc = k.get("FunctionCall") or {}
            acts = fc.get("actions") or []
            args = json.loads(base64.b64decode(acts[0]["args"])) if len(acts) == 1 else {}
            ok = fc.get("receiver_id") == TOKEN and len(acts) == 1 and acts[0].get("method_name") == "ft_transfer" and \
                acts[0].get("deposit") == "1" and args.get("receiver_id") == p["receiver"] and args.get("amount") == p["amount"]
        if not ok:
            bad.append("DAO #%d kind does not match payout %d (tier %d)" % (q["id"], p["id"], p["tier"]))
    if not filed:
        print("no filed payouts yet")
    elif bad:
        print("%d of %d differ: %s" % (len(bad), len(filed), "; ".join(bad[:3])))
    else:
        print("all match")
except Exception as e:
    print("error: %s" % (e,))
' "$CONTRACT" "$TOKEN" "$PROPS")
report "12. the last filed payouts match their DAO proposals (proposer, kind, receiver, amount, status)" "$got" "all match"

# 13. The public relay keys can only call act, close_round, pay, check_payout and sync on a Hat Tip
#     contract; the gas account's one full-access key is not in the repository.
got=$(query "{\"request_type\":\"view_access_key_list\",\"finality\":\"final\",\"account_id\":\"$GAS_ACCOUNT\"}" | check '
def kind(p):
    if p == "FullAccess":
        return "full access"
    f = p["FunctionCall"]
    return f["receiver_id"] + " " + ",".join(sorted(f["method_names"]))
kinds = collections.Counter(kind(k["access_key"]["permission"]) for k in r["keys"])
relay = kinds.pop(CONTRACT + " act,check_payout,close_round,pay,sync", 0)
other = {k: n for k, n in kinds.items() if k != "full access" and not k.endswith(" act,check_payout,close_round,pay,sync")}
full = kinds.get("full access", 0)
out = ("unexpected keys: %s" % other) if other else "%s relay keys for the contract (relay methods only), %d full access" % ("some" if relay else "no", full)')
report "13. relay keys only call act, close_round, pay, check_payout, sync" "$got" "some relay keys for the contract (relay methods only), 1 full access"

if [ "$FAILED" -eq 0 ]; then echo "All $TOTAL checks passed."; else echo "$FAILED of $TOTAL checks failed."; fi
exit "$FAILED"
