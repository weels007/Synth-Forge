"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  NETWORK,
  connectWallet,
  formatGen,
  loadSnapshot,
  pct,
  readOne,
  short,
  submit,
  type Asset,
  type Portfolio,
  type Position,
  type Proof,
  type Snapshot,
  type Strategy,
  type Wallet,
} from "@/lib/synthforge";

const ADDRESS = (process.env.NEXT_PUBLIC_SYNTHFORGE_ADDRESS ?? "").trim();

const DEFAULT_THESIS =
  "Real yields are rolling over and dollar liquidity is stable, so I want the long-vol sleeve " +
  "to carry the book while the low-risk sleeve keeps redemption capacity. Nothing pinned to one name.";

const DEFAULT_REASON =
  "The draft leans on crypto beta while the mandate asks for a book that survives a risk-off " +
  "regime; it understates drawdown correlation between the two high-risk sleeves.";

export default function Page() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");
  const [landing, setLanding] = useState(false);
  const [thesis, setThesis] = useState(DEFAULT_THESIS);
  const [horizon, setHorizon] = useState("30");
  const [reason, setReason] = useState(DEFAULT_REASON);
  const [prompt, setPrompt] = useState("");

  const refresh = useCallback(async () => {
    if (!ADDRESS) return;
    try {
      const next = await loadSnapshot(ADDRESS);
      setSnapshot(next);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const portfolio: Portfolio | undefined = snapshot?.portfolios[0];
  const strategy: Strategy | undefined = snapshot?.strategies[0];
  const proofs: Proof[] = snapshot?.proofs ?? [];
  const positions: Position[] = snapshot?.positions ?? [];

  const held = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of positions) map.set(row.symbol, row.weight_bps);
    return map;
  }, [positions]);

  const totalWeight = useMemo(
    () => positions.reduce((sum, row) => sum + Number(row.weight_bps), 0),
    [positions],
  );

  async function act(label: string, run: (wallet: Wallet) => Promise<unknown>, success: string) {
    if (!wallet) {
      setError("Connect a wallet first: every state change is signed by the portfolio manager.");
      return;
    }
    setBusy(label);
    setError("");
    setNote("");
    try {
      await run(wallet);
      setNote(success);
      await refresh();
      setLanding(true);
      window.setTimeout(() => setLanding(false), 700);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy("");
    }
  }

  async function onConnect() {
    try {
      setWallet(await connectWallet());
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  if (!ADDRESS) {
    return (
      <main className="page">
        <header className="masthead">
          <div className="wordmark">
            <div className="seal-mark">S</div>
            <div>
              <h1>SynthForge</h1>
              <span className="kicker">Generative synthetic assets · GenLayer</span>
            </div>
          </div>
        </header>
        <section className="sheet" style={{ marginTop: 26 }}>
          <header>
            <span className="schedule-label">Setup</span>
            <h2>No vault address configured</h2>
          </header>
          <div className="sheet-body">
            <p className="quiet">
              Run <code className="mono">node deploy/deployScript.ts</code> to deploy and seed the vault, then
              copy the printed address into <code className="mono">frontend/.env.local</code> as
              <code className="mono"> NEXT_PUBLIC_SYNTHFORGE_ADDRESS</code>.
            </p>
          </div>
        </section>
      </main>
    );
  }

  const status = portfolio?.status ?? "AWAITING";
  // Portfolio lifecycle: OPEN -> LIVE -> REVIEW (after a revoke). Strategy: ACTIVE / REVOKED.
  const stampClass = status === "REVOKED" ? "stamp revoked" : status === "REVIEW" ? "stamp review" : status === "ACTIVE" || status === "LIVE" ? "stamp active" : "stamp review";

  return (
    <main className="page">
      <header className="masthead">
        <div className="wordmark">
          <div className="seal-mark">S</div>
          <div>
            <h1>SynthForge</h1>
            <span className="kicker">Generative synthetic assets · GenLayer</span>
          </div>
        </div>
        <div className="folio">
          <div>
            Network <b>{NETWORK.name}</b> · Chain <b>{NETWORK.chainId}</b>
          </div>
          <div>
            Vault <b>{short(ADDRESS, 10, 6)}</b> · Owner <b>{snapshot ? short(snapshot.info.owner, 8, 4) : "…"}</b>
          </div>
          <div>
            Universe <b>{snapshot ? snapshot.info.assets : "…"}</b> instruments · Writes{" "}
            <b className={snapshot?.info.paused ? "halted" : "live"}>{snapshot?.info.paused ? "HALTED" : "OPEN"}</b>
          </div>
        </div>
      </header>

      <section className="certificate">
        <div className="guilloche" />
        <div className="cert-top">
          <div>
            <div className="cert-eyebrow">Certificate of managed synthetic exposure</div>
            <h2 className="cert-title">{portfolio?.name ?? "SynthForge portfolio"}</h2>
            <p className="cert-mandate">{portfolio?.mandate ?? "Loading the on-chain mandate…"}</p>
          </div>
          <div className={`${stampClass}${landing ? " landing" : ""}`}>
            {status}
            <small>{portfolio?.risk_profile ?? "—"} mandate</small>
          </div>
        </div>

        <div className="cert-figures">
          <div className="figure">
            <span>Net asset value</span>
            <strong>{portfolio ? formatGen(portfolio.nav_atto) : "—"}</strong>
            <em>GEN · marked at attested prices</em>
          </div>
          <div className="figure">
            <span>Shares outstanding</span>
            <strong>{portfolio ? formatGen(portfolio.shares_atto) : "—"}</strong>
            <em>{portfolio ? `NAV per share ${(Number(portfolio.nav_per_share_atto) / 1e18).toFixed(4)}` : ""}</em>
          </div>
          <div className="figure">
            <span>Rebalances</span>
            <strong>{portfolio ? String(portfolio.rebalances) : "—"}</strong>
            <em>{portfolio?.last_mark_at ? `last mark ${portfolio.last_mark_at.slice(0, 16)}` : "never marked"}</em>
          </div>
          <div className="figure">
            <span>Proofs anchored</span>
            <strong>{proofs.length}</strong>
            <em>{strategy ? `${strategy.regime} regime` : "no strategy yet"}</em>
          </div>
        </div>
      </section>

      <div className="schedules">
        <div className="stack">
          <section className="sheet">
            <header>
              <div>
                <span className="schedule-label">Schedule A</span>
                <h2>Synthetic universe</h2>
              </div>
              <span className="meta">{snapshot ? `${snapshot.assets.length} registered` : ""}</span>
            </header>
            <div className="sheet-body">
              <table className="ledger">
                <thead>
                  <tr>
                    <th>Instrument</th>
                    <th>Class</th>
                    <th>Risk</th>
                    <th className="num">Cap</th>
                    <th className="num">Held</th>
                  </tr>
                </thead>
                <tbody>
                  {(snapshot?.assets ?? []).map((asset: Asset) => {
                    const weight = held.get(asset.symbol) ?? 0;
                    return (
                      <tr key={asset.symbol}>
                        <td>
                          <span className="sym">{asset.symbol}</span>
                          <span className="sub">{asset.underlying}</span>
                        </td>
                        <td>
                          <span className="quiet">{asset.kind}</span>
                        </td>
                        <td>
                          <span className={`chip ${asset.risk_bucket.toLowerCase()}`}>{asset.risk_bucket}</span>
                          {!asset.enabled ? <span className="chip off"> off</span> : null}
                        </td>
                        <td className="num">{pct(asset.max_weight_bps)}</td>
                        <td className="num">{weight > 0 ? pct(weight) : "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div className="rule-note">
                Caps are enforced by the contract, not advisory: every proposed weight is clamped to the
                instrument cap and to the mandate ceiling. Deployed weight in the book totals{" "}
                <span className="mono">{pct(totalWeight)}</span>.
              </div>
            </div>
          </section>

          <section className="sheet">
            <header>
              <div>
                <span className="schedule-label">Schedule C</span>
                <h2>Proofs of execution</h2>
              </div>
              <span className="meta">{proofs.length ? `${proofs[0].proof_id} latest` : "none"}</span>
            </header>
            <div className="sheet-body">
              {proofs.length === 0 ? (
                <p className="quiet">No proof has been anchored for this portfolio yet.</p>
              ) : (
                <div className="proof-list">
                  {proofs.slice(0, 8).map((proof) => (
                    <div className="proof-row" key={proof.proof_id}>
                      <div>
                        <div className="proof-id">{proof.proof_id}</div>
                        <span className="proof-kind">{proof.kind}</span>
                      </div>
                      <div>
                        <div className="proof-detail">{proof.verdict_detail || "recorded"}</div>
                        <div className="proof-hash">
                          alloc {short(proof.allocation_digest, 10, 6)} · input {short(proof.input_digest, 10, 6)}
                        </div>
                        <div className="proof-hash">
                          nav {formatGen(proof.nav_before_atto)} → {formatGen(proof.nav_after_atto)} · turnover{" "}
                          {proof.weight_l1_bps} bps
                        </div>
                      </div>
                      <span className={`proof-verdict verdict-${String(proof.verdict).toLowerCase()}`}>
                        {proof.verdict}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        </div>

        <div className="stack">
          <section className="sheet">
            <header>
              <div>
                <span className="schedule-label">Schedule B</span>
                <h2>Strategy draft</h2>
              </div>
              <span className="meta">{strategy ? strategy.strategy_id : "none"}</span>
            </header>
            <div className="sheet-body">
              {strategy ? (
                <>
                  <div className="legs">
                    {Object.entries(strategy.allocation)
                      .sort((a, b) => b[1] - a[1])
                      .map(([symbol, weight]) => (
                        <div className="leg" key={symbol}>
                          <span className="sym">{symbol}</span>
                          <span className="hatch">
                            <i style={{ width: `${Math.min(100, Number(weight) / 100)}%` }} />
                          </span>
                          <span className="num">{pct(Number(weight))}</span>
                        </div>
                      ))}
                  </div>
                  {strategy.rationale ? <p className="leg-note" style={{ margin: "12px 0 0" }}>{strategy.rationale}</p> : null}
                  <div className="rule-note">
                    <b className="mono">{strategy.regime}</b> regime · confidence {pct(strategy.confidence_bps)} · horizon{" "}
                    {strategy.horizon_days} days · status {strategy.status}
                    {strategy.digest ? (
                      <>
                        <br />
                        <span className="quiet">allocation digest {short(strategy.digest, 14, 8)}</span>
                      </>
                    ) : null}
                  </div>
                  {snapshot && snapshot.strategies.length > 1 ? (
                    <div className="memo-row" style={{ paddingBottom: 10 }}>
                      <span className="memo-label">Strategy register</span>
                      <div className="quiet" style={{ lineHeight: 1.9 }}>
                        {snapshot.strategies.map((entry) => (
                          <span key={entry.strategy_id} style={{ marginRight: 14 }}>
                            <span className="mono">{entry.strategy_id}</span> {entry.status}
                          </span>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  <div className="memo-row" style={{ borderBottom: 0, paddingBottom: 0 }}>
                    <span className="memo-label">{strategy.status === "REVOKED" ? "Thesis that was revoked" : "Thesis under review"}</span>
                    <p className="quiet" style={{ margin: 0, lineHeight: 1.6 }}>
                      {strategy.thesis}
                    </p>
                  </div>
                </>
              ) : (
                <p className="quiet">
                  No strategy has been generated. Write a thesis in the memorandum below and let the
                  validator committee propose the first allocation.
                </p>
              )}
            </div>
          </section>

          <section className="sheet">
            <header>
              <div>
                <span className="schedule-label">Memorandum</span>
                <h2>Manager instructions</h2>
              </div>
              <span className="meta">{wallet ? short(wallet.address, 6, 4) : "unsigned"}</span>
            </header>
            <div className="sheet-body">
              <div className="memo">
                <div className="memo-row">
                  <label className="memo-label" htmlFor="thesis">
                    Investment thesis
                  </label>
                  <textarea id="thesis" rows={4} value={thesis} onChange={(event) => setThesis(event.target.value)} />
                </div>
                <div className="memo-row">
                  <label className="memo-label" htmlFor="horizon">
                    Horizon (days)
                  </label>
                  <input
                    id="horizon"
                    inputMode="numeric"
                    value={horizon}
                    onChange={(event) => setHorizon(event.target.value.replace(/[^0-9]/g, ""))}
                  />
                </div>
                <div className="memo-row">
                  <label className="memo-label" htmlFor="reason">
                    Challenge grounds
                  </label>
                  <textarea id="reason" rows={3} value={reason} onChange={(event) => setReason(event.target.value)} />
                </div>
              </div>

              <div className="controls">
                <button className="press" type="button" onClick={onConnect} disabled={!!wallet}>
                  {wallet ? "Wallet linked" : "Connect wallet"}
                </button>
                <button
                  className="press solid"
                  type="button"
                  disabled={!portfolio || !!busy}
                  onClick={() =>
                    act(
                      "generate",
                      (signer) =>
                        submit(signer.client, ADDRESS, "generate_strategy", [
                          portfolio!.portfolio_id,
                          thesis,
                          Number(horizon || "0"),
                        ]),
                      "The committee proposed a strategy. Read the draft above and execute it when it fits the mandate.",
                    )
                  }
                >
                  {busy === "generate" ? "Consensus…" : "Generate strategy"}
                </button>
                <button
                  className="press"
                  type="button"
                  disabled={!strategy || !portfolio || !!busy}
                  onClick={() =>
                    act(
                      "execute",
                      (signer) =>
                        submit(signer.client, ADDRESS, "execute_strategy", [
                          portfolio!.portfolio_id,
                          strategy!.strategy_id,
                        ]),
                      "Rebalance settled. The contract clamped every leg to its cap and anchored a proof.",
                    )
                  }
                >
                  {busy === "execute" ? "Settling…" : "Execute"}
                </button>
                <button
                  className="press"
                  type="button"
                  disabled={!portfolio || !!busy}
                  onClick={() =>
                    act(
                      "mark",
                      (signer) => submit(signer.client, ADDRESS, "mark_to_market", [portfolio!.portfolio_id]),
                      "Book repriced from attested sources. NAV moved to the new mark.",
                    )
                  }
                >
                  {busy === "mark" ? "Repricing…" : "Mark to market"}
                </button>
                <button
                  className="press danger"
                  type="button"
                  disabled={!strategy || !portfolio || !!busy}
                  onClick={() =>
                    act(
                      "challenge",
                      (signer) =>
                        submit(signer.client, ADDRESS, "challenge_strategy", [
                          portfolio!.portfolio_id,
                          strategy!.strategy_id,
                          reason,
                        ]),
                      "An independent adjudicator ruled on the challenge; the ruling is anchored.",
                    )
                  }
                >
                  {busy === "challenge" ? "Adjudicating…" : "Challenge"}
                </button>
                <button
                  className="press"
                  type="button"
                  disabled={!portfolio || !!busy}
                  onClick={async () => {
                    setBusy("prompt");
                    try {
                      const text = await readOne(ADDRESS, "preview_prompt", [
                        portfolio!.portfolio_id,
                        thesis,
                        Number(horizon || "0"),
                      ]);
                      setPrompt(String(text));
                    } catch (caught) {
                      setError(caught instanceof Error ? caught.message : String(caught));
                    } finally {
                      setBusy("");
                    }
                  }}
                >
                  {busy === "prompt" ? "Reading…" : "Show prompt"}
                </button>
              </div>

              {note ? <div className="notice good">{note}</div> : null}
              {error ? <div className="notice bad">{error}</div> : null}
              {prompt ? (
                <div className="notice">
                  <span className="memo-label">Exact prompt the validators judge</span>
                  <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontFamily: "var(--mono)", fontSize: 11 }}>
                    {prompt}
                  </pre>
                </div>
              ) : null}
              <p className="quiet" style={{ marginTop: 14 }}>
                Every instruction above is a signed transaction. The dashboard never talks to a model
                directly: it asks the contract, and the contract asks the validator committee.
              </p>
            </div>
          </section>
        </div>
      </div>

      <section className="process">
        <h3>How a synthetic book gets made</h3>
        <div className="steps">
          <div className="step">
            <b>I · Propose</b>
            <p>
              A thesis goes to the construction engine. Validators re-run the proposal and accept it only
              if regime, instruments and weights agree within tolerance, then the contract clamps the
              result to the mandate caps before storing it.
            </p>
          </div>
          <div className="step">
            <b>II · Attest</b>
            <p>
              Execution re-reads every reference feed inside consensus. The attested prices become the
              fills, the NAV, and the digest of the allocation that was actually held.
            </p>
          </div>
          <div className="step">
            <b>III · Adjudicate</b>
            <p>
              Anyone may challenge a live allocation. An independent adjudicator re-reads the mandate and
              rules REVOKE or UPHOLD; a revoke halts the strategy and drops the portfolio into review.
            </p>
          </div>
        </div>
      </section>

      <footer className="colophon">
        <span>SynthForge v{snapshot?.info.version ?? "1.0.0"} · {NETWORK.name} · contract {short(ADDRESS, 12, 8)}</span>
        <span>
          {snapshot ? `${snapshot.info.assets} instruments · ${snapshot.info.strategies} strategies · ${snapshot.info.proofs} proofs` : "loading"}
          {snapshot ? ` · refreshed ${new Date(snapshot.loadedAt).toLocaleTimeString()}` : ""}
        </span>
      </footer>
    </main>
  );
}
