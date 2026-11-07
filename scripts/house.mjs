#!/usr/bin/env node
// The house of the Hat Tip testnet demo: the labelled house members, the house council and the
// keeper, playing by the strategies published in sim/params.json ("house") and DESIGN.md
// ("House members"). Every action is an ordinary transaction under the contract's and the DAO's
// rules, signed with function-call keys that can do nothing else.
//
//   node scripts/house.mjs run [--section staging] (--rounds <N> | --minutes <M>) [--seed <s>]
//                              [--quiet <k,...>] [--guest <k,...>] [--remove <k,...>] [--log <file.jsonl>] [--dry-run]
//   node scripts/house.mjs report [--section staging]          balances; LOW lines when something runs low
//   node scripts/house.mjs export-secret [--section staging]   the HOUSE_KEYS value for GitHub
//   node scripts/house.mjs summary [--section staging] [--log <file.jsonl,...>] [--from <round>]
//       per round: budget, payouts with tier, status and DAO proposal; payouts by tier and status;
//       audit(); the house members' reputation and limits; with --log the events by kind and a
//       replay of the events that rebuilds every reputation and compares it with member()
//
// Per round, by the clock (round r runs genesis_ms + (r-1)*round_ms .. + r*round_ms):
// - notes: between 5 % and 30 % of the round every member that works this round posts what it
//   fixed ("fixed 4 kettles"); the free rider posts a vague note, claiming one item with chance
//   free_rider_claim ("... (1 item)").
// - thanks: between 50 % and 80 % of the round every working member reads the round's notes and
//   guests and calls allocate: first welcome_each thanks to each of up to welcome_max guests who
//   posted a note and gave thanks this round, then (pair members) cap_per_receiver to the partner,
//   then the rest to the other house members in proportion to the items in their notes times
//   lognormal(0, noise_sigma) noise (sim/hat_tip_sim.py `house_script` and `split`). A member works
//   with chance p_work; the free rider never gives thanks.
// - keeper: closes due rounds (close_round, 255 Tgas), files planned payouts (pay, 300 Tgas), and
//   records outcomes (check_payout, 140 Tgas) once the DAO proposal has one, through its own relay
//   keys on the gas account.
// - council: at least two minutes after a tier-2 or tier-3 payout is filed, house council members
//   vote on its DAO proposal by the published rule (sim/hat_tip_sim.py `council_decision`): tier 2,
//   one vote: approve unless more than half of the receiver's points this round came from one
//   giver whom the receiver also thanked this round, then reject; tier 3, two votes: approve if at
//   least three givers stand behind the receiver's points this round, else reject. A proposal a
//   human already decided is left alone; votes already cast count.
//
// Keys: the environment variable HOUSE_KEYS (JSON, .github/workflows/house.yml passes the secret of
// that name), else the git-ignored .secrets/house-keys-<contract>.json. Format:
//   {"v":1,"section":"staging","contract":"...","members":{"<account>":"<64 hex seed>",...},
//    "council":{"<account>":"<seed>",...},"keeper":[{"account":"<gas account>","seed":"<seed>"},...]}
// Every key must be a function-call key on chain (members: allocate and note on the contract;
// council: act_proposal on the DAO; keeper: the relay methods on the contract); a full-access key is
// refused. Without keys the script logs "no house keys, nothing to do" and exits 0.
//
// --rounds N    play N rounds, then keep closing, paying, voting and checking until their payouts
//               are final (at most 10 more minutes), and exit. Never runs forever.
// --minutes M   play the rounds that end at least 8 minutes before M minutes are up; keep until M.
// --seed s      the members' random streams (default: the start time)
// --first r     resume a stopped run: play from round r (if it is still open) with the same seed;
//               actions already sent this round are sent again and replace themselves
// --quiet k     staging test: on the run's k-th round the five honest members skip (their one-in-ten
//               skip, all at once), so the pair and the free rider share the budget
// --guest k     staging test: on the run's k-th round a fresh browser-style guest joins with a note
//               and gives its thanks through the relay (act), as the page does
// --remove k    staging test: the first tier-2 payout of the run's k-th round gets one council
//               VoteRemove instead of the rule (the DAO deletes the proposal and keeps the bond;
//               the contract records `removed` and a strike)
// --log f       append every transaction record (JSON lines) to f
// --dry-run     read the chain, print the plan of the current round; send nothing
import { existsSync, readFileSync } from 'node:fs'
import { accessKeys, hex, nearPublicKey, newKey, rpc, sign, view } from './near-lite.mjs'
import {
  GAS, MEMBER_METHODS, COUNCIL_METHODS, RELAY_METHODS, Recorder, cli, deployment, freeBalance, houseKeysFile, itemsOf,
  loadParams, nearStr, publicKeyOfSeed, readJson, seedSigner, short, sleep, split, stamp, stream, tryView, tusd, writeSecret,
} from './hat-tip-lib.mjs'

