"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { NETWORK, formatGen, loadDeployment, loadSnapshot, short, type Snapshot, type SystemInfo } from "../../lib/synthforge";

/** The bands in the copy are the contract's, not a remembered default. */
function buildPaths(info: SystemInfo | null | undefined) {
  const band = info
    ? `${info.max_weight_delta_bps} bps per leg (${info.max_l1_delta_bps.toLocaleString('en-US')} bps L1)`
    : `the contract's per-leg and L1 bands`;
  const tolerance = info ? `${info.price_tolerance_bps} bps` : `the contract's tolerance`;
  return [
    {
      n: `Path one`,
      title: `The strategy is agreed, not trusted`,
      body: `A model drafts the book from the mandate and the attested universe. Every validator re-runs the same prompt and must land on the same regime, the same instruments, and weights within ${band} before any state moves.`,
      rule: `gl.vm.run_nondet_unsafe · leader + validator`,
    },
    {
      n: `Path two`,
      title: `Every price is attested at the fill`,
      body: `Each instrument points at a URL and a JSON path. Validators fetch it independently and must agree within ${tolerance}. The proof stores the exact sources and prices it executed on, so the fill can be re-read years later.`,
      rule: info ? `gl.nondet.web.get · ${info.price_tolerance_bps} bps tolerance` : `gl.nondet.web.get · attested price`,
    },
    {
      n: `Path three`,
      title: `A challenge is judged on its grounds`,
      body: `Anyone may challenge an active strategy and must state a case. The ruling is compared on the verdict and on the cited violations, a revoke must name at least one, and each strategy is adjudicated once.`,
      rule: `one ruling per strategy · REVOKE needs grounds`,
    },
  ];
}

const INDEX = [
  { href: "/vault", index: "01", label: "Vault", sub: "Status, NAV, positions, mark to market" },
  { href: "/strategies", index: "02", label: "Strategies", sub: "Propose a book, execute it, read the draft" },
  { href: "/proofs", index: "03", label: "Proof ledger", sub: "Every transition with the inputs behind it" },
  { href: "/universe", index: "04", label: "Universe", sub: "Feeds, buckets, per-instrument caps" },
  { href: "/dispute", index: "05", label: "Dispute room", sub: "Challenge a book, read the ruling, reopen" },
  { href: "/how-it-works", index: "06", label: "How it works", sub: "The three consensus paths in detail" },
];

export default function CoverPage() {
  const [address, setAddress] = useState<string>("");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadDeployment()
      .then(async (deployment) => {
        const target = deployment?.address ?? process.env.NEXT_PUBLIC_SYNTHFORGE_ADDRESS ?? "";
        if (!target) return;
        if (cancelled) return;
        setAddress(target);
        try {
          const loaded = await loadSnapshot(target);
          if (!cancelled) setSnapshot(loaded);
        } catch {
          /* the cover still reads as a prospectus when the chain is unreachable */
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const portfolio = snapshot?.portfolios?.[0] ?? null;
  const proofs = snapshot?.proofs?.length ?? 0;
  const strategies = snapshot?.strategies?.length ?? 0;
  const consensus = snapshot?.info;
  const live = portfolio?.status === "LIVE" || portfolio?.status === "OPEN";
  const paths = buildPaths(consensus);

  return (
    <div className="page">
      <header className="masthead">
        <div className="wordmark">
          <div className="seal-mark">S</div>
          <div>
            <h1>SynthForge</h1>
            <span className="kicker">generative synthetic assets · genlayer</span>
          </div>
        </div>
        <div className="folio">
          <div>
            {NETWORK.name} · chain {NETWORK.chainId}
          </div>
          <div>
            contract <b>{address ? short(address, 6, 4) : "not published"}</b>
          </div>
          <div>
            writes <b className={snapshot?.info?.paused ? "halted" : "live"}>{snapshot?.info?.paused ? "HALTED" : "OPEN"}</b>
          </div>
        </div>
      </header>

      <section className="certificate">
        <div className="guilloche" />
        <div className="cert-top">
          <div>
            <div className="cert-eyebrow">prospectus · synthetic book no. 001</div>
            <h2 className="cert-title">A portfolio the validators have to agree on.</h2>
            <p className="cert-mandate">
              SynthForge turns a mandate into a synthetic asset book: a model proposes the allocation, an independent
              committee re-runs it, and only consensus-agreed weights are allowed to move capital. Every proposal,
              fill and ruling leaves an execution proof anchored to the inputs that justified it.
            </p>
          </div>
          <div className={live ? "stamp" : "stamp review"}>
            {live ? "consensus open" : "in review"}
            <small>{portfolio ? portfolio.status : "studionet"}</small>
          </div>
        </div>

        <div className="cert-figures">
          <div className="figure">
            <span>book nav</span>
            <strong>{portfolio ? formatGen(portfolio.nav_atto) : "—"}</strong>
            <em>{portfolio ? `${portfolio.portfolio_id} · ${portfolio.risk_profile}` : "reading the chain"}</em>
          </div>
          <div className="figure">
            <span>strategies</span>
            <strong>{strategies}</strong>
            <em>{portfolio?.active_strategy_id || "no active draft"}</em>
          </div>
          <div className="figure">
            <span>execution proofs</span>
            <strong>{proofs}</strong>
            <em>each with its committed evidence</em>
          </div>
          <div className="figure">
            <span>consensus band</span>
            <strong>{consensus ? `${consensus.max_weight_delta_bps} bps` : "—"}</strong>
            <em>{consensus ? `L1 ${consensus.max_l1_delta_bps} · prices ${consensus.price_tolerance_bps}` : "per leg · L1 · feed"}</em>
          </div>
        </div>
      </section>

      <div className="section-label">
        <h2>Three paths to agreement</h2>
        <span>equivalence principle</span>
      </div>
      <div className="paths">
        {paths.map((path) => (
          <article className="path" key={path.n}>
            <div className="n">{path.n}</div>
            <h3>{path.title}</h3>
            <p>{path.body}</p>
            <div className="rule">{path.rule}</div>
          </article>
        ))}
      </div>

      <div className="section-label">
        <h2>The console</h2>
        <span>six rooms, one ledger</span>
      </div>
      <nav className="index">
        {INDEX.map((item) => (
          <Link href={item.href} key={item.href}>
            <i>{item.index}</i>
            <span>
              <b>{item.label}</b>
              <span className="sub">{item.sub}</span>
            </span>
            <em>open →</em>
          </Link>
        ))}
      </nav>

      <section className="limits">
        <h3>What this is, and what it is not</h3>
        <p>
          This is a working GenLayer deployment on Studionet with paper capital: shares are minted against an internal
          ledger and nothing settles in real GEN. What is real is the part the product is about — the model output, the
          price attestation and the adjudication are all decided by validator consensus, and each decision carries the
          evidence it was made on.
        </p>
      </section>

      <footer className="cover-foot">
        <div>SynthForge · intelligent contract on GenLayer · v{snapshot?.info?.version ?? "1.0.0"}</div>
        <div>
          <a href={`${NETWORK.explorer}/address/${address}`} target="_blank" rel="noreferrer">
            explorer
          </a>
          {"  ·  "}
          <Link href="/how-it-works">how the consensus works</Link>
        </div>
      </footer>
    </div>
  );
}
