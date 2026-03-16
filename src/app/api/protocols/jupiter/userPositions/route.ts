import { NextRequest, NextResponse } from "next/server";

const JUPITER_USER_POSITIONS_URL = "https://lite-api.jup.ag/lend/v1/earn/positions";

function isLikelySolanaAddress(input: string): boolean {
  // Base58 without 0,O,I,l characters. Typical Solana pubkey length is 32-44.
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(input);
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
        headers: { Accept: "application/json" },
        cache: "no-store",
      }
    );

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Jupiter API returned ${response.status}${text ? `: ${text}` : ""}`);
    }

    const payload = await response.json().catch(() => []);
    const positions = Array.isArray(payload) ? payload : [];

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