const { opt, flag, positional } = cli()
const cmd = positional[0]
const section = opt('section', 'staging')
const GH = !!process.env.GITHUB_ACTIONS
const warn = (msg) => console.log(GH ? `::warning::${msg}` : `LOW  ${msg}`)
const kset = (s) => new Set(String(s ?? '').split(',').filter(Boolean).map(Number))
const COUNCIL_DELAY_MS = 120_000

// ---- the deployment, the strategies and the keys ----------------------------------------------------

const d = deployment(section)
const params = loadParams()
const H = params.house
const B = H.behaviour
const accountOf = (name) => `${name}.${d.root}`

function loadKeys() {
  let raw = process.env.HOUSE_KEYS
  if (!raw && existsSync(houseKeysFile(d.contract))) raw = readFileSync(houseKeysFile(d.contract), 'utf8')
  if (!raw || !raw.trim()) return null
  const k = JSON.parse(raw)
  if (k.contract !== d.contract) throw new Error(`the house keys are for ${k.contract}, not for the ${section} contract ${d.contract}`)
  return k
}

/** Checks a seed's key on chain: it must be a function-call key for `receiver` with exactly `methods`. */
async function checkKey(account, seed, receiver, methods) {
  const pk = publicKeyOfSeed(seed)
  const keys = await accessKeys(account, 'optimistic').catch(() => [])
  const k = keys.find((x) => x.public_key === pk)
  if (!k) return `no such key on ${account}`
  const p = k.access_key.permission
  if (p === 'FullAccess') return `a full-access key on ${account}: refused (the house runs on function-call keys only)`
  if (p.FunctionCall.receiver_id !== receiver) return `the key on ${account} is for ${p.FunctionCall.receiver_id}, not ${receiver}`
  if ([...p.FunctionCall.method_names].sort().join() !== [...methods].sort().join()) return `the key on ${account} may call ${p.FunctionCall.method_names.join(', ')}`
  return null
}

async function loadHouse(keys) {
  const members = []
  for (const m of H.members) {
    const account = accountOf(m.name)
    const seed = keys.members?.[account]
    const problem = seed ? await checkKey(account, seed, d.contract, MEMBER_METHODS) : 'no key'
    if (problem) console.log(`house member ${m.name}: ${problem}; it sits out`)
    members.push({ ...m, account, signer: problem ? null : seedSigner(account, seed) })
  }
  const council = []
  for (const c of H.council) {
    const account = accountOf(c.name)
    const seed = keys.council?.[account]
    const problem = seed ? await checkKey(account, seed, d.dao, COUNCIL_METHODS) : 'no key'
    if (problem) console.log(`house council ${c.name}: ${problem}; it does not vote`)
    council.push({ ...c, account, signer: problem ? null : seedSigner(account, seed) })
  }
  const keepers = []
  for (const k of keys.keeper ?? []) {
    const problem = await checkKey(k.account, k.seed, d.contract, RELAY_METHODS)
    if (problem) console.log(`keeper key: ${problem}`)
    else keepers.push(seedSigner(k.account, k.seed))
  }
  return { members, council, keepers }
}

// ---- reports ----------------------------------------------------------------------------------------

