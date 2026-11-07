# Hat Tip contract (`thanks`)

The rules of DESIGN.md in one NEAR contract (Rust, near-sdk 5.30, edition 2024): rounds of peer
thanks, the counting pipeline, reputation, the three payout tiers, and every payout filed as a
proposal in the community's own Sputnik v2 DAO through the DAO role `thanks`. The contract never
holds the money; it has no owner, admin, upgrade or withdraw method, and after deployment its
account has no keys. This file is the contract's interface, as built.

The name lives in `src/config.rs` (`NAME`, `EVENT_STANDARD`, `SIGNING_PREFIX`) and in the crate
name `hat-tip`; a rename touches those and the export list in `build.sh`.

## Deviations from the first interface draft

Small, and none changes a method name, an argument or a field the page or the scripts read:

1. **`pay(max)` returns `PayOutcome {filing, error}`**, not a promise. It starts one chain per
   payout and the chains run on their own; `filing` lists their payout ids. (A call that files
   several payouts has no single promise whose result means anything.)
2. **`check_payout` reads the proposal with `get_proposals(from_index: id, limit: 1)`**, not
   `get_proposal(id)`. Sputnik deletes a removed proposal (testnet probe), so `get_proposal`
   fails with `ERR_NO_PROPOSAL`, which looks like any other failure; `get_proposals` answers `[]`
   and the contract reads that, and only that, as `removed`. A failed read changes nothing.
3. **A `Failed` proposal is retried once.** The transfer of an approved proposal fails when the
   receiver is not registered with the token (probe: the bond stays locked). The first check
   that sees `Failed` calls `storage_deposit` for the receiver and then `act_proposal(Finalize)`,
   which makes the DAO run the approved transfer again; a second `Failed` is final. DESIGN.md
   said a failed transfer is not refiled: it is not refiled (no new proposal), only finalized.
4. **`on_finalized` records nothing.** After any `Finalize` the outcome (`Expired` with the bond
   back, or `Approved` / `Failed` after a retry) is read by the next `check_payout`, from the
   DAO's own record. An expired payout therefore takes two checks: one finalizes, one records.
5. **The views carry more fields than the draft listed** (additive; see "Views"), and two shapes are
   spelled out: `member().history` rows are objects `{round, points, givers: [[giver, given,
   counted]]}`, and `limits` (like `tiers()`) is `{auto, cosign, reputation}`.
6. **Gas** differs from the first budgets: every `call.then(callback)` costs about
   19 Tgas in receipt fees on top of the static gas, and a vote that executes a transfer needs at
   least 25 Tgas attached (probe). See "Gas".
7. **One new parameter, `guest_receive_cap_bp: u16`** (added 2026-11-07),
   the last field of `Config`, optional in JSON with default 10,000 (off): guests together
   receive at most this share of a round's points ("Counting, exactly", step 7). Without it a
   member could route its thanks to a farm of guests. The simulation models it (rule 17 of
   `sim/golden/README.md`, stage D of `docs/SIMULATION.md`), `sim/golden/receive_cap.json`
   exercises it and `launch_testnet.json` runs with it at 800.

## Build and check

```sh
./build.sh            # build with cargo-near, check, write WASM_SHA256
./build.sh --check    # build, check, compare with WASM_SHA256 (exit 3 if it differs)
cargo test            # unit tests and the mock-VM tests in tests/
```

`build.sh` (from Bonfire) builds with `cargo near build non-reproducible-wasm --locked`, remaps
every machine path, pins the host triple cargo hashes, and fails if `strings` finds `/Users/`,
`/home/` or the user name in the wasm (exit 2) or if the wasm exports anything but the methods
below (exit 4). It unsets every `CARGO_NEAR_*` and `NEP330_*` variable first: cargo-near writes
`CARGO_NEAR_VERSION` into the `builder` field of the ABI it embeds, which moves every later byte.
Toolchain: `rust-toolchain.toml` (1.95.0), cargo-near 0.22. On the Intel Mac (macOS 15, x86_64)
that built the deployed wasm, `./build.sh --check` reproduces `WASM_SHA256` from a cold target
directory in about 4.5 minutes, also with `CARGO_NEAR_VERSION` set. To compare a build with the
code on chain, section by section:

