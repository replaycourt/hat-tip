//! Nothing a lost callback, a race between checks or a long pause leaves behind may stop the
//! contract: it has no keys, so a stuck state would be for good. Regression tests for the
//! pre-lock review (2026-11-07): a payout stuck in `filing` (finding 1), two checks racing a
//! retry and an `Approved` read before the transfer failed (finding 3), the logs of a long
//! catch-up, and guests when the contract runs low on NEAR (finding 2).
mod common;

use common::*;
use hat_tip::config::{LOG_BUDGET, RETRY_BLOCKS, SETTLE_BLOCKS};
use hat_tip::types::Status;
use near_sdk::AccountId;
use near_sdk::json_types::U128;

fn everyone_gives(w: &mut World) {
    let m = members();
    for (i, giver) in m.iter().enumerate() {
        let gifts: Vec<(&AccountId, u16)> =
            m.iter().enumerate().filter(|(j, _)| *j != i).map(|(_, a)| (a, 14)).collect();
        assert!(w.allocate(giver, &gifts).ok);
    }
}

/// The council approves every filed payout but `skip`, and the keeper checks them.
fn settle_all(w: &mut World, skip: u64) {
    for p in w.payouts() {
        if p.id == skip {
            continue;
        }
        if p.status == Status::Filed {
            let _ = w.vote(&council()[0], p.id, "VoteApprove");
            let _ = w.vote(&council()[1], p.id, "VoteApprove");
        }
        if matches!(p.status, Status::Filed | Status::Approved) {
            w.check(p.id);
        }
    }
}

/// Files the first planned payout and loses its chain: it stays `filing` for good.
fn lose_one_filing(w: &mut World) -> u64 {
    w.auto_run = false;
    let out = w.pay(1);
    assert_eq!(out.filing.len(), 1);
    w.drop_queue();
    w.auto_run = true;
    let stuck = out.filing[0];
    assert_eq!(w.payout(stuck).status, Status::Filing);
    stuck
}

/// Review test B: a payout whose `on_filed` never lands used to hold the pay cursor (and the
/// prune cursor) for good; `pay` looked only 64 ids past it, so after 64 more payouts nothing was
/// filed again (10 rounds later: 16 planned, never filed).
#[test]
fn a_payout_stuck_in_filing_stops_no_later_payout() {
    let mut w = World::new();
    w.at(1, 100);
    everyone_gives(&mut w);
    w.close_through(1);
    let stuck = lose_one_filing(&mut w);
    assert_eq!(w.check(stuck), Status::Filing, "no proposal id: check_payout cannot see it");
    w.pay_all();
    let mut r = 2;
    while w.state().next_payout < stuck + 100 {
        w.at(r, 100);
        everyone_gives(&mut w);
        w.close_through(r);
        w.pay_all();
        r += 1;
    }
    let st = w.state();
    assert_eq!(st.planned, 0, "every payout after the stuck one is filed");
    assert_eq!(st.totals.by_status[Status::Filing as usize], 1, "only the stuck one is filing");
    assert_eq!(w.payout(stuck).status, Status::Filing);
    w.assert_audit();
}

/// Pruning moves past a payout without a final status once it is `log_keep` rounds old, holds
/// it, and prunes it the moment it gets one; before, it stopped at the first such payout.
#[test]
fn pruning_moves_past_payouts_that_are_not_final() {
    let mut c = cfg();
    c.log_keep = 3;
    let mut w = World::with(c);
    w.at(1, 100);
    everyone_gives(&mut w);
    w.close_through(1);
    let round1_end = w.state().next_payout;
    let stuck = lose_one_filing(&mut w);
    w.pay_all();
    // One payout of round 1 the council leaves alone: filed, not final.
    let waiting = w.round_payouts(1).into_iter().find(|p| p.id != stuck && p.status == Status::Filed).unwrap().id;
    let prop = w.payout(waiting).dao_proposal.unwrap();
    w.dao.proposals[prop as usize].as_mut().unwrap().submission_ns = u64::MAX / 2;
    for r in 2..=8 {
        w.at(r, 100);
        everyone_gives(&mut w);
        w.close_through(r);
        w.pay_all();
        settle_all(&mut w, waiting);
        w.assert_audit();
    }
    let st = w.state();
    assert!(st.oldest_payout >= round1_end, "past round 1: {st:?}");
    let mut held = st.held_payouts.clone();
    held.sort();
    assert_eq!(held, vec![stuck.min(waiting), stuck.max(waiting)]);
    assert_eq!(w.view(|c| c.payouts(stuck, 1))[0].status, Status::Filing, "a held payout stays in view");
    // `waiting` gets its votes: it is booked, and pruned at once.
    w.dao.proposals[prop as usize].as_mut().unwrap().submission_ns = w.now_ms * 1_000_000;
    w.vote(&council()[0], waiting, "VoteApprove").unwrap();
    w.vote(&council()[1], waiting, "VoteApprove").unwrap();
    assert_eq!(w.check(waiting), Status::Paid);
    assert_eq!(w.state().held_payouts, vec![stuck]);
    assert!(w.view(|c| c.payouts(waiting, 1)).is_empty());
    w.assert_audit();
}

