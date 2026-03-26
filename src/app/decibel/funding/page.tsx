'use client';

import { useState, useEffect, useMemo } from 'react';
import Link from 'next/link';
import { Logo } from '@/components/ui/logo';
import { WalletSelector } from '@/components/WalletSelector';
import { DecibelCTABlock } from '@/components/ui/decibel-cta-block';
import { DecibelFundingChart, getChartMarketOrder, type RawFundingRecord } from '@/components/decibel/decibel-funding-chart';
import { DecibelOpenPositionModal, type DecibelOpenPositionMarket } from '@/components/decibel/decibel-open-position-modal';
import { fetchFundingApr, marketNameForFundingApi } from '@/lib/protocols/decibel/fundingApr';
import { formatNumber, formatCurrency } from '@/lib/utils/numberFormat';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import Image from 'next/image';

const MARKET_LOGOS: Record<string, string> = {
  'BTC/USD': 'https://app.decibel.trade/images/icons/btc.svg?dpl=dpl_FECfRSDXc1wiUcCXB6MPHgx2CzKp',
  'APT/USD': 'https://assets.panora.exchange/tokens/aptos/apt.svg',
  'ETH/USD': 'https://app.decibel.trade/images/icons/eth.svg?dpl=dpl_FECfRSDXc1wiUcCXB6MPHgx2CzKp',
  'SOL/USD': 'https://app.decibel.trade/images/icons/sol.svg?dpl=dpl_FECfRSDXc1wiUcCXB6MPHgx2CzKp',
  'DOGE/USD': 'https://app.decibel.trade/images/icons/doge.svg?dpl=dpl_FECfRSDXc1wiUcCXB6MPHgx2CzKp',
  'XRP/USD': 'https://app.decibel.trade/images/icons/xrp.svg?dpl=dpl_FECfRSDXc1wiUcCXB6MPHgx2CzKp',
  'BNB/USD': 'https://app.decibel.trade/images/icons/bnb.svg?dpl=dpl_FECfRSDXc1wiUcCXB6MPHgx2CzKp',
  'SUI/USD': '/token_ico/sui.png',
  'HYPE/USD': 'https://app.decibel.trade/images/icons/hype.svg?dpl=dpl_FECfRSDXc1wiUcCXB6MPHgx2CzKp',
  'ZEC/USD': 'https://app.decibel.trade/images/icons/zec.svg?dpl=dpl_FECfRSDXc1wiUcCXB6MPHgx2CzKp',
};

interface DecibelMarketRow {
  market_addr: string;
  market_name?: string;
}

function getLogoUrl(marketName: string): string | undefined {
  const key = marketNameForFundingApi(marketName);
  return MARKET_LOGOS[key];
}

/**
 * Latest open interest per market from raw funding data.
 * API returns OI in base asset (e.g. 23 BTC); we convert to notional USD using mark_px.
 */
function latestOINotionalPerMarket(data: RawFundingRecord[]): Record<string, number> {
  const byMarket: Record<string, { ts: number; oi: number; mark_px: number }> = {};
  for (const row of data) {
    const name = row.market_name;
    if (!name || typeof name !== 'string') continue;
    const key = marketNameForFundingApi(name);
    const ts = typeof row.transaction_unix_ms === 'number' ? row.transaction_unix_ms : 0;
    const oi = typeof row.open_interest === 'number' ? row.open_interest : 0;
    const markPx = typeof (row as { mark_px?: number }).mark_px === 'number' ? (row as { mark_px: number }).mark_px : (row as { mid_px?: number }).mid_px ?? 0;
    const prev = byMarket[key];
    if (!prev || ts > prev.ts) byMarket[key] = { ts, oi, mark_px: markPx };
  }
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(byMarket)) {
    out[k] = v.mark_px > 0 ? v.oi * v.mark_px : Number.NaN;
  }
  return out;
}

/** Span of raw funding timestamps in hours (min..max over all rows). */
function fundingSeriesTimeSpanHours(data: RawFundingRecord[] | null): number | null {
  if (!data?.length) return null;
  let minMs = Infinity;
  let maxMs = -Infinity;
  for (const row of data) {
    const t = row.transaction_unix_ms;
    if (typeof t !== 'number' || !Number.isFinite(t)) continue;
    if (t < minMs) minMs = t;
    if (t > maxMs) maxMs = t;
  }
  if (!Number.isFinite(minMs) || !Number.isFinite(maxMs) || maxMs <= minMs) return null;
  return (maxMs - minMs) / 3600000;
}

/** Top N markets visible on the chart by default; others are toggled from the sidebar. */
const DEFAULT_CHART_VISIBLE_COUNT = 5;

