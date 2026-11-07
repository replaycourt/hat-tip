//! Payouts in the DAO: filing, the three tiers, votes, outcomes, failures and the pause.
mod common;

use common::*;
use hat_tip::types::Status;
use near_sdk::AccountId;
use near_sdk::base64::Engine;
use near_sdk::base64::engine::general_purpose::STANDARD;
use near_sdk::serde_json::{self, Value, json};

fn everyone_gives(w: &mut World) {
    let m = members();
    for (i, giver) in m.iter().enumerate() {
        let gifts: Vec<(&AccountId, u16)> =
            m.iter().enumerate().filter(|(j, _)| *j != i).map(|(_, a)| (a, 14)).collect();
        assert!(w.allocate(giver, &gifts).ok);
    }
}

/// Round 1 builds reputation (98 thanks each); round 2 plans m1 12 tUSD (tier 1), m6 30
/// (tier 2), m2 48 (tier 3) and m5 30 (tier 2). Returns their payout ids.
fn three_tiers(w: &mut World) -> (u64, u64, u64, u64) {
    let m = members();
    w.at(1, 100);
    everyone_gives(w);
    w.close_through(1);
    w.at(2, 100);
    assert!(w.allocate(&m[0], &[(&m[1], 10), (&m[6], 25), (&m[2], 40)]).ok);
    assert!(w.allocate(&m[4], &[(&m[5], 25)]).ok);
    w.close_through(2);
    let p = w.round_payouts(2);
    let by = |a: &AccountId| p.iter().find(|x| &x.receiver == a).unwrap().clone();
    let (t1, t2, t3, t2b) = (by(&m[1]), by(&m[6]), by(&m[2]), by(&m[5]));
    assert_eq!((t1.amount.0, t1.tier), (12 * USD, 1));
    assert_eq!((t2.amount.0, t2.tier), (30 * USD, 2));
    assert_eq!((t3.amount.0, t3.tier), (48 * USD, 3));
    assert_eq!((t2b.amount.0, t2b.tier), (30 * USD, 2));
    (t1.id, t2.id, t3.id, t2b.id)
}

fn prop(w: &mut World, id: u64) -> Prop {
    let p = w.payout(id).dao_proposal.expect("filed");
    w.dao.proposal(p).cloned().expect("in the DAO")
}

#[test]
fn tier_1_is_approved_by_the_contract_and_paid_in_the_filing_chain() {
    let mut w = World::new();
    let (t1, ..) = three_tiers(&mut w);
    let m = members();
    w.dao.calls.clear();
    w.pay_all();
    assert_eq!(w.payout(t1).status, Status::Approved);
    let p = prop(&mut w, t1);
    assert_eq!(p.status, "Approved");
    assert_eq!(p.proposer, CONTRACT);
    assert_eq!(p.description, format!("Hat Tip r2: 10.0 thanks from 1 -> {} (auto)", m[1]));
    assert_eq!(p.kind, json!({"Transfer": {"token_id": TOKEN, "receiver_id": m[1].as_str(), "amount": "12000000"}}));
    assert_eq!(w.dao.balance(m[1].as_str()), 12 * USD, "round 1's tier-3 payout is not voted yet");
    assert_eq!(w.check(t1), Status::Paid);
    let paid = entries(&w.events(Some("paid")));
    assert_eq!(paid.len(), 1);
    assert_eq!(paid[0]["payout"], t1);
    assert_eq!(paid[0]["amount"], "12000000");
    assert_eq!(entries(&w.events(Some("approved"))).len(), 1);
    // The tier-1 chain: register, file, vote; nothing else votes for the contract.
    let votes = w.executed.iter().filter(|c| c.method == "act_proposal").count();
    assert_eq!(votes, 1);
    w.assert_audit();
}

