"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useSolanaPortfolio } from "@/hooks/useSolanaPortfolio";
import { formatCurrency, formatNumber } from "@/lib/utils/numberFormat";
import { useWallet as useSolanaWallet } from "@solana/wallet-adapter-react";
import { Connection, PublicKey, SystemProgram, Transaction, VersionedTransaction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
} from "@solana/spl-token";
import { useToast } from "@/components/ui/use-toast";
import { ToastAction } from "@/components/ui/toast";
import { JupiterDepositModal } from "@/components/ui/jupiter-deposit-modal";
import { JupiterWithdrawModal } from "@/components/ui/jupiter-withdraw-modal";
import { getSolanaWalletAddress } from "@/lib/wallet/getSolanaWalletAddress";
import { useWallet as useAptosWallet } from "@aptos-labs/wallet-adapter-react";

type JupiterPosition = {
  token?: {
    totalRate?: string;
    asset?: {
      address?: string;
      symbol?: string;
      uiSymbol?: string;
      decimals?: number;
      price?: string;
      logoUrl?: string;
    };
  };
  underlyingAssets?: string;
};

const WSOL_MINT = "So11111111111111111111111111111111111111112";
const USDG_MINT = "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH";
const JUPITER_PREFER_LEGACY_DEPOSIT_MINTS = new Set([WSOL_MINT, USDG_MINT]);
const JUPITER_PREFER_LEGACY_SYMBOLS = new Set(["WSOL", "USDG"]);
const SOL_FEE_RESERVE_UI = 0.003;
const JUPITER_MINT_BY_SYMBOL: Record<string, string> = {
  WSOL: WSOL_MINT,
  USDG: USDG_MINT,
  USDS: "USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA",
};

function toNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const message = (error.message || "").trim();
    if (message.length > 0) return message;
    const name = (error.name || "").trim();
    if (name.length > 0) return name;
    return "Unknown error";
  }
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const maybeName = (error as { name?: unknown }).name;
    const maybeMessage = (error as { message?: unknown }).message;
    if (typeof maybeMessage === "string" && maybeMessage.trim().length > 0) {
      return maybeMessage;
    }
    if (typeof maybeName === "string" && maybeName.trim().length > 0) {
      return maybeName;
    }
    try {
      return JSON.stringify(error);
    } catch {
      return "Unknown error";
    }
  }
  return "Unknown error";
}

function isWalletNotSelected(error: unknown): boolean {
  if (!error) return false;
  const asObj = error as { name?: unknown; message?: unknown };
  const name = typeof asObj.name === "string" ? asObj.name.toLowerCase() : "";
  const message = typeof asObj.message === "string" ? asObj.message.toLowerCase() : "";
  return name.includes("walletnotselected") || message.includes("walletnotselected") || message.includes("wallet not selected");
}

function decodeBase64Tx(base64Tx: string): Uint8Array {
  const decoded = atob(base64Tx);
  return Uint8Array.from(decoded, (char) => char.charCodeAt(0));
}

function isVersionedTransactionBytes(serialized: Uint8Array): boolean {
  return serialized.length > 0 && (serialized[0] & 0x80) !== 0;
}

function toBase58Address(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof (value as { toBase58?: () => string }).toBase58 === "function") {
    try {
      return (value as { toBase58: () => string }).toBase58();
    } catch {
      // noop
    }
  }
  if (typeof (value as { toString?: () => string }).toString === "function") {
    try {
      return (value as { toString: () => string }).toString();
    } catch {
      // noop
    }
  }
  return "";
}

function normalizeMint(value?: string | null): string {
  return (value ?? "").trim();
}

