//! Hundreds of random rounds with every rule on, guests, a DAO that changes its members, runs low,
//! fails now and then, and a council that approves, rejects, removes or forgets. After every
//! round `audit()` holds; at the end the events alone rebuild every reputation and every payout.
mod common;

use common::*;
use hat_tip::math::decay_step;
use hat_tip::types::Status;
use near_sdk::AccountId;
use std::collections::BTreeMap;

fn run(seed: u64, rounds: u64) {
    let mut c = cfg();
    c.reciprocal_bp = 5_000;
    c.quadratic = true;
    c.breadth_k = 2;
    c.breadth_bp = 6_000;
    c.idle_bp = 5_000;
    c.guest_receive_cap_bp = 2_500;
    c.carry_rounds = 5;
    c.min_payout = near_sdk::json_types::U128(3 * USD);
    c.log_keep = 20;
    let mut w = World::with(c);
    w.dao.period_ns = 3 * ROUND_MS * 1_000_000;
    w.sync();
    let mut rng = Rng(seed);
    let pool: Vec<AccountId> =
        NAMES.iter().map(|n| member(n)).chain(["ivy", "jon", "kim"].iter().map(|n| member(n))).collect();
    let mut keys: Vec<Key> = (0..10).map(|i| Key::new(1_000 + i)).collect();
    let council = council();
    let mut n = 1;
    while n <= rounds {
        w.at(n, 50 + rng.below(400));
        // Membership changes now and then.
        if rng.below(15) == 0 {
            let a = &pool[rng.below(pool.len() as u64) as usize];
            if w.dao.members.contains(&a.to_string()) {
                w.dao.members.retain(|x| x != a.as_str());
            } else {
                w.dao.members.push(a.to_string());
            }
            w.sync();
        }
        let current: Vec<AccountId> = w.state().members;
        // Some rounds nobody gives.
        if rng.below(6) != 0 {
            for k in keys.iter_mut() {
                if rng.below(3) == 0 && !current.is_empty() {
                    let to = &current[rng.below(current.len() as u64) as usize];
                    w.guest_allocate(k, &[(to, 1 + rng.below(40) as u16)]);
                }
            }
            let seated = w.state().guests_seated;
            for giver in &current {
                if rng.below(4) == 0 {
                    continue;
                }
                let mut gifts: Vec<(&AccountId, u16)> = Vec::new();
                let mut left = 100u16;
                let targets: Vec<&AccountId> = current.iter().chain(seated.iter()).filter(|a| *a != giver).collect();
                for t in targets {
                    if rng.below(3) == 0 && left > 0 && gifts.len() < 10 {
                        let k = (1 + rng.below(40) as u16).min(left);
                        left -= k;
                        gifts.push((t, k));
                    }
                }
                let out = w.allocate(giver, &gifts);
                assert!(out.ok, "{out:?}");
            }
        }
        // The DAO's purse moves.
        match rng.below(10) {
            0 => {
                w.dao.balances.insert(DAO.into(), rng.below(200) as u128 * USD);
            }
            1 => {
                w.dao.balances.insert(DAO.into(), 1_000_000 * USD);
            }
            _ => {}
        }
        // Skip ahead sometimes: several empty rounds close in one call.
        let next = if rng.below(10) == 0 { n + 1 + rng.below(50) } else { n + 1 };
        w.at(next, 0);
        if rng.below(20) == 0 {
            w.dao.fail.insert(
                ["get_policy", "add_proposal", "act_proposal", "storage_deposit"][rng.below(4) as usize].into(),
            );
        }
        w.close();
        w.pay(rng.below(6) as u8);
        // The council acts on some open payouts.
        let open: Vec<_> =
            w.payouts().into_iter().filter(|p| matches!(p.status, Status::Filed | Status::Approved)).collect();
        for p in &open {
            if p.tier >= 2 && rng.below(3) == 0 {
                let action = ["VoteApprove", "VoteApprove", "VoteReject", "VoteRemove"][rng.below(4) as usize];
                let _ = w.vote(&council[rng.below(3) as usize], p.id, action);
            }
            if rng.below(2) == 0 {
                w.check(p.id);
            }
        }
        if rng.below(5) == 0 {
            w.dao.fail.clear();
            w.sync();
        }
        w.assert_audit();
        n = next;
    }
    w.dao.fail.clear();
    w.sync();
    w.pay_all();
    for p in w.payouts() {
        w.check(p.id);
    }
    w.assert_audit();
    let a = w.audit();
    let st = w.state();
    eprintln!(
        "seed {seed:#x}: {} rounds closed, {} payouts {:?}, {} strikes, lapsed {}, dust {}",
        st.totals.rounds_closed,
        a.payouts,
        a.by_status.iter().filter(|x| x.1 > 0).map(|x| (x.0.name(), x.1)).collect::<Vec<_>>(),
        st.totals.strikes,
        a.lapsed.0,
        a.dust.0
    );
    assert!(a.payouts > 0 && st.totals.strikes > 0, "the run should exercise payouts and strikes");
    replay(&mut w);
}

/// Rebuilds reputations and payout statuses from the events alone.
fn replay(w: &mut World) {
    let d = cfg().decay_bp as u128;
    let mut rep: BTreeMap<String, u128> = BTreeMap::new();
    let mut status: BTreeMap<u64, String> = BTreeMap::new();
    for e in w.events(None) {
        let kind = e["event"].as_str().unwrap().to_string();
        for x in e["data"].as_array().unwrap() {
            match kind.as_str() {
                "round_closed" => {
                    for (a, r) in rep.iter_mut() {
                        *r = decay_step(*r, d, a.len() == 64);
                    }
                    assert_ne!(x["detail"], 0, "the replay needs the points");
                }
                "points" => {
                    let accounts = x["accounts"].as_array().unwrap();
                    for row in x["points"].as_array().unwrap() {
                        let a = accounts[row[0].as_u64().unwrap() as usize].as_str().unwrap().to_string();
                        let r = rep.entry(a.clone()).or_default();
                        *r += row[1].as_u64().unwrap() as u128;
                        if a.len() == 64 && *r < 1_000 {
                            *r = 0;
                        }
                    }
                }
                "struck" => {
                    let a = x["account"].as_str().unwrap().to_string();
                    let strike: u128 = x["strike"].as_str().unwrap().parse().unwrap();
                    let r = rep.entry(a).or_default();
                    *r = r.saturating_sub(strike);
                    assert_eq!(r.to_string(), x["reputation"].as_str().unwrap());
                }
                "payout_planned" => {
                    status.insert(x["payout"].as_u64().unwrap(), "planned".into());
                }
                "filed" | "approved" | "paid" | "rejected" | "expired" | "removed" | "failed" => {
                    status.insert(x["payout"].as_u64().unwrap(), kind.clone());
                }
                _ => {}
            }
        }
    }
    for (a, r) in &rep {
        let a: AccountId = a.parse().unwrap();
        assert_eq!(w.rep(&a), *r, "replayed reputation of {a}");
    }
    let views = w.payouts();
    for p in &views {
        assert_eq!(status.get(&p.id).map(String::as_str), Some(p.status.name()), "replayed status of payout {}", p.id);
    }
    assert!(views.len() as u64 + w.state().oldest_payout == w.state().next_payout);
    assert_eq!(status.len() as u64, w.state().next_payout);
}

#[test]
fn many_random_rounds_keep_the_books() {
    run(0x1234_5678_9abc_def1, 300);
}

#[test]
fn other_seeds() {
    for seed in [7u64, 0xfeed_beef, 0x0dd_ba11] {
        run(seed, 80);
    }
}
