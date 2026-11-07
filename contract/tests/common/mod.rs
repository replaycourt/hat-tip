//! Shared harness: the real contract in the SDK's mock VM, a clock, browser keys with real
//! ed25519 signatures, and a model of the Sputnik v2 DAO and the tUSD token that executes every
//! receipt the contract creates and feeds the answers back into its callbacks.
//!
//! The DAO model follows sputnik-dao-contract 2.3.1 where the contract depends on it:
//! `add_proposal` needs the bond exactly and `<kind>:AddProposal`; `act_proposal` checks the
//! permission and that the kind matches; a vote counts in every role of the voter that allows it
//! and a role passes at its threshold (council: 2 of 3 by default, 1 for `call`; thanks: 1 of 1
//! for `transfer`); approval executes the transfer (failing if the receiver is not registered
//! with the token); `Remove` deletes the proposal; `Finalize` expires an overdue proposal or
//! re-runs a failed one; an expired proposal can no longer be voted on.
#![allow(dead_code)]

use ed25519_dalek::{Signer, SigningKey};
use hat_tip::config::*;
use hat_tip::types::*;
use hat_tip::views::*;
use hat_tip::{HatTip, signing_message};
use near_parameters::RuntimeFeesConfig;
use near_parameters::vm::Config as VmConfig;
use near_sdk::base64::Engine;
use near_sdk::base64::engine::general_purpose::STANDARD;
use near_sdk::json_types::U128;
use near_sdk::mock::MockAction;
use near_sdk::serde_json::{self, Value, json};
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{AccountId, Gas, MockedBlockchain, NearToken, PromiseOrValue, PromiseResult, testing_env};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::sync::OnceLock;

pub const CONTRACT: &str = "hattip.testnet";
pub const DAO: &str = "cafe.sputnikv2.testnet";
pub const TOKEN: &str = "tusd.testnet";
pub const ROUND_MS: u64 = 1_200_000;
pub const GENESIS_MS: u64 = 1_800_000_000_000;
/// One tUSD (6 decimals).
pub const USD: u128 = 1_000_000;
pub const BOND: u128 = 10_000_000_000_000_000_000_000;
pub const PERIOD_NS: u64 = 86_400_000_000_000;

pub fn acc(name: &str) -> AccountId {
    name.parse().unwrap()
}

pub fn contract_id() -> AccountId {
    acc(CONTRACT)
}

/// The demo community: eight members and a council of three.
pub fn member(name: &str) -> AccountId {
    acc(&format!("{name}.cafe.testnet"))
}

pub const NAMES: [&str; 8] = ["ana", "ben", "cai", "dan", "eva", "fay", "gus", "hal"];

pub fn members() -> Vec<AccountId> {
    NAMES.iter().map(|n| member(n)).collect()
}

pub fn council() -> Vec<AccountId> {
    ["council-a", "council-b", "council-c"].iter().map(|n| member(n)).collect()
}

/// Testnet-demo-like values; every dampening rule off (the tests switch them on one by one).
pub fn cfg() -> Config {
    Config {
        dao: acc(DAO),
        token: acc(TOKEN),
        members_role: "members".into(),
        council_role: "council".into(),
        thanks_role: "thanks".into(),
        genesis_ms: GENESIS_MS,
        round_ms: ROUND_MS,
        thanks_per_round: 100,
        cap_per_receiver: 40,
        max_receivers: 10,
        reciprocal_bp: 10_000,
        quadratic: false,
        breadth_k: 0,
        breadth_bp: 10_000,
        idle_bp: 10_000,
        decay_bp: 500,
        round_budget: U128(120 * USD),
        min_payout: U128(2 * USD),
        carry_rounds: 12,
        reserve: U128(0),
        auto_rep_min: 20,
        auto_per_thanks: U128(USD / 2),
        auto_max: U128(15 * USD),
        cosign_base: U128(5 * USD),
        cosign_per_thanks: U128(USD),
        cosign_max: U128(40 * USD),
        auto_share_bp: 6_000,
        guest_seats: 6,
        guest_weight_bp: 5_000,
        guest_cap_bp: 2_000,
        max_members: 24,
        max_catchup: 36,
        log_keep: 108,
        note_max_bytes: 80,
        guest_receive_cap_bp: 10_000,
    }
}

// ---- browser keys --------------------------------------------------------------------------

