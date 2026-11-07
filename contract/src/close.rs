//! Closing rounds, and reading the DAO policy (`sync`, and at every close with allocations).

use crate::config::*;
use crate::dao::{self, PolicyFacts};
use crate::events::*;
use crate::math::{self, Entry, Role, Rules};
use crate::types::*;
use crate::{HatTip, HatTipExt};
use near_sdk::json_types::{U64, U128};
use near_sdk::serde_json::{self, json};
use near_sdk::{AccountId, NearToken, Promise, PromiseOrValue, env, near};

/// A planned payout before it gets its id.
struct Plan {
    receiver: AccountId,
    amount: u128,
    tier: u8,
    points: u128,
    givers: u16,
}

#[near]
impl HatTip {
    /// Reads the DAO policy: members, council, bond, and whether this contract's role can file
    /// and approve payouts (if not, the contract pauses `pay`).
    pub fn sync(&mut self) -> Promise {
        let need = GAS_LINK.saturating_add(GAS_GET_POLICY).saturating_add(GAS_ON_POLICY).saturating_add(GAS_MARGIN);
        require_gas(need);
        Promise::new(self.cfg.dao.clone())
            .function_call("get_policy", b"{}".to_vec(), NearToken::from_yoctonear(0), GAS_GET_POLICY)
            .then(Promise::new(env::current_account_id()).function_call(
                "on_policy",
                b"{}".to_vec(),
                NearToken::from_yoctonear(0),
                GAS_ON_POLICY,
            ))
    }

    #[private]
    pub fn on_policy(&mut self) -> SyncOutcome {
        let facts = env::promise_result_checked(0, MAX_RESULT_BYTES).ok().and_then(|b| self.parse_policy(&b));
        let mut logs = Logs::new();
        let ok = match facts {
            Some(f) => {
                self.apply_policy(f, true, &mut logs);
                true
            }
            None => false,
        };
        logs.emit();
        SyncOutcome {
            ok,
            members: self.members.len() as u32,
            council: self.council.len() as u32,
            bond: U128(self.bond),
            paused: self.paused.is_some(),
        }
    }

    /// Closes due rounds in order. Rounds nobody gave in close at once (up to `max_catchup` per
    /// call). The first due round with allocations is counted after the DAO answers: the call
    /// then returns the promise of `get_policy` and `ft_balance_of(dao)`, joined into
    /// `on_close(round)`, whose `CloseOutcome` becomes the call's result.
    pub fn close_round(&mut self) -> PromiseOrValue<CloseOutcome> {
        let now = env::block_timestamp_ms();
        let mut logs = Logs::new();
        let mut closed = 0u32;
        let mut waiting = None;
        let mut error = None;
        let mut promise = None;
        loop {
            let r = self.last_closed + 1;
            if self.round_end_ms(r) > now {
                break;
            }
            if self.rounds.get(&r).is_some_and(|l| l.has_gifts()) {
                waiting = Some(r);
                if let Some((cr, since)) = self.closing
                    && cr == r
                    && now < since.saturating_add(CLOSE_RETRY_MS)
                {
                    error = Some(format!("round {r} already waits for the DAO"));
                    break;
                }
                let need = GAS_LINK
                    .saturating_mul(2)
                    .saturating_add(GAS_GET_POLICY)
                    .saturating_add(GAS_FT_BALANCE)
                    .saturating_add(GAS_ON_CLOSE)
                    .saturating_add(GAS_MARGIN);
                if env::prepaid_gas().saturating_sub(env::used_gas()) < need {
                    error = Some(format!("closing round {r} needs {} Tgas", need.as_tgas() + 5));
                    break;
                }
                self.closing = Some((r, now));
                let zero = NearToken::from_yoctonear(0);
                let policy = Promise::new(self.cfg.dao.clone()).function_call(
                    "get_policy",
                    b"{}".to_vec(),
                    zero,
                    GAS_GET_POLICY,
                );
                let balance = Promise::new(self.cfg.token.clone()).function_call(
                    "ft_balance_of",
                    json!({"account_id": self.cfg.dao}).to_string().into_bytes(),
                    zero,
                    GAS_FT_BALANCE,
                );
                let cb = Promise::new(env::current_account_id()).function_call(
                    "on_close",
                    json!({"round": r}).to_string().into_bytes(),
                    zero,
                    GAS_ON_CLOSE,
                );
                promise = Some(policy.and(balance).then(cb));
                break;
            }
            if closed >= self.cfg.max_catchup as u32 {
                break;
            }
            self.close_empty(r, &mut logs);
            closed += 1;
        }
        if closed > 0 {
            self.sweep();
        }
        logs.emit();
        match promise {
            Some(p) => PromiseOrValue::Promise(p),
            None => PromiseOrValue::Value(CloseOutcome { closed, last_closed: self.last_closed, waiting, error }),
        }
    }

