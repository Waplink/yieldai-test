"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Decimal from "decimal.js";
import { Connection, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { useWallet as useSolanaWallet } from "@solana/wallet-adapter-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ExternalLink } from "lucide-react";
import Image from "next/image";
import { useSolanaPortfolio } from "@/hooks/useSolanaPortfolio";
import type { Token } from "@/lib/types/token";
import { JupiterDepositModal } from "@/components/ui/jupiter-deposit-modal";
import { JupiterWithdrawModal } from "@/components/ui/jupiter-withdraw-modal";
import { formatCurrency, formatNumber } from "@/lib/utils/numberFormat";
import { getPreferredJupiterTokenIcon } from "@/lib/services/solana/jupiterTokenIcons";
import {
  createMainnetRpc,
  createWalletAdapterPartialSigner,
  getSolanaRpcEndpoint,
  loadKaminoVaultForAddress,
  sendVaultInstructionsWithWalletAdapter,
  sendKitInstructionsWithWallet,
} from "@/lib/solana/kaminoKvVaultTx";
import { extractKvaultVaultAddress, isLikelySolanaAddress } from "@/lib/kamino/kvaultVaultAddress";
import { useToast } from "@/components/ui/use-toast";

const KAMINO_LEND_URL = "https://kamino.com/lend";
const KAMINO_LOCAL_ICON = "/protocol_ico/kamino.png";

type KaminoPosition = {
  source?: "kamino-lend" | "kamino-earn" | "kamino-farm" | string;
  marketName?: string;
  marketPubkey?: string;
  obligation?: unknown;
  position?: unknown;
  farmPubkey?: string;
  tokenMint?: string;
  tokenSymbol?: string;
  tokenLogoUrl?: string;
  netTokenAmount?: string;
  netUsdAmount?: string;
  /** Set by API when farm pubkey maps to a kVault (Steakhouse, etc.). */
  vaultAddress?: string;
  vaultName?: string;
};

function toNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function getDeep(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const p of parts) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[p];
  }
  return current;
}

