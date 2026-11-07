//! The budget, shares, carries and their lapse, and the books that keep them.
mod common;

use common::*;

#[test]
fn a_small_share_is_carried_and_paid_with_the_next_one() {
    let mut w = World::new();
    let m = members();
    w.at(1, 100);
    w.allocate(&m[0], &[(&m[1], 40), (&m[3], 40), (&m[4], 19), (&m[2], 1)]);
    w.close_through(1);
    // 1 thanks of 100: 1.2 tUSD, below min_payout (2): carried.
    let mm = w.member(&m[2]);
    assert_eq!((mm.carry.0, mm.carry_since), (1_200_000, 1));
    assert!(w.round_payouts(1).iter().all(|p| p.receiver != m[2]));
    let c = entries(&w.events(Some("carry")));
    assert_eq!(c.len(), 1);
    assert_eq!((c[0]["account"].as_str().unwrap(), c[0]["amount"].as_str().unwrap()), (m[2].as_str(), "1200000"));

    w.at(2, 100);
    w.allocate(&m[0], &[(&m[1], 40), (&m[3], 40), (&m[4], 19), (&m[2], 1)]);
    w.close_through(2);
    let p = w.round_payouts(2);
    let to_m2 = p.iter().find(|p| p.receiver == m[2]).expect("paid with the carry");
    assert_eq!(to_m2.amount.0, 2_400_000);
    assert_eq!(w.member(&m[2]).carry.0, 0);
    w.assert_audit();
    let a = w.audit();
    assert_eq!(a.budgets.0, 240 * USD);
    assert_eq!(a.planned.0, 240 * USD);
    assert_eq!(a.carry.0, 0);
}

#[test]
fn a_carry_lapses_after_carry_rounds() {
    let mut c = cfg();
    c.carry_rounds = 3;
    let mut w = World::with(c);
    let m = members();
    w.at(1, 100);
    w.allocate(&m[0], &[(&m[1], 40), (&m[3], 40), (&m[4], 19), (&m[2], 1)]);
    w.close_through(3);
    assert_eq!(w.member(&m[2]).carry.0, 1_200_000);
    w.close_through(4);
    assert_eq!(w.member(&m[2]).carry.0, 0);
    let l = entries(&w.events(Some("carry_lapsed")));
    assert_eq!(l.len(), 1);
    assert_eq!((l[0]["round"].as_u64(), l[0]["since"].as_u64()), (Some(4), Some(1)));
    let a = w.audit();
    assert_eq!(a.lapsed.0, 1_200_000);
    w.assert_audit();
}

#[test]
fn a_carry_that_is_added_to_keeps_its_first_round() {
    let mut c = cfg();
    c.carry_rounds = 3;
    let mut w = World::with(c);
    let m = members();
    for n in 1..=3 {
        w.at(n, 100);
        // 1 thanks of 300 for m2 each round: 0.4 tUSD, still below 2 after three rounds.
        w.allocate(&m[0], &[(&m[1], 40), (&m[3], 40), (&m[4], 19), (&m[2], 1)]);
        w.allocate(&m[5], &[(&m[1], 40), (&m[3], 40), (&m[4], 20)]);
        w.allocate(&m[6], &[(&m[1], 40), (&m[3], 40), (&m[4], 20)]);
        w.close_through(n);
    }
    let mm = w.member(&m[2]);
    assert_eq!((mm.carry.0, mm.carry_since), (1_200_000, 1));
    w.close_through(4);
    assert_eq!(w.member(&m[2]).carry.0, 0, "lapses at round 1 + 3 although it grew");
    assert_eq!(w.audit().lapsed.0, 1_200_000);
    w.assert_audit();
}

#[test]
fn the_budget_is_capped_by_what_the_dao_holds_above_the_reserve() {
    let mut c = cfg();
    c.reserve = near_sdk::json_types::U128(10 * USD);
    let mut w = World::with(c);
    let m = members();
    w.dao.balances.insert(DAO.into(), 50 * USD);
    w.at(1, 100);
    w.allocate(&m[0], &[(&m[1], 30), (&m[2], 10)]);
    w.close_through(1);
    assert_eq!(w.round(1).unwrap().budget.0, 40 * USD);
    assert_eq!(w.round(1).unwrap().dao_balance.0, 50 * USD);
    let p = w.round_payouts(1);
    assert_eq!(p.iter().map(|x| x.amount.0).collect::<Vec<_>>(), vec![30 * USD, 10 * USD]);

    // A DAO below the reserve pays nothing; the round still counts for reputation.
    w.dao.balances.insert(DAO.into(), 5 * USD);
    w.at(2, 100);
    w.allocate(&m[0], &[(&m[3], 30)]);
    w.close_through(2);
    let r = w.round(2).unwrap();
    assert_eq!(r.budget.0, 0);
    assert!(r.payouts.is_empty());
    assert_eq!(w.rep(&m[3]), 30_000);
    assert_eq!(w.member(&m[3]).carry.0, 0);
    w.assert_audit();
}

#[test]
fn rounding_dust_stays_in_the_dao_and_in_the_books() {
    let mut w = World::new();
    let m = members();
    w.at(1, 100);
    // Seven equal receivers of 120,000,000: 17,142,857 each, 1 left over.
    let gifts: Vec<(&near_sdk::AccountId, u16)> = m[1..].iter().map(|a| (a, 10)).collect();
    w.allocate(&m[0], &gifts);
    w.close_through(1);
    let r = w.round(1).unwrap();
    assert_eq!(r.dust.0, 1);
    assert!(w.round_payouts(1).iter().all(|p| p.amount.0 == 17_142_857));
    let a = w.audit();
    assert_eq!(a.dust.0, 1);
    assert_eq!(a.budgets.0, a.planned.0 + a.dust.0);
    w.assert_audit();
}
