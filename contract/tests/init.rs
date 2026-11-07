//! Init: every parameter is checked once and shown by `config()`; nothing runs before the first
//! sync; the views answer before genesis.
mod common;

use common::*;
use hat_tip::config::Config;
use near_sdk::serde_json::{self, json};

fn refuses(f: impl FnOnce(&mut Config), why: &str) {
    let mut c = cfg();
    f(&mut c);
    let r = std::panic::catch_unwind(|| World::bare(c));
    let err = r.err().unwrap_or_else(|| panic!("accepted, but should fail with '{why}'"));
    let msg = err.downcast_ref::<String>().cloned().unwrap_or_default();
    assert!(msg.contains(why), "expected '{why}', got '{msg}'");
}

#[test]
fn every_parameter_is_checked() {
    refuses(|c| c.round_ms = 999, "round_ms");
    refuses(|c| c.thanks_per_round = 0, "thanks_per_round");
    refuses(|c| c.cap_per_receiver = 101, "cap_per_receiver");
    refuses(|c| c.cap_per_receiver = 0, "cap_per_receiver");
    refuses(|c| c.max_receivers = 0, "max_receivers");
    refuses(|c| c.reciprocal_bp = 10_001, "reciprocal_bp");
    refuses(|c| c.decay_bp = 10_001, "decay_bp");
    refuses(|c| c.guest_cap_bp = 10_001, "guest_cap_bp");
    refuses(|c| c.guest_receive_cap_bp = 10_001, "guest_receive_cap_bp");
    refuses(|c| c.min_payout = near_sdk::json_types::U128(0), "min_payout");
    refuses(|c| c.max_members = 59, "at most 64");
    refuses(|c| c.max_catchup = 0, "max_catchup");
    refuses(|c| c.log_keep = 1, "log_keep");
    refuses(|c| c.note_max_bytes = 281, "note_max_bytes");
    refuses(|c| c.thanks_role = "members".into(), "must differ");
    refuses(|c| c.council_role = String::new(), "council_role");
}

#[test]
fn config_round_trips_and_role_names_default() {
    let mut w = World::new();
    assert_eq!(w.view(|c| c.config()), cfg());
    let mut v = serde_json::to_value(cfg()).unwrap();
    let o = v.as_object_mut().unwrap();
    o.remove("members_role");
    o.remove("council_role");
    o.remove("thanks_role");
    o.remove("guest_receive_cap_bp");
    let c: Config = serde_json::from_value(v).unwrap();
    assert_eq!(
        (c.members_role.as_str(), c.council_role.as_str(), c.thanks_role.as_str()),
        ("members", "council", "thanks")
    );
    assert_eq!(c.guest_receive_cap_bp, 10_000, "off unless set");
    // U128 fields are strings in JSON.
    assert_eq!(serde_json::to_value(cfg()).unwrap()["round_budget"], json!("120000000"));
}

#[test]
fn nothing_is_filed_before_the_first_sync() {
    let mut w = World::bare(cfg());
    let s = w.state();
    assert!(s.paused);
    assert_eq!(s.pause_reason.as_deref(), Some("the DAO policy has not been read yet"));
    assert!(s.members.is_empty());
    assert_eq!((s.round, s.round_ends_ms, s.oldest_unclosed, s.due), (0, GENESIS_MS, 1, 0));
    assert_eq!(w.pay(5).error.as_deref(), Some("paused: the DAO policy has not been read yet"));
    w.sync();
    let s = w.state();
    assert!(!s.paused);
    assert_eq!(s.members, members());
    assert_eq!(s.bond.0, BOND);
    assert_eq!(s.name, "Hat Tip");
    let e = entries(&w.events(Some("synced")));
    assert_eq!(
        e,
        vec![json!({"members": 8, "council": 3, "dropped": 0, "bond": BOND.to_string(),
        "proposal_period": PERIOD_NS.to_string(), "paused": false})]
    );
}

#[test]
fn the_views_answer_for_unknown_accounts_and_rounds() {
    let mut w = World::new();
    assert_eq!(w.round(0), None);
    assert_eq!(w.round(1), None, "not started");
    w.at(1, 10);
    let r = w.round(1).unwrap();
    assert!(!r.closed && r.gifts.is_empty());
    assert_eq!((r.starts_ms, r.ends_ms), (GENESIS_MS, GENESIS_MS + ROUND_MS));
    let mv = w.member(&acc("nobody.testnet"));
    assert_eq!((mv.kind.as_str(), mv.reputation.0, mv.limits.cosign.0), ("other", 0, 5 * USD));
    assert_eq!(w.member(&members()[0]).kind, "member");
    assert!(w.view(|c| c.payouts(0, 10)).is_empty());
    let a = w.audit();
    assert!(a.balanced && a.statuses_ok && a.points_attributed && a.filed_have_ids && a.carry_ok);
}

#[test]
fn old_rounds_and_final_payouts_are_pruned_after_log_keep() {
    let mut c = cfg();
    c.log_keep = 3;
    let mut w = World::with(c);
    let m = members();
    w.at(1, 100);
    w.allocate(&m[0], &[(&m[1], 30)]);
    w.close_through(1);
    let id = w.round_payouts(1)[0].id;
    w.pay_all();
    w.vote(&council()[0], id, "VoteReject").unwrap();
    w.vote(&council()[1], id, "VoteReject").unwrap();
    w.check(id);
    w.close_through(3);
    assert!(w.round(1).is_some());
    assert!(w.view(|c| c.payouts(0, 10)).len() == 1);
    w.close_through(4);
    assert!(w.round(1).is_none(), "round 1 left the log");
    assert!(w.member(&m[1]).history.is_empty());
    assert!(w.view(|c| c.payouts(0, 10)).is_empty(), "the final payout of round 1 is pruned");
    assert_eq!(w.state().oldest_payout, 1);
    w.assert_audit();
}

#[test]
fn the_launch_parameters_of_sim_params_json_are_accepted() {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../sim/params.json");
    let Ok(bytes) = std::fs::read(&path) else {
        eprintln!("params: SKIPPED, no sim/params.json (package b, interface I-2)");
        return;
    };
    let p: near_sdk::serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    for column in ["testnet", "community"] {
        let mut v = p[column]["config"].clone();
        v["dao"] = DAO.into();
        v["token"] = TOKEN.into();
        v["genesis_ms"] = GENESIS_MS.into();
        let c: Config = serde_json::from_value(v).unwrap_or_else(|e| panic!("{column}: {e}"));
        let mut w = World::bare(c.clone());
        assert_eq!(w.view(|x| x.config()), c, "{column}");
        eprintln!("params: the {column} column is a valid Config");
    }
}
