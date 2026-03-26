import { NextResponse } from "next/server";
import { buildKaminoVaultDepositTransactionBase64 } from "@/lib/solana/kaminoTxServer";

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as
      | { vaultAddress?: unknown; signer?: unknown; amountUi?: unknown }
      | null;

    const vaultAddress = typeof body?.vaultAddress === "string" ? body.vaultAddress.trim() : "";
    const signer = typeof body?.signer === "string" ? body.signer.trim() : "";
    const amountUi = typeof body?.amountUi === "number" ? body.amountUi : Number(body?.amountUi);

    if (!vaultAddress) {
      return NextResponse.json({ success: false, error: "Missing vaultAddress" }, { status: 400 });
    }
    if (!signer) {
      return NextResponse.json({ success: false, error: "Missing signer" }, { status: 400 });
    }
    if (!Number.isFinite(amountUi) || amountUi <= 0) {
      return NextResponse.json({ success: false, error: "Invalid amountUi" }, { status: 400 });
    }

    const { transactionBase64 } = await buildKaminoVaultDepositTransactionBase64({
      vaultAddress,
      ownerBase58: signer,
      amountUi,
    });

    return NextResponse.json({ success: true, data: { transaction: transactionBase64 } });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

