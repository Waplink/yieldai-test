"use client";

import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { ExternalLink } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useSolanaPortfolio } from "@/hooks/useSolanaPortfolio";
import { formatCurrency, formatNumber } from "@/lib/utils/numberFormat";

type JupiterPosition = {
  token?: {
    asset?: {
      symbol?: string;
      uiSymbol?: string;
      decimals?: number;
      price?: string;
      logoUrl?: string;
    };
  };
  underlyingAssets?: string;
};

const JUPITER_EARN_URL = "https://jup.ag/lend/earn";

function toNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
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
  const { address: solanaAddress } = useSolanaPortfolio();
  const [positions, setPositions] = useState<JupiterPosition[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
                  <div className="text-lg font-bold text-right w-24">{formatCurrency(value, 2)}</div>
                  <div className="text-base text-muted-foreground font-semibold">{formatNumber(amount, 4)}</div>
                  <div className="flex gap-2 mt-2 justify-end">
                    <Button onClick={() => window.open(JUPITER_EARN_URL, "_blank")} size="sm" variant="default" className="h-10">
                      Deposit
                      <ExternalLink className="h-3 w-3" />
                    </Button>
                    <Button onClick={() => window.open(JUPITER_EARN_URL, "_blank")} size="sm" variant="outline" className="h-10">
                      Withdraw
                      <ExternalLink className="h-3 w-3" />
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
                    <div className="text-base font-semibold text-right w-24">{formatCurrency(value, 2)}</div>
                    <div className="text-sm text-muted-foreground">{formatNumber(amount, 4)}</div>
                    <div className="flex gap-2 mt-2 justify-end">
                      <Button onClick={() => window.open(JUPITER_EARN_URL, "_blank")} size="sm" variant="default" className="h-10">
                        Deposit
                        <ExternalLink className="h-3 w-3" />
                      </Button>
                      <Button onClick={() => window.open(JUPITER_EARN_URL, "_blank")} size="sm" variant="outline" className="h-10">
                        Withdraw
                        <ExternalLink className="h-3 w-3" />
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
    </div>
  );
}

