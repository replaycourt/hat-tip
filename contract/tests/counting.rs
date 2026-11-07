//! Counting through the contract: eligibility at the close, the dampening rules, attribution,
//! and the `points` event.
mod common;

use common::*;
use hat_tip::config::Config;
use hat_tip::math::{self, Entry, Role, Rules};
use near_sdk::AccountId;
use near_sdk::json_types::U128;

fn points_of(w: &mut World, n: u64) -> Vec<(AccountId, u128)> {
    w.round(n).unwrap().points.into_iter().map(|(a, p)| (a, p.0)).collect()
}

fn with(f: impl FnOnce(&mut Config)) -> World {
    let mut c = cfg();
    f(&mut c);
    World::with(c)
}

#[test]
fn reciprocal_thanks_are_discounted_in_both_directions() {
    let mut w = with(|c| c.reciprocal_bp = 5_000);
    let m = members();
    w.at(1, 100);
    w.allocate(&m[0], &[(&m[1], 40), (&m[2], 10)]);
    w.allocate(&m[1], &[(&m[0], 40)]);
    w.allocate(&m[2], &[(&m[3], 10)]);
    w.close_through(1);
    // The pair's 40 and 40 lose 20 each; the one-way thanks stay whole.
    assert_eq!(
        points_of(&mut w, 1),
        vec![(m[0].clone(), 20_000), (m[1].clone(), 20_000), (m[2].clone(), 10_000), (m[3].clone(), 10_000)]
    );
}

#[test]
fn quadratic_attribution_adds_up_and_favours_breadth() {
    let mut w = with(|c| c.quadratic = true);
    let m = members();
    w.at(1, 100);
    w.allocate(&m[0], &[(&m[1], 40)]);
    for giver in &m[2..6] {
        w.allocate(giver, &[(&m[7], 10)]);
    }
    w.close_through(1);
    let r = w.round(1).unwrap();
    for (a, p) in &r.points {
        let sum: u128 = r.gifts.iter().filter(|g| &g.1 == a).map(|g| g.3.0).sum();
        assert_eq!(sum, p.0, "points of {a} equal their attributions");
    }
    let p = points_of(&mut w, 1);
    let total: u128 = p.iter().map(|x| x.1).sum();
    assert!(total <= 80_000 && total + 5 >= 80_000, "the round's total stays W: {total}");
    let one = p.iter().find(|x| x.0 == m[1]).unwrap().1;
    let many = p.iter().find(|x| x.0 == m[7]).unwrap().1;
    // S1 = sqrt(40e9) = 200,000; S7 = 4 * 100,000 = 400,000: shares 1 : 4 of 80,000.
    assert_eq!((one, many), (16_000, 64_000));
    w.assert_audit();
}

#[test]
fn breadth_and_idle_discount_narrow_support_and_free_riders() {
    let mut w = with(|c| {
        c.breadth_k = 3;
        c.breadth_bp = 5_000;
        c.idle_bp = 2_000;
    });
    let m = members();
    w.at(1, 100);
    // m1 has three givers, m2 one; m7 gives nothing.
    w.allocate(&m[0], &[(&m[1], 10), (&m[2], 10), (&m[7], 10)]);
    w.allocate(&m[3], &[(&m[1], 10), (&m[7], 10)]);
    w.allocate(&m[4], &[(&m[1], 10), (&m[7], 10)]);
    w.allocate(&m[1], &[(&m[0], 1)]);
    w.allocate(&m[2], &[(&m[0], 1)]);
    w.close_through(1);
    let p = points_of(&mut w, 1);
    let get = |a: &AccountId| p.iter().find(|x| &x.0 == a).unwrap().1;
    assert_eq!(get(&m[1]), 30_000);
    assert_eq!(get(&m[2]), 5_000, "one giver: half");
    assert_eq!(get(&m[7]), 3 * 10_000 * 2_000 / 10_000, "three givers, but idle");
    assert_eq!(get(&m[0]), 1_000, "two givers: half");
}

#[test]
fn eligibility_is_checked_again_at_the_close() {
    let mut w = World::new();
    let m = members();
    w.at(1, 100);
    w.allocate(&m[0], &[(&m[1], 10), (&m[2], 20)]);
    w.allocate(&m[3], &[(&m[0], 30)]);
    // The DAO removes m2 and m3 before the close.
    w.dao.members.retain(|a| a != m[2].as_str() && a != m[3].as_str());
    w.close_through(1);
    assert_eq!(points_of(&mut w, 1), vec![(m[1].clone(), 10_000)]);
    let r = w.round(1).unwrap();
    assert!(r.gifts.iter().any(|g| g.1 == m[2] && g.3 == U128(0)), "the gift stays in the log, counted 0");
    assert_eq!(w.state().members.len(), 6, "the close took over the new member list");
}

