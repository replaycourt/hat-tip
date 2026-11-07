//! The arithmetic of a close, free of storage and environment, so it can be tested on its own
//! and read next to the simulation (`sim/`). Every division rounds down. README.md, "Counting,
//! exactly", states the same steps in words.

use crate::config::{BP, Config, MILLI};

/// One final allocation entry of a round: `given` whole thanks from `giver` to `receiver`
/// (indices into the round's account table).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Entry {
    pub giver: usize,
    pub receiver: usize,
    pub given: u16,
}

/// What the pipeline knows about each account of the round's table.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Role {
    /// In the member list fetched at the close.
    pub member: bool,
    /// A guest seated in the round.
    pub guest: bool,
    /// Has a non-empty allocation in the round (before eligibility).
    pub gave: bool,
}

/// The dampening parameters of the counting pipeline.
#[derive(Clone, Copy, Debug)]
pub struct Rules {
    pub guest_weight_bp: u128,
    pub guest_cap_bp: u128,
    pub reciprocal_bp: u128,
    pub quadratic: bool,
    pub breadth_k: u32,
    pub breadth_bp: u128,
    pub idle_bp: u128,
    pub guest_receive_cap_bp: u128,
}

impl Rules {
    pub fn from_config(c: &Config) -> Self {
        Self {
            guest_weight_bp: c.guest_weight_bp as u128,
            guest_cap_bp: c.guest_cap_bp as u128,
            reciprocal_bp: c.reciprocal_bp as u128,
            quadratic: c.quadratic,
            breadth_k: c.breadth_k as u32,
            breadth_bp: c.breadth_bp as u128,
            idle_bp: c.idle_bp as u128,
            guest_receive_cap_bp: c.guest_receive_cap_bp as u128,
        }
    }
}

/// Integer square root, rounded down.
pub fn isqrt(n: u128) -> u128 {
    if n < 2 {
        return n;
    }
    // Newton's method from a power of two above the root.
    let mut x = 1u128 << ((128 - n.leading_zeros()).div_ceil(2));
    loop {
        let y = (x + n / x) / 2;
        if y >= x {
            return x;
        }
        x = y;
    }
}

