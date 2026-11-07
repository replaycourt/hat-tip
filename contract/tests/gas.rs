//! The worst cases for one receipt. The mock VM meters host calls (storage, logs, promises) and
//! enforces the prepaid gas of every receipt the contract creates and the 16 KiB log limit; it
//! does not meter wasm instructions (see README.md, "Gas", for that estimate).
mod common;

use common::*;
use hat_tip::config::Config;
use hat_tip::types::Status;
use near_sdk::AccountId;

fn report(w: &World, what: &str) -> (u64, usize) {
    let (gas, bytes) = w.metered.get(what).copied().unwrap_or_default();
    eprintln!("{what}: host gas {:.2} Tgas, logs {bytes} bytes", gas as f64 / 1e12);
    (gas, bytes)
}

/// A community of `n` members with `name`-shaped accounts, `guests` seated guests, every
/// participant giving to `max_receivers` others, every dampening rule on.
fn crowded_round(n: usize, guests: u32, name: impl Fn(usize) -> String, tweak: impl FnOnce(&mut Config)) -> World {
    let mut c = cfg();
    c.max_members = n as u16;
    c.guest_seats = guests as u8;
    c.quadratic = true;
    c.reciprocal_bp = 5_000;
    c.breadth_k = 3;
    c.breadth_bp = 5_000;
    c.idle_bp = 5_000;
    c.guest_cap_bp = 2_000;
    c.guest_receive_cap_bp = 2_000;
    tweak(&mut c);
    let mut w = World::bare(c);
    let all: Vec<AccountId> = (0..n).map(|i| name(i).parse().unwrap()).collect();
    w.dao.members = all.iter().map(|a| a.to_string()).collect();
    w.sync();
    assert_eq!(w.state().members.len(), n);
    w.at(1, 100);
    let mut keys: Vec<Key> = (0..guests).map(|i| Key::new(500 + i)).collect();
    for k in keys.iter_mut() {
        assert!(w.join(k, Some(&"n".repeat(80))).ok);
    }
    let seated: Vec<AccountId> = keys.iter().map(|k| k.account.clone()).collect();
    for (i, giver) in all.iter().enumerate() {
        // Ten receivers: nine members and a guest when there are guests.
        let mut gifts: Vec<(&AccountId, u16)> = (1..=9).map(|d| (&all[(i + d) % n], 10)).collect();
        if !seated.is_empty() {
            gifts.push((&seated[i % seated.len()], 10));
        } else {
            gifts.push((&all[(i + 10) % n], 10));
        }
        let out = w.allocate_note(giver, &gifts, &"x".repeat(80));
        assert!(out.ok, "{out:?}");
    }
    for (j, k) in keys.iter_mut().enumerate() {
        let gifts: Vec<(&AccountId, u16)> = (0..10).map(|d| (&all[(j * 3 + d) % n], 10)).collect();
        assert!(w.guest_allocate(k, &gifts).ok);
    }
    w
}

#[test]
fn the_largest_demo_round_closes_well_within_its_gas_and_log_budget() {
    // 24 members + 6 guests, ten gifts each, every rule on (the demo's caps).
    let mut w = crowded_round(24, 6, |i| format!("member-{i:02}.hattip-cafe.testnet"), |_| {});
    w.close_through(1);
    let (gas, bytes) = report(&w, "on_close");
    assert!(gas < 60_000_000_000_000, "on_close host gas {gas}");
    assert!(bytes <= 16_384);
    let closed = entries(&w.events(Some("round_closed")));
    assert_eq!(closed[0]["detail"], 2, "the demo's largest round logs every point in full");
    let r = w.round(1).unwrap();
    assert_eq!(r.gifts.len(), 300);
    assert_eq!(r.points.len(), 30);
    w.assert_audit();
}

