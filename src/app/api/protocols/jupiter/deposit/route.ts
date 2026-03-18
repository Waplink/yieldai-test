import { NextRequest, NextResponse } from "next/server";
import { Connection, PublicKey, Transaction, TransactionInstruction, clusterApiUrl } from "@solana/web3.js";

type DepositRequest = {
  asset: string;
  signer: string;
  amount: string;
  preferLegacyInstruction?: boolean;
};

type JupiterDepositResponse = {
  transaction?: string;
};

type JupiterDepositInstructionResponse = {
  instructions?: Array<{
    programId: string;
    accounts: Array<{
      pubkey: string;
      isSigner: boolean;
      isWritable: boolean;
    }>;
    data: string;
  }>;
};

function isSolanaAddress(value: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}

function getRpcEndpoint(): string {
  return (
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL ||
    process.env.SOLANA_RPC_URL ||
    (process.env.NEXT_PUBLIC_SOLANA_RPC_API_KEY || process.env.SOLANA_RPC_API_KEY
      ? `https://mainnet.helius-rpc.com/?api-key=${process.env.NEXT_PUBLIC_SOLANA_RPC_API_KEY || process.env.SOLANA_RPC_API_KEY}`
      : clusterApiUrl("mainnet-beta"))
  );
}

async function buildLegacyTransactionFromInstruction(input: {
  asset: string;
  signer: string;
  amount: string;
}): Promise<string> {
  const upstream = await fetch("https://lite-api.jup.ag/lend/v1/earn/deposit-instructions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      asset: input.asset,
      signer: input.signer,
      amount: input.amount,
    }),
    cache: "no-store",
  });

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    throw new Error(`Jupiter instruction API error: ${upstream.status} ${upstream.statusText}${text ? ` - ${text}` : ""}`);
  }

  const payload = (await upstream.json().catch(() => null)) as JupiterDepositInstructionResponse | null;
  const instructions = payload?.instructions ?? [];
  if (!Array.isArray(instructions) || instructions.length === 0) {
    throw new Error("Invalid instruction response from Jupiter");
  }

  const connection = new Connection(getRpcEndpoint(), "confirmed");
  const { blockhash } = await connection.getLatestBlockhash("confirmed");

  const transaction = new Transaction({
    feePayer: new PublicKey(input.signer),
    recentBlockhash: blockhash,
  });

  for (const ix of instructions) {
    transaction.add(
      new TransactionInstruction({
        programId: new PublicKey(ix.programId),
        keys: ix.accounts.map((account) => ({
          pubkey: new PublicKey(account.pubkey),
          isSigner: !!account.isSigner,
          isWritable: !!account.isWritable,
        })),
        data: Buffer.from(ix.data || "", "base64"),
      })
    );
  }

  return transaction.serialize({
    requireAllSignatures: false,
    verifySignatures: false,
  }).toString("base64");
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as DepositRequest;

    if (!body?.asset || !body?.signer || !body?.amount) {
      return NextResponse.json(
        { success: false, error: "Missing required fields: asset, signer, amount" },
        { status: 400 }
      );
    }

    const amount = String(body.amount).trim();
    if (!/^\d+$/.test(amount) || amount === "0") {
      return NextResponse.json(
        { success: false, error: "Invalid amount. Must be a positive integer string in base units." },
        { status: 400 }
      );
    }

    if (!isSolanaAddress(body.asset) || !isSolanaAddress(body.signer)) {
      return NextResponse.json(
        { success: false, error: "Invalid Solana address format" },
        { status: 400 }
      );
    }

    if (body.preferLegacyInstruction) {
      const transaction = await buildLegacyTransactionFromInstruction({
        asset: body.asset,
        signer: body.signer,
        amount,
      });

      return NextResponse.json({
        success: true,
        data: {
          transaction,
          asset: body.asset,
          signer: body.signer,
          amount,
        },
      });
    }

    const upstream = await fetch("https://lite-api.jup.ag/lend/v1/earn/deposit", {
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

    const payload = (await upstream.json().catch(() => null)) as JupiterDepositResponse | null;
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