/// The counted points (milli-thanks) of every entry, in entry order, after steps 1-6 of DESIGN.md
/// "Counting" and the guests' receive cap (step 7, README.md). An entry that is not eligible
/// counts 0.
pub fn count(roles: &[Role], entries: &[Entry], r: &Rules) -> Vec<u128> {
    // 1. Eligibility.
    let eligible: Vec<bool> = entries
        .iter()
        .map(|e| {
            let g = roles[e.giver];
            let v = roles[e.receiver];
            e.giver != e.receiver
                && e.given > 0
                && (g.member || g.guest)
                && (v.member || v.guest)
                && !(g.guest && v.guest)
        })
        .collect();
    let is_guest_giver = |e: &Entry| !roles[e.giver].member && roles[e.giver].guest;

    // 2. Weight, and the guests' cap.
    let mut w: Vec<u128> = entries
        .iter()
        .zip(&eligible)
        .map(|(e, ok)| {
            if !ok {
                0
            } else if is_guest_giver(e) {
                e.given as u128 * r.guest_weight_bp / 10
            } else {
                e.given as u128 * MILLI
            }
        })
        .collect();
    let (mut g_sum, mut m_sum) = (0u128, 0u128);
    for (i, e) in entries.iter().enumerate() {
        if is_guest_giver(e) {
            g_sum += w[i];
        } else {
            m_sum += w[i];
        }
    }
    if g_sum * (BP - r.guest_cap_bp) > m_sum * r.guest_cap_bp {
        let num = m_sum * r.guest_cap_bp;
        let den = g_sum * (BP - r.guest_cap_bp);
        for (i, e) in entries.iter().enumerate() {
            if is_guest_giver(e) {
                w[i] = w[i] * num / den;
            }
        }
    }

    // 3. Reciprocity: each pair that thanked each other loses the same cut in both directions.
    if r.reciprocal_bp < BP {
        let k = roles.len();
        let mut at = vec![usize::MAX; k * k];
        for (i, e) in entries.iter().enumerate() {
            at[e.giver * k + e.receiver] = i;
        }
        let original = w.clone();
        for (i, e) in entries.iter().enumerate() {
            let j = at[e.receiver * k + e.giver];
            if j == usize::MAX || j <= i || original[i] == 0 || original[j] == 0 {
                continue;
            }
            let cut = original[i].min(original[j]) * (BP - r.reciprocal_bp) / BP;
            w[i] -= cut;
            w[j] -= cut;
        }
    }

    // 4. Aggregation.
    let mut a: Vec<u128> = if r.quadratic {
        let total: u128 = w.iter().sum();
        let v: Vec<u128> = w.iter().map(|x| isqrt(x * 1_000_000)).collect();
        let mut s = vec![0u128; roles.len()];
        for (i, e) in entries.iter().enumerate() {
            s[e.receiver] += v[i];
        }
        let q: u128 = s.iter().map(|x| x * x).sum();
        entries.iter().enumerate().map(|(i, e)| if q == 0 { 0 } else { total * v[i] * s[e.receiver] / q }).collect()
    } else {
        w
    };

    // 5. Breadth: count the givers whose share in a receiver is still above zero.
    if r.breadth_k > 0 && r.breadth_bp < BP {
        let mut support = vec![0u32; roles.len()];
        for (i, e) in entries.iter().enumerate() {
            if a[i] > 0 {
                support[e.receiver] += 1;
            }
        }
        for (i, e) in entries.iter().enumerate() {
            if support[e.receiver] < r.breadth_k {
                a[i] = a[i] * r.breadth_bp / BP;
            }
        }
    }

    // 6. Idle: a member receiver who gave nothing in the round.
    if r.idle_bp < BP {
        for (i, e) in entries.iter().enumerate() {
            let v = roles[e.receiver];
            if v.member && !v.gave {
                a[i] = a[i] * r.idle_bp / BP;
            }
        }
    }

    // 7. The guests' receive cap: guests together receive at most `guest_receive_cap_bp` of the
    // round's points, by the same rule as the cap on what they give.
    if r.guest_receive_cap_bp < BP {
        let to_guest = |e: &Entry| !roles[e.receiver].member && roles[e.receiver].guest;
        let (mut pg, mut pm) = (0u128, 0u128);
        for (i, e) in entries.iter().enumerate() {
            if to_guest(e) {
                pg += a[i];
            } else {
                pm += a[i];
            }
        }
        if pg * (BP - r.guest_receive_cap_bp) > pm * r.guest_receive_cap_bp {
            let num = pm * r.guest_receive_cap_bp;
            let den = pg * (BP - r.guest_receive_cap_bp);
            for (i, e) in entries.iter().enumerate() {
                if to_guest(e) {
                    a[i] = a[i] * num / den;
                }
            }
        }
    }
    a
}

/// One round of decay: `R * (10000 - decay_bp) / 10000`. A guest's reputation below one thanks
/// counts as zero (README.md, "Reputation").
pub fn decay_step(rep: u128, decay_bp: u128, guest: bool) -> u128 {
    let x = rep * (BP - decay_bp) / BP;
    if guest && x < MILLI { 0 } else { x }
}

/// `rep` carried from the close of round `from` to the close of round `to` without points.
pub fn decay_rounds(mut rep: u128, decay_bp: u128, guest: bool, from: u64, to: u64) -> u128 {
    if decay_bp == 0 {
        return rep;
    }
    let mut k = from;
    while k < to && rep > 0 {
        rep = decay_step(rep, decay_bp, guest);
        k += 1;
    }
    rep
}

/// Auto (tier 1) and co-sign (tier 2) limits for a receiver with reputation `rep` (before the
/// round's points).
pub fn limits(c: &Config, rep: u128, guest: bool) -> (u128, u128) {
    let thanks = rep / MILLI;
    let auto = if guest || rep < c.auto_rep_min as u128 * MILLI {
        0
    } else {
        c.auto_max.0.min(thanks.saturating_mul(c.auto_per_thanks.0))
    };
    let cosign = c.cosign_max.0.min(c.cosign_base.0.saturating_add(thanks.saturating_mul(c.cosign_per_thanks.0)));
    (auto, cosign)
}

