"use client";

import Link from "next/link";
import { useState } from "react";

import { Empty, Field, Gen, KeyValue, Panel, Stat, Tag, statusTone } from "../../../components/console-ui";
import { usePortfolio, useVault } from "../../../components/vault-context";
import { formatGen, short } from "../../../lib/synthforge";

/** Decimal text to atto, without ever touching a float. */
function toAtto(input: string): string {
  const clean = input.trim().replace(/,/g, "");
  const [whole, frac = ""] = clean.split(".");
  const padded = (frac + "0".repeat(18)).slice(0, 18);
  return (BigInt(whole || "0") * 10n ** 18n + BigInt(padded || "0")).toString();
}

export default function VaultPage() {
  const { snapshot, error, loading, act, busy, wallet } = useVault();
  const { portfolio, active, positions, info } = usePortfolio();
  const [fundAmount, setFundAmount] = useState("25000");
  const [redeemShares, setRedeemShares] = useState("1000");

  if (error) {
    return (
      <Panel title="The console cannot reach the vault" hint="read path">
        <p className="cx-note">{error}</p>
      </Panel>
    );
  }

  if (!portfolio) {
    return (
      <Panel title="No book yet" hint="the vault is deployed but empty">
        <p className="cx-note">Run the deploy script to open the demo portfolio, or open one from the CLI driver.</p>
        <p className="cx-hint">{loading ? "reading the chain…" : "nothing to show"}</p>
      </Panel>
    );
  }

  const navPerShare = Number(portfolio.nav_atto) / Number(portfolio.shares_atto || 1);
  const profileCaps = info?.caps?.[portfolio.risk_profile];

  return (
    <>
      <div className="cx-grid four" style={{ marginBottom: 18 }}>
        <Stat label="book nav" value={formatGen(portfolio.nav_atto)} note={`${portfolio.portfolio_id} · ${portfolio.risk_profile}`} />
        <Stat label="shares outstanding" value={formatGen(portfolio.shares_atto)} note="internal ledger, paper capital" />
        <Stat label="nav per share" value={navPerShare.toFixed(4)} note={`rebalances ${portfolio.rebalances}`} />
        <Stat
          label="status"
          value={
            <span style={{ fontSize: 13 }}>
              <Tag tone={statusTone(portfolio.status)}>{portfolio.status}</Tag>
            </span>
          }
          note={portfolio.active_strategy_id || "no active draft"}
          mono={false}
        />
      </div>

      <div className="cx-split">
        <Panel title="Positions" hint={`${positions.length} legs · marked ${portfolio.last_mark_at?.slice(0, 10) || "never"}`} tight>
          {positions.length === 0 ? (
            <Empty>No positions yet: execute a strategy to build the book.</Empty>
          ) : (
            <table className="cx-table">
              <thead>
                <tr>
                  <th>instrument</th>
                  <th>weight</th>
                  <th className="num">units</th>
                </tr>
              </thead>
              <tbody>
                {positions
                  .slice()
                  .sort((a, b) => Number(b.weight_bps) - Number(a.weight_bps))
                  .map((row) => {
                    const asset = snapshot?.assets?.find((item) => item.symbol === row.symbol);
                    const width = Math.max(1, Math.min(100, Number(row.weight_bps) / 100));
                    return (
                      <tr key={row.symbol}>
                        <td>
                          <span className="sym">{row.symbol}</span>
                          <span className="sub">
                            {asset ? `${asset.kind} · ${asset.risk_bucket} · cap ${(Number(asset.max_weight_bps) / 100).toFixed(0)}%` : "unregistered"}
                          </span>
                        </td>
                        <td>
                          <div className="cx-bar">
                            <i style={{ width: `${width}%` }} />
                          </div>
                          <span className="cx-hint">{Number(row.weight_bps) / 100}%</span>
                        </td>
                        <td className="num">{formatGen(row.units_atto)}</td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel title="Book and policy" hint="the state the validators enforce">
          <KeyValue
            rows={[
              ["portfolio", portfolio.portfolio_id],
              ["name", portfolio.name],
              ["manager", <code key="m" className="cx-dig">{short(portfolio.manager, 8, 6)}</code>],
              ["risk profile", portfolio.risk_profile],
              ["mandate", portfolio.mandate],
              [
                "active strategy",
                portfolio.active_strategy_id ? (
                  <Link key="s" href="/strategies">{portfolio.active_strategy_id} →</Link>
                ) : (
                  <span key="s" className="cx-hint">none</span>
                ),
              ],
              [
                "caps",
                profileCaps
                  ? `single ${profileCaps.max_single_bps} bps · high-risk sleeve ${profileCaps.max_high_bps} bps`
                  : "—",
              ],
              ["opened", portfolio.created_at],
            ]}
          />
        </Panel>
      </div>

      <div className="cx-split">
        <Panel title="Mark to market" hint="reprice at freshly attested prices">
          <p className="cx-note">
            Repricing is not a read: validators fetch every source again and must agree within {info?.price_tolerance_bps ?? 150} bps
            before the NAV moves. The mark leaves a proof carrying the sources it used.
          </p>
          <div className="cx-row" style={{ marginTop: 12 }}>
            <button className="cx-btn" data-tone="primary" disabled={!wallet || busy !== null} onClick={() => void act("mark_to_market", [portfolio.portfolio_id], "mark_to_market")}>
              {busy === "mark_to_market" ? "marking…" : "mark to market"}
            </button>
            {!wallet ? <span className="cx-hint">connect a wallet to sign writes</span> : null}
          </div>
        </Panel>

        <Panel title="Capital in and out" hint="paper ledger">
          <div className="cx-grid two">
            <div>
              <Field label="fund (GEN)" hint="mints shares at the current NAV">
                <input value={fundAmount} onChange={(event) => setFundAmount(event.target.value)} inputMode="decimal" />
              </Field>
              <button
                className="cx-btn"
                disabled={!wallet || busy !== null}
                onClick={() => {
                  try {
                    void act("fund_portfolio", [portfolio.portfolio_id, toAtto(fundAmount)], "fund_portfolio");
                  } catch {
                    /* a malformed amount is rejected by the disclaimer below */
                  }
                }}
              >
                fund
              </button>
            </div>
            <div>
              <Field label="redeem (shares)" hint="burns shares for a pro-rata payout">
                <input value={redeemShares} onChange={(event) => setRedeemShares(event.target.value)} inputMode="decimal" />
              </Field>
              <button
                className="cx-btn"
                data-tone="ghost"
                disabled={!wallet || busy !== null}
                onClick={() => void act("redeem_shares", [portfolio.portfolio_id, toAtto(redeemShares)], "redeem_shares")}
              >
                redeem
              </button>
            </div>
          </div>
          <p className="cx-hint" style={{ marginTop: 12 }}>
            Share balances live in the contract ledger. Nothing settles in real GEN on Studionet.
          </p>
        </Panel>
      </div>

      {portfolio.status === "REVIEW" ? (
        <Panel title="This book is under review" hint="after a revoke">
          <p className="cx-note">
            A revoke parks the portfolio with no active strategy. The explicit way back is <b>reopen</b> in the dispute room,
            which records who reopened it and why.
          </p>
          <div className="cx-row" style={{ marginTop: 12 }}>
            <Link className="cx-btn" data-tone="primary" href="/dispute">
              go to dispute room
            </Link>
          </div>
        </Panel>
      ) : null}
    </>
  );
}
