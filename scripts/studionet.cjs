#!/usr/bin/env node
/**
 * Shared Studionet plumbing for the SynthForge drivers.
 *
 * Everything that is easy to get wrong when talking to Studionet lives here once:
 *
 *  1. genlayer-js is resolved from a local install when one exists, and
 *     otherwise from the global `genlayer` CLI install, so deploying does not
 *     require a project-level npm install.
 *  2. A transaction can reach ACCEPTED and still have rolled back. Only
 *     consensus_data.leader_receipt says which happened, and
 *     leader_receipt.result.payload carries the contract error text. Every write
 *     is inspected before it is called successful.
 *  3. A receipt is believed only when it echoes the hash that was submitted, so
 *     an earlier transaction cannot be mistaken for this one.
 *  4. Studionet throttles. Calls are paced, and a stated rate limit, a 5xx or a
 *     Cloudflare HTML body is retried with backoff.
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const RPC_SPACING_MS = 2500;
const READ_ATTEMPTS = 24;
const READ_BACKOFF_MS = 10000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fmt = (atto) => `${(Number(BigInt(atto)) / 1e18).toFixed(6)} GEN`;

/**
 * Studionet now charges a fee deposit, and genlayer-js sends a zero deposit for
 * a default fee distribution, which the consensus contract rejects with
 * FeeValueMustBeNonZero. The CLI does know how to price a transaction against
 * the live fee policy, so the deposit is taken from `genlayer estimate-fees`
 * once per process and reused for every write and deploy.
 */
