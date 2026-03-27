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

function getEarnPositionUsd(position: unknown): number {
  return pickFirstNumber(position, [
    "positionUsd",
    "positionValueUsd",
    "totalUsdValue",
    "totalValueUsd",
    "positionUsdValue",
    "usdValue",
    "valueUsd",
  ]);
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
        const res = await fetch(
          `/api/protocols/kamino/userPositions?address=${encodeURIComponent(address)}&t=${Date.now()}`,
          { cache: "no-store" }
        );
        const data = await res.json().catch(() => null);
        const list: KaminoPositionRow[] = Array.isArray(data?.data) ? data.data : [];

        const earnByVault = new Map<string, number>();
        const farmByVault = new Map<string, number>();
        let total = 0;

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
            const vault = String(getDeep(r.position, "vaultAddress") ?? "").trim();
            const usd = getEarnPositionUsd(r.position);
            if (vault) {
              earnByVault.set(vault, Math.max(earnByVault.get(vault) ?? 0, usd));
            } else {
              total += usd;
            }
            continue;
          }

          if (r.source === "kamino-farm") {
            const vault = String(r.vaultAddress ?? "").trim();
            const usd = toNumber(r.netUsdAmount, 0);
            if (vault) {
              farmByVault.set(vault, (farmByVault.get(vault) ?? 0) + usd);
            } else {
              total += usd;
            }
          }
        }

        const allVaults = new Set([...earnByVault.keys(), ...farmByVault.keys()]);
        for (const vault of allVaults) {
          const earnUsd = earnByVault.get(vault) ?? 0;
          const farmUsd = farmByVault.get(vault) ?? 0;
          total += Math.max(earnUsd, farmUsd);
        }

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
      rows
        .map((r, idx) => ({ r, idx }))
        .filter(({ r }) => {
          if (r.source !== "kamino-farm") return true;
          const vault = String(r.vaultAddress ?? "").trim();
          if (!vault) return true;
          // If the same vault exists in earn, hide duplicate farm row in sidebar.
          return !rows.some(
            (x) => x.source === "kamino-earn" && String(getDeep(x.position, "vaultAddress") ?? "").trim() === vault
          );
        })
        .map(({ r, idx }) => {
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
        const value = getEarnPositionUsd(r.position);
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

