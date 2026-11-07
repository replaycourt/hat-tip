//! Read-only views.

use crate::config::*;
use crate::dao;
use crate::math;
use crate::types::*;
use crate::{HatTip, HatTipExt, signing_message};
use near_sdk::json_types::{U64, U128};
use near_sdk::{AccountId, env, near};

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct StateView {
    pub name: String,
    /// The round the clock is in (0 before genesis).
    pub round: u64,
    pub round_ends_ms: u64,
    pub oldest_unclosed: u64,
    /// Rounds whose end has passed and that are not closed yet.
    pub due: u64,
    /// A round waiting for the DAO's answer to its close.
    pub closing: Option<u64>,
    pub members: Vec<AccountId>,
    pub council: Vec<AccountId>,
    pub guests_seated: Vec<AccountId>,
    pub paused: bool,
    pub pause_reason: Option<String>,
    pub last_sync_ms: u64,
    pub bond: U128,
    pub proposal_period_ns: U64,
    /// Payouts waiting for `pay`.
    pub planned: u64,
    /// Payouts filing, filed or approved (in the DAO, no final status yet).
    pub open_payouts: u64,
    pub next_payout: u64,
    /// Payouts below this id are pruned from storage, except `held_payouts`.
    pub oldest_payout: u64,
    /// Payouts older than `log_keep` rounds without a final status yet, kept until they have
    /// one (`payouts()` lists them too).
    pub held_payouts: Vec<u64>,
    pub totals: Totals,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct RoundView {
    pub n: u64,
    pub closed: bool,
    pub starts_ms: u64,
    pub ends_ms: u64,
    pub dao_balance: U128,
    pub budget: U128,
    pub dust: U128,
    pub notes: Vec<(AccountId, String)>,
    pub seats: Vec<AccountId>,
    /// `(giver, receiver, given, counted)`; `counted` is 0 until the round is closed.
    pub gifts: Vec<(AccountId, AccountId, u16, U128)>,
    pub points: Vec<(AccountId, U128)>,
    pub payouts: Vec<u64>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Limits {
    pub auto: U128,
    pub cosign: U128,
    /// The reputation the limits come from (as of the last closed round).
    pub reputation: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct HistoryRow {
    pub round: u64,
    pub points: U128,
    /// `(giver, given, counted)`.
    pub givers: Vec<(AccountId, u16, U128)>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct MemberView {
    pub account: AccountId,
    /// `member`, `guest` (an implicit account) or `other`.
    pub kind: String,
    pub reputation: U128,
    pub carry: U128,
    pub carry_since: u64,
    pub limits: Limits,
    pub strikes: u32,
    pub open_payouts: u32,
    /// Rounds with points still in the round log, oldest first.
    pub history: Vec<HistoryRow>,
    pub payouts: Vec<PayoutView>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct PayoutView {
    pub id: u64,
    pub round: u64,
    pub receiver: AccountId,
    pub amount: U128,
    pub tier: u8,
    pub status: Status,
    pub dao_proposal: Option<u64>,
    /// `transfer` (tiers 1 and 3) or `function_call` (tier 2).
    pub kind: String,
    pub points: U128,
    pub givers: u16,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct AuditView {
    /// Every budget is accounted for: budgets = planned + carry + lapsed + dust.
    pub balanced: bool,
    /// Points equal the sum of their attributions, in total and in every kept round.
    pub points_attributed: bool,
    /// The payouts by status add up to every payout planned, the kept ones agree, and the ones
    /// without a final status add up to what the totals leave open.
    pub statuses_ok: bool,
    /// Every kept payout past filing has a DAO proposal id.
    pub filed_have_ids: bool,
    /// The carries of the accounts with a carry add up to the carry total.
    pub carry_ok: bool,
    pub budgets: U128,
    pub planned: U128,
    pub carry: U128,
    pub lapsed: U128,
    pub dust: U128,
    pub payouts: u64,
    pub by_status: Vec<(Status, u64)>,
}

impl HatTip {
    fn payout_view(&self, id: u64) -> Option<PayoutView> {
        self.payouts.get(&id).map(|p| PayoutView {
            id,
            round: p.round,
            receiver: p.receiver.clone(),
            amount: U128(p.amount),
            tier: p.tier,
            status: p.status,
            dao_proposal: p.proposal,
            kind: dao::kind_name(p.tier).into(),
            points: U128(p.points),
            givers: p.givers,
        })
    }

    fn reputation_now(&self, a: &AccountId, acct: &Acct) -> u128 {
        math::decay_rounds(acct.rep, self.cfg.decay_bp as u128, dao::is_implicit(a), acct.rep_round, self.last_closed)
    }

    fn limits_of(&self, a: &AccountId, rep: u128) -> Limits {
        let (auto, cosign) = math::limits(&self.cfg, rep, dao::is_implicit(a));
        Limits { auto: U128(auto), cosign: U128(cosign), reputation: U128(rep) }
    }

    fn kept(&self, n: u64) -> bool {
        n >= 1 && n + self.cfg.log_keep as u64 > self.last_closed.max(n)
    }
}

#[near]
impl HatTip {
    pub fn config(&self) -> Config {
        self.cfg.clone()
    }

    pub fn state(&self) -> StateView {
        let now = env::block_timestamp_ms();
        let round = self.clock_round(now);
        let mut due = 0;
        let mut r = self.last_closed + 1;
        while self.round_end_ms(r) <= now && due < 100_000 {
            due += 1;
            r += 1;
        }
        let s = self.totals.by_status;
        let guests_seated = self
            .rounds
            .get(&round)
            .map(|l| l.seats.iter().map(|&i| l.accounts[i as usize].clone()).collect())
            .unwrap_or_default();
        StateView {
            name: NAME.into(),
            round,
            round_ends_ms: if round == 0 { self.cfg.genesis_ms } else { self.round_end_ms(round) },
            oldest_unclosed: self.last_closed + 1,
            due,
            closing: self.closing.map(|c| c.0),
            members: self.members.clone(),
            council: self.council.clone(),
            guests_seated,
            paused: self.paused.is_some(),
            pause_reason: self.paused.clone(),
            last_sync_ms: self.last_sync_ms,
            bond: U128(self.bond),
            proposal_period_ns: U64(self.proposal_period_ns),
            planned: s[Status::Planned as usize],
            open_payouts: s[Status::Filing as usize] + s[Status::Filed as usize] + s[Status::Approved as usize],
            next_payout: self.next_payout,
            oldest_payout: self.prune_cursor,
            held_payouts: self.held.clone(),
            totals: self.totals.clone(),
        }
    }

    /// A round of the last `log_keep`, or the open ones. `None` for rounds pruned or not started.
    pub fn round(&self, n: u64) -> Option<RoundView> {
        let clock = self.clock_round(env::block_timestamp_ms());
        if n == 0 || n > clock.max(self.last_closed) || !self.kept(n) {
            return None;
        }
        let l = self.rounds.get(&n).cloned().unwrap_or_default();
        let name = |i: u16| l.accounts[i as usize].clone();
        Some(RoundView {
            n,
            closed: n <= self.last_closed,
            starts_ms: self.round_end_ms(n - 1),
            ends_ms: self.round_end_ms(n),
            dao_balance: U128(l.dao_balance),
            budget: U128(l.budget),
            dust: U128(l.dust),
            notes: l.notes.iter().map(|(i, t)| (name(*i), t.clone())).collect(),
            seats: l.seats.iter().map(|&i| name(i)).collect(),
            gifts: l.gifts.iter().map(|g| (name(g.giver), name(g.receiver), g.given, U128(g.counted))).collect(),
            points: l.points.iter().map(|(i, p)| (name(*i), U128(*p))).collect(),
            payouts: l.payouts.clone(),
        })
    }

    pub fn member(&self, account_id: AccountId) -> MemberView {
        let acct = self.accounts.get(&account_id).cloned().unwrap_or_default();
        let rep = self.reputation_now(&account_id, &acct);
        let kind = if self.is_member(&account_id) {
            "member"
        } else if dao::is_implicit(&account_id) {
            "guest"
        } else {
            "other"
        };
        let history = acct
            .hist
            .iter()
            .filter(|(n, _)| self.kept(*n))
            .map(|(n, p)| {
                let givers = self
                    .rounds
                    .get(n)
                    .and_then(|l| {
                        let me = l.index_of(&account_id)?;
                        Some(
                            l.gifts
                                .iter()
                                .filter(|g| g.receiver == me)
                                .map(|g| (l.accounts[g.giver as usize].clone(), g.given, U128(g.counted)))
                                .collect(),
                        )
                    })
                    .unwrap_or_default();
                HistoryRow { round: *n, points: U128(*p), givers }
            })
            .collect();
        MemberView {
            limits: self.limits_of(&account_id, rep),
            account: account_id,
            kind: kind.into(),
            reputation: U128(rep),
            carry: U128(acct.carry),
            carry_since: acct.carry_since,
            strikes: acct.strikes,
            open_payouts: acct.open,
            history,
            payouts: acct.payouts.iter().filter_map(|id| self.payout_view(*id)).collect(),
        }
    }

    /// Payouts with ids from `from` to `from + limit` (up to 100), skipping pruned ones.
    pub fn payouts(&self, from: u64, limit: u64) -> Vec<PayoutView> {
        let end = self.next_payout.min(from.saturating_add(limit.min(100)));
        let mut ids: Vec<u64> =
            self.held.iter().copied().filter(|id| *id >= from && *id < end && *id < self.prune_cursor).collect();
        ids.sort_unstable();
        ids.extend(from.max(self.prune_cursor)..end);
        ids.into_iter().filter_map(|id| self.payout_view(id)).collect()
    }

    /// The account's auto and co-sign limits for the next close.
    pub fn tiers(&self, account_id: AccountId) -> Limits {
        let acct = self.accounts.get(&account_id).cloned().unwrap_or_default();
        let rep = self.reputation_now(&account_id, &acct);
        self.limits_of(&account_id, rep)
    }

    pub fn audit(&self) -> AuditView {
        let t = &self.totals;
        let balanced = t.budgets.0 == t.planned.0 + t.carry.0 + t.lapsed.0 + t.dust.0;
        let carry_sum: u128 = self.carries.iter().map(|a| self.accounts.get(a).map_or(0, |x| x.carry)).sum();
        let carry_ok = carry_sum == t.carry.0;

        let mut points_attributed = t.points == t.attributed;
        let first = self.last_closed.saturating_sub(self.cfg.log_keep as u64 - 1).max(1);
        for n in first..=self.last_closed {
            let Some(l) = self.rounds.get(&n) else { continue };
            for (i, p) in &l.points {
                let sum: u128 = l.gifts.iter().filter(|g| g.receiver == *i).map(|g| g.counted).sum();
                points_attributed &= sum == *p;
            }
            let all: u128 = l.gifts.iter().map(|g| g.counted).sum();
            points_attributed &= all == l.points.iter().map(|x| x.1).sum::<u128>();
        }

        let counted: u64 = t.by_status.iter().sum();
        let mut statuses_ok = counted == self.next_payout;
        let mut filed_have_ids = true;
        let mut kept = [0u64; 9];
        let mut open = 0u128;
        for id in self.held.iter().copied().chain(self.prune_cursor..self.next_payout) {
            if let Some(p) = self.payouts.get(&id) {
                kept[p.status as usize] += 1;
                if !p.status.is_final() {
                    open += p.amount;
                }
                if !matches!(p.status, Status::Planned | Status::Filing) {
                    filed_have_ids &= p.proposal.is_some();
                }
            }
        }
        // What the payouts without a final status add up to, from the records and the totals.
        statuses_ok &= open == t.open();
        for (i, s) in Status::ALL.iter().enumerate() {
            // Pruned payouts are final; every non-final one is still kept.
            if !s.is_final() {
                statuses_ok &= kept[i] == t.by_status[i];
            } else {
                statuses_ok &= kept[i] <= t.by_status[i];
            }
        }
        AuditView {
            balanced,
            points_attributed,
            statuses_ok,
            filed_have_ids,
            carry_ok,
            budgets: t.budgets.clone(),
            planned: t.planned.clone(),
            carry: t.carry.clone(),
            lapsed: t.lapsed.clone(),
            dust: t.dust.clone(),
            payouts: self.next_payout,
            by_status: Status::ALL.iter().map(|s| (*s, t.by_status[*s as usize])).collect(),
        }
    }

    /// The exact text a guest's key signs for `act`.
    pub fn signing_text(&self, nonce: u64, action: String) -> String {
        signing_message(env::current_account_id().as_str(), nonce, &action)
    }
}
