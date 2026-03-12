"use client";

import { useEffect } from "react";

interface PositionsListProps {
  address?: string;
  onPositionsValueChange?: (value: number) => void;
  refreshKey?: number;
  onPositionsCheckComplete?: () => void;
  showManageButton?: boolean;
}

export function PositionsList({
  address,
  onPositionsValueChange,
  refreshKey,
  onPositionsCheckComplete,
}: PositionsListProps) {
  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!address) {
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
          onPositionsValueChange?.(total);
        }
      } catch {
        // Keep tracker resilient: APTree user positions are optional for now.
        if (!cancelled) {
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

  return null;
}
