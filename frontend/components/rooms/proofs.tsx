"use client";

import { Fragment, useState } from "react";

import { Empty, Panel, Tag } from "../console-ui";
import { usePortfolio, useVault } from "../vault-context";
import { formatGen, short, type Proof, type ProofEvidence } from "../../lib/synthforge";

const ORDER = ["STRATEGY_APPROVAL", "REBALANCE", "MARK", "CHALLENGE", "REOPEN", "PORTFOLIO_OPEN", "DEPOSIT", "REDEMPTION"];

function verdictTone(verdict: string): "ok" | "bad" | "warn" | "mute" {
  if (verdict === "UPHOLD") return "ok";
  if (verdict === "REVOKE") return "bad";
  if (verdict === "ACCEPTED" || verdict === "EXECUTED") return "ok";
  return "mute";
}

function Evidence({ evidence }: { evidence: ProofEvidence }) {
  const sources = evidence.sources ?? [];
  const violations = evidence.violations ?? [];
  const hasAnything =
    sources.length > 0 ||
    violations.length > 0 ||
    Boolean(evidence.note) ||
    Boolean(evidence.target_weights) ||
    Boolean(evidence.prompt_digest);

  if (!hasAnything) {
    return <div className="cx-hint">no evidence payload committed for this proof</div>;
  }

  return (
    <div style={{ display: "grid", gap: 12 }}>
      {sources.length > 0 ? (
        <div>
          <div className="cx-hint" style={{ marginBottom: 6 }}>
            sources attested at execution
          </div>
          <table className="cx-table">
            <thead>
              <tr>
                <th>symbol</th>
                <th>feed</th>
                <th className="num">price (atto)</th>
              </tr>
            </thead>
            <tbody>
              {sources.map((row) => (
                <tr key={row.symbol}>
                  <td className="sym">{row.symbol}</td>
                  <td>
                    <code className="cx-dig">{row.url}</code>
                    <span className="sub">path {row.path}</span>
                  </td>
                  <td className="num">{row.price_atto}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {violations.length > 0 ? (
        <div className="cx-row">
          <span className="cx-hint">cited grounds</span>
          {violations.map((code) => (
            <Tag key={code} tone="bad">
              {code}
            </Tag>
          ))}
        </div>
      ) : null}

      {evidence.target_weights ? (
        <div>
          <div className="cx-hint" style={{ marginBottom: 6 }}>
            target weights it executed ({evidence.turnover_bps ?? "?"} bps turnover)
          </div>
          <div className="cx-row">
            {Object.entries(evidence.target_weights).map(([symbol, weight]) => (
              <Tag key={symbol} tone="mute">
                {symbol} {Number(weight) / 100}%
              </Tag>
            ))}
          </div>
        </div>
      ) : null}

      {evidence.note ? <p className="cx-note">{evidence.note}</p> : null}
      {evidence.previous_status ? (
        <div className="cx-hint">transition from {evidence.previous_status}</div>
      ) : null}
      {evidence.prompt_digest ? (
        <div className="cx-hint">prompt digest {evidence.prompt_digest}</div>
      ) : null}
    </div>
  );
}

export default function ProofsRoom() {
  const { snapshot } = useVault();
  const { portfolio } = usePortfolio();
  const [kind, setKind] = useState("ALL");
  const [open, setOpen] = useState<string | null>(null);

  // list_proofs already returns newest first; reversing it here would put the
  // oldest transition at the top and mislabel it as the latest.
  const proofs: Proof[] = snapshot?.proofs ?? [];
  const filtered = kind === "ALL" ? proofs : proofs.filter((row) => row.kind === kind);
  const counts = proofs.reduce<Record<string, number>>((acc, row) => {
    acc[row.kind] = (acc[row.kind] ?? 0) + 1;
    return acc;
  }, {});
  const kinds = ["ALL", ...ORDER.filter((item) => (counts[item] ?? 0) > 0)];

  return (
    <>
      <div className="cx-grid four" style={{ marginBottom: 18 }}>
        <div className="cx-stat">
          <span>proofs anchored</span>
          <strong className="mono">{proofs.length}</strong>
          <em>append only</em>
        </div>
        <div className="cx-stat">
          <span>price attestations</span>
          <strong className="mono">{(counts.REBALANCE ?? 0) + (counts.MARK ?? 0)}</strong>
          <em>rebalance + mark</em>
        </div>
        <div className="cx-stat">
          <span>adjudications</span>
          <strong className="mono">{counts.CHALLENGE ?? 0}</strong>
          <em>one per strategy</em>
        </div>
        <div className="cx-stat">
          <span>latest</span>
          <strong className="mono">{proofs[0]?.proof_id ?? "-"}</strong>
          <em>{proofs[0]?.created_at?.slice(0, 19) ?? "empty ledger"}</em>
        </div>
      </div>

      <div className="cx-row" style={{ marginBottom: 14 }}>
        {kinds.map((item) => (
          <button
            key={item}
            className="cx-btn"
            data-tone={kind === item ? "primary" : "ghost"}
            onClick={() => setKind(item)}
          >
            {item === "ALL" ? `all ${proofs.length}` : `${item} ${counts[item] ?? 0}`}
          </button>
        ))}
      </div>

      <Panel
        title="Ledger"
        hint={portfolio ? `${portfolio.portfolio_id} · newest first · click a row for its inputs` : "newest first"}
        tight
      >
        {filtered.length === 0 ? (
          <Empty>No proofs of this kind yet.</Empty>
        ) : (
          <table className="cx-table">
            <thead>
              <tr>
                <th>proof</th>
                <th>kind</th>
                <th>verdict</th>
                <th className="num">nav before</th>
                <th className="num">nav after</th>
                <th className="num">l1 bps</th>
                <th>when</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => (
                <Fragment key={row.proof_id}>
                  <tr
                    data-selected={open === row.proof_id ? "true" : "false"}
                    style={{ cursor: "pointer" }}
                    onClick={() => setOpen(open === row.proof_id ? null : row.proof_id)}
                  >
                    <td>
                      <span className="sym">{row.proof_id}</span>
                      <span className="sub">{short(row.executor, 6, 4)}</span>
                    </td>
                    <td>{row.kind}</td>
                    <td>
                      <Tag tone={verdictTone(row.verdict)}>{row.verdict}</Tag>
                    </td>
                    <td className="num">{formatGen(row.nav_before_atto)}</td>
                    <td className="num">{formatGen(row.nav_after_atto)}</td>
                    <td className="num">{row.weight_l1_bps}</td>
                    <td>{row.created_at?.slice(0, 16)}</td>
                  </tr>
                  {open === row.proof_id ? (
                    <tr key={`${row.proof_id}-detail`}>
                      <td colSpan={7} style={{ background: "var(--c-panel-2)" }}>
                        <div style={{ display: "grid", gap: 12 }}>
                          <p className="cx-note" style={{ margin: 0 }}>
                            {row.verdict_detail}
                          </p>
                          <div className="cx-grid two">
                            <div className="cx-kv">
                              <div>
                                <dt>allocation digest</dt>
                                <dd>
                                  <code className="cx-dig">{row.allocation_digest}</code>
                                </dd>
                              </div>
                              <div>
                                <dt>input digest</dt>
                                <dd>
                                  <code className="cx-dig">{row.input_digest}</code>
                                </dd>
                              </div>
                              <div>
                                <dt>strategy</dt>
                                <dd>{row.strategy_id || "-"}</dd>
                              </div>
                            </div>
                          </div>
                          <Evidence evidence={row.evidence} />
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel title="What a proof commits to" hint="why this is not a log line">
        <p className="cx-note">
          A proof binds the decision to its inputs: the allocation digest covers the weights that were approved, the
          input digest covers the prompt or the price sources, and the evidence block carries the exact URLs, JSON paths
          and prices the execution ran on. Re-running the same decision against the same sources is the audit, and it
          needs no trust in this page.
        </p>
      </Panel>
    </>
  );
}
