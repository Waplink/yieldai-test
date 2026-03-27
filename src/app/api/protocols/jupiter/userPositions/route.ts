import { NextRequest, NextResponse } from "next/server";
import {
  appendSyntheticJupiterEarnPositionsFromWallet,
  computeJupiterMintDiagnostics,
  enrichJupiterEarnPositionsWithWalletShares,
  fetchWalletSplBalancesByMint,
  mergeEarnTokenCatalogArrays,
  mergeEarnTokenCatalogIntoPositionRows,
} from "@/lib/services/solana/jupiterEarnPositionsEnrichment";

/** Official Lend API (requires x-api-key — see https://dev.jup.ag/api-reference/lend/earn/positions) */
const JUPITER_OFFICIAL_POSITIONS_URL = "https://api.jup.ag/lend/v1/earn/positions";
const JUPITER_LITE_POSITIONS_URL = "https://lite-api.jup.ag/lend/v1/earn/positions";
const JUPITER_EARN_TOKENS_LITE_URL = "https://lite-api.jup.ag/lend/v1/earn/tokens";
const JUPITER_EARN_TOKENS_OFFICIAL_URL = "https://api.jup.ag/lend/v1/earn/tokens";

function getJupiterApiKey(): string | undefined {
  return (
    process.env.JUP_API_KEY ||
    process.env.NEXT_PUBLIC_JUP_API_KEY ||
    process.env.JUPITER_API_KEY ||
    undefined
  )?.trim() || undefined;
}

/** Which env var provided the key (for debugging; never expose the value). */
function getJupiterApiKeySource(): string | null {
  if (process.env.JUP_API_KEY?.trim()) return "JUP_API_KEY";
  if (process.env.NEXT_PUBLIC_JUP_API_KEY?.trim()) return "NEXT_PUBLIC_JUP_API_KEY";
  if (process.env.JUPITER_API_KEY?.trim()) return "JUPITER_API_KEY";
  return null;
}

function isLikelySolanaAddress(input: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(input);
}

function isPositiveAmount(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "bigint") return value > BigInt(0);
  if (typeof value === "number") return Number.isFinite(value) && value > 0;

  const s = String(value).trim();
  if (!s) return false;

  if (/^\d+$/.test(s)) {
    try {
      return BigInt(s) > BigInt(0);
    } catch {
      return false;
    }
  }

  const n = Number(s);
  return Number.isFinite(n) && n > 0;
}

function extractPositionsPayload(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") {
    const o = payload as Record<string, unknown>;
    if (Array.isArray(o.data)) return o.data;
    if (Array.isArray(o.positions)) return o.positions;
    if (Array.isArray(o.items)) return o.items;
    if (Array.isArray(o.result)) return o.result;
  }
  return [];
}

function isMeaningfulJupiterPosition(p: unknown): boolean {
  const obj = (p ?? {}) as Record<string, unknown>;
  return isPositiveAmount(obj.shares) || isPositiveAmount(obj.underlyingAssets);
}

function countMeaningful(rows: unknown[]): number {
  return rows.filter(isMeaningfulJupiterPosition).length;
}

function buildJupiterMeta(
  allPositions: unknown[],
  filtered: unknown[],
  sources: {
    official?: {
      ok: boolean;
      status: number;
      rows: number;
      meaningful: number;
      errorHint?: string;
    };
    lite?: { ok: boolean; status: number; rows: number; meaningful: number; errorHint?: string };
    chosenSource?: string;
    apiKeySource?: string | null;
  },
  enrichment?: Record<string, unknown>
): Record<string, unknown> {
  let maxUnderlyingBalanceRaw = "0";
  let maxUb = BigInt(0);
  for (const p of allPositions) {
    const obj = (p ?? {}) as Record<string, unknown>;
    const ub = String(obj.underlyingBalance ?? "").trim();
    if (/^\d+$/.test(ub)) {
      try {
        const v = BigInt(ub);
        if (v > maxUb) {
          maxUb = v;
          maxUnderlyingBalanceRaw = ub;
        }
      } catch {
        // ignore
      }
    }
  }

  return {
    upstreamRowCount: allPositions.length,
    activeLendPositions: filtered.length,
    filteredOutScaffoldRows: Math.max(0, allPositions.length - filtered.length),
    sources,
    apiKeySource: sources.apiKeySource,
    hasJupiterApiKey: !!getJupiterApiKey(),
    enrichment,
    note:
      "When Lend API returns shares=0 but jl* SPL exist in wallet, we backfill from RPC (totalAssets/totalSupply). If API shares>0 we do not add wallet jl (avoids doubled amounts). Missing API rows are filled from /earn/tokens + wallet jl balances. Use SOLANA_RPC_API_KEY for Helius.",
    maxUnderlyingBalanceRaw,
  };
}

async function fetchPositionsFromUrl(
  url: string,
  headers: Record<string, string>
): Promise<{ ok: boolean; status: number; rows: unknown[]; errorHint?: string }> {
  try {
    const response = await fetch(url, {
      method: "GET",
      headers,
      cache: "no-store",
    });
    const status = response.status;
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const errorHint =
        text.length > 0 && text.length < 400
          ? text
          : `http_${status}`;
      return { ok: false, status, rows: [], errorHint };
    }
    const payload = await response.json().catch(() => []);
    return { ok: true, status, rows: extractPositionsPayload(payload) };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      rows: [],
      errorHint: e instanceof Error ? e.message : "network_error",
    };
  }
}