#[test]
fn tier_2_is_a_function_call_that_one_council_vote_approves_or_rejects() {
    let mut w = World::new();
    let (_, t2, _, t2b) = three_tiers(&mut w);
    let m = members();
    w.pay_all();
    let p = prop(&mut w, t2);
    let f = &p.kind["FunctionCall"];
    assert_eq!(f["receiver_id"], TOKEN);
    let a = &f["actions"][0];
    assert_eq!(
        (a["method_name"].as_str(), a["deposit"].as_str(), a["gas"].as_str()),
        (Some("ft_transfer"), Some("1"), Some("15000000000000"))
    );
    let args: Value = serde_json::from_slice(&STANDARD.decode(a["args"].as_str().unwrap()).unwrap()).unwrap();
    assert_eq!(args, json!({"receiver_id": m[6].as_str(), "amount": "30000000"}));
    assert!(p.description.ends_with("(one council vote)"));
    assert_eq!(w.payout(t2).status, Status::Filed);
    // The contract's own role cannot approve a call.
    let pid = w.payout(t2).dao_proposal.unwrap();
    assert_eq!(w.dao.act(CONTRACT, pid, "VoteApprove", None, 0).unwrap_err(), "ERR_PERMISSION_DENIED");
    w.vote(&council()[2], t2, "VoteApprove").unwrap();
    assert_eq!(w.check(t2), Status::Paid);
    assert_eq!(w.dao.balance(m[6].as_str()), 30 * USD);

    let before = w.rep(&m[5]);
    w.vote(&council()[0], t2b, "VoteReject").unwrap();
    assert_eq!(w.check(t2b), Status::Rejected);
    assert_eq!(before - w.rep(&m[5]), 25_000, "the round's 25 thanks, not yet decayed");
    w.assert_audit();
}

#[test]
fn tier_3_needs_the_council_majority_and_a_removal_strikes() {
    let mut w = World::new();
    let (_, _, t3, _) = three_tiers(&mut w);
    let m = members();
    w.pay_all();
    assert!(prop(&mut w, t3).description.ends_with("(council majority)"));
    w.vote(&council()[0], t3, "VoteApprove").unwrap();
    assert_eq!(w.check(t3), Status::Filed);
    assert_eq!(w.last_check.as_ref().unwrap().changed, false);
    let before = w.rep(&m[2]);
    let returned = w.dao.bonds_returned;
    w.vote(&council()[1], t3, "VoteRemove").unwrap();
    w.vote(&council()[2], t3, "VoteRemove").unwrap();
    let pid = w.payout(t3).dao_proposal.unwrap();
    assert!(w.dao.proposal(pid).is_none(), "Sputnik deletes a removed proposal");
    assert_eq!(w.check(t3), Status::Removed);
    assert_eq!(before - w.rep(&m[2]), 40_000);
    assert_eq!(w.dao.bonds_returned, returned, "the DAO keeps a removed proposal's bond");
    assert_eq!(entries(&w.events(Some("removed"))).len(), 1);
    w.assert_audit();
}

#[test]
fn an_expired_proposal_is_finalized_and_recorded_on_the_next_check() {
    let mut w = World::new();
    w.dao.period_ns = 30 * 60 * 1_000_000_000;
    w.sync();
    assert_eq!(w.state().proposal_period_ns.0, 30 * 60 * 1_000_000_000);
    let (_, _, t3, _) = three_tiers(&mut w);
    w.pay_all();
    w.at(3, 100);
    assert_eq!(w.check(t3), Status::Filed, "not expired yet");
    w.at(5, 0);
    let returned = w.dao.bonds_returned;
    assert_eq!(w.check(t3), Status::Filed, "finalized now, recorded on the next check");
    assert_eq!(prop(&mut w, t3).status, "Expired");
    assert_eq!(w.dao.bonds_returned, returned + BOND);
    assert_eq!(w.check(t3), Status::Expired);
    assert_eq!(w.member(&members()[2]).strikes, 0, "no strike for an expiry");
    w.assert_audit();
}

#[test]
fn a_failed_transfer_is_retried_once_after_registering_the_receiver() {
    let mut w = World::new();
    let (_, _, t3, _) = three_tiers(&mut w);
    let m = members();
    w.pay_all();
    // The receiver leaves the token before the council approves.
    w.dao.registered.remove(m[2].as_str());
    w.vote(&council()[0], t3, "VoteApprove").unwrap();
    w.vote(&council()[1], t3, "VoteApprove").unwrap();
    assert_eq!(prop(&mut w, t3).status, "Failed");
    w.dao.calls.clear();
    assert_eq!(w.check(t3), Status::Filed, "retried: registered again and finalized");
    assert_eq!(w.dao.calls, vec!["get_proposals", "storage_deposit", "act_proposal"]);
    assert_eq!(prop(&mut w, t3).status, "Approved");
    assert_eq!(w.check(t3), Status::Paid);
    assert_eq!(w.dao.balance(m[2].as_str()), 48 * USD);
}

