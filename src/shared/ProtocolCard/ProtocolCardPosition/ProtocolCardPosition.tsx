"use client";

import Image from "next/image";
import { useMemo, useState } from "react";
import { formatCurrency } from "@/lib/utils/numberFormat";
import { Badge } from "@/shared/Badge/Badge";
import type { ProtocolPosition } from "../types";
import { PositionBadge } from "../types";
import styles from "./ProtocolCardPosition.module.css";

export interface ProtocolCardPositionProps {
  position: ProtocolPosition;
}

function getBadgeVariant(badge: PositionBadge): "success" | "danger" {
  return badge === PositionBadge.Active || badge === PositionBadge.Supply ? "success" : "danger";
}

function initialsFromLabel(label: string): string {
  const cleaned = (label || "").trim();
  if (!cleaned) return "?";
  const token = cleaned.split(/\s+/)[0] ?? cleaned;
  const up = token.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return (up.slice(0, 4) || "?").toUpperCase();
}

export function ProtocolCardPosition({ position }: ProtocolCardPositionProps) {
  const isPool = Boolean(position.logoUrl && position.logoUrl2);
  const logoUrl = position.logoUrl;
  const logoUrlFallback = position.logoUrlFallback;
  const logoUrl2 = position.logoUrl2;
  const isCollateral = position.isCollateral;
  const [useFallbackLogo, setUseFallbackLogo] = useState(false);
  const [logoFailed, setLogoFailed] = useState(false);
  const initials = useMemo(() => initialsFromLabel(position.label), [position.label]);

  if (isPool && logoUrl && logoUrl2) {
    return (
      <div className={styles.root}>
        <div className={styles.row}>
          <div className={styles.left}>
            <div className={styles.logosCol}>
              <div className={styles.logosRow}>
                <Image src={logoUrl} alt="" width={24} height={24} className={styles.logo} unoptimized />
                <Image src={logoUrl2} alt="" width={24} height={24} className={`${styles.logo} ${styles.logoStack}`} unoptimized />
              </div>
              {position.badge != null && (
                <Badge variant={getBadgeVariant(position.badge)} className={styles.statusBadge}>
                  {position.badge}
                </Badge>
              )}
            </div>
            <span className={styles.label}>{position.label}</span>
          </div>
          <span className={styles.value}>{formatCurrency(position.value, 2)}</span>
        </div>
      </div>
    );
  }

  const isBorrow = position.badge === PositionBadge.Borrow;

  return (
    <div className={styles.root}>
      <div className={styles.singleRow}>

        <div className={styles.singleLeft}>
          {(logoUrl || (useFallbackLogo && logoUrlFallback)) && !logoFailed ? (
            <Image
              src={useFallbackLogo ? (logoUrlFallback as string) : (logoUrl as string)}
              alt=""
              width={24}
              height={24}
              className={styles.logo}
              unoptimized
              onError={() => {
                if (!useFallbackLogo && logoUrlFallback) {
                  setUseFallbackLogo(true);
                  return;
                }
                setLogoFailed(true);
              }}
            />
          ) : (
            <div
              className={styles.logo}
              style={{
                width: 24,
                height: 24,
                borderRadius: 9999,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 10,
                fontWeight: 600,
                background: "rgba(148,163,184,0.18)",
                color: "rgba(148,163,184,0.95)",
              }}
              aria-hidden
            >
              {initials}
            </div>
          )}
          <div className={styles.singleLabelBlock}>
            <div className={styles.labelAndBadge}>
              <span className={styles.label}>{position.label}</span>
              {position.badge && (
                <Badge
                  variant={getBadgeVariant(position.badge)}
                  className={styles.typeBadge}
                >
                  {position.badge}
                </Badge>
              )}
              {isCollateral && (
                <Badge variant="info" className={styles.typeBadge}>
                  Collateral
                </Badge>
              )}
            </div>
            {position.price != null && (
              <span className={styles.price}>{formatCurrency(position.price, 2)}</span>
            )}
          </div>
        </div>

        <div className={styles.rightCol}>
          <span className={isBorrow ? styles.valueBorrow : styles.value}>
            {formatCurrency(position.value, 2)}
          </span>
          {position.subLabel != null && position.subLabel !== "" && (
            <span className={styles.sublabel}>{position.subLabel}</span>
          )}
        </div>

      </div>
    </div>
  );
}
