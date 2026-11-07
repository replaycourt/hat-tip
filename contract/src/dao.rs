//! What the contract sends to and reads from the Sputnik v2 DAO and the token: the policy, the
//! proposal kinds of the three tiers, and a proposal's status. JSON as Sputnik v2 (2.3.1) writes
//! and reads it.

use crate::config::{COUNCIL_KEEP, GAS_FT_TRANSFER};
use near_sdk::base64::Engine;
use near_sdk::base64::engine::general_purpose::STANDARD;
use near_sdk::serde_json::{self, Value, json};
use near_sdk::{AccountId, AccountIdRef};

/// What the contract needs from `get_policy`.
#[derive(Clone, Debug, PartialEq)]
pub struct PolicyFacts {
    /// Named members, sorted, at most `max_members`.
    pub members: Vec<AccountId>,
    /// Named members beyond `max_members` that were left out.
    pub dropped: u32,
    pub council: Vec<AccountId>,
    pub bond: u128,
    pub proposal_period_ns: u64,
    /// Why the contract cannot file and approve payouts, if it cannot.
    pub problem: Option<String>,
}

/// The permissions the contract's role needs: file both kinds, approve transfers (tier 1), and
/// finalize expired proposals of both kinds.
pub const NEEDED: [(&str, &str); 5] = [
    ("transfer", "AddProposal"),
    ("transfer", "VoteApprove"),
    ("call", "AddProposal"),
    ("transfer", "Finalize"),
    ("call", "Finalize"),
];

/// Implicit accounts (64 hex characters) and Ethereum-style `0x` accounts do not count as
/// members: membership is for named accounts.
pub fn is_named(a: &AccountIdRef) -> bool {
    let s = a.as_str();
    let hex = |t: &str| t.bytes().all(|b| b.is_ascii_hexdigit());
    !((s.len() == 64 && hex(s)) || (s.len() == 42 && s.starts_with("0x") && hex(&s[2..])))
}

/// A guest is the implicit account of a browser key.
pub fn is_implicit(a: &AccountIdRef) -> bool {
    let s = a.as_str();
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn u128_of(v: &Value) -> Option<u128> {
    match v {
        Value::String(s) => s.parse().ok(),
        Value::Number(n) => n.as_u64().map(u128::from),
        _ => None,
    }
}

fn group(role: &Value) -> Vec<AccountId> {
    role.get("kind")
        .and_then(|k| k.get("Group"))
        .and_then(|g| g.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str()).filter_map(|s| s.parse().ok()).collect())
        .unwrap_or_default()
}

fn allows(perms: &[String], kind: &str, action: &str) -> bool {
    perms.iter().any(|p| {
        *p == format!("{kind}:{action}") || *p == format!("{kind}:*") || *p == format!("*:{action}") || p == "*:*"
    })
}

/// Reads the facts out of `get_policy`'s JSON. `None` if it is not a policy.
pub fn parse_policy(
    bytes: &[u8],
    me: &AccountIdRef,
    members_role: &str,
    council_role: &str,
    thanks_role: &str,
    max_members: usize,
) -> Option<PolicyFacts> {
    let v: Value = serde_json::from_slice(bytes).ok()?;
    let roles = v.get("roles")?.as_array()?;
    let bond = u128_of(v.get("proposal_bond")?)?;
    let proposal_period_ns = u64::try_from(u128_of(v.get("proposal_period")?)?).ok()?;
    let find = |name: &str| roles.iter().find(|r| r.get("name").and_then(|n| n.as_str()) == Some(name));

    let mut members: Vec<AccountId> =
        find(members_role).map(group).unwrap_or_default().into_iter().filter(|a| is_named(a)).collect();
    members.sort();
    members.dedup();
    let dropped = members.len().saturating_sub(max_members) as u32;
    members.truncate(max_members);

    let mut council = find(council_role).map(group).unwrap_or_default();
    council.sort();
    council.dedup();
    council.truncate(COUNCIL_KEEP);

    let problem = match find(thanks_role) {
        None => Some(format!("the DAO has no role {thanks_role}")),
        Some(role) => {
            if !group(role).iter().any(|a| a.as_str() == me.as_str()) {
                Some(format!("this contract is not in the DAO role {thanks_role}"))
            } else {
                let perms: Vec<String> = role
                    .get("permissions")
                    .and_then(|p| p.as_array())
                    .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                    .unwrap_or_default();
                NEEDED
                    .iter()
                    .find(|(k, a)| !allows(&perms, k, a))
                    .map(|(k, a)| format!("the DAO role {thanks_role} lacks {k}:{a}"))
            }
        }
    };
    Some(PolicyFacts { members, dropped, council, bond, proposal_period_ns, problem })
}

/// The DAO proposal kind of a payout: `Transfer` of the token for tiers 1 and 3, a
/// `FunctionCall` of the token's `ft_transfer` for tier 2. `act_proposal` must get it back
/// byte for byte, so it is always rebuilt from the same fields.
pub fn proposal_kind(tier: u8, token: &AccountId, receiver: &AccountId, amount: u128) -> Value {
    if tier == 2 {
        let args = json!({"receiver_id": receiver, "amount": amount.to_string()}).to_string();
        json!({"FunctionCall": {
            "receiver_id": token,
            "actions": [{
                "method_name": "ft_transfer",
                "args": STANDARD.encode(args.as_bytes()),
                "deposit": "1",
                "gas": GAS_FT_TRANSFER.as_gas().to_string(),
            }],
        }})
    } else {
        json!({"Transfer": {"token_id": token, "receiver_id": receiver, "amount": amount.to_string()}})
    }
}

pub fn kind_name(tier: u8) -> &'static str {
    if tier == 2 { "function_call" } else { "transfer" }
}

/// The proposal text: `Hat Tip r42: 31.5 thanks from 5 -> ana.repaircafe.testnet (auto)`.
pub fn description(name: &str, round: u64, points: u128, givers: u16, receiver: &AccountId, tier: u8) -> String {
    let label = match tier {
        1 => "auto",
        2 => "one council vote",
        _ => "council majority",
    };
    let tenths = points / 100;
    format!("{name} r{round}: {}.{} thanks from {givers} -> {receiver} ({label})", tenths / 10, tenths % 10)
}

pub fn add_proposal_args(description: &str, kind: &Value) -> Vec<u8> {
    json!({"proposal": {"description": description, "kind": kind}}).to_string().into_bytes()
}

pub fn act_proposal_args(id: u64, action: &str, kind: &Value) -> Vec<u8> {
    json!({"id": id, "action": action, "proposal": kind}).to_string().into_bytes()
}

/// A proposal as `get_proposals(id, 1)` reports it.
#[derive(Clone, Debug, PartialEq)]
pub enum Seen {
    /// The DAO has no proposal with this id any more: it was removed.
    Missing,
    Found {
        status: String,
        submission_ns: u64,
    },
}

/// Reads `get_proposals(id, 1)`'s answer. `None` if it is not one.
pub fn parse_proposals(bytes: &[u8], id: u64) -> Option<Seen> {
    let v: Value = serde_json::from_slice(bytes).ok()?;
    let list = v.as_array()?;
    let Some(p) = list.iter().find(|p| p.get("id").and_then(|x| x.as_u64()) == Some(id)) else {
        return if list.is_empty() { Some(Seen::Missing) } else { None };
    };
    let status = p.get("status")?.as_str()?.to_string();
    let submission_ns = u64::try_from(u128_of(p.get("submission_time")?)?).ok()?;
    Some(Seen::Found { status, submission_ns })
}
