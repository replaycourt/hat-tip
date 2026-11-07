//! Filing planned payouts as DAO proposals, the tier-1 vote, and reading their outcome.

use crate::config::*;
use crate::dao::{self, Seen};
use crate::events::*;
use crate::math;
use crate::types::*;
use crate::{HatTip, HatTipExt, free_balance, remaining_gas};
use near_sdk::json_types::U128;
use near_sdk::serde_json::{Value, json};
use near_sdk::{Gas, NearToken, Promise, PromiseOrValue, env, near};

fn callback_with(method: &str, args: Value, gas: Gas) -> Promise {
    Promise::new(env::current_account_id()).function_call(
        method,
        args.to_string().into_bytes(),
        NearToken::from_yoctonear(0),
        gas,
    )
}

fn callback(method: &str, payout: u64, gas: Gas) -> Promise {
    callback_with(method, json!({ "payout": payout }), gas)
}

/// `on_filed`: its own work, and for tier 1 the vote and its callback.
pub fn gas_on_filed(tier: u8) -> Gas {
    if tier == 1 {
        GAS_OWN.saturating_add(GAS_LINK).saturating_add(GAS_ACT_PROPOSAL).saturating_add(GAS_ON_VOTED)
    } else {
        GAS_ON_FILED
    }
}

/// What starting `add_proposal -> on_filed` costs its creator.
pub fn gas_filing(tier: u8) -> Gas {
    GAS_LINK.saturating_add(GAS_ADD_PROPOSAL).saturating_add(gas_on_filed(tier))
}

pub fn gas_on_registered(tier: u8) -> Gas {
    GAS_OWN.saturating_add(gas_filing(tier))
}

/// What starting `storage_deposit -> on_registered` costs its creator.
pub fn gas_registering(tier: u8) -> Gas {
    GAS_LINK.saturating_add(GAS_STORAGE_DEPOSIT).saturating_add(gas_on_registered(tier))
}

/// `on_checked`: at most `storage_deposit -> act_proposal(Finalize) -> on_finalized`.
pub fn gas_on_checked() -> Gas {
    GAS_OWN
        .saturating_add(GAS_LINK.saturating_mul(2))
        .saturating_add(GAS_STORAGE_DEPOSIT)
        .saturating_add(GAS_ACT_PROPOSAL)
        .saturating_add(GAS_ON_FINALIZED)
}

#[near]
impl HatTip {
    /// Files up to `max` planned payouts, oldest first, as many as the attached gas and the
    /// contract's balance allow. Per payout: `storage_deposit` on the token if the receiver is
    /// not yet registered, then `add_proposal` with the DAO's bond, then (tier 1) the contract's
    /// own `VoteApprove`. The chains run on their own; `filing` lists the payouts they carry.
    pub fn pay(&mut self, max: u8) -> PayOutcome {
        if let Some(reason) = &self.paused {
            return PayOutcome { filing: Vec::new(), error: Some(format!("paused: {reason}")) };
        }
        let mut filing = Vec::new();
        let mut error = None;
        let end = self.next_payout.min(self.pay_cursor.saturating_add(PAY_SCAN));
        let mut id = self.pay_cursor;
        while id < end && filing.len() < max as usize {
            let Some(p) = self.payouts.get(&id).cloned() else {
                id += 1;
                continue;
            };
            if p.status != Status::Planned {
                id += 1;
                continue;
            }
            let register = !self.accounts.get(&p.receiver).is_some_and(|a| a.registered);
            let gas = if register { gas_registering(p.tier) } else { gas_filing(p.tier) };
            if remaining_gas() < gas.saturating_add(GAS_MARGIN) {
                error = Some(format!("not enough gas for payout {id}"));
                break;
            }
            let deposit = self.bond + if register { REGISTRATION_DEPOSIT.as_yoctonear() } else { 0 };
            if free_balance() < deposit + FLOAT_MIN.as_yoctonear() {
                error = Some("the contract's balance is too low for the bond".into());
                break;
            }
            if register {
                Promise::new(self.cfg.token.clone())
                    .function_call(
                        "storage_deposit",
                        json!({"account_id": p.receiver, "registration_only": true}).to_string().into_bytes(),
                        REGISTRATION_DEPOSIT,
                        GAS_STORAGE_DEPOSIT,
                    )
                    .then(callback("on_registered", id, gas_on_registered(p.tier)))
                    .detach();
            } else {
                self.file(id, &p).detach();
            }
            self.set_status(id, Status::Filing);
            filing.push(id);
            id += 1;
        }
        self.advance_pay_cursor();
        PayOutcome { filing, error }
    }

