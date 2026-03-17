"use client";

import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useSolanaPortfolio } from "@/hooks/useSolanaPortfolio";
import { formatCurrency, formatNumber } from "@/lib/utils/numberFormat";
import { useWallet as useSolanaWallet } from "@solana/wallet-adapter-react";
import { Connection, Transaction } from "@solana/web3.js";
import { useToast } from "@/components/ui/use-toast";
import { JupiterDepositModal } from "@/components/ui/jupiter-deposit-modal";
import { JupiterWithdrawModal } from "@/components/ui/jupiter-withdraw-modal";

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

function toNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const maybeMessage = (error as { message?: unknown }).message;
    if (typeof maybeMessage === "string" && maybeMessage.trim().length > 0) {
      return maybeMessage;
    }
    try {
      return JSON.stringify(error);
    } catch {
      return "Unknown error";
    }
  }
  return "Unknown error";
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
  const { address: solanaAddress, tokens: solanaTokens } = useSolanaPortfolio();
  const { publicKey, signTransaction } = useSolanaWallet();
  const { toast } = useToast();
  const [positions, setPositions] = useState<JupiterPosition[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedPosition, setSelectedPosition] = useState<JupiterPosition | null>(null);
  const [isDepositOpen, setIsDepositOpen] = useState(false);
  const [isDepositing, setIsDepositing] = useState(false);
  const [isWithdrawOpen, setIsWithdrawOpen] = useState(false);
  const [isWithdrawing, setIsWithdrawing] = useState(false);
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
    return { decimals, amount, symbol, mint };
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

  const handleDeposit = async (amountUi: number) => {
    if (!selectedPosition) return;
    if (!publicKey || !signTransaction) {
      toast({
        title: "Wallet not connected",
        description: "Connect Solana wallet to deposit to Jupiter.",
        variant: "destructive",
      });
      return;
    }

    if (!Number.isFinite(amountUi) || amountUi <= 0) {
      toast({
        title: "Invalid amount",
        description: "Enter a valid deposit amount.",
        variant: "destructive",
      });
      return;
    }

    const { decimals, mint, symbol } = selectedMeta;
    if (!mint) {
      toast({
        title: "Token error",
        description: "Jupiter token address is missing.",
        variant: "destructive",
      });
      return;
    }

    const amountBaseUnits = Math.floor(amountUi * Math.pow(10, decimals));
    if (!Number.isFinite(amountBaseUnits) || amountBaseUnits <= 0) {
      toast({
        title: "Amount too small",
        description: "Increase amount to meet token precision.",
        variant: "destructive",
      });
      return;
    }

    try {
      setIsDepositing(true);

      const txResp = await fetch("/api/protocols/jupiter/deposit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          asset: mint,
          signer: publicKey.toString(),
          amount: String(amountBaseUnits),
        }),
      });

      const txData = await txResp.json().catch(() => null);
      if (!txResp.ok || !txData?.success || !txData?.data?.transaction) {
        throw new Error(txData?.error || `Deposit prepare failed: ${txResp.status}`);
      }

      const connection = new Connection(rpcEndpoint, "confirmed");
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");

      const decoded = atob(txData.data.transaction);
      const serialized = Uint8Array.from(decoded, (char) => char.charCodeAt(0));
      const transaction = Transaction.from(serialized);
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = publicKey;

      const signed = await signTransaction(transaction);
      const signature = await connection.sendRawTransaction(signed.serialize(), {
        skipPreflight: false,
        preflightCommitment: "confirmed",
      });

      const confirmation = await connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        "confirmed"
      );
      if (confirmation.value.err) {
        throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
      }

      toast({
        title: "Deposit submitted",
        description: `Deposited ${amountUi} ${symbol}.`,
      });

      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("refreshPositions", { detail: { protocol: "jupiter" } }));
      }
      closeDeposit();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
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
    if (!publicKey || !signTransaction) {
      toast({
        title: "Wallet not connected",
        description: "Connect Solana wallet to withdraw from Jupiter.",
        variant: "destructive",
      });
      return;
    }

    if (!Number.isFinite(amountUi) || amountUi <= 0) {
      toast({
        title: "Invalid amount",
        description: "Enter a valid withdraw amount.",
        variant: "destructive",
      });
      return;
    }

    const { mint, symbol, amount: suppliedAmount, decimals } = selectedMeta;
    if (amountUi > suppliedAmount) {
      toast({
        title: "Amount too high",
        description: `Withdraw amount exceeds supplied balance (${formatNumber(suppliedAmount, 6)} ${symbol}).`,
        variant: "destructive",
      });
      return;
    }

    if (!mint) {
      toast({
        title: "Token error",
        description: "Jupiter token address is missing.",
        variant: "destructive",
      });
      return;
    }

    const amountBaseUnits = Math.floor(amountUi * Math.pow(10, decimals));
    if (!Number.isFinite(amountBaseUnits) || amountBaseUnits <= 0) {
      toast({
        title: "Amount too small",
        description: "Increase amount to meet token precision.",
        variant: "destructive",
      });
      return;
    }

    try {
      setIsWithdrawing(true);

      const txResp = await fetch("/api/protocols/jupiter/withdraw", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          asset: mint,
          signer: publicKey.toString(),
          amount: String(amountBaseUnits),
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

      const decoded = atob(txData.data.transaction);
      const serialized = Uint8Array.from(decoded, (char) => char.charCodeAt(0));
      const transaction = Transaction.from(serialized);
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = publicKey;

      const signed = await signTransaction(transaction);
      const signature = await connection.sendRawTransaction(signed.serialize(), {
        skipPreflight: false,
        preflightCommitment: "confirmed",
      });

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

      toast({
        title: "Withdraw submitted",
        description: `Withdrew ${amountUi} ${symbol}.`,
      });

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
      <ScrollArea className="max-h-[420px]">
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
      </ScrollArea>
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

