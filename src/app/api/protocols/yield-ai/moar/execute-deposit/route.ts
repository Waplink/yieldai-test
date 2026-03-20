import { NextRequest, NextResponse } from "next/server";
import { Aptos, AptosConfig, Network, Account, Ed25519PrivateKey } from "@aptos-labs/ts-sdk";
import { toCanonicalAddress } from "@/lib/utils/addressNormalization";
import {
  YIELD_AI_VAULT_MODULE,
  USDC_FA_METADATA_MAINNET,
  MOAR_ADAPTER_ADDRESS_MAINNET,
} from "@/lib/constants/yieldAiVault";
import { createErrorResponse, createSuccessResponse } from "@/lib/utils/http";

const APTOS_API_KEY = process.env.APTOS_API_KEY;
const config = new AptosConfig({
  network: Network.MAINNET,
  ...(APTOS_API_KEY && {
    clientConfig: {
      HEADERS: { Authorization: `Bearer ${APTOS_API_KEY}` },
    },
  }),
});
const aptos = new Aptos(config);

/**
 * POST /api/protocols/yield-ai/moar/execute-deposit
 * Body: { safeAddress: string, amountBaseUnits: string }
 * Executor (from YIELD_AI_EXECUTOR_PRIVATE_KEY) signs and submits vault::execute_deposit
 * to deposit USDC from safe into Moar via adapter.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const safeAddress = typeof body.safeAddress === "string" ? body.safeAddress.trim() : "";
    const amountBaseUnits = typeof body.amountBaseUnits === "string" ? body.amountBaseUnits.trim() : String(body.amountBaseUnits ?? "");

    if (!safeAddress) {
      return NextResponse.json(
        createErrorResponse(new Error("safeAddress is required")),
        { status: 400 }
      );
    }

    const amountBig = BigInt(amountBaseUnits);
    if (amountBig <= BigInt(0)) {
      return NextResponse.json(
        createErrorResponse(new Error("amountBaseUnits must be a positive integer")),
        { status: 400 }
      );
    }

    const privateKeyHex = process.env.YIELD_AI_EXECUTOR_PRIVATE_KEY;
    if (!privateKeyHex) {
      return NextResponse.json(
        createErrorResponse(new Error("YIELD_AI_EXECUTOR_PRIVATE_KEY is not configured")),
        { status: 500 }
      );
    }

    let account: Account;
    try {
      const keyHex = privateKeyHex.replace(/^0x/, "").trim();
      account = Account.fromPrivateKey({
        privateKey: new Ed25519PrivateKey(keyHex),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Invalid private key";
      console.error("[Yield AI] execute-deposit: failed to create account:", message);
      return NextResponse.json(
        createErrorResponse(new Error("Invalid executor private key")),
        { status: 500 }
      );
    }

    const safeAddr = toCanonicalAddress(safeAddress);
    const adapterAddr = toCanonicalAddress(MOAR_ADAPTER_ADDRESS_MAINNET);
    const metadataAddr = toCanonicalAddress(USDC_FA_METADATA_MAINNET);

    const transaction = await aptos.transaction.build.simple({
      sender: account.accountAddress,
      withFeePayer: false,
      data: {
        function: `${YIELD_AI_VAULT_MODULE}::execute_deposit` as `${string}::${string}::${string}`,
        typeArguments: [],
        functionArguments: [safeAddr, adapterAddr, amountBaseUnits, metadataAddr],
      },
      options: { maxGasAmount: 50000 },
    });

    const senderAuthenticator = aptos.transaction.sign({
      signer: account,
      transaction,
    });

    const result = await aptos.transaction.submit.simple({
      transaction,
      senderAuthenticator,
    });

    console.log("[Yield AI] execute-deposit submitted:", {
      hash: result.hash,
      safeAddress: safeAddr,
      amountBaseUnits,
    });

    return NextResponse.json(
      createSuccessResponse({ hash: result.hash })
    );
  } catch (error) {
    console.error("[Yield AI] execute-deposit error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      createErrorResponse(new Error(message)),
      { status: 500 }
    );
  }
}
