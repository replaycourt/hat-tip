//! Guests: signed actions relayed by anyone, seats, the guest weight and cap, and cleanup.
mod common;

use common::*;
use near_sdk::serde_json::json;

#[test]
fn the_signing_text_is_the_one_the_view_shows() {
    let mut w = World::new();
    let text = w.view(|c| c.signing_text(7, "{\"join\":{\"round\":1}}".into()));
    assert_eq!(text, format!("hattip:v1:{CONTRACT}:7:{{\"join\":{{\"round\":1}}}}"));
}

#[test]
fn a_guest_joins_notes_and_gives_to_members() {
    let mut w = World::new();
    let m = members();
    let mut g = Key::new(1);
    w.at(1, 100);
    let out = w.join(&mut g, Some("first visit, brought a toaster"));
    assert!(out.ok, "{out:?}");
    assert_eq!((out.nonce, out.round), (1, 1));
    assert_eq!(w.state().guests_seated, vec![g.account.clone()]);
    let out = w.guest_allocate(&mut g, &[(&m[0], 40), (&m[1], 40)]);
    assert!(out.ok, "{out:?}");
    let e = entries(&w.events(Some("joined")));
    assert_eq!(e, vec![json!({"round": 1, "account": g.account.as_str(), "seat": 1})]);
    let a = entries(&w.last_events(Some("allocated")));
    assert_eq!(a[0]["guest"], true);
    // Members may thank a seated guest.
    assert!(w.allocate(&m[0], &[(&g.account, 10)]).ok);
}

#[test]
fn bad_signatures_used_nonces_and_bad_json_fail_the_call() {
    let mut w = World::new();
    let mut g = Key::new(2);
    let other = Key::new(3);
    w.at(1, 100);
    let action = json!({"join": {"round": 1}}).to_string();
    let attempts: Vec<(String, u64, String, String, &str)> = vec![
        // signed by another key
        (g.hex.clone(), 1, action.clone(), other.sign(CONTRACT, 1, &action), "bad signature"),
        // signed for another contract
        (g.hex.clone(), 1, action.clone(), g.sign("other.testnet", 1, &action), "bad signature"),
        // signed for another nonce
        (g.hex.clone(), 2, action.clone(), g.sign(CONTRACT, 1, &action), "bad signature"),
        (g.hex.to_uppercase(), 1, action.clone(), g.sign(CONTRACT, 1, &action), "bad public key"),
        (g.hex.clone(), 1, action.clone(), "00".repeat(63), "bad signature encoding"),
        (g.hex.clone(), 0, action.clone(), g.sign(CONTRACT, 0, &action), "nonce out of range"),
        (g.hex.clone(), 1, "{\"join\":{}}".into(), g.sign(CONTRACT, 1, "{\"join\":{}}"), "malformed action"),
        (
            g.hex.clone(),
            1,
            "{\"fly\":{\"round\":1}}".into(),
            g.sign(CONTRACT, 1, "{\"fly\":{\"round\":1}}"),
            "malformed action",
        ),
    ];
    for (pk, nonce, act, sig, why) in attempts {
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            w.call(&acc("relayer.testnet"), |c| c.act(pk.clone(), nonce, act.clone(), sig.clone()))
        }));
        let err = r.expect_err(why);
        let msg = err.downcast_ref::<String>().cloned().unwrap_or_default();
        assert!(msg.contains(why), "expected '{why}', got '{msg}'");
    }
    assert!(w.join(&mut g, None).ok);
    // The same nonce again fails.
    let sig = g.sign(CONTRACT, 1, &action);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        w.call(&acc("relayer.testnet"), |c| c.act(g.hex.clone(), 1, action.clone(), sig.clone()))
    }));
    assert!(r.unwrap_err().downcast_ref::<String>().unwrap().contains("nonce already used"));
}

