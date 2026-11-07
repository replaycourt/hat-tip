# The page

*Draft for the README section "The page". Numbers in mock mode are made up; the live page reads them from testnet.*

A static page with no build step, no wallet and no third-party code. It shows one community, the demo *Repair Café*, as its Sputnik DAO and the Hat Tip contract see it, and lets a visitor take part as a guest.

## What a visitor sees

**In 20 seconds.** The round that is running: a countdown, the round's budget and what the DAO holds. Each member is a card with this round's note ("fixed two kettles and a lamp"), the thanks received so far, and what they would be paid if the round closed now, with the tier that payout would land in. Below, the last round's payouts in three columns: *Paid automatically*, *Needs one council vote*, *Needs a council majority*. Each payout card carries its DAO proposal number. One button: *Give your 100 thanks*.

**In 2 minutes.**
1. *Give your 100 thanks* makes a key in the browser and takes a guest seat; there is no wallet prompt. Tap +10 or drag a slider on the people whose work you value. While you do, every card's payout preview and tier move. A short line under a card says why the counted thanks differ from the given ones, for example "Thanked each other 40 with Gus: counted 20 each way."
2. Add a note and send. The house members thank guests who write a note and give thanks. If they thank you, your own payout preview shows up.
3. At the close, the page plays the close in five steps: thanks counted, budget split, proposals filed, approvals. Then the payouts move through the DAO. Tier 1 is paid at once by the contract's own vote. A tier-2 payout waits for one council member. A tier-3 payout needs two of three. A rejected payout is struck through and costs its receiver that round's points.
4. Open any member (*rep … ›*) to see their record: reputation over the rounds, every round's points with the givers behind them (given → counted), every payout with its tier, DAO proposal and status, and the auto and co-sign limits for the next close.
5. Open a proposal number to read the proposal live from the DAO: kind, amount, receiver and votes.
6. *Ledger of rounds*: every closed round, who gave how much to whom and what counted, and what it paid in each tier.
7. *The same thanks, counted twice* (a simulation, labelled as such): the café's house community over 36 rounds of `sim/replay.json`, every thanks counted plainly and with the rules, side by side and round by round. Each person's bar is the tUSD paid so far, its tick what their share of the work would have earned: with plain counting the colluding pair takes 23 % of the payouts for 17 % of the work, with the rules 20.5 %. Below, the simulation's bigger communities: the colluders' excess share falls from +3.5 / +13.8 / +17.9 points (pair / ring of three / ring of four) to −0.7 / +2.0 / +5.4. It also says what the rules do not do: free riders keep a little more, and an honest pair pays about 11 % of its payout. The module and its data load only when the replay is opened; `scripts/replay-data.mjs` derives the data from `sim/`, and a test fails if they drift apart.
8. *How it works* states the rules from the contract's `config()` and the three tiers as the DAO's `get_policy` states them.
9. *Proof*: the contract and the token have 0 access keys; their code hashes against `WASM_SHA256` in this repository; the DAO policy checked live (no `Everyone` role, only the contract's role may file call proposals, the three thresholds); the contract's `audit()`; the relay keys and the methods they may call; every transaction this tab sent.

House members are demo accounts run by a script with a published strategy. Every one of them carries a visible label on its card ("house bot · honest helper", "house bot · demo: colluding pair", "house bot · demo: free rider", "house bot · council") and a bot mark on payouts and votes.

## Run it

Any static file server works:

```sh
cd web
python3 -m http.server 8000 --bind 127.0.0.1
# open http://127.0.0.1:8000/?mock=1
```

- `?mock=1` plays a made-up Repair Café in the tab with no network at all: house members post notes and give thanks during the round, the round closes on the clock with the same counting as the contract, payouts go to a stand-in DAO with the demo policy, and the house council votes by its published rule. A banner says it is mock data. Knobs: `&round=<seconds>` (length of a round, default 180), `&at=<0..0.95>` (how far the round is at load, default 0.6), `&seed=<n>`.
- Without `?mock=1` the page reads NEAR testnet. `?contract=stage` uses the staging deployment (`thanks.hat-tip-stage.testnet`, 5-minute rounds) instead of the final one.
- Until `js/config.js` names a contract, the live page says the contract is not deployed yet and offers the mock. Today that is the default (`final`); the staging deployment is filled in.
- The round length, the budget and every rule on the page come from the contract's `config()`; nothing about them is written into the page.

Tests (Node 20 or later, no packages):

```sh
node --test 'web/test/*.test.mjs'
```

They cover the counting port against every golden vector of the simulation (`sim/golden/*.json`), the preview against the close, the tiers, giving and its refusals, the signing text, the DAO policy checks, proposals, records and formatting, a full mock round with all three tiers and a paid guest, the RPC client and gas pool, and the page's promises about itself (strict CSP, no inline code or styles, nothing private shipped).

## Wiring it to the contract

Everything that names a deployment is in `js/config.js`. Fill its `final` (and `stage`) entry from `deploy/testnet.json`:

| deploy/testnet.json | config.js |
|---|---|
| `contract` | `contract` |
| `gas` and its public function-call keys | `gasAccount`, `gasKeys` |
| `code_hashes.contract`, `code_hashes.token` | `codeHash`, `tokenCodeHash` |
| `house.members[].strategy`, `house.council` | `house: { account: kind }` |
| the transaction that deleted the last key | `lockTx` |

The DAO and the token are read from the contract's `config()`. If the RPC hosts change, `connect-src` in `index.html` must change with them (a test checks it).

What the page reads: the contract's `config`, `state`, `round`, `member`, `payouts` and `audit`; the DAO's `get_policy` and `get_proposals` (a removed proposal is deleted by Sputnik, so it reads ranges); the token's `ft_balance_of` for the DAO and the guest; `view_access_key_list` and `view_account` for the proof. What it sends, through the relay keys: `act` (a guest's `join` with a note, and `allocate`, each signed by the browser key over `hattip:v1:<contract>:<nonce>:<action>`), and, only when the house script is late, `close_round` and `pay`.

