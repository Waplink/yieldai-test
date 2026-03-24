"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Decimal from "decimal.js";
import { Connection, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { useWallet as useSolanaWallet } from "@solana/wallet-adapter-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ExternalLink } from "lucide-react";
import Image from "next/image";
import { useSolanaPortfolio } from "@/hooks/useSolanaPortfolio";
import { formatCurrency, formatNumber } from "@/lib/utils/numberFormat";
import { getPreferredJupiterTokenIcon } from "@/lib/services/solana/jupiterTokenIcons";
import {
  createMainnetRpc,
  createWalletAdapterPartialSigner,
  getSolanaRpcEndpoint,
  loadKaminoVaultForAddress,
  sendKitInstructionsWithWallet,
} from "@/lib/solana/kaminoKvVaultTx";
import { extractKvaultVaultAddress } from "@/lib/kamino/kvaultVaultAddress";
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
      typeLabel: string;
      typeColor: string;
      vaultAddress?: string;
      shares: { total: number; unstaked: number; staked: number };
    };

function normalizeKaminoPosition(row: KaminoPosition, idx: number): NormalizedKaminoRow {
  if (row.source === "kamino-farm") {
    const symbol = (row.tokenSymbol || "").trim() || shortKey(row.tokenMint);
    const fallbackLogoUrl = getPreferredJupiterTokenIcon(row.tokenSymbol, row.tokenLogoUrl) ?? "";
    const valueUsd = toNumber(row.netUsdAmount, 0);
    const amount = toNumber(row.netTokenAmount, 0);
    const price = amount > 0 ? valueUsd / amount : undefined;
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
  };
}

