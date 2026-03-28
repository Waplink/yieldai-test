"use client";

import type { ReactNode } from "react";
import Image from "next/image";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/utils/numberFormat";
import { useCollapsible } from "@/contexts/CollapsibleContext";
import { ManagePositionsButton } from "@/components/protocols/ManagePositionsButton";
import { ProtocolCardSkeleton } from "./ProtocolCardSkeleton/ProtocolCardSkeleton";
import { ProtocolCardPosition } from "./ProtocolCardPosition/ProtocolCardPosition";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { Protocol } from "@/lib/protocols/getProtocolsList";
import type { ProtocolPosition } from "./types";
import styles from "./ProtocolCard.module.css";

export interface ProtocolCardProps {
  protocol: Protocol;
  totalValue: number;
  totalRewardsUsd?: string;
  /** Optional tooltip body (e.g. per-token breakdown), shown when hovering the rewards row. */
  rewardsBreakdown?: ReactNode;
  /**
   * Match Echelon sidebar: border-top, text-sm label/value, rewards row after positions.
   * When false, uses compact ProtocolCard styles.
   */
  rewardsEchelonStyle?: boolean;
  positions?: ProtocolPosition[];
  isLoading?: boolean;
  className?: string;
  /** When false, hides the "Manage positions" button (e.g. on portfolio grid). Default true. */
  showManageButton?: boolean;
}

export function ProtocolCard({
  protocol,
  totalValue,
  totalRewardsUsd,
  rewardsBreakdown,
  rewardsEchelonStyle = false,
  positions = [],
  isLoading = false,
  className,
  showManageButton = true,
}: ProtocolCardProps) {
  const { isExpanded, toggleSection } = useCollapsible();
  const sectionKey = protocol.key;
  const expanded = isExpanded(sectionKey);
  const logoUrl = protocol.logoUrl;

  if (isLoading) {
    return <ProtocolCardSkeleton protocol={protocol} />;
  }

  return (
    <div className={cn(styles.card, className)}>
      <div
        className={styles.header}
        onClick={() => toggleSection(sectionKey)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === "Enter" && toggleSection(sectionKey)}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          {logoUrl ? <Image src={logoUrl} alt="" width={20} height={20} className={styles.logo} unoptimized /> : null}
          <span className={styles.title}>{protocol.name}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <span>{formatCurrency(totalValue, 2)}</span>
          <ChevronDown
            className={cn(styles.chevron, !expanded && styles.chevronCollapsed)}
            size={20}
          />
        </div>
      </div>

      {expanded && (
        <div className={styles.content}>
          {positions.length > 0 &&
            positions.map((pos, i) => (
              <ProtocolCardPosition key={pos.id ?? i} position={pos} />
            ))}
          {totalRewardsUsd &&
            (rewardsBreakdown ? (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div
                      className={cn(
                        rewardsEchelonStyle
                          ? "flex items-center justify-between pt-2 border-t border-gray-200 cursor-help"
                          : styles.totalRewardsRow,
                        !rewardsEchelonStyle && "cursor-help"
                      )}
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => e.stopPropagation()}
                    >
                      <span
                        className={rewardsEchelonStyle ? "text-sm text-muted-foreground" : styles.totalRewardsLabel}
                      >
                        💰 Total rewards:
                      </span>
                      <span
                        className={rewardsEchelonStyle ? "text-sm font-medium" : styles.totalRewardsValue}
                      >
                        {totalRewardsUsd}
                      </span>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent
                    className="bg-popover text-popover-foreground border-border max-w-xs"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {rewardsBreakdown}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            ) : (
              <div
                className={cn(
                  rewardsEchelonStyle
                    ? "flex items-center justify-between pt-2 border-t border-gray-200"
                    : styles.totalRewardsRow
                )}
              >
                <span
                  className={rewardsEchelonStyle ? "text-sm text-muted-foreground" : styles.totalRewardsLabel}
                >
                  💰 Total rewards:
                </span>
                <span className={rewardsEchelonStyle ? "text-sm font-medium" : styles.totalRewardsValue}>
                  {totalRewardsUsd}
                </span>
              </div>
            ))}
          {showManageButton && <ManagePositionsButton protocol={protocol} />}
        </div>
      )}
    </div>
  );
}
