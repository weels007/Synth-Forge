/**
 * Drive the full SynthForge lifecycle against a deployed vault.
 *
 * This is the integration test that matters: it proves the parts a unit test
 * cannot, namely that validators agree on an LLM strategy, that they agree on
 * the attested prices, and that every state transition leaves an execution
 * proof behind.
 *
 *   open portfolio -> generate strategy (LLM consensus) -> execute (price
 *   consensus) -> mark to market -> challenge (adjudication consensus)
 *
 * Usage:
 *   node deploy/e2eScript.ts --address 0x...            # full run
 *   node deploy/e2eScript.ts --address 0x... --skip-challenge
 *
 * The script is resumable: an existing portfolio is reused, and a strategy that
 * is already ACTIVE is not regenerated unless --regenerate is passed.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
const { makeClient, makeDriver, readKeyFromEnv, fmt } = createRequire(import.meta.url)(
  path.join(ROOT, "scripts", "studionet.cjs"),
);

function resolveKey(): string {
  if (process.env.DEPLOYER_PRIVATE_KEY) return process.env.DEPLOYER_PRIVATE_KEY.trim();
  const files = [process.env.SYNTHFORGE_KEY_FILE ?? "", path.join(ROOT, ".env"), "D:\\Genlayer-project\\wallet\\.env"];
  const key = readKeyFromEnv(files.filter(Boolean));
  if (!key) {
    console.error("No deployer key found. Set DEPLOYER_PRIVATE_KEY or SYNTHFORGE_KEY_FILE.");
    process.exit(1);
  }
  return key;
}

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

  const file = path.join(ROOT, "scripts", ".deployer.tmp");
  fs.writeFileSync(file, resolveKey(), { encoding: "utf-8", mode: 0o600 });
  const client = makeClient(file);
  fs.rmSync(file, { force: true });

  const driver = makeDriver(client);
  console.log(`contract   ${address}`);
  console.log(`actor      ${client.account.address}`);

  const info = await driver.readJson(address, "get_system_info");
  if (Number(info.assets) === 0) fail("preflight", "the vault has no registered assets; run deploy/deployScript.ts first");
  console.log(`universe   ${info.assets} assets · ${info.proofs} proofs · v${info.version}`);

  const book = await driver.readJson(address, "list_portfolios");
  const portfolioId = book[0]?.portfolio_id;
  if (!portfolioId) fail("preflight", "the vault has no portfolio; run deploy/deployScript.ts first");
  let portfolio = await driver.readJson(address, "get_portfolio", [portfolioId]);
  console.log(`portfolio  ${portfolioId} · ${portfolio.risk_profile} · nav ${fmt(BigInt(portfolio.nav_atto))} · ${portfolio.status}`);

  const strategies = await driver.readJson(address, "list_strategies", [portfolioId]);
  let strategy = strategies[0];
  if (!strategy || args.regenerate !== undefined) {
    step("generate_strategy: one LLM proposal, judged by the validator committee");
    console.log("  prompt preview:");
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

  if (args["skip-challenge"] === undefined) {
    step("challenge_strategy: an independent adjudicator re-reads the mandate");
    const challenged = await driver.writeTo(address, "challenge_strategy", [portfolioId, strategy.strategy_id, CHALLENGE_REASON]);
    if (!challenged.ok) fail(challenged.phase, challenged.reason);
    console.log(`  tx ${challenged.hash}`);
    const after = await driver.readJson(address, "list_proofs", [portfolioId]);
    const ruling = after[0];
    console.log(`  verdict ${ruling.verdict} · violations ${(ruling.verdict_detail || "").slice(0, 220)}`);
    portfolio = await driver.readJson(address, "get_portfolio", [portfolioId]);
    console.log(`  portfolio status ${portfolio.status} · active strategy ${portfolio.active_strategy_id || "none"}`);
  }

  step("execution proofs, newest first");
  const proofs = await driver.readJson(address, "list_proofs", [portfolioId]);
  for (const proof of proofs.slice(0, 10)) {
    console.log(`  ${proof.proof_id}  ${String(proof.kind).padEnd(18)} ${String(proof.verdict).padEnd(10)} nav ${fmt(BigInt(proof.nav_before_atto))} -> ${fmt(BigInt(proof.nav_after_atto))} · l1 ${proof.weight_l1_bps} bps`);
    if (proof.verdict_detail) console.log(`             ${proof.verdict_detail}`);
  }
  console.log(`  ${proofs.length} proofs anchored for ${portfolioId}`);

  const report = {
    address,
    portfolioId,
    strategyId: strategy.strategy_id,
    regime: strategy.regime,
    status: (await driver.readJson(address, "get_portfolio", [portfolioId])).status,
    navAtto: (await driver.readJson(address, "get_portfolio", [portfolioId])).nav_atto,
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
