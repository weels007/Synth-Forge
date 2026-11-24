# SynthForge

**Generative synthetic asset vaults, settled on GenLayer.**

An intelligent contract that turns an investment thesis into a synthetic asset portfolio,
executes the rebalance against attested price feeds, and anchors every proposal, fill and
challenge as an execution proof that anyone can re-verify.

| | |
| --- | --- |
| Network | Studionet · chain `61999` |
| Contract | [`0x3B60C0380dfc8C186F3cfb2C2Bd8a3E148DC3060`](https://explorer-studio.genlayer.com/address/0x3B60C0380dfc8C186F3cfb2C2Bd8a3E148DC3060) |
| Deploy tx | [`0x82c2ebb4…c5098c`](https://explorer-studio.genlayer.com/tx/0x82c2ebb40e2be822a5da479e6aa3be6aa3134414bb7a39fcba7bfc5197c5098c) |
| Runner | `py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6` |
| Seeded state | 5 instruments · 1 portfolio (`PF-0001`, 1,000,000 GEN paper capital) |
| Live lifecycle | 2 strategies · 8 execution proofs · 1 revoke ruling · 1 recorded reopen |
| Direct tests | 65 passing (`pytest tests/direct`) |

A full lifecycle already ran against that address, one transaction per stage:

| Stage | Transaction | Result |
| --- | --- | --- |
| `generate_strategy` | [`0x7f3d1ec4`](https://explorer-studio.genlayer.com/tx/0x7f3d1ec492767914060cef127211b355371e1895353d65aa886db8d46b1b4c90) | `ST-0001` accepted, regime `RISK_ON`, 5 legs |
| `execute_strategy` | [`0x700e423b`](https://explorer-studio.genlayer.com/tx/0x700e423bf901e0368947f74749fcb94747e90926239e6e72689f0dd23c9cc1b4) | book filled at attested prices, 5000 bps turnover |
| `mark_to_market` | [`0x54112287`](https://explorer-studio.genlayer.com/tx/0x54112287bb55f833771376664b9feb2909ca09b70732a5d5f76be38311ff71f6) | NAV 1,000,000 → 1,000,081.36 GEN |
| `challenge_strategy` | [`0xe336b9d0`](https://explorer-studio.genlayer.com/tx/0xe336b9d09180ece96181c622c480ccb095d28786d992550dbec93819b9bf9f12) | `REVOKE` on `MANDATE_DRIFT, MISSING_HEDGE`; portfolio → `REVIEW` |
| `reopen_portfolio` | [`0x0964403c`](https://explorer-studio.genlayer.com/tx/0x0964403c2b8434be6923f4f6895508783278e6d9e976c6bb741c0adba5c38ff2) | portfolio → `LIVE`, recorded as a `REOPEN` proof |
| `generate_strategy` | [`0x9ff031d3`](https://explorer-studio.genlayer.com/tx/0x9ff031d30a4eab4e97bcb8d8d57c8787fac0d96c9b9e54f6d1ca2c8065278006) | replacement draft `ST-0002` |
| `execute_strategy` | [`0x4b7ac543`](https://explorer-studio.genlayer.com/tx/0x4b7ac543462f119b49e05de240a382b940a691dab4dcc5ddc974f5e672491803) | book re-filled, 750 bps turnover |

![The dashboard reading the live vault](docs/dashboard.png)

---

## Ringkasan (ID)

SynthForge adalah vault aset sintetis di GenLayer: satu thesis masuk, komite validator
GenLayer yang menyusun portofolio, mengeksekusinya dengan harga yang di-attest di dalam
konsensus, lalu siapa pun bisa *challenge* alokasi yang melanggar mandat. Semua keputusan
AI tidak dipercaya begitu saja, melainkan dibandingkan secara independen oleh validator
lain, dan setiap transisi state meninggalkan *execution proof* on-chain yang bisa diaudit.

Persetujuan tidak berhenti di "setuju/tidak": putusan challenge harus sepakat pada
**verdict** dan pada **alasan** yang dikutip, dan alasan itu diambil dari daftar kode
tertutup supaya dua node independen tidak pernah berbeda kata. Pelanggaran objektif (cap,
total bobot, instrumen yang dinonaktifkan) dihitung di Python sebelum model bicara, jadi
`REVOKE` tetap bisa dicapai konsensus walaupun model ingin `UPHOLD`.

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
4. **Disputes are adjudicated on-chain, on stated grounds.** Anyone can challenge a live
   allocation; an independent adjudicator rules `UPHOLD` or `REVOKE` and must cite the
   breaches from a closed vocabulary. A revoke halts the strategy and drops the portfolio
   into `REVIEW`, which only an explicit, recorded reopen can clear.

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
| Per-leg weight | `abs(delta) <= MAX_WEIGHT_DELTA_BPS` = **500 bps** |
| Total turnover | `sum(abs(delta)) <= MAX_L1_DELTA_BPS` = **1200 bps** |

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
proof, and the same rows are committed as `evidence` (symbol, URL, JSON path, attested
price), so the fill prices used for a rebalance are reproducible after the fact, not just at
the time.

### 3. Adjudication (`challenge_strategy`)

This is the path that needed the most care, because a ruling is a decision *plus its
reasons*. Comparing only the verdict is not enough: two nodes can both say `REVOKE` for
different reasons, and the stored record would then be a different fact on every node.
Comparing free text is worse, because independent runs never phrase the same breach the same
way, so every challenge round would fail to reach consensus and the state change would be
discarded.

SynthForge therefore makes the grounds machine-comparable:

| Code | Meaning |
| --- | --- |
| `CAP_BREACH` | a leg or the HIGH-risk sleeve exceeds its policy cap |
| `SUM_MISMATCH` | the legs do not sum to 10,000 bps |
| `MANDATE_DRIFT` | the book no longer implements the stated mandate |
| `CONCENTRATION_RISK` | exposure is concentrated in correlated instruments |
| `MISSING_HEDGE` | protection the mandate requires is absent |
| `THESIS_CONTRADICTION` | the book contradicts its own thesis |
| `UNSUPPORTED_INSTRUMENT` | a leg is not an enabled instrument |

The equivalence test is the pair `(verdict, set of vocabulary codes)`. Unknown grounds are
dropped on both sides by the same normaliser, so a validator that invents a label still
converges with an honest one. A `REVOKE` that cites nothing is refused with `[LLM_ERROR]`
instead of being stored.

On top of that, `_policy_breaches` computes the objective breaches in Python *before* the model
is called. If the allocation breaks a cap, the sum, or cites a disabled instrument, those
codes are forced into the ruling and the verdict becomes `REVOKE` regardless of what the model
answered. Consensus on a hard fact does not depend on a stochastic model agreeing with itself,
and a model cannot talk the committee out of a cap it can compute.

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
                 │            │            ├── execute_strategy ──► positions + ACTIVE + proof
                 │            │            │            │
                 │            │            │            └── mark_to_market ──► new NAV + proof
                 │            │            │
                 │            │            └── challenge_strategy ──► REVOKED + portfolio REVIEW
                 │            │                          │
                 │            │                          └── reopen_portfolio ──► LIVE + proof
                 │
                 └── set_asset_enabled / set_paused / transfer_ownership  (owner only)
```

Portfolio status is `OPEN` → `LIVE` → `REVIEW` (after a revoke) → `LIVE` (after a recorded
reopen). A strategy is `PROPOSED` → `ACTIVE` → `REVOKED`. A strategy can be ruled on exactly
once (`adjudicated` on the read model), so a settled book cannot be re-litigated into a
different answer by filing the same complaint twice.

## Contract interface

26 public methods: 13 writes, 13 views.

### Writes (13)

| Method | Who | What it does |
| --- | --- | --- |
| `register_asset(symbol, name, kind, underlying, reference_url, price_path, risk_bucket, max_weight_bps)` | owner | adds an instrument to the universe |
| `set_asset_enabled(symbol, enabled)` | owner | suspends an instrument without deleting its history |
| `set_paused(paused)` | owner | circuit breaker for every write path |
| `transfer_ownership(new_owner)` | owner | ownership handover |
| `open_portfolio(name, mandate, risk_profile, initial_capital_atto)` | anyone | creates a vault, mints shares 1:1 to the creator |
| `fund_portfolio(portfolio_id, amount_atto)` | anyone | deposits at the current NAV per share |
| `redeem_shares(portfolio_id, shares_atto)` | holder | burns shares for cash at the current mark |
| `transfer_shares(portfolio_id, to, shares_atto)` | holder | moves share ownership |
| `generate_strategy(portfolio_id, thesis, horizon_days)` | manager | LLM proposal under consensus |
| `execute_strategy(portfolio_id, strategy_id)` | manager | attested-price rebalance + proof |
| `mark_to_market(portfolio_id)` | anyone | re-marks the book at fresh attested prices |
| `challenge_strategy(portfolio_id, strategy_id, reason)` | anyone | adjudicated dispute + proof |
| `reopen_portfolio(portfolio_id, note)` | manager or owner | explicit way out of `REVIEW`, recorded |

### Views (13)

`get_system_info`, `get_owner`, `list_assets`, `get_asset`, `list_portfolios`, `get_portfolio`,
`get_positions`, `get_share_balance`, `list_strategies`, `get_strategy`, `list_proofs`,
`get_proof`, `preview_prompt`.

Every view returns `json.dumps(..., sort_keys=True)` so the bytes are deterministic and the
dashboard can diff two reads. `preview_prompt` returns the exact prompt validators will judge
for a given thesis, which is what makes the model call auditable rather than mysterious.

## Execution proofs

One row per state transition that moved money or changed the book — `PORTFOLIO_OPEN`,
`DEPOSIT`, `REDEMPTION`, `STRATEGY_APPROVAL`, `REBALANCE`, `MARK`, `CHALLENGE`, `REOPEN`:

```json
{
  "proof_id": "PR-0005",
  "kind": "CHALLENGE",
  "portfolio_id": "PF-0001",
  "strategy_id": "ST-0001",
  "allocation_digest": "sha256 of the reviewed weights",
  "input_digest": "sha256 of the adjudication prompt",
  "nav_before_atto": 1000081362696000000000000,
  "nav_after_atto": 1000081362696000000000000,
  "weight_l1_bps": 0,
  "verdict": "REVOKE",
  "verdict_detail": "REVOKE [MANDATE_DRIFT,MISSING_HEDGE]: the mandate requires a real long-vol sleeve…",
  "evidence": {
    "violations": ["MANDATE_DRIFT", "MISSING_HEDGE"],
    "allocation": { "SBTC": 1500, "SETH": 1000, "SUSD": 3500, "SEUR": 2000, "SJPY": 2000 },
    "prompt_digest": "176256b3…"
  },
  "executor": "0x0C0Fd005…",
  "created_at": "2026-11-24T05:40:50Z"
}
```

`weight_l1_bps` is the realised turnover the rebalance actually cost the portfolio, and
`nav_before` / `nav_after` frame the value change the rebalance is responsible for. `evidence`
is what makes a proof re-runnable rather than merely descriptive: price proofs carry the
symbol, URL, JSON path and attested price of every leg, rebalance proofs carry the target
weights and turnover, challenge proofs carry the cited grounds and the mandate they were
judged against.

## Quick start

```bash
# 0. prerequisites: Python 3.12, Node >= 22, and the GenLayer CLI
npm install && pip install -r requirements.txt

# 1. run the unit suite (no network, direct mode)
pytest

# 2. deploy and seed the universe on Studionet
node deploy/deployScript.ts

# 3. drive one full lifecycle against the live contract
node deploy/e2eScript.ts --address 0x3B60…3060

# 4. dashboard
cd frontend && npm install && npm run dev
```

`deploy/deployScript.ts` prints the address, seeds five instruments, opens the demo portfolio,
reads the state back and refuses to report success if the read-back is empty (a Studionet
deploy can reach `FINALIZED` and still have rolled back, so the receipt alone is not proof).
It writes `deployments.json`, `frontend/public/fees.json` and `frontend/public/deployment.json`.

### Environment

| Variable | Where | Purpose |
| --- | --- | --- |
| `DEPLOYER_PRIVATE_KEY` | shell | deployer key; otherwise read from `.env` (`GENLAYER_DEV_KEY`) |
| `SYNTHFORGE_KEY_FILE` | shell | explicit path to a key file |
| `SYNTHFORGE_WALLET` | shell | keystore name to deploy with (default `global`) |
| `NEXT_PUBLIC_SYNTHFORGE_ADDRESS` | `frontend/.env.local` | fallback vault address only |

The dashboard resolves its contract from `frontend/public/deployment.json`, which the deploy
script writes, so the page cannot silently point at an older deployment than the one the
README documents.

Studionet charges a fee deposit and genlayer-js sends a zero deposit unless it is told
otherwise, so both drivers price each transaction with `genlayer estimate-fees` once per
process; the browser has no estimator, so the deploy script publishes the snapshot it used to
`frontend/public/fees.json`.

## Frontend

The dashboard is two surfaces with different jobs, so they look different on purpose.

| Route | Surface | What it is for |
| --- | --- | --- |
| `/` | cover | the printed prospectus: what the instrument is, the live certificate, the limits |
| `/vault` | console | NAV, positions, book policy, mark-to-market, fund/redeem |
| `/strategies` | console | the register of drafts, one draft in full, propose a new one |
| `/proofs` | console | the ledger, filterable, with the evidence behind each row |
| `/universe` | console | feeds, buckets, per-instrument caps, owner-gated registry |
| `/dispute` | console | file a challenge, read the latest ruling, reopen the book |
| `/how-it-works` | console | the three consensus paths, step by step |

Reads work without a wallet. Writes need one, and every write notice distinguishes
`ACCEPTED` from `FINALIZED`, because a Studionet receipt that has not closed its appeal
window is not a settled transaction.

## Repository map

```
contracts/SynthForgeVault.py      the intelligent contract (26 public methods)
tests/direct/                     direct-mode pytest suites (65 tests, mocked web + llm)
scripts/studionet.cjs             shared Studionet driver: paced RPC, receipts, fees
scripts/wallet.mjs                keystore loader for deployers and test actors
scripts/fetchFonts.mjs            re-downloads the dashboard fonts (latin subsets)
deploy/deployScript.ts            deploy + seed + read-back verification
deploy/e2eScript.ts               generate → execute → mark → challenge → reopen, prints proofs
frontend/                         Next.js dashboard: cover page + six-room console
docs/ARCHITECTURE.md              why the contract is shaped this way
docs/LICENSE                      MIT
```

## Tests

`pytest` runs in direct mode against `genlayer-test`: no network, deterministic, and the
cheatcodes (`mock_web`, `mock_llm`, `run_validator()`, `expect_revert()`) let a test play
the validator role explicitly.

| Suite | Tests | Covers |
| --- | --- | --- |
| `test_registry_and_portfolios.py` | 20 | symbol rules, caps per profile, funding, redemption, share transfers, pause/ownership guards |
| `test_strategy_engine.py` | 15 | proposal normalisation, clamping, prompt content, validator agreement and rejection |
| `test_execution_and_marks.py` | 9 | attested fills, turnover limits, NAV after rebalance, mark-to-market |
| `test_challenges_and_proofs.py` | 10 | uphold vs revoke, portfolio review state, one ruling per strategy, proof chain integrity |
| `test_consensus_binding.py` | 11 | verdict + grounds equivalence, unknown-ground dropping, objective breaches overriding the model, evidence payloads |

The interesting ones are the disagreement tests: they call `run_validator()` with a proposal
that differs within the band (accepted) and beyond it (rejected), which is the exact mechanism
that makes the AI output trustworthy. `test_consensus_binding.py` goes further and checks that
an honest validator still converges when the leader words its grounds differently or invents a
label outside the vocabulary.

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
would make every round rotate forever. The tolerances (500 bps per leg, 1200 bps total,
150 bps on prices) are the contract of what "the same book" means, and they are constants at
the top of the file rather than prompt instructions.

**A closed vocabulary is a consensus primitive, not a style choice.** Free-text grounds make
the consensus set empty, which silently discards the state change. Constraining the model to
seven codes, normalising what it returns, and computing the objective breaches in Python is
what turns "the committee agreed to revoke" into a fact that can be stored once and audited
later.

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
- The violation vocabulary is deliberately small. A breach it cannot name is either mapped to
  the nearest code or left to `MANDATE_DRIFT`; widening it is a contract change, not a prompt
  change.

## License

MIT — see `docs/LICENSE`.
