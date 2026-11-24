"use client";

import Link from "next/link";
import { useState } from "react";

import { Empty, Field, KeyValue, Leg, Panel, Tag, statusTone } from "../console-ui";
import { usePortfolio, useVault } from "../vault-context";
import { readOne, short } from "../../lib/synthforge";

const DEFAULT_THESIS =
  "US real yields are rolling over while dollar liquidity stays firm. Keep the book long risk, " +
  "fund the low-risk sleeve from stable synthetics, and cap the high-vol sleeve at policy.";

export default function StrategiesRoom() {
  const { address, act, busy, wallet } = useVault();
  const { portfolio, strategies } = usePortfolio();
  const [selected, setSelected] = useState<string | null>(null);
  const [thesis, setThesis] = useState(DEFAULT_THESIS);
  const [horizon, setHorizon] = useState("90");
  const [promptText, setPromptText] = useState<string | null>(null);
  const [promptError, setPromptError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);

  const current = strategies.find((row) => row.strategy_id === selected) ?? strategies[0] ?? null;
  const portfolioId = portfolio?.portfolio_id ?? "PF-0001";

  const previewPrompt = async () => {
    setReading(true);
    setPromptError(null);
    try {
      const raw = await readOne(address, "preview_prompt", [portfolioId, thesis, Number(horizon) || 90]);
      setPromptText(typeof raw === "string" ? raw : JSON.stringify(raw, null, 2));
    } catch (error) {
      setPromptText(null);
      setPromptError(error instanceof Error ? error.message : String(error));
    } finally {
      setReading(false);
    }
  };

  return (
    <>
      <div className="cx-grid four" style={{ marginBottom: 18 }}>
        <div className="cx-stat">
          <span>drafts on file</span>
          <strong className="mono">{strategies.length}</strong>
          <em>each one a full prompt transcript</em>
        </div>
        <div className="cx-stat">
          <span>active</span>
          <strong className="mono">{portfolio?.active_strategy_id || "none"}</strong>
          <em>{portfolio?.status ?? "no book"}</em>
        </div>
        <div className="cx-stat">
          <span>adjudicated</span>
          <strong className="mono">{strategies.filter((row) => row.adjudicated).length}</strong>
          <em>one ruling per strategy, ever</em>
        </div>
        <div className="cx-stat">
          <span>executed</span>
          <strong className="mono">{strategies.reduce((total, row) => total + Number(row.executions || 0), 0)}</strong>
          <em>executions that carried a proof</em>
        </div>
      </div>

      <div className="cx-split">
        <Panel title="The register" hint="newest last" tight>
          {strategies.length === 0 ? (
            <Empty>No strategies yet. Propose one below: the model drafts, the committee decides.</Empty>
          ) : (
            <table className="cx-table">
              <thead>
                <tr>
                  <th>id</th>
                  <th>regime</th>
                  <th>status</th>
                  <th className="num">conf</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {strategies.map((row) => (
                  <tr
                    key={row.strategy_id}
                    data-selected={current?.strategy_id === row.strategy_id ? "true" : "false"}
                    onClick={() => setSelected(row.strategy_id)}
                    style={{ cursor: "pointer" }}
                  >
                    <td>
                      <span className="sym">{row.strategy_id}</span>
                      <span className="sub">{row.created_at?.slice(0, 16)}</span>
                    </td>
                    <td>{row.regime}</td>
                    <td>
                      <Tag tone={statusTone(row.status)}>{row.status}</Tag>
                    </td>
                    <td className="num">{Number(row.confidence_bps) / 100}%</td>
                    <td>
                      {row.adjudicated ? <Tag tone="info">ruled</Tag> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel title="Draft detail" hint={current ? current.strategy_id : "nothing selected"}>
          {!current ? (
            <Empty>Select a draft to read its thesis and the wrapper it was judged against.</Empty>
          ) : (
            <>
              <KeyValue
                rows={[
                  ["regime", current.regime],
                  ["status", current.status],
                  ["confidence", `${Number(current.confidence_bps) / 100}%`],
                  ["horizon", `${current.horizon_days} days`],
                  ["author", <code key="a" className="cx-dig">{short(current.created_by, 8, 6)}</code>],
                  ["executions", String(current.executions)],
                  ["adjudicated", current.adjudicated ? "yes - a ruling is final" : "no"],
                  ["allocation digest", <code key="d" className="cx-dig">{current.digest}</code>],
                ]}
              />
              <div style={{ marginTop: 16 }}>
                <div className="cx-hint" style={{ marginBottom: 8 }}>
                  allocation
                </div>
                {Object.entries(current.allocation || {}).length === 0 ? (
                  <div className="cx-hint">allocation not recorded</div>
                ) : (
                  Object.entries(current.allocation)
                    .sort((a, b) => b[1] - a[1])
                    .map(([symbol, weight]) => <Leg key={symbol} symbol={symbol} weight={weight} />)
                )}
              </div>
              <div style={{ marginTop: 16 }}>
                <div className="cx-hint" style={{ marginBottom: 6 }}>
                  thesis
                </div>
                <p className="cx-note">{current.thesis}</p>
              </div>
              <div style={{ marginTop: 14 }}>
                <div className="cx-hint" style={{ marginBottom: 6 }}>
                  model rationale
                </div>
                <p className="cx-note">{current.rationale}</p>
              </div>
              <div className="cx-row" style={{ marginTop: 16 }}>
                <button
                  className="cx-btn"
                  data-tone="primary"
                  disabled={!wallet || busy !== null || current.status !== "ACTIVE"}
                  onClick={() => void act("execute_strategy", [portfolioId, current.strategy_id], "execute_strategy")}
                >
                  {busy === "execute_strategy" ? "executing…" : "execute this draft"}
                </button>
                <Link className="cx-btn" href="/proofs">
                  see its proofs
                </Link>
              </div>
              <p className="cx-hint" style={{ marginTop: 10 }}>
                Execution is the only step that moves capital, and it re-attests every price first.
              </p>
            </>
          )}
        </Panel>
      </div>

      <Panel title="Propose a new draft" hint="one model call, judged by every validator">
        <div className="cx-grid two">
          <div>
            <Field
              label="thesis"
              hint="the model reads this verbatim; vague theses get vague books, and validators notice"
            >
              <textarea value={thesis} onChange={(event) => setThesis(event.target.value)} />
            </Field>
            <Field label="horizon (days)" hint="must be between 1 and 365">
              <input value={horizon} onChange={(event) => setHorizon(event.target.value)} inputMode="numeric" />
            </Field>
            <div className="cx-row">
              <button
                className="cx-btn"
                data-tone="primary"
                disabled={!wallet || busy !== null || thesis.trim().length < 40}
                onClick={() => void act("generate_strategy", [portfolioId, thesis, Number(horizon) || 90], "generate_strategy")}
              >
                {busy === "generate_strategy" ? "waiting on consensus…" : "generate draft"}
              </button>
              <button className="cx-btn" data-tone="ghost" disabled={reading} onClick={() => void previewPrompt()}>
                {reading ? "reading…" : "preview the prompt"}
              </button>
            </div>
            <p className="cx-hint" style={{ marginTop: 10 }}>
              Generating is a read of the world, not a write of capital: the draft lands as PROPOSED and does nothing
              until it is executed.
            </p>
          </div>
          <div>
            <div className="cx-field">
              <label>prompt wrapper</label>
              <pre className="cx-pre" style={{ maxHeight: 320 }}>
                {promptText ?? (promptError ? `could not build the prompt: ${promptError}` : "Preview builds the exact prompt the committee will rerun: mandate, universe, policy caps and the JSON contract.")}
              </pre>
            </div>
          </div>
        </div>
      </Panel>
    </>
  );
}