#[test]
fn a_refused_action_leaves_no_trace_but_spends_a_known_guests_nonce() {
    let mut w = World::new();
    let m = members();
    let mut g = Key::new(4);
    w.at(1, 100);
    let out = w.guest_allocate(&mut g, &[(&m[0], 101)]);
    assert!(!out.ok);
    assert!(w.state().guests_seated.is_empty(), "a refused action takes no seat");
    assert_eq!(w.member(&g.account).kind, "guest");
    assert!(w.join(&mut g, None).ok);
    let out = w.guest_allocate(&mut g, &[(&m[0], 50), (&m[1], 51)]);
    assert!(!out.ok);
    // The refused action spent nonce 3; nonce 3 cannot be replayed.
    let action = json!({"note": {"round": 1, "text": "hi"}}).to_string();
    let sig = g.sign(CONTRACT, 3, &action);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        w.call(&acc("relayer.testnet"), |c| c.act(g.hex.clone(), 3, action.clone(), sig.clone()))
    }));
    assert!(r.is_err());
}

#[test]
fn guests_give_to_members_only_and_take_one_of_the_seats() {
    let mut w = World::new();
    let m = members();
    w.at(1, 100);
    let mut keys: Vec<Key> = (10..17).map(Key::new).collect();
    for k in keys.iter_mut().take(6) {
        assert!(w.join(k, None).ok);
    }
    let out = w.join(&mut keys[6], None);
    assert!(!out.ok && out.error.unwrap().contains("all 6 guest seats"));
    let other = keys[1].account.clone();
    let out = w.guest_allocate(&mut keys[0], &[(&other, 10)]);
    assert!(!out.ok && out.error.unwrap().contains("members only"));
    assert!(w.guest_allocate(&mut keys[0], &[(&m[0], 10)]).ok);

    // A seat lasts one round; acting in the next round takes a seat again while seats are free.
    w.at(2, 100);
    assert!(w.state().guests_seated.is_empty());
    let out = w.guest_allocate(&mut keys[6], &[(&m[0], 10)]);
    assert!(out.ok, "{out:?}");
    assert_eq!(w.state().guests_seated, vec![keys[6].account.clone()]);
}

#[test]
fn a_community_without_seats_refuses_guests() {
    let mut c = cfg();
    c.guest_seats = 0;
    let mut w = World::with(c);
    let mut g = Key::new(5);
    w.at(1, 100);
    let out = w.join(&mut g, None);
    assert!(!out.ok && out.error.unwrap().contains("no guest seats"));
}

#[test]
fn guest_thanks_count_at_the_guest_weight_under_the_cap() {
    let mut w = World::new();
    let m = members();
    let mut g = Key::new(6);
    w.at(1, 100);
    // Members give 100 thanks (100,000); the guest's 40 count 20,000 at half weight.
    assert!(w.allocate(&m[0], &[(&m[1], 40), (&m[2], 40), (&m[3], 20)]).ok);
    assert!(w.join(&mut g, None).ok);
    assert!(w.guest_allocate(&mut g, &[(&m[4], 40)]).ok);
    w.close_through(1);
    let r = w.round(1).unwrap();
    let guest_gift = r.gifts.iter().find(|x| x.0 == g.account).unwrap();
    // G = 20,000, M = 100,000: 20,000 * 8,000 = 1.6e8 <= 100,000 * 2,000 = 2e8, so no cap.
    assert_eq!(guest_gift.3.0, 20_000);

    // A guest that out-gives the members is scaled to the cap.
    w.at(2, 100);
    assert!(w.allocate(&m[0], &[(&m[1], 10)]).ok);
    let mut keys: Vec<Key> = (20..23).map(Key::new).collect();
    for k in keys.iter_mut() {
        assert!(w.guest_allocate(k, &[(&m[2], 40), (&m[3], 40)]).ok);
    }
    w.close_through(2);
    let r = w.round(2).unwrap();
    let g_sum: u128 = r.gifts.iter().filter(|x| x.0.as_str().len() == 64).map(|x| x.3.0).sum();
    let m_sum: u128 = r.gifts.iter().filter(|x| x.0.as_str().len() != 64).map(|x| x.3.0).sum();
    assert_eq!(m_sum, 10_000);
    // G = 120,000 scaled by 10,000 * 2,000 / (120,000 * 8,000): each 20,000 -> 416.
    assert!(r.gifts.iter().filter(|x| x.0.as_str().len() == 64).all(|x| x.3.0 == 20_000 * 20_000_000 / 960_000_000));
    assert!(g_sum * 8_000 <= m_sum * 2_000);
}