async function report(house, cfg, { full = true } = {}) {
  const lines = []
  const low = []
  const [daoT, dao, con, gas] = await Promise.all([
    view(d.token, 'ft_balance_of', { account_id: d.dao }),
    freeBalance(d.dao), freeBalance(d.contract), freeBalance(d.gas.account),
  ])
  const roundsLeft = BigInt(daoT) / BigInt(cfg.round_budget)
  lines.push(`DAO ${d.dao}: ${tusd(daoT)} tUSD (${roundsLeft} rounds of budget), ${nearStr(dao.free, 3)} NEAR free for proposal storage (about ${dao.free / (35n * 10n ** 20n)} payouts)`)
  if (roundsLeft < 72n) low.push(`the DAO holds ${tusd(daoT)} tUSD, ${roundsLeft} rounds of budget`)
  if (dao.free < 5n * 10n ** 23n) low.push(`the DAO has ${nearStr(dao.free, 3)} NEAR free for proposal storage; send it NEAR`)
  lines.push(`contract ${d.contract}: ${nearStr(con.free, 3)} NEAR free (bond float, registrations), ${con.storage} bytes`)
  if (con.free < 3n * 10n ** 23n) low.push(`the contract has ${nearStr(con.free, 3)} NEAR free for bonds and registrations`)
  lines.push(`gas account ${d.gas.account}: ${nearStr(gas.amount, 3)} NEAR`)
  if (gas.amount < 10n ** 24n) low.push(`the gas account holds ${nearStr(gas.amount, 3)} NEAR`)
  const allow = async (signer) => {
    const k = await rpc('query', { request_type: 'view_access_key', finality: 'optimistic', account_id: signer.accountId, public_key: nearPublicKey(signer.key) }).catch(() => null)
    return k?.permission?.FunctionCall?.allowance ? BigInt(k.permission.FunctionCall.allowance) : null
  }
  for (const s of full ? house?.keepers ?? [] : []) {
    const a = await allow(s)
    if (a !== null && a < 5n * 10n ** 23n) low.push(`a keeper key on ${s.accountId} has ${nearStr(a, 3)} NEAR of allowance left`)
  }
  const rows = []
  for (const p of full ? [...(house?.members ?? []), ...(house?.council ?? [])] : []) {
    const b = await freeBalance(p.account).catch(() => null)
    const a = p.signer ? await allow(p.signer) : null
    rows.push(`${p.name} ${b ? nearStr(b.free, 3) : '?'}${a !== null ? '/' + nearStr(a, 3) : ''}`)
    if (b && b.free < 5n * 10n ** 22n) low.push(`${p.account} has ${nearStr(b.free, 3)} NEAR free`)
    if (a !== null && a < 5n * 10n ** 22n) low.push(`the house key of ${p.account} has ${nearStr(a, 3)} NEAR of allowance left`)
  }
  if (rows.length) lines.push(`house (NEAR free / key allowance): ${rows.join(', ')}`)
  for (const l of lines) console.log(`[${stamp()}] ${l}`)
  for (const l of low) warn(l)
  return low
}

// ---- the members' round -------------------------------------------------------------------------------

function singular(tpl, n) {
  if (n !== 1) return tpl.replace('{n}', String(n))
  for (const [plural, one] of Object.entries(H.note_singular)) if (tpl.includes(plural)) return tpl.replace(plural, one)
  return tpl.replace('{n}', '1')
}

/** What each house member does in round r: works?, its note, and when it acts (fractions of the round). */
function planRound(seed, r, quiet) {
  const plan = {}
  for (const m of H.members) {
    const rng = stream(seed, 'house', r, m.name)
    const works = rng() < B.p_work
    const z = rng.lognormal(B.items_sigma)
    const tNote = 0.05 + 0.25 * rng()
    const tAlloc = 0.5 + 0.3 * rng()
    let items, note, gives
    if (m.kind === 'free_rider') {
      const claim = rng() < B.free_rider_claim
      const vague = rng.pick(m.notes)
      items = claim ? 1 : 0
      note = claim ? `${vague} (1 item)` : vague
      gives = false
    } else if (!works || (quiet && m.kind === 'honest')) {
      items = 0
      note = null
      gives = false
    } else {
      items = Math.max(0, Math.round(m.parameters.items_mean * z))
      note = items > 0 ? singular(rng.pick(m.notes), items) : 'came by, nothing fixed this time'
      gives = true
    }
    plan[m.name] = { works: note !== null, items, note, gives, tNote, tAlloc }
  }
  return plan
}

/** A member's allocation from the round as the chain shows it (notes, seats, guests' gifts). */
function allocationFor(m, r, seed, rv, cfg, house) {
  const rng = stream(seed, 'give', r, m.name)
  const notes = new Map((rv?.notes ?? []).map(([a, t]) => [a, t]))
  const seats = new Set(rv?.seats ?? [])
  const gaveThanks = new Set((rv?.gifts ?? []).map((g) => g[0]))
  const pool = [...seats].filter((g) => notes.get(g) && gaveThanks.has(g)).sort()
  const cap = cfg.cap_per_receiver
  const gifts = []
  if (pool.length) for (const g of rng.sample(pool, Math.min(B.welcome_max, pool.length))) gifts.push([g, B.welcome_each])
  let left = cfg.thanks_per_round - gifts.reduce((s, g) => s + g[1], 0)
  const exclude = new Set([m.account])
  if (m.kind === 'pair') {
    const partner = accountOf(m.parameters.partner)
    gifts.push([partner, cap])
    left -= cap
    exclude.add(partner)
  }
  const prefs = house.members
    .filter((o) => !exclude.has(o.account))
    .map((o) => [itemsOf(notes.get(o.account)) * rng.lognormal(B.noise_sigma), o.account])
  gifts.push(...split(left, prefs, cap, cfg.max_receivers - gifts.length, B.focus))
  return gifts.sort((a, b) => (a[0] < b[0] ? -1 : 1))
}

