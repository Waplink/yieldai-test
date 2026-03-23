import { NextRequest, NextResponse } from "next/server";

/** Official Lend API (requires x-api-key — see https://dev.jup.ag/api-reference/lend/earn/positions) */
const JUPITER_OFFICIAL_POSITIONS_URL = "https://api.jup.ag/lend/v1/earn/positions";
const JUPITER_LITE_POSITIONS_URL = "https://lite-api.jup.ag/lend/v1/earn/positions";

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
  }
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
    note:
      "Server needs JUP_API_KEY (or NEXT_PUBLIC_JUP_API_KEY) at runtime; redeploy after adding env. Prefer api.jup.ag for Lend. If official status is 401/403, create/enable a Lend-capable key at https://portal.jup.ag . lite-api may return scaffold zeros without matching the app UI.",
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

    const [official, lite] = await Promise.all([
      fetchPositionsFromUrl(JUPITER_OFFICIAL_POSITIONS_URL + query, headersWithKey),
      fetchPositionsFromUrl(JUPITER_LITE_POSITIONS_URL + query, headersWithKey),
    ]);

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

    const positions = allPositions.filter(isMeaningfulJupiterPosition);

    return NextResponse.json({
      success: true,
      data: positions,
      count: positions.length,
      meta: buildJupiterMeta(allPositions, positions, {
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
      }),
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