#[test]
fn a_second_failure_is_final() {
    let mut w = World::new();
    let (_, _, t3, _) = three_tiers(&mut w);
    w.pay_all();
    // The DAO cannot pay: the transfer fails, and fails again on the retry.
    w.dao.balances.insert(DAO.into(), USD);
    w.vote(&council()[0], t3, "VoteApprove").unwrap();
    w.vote(&council()[1], t3, "VoteApprove").unwrap();
    assert_eq!(w.check(t3), Status::Filed);
    assert_eq!(prop(&mut w, t3).status, "Failed");
    assert_eq!(w.check(t3), Status::Failed);
    assert_eq!(w.check(t3), Status::Failed);
    assert_eq!(entries(&w.events(Some("failed"))).len(), 1);
    assert_eq!(w.member(&members()[2]).strikes, 0, "a failed transfer is no strike");
    w.assert_audit();
}

#[test]
fn a_failing_add_proposal_pauses_until_a_sync_sees_the_dao_fit_again() {
    let mut w = World::new();
    three_tiers(&mut w);
    // The DAO raised its bond: add_proposal refuses the old one.
    w.dao.bond = 2 * BOND;
    let out = w.pay(3);
    assert_eq!(out.filing.len(), 3);
    let s = w.state();
    assert!(s.paused);
    assert!(s.pause_reason.unwrap().contains("add_proposal failed"));
    assert!(w.payouts().iter().all(|p| p.status == Status::Planned));
    let out = w.pay(3);
    assert!(out.filing.is_empty() && out.error.unwrap().starts_with("paused"));
    w.sync();
    assert!(!w.state().paused);
    assert_eq!(w.state().bond.0, 2 * BOND);
    w.pay_all();
    assert!(w.payouts().iter().all(|p| p.status != Status::Planned));
    assert_eq!(w.dao.bonds_held + w.dao.bonds_returned, 12 * 2 * BOND);
    let paused = entries(&w.events(Some("paused")));
    assert_eq!(paused.iter().map(|e| e["paused"].as_bool().unwrap()).collect::<Vec<_>>(), vec![false, true, false]);
    w.assert_audit();
}

#[test]
fn a_dao_role_without_the_contract_or_a_permission_pauses_it() {
    let mut w = World::new();
    w.dao.thanks_perms.retain(|p| p != "call:Finalize");
    w.sync();
    assert_eq!(w.state().pause_reason.as_deref(), Some("the DAO role thanks lacks call:Finalize"));
    w.dao.thanks_perms = vec!["*:*".into()];
    w.sync();
    assert!(!w.state().paused, "wildcards count");
    w.dao.thanks.clear();
    w.sync();
    assert_eq!(w.state().pause_reason.as_deref(), Some("this contract is not in the DAO role thanks"));
    // A close re-reads the policy too.
    w.dao.thanks = vec![CONTRACT.into()];
    let m = members();
    w.at(1, 100);
    w.allocate(&m[0], &[(&m[1], 10)]);
    w.close_through(1);
    assert!(!w.state().paused);
}

#[test]
fn a_failed_vote_or_registration_leaves_the_payout_safe() {
    let mut w = World::new();
    let (t1, ..) = three_tiers(&mut w);
    w.dao.fail.insert("act_proposal".into());
    w.pay_all();
    assert_eq!(w.payout(t1).status, Status::Filed, "the tier-1 transfer now waits for the council");
    assert!(w.state().pause_reason.unwrap().contains("VoteApprove failed"));
    w.dao.fail.clear();
    w.vote(&council()[0], t1, "VoteApprove").unwrap();
    w.vote(&council()[1], t1, "VoteApprove").unwrap();
    assert_eq!(w.check(t1), Status::Paid);

    let mut w = World::new();
    three_tiers(&mut w);
    w.dao.fail.insert("storage_deposit".into());
    w.pay(2);
    assert!(w.payouts().iter().all(|p| p.status == Status::Planned));
    assert!(w.state().pause_reason.unwrap().contains("storage_deposit"));
    w.assert_audit();
}

