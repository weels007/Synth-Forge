"use client";

import { useState } from "react";

import { Empty, Field, Panel, Tag, statusTone } from "../console-ui";
import { usePortfolio, useVault } from "../vault-context";
import { short } from "../../lib/synthforge";

export default function DisputeRoom() {
  const { act, busy, wallet, snapshot } = useVault();
  const { portfolio, strategies, info } = usePortfolio();
  const [strategyId, setStrategyId] = useState("");
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");

  // No invented id: until the snapshot lands there is no portfolio to name.
  const portfolioId = portfolio?.portfolio_id ?? "";
  // The contract publishes its minimum; 40 is only its documented default.
  const minChars = info?.min_reason_chars ?? 40;
  const openDrafts = strategies.filter((row) => row.status === "ACTIVE" && !row.adjudicated);
  const target = openDrafts.find((row) => row.strategy_id === strategyId) ?? openDrafts[0] ?? null;
  const rulings = (snapshot?.proofs ?? []).filter((row) => row.kind === "CHALLENGE").slice().reverse();
  const latest = rulings[0] ?? null;
  const underReview = portfolio?.status === "REVIEW";

  return (
    <>
      <div className="cx-grid four" style={{ marginBottom: 18 }}>
        <div className="cx-stat">
          <span>book status</span>
          <strong style={{ fontSize: 13 }}>
            <Tag tone={statusTone(portfolio?.status ?? "UNKNOWN")}>{portfolio?.status ?? "UNKNOWN"}</Tag>
          </strong>
          <em>{portfolio?.active_strategy_id || "no active strategy"}</em>
        </div>
        <div className="cx-stat">
          <span>challengeable</span>
          <strong className="mono">{openDrafts.length}</strong>
          <em>active drafts without a ruling</em>
        </div>
        <div className="cx-stat">
          <span>rulings recorded</span>
          <strong className="mono">{rulings.length}</strong>
          <em>each one final for its strategy</em>
        </div>
        <div className="cx-stat">
          <span>grounds required</span>
          <strong className="mono">{minChars}+ chars</strong>
          <em>a bare objection is rejected</em>
        </div>
      </div>

      <div className="cx-split">
        <Panel title="Challenge an active book" hint="anyone may file; the ruling is final">
          {openDrafts.length === 0 ? (
            <Empty>No challengeable draft: either nothing is active or the book has already been ruled on.</Empty>
          ) : (
            <>
              <Field label="strategy under challenge">
                <select value={target?.strategy_id ?? ""} onChange={(event) => setStrategyId(event.target.value)}>
                  {openDrafts.map((row) => (
                    <option key={row.strategy_id} value={row.strategy_id}>
                      {row.strategy_id} · {row.regime} · conf {Number(row.confidence_bps) / 100}%
                    </option>
                  ))}
                </select>
              </Field>
              <Field
                label="the case"
                hint={`${reason.trim().length}/${minChars} characters minimum. State the breach you allege: cap, mandate, concentration, missing hedge or thesis contradiction.`}
              >
                <textarea
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="The book concentrates 6,000 bps in correlated crypto beta while the mandate names a duration sleeve that is absent from every leg."
                />
              </Field>
              <div className="cx-row">
                <button
                  className="cx-btn"
                  data-tone="danger"
                  disabled={!wallet || busy !== null || !portfolioId || reason.trim().length < minChars || !target}
                  onClick={() => {
                    if (!target) return;
                    void act("challenge_strategy", [portfolioId, target.strategy_id, reason], "challenge_strategy");
                  }}
                >
                  {busy === "challenge_strategy" ? "waiting on the committee…" : "file challenge"}
                </button>
                {!wallet ? <span className="cx-hint">connect a wallet to file</span> : null}
              </div>
              <p className="cx-note" style={{ marginTop: 14 }}>
                A challenge spawns an independent adjudication: validators rerun the same prompt and must agree on both the
                verdict and the cited grounds. Objective cap or coverage breaches are computed in Python before the model
                speaks, and outrank it.
              </p>
            </>
          )}
        </Panel>

        <Panel
          title="Latest ruling"
          hint={latest ? `${latest.proof_id} · ${latest.verdict}` : "no ruling yet"}
        >
          {!latest ? (
            <Empty>The book has never been adjudicated.</Empty>
          ) : (
            <>
              <div className="cx-row" style={{ marginBottom: 12 }}>
                <Tag tone={latest.verdict === "UPHOLD" ? "ok" : "bad"}>{latest.verdict}</Tag>
                {(latest.evidence.violations ?? []).map((code) => (
                  <Tag key={code} tone="warn">
                    {code}
                  </Tag>
                ))}
              </div>
              <p className="cx-note">{latest.verdict_detail}</p>
              <dl className="cx-kv" style={{ marginTop: 14 }}>
                <div>
                  <dt>strategy</dt>
                  <dd>{latest.strategy_id}</dd>
                </div>
                <div>
                  <dt>ruled by</dt>
                  <dd>
                    <code className="cx-dig">{short(latest.executor, 8, 6)}</code>
                  </dd>
                </div>
                <div>
                  <dt>prompt digest</dt>
                  <dd>
                    <code className="cx-dig">{latest.input_digest}</code>
                  </dd>
                </div>
                <div>
                  <dt>when</dt>
                  <dd>{latest.created_at}</dd>
                </div>
              </dl>
            </>
          )}
        </Panel>
      </div>

      <Panel title="Reopen the book" hint="the only way out of REVIEW">
        {!underReview ? (
          <p className="cx-note">
            The book is <b>{portfolio?.status ?? "unknown"}</b>, not under review. Reopen is a deliberate transition: it
            only applies after a revoke has parked the portfolio, and it is limited to the manager or the owner.
          </p>
        ) : (
          <>
            <p className="cx-note">
              A revoke cleared the active strategy and parked the book. Reopening restores it to LIVE with no strategy
              attached, and records who did it and why. Generate and execute a fresh draft afterwards.
            </p>
            <Field label="reopen note" hint={`at least ${minChars} characters; it lands in the proof evidence`}>
              <textarea
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="Post-revoke review complete: the mandate was restated, caps re-verified and the crypto sleeve reduced."
              />
            </Field>
            <button
              className="cx-btn"
              data-tone="primary"
              disabled={!wallet || busy !== null || !portfolioId || note.trim().length < minChars}
              onClick={() => void act("reopen_portfolio", [portfolioId, note], "reopen_portfolio")}
            >
              {busy === "reopen_portfolio" ? "reopening…" : "reopen portfolio"}
            </button>
          </>
        )}
      </Panel>

      <Panel title="Settled strategies" hint="one ruling each, enforced by state" tight>
        {strategies.filter((row) => row.adjudicated).length === 0 ? (
          <Empty>No strategy has been adjudicated yet.</Empty>
        ) : (
          <table className="cx-table">
            <thead>
              <tr>
                <th>strategy</th>
                <th>regime</th>
                <th>status</th>
                <th>executions</th>
              </tr>
            </thead>
            <tbody>
              {strategies
                .filter((row) => row.adjudicated)
                .map((row) => {
                  const ruling = rulings.find((proof) => proof.strategy_id === row.strategy_id);
                  return (
                    <tr key={row.strategy_id}>
                      <td>
                        <span className="sym">{row.strategy_id}</span>
                        <span className="sub">{ruling ? `${ruling.verdict} · ${ruling.proof_id}` : "ruled"}</span>
                      </td>
                      <td>{row.regime}</td>
                      <td>
                        <Tag tone={statusTone(row.status)}>{row.status}</Tag>
                      </td>
                      <td>{row.executions}</td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        )}
      </Panel>
    </>
  );
}