pub struct Key {
    pub sk: SigningKey,
    pub hex: String,
    pub account: AccountId,
    pub nonce: u64,
}

impl Key {
    pub fn new(i: u32) -> Self {
        let mut seed = [0u8; 32];
        seed[..4].copy_from_slice(&i.to_le_bytes());
        seed[31] = 7;
        let sk = SigningKey::from_bytes(&seed);
        let hex: String = sk.verifying_key().to_bytes().iter().map(|b| format!("{b:02x}")).collect();
        let account = hex.parse().unwrap();
        Self { sk, hex, account, nonce: 0 }
    }

    pub fn sign(&self, contract: &str, nonce: u64, action: &str) -> String {
        let msg = signing_message(contract, nonce, action);
        self.sk.sign(msg.as_bytes()).to_bytes().iter().map(|b| format!("{b:02x}")).collect()
    }
}

// ---- the DAO and the token -----------------------------------------------------------------

#[derive(Clone, Debug)]
pub struct Prop {
    pub proposer: String,
    pub description: String,
    pub kind: Value,
    pub status: String,
    pub submission_ns: u64,
    pub approve: BTreeSet<String>,
    pub reject: BTreeSet<String>,
    pub remove: BTreeSet<String>,
}

#[derive(Clone, Debug)]
pub struct Dao {
    pub members: Vec<String>,
    pub council: Vec<String>,
    pub thanks: Vec<String>,
    pub thanks_perms: Vec<String>,
    pub bond: u128,
    pub period_ns: u64,
    pub proposals: Vec<Option<Prop>>,
    /// The token's ledger.
    pub registered: BTreeSet<String>,
    pub balances: BTreeMap<String, u128>,
    /// Methods that fail (`"get_policy"`, `"dao.act_proposal"`, ...): `<method>` or `<account>.<method>`.
    pub fail: BTreeSet<String>,
    /// Bonds the DAO holds, and bonds it returned to proposers.
    pub bonds_held: u128,
    pub bonds_returned: u128,
    /// Every external call, as `<method>`, in order.
    pub calls: Vec<String>,
}

pub fn thanks_perms() -> Vec<String> {
    ["transfer:AddProposal", "transfer:VoteApprove", "call:AddProposal", "transfer:Finalize", "call:Finalize"]
        .iter()
        .map(|s| s.to_string())
        .collect()
}

fn kind_label(kind: &Value) -> &'static str {
    if kind.get("FunctionCall").is_some() {
        "call"
    } else if kind.get("Transfer").is_some() {
        "transfer"
    } else {
        "other"
    }
}

fn allowed(perms: &[String], kind: &str, action: &str) -> bool {
    perms.iter().any(|p| {
        *p == format!("{kind}:{action}") || *p == format!("{kind}:*") || *p == format!("*:{action}") || p == "*:*"
    })
}

const COUNCIL_PERMS: [&str; 4] = ["*:VoteApprove", "*:VoteReject", "*:VoteRemove", "*:Finalize"];

impl Dao {
    pub fn new(supply: u128) -> Self {
        let mut balances = BTreeMap::new();
        balances.insert(DAO.to_string(), supply);
        Self {
            members: members().iter().map(|a| a.to_string()).collect(),
            council: council().iter().map(|a| a.to_string()).collect(),
            thanks: vec![CONTRACT.to_string()],
            thanks_perms: thanks_perms(),
            bond: BOND,
            period_ns: PERIOD_NS,
            proposals: Vec::new(),
            registered: [DAO.to_string()].into_iter().collect(),
            balances,
            fail: BTreeSet::new(),
            bonds_held: 0,
            bonds_returned: 0,
            calls: Vec::new(),
        }
    }

    pub fn policy_json(&self) -> Value {
        json!({
            "roles": [
                {"name": "council", "kind": {"Group": self.council},
                 "permissions": ["transfer:AddProposal", "*:VoteApprove", "*:VoteReject", "*:VoteRemove", "*:Finalize"],
                 "vote_policy": {"call": {"weight_kind": "RoleWeight", "quorum": "0", "threshold": "1"}}},
                {"name": "thanks", "kind": {"Group": self.thanks}, "permissions": self.thanks_perms,
                 "vote_policy": {"transfer": {"weight_kind": "RoleWeight", "quorum": "0", "threshold": [1, 1]}}},
                {"name": "members", "kind": {"Group": self.members}, "permissions": [], "vote_policy": {}}
            ],
            "default_vote_policy": {"weight_kind": "RoleWeight", "quorum": "0", "threshold": [1, 2]},
            "proposal_bond": self.bond.to_string(),
            "proposal_period": self.period_ns.to_string(),
            "bounty_bond": "1000000000000000000000000",
            "bounty_forgiveness_period": "86400000000000"
        })
    }