#[test]
fn the_worst_round_still_fits_one_receipt() {
    // 58 members with 64-character names and 6 guests: the logs drop the per-giver detail.
    let name = |i: usize| format!("{i:02}{}.testnet", "m".repeat(54));
    let mut w = crowded_round(58, 6, name, |c| c.max_receivers = 10);
    assert_eq!(name(0).len(), 64);
    w.close_through(1);
    let (gas, bytes) = report(&w, "on_close");
    assert!(bytes <= 16_384);
    assert!(gas < 120_000_000_000_000, "on_close host gas {gas}");
    let closed = entries(&w.events(Some("round_closed")));
    assert!(closed[0]["detail"].as_u64().unwrap() < 2);
    let r = w.round(1).unwrap();
    assert_eq!(r.gifts.len(), 640);
    w.assert_audit();
}

#[test]
fn every_payout_chain_fits_its_attached_gas() {
    // The mock VM fails a receipt that attaches more gas than it has: these chains running
    // to the end is the check. Filing with registration, tier 1 with the vote, the checks.
    let mut c = cfg();
    c.auto_share_bp = 10_000;
    let mut w = World::with(c);
    let m = members();
    w.at(1, 100);
    for (i, giver) in m.iter().enumerate() {
        let gifts: Vec<(&AccountId, u16)> =
            m.iter().enumerate().filter(|(j, _)| *j != i).map(|(_, a)| (a, 14)).collect();
        assert!(w.allocate(giver, &gifts).ok);
    }
    w.close_through(1);
    w.at(2, 100);
    for (i, giver) in m.iter().enumerate() {
        assert!(w.allocate(giver, &[(&m[(i + 1) % 8], 5)]).ok);
    }
    w.close_through(2);
    assert!(w.round_payouts(2).iter().all(|p| p.tier == 1));
    let out = w.pay(10);
    eprintln!("pay with 300 Tgas files {} first payouts (with registration)", out.filing.len());
    assert!(out.filing.len() >= 2);
    w.pay_all();
    assert!(w.payouts().iter().filter(|p| p.tier == 1).all(|p| p.status == hat_tip::types::Status::Approved));
    for p in w.payouts() {
        w.check(p.id);
    }
    for k in ["on_registered", "on_filed", "on_voted", "on_checked", "on_policy", "on_close"] {
        report(&w, k);
    }
}

#[test]
fn close_round_refuses_to_start_a_close_it_cannot_finish() {
    let mut w = World::new();
    let m = members();
    w.at(1, 100);
    w.allocate(&m[0], &[(&m[1], 10)]);
    w.at(2, 0);
    w.gas_tgas = 200;
    let out = w.call(&acc("anyone.testnet"), |c| value(c.close_round())).unwrap();
    assert!(out.error.unwrap().contains("needs"));
    assert_eq!(w.state().closing, None);
    w.gas_tgas = 300;
    w.close();
    assert_eq!(w.state().oldest_unclosed, 2);
}

// ---- cold callbacks: every receipt loads the contract afresh (World::cold), as on chain ------

const T: f64 = 1e12;

/// The launch config of `sim/params.json` (testnet column), else the demo config.
fn launch_cfg() -> Config {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../sim/params.json");
    let Ok(bytes) = std::fs::read(&path) else { return cfg() };
    let p: near_sdk::serde_json::Value = near_sdk::serde_json::from_slice(&bytes).unwrap();
    let mut v = p["testnet"]["config"].clone();
    v["dao"] = DAO.into();
    v["token"] = TOKEN.into();
    v["genesis_ms"] = GENESIS_MS.into();
    v["round_ms"] = ROUND_MS.into();
    near_sdk::serde_json::from_value(v).unwrap()
}

/// The most host gas a callback used, over the executions `keep` selects.
fn most(w: &World, method: &str, keep: impl Fn(u64) -> bool) -> u64 {
    w.gas_log.iter().filter(|(m, p, _)| m == method && keep(*p)).map(|x| x.2).max().unwrap_or(0)
}

