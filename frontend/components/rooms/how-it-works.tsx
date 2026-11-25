"use client";

import Link from "next/link";

import { KeyValue, Panel, Tag } from "../console-ui";
import { useVault } from "../vault-context";

const CODES: [string, string][] = [
  ["CAP_BREACH", "a leg or the HIGH-risk sleeve exceeds its policy cap"],
  ["SUM_MISMATCH", "the legs do not sum to 10,000 bps"],
  ["MANDATE_DRIFT", "the book no longer implements the stated mandate"],
  ["CONCENTRATION_RISK", "exposure is concentrated in correlated instruments"],
  ["MISSING_HEDGE", "protection the mandate requires is absent"],
  ["THESIS_CONTRADICTION", "the book contradicts its own stated thesis"],
  ["UNSUPPORTED_INSTRUMENT", "a leg is not an enabled instrument"],
];

export default function HowItWorksRoom() {
  const { snapshot, address } = useVault();
  const info = snapshot?.info ?? null;
  const portfolio = snapshot?.portfolios?.[0] ?? null;

  return (
    <>
      <Panel title="The claim" hint="read this before trusting a number on the other pages">
        <p className="cx-note" style={{ fontSize: 13.5 }}>
          SynthForge is a synthetic-asset vault whose decisions are made by a committee of GenLayer validators, not by
          the page you are reading. Four separate things have to reach agreement: whether an instrument's feed answers
          at all, the allocation a model proposes, the prices a fill is executed at, and the ruling a challenge
          receives. Each one is a separate consensus path with its own rule, and each one that moves state leaves a
          proof carrying the exact inputs it ran on.
        </p>
      </Panel>

      <Panel title="Lifecycle of a book" hint="the only path that moves capital">
        <div className="cx-flow">
          <div className="cx-step">
            <div className="idx">step 01</div>
            <div>
              <h3>Propose</h3>
              <p>
                The manager submits a thesis and a horizon. The contract builds a prompt from the mandate, the pinned
                universe (symbol, bucket, cap, feed URL, JSON path) and the policy limits, then asks a model for a full
                allocation as JSON. <b>No capital moves here.</b>
              </p>
              <ul className="cx-check">
                <li>the leader proposes; validators recompute the mandate, they do not re-run the model</li>
                <li>a book passes only if every leg is inside its cap and the budget is fully spent</li>
                <li>the draft lands ACTIVE with its digests and rationale; nothing moves until executed</li>
              </ul>
            </div>
          </div>
          <div className="cx-step">
            <div className="idx">step 02</div>
            <div>
              <h3>Attest prices</h3>
              <p>
                Execution fetches every leg from its registered URL and JSON path. Validators fetch independently and
                must land within the price tolerance, so a single lying feed cannot set the fill.
              </p>
              <ul className="cx-check">
                <li>per-source fetch, then the tolerance check on the attested number</li>
                <li>the proof stores symbol, URL, path and attested price</li>
                <li>the digest binds all four, so a proof cannot be reused for another feed</li>
              </ul>
            </div>
          </div>
          <div className="cx-step">
            <div className="idx">step 03</div>
            <div>
              <h3>Execute</h3>
              <p>
                The approved weights become positions at attested prices. Caps were already enforced before the book
                was storable; what executes here is cash, units and NAV, in Python, before any storage write. A
                REBALANCE proof records the target weights and the turnover it cost - measured, not a second gate.
              </p>
            </div>
          </div>
          <div className="cx-step">
            <div className="idx">step 04</div>
            <div>
              <h3>Mark to market</h3>
              <p>
                Anyone can reprice the book. It is a write, not a read: the sources are fetched again under consensus
                and the NAV only moves if the committee agrees. Use the vault page to run it and the proof ledger to
                check which sources it used.
              </p>
            </div>
          </div>
          <div className="cx-step">
            <div className="idx">step 05</div>
            <div>
              <h3>Challenge, and settle once</h3>
              <p>
                Any wallet may file a challenge with a stated case. The ruling is final for that strategy: state
                records the adjudication, so a second challenge cannot re-litigate a book or flip the portfolio twice.
              </p>
            </div>
          </div>
          <div className="cx-step">
            <div className="idx">step 06</div>
            <div>
              <h3>Recover explicitly</h3>
              <p>
                A revoke parks the portfolio in REVIEW with no active strategy. The way back is a named transition:
                the manager or owner reopens it with a note, which is recorded as a REOPEN proof. There is no implicit
                recovery hidden inside another call.
              </p>
            </div>
          </div>
        </div>
      </Panel>

      <div className="cx-split">
        <Panel title="Path 1 · strategy consensus" hint="the allocation itself">
          <p className="cx-note">
            The proposal is the financially binding output, so validators do not compare prose or even tickers twice:
            they recompute the mandate. A book passes only if every leg sits inside its profile cap, the weights sum to
            the full budget, and the regime is one the vault knows. A model that drifts in wording still lands; a book
            that breaks policy never does.
          </p>
          <div style={{ marginTop: 14 }}>
            <KeyValue
              rows={[
                ["rule", info ? info.validator_mode : "—"],
                ["budget", "each leg inside its cap, weights sum to 10,000 bps"],
                ["regime", "RISK_ON · NEUTRAL · RISK_OFF"],
                ["instrument set", "any subset of the attested universe"],
                ["on a breach", "the round rotates, no state written"],
              ]}
            />
          </div>
        </Panel>

        <Panel title="Path 2 · price attestation" hint="the fill price">
          <p className="cx-note">
            Each synthetic has one canonical feed. Validators fetch it themselves, parse the registered JSON path, and
            compare the attested number to the leader's within the tolerance. The agreement is on the number, not on the
            raw response text, so formatting noise cannot split the committee.
          </p>
          <div style={{ marginTop: 14 }}>
            <KeyValue
              rows={[
                ["tolerance", info ? `${info.price_tolerance_bps} bps` : "—"],
                ["source", "registered URL + dot path"],
                ["on digest", "symbol | url | path : price"],
                ["on failure", "[EXTERNAL] or [TRANSIENT], retried by the round"],
              ]}
            />
          </div>
        </Panel>
      </div>

      <Panel title="Path 3 · adjudication consensus" hint="the ruling, and its grounds">
        <p className="cx-note">
          A ruling is more than a verdict: it is the verdict plus the grounds it cites. Two nodes that agree on
          &quot;revoke&quot; but disagree on why would produce different audit trails, so both must match. To make that
          achievable, grounds come from a closed vocabulary and every objective breach is decided in Python before the
          model speaks.
        </p>
        <div className="cx-grid two" style={{ marginTop: 16 }}>
          <div>
            <div className="cx-hint" style={{ marginBottom: 8 }}>
              violation vocabulary
            </div>
            <table className="cx-table">
              <tbody>
                {CODES.map(([code, meaning]) => (
                  <tr key={code}>
                    <td style={{ width: 190 }}>
                      <Tag tone="warn">{code}</Tag>
                    </td>
                    <td style={{ color: "var(--c-dim)" }}>{meaning}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div>
            <div className="cx-hint" style={{ marginBottom: 8 }}>
              the equality rule
            </div>
            <ul className="cx-check">
              <li>same verdict, and both must be UPHOLD or REVOKE</li>
              <li>same set of vocabulary codes, order-insensitive</li>
              <li>a REVOKE that cites nothing is refused, not stored</li>
              <li>grounds outside the vocabulary are dropped on both sides</li>
              <li>at most three codes, so evidence stays readable</li>
              <li>if policy already found a breach, the ruling is REVOKE regardless of the model</li>
            </ul>
          </div>
        </div>
      </Panel>

      <Panel title="Path 4 · registry probe" hint="the instrument has to exist first">
        <p className="cx-note">
          Filing a symbol is permissionless, but nothing is stored on a promise. <code>propose_asset</code> fetches the
          reference feed inside consensus before the record exists: a 404, a body that is not JSON, or a dot path that
          misses the print aborts the call with the contract's own error. Activation re-probes, because a filing can be
          days old and the owner's claim is that the feed still answers now. The owner decides whether the source is
          canonical - a judgement no validator set can compute - and the queue keeps the proposer, the probe price and
          the written reason either way.
        </p>
        <div className="cx-grid two" style={{ marginTop: 16 }}>
          <div>
            <div className="cx-hint" style={{ marginBottom: 8 }}>
              who may do what
            </div>
            <ul className="cx-check">
              <li>any wallet: file a symbol, with its feed and JSON path</li>
              <li>the committee: fetch it and agree on the print, or refuse to store</li>
              <li>the owner: activate (re-probed) or reject with a note of 12+ characters</li>
              <li>everyone: read the whole queue, decisions included</li>
            </ul>
          </div>
          <div>
            <KeyValue
              rows={[
                ["gate", "consensus probe, any wallet"],
                ["tolerance", info ? `${info.price_tolerance_bps} bps on the attested price` : "—"],
                ["decision", "owner activation or a written rejection"],
                ["on a dead feed", "[EXTERNAL] 404, no proposal record written"],
                ["on a repeat", "[EXPECTED] already registered / already pending"],
              ]}
            />
          </div>
        </div>
      </Panel>

      <div className="cx-split">
        <Panel title="Received is not final" hint="the distinction the console keeps">
          <p className="cx-note">
            A write settles in two steps. The first returns an <b>ACCEPTED</b> receipt: an execution result exists, but
            the appeal window is still open. Only later does the transaction become <b>FINALIZED</b>. Every write notice
            in this console labels which one it has, and a state read can lag the receipt you just saw. If a number looks
            one step behind, reload before assuming the write failed.
          </p>
        </Panel>

        <Panel title="Proof anatomy" hint="what an auditor re-runs">
          <dl className="cx-kv">
            <div>
              <dt>allocation digest</dt>
              <dd>the weights that were approved or executed</dd>
            </div>
            <div>
              <dt>input digest</dt>
              <dd>the exact prompt, or the attested price rows</dd>
            </div>
            <div>
              <dt>evidence</dt>
              <dd>URLs, paths, prices, target weights, cited grounds, reopen note</dd>
            </div>
            <div>
              <dt>nav before / after</dt>
              <dd>what the book was worth on each side of the transition</dd>
            </div>
            <div>
              <dt>verdict</dt>
              <dd>the decision label, with the detail text beside it</dd>
            </div>
          </dl>
        </Panel>
      </div>

      <Panel title="What is real here" hint="and what is not">
        <p className="cx-note">
          The contract is deployed on Studionet and the consensus paths above are the ones it actually runs. What is
          simulated is the capital: shares are minted against an internal ledger, there is no real GEN settlement, and
          the synthetic instruments are reference-priced rather than issued. The interesting part is not the paper - it
          is that a model output, a price feed and a dispute ruling all became state that validators had to agree on,
          with the evidence to check them afterwards.
        </p>
        <div className="cx-row" style={{ marginTop: 14 }}>
          <Link className="cx-btn" data-tone="primary" href="/vault">
            back to the vault
          </Link>
          <a
            className="cx-btn"
            data-tone="ghost"
            href={`https://explorer-studio.genlayer.com/address/${address}`}
            target="_blank"
            rel="noreferrer"
          >
            open in explorer
          </a>
          <span className="cx-hint">
            {portfolio ? `book ${portfolio.portfolio_id} · ${portfolio.status}` : "reading the chain"} · v
            {info?.version ?? "1.0.0"}
          </span>
        </div>
      </Panel>
    </>
  );
}