    pub fn balance(&self, who: &str) -> u128 {
        self.balances.get(who).copied().unwrap_or(0)
    }

    fn ft_transfer(&mut self, from: &str, to: &str, amount: u128) -> Result<(), String> {
        if !self.registered.contains(to) {
            return Err(format!("The account {to} is not registered"));
        }
        let have = self.balance(from);
        if have < amount {
            return Err("The account doesn't have enough balance".into());
        }
        *self.balances.entry(from.to_string()).or_default() -= amount;
        *self.balances.entry(to.to_string()).or_default() += amount;
        Ok(())
    }

    fn execute(&mut self, id: usize) {
        let p = self.proposals[id].clone().unwrap();
        let result = if let Some(t) = p.kind.get("Transfer") {
            assert_eq!(t["token_id"], TOKEN);
            let amount: u128 = t["amount"].as_str().unwrap().parse().unwrap();
            self.ft_transfer(DAO, t["receiver_id"].as_str().unwrap(), amount)
        } else if let Some(f) = p.kind.get("FunctionCall") {
            assert_eq!(f["receiver_id"], TOKEN);
            let a = &f["actions"][0];
            assert_eq!(a["method_name"], "ft_transfer");
            assert_eq!(a["deposit"], "1");
            let args: Value = serde_json::from_slice(&STANDARD.decode(a["args"].as_str().unwrap()).unwrap()).unwrap();
            let amount: u128 = args["amount"].as_str().unwrap().parse().unwrap();
            self.ft_transfer(DAO, args["receiver_id"].as_str().unwrap(), amount)
        } else {
            Err("unexpected kind".into())
        };
        let prop = self.proposals[id].as_mut().unwrap();
        if result.is_ok() {
            prop.status = "Approved".into();
            self.bonds_held -= self.bond;
            self.bonds_returned += self.bond;
        } else {
            prop.status = "Failed".into();
        }
    }

    fn roles_of(&self, who: &str) -> Vec<(&'static str, Vec<String>)> {
        let mut r = Vec::new();
        if self.council.iter().any(|x| x == who) {
            r.push(("council", COUNCIL_PERMS.iter().map(|s| s.to_string()).collect()));
        }
        if self.thanks.iter().any(|x| x == who) {
            r.push(("thanks", self.thanks_perms.clone()));
        }
        r
    }

    fn threshold(&self, role: &str, kind: &str) -> usize {
        match (role, kind) {
            ("council", "call") => 1,
            ("council", _) => (self.council.len() / 2 + 1).min(self.council.len()),
            ("thanks", "transfer") => 1,
            ("thanks", _) => (self.thanks.len() / 2 + 1).min(self.thanks.len()),
            _ => usize::MAX,
        }
    }