function canonicalJupiterSymbol(value?: string | null): string {
  const normalized = (value ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (normalized.startsWith("WSOL")) return "WSOL";
  if (normalized.startsWith("SOL")) return "WSOL";
  if (normalized.startsWith("USDG")) return "USDG";
  if (normalized.startsWith("USDS")) return "USDS";
  return normalized;
}

function sortByValueDesc(items: JupiterPosition[]): JupiterPosition[] {
  return [...items].sort((a, b) => {
    const da = a.token?.asset?.decimals ?? 0;
    const db = b.token?.asset?.decimals ?? 0;
    const aa = toNumber(a.underlyingAssets, 0) / Math.pow(10, da || 0);
    const ab = toNumber(b.underlyingAssets, 0) / Math.pow(10, db || 0);
    const pa = toNumber(a.token?.asset?.price, 0);
    const pb = toNumber(b.token?.asset?.price, 0);
    return ab * pb - aa * pa;
  });
}

export function JupiterPositions() {
  const { address: solanaAddress, tokens: solanaTokens, refresh: refreshSolana } = useSolanaPortfolio();
  const { wallet: aptosWallet } = useAptosWallet();
  const {
    publicKey,
    signTransaction,
    sendTransaction,
    connecting: solanaConnecting,
    wallet: solanaWallet,
    wallets: solanaWallets,
    select: selectSolanaWallet,
    connect: connectSolanaWallet,
  } = useSolanaWallet();
  const { toast } = useToast();
  const [positions, setPositions] = useState<JupiterPosition[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedPosition, setSelectedPosition] = useState<JupiterPosition | null>(null);
  const [isDepositOpen, setIsDepositOpen] = useState(false);
  const [isDepositing, setIsDepositing] = useState(false);
  const [isWithdrawOpen, setIsWithdrawOpen] = useState(false);
  const [isWithdrawing, setIsWithdrawing] = useState(false);
  const adapterPublicKey = (solanaWallet?.adapter?.publicKey as PublicKey | null) ?? null;
  const adapterAddress = toBase58Address(adapterPublicKey);
  const derivedSolanaAddress = getSolanaWalletAddress(aptosWallet ?? null) ?? "";
  // IMPORTANT: signer address must come from active Solana adapter/publicKey only.
  // Do not use derived/fallback portfolio addresses for transaction signer.
  const effectiveSignerAddress = toBase58Address(publicKey) || adapterAddress || "";
  const adapterSignTransaction =
    typeof (solanaWallet?.adapter as { signTransaction?: unknown } | undefined)?.signTransaction === "function"
      ? ((solanaWallet?.adapter as { signTransaction: (transaction: Transaction) => Promise<Transaction> }).signTransaction.bind(
          solanaWallet?.adapter
        ) as (transaction: Transaction) => Promise<Transaction>)
      : undefined;
  const adapterSendTransaction =
    typeof (solanaWallet?.adapter as { sendTransaction?: unknown } | undefined)?.sendTransaction === "function"
      ? ((solanaWallet?.adapter as {
          sendTransaction: (
            transaction: unknown,
            connection: Connection,
            options?: { skipPreflight?: boolean; preflightCommitment?: "processed" | "confirmed" | "finalized" }
          ) => Promise<string>;
        }).sendTransaction.bind(solanaWallet?.adapter) as (
          transaction: unknown,
          connection: Connection,
          options?: { skipPreflight?: boolean; preflightCommitment?: "processed" | "confirmed" | "finalized" }
        ) => Promise<string>)
      : undefined;
  const activeSignTransaction = signTransaction ?? adapterSignTransaction;
  const activeSendTransaction = sendTransaction ?? adapterSendTransaction;
  const isTrustWallet = (solanaWallet?.adapter?.name || "").toLowerCase().includes("trust");
  const hasAnySolanaSession =
    !!effectiveSignerAddress ||
    !!solanaAddress ||
    !!derivedSolanaAddress ||
    !!solanaConnecting ||
    !!solanaWallet?.adapter?.connected;
  const rpcEndpoint = useMemo(() => {
    return (
      process.env.NEXT_PUBLIC_SOLANA_RPC_URL ||
      process.env.SOLANA_RPC_URL ||
      (process.env.NEXT_PUBLIC_SOLANA_RPC_API_KEY || process.env.SOLANA_RPC_API_KEY
        ? `https://mainnet.helius-rpc.com/?api-key=${process.env.NEXT_PUBLIC_SOLANA_RPC_API_KEY || process.env.SOLANA_RPC_API_KEY}`
        : "https://mainnet.helius-rpc.com/?api-key=29798653-2d13-4d8a-96ad-df70b015e234")
    );
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!solanaAddress) {
        setPositions([]);
        return;
      }
      try {
        setLoading(true);
        setError(null);
        const res = await fetch(`/api/protocols/jupiter/userPositions?address=${encodeURIComponent(solanaAddress)}`);
        const data = await res.json().catch(() => null);
        const list = Array.isArray(data?.data) ? data.data : [];
        if (!cancelled) {
          setPositions(sortByValueDesc(list));
        }
      } catch {
        if (!cancelled) {
          setError("Failed to load Jupiter positions");
          setPositions([]);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    load();
    const handleRefresh: EventListener = (evt) => {
      const event = evt as CustomEvent<{ protocol?: string }>;
      if (event?.detail?.protocol === "jupiter") {
        void load();
      }
    };
    window.addEventListener("refreshPositions", handleRefresh);
    return () => {
      cancelled = true;
      window.removeEventListener("refreshPositions", handleRefresh);
    };
  }, [solanaAddress]);

  const totalValue = useMemo(
    () =>
      positions.reduce((sum, p) => {
        const decimals = toNumber(p?.token?.asset?.decimals, 0);
        const amount = toNumber(p?.underlyingAssets, 0) / Math.pow(10, decimals || 0);
        const price = toNumber(p?.token?.asset?.price, 0);
        return sum + amount * price;
      }, 0),
    [positions]
  );

  const selectedMeta = useMemo(() => {
    const p = selectedPosition;
    const decimals = toNumber(p?.token?.asset?.decimals, 0);
    const rawAmount = toNumber(p?.underlyingAssets, 0);
    const amount = decimals > 0 ? rawAmount / Math.pow(10, decimals) : 0;
    const symbol = p?.token?.asset?.uiSymbol || p?.token?.asset?.symbol || "Unknown";
    const mint = p?.token?.asset?.address || "";
    const canonicalSymbol = canonicalJupiterSymbol(symbol);
    return { decimals, amount, symbol, mint, canonicalSymbol };
  }, [selectedPosition]);

  const selectedWalletAmount = useMemo(() => {
    if (!selectedMeta.mint) return 0;
    const walletToken = solanaTokens.find((token) => token.address === selectedMeta.mint);
    if (!walletToken) return 0;
    const rawAmount = Number(walletToken.amount);
    const decimals = Number(walletToken.decimals);
    if (!Number.isFinite(rawAmount) || !Number.isFinite(decimals) || decimals < 0) return 0;
    return rawAmount / Math.pow(10, decimals);
  }, [selectedMeta.mint, solanaTokens]);

  const onDepositClick = (position: JupiterPosition) => {
    setSelectedPosition(position);
    setIsDepositOpen(true);
  };

  const closeDeposit = () => {
    setIsDepositOpen(false);
    setSelectedPosition(null);
  };

  const onWithdrawClick = (position: JupiterPosition) => {
    setSelectedPosition(position);
    setIsWithdrawOpen(true);
  };

  const closeWithdraw = () => {
    setIsWithdrawOpen(false);
    setSelectedPosition(null);
  };

  const resolveSolanaSession = useCallback(() => {
    const connectedAdapterFromList = solanaWallets.find((w) => w?.adapter?.connected)?.adapter;
    const runtimeAdapter = (solanaWallet?.adapter || connectedAdapterFromList) as
      | {
          connected?: boolean;
          publicKey?: PublicKey | null;
          sendTransaction?: (
            transaction: unknown,
            connection: Connection,
            options?: { skipPreflight?: boolean; preflightCommitment?: "processed" | "confirmed" | "finalized" }
          ) => Promise<string>;
          signTransaction?: (transaction: Transaction) => Promise<Transaction>;
        }
      | undefined;
    const runtimeAdapterAddress = toBase58Address(runtimeAdapter?.publicKey);
    const runtimeSignerAddress = toBase58Address(publicKey) || runtimeAdapterAddress || "";

    const adapterSend =
      typeof runtimeAdapter?.sendTransaction === "function"
        ? runtimeAdapter.sendTransaction.bind(runtimeAdapter)
        : undefined;
    const adapterSign =
      typeof runtimeAdapter?.signTransaction === "function"
        ? runtimeAdapter.signTransaction.bind(runtimeAdapter)
        : undefined;
    const runtimeSend = runtimeAdapter?.connected
      ? (adapterSend ?? activeSendTransaction)
      : (activeSendTransaction ?? adapterSend);
    const runtimeSign = runtimeAdapter?.connected
      ? (adapterSign ?? activeSignTransaction)
      : (activeSignTransaction ?? adapterSign);

    return {
      adapter: runtimeAdapter,
      signerAddress: runtimeSignerAddress,
      sendTransaction: runtimeSend,
      signTransaction: runtimeSign,
      hasSigner: !!runtimeSend || !!runtimeSign,
      hasSession:
        !!runtimeSignerAddress ||
        !!runtimeAdapter?.connected ||
        !!solanaConnecting ||
        !!solanaAddress ||
        !!getSolanaWalletAddress(aptosWallet ?? null),
    };
  }, [
    solanaWallets,
    solanaWallet,
    publicKey,
    effectiveSignerAddress,
    activeSendTransaction,
    activeSignTransaction,
    solanaConnecting,
    solanaAddress,
    aptosWallet,
  ]);

  const waitForReadySolanaSession = useCallback(
    async (retries = 12, delayMs = 150) => {
      let session = resolveSolanaSession();
      for (let i = 0; i < retries && (!session.signerAddress || !session.hasSigner); i++) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        session = resolveSolanaSession();
      }
      return session;
    },
    [resolveSolanaSession]
  );

  const recoverSolanaWalletSelection = useCallback(async () => {
    const preferredName =
      (solanaWallet?.adapter?.name as string | undefined) ||
      (solanaWallets.find((w) => w?.adapter?.connected)?.adapter?.name as string | undefined) ||
      (() => {
        try {
          const raw = window.localStorage.getItem("walletName");
          if (!raw) return undefined;
          const parsed = JSON.parse(raw);
          return typeof parsed === "string" ? parsed : undefined;
        } catch {
          return undefined;
        }
      })();

    if (!preferredName) return;

    const exists = solanaWallets.some((w) => w?.adapter?.name === preferredName);
    if (exists && typeof selectSolanaWallet === "function") {
      try {
        selectSolanaWallet(preferredName as any);
      } catch {
        // ignore
      }
    }

    if (typeof connectSolanaWallet === "function") {
      try {
        await connectSolanaWallet();
      } catch {
        // ignore
      }
    }
  }, [solanaWallet, solanaWallets, selectSolanaWallet, connectSolanaWallet]);

  const handleDeposit = async (amountUi: number) => {
    if (!selectedPosition) return;
    setIsDepositing(true);
    const session = await waitForReadySolanaSession();
    let resolvedSignerAddress = session.signerAddress || effectiveSignerAddress;
    let resolvedSendTransaction = session.sendTransaction ?? activeSendTransaction;
    let resolvedSignTransaction = session.signTransaction ?? activeSignTransaction;

    if (!resolvedSignerAddress || (!resolvedSendTransaction && !resolvedSignTransaction)) {
      const adapter = (session.adapter ||
        solanaWallet?.adapter ||
        solanaWallets.find((w) => w?.adapter?.connected)?.adapter) as { connect?: () => Promise<void> } | undefined;
      if (adapter && typeof adapter.connect === "function") {
        try {
          await adapter.connect();
        } catch (reconnectError) {
          console.warn("[Jupiter][Deposit] adapter reconnect failed", reconnectError);
        }
        const retried = await waitForReadySolanaSession(8, 250);
        resolvedSignerAddress = retried.signerAddress || effectiveSignerAddress;
        resolvedSendTransaction = retried.sendTransaction ?? resolvedSendTransaction;
        resolvedSignTransaction = retried.signTransaction ?? resolvedSignTransaction;
      }
    }

    if (!resolvedSignerAddress || (!resolvedSendTransaction && !resolvedSignTransaction)) {
      await recoverSolanaWalletSelection();
      const retriedAfterSelect = await waitForReadySolanaSession(10, 150);
      resolvedSignerAddress = retriedAfterSelect.signerAddress || effectiveSignerAddress;
      resolvedSendTransaction = retriedAfterSelect.sendTransaction ?? resolvedSendTransaction;
      resolvedSignTransaction = retriedAfterSelect.signTransaction ?? resolvedSignTransaction;
    }

    // Continue when we have an address but signer APIs are still warming up:
    // submit path has an extra signer re-resolve and WalletNotSelected retry.
    if (!resolvedSignerAddress) {
      const finalRetry = await waitForReadySolanaSession(12, 250);
      resolvedSignerAddress = finalRetry.signerAddress || effectiveSignerAddress;
      resolvedSendTransaction = finalRetry.sendTransaction ?? resolvedSendTransaction ?? activeSendTransaction;
      resolvedSignTransaction = finalRetry.signTransaction ?? resolvedSignTransaction ?? activeSignTransaction;
    }

    if (!resolvedSignerAddress) {
      if (session.hasSession || hasAnySolanaSession) {
        toast({
          title: "Solana wallet reconnecting",
          description: "Wallet address is unavailable after reconnect. Reconnect Solana wallet and try again.",
        });
        setIsDepositing(false);
        return;
      }
      toast({
        title: "Wallet not connected",
        description: "Connect Solana wallet to deposit to Jupiter.",
        variant: "destructive",
      });
      setIsDepositing(false);
      return;
    }

    if (!Number.isFinite(amountUi) || amountUi <= 0) {
      toast({
        title: "Invalid amount",
        description: "Enter a valid deposit amount.",
        variant: "destructive",
      });
      setIsDepositing(false);
      return;
    }

    const { decimals, mint, symbol } = selectedMeta;
    if (!mint) {
      toast({
        title: "Token error",
        description: "Jupiter token address is missing.",
        variant: "destructive",
      });
      setIsDepositing(false);
      return;
    }

    const amountBaseUnits = Math.floor(amountUi * Math.pow(10, decimals));
    if (!Number.isFinite(amountBaseUnits) || amountBaseUnits <= 0) {
      toast({
        title: "Amount too small",
        description: "Increase amount to meet token precision.",
        variant: "destructive",
      });
      setIsDepositing(false);
      return;
    }

    const normalizedMint = normalizeMint(mint);
    const canonicalMint = JUPITER_MINT_BY_SYMBOL[selectedMeta.canonicalSymbol || ""] || normalizedMint;
    const preferLegacyInstruction =
      JUPITER_PREFER_LEGACY_DEPOSIT_MINTS.has(canonicalMint) ||
      JUPITER_PREFER_LEGACY_SYMBOLS.has(selectedMeta.canonicalSymbol || "");
    const isWsolDeposit = canonicalMint === WSOL_MINT || selectedMeta.canonicalSymbol === "WSOL";

    try {
      const connection = new Connection(rpcEndpoint, "confirmed");
      if (isWsolDeposit) {
        const maxSpendableSol = Math.max(0, selectedWalletAmount - SOL_FEE_RESERVE_UI);
        if (amountUi > maxSpendableSol + 1e-12) {
          toast({
            title: "Leave SOL for fees",
            description: `For SOL deposits, keep about ${SOL_FEE_RESERVE_UI} SOL for network fees. Max now: ${maxSpendableSol.toFixed(6)} SOL.`,
            variant: "destructive",
          });
          setIsDepositing(false);
          return;
        }

        const owner = new PublicKey(resolvedSignerAddress);
        const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, owner, false);
        const { blockhash: wrapBlockhash, lastValidBlockHeight: wrapLastValidBlockHeight } =
          await connection.getLatestBlockhash("confirmed");
        const wrapTx = new Transaction();
        wrapTx.feePayer = owner;
        wrapTx.recentBlockhash = wrapBlockhash;
        wrapTx.add(createAssociatedTokenAccountIdempotentInstruction(owner, wsolAta, owner, NATIVE_MINT));
        wrapTx.add(
          SystemProgram.transfer({
            fromPubkey: owner,
            toPubkey: wsolAta,
            lamports: amountBaseUnits,
          })
        );
        wrapTx.add(createSyncNativeInstruction(wsolAta));

        let wrapSignature: string;
        if (resolvedSendTransaction && !isTrustWallet) {
          try {
            wrapSignature = await resolvedSendTransaction(wrapTx as any, connection, {
              skipPreflight: false,
              preflightCommitment: "confirmed",
            });
          } catch (sendError) {
            if (!resolvedSignTransaction) {
              throw sendError instanceof Error ? sendError : new Error(getErrorMessage(sendError));
            }
            const signedWrap = await resolvedSignTransaction(wrapTx as any);
            wrapSignature = await connection.sendRawTransaction(signedWrap.serialize(), {
              skipPreflight: false,
              preflightCommitment: "confirmed",
            });
          }
        } else {
          if (!resolvedSignTransaction) {
            throw new Error("Wallet API is unavailable after reconnect. Reconnect Solana wallet and try again.");
          }
          try {
            const signedWrap = await resolvedSignTransaction(wrapTx as any);
            wrapSignature = await connection.sendRawTransaction(signedWrap.serialize(), {
              skipPreflight: false,
              preflightCommitment: "confirmed",
            });
          } catch (signError) {
            if (!resolvedSendTransaction) {
              throw signError instanceof Error ? signError : new Error(getErrorMessage(signError));
            }
            wrapSignature = await resolvedSendTransaction(wrapTx as any, connection, {
              skipPreflight: false,
              preflightCommitment: "confirmed",
            });
          }
        }

        const wrapConfirmation = await connection.confirmTransaction(
          {
            signature: wrapSignature,
            blockhash: wrapBlockhash,
            lastValidBlockHeight: wrapLastValidBlockHeight,
          },
          "confirmed"
        );
        if (wrapConfirmation.value.err) {
          throw new Error(`SOL wrap failed: ${JSON.stringify(wrapConfirmation.value.err)}`);
        }
      }

      const txResp = await fetch("/api/protocols/jupiter/deposit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          asset: canonicalMint || normalizedMint || mint,
          signer: resolvedSignerAddress,
          amount: String(amountBaseUnits),
          preferLegacyInstruction,
        }),
      });

      const txData = await txResp.json().catch(() => null);
      if (!txResp.ok || !txData?.success || !txData?.data?.transaction) {
        throw new Error(txData?.error || `Deposit prepare failed: ${txResp.status}`);
      }

      const serialized = decodeBase64Tx(txData.data.transaction);
      let txForWallet: Transaction | VersionedTransaction = isVersionedTransactionBytes(serialized)
        ? VersionedTransaction.deserialize(serialized)
        : Transaction.from(serialized);
      let activeSignerAddressForTx = resolvedSignerAddress;

      if (!resolvedSendTransaction && !resolvedSignTransaction) {
        const retriedBeforeSend = await waitForReadySolanaSession(6, 150);
        resolvedSendTransaction = retriedBeforeSend.sendTransaction ?? resolvedSendTransaction;
        resolvedSignTransaction = retriedBeforeSend.signTransaction ?? resolvedSignTransaction;
      }
      if (!resolvedSendTransaction && !resolvedSignTransaction) {
        throw new Error("Wallet API is unavailable after reconnect. Reconnect Solana wallet and try again.");
      }

      let signature: string | undefined;
      if (resolvedSendTransaction) {
        try {
          signature = await resolvedSendTransaction(txForWallet as any, connection, {
            skipPreflight: false,
            preflightCommitment: "confirmed",
          });
        } catch (sendError) {
          if (isWalletNotSelected(sendError)) {
            let recovered = false;
            for (let attempt = 0; attempt < 2 && !recovered; attempt++) {
              await recoverSolanaWalletSelection();
              const retried = await waitForReadySolanaSession(10, 150);
              const retrySend = retried.sendTransaction;
              const retrySign = retried.signTransaction;
              const retrySignerAddress = retried.signerAddress || activeSignerAddressForTx;
              if (retrySignerAddress && retrySignerAddress !== activeSignerAddressForTx) {
                const retryTxResp = await fetch("/api/protocols/jupiter/deposit", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    asset: canonicalMint || normalizedMint || mint,
                    signer: retrySignerAddress,
                    amount: String(amountBaseUnits),
                    preferLegacyInstruction,
                  }),
                });
                const retryTxData = await retryTxResp.json().catch(() => null);
                if (!retryTxResp.ok || !retryTxData?.success || !retryTxData?.data?.transaction) {
                  throw new Error(retryTxData?.error || `Deposit prepare failed: ${retryTxResp.status}`);
                }
                const retrySerialized = decodeBase64Tx(retryTxData.data.transaction);
                txForWallet = isVersionedTransactionBytes(retrySerialized)
                  ? VersionedTransaction.deserialize(retrySerialized)
                  : Transaction.from(retrySerialized);
                activeSignerAddressForTx = retrySignerAddress;
              }
              try {
                if (retrySend) {
                  signature = await retrySend(txForWallet as any, connection, {
                    skipPreflight: false,
                    preflightCommitment: "confirmed",
                  });
                  recovered = true;
                  break;
                }
                if (retrySign) {
                  const retrySigned = await retrySign(txForWallet as any);
                  signature = await connection.sendRawTransaction(retrySigned.serialize(), {
                    skipPreflight: false,
                    preflightCommitment: "confirmed",
                  });
                  recovered = true;
                  break;
                }
              } catch (retryError) {
                if (!isWalletNotSelected(retryError)) {
                  throw retryError instanceof Error ? retryError : new Error(getErrorMessage(retryError));
                }
              }
            }
            if (!recovered) {
              throw new Error("Wallet API is still syncing after reconnect. Try again in 1-2 seconds.");
            }
          } else {
          if (!resolvedSignTransaction) {
            throw sendError instanceof Error ? sendError : new Error(getErrorMessage(sendError));
          }
          const signed = await resolvedSignTransaction(txForWallet as any);
          signature = await connection.sendRawTransaction(signed.serialize(), {
            skipPreflight: false,
            preflightCommitment: "confirmed",
          });
          }
        }
      } else {
        if (!resolvedSignTransaction) {
          throw new Error("Wallet API is unavailable after reconnect. Reconnect Solana wallet and try again.");
        }
        const signed = await resolvedSignTransaction(txForWallet as any);
        signature = await connection.sendRawTransaction(signed.serialize(), {
          skipPreflight: false,
          preflightCommitment: "confirmed",
        });
      }

      if (!signature) {
        throw new Error("Failed to submit transaction signature");
      }

      const confirmation = await connection.confirmTransaction(signature, "confirmed");
      if (confirmation.value.err) {
        throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
      }

      toast({
        title: "Deposit submitted",
        description: `Deposited ${amountUi} ${symbol}.`,
        action: (
          <ToastAction altText="View on Solscan" onClick={() => window.open(`https://solscan.io/tx/${signature}`, "_blank")}>
            View on Solscan
          </ToastAction>
        ),
      });

      await refreshSolana();
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("refreshPositions", { detail: { protocol: "jupiter" } }));
      }
      closeDeposit();
    } catch (e) {
      const message = getErrorMessage(e);
      const normalized = message.toLowerCase();
      if (normalized.includes("public_signrawtransaction") && normalized.includes("already pending")) {
        toast({
          title: "Signature request already pending",
          description: "Approve or reject the existing wallet request, then try again.",
          variant: "destructive",
        });
        return;
      }
      if (normalized.includes("walletnotselectederror") || normalized.includes("wallet not selected")) {
        toast({
          title: "Solana wallet reconnecting",
          description: "Wallet session is not selected after reconnect. Reconnect Solana wallet and try again.",
          variant: "destructive",
        });
        return;
      }
      if (normalized.includes("user rejected")) {
        toast({
          title: "Transaction cancelled",
          description: "Request was rejected in wallet.",
        });
        return;
      }
      console.error("[Jupiter][Deposit] failed", { message, error: e });
      toast({
        title: "Deposit failed",
        description: message,
        variant: "destructive",
      });
    } finally {
      setIsDepositing(false);
    }
  };

  const handleWithdraw = async (amountUi: number) => {
    if (!selectedPosition) return;
    setIsWithdrawing(true);
    const session = await waitForReadySolanaSession();
    let resolvedSignerAddress = session.signerAddress || effectiveSignerAddress;
    let resolvedSendTransaction = session.sendTransaction ?? activeSendTransaction;
    let resolvedSignTransaction = session.signTransaction ?? activeSignTransaction;

    if (!resolvedSignerAddress || (!resolvedSendTransaction && !resolvedSignTransaction)) {
      const adapter = (session.adapter ||
        solanaWallet?.adapter ||
        solanaWallets.find((w) => w?.adapter?.connected)?.adapter) as { connect?: () => Promise<void> } | undefined;
      if (adapter && typeof adapter.connect === "function") {
        try {
          await adapter.connect();
        } catch (reconnectError) {
          console.warn("[Jupiter][Withdraw] adapter reconnect failed", reconnectError);
        }
        const retried = await waitForReadySolanaSession(8, 150);
        resolvedSignerAddress = retried.signerAddress || effectiveSignerAddress;
        resolvedSendTransaction = retried.sendTransaction ?? resolvedSendTransaction;
        resolvedSignTransaction = retried.signTransaction ?? resolvedSignTransaction;
      }
    }

    if (!resolvedSignerAddress || (!resolvedSendTransaction && !resolvedSignTransaction)) {
      await recoverSolanaWalletSelection();
      const retriedAfterSelect = await waitForReadySolanaSession(10, 150);
      resolvedSignerAddress = retriedAfterSelect.signerAddress || effectiveSignerAddress;
      resolvedSendTransaction = retriedAfterSelect.sendTransaction ?? resolvedSendTransaction;
      resolvedSignTransaction = retriedAfterSelect.signTransaction ?? resolvedSignTransaction;
    }

    if (!resolvedSignerAddress || (!resolvedSendTransaction && !resolvedSignTransaction)) {
      if (session.hasSession || hasAnySolanaSession) {
        toast({
          title: "Solana wallet reconnecting",
          description: "Wallet API is unavailable after auto-reconnect attempts. Reconnect Solana wallet and try again.",
        });
        setIsWithdrawing(false);
        return;
      }
      toast({
        title: "Wallet not connected",
        description: "Connect Solana wallet to withdraw from Jupiter.",
        variant: "destructive",
      });
      setIsWithdrawing(false);
      return;
    }

    if (!Number.isFinite(amountUi) || amountUi <= 0) {
      toast({
        title: "Invalid amount",
        description: "Enter a valid withdraw amount.",
        variant: "destructive",
      });
      setIsWithdrawing(false);
      return;
    }

    const { mint, symbol, amount: suppliedAmount, decimals } = selectedMeta;
    const normalizedWithdrawMint = normalizeMint(mint);
    const canonicalWithdrawMint =
      JUPITER_MINT_BY_SYMBOL[selectedMeta.canonicalSymbol || ""] || normalizedWithdrawMint;
    const preferLegacyWithdrawInstruction =
      JUPITER_PREFER_LEGACY_DEPOSIT_MINTS.has(canonicalWithdrawMint) ||
      JUPITER_PREFER_LEGACY_SYMBOLS.has(selectedMeta.canonicalSymbol || "");

    if (amountUi > suppliedAmount + 1e-12) {
      toast({
        title: "Amount too high",
        description: `Withdraw amount exceeds supplied balance (${formatNumber(suppliedAmount, 6)} ${symbol}).`,
        variant: "destructive",
      });
      setIsWithdrawing(false);
      return;
    }

    if (!mint) {
      toast({
        title: "Token error",
        description: "Jupiter token address is missing.",
        variant: "destructive",
      });
      setIsWithdrawing(false);
      return;
    }

    const amountBaseUnits = Math.floor(amountUi * Math.pow(10, decimals));
    if (!Number.isFinite(amountBaseUnits) || amountBaseUnits <= 0) {
      toast({
        title: "Amount too small",
        description: "Increase amount to meet token precision.",
        variant: "destructive",
      });
      setIsWithdrawing(false);
      return;
    }

    try {
      const txResp = await fetch("/api/protocols/jupiter/withdraw", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          asset: mint,
          signer: resolvedSignerAddress,
          amount: String(amountBaseUnits),
          preferLegacyInstruction: preferLegacyWithdrawInstruction,
        }),
      });

      const txData = await txResp.json().catch(() => null);
      if (!txResp.ok || !txData?.success || !txData?.data?.transaction) {
        console.error("[Jupiter][Withdraw] prepare failed", {
          status: txResp.status,
          body: txData,
        });
        throw new Error(txData?.error || `Withdraw prepare failed: ${txResp.status}`);
      }

      const connection = new Connection(rpcEndpoint, "confirmed");
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");

      const serialized = decodeBase64Tx(txData.data.transaction);
      const transaction = isVersionedTransactionBytes(serialized)
        ? VersionedTransaction.deserialize(serialized)
        : Transaction.from(serialized);
      const effectivePublicKey = new PublicKey(resolvedSignerAddress);
      if (!(transaction instanceof VersionedTransaction)) {
        transaction.recentBlockhash = blockhash;
        transaction.feePayer = effectivePublicKey;
      }

      if (!resolvedSendTransaction && !resolvedSignTransaction) {
        const retriedBeforeSend = await waitForReadySolanaSession(6, 150);
        resolvedSendTransaction = retriedBeforeSend.sendTransaction ?? resolvedSendTransaction;
        resolvedSignTransaction = retriedBeforeSend.signTransaction ?? resolvedSignTransaction;
      }
      if (!resolvedSendTransaction && !resolvedSignTransaction) {
        throw new Error("Wallet API is unavailable after reconnect. Reconnect Solana wallet and try again.");
      }

      let signature: string | undefined;
      let txForWallet: Transaction | VersionedTransaction = transaction;
      let activeSignerAddressForTx = resolvedSignerAddress;
      if (resolvedSendTransaction) {
        try {
          signature = await resolvedSendTransaction(txForWallet as any, connection, {
            skipPreflight: false,
            preflightCommitment: "confirmed",
          });
        } catch (sendError) {
          if (isWalletNotSelected(sendError)) {
            let recovered = false;
            for (let attempt = 0; attempt < 2 && !recovered; attempt++) {
              await recoverSolanaWalletSelection();
              const retried = await waitForReadySolanaSession(10, 150);
              const retrySend = retried.sendTransaction;
              const retrySign = retried.signTransaction;
              const retrySignerAddress = retried.signerAddress || activeSignerAddressForTx;
              if (retrySignerAddress && retrySignerAddress !== activeSignerAddressForTx) {
                const retryTxResp = await fetch("/api/protocols/jupiter/withdraw", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    asset: mint,
                    signer: retrySignerAddress,
                    amount: String(amountBaseUnits),
                    preferLegacyInstruction: preferLegacyWithdrawInstruction,
                  }),
                });
                const retryTxData = await retryTxResp.json().catch(() => null);
                if (!retryTxResp.ok || !retryTxData?.success || !retryTxData?.data?.transaction) {
                  throw new Error(retryTxData?.error || `Withdraw prepare failed: ${retryTxResp.status}`);
                }
                const retrySerialized = decodeBase64Tx(retryTxData.data.transaction);
                txForWallet = isVersionedTransactionBytes(retrySerialized)
                  ? VersionedTransaction.deserialize(retrySerialized)
                  : Transaction.from(retrySerialized);
                activeSignerAddressForTx = retrySignerAddress;
              }
              try {
                if (retrySend) {
                  signature = await retrySend(txForWallet as any, connection, {
                    skipPreflight: false,
                    preflightCommitment: "confirmed",
                  });
                  recovered = true;
                  break;
                }
                if (retrySign) {
                  const retrySigned = await retrySign(txForWallet as any);
                  signature = await connection.sendRawTransaction(retrySigned.serialize(), {
                    skipPreflight: false,
                    preflightCommitment: "confirmed",
                  });
                  recovered = true;
                  break;
                }
              } catch (retryError) {
                if (!isWalletNotSelected(retryError)) {
                  throw retryError instanceof Error ? retryError : new Error(getErrorMessage(retryError));
                }
              }
            }
            if (!recovered) {
              throw new Error("Wallet API is still syncing after reconnect. Try again in 1-2 seconds.");
            }
          } else {
          if (!resolvedSignTransaction) {
            throw sendError instanceof Error ? sendError : new Error(getErrorMessage(sendError));
          }
          const signed = await resolvedSignTransaction(txForWallet as any);
          signature = await connection.sendRawTransaction(signed.serialize(), {
            skipPreflight: false,
            preflightCommitment: "confirmed",
          });
          }
        }
      } else {
        if (!resolvedSignTransaction) {
          throw new Error("Wallet API is unavailable after reconnect. Reconnect Solana wallet and try again.");
        }
        const signed = await resolvedSignTransaction(txForWallet as any);
        signature = await connection.sendRawTransaction(signed.serialize(), {
          skipPreflight: false,
          preflightCommitment: "confirmed",
        });
      }

      if (!signature) {
        throw new Error("Failed to submit transaction signature");
      }

      const confirmation = await connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        "confirmed"
      );
      if (confirmation.value.err) {
        console.error("[Jupiter][Withdraw] chain confirmation error", {
          signature,
          err: confirmation.value.err,
        });
        throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
      }

      // For SOL withdraw, Jupiter returns WSOL. Unwrap WSOL back to SOL by closing WSOL ATA.
      if (mint === WSOL_MINT) {
        try {
          const owner = new PublicKey(effectivePublicKey.toString());
          const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, owner, false);
          const wsolBalance = await connection.getTokenAccountBalance(wsolAta).catch(() => null);
          const rawAmount = Number(wsolBalance?.value?.amount || 0);

          if (Number.isFinite(rawAmount) && rawAmount > 0) {
            const { blockhash: unwrapBlockhash, lastValidBlockHeight: unwrapLastValidBlockHeight } =
              await connection.getLatestBlockhash("confirmed");
            const unwrapTx = new Transaction();
            unwrapTx.feePayer = owner;
            unwrapTx.recentBlockhash = unwrapBlockhash;
            unwrapTx.add(
              createCloseAccountInstruction(
                wsolAta,
                owner, // destination SOL wallet
                owner, // close authority
              )
            );

            let unwrapSig: string;
            if (resolvedSendTransaction) {
              try {
                unwrapSig = await resolvedSendTransaction(unwrapTx, connection, {
                  skipPreflight: false,
                  preflightCommitment: "confirmed",
                });
              } catch (sendError) {
                if (!resolvedSignTransaction) {
                  throw sendError instanceof Error ? sendError : new Error(getErrorMessage(sendError));
                }
                const signedUnwrap = await resolvedSignTransaction(unwrapTx);
                unwrapSig = await connection.sendRawTransaction(signedUnwrap.serialize(), {
                  skipPreflight: false,
                  preflightCommitment: "confirmed",
                });
              }
            } else {
              if (!resolvedSignTransaction) {
                throw new Error("Wallet API is unavailable after reconnect. Reconnect Solana wallet and try again.");
              }
              const signedUnwrap = await resolvedSignTransaction(unwrapTx);
              unwrapSig = await connection.sendRawTransaction(signedUnwrap.serialize(), {
                skipPreflight: false,
                preflightCommitment: "confirmed",
              });
            }
            const unwrapConfirmation = await connection.confirmTransaction(
              {
                signature: unwrapSig,
                blockhash: unwrapBlockhash,
                lastValidBlockHeight: unwrapLastValidBlockHeight,
              },
              "confirmed"
            );
            if (unwrapConfirmation.value.err) {
              console.warn("[Jupiter][Withdraw] WSOL unwrap failed", unwrapConfirmation.value.err);
            }
          }
        } catch (unwrapError) {
          console.warn("[Jupiter][Withdraw] WSOL unwrap step failed", unwrapError);
        }
      }

      toast({
        title: "Withdraw submitted",
        description: `Withdrew ${amountUi} ${symbol}.`,
        action: (
          <ToastAction altText="View on Solscan" onClick={() => window.open(`https://solscan.io/tx/${signature}`, "_blank")}>
            View on Solscan
          </ToastAction>
        ),
      });

      await refreshSolana();
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("refreshPositions", { detail: { protocol: "jupiter" } }));
      }
      closeWithdraw();
    } catch (e) {
      const message = getErrorMessage(e);
      console.error("[Jupiter][Withdraw] failed", {
        message,
        error: e,
      });
      toast({
        title: "Withdraw failed",
        description: message,
        variant: "destructive",
      });
    } finally {
      setIsWithdrawing(false);
    }
  };

  if (!solanaAddress) {
    return <div className="py-4 text-muted-foreground">Connect Solana wallet to view Jupiter positions.</div>;
  }
  if (loading) {
    return <div className="py-4 text-muted-foreground">Loading positions...</div>;
  }
  if (error) {
    return <div className="py-4 text-red-500">{error}</div>;
  }
  if (positions.length === 0) {
    return <div className="py-4 text-muted-foreground">No positions on Jupiter.</div>;
  }

  return (
    <div className="space-y-4 text-base">
      <div className="mb-4">
          {positions.map((position, idx) => {
            const symbol = position?.token?.asset?.uiSymbol || position?.token?.asset?.symbol || "Unknown";
            const decimals = toNumber(position?.token?.asset?.decimals, 0);
            const amount = toNumber(position?.underlyingAssets, 0) / Math.pow(10, decimals || 0);
            const price = toNumber(position?.token?.asset?.price, 0);
            const value = amount * price;
            const logoUrl = position?.token?.asset?.logoUrl;
            const aprPct = toNumber(position?.token?.totalRate, 0) / 100;

            return (
              <div key={`jupiter-${idx}`} className="p-3 sm:p-4 border-b last:border-b-0">
              <div className="hidden sm:flex justify-between items-center">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 relative">
                    {logoUrl ? (
                      <Image src={logoUrl} alt={symbol} width={32} height={32} className="object-contain" unoptimized />
                    ) : null}
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <div className="text-lg font-semibold">{symbol}</div>
                      <Badge
                        variant="outline"
                        className="bg-green-500/10 text-green-600 border-green-500/20 text-xs font-normal px-2 py-0.5 h-5"
                      >
                        Supply
                      </Badge>
                    </div>
                    <div className="text-base text-muted-foreground mt-0.5">{formatCurrency(price, 4)}</div>
                  </div>
                </div>
                <div className="text-right">
                  <div className="flex items-center justify-end gap-2 mb-1">
                    <Badge
                      variant="outline"
                      className="bg-blue-500/10 text-blue-600 border-blue-500/20 text-xs font-normal px-2 py-0.5 h-5"
                    >
                      APR: {formatNumber(aprPct, 2)}%
                    </Badge>
                    <div className="text-lg font-bold text-right w-24">{formatCurrency(value, 2)}</div>
                  </div>
                  <div className="text-base text-muted-foreground font-semibold">{formatNumber(amount, 4)}</div>
                  <div className="flex gap-2 mt-2 justify-end">
                    <Button onClick={() => onDepositClick(position)} size="sm" variant="default" className="h-10">
                      Deposit
                    </Button>
                    <Button onClick={() => onWithdrawClick(position)} size="sm" variant="outline" className="h-10">
                      Withdraw
                    </Button>
                  </div>
                </div>
              </div>

              <div className="block sm:hidden space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <div className="w-8 h-8 relative">
                      {logoUrl ? (
                        <Image src={logoUrl} alt={symbol} width={32} height={32} className="object-contain" unoptimized />
                      ) : null}
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <div className="text-base font-semibold">{symbol}</div>
                        <Badge
                          variant="outline"
                          className="bg-green-500/10 text-green-600 border-green-500/20 text-xs font-normal px-1.5 py-0.5 h-4"
                        >
                          Supply
                        </Badge>
                      </div>
                      <div className="text-sm text-muted-foreground">{formatCurrency(price, 4)}</div>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="flex items-center justify-end gap-2 mb-1">
                      <Badge
                        variant="outline"
                        className="bg-blue-500/10 text-blue-600 border-blue-500/20 text-xs font-normal px-1.5 py-0.5 h-4"
                      >
                        APR: {formatNumber(aprPct, 2)}%
                      </Badge>
                      <div className="text-base font-semibold text-right w-24">{formatCurrency(value, 2)}</div>
                    </div>
                    <div className="text-sm text-muted-foreground">{formatNumber(amount, 4)}</div>
                    <div className="flex gap-2 mt-2 justify-end">
                      <Button onClick={() => onDepositClick(position)} size="sm" variant="default" className="h-10">
                        Deposit
                      </Button>
                      <Button onClick={() => onWithdrawClick(position)} size="sm" variant="outline" className="h-10">
                        Withdraw
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
              </div>
            );
          })}
      </div>
      <div className="flex items-center justify-between pt-6 pb-6">
        <span className="text-xl">Total assets in Jupiter:</span>
        <span className="text-xl text-primary font-bold">{formatCurrency(totalValue, 2)}</span>
      </div>

      <JupiterDepositModal
        isOpen={isDepositOpen}
        onClose={closeDeposit}
        onConfirm={handleDeposit}
        isLoading={isDepositing}
        token={{
          symbol: selectedMeta.symbol,
          logoUrl: selectedPosition?.token?.asset?.logoUrl,
          availableAmount: selectedWalletAmount,
          apy: toNumber(selectedPosition?.token?.totalRate, 0) / 100,
          priceUsd: toNumber(selectedPosition?.token?.asset?.price, 0),
        }}
      />

      <JupiterWithdrawModal
        isOpen={isWithdrawOpen}
        onClose={closeWithdraw}
        onConfirm={handleWithdraw}
        isLoading={isWithdrawing}
        token={{
          symbol: selectedMeta.symbol,
          logoUrl: selectedPosition?.token?.asset?.logoUrl,
          suppliedAmount: selectedMeta.amount,
        }}
      />
    </div>
  );
}

