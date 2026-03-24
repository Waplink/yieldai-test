"use client";

import { useEffect, useMemo, useState } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ExternalLink } from "lucide-react";
import Image from "next/image";
import { useSolanaPortfolio } from "@/hooks/useSolanaPortfolio";
import { formatCurrency, formatNumber } from "@/lib/utils/numberFormat";
import { getPreferredJupiterTokenIcon } from "@/lib/services/solana/jupiterTokenIcons";

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
      // Local icons can be optimized by Next.js; external icons are rendered as-is.
      unoptimized={isExternalUrl(src)}
      onError={() => {
        if (!useFallback && externalLogoUrl) setUseFallback(true);
      }}
    />
  );
}

function normalizeKaminoPosition(row: KaminoPosition, idx: number) {
  if (row.source === "kamino-farm") {
    const symbol = (row.tokenSymbol || "").trim() || shortKey(row.tokenMint);
    const fallbackLogoUrl = getPreferredJupiterTokenIcon(row.tokenSymbol, row.tokenLogoUrl);
    const valueUsd = toNumber(row.netUsdAmount, 0);
    const amount = toNumber(row.netTokenAmount, 0);
    return {
      id: `kamino-farm-${row.farmPubkey}-${idx}`,
      label: `Kamino Farm (${symbol})`,
      fallbackLogoUrl,
      valueUsd,
      amount,
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
  return {
    id: `kamino-earn-${idx}`,
    label,
    fallbackLogoUrl: "",
    valueUsd,
    amount: 0,
    typeLabel: "Supply",
    typeColor: "bg-green-500/10 text-green-600 border-green-500/20",
  };
}

export function KaminoPositions() {
  const { address: solanaAddress } = useSolanaPortfolio();
  const [positions, setPositions] = useState<KaminoPosition[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPositions = async () => {
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
  };

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
  }, [solanaAddress]);

  const normalized = useMemo(() => positions.map(normalizeKaminoPosition), [positions]);
  const sorted = useMemo(() => [...normalized].sort((a, b) => b.valueUsd - a.valueUsd), [normalized]);
  const totalValue = useMemo(() => sorted.reduce((sum, p) => sum + p.valueUsd, 0), [sorted]);

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
                  <div className="text-base text-muted-foreground mt-0.5">{formatCurrency(position.valueUsd, 4)}</div>
                </div>
              </div>
              <div className="text-right">
                <div className="text-lg font-bold">{formatCurrency(position.valueUsd, 2)}</div>
                {position.amount > 0 && <div className="text-base text-muted-foreground">{formatNumber(position.amount, 6)}</div>}
                <div className="flex gap-2 mt-2 justify-end">
                  <Button size="sm" variant="default" className="h-10" onClick={() => window.open(KAMINO_LEND_URL, "_blank")}>
                    Deposit
                    <ExternalLink className="h-3 w-3 ml-1" />
                  </Button>
                  <Button size="sm" variant="outline" className="h-10" onClick={() => window.open(KAMINO_LEND_URL, "_blank")}>
                    Withdraw
                    <ExternalLink className="h-3 w-3 ml-1" />
                  </Button>
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
                    <div className="text-sm text-muted-foreground">{formatCurrency(position.valueUsd, 4)}</div>
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-base font-semibold">{formatCurrency(position.valueUsd, 2)}</div>
                  {position.amount > 0 && <div className="text-sm text-muted-foreground">{formatNumber(position.amount, 6)}</div>}
                </div>
              </div>
              <div className="flex flex-col gap-2">
                <Button size="sm" variant="default" className="w-full h-10" onClick={() => window.open(KAMINO_LEND_URL, "_blank")}>
                  Deposit
                  <ExternalLink className="h-3 w-3 ml-1" />
                </Button>
                <Button size="sm" variant="outline" className="w-full h-10" onClick={() => window.open(KAMINO_LEND_URL, "_blank")}>
                  Withdraw
                  <ExternalLink className="h-3 w-3 ml-1" />
                </Button>
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

