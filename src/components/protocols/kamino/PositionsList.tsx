"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { getProtocolByName } from "@/lib/protocols/getProtocolsList";
import { ProtocolCard } from "@/shared/ProtocolCard";
import { PositionBadge } from "@/shared/ProtocolCard/types";
import { formatNumber } from "@/lib/utils/numberFormat";

type KaminoPositionsListProps = {
  address?: string;
  onPositionsValueChange?: (value: number) => void;
  showManageButton?: boolean;
  onPositionsCheckComplete?: () => void;
};

type KaminoPositionRow = {
  source?: "kamino-lend" | "kamino-earn" | "kamino-farm" | string;
  marketName?: string;
  marketPubkey?: string;
  obligation?: unknown;
  position?: unknown;
  farmPubkey?: string;
  tokenMint?: string;
  netTokenAmount?: string;
  netUsdAmount?: string;
  lastActivity?: string;
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
  const [totalValue, setTotalValue] = useState(0);
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
          setTotalValue(0);
          onValueRef.current?.(0);
          markComplete();
        }
        return;
      }

      try {
        const res = await fetch(`/api/protocols/kamino/userPositions?address=${encodeURIComponent(address)}`);
        const data = await res.json().catch(() => null);
        const list: KaminoPositionRow[] = Array.isArray(data?.data) ? data.data : [];

        const total = list.reduce((sum, r) => {
          if (r.source === "kamino-farm") {
            return sum + toNumber(r.netUsdAmount, 0);
          }
          if (r.source === "kamino-lend") {
            const usd = pickFirstNumber(r.obligation, [
              "refreshedStats.userTotalDeposit",
              "obligationStats.userTotalDeposit",
              "userTotalDeposit",
              "depositedValueUsd",
              "totalDepositUsd",
            ]);
            return sum + usd;
          }
          if (r.source === "kamino-earn") {
            const usd = pickFirstNumber(r.position, [
              "totalUsdValue",
              "totalValueUsd",
              "positionUsdValue",
              "usdValue",
              "valueUsd",
            ]);
            return sum + usd;
          }
          return sum;
        }, 0);

        if (!cancelled) {
          setRows(list);
          setTotalValue(total);
          onValueRef.current?.(total);
          markComplete();
        }
      } catch {
        if (!cancelled) {
          setRows([]);
          setTotalValue(0);
          onValueRef.current?.(0);
          markComplete();
        }
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
  }, [address]);

  const positions = useMemo(
    () =>
      rows.map((r, idx) => {
        if (r.source === "kamino-farm") {
          const value = toNumber(r.netUsdAmount, 0);
          const amount = toNumber(r.netTokenAmount, 0);
          return {
            id: `kamino-farm-${r.farmPubkey}-${r.tokenMint}-${idx}`,
            label: `Farm ${shortKey(r.farmPubkey)}`,
            value,
            badge: PositionBadge.Supply,
            subLabel: formatNumber(amount, 6),
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
        const vaultName = String(
          getDeep(r.position, "name") ??
            getDeep(r.position, "vaultName") ??
            getDeep(r.position, "symbol") ??
            `Earn ${idx + 1}`
        );
        return {
          id: `kamino-earn-${idx}`,
          label: vaultName,
          value,
          badge: PositionBadge.Supply,
        };
      }),
    [rows]
  );

  if (!protocol || !address) return null;
  if (rows.length === 0) return null;

  return (
    <ProtocolCard
      protocol={protocol}
      totalValue={totalValue}
      positions={positions}
      isLoading={false}
      showManageButton={showManageButton}
    />
  );
}

