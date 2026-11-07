//! Hat Tip: a community that keeps its money in a Sputnik DAO pays its contributors in rounds of
//! peer thanks. See ../DESIGN.md for the rules and README.md for the API.
//!
//! The contract has no owner, no admin method and no upgrade method. Every rule is a launch
//! parameter (`config.rs`), stored once by `new` and never changed. The money stays in the DAO:
//! every payout is a DAO proposal, filed by this contract through its DAO role.

pub mod config;
pub mod dao;
pub mod math;
pub mod types;
pub mod views;

mod close;
mod events;
pub mod pay;

use config::*;
use events::{AllocatedEvent, JoinedEvent, Kind, Logs, NoteEvent};
use near_sdk::store::{LookupMap, Vector};
use near_sdk::{AccountId, BorshStorageKey, PanicOnDefault, env, near, require, serde_json};
use types::*;

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum Key {
    Accounts,
    Rounds,
    Payouts,
    Guests,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct HatTip {
    pub(crate) cfg: Config,
    /// Named accounts of the DAO's members role, sorted, as of the last close or `sync`.
    pub(crate) members: Vec<AccountId>,
    pub(crate) council: Vec<AccountId>,
    pub(crate) bond: u128,
    pub(crate) proposal_period_ns: u64,
    /// Why `pay` does not file, if it does not.
    pub(crate) paused: Option<String>,
    pub(crate) last_sync_ms: u64,
    /// Every round up to this one is closed (0: none yet).
    pub(crate) last_closed: u64,
    /// A round waiting for the DAO's answer, and since when.
    pub(crate) closing: Option<(u64, u64)>,
    pub(crate) next_payout: u64,
    /// No payout below this id is planned or filing.
    pub(crate) pay_cursor: u64,
    /// Payouts below this id are pruned.
    pub(crate) prune_cursor: u64,
    pub(crate) guest_cursor: u32,
    pub(crate) totals: Totals,
    /// Accounts with a carry.
    pub(crate) carries: Vec<AccountId>,
    pub(crate) accounts: LookupMap<AccountId, Acct>,
    pub(crate) rounds: LookupMap<u64, RoundLog>,
    pub(crate) payouts: LookupMap<u64, Payout>,
    /// Guest records, for the cleanup sweep.
    pub(crate) guests: Vector<AccountId>,
}

/// The exact text a browser key signs for `act`.
pub fn signing_message(contract: &str, nonce: u64, action: &str) -> String {
    format!("{SIGNING_PREFIX}:{contract}:{nonce}:{action}")
}

#[near]
impl HatTip {
    /// Binds the contract to its DAO and token and stores every parameter. Runs once, as part
    /// of the deployment. The contract is paused until the first `sync` reads the DAO policy.
    #[init]
    #[private]
    pub fn new(config: Config) -> Self {
        config.validate();
        Self {
            cfg: config,
            members: Vec::new(),
            council: Vec::new(),
            bond: 0,
            proposal_period_ns: 0,
            paused: Some("the DAO policy has not been read yet".into()),
            last_sync_ms: 0,
            last_closed: 0,
            closing: None,
            next_payout: 0,
            pay_cursor: 0,
            prune_cursor: 0,
            guest_cursor: 0,
            totals: Totals::default(),
            carries: Vec::new(),
            accounts: LookupMap::new(Key::Accounts),
            rounds: LookupMap::new(Key::Rounds),
            payouts: LookupMap::new(Key::Payouts),
            guests: Vector::new(Key::Guests),
        }
    }

    /// A member hands out the round's thanks: `gifts` is a list of `(receiver, thanks)`. It
    /// replaces the member's earlier allocation for the round; an empty list withdraws it. An
    /// optional `note` is posted in the same call. A refused allocation changes nothing and says
    /// why in `error`.
    pub fn allocate(&mut self, round: u64, gifts: Vec<(AccountId, u16)>, note: Option<String>) -> AllocateOutcome {
        let who = env::predecessor_account_id();
        let mut logs = Logs::new();
        let result = self.member_gate(&who, round).and_then(|mut log| {
            if let Some(text) = &note {
                self.check_note(text)?;
            }
            let given = self.check_gifts(&log, &who, false, &gifts)?;
            self.put_gifts(&mut log, round, &who, false, &gifts, given, &mut logs);
            if let Some(text) = &note {
                self.put_note(&mut log, round, &who, text, &mut logs);
            }
            self.rounds.insert(round, log);
            Ok(given)
        });
        logs.emit();
        match result {
            Ok(given) => AllocateOutcome { ok: true, error: None, given },
            Err(e) => AllocateOutcome { ok: false, error: Some(e), given: 0 },
        }
    }

    /// A member posts (or with an empty text, deletes) its note for the round.
    pub fn note(&mut self, round: u64, text: String) {
        let who = env::predecessor_account_id();
        let mut log = self.member_gate(&who, round).unwrap_or_else(|e| env::panic_str(&e));
        self.check_note(&text).unwrap_or_else(|e| env::panic_str(&e));
        let mut logs = Logs::new();
        self.put_note(&mut log, round, &who, &text, &mut logs);
        self.rounds.insert(round, log);
        logs.emit();
    }

    /// Plays one signed guest action for the implicit account of `pubkey`, whoever relays it.
    ///
    /// `pubkey` and `signature` are lowercase hex (32 and 64 bytes). `action` is one JSON action
    /// (`{"join":{"round","note"}}`, `{"allocate":{"round","gifts"}}`, `{"note":{"round","text"}}`)
    /// and the signature covers the UTF-8 bytes of `hattip:v1:<contract>:<nonce>:<action>`.
    /// `nonce` must be above the key's last one.
    ///
    /// A bad signature, a used nonce or malformed JSON fails the call. A refused action does not:
    /// it changes nothing but the nonce (if the guest has a record), and `error` says why.
    pub fn act(&mut self, pubkey: String, nonce: u64, action: String, signature: String) -> ActOutcome {
        require!(action.len() <= MAX_ACTION_BYTES, "action too long");
        require!(nonce >= 1 && nonce <= MAX_NONCE, "nonce out of range");
        let key: [u8; 32] = parse_hex(&pubkey).unwrap_or_else(|| env::panic_str("bad public key"));
        let sig: [u8; 64] = parse_hex(&signature).unwrap_or_else(|| env::panic_str("bad signature encoding"));
        let msg = signing_message(env::current_account_id().as_str(), nonce, &action);
        require!(env::ed25519_verify(&sig, msg.as_bytes(), &key), "bad signature");
        let guest: AccountId = pubkey.parse().unwrap_or_else(|_| env::panic_str("bad public key"));
        let seen = self.accounts.get(&guest).map_or(0, |a| a.nonce);
        require!(nonce > seen, "nonce already used");
        let parsed: Action = serde_json::from_str(&action).unwrap_or_else(|_| env::panic_str("malformed action"));

        let mut logs = Logs::new();
        let result = self.guest_action(&guest, parsed, &mut logs);
        if let Some(a) = self.accounts.get_mut(&guest) {
            a.nonce = nonce;
        }
        logs.emit();
        ActOutcome {
            ok: result.is_ok(),
            error: result.err(),
            nonce,
            round: self.clock_round(env::block_timestamp_ms()),
        }
    }
}

impl HatTip {
    /// The round the clock is in (0 before genesis).
    pub(crate) fn clock_round(&self, now_ms: u64) -> u64 {
        if now_ms < self.cfg.genesis_ms { 0 } else { (now_ms - self.cfg.genesis_ms) / self.cfg.round_ms + 1 }
    }

    pub(crate) fn round_end_ms(&self, r: u64) -> u64 {
        self.cfg.genesis_ms.saturating_add(r.saturating_mul(self.cfg.round_ms))
    }

    pub(crate) fn is_member(&self, a: &AccountId) -> bool {
        self.members.binary_search(a).is_ok()
    }

    /// The open round's log, if `round` is the clock's round.
    fn round_gate(&self, round: u64) -> Result<RoundLog, String> {
        let clock = self.clock_round(env::block_timestamp_ms());
        if clock == 0 {
            return Err("round 1 has not started yet".into());
        }
        if round != clock {
            return Err(format!("the action is for round {round}, but this is round {clock}"));
        }
        Ok(self.rounds.get(&round).cloned().unwrap_or_default())
    }

    fn member_gate(&self, who: &AccountId, round: u64) -> Result<RoundLog, String> {
        if !self.is_member(who) {
            return Err(format!("{who} is not a member of the DAO (as of the last sync)"));
        }
        self.round_gate(round)
    }

    pub(crate) fn check_note(&self, text: &str) -> Result<(), String> {
        if text.len() > self.cfg.note_max_bytes as usize {
            return Err(format!("a note has at most {} bytes", self.cfg.note_max_bytes));
        }
        if text.chars().any(|c| c.is_control()) {
            return Err("a note is one line without control characters".into());
        }
        Ok(())
    }

    /// The thanks in `gifts` if the allocation is allowed, else why not.
    pub(crate) fn check_gifts(
        &self,
        log: &RoundLog,
        giver: &AccountId,
        guest: bool,
        gifts: &[(AccountId, u16)],
    ) -> Result<u16, String> {
        let c = &self.cfg;
        if gifts.len() > c.max_receivers as usize {
            return Err(format!("at most {} receivers", c.max_receivers));
        }
        let mut sum: u32 = 0;
        for (i, (to, n)) in gifts.iter().enumerate() {
            if to == giver {
                return Err("no thanks to yourself".into());
            }
            if gifts[..i].iter().any(|(x, _)| x == to) {
                return Err(format!("{to} is named twice"));
            }
            if *n == 0 || *n > c.cap_per_receiver {
                return Err(format!("thanks to one receiver must be from 1 to {}", c.cap_per_receiver));
            }
            if self.is_member(to) {
                // fine
            } else if log.seated(to) {
                if guest {
                    return Err("guests give to members only".into());
                }
            } else {
                return Err(format!("{to} is neither a member nor a seated guest"));
            }
            sum += *n as u32;
        }
        if sum > c.thanks_per_round as u32 {
            return Err(format!("at most {} thanks per round", c.thanks_per_round));
        }
        Ok(sum as u16)
    }

    pub(crate) fn put_gifts(
        &mut self,
        log: &mut RoundLog,
        round: u64,
        giver: &AccountId,
        guest: bool,
        gifts: &[(AccountId, u16)],
        given: u16,
        logs: &mut Logs,
    ) {
        let g = log.index_or_insert(giver);
        log.gifts.retain(|x| x.giver != g);
        for (to, n) in gifts {
            let receiver = log.index_or_insert(to);
            log.gifts.push(Gift { giver: g, receiver, given: *n, counted: 0 });
        }
        logs.push(Kind::Allocated, &AllocatedEvent { round, giver, guest, given: given as u32, gifts });
    }

    pub(crate) fn put_note(&mut self, log: &mut RoundLog, round: u64, who: &AccountId, text: &str, logs: &mut Logs) {
        let i = log.index_or_insert(who);
        log.notes.retain(|(x, _)| *x != i);
        if !text.is_empty() {
            log.notes.push((i, text.to_string()));
        }
        logs.push(Kind::Note, &NoteEvent { round, account: who, text });
    }

    fn guest_action(&mut self, guest: &AccountId, action: Action, logs: &mut Logs) -> Result<(), String> {
        let round = action.round();
        let mut log = self.round_gate(round)?;
        // Check everything before the seat is taken, so a refused action leaves no seat behind.
        let given = match &action {
            Action::Join { note, .. } => {
                if let Some(t) = note {
                    self.check_note(t)?;
                }
                None
            }
            Action::Note { text, .. } => {
                self.check_note(text)?;
                None
            }
            Action::Allocate { gifts, .. } => Some(self.check_gifts(&log, guest, true, gifts)?),
        };
        if !log.seated(guest) {
            if self.cfg.guest_seats == 0 {
                return Err("this community has no guest seats".into());
            }
            if log.seats.len() >= self.cfg.guest_seats as usize {
                return Err(format!("all {} guest seats of round {round} are taken", self.cfg.guest_seats));
            }
            let i = log.index_or_insert(guest);
            log.seats.push(i);
            logs.push(Kind::Joined, &JoinedEvent { round, account: guest, seat: log.seats.len() as u32 });
        }
        match &action {
            Action::Join { note: Some(t), .. } => self.put_note(&mut log, round, guest, t, logs),
            Action::Join { note: None, .. } => {}
            Action::Note { text, .. } => self.put_note(&mut log, round, guest, text, logs),
            Action::Allocate { gifts, .. } => {
                self.put_gifts(&mut log, round, guest, true, gifts, given.unwrap_or(0), logs)
            }
        }
        self.rounds.insert(round, log);
        if !self.accounts.contains_key(guest) {
            self.accounts.insert(guest.clone(), Acct { rep_round: self.last_closed, ..Default::default() });
            self.guests.push(guest.clone());
        }
        if let Some(a) = self.accounts.get_mut(guest) {
            a.seat = round;
        }
        Ok(())
    }

    /// Writes every cached collection entry now. The contract does this on its own at the end of
    /// each call; tests call it to meter the writes inside the call they measure.
    #[doc(hidden)]
    pub fn flush(&mut self) {
        self.accounts.flush();
        self.rounds.flush();
        self.payouts.flush();
        self.guests.flush();
    }

    /// Plays a guest action without a signature. Not exported by the wasm: the golden test uses
    /// it to seat the simulation's guests, whose keys it does not have.
    #[doc(hidden)]
    pub fn act_unsigned(&mut self, guest: AccountId, action: Action) -> ActOutcome {
        let mut logs = Logs::new();
        let result = self.guest_action(&guest, action, &mut logs);
        logs.emit();
        ActOutcome {
            ok: result.is_ok(),
            error: result.err(),
            nonce: 0,
            round: self.clock_round(env::block_timestamp_ms()),
        }
    }
}

pub(crate) fn parse_hex<const N: usize>(s: &str) -> Option<[u8; N]> {
    if s.len() != N * 2 {
        return None;
    }
    let digit = |b: u8| match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        _ => None,
    };
    let bytes = s.as_bytes();
    let mut out = [0u8; N];
    for i in 0..N {
        out[i] = digit(bytes[i * 2])? << 4 | digit(bytes[i * 2 + 1])?;
    }
    Some(out)
}