    /// Sputnik's `act_proposal` for a vote, Finalize or remove.
    pub fn act(&mut self, who: &str, id: u64, action: &str, kind: Option<&Value>, now_ns: u64) -> Result<(), String> {
        let id = id as usize;
        let Some(Some(p)) = self.proposals.get(id).cloned() else { return Err("ERR_NO_PROPOSAL".into()) };
        let label = kind_label(&p.kind);
        let roles: Vec<&'static str> =
            self.roles_of(who).into_iter().filter(|(_, perms)| allowed(perms, label, action)).map(|(n, _)| n).collect();
        if roles.is_empty() {
            return Err("ERR_PERMISSION_DENIED".into());
        }
        if let Some(k) = kind
            && *k != p.kind
        {
            return Err("ERR_WRONG_KIND".into());
        }
        let expired = p.submission_ns + self.period_ns < now_ns;
        match action {
            "VoteApprove" | "VoteReject" | "VoteRemove" => {
                if p.status != "InProgress" {
                    return Err("ERR_PROPOSAL_NOT_READY_FOR_VOTE".into());
                }
                let prop = self.proposals[id].as_mut().unwrap();
                match action {
                    "VoteApprove" => prop.approve.insert(who.into()),
                    "VoteReject" => prop.reject.insert(who.into()),
                    _ => prop.remove.insert(who.into()),
                };
                if expired {
                    prop.status = "Expired".into();
                    return Ok(());
                }
                let prop = prop.clone();
                let count = |set: &BTreeSet<String>, role: &str| {
                    set.iter().filter(|v| self.roles_of(v).iter().any(|(n, _)| *n == role)).count()
                };
                for role in ["council", "thanks"] {
                    let t = self.threshold(role, label);
                    if count(&prop.approve, role) >= t {
                        self.execute(id);
                        return Ok(());
                    } else if count(&prop.reject, role) >= t {
                        self.proposals[id].as_mut().unwrap().status = "Rejected".into();
                        self.bonds_held -= self.bond;
                        self.bonds_returned += self.bond;
                        return Ok(());
                    } else if count(&prop.remove, role) >= t {
                        self.proposals[id] = None;
                        return Ok(());
                    }
                }
                Ok(())
            }
            "Finalize" => {
                if !matches!(p.status.as_str(), "InProgress" | "Failed") {
                    return Err("ERR_PROPOSAL_NOT_IN_PROGRESS".into());
                }
                if expired {
                    self.proposals[id].as_mut().unwrap().status = "Expired".into();
                    self.bonds_held -= self.bond;
                    self.bonds_returned += self.bond;
                    return Ok(());
                }
                if p.status == "Failed" {
                    self.execute(id);
                    return Ok(());
                }
                Err("ERR_PROPOSAL_NOT_EXPIRED_OR_FAILED".into())
            }
            _ => Err("ERR_WRONG_ACTION".into()),
        }
    }

    /// One external call. `Err` is a failed receipt.
    pub fn handle(
        &mut self,
        receiver: &str,
        method: &str,
        args: &[u8],
        deposit: u128,
        from: &str,
        now_ns: u64,
    ) -> Result<Vec<u8>, String> {
        self.calls.push(method.to_string());
        if self.fail.contains(method) || self.fail.contains(&format!("{receiver}.{method}")) {
            return Err(format!("{method} forced to fail"));
        }
        let a: Value = serde_json::from_slice(args).map_err(|e| e.to_string())?;
        let out = |v: Value| Ok(v.to_string().into_bytes());
        match (receiver, method) {
            (DAO, "get_policy") => out(self.policy_json()),
            (DAO, "add_proposal") => {
                if deposit != self.bond {
                    return Err("ERR_MIN_BOND".into());
                }
                let kind = a["proposal"]["kind"].clone();
                let label = kind_label(&kind);
                if !self.roles_of(from).iter().any(|(_, perms)| allowed(perms, label, "AddProposal")) {
                    return Err("ERR_PERMISSION_DENIED".into());
                }
                self.proposals.push(Some(Prop {
                    proposer: from.into(),
                    description: a["proposal"]["description"].as_str().unwrap().into(),
                    kind,
                    status: "InProgress".into(),
                    submission_ns: now_ns,
                    approve: BTreeSet::new(),
                    reject: BTreeSet::new(),
                    remove: BTreeSet::new(),
                }));
                self.bonds_held += deposit;
                out(json!(self.proposals.len() - 1))
            }
            (DAO, "act_proposal") => {
                let obj = a.as_object().unwrap();
                for k in obj.keys() {
                    assert!(["id", "action", "proposal", "memo"].contains(&k.as_str()), "unknown argument {k}");
                }
                self.act(from, a["id"].as_u64().unwrap(), a["action"].as_str().unwrap(), Some(&a["proposal"]), now_ns)?;
                Ok(Vec::new())
            }
            (DAO, "get_proposals") => {
                let id = a["from_index"].as_u64().unwrap() as usize;
                let list: Vec<Value> = self
                    .proposals
                    .get(id)
                    .cloned()
                    .flatten()
                    .map(|p| {
                        json!({"id": id, "proposer": p.proposer, "description": p.description, "kind": p.kind,
                               "status": p.status, "vote_counts": {}, "votes": {},
                               "submission_time": p.submission_ns.to_string()})
                    })
                    .into_iter()
                    .collect();
                out(json!(list))
            }
            (TOKEN, "ft_balance_of") => out(json!(self.balance(a["account_id"].as_str().unwrap()).to_string())),
            (TOKEN, "storage_deposit") => {
                if deposit < 1_250_000_000_000_000_000_000 {
                    return Err("The attached deposit is less than the minimum storage balance".into());
                }
                assert_eq!(a["registration_only"], true);
                self.registered.insert(a["account_id"].as_str().unwrap().into());
                out(json!({"total": "1250000000000000000000", "available": "0"}))
            }
            _ => Err(format!("{receiver} has no method {method}")),
        }
    }