#[test]
fn stale_callbacks_change_nothing() {
    // (`#[private]` is enforced by the SDK's wasm entry points, which the mock VM bypasses.)
    let mut w = World::new();
    let (t1, ..) = three_tiers(&mut w);
    // A forged success for a payout that is not filing is ignored.
    let me = contract_id();
    let ok = vec![near_sdk::PromiseResult::Successful(b"7".to_vec())];
    w.exec(&me, 300_000_000_000_000, ok, |c| c.on_filed(t1));
    assert_eq!(w.payout(t1).status, Status::Planned);
    assert_eq!(w.payout(t1).dao_proposal, None);
    let out =
        w.exec(&me, 300_000_000_000_000, vec![near_sdk::PromiseResult::Failed, near_sdk::PromiseResult::Failed], |c| {
            c.on_close(1)
        });
    assert_eq!(out.error.as_deref(), Some("round already closed"));
    w.assert_audit();
}

#[test]
fn a_close_waits_for_the_dao_and_retries_when_it_does_not_answer() {
    let mut w = World::new();
    let m = members();
    w.at(1, 100);
    w.allocate(&m[0], &[(&m[1], 10)]);
    w.at(2, 0);
    w.dao.fail.insert("get_policy".into());
    w.close();
    assert_eq!(w.state().oldest_unclosed, 1);
    assert!(w.last_close.as_ref().unwrap().error.as_ref().unwrap().contains("did not answer"));
    assert_eq!(w.state().closing, None);
    w.dao.fail.clear();

    // In flight: a second close waits, until the retry time has passed.
    w.auto_run = false;
    let out = w.call(&acc("anyone.testnet"), |c| value(c.close_round()));
    assert!(out.is_none());
    assert_eq!(w.state().closing, Some(1));
    let out = w.call(&acc("anyone.testnet"), |c| value(c.close_round())).unwrap();
    assert!(out.error.unwrap().contains("already waits"));
    w.now_ms += hat_tip::config::CLOSE_RETRY_MS;
    let out = w.call(&acc("anyone.testnet"), |c| value(c.close_round()));
    assert!(out.is_none(), "retried");
    assert_eq!(w.queued(), 6);
    w.auto_run = true;
    w.run();
    assert_eq!(w.state().oldest_unclosed, 2);
    assert_eq!(w.last_close.as_ref().unwrap().error.as_deref(), Some("round already closed"));
    assert_eq!(entries(&w.events(Some("round_closed"))).len(), 1);
    w.assert_audit();
}

#[test]
fn the_member_list_holds_named_accounts_up_to_max_members() {
    let mut c = cfg();
    c.max_members = 5;
    let mut w = World::bare(c);
    w.dao.members.push("a".repeat(64).replace('a', "0"));
    w.dao.members.push(format!("0x{}", "ab".repeat(20)));
    w.sync();
    let s = w.state();
    assert_eq!(s.members, members()[..5].to_vec());
    assert_eq!(s.council, council());
    let e = entries(&w.events(Some("synced")));
    assert_eq!(e.last().unwrap()["dropped"], 3);
    assert_eq!(e.last().unwrap()["members"], 5);
}

#[test]
fn pay_files_what_the_gas_and_the_balance_allow() {
    let mut w = World::new();
    three_tiers(&mut w);
    let planned = w.state().planned;
    assert_eq!(planned, 12);
    w.gas_tgas = 150;
    let out = w.pay(10);
    assert_eq!(out.filing.len(), 1, "{out:?}");
    assert!(out.error.unwrap().contains("not enough gas"));
    w.gas_tgas = 300;
    w.balance = near_sdk::NearToken::from_millinear(60).as_yoctonear();
    let out = w.pay(10);
    assert!(out.filing.is_empty());
    assert!(out.error.unwrap().contains("balance is too low"));
    w.balance = near_sdk::NearToken::from_near(50).as_yoctonear();
    w.pay_all();
    assert_eq!(w.state().planned, 0);
    w.assert_audit();
}

#[test]
fn check_payout_reports_unfiled_payouts_and_refuses_unknown_ones() {
    let mut w = World::new();
    let (t1, ..) = three_tiers(&mut w);
    assert_eq!(w.check(t1), Status::Planned);
    assert_eq!(w.last_check.as_ref().unwrap().changed, false);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| w.check(999)));
    assert!(r.is_err());
}
