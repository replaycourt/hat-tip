#!/usr/bin/env python3
"""Compare a locally built wasm with the code deployed on a NEAR account, section by section.

    python3 scripts/compare-wasm.py LOCAL.wasm --account ACCOUNT.testnet [--rpc URL]
    python3 scripts/compare-wasm.py LOCAL.wasm --deployment contract|token [--section final|staging]
    python3 scripts/compare-wasm.py LOCAL.wasm --deployed OTHER.wasm

For both crates: the contract (contract/target/near/hat_tip.wasm) and tUSD (token/target/near/tusd.wasm).
`--deployment` takes the account from deploy/testnet.json: the `final` section once the launch
filled it, else `staging` (or the section named). Fetches the deployed code with the RPC `view_code`
query (FastNEAR, falling back to dRPC when it refuses), or reads a second file; prints the sha256 and
the NEAR code hash (base58 of the sha256) of both, then walks the module sections and says which are
byte-identical. Where a section differs it goes one level deeper: the function bodies of the code
section, the segments of the data section (with the differing byte ranges and whether they fall in
the embedded, zstd-compressed ABI), the export names, the custom section names.

Exit status: 0 the two modules are byte-identical, 1 they differ, 2 usage, network or parse error.
Standard library only; Python 3.8 or newer. Adapted from Bonfire's contract/compare-wasm.py.
"""

import argparse
import base64
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request

DEFAULT_RPC = "https://test.rpc.fastnear.com"
FALLBACK_RPC = "https://near-testnet.drpc.org"
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SECTION_NAMES = {
    0: "custom", 1: "type", 2: "import", 3: "function", 4: "table", 5: "memory", 6: "global",
    7: "export", 8: "start", 9: "element", 10: "code", 11: "data", 12: "datacount", 13: "tag",
}
ZSTD_MAGIC = b"\x28\xb5\x2f\xfd"
B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


class ParseError(Exception):
    pass


def b58(data):
    n = int.from_bytes(data, "big")
    out = ""
    while n:
        n, r = divmod(n, 58)
        out = B58[r] + out
    return "1" * (len(data) - len(data.lstrip(b"\0"))) + out


def leb(buf, i):
    n = shift = 0
    while True:
        if i >= len(buf):
            raise ParseError("truncated LEB128 at byte %d" % i)
        x = buf[i]
        i += 1
        n |= (x & 0x7F) << shift
        shift += 7
        if x < 0x80:
            return n, i


def sections(module):
    """[(label, id, start offset in the file, body bytes)]; custom sections are labelled by name."""
    if module[:4] != b"\0asm":
        raise ParseError("not a wasm module (bad magic)")
    out, i = [], 8
    while i < len(module):
        sid = module[i]
        size, j = leb(module, i + 1)
        body = module[j:j + size]
        if len(body) != size:
            raise ParseError("section %d runs past the end of the file" % sid)
        label = SECTION_NAMES.get(sid, "id%d" % sid)
        if sid == 0:
            n, k = leb(body, 0)
            label = "custom:" + body[k:k + n].decode("utf-8", "replace")
        out.append((label, sid, j, body))
        i = j + size
    return out


def code_bodies(body):
    count, i = leb(body, 0)
    funcs = []
    for _ in range(count):
        size, j = leb(body, i)
        funcs.append(body[j:j + size])
        i = j + size
    return funcs


def data_segments(body):
    """[(memory offset or None, start of the payload within the section body, payload)]."""
    count, i = leb(body, 0)
    segs = []
    for _ in range(count):
        flag, i = leb(body, i)
        offset = None
        if flag in (0, 2):
            if flag == 2:
                _, i = leb(body, i)  # memory index
            # constant expression, normally `i32.const N end`
            if body[i] == 0x41:
                value, i = leb(body, i + 1)
                offset = value
            while body[i] != 0x0B:
                i += 1
            i += 1
        size, i = leb(body, i)
        segs.append((offset, i, body[i:i + size]))
        i += size
    return segs


def exports(body):
    count, i = leb(body, 0)
    names = []
    for _ in range(count):
        n, i = leb(body, i)
        name = body[i:i + n].decode("utf-8", "replace")
        i += n
        kind = body[i]
        _, i = leb(body, i + 1)
        names.append((name, kind))
    return names


def byte_ranges(a, b):
    """Maximal ranges [start, end) where the equal-length byte strings a and b differ."""
    ranges, start = [], None
    for k in range(len(a)):
        if a[k] != b[k]:
            if start is None:
                start = k
        elif start is not None:
            ranges.append((start, k))
            start = None
    if start is not None:
        ranges.append((start, len(a)))
    return ranges


