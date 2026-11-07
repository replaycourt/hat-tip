//! Stored records and the outcomes of calls.

use near_sdk::json_types::U128;
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::{AccountId, near};

/// Everything the contract keeps about one account: a member, a guest or a former member.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Acct {
    /// Reputation in milli-thanks as of the close of round `rep_round`; later rounds decay it
    /// lazily (`math::decay_rounds`).
    pub rep: u128,
    pub rep_round: u64,
    /// A share too small to pay, kept until a later round adds to it or it lapses.
    pub carry: u128,
    /// The round of the oldest share in the carry.
    pub carry_since: u64,
    /// Payouts planned, filing, filed or approved.
    pub open: u32,
    /// The contract has registered this account with the token (or found it registered).
    pub registered: bool,
    /// Guests: the last nonce `act` accepted.
    pub nonce: u64,
    /// Guests: the last round with a seat.
    pub seat: u64,
    pub strikes: u32,
    /// `(round, points)` for the rounds with points still in the round log.
    pub hist: Vec<(u64, u128)>,
    /// The latest payout ids (at most `MEMBER_PAYOUTS_KEEP`).
    pub payouts: Vec<u64>,
}

/// One allocation entry of a round, with what it counted for once the round is closed.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Gift {
    pub giver: u16,
    pub receiver: u16,
    pub given: u16,
    pub counted: u128,
}

/// A round as the contract keeps it for `log_keep` rounds.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RoundLog {
    pub closed: bool,
    /// Every account the round names, by index.
    pub accounts: Vec<AccountId>,
    /// Indices of the seated guests, in seat order.
    pub seats: Vec<u16>,
    pub notes: Vec<(u16, String)>,
    /// Final allocations, grouped by giver in the order of their last allocation.
    pub gifts: Vec<Gift>,
    pub dao_balance: u128,
    pub budget: u128,
    pub dust: u128,
    /// Points by account index, sorted by account id; filled at the close.
    pub points: Vec<(u16, u128)>,
    pub payouts: Vec<u64>,
}

impl RoundLog {
    pub fn index_of(&self, a: &AccountId) -> Option<u16> {
        self.accounts.iter().position(|x| x == a).map(|i| i as u16)
    }

    pub fn index_or_insert(&mut self, a: &AccountId) -> u16 {
        match self.index_of(a) {
            Some(i) => i,
            None => {
                self.accounts.push(a.clone());
                (self.accounts.len() - 1) as u16
            }
        }
    }

    pub fn seated(&self, a: &AccountId) -> bool {
        self.index_of(a).is_some_and(|i| self.seats.contains(&i))
    }

    pub fn has_gifts(&self) -> bool {
        !self.gifts.is_empty()
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    /// Waiting for `pay`.
    Planned,
    /// `pay` started its chain; the DAO has not answered yet.
    Filing,
    /// In the DAO with a proposal id, waiting for votes (tier 1: for the contract's own vote).
    Filed,
    /// Tier 1: the contract's vote passed and the DAO executes the transfer.
    Approved,
    Paid,
    Rejected,
    Expired,
    Removed,
    Failed,
}

impl Status {
    pub const ALL: [Status; 9] = [
        Status::Planned,
        Status::Filing,
        Status::Filed,
        Status::Approved,
        Status::Paid,
        Status::Rejected,
        Status::Expired,
        Status::Removed,
        Status::Failed,
    ];

    pub fn is_final(self) -> bool {
        matches!(self, Status::Paid | Status::Rejected | Status::Expired | Status::Removed | Status::Failed)
    }

    pub fn name(self) -> &'static str {
        match self {
            Status::Planned => "planned",
            Status::Filing => "filing",
            Status::Filed => "filed",
            Status::Approved => "approved",
            Status::Paid => "paid",
            Status::Rejected => "rejected",
            Status::Expired => "expired",
            Status::Removed => "removed",
            Status::Failed => "failed",
        }
    }
}

/// One receiver's payout of one round.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Payout {
    pub round: u64,
    pub receiver: AccountId,
    pub amount: u128,
    pub tier: u8,
    pub status: Status,
    pub proposal: Option<u64>,
    /// The receiver's points in the round (what a strike takes back).
    pub points: u128,
    /// Givers whose thanks counted for the receiver in the round.
    pub givers: u16,
    /// The DAO reported the proposal `Failed` once and the contract re-registered the receiver
    /// and finalized it (which re-runs the transfer); a second `Failed` is final.
    pub retried: bool,
    /// A DAO answer asked for (by `check_payout`) before this block height changes nothing: set
    /// to `RETRY_BLOCKS` ahead when a retry starts, and by `on_finalized` to `SETTLE_BLOCKS`
    /// after the `Finalize`, so neither a check that races the retry nor one that read the
    /// proposal before the retry ran can book an outcome.
    pub settle_at: u64,
    /// Block height of the `on_checked` that first saw the proposal `Approved` (0: not seen).
    /// Sputnik shows `Approved` before the transfer has run and `Failed` a few blocks later, so
    /// `paid` needs a second `Approved` asked for `SETTLE_BLOCKS` or more after this one.
    pub approved_at: u64,
}

/// Running totals since init.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Totals {
    pub rounds_closed: u64,
    pub budgets: U128,
    pub planned: U128,
    pub carry: U128,
    pub lapsed: U128,
    pub dust: U128,
    pub points: U128,
    pub attributed: U128,
    pub paid: U128,
    pub rejected: U128,
    pub expired: U128,
    pub removed: U128,
    pub failed: U128,
    pub strikes: u64,
    /// Payouts by status, in the order of `Status::ALL`.
    pub by_status: [u64; 9],
}

impl Totals {
    /// What the payouts without a final status add up to (planned, filing, filed, approved).
    pub fn open(&self) -> u128 {
        let done = self.paid.0 + self.rejected.0 + self.expired.0 + self.removed.0 + self.failed.0;
        self.planned.0 - done
    }
}

/// What a guest signs and sends through `act`.
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
#[serde(crate = "near_sdk::serde", rename_all = "snake_case", deny_unknown_fields)]
pub enum Action {
    Join {
        round: u64,
        #[serde(default)]
        note: Option<String>,
    },
    Allocate {
        round: u64,
        gifts: Vec<(AccountId, u16)>,
    },
    Note {
        round: u64,
        text: String,
    },
}

impl Action {
    pub fn round(&self) -> u64 {
        match self {
            Action::Join { round, .. } | Action::Allocate { round, .. } | Action::Note { round, .. } => *round,
        }
    }
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct AllocateOutcome {
    pub ok: bool,
    pub error: Option<String>,
    /// Thanks in the allocation now standing (0 if refused).
    pub given: u16,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct ActOutcome {
    pub ok: bool,
    pub error: Option<String>,
    pub nonce: u64,
    pub round: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct CloseOutcome {
    /// Rounds closed by this call (or callback).
    pub closed: u32,
    pub last_closed: u64,
    /// A round with allocations waits for the DAO's answer.
    pub waiting: Option<u64>,
    pub error: Option<String>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct PayOutcome {
    /// Payout ids whose filing chain started.
    pub filing: Vec<u64>,
    pub error: Option<String>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct CheckOutcome {
    pub payout: u64,
    pub status: Status,
    pub changed: bool,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct SyncOutcome {
    pub ok: bool,
    pub members: u32,
    pub council: u32,
    pub bond: U128,
    pub paused: bool,
}
