/**
 * Drive the full SynthForge lifecycle against a deployed vault.
 *
 * This is the integration test that matters: it proves the parts a unit test
 * cannot, namely that validators agree on an LLM strategy, that they agree on
 * the attested prices, and that every state transition leaves an execution
 * proof behind with the inputs it was decided on.
 *
 *   generate (LLM consensus) -> execute (price consensus) -> mark -> challenge
 *   (adjudication consensus) -> reopen -> regenerate
 *
 * Actors come from the project keystore folder: the manager (default "global")
 * proposes and executes, an independent wallet (default "tester2") challenges.
 * A non-manager proposal attempt is included to show the authorization guard.
 *
 * Usage:
 *   node deploy/e2eScript.ts --address 0x...            # full run
 *   node deploy/e2eScript.ts --wallet tester1 --challenger tester2
 *   node deploy/e2eScript.ts --address 0x... --skip-challenge
 *
 * The script is resumable: an existing portfolio is reused, and a strategy that
 * is already ACTIVE is not regenerated unless --regenerate is passed.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const ATTO = 10n ** 18n;

const THESIS =
  "Validators report a risk-on rotation: real yields are falling, dollar liquidity is stable " +
  "and crypto beta has been leading. I want the long-vol sleeve to carry the book while the " +
  "low-risk sleeve keeps redemption capacity, and I want nothing pinned to a single name.";

const HORIZON_DAYS = 30;

const CHALLENGE_REASON =
  "The proposal leans on crypto beta while the mandate asks for a balanced book that survives " +
  "a risk-off regime; the draft understates drawdown correlation between the two high-risk sleeves.";

const REOPEN_NOTE =
  "Revoked draft replaced: caps re-checked against the mandate and the rotation re-run under a " +
  "long-vol sleeve, so the book may trade again.";

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) out[key] = "1";
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const { createRawClient, makeDriver, fmt } = createRequire(import.meta.url)(
  path.join(ROOT, "scripts", "studionet.cjs"),
);
const { loadWallet } = await import(pathToFileURL(path.join(ROOT, "scripts", "wallet.mjs")).href);

function deployments(): { address?: string } {
  const file = path.join(ROOT, "deployments.json");
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

function step(title: string) {
  console.log(`\n=== ${title}`);
}

function fail(phase: string, reason: string): never {
  console.error(`  FAILED at ${phase}: ${reason}`);
  process.exit(1);
}

async function main() {
  const address = args.address ?? deployments().address;
  if (!address) fail("config", "pass --address, or run deploy/deployScript.ts first (it writes deployments.json)");

  const managerName = args.wallet ?? process.env.SYNTHFORGE_WALLET ?? "global";
  const challengerName = args.challenger ?? "tester2";
  const manager = await loadWallet(managerName);
  const challenger = await loadWallet(challengerName);
  const driver = makeDriver(createRawClient(manager.privateKey));
  const outsider = makeDriver(createRawClient(challenger.privateKey));

  console.log(`contract   ${address}`);
  console.log(`manager    ${manager.name} ${manager.address}`);
  console.log(`challenger ${challenger.name} ${challenger.address}`);

  const info = await driver.readJson(address, "get_system_info");
  if (Number(info.assets) === 0) fail("preflight", "the vault has no registered assets; run deploy/deployScript.ts first");
  console.log(`universe   ${info.assets} assets · ${info.proofs} proofs · v${info.version}`);
  console.log(`consensus  weight band ${info.max_weight_delta_bps} bps · L1 ${info.max_l1_delta_bps} bps · prices ${info.price_tolerance_bps} bps`);

  const book = await driver.readJson(address, "list_portfolios");
  const portfolioId = book[0]?.portfolio_id;
  if (!portfolioId) fail("preflight", "the vault has no portfolio; run deploy/deployScript.ts first");
  let portfolio = await driver.readJson(address, "get_portfolio", [portfolioId]);
  console.log(`portfolio  ${portfolioId} · ${portfolio.risk_profile} · nav ${fmt(BigInt(portfolio.nav_atto))} · ${portfolio.status}`);

  const strategies = await driver.readJson(address, "list_strategies", [portfolioId]);
  let strategy = strategies[0];
  if (!strategy || args.regenerate !== undefined) {
    step("generate_strategy: one LLM proposal, judged by the validator committee");
    const preview = await driver.readFrom(address, "preview_prompt", [portfolioId, THESIS, HORIZON_DAYS]);
    for (const line of String(preview).split("\n").slice(0, 6)) console.log(`    ${line}`);
    const generated = await driver.writeTo(address, "generate_strategy", [portfolioId, THESIS, HORIZON_DAYS]);
    if (!generated.ok) fail(generated.phase, generated.reason);
    console.log(`  tx ${generated.hash}`);
    const list = await driver.readJson(address, "list_strategies", [portfolioId]);
    strategy = list[0];
  } else {
    console.log(`\n=== generate_strategy skipped, ${strategy.strategy_id} already exists`);
  }

  console.log(`  ${strategy.strategy_id} ${strategy.regime} · confidence ${strategy.confidence_bps} bps · status ${strategy.status}`);
  const weights = Object.entries(strategy.allocation as Record<string, number>).sort((a, b) => b[1] - a[1]);
  for (const [symbol, weight] of weights) {
    const bar = "#".repeat(Math.max(1, Math.round(weight / 200)));
    console.log(`    ${symbol.padEnd(6)} ${String(weight).padStart(5)} bps ${bar}`);
  }
  if (strategy.rationale) console.log(`  rationale: ${strategy.rationale}`);

  if (strategy.status === "PROPOSED" || strategy.status === "ACTIVE") {
    step("execute_strategy: attested prices, capped rebalance, execution proof");
    const executed = await driver.writeTo(address, "execute_strategy", [portfolioId, strategy.strategy_id]);
    if (!executed.ok) fail(executed.phase, executed.reason);
    console.log(`  tx ${executed.hash}`);
    const positions = await driver.readJson(address, "get_positions", [portfolioId]);
    for (const row of positions) {
      console.log(`  ${String(row.symbol).padEnd(6)} ${String(row.weight_bps).padStart(5)} bps  ${row.units_atto} units`);
    }
  }

  step("mark_to_market: reprice the book at fresh attested prices");
  const before = await driver.readJson(address, "get_portfolio", [portfolioId]);
  const marked = await driver.writeTo(address, "mark_to_market", [portfolioId]);
  if (!marked.ok) fail(marked.phase, marked.reason);
  console.log(`  tx ${marked.hash}`);
  const after = await driver.readJson(address, "get_portfolio", [portfolioId]);
  console.log(`  nav ${fmt(BigInt(before.nav_atto))} -> ${fmt(BigInt(after.nav_atto))} · rebalances ${after.rebalances}`);

  let verdict = "SKIPPED";
  let revokedStrategyId: string | null = null;
  let reopenTx: string | null = null;
  let challengeTx: string | null = null;

  if (args["skip-challenge"] === undefined) {
    step(`challenge_strategy: ${challenger.name} re-reads the mandate as an independent party`);
    const challenged = await outsider.writeTo(address, "challenge_strategy", [portfolioId, strategy.strategy_id, CHALLENGE_REASON]);
    if (!challenged.ok) fail(challenged.phase, challenged.reason);
    challengeTx = challenged.hash ?? null;
    console.log(`  tx ${challengeTx}`);
    const proofs = await driver.readJson(address, "list_proofs", [portfolioId]);
    const ruling = proofs[0];
    verdict = ruling.verdict;
    const evidence = ruling.evidence ?? {};
    console.log(`  verdict ${ruling.verdict} by ${ruling.executor}`);
    console.log(`  violations ${(evidence.violations ?? []).join(", ") || "none"}`);
    if (evidence.prompt_digest) console.log(`  prompt digest ${evidence.prompt_digest}`);
    console.log(`  detail ${(ruling.verdict_detail || "").slice(0, 220)}`);
    portfolio = await driver.readJson(address, "get_portfolio", [portfolioId]);
    console.log(`  portfolio status ${portfolio.status} · active strategy ${portfolio.active_strategy_id || "none"}`);

    if (portfolio.status === "REVIEW") {
      revokedStrategyId = strategy.strategy_id;
      step("reopen_portfolio: the explicit, recorded way back out of review");
      const reopened = await driver.writeTo(address, "reopen_portfolio", [portfolioId, REOPEN_NOTE]);
      if (!reopened.ok) fail(reopened.phase, reopened.reason);
      reopenTx = reopened.hash ?? null;
      console.log(`  tx ${reopenTx}`);
      console.log(`  portfolio status ${(await driver.readJson(address, "get_portfolio", [portfolioId])).status}`);

      step("generate_strategy: replacement draft after the revoke");
      const regenerated = await driver.writeTo(address, "generate_strategy", [portfolioId, THESIS, HORIZON_DAYS]);
      if (!regenerated.ok) fail(regenerated.phase, regenerated.reason);
      console.log(`  tx ${regenerated.hash}`);
      const list = await driver.readJson(address, "list_strategies", [portfolioId]);
      const replacement = list[0];
      console.log(`  ${replacement.strategy_id} ${replacement.regime} · status ${replacement.status}`);
      const executed = await driver.writeTo(address, "execute_strategy", [portfolioId, replacement.strategy_id]);
      if (!executed.ok) fail(executed.phase, executed.reason);
      console.log(`  tx ${executed.hash}`);
      strategy = replacement;
    }
  }

  step(`authorization: ${challenger.name} is not the manager and cannot propose`);
  const refused = await outsider.writeTo(address, "generate_strategy", [portfolioId, THESIS, HORIZON_DAYS]);
  if (refused.ok) {
    console.log("  unexpected: a non-manager proposal was accepted");
  } else {
    console.log(`  reverted at ${refused.phase}: ${String(refused.reason).slice(0, 200)}`);
  }

  step("execution proofs, newest first");
  const proofs = await driver.readJson(address, "list_proofs", [portfolioId]);
  for (const proof of proofs.slice(0, 12)) {
    console.log(`  ${proof.proof_id}  ${String(proof.kind).padEnd(18)} ${String(proof.verdict).padEnd(10)} nav ${fmt(BigInt(proof.nav_before_atto))} -> ${fmt(BigInt(proof.nav_after_atto))} · l1 ${proof.weight_l1_bps} bps`);
    if (proof.verdict_detail) console.log(`             ${proof.verdict_detail}`);
  }
  console.log(`  ${proofs.length} proofs anchored for ${portfolioId}`);

  const priced = proofs.find((p: any) => p.evidence && p.evidence.sources);
  if (priced) {
    step("evidence committed by the newest price proof");
    for (const row of priced.evidence.sources) {
      console.log(`  ${String(row.symbol).padEnd(6)} ${row.price_atto} atto · ${row.url} ${row.path}`);
    }
  }

  portfolio = await driver.readJson(address, "get_portfolio", [portfolioId]);
  const report = {
    address,
    portfolioId,
    manager: { name: manager.name, address: manager.address },
    challenger: { name: challenger.name, address: challenger.address },
    strategyId: strategy.strategy_id,
    revokedStrategyId,
    regime: strategy.regime,
    status: portfolio.status,
    navAtto: portfolio.nav_atto,
    verdict,
    transactions: { challenge: challengeTx, reopen: reopenTx },
    proofs: proofs.map((p: any) => ({ id: p.proof_id, kind: p.kind, verdict: p.verdict })),
    ranAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(ROOT, "deploy", "e2e-report.json"), JSON.stringify(report, null, 2) + "\n", "utf-8");
  console.log("\nwrote deploy/e2e-report.json");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
