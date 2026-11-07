//! Reputation: decay, the tiers it unlocks, the round cap, strikes, and closing many rounds.
mod common;

use common::*;
use hat_tip::math::decay_rounds;
use hat_tip::types::Status;
use near_sdk::AccountId;

/// Every member gives 14 thanks to each of the seven others.
fn everyone_gives(w: &mut World) {
    let m = members();
    for (i, giver) in m.iter().enumerate() {
        let gifts: Vec<(&AccountId, u16)> =
            m.iter().enumerate().filter(|(j, _)| *j != i).map(|(_, a)| (a, 14)).collect();
        assert!(w.allocate(giver, &gifts).ok);
    }
}

#[test]
fn reputation_decays_every_round_rounded_down_also_without_a_close_touching_it() {
    let mut w = World::new();
    let m = members();
    w.at(1, 100);
    w.allocate(&m[0], &[(&m[1], 33), (&m[2], 7)]);
    w.close_through(1);
    assert_eq!(w.rep(&m[1]), 33_000);
    let mut expect = 33_000u128;
    for n in 2..=30 {
        if n == 12 {
            w.at(12, 100);
            w.allocate(&m[0], &[(&m[2], 5)]);
        }
        w.close_through(n);
        expect = expect * 9_500 / 10_000;
        assert_eq!(w.rep(&m[1]), expect, "round {n}");
    }
    assert_eq!(w.rep(&m[1]), decay_rounds(33_000, 500, false, 1, 30));
    // m2 got points in rounds 1 and 12: decayed 7,000 to 11, plus 5,000, decayed to 30.
    let at11 = decay_rounds(7_000, 500, false, 1, 11);
    let at12 = at11 * 9_500 / 10_000 + 5_000;
    assert_eq!(w.rep(&m[2]), decay_rounds(at12, 500, false, 12, 30));
    let h = w.member(&m[2]).history;
    assert_eq!(h.iter().map(|r| (r.round, r.points.0)).collect::<Vec<_>>(), vec![(1, 7_000), (12, 5_000)]);
    assert_eq!(h[1].givers, vec![(m[0].clone(), 5, near_sdk::json_types::U128(5_000))]);
}

#[test]
fn tiers_come_from_reputation_before_the_round() {
    let mut w = World::new();
    let m = members();
    w.at(1, 100);
    w.allocate(&m[0], &[(&m[1], 40)]);
    w.allocate(&m[2], &[(&m[1], 10)]);
    w.allocate(&m[3], &[(&m[4], 19)]);
    w.close_through(1);
    // A burst of thanks does not unlock itself: round 1 pays everything in tier 3.
    assert!(w.round_payouts(1).iter().all(|p| p.tier == 3));
    let l = w.tiers(&m[1]);
    assert_eq!((l.auto.0, l.cosign.0, l.reputation.0), (15 * USD, 40 * USD, 50_000));
    // 19 thanks are below auto_rep_min (20): no auto limit, co-sign 5 + 19.
    let l = w.tiers(&m[4]);
    assert_eq!((l.auto.0, l.cosign.0), (0, 24 * USD));

    w.at(2, 100);
    w.allocate(&m[0], &[(&m[1], 10), (&m[2], 30), (&m[3], 40)]);
    w.allocate(&m[5], &[(&m[4], 10), (&m[6], 10)]);
    w.close_through(2);
    let p = w.round_payouts(2);
    let by = |a: &AccountId| p.iter().find(|x| &x.receiver == a).unwrap().clone();
    // 120 tUSD over 100 thanks: m1 12 (auto <= 15), m4 12 (co-sign <= 24), m2 36 (tier 3).
    assert_eq!((by(&m[1]).amount.0, by(&m[1]).tier), (12 * USD, 1));
    assert_eq!((by(&m[4]).amount.0, by(&m[4]).tier), (12 * USD, 2));
    assert_eq!((by(&m[2]).amount.0, by(&m[2]).tier), (36 * USD, 3));
    assert_eq!(by(&m[6]).tier, 3);
}

#[test]
fn the_round_cap_moves_the_largest_auto_payouts_to_one_council_vote() {
    let mut w = World::new();
    w.at(1, 100);
    everyone_gives(&mut w);
    w.close_through(1);
    assert_eq!(w.rep(&members()[0]), 98_000);
    w.at(2, 100);
    everyone_gives(&mut w);
    w.close_through(2);
    let p = w.round_payouts(2);
    assert_eq!(p.len(), 8);
    assert!(p.iter().all(|x| x.amount.0 == 15 * USD));
    // All eight are within the auto limit (15), but tier 1 may send at most 60 % of 120: the
    // first four (equal amounts: by account) move to tier 2.
    let tiers: Vec<u8> = p.iter().map(|x| x.tier).collect();
    assert_eq!(tiers, vec![2, 2, 2, 2, 1, 1, 1, 1]);
}

