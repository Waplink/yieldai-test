import { NextRequest, NextResponse } from "next/server";

const JUPITER_USER_POSITIONS_URL = "https://lite-api.jup.ag/lend/v1/earn/positions";

function isLikelySolanaAddress(input: string): boolean {
  // Base58 without 0,O,I,l characters. Typical Solana pubkey length is 32-44.
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(input);
}

/**
 * Jupiter may return shares / underlyingAssets as uint strings, decimals, or numbers.
 * Using only BigInt() incorrectly drops positions when values are decimal strings.
 */
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

/**
 * GET /api/protocols/jupiter/userPositions?address=<solana_wallet>
 * Returns Jupiter Lend user positions for a Solana wallet.
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

    const response = await fetch(
      `${JUPITER_USER_POSITIONS_URL}?users=${encodeURIComponent(address)}`,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          "User-Agent": "Mozilla/5.0 (compatible; YieldAI/1.0)",
        },
        cache: "no-store",
      }
    );

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Jupiter API returned ${response.status}${text ? `: ${text}` : ""}`);
    }

    const payload = await response.json().catch(() => []);
    const allPositions = extractPositionsPayload(payload);
    const positions = allPositions.filter((p) => {
      // Jupiter may return scaffold rows with all-zero balances for non-participating wallets.
      return isMeaningfulJupiterPosition(p);
    });

    return NextResponse.json({
      success: true,
      data: positions,
      count: positions.length,
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
