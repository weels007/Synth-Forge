"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { NETWORK, short } from "../lib/synthforge";
import { usePortfolio, useVault } from "./vault-context";

const PAGES: { href: string; index: string; label: string; title: string; blurb: string }[] = [
  { href: "/vault", index: "01", label: "Vault", title: "Vault overview", blurb: "One book, its status, its positions" },
  { href: "/strategies", index: "02", label: "Strategies", title: "Strategy desk", blurb: "Propose, execute, inspect" },
  { href: "/proofs", index: "03", label: "Proofs", title: "Proof ledger", blurb: "Every transition and the inputs behind it" },
  { href: "/universe", index: "04", label: "Universe", title: "Synthetic universe", blurb: "Feeds, buckets and caps" },
  { href: "/dispute", index: "05", label: "Dispute", title: "Dispute room", blurb: "Challenge a book, read the ruling" },
  { href: "/how-it-works", index: "06", label: "How it works", title: "How the consensus works", blurb: "The three paths to agreement" },
];

export function ConsoleShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { address, wallet, connect, reload, loading, snapshot, notice } = useVault();
  const { portfolio } = usePortfolio();
  const current = PAGES.find((page) => pathname?.startsWith(page.href)) ?? PAGES[0];
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
            <Link key={page.href} href={page.href} data-active={pathname?.startsWith(page.href) ? "true" : "false"}>
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
        <header className="cx-top">
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
          {children}
        </div>
      </main>
    </div>
  );
}
