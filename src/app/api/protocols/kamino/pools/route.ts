import { NextResponse } from "next/server";
import { InvestmentData } from "@/types/investments";
import { JupiterTokenMetadataService } from "@/lib/services/solana/tokenMetadata";
import { NATIVE_MINT } from "@solana/spl-token";

const KAMINO_API_BASE_URL = "https://api.kamino.finance";
const RETRY_ATTEMPTS = 5;
const RETRY_DELAY_MS = 2000;

type KaminoMarket = {
  lendingMarket: string;
  isPrimary?: boolean;
};

type KaminoReserveMetrics = {
  reserve: string;
  liquidityToken: string;
  liquidityTokenMint: string;
  maxLtv: string;
  borrowApy: string;
  supplyApy: string;
  totalSupply: string;
  totalBorrow: string;
  totalBorrowUsd: string;
  totalSupplyUsd: string;
};

function toNumber(value: unknown, fallback = 0): number {
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function toApyPct(apyFraction: unknown): number {
  // API returns APY as a fraction, e.g. 0.038... for 3.8%
  const apy = toNumber(apyFraction, 0);
  return apy * 100;
}

function normalizeLiquiditySymbol(symbol: string, mint: string): string {
  const nativeMint = NATIVE_MINT.toBase58();
  if (mint === nativeMint) return "SOL";
  return symbol;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, init);
      if (response.ok) return response;

      const shouldRetry =
        response.status === 502 || response.status === 503 || response.status === 504;

      if (!shouldRetry || attempt === RETRY_ATTEMPTS) {
        return response;
      }
    } catch (error) {
      lastError = error;
      if (attempt === RETRY_ATTEMPTS) break;
    }

    await sleep(RETRY_DELAY_MS);
  }

  throw lastError instanceof Error ? lastError : new Error("Kamino request failed after retries");
}

export async function GET() {
  try {
    const marketsRes = await fetchWithRetry(`${KAMINO_API_BASE_URL}/v2/kamino-market`, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
    });

    if (!marketsRes.ok) {
      console.warn("[Kamino][Pools] markets API unavailable, returning empty data", {
        status: marketsRes.status,
        statusText: marketsRes.statusText,
      });
      return NextResponse.json({
        success: true,
        data: [],
        count: 0,
      });
    }

    const markets = (await marketsRes.json()) as KaminoMarket[];
    const primaryMarkets = (Array.isArray(markets) ? markets : []).filter((m) => m.isPrimary);
    const marketsToQuery = primaryMarkets.length > 0 ? primaryMarkets : (markets || []).slice(0, 1);

    const allReserveMetrics: KaminoReserveMetrics[] = [];

    // Keep this intentionally sequential to reduce the chance of rate-limits on unauthenticated requests.
    for (const market of marketsToQuery) {
      if (!market?.lendingMarket) continue;

      const metricsRes = await fetchWithRetry(
        `${KAMINO_API_BASE_URL}/kamino-market/${market.lendingMarket}/reserves/metrics?env=mainnet-beta`,
        {
          method: "GET",
          headers: { Accept: "application/json" },
          cache: "no-store",
        }
      );

      if (!metricsRes.ok) {
        console.warn("[Kamino][Pools] reserves metrics API unavailable, returning empty data", {
          market: market.lendingMarket,
          status: metricsRes.status,
          statusText: metricsRes.statusText,
        });
        return NextResponse.json({
          success: true,
          data: [],
          count: 0,
        });
      }

      const metrics = (await metricsRes.json()) as KaminoReserveMetrics[];
      if (Array.isArray(metrics)) allReserveMetrics.push(...metrics);
    }

    // Filter out empty pools.
    const filtered = allReserveMetrics.filter((m) => toNumber(m.totalSupplyUsd, 0) > 0);

    const tokenMints = Array.from(
      new Set(filtered.map((m) => m.liquidityTokenMint).filter(Boolean))
    );

    // Best-effort metadata enrichment (symbol/decimals/logo). If it fails, we still return pools.
    let metadataMap: Record<string, { symbol?: string; decimals?: number; logoUrl?: string }> = {};
    try {
      const metadataService = JupiterTokenMetadataService.getInstance();
      const raw = await metadataService.getMetadataMap(tokenMints);
      metadataMap = raw as any;
    } catch (e) {
      console.warn("[Kamino] token metadata resolve failed, continuing without it", e);
    }

    const data: InvestmentData[] = filtered.map((m) => {
      const tokenMint = m.liquidityTokenMint;
      const meta = tokenMint ? metadataMap[tokenMint] : undefined;

      const asset = normalizeLiquiditySymbol(meta?.symbol || m.liquidityToken, tokenMint);
      const depositApy = toApyPct(m.supplyApy);
      const borrowApy = toApyPct(m.borrowApy);
      const tvlUSD = toNumber(m.totalSupplyUsd, 0);

      return {
        asset,
        provider: "Kamino",
        totalAPY: depositApy,
        depositApy,
        borrowAPY: borrowApy,
        token: tokenMint,
        tokenDecimals: typeof meta?.decimals === "number" ? meta.decimals : undefined,
        protocol: "Kamino",
        logoUrl: meta?.logoUrl,
        tvlUSD,
        dailyVolumeUSD: 0,
        poolType: "Lending",
      };
    });

    data.sort((a, b) => (b.totalAPY || 0) - (a.totalAPY || 0));

    return NextResponse.json(
      {
        success: true,
        data,
        count: data.length,
      },
      {
        headers: {
          "Cache-Control": "public, max-age=120, s-maxage=120, stale-while-revalidate=300",
          "Cdn-Cache-Control": "max-age=120",
          "Surrogate-Control": "max-age=120",
        },
      }
    );
  } catch (error) {
    console.warn("[Kamino][Pools] fallback to empty data after retries", error);
    return NextResponse.json({
      success: true,
      data: [],
      count: 0,
    });
  }
}