def zstd_frame(buf, start):
    """(start, end) of the zstd frame at `start` (cargo-near embeds the ABI as one), or None."""
    try:
        fhd = buf[start + 4]
        single = fhd >> 5 & 1
        i = start + 5 + (0 if single else 1) + (0, 1, 2, 4)[fhd & 3]
        i += (1 if single else 0, 2, 4, 8)[fhd >> 6]
        while True:
            header = int.from_bytes(buf[i:i + 3], "little")
            last, kind, size = header & 1, header >> 1 & 3, header >> 3
            if kind == 3 or len(buf) < i + 3:
                return None
            i += 3 + (1 if kind == 1 else size)
            if last:
                break
        i += 4 if fhd >> 2 & 1 else 0
        return (start, i) if i <= len(buf) else None
    except IndexError:
        return None


def preview(raw):
    return "".join(chr(c) if 32 <= c < 127 else "." for c in raw[:48])


def describe_code(a, b):
    fa, fb = code_bodies(a), code_bodies(b)
    print("    functions: %d local, %d deployed" % (len(fa), len(fb)))
    same_index = sum(1 for x, y in zip(fa, fb) if x == y)
    print("    bodies identical at the same index: %d" % same_index)
    ha = sorted(hashlib.sha256(x).digest() for x in fa)
    hb = sorted(hashlib.sha256(x).digest() for x in fb)
    if ha == hb:
        print("    same set of bodies, different order")
    else:
        common = len(set(ha) & set(hb))
        print("    bodies found in both modules regardless of index: %d" % common)
    shown = 0
    for k, (x, y) in enumerate(zip(fa, fb)):
        if x != y and shown < 8:
            print("    first differences: function %d (%d vs %d bytes)" % (k, len(x), len(y))
                  if shown == 0 else
                  "                       function %d (%d vs %d bytes)" % (k, len(x), len(y)))
            shown += 1


def describe_data(a, b):
    sa, sb = data_segments(a), data_segments(b)
    print("    segments: %d local, %d deployed" % (len(sa), len(sb)))
    if len(sa) != len(sb):
        return
    for k, ((oa, pa, da), (ob, pb, db)) in enumerate(zip(sa, sb)):
        if (oa, da) == (ob, db):
            continue
        where = "segment %d at memory offset %s" % (k, oa if oa == ob else "%s vs %s" % (oa, ob))
        if len(da) != len(db):
            print("    %s: %d vs %d bytes" % (where, len(da), len(db)))
            continue
        ranges = byte_ranges(da, db)
        zs = da.find(ZSTD_MAGIC)
        abi = zstd_frame(da, zs) if zs >= 0 else None
        if abi:
            print("    (segment %d holds a zstd frame at +%d..+%d, the embedded ABI)" % (k, abi[0], abi[1]))
        print("    %s (%d bytes): %d differing byte(s) in %d range(s)"
              % (where, len(da), sum(e - s for s, e in ranges), len(ranges)))
        for s, e in ranges[:6]:
            inside = " (inside the embedded ABI)" if abi and abi[0] <= s < abi[1] else ""
            print("      +%d..+%d%s  local %r  deployed %r"
                  % (s, e, inside, preview(da[s:e]), preview(db[s:e])))


def describe_exports(a, b):
    ea, eb = set(exports(a)), set(exports(b))
    if ea - eb:
        print("    only local:    %s" % sorted(n for n, _ in ea - eb))
    if eb - ea:
        print("    only deployed: %s" % sorted(n for n, _ in eb - ea))
    if ea == eb:
        print("    same export names, different order or indices")


def fetch_code(account, rpc):
    """The deployed code, from `rpc` or, when it refuses (FastNEAR answers HTTP 429 to quick calls),
    from the fallback; five tries with growing pauses."""
    payload = json.dumps({
        "jsonrpc": "2.0", "id": "compare-wasm", "method": "query",
        "params": {"request_type": "view_code", "finality": "final", "account_id": account},
    }).encode()
    errors = []
    for attempt, url in enumerate([rpc, FALLBACK_RPC, rpc, FALLBACK_RPC, rpc]):
        if attempt:
            time.sleep(attempt)
        req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                reply = json.load(resp)
        except (urllib.error.URLError, OSError, ValueError) as e:
            errors.append("%s: %s" % (url, e))
            continue
        if "result" not in reply:
            err = json.dumps(reply.get("error", reply))
            if "UNKNOWN_ACCOUNT" in err or "NO_CONTRACT_CODE" in err:
                raise ParseError("RPC error: %s" % err[:400])
            errors.append("%s: RPC error %s" % (url, err[:200]))
            continue
        code = base64.b64decode(reply["result"]["code_base64"])
        if reply["result"].get("hash") != b58(hashlib.sha256(code).digest()):
            raise ParseError("the RPC code hash does not match the code it returned")
        return code, "%s (view_code via %s, block %s)" % (account, url, reply["result"].get("block_height"))
    raise ParseError("no RPC answered: " + "; ".join(errors[-2:]))


