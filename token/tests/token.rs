//! tUSD in the SDK's mock VM: the one mint at init, transfers, registration, metadata.

use near_contract_standards::fungible_token::core::FungibleTokenCore;
use near_contract_standards::fungible_token::metadata::{
    FT_METADATA_SPEC, FungibleTokenMetadata, FungibleTokenMetadataProvider,
};
use near_contract_standards::storage_management::StorageManagement;
use near_parameters::RuntimeFeesConfig;
use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, Value};
use near_sdk::test_utils::{VMContextBuilder, get_logs};
use near_sdk::{AccountId, MockedBlockchain, NearToken, testing_env};
use tusd::Token;

const DAO: &str = "cafe.sputnikv2.testnet";
const SUPPLY: u128 = 1_000_000 * 1_000_000;

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn context(who: &str, deposit: u128) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc("tusd.testnet"))
        .predecessor_account_id(acc(who))
        .signer_account_id(acc(who))
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .account_balance(NearToken::from_near(10));
    testing_env!(b.build());
}

fn metadata() -> FungibleTokenMetadata {
    FungibleTokenMetadata {
        spec: FT_METADATA_SPEC.to_string(),
        name: "Test dollar (Hat Tip demo, no value)".into(),
        symbol: "tUSD".into(),
        icon: None,
        reference: None,
        reference_hash: None,
        decimals: 6,
    }
}

fn fresh() -> Token {
    near_sdk::env::set_blockchain_interface(MockedBlockchain::new(
        VMContextBuilder::new().build(),
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        Vec::new(),
        Default::default(),
        Default::default(),
        None,
    ));
    context("tusd.testnet", 0);
    Token::new(acc(DAO), U128(SUPPLY), metadata())
}

fn events(standard: &str) -> Vec<Value> {
    get_logs()
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|j| serde_json::from_str::<Value>(j).unwrap())
        .filter(|v| v["standard"] == standard)
        .collect()
}

#[test]
fn init_mints_the_whole_supply_to_the_dao_once() {
    let t = fresh();
    let e = events("nep141");
    assert_eq!(e.len(), 1);
    assert_eq!(e[0]["event"], "ft_mint");
    assert_eq!(e[0]["data"][0]["owner_id"], DAO);
    assert_eq!(e[0]["data"][0]["amount"], SUPPLY.to_string());
    assert_eq!(t.ft_total_supply().0, SUPPLY);
    assert_eq!(t.ft_balance_of(acc(DAO)).0, SUPPLY);
    assert!(t.storage_balance_of(acc(DAO)).is_some());
    let m = t.ft_metadata();
    assert_eq!((m.symbol.as_str(), m.decimals), ("tUSD", 6));
}

#[test]
fn registration_costs_what_the_contract_attaches() {
    let t = fresh();
    // The thanks contract attaches 0.00125 NEAR (`REGISTRATION_DEPOSIT`).
    assert_eq!(t.storage_balance_bounds().min.as_yoctonear(), 1_250_000_000_000_000_000_000);
}

#[test]
fn transfers_need_one_yocto_and_a_registered_receiver() {
    let mut t = fresh();
    let ana = acc("ana.cafe.testnet");
    context("relayer.testnet", 1_250_000_000_000_000_000_000);
    t.storage_deposit(Some(ana.clone()), Some(true));
    context(DAO, 1);
    t.ft_transfer(ana.clone(), U128(15_000_000), Some("Hat Tip r1".into()));
    assert_eq!(t.ft_balance_of(ana.clone()).0, 15_000_000);
    assert_eq!(t.ft_balance_of(acc(DAO)).0, SUPPLY - 15_000_000);
    let e = events("nep141");
    assert_eq!(e[0]["event"], "ft_transfer");
    context(DAO, 0);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| t.ft_transfer(ana.clone(), U128(1), None)));
    assert!(r.is_err(), "no yocto attached");
    // Registering again refunds the deposit and changes nothing.
    context("relayer.testnet", 1_250_000_000_000_000_000_000);
    t.storage_deposit(Some(ana.clone()), Some(true));
    assert_eq!(t.ft_balance_of(ana).0, 15_000_000);
}

#[test]
#[should_panic(expected = "is not registered")]
fn an_unregistered_receiver_cannot_receive() {
    let mut t = fresh();
    context(DAO, 1);
    t.ft_transfer(acc("ana.cafe.testnet"), U128(5), None);
}

#[test]
fn a_forced_unregister_burns_and_says_so() {
    let mut t = fresh();
    let ana = acc("ana.cafe.testnet");
    context("relayer.testnet", 1_250_000_000_000_000_000_000);
    t.storage_deposit(Some(ana.clone()), Some(true));
    context(DAO, 1);
    t.ft_transfer(ana.clone(), U128(7), None);
    context("ana.cafe.testnet", 1);
    assert!(t.storage_unregister(Some(true)));
    let e = events("nep141");
    assert_eq!(e[0]["event"], "ft_burn");
    assert_eq!(e[0]["data"][0]["amount"], "7");
    assert_eq!(t.ft_total_supply().0, SUPPLY - 7);
}

#[test]
#[should_panic]
fn bad_metadata_is_refused() {
    near_sdk::env::set_blockchain_interface(MockedBlockchain::new(
        VMContextBuilder::new().build(),
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        Vec::new(),
        Default::default(),
        Default::default(),
        None,
    ));
    context("tusd.testnet", 0);
    let mut m = metadata();
    m.spec = "ft-0.9".into();
    Token::new(acc(DAO), U128(SUPPLY), m);
}
