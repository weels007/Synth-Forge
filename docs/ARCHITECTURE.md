# Architecture

Why `SynthForgeVault` is shaped the way it is: state, the nondeterministic boundary, the
policy pipeline, the money math, and the invariants the test suite is written against.

## 1. State inventory

| Field | Type | Purpose |
| --- | --- | --- |
| `owner` | `Address` | the only key that can register, pause, or hand over |
| `paused` | `bool` | circuit breaker checked at the top of every write |
| `asset_symbols` | `DynArray[str]` | insertion order = display order |
| `assets` | `TreeMap[str, SyntheticAsset]` | symbol → instrument |
| `portfolio_ids` | `DynArray[str]` | `PF-0001`, `PF-0002`, … |
| `portfolios` | `TreeMap[str, Portfolio]` | id → vault |
| `strategy_ids` | `DynArray[str]` | `ST-0001`, … |
| `strategy_index` | `TreeMap[str, str]` | `"<portfolio>|<n>"` → strategy id |
| `strategy_counter` | `TreeMap[str, u256]` | `<portfolio>` → count, for reverse iteration |
| `strategies` | `TreeMap[str, Strategy]` | id → proposal and its lifecycle, including the `ruled` flag that makes a ruling final |
| `positions` | `TreeMap[str, u256>` | `"<portfolio>|<symbol>"` → units held |
| `book_weights` | `TreeMap[str, str]` | `"<portfolio>"` → JSON weight map (as held) |
| `held_symbols` | `TreeMap[str, str]` | `"<portfolio>"` → JSON array, so iteration is bounded |
| `share_ledger` | `TreeMap[str, u256>` | `"<portfolio>|<holder>"` → shares |
| `cash` | `TreeMap[str, u256>` | `"<portfolio>"` → uninvested atto balance |
| `proof_ids` | `DynArray[str]` | `PR-0001`, … |
| `proof_index` | `TreeMap[str, str]` | `"<portfolio>|<n>"` → proof id |
| `proof_counter` | `TreeMap[str, u256]` | `<portfolio>` → count |
| `proofs` | `TreeMap[str, ExecutionProof]` | the audit trail, including the evidence payload |

Two deliberate choices here.

**Iteration is never over a `TreeMap`.** GenVM storage maps are not ordered containers, so
every listing (`list_assets`, `list_proofs`, `list_strategies`) iterates an ordered
`DynArray` or a counter, and every composite lookup uses a `"<parent>|<child>"` string key.
That key shape is why `held_symbols` exists: the execution path has to know which symbols to
reprice without scanning the whole universe.

**The held book is stored twice, on purpose.** `book_weights` is the target allocation the
strategy wanted, `positions` is the units actually bought. `get_positions` reports both
`weight_bps` (from `book_weights`) and `units_atto` (from `positions`) so a rebalance can be
diffed against what it intended to do.

## 2. The nondeterministic boundary

Only three methods touch the network or a model:

```
generate_strategy   gl.nondet.exec_prompt(...)          + validator re-run
execute_strategy    gl.nondet.web.get(...) per feed     + validator re-fetch
mark_to_market      gl.nondet.web.get(...) per feed     + validator re-fetch
challenge_strategy  gl.nondet.exec_prompt(...)          + validator re-run
```

Everything inside a closure is pure: it takes a prompt or a URL spec list, returns a plain
`dict`, and never touches `self`. Storage writes, `self._record_proof`, and `.emit()` calls
all happen *after* `run_nondet_unsafe` returns. This is not stylistic — a closure that
captures `self` cannot be re-executed by a validator, because the validator does not share
the leader's storage snapshot.

```python
def leader_fn():
    raw = gl.nondet.exec_prompt(prompt, response_format="json")
    return _normalize_proposal(raw, universe, profile)

def validator_fn(leaders_res) -> bool:
    if not isinstance(leaders_res, gl.vm.Return):
        return _handle_leader_error(leaders_res, leader_fn)
    return _compare_proposals(leaders_res.calldata, leader_fn())

proposal = gl.vm.run_nondet_unsafe(leader_fn, validator_fn)
# ... only now does the contract write
```

