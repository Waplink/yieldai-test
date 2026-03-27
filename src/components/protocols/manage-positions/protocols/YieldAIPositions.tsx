"use client";

import { useCallback, useEffect, useState } from "react";
import { useWallet } from "@aptos-labs/wallet-adapter-react";
import Image from "next/image";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PanoraPricesService } from "@/lib/services/panora/prices";
import { Token } from "@/lib/types/token";
import { APTOS_COIN_TYPE, USDC_FA_METADATA_MAINNET } from "@/lib/constants/yieldAiVault";
import type { TokenPrice } from "@/lib/types/panora";
import { formatCurrency, formatNumber } from "@/lib/utils/numberFormat";
import { useToast } from "@/components/ui/use-toast";
import { getTokenList } from "@/lib/tokens/getTokenList";
import { normalizeAddress } from "@/lib/utils/addressNormalization";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Copy } from "lucide-react";
import { YieldAIDepositModal } from "@/components/ui/yield-ai-deposit-modal";
import { YieldAIWithdrawModal } from "@/components/ui/yield-ai-withdraw-modal";
import {
  useMoarPositions,
  useMoarPools,
  useMoarRewards,
  type MoarPosition,
} from "@/lib/query/hooks/protocols/moar";
import { useWithdraw } from "@/lib/hooks/useWithdraw";
import { useWalletStore } from "@/lib/stores/walletStore";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/queryKeys";
import { WithdrawModal } from "@/components/ui/withdraw-modal";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { areAddressesEqual, toCanonicalAddress } from "@/lib/utils/addressNormalization";
import { buildDelegateTradingPayload } from "@/lib/protocols/decibel/delegateTrading";
import { Input } from "@/components/ui/input";

/** Re-enable when Decibel perps delegation matches executor flow (Decibel Delegation + Executor Trade UI). */
const SHOW_EXECUTOR_TRADE_BLOCK = false;

