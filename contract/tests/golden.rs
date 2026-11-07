//! Golden test: the contract closes every round of `sim/golden/*.json` (interface I-3, format in
//! `sim/golden/README.md`) exactly like the reference model `sim/hat_tip_sim.py`, to the base
//! unit and the milli-thanks: counted entries, points, budget, dust, payouts and tiers, the
//! limits behind them, reputation, carries, lapses, strikes and the running books.
//!
//! Each vector is played through the real contract in the mock VM against the DAO model of
//! `common`: the first sync sees `initial_members`, the DAO's members and balance are set to the
//! vector's before each close, every planned payout is filed after its close, and a round's
//! `outcomes` are put into the DAO and read by `check_payout` before the round's allocations.
//! Without vectors the test says so and passes.
mod common;

use common::*;
use hat_tip::config::Config;
use hat_tip::types::{Action, Status};
use near_sdk::AccountId;
use near_sdk::serde_json::{self, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

fn golden_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../sim/golden")
}

fn s(v: &Value) -> String {
    match v {
        Value::String(x) => x.clone(),
        Value::Number(n) => n.to_string(),
        other => panic!("expected a string or a number, got {other}"),
    }
}

fn n(v: &Value) -> u128 {
    s(v).parse().unwrap_or_else(|_| panic!("not a number: {v}"))
}

fn a(v: &Value) -> AccountId {
    v.as_str().unwrap_or_else(|| panic!("not an account: {v}")).parse().unwrap()
}

/// A list; `null` (what the vectors write for an empty round's lists) is the empty list.
fn list(v: &Value) -> &Vec<Value> {
    static EMPTY: Vec<Value> = Vec::new();
    if v.is_null() {
        return &EMPTY;
    }
    v.as_array().unwrap_or_else(|| panic!("not a list: {v}"))
}

