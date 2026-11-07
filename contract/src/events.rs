//! NEP-297 events, standard `hattip` (`config::EVENT_STANDARD`), version 1.0.0.
//!
//! A call collects its events and logs them at the end, one log line per event kind with every
//! entry of that kind in its `data` array. Collecting first lets a close count the bytes: NEAR
//! fails a receipt whose logs exceed 16 KiB, so a close that would cross `LOG_BUDGET` logs its
//! `points` event without the per-giver detail (the `round(n)` view still has it).

use crate::config::{EVENT_STANDARD, EVENT_VERSION};
use near_sdk::json_types::{U64, U128};
use near_sdk::serde::Serialize;
use near_sdk::{AccountId, env, serde_json};

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Synced,
    Paused,
    Joined,
    Note,
    Allocated,
    RoundClosed,
    Points,
    PayoutPlanned,
    Carry,
    CarryLapsed,
    Filed,
    Approved,
    Paid,
    Rejected,
    Expired,
    Removed,
    Failed,
    Struck,
}

pub const NAMES: [&str; 18] = [
    "synced",
    "paused",
    "joined",
    "note",
    "allocated",
    "round_closed",
    "points",
    "payout_planned",
    "carry",
    "carry_lapsed",
    "filed",
    "approved",
    "paid",
    "rejected",
    "expired",
    "removed",
    "failed",
    "struck",
];

const TAIL: &str = "]}";

fn head(k: usize) -> String {
    format!(
        "EVENT_JSON:{{\"standard\":\"{EVENT_STANDARD}\",\"version\":\"{EVENT_VERSION}\",\"event\":\"{}\",\"data\":[",
        NAMES[k]
    )
}

pub fn json<T: Serialize>(v: &T) -> String {
    serde_json::to_string(v).unwrap_or_else(|_| env::abort())
}

/// The events of one call, logged by `emit`.
pub struct Logs {
    entries: [Vec<String>; 18],
    bytes: usize,
}

impl Default for Logs {
    fn default() -> Self {
        Self::new()
    }
}

impl Logs {
    pub fn new() -> Self {
        Self { entries: Default::default(), bytes: 0 }
    }

    /// Bytes the logs will take once emitted.
    pub fn bytes(&self) -> usize {
        self.bytes
    }

    pub fn push<T: Serialize>(&mut self, k: Kind, data: &T) {
        self.push_raw(k, json(data));
    }

    pub fn push_raw(&mut self, k: Kind, entry: String) {
        let i = k as usize;
        self.bytes += if self.entries[i].is_empty() { head(i).len() + TAIL.len() } else { 1 };
        self.bytes += entry.len();
        self.entries[i].push(entry);
    }

    pub fn emit(self) {
        for (i, e) in self.entries.iter().enumerate() {
            if !e.is_empty() {
                env::log_str(&format!("{}{}{TAIL}", head(i), e.join(",")));
            }
        }
    }
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct SyncedEvent {
    pub members: u32,
    pub council: u32,
    /// Named accounts of the members role beyond `max_members` (the ones sorting last).
    pub dropped: u32,
    pub bond: U128,
    pub proposal_period: U64,
    pub paused: bool,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct PausedEvent<'a> {
    pub paused: bool,
    pub reason: &'a str,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct JoinedEvent<'a> {
    pub round: u64,
    pub account: &'a AccountId,
    /// 1 to `guest_seats`.
    pub seat: u32,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct NoteEvent<'a> {
    pub round: u64,
    pub account: &'a AccountId,
    pub text: &'a str,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct AllocatedEvent<'a> {
    pub round: u64,
    pub giver: &'a AccountId,
    pub guest: bool,
    pub given: u32,
    pub gifts: &'a [(AccountId, u16)],
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct RoundClosedEvent {
    pub round: u64,
    pub empty: bool,
    pub members: u32,
    pub dao_balance: U128,
    pub budget: U128,
    pub points: u64,
    pub dust: U128,
    pub payouts: u32,
    pub carries: u32,
    /// 2: every event in full; 1: `points` without the per-giver detail; 0: no `points`,
    /// `payout_planned`, `carry` or `carry_lapsed` entries (the logs would not have fit; the
    /// views have everything).
    pub detail: u8,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct PayoutPlannedEvent<'a> {
    pub payout: u64,
    pub round: u64,
    pub receiver: &'a AccountId,
    pub amount: U128,
    pub tier: u8,
    pub points: u64,
    pub givers: u32,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct CarryEvent<'a> {
    pub round: u64,
    pub account: &'a AccountId,
    pub amount: U128,
    /// The round of the oldest share in the carry.
    pub since: u64,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct FiledEvent<'a> {
    pub payout: u64,
    pub proposal: u64,
    pub tier: u8,
    pub kind: &'a str,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct OutcomeEvent<'a> {
    pub payout: u64,
    pub proposal: u64,
    pub receiver: &'a AccountId,
    pub amount: U128,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct StruckEvent<'a> {
    pub payout: u64,
    pub round: u64,
    pub account: &'a AccountId,
    /// The round's points.
    pub points: u64,
    /// Those points decayed to the last closed round: what the reputation lost.
    pub strike: U128,
    pub reputation: U128,
}
