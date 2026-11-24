"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { createElement } from "react";

import { NETWORK, short } from "../lib/synthforge";
import { ConsoleDeck } from "./console-deck";
import DisputeRoom from "./rooms/dispute";
import HowItWorksRoom from "./rooms/how-it-works";
import ProofsRoom from "./rooms/proofs";
import StrategiesRoom from "./rooms/strategies";
import UniverseRoom from "./rooms/universe";
import VaultRoom from "./rooms/vault";
import { usePortfolio, useVault } from "./vault-context";

const PAGES = [
  { href: "/vault", index: "01", label: "Vault", title: "Vault overview", blurb: "One book, its status, its positions", Room: VaultRoom },
  { href: "/strategies", index: "02", label: "Strategies", title: "Strategy desk", blurb: "Propose, execute, inspect", Room: StrategiesRoom },
  { href: "/proofs", index: "03", label: "Proofs", title: "Proof ledger", blurb: "Every transition and the inputs behind it", Room: ProofsRoom },
  { href: "/universe", index: "04", label: "Universe", title: "Synthetic universe", blurb: "Feeds, buckets and caps", Room: UniverseRoom },
  { href: "/dispute", index: "05", label: "Dispute", title: "Dispute room", blurb: "Challenge a book, read the ruling", Room: DisputeRoom },
  { href: "/how-it-works", index: "06", label: "How it works", title: "How the consensus works", blurb: "The three paths to agreement", Room: HowItWorksRoom },
];

export function ConsoleShell() {
  const pathname = usePathname();
  const { address, wallet, connect, reload, loading, snapshot, notice } = useVault();
  const { portfolio } = usePortfolio();
  const active = Math.max(0, PAGES.findIndex((page) => pathname?.startsWith(page.href)));
  const current = PAGES[active];
  const paused = snapshot?.info?.paused;

  return (
    <div className="cx">
      <aside className="cx-rail">
        <div className="cx-brand">
          <div className="mark">S</div>
          <div>
            <b>SynthForge</b>
            <span>Operations ledger</span>
          </div>
        </div>

        <nav className="cx-nav">
          {PAGES.map((page) => (
            <Link key={page.href} href={page.href} data-active={page.href === current.href ? "true" : "false"}>
              <i>{page.index}</i>
              <span>{page.label}</span>
              <b>›</b>
            </Link>
          ))}
        </nav>

        <div className="cx-rail-foot">
          <div>prospectus · book no. 001</div>
          <div>
            <b>{NETWORK.name}</b> · chain {NETWORK.chainId}
          </div>
          <div>contract {address ? short(address, 6, 4) : "-"}</div>
          <div>vault {paused ? "PAUSED" : "OPEN"}</div>
          <div style={{ marginTop: 10 }}>
            <Link href="/">← cover page</Link>
          </div>
        </div>
      </aside>

      <main className="cx-main">
        <header className="cx-top" key={current.href}>
          <div>
            <div className="eyebrow">
              {current.index} · {current.blurb}
            </div>
            <h1>{current.title}</h1>
          </div>
          <div className="cx-top-side">
            <span className="cx-clock">
              {portfolio ? `${portfolio.portfolio_id} · ${portfolio.status}` : "no book"}
            </span>
            <button className="cx-btn" data-tone="ghost" onClick={() => void reload()} disabled={loading}>
              {loading ? "reading…" : "reload"}
            </button>
            {wallet ? (
              <span className="cx-tag ok">{short(wallet.address, 6, 4)}</span>
            ) : (
              <button className="cx-btn" data-tone="primary" onClick={() => void connect()}>
                connect wallet
              </button>
            )}
          </div>
        </header>

        <div className="cx-body">
          {notice ? (
            <div className={`cx-notice ${notice.kind}`}>
              <div>{notice.text}</div>
              {notice.hash ? <code>tx {notice.hash}</code> : null}
              {notice.status ? <div className="stamp-line">{notice.status} receipts are reorg-visible until finalized</div> : null}
            </div>
          ) : null}

          <ConsoleDeck
            active={active}
            leaves={PAGES.map((page) => ({
              href: page.href,
              index: page.index,
              label: page.label,
              node: createElement(page.Room),
            }))}
          />
        </div>
      </main>
    </div>
  );
}
