"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { getProtocolByName } from "@/lib/protocols/getProtocolsList";
import { ProtocolCard } from "@/shared/ProtocolCard";
import { PositionBadge } from "@/shared/ProtocolCard/types";
import { formatNumber } from "@/lib/utils/numberFormat";

interface PositionsListProps {
  address?: string;
  onPositionsValueChange?: (value: number) => void;
  showManageButton?: boolean;
}

interface JupiterPosition {
  token?: {
    asset?: {
      symbol?: string;
      uiSymbol?: string;
      decimals?: number;
      price?: string;
      logoUrl?: string;
    };
  };
  shares?: string;
  underlyingAssets?: string;
}

function toNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function PositionsList({
  address,
  onPositionsValueChange,
  showManageButton = true,
}: PositionsListProps) {
  const [positions, setPositions] = useState<JupiterPosition[]>([]);
  const [totalValue, setTotalValue] = useState(0);
  const protocol = getProtocolByName("Jupiter");
  const onValueRef = useRef(onPositionsValueChange);
  onValueRef.current = onPositionsValueChange;

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!address) {
        if (!cancelled) {
          setPositions([]);
          setTotalValue(0);
          onValueRef.current?.(0);
        }
        return;
      }

      try {
        const res = await fetch(`/api/protocols/jupiter/userPositions?address=${encodeURIComponent(address)}`);
        const data = await res.json().catch(() => null);
        const list: JupiterPosition[] = Array.isArray(data?.data) ? data.data : [];

        const total = list.reduce((sum, p) => {
          const decimals = toNumber(p?.token?.asset?.decimals, 0);
          const rawAmount = toNumber(p?.underlyingAssets, 0);
          const amount = decimals > 0 ? rawAmount / Math.pow(10, decimals) : 0;
          const price = toNumber(p?.token?.asset?.price, 0);
          return sum + amount * price;
        }, 0);

        if (!cancelled) {
          setPositions(list);
          setTotalValue(total);
          onValueRef.current?.(total);
        }
      } catch {
        if (!cancelled) {
          setPositions([]);
          setTotalValue(0);
          onValueRef.current?.(0);
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
  }, [address]);

  const protocolPositions = useMemo(
    () =>
      positions.map((position, idx) => {
        const symbol = position?.token?.asset?.uiSymbol || position?.token?.asset?.symbol || "Unknown";
        const decimals = toNumber(position?.token?.asset?.decimals, 0);
        const rawAmount = toNumber(position?.underlyingAssets, 0);
        const amount = decimals > 0 ? rawAmount / Math.pow(10, decimals) : 0;
        const price = toNumber(position?.token?.asset?.price, 0);
        const value = amount * price;
        return {
          id: `jupiter-${idx}`,
          label: symbol,
          value,
          logoUrl: position?.token?.asset?.logoUrl,
          badge: PositionBadge.Supply,
          subLabel: formatNumber(amount, 4),
          price,
        };
      }),
    [positions]
  );
  if (!protocol || !address) return null;
  if (positions.length === 0) return null;

  return (
    <ProtocolCard
      protocol={protocol}
      totalValue={totalValue}
      positions={protocolPositions}
      isLoading={false}
      showManageButton={showManageButton}
    />
  );
}

