import { NextResponse } from "next/server";
import { InvestmentData } from "@/types/investments";
import { getPreferredJupiterTokenIcon } from "@/lib/services/solana/jupiterTokenIcons";

const JUPITER_LEND_TOKENS_URL = "https://lite-api.jup.ag/lend/v1/earn/tokens";

type JupiterPool = {
  address: string;
  totalRate: string;
  totalAssets: string;
  asset: {
    address: string;
    symbol: string;
    decimals: number;
    price: string;
    logoUrl?: string;
  };
};

function toNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function mapPoolToInvestment(pool: JupiterPool): InvestmentData {
  const price = toNumber(pool.asset?.price, 0);
  const decimals = toNumber(pool.asset?.decimals, 0);
  const totalAssetsRaw = toNumber(pool.totalAssets, 0);
  const totalAssets = decimals > 0 ? totalAssetsRaw / Math.pow(10, decimals) : 0;

  // Jupiter totalRate is in bps.
  const totalApyPct = toNumber(pool.totalRate, 0) / 100;
  const displaySymbol = (pool.asset?.symbol || "UNKNOWN").toUpperCase() === "WSOL"
    ? "SOL"
    : (pool.asset?.symbol || "UNKNOWN");

  return {
    asset: displaySymbol,
    provider: "Jupiter",
    totalAPY: totalApyPct,
    depositApy: totalApyPct,
    borrowAPY: 0,
    token: pool.asset?.address || pool.address,
    tokenDecimals: decimals,
    protocol: "Jupiter",
    logoUrl: getPreferredJupiterTokenIcon(pool.asset?.symbol, pool.asset?.logoUrl),
    tvlUSD: totalAssets * price,
  };
}

/**
 * GET /api/protocols/jupiter/pools
 * Solana Jupiter Lend pools for Ideas-like aggregations.
 */
export async function GET() {
  try {
    const response = await fetch(JUPITER_LEND_TOKENS_URL, {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(`Jupiter API returned ${response.status}`);
    }

    const pools = (await response.json()) as JupiterPool[];
    const data = Array.isArray(pools) ? pools.map(mapPoolToInvestment) : [];

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
    console.error("[Jupiter] pools error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
        data: [],
        count: 0,
      },
      { status: 500 }
    );
  }
}
