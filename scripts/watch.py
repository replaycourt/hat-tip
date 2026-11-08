#!/usr/bin/env python3
"""The hourly watchdog of the live Hat Tip demo (run by .github/workflows/watch.yml).

    python3 scripts/watch.py

Read-only: every call is a view on the public NEAR testnet RPC or a GET on the GitHub API; it needs
python3, bash, curl and node (for scripts/judge-checks.sh and `scripts/house.mjs report`). It checks
  - the read-only checks of scripts/judge-checks.sh against the final deployment,
  - the gas account's spendable balance and the relay keys' allowance, with the days they last,
  - the NEAR the contract has free for storage (guests are refused below 1 NEAR) and the NEAR the
    DAO has free for proposal storage,
  - the balances `scripts/house.mjs report` flags as low (house members, council, keeper),
  - that the House workflow (house members, council and keeper) is running or has just finished.
It prints a table (also into the job summary), one ::error:: line per problem and one ::warning::
line per warning, and exits 1 on any problem. Thresholds come from the environment; the defaults are
the values in watch.yml. Adapted from Bonfire's scripts/watch.py (same author).
"""
import datetime
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FINAL = json.load(open(os.path.join(ROOT, "deploy", "testnet.json")))["final"]
CONTRACT = FINAL["contract"]
GAS_ACCOUNT = FINAL["gas"]["account"] if isinstance(FINAL.get("gas"), dict) and "account" in FINAL["gas"] else "hat-tip-gas.testnet"
DAO = FINAL["dao"]
HOUSE_WORKFLOW = "house.yml"


def setting(name, default):
    return os.environ.get(name) or default


RPCS = [setting("RPC", "https://test.rpc.fastnear.com"), setting("RPC_FALLBACK", "https://near-testnet.drpc.org")]
REPO = setting("GITHUB_REPOSITORY", "replaycourt/hat-tip")
JUDGING_ENDS = setting("JUDGING_ENDS", "2026-11-25")
MIN_GAS_NEAR = float(setting("MIN_GAS_NEAR", "3"))
MIN_ALLOWANCE_NEAR = float(setting("MIN_ALLOWANCE_NEAR", "3"))
BURN_NEAR_PER_DAY = float(setting("BURN_NEAR_PER_DAY", "0.8"))
MIN_CONTRACT_FREE_NEAR = float(setting("MIN_CONTRACT_FREE_NEAR", "1.5"))
WARN_CONTRACT_FREE_NEAR = float(setting("WARN_CONTRACT_FREE_NEAR", "3"))
MIN_DAO_FREE_NEAR = float(setting("MIN_DAO_FREE_NEAR", "2"))
MAX_HOUSE_IDLE_MIN = float(setting("MAX_HOUSE_IDLE_MIN", "60"))

NEAR = 10**24
STORAGE_PER_BYTE = 10**19  # yoctoNEAR the protocol locks per byte of account storage
LOOKBACK_BLOCKS = 120_000  # about 20 hours of testnet blocks: the burn rate is measured over these
NOW = time.time()
rows = []  # (check, "ok" | "warning" | "FAIL", details)


def report(check, ok, details, warning=False):
    """Adds a row: ok, a warning (shown, but the job still passes) or a failure."""
    rows.append((check, ("warning" if warning else "ok") if ok else "FAIL", details))


def http_json(url, body=None, headers=None):
    head = {"User-Agent": "hat-tip-watch", "Content-Type": "application/json"}
    head.update(headers or {})
    data = None if body is None else json.dumps(body).encode()
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data, head), timeout=20) as f:
            return json.load(f)
    except urllib.error.HTTPError as e:
        raise RuntimeError("HTTP %d from %s" % (e.code, url))


