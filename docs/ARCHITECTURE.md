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
| `strategies` | `TreeMap[str, Strategy]` | id → proposal and its lifecycle |
| `positions` | `TreeMap[str, u256>` | `"<portfolio>|<symbol>"` → units held |
| `book_weights` | `TreeMap[str, str]` | `"<portfolio>"` → JSON weight map (as held) |
| `held_symbols` | `TreeMap[str, str]` | `"<portfolio>"` → JSON array, so iteration is bounded |
| `share_ledger` | `TreeMap[str, u256>` | `"<portfolio>|<holder>"` → shares |
| `cash` | `TreeMap[str, u256>` | `"<portfolio>"` → uninvested atto balance |
| `proof_ids` | `DynArray[str]` | `PR-0001`, … |
| `proof_index` | `TreeMap[str, str]` | `"<portfolio>|<n>"` → proof id |
| `proof_counter` | `TreeMap[str, u256]` | `<portfolio>` → count |
| `proofs` | `TreeMap[str, ExecutionProof]` | the audit trail |

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
4. compute the new book and its total turnover; reject above `MAX_TURNOVER`
5. book it: `units = weight * nav // BPS // price`, subtract cash, store `positions`,

   `book_weights`, `held_symbols`, bump `rebalances`, set strategy `ACTIVE`, portfolio `ACTIVE`
6. `_record_proof("EXECUTION", …)` with both digests, NAV before/after and realised turnover

`mark_to_market` is the same consensus step without the trade: it reprices the held symbols,
recomputes NAV, stamps `last_mark_at`, and records a `MARK` proof. Neither method lets the
caller pass prices in — the contract always fetches them itself.

## 6. Proof chain

| `kind` | Written by | Verdict |
| --- | --- | --- |
| `PORTFOLIO_OPEN` | `open_portfolio` | `OPENED` |
| `DEPOSIT` | `fund_portfolio` | `FILLED` |
| `REDEEM` | `redeem_shares` | `FILLED` |
| `EXECUTION` | `execute_strategy` | `FILLED` |
| `MARK` | `mark_to_market` | `MARKED` |
| `CHALLENGE` | `challenge_strategy` | `UPHOLD` / `REVOKE` |

Each row stores `allocation_digest` (sha256 of the booked weight map), `input_digest` (sha256
of the prompt, or of the feed specs plus attested prices), `nav_before_atto`, `nav_after_atto`,
`weight_l1_bps`, the executor, and a human-readable `verdict_detail` that includes any clamp
the policy applied. Proof ids are `PR-0001`-style, per portfolio, via `_pad`.

The chain is append-only: nothing deletes a proof, and a challenge never rewrites the
original execution record — it adds a new row that names the same `strategy_id`.

## 7. Invariants the tests defend

| Invariant | Where it is tested |
| --- | --- |
| stored weights always sum to exactly 10 000 bps | `test_strategy_engine.py` |
| no leg exceeds `min(asset cap, profile cap)` | `test_strategy_engine.py` |
| HIGH sleeve never exceeds `max_high_bps` | `test_strategy_engine.py`, `test_execution_and_marks.py` |
| NAV is conserved across a rebalance (± dust) | `test_execution_and_marks.py` |
| nothing moves after `set_paused(True)` | `test_registry_and_portfolios.py` |
| only the owner can register / pause / transfer | `test_registry_and_portfolios.py` |
| a validator that disagrees beyond 1500 bps rejects the leader | `test_strategy_engine.py` |
| a `REVOKE` ruling clears `active_strategy_id` and sets `REVIEW` | `test_challenges_and_proofs.py` |
| every mutation appends exactly one proof | `test_challenges_and_proofs.py` |

## 8. Failure modes

| Situation | Behaviour |
| --- | --- |
| feed returns 4xx/5xx | `[EXTERNAL]`; validators agree deterministically, tx fails cleanly |
| feed times out | `[TRANSIENT]`; a validator that also times out agrees, else rotate |
| model returns prose | `[LLM_ERROR] malformed JSON`; rotate |
| model returns an illegal symbol | dropped before caps; if nothing legal remains, `[EXPECTED]` |
| caps unsatisfiable for the universe | `[EXPECTED] cannot satisfy the risk caps` |
| two validators disagree | consensus disagreement, round rotates, state unchanged |
| leader lies about prices | validator refetch disagrees, leader rejected |

## 9. What is deliberately not real

The vault is a *portfolio accounting system*, not a settlement system. `open_portfolio` mints
shares against an internal atto balance; there is no GEN deposit, no bridge, and no
counterparty issuing the synthetic. That is the honest scope of this build: the hard, novel
part is the consensus design over model output and prices, and bolting a token ledger onto it
would add plumbing without adding a single verifiable claim.

A production fork would replace `cash` with a token transfer, `_fetch_price` with a signed
oracle plus per-instrument staleness bounds, and `share_ledger` with an ERC-20. None of those
touch the consensus closures.

## 10. Owner powers

The owner can register instruments, disable one, pause every write, and transfer ownership.
It cannot: mint shares, move a portfolio's positions, execute a strategy on someone else's
portfolio (execution is open to anyone — the contract enforces the mandate, not the caller),
or delete a proof. `transfer_ownership` is single-step and takes effect immediately; a
production build should add a two-step handover.

## 11. Frontend

The dashboard reads the same JSON views the tests assert on, through `genlayer-js` with no
signer, so it works with a plain browser and no wallet. Writes require an injected wallet, and
each write needs an explicit fee deposit: Studionet charges one, the SDK sends zero by default,
and the browser has no estimator — so `deploy/deployScript.ts` publishes the fee snapshot it
used to `frontend/public/fees.json` and the UI reuses it.

`preview_prompt` is surfaced in the UI on purpose: the prompt is part of the product surface.
