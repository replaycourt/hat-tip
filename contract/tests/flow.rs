//! End to end through the mock DAO: a round of thanks becomes points, payouts in three tiers,
//! DAO proposals, votes and transfers.
mod common;

use common::*;
use hat_tip::types::Status;

#[test]
fn a_round_becomes_payouts_in_the_dao() {
    let mut w = World::new();
    let m = members();
    w.at(1, 100);
    for (i, giver) in m.iter().enumerate() {
        let a = &m[(i + 1) % 8];
        let b = &m[(i + 2) % 8];
        let out = w.allocate(giver, &[(a, 30), (b, 20)]);
        assert!(out.ok, "{out:?}");
        assert_eq!(out.given, 50);
    }
    w.close_through(1);
    let r = w.round(1).unwrap();
    assert!(r.closed);
    assert_eq!(r.points.len(), 8);
    assert!(r.points.iter().all(|(_, p)| p.0 == 50_000));
    assert_eq!(r.budget.0, 120 * USD);
    let payouts = w.round_payouts(1);
    assert_eq!(payouts.len(), 8);
    // Newcomers: no auto limit, co-sign base 5 tUSD; 15 tUSD each needs the council majority.
    assert!(payouts.iter().all(|p| p.amount.0 == 15 * USD && p.tier == 3), "{payouts:?}");
    w.assert_audit();

    w.pay_all();
    assert!(w.payouts().iter().all(|p| p.status == Status::Filed));
    assert_eq!(w.dao.proposals.len(), 8);
    let id = payouts[0].id;
    w.vote(&council()[0], id, "VoteApprove").unwrap();
    assert_eq!(w.check(id), Status::Filed, "one council vote is not enough for tier 3");
    w.vote(&council()[1], id, "VoteApprove").unwrap();
    assert_eq!(w.check(id), Status::Paid);
    assert_eq!(w.dao.balance(payouts[0].receiver.as_str()), 15 * USD);
    w.assert_audit();
}