#[test]
fn a_guest_is_never_in_tier_1_and_its_record_goes_when_empty() {
    let mut c = cfg();
    c.decay_bp = 5_000;
    c.auto_rep_min = 0;
    let mut w = World::with(c);
    let m = members();
    let mut g = Key::new(8);
    w.at(1, 100);
    assert!(w.join(&mut g, Some("hello")).ok);
    for giver in &m[..4] {
        assert!(w.allocate(giver, &[(&g.account, 5)]).ok);
    }
    w.close_through(1);
    let p = w.round_payouts(1);
    assert_eq!(p.len(), 1);
    assert_eq!(p[0].receiver, g.account);
    // 20 thanks of 20: the whole budget, 120 tUSD, above the co-sign limit: tier 3.
    assert_eq!((p[0].amount.0, p[0].tier), (120 * USD, 3));
    assert_eq!(w.tiers(&g.account).auto.0, 0, "guests have no auto limit");
    assert_eq!(w.rep(&g.account), 20_000);
    w.pay_all();
    w.vote(&council()[0], p[0].id, "VoteApprove").unwrap();
    w.vote(&council()[1], p[0].id, "VoteApprove").unwrap();
    assert_eq!(w.check(p[0].id), hat_tip::types::Status::Paid);
    assert_eq!(w.dao.balance(g.account.as_str()), 120 * USD);
    // 20,000 halves each round: 10,000, 5,000, 2,500, 1,250, then 625 < one thanks: zero.
    w.close_through(5);
    assert_eq!(w.rep(&g.account), 1_250);
    w.close_through(6);
    assert_eq!(w.rep(&g.account), 0);
    w.close_through(7);
    assert_eq!(w.member(&g.account).carry.0, 0);
    // The record is gone: a new action starts from nonce 1 again.
    let mut again = Key::new(8);
    assert!(w.join(&mut again, None).ok);
}

#[test]
fn guests_together_receive_at_most_the_receive_cap() {
    let mut c = cfg();
    c.guest_receive_cap_bp = 2_000;
    let mut w = World::with(c);
    let m = members();
    let mut farm: Vec<Key> = (30..33).map(Key::new).collect();
    w.at(1, 100);
    for k in farm.iter_mut() {
        assert!(w.guest_allocate(k, &[(&m[0], 10)]).ok);
    }
    // A member routes 90 thanks to the farm and 10 to another member.
    let gifts: Vec<(&near_sdk::AccountId, u16)> =
        farm.iter().map(|k| (&k.account, 30)).chain(std::iter::once((&m[1], 10))).collect();
    assert!(w.allocate(&m[0], &gifts).ok);
    w.close_through(1);
    let r = w.round(1).unwrap();
    let to_guests: u128 = r.points.iter().filter(|p| p.0.as_str().len() == 64).map(|p| p.1.0).sum();
    let to_members: u128 = r.points.iter().filter(|p| p.0.as_str().len() != 64).map(|p| p.1.0).sum();
    // Members receive 10,000 + 3 * 5,000; guests at most 20 % of the round.
    assert_eq!(to_members, 25_000);
    assert!(to_guests * 8_000 <= to_members * 2_000, "{to_guests} vs {to_members}");
    assert_eq!(to_guests, 3 * (30_000 * 25_000 * 2_000 / (90_000 * 8_000)));
    let paid_to_guests: u128 =
        w.round_payouts(1).iter().filter(|p| p.receiver.as_str().len() == 64).map(|p| p.amount.0).sum();
    assert!(paid_to_guests * 5 <= 120 * USD, "guests get at most a fifth of the budget");
    w.assert_audit();
}
