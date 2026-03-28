"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Connection, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { useWallet as useSolanaWallet } from "@solana/wallet-adapter-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ExternalLink } from "lucide-react";
import Image from "next/image";
import { useSolanaPortfolio } from "@/hooks/useSolanaPortfolio";
import type { Token } from "@/lib/types/token";
import { JupiterDepositModal } from "@/components/ui/jupiter-deposit-modal";
import { JupiterWithdrawModal } from "@/components/ui/jupiter-withdraw-modal";
import { formatCurrency, formatNumber } from "@/lib/utils/numberFormat";
import { getPreferredJupiterTokenIcon } from "@/lib/services/solana/jupiterTokenIcons";
import { getSolanaRpcEndpoint } from "@/lib/solana/kaminoKvVaultTx";
import { extractKvaultVaultAddress, isLikelySolanaAddress } from "@/lib/kamino/kvaultVaultAddress";
import { useToast } from "@/components/ui/use-toast";

const KAMINO_LEND_URL = "https://kamino.com/lend";
const KAMINO_LOCAL_ICON = "/protocol_ico/kamino.png";

function fingerprintRows(rows: KaminoPosition[]): string {
  const parts = rows.map((r) => {
    const source = String(r.source ?? "");
    const vault = String(r.vaultAddress ?? "");
    const farm = String(r.farmPubkey ?? "");
    const market = String(r.marketPubkey ?? "");
    const usd = String(r.netUsdAmount ?? "");
    const tok = String(r.netTokenAmount ?? "");
    const shares =
      r.position && typeof r.position === "object"
        ? `${String((r.position as any).totalShares ?? "")}:${String((r.position as any).unstakedShares ?? "")}:${String((r.position as any).stakedShares ?? "")}`
        : "";
    return [source, vault, farm, market, usd, tok, shares].join("|");
  });
  return `${rows.length}:${parts.join("~")}`;
}

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