fn play(path: &PathBuf) -> usize {
    let file = path.file_name().unwrap().to_string_lossy().to_string();
    let g: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let mut config: Value = g["config"].clone();
    config["dao"] = DAO.into();
    config["token"] = TOKEN.into();
    config["genesis_ms"] = GENESIS_MS.into();
    config["round_ms"] = ROUND_MS.into();
    let config: Config = serde_json::from_value(config).expect("config");

    let mut w = World::bare(config);
    w.dao.members = list(&g["initial_members"]).iter().map(|x| x.as_str().unwrap().to_string()).collect();
    w.sync();

    // Every account the vector names, to compare reputation and carry for all of them.
    let mut known: BTreeSet<AccountId> = list(&g["initial_members"])
        .iter()
        .map(a)
        .filter(|x| hat_tip::dao::is_named(x) || hat_tip::dao::is_implicit(x))
        .collect();
    let mut checks = 0usize;

    for round in list(&g["rounds"]) {
        let r = round["round"].as_u64().unwrap();
        let at = |what: &str| format!("{file} round {r}: {what}");
        assert_eq!(w.state().oldest_unclosed, r, "{}", at("rounds are closed in order"));
        w.at(r, 100);
        let e = &round["expected"];

        // DAO outcomes read before the round's allocations.
        let mark = w.logs.len();
        for o in list(&round["outcomes"]) {
            let pr = o["round"].as_u64().unwrap();
            let receiver = a(&o["receiver"]);
            let id = w
                .round_payouts(pr)
                .into_iter()
                .find(|p| p.receiver == receiver)
                .unwrap_or_else(|| panic!("{}", at(&format!("no payout to {receiver} in round {pr}"))))
                .id;
            let pid = w.payout(id).dao_proposal.unwrap_or_else(|| panic!("{}", at("payout not filed")));
            let status = o["status"].as_str().unwrap();
            match status {
                "paid" => w.dao.proposals[pid as usize].as_mut().unwrap().status = "Approved".into(),
                "rejected" => w.dao.proposals[pid as usize].as_mut().unwrap().status = "Rejected".into(),
                "expired" => w.dao.proposals[pid as usize].as_mut().unwrap().status = "Expired".into(),
                "removed" => w.dao.proposals[pid as usize] = None,
                other => panic!("{}", at(&format!("unknown outcome {other}"))),
            }
            let got = w.check(id);
            assert_eq!(got.name(), status, "{}", at("outcome recorded"));
        }
        let struck: Vec<(String, u64, String)> = entries(&parse_events(&w.logs[mark..], Some("struck")))
            .iter()
            .map(|x| (s(&x["account"]), x["round"].as_u64().unwrap(), s(&x["strike"])))
            .collect();
        let want: Vec<(String, u64, String)> =
            list(&e["strikes"]).iter().map(|x| (s(&x[0]), x[1].as_u64().unwrap(), s(&x[3]))).collect();
        assert_eq!(struck, want, "{}", at("strikes"));

        // Seats, notes, allocations.
        for seat in list(&round["seats"]) {
            let guest = a(seat);
            known.insert(guest.clone());
            let out = w.call(&acc("relayer.testnet"), |c| c.act_unsigned(guest, Action::Join { round: r, note: None }));
            assert!(out.ok, "{}", at(&format!("seat refused: {out:?}")));
        }
        for note in round["notes"].as_array().cloned().unwrap_or_default() {
            let who = a(&note[0]);
            let text = s(&note[1]);
            if hat_tip::dao::is_implicit(&who) {
                let out = w.call(&acc("relayer.testnet"), |c| c.act_unsigned(who, Action::Note { round: r, text }));
                assert!(out.ok, "{}", at(&format!("note refused: {out:?}")));
            } else {
                w.call(&who, |c| c.note(r, text));
            }
        }
        for alloc in list(&round["allocations"]) {
            let giver = a(&alloc["giver"]);
            let gifts: Vec<(AccountId, u16)> =
                list(&alloc["gifts"]).iter().map(|x| (a(&x[0]), x[1].as_u64().unwrap() as u16)).collect();
            known.insert(giver.clone());
            known.extend(gifts.iter().map(|x| x.0.clone()));
            let (ok, error) = if hat_tip::dao::is_implicit(&giver) {
                let out =
                    w.call(&acc("relayer.testnet"), |c| c.act_unsigned(giver, Action::Allocate { round: r, gifts }));
                (out.ok, out.error)
            } else {
                let out = w.call(&giver, |c| c.allocate(r, gifts, None));
                (out.ok, out.error)
            };
            assert!(ok, "{}", at(&format!("allocation refused: {error:?}")));
        }

        // The limits behind each payout come from the reputation before the close.
        for p in list(&e["payouts"]) {
            let receiver = a(&p["receiver"]);
            let l = w.tiers(&receiver);
            assert_eq!(
                (l.reputation.0, l.auto.0, l.cosign.0),
                (n(&p["r0"]), n(&p["auto_limit"]), n(&p["cosign_limit"])),
                "{}",
                at(&format!("limits of {receiver}"))
            );
        }

        // The DAO at the close.
        if !round["members"].is_null() {
            w.dao.members = list(&round["members"]).iter().map(|x| x.as_str().unwrap().to_string()).collect();
        }
        if !round["dao_balance"].is_null() {
            w.dao.balances.insert(DAO.into(), n(&round["dao_balance"]));
        }
        let mark = w.logs.len();
        w.close_through(r);
        let closed = entries(&parse_events(&w.logs[mark..], Some("round_closed")));
        let this = closed.iter().find(|x| x["round"] == r).unwrap_or_else(|| panic!("{}", at("no round_closed")));
        assert_eq!(this["empty"], e["empty"], "{}", at("empty"));

        let view = w.round(r).unwrap();
        let counted: BTreeMap<(AccountId, AccountId), (u16, u128)> =
            view.gifts.iter().map(|g| ((g.0.clone(), g.1.clone()), (g.2, g.3.0))).collect();
        for x in list(&e["entries"]) {
            let key = (a(&x[0]), a(&x[1]));
            let got = counted.get(&key).unwrap_or_else(|| panic!("{}", at(&format!("missing entry {key:?}"))));
            assert_eq!(*got, (x[2].as_u64().unwrap() as u16, n(&x[6])), "{}", at(&format!("entry {key:?}")));
        }
        for x in list(&e["dropped"]) {
            let key = (a(&x[0]), a(&x[1]));
            assert_eq!(counted.get(&key).map(|c| c.1), Some(0), "{}", at(&format!("dropped entry {key:?}")));
        }
        assert_eq!(counted.len(), list(&e["entries"]).len() + list(&e["dropped"]).len(), "{}", at("entry count"));
        let points: Vec<(AccountId, u128)> = view.points.iter().map(|(x, p)| (x.clone(), p.0)).collect();
        let want: Vec<(AccountId, u128)> =
            list(&e["points"]).iter().map(|x| (a(&x[0]), n(&x[1]))).filter(|x| x.1 > 0).collect();
        assert_eq!(points, want, "{}", at("points"));
        // An empty round's expectations leave out what it cannot have: no budget, no dust.
        let zero = |v: &Value| if v.is_null() && e["empty"] == true { 0 } else { n(v) };
        assert_eq!(view.budget.0, zero(&e["budget"]), "{}", at("budget"));
        assert_eq!(view.dust.0, zero(&e["dust"]), "{}", at("dust"));

        let payouts: Vec<(AccountId, u128, u8)> =
            w.round_payouts(r).into_iter().map(|p| (p.receiver, p.amount.0, p.tier)).collect();
        let want: Vec<(AccountId, u128, u8)> = list(&e["payouts"])
            .iter()
            .map(|p| (a(&p["receiver"]), n(&p["amount"]), p["tier"].as_u64().unwrap() as u8))
            .collect();
        assert_eq!(payouts, want, "{}", at("payouts"));

        let lapsed: Vec<(String, String, u64)> = entries(&parse_events(&w.logs[mark..], Some("carry_lapsed")))
            .iter()
            .map(|x| (s(&x["account"]), s(&x["amount"]), x["since"].as_u64().unwrap()))
            .collect();
        let want: Vec<(String, String, u64)> =
            list(&e["lapsed"]).iter().map(|x| (s(&x[0]), s(&x[1]), x[2].as_u64().unwrap())).collect();
        assert_eq!(lapsed, want, "{}", at("lapsed carries"));

        let reps: BTreeMap<AccountId, u128> = list(&e["reputation"]).iter().map(|x| (a(&x[0]), n(&x[1]))).collect();
        let carries: BTreeMap<AccountId, (u128, u64)> =
            list(&e["carry"]).iter().map(|x| (a(&x[0]), (n(&x[1]), x[2].as_u64().unwrap()))).collect();
        known.extend(reps.keys().cloned());
        known.extend(carries.keys().cloned());
        for x in &known {
            let mv = w.member(x);
            assert_eq!(mv.reputation.0, reps.get(x).copied().unwrap_or(0), "{}", at(&format!("reputation of {x}")));
            let (amount, since) = carries.get(x).copied().unwrap_or((0, 0));
            assert_eq!(mv.carry.0, amount, "{}", at(&format!("carry of {x}")));
            if amount > 0 {
                assert_eq!(mv.carry_since, since, "{}", at(&format!("carry stamp of {x}")));
            }
        }

        let books = w.audit();
        assert!(!e["audit"].is_null(), "{}", at("no audit numbers"));
        let au = &e["audit"];
        assert_eq!(
            (books.budgets.0, books.planned.0, books.carry.0, books.lapsed.0, books.dust.0),
            (n(&au["budget"]), n(&au["planned"]), n(&au["carry"]), n(&au["lapsed"]), n(&au["dust"])),
            "{}",
            at("books")
        );
        w.assert_audit();

        // File every planned payout so later outcomes can be read from the DAO.
        w.pay_all();
        assert_eq!(w.state().planned, 0, "{}", at("everything filed"));
        assert!(w.payouts().iter().all(|p| p.status != Status::Filing));
        checks += 1;
    }
    checks
}

#[test]
fn the_contract_closes_rounds_like_the_simulation() {
    let dir = golden_dir();
    let mut files: Vec<PathBuf> = std::fs::read_dir(&dir)
        .map(|d| {
            d.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "json")).collect()
        })
        .unwrap_or_default();
    files.sort();
    if files.is_empty() {
        eprintln!(
            "golden: SKIPPED, no vectors in {} (package b writes sim/golden/*.json, interface I-3)",
            dir.display()
        );
        return;
    }
    for f in &files {
        let rounds = play(f);
        eprintln!("golden: {} matches the simulation in {rounds} rounds", f.file_name().unwrap().to_string_lossy());
    }
}
