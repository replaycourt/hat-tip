// Everything that ties this page to one deployment, in one place. To wire the page to the real
// contract, fill in DEPLOYMENTS from deploy/testnet.json (I-4); nothing else in web/ names an account.
//
//   deploy/testnet.json            here
//   contract                    -> contract
//   gas (the gas account)       -> gasAccount, and its public function-call keys -> gasKeys
//   code_hashes.contract/token  -> codeHash / tokenCodeHash (base58, as view_account reports them)
//   house.members / council     -> house: { account: strategy kind }
//   txs (the last key deletion) -> lockTx
// The DAO and the token are not listed: the page reads them from the contract's config().
//
// Guests never see a wallet. Their browser makes an Ed25519 key, and every action is signed with
// that key and relayed through the contract's `act` method. The relaying transaction is paid by the
// deployment's gas account, through public function-call keys that may ONLY call `act`,
// `close_round`, `pay`, `check_payout` and `sync` on the contract, with a capped allowance. They
// cannot move NEAR, touch any other contract or act for a guest (`act` checks the guest's own
// signature). The worst anyone can do with them is burn the allowance.
//
// Which deployment: DEFAULT below, or `?contract=stage` / `?contract=final` (only these names).
// `?mock=1` plays a made-up community in the browser instead (js/mock.js), with no network at all.
// RPC_HOSTS must match `connect-src` in index.html (test/config.test.mjs checks that).

export const DEPLOYMENTS = {
  final: {
    contract: null,
    gasAccount: null,
    codeHash: null,
    tokenCodeHash: null,
    lockTx: null,
    // PUBLIC on purpose once filled: function-call keys of the gas account (see the top).
    gasKeys: [],
    house: {},
  },
  stage: {
    contract: null,
    gasAccount: null,
    codeHash: null,
    tokenCodeHash: null,
    lockTx: null,
    gasKeys: [],
    house: {},
  },
}

export const DEFAULT = 'final'
export const COMMUNITY = 'Repair Café'

export const NETWORK = 'testnet'
export const RPC_HOSTS = ['https://test.rpc.fastnear.com', 'https://near-testnet.drpc.org']
export const EXPLORER = 'https://testnet.nearblocks.io'
export const REPO = 'https://github.com/replaycourt/hat-tip'

/** Gas attached to relayed calls (contract/README.md, "Gas"). */
export const ACT_GAS = 30_000_000_000_000n
export const CLOSE_GAS = 255_000_000_000_000n
export const PAY_GAS = 300_000_000_000_000n
export const CHECK_GAS = 135_000_000_000_000n

/** The deployment named by `?contract=` if it is one of DEPLOYMENTS, else DEFAULT. */
export function pickDeployment(search = globalThis.location?.search ?? '') {
  const name = new URLSearchParams(search).get('contract')
  const key = name && Object.hasOwn(DEPLOYMENTS, name) ? name : DEFAULT
  return { name: key, ...DEPLOYMENTS[key] }
}

export const DEPLOYMENT = pickDeployment()
export const CONTRACT = DEPLOYMENT.contract
export const GAS_ACCOUNT = DEPLOYMENT.gasAccount
export const GAS_KEYS = DEPLOYMENT.gasKeys