Only the adjudication path adds work *outside* the closure: `_policy_breaches` computes the
objective breaches from the allocation before the model is asked anything, and the resulting
codes are handed to the leader and forced into whatever ruling comes back. That is the one
place where a deterministic computation is allowed to overrule a nondeterministic one.

`_handle_leader_error` is what makes failures consensus-safe. A leader that raised
`[EXPECTED] insufficient cash` and a validator that raises the same message agree the
transaction should fail; a leader that hit a `[TRANSIENT]` timeout and a validator that also
hits one agree to retry; everything else is a disagreement and the round rotates.

## 3. The policy pipeline

The model output is never stored as-is. It passes four deterministic stages, each of which can
shrink it:

```
raw JSON
   │  _normalize_proposal   drop unknown symbols, coerce bps, enforce the instrument set
   ▼
proposal {regime, weights, rationale, confidence_bps}
   │  _normalize_weights    scale to exactly 10 000 bps, largest-remainder rounding
   ▼
weights summing to BPS
   │  _apply_caps           per-instrument cap → HIGH-bucket ceiling → deficit redistribution
   ▼
book the mandate allows
```

`_apply_caps` is the interesting one. It clamps each leg to `min(asset cap, profile single
cap)`, then proportionally shrinks the HIGH-risk sleeve back under `max_high_bps`, then
distributes whatever weight was freed across the legs that still have room — recomputing the
room of a HIGH leg against the *remaining* bucket budget on every pass, so redistribution can
never push the sleeve back over its ceiling. If the caps are arithmetically unsatisfiable
(a universe of only HIGH instruments under a `CONSERVATIVE` mandate) it raises
`[EXPECTED] allocation cannot satisfy the risk caps` instead of storing a book that lies.

Two properties matter for consensus: the pipeline is a pure function of the proposal and the
pinned universe, and it runs on every node. A malicious leader can therefore only choose
*among* legal books, never outside them.

## 4. Money

All amounts are `u256` atto units (`10**18` per GEN) and all weights are basis points
(`10 000` = 100 %).

| Operation | Formula |
| --- | --- |
| open | `shares = capital` (NAV starts at 1.0 per share) |
| fund | `minted = amount * total_shares // nav_before` |
| redeem | `payout = shares * nav // total_shares`, then `nav -= payout` |
| buy | `units = weight_bps * nav // BPS` then `// price_atto`, remainder stays in cash |
| NAV | `cash + sum(units * price)` — recomputed, never incremented |

NAV is always recomputed from components rather than adjusted incrementally, so a rounding
dust can never accumulate into a phantom balance. The direct tests assert to within
`1_000_000` atto (1e-12 GEN) for that reason.

## 5. Execution path

`execute_strategy` is the method that turns a proposal into a book:

1. reject if paused, unknown portfolio/strategy, strategy not `PROPOSED`/`ACTIVE`
2. pin the universe (enabled instruments only) and the target weights
3. **consensus**: fetch every feed inside `run_nondet_unsafe`, compare maps at 150 bps
4. compute the new book and its total turnover; reject above `MAX_L1_DELTA_BPS` (1200 bps)
5. book it: `units = weight * nav // BPS // price`, subtract cash, store `positions`,

   `book_weights`, `held_symbols`, bump `rebalances`, set strategy `ACTIVE`, portfolio `LIVE`
6. `_record_proof("REBALANCE", …)` with both digests, NAV before/after and realised turnover

`mark_to_market` is the same consensus step without the trade: it reprices the held symbols,
recomputes NAV, stamps `last_mark_at`, and records a `MARK` proof. Neither method lets the
caller pass prices in — the contract always fetches them itself.

## 6. Adjudication: making a ruling survive consensus

A challenge used to be the weakest link, and the live test is what exposed it. The receipt said
`SUCCESS`, but no `CHALLENGE` proof existed and the strategy was still unruled. The round log
showed why: validator votes `[4, 3, 3, 4, 4]`, i.e. three leaders rejected. Each run had ruled
`REVOKE` for the same real reason, but each phrased it differently, and the equality test
compared the free text. Independent runs never agree on prose, so the state delta was
discarded every time.

Three changes fix it.

