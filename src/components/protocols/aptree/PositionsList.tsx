"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { ChevronDown } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useCollapsible } from "@/contexts/CollapsibleContext";
import { cn } from "@/lib/utils";
import { formatCurrency, formatNumber } from "@/lib/utils/numberFormat";
import { getProtocolByName } from "@/lib/protocols/getProtocolsList";

interface PositionsListProps {
  address?: string;
  onPositionsValueChange?: (value: number) => void;
  refreshKey?: number;
  onPositionsCheckComplete?: () => void;
  showManageButton?: boolean;
}

interface AptreePosition {
  poolId: number;
  assetName: string;
  balance: string;
  value: string;
  type: "deposit";
  assetInfo?: {
    symbol?: string;
    logoUrl?: string;
    decimals?: number;
    name?: string;
  };
}

export function PositionsList({
  address,
  onPositionsValueChange,
  refreshKey,
  onPositionsCheckComplete,
}: PositionsListProps) {
  const [positions, setPositions] = useState<AptreePosition[]>([]);
  const [totalValue, setTotalValue] = useState(0);
  const { isExpanded, toggleSection } = useCollapsible();
  const protocol = getProtocolByName("APTree");

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!address) {
        setPositions([]);
        setTotalValue(0);
        onPositionsValueChange?.(0);
        onPositionsCheckComplete?.();
        return;
      }

      try {
        const res = await fetch(
          `/api/protocols/aptree/userPositions?address=${encodeURIComponent(address)}`
        );
        const data = await res.json().catch(() => null);
        const positions = Array.isArray(data?.data) ? data.data : [];
        const total = positions.reduce((sum: number, p: { value?: string | number }) => {
          const v = typeof p?.value === 'number' ? p.value : Number(p?.value || 0);
          return sum + (Number.isFinite(v) ? v : 0);
        }, 0);
        if (!cancelled) {
          setPositions(positions);
          setTotalValue(total);
          onPositionsValueChange?.(total);
        }
      } catch {
        // Keep tracker resilient: APTree user positions are optional for now.
        if (!cancelled) {
          setPositions([]);
          setTotalValue(0);
          onPositionsValueChange?.(0);
        }
      } finally {
        if (!cancelled) {
          onPositionsCheckComplete?.();
        }
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [address, refreshKey, onPositionsValueChange, onPositionsCheckComplete]);

  if (positions.length === 0) {
    return null;
  }

  return (
    <Card className="w-full h-full flex flex-col">
      <CardHeader
        className="py-2 cursor-pointer hover:bg-accent/50 transition-colors"
        onClick={() => toggleSection("aptree")}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {protocol && (
              <div className="w-5 h-5 relative">
                <Image
                  src={protocol.logoUrl}
                  alt={protocol.name}
                  width={20}
                  height={20}
                  className="object-contain"
                />
              </div>
            )}
            <CardTitle className="text-lg">APTree</CardTitle>
          </div>
          <div className="flex items-center gap-2">
            <div className="text-lg">{formatCurrency(totalValue, 2)}</div>
            <ChevronDown
              className={cn(
                "h-5 w-5 transition-transform",
                isExpanded("aptree") ? "transform rotate-0" : "transform -rotate-90"
              )}
            />
          </div>
        </div>
      </CardHeader>

      {isExpanded("aptree") && (
        <CardContent className="flex-1 overflow-y-auto px-3 pt-0">
          <ScrollArea className="h-full">
            {positions.map((position, index) => {
              const decimals = position.assetInfo?.decimals ?? 6;
              const amount = Number(position.balance || 0) / Math.pow(10, decimals);
              const symbol = position.assetInfo?.symbol || position.assetName || "AET";
              const logoUrl = position.assetInfo?.logoUrl || "/token_ico/aet.png?v=2";
              return (
                <div key={`${position.poolId}-${index}`} className="mb-2">
                  <div className="flex justify-between items-center">
                    <div className="flex items-center gap-2">
                      <div className="w-6 h-6 relative">
                        <Image
                          src={logoUrl}
                          alt={symbol}
                          width={24}
                          height={24}
                          className="object-contain"
                        />
                      </div>
                      <div>
                        <div className="text-sm font-medium">{symbol}</div>
                        <div className="text-xs text-muted-foreground">{formatNumber(amount, 6)}</div>
                      </div>
                    </div>
                    <div className="text-sm font-medium">{formatCurrency(Number(position.value || 0), 2)}</div>
                  </div>
                </div>
              );
            })}
          </ScrollArea>
        </CardContent>
      )}
    </Card>
  );
}
