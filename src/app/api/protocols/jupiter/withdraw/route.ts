import { NextRequest, NextResponse } from "next/server";

type WithdrawRequest = {
  asset: string;
  signer: string;
  amount: string;
};

type JupiterWithdrawResponse = {
  transaction?: string;
};

function isSolanaAddress(value: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as WithdrawRequest;

    if (!body?.asset || !body?.signer || !body?.amount) {
      return NextResponse.json(
        { success: false, error: "Missing required fields: asset, signer, amount" },
        { status: 400 }
      );
    }

    const amount = String(body.amount).trim();
    const amountNum = Number(amount);
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      return NextResponse.json(
        { success: false, error: "Invalid amount. Must be a positive number string." },
        { status: 400 }
      );
    }

    if (!isSolanaAddress(body.asset) || !isSolanaAddress(body.signer)) {
      return NextResponse.json(
        { success: false, error: "Invalid Solana address format" },
        { status: 400 }
      );
    }

    const upstream = await fetch("https://lite-api.jup.ag/lend/v1/earn/withdraw", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        asset: body.asset,
        signer: body.signer,
        amount,
      }),
      cache: "no-store",
    });

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => "");
      return NextResponse.json(
        {
          success: false,
          error: `Jupiter API error: ${upstream.status} ${upstream.statusText}${text ? ` - ${text}` : ""}`,
        },
        { status: upstream.status }
      );
    }

    const payload = (await upstream.json().catch(() => null)) as JupiterWithdrawResponse | null;
    if (!payload?.transaction) {
      return NextResponse.json(
        { success: false, error: "No transaction returned from Jupiter API" },
        { status: 502 }
      );
    }

    return NextResponse.json({
      success: true,
      data: {
        transaction: payload.transaction,
        asset: body.asset,
        signer: body.signer,
        amount,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    );
  }
}