    #[private]
    pub fn on_registered(&mut self, payout: u64) {
        let ok = env::promise_result_checked(0, 1_024).is_ok();
        let Some(p) = self.payouts.get(&payout).cloned().filter(|p| p.status == Status::Filing) else { return };
        let mut logs = Logs::new();
        if !ok {
            self.replan(payout);
            self.pause("storage_deposit on the token failed", &mut logs);
        } else {
            if let Some(a) = self.accounts.get_mut(&p.receiver) {
                a.registered = true;
            }
            if free_balance() < self.bond + FLOAT_MIN.as_yoctonear() {
                self.replan(payout);
            } else {
                self.file(payout, &p).detach();
            }
        }
        logs.emit();
    }

    /// Its work does not grow with the state: tiers 2 and 3 give it only `GAS_ON_FILED`. (It
    /// used to move the pay cursor too, reading one payout per id filed after this one: a long
    /// backlog ran it out of gas and left the payout `filing` for good.)
    #[private]
    pub fn on_filed(&mut self, payout: u64) {
        let id = env::promise_result_checked(0, 64).ok().and_then(|b| near_sdk::serde_json::from_slice::<u64>(&b).ok());
        let Some(mut p) = self.payouts.get(&payout).cloned().filter(|p| p.status == Status::Filing) else { return };
        let mut logs = Logs::new();
        match id {
            None => {
                self.replan(payout);
                self.pause("add_proposal failed: the DAO role, the bond or the policy changed", &mut logs);
            }
            Some(id) => {
                p.proposal = Some(id);
                p.status = Status::Filed;
                self.adjust(Status::Filing, Status::Filed);
                self.payouts.insert(payout, p.clone());
                logs.push(
                    Kind::Filed,
                    &FiledEvent { payout, proposal: id, tier: p.tier, kind: dao::kind_name(p.tier) },
                );
                if p.tier == 1 {
                    let kind = dao::proposal_kind(1, &self.cfg.token, &p.receiver, p.amount);
                    Promise::new(self.cfg.dao.clone())
                        .function_call(
                            "act_proposal",
                            dao::act_proposal_args(id, "VoteApprove", &kind),
                            NearToken::from_yoctonear(0),
                            GAS_ACT_PROPOSAL,
                        )
                        .then(callback("on_voted", payout, GAS_ON_VOTED))
                        .detach();
                }
            }
        }
        logs.emit();
    }

    #[private]
    pub fn on_voted(&mut self, payout: u64) {
        let ok = env::promise_result_checked(0, 1_024).is_ok();
        let Some(p) = self.payouts.get(&payout).cloned().filter(|p| p.status == Status::Filed) else { return };
        let mut logs = Logs::new();
        if ok {
            self.set_status(payout, Status::Approved);
            logs.push(Kind::Approved, &json!({"payout": payout, "proposal": p.proposal}));
        } else {
            self.pause("the contract's VoteApprove failed: the DAO role changed", &mut logs);
        }
        logs.emit();
    }

    /// Reads a filed payout's DAO proposal and records the outcome: `paid` (Approved, seen
    /// twice at least `SETTLE_BLOCKS` apart), `rejected` or `removed` (both a strike), `failed`,
    /// or `expired` (after finalizing it in the DAO, which returns the bond). A payout still in
    /// progress stays as it is.
    pub fn check_payout(&mut self, payout: u64) -> PromiseOrValue<CheckOutcome> {
        let p = self.payouts.get(&payout).cloned().unwrap_or_else(|| env::panic_str("no such payout (or pruned)"));
        let (Some(id), false) = (p.proposal, p.status.is_final()) else {
            return PromiseOrValue::Value(CheckOutcome { payout, status: p.status, changed: false });
        };
        let need =
            GAS_LINK.saturating_add(GAS_GET_PROPOSAL).saturating_add(gas_on_checked()).saturating_add(GAS_MARGIN);
        if remaining_gas() < need {
            env::panic_str(&format!("this call needs {} Tgas", need.as_tgas() + 5));
        }
        PromiseOrValue::Promise(
            Promise::new(self.cfg.dao.clone())
                .function_call(
                    "get_proposals",
                    json!({"from_index": id, "limit": 1}).to_string().into_bytes(),
                    NearToken::from_yoctonear(0),
                    GAS_GET_PROPOSAL,
                )
                .then(callback_with(
                    "on_checked",
                    json!({"payout": payout, "asked": env::block_height()}),
                    gas_on_checked(),
                )),
        )
    }