export function YieldAIPositions() {
  const { account, signAndSubmitTransaction } = useWallet();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [safeAddresses, setSafeAddresses] = useState<string[]>([]);
  const [tokens, setTokens] = useState<Token[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDepositModal, setShowDepositModal] = useState(false);
  const [showWithdrawModal, setShowWithdrawModal] = useState(false);
  const [selectedWithdrawToken, setSelectedWithdrawToken] = useState<Token | null>(null);
  const [showMoarWithdrawModal, setShowMoarWithdrawModal] = useState(false);
  const [selectedMoarWithdrawPosition, setSelectedMoarWithdrawPosition] = useState<MoarPosition | null>(null);
  const [decibelSubaccounts, setDecibelSubaccounts] = useState<string[]>([]);
  const [selectedDecibelSubaccount, setSelectedDecibelSubaccount] = useState<string>("");
  const [delegationStatusLoading, setDelegationStatusLoading] = useState(false);
  const [delegateSubmitting, setDelegateSubmitting] = useState(false);
  const [executorAddress, setExecutorAddress] = useState<string | null>(null);
  const [isDelegatedToExecutor, setIsDelegatedToExecutor] = useState(false);
  const [delegationStatusError, setDelegationStatusError] = useState<string | null>(null);
  const [executorAsset, setExecutorAsset] = useState<"BTC" | "APT">("BTC");
  const [executorSizeUsd, setExecutorSizeUsd] = useState<string>("10");
  const [executorSubmitting, setExecutorSubmitting] = useState(false);

  const safeAddr = safeAddresses[0];
  const { data: moarPositions = [] } = useMoarPositions(safeAddr, {
    refetchOnMount: "always",
  });
  const { data: rewardsResponse } = useMoarRewards(safeAddr, {
    refetchOnMount: "always",
  });
  const { data: poolsResponse } = useMoarPools();
  const { withdraw, isLoading: isWithdrawing } = useWithdraw();
  const { getTokenPrice } = useWalletStore();

  const poolsAPR = (() => {
    if (!poolsResponse?.data) return {} as Record<number, { totalAPR: number; interestRateComponent: number; farmingAPY: number }>;
    const map: Record<number, { totalAPR: number; interestRateComponent: number; farmingAPY: number }> = {};
    (poolsResponse.data as { poolId?: number; totalAPY?: number; interestRateComponent?: number; farmingAPY?: number }[]).forEach(
      (pool) => {
        if (pool.poolId !== undefined) {
          map[pool.poolId] = {
            totalAPR: pool.totalAPY ?? 0,
            interestRateComponent: pool.interestRateComponent ?? 0,
            farmingAPY: pool.farmingAPY ?? 0,
          };
        }
      }
    );
    return map;
  })();

  const loadData = useCallback(async () => {
    const walletAddress = account?.address?.toString();
    if (!walletAddress) {
      setSafeAddresses([]);
      setTokens([]);
      return;
    }
    try {
      setLoading(true);
      setError(null);
      const safesRes = await fetch(
        `/api/protocols/yield-ai/safes?owner=${encodeURIComponent(walletAddress)}`
      );
      const safesJson = await safesRes.json();
      const list = safesJson?.data?.safeAddresses ?? [];
      const addresses = Array.isArray(list) ? list : [];
      setSafeAddresses(addresses);

      if (addresses.length === 0) {
        setTokens([]);
        return;
      }

      const safeAddress = addresses[0];
      const contentsRes = await fetch(
        `/api/protocols/yield-ai/safe-contents?safeAddress=${encodeURIComponent(safeAddress)}`
      );
      const contentsJson = await contentsRes.json();
      const data = contentsJson?.data;
      const faTokens = data?.tokens ?? [];
      const aptBalance = data?.aptBalance ?? "0";

      const tokenAddresses = [
        ...faTokens.map((t: { asset_type: string }) => t.asset_type),
        APTOS_COIN_TYPE,
      ].filter(Boolean);
      const pricesService = PanoraPricesService.getInstance();
      let prices: TokenPrice[] = [];
      try {
        const pr = await pricesService.getPrices(1, tokenAddresses);
        prices = Array.isArray(pr) ? pr : (pr?.data ?? []);
      } catch {
        // no prices
      }

      const built: Token[] = [];
      const tokenListAptos = getTokenList(1) as Array<{
        faAddress?: string;
        tokenAddress?: string | null;
        symbol?: string;
        logoUrl?: string;
      }>;
      const resolveLogo = (addressOrType: string, symbol: string) => {
        const addr = addressOrType.includes("::")
          ? addressOrType.split("::")[0]
          : addressOrType;
        const norm = normalizeAddress(addr);
        const byAddr = tokenListAptos.find(
          (t: { faAddress?: string; tokenAddress?: string | null }) => {
            const tFa = t.faAddress && normalizeAddress(t.faAddress);
            const tTa = t.tokenAddress && normalizeAddress(t.tokenAddress);
            return tFa === norm || tTa === norm;
          }
        );
        if (byAddr?.logoUrl) return byAddr.logoUrl;
        const bySymbol = tokenListAptos.find(
          (t: { symbol?: string }) => t.symbol === symbol
        );
        return bySymbol?.logoUrl;
      };
      for (const t of faTokens) {
        const price = prices.find(
          (p) => p.faAddress === t.asset_type || p.tokenAddress === t.asset_type
        );
        const decimals = price?.decimals ?? 8;
        const amount = parseFloat(t.amount) / Math.pow(10, decimals);
        const usd = price ? amount * parseFloat(price.usdPrice) : 0;
        const symbol = price?.symbol ?? t.asset_type.split("::").pop() ?? "?";
        built.push({
          address: t.asset_type,
          name: price?.name ?? t.asset_type.split("::").pop() ?? "",
          symbol,
          decimals,
          amount: t.amount,
          price: price?.usdPrice ?? null,
          value: price ? String(usd) : null,
          logoUrl: resolveLogo(t.asset_type, symbol),
        });
      }
      if (BigInt(aptBalance) > 0) {
        const aptPrice = prices.find(
          (p) =>
            p.tokenAddress === APTOS_COIN_TYPE || p.faAddress === APTOS_COIN_TYPE
        );
        const decimals = aptPrice?.decimals ?? 8;
        const amount = Number(aptBalance) / Math.pow(10, decimals);
        const usd = aptPrice ? amount * parseFloat(aptPrice.usdPrice) : 0;
        built.push({
          address: APTOS_COIN_TYPE,
          name: "Aptos Coin",
          symbol: "APT",
          decimals,
          amount: aptBalance,
          price: aptPrice?.usdPrice ?? null,
          value: aptPrice ? String(usd) : null,
          logoUrl: resolveLogo(APTOS_COIN_TYPE, "APT"),
        });
      }
      built.sort((a, b) => {
        const va = a.value ? parseFloat(a.value) : 0;
        const vb = b.value ? parseFloat(b.value) : 0;
        return vb - va;
      });
      // Only show base assets (USDC, APT); hide wrapper/supply tokens
      const baseOnly = built.filter(
        (t) =>
          t.symbol === "USDC" ||
          normalizeAddress(t.address) === normalizeAddress(USDC_FA_METADATA_MAINNET) ||
          t.address === APTOS_COIN_TYPE
      );
      setTokens(baseOnly);
    } catch {
      setError("Failed to load AI agent safe data");
      setTokens([]);
    } finally {
      setLoading(false);
    }
  }, [account?.address]);

  const loadDecibelSubaccounts = useCallback(async () => {
    const walletAddress = account?.address?.toString();
    if (!walletAddress) {
      setDecibelSubaccounts([]);
      setSelectedDecibelSubaccount("");
      return;
    }
    try {
      const response = await fetch(
        `/api/protocols/decibel/subaccounts?address=${encodeURIComponent(walletAddress)}`
      );
      const json = await response.json();
      const data: Array<{ subaccount_address?: string }> = Array.isArray(json?.data) ? json.data : [];
      const addresses = data
        .map((item) => item?.subaccount_address)
        .filter((value: unknown): value is string => typeof value === "string")
        .map((value: string) => toCanonicalAddress(value));
      setDecibelSubaccounts(addresses);
      setSelectedDecibelSubaccount((prev) => {
        if (prev && addresses.some((it) => areAddressesEqual(it, prev))) {
          return toCanonicalAddress(prev);
        }
        return addresses[0] ?? "";
      });
    } catch {
      setDecibelSubaccounts([]);
      setSelectedDecibelSubaccount("");
    }
  }, [account?.address]);

  const loadDelegationStatus = async (subaccount: string) => {
    if (!subaccount) {
      setDelegationStatusError(null);
      setIsDelegatedToExecutor(false);
      setExecutorAddress(null);
      return;
    }
    try {
      setDelegationStatusLoading(true);
      setDelegationStatusError(null);
      const response = await fetch(
        `/api/protocols/decibel/delegations?subaccount=${encodeURIComponent(subaccount)}`
      );
      const json = await response.json();
      if (!response.ok || !json?.success) {
        throw new Error(json?.error || "Failed to load delegation status");
      }
      setIsDelegatedToExecutor(Boolean(json?.isDelegatedToExecutor));
      setExecutorAddress(typeof json?.executorAddress === "string" ? json.executorAddress : null);
    } catch (err) {
      setIsDelegatedToExecutor(false);
      setExecutorAddress(null);
      setDelegationStatusError(
        err instanceof Error ? err.message : "Failed to load delegation status"
      );
    } finally {
      setDelegationStatusLoading(false);
    }
  };

  const handleDelegate = async () => {
    if (!account?.address) {
      toast({
        title: "Wallet not connected",
        description: "Connect your wallet to delegate trading.",
        variant: "destructive",
      });
      return;
    }
    if (!selectedDecibelSubaccount) {
      toast({
        title: "Subaccount required",
        description: "Select a Decibel subaccount first.",
        variant: "destructive",
      });
      return;
    }
    if (!executorAddress) {
      toast({
        title: "Executor is not configured",
        description: "Try refreshing delegation status and try again.",
        variant: "destructive",
      });
      return;
    }
    if (!signAndSubmitTransaction) {
      toast({
        title: "Unsupported wallet",
        description: "Current wallet cannot sign and submit transactions.",
        variant: "destructive",
      });
      return;
    }

    try {
      setDelegateSubmitting(true);
      const payload = buildDelegateTradingPayload({
        subaccountAddr: selectedDecibelSubaccount,
        accountToDelegateTo: executorAddress,
        expirationTimestampSecs: null,
      });
      const result = await signAndSubmitTransaction({
        data: {
          function: payload.function as `${string}::${string}::${string}`,
          typeArguments: payload.typeArguments,
          functionArguments: payload.functionArguments as (string | number | null)[],
        },
        options: { maxGasAmount: 20000 },
      });
      const txHash = typeof result?.hash === "string" ? result.hash : "";
      toast({
        title: "Delegation submitted",
        description: txHash
          ? `Transaction ${txHash.slice(0, 6)}...${txHash.slice(-4)}`
          : "Transaction submitted successfully.",
      });
      await loadDelegationStatus(selectedDecibelSubaccount);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to delegate trading";
      toast({ title: "Delegation failed", description: msg, variant: "destructive" });
    } finally {
      setDelegateSubmitting(false);
    }
  };

  const handleExecutorOpenShort = async () => {
    if (!account?.address) {
      toast({
        title: "Wallet not connected",
        description: "Connect your wallet to continue.",
        variant: "destructive",
      });
      return;
    }
    if (!selectedDecibelSubaccount) {
      toast({
        title: "Subaccount required",
        description: "Select a Decibel subaccount first.",
        variant: "destructive",
      });
      return;
    }
    const sizeUsd = Number(executorSizeUsd);
    if (!Number.isFinite(sizeUsd) || sizeUsd <= 0) {
      toast({
        title: "Invalid size",
        description: "Enter a valid USD size.",
        variant: "destructive",
      });
      return;
    }
    try {
      setExecutorSubmitting(true);
      const response = await fetch("/api/protocols/decibel/executor-open-short", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          owner: account.address.toString(),
          subaccount: selectedDecibelSubaccount,
          asset: executorAsset,
          sizeUsd,
        }),
      });
      const json = await response.json();
      if (!response.ok || !json?.success) {
        throw new Error(json?.error || "Failed to open short via executor");
      }

      const hash = json?.data?.openTxHash as string | undefined;
      toast({
        title: "Executor short opened",
        description: hash
          ? `${executorAsset} short 1x submitted: ${hash.slice(0, 6)}...${hash.slice(-4)}`
          : `${executorAsset} short 1x submitted.`,
      });
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent("refreshPositions", { detail: { protocol: "decibel" } }));
      }, 1500);
    } catch (err) {
      toast({
        title: "Executor short failed",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setExecutorSubmitting(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    if (!SHOW_EXECUTOR_TRADE_BLOCK) return;
    void loadDecibelSubaccounts();
  }, [loadDecibelSubaccounts]);

  useEffect(() => {
    if (!SHOW_EXECUTOR_TRADE_BLOCK) return;
    if (!selectedDecibelSubaccount) return;
    void loadDelegationStatus(selectedDecibelSubaccount);
  }, [selectedDecibelSubaccount]);

  useEffect(() => {
    const handleRefresh: EventListener = (evt) => {
      const event = evt as CustomEvent<{ protocol: string }>;
      if (event?.detail?.protocol === "yield-ai") {
        void loadData();
      }
    };
    window.addEventListener("refreshPositions", handleRefresh);
    return () => window.removeEventListener("refreshPositions", handleRefresh);
  }, [loadData]);

  const getMoarTokenAddress = (symbol: string) => {
    if (symbol === "APT") return "0x1::aptos_coin::AptosCoin";
    if (symbol === "USDC") return "0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b";
    return symbol;
  };

  const handleMoarWithdrawConfirm = async (amount: bigint) => {
    if (!selectedMoarWithdrawPosition) return;
    try {
      const tokenAddress = getMoarTokenAddress(selectedMoarWithdrawPosition.assetInfo.symbol);
      await withdraw("moar", String(selectedMoarWithdrawPosition.poolId), amount, tokenAddress);
      setShowMoarWithdrawModal(false);
      setSelectedMoarWithdrawPosition(null);
      if (safeAddr) {
        queryClient.invalidateQueries({ queryKey: queryKeys.protocols.moar.userPositions(safeAddr) });
        queryClient.invalidateQueries({ queryKey: queryKeys.protocols.moar.rewards(safeAddr) });
      }
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent("refreshPositions", { detail: { protocol: "yield-ai" } }));
      }, 2000);
    } catch (err) {
      console.error("Moar withdraw failed:", err);
      toast({
        title: "Withdraw Failed",
        description: err instanceof Error ? err.message : "Withdraw failed. Please try again.",
        variant: "destructive",
      });
    }
  };

  const rewardsData = rewardsResponse?.data ?? [];
  const totalRewardsValue = rewardsResponse?.totalUsd ?? 0;

  const moarPositionsValue = moarPositions.reduce(
    (sum, p) => sum + parseFloat(p.value || "0"),
    0
  );
  const totalValue =
    tokens.reduce((sum, t) => sum + (t.value ? parseFloat(t.value) : 0), 0) +
    moarPositionsValue +
    totalRewardsValue;

  if (loading) {
    return <div className="py-4 text-muted-foreground">Loading safe assets...</div>;
  }
  if (error) {
    return <div className="py-4 text-red-500">{error}</div>;
  }
  if (safeAddresses.length === 0) {
    return (
      <div className="py-4 text-muted-foreground">
        No safe found. Create a safe to see assets here.
      </div>
    );
  }

  return (
    <div className="space-y-4 text-base">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1.5">
          <span className="text-sm text-muted-foreground font-medium">
            Safe {safeAddresses[0].slice(0, 6)}...{safeAddresses[0].slice(-4)}
          </span>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 shrink-0"
                onClick={() => {
                  navigator.clipboard
                    .writeText(safeAddresses[0])
                    .then(() =>
                      toast({
                        title: "Copied",
                        description: "Safe address copied to clipboard",
                      })
                    )
                    .catch(() =>
                      toast({
                        title: "Copy failed",
                        variant: "destructive",
                      })
                    );
                }}
                aria-label="Copy safe address"
              >
                <Copy className="h-3.5 w-3.5 text-muted-foreground" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>Copy safe address</p>
            </TooltipContent>
          </Tooltip>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
          <span className="text-sm text-muted-foreground font-normal text-right max-w-md">
            AI agent rebalances positions every hour
          </span>
          {!tokens.some(
            (t) =>
              t.symbol === "USDC" ||
              normalizeAddress(t.address) === normalizeAddress(USDC_FA_METADATA_MAINNET)
          ) && (
            <Button size="sm" variant="default" onClick={() => setShowDepositModal(true)}>
              Deposit USDC
            </Button>
          )}
        </div>
      </div>

      {SHOW_EXECUTOR_TRADE_BLOCK && (
        <>
          <div className="rounded-lg border bg-card p-3 sm:p-4 space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="font-medium">Decibel Delegation</div>
                <div className="text-sm text-muted-foreground">
                  Delegate selected subaccount to executor for AI trading.
                </div>
              </div>
              <Badge
                variant="outline"
                className={
                  isDelegatedToExecutor
                    ? "bg-green-500/10 text-green-600 border-green-500/20"
                    : "bg-muted text-muted-foreground"
                }
              >
                {delegationStatusLoading
                  ? "Checking..."
                  : isDelegatedToExecutor
                    ? "Delegated"
                    : "Not delegated"}
              </Badge>
            </div>

            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Select
                value={selectedDecibelSubaccount}
                onValueChange={setSelectedDecibelSubaccount}
                disabled={decibelSubaccounts.length === 0 || delegateSubmitting}
              >
                <SelectTrigger className="w-full sm:w-[380px]">
                  <SelectValue placeholder="Select Decibel subaccount" />
                </SelectTrigger>
                <SelectContent>
                  {decibelSubaccounts.map((sub) => (
                    <SelectItem key={sub} value={sub}>
                      {sub.slice(0, 8)}...{sub.slice(-6)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="default"
                  onClick={handleDelegate}
                  disabled={
                    delegateSubmitting ||
                    !account?.address ||
                    !selectedDecibelSubaccount ||
                    !executorAddress
                  }
                >
                  {delegateSubmitting ? "Delegating..." : "Delegate"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    if (selectedDecibelSubaccount) {
                      void loadDelegationStatus(selectedDecibelSubaccount);
                    }
                  }}
                  disabled={delegationStatusLoading || !selectedDecibelSubaccount}
                >
                  Refresh status
                </Button>
              </div>
            </div>

            {executorAddress && (
              <div className="text-xs text-muted-foreground">
                Executor: {executorAddress.slice(0, 8)}...{executorAddress.slice(-6)}
              </div>
            )}
            {decibelSubaccounts.length === 0 && (
              <div className="text-xs text-muted-foreground">
                No Decibel subaccounts found for this wallet.
              </div>
            )}
            {delegationStatusError && (
              <div className="text-xs text-destructive">{delegationStatusError}</div>
            )}
          </div>

          <div className="rounded-lg border bg-card p-3 sm:p-4 space-y-3">
            <div>
              <div className="font-medium">Executor Trade</div>
              <div className="text-sm text-muted-foreground">
                Test mode: open market short 1x on BTC or APT without wallet popup.
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <Select
                value={executorAsset}
                onValueChange={(value) => setExecutorAsset(value as "BTC" | "APT")}
                disabled={executorSubmitting}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="BTC">BTC</SelectItem>
                  <SelectItem value="APT">APT</SelectItem>
                </SelectContent>
              </Select>
              <Input
                type="number"
                min="0"
                step="any"
                placeholder="Size USD"
                value={executorSizeUsd}
                onChange={(e) => setExecutorSizeUsd(e.target.value)}
                disabled={executorSubmitting}
              />
              <Button
                variant="default"
                onClick={handleExecutorOpenShort}
                disabled={
                  executorSubmitting ||
                  !selectedDecibelSubaccount
                }
              >
                {executorSubmitting ? "Submitting..." : "Open short 1x"}
              </Button>
            </div>
          </div>
        </>
      )}

      <ScrollArea>
        {moarPositions.length > 0 && (
          <div className="px-3 sm:px-4 pt-1 pb-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Moar Market
          </div>
        )}
        {moarPositions.map((position) => {
          const value = parseFloat(position.value || "0");
          const decimals = position.assetInfo?.decimals ?? 8;
          const amount = parseFloat(position.balance || "0") / Math.pow(10, decimals);
          const poolAPR = poolsAPR[position.poolId];
          const positionRewards = rewardsData.filter(
            (reward: { farming_identifier?: string }) =>
              reward.farming_identifier &&
              reward.farming_identifier === position.poolId.toString()
          );
          return (
            <div key={`moar-${position.poolId}`} className="border-b last:border-b-0">
              <div className="p-3 sm:p-4 flex justify-between items-center gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <div className="flex items-center -space-x-1">
                  <div className="w-8 h-8 relative shrink-0 rounded-full bg-muted flex items-center justify-center overflow-hidden ring-2 ring-background">
                    <Image
                      src="/protocol_ico/moar-market-logo-primary.png"
                      alt="MOAR"
                      width={32}
                      height={32}
                      className="object-contain"
                      unoptimized
                    />
                  </div>
                  {position.assetInfo?.logoUrl && (
                    <div className="w-8 h-8 relative shrink-0 rounded-full bg-muted flex items-center justify-center overflow-hidden ring-2 ring-background">
                      <Image
                        src={position.assetInfo.logoUrl}
                        alt={position.assetInfo.symbol}
                        width={32}
                        height={32}
                        className="object-contain"
                        unoptimized
                      />
                    </div>
                  )}
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">{position.assetInfo?.symbol ?? "—"}</span>
                    <Badge
                      variant="outline"
                      className="bg-green-500/10 text-green-600 border-green-500/20 text-xs font-normal px-2 py-0.5 h-5"
                    >
                      Supply
                    </Badge>
                  </div>
                  {poolAPR && poolAPR.totalAPR > 0 && (
                    <div className="text-sm text-muted-foreground">
                      APR: {formatNumber(poolAPR.totalAPR, 2)}%
                    </div>
                  )}
                </div>
              </div>
              <div className="text-right shrink-0">
                <div className="text-lg font-bold">{formatCurrency(value, 2)}</div>
                <div className="text-base text-muted-foreground font-semibold">
                  {formatNumber(amount, 4)}
                </div>
                <div className="flex gap-2 mt-2 justify-end">
                  {amount > 0 && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-10 max-w-[min(100%,18rem)] whitespace-normal text-center leading-tight px-2 py-1.5"
                      disabled={isWithdrawing}
                      onClick={() => {
                        setSelectedMoarWithdrawPosition(position);
                        setShowMoarWithdrawModal(true);
                      }}
                    >
                      {isWithdrawing
                        ? "Withdrawing…"
                        : "Withdraw to AI agent wallet"}
                    </Button>
                  )}
                </div>
              </div>
              </div>
              {positionRewards.length > 0 && (
                <div className="px-3 sm:px-4 pb-3 pt-0 border-t border-border">
                  <div className="text-xs font-medium text-muted-foreground mb-1">
                    💰 Supply Rewards
                  </div>
                  <div className="space-y-1">
                    {positionRewards.map((reward: { logoUrl?: string | null; symbol?: string; usdValue?: number; amount?: number; token_info?: { symbol?: string } }, rewardIdx: number) => (
                      <TooltipProvider key={rewardIdx}>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <div className="flex items-center justify-between text-xs cursor-help">
                              <div className="flex items-center gap-1">
                                {reward.logoUrl && (
                                  <Image
                                    src={reward.logoUrl}
                                    alt={reward.symbol ?? "?"}
                                    width={12}
                                    height={12}
                                    className="object-contain"
                                    unoptimized
                                  />
                                )}
                                <span className="text-muted-foreground">
                                  {reward.symbol ?? "Unknown"}
                                </span>
                              </div>
                              <div className="text-right">
                                <div className="font-medium">
                                  {formatCurrency(reward.usdValue ?? 0)}
                                </div>
                              </div>
                            </div>
                          </TooltipTrigger>
                          <TooltipContent className="bg-popover text-popover-foreground border-border">
                            <div className="text-xs">
                              <div className="text-muted-foreground">
                                {formatNumber(reward.amount ?? 0, 6)}{" "}
                                {reward.token_info?.symbol ?? reward.symbol ?? "Unknown"}
                              </div>
                              <div className="text-muted-foreground">
                                {formatCurrency(reward.usdValue ?? 0)}
                              </div>
                            </div>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
        {tokens.length === 0 && moarPositions.length === 0 ? (
          <div className="py-4 text-muted-foreground">No assets in this safe.</div>
        ) : (
          <>
            {tokens.length > 0 && (
              <div
                className={
                  moarPositions.length > 0
                    ? "px-3 sm:px-4 pt-3 pb-2 text-xs font-medium text-muted-foreground uppercase tracking-wide border-t border-border"
                    : "px-3 sm:px-4 pt-1 pb-2 text-xs font-medium text-muted-foreground uppercase tracking-wide"
                }
              >
                AI agent wallet (safe)
              </div>
            )}
            {tokens.map((token) => {
            const value = token.value ? parseFloat(token.value) : 0;
            const amount =
              parseFloat(token.amount) / Math.pow(10, token.decimals);
            const price = token.price ? parseFloat(token.price) : 0;
            const isUsdc =
              token.symbol === "USDC" ||
              normalizeAddress(token.address) === normalizeAddress(USDC_FA_METADATA_MAINNET);
            return (
              <div
                key={token.address}
                className="p-3 sm:p-4 border-b last:border-b-0 flex justify-between items-center gap-3"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-8 h-8 relative shrink-0 rounded-full bg-muted flex items-center justify-center text-sm font-semibold">
                    {token.logoUrl ? (
                      <Image
                        src={token.logoUrl}
                        alt={token.symbol}
                        width={32}
                        height={32}
                        className="object-contain rounded-full"
                        unoptimized
                      />
                    ) : (
                      <span>{token.symbol.slice(0, 1)}</span>
                    )}
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold">{token.symbol}</span>
                      {isUsdc && (
                        <Badge
                          variant="outline"
                          className="bg-green-500/10 text-green-600 border-green-500/20 text-xs font-normal px-2 py-0.5 h-5"
                        >
                          AGENT WALLET
                        </Badge>
                      )}
                    </div>
                    {price > 0 && (
                      <div className="text-sm text-muted-foreground">
                        {formatCurrency(price, 4)}
                      </div>
                    )}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-lg font-bold">{formatCurrency(value, 2)}</div>
                  <div className="text-base text-muted-foreground font-semibold">
                    {formatNumber(amount, 4)}
                  </div>
                  {isUsdc && (
                    <div className="flex flex-wrap gap-2 mt-2 justify-end">
                      <Button
                        size="sm"
                        variant="default"
                        className="h-10"
                        onClick={() => setShowDepositModal(true)}
                      >
                        Deposit
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-10"
                        onClick={() => {
                          setSelectedWithdrawToken(token);
                          setShowWithdrawModal(true);
                        }}
                      >
                        Withdraw
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          </>
        )}
      </ScrollArea>

      <div className="pt-6 pb-6 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xl">Total assets in safe:</span>
          <span className="text-xl text-primary font-bold">
            {formatCurrency(totalValue, 2)}
          </span>
        </div>
        {totalRewardsValue > 0 && (
          <div className="flex justify-end">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="text-sm text-muted-foreground flex items-center gap-1 justify-end cursor-help">
                    <span>💰</span>
                    <span>including rewards {formatCurrency(totalRewardsValue)}</span>
                  </div>
                </TooltipTrigger>
                <TooltipContent className="bg-popover text-popover-foreground border-border max-w-xs">
                  <div className="text-xs font-semibold mb-1">Rewards breakdown:</div>
                  <div className="space-y-2 max-h-60 overflow-y-auto">
                    {rewardsData.map(
                      (
                        reward: {
                          logoUrl?: string | null;
                          symbol?: string;
                          amount?: number;
                          usdValue?: number;
                        },
                        idx: number
                      ) => (
                        <div key={idx} className="flex items-center gap-2">
                          {reward.logoUrl && (
                            <img
                              src={reward.logoUrl}
                              alt={reward.symbol ?? ""}
                              className="w-3 h-3 rounded-full"
                            />
                          )}
                          <span>{reward.symbol}</span>
                          <span>{formatNumber(reward.amount ?? 0, 6)}</span>
                          <span className="text-muted-foreground">
                            {formatCurrency(reward.usdValue ?? 0)}
                          </span>
                        </div>
                      )
                    )}
                  </div>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        )}
      </div>

      <YieldAIDepositModal
        isOpen={showDepositModal}
        onClose={() => setShowDepositModal(false)}
        safeAddress={safeAddresses[0]}
      />

      <YieldAIWithdrawModal
        isOpen={showWithdrawModal}
        onClose={() => {
          setShowWithdrawModal(false);
          setSelectedWithdrawToken(null);
        }}
        token={selectedWithdrawToken}
        safeAddress={safeAddresses[0]}
      />

      {selectedMoarWithdrawPosition && (
        <WithdrawModal
          isOpen={showMoarWithdrawModal}
          onClose={() => {
            setShowMoarWithdrawModal(false);
            setSelectedMoarWithdrawPosition(null);
          }}
          onConfirm={handleMoarWithdrawConfirm}
          position={{
            coin: selectedMoarWithdrawPosition.assetInfo.symbol,
            supply: selectedMoarWithdrawPosition.balance,
            market: String(selectedMoarWithdrawPosition.poolId),
          }}
          tokenInfo={{
            symbol: selectedMoarWithdrawPosition.assetInfo.symbol,
            logoUrl: selectedMoarWithdrawPosition.assetInfo.logoUrl ?? undefined,
            decimals: selectedMoarWithdrawPosition.assetInfo.decimals,
            usdPrice: getTokenPrice(getMoarTokenAddress(selectedMoarWithdrawPosition.assetInfo.symbol)),
          }}
          isLoading={isWithdrawing}
          userAddress={safeAddr ?? undefined}
        />
      )}

    </div>
  );
}
