import type { ProtocolPosition } from "@/shared/ProtocolCard/types";
import { PositionBadge } from "@/shared/ProtocolCard/types";
import type { MoarPosition } from "@/lib/query/hooks/protocols/moar";
import { formatNumber } from "@/lib/utils/numberFormat";

function trimTrailingZeros(value: string): string {
  if (!value.includes(".")) return value;
  const trimmed = value.replace(/\.?0+$/, "");
  return trimmed === "" ? "0" : trimmed;
}

/**
 * AI agent variant: show MOAR + underlying asset as a stacked logo pair.
 * This is intentionally different from the Moar protocol card, which shows only the underlying asset.
 */
export function mapMoarPositionToProtocolPositionAiAgent(
  position: MoarPosition,
  apr?: number
): ProtocolPosition {
  const value = parseFloat(position.value || "0");
  const amount =
    parseFloat(position.balance || "0") /
    Math.pow(10, position.assetInfo?.decimals ?? 8);
  const price = amount > 0 ? value / amount : undefined;
  const symbol = position.assetInfo?.symbol ?? position.assetName ?? "";
  const formattedAmount = trimTrailingZeros(formatNumber(amount, 4));

  const moarLogoUrl = "/protocol_ico/moar-market-logo-primary.png";
  return {
    id: `moar-${position.poolId}-${position.assetName}`,
    label: symbol || "—",
    value,
    logoUrl: moarLogoUrl,
    logoUrl2: position.assetInfo?.logoUrl ?? undefined,
    badge: PositionBadge.Supply,
    subLabel: formattedAmount,
    price,
    apr: apr != null ? apr.toFixed(2) : undefined,
  };
}

export function mapMoarPositionsToProtocolPositionsAiAgent(
  positions: MoarPosition[],
  aprByPoolId?: Record<number, number>
): ProtocolPosition[] {
  return positions
    .map((position) =>
      mapMoarPositionToProtocolPositionAiAgent(
        position,
        aprByPoolId ? aprByPoolId[position.poolId] : undefined
      )
    )
    .sort((a, b) => b.value - a.value);
}