```sh
python3 ../scripts/compare-wasm.py target/near/hat_tip.wasm --deployment contract
```

## Init

`new(config: Config)`, `#[init]`, `#[private]`: runs once in the deployment transaction. The
contract starts **paused** ("the DAO policy has not been read yet") with an empty member list;
the first `sync()` reads the DAO policy.

### `Config`

All fields are required in JSON except the three role names and `guest_receive_cap_bp`. `U128` fields are decimal strings.
Amounts are tUSD base units (6 decimals), `*_bp` basis points (10,000 = 100 %), times
milliseconds. `new` panics with the first field out of range.

| Field | Type | Meaning | Checked |
|---|---|---|---|
| `dao` | AccountId | the community's Sputnik v2 DAO | |
| `token` | AccountId | the NEP-141 token the DAO pays in (tUSD) | |
| `members_role` | String = `"members"` | DAO role whose named accounts are the members | 1-64 bytes, not `thanks_role` |
| `council_role` | String = `"council"` | DAO role shown as the council | 1-64 bytes |
| `thanks_role` | String = `"thanks"` | DAO role this contract is in | 1-64 bytes |
| `genesis_ms` | u64 | start of round 1 | |
| `round_ms` | u64 | round length | >= 1,000 |
| `thanks_per_round` | u16 | thanks per giver and round | >= 1 |
| `cap_per_receiver` | u16 | most thanks to one receiver | 1 ..= `thanks_per_round` |
| `max_receivers` | u8 | most receivers per allocation | >= 1 |
| `reciprocal_bp` | u16 | share at which mutual thanks count (10,000 = off) | <= 10,000 |
| `quadratic` | bool | quadratic aggregation | |
| `breadth_k` | u8 | fewer supporting givers than this count at `breadth_bp` (0 = off) | |
| `breadth_bp` | u16 | | <= 10,000 |
| `idle_bp` | u16 | share for a member receiver who gave nothing (10,000 = off) | <= 10,000 |
| `decay_bp` | u16 | reputation lost per round | <= 10,000 |
| `round_budget` | U128 | most a round pays | |
| `min_payout` | U128 | smallest payout; less is carried | >= 1 |
| `carry_rounds` | u16 | a carry lapses this many rounds after its first share | |
| `reserve` | U128 | DAO balance a round never touches | |
| `auto_rep_min` | u32 | reputation (thanks) needed for any auto limit | |
| `auto_per_thanks` | U128 | auto limit per thanks of reputation | |
| `auto_max` | U128 | auto limit cap | |
| `cosign_base` | U128 | co-sign limit at reputation 0 | |
| `cosign_per_thanks` | U128 | co-sign limit per thanks of reputation | |
| `cosign_max` | U128 | co-sign limit cap | |
| `auto_share_bp` | u16 | most of a round's budget tier 1 may send | <= 10,000 |
| `guest_seats` | u8 | guest seats per round (0 = no guests) | |
| `guest_weight_bp` | u16 | weight of a guest's thanks | <= 10,000 |
| `guest_cap_bp` | u16 | most of a round's weight all guests together steer | <= 10,000 |
| `guest_receive_cap_bp` | u16 = 10,000 | most of a round's points all guests together receive (10,000 = off); last field, optional | <= 10,000 |
| `max_members` | u16 | members the contract takes from the role (the first by account id) | >= 1; `max_members + guest_seats <= 64` |
| `max_catchup` | u16 | empty rounds one `close_round` closes | >= 1 |
| `log_keep` | u32 | rounds kept in full (`round(n)`, `member().history`) | >= 2 |
| `note_max_bytes` | u16 | longest note | <= 280 |

## Calls

Anyone may call these; the relay's function-call keys may call `act`, `close_round`, `pay`,
`check_payout` and `sync`.

