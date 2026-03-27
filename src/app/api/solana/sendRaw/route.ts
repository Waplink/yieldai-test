import { NextResponse } from "next/server";
import { Connection } from "@solana/web3.js";
import { getSafeSolanaRpcEndpoint } from "@/lib/solana/solanaRpcEndpoint";

function base64ToBytes(base64: string): Uint8Array {
  return Uint8Array.from(Buffer.from(base64, "base64"));
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as { txBase64?: unknown } | null;
    const txBase64 = typeof body?.txBase64 === "string" ? body.txBase64.trim() : "";
    if (!txBase64) return NextResponse.json({ success: false, error: "Missing txBase64" }, { status: 400 });

    const raw = base64ToBytes(txBase64);
    const connection = new Connection(getSafeSolanaRpcEndpoint(), "confirmed");

    const sig = await connection.sendRawTransaction(raw, {
      skipPreflight: false,
      maxRetries: 3,
      preflightCommitment: "confirmed",
    });
    await connection.confirmTransaction(sig, "confirmed");

    return NextResponse.json({ success: true, data: { signature: sig } });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