/**
 * GET /api/protocols/jupiter/userPositions?address=<solana_wallet>
 * Uses official Jupiter Lend API when a key is set; also sends the same key to lite-api (often improves data).
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const address = (searchParams.get("address") || "").trim();
    const debug = (searchParams.get("debug") || "").trim() === "1";

    if (!address) {
      return NextResponse.json(
        { success: false, error: "Address parameter is required" },
        { status: 400 }
      );
    }

    if (!isLikelySolanaAddress(address)) {
      return NextResponse.json(
        { success: false, error: "Invalid Solana wallet address" },
        { status: 400 }
      );
    }

    const baseHeaders: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (compatible; YieldAI/1.0)",
    };

    const query = `?users=${encodeURIComponent(address)}`;
    const apiKey = getJupiterApiKey();
    const apiKeySource = getJupiterApiKeySource();

    const headersWithKey = apiKey ? { ...baseHeaders, "x-api-key": apiKey } : baseHeaders;

    const [official, lite, earnLitePayload, earnOfficialPayload] = await Promise.all([
      fetchPositionsFromUrl(JUPITER_OFFICIAL_POSITIONS_URL + query, headersWithKey),
      fetchPositionsFromUrl(JUPITER_LITE_POSITIONS_URL + query, headersWithKey),
      fetch(JUPITER_EARN_TOKENS_LITE_URL, {
        method: "GET",
        headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 (compatible; YieldAI/1.0)" },
        cache: "no-store",
      })
        .then(async (r) => (r.ok ? r.json().catch(() => []) : []))
        .catch(() => []),
      fetch(JUPITER_EARN_TOKENS_OFFICIAL_URL, {
        method: "GET",
        headers: headersWithKey,
        cache: "no-store",
      })
        .then(async (r) => (r.ok ? r.json().catch(() => []) : []))
        .catch(() => []),
    ]);

    const earnLite = Array.isArray(earnLitePayload) ? earnLitePayload : [];
    const earnOfficial = Array.isArray(earnOfficialPayload) ? earnOfficialPayload : [];
    /** Official + lite catalogs can differ; dedupe by jl mint address. */
    const earnTokens = mergeEarnTokenCatalogArrays([earnOfficial, earnLite]);

    const officialMeaningful = countMeaningful(official.rows);
    const liteMeaningful = countMeaningful(lite.rows);

    let allPositions: unknown[] = [];
    let chosen: "official" | "lite" | "none" = "none";

    if (official.ok && officialMeaningful > liteMeaningful) {
      allPositions = official.rows;
      chosen = "official";
    } else if (lite.ok && liteMeaningful > officialMeaningful) {
      allPositions = lite.rows;
      chosen = "lite";
    } else if (official.ok && official.rows.length > 0) {
      allPositions = official.rows;
      chosen = "official";
    } else if (lite.ok && lite.rows.length > 0) {
      allPositions = lite.rows;
      chosen = "lite";
    } else {
      allPositions = official.rows.length ? official.rows : lite.rows;
      chosen = official.rows.length ? "official" : "lite";
    }

    let enrichmentMeta: Record<string, unknown> = { applied: false as const };
    let mergedPositions = allPositions;
    try {
      const positionsWithCatalog = mergeEarnTokenCatalogIntoPositionRows(allPositions, earnTokens);
      const mintToBalance = await fetchWalletSplBalancesByMint(address);
      const diagnostics = computeJupiterMintDiagnostics(positionsWithCatalog, mintToBalance, earnTokens);
      const { enriched, rowsTouched } = enrichJupiterEarnPositionsWithWalletShares(
        positionsWithCatalog,
        mintToBalance
      );
      const { merged, rowsAppended } = appendSyntheticJupiterEarnPositionsFromWallet(
        enriched,
        mintToBalance,
        earnTokens,
        address
      );
      mergedPositions = merged;
      enrichmentMeta = {
        applied: true,
        rowsMergedWithWalletJl: rowsTouched,
        syntheticRowsFromEarnTokens: rowsAppended,
        splMintAccountsInWallet: mintToBalance.size,
        earnTokensCatalogLiteCount: earnLite.length,
        earnTokensCatalogOfficialCount: earnOfficial.length,
        ...diagnostics,
      };
    } catch (e) {
      enrichmentMeta = {
        applied: false,
        error: e instanceof Error ? e.message : "enrichment_failed",
      };
    }

    const positions = mergedPositions.filter(isMeaningfulJupiterPosition);

    const basePayload = {
      success: true,
      data: positions,
      count: positions.length,
    };

    if (!debug) {
      return NextResponse.json(basePayload);
    }

    return NextResponse.json({
      ...basePayload,
      meta: buildJupiterMeta(
        mergedPositions,
        positions,
        {
          official: {
            ok: official.ok,
            status: official.status,
            rows: official.rows.length,
            meaningful: officialMeaningful,
            errorHint: official.errorHint,
          },
          lite: {
            ok: lite.ok,
            status: lite.status,
            rows: lite.rows.length,
            meaningful: liteMeaningful,
            errorHint: lite.errorHint,
          },
          chosenSource: chosen,
          apiKeySource,
        },
        enrichmentMeta
      ),
    });
  } catch (error) {
    console.error("[Jupiter] userPositions error:", error);
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