/// The largest state the launch config lets a callback load: `max_members` members with
/// 64-character names, and for `carry_rounds` rounds six fresh guests a round who each keep a
/// carry (members thank them below `min_payout`), so the carry list holds about every member
/// and 72 guests. Payouts are filed, voted on by the council and checked along the way:
/// approvals, a rejection, an unregistered receiver retried, an expiry.
#[test]
fn every_callback_fits_its_gas_cold_in_the_largest_launch_state() {
    let c = launch_cfg();
    let n = c.max_members as usize;
    let mut w = World::bare(c.clone());
    let all: Vec<AccountId> = (0..n).map(|i| format!("{i:02}{}.testnet", "m".repeat(54)).parse().unwrap()).collect();
    w.dao.members = all.iter().map(|a| a.to_string()).collect();
    w.dao.period_ns = 30 * ROUND_MS * 1_000_000;
    w.sync();
    let council = council();
    let rounds = c.carry_rounds as u64 + 2;
    let mut seed = 9_000;
    for r in 1..=rounds {
        w.at(r, 100);
        let mut keys: Vec<Key> = (0..c.guest_seats as u32)
            .map(|_| {
                seed += 1;
                Key::new(seed)
            })
            .collect();
        for k in keys.iter_mut() {
            assert!(w.join(k, Some(&"g".repeat(c.note_max_bytes as usize))).ok);
        }
        let guests: Vec<AccountId> = keys.iter().map(|k| k.account.clone()).collect();
        for (i, giver) in all.iter().enumerate() {
            let mut gifts: Vec<(&AccountId, u16)> = (1..=9).map(|d| (&all[(i + d) % n], 10)).collect();
            gifts.push((&guests[i % guests.len()], 10));
            assert!(w.allocate_note(giver, &gifts, &"x".repeat(c.note_max_bytes as usize)).ok);
        }
        for (j, k) in keys.iter_mut().enumerate() {
            let gifts: Vec<(&AccountId, u16)> = (0..10).map(|d| (&all[(j * 3 + d) % n], 10)).collect();
            assert!(w.guest_allocate(k, &gifts).ok);
        }
        w.close_through(r);
        w.pay_all();
        // The council: approves tier 2 and 3, rejects one; one receiver leaves the token first.
        let open: Vec<_> = w.payouts().into_iter().filter(|p| p.status == Status::Filed).collect();
        for (k, p) in open.iter().enumerate() {
            if r % 3 == 0 && k == 0 {
                w.dao.registered.remove(p.receiver.as_str());
            }
            let action = if k == 1 && r % 2 == 0 { "VoteReject" } else { "VoteApprove" };
            let _ = w.vote(&council[0], p.id, action);
            let _ = w.vote(&council[1], p.id, action);
        }
        for p in w.payouts() {
            if !p.status.is_final() && p.status != Status::Planned {
                w.check(p.id);
                w.check(p.id);
            }
        }
        w.assert_audit();
    }
    w.sync();
    let st = w.state();
    let carries = st.totals.carry.0;
    eprintln!(
        "state after {rounds} rounds: {} members, carries {carries}, {} payouts, {} retried",
        st.members.len(),
        st.next_payout,
        w.gas_log.iter().filter(|x| x.0 == "on_finalized").count()
    );
    let tiers: std::collections::BTreeMap<u64, u8> =
        (0..st.next_payout).filter_map(|id| w.view(|c| c.payouts(id, 1)).pop().map(|p| (id, p.tier))).collect();
    let tier = |p: u64| tiers.get(&p).copied().unwrap_or(0);
    let gas = |g: near_sdk::Gas| g.as_gas();
    use hat_tip::config::*;
    use hat_tip::pay::*;
    let rows: Vec<(&str, u64, u64)> = vec![
        ("on_filed, tier 1", most(&w, "on_filed", |p| tier(p) == 1), gas(gas_on_filed(1))),
        ("on_filed, tiers 2 and 3", most(&w, "on_filed", |p| tier(p) >= 2), gas(gas_on_filed(2))),
        ("on_registered, tier 2/3", most(&w, "on_registered", |p| tier(p) != 1), gas(gas_on_registered(2))),
        ("on_voted", most(&w, "on_voted", |_| true), gas(GAS_ON_VOTED)),
        ("on_checked", most(&w, "on_checked", |_| true), gas(gas_on_checked())),
        ("on_finalized", most(&w, "on_finalized", |_| true), gas(GAS_ON_FINALIZED)),
        ("on_policy", most(&w, "on_policy", |_| true), gas(GAS_ON_POLICY)),
        ("on_close", most(&w, "on_close", |_| true), gas(GAS_ON_CLOSE)),
    ];
    for (what, used, static_gas) in &rows {
        eprintln!("{what}: cold host gas {:.2} Tgas of {:.0}", *used as f64 / T, *static_gas as f64 / T);
        assert!(*used > 0, "{what} never ran");
        // On chain a receipt also pays its wasm instructions, trie nodes and the wasm load
        // (0.38 Tgas for 350 KB), which the mock does not meter. A callback that creates no
        // promise keeps three quarters of its gas for them; one that does keeps at least 4 Tgas
        // here, and about 17 Tgas more per link on chain (the mock charges 19.1 Tgas of receipt
        // fees per link, the chain about 2.5).
        let links = matches!(*what, "on_filed, tier 1" | "on_registered, tier 2/3" | "on_checked");
        if links {
            assert!(used + 4_000_000_000_000 <= *static_gas, "{what}: too little left for its own work");
        } else {
            assert!(used * 4 <= *static_gas, "{what}: too little left for wasm and trie costs");
        }
    }
}

