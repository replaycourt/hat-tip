//! The worst cases for one receipt. The mock VM meters host calls (storage, logs, promises) and
//! enforces the prepaid gas of every receipt the contract creates and the 16 KiB log limit; it
//! does not meter wasm instructions (see README.md, "Gas", for that estimate).
mod common;

use common::*;
use hat_tip::config::Config;
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
