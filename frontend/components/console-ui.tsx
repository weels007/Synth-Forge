import type { ReactNode } from "react";

import { formatGen, short } from "../lib/synthforge";

export function Panel({
  title,
  hint,
  children,
  tight = false,
}: {
  title: string;
  hint?: ReactNode;
  children: ReactNode;
  tight?: boolean;
}) {
  return (
    <section className="cx-panel">
      <header>
        <h2>{title}</h2>
        {hint ? <span className="hint">{hint}</span> : null}
      </header>
      <div className={tight ? "cx-panel-body tight" : "cx-panel-body"}>{children}</div>
    </section>
  );
}

export function Stat({ label, value, note, mono = true }: { label: string; value: ReactNode; note?: ReactNode; mono?: boolean }) {
  return (
    <div className="cx-stat">
      <span>{label}</span>
      <strong className={mono ? "mono" : undefined}>{value}</strong>
      {note ? <em>{note}</em> : null}
    </div>
  );
}

export function Tag({ tone, children }: { tone: "ok" | "warn" | "bad" | "info" | "mute"; children: ReactNode }) {
  return <span className={`cx-tag ${tone}`}>{children}</span>;
}

export function statusTone(status: string): "ok" | "warn" | "bad" | "mute" {
  if (status === "LIVE" || status === "ACTIVE") return "ok";
  if (status === "REVIEW" || status === "OPEN" || status === "PROPOSED") return "warn";
  if (status === "REVOKED" || status === "HALTED") return "bad";
  return "mute";
}

export function Leg({ symbol, weight, max = 10000, tone }: { symbol: string; weight: number; max?: number; tone?: "warn" }) {
  const width = Math.max(1, Math.min(100, (Number(weight) / max) * 100));
  return (
    <div className="cx-leg">
      <span className="sym">{symbol}</span>
      <div className={tone === "warn" ? "cx-bar warn" : "cx-bar"}>
        <i style={{ width: `${width}%` }} />
      </div>
      <span className="num">{(Number(weight) / 100).toFixed(2)}%</span>
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="cx-field">
      <label>{label}</label>
      {children}
      {hint ? <small>{hint}</small> : null}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="cx-empty">{children}</div>;
}

export function KeyValue({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="cx-kv">
      {rows.map(([key, value]) => (
        <div key={key}>
          <dt>{key}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function NoticeBar() {
  return null;
}

export function Address({ value }: { value: string }) {
  return <code className="cx-dig">{short(value, 8, 6)}</code>;
}

export function Gen({ atto }: { atto: number | string | bigint }) {
  return <>{formatGen(atto)}</>;
}
