# SynthForge

**Generative synthetic asset vaults, settled on GenLayer.**

An intelligent contract that turns an investment thesis into a synthetic asset portfolio,
executes the rebalance against attested price feeds, and anchors every proposal, fill and
challenge as an execution proof that anyone can re-verify.

| | |
| --- | --- |
| Network | Studionet · chain `61999` |
| Contract | [`0x562e1E4FBd555a1aE0dF529d543aE4D357A9bA49`](https://explorer-studio.genlayer.com/address/0x562e1E4FBd555a1aE0dF529d543aE4D357A9bA49) |
| Deploy tx | [`0xbf07a038…5a02c`](https://explorer-studio.genlayer.com/tx/0xbf07a038836acbda9c9ac84de0a90202b18f4d3eb78dfe271cb4d30c2555a02c) |
| Runner | `py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6` |
| Seeded state | 5 instruments · 1 portfolio (`PF-0001`, 1,000,000 GEN paper capital) |
| Live lifecycle | 2 strategies · 8 execution proofs · 1 revoke ruling |
| Direct tests | 54 passing (`pytest tests/direct`) |

A full lifecycle already ran against that address, one transaction per stage:

| Stage | Transaction | Result |
| --- | --- | --- |
| `generate_strategy` | [`0xc705ee3e`](https://explorer-studio.genlayer.com/tx/0xc705ee3e054c91cf3f3ec789bb93394fae86a653f4ffd7552eef65227f524368) | `ST-0001` accepted, regime `RISK_ON`, 5 legs |
| `execute_strategy` | [`0xb8e984be`](https://explorer-studio.genlayer.com/tx/0xb8e984be5bbbf9907aab33dba9615b1147d7666b28c6525487b5b6bf9343a5d0) | book filled at attested prices, 5000 bps turnover |
| `mark_to_market` | [`0x8bcecd02`](https://explorer-studio.genlayer.com/tx/0x8bcecd02185ca9f7145349e1503a027d691b936fac19eaa4be72b1d28f602889) | NAV 1,000,000 → 1,000,032.67 GEN |
| `challenge_strategy` | [`0xf328beda`](https://explorer-studio.genlayer.com/tx/0xf328beda349be4ed09f6a81f22ece2df9d10629ffd4345d6aa6fafdbf23aa26f) | `REVOKE` — `NO_LONG_VOL_SLEEVE`, portfolio moved to `REVIEW` |

A second strategy (`ST-0002`) was then generated and executed, which is how the live portfolio
ends at `LIVE` with 8 proofs and one revoked predecessor in its register.

![The dashboard reading the live vault](docs/dashboard.png)

---

## Ringkasan (ID)

SynthForge adalah vault aset sintetis di GenLayer: satu thesis masuk, komite validator
GenLayer yang menyusun portofolio, mengeksekusinya dengan harga yang di-attest di dalam
konsensus, lalu siapa pun bisa *challenge* alokasi yang melanggar mandat. Semua keputusan
AI tidak dipercaya begitu saja, melainkan dibandingkan secara independen oleh validator
lain, dan setiap transisi state meninggalkan *execution proof* on-chain yang bisa diaudit.

---

## The problem it solves

AI portfolio agents today are a black box: a model proposes an allocation off-chain, a server
executes it, and the user has to trust both. There is no way to check whether the model saw
the price it claims to have seen, whether the weights it reports are the weights it bought,
or whether the mandate it was given was the mandate it followed.

SynthForge moves that entire loop on-chain and makes each step *comparatively verifiable*:

1. **The proposal is re-run by the validators.** The leader asks a model for an allocation;
   every validator asks the same model the same prompt and only accepts the result if it
   agrees within an explicit tolerance. Disagreement is a consensus failure, not a silent
   overwrite.
2. **Prices are read inside consensus.** Every leg is filled at a price fetched and agreed
   on by the committee, so the fill price cannot be spoofed by the leader.
3. **The mandate is enforced by code, not by the prompt.** Whatever the model returns is
   normalised and clamped against per-instrument caps, the risk-profile ceiling and the
   max turnover before a single unit is booked.
4. **Disputes are adjudicated on-chain.** Anyone can challenge a live allocation; an
   independent adjudicator re-reads the mandate and rules `UPHOLD` or `REVOKE`, and a revoke
   halts the strategy and drops the portfolio into `REVIEW`.

## The three consensus paths

Each path is one `gl.vm.run_nondet_unsafe(leader_fn, validator_fn)` block. Nothing that
touches storage, `self`, or `gl.get_contract_at` lives inside a closure; the closures return
plain data and the contract writes afterwards.

### 1. Strategy construction (`generate_strategy`)

The leader builds a portfolio from a fixed universe snapshot:

```
PORTFOLIO CONSTRUCTION ENGINE  →  { regime, weights{symbol: bps}, rationale, confidence_bps }
RISK ADJUDICATOR               →  { verdict: UPHOLD|REVOKE, violations[], explanation }
```

| Equivalent when | Rule |
| --- | --- |
| Regime | must be identical |
| Instrument set | must be identical (`sorted(keys)` match) |
| Per-leg weight | `abs(delta) <= MAX_WEIGHT_DELTA_BPS` = **1500 bps** |
| Total turnover | `sum(abs(delta)) <= MAX_L1_DELTA_BPS` = **3500 bps** |

Two independent runs of a stochastic model will never be byte-identical, so the equivalence
principle has to be a *statement about the portfolio*, not about the text: same market view,
same instruments, and weights that are economically the same book. A validator that
disagrees beyond that tolerance rejects the leader and the round rotates.

### 2. Price attestation (`execute_strategy`, `mark_to_market`)

Each instrument carries a `reference_url` and a `price_path` (a dotted JSON path such as
`data.amount` or `rates.USD`). Inside consensus the leader fetches every feed; each validator
fetches the same feeds and the two price maps must agree leg by leg:

```
abs(leader_price - validator_price) * 10000 <= PRICE_TOLERANCE_BPS * leader_price   # 150 bps
```

The agreed map is then reduced to a digest (`_specs_digest`) that is stored on the execution
proof, so the fill prices used for a rebalance are reproducible after the fact, not just at
the time.

### 3. Adjudication (`challenge_strategy`)

The ruling is a decision, not prose. Validators compare the `verdict` field only (`UPHOLD` /
`REVOKE`); the explanation is stored for humans but is not part of the equivalence test,
because two correct adjudications of the same facts can be worded differently. The violation
tags are normalised (`upper`, spaces to `_`, sorted) so the stored record is stable.

### Error taxonomy

Closures raise `gl.vm.UserError` with a prefix, and `_handle_leader_error` decides what a
validator should do when the leader failed instead of returning:

| Prefix | Meaning | Validator behaviour |
| --- | --- | --- |
| `[EXPECTED]` | deterministic, business-level rejection | agree only if the message matches exactly |
| `[EXTERNAL]` | deterministic upstream refusal (400/404 from a feed) | same |
| `[TRANSIENT]` | network flake | agree if the validator also failed transiently, else rotate |
| `[LLM_ERROR]` | model returned unusable output | rotate |

## Lifecycle

```
register_asset ──┐
                 ├── open_portfolio ──► fund / redeem / transfer shares
                 │            │
                 │            ├── generate_strategy ──► strategy PROPOSED
                 │            │            │
                 │            │            └── challenge_strategy ──► REVOKED (portfolio REVIEW)
                 │            │
                 │            └── execute_strategy ──► positions + ACTIVE + proof
                 │                          │
                 │                          └── mark_to_market ──► new NAV + proof
                 │
                 └── set_asset_enabled / set_paused / transfer_ownership  (owner only)
```

Portfolio status is `OPEN` → `ACTIVE` (after a first execution) → `REVIEW` (after a revoke).
A strategy is `PROPOSED` → `ACTIVE` → `REVOKED`.

## Contract interface

### Writes (12)

| Method | Who | What it does |
| --- | --- | --- |
| `register_asset(symbol, name, kind, underlying, reference_url, price_path, risk_bucket, max_weight_bps)` | owner | adds an instrument to the universe |
| `set_asset_enabled(symbol, enabled)` | owner | suspends an instrument without deleting its history |
| `set_paused(paused)` | owner | circuit breaker for every write path |
| `transfer_ownership(new_owner)` | owner | two-step-free ownership handover |
| `open_portfolio(name, mandate, risk_profile, initial_capital_atto)` | anyone | creates a vault, mints shares 1:1 to the creator |
| `fund_portfolio(portfolio_id, amount_atto)` | anyone | deposits at the current NAV per share |
| `redeem_shares(portfolio_id, shares_atto)` | holder | burns shares for cash at the current mark |
| `transfer_shares(portfolio_id, to, shares_atto)` | holder | moves share ownership |
| `generate_strategy(portfolio_id, thesis, horizon_days)` | anyone | LLM proposal under consensus |
| `execute_strategy(portfolio_id, strategy_id)` | anyone | attested-price rebalance + proof |
| `mark_to_market(portfolio_id)` | anyone | re-marks the book at fresh attested prices |
| `challenge_strategy(portfolio_id, strategy_id, reason)` | anyone | adjudicated dispute + proof |

### Views (13)

`get_system_info`, `get_owner`, `list_assets`, `get_asset`, `list_portfolios`, `get_portfolio`,
`get_positions`, `get_share_balance`, `list_strategies`, `get_strategy`, `list_proofs`,
`get_proof`, `preview_prompt`.

Every view returns `json.dumps(..., sort_keys=True)` so the bytes are deterministic and the
dashboard can diff two reads. `preview_prompt` returns the exact prompt validators will judge
for a given thesis, which is what makes the model call auditable rather than mysterious.

## Execution proofs

One row per state transition that moved money or changed the book — `PORTFOLIO_OPEN`,
`DEPOSIT`, `REDEMPTION`, `STRATEGY_APPROVAL`, `REBALANCE`, `MARK`, `CHALLENGE`:

```json
{
  "proof_id": "PR-0003",
  "kind": "REBALANCE",
  "portfolio_id": "PF-0001",
  "strategy_id": "ST-0001",
  "allocation_digest": "sha256 of the booked weights",
  "input_digest": "sha256 of the prompt and attested prices",
  "nav_before_atto": 1000000000000000000000000,
  "nav_after_atto": 999999999999999000000000,
  "weight_l1_bps": 2100,
  "verdict": "ACCEPTED",
  "verdict_detail": "executed under validator-attested prices",
  "executor": "0x...",
  "created_at": "2025-…"
}
```

`weight_l1_bps` is the realised turnover the rebalance actually cost the portfolio, and
`nav_before` / `nav_after` frame the value change the rebalance is responsible for. Anyone can
recompute `allocation_digest` from `get_positions` plus the stored weights and compare.

## Quick start

```bash
# 0. prerequisites: Python 3.12, Node >= 22, and the GenLayer CLI
npm install && pip install -r requirements.txt

# 1. run the unit suite (no network, direct mode)
pytest

# 2. deploy and seed the universe on Studionet
node deploy/deployScript.ts

# 3. drive one full lifecycle against the live contract
node deploy/e2eScript.ts --address 0x562e…bA49

# 4. dashboard
cd frontend && npm install && npm run dev
```

`deploy/deployScript.ts` prints the address, seeds five instruments, opens the demo portfolio,
reads the state back and refuses to report success if the read-back is empty (a Studionet
deploy can reach `FINALIZED` and still have rolled back, so the receipt alone is not proof).
It writes `deployments.json` and `frontend/public/fees.json`.

### Environment

| Variable | Where | Purpose |
| --- | --- | --- |
| `DEPLOYER_PRIVATE_KEY` | shell | deployer key; otherwise read from `.env` (`GENLAYER_DEV_KEY`) |
| `SYNTHFORGE_KEY_FILE` | shell | explicit path to a key file |
| `NEXT_PUBLIC_SYNTHFORGE_ADDRESS` | `frontend/.env.local` | vault the dashboard reads |

Studionet charges a fee deposit and genlayer-js sends a zero deposit unless it is told
otherwise, so both drivers price each transaction with `genlayer estimate-fees` once per
process; the browser has no estimator, so the deploy script publishes the snapshot it used to
`frontend/public/fees.json`.

## Repository map

```
contracts/SynthForgeVault.py      the intelligent contract (~58 KB, 25 public methods)
tests/direct/                     direct-mode pytest suites (54 tests, mocked web + llm)
scripts/studionet.cjs             shared Studionet driver: paced RPC, receipts, fees
scripts/fetchFonts.mjs            re-downloads the dashboard fonts (latin subsets)
deploy/deployScript.ts            deploy + seed + read-back verification
deploy/e2eScript.ts               generate → execute → mark → challenge, prints proofs
frontend/                         Next.js dashboard (read-only without a wallet)
docs/ARCHITECTURE.md               why the contract is shaped this way
docs/LICENSE                      MIT
```

## Tests

`pytest` runs in direct mode against `genlayer-test`: no network, deterministic, and the
cheatcodes (`mock_web`, `mock_llm`, `run_validator()`) let a test play the validator role
explicitly.

| Suite | Tests | Covers |
| --- | --- | --- |
| `test_registry_and_portfolios.py` | 20 | symbol rules, caps per profile, funding, redemption, share transfers, pause/ownership guards |
| `test_strategy_engine.py` | 15 | proposal normalisation, clamping, prompt content, validator agreement and rejection |
| `test_execution_and_marks.py` | 13 | attested fills, turnover limits, NAV after rebalance, mark-to-market |
| `test_challenges_and_proofs.py` | 6 | uphold vs revoke, portfolio review state, proof chain integrity |

The interesting ones are the disagreement tests: they call `run_validator()` with a proposal
that differs by 400 bps (accepted) and by more than 1500 bps (rejected), which is the exact
mechanism that makes the AI output trustworthy.

## Design notes

**Why paper capital.** `open_portfolio` mints shares against an internal `atto` balance rather
than accepting GEN. Real settlement would need an oracle for GEN price and a bridge for each
synthetic, which would bury the part that matters (consensus over the strategy) under
plumbing. The accounting is real: shares, NAV per share, funding and redemption all price off
the marked book, so swapping the cash ledger for a real one is a contained change.

**Clamp, do not reject.** A model that returns a weight above the cap is not an error, it is
the expected case, so the contract clamps it and records the adjustment in the proof detail.
Rejecting would make the strategy path fail exactly when the model is most creative. Only
*structural* violations (unknown symbols, weights that sum to zero, malformed JSON) raise.

**Tolerance instead of determinism.** LLM output is not reproducible; pretending otherwise
would make every round rotate forever. The tolerances (1500 bps per leg, 3500 bps total,
150 bps on prices) are the contract of what "the same book" means, and they are constants at
the top of the file rather than prompt instructions.

**The prompt is a view.** `preview_prompt` exists because an AI system that cannot show its
prompt is not auditable. It renders the same string the leader sends.

## Limits

- Prices come from public keyless HTTP feeds (Coinbase spot, Frankfurter FX); a production
  build would need a signed oracle and staleness bounds per instrument.
- Synthetic exposure is not hedged: the vault tracks notional value, it does not hold the
  underlying.
- Share transfer is `u256` bookkeeping, not an ERC-20.
- One portfolio per `open_portfolio` call and a single active strategy per portfolio: the
  model reasons about one book at a time.

## License

MIT — see `docs/LICENSE`.
