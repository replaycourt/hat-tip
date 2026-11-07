//! The hard rules of giving: who may give, to whom, how much, and when.
mod common;

use common::*;
use near_sdk::AccountId;

fn refused(w: &mut World, who: &AccountId, gifts: &[(&AccountId, u16)], why: &str) {
    let out = w.allocate(who, gifts);
    assert!(!out.ok, "allowed but should fail with '{why}'");
    let e = out.error.unwrap();
    assert!(e.contains(why), "error '{e}' does not say '{why}'");
    assert_eq!(out.given, 0);
}

#[test]
fn nothing_opens_before_genesis() {
    let mut w = World::new();
    assert_eq!(w.clock(), 0);
    let m = members();
    let out = w.call(&m[0], |c| c.allocate(1, vec![(m[1].clone(), 10)], None));
    assert!(!out.ok && out.error.unwrap().contains("not started"));
    w.at(1, 0);
    assert_eq!(w.clock(), 1);
    assert!(w.allocate(&m[0], &[(&m[1], 10)]).ok);
}

#[test]
fn only_the_clock_round_takes_allocations() {
    let mut w = World::new();
    let m = members();
    w.at(2, 10);
    for r in [1, 3] {
        let out = w.call(&m[0], |c| c.allocate(r, vec![(m[1].clone(), 10)], None));
        assert!(!out.ok, "round {r}");
        assert!(out.error.unwrap().contains("this is round 2"));
    }
    let out = w.call(&m[0], |c| c.allocate(2, vec![(m[1].clone(), 10)], None));
    assert!(out.ok);
}

#[test]
fn every_hard_rule_refuses() {
    let mut w = World::new();
    let m = members();
    let stranger = acc("stranger.testnet");
    w.at(1, 100);
    refused(&mut w, &stranger, &[(&m[1], 10)], "not a member");
    refused(&mut w, &m[0], &[(&m[0], 10)], "yourself");
    refused(&mut w, &m[0], &[(&m[1], 41)], "from 1 to 40");
    refused(&mut w, &m[0], &[(&m[1], 0)], "from 1 to 40");
    refused(&mut w, &m[0], &[(&m[1], 40), (&m[2], 40), (&m[3], 21)], "at most 100 thanks");
    refused(&mut w, &m[0], &[(&m[1], 10), (&m[1], 10)], "named twice");
    refused(&mut w, &m[0], &[(&stranger, 10)], "neither a member nor a seated guest");
    let guest = Key::new(1);
    refused(&mut w, &m[0], &[(&guest.account, 10)], "neither a member nor a seated guest");

    let mut c = cfg();
    c.max_receivers = 3;
    let mut w = World::with(c);
    w.at(1, 100);
    refused(&mut w, &m[0], &[(&m[1], 1), (&m[2], 1), (&m[3], 1), (&m[4], 1)], "at most 3 receivers");
    assert!(w.allocate(&m[0], &[(&m[1], 1), (&m[2], 1), (&m[3], 1)]).ok);
    // Nothing was logged for the refusals.
    assert_eq!(w.events(Some("allocated")).len(), 1);
}

#[test]
fn a_new_allocation_replaces_the_old_one_and_an_empty_one_withdraws() {
    let mut w = World::new();
    let m = members();
    w.at(1, 100);
    assert_eq!(w.allocate(&m[0], &[(&m[1], 40), (&m[2], 40), (&m[3], 20)]).given, 100);
    assert_eq!(w.allocate(&m[0], &[(&m[4], 25)]).given, 25);
    let r = w.round(1).unwrap();
    assert_eq!(r.gifts.len(), 1);
    assert_eq!((r.gifts[0].1.clone(), r.gifts[0].2), (m[4].clone(), 25));
    assert!(w.allocate(&m[1], &[(&m[0], 5)]).ok);
    assert!(w.allocate(&m[0], &[]).ok);
    let r = w.round(1).unwrap();
    assert_eq!(r.gifts.len(), 1, "only m1's allocation stands");
    w.close_through(1);
    // m0 gave nothing in the end: it only receives.
    assert_eq!(w.round(1).unwrap().points, vec![(m[0].clone(), near_sdk::json_types::U128(5_000))]);
}

#[test]
fn notes_are_one_line_of_at_most_note_max_bytes() {
    let mut w = World::new();
    let m = members();
    w.at(1, 100);
    let out = w.allocate_note(&m[0], &[(&m[1], 10)], "fixed two kettles and a lamp");
    assert!(out.ok);
    w.call(&m[1], |c| c.note(1, "sorted the screws".into()));
    w.call(&m[1], |c| c.note(1, "sorted the screws and the bolts".into()));
    let r = w.round(1).unwrap();
    assert_eq!(
        r.notes,
        vec![
            (m[0].clone(), "fixed two kettles and a lamp".to_string()),
            (m[1].clone(), "sorted the screws and the bolts".into())
        ]
    );
    let long = "x".repeat(81);
    let out = w.allocate_note(&m[2], &[(&m[1], 10)], &long);
    assert!(!out.ok && out.error.unwrap().contains("at most 80 bytes"));
    let out = w.allocate_note(&m[2], &[(&m[1], 10)], "two\nlines");
    assert!(!out.ok && out.error.unwrap().contains("one line"));
    // An empty note deletes the note.
    w.call(&m[1], |c| c.note(1, String::new()));
    assert_eq!(w.round(1).unwrap().notes.len(), 1);
    assert_eq!(w.events(Some("note")).len(), 4);
}

#[test]
#[should_panic(expected = "not a member")]
fn a_stranger_cannot_post_a_note() {
    let mut w = World::new();
    w.at(1, 100);
    w.call(&acc("stranger.testnet"), |c| c.note(1, "hello".into()));
}

#[test]
fn allocations_are_logged_with_every_gift() {
    let mut w = World::new();
    let m = members();
    w.at(1, 100);
    w.allocate(&m[0], &[(&m[1], 30), (&m[2], 12)]);
    let e = entries(&w.last_events(Some("allocated")));
    assert_eq!(e.len(), 1);
    assert_eq!(e[0]["round"], 1);
    assert_eq!(e[0]["giver"], m[0].as_str());
    assert_eq!(e[0]["guest"], false);
    assert_eq!(e[0]["given"], 42);
    assert_eq!(e[0]["gifts"], near_sdk::serde_json::json!([[m[1].as_str(), 30], [m[2].as_str(), 12]]));
}

#[test]
fn membership_comes_from_the_last_sync() {
    let mut w = World::new();
    let m = members();
    let newcomer = member("ivy");
    w.at(1, 100);
    refused(&mut w, &newcomer, &[(&m[0], 10)], "not a member");
    w.dao.members.push(newcomer.to_string());
    refused(&mut w, &newcomer, &[(&m[0], 10)], "not a member");
    w.sync();
    assert!(w.allocate(&newcomer, &[(&m[0], 10)]).ok);
    assert!(w.allocate(&m[0], &[(&newcomer, 10)]).ok);
}