    /// Counts round `round` with the DAO policy and the DAO's token balance just read.
    #[private]
    pub fn on_close(&mut self, round: u64) -> CloseOutcome {
        let policy = env::promise_result_checked(0, MAX_RESULT_BYTES);
        let balance = env::promise_result_checked(1, 256);
        let stale = self.last_closed + 1 != round;
        if let Some((cr, _)) = self.closing
            && cr == round
        {
            self.closing = None;
        }
        let out = |s: &Self, closed, error: &str| CloseOutcome {
            closed,
            last_closed: s.last_closed,
            waiting: None,
            error: if error.is_empty() { None } else { Some(error.to_string()) },
        };
        if stale {
            return out(self, 0, "round already closed");
        }
        let facts = policy.ok().and_then(|b| self.parse_policy(&b));
        let balance = balance.ok().and_then(|b| serde_json::from_slice::<U128>(&b).ok()).map(|x| x.0);
        let (Some(facts), Some(balance)) = (facts, balance) else {
            return out(self, 0, "the DAO or the token did not answer; call close_round again");
        };
        let mut logs = Logs::new();
        self.apply_policy(facts, false, &mut logs);
        self.close_counted(round, balance, logs);
        self.sweep();
        out(self, 1, "")
    }
}

fn require_gas(need: near_sdk::Gas) {
    if env::prepaid_gas().saturating_sub(env::used_gas()) < need {
        env::panic_str(&format!("this call needs {} Tgas", need.as_tgas() + 5));
    }
}

impl HatTip {
    pub(crate) fn parse_policy(&self, bytes: &[u8]) -> Option<PolicyFacts> {
        let c = &self.cfg;
        dao::parse_policy(
            bytes,
            &env::current_account_id(),
            &c.members_role,
            &c.council_role,
            &c.thanks_role,
            c.max_members as usize,
        )
    }

    /// Takes over the policy's facts; `synced` is logged when anything changed (always on
    /// `sync`), `paused` when the pause state changes.
    pub(crate) fn apply_policy(&mut self, f: PolicyFacts, always: bool, logs: &mut Logs) {
        let changed = self.members != f.members
            || self.council != f.council
            || self.bond != f.bond
            || self.proposal_period_ns != f.proposal_period_ns;
        self.members = f.members;
        self.council = f.council;
        self.bond = f.bond;
        self.proposal_period_ns = f.proposal_period_ns;
        self.last_sync_ms = env::block_timestamp_ms();
        let pause_changed = self.paused != f.problem;
        self.paused = f.problem;
        if pause_changed {
            let reason = self.paused.as_deref().unwrap_or("the DAO role allows filing again");
            logs.push(Kind::Paused, &PausedEvent { paused: self.paused.is_some(), reason });
        }
        if changed || always || pause_changed {
            logs.push(
                Kind::Synced,
                &SyncedEvent {
                    members: self.members.len() as u32,
                    council: self.council.len() as u32,
                    dropped: f.dropped,
                    bond: U128(self.bond),
                    proposal_period: U64(self.proposal_period_ns),
                    paused: self.paused.is_some(),
                },
            );
        }
    }

    pub(crate) fn pause(&mut self, reason: &str, logs: &mut Logs) {
        if self.paused.as_deref() != Some(reason) {
            self.paused = Some(reason.to_string());
            logs.push(Kind::Paused, &PausedEvent { paused: true, reason });
        }
    }

