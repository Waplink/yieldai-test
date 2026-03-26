import type { Instruction } from "@solana/instructions";
import { Buffer } from "buffer";
import { PublicKey, SendTransactionError, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { getSafeSolanaRpcEndpoint } from "@/lib/solana/solanaRpcEndpoint";

function base64ToBytes(base64: string): Uint8Array {
  // Prefer browser-safe decoding (Next client). Fallback to Node Buffer when available.
  if (typeof atob === "function") {
    const bin = atob(base64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const b: any = (globalThis as any).Buffer;
  if (b && typeof b.from === "function") {
    return Uint8Array.from(b.from(base64, "base64"));
  }
  throw new Error("Base64 decoder unavailable in this environment");
}

function kitInstructionToWeb3(ix: Instruction): TransactionInstruction {
  const programId = new PublicKey(String(ix.programAddress));
  const keys =
    (ix.accounts ?? []).map((a) => {
      const role = (a as { role?: unknown }).role as number | undefined;
      const isSigner = role === 2 || role === 3;
      const isWritable = role === 1 || role === 3;
      return {
        pubkey: new PublicKey(String((a as { address: unknown }).address)),
        isSigner,
        isWritable,
      };
    }) ?? [];
  // web3.js types expect Buffer for `data` in some versions.
  const data = Buffer.from(ix.data ? Uint8Array.from(ix.data) : new Uint8Array());
  return new TransactionInstruction({ programId, keys, data });
}

async function sendRawVersionedWithLogs(connection: import("@solana/web3.js").Connection, raw: Uint8Array): Promise<string> {
  try {
    const sentSig = await connection.sendRawTransaction(raw, {
      skipPreflight: false,
      maxRetries: 3,
    });
    await connection.confirmTransaction(sentSig, "confirmed");
    return sentSig;
  } catch (e) {
    if (e instanceof SendTransactionError) {
      let logs: string[] | undefined = e.logs;
      try {
        logs = logs ?? (await e.getLogs(connection));
      } catch {
        // ignore
      }
      const msg = e.transactionError?.message || e.message || "SendTransactionError";
      throw new Error(`${msg}${logs && logs.length ? `\nLogs:\n${logs.join("\n")}` : ""}`);
    }
    throw e;
  }
}

/**
 * Wallet-adapter compatible path: build a VersionedTransaction via web3.js, sign with adapter,
 * then send the signed bytes. This avoids Solana Kit signer dictionary mismatches.
 */
export async function sendVaultInstructionsWithWalletAdapter(params: {
  connection: import("@solana/web3.js").Connection;
  payerBase58: string;
  signTransaction: (tx: VersionedTransaction) => Promise<VersionedTransaction>;
  instructions: readonly Instruction[];
  /** Optional ALT addresses to reduce tx size. */
  addressLookupTableAddresses?: string[];
}): Promise<string> {
  const { connection, payerBase58, signTransaction, instructions, addressLookupTableAddresses = [] } = params;
  const payer = new PublicKey(payerBase58);
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const web3Ixs = instructions.map(kitInstructionToWeb3);
  const altAccounts = (
    await Promise.all(
      addressLookupTableAddresses
        .map((a) => a.trim())
        .filter(Boolean)
        .map(async (a) => {
          try {
            const res = await connection.getAddressLookupTable(new PublicKey(a));
            return res.value ?? null;
          } catch {
            return null;
          }
        })
    )
  ).filter((x): x is NonNullable<typeof x> => !!x);

  const messageV0 = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions: web3Ixs,
  }).compileToV0Message(altAccounts);
  const vtx = new VersionedTransaction(messageV0);

  const signed = await signTransaction(vtx);
  // simulate with signature verify for a clear error
  const sim = await connection.simulateTransaction(signed, { sigVerify: true, commitment: "processed" });
  if (sim.value.err) {
    const logs = sim.value.logs ?? [];
    throw new Error(`Preflight simulation failed: ${JSON.stringify(sim.value.err)}${logs.length ? `\nLogs:\n${logs.join("\n")}` : ""}`);
  }
  return sendRawVersionedWithLogs(connection, signed.serialize());
}

export function getSolanaRpcEndpoint(): string {
  return getSafeSolanaRpcEndpoint();
}

export function decodeKitWireTransaction(base64Wire: string): Uint8Array {
  return base64ToBytes(base64Wire);
}