def rpc(method, params):
    """Asks the first RPC, then the fallback, with a pause in between (FastNEAR answers 429 to a
    burst); returns the result or raises the last error."""
    err = None
    for attempt in range(4):
        url = RPCS[attempt % len(RPCS)]
        try:
            ans = http_json(url, {"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
            if "error" in ans:
                raise RuntimeError(json.dumps(ans["error"])[:200])
            if isinstance(ans["result"], dict) and "error" in ans["result"]:
                raise RuntimeError(str(ans["result"]["error"])[:200])
            return ans["result"]
        except Exception as e:  # noqa: BLE001 -- any failure moves on to the other host
            err = "%s: %s" % (url, e)
            time.sleep(1 + attempt)
    raise RuntimeError(err)


def query(request_type, account, at=None, **extra):
    params = dict(at or {"finality": "final"}, request_type=request_type, account_id=account, **extra)
    return rpc("query", params)


def free_near(account, at=None):
    a = query("view_account", account, at)
    return (int(a["amount"]) - a["storage_usage"] * STORAGE_PER_BYTE) / NEAR


def judge_checks():
    """Runs scripts/judge-checks.sh (final) and reports each of its checks."""
    run = subprocess.run(["bash", os.path.join(ROOT, "scripts", "judge-checks.sh")], stdout=subprocess.PIPE,
                         stderr=subprocess.STDOUT, universal_newlines=True, timeout=600)
    lines = run.stdout.splitlines()
    seen = 0
    for i, line in enumerate(lines):
        if line.startswith(("PASS  ", "FAIL  ")):
            seen += 1
            ok = line.startswith("PASS")
            got = [x.split("got:", 1)[1].strip() for x in lines[i + 1:i + 3] if "got:" in x]
            want = [x.split("expected:", 1)[1].strip() for x in lines[i + 1:i + 3] if "expected:" in x]
            report("judge check " + line[6:], ok, "as JUDGE.md says" if ok else
                   "expected %s, got %s" % (want[0] if want else "?", got[0] if got else "?"))
    if not seen:
        report("scripts/judge-checks.sh", False, "no result (exit %d): %s" % (run.returncode, run.stdout[-200:]))


def burn_per_day(head, amount_now):
    """NEAR per day the gas account spent over the last ~20 hours, or None when the RPC no longer
    holds that block or the account was topped up in between."""
    for height in range(head["height"] - LOOKBACK_BLOCKS, head["height"] - LOOKBACK_BLOCKS - 3, -1):
        try:  # a height can be skipped: try the next lower one
            old = rpc("block", {"block_id": height})["header"]
            then = int(query("view_account", GAS_ACCOUNT, {"block_id": old["hash"]})["amount"])
        except Exception:  # noqa: BLE001
            continue
        days = (head["timestamp"] - old["timestamp"]) / 86400e9
        spent = (then - amount_now) / NEAR
        return spent / days if spent > 0 and days > 0.1 else None
    return None


def gas():
    head = rpc("block", {"finality": "final"})["header"]
    at = {"block_id": head["hash"]}
    account = query("view_account", GAS_ACCOUNT, at)
    spendable = (int(account["amount"]) - account["storage_usage"] * STORAGE_PER_BYTE) / NEAR
    relay = [k["access_key"]["permission"]["FunctionCall"] for k in query("view_access_key_list", GAS_ACCOUNT, at)["keys"]
             if k["access_key"]["permission"] != "FullAccess"
             and k["access_key"]["permission"]["FunctionCall"]["receiver_id"] == CONTRACT]
    allowance = sum(int(f["allowance"]) for f in relay if f.get("allowance") is not None) / NEAR
    if any(f.get("allowance") is None for f in relay):
        allowance = float("inf")

    burn = burn_per_day(head, int(account["amount"]))
    rate = ("%.2f NEAR/day over the last 20 h" % burn) if burn else ("%.2f NEAR/day assumed" % BURN_NEAR_PER_DAY)
    burn = burn or BURN_NEAR_PER_DAY
    end = datetime.datetime.strptime(JUDGING_ENDS, "%Y-%m-%d").replace(tzinfo=datetime.timezone.utc)
    days_to_end = (end.timestamp() + 86400 - NOW) / 86400  # until the last day of judging is over

    def check(name, near, minimum, what, remedy):
        days = max(near, 0) / burn
        until = datetime.datetime.fromtimestamp(NOW + min(days, 3650) * 86400, datetime.timezone.utc)
        details = "%s %.2f NEAR (min %g), about %.0f days at %s, until %s" % (
            what, near, minimum, days, rate, until.strftime("%Y-%m-%d"))
        if near < minimum:
            details += "; below the minimum: " + remedy
        elif days < days_to_end:
            details += "; runs out before judging ends on %s: %s" % (JUDGING_ENDS, remedy)
        report(name, near >= minimum, details, warning=days < days_to_end)

    check("gas account balance", spendable, MIN_GAS_NEAR, "%s can spend" % GAS_ACCOUNT,
          "send testnet NEAR to " + GAS_ACCOUNT)
    check("relay key allowance", allowance, MIN_ALLOWANCE_NEAR, "%d relay keys for %s have" % (len(relay), CONTRACT),
          "add relay keys with scripts/setup-gas-pool.mjs")


def storage():
    contract = free_near(CONTRACT)
    low = contract < WARN_CONTRACT_FREE_NEAR
    report("contract NEAR for storage", contract >= MIN_CONTRACT_FREE_NEAR,
           "%s has %.2f NEAR free (min %g; guests are refused below 1 NEAR)%s" % (
               CONTRACT, contract, MIN_CONTRACT_FREE_NEAR,
               "; anyone can send it testnet NEAR, the account has no keys" if low else ""), warning=low)
    dao = free_near(DAO)
    report("DAO NEAR for proposals", dao >= MIN_DAO_FREE_NEAR,
           "%s has %.2f NEAR free for proposal storage (min %g)" % (DAO, dao, MIN_DAO_FREE_NEAR))


def house_balances():
    """`scripts/house.mjs report --section final`: its LOW lines become warnings."""
    run = subprocess.run(["node", os.path.join(ROOT, "scripts", "house.mjs"), "report", "--section", "final"],
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT, universal_newlines=True, timeout=300,
                         env=dict(os.environ, GITHUB_ACTIONS=""))
    low = [l.split("LOW", 1)[1].strip() for l in run.stdout.splitlines() if l.startswith("LOW")]
    if run.returncode != 0:
        report("house balances", False, "house.mjs report exit %d: %s" % (run.returncode, run.stdout[-200:]))
    elif low:
        report("house balances", True, "; ".join(low), warning=True)
    else:
        report("house balances", True, "members, council and keeper keys above their floors")


def house_workflow():
    def ts(text):
        return datetime.datetime.strptime(text, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc).timestamp()

    headers = {"Accept": "application/vnd.github+json"}
    if os.environ.get("GITHUB_TOKEN"):
        headers["Authorization"] = "Bearer " + os.environ["GITHUB_TOKEN"]
    runs = http_json("https://api.github.com/repos/%s/actions/workflows/%s/runs?per_page=10" % (REPO, HOUSE_WORKFLOW),
                     headers=headers)["workflow_runs"]
    running = [r for r in runs if r["status"] == "in_progress"]
    waiting = [r for r in runs if r["status"] in ("queued", "pending", "waiting", "requested")]
    done = sorted((r for r in runs if r["status"] == "completed"), key=lambda r: r["updated_at"], reverse=True)
    idle = (NOW - ts(done[0]["updated_at"])) / 60 if done else float("inf")
    ended = ("the last one (#%d) ended %.0f min ago, %s" % (done[0]["run_number"], idle, done[0]["conclusion"])
             if done else "it has never run")
    name = "%s (house members, council, keeper)" % HOUSE_WORKFLOW
    if running:
        report(name, True, "run #%d in progress" % running[0]["run_number"])
    elif waiting and idle <= MAX_HOUSE_IDLE_MIN:
        report(name, True, "run #%d about to start; %s" % (waiting[0]["run_number"], ended))
    else:
        ok = idle <= MAX_HOUSE_IDLE_MIN and bool(done) and done[0]["conclusion"] == "success"
        report(name, ok, "no run in progress; %s (max %g min idle)" % (ended, MAX_HOUSE_IDLE_MIN))


def main():
    for check, step in (("judge checks", judge_checks), ("gas", gas), ("storage", storage),
                        ("house balances", house_balances), ("house workflow", house_workflow)):
        try:
            step()
        except Exception as e:  # noqa: BLE001 -- a check that cannot run is a problem too
            report(check, False, "could not check: %s" % e)

    when = datetime.datetime.fromtimestamp(NOW, datetime.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    table = ["### Hat Tip watchdog, %s" % when, "", "| Check | Result | Details |", "|---|---|---|"]
    table += ["| %s | %s | %s |" % (c, r, d.replace("|", "/")) for c, r, d in rows]
    print("\n".join(table))
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as f:
            f.write("\n".join(table) + "\n")
    for check, result, details in rows:
        if result != "ok":
            print("::%s::%s: %s" % ("error" if result == "FAIL" else "warning", check, details.replace("%", "%25")))
    problems = [c for c, r, d in rows if r == "FAIL"]
    warnings = len([c for c, r, d in rows if r == "warning"])
    print("%d of %d checks failed." % (len(problems), len(rows)) if problems else
          "All %d checks passed%s." % (len(rows), " (%d with a warning)" % warnings if warnings else ""))
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