Gas the page attaches, from the contract's own needs (it refuses less and names the figure; a test recomputes them from `contract/src/config.rs`): `act` 30 Tgas (burns about 3), `close_round` 255 (needs 250 + 5), `check_payout` 140 (needs 135 + 5), `pay` 300 (40 to 130 per payout; files as many as fit). A relay key's 1 NEAR allowance covers the prepaid gas of the dearest call (300 Tgas, 0.3 NEAR at the pessimistic price). The RPC client keeps at most four calls on the wire and lets a host that answers HTTP 429 rest for 30 seconds while the other one serves.

## How it is built

| File | What it does |
|---|---|
| `index.html` | the page; a strict Content Security Policy (`default-src 'self'`, no inline scripts or styles) |
| `css/style.css` | the look: warm paper, ink, copper for thanks, one quiet colour per tier; no web fonts |
| `js/config.js` | the deployments, RPC hosts, gas |
| `js/logic.js` | pure functions: the round close in the contract's integer arithmetic (a port of `sim/hat_tip_sim.py`), the preview, explanations, tiers, giving, signing text, policy checks, proposals, records, formatting |
| `js/near.js`, `js/chain.js` | base58, borsh, Ed25519 in WebCrypto, RPC with a fallback host, the gas pool and the guest's key; the client for the contract, its DAO and its token |
| `js/mock.js` | the made-up community for `?mock=1`, with the same client methods and JSON shapes |
| `js/replay.js`, `js/replay-data.js` | the second replay (loaded on demand); the data is generated by `scripts/replay-data.mjs` from `sim/` |
| `js/ui.js`, `js/main.js` | rendering and the page's flow |
| `test/*.test.mjs` | `node --test` |

The NEAR layer, the gas pool, the proof drawer and the test layout are taken over from Bonfire, an earlier entry by the same author.

## Checked against staging

In headless Chrome against `?contract=stage` (desktop 1440×900 and phone 390×844), with no console errors and no CSP report: a guest arrives, gives thanks, sees the preview move, and the two `act` transactions land on chain (the round's gifts and note name the guest); the page closes due rounds through the relay; the close of the guest's round plays its five steps; the last round with payouts shows all three tiers with their DAO proposals (tier 1 paid at once, a tier-2 payout removed by the council with its strike, tier 3 approved by two council members); a member's record, a DAO proposal read live, the rules from `get_policy` and the proof drawer (code hashes match `WASM_SHA256`; staging keeps its keys, which the drawer says) all read correctly. Screenshots: `docs/shots/`.

## Not yet

- The final deployment: `DEPLOYMENTS.final` stays empty until the launch.
- The mock plays the launch parameters and house strategies of `sim/params.json`, with a round of three minutes by default so that a close comes soon.