    pub fn proposal(&self, id: u64) -> Option<&Prop> {
        self.proposals.get(id as usize).and_then(|p| p.as_ref())
    }
}

// ---- the world -----------------------------------------------------------------------------

fn vm_config() -> VmConfig {
    static CONFIG: OnceLock<VmConfig> = OnceLock::new();
    CONFIG.get_or_init(near_sdk::test_vm_config).clone()
}

pub fn fresh_chain() {
    near_sdk::env::set_blockchain_interface(MockedBlockchain::new(
        VMContextBuilder::new().build(),
        vm_config(),
        RuntimeFeesConfig::test(),
        Vec::new(),
        Default::default(),
        Default::default(),
        None,
    ));
}

pub fn value<T>(p: PromiseOrValue<T>) -> Option<T> {
    match p {
        PromiseOrValue::Value(v) => Some(v),
        PromiseOrValue::Promise(_) => None,
    }
}

/// One receipt the contract created: `(own index, dependencies, receiver, method, args, deposit, gas)`.
#[derive(Clone, Debug)]
pub struct Call {
    pub index: u64,
    pub deps: Vec<u64>,
    pub receiver: String,
    pub method: String,
    pub args: Vec<u8>,
    pub deposit: u128,
    pub gas: u64,
}

pub fn created_calls() -> Vec<Call> {
    near_sdk::test_utils::get_created_receipts()
        .into_iter()
        .flat_map(|r| {
            let receiver = r.receiver_id.to_string();
            let deps = r.receipt_indices.clone();
            r.actions
                .into_iter()
                .filter_map(|a| match a {
                    MockAction::FunctionCallWeight {
                        receipt_index,
                        method_name,
                        args,
                        attached_deposit,
                        prepaid_gas,
                        ..
                    } => Some(Call {
                        index: receipt_index,
                        deps: deps.clone(),
                        receiver: receiver.clone(),
                        method: String::from_utf8(method_name).unwrap(),
                        args,
                        deposit: attached_deposit.as_yoctonear(),
                        gas: prepaid_gas.as_gas(),
                    }),
                    _ => None,
                })
                .collect::<Vec<_>>()
        })
        .collect()
}

pub struct World {
    pub c: HatTip,
    pub now_ms: u64,
    pub dao: Dao,
    pub logs: Vec<String>,
    pub last_logs: Vec<String>,
    /// The contract's balance in every call.
    pub balance: u128,
    /// Gas attached to top-level calls.
    pub gas_tgas: u64,
    queue: VecDeque<Vec<Call>>,
    /// Every receipt executed, in order.
    pub executed: Vec<Call>,
    pub last_close: Option<CloseOutcome>,
    pub last_check: Option<CheckOutcome>,
    /// When false, `run` leaves the queue alone (to inspect in-flight states).
    pub auto_run: bool,
    /// The most host gas and log bytes any execution of a method used, by method.
    pub metered: BTreeMap<String, (u64, usize)>,
}

impl World {
    pub fn new() -> Self {
        Self::with(cfg())
    }

    /// A community before genesis, synced with the DAO.
    pub fn with(config: Config) -> Self {
        let mut w = Self::bare(config);
        w.sync();
        w
    }

    /// A deployed contract that has not read the DAO policy yet.
    pub fn bare(config: Config) -> Self {
        fresh_chain();
        let now_ms = GENESIS_MS - 60_000;
        let mut b = VMContextBuilder::new();
        b.current_account_id(contract_id())
            .predecessor_account_id(contract_id())
            .signer_account_id(contract_id())
            .block_timestamp(now_ms * 1_000_000)
            .account_balance(NearToken::from_near(50));
        testing_env!(b.build(), vm_config(), RuntimeFeesConfig::test());
        let c = HatTip::new(config);
        let mut w = Self {
            c,
            now_ms,
            dao: Dao::new(1_000_000 * USD),
            logs: Vec::new(),
            last_logs: Vec::new(),
            balance: NearToken::from_near(50).as_yoctonear(),
            gas_tgas: 300,
            queue: VecDeque::new(),
            executed: Vec::new(),
            last_close: None,
            last_check: None,
            auto_run: true,
            metered: BTreeMap::new(),
        };
        w.gather_logs();
        w
    }

