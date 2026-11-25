/**
 * Deploy SynthForge to Studionet and seed the synthetic universe.
 *
 * A deploy that reaches FINALIZED but rolled back still leaves an address behind,
 * so this script reads the contract back and asserts the state it just created
 * before it reports success or writes deployments.json.
 *
 * Usage:
 *   node deploy/deployScript.ts                    # deploy + seed + verify (wallet/global)
 *   node deploy/deployScript.ts --wallet tester1   # sign with another keystore
 *   node deploy/deployScript.ts --dry-run          # print the plan, send nothing
 *   node deploy/deployScript.ts --skip-seed        # deploy only
 *   node deploy/deployScript.ts --address 0x...    # seed an existing deployment
 *
 * The deployer key comes from the sibling keystore folder ../wallet
 * (override the directory with SYNTHFORGE_WALLET_DIR)
 * (name default "global", override with --wallet or SYNTHFORGE_WALLET). The key
 * is decrypted in memory, never written to disk. DEPLOYER_PRIVATE_KEY still
 * overrides everything for CI use.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const ATTO = 10n ** 18n;

const UNIVERSE = [
  {
    symbol: "SBTC",
    name: "Synthetic Bitcoin",
    kind: "CRYPTO",
    underlying: "BTC-USD spot",
    reference_url: "https://api.coinbase.com/v2/prices/BTC-USD/spot",
    price_path: "data.amount",
    risk_bucket: "HIGH",
    max_weight_bps: 4000,
  },
  {
    symbol: "SETH",
    name: "Synthetic Ether",
    kind: "CRYPTO",
    underlying: "ETH-USD spot",
    reference_url: "https://api.coinbase.com/v2/prices/ETH-USD/spot",
    price_path: "data.amount",
    risk_bucket: "HIGH",
    max_weight_bps: 4000,
  },
  {
    symbol: "SUSD",
    name: "Synthetic Dollar",
    kind: "RATE",
    underlying: "USDC-USD spot",
    reference_url: "https://api.coinbase.com/v2/prices/USDC-USD/spot",
    price_path: "data.amount",
    risk_bucket: "LOW",
    max_weight_bps: 10000,
  },
  {
    symbol: "SEUR",
    name: "Synthetic Euro",
    kind: "FX",
    underlying: "EUR/USD",
    reference_url: "https://api.frankfurter.dev/v1/latest?base=EUR&symbols=USD",
    price_path: "rates.USD",
    risk_bucket: "MEDIUM",
    max_weight_bps: 3000,
  },
  {
    symbol: "SJPY",
    name: "Synthetic Yen",
    kind: "FX",
    underlying: "USD/JPY",
    reference_url: "https://api.frankfurter.dev/v1/latest?base=USD&symbols=JPY",
    price_path: "rates.JPY",
    risk_bucket: "LOW",
    max_weight_bps: 3000,
  },
];

const DEMO_PORTFOLIO = {
  name: "SynthForge Alpha",
  mandate:
    "Hold a balanced synthetic book that survives a risk-off regime: keep a real long-vol sleeve, " +
    "do not let any single synthetic exceed its cap, and stay liquid through the low-risk sleeve.",
  risk_profile: "BALANCED",
  capital_atto: 1_000_000n * ATTO,
};

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
const dryRun = args["dry-run"] !== undefined;
const skipSeed = args["skip-seed"] !== undefined;
const existing = args.address;

const { createRawClient, makeDriver, transactionFees, fmt } = createRequire(import.meta.url)(
  path.join(ROOT, "scripts", "studionet.cjs"),
);
const { loadWallet } = await import(pathToFileURL(path.join(ROOT, "scripts", "wallet.mjs")).href);

async function resolveWallet(): Promise<string> {
  if (process.env.DEPLOYER_PRIVATE_KEY) return process.env.DEPLOYER_PRIVATE_KEY.trim();
  const name = args.wallet ?? process.env.SYNTHFORGE_WALLET ?? "global";
  try {
    const wallet = await loadWallet(name);
    console.log(`wallet     ${wallet.name} ${wallet.address}`);
    return wallet.privateKey;
  } catch (error) {
    console.error(`Could not unlock wallet "${name}": ${(error as Error).message}`);
    console.error("Set DEPLOYER_PRIVATE_KEY, or pass --wallet with a keystore that has a .password file.");
    process.exit(1);
  }
}

async function main() {
  const client = createRawClient(await resolveWallet());
  const driver = makeDriver(client);
  console.log(`deployer   ${client.account.address}`);
  console.log(`balance    ${fmt(await driver.balance())}`);

  const source = fs.readFileSync(path.join(ROOT, "contracts", "SynthForgeVault.py"), "utf-8");
  console.log(`source     contracts/SynthForgeVault.py (${source.length} bytes)`);

  if (dryRun) {
    console.log("\n--dry-run, nothing will be sent. This would:");
    console.log("  1. deploy contracts/SynthForgeVault.py (no constructor arguments)");
    console.log(`  2. register ${UNIVERSE.length} synthetic assets: ${UNIVERSE.map((a) => a.symbol).join(", ")}`);
    console.log(`  3. open ${DEMO_PORTFOLIO.name} (${DEMO_PORTFOLIO.risk_profile}) with ${fmt(DEMO_PORTFOLIO.capital_atto)} of paper capital`);
    console.log("  4. read the state back and write deployments.json");
    return;
  }

  let address = existing;
  let deployTx = "reused";

  if (!address) {
    console.log("\n[1/4] deploy");
    const created = await driver.deployContract(source, []);
    if (!created.ok) {
      console.error(`  FAILED at ${created.phase}: ${created.reason}`);
      process.exit(1);
    }
    address = created.address;
    deployTx = created.hash;
    if (!address) {
      console.error("  the receipt carried no contract address");
      process.exit(1);
    }
    console.log(`  tx       ${deployTx}`);
    console.log(`  contract ${address}`);
  } else {
    console.log(`\n[1/4] deploy skipped, seeding ${address}`);
  }

  const info = await driver.readJson(address, "get_system_info");
  console.log(`  owner    ${info.owner}`);
  console.log(`  version  ${info.version}`);

  if (skipSeed) {
    writeDeployments({ address, deployTx, deployer: client.account.address, universe: info.assets, portfolio: null });
    console.log("\n--skip-seed, so the universe was left alone.");
    return;
  }

  console.log("\n[2/4] register the synthetic universe");
  const registered = new Set<string>((await driver.readJson(address, "list_assets")).map((a: any) => a.symbol));
  for (const asset of UNIVERSE) {
    if (registered.has(asset.symbol)) {
      console.log(`  ${asset.symbol}  already registered`);
      continue;
    }
    const result = await driver.writeTo(address, "register_asset", [
      asset.symbol,
      asset.name,
      asset.kind,
      asset.underlying,
      asset.reference_url,
      asset.price_path,
      asset.risk_bucket,
      asset.max_weight_bps,
    ]);
    if (!result.ok) {
      console.error(`  ${asset.symbol}  FAILED at ${result.phase}: ${result.reason}`);
      process.exit(1);
    }
    console.log(`  ${asset.symbol}  ${asset.kind}/${asset.risk_bucket} cap ${asset.max_weight_bps} bps  ${result.hash}`);
  }

  console.log("\n[3/4] open the demo portfolio");
  const portfolios = await driver.readJson(address, "list_portfolios");
  let portfolioId: string | null = portfolios[0]?.portfolio_id ?? null;
  if (portfolioId) {
    console.log(`  ${portfolioId} already exists, leaving it alone`);
  } else {
    const opened = await driver.writeTo(address, "open_portfolio", [
      DEMO_PORTFOLIO.name,
      DEMO_PORTFOLIO.mandate,
      DEMO_PORTFOLIO.risk_profile,
      DEMO_PORTFOLIO.capital_atto.toString(),
    ]);
    if (!opened.ok) {
      console.error(`  FAILED at ${opened.phase}: ${opened.reason}`);
      process.exit(1);
    }
    const listed = await driver.readJson(address, "list_portfolios");
    portfolioId = listed[listed.length - 1].portfolio_id;
    console.log(`  ${portfolioId} ${DEMO_PORTFOLIO.name}  ${opened.hash}`);
  }

  console.log("\n[4/4] read the state back, because a receipt is not proof");
  const assets = await driver.readJson(address, "list_assets");
  const book = await driver.readJson(address, "list_portfolios");
  const portfolio = portfolioId ? await driver.readJson(address, "get_portfolio", [portfolioId]) : null;
  const proofs = portfolioId ? await driver.readJson(address, "list_proofs", [portfolioId]) : [];

  console.log(`  assets      ${assets.length} (${assets.map((a: any) => a.symbol).join(", ")})`);
  console.log(`  portfolios  ${book.length}`);
  if (portfolio) {
    console.log(`  ${portfolio.portfolio_id}   nav ${fmt(BigInt(portfolio.nav_atto))} · shares ${portfolio.shares_atto} · ${portfolio.status}`);
  }
  console.log(`  proofs      ${proofs.length}`);

  if (assets.length === 0 || book.length === 0) {
    console.error("\nthe deployment reads back empty, so it did not really take");
    process.exit(1);
  }

  writeDeployments({
    address,
    deployTx,
    deployer: client.account.address,
    universe: assets.map((a: any) => a.symbol),
    portfolio: portfolioId,
  });

  console.log("\ndeployed. Next:");
  console.log(`  node deploy/e2eScript.ts --address ${address}`);
  console.log("  cd frontend && npm install && npm run dev   # dashboard against this address");
}


function writeDeployments(record: { address: string; deployTx: string; deployer: string; universe: any; portfolio: string | null }) {
  // Re-seeding an existing deployment must not erase the original deploy tx.
  const existingFile = path.join(ROOT, "deployments.json");
  if (record.deployTx === "reused" && fs.existsSync(existingFile)) {
    const previous = JSON.parse(fs.readFileSync(existingFile, "utf-8"));
    if (previous.address === record.address && previous.deployTx) record.deployTx = previous.deployTx;
  }
  const payload = {
    network: "studionet",
    rpc: "https://studio.genlayer.com/api",
    chainId: 61999,
    contract: "SynthForgeVault",
    address: record.address,
    deployTx: record.deployTx,
    deployer: record.deployer,
    deployedAt: new Date().toISOString(),
    universe: record.universe,
    demoPortfolio: record.portfolio,
  };
  fs.writeFileSync(path.join(ROOT, "deployments.json"), JSON.stringify(payload, null, 2) + "\n", "utf-8");
  console.log("\nwrote deployments.json");

  // Studionet charges a fee deposit, and genlayer-js sends a zero deposit when it
  // is not told otherwise. The browser has no fee estimator, so the snapshot the
  // driver took is published for the dashboard to reuse on every write.
  const publicDir = path.join(ROOT, "frontend", "public");
  fs.mkdirSync(publicDir, { recursive: true });
  const fees = { ...transactionFees(), capturedAt: new Date().toISOString(), network: "studionet" };
  fs.writeFileSync(path.join(publicDir, "fees.json"), JSON.stringify(fees, null, 2) + "\n", "utf-8");
  console.log("wrote frontend/public/fees.json");

  // The console resolves the contract it talks to from this file, not from a
  // build-time env var, so the page cannot drift from the documented deployment.
  const deployment = {
    network: "studionet",
    chainId: 61999,
    address: record.address,
    deployTx: record.deployTx,
    deployer: record.deployer,
    portfolioId: record.portfolio,
    deployedAt: payload.deployedAt,
  };
  fs.writeFileSync(path.join(publicDir, "deployment.json"), JSON.stringify(deployment, null, 2) + "\n", "utf-8");
  console.log("wrote frontend/public/deployment.json");

  fs.rmSync(path.join(ROOT, "scripts", ".deployer.tmp"), { force: true });
}

main()
  .then(() => fs.rmSync(path.join(ROOT, "scripts", ".deployer.tmp"), { force: true }))
  .catch((error) => {
    fs.rmSync(path.join(ROOT, "scripts", ".deployer.tmp"), { force: true });
    console.error(error);
    process.exit(1);
  });
