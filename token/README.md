# tUSD (test token)

The Hat Tip demo's test dollar: a minimal NEP-141 token (NEP-145 storage management, NEP-148
metadata) built from near-contract-standards 5.30. `new` mints the whole supply once, to the
community's DAO. There is no owner, no mint, no admin and no upgrade method; after deployment the
account has no keys. It has no value.

## Init

`new(owner_id: AccountId, total_supply: U128, metadata: FungibleTokenMetadata)`, `#[init]`,
`#[private]` (runs in the deployment transaction). It registers `owner_id`, credits it the whole
supply and logs one `ft_mint`. The metadata must be valid and have `spec` `ft-1.0.0`; the demo
uses

```json
{"owner_id": "<dao>", "total_supply": "1000000000000",
 "metadata": {"spec": "ft-1.0.0", "name": "Test dollar (Hat Tip demo, no value)", "symbol": "tUSD",
              "icon": null, "reference": null, "reference_hash": null, "decimals": 6}}
```

(1,000,000 tUSD at 6 decimals.)

## Methods

Exactly the standard ones (the build fails on anything else): `ft_transfer`,
`ft_transfer_call`, `ft_total_supply`, `ft_balance_of`, `ft_resolve_transfer` (private
callback), `ft_metadata`, `storage_deposit`, `storage_withdraw`, `storage_unregister`,
`storage_balance_bounds`, `storage_balance_of`, plus `contract_source_metadata` (NEP-330) and the
embedded ABI. Registration costs `storage_balance_bounds().min` = 0.00125 NEAR, the amount the
thanks contract attaches before a receiver's first payout. A receiver that is not registered
cannot receive: the DAO's transfer to it fails (the thanks contract registers it and retries,
see ../contract/README.md). The only way the supply shrinks is NEP-145's
`storage_unregister(force: true)` by a holder, which burns that holder's balance and logs
`ft_burn`.

## Build and test

```sh
./build.sh            # privacy-checked wasm, export check, writes WASM_SHA256
./build.sh --check    # the same, and compares with WASM_SHA256
cargo test
```