let cachedFees = null;
function transactionFees() {
  if (cachedFees) return cachedFees;
  const raw = execSync("genlayer estimate-fees --json", { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
  const line = raw.trim().split("\n").filter((l) => l.trim().startsWith("{")).pop();
  if (!line) throw new Error("genlayer estimate-fees did not return a fee object");
  const parsed = JSON.parse(line);
  if (!parsed.distribution || parsed.feeValue === undefined) {
    throw new Error("genlayer estimate-fees returned no distribution/feeValue");
  }
  cachedFees = { distribution: parsed.distribution, feeValue: String(parsed.feeValue) };
  return cachedFees;
}

function resolveGenlayerJs() {
  try {
    return require("genlayer-js");
  } catch {
    const globalRoot = path.join(execSync("npm root -g").toString().trim(), "genlayer", "node_modules");
    return require(path.join(globalRoot, "genlayer-js"));
  }
}

const { createClient, createAccount, chains } = resolveGenlayerJs();

/** Read a private key from the first env-like file that matches, or a bare 32-byte hex key. */
function readKeyFromEnv(files, names = ["GENLAYER_DEV_KEY", "DEPLOYER_PRIVATE_KEY"]) {
  for (const file of files) {
    if (!file || !fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf-8");
    for (const name of names) {
      const match = text.match(new RegExp(`^\\s*${name}\\s*=\\s*(.+?)\\s*$`, "m"));
      if (match) return match[1].replace(/^["\']|["\']$/g, "").trim();
    }
    const bare = text.trim();
    if (/^0x[0-9a-fA-F]{64}$/.test(bare)) return bare;
  }
  return null;
}

function createRawClient(key) {
  return createClient({ chain: chains.studionet, account: createAccount(String(key).trim()) });
}

function makeClient(keyPath) {
  return createRawClient(fs.readFileSync(keyPath, "utf-8"));
}

function makeDriver(client, shared = { lastCall: 0 }) {
  async function paced(fn) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const wait = shared.lastCall + RPC_SPACING_MS - Date.now();
      if (wait > 0) await sleep(wait);
      shared.lastCall = Date.now();
      try {
        return await fn();
      } catch (err) {
        const retryAfter = err?.data?.retry_after_seconds ?? err?.cause?.data?.retry_after_seconds;
        const message = `${err?.message ?? ""} ${err?.cause?.message ?? ""} ${err?.details ?? ""}`;
        const transient =
          /rate limit|unknown RPC error|unexpected token|DOCTYPE|bad gateway|service unavailable|gateway timeout|fetch failed|network error|ECONNRESET|socket hang up|\b50[234]\b|temporarily/i.test(
            message,
          );
        if (retryAfter === undefined && !transient) throw err;
        const backoff = retryAfter !== undefined ? (Number(retryAfter) + 2) * 1000 : 4000 * (attempt + 1);
        await sleep(backoff);
      }
    }
    throw new Error("gave up after repeated transient RPC failures");
  }

  function receiptHashMismatch(receipt, expected) {
    if (!expected) return null;
    const got = receipt?.transaction_hash ?? receipt?.transactionHash ?? receipt?.hash ?? receipt?.to_transaction_hash;
    if (got === undefined || got === null) return null;
    return String(got).toLowerCase() === String(expected).toLowerCase() ? null : `${got} != ${expected}`;
  }

  /** null when the leader actually returned, otherwise a diagnostic string. */
  function executionFailure(receipt) {
    const leader = receipt?.consensus_data?.leader_receipt?.[0] ?? receipt?.consensus_data?.leader_receipt;
    if (!leader) return "no leader receipt in the response";
    const status = leader.result?.status;
    if (leader.execution_result === "SUCCESS" && (status === undefined || status === "return")) return null;
    const parts = [];
    if (leader.execution_result !== "SUCCESS") parts.push(`execution_result=${leader.execution_result}`);
    if (leader.error_code) parts.push(`error_code=${leader.error_code}`);
    if (status) parts.push(`result=${status}`);
    const payload = leader.result?.payload;
    if (payload !== undefined && payload !== null) {
      const text = typeof payload === "string" ? payload : JSON.stringify(payload);
      parts.push(`payload=${text.slice(0, 400)}`);
    }
    return parts.length ? parts.join(" | ") : "unknown failure";
  }

  const waitReceipt = (hash) =>
    paced(() => client.waitForTransactionReceipt({ hash, waitUntil: "decided", interval: 4000, retries: 150 }));

  async function readFrom(address, method, args = []) {
    let lastError;
    for (let attempt = 0; attempt < READ_ATTEMPTS; attempt += 1) {
      try {
        return await paced(() => client.readContract({ address, functionName: method, args }));
      } catch (err) {
        lastError = err;
        if (!/execution failed|invalid parameters|not found|timed out/i.test(err?.message ?? "")) throw err;
        await sleep(READ_BACKOFF_MS);
      }
    }
    throw lastError;
  }

  async function readJson(address, method, args = []) {
    const raw = await readFrom(address, method, args);
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  }

  async function writeTo(address, method, args = [], value = 0n) {
    let hash;
    try {
      hash = await paced(() =>
        client.writeContract({ address, functionName: method, args, value, consensusMaxRotations: 5, fees: transactionFees() }),
      );
    } catch (err) {
      return { ok: false, phase: "submit", reason: err.message };
    }
    let receipt;
    try {
      receipt = await waitReceipt(hash);
    } catch (err) {
      return { ok: false, phase: "receipt", reason: err.message, hash };
    }
    const stale = receiptHashMismatch(receipt, hash);
    if (stale) return { ok: false, phase: "receipt", reason: `receipt is for another transaction: ${stale}`, hash };
    const failure = executionFailure(receipt);
    if (failure) return { ok: false, phase: "execute", reason: failure, hash, receipt };
    return { ok: true, hash, receipt };
  }

  async function deployContract(code, args = []) {
    let hash;
    try {
      hash = await paced(() => client.deployContract({ code, args, consensusMaxRotations: 5, fees: transactionFees() }));
    } catch (err) {
      return { ok: false, phase: "submit", reason: err.message };
    }
    let receipt;
    try {
      receipt = await waitReceipt(hash);
    } catch (err) {
      return { ok: false, phase: "receipt", reason: err.message, hash };
    }
    const stale = receiptHashMismatch(receipt, hash);
    if (stale) return { ok: false, phase: "receipt", reason: `receipt is for another transaction: ${stale}`, hash };
    const failure = executionFailure(receipt);
    if (failure) return { ok: false, phase: "execute", reason: failure, hash };
    return { ok: true, hash, address: receipt.contract_address || receipt.to_address };
  }

  const balance = (address) => paced(() => client.getBalance({ address: address ?? client.account.address }));

  return { client, paced, readFrom, readJson, writeTo, deployContract, balance, waitReceipt, executionFailure, receiptHashMismatch };
}

module.exports = { makeClient, createRawClient, makeDriver, readKeyFromEnv, transactionFees, sleep, fmt };