export default function DecibelFundingPage() {
  const [rawFunding, setRawFunding] = useState<RawFundingRecord[] | null>(null);
  const [markets, setMarkets] = useState<DecibelMarketRow[]>([]);
  const [fundingApr24hByMarket, setFundingApr24hByMarket] = useState<Record<string, { avg_yearly_apr_pct: number; direction: string } | null>>({});
  const [fundingApr7dByMarket, setFundingApr7dByMarket] = useState<Record<string, { avg_yearly_apr_pct: number; direction: string } | null>>({});
  const [selectedMarket, setSelectedMarket] = useState<DecibelOpenPositionMarket | null>(null);
  const [hoveredCardMarket, setHoveredCardMarket] = useState<string | null>(null);
  const [visibleChartMarkets, setVisibleChartMarkets] = useState<Set<string> | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/protocols/decibel/markets')
      .then((r) => r.json())
      .then((json) => {
        if (cancelled) return;
        if (json?.success && Array.isArray(json.data)) {
          const list = (json.data as DecibelMarketRow[]).filter(
            (m) => m.market_addr && (m.market_name || '').toUpperCase().includes('USD')
          );
          setMarkets(list);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  /** One upstream request per market so each series gets full `period=week` history (no combined row cap). */
  useEffect(() => {
    if (markets.length === 0) return;
    let cancelled = false;
    setRawFunding(null);
    const keys = markets
      .map((m) => marketNameForFundingApi(m.market_name || ''))
      .filter((k) => k.length > 0);
    Promise.all(
      keys.map((key) =>
        fetch(
          `/api/protocols/decibel/funding?market_name=${encodeURIComponent(key)}&window=7d&series_only=true`
        )
          .then((r) => r.json())
          .then((json) =>
            json?.success && Array.isArray(json.data) ? (json.data as RawFundingRecord[]) : []
          )
      )
    )
      .then((chunks) => {
        if (cancelled) return;
        const merged: RawFundingRecord[] = [];
        for (const rows of chunks) merged.push(...rows);
        setRawFunding(merged);
      })
      .catch(() => {
        if (!cancelled) setRawFunding([]);
      });
    return () => {
      cancelled = true;
    };
  }, [markets]);

  useEffect(() => {
    if (markets.length === 0) return;
    let cancelled = false;
    const keys = markets.map((m) => marketNameForFundingApi(m.market_name || ''));
    Promise.all(
      keys.map(async (k) => {
        const [apr24h, apr7d] = await Promise.all([
          fetchFundingApr(k, '24h'),
          fetchFundingApr(k, '7d'),
        ]);
        return { key: k, apr24h, apr7d };
      })
    )
      .then((results) => {
        if (cancelled) return;
        const map24h: Record<string, { avg_yearly_apr_pct: number; direction: string } | null> = {};
        const map7d: Record<string, { avg_yearly_apr_pct: number; direction: string } | null> = {};
        results.forEach(({ key, apr24h, apr7d }) => {
          map24h[key] = apr24h;
          map7d[key] = apr7d;
        });
        setFundingApr24hByMarket(map24h);
        setFundingApr7dByMarket(map7d);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [markets]);

  const oiNotionalByMarket = useMemo(() => (rawFunding ? latestOINotionalPerMarket(rawFunding) : {}), [rawFunding]);

  /** Wall-clock span of combined chart feed (multi-market responses may be row-capped). */
  const fundingChartSpanHours = useMemo(() => fundingSeriesTimeSpanHours(rawFunding), [rawFunding]);

  /** Markets sorted by Open Interest (notional USD) descending */
  const marketsSortedByOI = useMemo(() => {
    return [...markets].sort((a, b) => {
      const keyA = marketNameForFundingApi(a.market_name || '');
      const keyB = marketNameForFundingApi(b.market_name || '');
      const oiA = oiNotionalByMarket[keyA] ?? -Infinity;
      const oiB = oiNotionalByMarket[keyB] ?? -Infinity;
      return oiB - oiA;
    });
  }, [markets, oiNotionalByMarket]);

  const chartSeriesOrderPreference = useMemo(
    () => marketsSortedByOI.map((m) => marketNameForFundingApi(m.market_name || '')),
    [marketsSortedByOI]
  );

  /** All markets that have funding series data (chart lines are created for each). */
  const allChartMarketNames = useMemo(
    () => getChartMarketOrder(rawFunding ?? null, undefined, chartSeriesOrderPreference),
    [rawFunding, chartSeriesOrderPreference]
  );

  const defaultVisibleMarketKeys = useMemo(
    () => allChartMarketNames.slice(0, DEFAULT_CHART_VISIBLE_COUNT),
    [allChartMarketNames]
  );

  const effectiveVisibleChartMarkets = useMemo(() => {
    if (visibleChartMarkets !== null) return visibleChartMarkets;
    return new Set(defaultVisibleMarketKeys);
  }, [visibleChartMarkets, defaultVisibleMarketKeys]);

  useEffect(() => {
    if (defaultVisibleMarketKeys.length > 0 && visibleChartMarkets === null) {
      setVisibleChartMarkets(new Set(defaultVisibleMarketKeys));
    }
  }, [defaultVisibleMarketKeys, visibleChartMarkets]);

  /** Same list as dropdown options for modal (with logo URLs) */
  const marketsForModal = useMemo((): DecibelOpenPositionMarket[] => {
    return marketsSortedByOI.map((m) => {
      const name = m.market_name || '';
      return {
        marketAddr: m.market_addr,
        marketName: name,
        marketLogoUrl: getLogoUrl(name),
      };
    });
  }, [marketsSortedByOI]);

  return (
    <div className="h-screen min-h-0 flex flex-col md:flex-row bg-background overflow-x-hidden overflow-y-auto md:overflow-hidden" style={{ WebkitOverflowScrolling: 'touch' }}>
      {/* Left: Logo, Wallet, Decibel CTA, then explanation */}
      <aside className="w-full md:w-72 shrink-0 border-b md:border-b-0 md:border-r border-border p-4 flex flex-col gap-4 md:max-h-screen md:overflow-y-auto min-h-0">
        <Link href="/" className="flex items-center gap-2 shrink-0">
          <Logo size="sm" className="shrink-0" />
          <span className="font-semibold text-sm">Yield AI</span>
        </Link>
        <div className="shrink-0">
          <WalletSelector />
        </div>
        <div className="shrink-0">
          <DecibelCTABlock />
        </div>
        <div className="mt-2 pt-3 border-t border-border text-xs text-muted-foreground space-y-2">
          <p className="font-medium text-foreground">About the chart</p>
          <p>
            The chart shows the funding rate in basis points (bps) over time for each market. Positive values mean longs pay shorts; negative means shorts pay longs. Rates are smoothed (rolling average) from raw snapshots.
          </p>
          <p className="font-medium text-foreground mt-2">Open Interest</p>
          <p>
            Open Interest (OI) is the total notional value of open positions in a market. Higher OI usually means more liquidity and more stable funding.
          </p>
        </div>
      </aside>

      {/* Center: Chart — on mobile use natural height so page can scroll; on desktop fill remaining */}
      <main className="flex-none min-h-[50vh] md:flex-1 md:min-h-0 min-w-0 p-4 flex flex-col overflow-hidden">
        <h1 className="text-xl font-bold mb-1 shrink-0">Decibel funding</h1>
        <p className="text-sm text-muted-foreground mb-2 shrink-0">
          Funding rate (bps) over time by market. Positive = longs pay shorts.
            {fundingChartSpanHours != null && fundingChartSpanHours < 120 && (
              <span className="block mt-1.5 text-xs text-amber-700 dark:text-amber-400/90">
                Chart time range is ~{formatNumber(fundingChartSpanHours, 1)}h — less than a full week; check upstream
                series or <code className="font-mono text-[0.85em]">DECIBEL_FUNDING_SERIES_URL</code>.
              </span>
            )}
        </p>
        <div className="flex-1 min-h-[55vh] md:min-h-0 flex flex-col">
          <DecibelFundingChart
            rawData={rawFunding}
            explicitMarketOrder={allChartMarketNames}
            className="w-full flex-1 min-h-0"
            hoveredMarket={hoveredCardMarket}
            visibleMarkets={effectiveVisibleChartMarkets}
            onLegendHover={setHoveredCardMarket}
            onLegendClick={(market) => {
              setVisibleChartMarkets((prev) => {
                const base = prev ?? new Set(defaultVisibleMarketKeys);
                const next = new Set(base);
                if (next.has(market)) next.delete(market);
                else next.add(market);
                return next;
              });
            }}
          />
        </div>
      </main>

      {/* Right: Markets list (sorted by Open Interest desc) */}
      <aside className="w-full md:w-80 shrink-0 border-t md:border-t-0 md:border-l border-border p-4 overflow-y-auto md:max-h-screen min-h-0">
        <h2 className="text-sm font-semibold mb-3">Markets</h2>
        <p className="text-xs text-muted-foreground mb-3">
          Top {DEFAULT_CHART_VISIBLE_COUNT} by open interest are on the chart by default. Use the checkbox to add or remove series; &quot;Only this&quot; isolates one market.
        </p>
        <ul className="space-y-2">
          {marketsSortedByOI.map((m) => {
            const name = m.market_name || '';
            const key = marketNameForFundingApi(name);
            const apr24h = fundingApr24hByMarket[key];
            const hasChartData = allChartMarketNames.includes(key);
            const apr7d = fundingApr7dByMarket[key];
            const oiNotional = oiNotionalByMarket[key];
            const logoUrl = getLogoUrl(name);
            const isVisibleOnChart = effectiveVisibleChartMarkets.has(key);
            return (
              <li
                key={m.market_addr}
                className={cn(
                  'flex items-start justify-between gap-3 p-2 rounded-lg border border-border bg-card transition-all',
                  hasChartData && 'hover:bg-muted/50',
                  hoveredCardMarket === key && 'ring-1 ring-primary',
                  hasChartData && !isVisibleOnChart && 'opacity-60'
                )}
                onMouseEnter={() => hasChartData && setHoveredCardMarket(key)}
                onMouseLeave={() => setHoveredCardMarket(null)}
              >
                <div className="flex flex-col gap-1.5 min-w-0 flex-1">
                  <div className="flex gap-2 min-w-0 items-start">
                    {logoUrl && (
                      <Image
                        src={logoUrl}
                        alt=""
                        width={20}
                        height={20}
                        className="shrink-0 rounded-full mt-0.5"
                        unoptimized
                      />
                    )}
                    <span className="text-sm font-medium break-words leading-snug min-w-0">
                      {name || m.market_addr.slice(0, 8)}
                    </span>
                  </div>
                  {hasChartData ? (
                    <label className="flex items-center gap-2 cursor-pointer self-start w-full min-w-0">
                      <Checkbox
                        title="Show on chart"
                        checked={isVisibleOnChart}
                        className="shrink-0"
                        onClick={(e) => e.stopPropagation()}
                        onCheckedChange={(checked) => {
                          setVisibleChartMarkets((prev) => {
                            const base = prev ?? new Set(defaultVisibleMarketKeys);
                            const next = new Set(base);
                            if (checked === true) next.add(key);
                            else next.delete(key);
                            return next;
                          });
                        }}
                      />
                      <span className="text-xs text-muted-foreground select-none">Chart</span>
                    </label>
                  ) : (
                    <span className="text-[10px] text-muted-foreground self-start">No chart data</span>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={!hasChartData}
                    title="Show only this market on the chart"
                    className="h-6 self-start px-2 -ml-2 text-[10px] font-normal text-muted-foreground hover:text-foreground"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!hasChartData) return;
                      setVisibleChartMarkets(new Set([key]));
                    }}
                  >
                    Only this
                  </Button>
                </div>
                <div className="flex flex-col items-end gap-0.5 shrink-0 text-right">
                  <span className="text-xs text-muted-foreground">
                    APR 24h:{' '}
                    {apr24h != null && Number.isFinite(apr24h.avg_yearly_apr_pct) ? (
                      <span
                        className={cn(
                          'font-medium',
                          apr24h.avg_yearly_apr_pct > 0 ? 'text-green-600 dark:text-green-400' : apr24h.avg_yearly_apr_pct < 0 ? 'text-red-600 dark:text-red-400' : ''
                        )}
                      >
                        {apr24h.avg_yearly_apr_pct > 0 ? '+' : ''}
                        {formatNumber(apr24h.avg_yearly_apr_pct, 2)}%
                      </span>
                    ) : (
                      '—'
                    )}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    APR 7d:{' '}
                    {apr7d != null && Number.isFinite(apr7d.avg_yearly_apr_pct) ? (
                      <span
                        className={cn(
                          'font-medium',
                          apr7d.avg_yearly_apr_pct > 0 ? 'text-green-600 dark:text-green-400' : apr7d.avg_yearly_apr_pct < 0 ? 'text-red-600 dark:text-red-400' : ''
                        )}
                      >
                        {apr7d.avg_yearly_apr_pct > 0 ? '+' : ''}
                        {formatNumber(apr7d.avg_yearly_apr_pct, 2)}%
                      </span>
                    ) : (
                      '—'
                    )}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    Open Interest: {typeof oiNotional === 'number' && Number.isFinite(oiNotional) ? formatCurrency(oiNotional, 0) : '—'}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-1 h-7 text-xs w-full max-w-[9.5rem]"
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedMarket({
                        marketAddr: m.market_addr,
                        marketName: name,
                        marketLogoUrl: logoUrl,
                      });
                    }}
                  >
                    Open position
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
        {marketsSortedByOI.length === 0 && (
          <p className="text-sm text-muted-foreground">Loading markets…</p>
        )}
      </aside>

      <DecibelOpenPositionModal
        open={!!selectedMarket}
        onOpenChange={(open) => !open && setSelectedMarket(null)}
        market={selectedMarket}
        markets={marketsForModal}
        onMarketChange={setSelectedMarket}
      />
    </div>
  );
}