export function KaminoPositions() {
  const { address: solanaAddress, refresh: refreshSolana } = useSolanaPortfolio();
  const { toast } = useToast();
  const { publicKey, signTransaction, wallet: solanaWallet, connecting: solanaConnecting } = useSolanaWallet();

  const [positions, setPositions] = useState<KaminoPosition[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const adapterPublicKey = (solanaWallet?.adapter?.publicKey as PublicKey | null) ?? null;
  const adapterAddress = toBase58Address(adapterPublicKey);
  const effectiveSignerAddress = toBase58Address(publicKey) || adapterAddress || "";

  const adapterSignTransaction =
    typeof (solanaWallet?.adapter as { signTransaction?: unknown } | undefined)?.signTransaction === "function"
      ? ((solanaWallet?.adapter as { signTransaction: (t: Transaction | VersionedTransaction) => Promise<Transaction | VersionedTransaction> }).signTransaction.bind(
          solanaWallet?.adapter
        ) as (t: VersionedTransaction) => Promise<VersionedTransaction>)
      : undefined;
  const activeSignTransaction = signTransaction ?? adapterSignTransaction;

  const [earnModal, setEarnModal] = useState<"deposit" | "withdraw" | null>(null);
  const [earnTarget, setEarnTarget] = useState<Extract<NormalizedKaminoRow, { kind: "earn" }> | null>(null);
  const [earnAmount, setEarnAmount] = useState("");
  const [earnSubmitting, setEarnSubmitting] = useState(false);

  const loadPositions = useCallback(async () => {
    if (!solanaAddress) {
      setPositions([]);
      return;
    }
    try {
      setLoading(true);
      setError(null);
      const response = await fetch(`/api/protocols/kamino/userPositions?address=${encodeURIComponent(solanaAddress)}`);
      if (!response.ok) throw new Error("Failed to fetch Kamino positions");
      const data = await response.json().catch(() => null);
      const rows = Array.isArray(data?.data) ? (data.data as KaminoPosition[]) : [];
      setPositions(rows);
    } catch {
      setError("Failed to load Kamino positions");
      setPositions([]);
    } finally {
      setLoading(false);
    }
  }, [solanaAddress]);

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
  const sorted = useMemo(() => [...normalized].sort((a, b) => b.valueUsd - a.valueUsd), [normalized]);
  const totalValue = useMemo(() => sorted.reduce((sum, p) => sum + p.valueUsd, 0), [sorted]);

  const openEarnDeposit = useCallback((row: Extract<NormalizedKaminoRow, { kind: "earn" }>) => {
    setEarnTarget(row);
    setEarnAmount("");
    setEarnModal("deposit");
  }, []);

  const openEarnWithdraw = useCallback((row: Extract<NormalizedKaminoRow, { kind: "earn" }>) => {
    setEarnTarget(row);
    setEarnAmount("");
    setEarnModal("withdraw");
  }, []);

  const closeEarnModal = useCallback(() => {
    setEarnModal(null);
    setEarnTarget(null);
    setEarnAmount("");
    setEarnSubmitting(false);
  }, []);

  const submitEarnModal = useCallback(async () => {
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

    const amountDec = new Decimal((earnAmount || "").trim() || "0");
    if (!amountDec.isFinite() || amountDec.lte(0)) {
      toast({ variant: "destructive", title: "Invalid amount", description: "Enter a positive number." });
      return;
    }

    setEarnSubmitting(true);
    try {
      const { vault, lookupTable } = await loadKaminoVaultForAddress(rpc, earnTarget.vaultAddress);
      const slot = await rpc.getSlot({ commitment: "confirmed" }).send();

      if (earnModal === "deposit") {
        const dep = await vault.depositIxs(signer, amountDec, undefined, undefined, signer);
        const stakeExtra =
          dep.stakeInFarmIfNeededIxs.length > 0 ? dep.stakeInFarmIfNeededIxs : dep.stakeInFlcFarmIfNeededIxs;
        const ixs = [...dep.depositIxs, ...stakeExtra];
        const sig = await sendKitInstructionsWithWallet(rpc, connection, ixs, signer, [lookupTable]);
        toast({ title: "Deposit submitted", description: `${sig.slice(0, 8)}…` });
      } else {
        const w = await vault.withdrawIxs(signer, amountDec, slot, undefined, undefined, signer);
        const ixs = [...w.unstakeFromFarmIfNeededIxs, ...w.withdrawIxs, ...w.postWithdrawIxs];
        const sig = await sendKitInstructionsWithWallet(rpc, connection, ixs, signer, [lookupTable]);
        toast({ title: "Withdraw submitted", description: `${sig.slice(0, 8)}…` });
      }

      closeEarnModal();
      await refreshSolana();
      void loadPositions();
      window.dispatchEvent(new CustomEvent("refreshPositions", { detail: { protocol: "kamino" } }));
    } catch (e) {
      toast({
        variant: "destructive",
        title: earnModal === "deposit" ? "Deposit failed" : "Withdraw failed",
        description: getErrorMessage(e),
      });
    } finally {
      setEarnSubmitting(false);
    }
  }, [
    earnTarget,
    effectiveSignerAddress,
    activeSignTransaction,
    earnAmount,
    earnModal,
    toast,
    closeEarnModal,
    refreshSolana,
    solanaConnecting,
    loadPositions,
  ]);

  if (loading) {
    return <div className="py-4 text-muted-foreground">Loading positions...</div>;
  }
  if (error) {
    return <div className="py-4 text-red-500">{error}</div>;
  }
  if (sorted.length === 0) {
    return <div className="py-4 text-muted-foreground">No positions on Kamino.</div>;
  }

  return (
    <div className="space-y-4 text-base">
      <Dialog open={earnModal !== null} onOpenChange={(o) => !o && closeEarnModal()}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{earnModal === "deposit" ? "Deposit to vault" : "Withdraw from vault"}</DialogTitle>
          </DialogHeader>
          {earnTarget && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">{earnTarget.label}</p>
              {earnModal === "withdraw" && earnTarget.shares.total > 0 && (
                <p className="text-sm text-muted-foreground">
                  Share balance (approx.): {formatNumber(earnTarget.shares.total, 6)}
                  {earnTarget.shares.staked > 0 && (
                    <span className="block text-xs mt-1">
                      Unstaked {formatNumber(earnTarget.shares.unstaked, 6)} · Staked{" "}
                      {formatNumber(earnTarget.shares.staked, 6)}
                    </span>
                  )}
                </p>
              )}
              <div className="space-y-2">
                <Label htmlFor="kamino-earn-amount">
                  {earnModal === "deposit" ? "Amount (vault token)" : "Share amount to withdraw"}
                </Label>
                <Input
                  id="kamino-earn-amount"
                  inputMode="decimal"
                  placeholder={earnModal === "deposit" ? "0.0" : "0.0"}
                  value={earnAmount}
                  onChange={(e) => setEarnAmount(e.target.value)}
                  disabled={earnSubmitting}
                />
                <p className="text-xs text-muted-foreground">
                  {earnModal === "deposit"
                    ? "Deposit uses the vault’s underlying token amount."
                    : "Enter shares in vault share units (same decimals as on Kamino). Any amount larger than your balance withdraws all."}
                </p>
              </div>
            </div>
          )}
          <DialogFooter className="gap-2 sm:gap-0">
            <Button type="button" variant="outline" onClick={closeEarnModal} disabled={earnSubmitting}>
              Cancel
            </Button>
            <Button type="button" onClick={() => void submitEarnModal()} disabled={earnSubmitting}>
              {earnSubmitting ? "Submitting…" : earnModal === "deposit" ? "Deposit" : "Withdraw"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