#[test]
fn a_rejected_payout_strikes_the_rounds_points_decayed() {
    let mut w = World::new();
    let m = members();
    w.at(1, 100);
    w.allocate(&m[0], &[(&m[1], 40)]);
    w.allocate(&m[2], &[(&m[1], 10)]);
    w.close_through(1);
    let id = w.round_payouts(1)[0].id;
    w.pay_all();
    w.at(2, 100);
    w.allocate(&m[0], &[(&m[1], 20)]);
    w.close_through(3);
    // 50,000 -> 47,500 + 20,000 -> 64,125.
    assert_eq!(w.rep(&m[1]), 64_125);
    w.vote(&council()[0], id, "VoteReject").unwrap();
    w.vote(&council()[1], id, "VoteReject").unwrap();
    assert_eq!(w.check(id), Status::Rejected);
    // Round 1's 50,000 decayed to round 3: 45,125.
    assert_eq!(w.rep(&m[1]), 19_000);
    let s = entries(&w.events(Some("struck")));
    assert_eq!(s.len(), 1);
    assert_eq!(s[0]["payout"], id);
    assert_eq!(s[0]["round"], 1);
    assert_eq!(s[0]["points"], 50_000);
    assert_eq!(s[0]["strike"], "45125");
    assert_eq!(s[0]["reputation"], "19000");
    assert_eq!(w.member(&m[1]).strikes, 1);
    // Checking again changes nothing.
    assert_eq!(w.check(id), Status::Rejected);
    assert_eq!(w.rep(&m[1]), 19_000);
    w.assert_audit();
}

#[test]
fn empty_rounds_close_in_batches_and_stop_at_a_round_with_allocations() {
    let mut w = World::new();
    let m = members();
    w.at(5, 100);
    w.allocate(&m[0], &[(&m[1], 10)]);
    w.at(100, 0);
    assert_eq!(w.state().due, 99);
    // One call: rounds 1-4 at once, round 5 through the DAO.
    let out = w.call(&acc("anyone.testnet"), |c| value(c.close_round()));
    assert!(out.is_none(), "round 5 needs the DAO");
    assert_eq!(w.last_close.as_ref().unwrap().closed, 1);
    assert_eq!(w.state().oldest_unclosed, 6);
    let closed = entries(&w.events(Some("round_closed")));
    assert_eq!(closed.iter().map(|e| e["round"].as_u64().unwrap()).collect::<Vec<_>>(), vec![1, 2, 3, 4, 5]);
    // Then at most max_catchup (36) empty rounds per call.
    let out = w.call(&acc("anyone.testnet"), |c| value(c.close_round())).unwrap();
    assert_eq!((out.closed, out.last_closed), (36, 41));
    let out = w.call(&acc("anyone.testnet"), |c| value(c.close_round())).unwrap();
    assert_eq!((out.closed, out.last_closed), (36, 77));
    let out = w.call(&acc("anyone.testnet"), |c| value(c.close_round())).unwrap();
    assert_eq!((out.closed, out.last_closed), (22, 99));
    let out = w.call(&acc("anyone.testnet"), |c| value(c.close_round())).unwrap();
    assert_eq!(out.closed, 0);
    assert_eq!(w.rep(&m[1]), decay_rounds(10_000, 500, false, 5, 99));
    assert_eq!(w.state().due, 0);
}

#[test]
fn a_newcomer_with_steady_help_reaches_tier_1() {
    let mut w = World::new();
    let m = members();
    let mut first_auto = None;
    for n in 1..=20 {
        w.at(n, 100);
        // Three members thank the newcomer (m7) 6 each; the rest is spread.
        for giver in &m[..3] {
            w.allocate(giver, &[(&m[7], 6), (&m[3], 30), (&m[4], 30)]);
        }
        w.allocate(&m[7], &[(&m[0], 30), (&m[1], 30), (&m[2], 30)]);
        w.close_through(n);
        if let Some(p) = w.round_payouts(n).iter().find(|p| p.receiver == m[7])
            && p.tier == 1
            && first_auto.is_none()
        {
            first_auto = Some(n);
        }
    }
    let n = first_auto.expect("the newcomer reached tier 1");
    assert!((2..=10).contains(&n), "reached tier 1 in round {n}");
}
