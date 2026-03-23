import { NextRequest, NextResponse } from "next/server";

/** Official Lend API (requires x-api-key — same portal as other Jupiter APIs). */
const JUPITER_OFFICIAL_POSITIONS_URL = "https://api.jup.ag/lend/v1/earn/positions";
/** Legacy host; may return scaffold rows with zero balances compared to official API. */
const JUPITER_LITE_POSITIONS_URL = "https://lite-api.jup.ag/lend/v1/earn/positions";

function getJupiterApiKey(): string | undefined {
  return (
    process.env.JUP_API_KEY ||
    process.env.NEXT_PUBLIC_JUP_API_KEY ||
    process.env.JUPITER_API_KEY ||
    undefined
  )?.trim() || undefined;
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
    official?: { ok: boolean; rows: number; meaningful: number };
    lite?: { ok: boolean; rows: number; meaningful: number };
    chosenSource?: string;
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
    hasJupiterApiKey: !!getJupiterApiKey(),
    note:
      "Prefer api.jup.ag with JUP_API_KEY for accurate lend balances. lite-api can disagree with the Jupiter UI. Rows kept only if shares or underlyingAssets are non-zero.",
    maxUnderlyingBalanceRaw,
  };
}

async function fetchPositionsFromUrl(
  url: string,
  headers: Record<string, string>
): Promise<{ ok: boolean; rows: unknown[] }> {
  try {
    const response = await fetch(url, {
      method: "GET",
      headers,
      cache: "no-store",
    });
    if (!response.ok) {
      return { ok: false, rows: [] };
    }
    const payload = await response.json().catch(() => []);
    return { ok: true, rows: extractPositionsPayload(payload) };
  } catch {
    return { ok: false, rows: [] };
  }
}

/**
 * GET /api/protocols/jupiter/userPositions?address=<solana_wallet>
 * Uses official Jupiter Lend API when JUP_API_KEY is set, otherwise lite-api.
 * Picks the response with more non-zero positions when both are available.
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

    const officialHeaders = apiKey
      ? { ...baseHeaders, "x-api-key": apiKey }
      : baseHeaders;

    const [official, lite] = await Promise.all([
      apiKey
        ? fetchPositionsFromUrl(JUPITER_OFFICIAL_POSITIONS_URL + query, officialHeaders)
        : Promise.resolve({ ok: false, rows: [] as unknown[] }),
      fetchPositionsFromUrl(JUPITER_LITE_POSITIONS_URL + query, baseHeaders),
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
          rows: official.rows.length,
          meaningful: officialMeaningful,
        },
        lite: {
          ok: lite.ok,
          rows: lite.rows.length,
          meaningful: liteMeaningful,
        },
        chosenSource: chosen,
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