/// A tier-3 payout of round 1 whose receiver left the token: the council's second vote turns
/// the proposal `Failed`. Returns (payout, DAO proposal id).
fn failed_payout(w: &mut World) -> (u64, u64) {
    w.at(1, 100);
    everyone_gives(w);
    w.close_through(1);
    w.pay_all();
    let p = w.round_payouts(1).into_iter().find(|p| p.tier == 3).expect("a tier-3 payout");
    w.dao.registered.remove(p.receiver.as_str());
    w.vote(&council()[0], p.id, "VoteApprove").unwrap();
    w.vote(&council()[1], p.id, "VoteApprove").unwrap();
    let id = w.payout(p.id).dao_proposal.unwrap();
    assert_eq!(w.dao.proposal(id).unwrap().status, "Failed");
    (p.id, id)
}

/// Review test D: two checks in flight on a `Failed` proposal. The first starts the retry; the
/// second, which read `Failed` before the retry ran, used to book `failed` for good while the
/// retry paid the receiver (contract: failed, DAO: Approved, receiver paid).
#[test]
fn a_check_racing_the_retry_changes_nothing() {
    let mut w = World::new();
    let (id, prop) = failed_payout(&mut w);
    let p = w.payout(id);
    w.auto_run = false;
    w.call(&acc("a.testnet"), |c| {
        let _ = value(c.check_payout(id));
    });
    w.call(&acc("b.testnet"), |c| {
        let _ = value(c.check_payout(id));
    });
    w.auto_run = true;
    w.run();
    assert_ne!(w.payout(id).status, Status::Failed, "the second check booked failed while the retry ran");
    assert_eq!(w.dao.proposal(prop).unwrap().status, "Approved");
    assert_eq!(w.dao.balance(p.receiver.as_str()), p.amount.0);
    assert_eq!(w.check(id), Status::Paid);
    assert!(entries(&w.events(Some("failed"))).is_empty());
    assert_eq!(entries(&w.events(Some("paid"))).len(), 1);
    w.assert_audit();
}

/// Finding 3a: Sputnik sets `Approved` before it runs the transfer and `Failed` two blocks
/// later. A check that read `Approved` in between used to book `paid` for good: no retry, the
/// receiver unpaid, the bond locked. Now `paid` needs a second `Approved` asked for at least
/// SETTLE_BLOCKS after the first was seen.
#[test]
fn approved_is_booked_only_when_seen_again_blocks_later() {
    let mut w = World::new();
    w.at(1, 100);
    everyone_gives(&mut w);
    w.close_through(1);
    w.pay_all();
    let p = w.round_payouts(1).into_iter().find(|p| p.tier == 3).expect("a tier-3 payout");
    let prop = w.payout(p.id).dao_proposal.unwrap();
    // The council's second vote: Approved, the transfer still on its way (and doomed: the
    // receiver left the token).
    w.dao.registered.remove(p.receiver.as_str());
    w.dao.proposals[prop as usize].as_mut().unwrap().status = "Approved".into();
    assert_eq!(w.check_once(p.id), Status::Filed, "a first Approved is only noted");
    assert_eq!(w.check_once(p.id), Status::Filed, "a second one asked too soon changes nothing");
    // Two blocks later the DAO's callback marks it Failed.
    w.dao.proposals[prop as usize].as_mut().unwrap().status = "Failed".into();
    w.blocks(SETTLE_BLOCKS);
    assert_eq!(w.check_once(p.id), Status::Filed, "Failed: retried (registered, finalized)");
    assert_eq!(w.dao.proposal(prop).unwrap().status, "Approved");
    assert_eq!(w.dao.balance(p.receiver.as_str()), p.amount.0, "the retry paid");
    assert_eq!(w.check(p.id), Status::Paid);
    assert_eq!(entries(&w.events(Some("paid"))).len(), 1);
    w.assert_audit();
}