| Method | Arguments | Returns | What it does |
|---|---|---|---|
| `sync` | - | Promise -> `SyncOutcome {ok, members, council, bond, paused}` | `dao.get_policy()` -> `on_policy`: takes over members, council, bond, proposal period, and pauses or unpauses (below). Needs 70 Tgas. |
| `allocate` | `round: u64, gifts: [[AccountId, u16]], note: Option<String>` | `AllocateOutcome {ok, error, given}` | a member's allocation for the clock's round; replaces the member's earlier one; `[]` withdraws it; the optional note is posted in the same call. Refused: not the clock's round, round 1 not started, caller not a member (last synced list), more than `max_receivers`, a receiver named twice, the caller as receiver, a gift outside 1..=`cap_per_receiver`, a receiver neither a member nor a guest seated in the round, more than `thanks_per_round` in all, a bad note. A refusal changes nothing and logs nothing. |
| `note` | `round: u64, text: String` | - | a member's note for the clock's round; `""` deletes it. Panics on refusal. |
| `act` | `pubkey: String, nonce: u64, action: String, signature: String` | `ActOutcome {ok, error, nonce, round}` | a guest's signed action (below) |
| `close_round` | - | `CloseOutcome {closed, last_closed, waiting, error}` or Promise -> `on_close`'s `CloseOutcome` | closes due rounds in order (below) |
| `pay` | `max: u8` | `PayOutcome {filing: [u64], error}` | files up to `max` planned payouts, oldest first (below) |
| `check_payout` | `payout: u64` | `CheckOutcome {payout, status, changed}` or Promise -> the same | reads a filed payout's DAO proposal and records its outcome (below). Panics for an unknown or pruned id. |

Callbacks, all `#[private]`: `on_policy()`, `on_close(round)`, `on_registered(payout)`,
`on_filed(payout)`, `on_voted(payout)`, `on_checked(payout)`, `on_finalized(payout)`. A callback
for a payout that is no longer in the state it expects changes nothing.

### Guests: `act`

A guest is the implicit account of a browser ed25519 key. `pubkey` is the key's 32 bytes and
`signature` its 64-byte signature, both lowercase hex. The signature covers the UTF-8 bytes of

```text
hattip:v1:<contract account>:<nonce>:<action>
```

(`signing_text(nonce, action)` returns it). `nonce` is 1 ..= 2^53 - 1 and must be above the
key's last accepted nonce. Actions (JSON, at most 2,048 bytes):

```json
{"join": {"round": 42, "note": "first visit"}}            // note optional
{"allocate": {"round": 42, "gifts": [["ana.example.testnet", 40], ["ben.example.testnet", 60]]}}
{"note": {"round": 42, "text": "brought a toaster"}}
```

A bad signature, a used nonce, a nonce out of range or malformed JSON **fail the call**. A
refused action returns `ok: false` with `error` and changes nothing except the nonce of a guest
that already has a record. Any accepted action takes one of the round's `guest_seats` seats if
the guest has none (first come; `joined` event); a seat lasts one round. A guest gives to members
only, under the same rules as a member.

### Closing: `close_round`

Round `r` runs from `genesis_ms + (r - 1) * round_ms` to `genesis_ms + r * round_ms`. Due rounds
close in order. A round without allocations closes at once (up to `max_catchup` per call): no
budget, no payouts; reputation decays and old carries lapse. The first due round with
allocations is counted after the DAO answers: the call returns
`get_policy()` and `token.ft_balance_of(dao)`, joined, then `on_close(round)`; one such round per
call. While that answer is pending (up to 2 minutes) another call does not start a second one.
If either answer fails, nothing closes and `error` says to call again. A close with allocations
needs 255 Tgas attached; with less, `error` says so and nothing starts.

`on_close` takes over the policy just read (as `sync` does), counts the round, plans the payouts
and logs the events. The arithmetic is "Counting, exactly" below.

### Paying: `pay(max)`

Refused while paused. For each planned payout, oldest id first, while the attached gas and the
contract's balance allow (the contract keeps 0.05 NEAR free above its storage):

1. If the contract has not registered the receiver with the token yet:
   `token.storage_deposit({account_id, registration_only: true})` with 0.00125 NEAR ->
   `on_registered(payout)`.
2. `dao.add_proposal({proposal: {description, kind}})` with exactly the DAO's `proposal_bond`
   (from the last sync) -> `on_filed(payout)`, which stores the DAO's proposal id.
3. Tier 1 only: `dao.act_proposal({id, action: "VoteApprove", proposal: kind})` -> `on_voted`.
   The role `thanks` has `transfer` 1 of 1, so the DAO executes the transfer in this chain.

