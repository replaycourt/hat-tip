//! tUSD: the Hat Tip demo's test dollar. A minimal NEP-141 fungible token (with NEP-145 storage
//! management and NEP-148 metadata) from near-contract-standards. `new` mints the whole, fixed
//! supply to one account (the community's DAO) and that is the only mint there will ever be:
//! there is no owner, no mint, no admin and no upgrade method. The supply only shrinks when an
//! account force-unregisters with a balance (NEP-145), which burns it. It has no value.

use near_contract_standards::fungible_token::core::FungibleTokenCore;
use near_contract_standards::fungible_token::events::{FtBurn, FtMint};
use near_contract_standards::fungible_token::metadata::{
    FT_METADATA_SPEC, FungibleTokenMetadata, FungibleTokenMetadataProvider,
};
use near_contract_standards::fungible_token::resolver::FungibleTokenResolver;
use near_contract_standards::fungible_token::{Balance, FungibleToken};
use near_contract_standards::storage_management::{StorageBalance, StorageBalanceBounds, StorageManagement};
use near_sdk::borsh::BorshSerialize;
use near_sdk::collections::LazyOption;
use near_sdk::json_types::U128;
use near_sdk::{AccountId, BorshStorageKey, NearToken, PanicOnDefault, PromiseOrValue, env, log, near, require};

#[derive(BorshSerialize, BorshStorageKey)]
#[borsh(crate = "near_sdk::borsh")]
enum Key {
    Accounts,
    Metadata,
}

#[near(
    contract_state,
    contract_metadata(
        standard(standard = "nep141", version = "1.0.0"),
        standard(standard = "nep145", version = "1.0.0"),
        standard(standard = "nep148", version = "1.0.0")
    )
)]
#[derive(PanicOnDefault)]
pub struct Token {
    token: FungibleToken,
    metadata: LazyOption<FungibleTokenMetadata>,
}

#[near]
impl Token {
    /// Mints `total_supply` to `owner_id` (registered here) and stores the metadata. Runs once, as
    /// part of the deployment.
    #[init]
    #[private]
    pub fn new(owner_id: AccountId, total_supply: U128, metadata: FungibleTokenMetadata) -> Self {
        metadata.assert_valid();
        require!(metadata.spec == FT_METADATA_SPEC, "metadata spec must be ft-1.0.0");
        require!(total_supply.0 > 0, "total_supply must be positive");
        let mut t = Self {
            token: FungibleToken::new(Key::Accounts),
            metadata: LazyOption::new(Key::Metadata, Some(&metadata)),
        };
        t.token.internal_register_account(&owner_id);
        t.token.internal_deposit(&owner_id, total_supply.0);
        FtMint { owner_id: &owner_id, amount: total_supply, memo: Some("fixed supply, minted once at init") }.emit();
        t
    }
}

#[near]
impl FungibleTokenCore for Token {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        self.token.ft_transfer(receiver_id, amount, memo)
    }

    #[payable]
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }

    fn ft_total_supply(&self) -> U128 {
        self.token.ft_total_supply()
    }

    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token.ft_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenResolver for Token {
    #[private]
    fn ft_resolve_transfer(&mut self, sender_id: AccountId, receiver_id: AccountId, amount: U128) -> U128 {
        let (used, burned): (Balance, Balance) =
            self.token.internal_ft_resolve_transfer(&sender_id, receiver_id, amount);
        if burned > 0 {
            log!("Account @{} burned {}", sender_id, burned);
        }
        used.into()
    }
}

#[near]
impl StorageManagement for Token {
    #[payable]
    fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }

    /// Unregisters the caller. With `force`, a remaining balance is burned (NEP-145); the supply
    /// shrinks by it and an `ft_burn` event says so.
    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        if let Some((account_id, balance)) = self.token.internal_storage_unregister(force) {
            if balance > 0 {
                FtBurn { owner_id: &account_id, amount: U128(balance), memo: Some("storage_unregister(force)") }.emit();
            }
            true
        } else {
            false
        }
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for Token {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        self.metadata.get().unwrap_or_else(|| env::abort())
    }
}