/// A retry whose chain is lost (no `on_finalized`) holds the payout only for RETRY_BLOCKS.
#[test]
fn a_lost_retry_holds_the_payout_only_for_a_while() {
    let mut w = World::new();
    let (id, _) = failed_payout(&mut w);
    w.auto_run = false;
    w.check_once(id);
    assert!(w.step(), "get_proposals and on_checked");
    w.drop_queue();
    w.auto_run = true;
    assert_eq!(w.check(id), Status::Filed, "in flight");
    w.blocks(RETRY_BLOCKS);
    assert_eq!(w.check(id), Status::Failed, "the one retry is spent; a second Failed is final");
    w.assert_audit();
}

/// Review test C, larger: after a long pause one `close_round` closes up to `max_catchup` empty
/// rounds, and every carry of 12 rounds of guests lapses on the way. With 64-character member
/// names its logs passed 16 KiB, and every `close_round` failed for good. Now a call stops
/// before LOG_BUDGET and the next one goes on.
#[test]
fn a_long_catch_up_spreads_its_logs_over_several_calls() {
    let mut c = cfg();
    c.min_payout = U128(1_000_000 * USD); // every share becomes a carry
    c.guest_receive_cap_bp = 800;
    c.max_catchup = 60;
    c.carry_rounds = 12;
    let mut w = World::bare(c);
    let m: Vec<AccountId> = (0..24).map(|i| format!("{i:02}{}.testnet", "m".repeat(54)).parse().unwrap()).collect();
    w.dao.members = m.iter().map(|a| a.to_string()).collect();
    w.sync();
    let mut seed = 1_000;
    for r in 1..=12u64 {
        w.at(r, 100);
        let mut keys: Vec<Key> = (0..6)
            .map(|_| {
                seed += 1;
                Key::new(seed)
            })
            .collect();
        for k in keys.iter_mut() {
            assert!(w.join(k, None).ok);
        }
        let guests: Vec<AccountId> = keys.iter().map(|k| k.account.clone()).collect();
        for (i, giver) in m.iter().enumerate() {
            let mut gifts: Vec<(&AccountId, u16)> = (1..=9).map(|d| (&m[(i + d) % 24], 10)).collect();
            gifts.push((&guests[i % 6], 10));
            assert!(w.allocate(giver, &gifts).ok);
        }
        w.close_through(r);
    }
    let carried = w.audit().carry.0;
    assert!(carried > 0);
    // Nobody acts for 40 rounds.
    w.at(13 + 40, 0);
    let mut calls = 0;
    let mut lapsed = 0;
    loop {
        let before = w.state().oldest_unclosed;
        w.call(&acc("anyone.testnet"), |c| value(c.close_round()));
        let bytes: usize = w.last_logs.iter().map(|l| l.len()).sum();
        assert!(bytes <= LOG_BUDGET, "{bytes} bytes of logs");
        eprintln!("close_round: {bytes} bytes of logs");
        lapsed += entries(&w.last_events(Some("carry_lapsed"))).len();
        if w.state().oldest_unclosed == before {
            break;
        }
        calls += 1;
    }
    eprintln!("40 empty rounds closed in {calls} calls; {lapsed} carries lapsed");
    assert_eq!(w.state().oldest_unclosed, 13 + 40);
    assert!(calls >= 2, "more than one call: one would have passed the log limit");
    assert_eq!(lapsed, 24 + 72);
    assert_eq!(w.audit().carry.0, 0);
    assert_eq!(w.audit().lapsed.0, carried);
    w.assert_audit();
}

/// Finding 2: below 1 NEAR free, guests (whose seats, notes and gifts the contract pays) are
/// refused with a clear reason; members still give.
#[test]
fn guests_wait_while_the_contract_is_low_on_near() {
    let mut w = World::new();
    let m = members();
    w.at(1, 100);
    let mut k = Key::new(77);
    w.balance = near_sdk::NearToken::from_millinear(900).as_yoctonear();
    let out = w.join(&mut k, Some("hello"));
    assert!(!out.ok);
    assert!(out.error.unwrap().contains("less than 1 NEAR free"));
    assert!(w.state().guests_seated.is_empty());
    assert!(w.allocate(&m[0], &[(&m[1], 10)]).ok, "members still give");
    w.balance = near_sdk::NearToken::from_near(50).as_yoctonear();
    assert!(w.join(&mut k, Some("hello")).ok);
    assert_eq!(w.state().guests_seated, vec![k.account.clone()]);
}
