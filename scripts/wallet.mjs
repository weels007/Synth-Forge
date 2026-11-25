// Wallet access for this project: the keystores in ../wallet are the only
// source of truth. Keys are decrypted in memory only, never printed, never
// copied to disk, and never imported into the CLI store.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";

// Resolved next to the checkout, so no machine path is baked into the source:
// <repo>/../wallet, or SYNTHFORGE_WALLET_DIR when the keys live elsewhere.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DIR = path.join(REPO_ROOT, "..", "wallet");

export function walletDir() {
  return process.env.SYNTHFORGE_WALLET_DIR || DEFAULT_DIR;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

function decryptKeystore(keystore, password) {
  const spec = keystore.crypto;
  const kdf = spec.kdfparams;
  const derived = crypto.scryptSync(
    Buffer.from(String(password).normalize("NFC"), "utf-8"),
    Buffer.from(kdf.salt, "hex"),
    kdf.dklen,
    { N: kdf.n, r: kdf.r, p: kdf.p, maxmem: 1024 * 1024 * 1024 },
  );
  const ciphertext = Buffer.from(spec.ciphertext, "hex");
  return { derived, ciphertext, iv: Buffer.from(spec.cipherparams.iv, "hex") };
}

/** Unlock <name>-keystore.json with <name>.password and return a viem account. */
export async function loadWallet(name = "global") {
  const dir = walletDir();
  const keystoreFile = path.join(dir, name + "-keystore.json");
  const passwordFile = path.join(dir, name + ".password");
  if (!fs.existsSync(keystoreFile)) throw new Error("keystore not found: " + keystoreFile);
  if (!fs.existsSync(passwordFile)) throw new Error("password file not found: " + passwordFile);
  const keystore = readJson(keystoreFile);
  const password = fs.readFileSync(passwordFile, "utf-8").trim();
  const unlocked = decryptKeystore(keystore, password);
  const { keccak256 } = await import("viem");
  const macInput = Buffer.concat([unlocked.derived.subarray(16, 32), unlocked.ciphertext]);
  const mac = keccak256(macInput).slice(2).toLowerCase();
  if (mac !== String(keystore.crypto.mac).toLowerCase()) {
    throw new Error("keystore MAC mismatch for " + name + ": wrong password or corrupted file");
  }
  const decipher = crypto.createDecipheriv("aes-128-ctr", unlocked.derived.subarray(0, 16), unlocked.iv);
  const secret = Buffer.concat([decipher.update(unlocked.ciphertext), decipher.final()]);
  const hexKey = "0x" + secret.toString("hex");
  const account = privateKeyToAccount(hexKey);
  secret.fill(0);
  const derivedHex = "0x" + account.address.toLowerCase().slice(2);
  const storedHex = "0x" + String(keystore.address).toLowerCase().replace(/^0x/, "");
  if (derivedHex !== storedHex) {
    throw new Error("decrypted key does not match keystore address for " + name);
  }
  return { name: name, address: account.address, account: account, privateKey: hexKey, keystorePath: keystoreFile };
}

/** Addresses only, no unlocking — safe for a status readout. */
export function listWallets() {
  const dir = walletDir();
  if (!fs.existsSync(dir)) return [];
  const entries = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith("-keystore.json")) continue;
    const name = file.replace("-keystore.json", "");
    const keystore = readJson(path.join(dir, file));
    entries.push({
      name: name,
      address: "0x" + String(keystore.address).replace(/^0x/, ""),
      unlockable: fs.existsSync(path.join(dir, name + ".password")),
    });
  }
  return entries;
}

export async function loadActors() {
  const actors = {};
  for (const entry of listWallets()) {
    if (!entry.unlockable) continue;
    actors[entry.name] = await loadWallet(entry.name);
  }
  return actors;
}
