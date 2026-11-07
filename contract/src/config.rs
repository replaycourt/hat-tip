//! Launch parameters, fixed at init, and the contract's constants.
//!
//! The project name appears only in the constants of the first block below (and in the crate
//! name), so a rename is a small change.

use near_sdk::json_types::U128;
use near_sdk::{AccountId, Gas, NearToken, near, require};

/// The project's name as it appears in DAO proposal texts.
pub const NAME: &str = "Hat Tip";
/// The NEP-297 event standard.
pub const EVENT_STANDARD: &str = "hattip";
/// Version of the events and of the `act` signing format.
pub const EVENT_VERSION: &str = "1.0.0";
/// Prefix of the text a browser key signs: `<prefix>:<contract>:<nonce>:<action>`.
pub const SIGNING_PREFIX: &str = "hattip:v1";

/// One thanks in milli-thanks, the unit of weights, points and reputation.
pub const MILLI: u128 = 1_000;
pub const BP: u128 = 10_000;

/// The longest JSON action `act` accepts.
pub const MAX_ACTION_BYTES: usize = 2_048;
/// The largest nonce `act` accepts (2^53 - 1, so it stays exact in JavaScript).
pub const MAX_NONCE: u64 = 9_007_199_254_740_991;
/// The most council accounts the contract copies from the policy (for display only).
pub const COUNCIL_KEEP: usize = 32;
/// The most account ids a round's participants can name (members plus guest seats).
pub const MAX_PARTICIPANTS: u32 = 64;
/// The longest note `note_max_bytes` may allow.
pub const NOTE_LIMIT: u16 = 280;
/// The longest DAO answer the callbacks read.
pub const MAX_RESULT_BYTES: usize = 128 * 1024;
/// NEAR fails a receipt whose logs exceed 16 KiB; a close keeps below this.
pub const LOG_BUDGET: usize = 15_000;
/// How long a close waits for its DAO callback before another `close_round` may retry.
pub const CLOSE_RETRY_MS: u64 = 120_000;
/// Planned payouts `pay` looks at per call.
pub const PAY_SCAN: u64 = 64;
/// Guest records the cleanup sweep looks at per close.
pub const GUEST_SWEEP: u32 = 8;
/// Final payout records pruned per close once they are older than `log_keep` rounds.
pub const PAYOUT_PRUNE: u32 = 16;
/// Payout ids kept in an account record for `member()`.
pub const MEMBER_PAYOUTS_KEEP: usize = 32;

/// What `storage_deposit(registration_only)` costs on a near-contract-standards NEP-141 token
/// (125 bytes at 10^19 yoctoNEAR per byte). A token that asks less refunds the rest.
pub const REGISTRATION_DEPOSIT: NearToken = NearToken::from_yoctonear(1_250_000_000_000_000_000_000);
/// Balance the contract keeps free above its storage before it attaches a bond or a deposit.
pub const FLOAT_MIN: NearToken = NearToken::from_millinear(50);

// Gas. A callback gets exactly its static gas. Creating `call.then(callback)` costs about 19 Tgas
// in receipt fees (two function-call receipts and one data receipt, send and execution), which
// the creator pays on top of the static gas it attaches; `GAS_LINK` is that fee per link.
pub const GAS_LINK: Gas = Gas::from_tgas(20);
/// A small callback's own work (storage, events).
pub const GAS_OWN: Gas = Gas::from_tgas(5);
pub const GAS_GET_POLICY: Gas = Gas::from_tgas(10);
pub const GAS_FT_BALANCE: Gas = Gas::from_tgas(5);
pub const GAS_ON_POLICY: Gas = Gas::from_tgas(20);
pub const GAS_ON_CLOSE: Gas = Gas::from_tgas(180);
pub const GAS_STORAGE_DEPOSIT: Gas = Gas::from_tgas(10);
pub const GAS_ADD_PROPOSAL: Gas = Gas::from_tgas(15);
/// A vote that executes the transfer needs at least 25 Tgas attached (testnet probe).
pub const GAS_ACT_PROPOSAL: Gas = Gas::from_tgas(30);
pub const GAS_ON_VOTED: Gas = Gas::from_tgas(5);
pub const GAS_GET_PROPOSAL: Gas = Gas::from_tgas(10);
pub const GAS_ON_FINALIZED: Gas = Gas::from_tgas(5);
/// Gas the DAO gets to run the tier-2 `ft_transfer` it calls on the token.
pub const GAS_FT_TRANSFER: Gas = Gas::from_tgas(15);
/// Gas a method keeps for itself after scheduling its promises.
pub const GAS_MARGIN: Gas = Gas::from_tgas(15);

