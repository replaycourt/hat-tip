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
7. *How it works* states the rules from the contract's `config()` and the three tiers as the DAO's `get_policy` states them.
8. *Proof*: the contract and the token have 0 access keys; their code hashes against `WASM_SHA256` in this repository; the DAO policy checked live (no `Everyone` role, only the contract's role may file call proposals, the three thresholds); the contract's `audit()`; the relay keys and the methods they may call; every transaction this tab sent.

House members are demo accounts run by a script with a published strategy. Every one of them carries a visible label on its card ("house bot · honest helper", "house bot · demo: colluding pair", "house bot · demo: free rider", "house bot · council") and a bot mark on payouts and votes.

## Run it

Any static file server works:

```sh
cd web
python3 -m http.server 8000 --bind 127.0.0.1
# open http://127.0.0.1:8000/?mock=1
```

- `?mock=1` plays a made-up Repair Café in the tab with no network at all: house members post notes and give thanks during the round, the round closes on the clock with the same counting as the contract, payouts go to a stand-in DAO with the demo policy, and the house council votes by its published rule. A banner says it is mock data. Knobs: `&round=<seconds>` (length of a round, default 180), `&at=<0..0.95>` (how far the round is at load, default 0.6), `&seed=<n>`.
- Without `?mock=1` the page reads NEAR testnet. `?contract=stage` uses the staging deployment instead of the final one.
- Until `js/config.js` names a contract, the live page says the contract is not deployed yet and offers the mock.

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

What the page reads: the contract's `config`, `state`, `round`, `member`, `payouts` and `audit`; the DAO's `get_policy` and `get_proposal`; the token's `ft_balance_of` for the DAO and the guest; `view_access_key_list` and `view_account` for the proof. What it sends, through the relay keys: `act` (a guest's `join` with a note, and `allocate`, each signed by the browser key over `hattip:v1:<contract>:<nonce>:<action>`), and, only when the house script is late, `close_round` and `pay`.

## How it is built

| File | What it does |
|---|---|
| `index.html` | the page; a strict Content Security Policy (`default-src 'self'`, no inline scripts or styles) |
| `css/style.css` | the look: warm paper, ink, copper for thanks, one quiet colour per tier; no web fonts |
| `js/config.js` | the deployments, RPC hosts, gas |
| `js/logic.js` | pure functions: the round close in the contract's integer arithmetic (a port of `sim/hat_tip_sim.py`), the preview, explanations, tiers, giving, signing text, policy checks, proposals, records, formatting |
| `js/near.js`, `js/chain.js` | base58, borsh, Ed25519 in WebCrypto, RPC with a fallback host, the gas pool and the guest's key; the client for the contract, its DAO and its token |
| `js/mock.js` | the made-up community for `?mock=1`, with the same client methods and JSON shapes |
| `js/ui.js`, `js/main.js` | rendering and the page's flow |
| `test/*.test.mjs` | `node --test` |

The NEAR layer, the gas pool, the proof drawer and the test layout are taken over from Bonfire, an earlier entry by the same author.

## Not yet

- The live mode has run only against mock data and unit tests; it needs the deployed contract (`deploy/testnet.json`) and its final view shapes.
- The second replay of DESIGN.md (the same community with and without dampening) waits for the simulation's replay file.
- The mock uses demo parameters of its own; the live page shows whatever the contract's `config()` says.