// ---- the house council's rule -------------------------------------------------------------------------

/** sim/hat_tip_sim.py `council_decision`, on the round as the contract recorded it. */
export function councilDecision(tier, receiver, rv) {
  const givers = new Map()
  const gaveTo = new Set()
  let points = 0n
  for (const [g, r, given, counted] of rv.gifts) {
    if (r === receiver) {
      givers.set(g, BigInt(counted))
      points += BigInt(counted)
    }
    if (g === receiver && given > 0) gaveTo.add(r)
  }
  if (tier === 2) {
    if (givers.size) {
      let top = null
      for (const g of [...givers.keys()].sort()) if (top === null || givers.get(g) > givers.get(top)) top = g
      if (givers.get(top) * 2n > points && gaveTo.has(top)) return { approve: false, why: `${short(top)} gave more than half of the points and was thanked back` }
    }
    return { approve: true, why: 'no reciprocal partner behind most of the points' }
  }
  const n = [...givers.values()].filter((v) => v > 0n).length
  return n >= 3 ? { approve: true, why: `${n} givers stand behind it` } : { approve: false, why: `only ${n} giver${n === 1 ? '' : 's'} behind it` }
}

// ---- run ------------------------------------------------------------------------------------------

async function run() {
  const keys = loadKeys()
  if (!keys) {
    console.log('no house keys, nothing to do')
    return
  }
  const house = await loadHouse(keys)
  const cfg = await view(d.contract, 'config')
  const L = Number(cfg.round_ms)
  const G = Number(cfg.genesis_ms)
  const startOf = (r) => G + (r - 1) * L
  const seed = opt('seed', String(Date.now()))
  const quietK = kset(opt('quiet'))
  const guestK = kset(opt('guest'))
  const removeK = kset(opt('remove'))
  const removedRounds = new Set()
  const dry = flag('dry-run')
  const rec = new Recorder({ log: opt('log', null) })
  const t0 = Date.now()
  const minutes = opt('minutes') ? Math.min(Number(opt('minutes')), 355) : null
  const roundsWanted = opt('rounds') ? Number(opt('rounds')) : null
  if (!dry && !(minutes > 0) && !(roundsWanted > 0)) {
    console.error('give --rounds N or --minutes M')
    process.exit(64)
  }
  const hardEnd = minutes ? t0 + minutes * 60_000 : Infinity
  const clockRound = () => Math.floor((Date.now() - G) / L) + 1
  // The first round played: the current one if at least 70 % of it is left, else the next.
  let first = clockRound()
  if (first < 1) first = 1
  else if (startOf(first + 1) - Date.now() < 0.7 * L) first += 1
  if (opt('first')) first = Math.max(Number(opt('first')), clockRound()) // a restart that resumes a run
  const lastPlayed = roundsWanted
    ? first + roundsWanted - 1
    : Math.floor((hardEnd - 8 * 60_000 - G) / L) // rounds that end 8 minutes before the end
  console.log(`[${stamp()}] house on ${d.contract} (${section}); rounds of ${L / 60_000} min; playing rounds ${first}..${lastPlayed}; seed ${seed}; ${house.members.filter((m) => m.signer).length} members, ${house.council.filter((c) => c.signer).length} council, ${house.keepers.length} keeper keys`)
  await report(house, cfg)

  if (dry) {
    const r = clockRound()
    const plan = planRound(seed, r, false)
    const rv = await tryView(d.contract, 'round', { n: r })
    for (const m of house.members) {
      const p = plan[m.name]
      console.log(`r${r} ${m.name} (${m.kind}${m.label ? ', ' + m.label : ''}): ${p.note ?? 'skips'}${p.gives ? '; thanks ' + JSON.stringify(allocationFor(m, r, seed, rv, cfg, house)) : ''}`)
    }
    return
  }

  const done = new Map() // `${r}:${name}:note|alloc` -> true
  const decided = new Map() // payout id -> decision
  const voted = new Map() // payout id -> Set(account) the house voted with
  const plans = new Map()
  let keeperIx = 0
  const keeper = () => house.keepers[keeperIx++ % house.keepers.length]
  let lastReportRound = first
  const seenFiled = new Map() // payout id -> when the house first saw it with a DAO proposal
  let openFrom = 0
  let drainSince = null
  const problems = []

  const keeperCall = async (method, args, gas, label, round = null) => {
    if (!house.keepers.length) return null
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await rec.call(keeper(), d.contract, method, args, { gas, label, round })
        if (!r.ok) problems.push(r)
        return r
      } catch (e) {
        if (attempt === 1) {
          problems.push({ label, error: e.message })
          return null
        }
      }
    }
  }

  const tickKeeper = async () => {
    let st = await view(d.contract, 'state')
    if (st.paused) {
      console.log(`[${stamp()}] the contract is paused: ${st.pause_reason}; calling sync`)
      await keeperCall('sync', {}, GAS.sync, 'sync (paused)')
      st = await view(d.contract, 'state')
    }
    for (let i = 0; i < 8 && st.due > 0; i++) {
      const r = await keeperCall('close_round', {}, GAS.close, `close_round (${st.due} due)`, st.oldest_unclosed)
      const v = r?.value
      st = await view(d.contract, 'state')
      if (!r || v?.error) break
    }
    for (let i = 0; i < 5 && st.planned > 0 && !st.paused; i++) {
      const before = st.planned
      const r = await keeperCall('pay', { max: 10 }, GAS.pay, `pay (${st.planned} planned)`)
      st = await view(d.contract, 'state')
      if (!r || st.planned >= before) break
    }
    return st
  }

  const tickPayouts = async (st) => {
    const from = Math.max(openFrom, st.oldest_payout ?? 0)
    if (from >= st.next_payout) return 0
    const list = await view(d.contract, 'payouts', { from, limit: 100 })
    let open = 0
    let firstOpen = null
    // The proposals worth reading this tick: tier 1 at once; tiers 2 and 3 from two minutes after
    // the house first saw them filed (the council's delay), all in one get_proposals call.
    const now = Date.now()
    const due = []
    for (const p of list) {
      const final = ['paid', 'rejected', 'expired', 'removed', 'failed'].includes(p.status)
      if (!final && firstOpen === null) firstOpen = p.id
      if (final || p.dao_proposal === null || p.dao_proposal === undefined) continue
      if (!seenFiled.has(p.id)) seenFiled.set(p.id, now)
      if (p.tier === 1 || p.status !== 'filed' || now - seenFiled.get(p.id) >= COUNCIL_DELAY_MS - 10_000) due.push(p.dao_proposal)
    }
    const props = new Map()
    if (due.length) {
      const lo = Math.min(...due)
      const hi = Math.max(...due)
      for (let at = lo; at <= hi; at += 100) {
        for (const q of await view(d.dao, 'get_proposals', { from_index: at, limit: Math.min(100, hi - at + 1) })) props.set(q.id, q)
      }
    }
    for (const p of list) {
      const final = ['paid', 'rejected', 'expired', 'removed', 'failed'].includes(p.status)
      if (final) continue
      open++
      if (p.dao_proposal === null || p.dao_proposal === undefined || !due.includes(p.dao_proposal)) continue
      const prop = props.get(p.dao_proposal) ?? null // removed proposals are deleted by the DAO
      const expired = prop && prop.status === 'InProgress' && BigInt(prop.submission_time) + BigInt(st.proposal_period_ns) < BigInt(Date.now()) * 1_000_000n
      if (!prop || prop.status !== 'InProgress' || expired) {
        await keeperCall('check_payout', { payout: p.id }, GAS.check, `check_payout ${p.id} (DAO #${p.dao_proposal}: ${prop?.status ?? 'gone'})`, p.round)
        continue
      }
      if (p.tier === 1 || p.status !== 'filed') continue
      const age = Date.now() - Number(BigInt(prop.submission_time) / 1_000_000n)
      if (age < COUNCIL_DELAY_MS) continue
      let dec = decided.get(p.id)
      if (!dec) {
        const rv = await view(d.contract, 'round', { n: p.round })
        if (!rv) continue
        dec = councilDecision(p.tier, p.receiver, rv)
        // staging test: on a --remove round the first tier-2 payout is removed instead (one vote)
        if (p.tier === 2 && removeK.has(p.round - first + 1) && !removedRounds.has(p.round)) {
          removedRounds.add(p.round)
          dec = { approve: false, remove: true, why: 'staging test (--remove): VoteRemove instead of the rule' }
        }
        decided.set(p.id, dec)
        console.log(`[${stamp()}] council on payout ${p.id} (r${p.round}, tier ${p.tier}, ${tusd(p.amount)} tUSD to ${short(p.receiver)}, DAO #${p.dao_proposal}): ${dec.remove ? 'remove' : dec.approve ? 'approve' : 'reject'}, ${dec.why}`)
      }
      const action = dec.remove ? 'VoteRemove' : dec.approve ? 'VoteApprove' : 'VoteReject'
      const mine = voted.get(p.id) ?? new Set()
      voted.set(p.id, mine)
      const need = p.tier === 2 ? 1 : 2
      const same = Object.entries(prop.votes ?? {}).filter(([a, v]) => mine.has(a) || (house.council.some((c) => c.account === a) && v === (dec.remove ? 'Remove' : dec.approve ? 'Approve' : 'Reject'))).length
      const voters = house.council.filter((c) => c.signer && !(c.account in (prop.votes ?? {})))
      const startAt = p.id % Math.max(1, voters.length)
      const order = [...voters.slice(startAt), ...voters.slice(0, startAt)]
      let cast = same
      for (const c of order) {
        if (cast >= need) break
        const r = await rec.call(c.signer, d.dao, 'act_proposal', { id: p.dao_proposal, action, proposal: prop.kind },
          { gas: GAS.vote, label: `${c.name} ${action} DAO #${p.dao_proposal} (payout ${p.id}, tier ${p.tier})`, round: p.round })
        if (!r.ok) {
          problems.push(r)
          break
        }
        mine.add(c.account)
        cast++
        const now = await view(d.dao, 'get_proposal', { id: p.dao_proposal }).catch(() => null)
        if (!now || now.status !== 'InProgress') {
          await keeperCall('check_payout', { payout: p.id }, GAS.check, `check_payout ${p.id} (DAO #${p.dao_proposal}: ${now?.status ?? 'gone'})`, p.round)
          break
        }
      }
    }
    if (firstOpen !== null) openFrom = firstOpen
    else if (list.length) openFrom = list[list.length - 1].id + 1
    return open
  }

  const tickMembers = async (r, runIndex) => {
    if (r < first || r > lastPlayed) return
    if (!plans.has(r)) plans.set(r, planRound(seed, r, quietK.has(runIndex)))
    const plan = plans.get(r)
    const now = Date.now()
    const end = startOf(r + 1)
    // staging test: a guest from a browser-style key, relayed like the page does it
    if (guestK.has(runIndex) && !done.get(`${r}:guest`) && now >= startOf(r) + 0.35 * L && now < end - 30_000) {
      done.set(`${r}:guest`, true)
      await playGuest(r, cfg, rec, keeperCall, problems)
    }
    for (const m of house.members) {
      if (!m.signer) continue
      const p = plan[m.name]
      if (!p.works) continue
      const kn = `${r}:${m.name}:note`
      if (!done.get(kn) && Date.now() >= startOf(r) + p.tNote * L && Date.now() < end - 20_000) {
        done.set(kn, true)
        const res = await rec.call(m.signer, d.contract, 'note', { round: r, text: p.note }, { gas: GAS.note, label: `${m.name} note "${p.note}"`, round: r, receipts: false }).catch((e) => ({ ok: false, error: e.message }))
        if (!res.ok) problems.push(res)
      }
      const ka = `${r}:${m.name}:alloc`
      if (p.gives && !done.get(ka) && Date.now() >= startOf(r) + p.tAlloc * L) {
        done.set(ka, true)
        if (Date.now() > end - 20_000) {
          console.log(`[${stamp()}] r${r} ${m.name}: too close to the round's end, no thanks this round`)
          continue
        }
        const rv = await view(d.contract, 'round', { n: r })
        const gifts = allocationFor(m, r, seed, rv, cfg, house)
        const res = await rec.call(m.signer, d.contract, 'allocate', { round: r, gifts, note: null },
          { gas: GAS.allocate, label: `${m.name} allocate ${gifts.map(([a, t]) => `${short(a).split('.')[0]}:${t}`).join(' ')}`, round: r, receipts: false }).catch((e) => ({ ok: false, error: e.message }))
        if (!res.ok || res.value?.ok === false) {
          problems.push(res)
          if (res.value?.ok === false) console.log(`[${stamp()}] r${r} ${m.name}: allocation refused: ${res.value.error}`)
        }
      }
    }
  }

  while (Date.now() < hardEnd) {
    const r = clockRound()
    try {
      const st = await tickKeeper()
      const open = await tickPayouts(st)
      await tickMembers(r, r - first + 1)
      if (r > lastReportRound) {
        lastReportRound = r
        await report(house, cfg, { full: (r - first) % 12 === 0 }).catch((e) => console.log(`report failed: ${e.message}`))
      }
      if (r > lastPlayed) {
        // drain: the played rounds are over; stop once they are closed, filed and decided
        drainSince ??= Date.now()
        const settled = st.oldest_unclosed > lastPlayed && st.planned === 0 && open === 0
        if (settled || (roundsWanted && Date.now() - drainSince > 10 * 60_000)) break
      }
    } catch (e) {
      console.log(`[${stamp()}] tick failed: ${e.message.slice(0, 300)}; going on`)
    }
    // next wake-up: the next member action of this round, at most 10 s away
    const plan = plans.get(r)
    let next = Date.now() + 10_000
    if (plan) {
      for (const m of house.members) {
        const p = plan[m.name]
        for (const t of [p.tNote, p.tAlloc]) {
          const at = startOf(r) + t * L
          if (at > Date.now() && at < next) next = at + 50
        }
      }
    }
    if (startOf(r + 1) > Date.now() && startOf(r + 1) < next) next = startOf(r + 1) + 1_500
    await sleep(Math.max(500, Math.min(next, hardEnd) - Date.now()))
  }
  const failed = rec.records.filter((x) => !x.ok)
  const refused = rec.records.filter((x) => x.value && x.value.ok === false)
  console.log(`[${stamp()}] done: ${rec.records.length} transactions, ${failed.length} failed, ${refused.length} refused`)
  for (const f of failed) console.log(`  FAILED ${f.label}: ${f.error ?? f.failure ?? (f.receiptFailures ?? []).join('; ')} ${f.hash ?? ''}`)
  await report(house, cfg).catch(() => {})
  if (failed.length) process.exitCode = 1
}