    /// `asked`: the block of the `check_payout` that read the proposal.
    #[private]
    pub fn on_checked(&mut self, payout: u64, asked: u64) -> PromiseOrValue<CheckOutcome> {
        let answer = env::promise_result_checked(0, MAX_RESULT_BYTES).ok();
        let Some(p) = self.payouts.get(&payout).cloned() else {
            env::panic_str("no such payout");
        };
        let same = PromiseOrValue::Value(CheckOutcome { payout, status: p.status, changed: false });
        let (Some(id), false) = (p.proposal, p.status.is_final()) else { return same };
        // A retry is in flight, or the answer was read before the last Finalize settled.
        if asked < p.settle_at {
            return same;
        }
        let Some(seen) = answer.and_then(|b| dao::parse_proposals(&b, id)) else { return same };
        let now = env::block_height();
        let finalize = |s: &Self| {
            let kind = dao::proposal_kind(p.tier, &s.cfg.token, &p.receiver, p.amount);
            Promise::new(s.cfg.dao.clone()).function_call(
                "act_proposal",
                dao::act_proposal_args(id, "Finalize", &kind),
                NearToken::from_yoctonear(0),
                GAS_ACT_PROPOSAL,
            )
        };
        let to = match &seen {
            Seen::Missing => Status::Removed,
            Seen::Found { status, submission_ns } => match status.as_str() {
                // Sputnik shows Approved while the transfer still runs; a failed transfer turns
                // it Failed in a later block. Paid on a second Approved, asked for at least
                // SETTLE_BLOCKS after the first was seen.
                "Approved" if p.approved_at > 0 && asked >= p.approved_at.saturating_add(SETTLE_BLOCKS) => Status::Paid,
                "Approved" => {
                    if p.approved_at == 0 {
                        let mut q = p.clone();
                        q.approved_at = now;
                        self.payouts.insert(payout, q);
                    }
                    return same;
                }
                "Rejected" => Status::Rejected,
                "Removed" => Status::Removed,
                "Expired" => Status::Expired,
                "Moved" => Status::Failed,
                "Failed"
                    if p.retried || free_balance() < REGISTRATION_DEPOSIT.as_yoctonear() + FLOAT_MIN.as_yoctonear() =>
                {
                    Status::Failed
                }
                "Failed" => {
                    // The transfer failed, most likely because the receiver left the token. Register
                    // it again and finalize: the DAO re-runs an approved proposal (once).
                    // Until on_finalized lands (or RETRY_BLOCKS pass), answers change nothing.
                    let mut q = p.clone();
                    q.retried = true;
                    q.approved_at = 0;
                    q.settle_at = now.saturating_add(RETRY_BLOCKS);
                    self.payouts.insert(payout, q);
                    let chain = Promise::new(self.cfg.token.clone())
                        .function_call(
                            "storage_deposit",
                            json!({"account_id": p.receiver, "registration_only": true}).to_string().into_bytes(),
                            REGISTRATION_DEPOSIT,
                            GAS_STORAGE_DEPOSIT,
                        )
                        .then(finalize(self))
                        .then(callback("on_finalized", payout, GAS_ON_FINALIZED));
                    return PromiseOrValue::Promise(chain);
                }
                "InProgress" => {
                    let deadline = submission_ns.saturating_add(self.proposal_period_ns);
                    if self.proposal_period_ns > 0 && deadline < env::block_timestamp() {
                        return PromiseOrValue::Promise(finalize(self).then(callback(
                            "on_finalized",
                            payout,
                            GAS_ON_FINALIZED,
                        )));
                    }
                    return same;
                }
                _ => return same,
            },
        };
        PromiseOrValue::Value(self.conclude(payout, to))
    }

    /// After the contract's `Finalize` (of an expired proposal, or of a failed one it retries).
    /// Ends the retry in flight; the outcome is read by a `check_payout` asked for at least
    /// `SETTLE_BLOCKS` later (the DAO's own callback runs after this one), from the DAO's record.
    #[private]
    pub fn on_finalized(&mut self, payout: u64) -> CheckOutcome {
        let p = self.payouts.get(&payout).cloned().unwrap_or_else(|| env::panic_str("no such payout"));
        if !p.status.is_final() {
            let mut q = p.clone();
            q.settle_at = env::block_height().saturating_add(SETTLE_BLOCKS);
            self.payouts.insert(payout, q);
        }
        CheckOutcome { payout, status: p.status, changed: false }
    }
}