    fn gather_logs(&mut self) {
        self.last_logs = near_sdk::test_utils::get_logs();
        self.logs.extend(self.last_logs.iter().cloned());
    }

    fn context(&self, who: &AccountId, deposit: u128, gas: u64, results: Vec<PromiseResult>) {
        let mut b = VMContextBuilder::new();
        b.current_account_id(contract_id())
            .predecessor_account_id(who.clone())
            .signer_account_id(who.clone())
            .block_timestamp(self.now_ms * 1_000_000)
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .account_balance(NearToken::from_yoctonear(self.balance))
            .prepaid_gas(Gas::from_gas(gas));
        testing_env!(b.build(), vm_config(), RuntimeFeesConfig::test(), Default::default(), results);
    }

    /// One contract call; the receipts it creates are queued. Return values that hold a promise
    /// must be turned into plain values inside `f` (see `value`), so the promise is built there.
    pub fn exec<R>(
        &mut self,
        who: &AccountId,
        gas: u64,
        results: Vec<PromiseResult>,
        f: impl FnOnce(&mut HatTip) -> R,
    ) -> R {
        self.exec_named("", who, gas, results, f)
    }

    /// `exec`, metering the host gas (with the cached writes flushed inside the call, as the
    /// runtime does at its end) and the log bytes under `name`.
    pub fn exec_named<R>(
        &mut self,
        name: &str,
        who: &AccountId,
        gas: u64,
        results: Vec<PromiseResult>,
        f: impl FnOnce(&mut HatTip) -> R,
    ) -> R {
        self.context(who, 0, gas, results);
        let r = f(&mut self.c);
        self.c.flush();
        let used = near_sdk::env::used_gas().as_gas();
        self.gather_logs();
        let bytes: usize = self.last_logs.iter().map(|l| l.len()).sum();
        if !name.is_empty() {
            let e = self.metered.entry(name.to_string()).or_insert((0, 0));
            *e = (e.0.max(used), e.1.max(bytes));
        }
        let calls = created_calls();
        if !calls.is_empty() {
            self.queue.push_back(calls);
        }
        r
    }

    pub fn call<R>(&mut self, who: &AccountId, f: impl FnOnce(&mut HatTip) -> R) -> R {
        let gas = Gas::from_tgas(self.gas_tgas).as_gas();
        let r = self.exec(who, gas, Vec::new(), f);
        if self.auto_run {
            self.run();
        }
        r
    }

    pub fn view<R>(&mut self, f: impl FnOnce(&HatTip) -> R) -> R {
        self.context(&acc("viewer.testnet"), 0, Gas::from_tgas(300).as_gas(), Vec::new());
        f(&self.c)
    }

    /// Executes queued receipts until none are left: DAO and token calls in the model,
    /// callbacks in the contract with the answers they depend on.
    pub fn run(&mut self) {
        while let Some(batch) = self.queue.pop_front() {
            let mut results: BTreeMap<u64, Option<Vec<u8>>> = BTreeMap::new();
            for call in batch {
                self.executed.push(call.clone());
                let r = if call.receiver == CONTRACT {
                    let deps: Vec<PromiseResult> = call
                        .deps
                        .iter()
                        .map(|d| match results.get(d).cloned().flatten() {
                            Some(v) => PromiseResult::Successful(v),
                            None => PromiseResult::Failed,
                        })
                        .collect();
                    self.callback(&call, deps);
                    Some(Vec::new())
                } else {
                    self.dao
                        .handle(
                            &call.receiver,
                            &call.method,
                            &call.args,
                            call.deposit,
                            CONTRACT,
                            self.now_ms * 1_000_000,
                        )
                        .ok()
                };
                results.insert(call.index, r);
            }
        }
    }

    pub fn queued(&self) -> usize {
        self.queue.iter().map(|b| b.len()).sum()
    }

