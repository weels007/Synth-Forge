"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import {
  connectWallet,
  loadDeployment,
  loadSnapshot,
  submit,
  type Snapshot,
  type Wallet,
} from "../lib/synthforge";

export type Notice = {
  kind: "ok" | "err";
  text: string;
  hash?: string;
  /** ACCEPTED is not FINALIZED: the appeal window is still open. */
  status?: string;
};

type VaultContextValue = {
  address: string;
  snapshot: Snapshot | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  wallet: Wallet | null;
  connect: () => Promise<void>;
  act: (functionName: string, args: unknown[], label: string) => Promise<boolean>;
  busy: string | null;
  notice: Notice | null;
  clearNotice: () => void;
};

const VaultContext = createContext<VaultContextValue | null>(null);

function message(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function VaultProvider({ children }: { children: React.ReactNode }) {
  const [address, setAddress] = useState<string>(process.env.NEXT_PUBLIC_SYNTHFORGE_ADDRESS ?? "");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const addressRef = useRef(address);
  // Once a book has been read, a failed poll is a stale mark, not a missing book.
  const hasData = useRef(false);

  addressRef.current = address;

  const reload = useCallback(async () => {
    const target = addressRef.current;
    if (!target) {
      setLoading(false);
      setError("No contract address. Publish frontend/public/deployment.json with the deploy script, or set NEXT_PUBLIC_SYNTHFORGE_ADDRESS.");
      return;
    }
    setLoading(true);
    try {
      setSnapshot(await loadSnapshot(target));
      hasData.current = true;
      setError(null);
    } catch (loadError) {
      // A snapshot costs seven reads; a public node that rate-limits a poll must
      // not blank a book that was already on screen.
      if (!hasData.current) setError(message(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  // The published deployment wins over the build-time default.
  useEffect(() => {
    let cancelled = false;
    loadDeployment()
      .then((deployment) => {
        if (!cancelled && deployment?.address) {
          addressRef.current = deployment.address;
          setAddress(deployment.address);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) void reload();
      });
    return () => {
      cancelled = true;
    };
  }, [reload]);

  // A desk left open should not show a stale book - but a tab left in the
  // background should not spend the node's hourly read budget either.
  useEffect(() => {
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      void reload();
    }, 120000);
    return () => clearInterval(timer);
  }, [reload]);

  const connect = useCallback(async () => {
    try {
      setWallet(await connectWallet());
      setNotice({ kind: "ok", text: "Wallet connected. Writes are signed in the browser." });
    } catch (connectError) {
      setNotice({ kind: "err", text: message(connectError) });
    }
  }, []);

  const act = useCallback(
    async (functionName: string, args: unknown[], label: string) => {
      if (!wallet) {
        setNotice({ kind: "err", text: "Connect a wallet first: writes are signed in the browser, never by the page." });
        return false;
      }
      setBusy(label);
      setNotice(null);
      try {
        const result = await submit(wallet.client, addressRef.current, functionName, args);
        setNotice({
          kind: "ok",
          text: `${label} executed: ${result.status}. Accepted is not final until the appeal window closes.`,
          hash: result.hash,
          status: result.status,
        });
        await reload();
        return true;
      } catch (writeError) {
        setNotice({ kind: "err", text: message(writeError) });
        return false;
      } finally {
        setBusy(null);
      }
    },
    [wallet, reload],
  );

  const value = useMemo<VaultContextValue>(
    () => ({
      address,
      snapshot,
      loading,
      error,
      reload,
      wallet,
      connect,
      act,
      busy,
      notice,
      clearNotice: () => setNotice(null),
    }),
    [address, snapshot, loading, error, reload, wallet, connect, act, busy, notice],
  );

  return <VaultContext.Provider value={value}>{children}</VaultContext.Provider>;
}

export function useVault(): VaultContextValue {
  const value = useContext(VaultContext);
  if (!value) throw new Error("useVault must be used inside <VaultProvider>");
  return value;
}

export function usePortfolio() {
  const { snapshot } = useVault();
  const portfolio = snapshot?.portfolios?.[0] ?? null;
  const strategies = snapshot?.strategies ?? [];
  const active = strategies.find((row) => row.strategy_id === portfolio?.active_strategy_id) ?? null;
  const proofs = snapshot?.proofs ?? [];
  return { portfolio, strategies, active, proofs, info: snapshot?.info ?? null, assets: snapshot?.assets ?? [], positions: snapshot?.positions ?? [] };
}
