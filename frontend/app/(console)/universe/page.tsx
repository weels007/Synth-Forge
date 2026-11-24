"use client";

import { useState } from "react";

import { Empty, Field, Panel, Tag } from "../../../components/console-ui";
import { useVault } from "../../../components/vault-context";

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

export default function UniversePage() {
  const { snapshot, wallet, act, busy } = useVault();
  const [form, setForm] = useState(EMPTY);
  const assets = snapshot?.assets ?? [];
  const info = snapshot?.info ?? null;
  const isOwner = Boolean(wallet && info && wallet.address.toLowerCase() === info.owner.toLowerCase());

  const set = (key: keyof typeof EMPTY) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));

  return (
    <>
      <div className="cx-grid four" style={{ marginBottom: 18 }}>
        <div className="cx-stat">
          <span>instruments</span>
          <strong className="mono">{assets.length}</strong>
          <em>{assets.filter((row) => row.enabled).length} enabled</em>
        </div>
        <div className="cx-stat">
          <span>high-risk cap sleeve</span>
          <strong className="mono">{info ? `${info.caps?.BALANCED?.max_high_bps ?? "-"} bps` : "-"}</strong>
          <em>per profile, from storage</em>
        </div>
        <div className="cx-stat">
          <span>price tolerance</span>
          <strong className="mono">{info ? `${info.price_tolerance_bps} bps` : "-"}</strong>
          <em>validators must land inside it</em>
        </div>
        <div className="cx-stat">
          <span>owner</span>
          <strong className="mono" style={{ fontSize: 13 }}>
            {info ? `${info.owner.slice(0, 6)}…${info.owner.slice(-4)}` : "-"}
          </strong>
          <em>{isOwner ? "this wallet" : "registry is owner-gated"}</em>
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

      <div className="cx-split">
        <Panel title="Register an instrument" hint="owner only">
          {!isOwner ? (
            <p className="cx-note">
              The registry is owner-gated. Connect the owner wallet to add or disable an instrument; everyone else can
              read the universe and the caps it enforces.
            </p>
          ) : null}
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
              <Field label="reference url" hint="must be http(s); validators fetch it at every fill">
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
            disabled={!isOwner || busy !== null || form.symbol.trim() === "" || form.name.trim() === ""}
            onClick={() =>
              void act(
                "register_asset",
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
                "register_asset",
              )
            }
          >
            register
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
                <dt>weight band</dt>
                <dd>{info.max_weight_delta_bps} bps per leg, {info.max_l1_delta_bps} bps L1</dd>
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