Failures: a failed `storage_deposit` or `add_proposal` puts the payout back to `planned` and
pauses the contract; a failed vote leaves the payout `filed` (it then needs the council
majority, like tier 3) and pauses the contract. `sync()` or the next close unpauses it when the
policy shows the role fit again.

### The proposals

| Tier | Kind (`kind` JSON, as filed and as passed back to `act_proposal`) | Approved by |
|---|---|---|
| 1 | `{"Transfer": {"token_id": <token>, "receiver_id": <receiver>, "amount": "<q>"}}` | the contract's own `VoteApprove` (role `thanks`: `transfer` 1 of 1) |
| 2 | `{"FunctionCall": {"receiver_id": <token>, "actions": [{"method_name": "ft_transfer", "args": <base64 of {"amount":"<q>","receiver_id":"<receiver>"}>, "deposit": "1", "gas": "15000000000000"}]}}` | one council `VoteApprove` (council `call` threshold 1); one `VoteReject` rejects |
| 3 | the same `Transfer` as tier 1, without the contract's vote | the council majority (default policy) |

Description (also the `ft_transfer` memo of tiers 1 and 3):
`Hat Tip r42: 31.5 thanks from 5 -> ana.repaircafe.testnet (auto)`, with
`(one council vote)` for tier 2 and `(council majority)` for tier 3. The thanks are the round's
points in thanks with one decimal (rounded down), "from" the givers whose thanks counted.

The contract's role needs `transfer:AddProposal`, `transfer:VoteApprove`, `call:AddProposal`,
`transfer:Finalize` and `call:Finalize` (exact, `kind:*`, `*:action` or `*:*`, as Sputnik
matches them). If the role is missing, does not contain this contract, or lacks one of them, the
contract is paused with that reason.

### Outcomes: `check_payout(payout)`

For a payout that has a proposal id and no final status: `dao.get_proposals({from_index: id,
limit: 1})` -> `on_checked(payout)`:

| The DAO says | Recorded | Strike |
|---|---|---|
| `[]` (Sputnik deleted it) | `removed` | yes |
| `Approved` | `paid` | |
| `Rejected` | `rejected` | yes |
| `Removed` | `removed` | yes |
| `Expired` | `expired` | |
| `Failed`, first time | nothing yet: `storage_deposit` -> `act_proposal(Finalize)` -> `on_finalized` (the DAO re-runs the transfer) | |
| `Failed` after the retry, or `Moved` | `failed` | |
| `InProgress`, past `submission_time + proposal_period` | nothing yet: `act_proposal(Finalize)` -> `on_finalized` (the DAO expires it and returns the bond) | |
| `InProgress` | nothing | |

A strike takes the round's points back, decayed to the last closed round with the per-round
floors: `R = R - min(R, strike)`. Needs 140 Tgas attached (with less it panics `this call needs 140 Tgas`).

## Views

```text
config() -> Config
state() -> {name, round, round_ends_ms, oldest_unclosed, due, closing: Option<u64>,
            members: [AccountId], council: [AccountId], guests_seated: [AccountId],
            paused: bool, pause_reason: Option<String>, last_sync_ms, bond: U128,
            proposal_period_ns: U64, planned, open_payouts, next_payout, oldest_payout,
            totals: Totals}
round(n) -> Option<{n, closed, starts_ms, ends_ms, dao_balance: U128, budget: U128, dust: U128,
            notes: [[AccountId, String]], seats: [AccountId],
            gifts: [[giver, receiver, given: u16, counted: U128]], points: [[AccountId, U128]],
            payouts: [u64]}>
member(account_id) -> {account, kind: "member"|"guest"|"other", reputation: U128, carry: U128,
            carry_since, limits: {auto, cosign, reputation}, strikes, open_payouts,
            history: [{round, points: U128, givers: [[giver, given, counted: U128]]}],
            payouts: [PayoutView]}
payouts(from: u64, limit: u64) -> [PayoutView]      // limit at most 100, pruned ids skipped
PayoutView = {id, round, receiver, amount: U128, tier: 1|2|3,
              status: "planned"|"filing"|"filed"|"approved"|"paid"|"rejected"|"expired"|"removed"|"failed",
              dao_proposal: Option<u64>, kind: "transfer"|"function_call", points: U128, givers}
tiers(account_id) -> {auto: U128, cosign: U128, reputation: U128}   // for the next close
audit() -> {balanced, points_attributed, statuses_ok, filed_have_ids, carry_ok,
            budgets, planned, carry, lapsed, dust: U128, payouts, by_status: [[status, count]]}
signing_text(nonce: u64, action: String) -> String
Totals = {rounds_closed, budgets, planned, carry, lapsed, dust, points, attributed, paid,
          rejected, expired, removed, failed: U128, strikes, by_status: [u64; 9]}
```