**1. Grounds come from a closed vocabulary.** `VIOLATION_CODES` lists seven codes
(`CAP_BREACH`, `SUM_MISMATCH`, `MANDATE_DRIFT`, `CONCENTRATION_RISK`, `MISSING_HEDGE`,
`THESIS_CONTRADICTION`, `UNSUPPORTED_INSTRUMENT`). `_normalize_verdict` uppercases, converts
spaces and dashes to underscores, keeps only members of the vocabulary, dedupes, sorts and
truncates to `MAX_VIOLATIONS`. `_compare_verdicts` then compares the pair
`(verdict, canonical code list)`. The explanation is still stored and still shown to humans,
but it is not part of the equivalence test — words are not facts.

**2. Objective breaches are computed, not argued.** `_policy_breaches(allocation, profile,
universe)` runs in Python before the prompt is built. It returns `UNSUPPORTED_INSTRUMENT` for a
leg outside the enabled universe, `CAP_BREACH` for a leg over `min(asset cap, profile cap)` or a
HIGH sleeve over `max_high_bps`, and `SUM_MISMATCH` when the legs do not sum to 10 000 bps.
When that set is non-empty the ruling is forced to `REVOKE` with exactly those codes, whatever
the model answered, and the prompt says so explicitly. A model cannot talk the committee out of
a cap that the committee can compute.

**3. One ruling per strategy.** `challenge_strategy` rejects a strategy whose `ruled` flag is
set, so a settled book cannot be re-litigated until someone explicitly reopens the portfolio.
Without that guard, a challenge that reached different verdicts on different days would leave
the audit trail describing two different histories.

`_normalize_verdict` still refuses a `REVOKE` that cites no grounds (`[LLM_ERROR] revoke ruling
cites no violation`), because a silent revoke is not a decision that can be audited. The
dashboard mirrors this vocabulary in `/how-it-works`, so the codes a ruling can cite are part
of the product surface rather than an implementation detail.

## 7. Proof chain

| `kind` | Written by | Verdict |
| --- | --- | --- |
| `PORTFOLIO_OPEN` | `open_portfolio` | `ACCEPTED` |
| `DEPOSIT` | `fund_portfolio` | `ACCEPTED` |
| `REDEMPTION` | `redeem_shares` | `ACCEPTED` |
| `STRATEGY_APPROVAL` | `generate_strategy` | `ACCEPTED` |
| `REBALANCE` | `execute_strategy` | `ACCEPTED` |
| `MARK` | `mark_to_market` | `ACCEPTED` |
| `CHALLENGE` | `challenge_strategy` | `UPHOLD` / `REVOKE` |
| `REOPEN` | `reopen_portfolio` | `ACCEPTED` |

Each row stores `allocation_digest` (sha256 of the booked weight map), `input_digest` (sha256
of the prompt, or of the feed specs plus attested prices), `nav_before_atto`, `nav_after_atto`,
`weight_l1_bps`, the executor, and a human-readable `verdict_detail` that includes any clamp
the policy applied. Proof ids are `PR-0001`-style, per portfolio, via `_pad`.

`evidence` is the part that makes a proof re-runnable rather than merely descriptive. Price
proofs commit the symbol, URL, JSON path and attested price of every leg; rebalance proofs
commit the target weights and the realised turnover; challenge proofs commit the cited
grounds, the allocation that was judged and the prompt digest; reopen proofs commit the note
and the status they transitioned from. `_record_proof(..., evidence=...)` serialises it, and
`get_proof` returns it, so the dashboard never has to reconstruct inputs it cannot see.

The chain is append-only: nothing deletes a proof, and a challenge never rewrites the
original execution record — it adds a new row that names the same `strategy_id`.

## 8. Invariants the tests defend

| Invariant | Where it is tested |
| --- | --- |
| stored weights always sum to exactly 10 000 bps | `test_strategy_engine.py` |
| no leg exceeds `min(asset cap, profile cap)` | `test_strategy_engine.py` |
| HIGH sleeve never exceeds `max_high_bps` | `test_strategy_engine.py`, `test_execution_and_marks.py` |
| NAV is conserved across a rebalance (± dust) | `test_execution_and_marks.py` |
| nothing moves after `set_paused(True)` | `test_registry_and_portfolios.py` |
| only the owner can register / pause / transfer | `test_registry_and_portfolios.py` |
| a validator that disagrees beyond 500 bps per leg rejects the leader | `test_strategy_engine.py` |
| a `REVOKE` ruling clears `active_strategy_id` and sets `REVIEW` | `test_challenges_and_proofs.py` |
| a strategy is adjudicated at most once | `test_challenges_and_proofs.py` |
| every mutation appends exactly one proof | `test_challenges_and_proofs.py` |
| differently worded grounds still converge, unknown codes are dropped identically | `test_consensus_binding.py` |
| an objective cap breach forces `REVOKE` even when the model says `UPHOLD` | `test_consensus_binding.py` |

