#!/usr/bin/env bash
# Privacy-safe wasm build of the Hat Tip thanks contract.
#
#   ./build.sh           build, check, print the sha256 and write it to WASM_SHA256
#   ./build.sh --check   build, check, and compare the sha256 with WASM_SHA256 (exit 3 if it differs)
#
# Runs `cargo near build non-reproducible-wasm --locked` with `--remap-path-prefix` for the cargo home,
# the rustup home, the repository and the target directory, so panic messages in the wasm carry neutral
# paths (/cargo/registry/..., /hat-tip/...) instead of machine-specific ones. cargo-near takes
# RUSTFLAGS only through `--env` and appends `--cfg near` itself, so RUSTFLAGS and
# CARGO_ENCODED_RUSTFLAGS are unset here (the latter would make cargo drop `--cfg near`).
# It also pins the host triple that cargo hashes (see "Host pin" below); it sets RUSTC_WRAPPER for
# that and replaces any wrapper set before. It unsets every CARGO_NEAR_* and NEP330_* variable
# (see "cargo-near's own variables" below).
#
# The build fails if `strings` finds /Users/, /home/ or the current user name in the wasm (exit 2),
# or if the wasm exports any method beyond the list below (exit 4): the round
# methods, the guest relay, the DAO calls and their callbacks, the views and the one init. There is no
# owner, admin, upgrade or withdraw method to find.
# Output: $CARGO_TARGET_DIR/near/hat_tip.wasm (default target/near/hat_tip.wasm).
# Needs: cargo-near 0.22, the toolchain pinned in rust-toolchain.toml, strings, python3,
# sha256sum or shasum.

set -euo pipefail

MODE=write
case "${1:-}" in
  "") ;;
  --check) MODE=check ;;
  *) echo "usage: $0 [--check]" >&2; exit 64 ;;
esac

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/.." && pwd)
CARGO_HOME_DIR=${CARGO_HOME:-$HOME/.cargo}
RUSTUP_HOME_DIR=${RUSTUP_HOME:-$HOME/.rustup}
TARGET_DIR=${CARGO_TARGET_DIR:-$HERE/target}
mkdir -p "$TARGET_DIR"
TARGET_DIR=$(cd "$TARGET_DIR" && pwd)
OUT_DIR=$TARGET_DIR/near
WASM=$OUT_DIR/hat_tip.wasm

for p in "$CARGO_HOME_DIR" "$RUSTUP_HOME_DIR" "$REPO" "$TARGET_DIR"; do
  case "$p" in
    *" "*) echo "ERROR: path with a space ($p): RUSTFLAGS cannot carry it" >&2; exit 1 ;;
  esac
done

# rustc applies the last matching remapping, so the more specific prefixes come later
# (the target directory usually lies inside the repository).
FLAGS="-C link-arg=-s"
FLAGS="$FLAGS --remap-path-prefix=$REPO=/hat-tip"
FLAGS="$FLAGS --remap-path-prefix=$TARGET_DIR=/target"
FLAGS="$FLAGS --remap-path-prefix=$RUSTUP_HOME_DIR=/rustup"
FLAGS="$FLAGS --remap-path-prefix=$CARGO_HOME_DIR=/cargo"

unset RUSTFLAGS CARGO_ENCODED_RUSTFLAGS

# cargo-near's own variables (fix from Bonfire). cargo-near reads CARGO_NEAR_* and NEP330_* from the
# environment to pass state into nested builds, and some of it ends up in the wasm: a set
# CARGO_NEAR_VERSION replaces the `builder` field of the ABI embedded in the wasm, NEP330_LINK the
# source link of the NEP-330 metadata. A CI job that set CARGO_NEAR_VERSION for its own use built an
# ABI with another `builder`; the compressed ABI changed length, every later data address moved, and
# with them globals and code. None of these is set for this build.
for v in $(compgen -e); do
  case "$v" in CARGO_NEAR_*|NEP330_*) unset "$v" ;; esac
done
cd "$HERE"
export CARGO_TARGET_DIR=$TARGET_DIR

# Host pin. cargo mixes the `host:` line of `rustc -vV` into the -C metadata of every unit it builds
# for the host (proc macros, build scripts) and, through the dependency graph, into the crate hashes
# of the wasm's own crates (rust-lang/cargo#8140). Those hashes decide symbol names, and with them the
# order of functions, imports and data in the wasm: on one and the same machine, reporting another
# host changes the code section. build.sh therefore runs rustc through a small wrapper that reports
# PINNED_HOST to `rustc -vV` and passes every other call through unchanged; proc macros and build
# scripts still run natively. The default is the host the deployed wasm was built on; set
# PINNED_HOST to another triple to see what the host line alone changes.
PINNED_HOST=${PINNED_HOST:-x86_64-apple-darwin}
case "$PINNED_HOST" in
  *[!a-z0-9_.-]*|"") echo "ERROR: PINNED_HOST must be a target triple" >&2; exit 64 ;;