`round(n)` answers for the last `log_keep` closed rounds and the open ones; `None` before round
1, for rounds not started and for pruned rounds. `reputation` is decayed to the last closed
round. `limits` and `tiers()` are the limits the next close applies (from that reputation).
`audit()`: `balanced` is `budgets = planned + carry + lapsed + dust`; `points_attributed` that
the points equal the sum of their counted gifts, in total and in every kept round; `statuses_ok`
that the payouts by status add up to every payout planned; `filed_have_ids` that every kept
payout past filing has a DAO proposal id; `carry_ok` that the accounts' carries add up to the
carry total.

Payout statuses: `planned` (waits for `pay`), `filing` (chain running), `filed` (in the DAO
with an id), `approved` (tier 1: the contract's vote passed; the DAO executes), then one final
status: `paid`, `rejected`, `expired`, `removed` or `failed`.

## Events

NEP-297, `EVENT_JSON:{"standard":"hattip","version":"1.0.0","event":...,"data":[...]}`. A call
logs one line per event kind, with every entry of that kind in `data`, in the order of this
table. Amounts are decimal strings; rounds, ids, thanks and points are numbers.

| Event | Fields of each entry |
|---|---|
| `synced` | `members`, `council` (counts), `dropped` (named members beyond `max_members`), `bond`, `proposal_period` (ns, string), `paused` |
| `paused` | `paused` (bool), `reason` |
| `joined` | `round`, `account`, `seat` (1 ..= `guest_seats`) |
| `note` | `round`, `account`, `text` (`""`: deleted) |
| `allocated` | `round`, `giver`, `guest` (bool), `given` (sum), `gifts` (`[[receiver, thanks]]`) |
| `round_closed` | `round`, `empty`, `members` (count), `dao_balance`, `budget`, `points` (sum), `dust`, `payouts` (count), `carries` (count), `detail` (below) |
| `points` | `round`, `accounts` (the round's account table), `points`: `[[receiver index, points, [[giver index, thanks, counted]...]]...]` in account order, `detail` (bool) |
| `payout_planned` | `payout`, `round`, `receiver`, `amount`, `tier`, `points`, `givers` |
| `carry` | `round`, `account`, `amount` (the whole carry now), `since` |
| `carry_lapsed` | `round`, `account`, `amount`, `since` |
| `filed` | `payout`, `proposal`, `tier`, `kind` |
| `approved` | `payout`, `proposal` |
| `paid`, `rejected`, `expired`, `removed`, `failed` | `payout`, `proposal`, `receiver`, `amount` |
| `struck` | `payout`, `round`, `account`, `points` (the round's), `strike` (decayed), `reputation` (after) |

`synced` is logged by every `sync`, and by a close when anything changed. A close keeps its logs
below 15,000 bytes (NEAR fails a receipt above 16 KiB): `detail` 2 logs everything; 1 drops the
per-giver lists from `points` (the `round(n)` view still has them); 0 logs only `round_closed`.
The demo's largest round (24 members, 6 guests, 10 gifts each) logs at `detail` 2. With detail
2 or 1 the events alone rebuild every reputation (`round_closed` decays, `points` adds, `struck`
subtracts) and every payout status; `tests/invariant.rs` does exactly that.

## Counting, exactly

The contract implements the integer rules listed in `sim/golden/README.md` ("The integer rules
the vectors fix", 1-17), and `tests/golden.rs` checks it against every vector (all six match to
the base unit and the milli-thanks). In short, for a
round with entries `T[i][j]`, every division rounding down:

1. Eligibility (at the close, against the policy just read): giver and receiver each a named
   member or a guest seated in the round, not both guests. Others count 0 and stay in the log.
2. Weight: `T * 1000` (member), `T * guest_weight_bp / 10` (guest). If
   `G * (10000 - guest_cap_bp) > M * guest_cap_bp`: each guest entry `w * (M * guest_cap_bp) /
   (G * (10000 - guest_cap_bp))`.
3. Reciprocity: for each pair both ways, both lose `min(w_ij, w_ji) * (10000 - reciprocal_bp) / 10000`.
4. Quadratic (if on): `v = isqrt(w * 10^6)`, `S_j = sum v`, `W = sum w`, `Q = sum S_j^2`,
   `a = W * v * S_j / Q`; else `a = w`.
5. Breadth: if fewer than `breadth_k` entries to j have `a > 0`: `a = a * breadth_bp / 10000`.
6. Idle: if j is a member without an allocation in the round: `a = a * idle_bp / 10000`.
7. Guests' receive cap (off at 10,000): `Pg` = sum of `a` over entries
   to guests, `Pm` over entries to members. If `Pg * (10000 - guest_receive_cap_bp) > Pm *
   guest_receive_cap_bp`, every entry to a guest becomes `a * (Pm * guest_receive_cap_bp) /
   (Pg * (10000 - guest_receive_cap_bp))`, one floor per entry (the same rule as step 2's cap).
8. Points `p_j = sum a`; only `p_j > 0` takes part below.
9. Reputation: `R0` = after the previous close and any strikes since. Each close decays every
   record once, `R * (10000 - decay_bp) / 10000` (applied lazily, round by round with its own
   floor), then adds `p`. A guest's reputation below 1,000 becomes 0.
10. Budget `B = min(round_budget, max(0, dao_balance - reserve))`, 0 if the points sum to 0.
11. In account order: `share = B * p / sum p`, `q = share + carry`; `0 < q < min_payout` becomes
    the carry (stamped with the round it began), else a payout of `q` is planned. `dust = B -
    sum shares`.
12. Tiers from `R0`: `auto = min(auto_max, R0/1000 * auto_per_thanks)`, 0 for a guest or below
    `auto_rep_min` thanks; `cosign = min(cosign_max, cosign_base + R0/1000 * cosign_per_thanks)`;
    tier 1 if `q <= auto`, 2 if `q <= cosign`, else 3. Round cap: while tier 1 sums to more than
    `auto_share_bp` of `B`, the largest tier-1 payout (ties: lower account id) moves to tier 2.
13. Carries with `r - stamp >= carry_rounds` lapse, at every close.

Payout ids are assigned in receiver account order. Steps 1-7 are the pure function
`math::count`.

## Storage

The contract pays its own storage. Per round it keeps one record (accounts, seats, notes, gifts
with their counted points, budget, points, payout ids) and deletes it when the round is
`log_keep` rounds old. Account records keep reputation (lazily decayed), carry, open payouts,
the guest's nonce and seat, and the rounds with points still in the log. Guest records with
nothing left (reputation 0, no carry, no open payout, no seat) are deleted by a sweep at each
close (8 per close); final payouts older than `log_keep` rounds are pruned (16 per close).
Neither changes any number.

## Gas

Static gas each receipt gets (`src/config.rs`); `GAS_LINK` (20 Tgas) is the receipt fee of one
`call.then(callback)`, which the creator pays on top:

| Step | Tgas |
|---|---|
| `get_policy`, `ft_balance_of`, `get_proposals` | 10, 5, 10 |
| `on_policy`, `on_close` | 20, 180 |
| `storage_deposit`, `add_proposal`, `act_proposal` | 10, 15, 30 |
| `on_registered` | 5 + the filing link |
| `on_filed` | 5; tier 1: 5 + 20 + 30 + `on_voted` 5 = 60 |
| `on_checked` | 5 + 2 x 20 + 10 + 30 + 5 = 90 |

Attach: `sync` 70, `close_round` 255 (when a round with allocations is due), `check_payout`
140, `pay` 40 to 130 per payout (tier 3 already registered to tier 1 with registration), plus
15 for itself. The first three are what the contract asks for itself (`this call needs N Tgas`):
the gas it attaches, one `GAS_LINK` per link, the 15 Tgas it keeps (`GAS_MARGIN`) and 5 for its
own work before the check: `sync` 20 + 10 + 20 + 15 + 5 = 70, `close_round` 2 x 20 + 10 + 5 + 180
+ 15 + 5 = 255, `check_payout` 20 + 10 + 90 + 15 + 5 = 140. The mock-VM tests fail any receipt
that attaches more gas than it has.

Measured in the mock VM (`tests/gas.rs`; host calls only: storage, logs, promises, not wasm
instructions; storage writes flushed inside the call):

| Receipt | Host gas | Logs |
|---|---|---|
| `on_close`, the demo's largest round: 24 members and 6 guests, 10 gifts each (300 entries), every rule on | 10.5 Tgas | 9,647 bytes, detail 2 |
| `on_close`, the worst: 58 members with 64-character names and 6 guests, 640 entries | 16.6 Tgas | 13,827 bytes, detail 1 |
| `on_close`, an 8-member round | 3.0 Tgas | 2,283 bytes |
| `on_registered`, `on_filed` (tier 1) | 39.3, 54.3 Tgas (almost all of it the gas they attach to the next step) | |
| `on_voted`, `on_checked`, `on_policy` | 0.1-0.2 Tgas | |

`on_close` gets 180 Tgas, so the counting itself (wasm: the pipeline, JSON of the policy and the
events, borsh of the round) has more than 160 Tgas at the worst size. On the staging deployment
`on_close` burnt 5.0-8.4 Tgas for 8 members, and a whole close 12.2-15.8 (`docs/testnet-stage.md`,
"Gas, measured"). `pay` with 300 Tgas files 3 first payouts (with registration).

## Tests

`cargo test`: 72 tests, all through the real contract in the SDK's mock VM except the unit tests
of the pure arithmetic. `tests/common` holds a model of the Sputnik v2 DAO (2.3.1: bond, per-kind
permissions, role thresholds, execution, removal deletes the proposal, Finalize expires or
re-runs) and of the token; it executes every receipt the contract creates and feeds the answers
(or failures) back into the callbacks, with the gas each receipt attached.

| File | Tests | What |
|---|---|---|
| `src/math.rs` | 10 | isqrt, each pipeline step, the guests' caps, decay, the round cap |
| `allocate.rs` | 8 | every allocation refusal, replacing and withdrawing, notes, membership from the last sync |
| `guests.rs` | 9 | signatures, nonces, malformed actions, seats, guest weight and both guest caps, no tier 1 for guests, record cleanup |
| `counting.rs` | 6 | reciprocity, quadratic attribution, breadth, idle, eligibility at the close, the `points` event, contract = `math::count` on random rounds with every rule on |
| `reputation.rs` | 6 | lazy decay = per-round decay, tiers from the reputation before the round, the round cap, strike arithmetic, batch closes of empty rounds, a newcomer reaching tier 1 |
| `carry.rs` | 5 | carry, carry paid with the next share, lapse, budget capped by the DAO and the reserve, rounding dust |
| `dao.rs` | 14 | the three tiers end to end, reject and remove (strikes), expiry and the bond, the failed-transfer retry, add_proposal / vote / registration failures and the pause, role and permission checks, member list rules, gas and balance limits of `pay`, stale callbacks, a close that waits or retries |
| `flow.rs` | 1 | one round from thanks to a paid DAO proposal |
| `gas.rs` | 4 | the largest and the worst close within gas and the log limit, every payout chain within its attached gas |
| `init.rs` | 6 | parameter checks, defaults, paused before the first sync, views before genesis, pruning, both launch columns of `sim/params.json` accepted |
| `invariant.rs` | 2 | 600 random rounds (members joining and leaving, guests, a DAO running low and failing, council votes): `audit()` after every round, and the events alone rebuild every reputation and payout status |
| `golden.rs` | 1 | every `sim/golden/*.json` (6 vectors, 61 rounds) to the unit; skipped with a message when there are none |

Not done: an integration test in near-sandbox with the testnet DAO's wasm (optional; the staging
run on testnet, `docs/testnet-stage.md`, covers the same paths against the real DAO).