    fn callback(&mut self, call: &Call, results: Vec<PromiseResult>) {
        let args: Value = serde_json::from_slice(&call.args).unwrap();
        let me = contract_id();
        let p = args.get("payout").and_then(|x| x.as_u64()).unwrap_or(0);
        let gas = call.gas;
        let name = call.method.clone();
        match call.method.as_str() {
            "on_policy" => {
                self.exec_named(&name, &me, gas, results, |c| c.on_policy());
            }
            "on_close" => {
                let r = args["round"].as_u64().unwrap();
                let out = self.exec_named(&name, &me, gas, results, |c| c.on_close(r));
                self.last_close = Some(out);
            }
            "on_registered" => self.exec_named(&name, &me, gas, results, |c| c.on_registered(p)),
            "on_filed" => self.exec_named(&name, &me, gas, results, |c| c.on_filed(p)),
            "on_voted" => self.exec_named(&name, &me, gas, results, |c| c.on_voted(p)),
            "on_checked" => {
                let out = self.exec_named(&name, &me, gas, results, |c| value(c.on_checked(p)));
                if let Some(o) = out {
                    self.last_check = Some(o);
                }
            }
            "on_finalized" => {
                let out = self.exec_named(&name, &me, gas, results, |c| c.on_finalized(p));
                self.last_check = Some(out);
            }
            other => panic!("unexpected callback {other}"),
        }
    }

    // ---- clock ---------------------------------------------------------------------------

    pub fn round_start(n: u64) -> u64 {
        GENESIS_MS + (n - 1) * ROUND_MS
    }

    /// Moves the clock to `permille` thousandths into round `n`.
    pub fn at(&mut self, n: u64, permille: u64) {
        let t = Self::round_start(n) + ROUND_MS * permille / 1_000;
        assert!(t >= self.now_ms, "the clock only moves forward");
        self.now_ms = t;
    }

    pub fn clock(&mut self) -> u64 {
        self.state().round
    }

    // ---- calls ---------------------------------------------------------------------------

    pub fn sync(&mut self) -> Vec<String> {
        self.call(&acc("anyone.testnet"), |c| {
            c.sync().detach();
        });
        self.last_logs.clone()
    }

    pub fn allocate(&mut self, who: &AccountId, gifts: &[(&AccountId, u16)]) -> AllocateOutcome {
        let r = self.clock();
        let g: Vec<(AccountId, u16)> = gifts.iter().map(|(a, n)| ((*a).clone(), *n)).collect();
        self.call(who, |c| c.allocate(r, g, None))
    }

    pub fn allocate_note(&mut self, who: &AccountId, gifts: &[(&AccountId, u16)], note: &str) -> AllocateOutcome {
        let r = self.clock();
        let g: Vec<(AccountId, u16)> = gifts.iter().map(|(a, n)| ((*a).clone(), *n)).collect();
        let note = Some(note.to_string());
        self.call(who, |c| c.allocate(r, g, note))
    }

    /// Signs with the key's next nonce and relays through `act`.
    pub fn act(&mut self, key: &mut Key, action: &str) -> ActOutcome {
        key.nonce += 1;
        let sig = key.sign(CONTRACT, key.nonce, action);
        let (hex, nonce) = (key.hex.clone(), key.nonce);
        let action = action.to_string();
        self.call(&acc("relayer.testnet"), |c| c.act(hex, nonce, action, sig))
    }

    pub fn join(&mut self, key: &mut Key, note: Option<&str>) -> ActOutcome {
        let r = self.clock();
        let a = match note {
            Some(n) => json!({"join": {"round": r, "note": n}}),
            None => json!({"join": {"round": r}}),
        };
        self.act(key, &a.to_string())
    }

    pub fn guest_allocate(&mut self, key: &mut Key, gifts: &[(&AccountId, u16)]) -> ActOutcome {
        let r = self.clock();
        let g: Vec<Value> = gifts.iter().map(|(a, n)| json!([a, n])).collect();
        self.act(key, &json!({"allocate": {"round": r, "gifts": g}}).to_string())
    }

    /// `close_round` until nothing more closes; returns the rounds closed.
    pub fn close(&mut self) -> u64 {
        let before = self.state().oldest_unclosed;
        for _ in 0..1_000 {
            let last = self.state().oldest_unclosed;
            self.last_close = None;
            let out = self.call(&acc("anyone.testnet"), |c| value(c.close_round()));
            if let Some(o) = &out {
                self.last_close = Some(o.clone());
            }
            let now = self.state().oldest_unclosed;
            if now == last {
                break;
            }
        }
        self.state().oldest_unclosed - before
    }