function pickFirstNumber(obj: unknown, paths: string[], fallback = 0): number {
  for (const path of paths) {
    const value = getDeep(obj, path);
    const n = toNumber(value, NaN);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function shortKey(value?: string): string {
  if (!value) return "Unknown";
  if (value.length <= 10) return value;
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function isExternalUrl(value?: string): boolean {
  if (!value) return false;
  return /^https?:\/\//i.test(value);
}

function extractUnderlyingMintSymbol(position: unknown): { mint?: string; symbol?: string } {
  if (!position || typeof position !== "object") return {};
  const o = position as Record<string, unknown>;
  const fromState = getDeep(position, "state.tokenMint");
  const mintRaw =
    (typeof o.tokenMint === "string" && o.tokenMint.trim()) ||
    (typeof fromState === "string" && fromState.trim()) ||
    (typeof getDeep(position, "vault.tokenMint") === "string" && String(getDeep(position, "vault.tokenMint")).trim()) ||
    undefined;
  const symRaw =
    (typeof o.tokenSymbol === "string" && o.tokenSymbol.trim()) ||
    (typeof getDeep(position, "state.tokenSymbol") === "string" && String(getDeep(position, "state.tokenSymbol")).trim()) ||
    (typeof o.symbol === "string" && o.symbol.trim()) ||
    undefined;
  return { mint: mintRaw || undefined, symbol: symRaw || undefined };
}

function walletUiAmountForMint(tokens: Token[], mint: string | undefined): number {
  const m = (mint ?? "").trim();
  if (!m) return 0;
  const token = tokens.find((t) => (t.address ?? "").trim() === m);
  if (!token) return 0;
  const rawAmount = Number(token.amount);
  const decimals = Number(token.decimals);
  if (!Number.isFinite(rawAmount) || !Number.isFinite(decimals) || decimals < 0) return 0;
  return rawAmount / Math.pow(10, decimals);
}

function parseEarnShares(position: unknown): { total: number; unstaked: number; staked: number } {
  if (!position || typeof position !== "object") {
    return { total: 0, unstaked: 0, staked: 0 };
  }
  const o = position as Record<string, unknown>;
  return {
    total: toNumber(o.totalShares, 0),
    unstaked: toNumber(o.unstakedShares, 0),
    staked: toNumber(o.stakedShares, 0),
  };
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
  return "";
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const message = (error.message || "").trim();
    if (message.length > 0) return message;
    return "Unknown error";
  }
  if (typeof error === "string") return error;
  return "Unknown error";
}

function KaminoLogo({ alt, externalLogoUrl }: { alt: string; externalLogoUrl?: string }) {
  const [useFallback, setUseFallback] = useState(false);
  const src = useFallback && externalLogoUrl ? externalLogoUrl : KAMINO_LOCAL_ICON;
  return (
    <Image
      src={src}
      alt={alt}
      width={32}
      height={32}
      className="object-contain"
      unoptimized={isExternalUrl(src)}
      onError={() => {
        if (!useFallback && externalLogoUrl) setUseFallback(true);
      }}
    />
  );
}

type NormalizedKaminoRow =
  | {
      kind: "farm";
      id: string;
      label: string;
      fallbackLogoUrl: string;
      valueUsd: number;
      amount: number;
      price?: number;
      typeLabel: string;
      typeColor: string;
    }
  | {
      kind: "lend";
      id: string;
      label: string;
      fallbackLogoUrl: string;
      valueUsd: number;
      amount: number;
      typeLabel: string;
      typeColor: string;
    }
  | {
      kind: "earn";
      id: string;
      label: string;
      fallbackLogoUrl: string;
      valueUsd: number;
      amount: number;
      price?: number;
      typeLabel: string;
      typeColor: string;
      vaultAddress?: string;
      shares: { total: number; unstaked: number; staked: number };
      underlyingMint?: string;
      underlyingSymbol?: string;
    };

function normalizeKaminoPosition(row: KaminoPosition, idx: number): NormalizedKaminoRow {
  if (row.source === "kamino-farm") {
    const symbol = (row.tokenSymbol || "").trim() || shortKey(row.tokenMint);
    const fallbackLogoUrl = getPreferredJupiterTokenIcon(row.tokenSymbol, row.tokenLogoUrl) ?? "";
    const valueUsd = toNumber(row.netUsdAmount, 0);
    const amount = toNumber(row.netTokenAmount, 0);
    const price = amount > 0 ? valueUsd / amount : undefined;
    const vaultResolved =
      row.vaultAddress && isLikelySolanaAddress(row.vaultAddress) ? row.vaultAddress.trim() : undefined;
    if (vaultResolved) {
      const label =
        (row.vaultName && row.vaultName.trim()) ||
        (symbol ? `Kamino Farm (${symbol})` : `Kamino Farm (${shortKey(row.farmPubkey)})`);
      const mint = (row.tokenMint ?? "").trim() || undefined;
      return {
        kind: "earn",
        id: `kamino-farm-${row.farmPubkey}-${idx}`,
        label,
        fallbackLogoUrl,
        valueUsd,
        amount,
        price,
        typeLabel: "Supply",
        typeColor: "bg-green-500/10 text-green-600 border-green-500/20",
        vaultAddress: vaultResolved,
        shares: { total: 0, unstaked: 0, staked: 0 },
        underlyingMint: mint,
        underlyingSymbol: symbol,
      };
    }
    return {
      kind: "farm",
      id: `kamino-farm-${row.farmPubkey}-${idx}`,
      label: `Kamino Farm (${symbol})`,
      fallbackLogoUrl,
      valueUsd,
      amount,
      price,
      typeLabel: "Supply",
      typeColor: "bg-green-500/10 text-green-600 border-green-500/20",
    };
  }

  if (row.source === "kamino-lend") {
    const valueUsd = pickFirstNumber(row.obligation, [
      "refreshedStats.userTotalDeposit",
      "obligationStats.userTotalDeposit",
      "userTotalDeposit",
      "depositedValueUsd",
      "totalDepositUsd",
    ]);
    return {
      kind: "lend",
      id: `kamino-lend-${row.marketPubkey}-${idx}`,
      label: row.marketName || `Kamino Lend (${shortKey(row.marketPubkey)})`,
      fallbackLogoUrl: "",
      valueUsd,
      amount: 0,
      typeLabel: "Supply",
      typeColor: "bg-green-500/10 text-green-600 border-green-500/20",
    };
  }

  const valueUsd = pickFirstNumber(row.position, [
    "totalUsdValue",
    "totalValueUsd",
    "positionUsdValue",
    "usdValue",
    "valueUsd",
  ]);
  const label = String(
    getDeep(row.position, "name") ??
      getDeep(row.position, "vaultName") ??
      getDeep(row.position, "symbol") ??
      "Kamino Earn"
  );
  const mergedForVault =
    row.position && typeof row.position === "object"
      ? { ...(row as Record<string, unknown>), ...(row.position as Record<string, unknown>) }
      : (row as Record<string, unknown>);
  const vaultAddress =
    extractKvaultVaultAddress(row.position) ?? extractKvaultVaultAddress(mergedForVault);
  const shares = parseEarnShares(row.position);
  const { mint: uMint, symbol: uSym } = extractUnderlyingMintSymbol(row.position);
  return {
    kind: "earn",
    id: vaultAddress ? `kamino-earn-${vaultAddress}` : `kamino-earn-${idx}`,
    label,
    fallbackLogoUrl: "",
    valueUsd,
    amount: 0,
    typeLabel: "Supply",
    typeColor: "bg-green-500/10 text-green-600 border-green-500/20",
    vaultAddress,
    shares,
    underlyingMint: uMint,
    underlyingSymbol: uSym,
  };
}

export function KaminoPositions() {
  const { address: solanaAddress, tokens: solanaTokens, refresh: refreshSolana } = useSolanaPortfolio();
  const { toast } = useToast();
  const { publicKey, signTransaction, wallet: solanaWallet, connecting: solanaConnecting } = useSolanaWallet();

  const [positions, setPositions] = useState<KaminoPosition[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // IMPORTANT: signer address must match the wallet adapter used to sign.
  // Prefer adapter publicKey/signTransaction because some wallets can leave hook values stale.
  const adapterPublicKey = (solanaWallet?.adapter?.publicKey as PublicKey | null) ?? null;
  const adapterAddress = toBase58Address(adapterPublicKey);
  const hookAddress = toBase58Address(publicKey);
  const effectiveSignerAddress = adapterAddress || hookAddress || "";

  const adapterSignTransaction =
    typeof (solanaWallet?.adapter as { signTransaction?: unknown } | undefined)?.signTransaction === "function"
      ? ((solanaWallet?.adapter as {
          signTransaction: (t: Transaction | VersionedTransaction) => Promise<Transaction | VersionedTransaction>;
        }).signTransaction.bind(solanaWallet?.adapter) as (t: VersionedTransaction) => Promise<VersionedTransaction>)
      : undefined;
  const activeSignTransaction = adapterSignTransaction ?? signTransaction;
  const positionsOwnerAddress = (solanaAddress || effectiveSignerAddress || "").trim();

  const [earnModal, setEarnModal] = useState<"deposit" | "withdraw" | null>(null);
  const [earnTarget, setEarnTarget] = useState<Extract<NormalizedKaminoRow, { kind: "earn" }> | null>(null);
  const [earnAmount, setEarnAmount] = useState("");
  const [earnSubmitting, setEarnSubmitting] = useState(false);

  const loadPositions = useCallback(async (): Promise<KaminoPosition[]> => {
    if (!positionsOwnerAddress) {
      setPositions([]);
      return [];
    }
    try {
      setLoading(true);
      setError(null);
      const response = await fetch(
        `/api/protocols/kamino/userPositions?address=${encodeURIComponent(positionsOwnerAddress)}&t=${Date.now()}`,
        { cache: "no-store" }
      );
      if (!response.ok) throw new Error("Failed to fetch Kamino positions");
      const data = await response.json().catch(() => null);
      const rows = Array.isArray(data?.data) ? (data.data as KaminoPosition[]) : [];
      setPositions(rows);
      return rows;
    } catch {
      setError("Failed to load Kamino positions");
      setPositions([]);
      return [];
    } finally {
      setLoading(false);
    }
  }, [positionsOwnerAddress]);

  useEffect(() => {
    void loadPositions();
    const handleRefresh: EventListener = (evt) => {
      const event = evt as CustomEvent<{ protocol?: string; data?: KaminoPosition[] }>;
      if (event?.detail?.protocol === "kamino") {
        if (Array.isArray(event.detail.data)) {
          setPositions(event.detail.data);
        } else {
          void loadPositions();
        }
      }
    };
    window.addEventListener("refreshPositions", handleRefresh);
    return () => window.removeEventListener("refreshPositions", handleRefresh);
  }, [loadPositions]);

  const normalized = useMemo(() => positions.map(normalizeKaminoPosition), [positions]);

  // De-dupe kVault positions: the same vault can appear as:
  // - `kamino-earn` (has shares for withdraw)
  // - `kamino-farm` aggregated (has value/amount/price)
  // Merge them so the card and withdraw modal are both correct.
  const merged = useMemo(() => {
    const out: NormalizedKaminoRow[] = [];
    const byVault = new Map<string, Extract<NormalizedKaminoRow, { kind: "earn" }>>();

    const mergeEarn = (
      a: Extract<NormalizedKaminoRow, { kind: "earn" }>,
      b: Extract<NormalizedKaminoRow, { kind: "earn" }>
    ): Extract<NormalizedKaminoRow, { kind: "earn" }> => {
      const pickLabel = (x: string, y: string) => {
        const nx = (x || "").trim();
        const ny = (y || "").trim();
        if (!nx) return ny;
        if (!ny) return nx;
        // Prefer non-generic, non "Kamino Farm" label when possible.
        const xScore = nx.toLowerCase().includes("kamino earn") ? 0 : nx.toLowerCase().includes("kamino farm") ? 1 : 2;
        const yScore = ny.toLowerCase().includes("kamino earn") ? 0 : ny.toLowerCase().includes("kamino farm") ? 1 : 2;
        if (xScore !== yScore) return xScore > yScore ? nx : ny;
        return nx.length >= ny.length ? nx : ny;
      };

      return {
        kind: "earn",
        id: a.vaultAddress ? `kamino-earn-${a.vaultAddress}` : a.id,
        label: pickLabel(a.label, b.label),
        fallbackLogoUrl: a.fallbackLogoUrl || b.fallbackLogoUrl,
        valueUsd: Math.max(a.valueUsd || 0, b.valueUsd || 0),
        amount: Math.max(a.amount || 0, b.amount || 0),
        price: (a.price ?? 0) > 0 ? a.price : b.price,
        typeLabel: a.typeLabel,
        typeColor: a.typeColor,
        vaultAddress: a.vaultAddress || b.vaultAddress,
        shares: {
          total: Math.max(a.shares?.total || 0, b.shares?.total || 0),
          unstaked: Math.max(a.shares?.unstaked || 0, b.shares?.unstaked || 0),
          staked: Math.max(a.shares?.staked || 0, b.shares?.staked || 0),
        },
        underlyingMint: a.underlyingMint || b.underlyingMint,
        underlyingSymbol: a.underlyingSymbol || b.underlyingSymbol,
      };
    };

    for (const row of normalized) {
      if (row.kind !== "earn" || !row.vaultAddress) {
        out.push(row);
        continue;
      }
      const key = row.vaultAddress.trim();
      const prev = byVault.get(key);
      if (!prev) {
        byVault.set(key, row);
      } else {
        byVault.set(key, mergeEarn(prev, row));
      }
    }

    out.push(...byVault.values());
    return out;
  }, [normalized]);

  const sorted = useMemo(() => [...merged].sort((a, b) => b.valueUsd - a.valueUsd), [merged]);
  const totalValue = useMemo(() => sorted.reduce((sum, p) => sum + p.valueUsd, 0), [sorted]);

  const openEarnDeposit = useCallback((row: Extract<NormalizedKaminoRow, { kind: "earn" }>) => {
    setEarnTarget(row);
    setEarnModal("deposit");
  }, []);

  const openEarnWithdraw = useCallback((row: Extract<NormalizedKaminoRow, { kind: "earn" }>) => {
    setEarnTarget(row);
    setEarnModal("withdraw");
  }, []);

  const closeEarnModal = useCallback(() => {
    setEarnModal(null);
    setEarnTarget(null);
    setEarnSubmitting(false);
  }, []);

  const kaminoDepositModalToken = useMemo(() => {
    if (!earnTarget || earnTarget.kind !== "earn") return null;
    const sym = earnTarget.underlyingSymbol || "Token";
    const available = walletUiAmountForMint(solanaTokens, earnTarget.underlyingMint);
    return {
      symbol: sym,
      logoUrl:
        (getPreferredJupiterTokenIcon(sym, earnTarget.fallbackLogoUrl || undefined) ??
          earnTarget.fallbackLogoUrl) ||
        undefined,
      availableAmount: available,
      apy: 0,
      priceUsd: earnTarget.price ?? 0,
    };
  }, [earnTarget, solanaTokens]);

  const kaminoWithdrawModalToken = useMemo(() => {
    if (!earnTarget || earnTarget.kind !== "earn") return null;
    const sym = earnTarget.underlyingSymbol || "Token";
    return {
      symbol: sym,
      logoUrl:
        (getPreferredJupiterTokenIcon(sym, earnTarget.fallbackLogoUrl || undefined) ??
          earnTarget.fallbackLogoUrl) ||
        undefined,
      suppliedAmount: earnTarget.shares.total,
    };
  }, [earnTarget]);

  const runEarnTransaction = useCallback(
    async (mode: "deposit" | "withdraw", amountUi: number) => {
      if (!earnTarget?.vaultAddress || !effectiveSignerAddress) {
        toast({
          variant: "destructive",
          title: "Wallet required",
          description: "Connect a Solana wallet that matches your portfolio address.",
        });
        return;
      }
      if (!activeSignTransaction) {
        toast({
          variant: "destructive",
          title: "Wallet cannot sign",
          description: solanaConnecting ? "Connecting wallet…" : "This wallet cannot sign transactions.",
        });
        return;
      }

      const rpc = createMainnetRpc();
      const connection = new Connection(getSolanaRpcEndpoint(), "confirmed");
      const signer = createWalletAdapterPartialSigner(effectiveSignerAddress, activeSignTransaction);

      const amountDec = new Decimal(amountUi);
      if (!amountDec.isFinite() || amountDec.lte(0)) {
        toast({ variant: "destructive", title: "Invalid amount", description: "Enter a positive number." });
        return;
      }

      setEarnSubmitting(true);
      try {
        const { vault, lookupTable } = await loadKaminoVaultForAddress(rpc, earnTarget.vaultAddress);
        const slot = await rpc.getSlot({ commitment: "confirmed" }).send();

        if (mode === "deposit") {
          const dep = await vault.depositIxs(signer, amountDec, undefined, undefined, signer);
          const stakeExtra =
            dep.stakeInFarmIfNeededIxs.length > 0 ? dep.stakeInFarmIfNeededIxs : dep.stakeInFlcFarmIfNeededIxs;
          const ixs = [...dep.depositIxs, ...stakeExtra];
          const sig = await sendVaultInstructionsWithWalletAdapter({
            connection,
            payerBase58: effectiveSignerAddress,
            signTransaction: activeSignTransaction,
            instructions: ixs,
            addressLookupTableAddresses: [String(lookupTable)],
          });
          toast({ title: "Deposit submitted", description: `${sig.slice(0, 8)}…` });
        } else {
          const w = await vault.withdrawIxs(signer, amountDec, slot, undefined, undefined, signer);
          const ixs = [...w.unstakeFromFarmIfNeededIxs, ...w.withdrawIxs, ...w.postWithdrawIxs];
          const sig = await sendVaultInstructionsWithWalletAdapter({
            connection,
            payerBase58: effectiveSignerAddress,
            signTransaction: activeSignTransaction,
            instructions: ixs,
            addressLookupTableAddresses: [String(lookupTable)],
          });
          toast({ title: "Withdraw submitted", description: `${sig.slice(0, 8)}…` });
        }

        closeEarnModal();
        if (typeof window !== "undefined") {
          window.setTimeout(() => {
            void refreshSolana();
            void loadPositions();
            window.dispatchEvent(new CustomEvent("refreshPositions", { detail: { protocol: "kamino" } }));
          }, 3000);
        }
      } catch (e) {
        toast({
          variant: "destructive",
          title: mode === "deposit" ? "Deposit failed" : "Withdraw failed",
          description: getErrorMessage(e),
        });
      } finally {
        setEarnSubmitting(false);
      }
    },
    [
      earnTarget,
      effectiveSignerAddress,
      activeSignTransaction,
      toast,
      closeEarnModal,
      refreshSolana,
      solanaConnecting,
      loadPositions,
    ]
  );

  if (loading) {
    return <div className="py-4 text-muted-foreground">Loading positions...</div>;
  }
  if (error) {
    return <div className="py-4 text-red-500">{error}</div>;
  }
  if (sorted.length === 0) {
    return <div className="py-4 text-muted-foreground">No positions on Kamino.</div>;
  }

  const depositSymbol = kaminoDepositModalToken?.symbol ?? "Token";

  return (
    <div className="space-y-4 text-base">
      {kaminoDepositModalToken ? (
        <JupiterDepositModal
          isOpen={earnModal === "deposit"}
          onClose={closeEarnModal}
          onConfirm={(amountUi) => void runEarnTransaction("deposit", amountUi)}
          isLoading={earnSubmitting}
          title="Deposit to Kamino"
          description={`Enter amount to deposit ${depositSymbol}`}
          protocol={{ name: "Kamino", logoUrl: "/protocol_ico/kamino.png" }}
          token={kaminoDepositModalToken}
        />
      ) : null}

      {kaminoWithdrawModalToken ? (
        <JupiterWithdrawModal
          isOpen={earnModal === "withdraw"}
          onClose={closeEarnModal}
          onConfirm={(amountUi) => void runEarnTransaction("withdraw", amountUi)}
          isLoading={earnSubmitting}
          token={kaminoWithdrawModalToken}
        />
      ) : null}

      <ScrollArea>
        {sorted.map((position) => (
          <div key={position.id} className="p-3 sm:p-4 border-b last:border-b-0">
            <div className="hidden sm:flex justify-between items-center">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 relative">
                  <KaminoLogo alt={position.label} externalLogoUrl={position.fallbackLogoUrl} />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <div className="text-lg font-semibold">{position.label}</div>
                    <Badge variant="outline" className={`${position.typeColor} text-xs font-normal px-2 py-0.5 h-5`}>
                      {position.typeLabel}
                    </Badge>
                  </div>
                  {"price" in position && position.price != null && (
                    <div className="text-base text-muted-foreground mt-0.5">{formatCurrency(position.price, 4)}</div>
                  )}
                </div>
              </div>
              <div className="text-right">
                <div className="text-lg font-bold">{formatCurrency(position.valueUsd, 2)}</div>
                {"amount" in position && position.amount > 0 && (
                  <div className="text-base text-muted-foreground">{formatNumber(position.amount, 6)}</div>
                )}
                <div className="flex gap-2 mt-2 justify-end">
                  {position.kind === "earn" && position.vaultAddress ? (
                    <>
                      <Button
                        size="sm"
                        variant="default"
                        className="h-10"
                        onClick={() => openEarnDeposit(position)}
                        disabled={!effectiveSignerAddress || !activeSignTransaction}
                      >
                        Deposit
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-10"
                        onClick={() => openEarnWithdraw(position)}
                        disabled={!effectiveSignerAddress || !activeSignTransaction}
                      >
                        Withdraw
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button size="sm" variant="default" className="h-10" onClick={() => window.open(KAMINO_LEND_URL, "_blank")}>
                        Deposit
                        <ExternalLink className="h-3 w-3 ml-1" />
                      </Button>
                      <Button size="sm" variant="outline" className="h-10" onClick={() => window.open(KAMINO_LEND_URL, "_blank")}>
                        Withdraw
                        <ExternalLink className="h-3 w-3 ml-1" />
                      </Button>
                    </>
                  )}
                </div>
              </div>
            </div>

            <div className="block sm:hidden space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 relative">
                    <KaminoLogo alt={position.label} externalLogoUrl={position.fallbackLogoUrl} />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <div className="text-base font-semibold">{position.label}</div>
                      <Badge variant="outline" className={`${position.typeColor} text-xs font-normal px-1.5 py-0.5 h-4`}>
                        {position.typeLabel}
                      </Badge>
                    </div>
                    {"price" in position && position.price != null && (
                      <div className="text-sm text-muted-foreground">{formatCurrency(position.price, 4)}</div>
                    )}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-base font-semibold">{formatCurrency(position.valueUsd, 2)}</div>
                  {"amount" in position && position.amount > 0 && (
                    <div className="text-sm text-muted-foreground">{formatNumber(position.amount, 6)}</div>
                  )}
                </div>
              </div>
              <div className="flex flex-col gap-2">
                {position.kind === "earn" && position.vaultAddress ? (
                  <>
                    <Button
                      size="sm"
                      variant="default"
                      className="w-full h-10"
                      onClick={() => openEarnDeposit(position)}
                      disabled={!effectiveSignerAddress || !activeSignTransaction}
                    >
                      Deposit
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="w-full h-10"
                      onClick={() => openEarnWithdraw(position)}
                      disabled={!effectiveSignerAddress || !activeSignTransaction}
                    >
                      Withdraw
                    </Button>
                  </>
                ) : (
                  <>
                    <Button size="sm" variant="default" className="w-full h-10" onClick={() => window.open(KAMINO_LEND_URL, "_blank")}>
                      Deposit
                      <ExternalLink className="h-3 w-3 ml-1" />
                    </Button>
                    <Button size="sm" variant="outline" className="w-full h-10" onClick={() => window.open(KAMINO_LEND_URL, "_blank")}>
                      Withdraw
                      <ExternalLink className="h-3 w-3 ml-1" />
                    </Button>
                  </>
                )}
              </div>
            </div>
          </div>
        ))}
      </ScrollArea>
      <div className="p-3 sm:p-4 bg-muted/50 rounded-lg">
        <div className="flex justify-between items-center">
          <span className="text-base font-medium">Total Value</span>
          <span className="text-lg font-bold">{formatCurrency(totalValue, 2)}</span>
        </div>
      </div>
    </div>
  );
}
