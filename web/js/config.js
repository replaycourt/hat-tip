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
    contract: 'thanks.hat-tip-stage.testnet',
    gasAccount: 'hat-tip-gas.testnet',
    codeHash: 'ApXWMjk6wgykDyEdNAPBagSNYZHnvMwioQcqpykZKGQw',
    tokenCodeHash: '41kVaTjWBmhriofB8Q3QKzZNCWdE7TNqVhPiRe8eHFip',
    lockTx: null,
    // PUBLIC on purpose: function-call keys of hat-tip-gas.testnet that may only call `act`,
    // `close_round`, `pay`, `check_payout` and `sync` on thanks.hat-tip-stage.testnet, 1 NEAR allowance each
    // (see the comment at the top).
    gasKeys: [
      { public_key: 'ed25519:59Ny8fFy7dDvJfbsWDVDiSyw764ekieddqXq2Mq8GNC2', private_key: 'ed25519:3Ukjh3p2sxjfSmF7FsCgyxm4HQ9NHgh6HDCQWqWGt19jxcCofVsUAG7Bm8ZWghPyaPwvB8CpanY5STkiq45maaJN' },
      { public_key: 'ed25519:G27BzzhsmcuNTWRmrmyLcX4rY36AV5NQrqk5FNxRcirM', private_key: 'ed25519:ELWQohMziu6wscZo4tseBQURxnCJViqruC8XbBRp2JCBtYyDwJSW5VYQC6k4J6MLDD6rPrMy8dpk6FXi8SXXEdX' },
      { public_key: 'ed25519:79AggFigia8tgxCoH959D9ospUb3DkpEomhE4wfxzz7i', private_key: 'ed25519:4nA4tzmQygmi3aeNasTVCc3q7Z6wVWdGU3pFEunQXqfS3mK5pVnJztp6A3aZtzUifJAvXe7BTzgm3xCLzNZt5heG' },
      { public_key: 'ed25519:A9r2t8ugcwZaedXegmpaySejrWL799P5CrbgMy3qjFVz', private_key: 'ed25519:xfoqGK6Jfiv6MgCj6t3Vp4PUw3mtG5DNwF2zBFpCMf1fvzYgGeCi4aCj9jWGdNWTaiX3vpELS2cKXw1nnRVUcSC' },
      { public_key: 'ed25519:34u8CT9KdiA5MGCHeTbVZc1z5WgN9tTRDZHx5gqtYB7X', private_key: 'ed25519:3nLkkg7UAbqjZV5hSkK5ANhQdb13V1DKr9xqY4mY6c9eTEQszM15gn54KJ7LAgCBUnwxRkGfaGvEe1MoTZoosGhF' },
      { public_key: 'ed25519:5BRXKdLU5aAzMbYibxuafNV1SMTbgdt1aTy4QgTE8PAn', private_key: 'ed25519:47MWrSfPxVymrcQyFvP69wM5CjQCxUFnMn3cmomePwsvHUhS3LV1C4iJGQnx7AxNPMVit1xWKsatYPrHBJMUiFbt' },
      { public_key: 'ed25519:5cdCXh5DCjQeZZx1RNWNuFzEiu86GFtynaZdtFWXXpU4', private_key: 'ed25519:AkB6vYf7rUnH5dmyEXjmnYnFLB7YuGiLKco2AScXtifppRHKvKpeq6Eg9S99GtrFifXbxTM3QRdVDp9J2JDQW3n' },
      { public_key: 'ed25519:BNJBPfw5oDQ1UGtPWspNzdGkMLZ615QS3H5mDC4hL5Up', private_key: 'ed25519:58FTLC1RaZ7t2RVTxH9CgNjekJkpc8BfH4rBiwXfDSbjbu94gDu4md35xm2aUp71RaH2jToK9rXtEhkqTy43AQL4' },
    ],
    // The labelled house members and council (deploy/testnet.json, house; sim/params.json).
    house: {
      'ana.hat-tip-stage.testnet': 'honest',
      'ben.hat-tip-stage.testnet': 'honest',
      'cleo.hat-tip-stage.testnet': 'honest',
      'dina.hat-tip-stage.testnet': 'honest',
      'emil.hat-tip-stage.testnet': 'honest',
      'finn.hat-tip-stage.testnet': 'pair',
      'gus.hat-tip-stage.testnet': 'pair',
      'hugo.hat-tip-stage.testnet': 'free_rider',
      'council-a.hat-tip-stage.testnet': 'council',
      'council-b.hat-tip-stage.testnet': 'council',
      'council-c.hat-tip-stage.testnet': 'council',
    },
  },
}

export const DEFAULT = 'final'
export const COMMUNITY = 'Repair Café'

export const NETWORK = 'testnet'
export const RPC_HOSTS = ['https://test.rpc.fastnear.com', 'https://near-testnet.drpc.org']
export const EXPLORER = 'https://testnet.nearblocks.io'
export const REPO = 'https://github.com/replaycourt/hat-tip'

/**
 * Gas attached to relayed calls. The contract refuses a call with less than it needs and names
 * the figure ("this call needs N Tgas"); test/config.test.mjs recomputes the needs from the
 * constants in contract/src/config.rs. Burnt on stage (docs/testnet-stage.md): act 3, close 15,
 * pay about 6-18 per payout, check 7.5. Unused gas is refunded; a relay key's allowance (1 NEAR)
 * must only cover the prepaid gas of one call at the pessimistic gas price (PAY_GAS: 0.3 NEAR).
 */
export const ACT_GAS = 30_000_000_000_000n // no cross-contract call; burns about 3 Tgas
export const CLOSE_GAS = 255_000_000_000_000n // need 2 x 20 link + 10 get_policy + 5 ft_balance_of + 180 on_close + 15 margin = 250, +5
export const PAY_GAS = 300_000_000_000_000n // files as many payouts as fit, 45-135 Tgas each (+15 margin)
export const CHECK_GAS = 140_000_000_000_000n // need 20 link + 10 get_proposals + 90 on_checked + 15 margin = 135, +5
/** Payouts one relayed `pay` asks for; the contract files only as many as PAY_GAS covers. */
export const PAY_MAX = 10

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