    /// Moves the clock to the start of round `n` and closes every round before it.
    pub fn close_through(&mut self, n: u64) {
        self.at(n + 1, 0);
        self.close();
        assert_eq!(self.state().oldest_unclosed, n + 1, "rounds up to {n} should be closed");
    }

    pub fn pay(&mut self, max: u8) -> PayOutcome {
        self.call(&acc("anyone.testnet"), |c| c.pay(max))
    }

    /// Pays until nothing more is filed.
    pub fn pay_all(&mut self) {
        for _ in 0..100 {
            if self.pay(10).filing.is_empty() {
                break;
            }
        }
    }

    pub fn check(&mut self, id: u64) -> Status {
        self.last_check = None;
        let out = self.call(&acc("anyone.testnet"), |c| value(c.check_payout(id)));
        if let Some(o) = out {
            self.last_check = Some(o);
        }
        self.payout(id).status
    }

    /// A council member votes in the DAO on the payout's proposal.
    pub fn vote(&mut self, who: &AccountId, id: u64, action: &str) -> Result<(), String> {
        let p = self.payout(id).dao_proposal.expect("payout not filed");
        self.dao.act(who.as_str(), p, action, None, self.now_ms * 1_000_000)
    }

    // ---- views ---------------------------------------------------------------------------

    pub fn state(&mut self) -> StateView {
        self.view(|c| c.state())
    }

    pub fn round(&mut self, n: u64) -> Option<RoundView> {
        self.view(|c| c.round(n))
    }

    pub fn member(&mut self, a: &AccountId) -> MemberView {
        let a = a.clone();
        self.view(|c| c.member(a))
    }

    pub fn tiers(&mut self, a: &AccountId) -> Limits {
        let a = a.clone();
        self.view(|c| c.tiers(a))
    }

    pub fn rep(&mut self, a: &AccountId) -> u128 {
        self.member(a).reputation.0
    }

    pub fn payouts(&mut self) -> Vec<PayoutView> {
        let mut out = Vec::new();
        let mut from = 0;
        loop {
            let page = self.view(|c| c.payouts(from, 100));
            let n = self.state().next_payout;
            out.extend(page);
            from += 100;
            if from >= n {
                break;
            }
        }
        out
    }

    pub fn payout(&mut self, id: u64) -> PayoutView {
        self.view(|c| c.payouts(id, 1)).pop().expect("payout")
    }

    pub fn round_payouts(&mut self, n: u64) -> Vec<PayoutView> {
        let ids = self.round(n).map(|r| r.payouts).unwrap_or_default();
        ids.into_iter().map(|id| self.payout(id)).collect()
    }

    pub fn audit(&mut self) -> AuditView {
        self.view(|c| c.audit())
    }

    pub fn assert_audit(&mut self) {
        let a = self.audit();
        assert!(
            a.balanced && a.points_attributed && a.statuses_ok && a.filed_have_ids && a.carry_ok,
            "audit failed: {a:?}"
        );
    }

    /// Parsed `EVENT_JSON` lines of the `hattip` standard named `event` (all if `None`).
    pub fn events(&self, event: Option<&str>) -> Vec<Value> {
        parse_events(&self.logs, event)
    }

    pub fn last_events(&self, event: Option<&str>) -> Vec<Value> {
        parse_events(&self.last_logs, event)
    }
}

impl Default for World {
    fn default() -> Self {
        Self::new()
    }
}

pub fn parse_events(logs: &[String], event: Option<&str>) -> Vec<Value> {
    logs.iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|j| serde_json::from_str::<Value>(j).expect("event is JSON"))
        .filter(|v| v["standard"] == EVENT_STANDARD && event.is_none_or(|e| v["event"] == e))
        .collect()
}

/// Every data entry of the events named `event`, oldest first.
pub fn entries(events: &[Value]) -> Vec<Value> {
    events.iter().flat_map(|e| e["data"].as_array().unwrap().clone()).collect()
}

/// A tiny deterministic generator for the randomized tests.
pub struct Rng(pub u64);

impl Rng {
    pub fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    pub fn below(&mut self, n: u64) -> u64 {
        self.next() % n.max(1)
    }
}
