"use client";

import { useEffect } from "react";

type KaminoPositionsListProps = {
  address?: string;
  onPositionsCheckComplete?: () => void;
};

/**
 * Placeholder for Kamino positions.
 * For now we only need the component to participate in the sidebar "checking positions on" loading indicator
 * so Kamino can appear in the spinner and then be removed.
 */
export function PositionsList({ address, onPositionsCheckComplete }: KaminoPositionsListProps) {
  useEffect(() => {
    if (!address) {
      onPositionsCheckComplete?.();
      return;
    }

    const t = window.setTimeout(() => {
      onPositionsCheckComplete?.();
    }, 800);

    return () => {
      window.clearTimeout(t);
    };
  }, [address, onPositionsCheckComplete]);

  return null;
}