function KaminoLogo({
  alt,
  externalLogoUrl,
  fallbackLogoUrl,
  symbol,
}: {
  alt: string;
  externalLogoUrl?: string;
  fallbackLogoUrl?: string;
  symbol?: string;
}) {
  const [stage, setStage] = useState<"primary" | "fallback" | "badge">("primary");
  const sym = (symbol || "").trim().toUpperCase();
  const fallbackText = (sym || alt || "TOKEN").trim().slice(0, 4).toUpperCase();
  const primary = (externalLogoUrl || "").trim();
  const fallback = (fallbackLogoUrl || "").trim();
  const src = stage === "primary" ? (primary || null) : stage === "fallback" ? (fallback || null) : null;
  if (!src) {
    return (
      <div className="w-8 h-8 rounded-full bg-slate-500/20 text-slate-200/90 flex items-center justify-center text-[10px] font-semibold">
        {fallbackText}
      </div>
    );
  }
  return (
    <Image
      src={src}
      alt={alt}
      width={32}
      height={32}
      className="object-contain"
      unoptimized={isExternalUrl(src)}
      onError={() => {
        if (stage === "primary" && fallback) setStage("fallback");
        else setStage("badge");
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
      underlyingLogoUrl?: string;
      valueUsd: number;
      amount: number;
      price?: number;
      aprPct?: number;
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
  const earnIcon = uSym ? `/token_ico/${uSym.toLowerCase()}.png` : "";
  const tokenLogoUrl = String(getDeep(row.position, "tokenLogoUrl") ?? "").trim();
  const fallbackLogoUrl = earnIcon || "";
  const underlyingLogoUrl = tokenLogoUrl || getPreferredJupiterTokenIcon(uSym, tokenLogoUrl) || "";
  const amount = toNumber(getDeep(row.position, "underlyingTokenAmount"), 0);
  const price = pickFirstNumber(row.position, ["underlyingTokenPriceUsd", "tokenPriceUsd", "priceUsd"], 0);
  const aprPct = pickFirstNumber(row.position, ["aprPct", "depositApy", "apyPct", "apy"], 0);
  return {
    kind: "earn",
    id: vaultAddress ? `kamino-earn-${vaultAddress}` : `kamino-earn-${idx}`,
    label,
    fallbackLogoUrl,
    underlyingLogoUrl,
    valueUsd,
    amount: amount > 0 ? amount : 0,
    price: price > 0 ? price : undefined,
    aprPct: aprPct > 0 ? aprPct : undefined,
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
  const [rewards, setRewards] = useState<
    Array<{ tokenMint: string; tokenSymbol?: string; tokenLogoUrl?: string; amount: string; usdValue?: number }>
  >([]);
  const [rewardsLoading, setRewardsLoading] = useState(false);
  const rewardsMockEnabled =
    process.env.NEXT_PUBLIC_KAMINO_REWARDS_MOCK === "1" ||
    process.env.NEXT_PUBLIC_KAMINO_REWARDS_MOCK === "true";
  const lastFingerprintRef = useRef<string>("0:");
  const refreshTimeoutRef = useRef<number | null>(null);

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
      // Don't render kamino-farm in UI (treat it as internal / rewards history noise).
      const filtered = rows.filter((r) => r.source !== "kamino-farm");
      setPositions(filtered);
      lastFingerprintRef.current = fingerprintRows(filtered);
      return filtered;
    } catch {
      setError("Failed to load Kamino positions");
      setPositions([]);
      lastFingerprintRef.current = "0:";
      return [];
    } finally {
      setLoading(false);
    }
  }, [positionsOwnerAddress]);

  const loadRewards = useCallback(async () => {
    if (!positionsOwnerAddress) {
      setRewards([]);
      return;
    }
    setRewardsLoading(true);
    try {
      const res = await fetch(
        `/api/protocols/kamino/rewards?address=${encodeURIComponent(positionsOwnerAddress)}&t=${Date.now()}${
          rewardsMockEnabled ? "&mock=1" : ""
        }`,
        { cache: "no-store" }
      );
      const j = await res.json().catch(() => null);
      const list = Array.isArray(j?.data) ? j.data : [];
      setRewards(list);
    } catch {
      setRewards([]);
    } finally {
      setRewardsLoading(false);
    }
  }, [positionsOwnerAddress, rewardsMockEnabled]);

  const schedulePositionsRefresh = useCallback(
    (delayMs: number) => {
      if (typeof window === "undefined") return;
      if (refreshTimeoutRef.current != null) {
        window.clearTimeout(refreshTimeoutRef.current);
      }
      // Immediately show "something is happening"
      setLoading(true);
      setError(null);
      refreshTimeoutRef.current = window.setTimeout(async () => {
        try {
          await refreshSolana();
          await loadPositions();
          window.dispatchEvent(new CustomEvent("refreshPositions", { detail: { protocol: "kamino" } }));
        } finally {
          refreshTimeoutRef.current = null;
        }
      }, delayMs);
    },
    [loadPositions, refreshSolana]
  );

  useEffect(() => {
    return () => {
      if (refreshTimeoutRef.current != null) {
        window.clearTimeout(refreshTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    void loadPositions();
    void loadRewards();
    const handleRefresh: EventListener = (evt) => {
      const event = evt as CustomEvent<{ protocol?: string; data?: KaminoPosition[] }>;
      if (event?.detail?.protocol === "kamino") {
        if (Array.isArray(event.detail.data)) {
          setPositions(event.detail.data);
        } else {
          void loadPositions();
        }
        void loadRewards();
      }
    };
    window.addEventListener("refreshPositions", handleRefresh);
    return () => window.removeEventListener("refreshPositions", handleRefresh);
  }, [loadPositions, loadRewards]);

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
  const totalRewardsUsd = useMemo(
    () => rewards.reduce((sum, r) => sum + (typeof r.usdValue === "number" && Number.isFinite(r.usdValue) ? r.usdValue : 0), 0),
    [rewards]
  );

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
      const connection = new Connection(getSolanaRpcEndpoint(), "confirmed");
      if (!Number.isFinite(amountUi) || amountUi <= 0) {
        toast({ variant: "destructive", title: "Invalid amount", description: "Enter a positive number." });
        return;
      }

      setEarnSubmitting(true);
      try {
        const txResp = await fetch("/api/protocols/kamino/earnTx", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            vaultAddress: earnTarget.vaultAddress,
            signer: effectiveSignerAddress,
            amountUi,
            mode,
          }),
        });
        const txData = await txResp.json().catch(() => null);
        if (!txResp.ok || !txData?.success || !txData?.data?.transaction) {
          throw new Error(txData?.error || `Transaction prepare failed: ${txResp.status}`);
        }

        const serialized = (() => {
          const decoded = atob(String(txData.data.transaction));
          return Uint8Array.from(decoded, (c) => c.charCodeAt(0));
        })();
        const txForWallet = (() => {
          try {
            return VersionedTransaction.deserialize(serialized);
          } catch {
            return Transaction.from(serialized);
          }
        })();

        const signed = await activeSignTransaction(txForWallet as any);
        const sendResp = await fetch("/api/solana/sendRaw", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            txBase64: Buffer.from((signed as any).serialize()).toString("base64"),
          }),
        });
        const sendJson = await sendResp.json().catch(() => null);
        if (!sendResp.ok || !sendJson?.success || !sendJson?.data?.signature) {
          throw new Error(sendJson?.error || `Send failed: ${sendResp.status}`);
        }
        const sig = String(sendJson.data.signature);
        toast({ title: mode === "deposit" ? "Deposit submitted" : "Withdraw submitted", description: `${sig.slice(0, 8)}…` });

        closeEarnModal();
        // Refresh UI immediately (show loading), then refetch after Kamino API catches up.
        schedulePositionsRefresh(10000);
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
      schedulePositionsRefresh,
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
    <div className="w-full min-w-0 max-w-full space-y-4 text-base">
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

      <ScrollArea className="w-full min-w-0 max-w-full">
        {sorted.map((position) => (
          <div
            key={position.id}
            className="box-border w-full min-w-0 max-w-full overflow-hidden p-3 sm:p-4 border-b last:border-b-0"
          >
            <div className="hidden sm:flex justify-between items-center">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 relative">
                  <KaminoLogo
                    alt={position.label}
                    externalLogoUrl={position.fallbackLogoUrl}
                    fallbackLogoUrl={"underlyingLogoUrl" in position ? position.underlyingLogoUrl : undefined}
                    symbol={"underlyingSymbol" in position ? position.underlyingSymbol : undefined}
                  />
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
                <div className="flex items-center justify-end gap-2 mb-1">
                  {position.kind === "earn" && position.aprPct != null ? (
                    <Badge
                      variant="outline"
                      className="bg-blue-500/10 text-blue-600 border-blue-500/20 text-xs font-normal px-2 py-0.5 h-5"
                    >
                      APR: {formatNumber(position.aprPct, 2)}%
                    </Badge>
                  ) : null}
                  <div className="text-lg font-bold text-right w-24">{formatCurrency(position.valueUsd, 2)}</div>
                </div>
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

            <div className="block sm:hidden w-full min-w-0 max-w-full space-y-3">
              <div className="flex w-full min-w-0 max-w-full flex-wrap items-center gap-x-2 gap-y-2">
                <div className="relative h-8 w-8 shrink-0">
                  <KaminoLogo
                    alt={position.label}
                    externalLogoUrl={position.fallbackLogoUrl}
                    fallbackLogoUrl={"underlyingLogoUrl" in position ? position.underlyingLogoUrl : undefined}
                    symbol={"underlyingSymbol" in position ? position.underlyingSymbol : undefined}
                  />
                </div>
                <div className="min-w-0 max-w-full break-words text-base font-semibold [overflow-wrap:anywhere]">
                  {position.label}
                </div>
                <Badge
                  variant="outline"
                  className={`${position.typeColor} h-4 shrink-0 px-1.5 py-0.5 text-xs font-normal`}
                >
                  {position.typeLabel}
                </Badge>
                {position.kind === "earn" && position.aprPct != null ? (
                  <Badge
                    variant="outline"
                    className="h-4 shrink-0 border-blue-500/20 bg-blue-500/10 px-1.5 py-0.5 text-xs font-normal text-blue-600"
                  >
                    APR: {formatNumber(position.aprPct, 2)}%
                  </Badge>
                ) : null}
                {"price" in position && position.price != null ? (
                  <span className="text-sm text-muted-foreground">{formatCurrency(position.price, 4)}</span>
                ) : null}
                <span className="text-base font-semibold">{formatCurrency(position.valueUsd, 2)}</span>
                {"amount" in position && position.amount > 0 ? (
                  <span className="min-w-0 max-w-full break-all text-sm text-muted-foreground">
                    {formatNumber(position.amount, 6)}
                  </span>
                ) : null}
              </div>
              <div className="flex w-full min-w-0 max-w-full flex-col gap-2">
                {position.kind === "earn" && position.vaultAddress ? (
                  <>
                    <Button
                      size="sm"
                      variant="default"
                      className="box-border h-10 w-full min-w-0 max-w-full"
                      onClick={() => openEarnDeposit(position)}
                      disabled={!effectiveSignerAddress || !activeSignTransaction}
                    >
                      Deposit
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="box-border h-10 w-full min-w-0 max-w-full"
                      onClick={() => openEarnWithdraw(position)}
                      disabled={!effectiveSignerAddress || !activeSignTransaction}
                    >
                      Withdraw
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      size="sm"
                      variant="default"
                      className="box-border h-10 w-full min-w-0 max-w-full"
                      onClick={() => window.open(KAMINO_LEND_URL, "_blank")}
                    >
                      Deposit
                      <ExternalLink className="ml-1 h-3 w-3" />
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="box-border h-10 w-full min-w-0 max-w-full"
                      onClick={() => window.open(KAMINO_LEND_URL, "_blank")}
                    >
                      Withdraw
                      <ExternalLink className="ml-1 h-3 w-3" />
                    </Button>
                  </>
                )}
              </div>
            </div>
          </div>
        ))}
      </ScrollArea>

      <div className="pt-4">
        {rewardsLoading ? (
          <div className="text-muted-foreground text-right">Loading rewards...</div>
        ) : rewards.length > 0 ? (
          <div className="text-right">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="text-gray-500 mb-1 cursor-help">
                    🎁 Rewards: {totalRewardsUsd > 0 ? formatCurrency(totalRewardsUsd, 2) : "-"}
                  </div>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs">
                  <div className="space-y-1 text-xs max-h-48 overflow-auto">
                    {rewards.map((r) => {
                      const sym = (r.tokenSymbol || "").trim();
                      const local = sym ? `/token_ico/${sym.toLowerCase()}.png` : "";
                      const icon = local || (r.tokenLogoUrl || "").trim();
                      const amountNum = Number(r.amount);
                      return (
                        <div key={r.tokenMint} className="flex items-center justify-between gap-3">
                          <div className="flex items-center gap-2">
                            {icon ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={icon} alt={sym} className="w-4 h-4 rounded-full object-contain" />
                            ) : (
                              <div className="w-4 h-4 rounded-full bg-slate-500/20" />
                            )}
                            <span>{sym || `${r.tokenMint.slice(0, 4)}...${r.tokenMint.slice(-4)}`}</span>
                          </div>
                          <span className="font-semibold">
                            {Number.isFinite(amountNum) ? formatNumber(amountNum, 6) : r.amount}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        ) : null}
      </div>

      <div className="flex items-center justify-between pt-6 pb-6">
        <span className="text-xl">Total assets in Kamino:</span>
        <span className="text-xl text-primary font-bold">{formatCurrency(totalValue, 2)}</span>
      </div>
    </div>
  );
}
