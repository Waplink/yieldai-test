"use client";

import { WalletProvider as SolanaWalletProvider, ConnectionProvider } from "@solana/wallet-adapter-react";
import {
  PhantomWalletAdapter,
  SolflareWalletAdapter,
  CoinbaseWalletAdapter,
  TorusWalletAdapter,
  LedgerWalletAdapter,
} from "@solana/wallet-adapter-wallets";
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
  
  // Most wallets register themselves as Standard Wallets automatically,
  // but Phantom may not work correctly when Aptos cross-chain is also enabled.
  // Explicitly include PhantomWalletAdapter to ensure Phantom Solana works independently.
  const wallets = useMemo(
    () => [
      new PhantomWalletAdapter(),
      new SolflareWalletAdapter(),
      new CoinbaseWalletAdapter(),
      new TorusWalletAdapter(),
      new LedgerWalletAdapter(),
    ],
    []
  );

  return (
    <ConnectionProvider endpoint={endpoint}>
      <SolanaWalletProvider 
        wallets={wallets} 
        autoConnect 
        localStorageKey="walletName"
        onError={(error) => {
          const name = (error as { name?: string })?.name;
          // Suppress expected errors during disconnect/reconnect flows
          if (
            name === "WalletDisconnectedError" ||
            name === "WalletNotConnectedError" ||
            name === "WalletNotSelectedError"
          ) {
            return;
          }
          console.error("Solana wallet error:", error);
        }}
      >
        {children}
      </SolanaWalletProvider>
    </ConnectionProvider>
  );
}