/// The tier of a payout of `q` under the limits.
pub fn tier(q: u128, auto: u128, cosign: u128) -> u8 {
    if q <= auto {
        1
    } else if q <= cosign {
        2
    } else {
        3
    }
}

/// Applies the round cap in place: while tier 1 adds up to more than `auto_share_bp` of the
/// budget, the largest tier-1 payout (ties: the receiver sorting first) moves to tier 2.
/// `payouts` are `(receiver key, amount, tier)`.
pub fn round_cap<K: Ord + Clone>(payouts: &mut [(K, u128, u8)], budget: u128, auto_share_bp: u128) {
    let mut sum: u128 = payouts.iter().filter(|p| p.2 == 1).map(|p| p.1).sum();
    let cap = budget * auto_share_bp;
    while sum * BP > cap {
        let mut best: Option<usize> = None;
        for (i, p) in payouts.iter().enumerate() {
            if p.2 != 1 {
                continue;
            }
            best = match best {
                None => Some(i),
                Some(b) => {
                    let q = &payouts[b];
                    if p.1 > q.1 || (p.1 == q.1 && p.0 < q.0) { Some(i) } else { Some(b) }
                }
            };
        }
        let Some(b) = best else { break };
        payouts[b].2 = 2;
        sum -= payouts[b].1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rules() -> Rules {
        Rules {
            guest_weight_bp: 5_000,
            guest_cap_bp: 2_000,
            reciprocal_bp: 10_000,
            quadratic: false,
            breadth_k: 0,
            breadth_bp: 10_000,
            idle_bp: 10_000,
            guest_receive_cap_bp: 10_000,
        }
    }

    fn m() -> Role {
        Role { member: true, guest: false, gave: true }
    }

    fn e(giver: usize, receiver: usize, given: u16) -> Entry {
        Entry { giver, receiver, given }
    }

    #[test]
    fn isqrt_is_the_floor_root() {
        for n in 0u128..10_000 {
            let r = isqrt(n);
            assert!(r * r <= n && (r + 1) * (r + 1) > n, "isqrt({n}) = {r}");
        }
        for n in [u64::MAX as u128, (1u128 << 100) + 12345, 100_000_000_000u128, 99_999_999_999] {
            let r = isqrt(n);
            assert!(r * r <= n && (r + 1) * (r + 1) > n, "isqrt({n}) = {r}");
        }
    }

    #[test]
    fn linear_counts_every_member_thanks_as_a_thousand() {
        let roles = vec![m(), m(), m()];
        let out = count(&roles, &[e(0, 1, 10), e(0, 2, 30), e(1, 2, 5)], &rules());
        assert_eq!(out, vec![10_000, 30_000, 5_000]);
    }

    #[test]
    fn ineligible_entries_count_nothing() {
        let stranger = Role::default();
        let guest = Role { member: false, guest: true, gave: true };
        let roles = vec![m(), stranger, guest, guest, m()];
        let r = Rules { guest_cap_bp: 10_000, ..rules() };
        let out = count(&roles, &[e(0, 1, 10), e(1, 0, 10), e(2, 3, 10), e(2, 4, 10), e(0, 2, 10)], &r);
        assert_eq!(out[0], 0, "to a non-member");
        assert_eq!(out[1], 0, "from a non-member");
        assert_eq!(out[2], 0, "guest to guest");
        assert_eq!(out[3], 5_000, "guest to member at guest_weight_bp");
        assert_eq!(out[4], 10_000, "member to guest");
    }

    #[test]
    fn guests_together_steer_at_most_their_cap() {
        let guest = Role { member: false, guest: true, gave: true };
        // Members give 20 thanks (20,000), guests 100 at half weight (50,000): capped at 20 %.
        let roles = vec![m(), m(), guest, guest];
        let out = count(&roles, &[e(0, 1, 20), e(2, 0, 50), e(3, 1, 50)], &rules());
        assert_eq!(out[0], 20_000);
        // G = 50,000, M = 20,000: scale 20,000 * 2,000 / (50,000 * 8,000) = 0.1.
        assert_eq!(out[1], 25_000 * 20_000 * 2_000 / (50_000 * 8_000));
        let g: u128 = out[1] + out[2];
        assert!(g * 8_000 <= 20_000 * 2_000);
    }

    #[test]
    fn reciprocity_cuts_both_directions_by_the_same_amount() {
        let roles = vec![m(), m(), m()];
        let r = Rules { reciprocal_bp: 5_000, ..rules() };
        let out = count(&roles, &[e(0, 1, 40), e(1, 0, 30), e(2, 0, 10)], &r);
        // m = 30,000, cut = 15,000 from each.
        assert_eq!(out, vec![25_000, 15_000, 10_000]);
    }

    #[test]
    fn quadratic_keeps_the_round_total_and_favours_breadth() {
        let roles = vec![m(); 6];
        let r = Rules { quadratic: true, ..rules() };
        // Receiver 1: one giver with 40. Receiver 2: four givers with 10 each.
        let entries = [e(0, 1, 40), e(3, 2, 10), e(4, 2, 10), e(5, 2, 10), e(0, 2, 10)];
        let out = count(&roles, &entries, &r);
        let total: u128 = out.iter().sum();
        assert!(total <= 80_000 && total + 5 >= 80_000, "total {total}");
        let p1 = out[0];
        let p2: u128 = out[1..].iter().sum();
        assert!(p2 > 2 * p1, "breadth wins: {p1} vs {p2}");
    }

    #[test]
    fn breadth_and_idle_multiply_each_share() {
        let roles = vec![m(), m(), m(), Role { member: true, guest: false, gave: false }];
        let r = Rules { breadth_k: 2, breadth_bp: 5_000, idle_bp: 2_500, ..rules() };
        let out = count(&roles, &[e(0, 1, 10), e(0, 2, 10), e(1, 2, 10), e(0, 3, 10), e(1, 3, 10)], &r);
        assert_eq!(out[0], 5_000, "one giver only");
        assert_eq!(out[1] + out[2], 20_000, "two givers");
        assert_eq!(out[3] + out[4], 5_000, "idle receiver");
    }

    #[test]
    fn guests_together_receive_at_most_their_receive_cap() {
        let guest = Role { member: false, guest: true, gave: true };
        // Member 0 sends 90 thanks to three guests and 10 to member 1; a guest thanks member 0.
        let roles = vec![m(), m(), guest, guest, guest];
        let entries = [e(0, 2, 30), e(0, 3, 30), e(0, 4, 30), e(0, 1, 10), e(2, 0, 10)];
        let open = count(&roles, &entries, &rules());
        assert_eq!(open, vec![30_000, 30_000, 30_000, 10_000, 5_000]);
        let r = Rules { guest_receive_cap_bp: 2_000, ..rules() };
        let out = count(&roles, &entries, &r);
        // Pg = 90,000, Pm = 15,000: each guest entry 30,000 * 15,000 * 2,000 / (90,000 * 8,000).
        assert_eq!(out, vec![1_250, 1_250, 1_250, 10_000, 5_000]);
        let pg: u128 = out[..3].iter().sum();
        assert!(pg * 8_000 <= 15_000 * 2_000);
        // Not binding: unchanged.
        let r = Rules { guest_receive_cap_bp: 9_000, ..rules() };
        assert_eq!(count(&roles, &entries, &r), open);
    }

    #[test]
    fn decay_rounds_down_every_round_and_zeroes_small_guests() {
        assert_eq!(decay_step(10_000, 500, false), 9_500);
        assert_eq!(decay_step(999, 500, false), 949);
        assert_eq!(decay_step(1_050, 500, true), 0);
        assert_eq!(decay_rounds(10_000, 500, false, 3, 5), 9_025);
        assert_eq!(decay_rounds(10_000, 0, false, 3, 500), 10_000);
    }

    #[test]
    fn round_cap_moves_the_largest_first() {
        let mut p = vec![("a", 50u128, 1u8), ("b", 30, 1), ("c", 30, 1), ("d", 100, 3)];
        round_cap(&mut p, 100, 6_000);
        assert_eq!(p.iter().map(|x| x.2).collect::<Vec<_>>(), vec![2, 1, 1, 3]);
        let mut p = vec![("a", 30u128, 1u8), ("b", 30, 1), ("c", 30, 1)];
        round_cap(&mut p, 100, 3_000);
        assert_eq!(p.iter().map(|x| x.2).collect::<Vec<_>>(), vec![2, 2, 1]);
    }
}
