"use client";

import { useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";

export type DeckLeaf = { href: string; index: string; label: string; node: ReactNode };

/**
 * One folio, six leaves. The rooms are mounted together and the deck slides
 * sideways, so pressing a room moves the book instead of replacing the page:
 * the rail, the masthead and the wallet state stay exactly where they were.
 */
export function ConsoleDeck({ leaves, active }: { leaves: DeckLeaf[]; active: number }) {
  const router = useRouter();

  // A new leaf starts at its own head, like opening a later page of a document.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [active]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable)) return;
      if (event.key === "ArrowRight" && active < leaves.length - 1) {
        event.preventDefault();
        router.push(leaves[active + 1].href);
      }
      if (event.key === "ArrowLeft" && active > 0) {
        event.preventDefault();
        router.push(leaves[active - 1].href);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, leaves, router]);

  const previous = active > 0 ? leaves[active - 1] : null;
  const next = active < leaves.length - 1 ? leaves[active + 1] : null;

  return (
    <div className="cx-deck-wrap">
      <div className="cx-deck">
        {leaves.map((leaf, position) => (
          <section
            key={leaf.href}
            className="cx-slide"
            aria-label={leaf.label}
            aria-hidden={position === active ? undefined : true}
            data-state={position === active ? "active" : position < active ? "before" : "after"}
            {...({ inert: position === active ? undefined : "" } as Record<string, unknown>)}
          >
            {leaf.node}
          </section>
        ))}
      </div>

      <nav className="cx-leaf-nav" aria-label="Leaves of the book">
        <button
          type="button"
          className="cx-btn"
          data-tone="ghost"
          disabled={!previous}
          onClick={() => previous && router.push(previous.href)}
        >
          ← {previous ? previous.label : "cover"}
        </button>
        <span className="cx-leaf-count">
          {leaves[active].index} / {String(leaves.length).padStart(2, "0")} · {leaves[active].label}
        </span>
        <button
          type="button"
          className="cx-btn"
          data-tone="ghost"
          disabled={!next}
          onClick={() => next && router.push(next.href)}
        >
          {next ? next.label : "end"} →
        </button>
      </nav>
    </div>
  );
}
