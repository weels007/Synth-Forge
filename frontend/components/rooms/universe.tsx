"use client";

import { useState } from "react";

import { Empty, Field, Panel, Tag } from "../console-ui";
import { useVault } from "../vault-context";

const EMPTY = {
  symbol: "",
  name: "",
  kind: "INDEX",
  underlying: "",
  reference_url: "https://",
  price_path: "data.amount",
  risk_bucket: "MEDIUM",
  max_weight_bps: "3000",
};

const TONE: Record<string, "ok" | "warn" | "bad" | "mute"> = {
  ACTIVE: "ok",
  PENDING: "warn",
  REJECTED: "bad",
};

/** Feed prices come back as atto strings; show them the way a desk reads them. */
function priceOf(atto: string) {
  const value = Number(atto) / 1e18;
  if (!Number.isFinite(value) || value <= 0) return "-";
  return value.toLocaleString("en-US", { maximumFractionDigits: value >= 1000 ? 2 : 4 });
}

function short(address: string) {
  if (!address) return "-";
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export default function UniverseRoom() {
  const { snapshot, wallet, act, busy } = useVault();
  const [form, setForm] = useState(EMPTY);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const assets = snapshot?.assets ?? [];
  const proposals = [...(snapshot?.proposals ?? [])].sort((a, b) => {
    if (a.status === "PENDING" && b.status !== "PENDING") return -1;
    if (b.status === "PENDING" && a.status !== "PENDING") return 1;
    return b.proposed_at.localeCompare(a.proposed_at);
  });
  const pending = proposals.filter((row) => row.status === "PENDING");
  const info = snapshot?.info ?? null;
  const isOwner = Boolean(wallet && info && wallet.address.toLowerCase() === info.owner.toLowerCase());
  const minNote = info?.min_rejection_chars ?? 12;

  const set = (key: keyof typeof EMPTY) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));

  const propose = () =>
    act(
      "propose_asset",
      [
        form.symbol,
        form.name,
        form.kind,
        form.underlying,
        form.reference_url,
        form.price_path,
        form.risk_bucket,
        Number(form.max_weight_bps) || 3000,
      ],
      "propose_asset",
    );

  return (
    <>
      <div className="cx-grid four" style={{ marginBottom: 18 }}>
        <div className="cx-stat">
          <span>instruments</span>
          <strong className="mono">{assets.length}</strong>
          <em>{assets.filter((row) => row.enabled).length} enabled</em>
        </div>
        <div className="cx-stat">
          <span>open proposals</span>
          <strong className="mono">{pending.length}</strong>
          <em>waiting on the owner</em>
        </div>
        <div className="cx-stat">
          <span>probe tolerance</span>
          <strong className="mono">{info ? `${info.price_tolerance_bps} bps` : "-"}</strong>
          <em>validators must read the same print</em>
        </div>
        <div className="cx-stat">
          <span>owner</span>
          <strong className="mono" style={{ fontSize: 13 }}>
            {info ? short(info.owner) : "-"}
          </strong>
          <em>{isOwner ? "this wallet" : "any wallet may propose"}</em>
        </div>
      </div>

      <Panel title="Registered synthetics" hint="the only instruments a strategy may cite" tight>
        {assets.length === 0 ? (
          <Empty>No instruments registered.</Empty>
        ) : (
          <table className="cx-table">
            <thead>
              <tr>
                <th>symbol</th>
                <th>kind</th>
                <th>bucket</th>
                <th>feed</th>
                <th className="num">cap</th>
                <th>state</th>
              </tr>
            </thead>
            <tbody>
              {assets.map((row) => (
                <tr key={row.symbol}>
                  <td>
                    <span className="sym">{row.symbol}</span>
                    <span className="sub">{row.name}</span>
                  </td>
                  <td>{row.kind}</td>
                  <td>
                    <Tag tone={row.risk_bucket === "HIGH" ? "bad" : row.risk_bucket === "LOW" ? "ok" : "warn"}>
                      {row.risk_bucket}
                    </Tag>
                  </td>
                  <td>
                    <code className="cx-dig">{row.reference_url}</code>
                    <span className="sub">{row.price_path}</span>
                  </td>
                  <td className="num">{Number(row.max_weight_bps) / 100}%</td>
                  <td>
                    {row.enabled ? <Tag tone="ok">enabled</Tag> : <Tag tone="mute">disabled</Tag>}
                    <button
                      className="cx-btn"
                      data-tone="ghost"
                      style={{ marginLeft: 8, padding: "3px 7px", fontSize: 9 }}
                      disabled={!isOwner || busy !== null}
                      onClick={() => void act("set_asset_enabled", [row.symbol, !row.enabled], "set_asset_enabled")}
                    >
                      {row.enabled ? "disable" : "enable"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel title="Proposal queue" hint="probes first, then the owner signs off" tight>
        <p className="cx-note" style={{ padding: "0 14px 12px" }}>
          Filing a symbol is open to every wallet. The contract will not store a proposal until a consensus probe
          fetches the reference feed and every validator reads the same print inside {info?.price_tolerance_bps ?? 150} bps.
          Activation re-probes the feed; a rejection needs a written note, and it is kept on the record.
        </p>
        {proposals.length === 0 ? (
          <Empty>No proposals yet. The queue is empty, the registry is not open to guesswork.</Empty>
        ) : (
          <div className="cx-queue">
            {proposals.map((row) => {
              const note = notes[row.symbol] ?? "";
              return (
                <div key={row.symbol} className="cx-queue-row">
                  <div className="cx-queue-main">
                    <div>
                      <span className="sym">{row.symbol}</span>
                      <span className="sub">{row.name}</span>
                    </div>
                    <div className="cx-queue-meta">
                      <Tag tone={TONE[row.status] ?? "mute"}>{row.status.toLowerCase()}</Tag>
                      <span>{row.kind}</span>
                      <span>{row.risk_bucket}</span>
                      <span>cap {Number(row.max_weight_bps) / 100}%</span>
                      <span>probe {priceOf(row.probe_price_atto)}</span>
                    </div>
                    <div className="cx-queue-sub">
                      <code className="cx-dig">{row.reference_url}</code>
                      <span className="sub">
                        {row.price_path} · filed by {short(row.proposed_by)} · {row.proposed_at.slice(0, 10)}
                      </span>
                      {row.status !== "PENDING" && row.decided_by ? (
                        <span className="sub">
                          {row.status === "ACTIVE" ? "activated" : "rejected"} by {short(row.decided_by)} ·
                          {" "}{row.decided_at.slice(0, 10)}
                          {row.note ? ` · ${row.note}` : ""}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  {row.status === "PENDING" ? (
                    <div className="cx-queue-actions">
                      <button
                        className="cx-btn"
                        data-tone="primary"
                        disabled={!isOwner || busy !== null}
                        onClick={() => void act("activate_asset", [row.symbol], "activate_asset")}
                      >
                        activate
                      </button>
                      <input
                        value={note}
                        onChange={(event) => setNotes((current) => ({ ...current, [row.symbol]: event.target.value }))}
                        placeholder={`why not canonical (${minNote}+ chars)`}
                        disabled={!isOwner || busy !== null}
                        style={{ minWidth: 190 }}
                      />
                      <button
                        className="cx-btn"
                        data-tone="danger"
                        disabled={!isOwner || busy !== null || note.trim().length < minNote}
                        onClick={() => void act("reject_asset", [row.symbol, note.trim()], "reject_asset")}
                      >
                        reject
                      </button>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </Panel>

      <div className="cx-split">
        <Panel title="Propose an instrument" hint="any wallet, consensus probe included">
          <p className="cx-note">
            The reference feed is fetched inside consensus: a 404, a non-JSON body or a path that misses the print
            aborts the proposal before storage, and the contract&apos;s own error is what comes back. The owner
            decides whether the
            source is canonical, because no consensus round can answer that question.
          </p>
          <div className="cx-grid two">
            <div>
              <Field label="symbol">
                <input value={form.symbol} onChange={set("symbol")} placeholder="SBTC" />
              </Field>
              <Field label="name">
                <input value={form.name} onChange={set("name")} placeholder="Synthetic Bitcoin" />
              </Field>
              <Field label="kind">
                <select value={form.kind} onChange={set("kind")}>
                  {["CRYPTO", "COMMODITY", "INDEX", "FX", "RATE", "EQUITY", "BASKET"].map((kind) => (
                    <option key={kind} value={kind}>
                      {kind}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="underlying">
                <input value={form.underlying} onChange={set("underlying")} placeholder="BTC" />
              </Field>
            </div>
            <div>
              <Field label="reference url" hint="must be http(s); probed now and again on activation">
                <input value={form.reference_url} onChange={set("reference_url")} />
              </Field>
              <Field label="price path" hint="dot path into the JSON body, e.g. data.amount">
                <input value={form.price_path} onChange={set("price_path")} />
              </Field>
              <Field label="risk bucket">
                <select value={form.risk_bucket} onChange={set("risk_bucket")}>
                  {["LOW", "MEDIUM", "HIGH"].map((bucket) => (
                    <option key={bucket} value={bucket}>
                      {bucket}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="max weight (bps)">
                <input value={form.max_weight_bps} onChange={set("max_weight_bps")} inputMode="numeric" />
              </Field>
            </div>
          </div>
          <button
            className="cx-btn"
            data-tone="primary"
            disabled={busy !== null || form.symbol.trim() === "" || form.name.trim() === ""}
            onClick={() => void propose()}
          >
            {busy === "propose_asset" ? "probing feed…" : "propose for review"}
          </button>
        </Panel>

        <Panel title="Caps the committee enforces" hint="from get_system_info">
          {!info ? (
            <Empty>Reading policy…</Empty>
          ) : (
            <dl className="cx-kv">
              {Object.entries(info.caps ?? {}).map(([profile, caps]) => (
                <div key={profile}>
                  <dt>{profile}</dt>
                  <dd>
                    single leg {caps.max_single_bps} bps · HIGH sleeve {caps.max_high_bps} bps
                  </dd>
                </div>
              ))}
              <div>
                <dt>validator rule</dt>
                <dd>{info.validator_mode} — every leg inside its cap, the full budget spent</dd>
              </div>
              <div>
                <dt>proposal gate</dt>
                <dd>consensus price probe within {info.price_tolerance_bps} bps, owner activation</dd>
              </div>
              <div>
                <dt>challenge grounds</dt>
                <dd>at least {info.min_reason_chars} characters, ruled once</dd>
              </div>
            </dl>
          )}
        </Panel>
      </div>
    </>
  );
}