    /// Closes a round nobody gave in: no budget, no payouts; reputation decays (lazily) and
    /// carries may lapse.
    fn close_empty(&mut self, r: u64, logs: &mut Logs) {
        let mut lapses = Vec::new();
        self.lapse_carries(r, &mut lapses);
        if let Some(mut log) = self.rounds.get(&r).cloned() {
            log.closed = true;
            self.rounds.insert(r, log);
        }
        self.finish_round(r);
        logs.push(
            Kind::RoundClosed,
            &RoundClosedEvent {
                round: r,
                empty: true,
                members: self.members.len() as u32,
                dao_balance: U128(0),
                budget: U128(0),
                points: 0,
                dust: U128(0),
                payouts: 0,
                carries: 0,
                detail: 2,
            },
        );
        for (a, amount, since) in &lapses {
            logs.push(Kind::CarryLapsed, &CarryEvent { round: r, account: a, amount: U128(*amount), since: *since });
        }
    }

    fn finish_round(&mut self, r: u64) {
        self.last_closed = r;
        self.totals.rounds_closed += 1;
        if r > self.cfg.log_keep as u64 {
            self.rounds.remove(&(r - self.cfg.log_keep as u64));
        }
    }

    /// Lapses every carry whose oldest share is `carry_rounds` or more rounds older than `r`.
    fn lapse_carries(&mut self, r: u64, out: &mut Vec<(AccountId, u128, u64)>) {
        let keep = self.cfg.carry_rounds as u64;
        let mut still = Vec::with_capacity(self.carries.len());
        for a in std::mem::take(&mut self.carries) {
            let Some(acct) = self.accounts.get_mut(&a) else { continue };
            if acct.carry == 0 {
                continue;
            }
            if r.saturating_sub(acct.carry_since) >= keep {
                let amount = acct.carry;
                let since = acct.carry_since;
                acct.carry = 0;
                acct.carry_since = 0;
                self.totals.carry.0 -= amount;
                self.totals.lapsed.0 += amount;
                out.push((a, amount, since));
            } else {
                still.push(a);
            }
        }
        self.carries = still;
    }