#[test]
fn the_points_event_attributes_every_point() {
    let mut w = World::new();
    let m = members();
    w.at(1, 100);
    w.allocate(&m[0], &[(&m[1], 10), (&m[2], 20)]);
    w.allocate(&m[3], &[(&m[1], 30)]);
    w.close_through(1);
    let e = entries(&w.events(Some("points")));
    assert_eq!(e.len(), 1);
    let ev = &e[0];
    assert_eq!(ev["round"], 1);
    assert_eq!(ev["detail"], true);
    let accounts: Vec<String> =
        ev["accounts"].as_array().unwrap().iter().map(|a| a.as_str().unwrap().to_string()).collect();
    let name = |i: &near_sdk::serde_json::Value| accounts[i.as_u64().unwrap() as usize].clone();
    let mut seen = Vec::new();
    for row in ev["points"].as_array().unwrap() {
        let receiver = name(&row[0]);
        let points = row[1].as_u64().unwrap();
        let givers = row[2].as_array().unwrap();
        let sum: u64 = givers.iter().map(|g| g[2].as_u64().unwrap()).sum();
        assert_eq!(sum, points);
        seen.push((receiver, points, givers.iter().map(|g| (name(&g[0]), g[1].as_u64().unwrap())).collect::<Vec<_>>()));
    }
    assert_eq!(
        seen,
        vec![
            (m[1].to_string(), 40_000, vec![(m[0].to_string(), 10), (m[3].to_string(), 30)]),
            (m[2].to_string(), 20_000, vec![(m[0].to_string(), 20)]),
        ]
    );
    let closed = entries(&w.events(Some("round_closed")));
    let c = closed.iter().find(|x| x["round"] == 1).unwrap();
    assert_eq!(c["empty"], false);
    assert_eq!(c["points"], 60_000);
    assert_eq!(c["budget"], (120 * USD).to_string());
    assert_eq!(c["detail"], 2);
}

/// The contract's close equals the pure pipeline on random rounds with every rule on.
#[test]
fn the_contract_counts_like_the_pipeline() {
    let mut rng = Rng(0x5eed_1234_abcd);
    for case in 0..12 {
        let mut c = cfg();
        c.reciprocal_bp = [10_000, 5_000, 2_500][case % 3] as u16;
        c.quadratic = case % 2 == 0;
        c.breadth_k = (case % 4) as u8;
        c.breadth_bp = 6_000;
        c.idle_bp = if case % 5 == 0 { 10_000 } else { 3_000 };
        c.guest_receive_cap_bp = [10_000, 1_000, 300][(case / 3) % 3];
        let rules = Rules::from_config(&c);
        let mut w = World::with(c);
        let m = members();
        let mut guests: Vec<Key> = (0..3).map(|i| Key::new(100 + i)).collect();
        w.at(1, 100);
        for g in guests.iter_mut() {
            let to = &m[rng.below(8) as usize];
            assert!(w.guest_allocate(g, &[(to, 1 + rng.below(40) as u16)]).ok);
        }
        for (i, giver) in m.iter().enumerate() {
            if rng.below(4) == 0 {
                continue;
            }
            let mut gifts: Vec<(&AccountId, u16)> = Vec::new();
            let mut left = 100u16;
            for j in 0..8 {
                if j == i || rng.below(3) == 0 || left == 0 {
                    continue;
                }
                let n = (1 + rng.below(40) as u16).min(left);
                left -= n;
                gifts.push((&m[j], n));
            }
            if rng.below(3) == 0 {
                gifts.push((&guests[0].account, 1 + rng.below(left.max(1) as u64).min(39) as u16));
            }
            let out = w.allocate(giver, &gifts);
            assert!(out.ok || out.error.as_deref().unwrap_or("").contains("at most 100"), "{out:?}");
        }
        let before = w.round(1).unwrap();
        w.close_through(1);
        let after = w.round(1).unwrap();
        // Rebuild the pipeline's input from the round view.
        let mut table: Vec<AccountId> = Vec::new();
        fn idx(a: &AccountId, t: &mut Vec<AccountId>) -> usize {
            match t.iter().position(|x| x == a) {
                Some(i) => i,
                None => {
                    t.push(a.clone());
                    t.len() - 1
                }
            }
        }
        let entries: Vec<Entry> = before
            .gifts
            .iter()
            .map(|g| Entry { giver: idx(&g.0, &mut table), receiver: idx(&g.1, &mut table), given: g.2 })
            .collect();
        let roles: Vec<Role> = table
            .iter()
            .map(|a| Role {
                member: m.contains(a),
                guest: before.seats.contains(a),
                gave: before.gifts.iter().any(|g| &g.0 == a),
            })
            .collect();
        let expected = math::count(&roles, &entries, &rules);
        let got: Vec<u128> = after.gifts.iter().map(|g| g.3.0).collect();
        assert_eq!(got, expected, "case {case}");
        w.assert_audit();
    }
}
