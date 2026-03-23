import { NextRequest, NextResponse } from "next/server";

const KAMINO_API_BASE_URL = "https://api.kamino.finance";
const RETRY_ATTEMPTS = 5;
const RETRY_DELAY_MS = 2000;

type KaminoMarketRow = {
  lendingMarket: string;
  name?: string;
  isPrimary?: boolean;
};

function isLikelySolanaAddress(input: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(input);
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

function hasEarnVaultBalance(item: unknown): boolean {
  if (!item || typeof item !== "object") return false;
  const o = item as Record<string, unknown>;
  const total = Number.parseFloat(String(o.totalShares ?? "0"));
  const staked = Number.parseFloat(String(o.stakedShares ?? "0"));
  const unstaked = Number.parseFloat(String(o.unstakedShares ?? "0"));
  return (
    (Number.isFinite(total) && total > 0) ||
    (Number.isFinite(staked) && staked > 0) ||
    (Number.isFinite(unstaked) && unstaked > 0)
  );
}

export type KaminoUserPositionRow =
  | {
      source: "kamino-lend";
      marketPubkey: string;
      marketName?: string;
      obligation: unknown;
    }
  | {
      source: "kamino-earn";
      position: unknown;
    };

/**
 * GET /api/protocols/kamino/userPositions?address=<solana_wallet>
 *
 * Aggregates:
 * - Kamino Lend: GET /kamino-market/{market}/users/{wallet}/obligations (all markets from v2/kamino-market)
 * - Kamino Earn: GET /kvaults/users/{wallet}/positions
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const address = (searchParams.get("address") || "").trim();

    if (!address) {
      return NextResponse.json(
        { success: false, error: "Address parameter is required", data: [], count: 0 },
        { status: 400 }
      );
    }

    if (!isLikelySolanaAddress(address)) {
      return NextResponse.json(
        { success: false, error: "Invalid Solana wallet address", data: [], count: 0 },
        { status: 400 }
      );
    }

    const marketsRes = await fetchWithRetry(`${KAMINO_API_BASE_URL}/v2/kamino-market`, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
    });

    if (!marketsRes.ok) {
      const text = await marketsRes.text().catch(() => "");
      throw new Error(`Kamino markets API returned ${marketsRes.status}${text ? `: ${text}` : ""}`);
    }

    const markets = (await marketsRes.json()) as KaminoMarketRow[];
    const marketList = Array.isArray(markets) ? markets : [];

    const obligationResults = await Promise.all(
      marketList.map(async (m) => {
        if (!m?.lendingMarket) {
          return { market: m, obligations: [] as unknown[] };
        }
        const url = `${KAMINO_API_BASE_URL}/kamino-market/${m.lendingMarket}/users/${address}/obligations?env=mainnet-beta`;
        try {
          const res = await fetchWithRetry(url, {
            method: "GET",
            headers: { Accept: "application/json" },
            cache: "no-store",
          });
          if (!res.ok) {
            return { market: m, obligations: [] as unknown[] };
          }
          const payload = await res.json().catch(() => []);
          return {
            market: m,
            obligations: Array.isArray(payload) ? payload : [],
          };
        } catch {
          return { market: m, obligations: [] as unknown[] };
        }
      })
    );

    const flat: KaminoUserPositionRow[] = [];

    for (const { market, obligations } of obligationResults) {
      if (!obligations.length) continue;
      for (const obligation of obligations) {
        flat.push({
          source: "kamino-lend",
          marketPubkey: market.lendingMarket,
          marketName: market.name,
          obligation,
        });
      }
    }

    let earnRaw: unknown[] = [];
    try {
      const kvRes = await fetchWithRetry(
        `${KAMINO_API_BASE_URL}/kvaults/users/${address}/positions`,
        {
          method: "GET",
          headers: { Accept: "application/json" },
          cache: "no-store",
        }
      );
      if (kvRes.ok) {
        const kvJson = await kvRes.json().catch(() => []);
        earnRaw = Array.isArray(kvJson) ? kvJson : [];
      }
    } catch {
      earnRaw = [];
    }

    for (const pos of earnRaw) {
      if (!hasEarnVaultBalance(pos)) continue;
      flat.push({ source: "kamino-earn", position: pos });
    }

    return NextResponse.json({
      success: true,
      data: flat,
      count: flat.length,
      meta: {
        marketsQueried: marketList.length,
        lendPositions: flat.filter((r) => r.source === "kamino-lend").length,
        earnPositions: flat.filter((r) => r.source === "kamino-earn").length,
      },
    });
  } catch (error) {
    console.error("[Kamino] userPositions error:", error);
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