    /// Counts a round with allocations and plans its payouts (DESIGN.md, "One round", 5-9).
    fn close_counted(&mut self, r: u64, dao_balance: u128, logs: Logs) {
        let c = self.cfg.clone();
        let d = c.decay_bp as u128;
        let mut log = self.rounds.get(&r).cloned().unwrap_or_default();
        let k = log.accounts.len();

        // 5. Counting.
        let mut roles = vec![Role::default(); k];
        for (i, a) in log.accounts.iter().enumerate() {
            roles[i].member = dao::is_named(a) && self.is_member(a);
            roles[i].guest = dao::is_implicit(a) && log.seats.contains(&(i as u16));
        }
        for g in &log.gifts {
            roles[g.giver as usize].gave = true;
        }
        let entries: Vec<Entry> = log
            .gifts
            .iter()
            .map(|g| Entry { giver: g.giver as usize, receiver: g.receiver as usize, given: g.given })
            .collect();
        let counted = math::count(&roles, &entries, &Rules::from_config(&c));
        let mut points = vec![0u128; k];
        let mut givers = vec![0u16; k];
        for (g, x) in log.gifts.iter_mut().zip(&counted) {
            g.counted = *x;
            points[g.receiver as usize] += *x;
            if *x > 0 {
                givers[g.receiver as usize] += 1;
            }
        }
        let total: u128 = points.iter().sum();

        // 7. Budget.
        let budget = if total == 0 { 0 } else { c.round_budget.0.min(dao_balance.saturating_sub(c.reserve.0)) };

        // 6, 8, 9. Reputation, shares, carry and tiers, receiver by receiver in account order.
        let mut order: Vec<usize> = (0..k).filter(|&i| points[i] > 0).collect();
        order.sort_by(|&a, &b| log.accounts[a].cmp(&log.accounts[b]));
        let mut plans: Vec<Plan> = Vec::new();
        let mut new_carries: Vec<(AccountId, u128, u64)> = Vec::new();
        let mut shares = 0u128;
        let keep = c.log_keep as u64;
        for &i in &order {
            let a = log.accounts[i].clone();
            let guest = dao::is_implicit(&a);
            let mut acct = self.accounts.get(&a).cloned().unwrap_or(Acct { rep_round: r - 1, ..Default::default() });
            let r0 = math::decay_rounds(acct.rep, d, guest, acct.rep_round, r - 1);
            let share = budget * points[i] / total;
            shares += share;
            let q = share + acct.carry;
            if q > 0 && q < c.min_payout.0 {
                let since = if acct.carry > 0 { acct.carry_since } else { r };
                self.totals.carry.0 += share;
                if acct.carry == 0 {
                    self.carries.push(a.clone());
                }
                acct.carry = q;
                acct.carry_since = since;
                new_carries.push((a.clone(), q, since));
            } else if q > 0 {
                self.totals.carry.0 -= acct.carry;
                acct.carry = 0;
                acct.carry_since = 0;
                let (auto, cosign) = math::limits(&c, r0, guest);
                plans.push(Plan {
                    receiver: a.clone(),
                    amount: q,
                    tier: math::tier(q, auto, cosign),
                    points: points[i],
                    givers: givers[i],
                });
            }
            let mut rep = math::decay_step(r0, d, guest) + points[i];
            if guest && rep < MILLI {
                rep = 0;
            }
            acct.rep = rep;
            acct.rep_round = r;
            acct.hist.retain(|(n, _)| n + keep > r);
            acct.hist.push((r, points[i]));
            self.accounts.insert(a, acct);
        }
        self.carries.retain(|a| self.accounts.get(a).is_some_and(|x| x.carry > 0));

        // The round cap.
        let mut tiers: Vec<(AccountId, u128, u8)> =
            plans.iter().map(|p| (p.receiver.clone(), p.amount, p.tier)).collect();
        math::round_cap(&mut tiers, budget, c.auto_share_bp as u128);
        let mut planned_ids = Vec::with_capacity(plans.len());
        let mut planned_sum = 0u128;
        for (p, (_, _, tier)) in plans.iter_mut().zip(&tiers) {
            p.tier = *tier;
            let id = self.next_payout;
            self.next_payout += 1;
            planned_sum += p.amount;
            self.payouts.insert(
                id,
                Payout {
                    round: r,
                    receiver: p.receiver.clone(),
                    amount: p.amount,
                    tier: p.tier,
                    status: Status::Planned,
                    proposal: None,
                    points: p.points,
                    givers: p.givers,
                    retried: false,
                },
            );
            self.totals.by_status[0] += 1;
            if let Some(acct) = self.accounts.get_mut(&p.receiver) {
                acct.open += 1;
                acct.payouts.push(id);
                if acct.payouts.len() > MEMBER_PAYOUTS_KEEP {
                    acct.payouts.remove(0);
                }
            }
            planned_ids.push(id);
        }

        // Carries that are now too old.
        let mut lapses = Vec::new();
        self.lapse_carries(r, &mut lapses);

        self.totals.budgets.0 += budget;
        self.totals.planned.0 += planned_sum;
        self.totals.dust.0 += budget - shares;
        self.totals.points.0 += total;
        self.totals.attributed.0 += counted.iter().sum::<u128>();

        // The log.
        let mut point_list: Vec<(u16, u128)> = order.iter().map(|&i| (i as u16, points[i])).collect();
        point_list.sort_by(|a, b| log.accounts[a.0 as usize].cmp(&log.accounts[b.0 as usize]));
        log.closed = true;
        log.dao_balance = dao_balance;
        log.budget = budget;
        log.dust = budget - shares;
        log.points = point_list;
        log.payouts = planned_ids.clone();
        self.finish_round(r);

        // Events, as much detail as fits in one receipt's logs.
        let lapsed_now: Vec<&AccountId> = lapses.iter().map(|x| &x.0).collect();
        let carries: Vec<&(AccountId, u128, u64)> =
            new_carries.iter().filter(|x| !lapsed_now.contains(&&x.0)).collect();
        let base = logs.bytes();
        let mut chosen = None;
        for detail in [2u8, 1, 0] {
            let mut trial = Logs::new();
            self.round_events(r, &log, &plans, &planned_ids, &carries, &lapses, detail, &mut trial);
            if base + trial.bytes() <= LOG_BUDGET || detail == 0 {
                chosen = Some(trial);
                break;
            }
        }
        self.rounds.insert(r, log);
        logs.emit();
        if let Some(t) = chosen {
            t.emit();
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn round_events(
        &self,
        r: u64,
        log: &RoundLog,
        plans: &[Plan],
        ids: &[u64],
        carries: &[&(AccountId, u128, u64)],
        lapses: &[(AccountId, u128, u64)],
        detail: u8,
        logs: &mut Logs,
    ) {
        let total: u128 = log.points.iter().map(|x| x.1).sum();
        logs.push(
            Kind::RoundClosed,
            &RoundClosedEvent {
                round: r,
                empty: false,
                members: self.members.len() as u32,
                dao_balance: U128(log.dao_balance),
                budget: U128(log.budget),
                points: total as u64,
                dust: U128(log.dust),
                payouts: plans.len() as u32,
                carries: carries.len() as u32,
                detail,
            },
        );
        if detail == 0 {
            return;
        }
        // points: {"round","accounts","points":[[receiver, points, [[giver, given, counted], ..]], ..]}
        let mut list = Vec::with_capacity(log.points.len());
        for (i, p) in &log.points {
            if detail == 2 {
                let mut from: Vec<&Gift> = log.gifts.iter().filter(|g| g.receiver == *i).collect();
                from.sort_by(|a, b| log.accounts[a.giver as usize].cmp(&log.accounts[b.giver as usize]));
                let givers: Vec<serde_json::Value> =
                    from.iter().map(|g| json!([g.giver, g.given, g.counted as u64])).collect();
                list.push(json!([i, *p as u64, givers]));
            } else {
                list.push(json!([i, *p as u64]));
            }
        }
        logs.push(Kind::Points, &json!({"round": r, "accounts": log.accounts, "points": list, "detail": detail == 2}));
        for (p, id) in plans.iter().zip(ids) {
            logs.push(
                Kind::PayoutPlanned,
                &PayoutPlannedEvent {
                    payout: *id,
                    round: r,
                    receiver: &p.receiver,
                    amount: U128(p.amount),
                    tier: p.tier,
                    points: p.points as u64,
                    givers: p.givers as u32,
                },
            );
        }
        for (a, amount, since) in carries.iter().map(|x| (&x.0, x.1, x.2)) {
            logs.push(Kind::Carry, &CarryEvent { round: r, account: a, amount: U128(amount), since });
        }
        for (a, amount, since) in lapses {
            logs.push(Kind::CarryLapsed, &CarryEvent { round: r, account: a, amount: U128(*amount), since: *since });
        }
    }

    /// Storage hygiene after a close: deletes guest records with nothing left in them and final
    /// payouts older than `log_keep` rounds. Neither changes any number.
    pub(crate) fn sweep(&mut self) {
        let d = self.cfg.decay_bp as u128;
        let mut looked = 0;
        while looked < GUEST_SWEEP && !self.guests.is_empty() {
            looked += 1;
            if self.guest_cursor >= self.guests.len() {
                self.guest_cursor = 0;
            }
            let i = self.guest_cursor;
            let Some(g) = self.guests.get(i).cloned() else { break };
            let gone = match self.accounts.get(&g) {
                None => true,
                Some(a) => {
                    let rep = math::decay_rounds(a.rep, d, true, a.rep_round, self.last_closed);
                    rep == 0 && a.carry == 0 && a.open == 0 && a.seat <= self.last_closed
                }
            };
            if gone {
                self.accounts.remove(&g);
                self.guests.swap_remove(i);
            } else {
                self.guest_cursor = i + 1;
            }
        }
        let keep = self.cfg.log_keep as u64;
        let mut pruned = 0;
        while pruned < PAYOUT_PRUNE && self.prune_cursor < self.pay_cursor {
            let id = self.prune_cursor;
            match self.payouts.get(&id) {
                Some(p) if p.status.is_final() && p.round + keep <= self.last_closed => {
                    self.payouts.remove(&id);
                }
                Some(_) => break,
                None => {}
            }
            self.prune_cursor += 1;
            pruned += 1;
        }
    }
}