esac
export PINNED_HOST
REAL_HOST=$(rustc -vV | sed -n 's/^host: //p')
WRAPPER=$TARGET_DIR/rustc-pinned-host.sh
cat >"$WRAPPER" <<'EOF'
#!/bin/sh
# Written by contract/build.sh: report $PINNED_HOST as the host to `rustc -vV`, pass the rest through.
if [ $# -eq 2 ] && [ "$2" = "-vV" ]; then
  out=$("$1" -vV) || exit $?
  printf '%s\n' "$out" | sed "s/^host: .*/host: $PINNED_HOST/"
  exit 0
fi
exec "$@"
EOF
chmod +x "$WRAPPER"
export RUSTC_WRAPPER=$WRAPPER
echo "host pin: cargo sees host \`$PINNED_HOST\` (this machine: \`$REAL_HOST\`)" >&2

cargo near build non-reproducible-wasm --locked --env "RUSTFLAGS=$FLAGS" --out-dir "$OUT_DIR" >&2

[ -f "$WASM" ] || { echo "ERROR: $WASM was not built" >&2; exit 1; }

# Privacy check: no machine-specific path or user name may remain in the wasm.
USER_NAME=${USER:-$(id -un)}
PATTERN='/Users/|/home/'
if [ -n "$USER_NAME" ]; then PATTERN="$PATTERN|$USER_NAME"; fi
LEAKS=$(strings -a "$WASM" | grep -E "$PATTERN" || true)
if [ -n "$LEAKS" ]; then
  echo "ERROR: the wasm contains machine-specific strings:" >&2
  printf '%s\n' "$LEAKS" | head -20 >&2
  exit 2
fi
echo "privacy check: no /Users/, /home/ or user name in $(basename "$WASM")" >&2

# Surface check: the wasm's function exports are exactly these methods (`__contract_abi` is the
# read-only ABI that cargo-near embeds).
EXPECTED="__contract_abi act allocate audit check_payout close_round config contract_source_metadata member new note \
on_checked on_close on_filed on_finalized on_policy on_registered on_voted pay payouts round signing_text state \
sync tiers"
python3 -I - "$WASM" "$EXPECTED" <<'PY' >&2
import sys

def leb(b, i):
    n = s = 0
    while True:
        x = b[i]; i += 1
        n |= (x & 0x7F) << s; s += 7
        if x < 0x80:
            return n, i

data = open(sys.argv[1], "rb").read()
assert data[:4] == b"\0asm", "not a wasm module"
i, found = 8, []
while i < len(data):
    sid = data[i]; size, i = leb(data, i + 1); end = i + size
    if sid == 7:
        count, i = leb(data, i)
        for _ in range(count):
            n, i = leb(data, i); name = data[i:i + n].decode(); i += n
            kind = data[i]; _, i = leb(data, i + 1)
            if kind == 0:
                found.append(name)
    i = end
expected = sorted(sys.argv[2].split())
if sorted(found) != expected:
    print("ERROR: the wasm exports differ from the expected surface", file=sys.stderr)
    print("  unexpected:", sorted(set(found) - set(expected)), file=sys.stderr)
    print("  missing:   ", sorted(set(expected) - set(found)), file=sys.stderr)
    sys.exit(4)
print("surface check: the wasm exports exactly the %d expected methods" % len(found), file=sys.stderr)
PY

if command -v sha256sum >/dev/null 2>&1; then
  HASH=$(sha256sum "$WASM" | awk '{print $1}')
else
  HASH=$(shasum -a 256 "$WASM" | awk '{print $1}')
fi
echo "sha256 $HASH  $(basename "$WASM") ($(wc -c <"$WASM" | tr -d ' ') bytes)" >&2

if [ "$MODE" = write ]; then
  printf '%s\n' "$HASH" >"$HERE/WASM_SHA256"
  echo "wrote WASM_SHA256" >&2
else
  EXPECTED=$(tr -d '[:space:]' <"$HERE/WASM_SHA256")
  if [ "$HASH" != "$EXPECTED" ]; then
    echo "MISMATCH: WASM_SHA256 says $EXPECTED" >&2
    exit 3
  fi
  echo "matches WASM_SHA256" >&2
fi
echo "$WASM"