fn default_members_role() -> String {
    "members".into()
}
fn default_council_role() -> String {
    "council".into()
}
fn default_thanks_role() -> String {
    "thanks".into()
}
fn default_off() -> u16 {
    10_000
}

/// Every parameter, stored once by `new` and shown by `config()`. Amounts are tUSD base units,
/// `*_bp` basis points (10,000 = 100 %), times milliseconds.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Config {
    /// The community's Sputnik v2 DAO.
    pub dao: AccountId,
    /// The NEP-141 token the DAO pays in (tUSD).
    pub token: AccountId,
    #[serde(default = "default_members_role")]
    pub members_role: String,
    #[serde(default = "default_council_role")]
    pub council_role: String,
    /// The DAO role this contract is the one member of.
    #[serde(default = "default_thanks_role")]
    pub thanks_role: String,
    /// Start of round 1.
    pub genesis_ms: u64,
    pub round_ms: u64,
    pub thanks_per_round: u16,
    pub cap_per_receiver: u16,
    pub max_receivers: u8,
    /// Mutual thanks count at this share (10,000 = off).
    pub reciprocal_bp: u16,
    pub quadratic: bool,
    /// Receivers with fewer supporting givers count at `breadth_bp` (0 = off).
    pub breadth_k: u8,
    pub breadth_bp: u16,
    /// Members who gave nothing in the round receive at this share (10,000 = off).
    pub idle_bp: u16,
    /// Reputation lost per round.
    pub decay_bp: u16,
    pub round_budget: U128,
    pub min_payout: U128,
    pub carry_rounds: u16,
    pub reserve: U128,
    /// Reputation (in thanks) below which a receiver has no auto limit.
    pub auto_rep_min: u32,
    pub auto_per_thanks: U128,
    pub auto_max: U128,
    pub cosign_base: U128,
    pub cosign_per_thanks: U128,
    pub cosign_max: U128,
    /// The most of a round's budget that tier 1 may send.
    pub auto_share_bp: u16,
    pub guest_seats: u8,
    pub guest_weight_bp: u16,
    pub guest_cap_bp: u16,
    pub max_members: u16,
    pub max_catchup: u16,
    pub log_keep: u32,
    pub note_max_bytes: u16,
    /// The most of a round's points that guests together receive (10,000 = off, the default).
    /// Scales every entry to a guest down when guests would receive more; it bounds what a
    /// member who thanks a farm of guests can route to them. (Added after I-1; see README.md.)
    #[serde(default = "default_off")]
    pub guest_receive_cap_bp: u16,
}

impl Config {
    /// Panics with the first parameter out of range.
    pub fn validate(&self) {
        require!(self.round_ms >= 1_000, "round_ms must be at least 1,000");
        require!(self.genesis_ms.checked_add(self.round_ms).is_some(), "genesis_ms out of range");
        require!(self.thanks_per_round >= 1, "thanks_per_round must be at least 1");
        require!(
            self.cap_per_receiver >= 1 && self.cap_per_receiver <= self.thanks_per_round,
            "cap_per_receiver must be from 1 to thanks_per_round"
        );
        require!(self.max_receivers >= 1, "max_receivers must be at least 1");
        for (name, v) in [
            ("reciprocal_bp", self.reciprocal_bp),
            ("breadth_bp", self.breadth_bp),
            ("idle_bp", self.idle_bp),
            ("decay_bp", self.decay_bp),
            ("auto_share_bp", self.auto_share_bp),
            ("guest_weight_bp", self.guest_weight_bp),
            ("guest_cap_bp", self.guest_cap_bp),
            ("guest_receive_cap_bp", self.guest_receive_cap_bp),
        ] {
            require!(v as u128 <= BP, format!("{name} must be at most 10,000"));
        }
        require!(self.min_payout.0 >= 1, "min_payout must be at least 1");
        require!(self.max_members >= 1, "max_members must be at least 1");
        require!(
            self.max_members as u32 + self.guest_seats as u32 <= MAX_PARTICIPANTS,
            "max_members + guest_seats must be at most 64"
        );
        require!(self.max_catchup >= 1, "max_catchup must be at least 1");
        require!(self.log_keep >= 2, "log_keep must be at least 2");
        require!(self.note_max_bytes <= NOTE_LIMIT, "note_max_bytes must be at most 280");
        for (name, role) in [
            ("members_role", &self.members_role),
            ("council_role", &self.council_role),
            ("thanks_role", &self.thanks_role),
        ] {
            require!(!role.is_empty() && role.len() <= 64, format!("{name} must be 1 to 64 bytes"));
        }
        require!(self.members_role != self.thanks_role, "members_role and thanks_role must differ");
    }
}
