import { chains, createClient } from "genlayer-js";

export const NETWORK = {
  name: "Studionet",
  chainId: 61999,
  rpc: "https://studio.genlayer.com/api",
  explorer: "https://explorer-studio.genlayer.com",
};

export type Asset = {
  symbol: string;
  name: string;
  kind: string;
  underlying: string;
  reference_url: string;
  price_path: string;
  risk_bucket: string;
  max_weight_bps: number;
  enabled: boolean;
  added_at: string;
};

export type Portfolio = {
  portfolio_id: string;
  manager: string;
  name: string;
  mandate: string;
  risk_profile: string;
  capital_atto: number;
  shares_atto: number;
  nav_atto: number;
  nav_per_share_atto: number;
  active_strategy_id: string;
  status: string;
  rebalances: number;
  created_at: string;
  last_mark_at: string;
};

/** The contract stores the allocation as a symbol -> basis-points map. */
export type Allocation = Record<string, number>;

export type Strategy = {
  strategy_id: string;
  portfolio_id: string;
  thesis: string;
  risk_profile: string;
  horizon_days: number;
  regime: string;
  allocation: Allocation;
  rationale: string;
  digest: string;
  confidence_bps: number;
  status: string;
  created_by: string;
  created_at: string;
  executions: number;
  /** One ruling per strategy: a settled draft cannot be re-litigated. */
  adjudicated: boolean;
};

export type Proof = {
  proof_id: string;
  kind: string;
  portfolio_id: string;
  strategy_id: string;
  allocation_digest: string;
  input_digest: string;
  nav_before_atto: number;
  nav_after_atto: number;
  weight_l1_bps: number;
  verdict: string;
  verdict_detail: string;
  /** The inputs the decision was made on: fetched sources, weights, violations. */
  evidence: ProofEvidence;
  executor: string;
  created_at: string;
};

export type ProofEvidence = {
  sources?: { symbol: string; url: string; path: string; price_atto: string }[];
  target_weights?: Allocation;
  turnover_bps?: string;
  violations?: string[];
  allocation?: Allocation;
  regime?: string;
  confidence_bps?: string;
  prompt_digest?: string;
  capital_atto?: string;
  amount_atto?: string;
  shares_atto?: string;
  shares_minted_atto?: string;
  payout_atto?: string;
  note?: string;
  previous_status?: string;
};

export type SystemInfo = {
  contract: string;
  version: string;
  owner: string;
  paused: boolean;
  assets: number;
  portfolios: number;
  strategies: number;
  proofs: number;
  bps: number;
  atto: number;
  price_tolerance_bps: number;
  max_weight_delta_bps: number;
  max_l1_delta_bps: number;
  min_reason_chars: number;
  caps: Record<string, { max_single_bps: number; max_high_bps: number }>;
};

export type Position = { symbol: string; weight_bps: number; units_atto: number };

export type Snapshot = {
  info: SystemInfo;
  assets: Asset[];
  portfolios: Portfolio[];
  strategies: Strategy[];
  proofs: Proof[];
  positions: Position[];
  loadedAt: string;
};

/** Reads do not need a signer, so the dashboard can load without a wallet. */
export const readClient = createClient({ chain: chains.studionet });