## 9. Failure modes

| Situation | Behaviour |
| --- | --- |
| feed returns 4xx/5xx | `[EXTERNAL]`; validators agree deterministically, tx fails cleanly |
| feed times out | `[TRANSIENT]`; a validator that also times out agrees, else rotate |
| model returns prose | `[LLM_ERROR] malformed JSON`; rotate |
| model returns an illegal symbol | dropped before caps; if nothing legal remains, `[EXPECTED]` |
| caps unsatisfiable for the universe | `[EXPECTED] cannot satisfy the risk caps` |
| two validators disagree | consensus disagreement, round rotates, state unchanged |
| leader lies about prices | validator refetch disagrees, leader rejected |
| model cites a made-up ground | dropped by the vocabulary filter on every node, ruling still converges |
| model wants to uphold a book that breaches a cap | `_policy_breaches` overrides, `REVOKE` is stored |
| strategy already adjudicated | `[EXPECTED] strategy already adjudicated`, no second ruling |

## 10. What is deliberately not real

The vault is a *portfolio accounting system*, not a settlement system. `open_portfolio` mints
shares against an internal atto balance; there is no GEN deposit, no bridge, and no
counterparty issuing the synthetic. That is the honest scope of this build: the hard, novel
part is the consensus design over model output and prices, and bolting a token ledger onto it
would add plumbing without adding a single verifiable claim.

A production fork would replace `cash` with a token transfer, `_fetch_price` with a signed
oracle plus per-instrument staleness bounds, and `share_ledger` with an ERC-20. None of those
touch the consensus closures.

## 11. Owner powers

The owner can register instruments, disable one, pause every write, and transfer ownership.
It cannot: mint shares, move a portfolio's positions, execute a strategy on someone else's
portfolio (execution is open to anyone — the contract enforces the mandate, not the caller),
or delete a proof. `transfer_ownership` is single-step and takes effect immediately; a
production build should add a two-step handover.

## 12. Frontend

The dashboard reads the same JSON views the tests assert on, through `genlayer-js` with no
signer, so it works with a plain browser and no wallet. Writes require an injected wallet, and
each write needs an explicit fee deposit: Studionet charges one, the SDK sends zero by default,
and the browser has no estimator — so `deploy/deployScript.ts` publishes the fee snapshot it
used to `frontend/public/fees.json` and the UI reuses it.

It is one document. `/` is the prospectus leaf: the instrument, the live certificate, and the
honest limits, because a synthetic-asset product is still a document. `/vault`, `/strategies`,
`/proofs`, `/universe`, `/dispute` and `/how-it-works` are the rooms you check it in, each owning
one question - and they are one deck rather than six pages. All six are mounted inside the console
frame; only the active leaf is in flow, the rest wait off to the side, and changing rooms
translates the deck sideways in 380 ms. The rail and the masthead are part of the frame, so they
never re-render away. Each room is still a real URL: the deck is driven by the pathname, so a
bookmarked room opens directly on its leaf, the back button walks the same leaves, and `←` / `→`
do it from the keyboard. They share the cover's substrate on purpose: one ambient field behind both
groups (three drifting chromatic fields over a panning grid, pure CSS, halted under
`prefers-reduced-motion`), the same smoked-glass surfaces, the same serif voice for headings and
mono for every number. Following the rail therefore reads as turning a leaf, not as arriving in a
different product. What changes between them is density, not identity: the cover breathes, the
desk is packed.

The address is resolved from `frontend/public/deployment.json`, written by the deploy script.
`NEXT_PUBLIC_SYNTHFORGE_ADDRESS` is only a fallback, so the console cannot keep reading an older
deployment than the one the repository documents.

`preview_prompt` is surfaced in the UI on purpose: the prompt is part of the product surface.