/** A guest as the page makes one: a fresh ed25519 key, join with a note, then 100 thanks to members. */
async function playGuest(r, cfg, rec, keeperCall, problems) {
  const key = newKey()
  const pub = hex(key.publicKey)
  writeSecret(`stage-guest-${pub.slice(0, 8)}.json`, { account: pub, seed: hex(key.seed), round: r, contract: d.contract })
  let nonce = Date.now()
  const actSigned = async (action, label) => {
    nonce = Math.max(Date.now(), nonce + 1)
    const text = JSON.stringify(action)
    const msg = `hattip:v1:${d.contract}:${nonce}:${text}`
    const signature = hex(sign(key, Buffer.from(msg, 'utf8')))
    const res = await keeperCall('act', { pubkey: pub, nonce, action: text, signature }, GAS.act, `guest ${pub.slice(0, 8)} ${label}`, r)
    if (res?.value?.ok === false) {
      console.log(`[${stamp()}] guest action refused: ${res.value.error}`)
      problems.push(res)
    }
    return res
  }
  await actSigned({ join: { round: r, note: 'first visit: brought a wobbly chair' } }, 'join with a note')
  const rv = await view(d.contract, 'round', { n: r })
  const notes = new Map((rv?.notes ?? []).map(([a, t]) => [a, t]))
  const rng = stream('guest', pub, r)
  const k = 2 + Math.floor(rng() * 4)
  const prefs = H.members.map((m) => [(itemsOf(notes.get(accountOf(m.name))) + 0.5) * rng.lognormal(B.noise_sigma), accountOf(m.name)])
  const gifts = split(cfg.thanks_per_round, prefs, cfg.cap_per_receiver, k, 0)
  await actSigned({ allocate: { round: r, gifts } }, `allocate ${gifts.map(([a, t]) => `${a.split('.')[0]}:${t}`).join(' ')}`)
  console.log(`[${stamp()}] r${r} guest ${pub} joined and gave thanks`)
}