async function read(address: string, functionName: string, args: unknown[] = []) {
  const raw = await (readClient.readContract as any)({ address, functionName, args });
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export async function loadSnapshot(address: string): Promise<Snapshot> {
  const info = (await read(address, "get_system_info")) as SystemInfo;
  const assets = (await read(address, "list_assets")) as Asset[];
  const portfolios = (await read(address, "list_portfolios")) as Portfolio[];

  const strategies: Strategy[] = [];
  const proofs: Proof[] = [];
  let positions: Position[] = [];

  if (portfolios.length > 0) {
    const portfolioId = portfolios[0].portfolio_id;
    strategies.push(...((await read(address, "list_strategies", [portfolioId])) as Strategy[]));
    proofs.push(...((await read(address, "list_proofs", [portfolioId])) as Proof[]));
    positions = (await read(address, "get_positions", [portfolioId])) as Position[];
  }

  return { info, assets, portfolios, strategies, proofs, positions, loadedAt: new Date().toISOString() };
}

export type Fees = { distribution: Record<string, unknown>; feeValue: string };

/**
 * The canonical deployment, published by deploy/deployScript.ts next to the
 * fee snapshot. The console prefers this over a build-time env var so the
 * address it talks to can never drift from the documented deployment.
 */
export type Deployment = {
  network: string;
  chainId: number;
  address: string;
  deployTx: string;
  deployer: string;
  portfolioId: string | null;
  deployedAt: string;
};

export async function loadDeployment(): Promise<Deployment | null> {
  const response = await fetch("/deployment.json", { cache: "no-store" });
  if (!response.ok) return null;
  return (await response.json()) as Deployment;
}

let feeCache: Fees | null = null;

/** The fee deposit snapshot published by deploy/deployScript.ts. */
export async function loadFees(): Promise<Fees> {
  if (feeCache) return feeCache;
  const response = await fetch("/fees.json", { cache: "no-store" });
  if (!response.ok) throw new Error("frontend/public/fees.json is missing; re-run the deploy script");
  const parsed = (await response.json()) as Fees;
  feeCache = { distribution: parsed.distribution, feeValue: parsed.feeValue };
  return feeCache;
}

export type Wallet = { address: string; client: ReturnType<typeof createClient> };

/** Connect an injected wallet and build a client that can sign contract writes. */
export async function connectWallet(): Promise<Wallet> {
  const injected = (globalThis as any).ethereum;
  if (!injected) throw new Error("No injected wallet found. Install MetaMask or use the CLI drivers.");
  const accounts: string[] = await injected.request({ method: "eth_requestAccounts" });
  if (!accounts.length) throw new Error("The wallet returned no account.");
  const client = createClient({
    chain: chains.studionet,
    account: accounts[0] as `0x${string}`,
    provider: injected as never,
  });
  return { address: accounts[0], client };
}

/**
 * Submit a write, wait for the receipt, and surface the leader error text.
 *
 * The receipt status is returned verbatim: a transaction that reached ACCEPTED
 * is not FINALIZED, because the appeal window is still open. Callers must not
 * present one as the other.
 */
export async function submit(
  client: ReturnType<typeof createClient>,
  address: string,
  functionName: string,
  args: unknown[],
): Promise<{ hash: string; result: unknown; status: string }> {
  const fees = await loadFees();
  const hash = await client.writeContract({
    address: address as `0x${string}`,
    functionName,
    args,
    fees,
  } as any);
  const receipt = (await client.waitForTransactionReceipt({ hash: hash as any, status: "ACCEPTED" as any, interval: 4000, retries: 150 } as any)) as any;
  const leader = receipt?.consensus_data?.leader_receipt?.[0];
  if (leader && leader.execution_result !== "SUCCESS") {
    const payload = leader?.result?.payload;
    throw new Error(`execution ${leader.execution_result}: ${typeof payload === "string" ? payload : JSON.stringify(payload)}`);
  }
  const status = String(receipt?.status_name ?? receipt?.status ?? "ACCEPTED").toUpperCase();
  return { hash: String(hash), result: leader?.result?.payload ?? null, status };
}

/** Read a single view and JSON-decode it, for one-off calls like preview_prompt. */
export async function readOne(address: string, functionName: string, args: unknown[] = []) {
  return read(address, functionName, args);
}

export const ATTO = 10n ** 18n;

export function formatGen(atto: number | string | bigint): string {
  const value = Number(BigInt(atto)) / 1e18;
  if (!Number.isFinite(value)) return "0";
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

export function short(value: string, head = 6, tail = 4): string {
  if (!value) return "-";
  if (value.length <= head + tail + 3) return value;
  return `${value.slice(0, head)}...${value.slice(-tail)}`;
}

export function pct(bps: number): string {
  return `${(Number(bps) / 100).toFixed(2)}%`;
}

export function riskClass(bucket: string): string {
  if (bucket === "HIGH") return "tag hi";
  if (bucket === "MEDIUM") return "tag md";
  return "tag lo";
}