impl HatTip {
    /// The `add_proposal` chain of one payout.
    fn file(&self, payout: u64, p: &Payout) -> Promise {
        let kind = dao::proposal_kind(p.tier, &self.cfg.token, &p.receiver, p.amount);
        let text = dao::description(NAME, p.round, p.points, p.givers, &p.receiver, p.tier);
        Promise::new(self.cfg.dao.clone())
            .function_call(
                "add_proposal",
                dao::add_proposal_args(&text, &kind),
                NearToken::from_yoctonear(self.bond),
                GAS_ADD_PROPOSAL,
            )
            .then(callback("on_filed", payout, gas_on_filed(p.tier)))
    }

    fn adjust(&mut self, from: Status, to: Status) {
        self.totals.by_status[from as usize] -= 1;
        self.totals.by_status[to as usize] += 1;
    }

    fn set_status(&mut self, payout: u64, to: Status) {
        let Some(mut p) = self.payouts.get(&payout).cloned() else { return };
        self.adjust(p.status, to);
        p.status = to;
        self.payouts.insert(payout, p);
    }

    /// Puts a payout whose filing surely did not happen back to planned, for the next `pay`.
    fn replan(&mut self, payout: u64) {
        self.set_status(payout, Status::Planned);
        self.pay_cursor = self.pay_cursor.min(payout);
    }

    /// Moves the pay cursor to the first planned payout. Only `pay` calls it, with ample gas: a
    /// payout that stays filing (its chain lost) cannot hold the cursor, and nothing behind it.
    fn advance_pay_cursor(&mut self) {
        let end = self.next_payout.min(self.pay_cursor.saturating_add(PAY_SCAN));
        while self.pay_cursor < end {
            match self.payouts.get(&self.pay_cursor) {
                Some(p) if p.status == Status::Planned => break,
                _ => self.pay_cursor += 1,
            }
        }
    }

    /// Records a final outcome, with the strike it brings.
    fn conclude(&mut self, payout: u64, to: Status) -> CheckOutcome {
        let mut p = self.payouts.get(&payout).cloned().unwrap_or_else(|| env::panic_str("no such payout"));
        let from = p.status;
        self.adjust(from, to);
        p.status = to;
        self.payouts.insert(payout, p.clone());
        let amount = U128(p.amount);
        let slot = match to {
            Status::Paid => &mut self.totals.paid,
            Status::Rejected => &mut self.totals.rejected,
            Status::Expired => &mut self.totals.expired,
            Status::Removed => &mut self.totals.removed,
            _ => &mut self.totals.failed,
        };
        slot.0 += p.amount;
        // A payout the prune moved past (held) is pruned as soon as it is final.
        if let Some(i) = self.held.iter().position(|x| *x == payout) {
            self.held.swap_remove(i);
            self.payouts.remove(&payout);
        }
        let mut logs = Logs::new();
        let proposal = p.proposal.unwrap_or(0);
        let kind = match to {
            Status::Paid => Kind::Paid,
            Status::Rejected => Kind::Rejected,
            Status::Expired => Kind::Expired,
            Status::Removed => Kind::Removed,
            _ => Kind::Failed,
        };
        logs.push(kind, &OutcomeEvent { payout, proposal, receiver: &p.receiver, amount });
        let d = self.cfg.decay_bp as u128;
        let last = self.last_closed;
        let guest = dao::is_implicit(&p.receiver);
        if let Some(a) = self.accounts.get_mut(&p.receiver) {
            a.open = a.open.saturating_sub(1);
            if matches!(to, Status::Rejected | Status::Removed) {
                let now = math::decay_rounds(a.rep, d, guest, a.rep_round, last);
                let strike = math::decay_rounds(p.points, d, false, p.round, last);
                a.rep = now.saturating_sub(strike);
                a.rep_round = last;
                a.strikes += 1;
                self.totals.strikes += 1;
                let reputation = U128(a.rep);
                logs.push(
                    Kind::Struck,
                    &StruckEvent {
                        payout,
                        round: p.round,
                        account: &p.receiver,
                        points: p.points as u64,
                        strike: U128(strike),
                        reputation,
                    },
                );
            }
        }
        logs.emit();
        CheckOutcome { payout, status: to, changed: true }
    }
}