/// Port of the pre-lock review's test A: a payout at the pay cursor whose chain is two steps
/// longer (its receiver is registered first) gets its `on_filed` after overlapping `pay` calls
/// have filed every payout behind it. That `on_filed` used to walk the cursor over all of them,
/// one cold storage read each, with 5 Tgas: 4.4 Tgas of host gas alone for 57.
#[test]
fn on_filed_does_not_grow_with_the_payouts_filed_after_it() {
    let mut c = cfg();
    c.max_members = 58;
    c.round_budget = near_sdk::json_types::U128(100_000 * USD);
    c.min_payout = near_sdk::json_types::U128(USD);
    let mut w = World::bare(c);
    let m: Vec<AccountId> = (0..57).map(|i| acc(&format!("m{i:02}.cafe.testnet"))).collect();
    w.dao.members = m.iter().map(|a| a.to_string()).collect();
    w.sync();
    let give = |w: &mut World, extra: Option<&AccountId>| {
        for (i, giver) in m.iter().enumerate() {
            let mut gifts: Vec<(&AccountId, u16)> = (1..=9).map(|d| (&m[(i + d) % 57], 10)).collect();
            gifts.push((extra.unwrap_or(&m[(i + 10) % 57]), 10));
            assert!(w.allocate(giver, &gifts).ok);
        }
    };
    w.at(1, 100);
    give(&mut w, None);
    w.close_through(1);
    w.pay_all();
    // A new member that sorts first and is not registered with the token yet.
    let newbie = acc("aaa.cafe.testnet");
    w.dao.members.push(newbie.to_string());
    w.sync();
    w.at(2, 100);
    give(&mut w, Some(&newbie));
    w.close_through(2);
    let first = w.round_payouts(2)[0].clone();
    assert_eq!(first.receiver, newbie);
    assert!(first.tier >= 2);
    w.auto_run = false;
    let mut filed = 0;
    for _ in 0..40 {
        let out = w.pay(255);
        if out.filing.is_empty() {
            break;
        }
        filed += out.filing.len();
    }
    w.auto_run = true;
    w.gas_log.clear();
    w.run();
    let order: Vec<u64> = w.gas_log.iter().filter(|x| x.0 == "on_filed").map(|x| x.1).collect();
    assert_eq!(order.last(), Some(&first.id), "the first payout's on_filed comes last");
    let last = most(&w, "on_filed", |p| p == first.id);
    let others = most(&w, "on_filed", |p| p != first.id);
    eprintln!(
        "{filed} payouts filed by overlapping pay calls; on_filed of the first {:.3} Tgas, the others at most {:.3}",
        last as f64 / T,
        others as f64 / T
    );
    assert_eq!(w.payout(first.id).status, Status::Filed);
    assert!(last <= others + 50_000_000_000, "on_filed grows with the payouts filed after it");
    assert!(last < 1_000_000_000_000);
    assert_eq!(w.state().planned, 0);
}