def deployment_account(role, section):
    """The `contract` or `token` account of deploy/testnet.json: `section`, or final if set, else staging."""
    with open(os.path.join(REPO, "deploy", "testnet.json"), encoding="utf-8") as f:
        deploy = json.load(f)
    name = section or ("final" if deploy.get("final") else "staging")
    if not deploy.get(name):
        raise ParseError("deploy/testnet.json has no %s deployment" % name)
    return deploy[name][role], name


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("local", help="the wasm built here")
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--account", help="NEAR account whose deployed code to fetch")
    src.add_argument("--deployment", choices=["contract", "token"],
                     help="the account of deploy/testnet.json (final once launched, else staging)")
    src.add_argument("--deployed", help="a second wasm file instead of the chain")
    ap.add_argument("--section", choices=["final", "staging"], help="with --deployment: this section")
    ap.add_argument("--rpc", default=DEFAULT_RPC, help="RPC endpoint (default %(default)s, fallback " + FALLBACK_RPC + ")")
    args = ap.parse_args()

    try:
        with open(args.local, "rb") as f:
            local = f.read()
        if args.deployment:
            args.account, section = deployment_account(args.deployment, args.section)
            print("deployment: %s of deploy/testnet.json section %s" % (args.account, section))
        if args.account:
            deployed, source = fetch_code(args.account, args.rpc)
        else:
            with open(args.deployed, "rb") as f:
                deployed = f.read()
            source = args.deployed
        sec_a, sec_b = sections(local), sections(deployed)
    except (OSError, ValueError, KeyError, ParseError) as e:
        print("ERROR: %s" % e, file=sys.stderr)
        return 2

    for name, blob, where in (("local", local, args.local), ("deployed", deployed, source)):
        digest = hashlib.sha256(blob).digest()
        print("%-8s sha256 %s  code hash %s  %d bytes  %s"
              % (name, digest.hex(), b58(digest), len(blob), where))
    if local == deployed:
        print("result: byte-identical")
        return 0

    print("\n%-22s %10s %10s  %s" % ("section", "local", "deployed", "verdict"))
    labels_a = [s[0] for s in sec_a]
    labels_b = [s[0] for s in sec_b]
    order = labels_a + [x for x in labels_b if x not in labels_a]
    by_a = dict((s[0], s) for s in sec_a)
    by_b = dict((s[0], s) for s in sec_b)
    differing = []
    for label in order:
        a, b = by_a.get(label), by_b.get(label)
        if a is None or b is None:
            verdict = "only in the %s module" % ("deployed" if a is None else "local")
        else:
            verdict = "identical" if a[3] == b[3] else "DIFFERENT"
        print("%-22s %10s %10s  %s" % (label, len(a[3]) if a else "-", len(b[3]) if b else "-", verdict))
        if verdict == "DIFFERENT":
            differing.append(label)
    if labels_a != labels_b and set(labels_a) == set(labels_b):
        print("(the sections appear in a different order)")

    try:
        for label in differing:
            print("\n%s:" % label)
            a, b = by_a[label][3], by_b[label][3]
            if label == "code":
                describe_code(a, b)
            elif label == "data":
                describe_data(a, b)
            elif label == "export":
                describe_exports(a, b)
            elif len(a) == len(b):
                ranges = byte_ranges(a, b)
                print("    %d differing byte(s) in %d range(s), first at +%d"
                      % (sum(e - s for s, e in ranges), len(ranges), ranges[0][0]))
            else:
                print("    %d vs %d bytes" % (len(a), len(b)))
    except (IndexError, ParseError) as e:
        print("    (could not look deeper: %s)" % e)
    print("\nresult: DIFFERENT in %s" % (", ".join(differing) if differing else "section layout"))
    return 1


if __name__ == "__main__":
    sys.exit(main())
