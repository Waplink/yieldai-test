"use client";

import { useEffect, useRef } from "react";
import { useWallet } from "@aptos-labs/wallet-adapter-react";
import { getAptosWalletNameFromStorage } from "@/lib/aptosWalletUtils";

const LOG = "[aptos-restore]";
const SKIP_DERIVED_KEY = "skip_auto_connect_derived_aptos";

function isDerivedName(name: string): boolean {
  return String(name).trim().endsWith(" (Solana)");
}

/**
 * Controlled Aptos restore from localStorage ("AptosWalletName").
 * We keep Aptos and Solana independent by default:
 * - If user explicitly disconnected derived on /bridge, we set sessionStorage SKIP_DERIVED_KEY=1.
 *   In that case we DO NOT auto-connect derived again.
 * - Native wallets (Petra, etc.) are allowed to restore even when skip is set.
 */
export function AptosWalletRestore({ children }: { children: React.ReactNode }) {
  const { wallets, wallet, connected, connect } = useWallet();
  const prevConnected = useRef<boolean>(connected);
  const hasTriggeredConnect = useRef(false);

  // If disconnected externally, allow restore again
  useEffect(() => {
    const was = prevConnected.current;
    if (was && !connected) {
      hasTriggeredConnect.current = false;
    }
    prevConnected.current = connected;
  }, [connected]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (connected) return;
    if (!wallets?.length) return;
    if (hasTriggeredConnect.current) return;

    const stored = getAptosWalletNameFromStorage();
    if (!stored) return;

    const skipDerived = sessionStorage.getItem(SKIP_DERIVED_KEY) === "1";
    if (skipDerived && isDerivedName(stored)) {
      if (typeof console !== "undefined" && console.log) {
        console.log(LOG, "Skip derived restore due to user disconnect:", stored);
      }
      return;
    }

    const exists = wallets.some((w) => w.name === stored);
    if (!exists) return;

    hasTriggeredConnect.current = true;
    try {
      if (typeof console !== "undefined" && console.log) {
        console.log(LOG, "Restoring Aptos wallet:", stored);
      }
      connect(stored);
    } catch (e) {
      // allow retries
      hasTriggeredConnect.current = false;
      if (typeof console !== "undefined" && console.warn) {
        console.warn(LOG, "connect() threw:", (e as any)?.message ?? e);
      }
    }

    const delays = [200, 600, 1500, 3500];
    const timers = delays.map((ms) =>
      setTimeout(() => {
        if (connected) return;
        if (hasTriggeredConnect.current) return;
        try {
          hasTriggeredConnect.current = true;
          connect(stored);
        } catch {
          hasTriggeredConnect.current = false;
        }
      }, ms)
    );
    return () => timers.forEach((t) => clearTimeout(t));
  }, [connected, wallets, connect, wallet?.name]);

  return <>{children}</>;
}