// ---- export-secret, report, summary ---------------------------------------------------------------------

async function exportSecret() {
  const keys = loadKeys()
  if (!keys) throw new Error(`no ${houseKeysFile(d.contract)}`)
  const house = await loadHouse(keys)
  const ok = house.members.filter((m) => m.signer).length === H.members.length && house.council.filter((c) => c.signer).length === H.council.length && house.keepers.length > 0
  if (!ok) throw new Error('not every house key checks out on chain; not writing the secret')
  const value = JSON.stringify({ v: 1, section, contract: d.contract, members: keys.members, council: keys.council, keeper: keys.keeper })
  const file = writeSecret('github-secret-HOUSE_KEYS.txt', value + '\n')
  console.log(`wrote ${file.replace(/.*\/\.secrets\//, '.secrets/')} (mode 600): ${Object.keys(keys.members).length} members, ${Object.keys(keys.council).length} council, ${keys.keeper.length} keeper keys, ${value.length} bytes; all function-call keys, checked on chain`)
}

async function summary() {
  const st = await view(d.contract, 'state')
  const cfg = await view(d.contract, 'config')
  const from = Number(opt('from', '1'))
  const rows = []
  for (let r = from; r < st.oldest_unclosed; r++) {
    const rv = await view(d.contract, 'round', { n: r })
    if (!rv || !rv.gifts.length) continue
    const ps = []
    for (const id of rv.payouts) ps.push(...(await view(d.contract, 'payouts', { from: id, limit: 1 })))
    rows.push({ round: r, budget: tusd(rv.budget), dust: rv.dust, givers: new Set(rv.gifts.map((g) => g[0])).size, gifts: rv.gifts.length, notes: rv.notes.length, seats: rv.seats.length,
      payouts: ps.map((p) => ({ id: p.id, to: p.receiver.split('.')[0].slice(0, 12), tusd: tusd(p.amount), tier: p.tier, status: p.status, dao: p.dao_proposal })) })
  }
  const audit = await view(d.contract, 'audit')
  const all = []
  for (let at = st.oldest_payout; at < st.next_payout; at += 100) all.push(...(await view(d.contract, 'payouts', { from: at, limit: 100 })))
  const byTier = {}
  for (const p of all) {
    byTier[p.tier] ??= {}
    byTier[p.tier][p.status] = (byTier[p.tier][p.status] ?? 0) + 1
  }
  // Events: counted by kind, and replayed to rebuild every reputation (round_closed decays every
  // record once, points adds, struck subtracts), then compared with member(). Needs the logs of
  // every transaction since genesis that logged events, in any number of files (--log a,b,...).
  let events = null
  let replay = null
  const logs = String(opt('log', '')).split(',').filter((f) => f && existsSync(f))
  if (logs.length) {
    events = {}
    const recs = logs.flatMap((f) => readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)))
    recs.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
    const rep = new Map()
    const D = BigInt(cfg.decay_bp)
    const isGuest = (a) => /^[0-9a-f]{64}$/.test(a)
    let lastRound = 0
    let gaps = 0
    for (const x of recs) {
      for (const e of x.eventsFull ?? []) {
        events[e.event] = (events[e.event] ?? 0) + e.data.length
        for (const ev of e.data) {
          if (e.event === 'round_closed') {
            if (ev.round !== lastRound + 1) gaps++
            lastRound = ev.round
            for (const [a, r] of rep) {
              let v = (r * (10000n - D)) / 10000n
              if (isGuest(a) && v < 1000n) v = 0n
              rep.set(a, v)
            }
          } else if (e.event === 'points') {
            for (const [ri, pts] of ev.points) {
              const a = ev.accounts[ri]
              let v = (rep.get(a) ?? 0n) + BigInt(pts)
              if (isGuest(a) && v < 1000n) v = 0n
              rep.set(a, v)
            }
          } else if (e.event === 'struck') {
            const r = rep.get(ev.account) ?? 0n
            const strike = BigInt(ev.strike)
            rep.set(ev.account, r - (strike < r ? strike : r))
            if (String(rep.get(ev.account)) !== String(ev.reputation)) gaps++
          }
        }
      }
    }
    const differ = []
    for (const [a, r] of rep) {
      const v = await view(d.contract, 'member', { account_id: a })
      if (BigInt(v.reputation) !== r) differ.push(`${short(a)}: events ${r}, member() ${v.reputation}`)
    }
    replay = { accounts: rep.size, last_round_replayed: lastRound, gaps_or_mismatched_strikes: gaps, differ }
  }
  const members = {}
  for (const m of H.members) {
    const v = await view(d.contract, 'member', { account_id: accountOf(m.name) })
    members[m.name] = { reputation: (Number(v.reputation) / 1000).toFixed(1), auto: tusd(v.limits.auto), cosign: tusd(v.limits.cosign), strikes: v.strikes, carry: tusd(v.carry) }
  }
  const out = { state: { round: st.round, oldest_unclosed: st.oldest_unclosed, paused: st.paused, planned: st.planned, open_payouts: st.open_payouts, totals: st.totals }, round_ms: cfg.round_ms, rounds: rows, by_tier: byTier, audit, members, events, replay }
  console.log(JSON.stringify(out, null, 1))
}

const cmds = { run, report: async () => { const k = loadKeys(); await report(k ? await loadHouse(k) : null, await view(d.contract, 'config')) }, 'export-secret': exportSecret, summary }
if (!cmds[cmd]) {
  console.error('usage: house.mjs run|report|export-secret|summary [--section staging] ...')
  process.exit(64)
}
cmds[cmd]().catch((e) => {
  console.error(e.stack || e.message)
  process.exit(1)
})
