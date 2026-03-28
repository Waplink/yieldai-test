"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { getProtocolByName } from "@/lib/protocols/getProtocolsList";
import { ProtocolCard } from "@/shared/ProtocolCard";
import { PositionBadge } from "@/shared/ProtocolCard/types";
import { formatNumber } from "@/lib/utils/numberFormat";
import { getPreferredJupiterTokenIcon } from "@/lib/services/solana/jupiterTokenIcons";

type KaminoPositionsListProps = {
  address?: string;
  onPositionsValueChange?: (value: number) => void;
  showManageButton?: boolean;
  onPositionsCheckComplete?: () => void;
};

type KaminoRewardRow = {
  tokenMint: string;
  tokenSymbol?: string;
  tokenLogoUrl?: string;
  amount: string;
  usdValue?: number;
};

type KaminoPositionRow = {
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
  lastActivity?: string;
  vaultAddress?: string;
  vaultName?: string;
};

function toNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function shortKey(value?: string): string {
  if (!value) return "Unknown";
  if (value.length <= 10) return value;
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
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

export function PositionsList({
  address,
  onPositionsValueChange,
  showManageButton = true,
  onPositionsCheckComplete,
}: KaminoPositionsListProps) {
  const [rows, setRows] = useState<KaminoPositionRow[]>([]);
  const [rewards, setRewards] = useState<KaminoRewardRow[]>([]);
  const [totalValue, setTotalValue] = useState(0);
  const rewardsMockEnabled =
    process.env.NEXT_PUBLIC_KAMINO_REWARDS_MOCK === "1" ||
    process.env.NEXT_PUBLIC_KAMINO_REWARDS_MOCK === "true";
  const protocol = getProtocolByName("Kamino");
  const onValueRef = useRef(onPositionsValueChange);
  onValueRef.current = onPositionsValueChange;
  const onCheckCompleteRef = useRef(onPositionsCheckComplete);
  onCheckCompleteRef.current = onPositionsCheckComplete;

  useEffect(() => {
    let cancelled = false;
    const markComplete = () => {
      if (!cancelled) onCheckCompleteRef.current?.();
    };

    async function load() {
      if (!address) {
        if (!cancelled) {
          setRows([]);
          setRewards([]);
          setTotalValue(0);
          onValueRef.current?.(0);
          markComplete();
        }
        return;
      }

      let list: KaminoPositionRow[] = [];
      let total = 0;

      try {
        const posRes = await fetch(
          `/api/protocols/kamino/userPositions?address=${encodeURIComponent(address)}&t=${Date.now()}`,
          { cache: "no-store" }
        );
        const data = await posRes.json().catch(() => null);
        const raw: KaminoPositionRow[] = Array.isArray(data?.data) ? data.data : [];
        // Don't render kamino-farm in UI (treat it as internal / rewards history noise).
        list = raw.filter((r) => r.source !== "kamino-farm");

        for (const r of list) {
          if (r.source === "kamino-lend") {
            total += pickFirstNumber(r.obligation, [
              "refreshedStats.userTotalDeposit",
              "obligationStats.userTotalDeposit",
              "userTotalDeposit",
              "depositedValueUsd",
              "totalDepositUsd",
            ]);
            continue;
          }

          if (r.source === "kamino-earn") {
            const usd = pickFirstNumber(r.position, [
              "totalUsdValue",
              "totalValueUsd",
              "positionUsdValue",
              "usdValue",
              "valueUsd",
            ]);
            if (Number.isFinite(usd) && usd > 0) total += usd;
            continue;
          }
        }
      } catch {
        list = [];
        total = 0;
      }

      let rewardList: KaminoRewardRow[] = [];
      try {
        const rewRes = await fetch(
          `/api/protocols/kamino/rewards?address=${encodeURIComponent(address)}&t=${Date.now()}${
            rewardsMockEnabled ? "&mock=1" : ""
          }`,
          { cache: "no-store" }
        );
        const rewJson = await rewRes.json().catch(() => null);
        rewardList = Array.isArray(rewJson?.data) ? rewJson.data : [];
      } catch {
        rewardList = [];
      }

      const rewardsUsd = rewardList.reduce((sum, rw) => {
        const v = typeof rw.usdValue === "number" && Number.isFinite(rw.usdValue) ? rw.usdValue : 0;
        return sum + v;
      }, 0);

      if (!cancelled) {
        setRows(list);
        setRewards(rewardList);
        setTotalValue(total);
        onValueRef.current?.(total + rewardsUsd);
        markComplete();
      }
    }

    load();
    const handleRefresh: EventListener = (evt) => {
      const event = evt as CustomEvent<{ protocol?: string }>;
      if (event?.detail?.protocol === "kamino") {
        void load();
      }
    };
    window.addEventListener("refreshPositions", handleRefresh);
    return () => {
      cancelled = true;
      window.removeEventListener("refreshPositions", handleRefresh);
    };
  }, [address, rewardsMockEnabled]);

  const positions = useMemo(
    () =>
      rows
        .filter((r) => r.source !== "kamino-farm")
        .map((r, idx) => {
        if (r.source === "kamino-farm") {
          const value = toNumber(r.netUsdAmount, 0);
          const amount = toNumber(r.netTokenAmount, 0);
          const price = amount > 0 ? value / amount : undefined;
          const tokenLabel = (r.tokenSymbol || "").trim();
          const icon = getPreferredJupiterTokenIcon(r.tokenSymbol, r.tokenLogoUrl);
          return {
            id: `kamino-farm-${r.farmPubkey}-${r.tokenMint}-${idx}`,
            label: tokenLabel ? `Kamino Farm (${tokenLabel})` : "Kamino Farm",
            value,
            logoUrl: icon,
            badge: PositionBadge.Supply,
            subLabel: formatNumber(amount, 6),
            price,
          };
        }
        if (r.source === "kamino-lend") {
          const value = pickFirstNumber(r.obligation, [
            "refreshedStats.userTotalDeposit",
            "obligationStats.userTotalDeposit",
            "userTotalDeposit",
            "depositedValueUsd",
            "totalDepositUsd",
          ]);
          return {
            id: `kamino-lend-${r.marketPubkey}-${idx}`,
            label: r.marketName || `Lend ${shortKey(r.marketPubkey)}`,
            value,
            badge: PositionBadge.Supply,
          };
        }
        const value = pickFirstNumber(r.position, [
          "totalUsdValue",
          "totalValueUsd",
          "positionUsdValue",
          "usdValue",
          "valueUsd",
        ]);
        // Kamino Earn positions endpoint often doesn't include USD fields.
        // Avoid rendering confusing "$0" rows in the sidebar.
        if (!Number.isFinite(value) || value <= 0) return null;
        const vaultName = String(
          getDeep(r.position, "name") ??
            getDeep(r.position, "vaultName") ??
            getDeep(r.position, "symbol") ??
            `Earn ${idx + 1}`
        );
        const tokenSymbol = String(getDeep(r.position, "tokenSymbol") ?? "").trim();
        const tokenLogoUrl = String(getDeep(r.position, "tokenLogoUrl") ?? "").trim();
        const localBySymbol = tokenSymbol ? `/token_ico/${tokenSymbol.toLowerCase()}.png` : "";
        const icon = localBySymbol || getPreferredJupiterTokenIcon(tokenSymbol, tokenLogoUrl);
        const label = tokenSymbol || vaultName;
        const price = pickFirstNumber(r.position, ["underlyingTokenPriceUsd", "tokenPriceUsd", "priceUsd"], NaN);
        const underlyingAmount = toNumber(getDeep(r.position, "underlyingTokenAmount"), NaN);
        return {
          id: `kamino-earn-${idx}`,
          label,
          value,
          logoUrl: icon,
          logoUrlFallback: tokenLogoUrl || undefined,
          badge: PositionBadge.Supply,
          price: Number.isFinite(price) && price > 0 ? price : undefined,
          subLabel: Number.isFinite(underlyingAmount) && underlyingAmount > 0 ? formatNumber(underlyingAmount, 6) : undefined,
        };
      })
        .filter((p): p is NonNullable<typeof p> => Boolean(p)),
    [rows]
  );

  const calculateRewardsValue = useMemo(() => {
    return rewards.reduce((sum, rw) => {
      const v = typeof rw.usdValue === "number" && Number.isFinite(rw.usdValue) ? rw.usdValue : 0;
      return sum + v;
    }, 0);
  }, [rewards]);

  const cardTotalValue = totalValue + calculateRewardsValue;

  const totalRewardsUsdStr =
    calculateRewardsValue > 0 ? `$${formatNumber(calculateRewardsValue, 2)}` : undefined;

  const rewardsBreakdown =
    calculateRewardsValue > 0 ? (
      <>
        <div className="text-xs font-semibold mb-1">Rewards breakdown:</div>
        <div className="space-y-2 max-h-60 overflow-y-auto">
          {rewards.map((reward, idx) => {
            const tokenInfo = (() => {
              const mint = (reward.tokenMint || "").trim();
              if (!mint) return null;
              const symbol =
                (reward.tokenSymbol || "").trim() || `${mint.slice(0, 4)}...${mint.slice(-4)}`;
              const icon_uri =
                (reward.tokenLogoUrl || "").trim() ||
                getPreferredJupiterTokenIcon(reward.tokenSymbol, reward.tokenLogoUrl) ||
                "";
              return { symbol, icon_uri };
            })();
            if (!tokenInfo) return null;
            const amountNum = Number(reward.amount);
            const rewardAmount = Number.isFinite(amountNum) ? amountNum : 0;
            const price =
              typeof reward.usdValue === "number" &&
              Number.isFinite(reward.usdValue) &&
              reward.usdValue > 0 &&
              rewardAmount > 0
                ? String(reward.usdValue / rewardAmount)
                : "0";
            const value =
              price && price !== "0" ? formatNumber(rewardAmount * parseFloat(price), 2) : "N/A";
            return (
              <div key={idx} className="flex items-center gap-2">
                {tokenInfo.icon_uri && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={tokenInfo.icon_uri} alt={tokenInfo.symbol} className="w-3 h-3 rounded-full" />
                )}
                <span>{tokenInfo.symbol}</span>
                <span>{Number.isFinite(amountNum) ? formatNumber(amountNum, 6) : reward.amount}</span>
                <span className="text-gray-300">${value}</span>
              </div>
            );
          })}
        </div>
      </>
    ) : undefined;

  if (!protocol || !address) return null;
  if (rows.length === 0 && calculateRewardsValue <= 0) return null;

  return (
    <ProtocolCard
      protocol={protocol}
      totalValue={cardTotalValue}
      totalRewardsUsd={totalRewardsUsdStr}
      rewardsBreakdown={rewardsBreakdown}
      rewardsEchelonStyle={Boolean(totalRewardsUsdStr)}
      positions={positions}
      isLoading={false}
      showManageButton={showManageButton}
    />
  );
}

