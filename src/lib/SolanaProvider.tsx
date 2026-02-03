"use client";

import { WalletProvider as SolanaWalletProvider, ConnectionProvider } from "@solana/wallet-adapter-react";
import {
  PhantomWalletAdapter,
  SolflareWalletAdapter,
  CoinbaseWalletAdapter,
  TorusWalletAdapter,
  LedgerWalletAdapter,
} from "@solana/wallet-adapter-wallets";
import { TrustWalletAdapter } from "@solana/wallet-adapter-trust";
import { useMemo, type ReactNode } from "react";

const WALLET_NAME_KEY = "walletName";

/** Normalize walletName to valid JSON so adapter's JSON.parse() does not throw (e.g. "Trust" → "\"Trust\""). */
function normalizeWalletNameStorage() {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(WALLET_NAME_KEY);
    if (raw == null || raw === "") return;
    JSON.parse(raw);
  } catch {
    const raw = window.localStorage.getItem(WALLET_NAME_KEY);
    if (raw != null && raw !== "") {
      window.localStorage.setItem(WALLET_NAME_KEY, JSON.stringify(raw));
    }
  }
}

export function SolanaProvider({ children }: { children: ReactNode }) {
  normalizeWalletNameStorage();

  const endpoint = useMemo(
    () =>
      process.env.NEXT_PUBLIC_SOLANA_RPC_URL ||
      process.env.SOLANA_RPC_URL ||
      (process.env.NEXT_PUBLIC_SOLANA_RPC_API_KEY || process.env.SOLANA_RPC_API_KEY
        ? `https://mainnet.helius-rpc.com/?api-key=${process.env.NEXT_PUBLIC_SOLANA_RPC_API_KEY || process.env.SOLANA_RPC_API_KEY}`
        : "https://mainnet.helius-rpc.com/?api-key=29798653-2d13-4d8a-96ad-df70b015e234"),
    []
  );
  const wallets = useMemo(
    () => [
      new SolflareWalletAdapter(),
      new CoinbaseWalletAdapter(),
      new TorusWalletAdapter(),
      new LedgerWalletAdapter(),
    ],
    []
  );

  return (
    <ConnectionProvider endpoint={endpoint}>
      <SolanaWalletProvider wallets={wallets} autoConnect localStorageKey="walletName">
        {children}
      </SolanaWalletProvider>
    </ConnectionProvider>
  );
}
