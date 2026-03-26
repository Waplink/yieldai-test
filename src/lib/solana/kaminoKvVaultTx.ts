import { fromVersionedTransaction } from "@solana/compat";
import type { Address } from "@solana/addresses";
import { address } from "@solana/addresses";
import type { Instruction } from "@solana/instructions";
import {
  appendTransactionMessageInstructions,
  compressTransactionMessageUsingAddressLookupTables,
  createSolanaRpc,
  createTransactionMessage,
  fetchAddressesForLookupTables,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import type { SignatureBytes } from "@solana/keys";
import type { SignatureDictionary, TransactionPartialSigner } from "@solana/signers";
import type { Transaction as KitTransaction } from "@solana/transactions";
import Decimal from "decimal.js";
import { Connection, PublicKey, SendTransactionError, TransactionInstruction, TransactionMessage, VersionedMessage, VersionedTransaction } from "@solana/web3.js";
import { sendVaultInstructionsWithWalletAdapter } from "@/lib/solana/kaminoTxClient";
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
  const data = ix.data ? Buffer.from(ix.data) : Buffer.alloc(0);
  return new TransactionInstruction({ programId, keys, data });
}

async function sendRawVersionedWithLogs(connection: Connection, raw: Uint8Array): Promise<string> {
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
// NOTE: sendVaultInstructionsWithWalletAdapter moved to `kaminoTxClient.ts`

export function getSolanaRpcEndpoint(): string {
  return getSafeSolanaRpcEndpoint();
}

export type MainnetSolanaRpc = ReturnType<typeof createSolanaRpc>;

export function createMainnetRpc(): MainnetSolanaRpc {
  return createSolanaRpc(getSolanaRpcEndpoint() as Parameters<typeof createSolanaRpc>[0]);
}

function kitTransactionToVersionedTransaction(kitTx: KitTransaction): VersionedTransaction {
  const message = VersionedMessage.deserialize(new Uint8Array(kitTx.messageBytes));
  const { header, staticAccountKeys } = message;
  const numRequired = header.numRequiredSignatures;
  const signatures: Uint8Array[] = [];
  for (let i = 0; i < numRequired; i++) {
    const pk = staticAccountKeys[i];
    const addr = address(pk.toBase58());
    const sig = kitTx.signatures[addr];
    if (sig) {
      signatures.push(new Uint8Array(sig));
    } else {
      signatures.push(new Uint8Array(64));
    }
  }
  return new VersionedTransaction(message, signatures);
}

export function createWalletAdapterPartialSigner(
  walletAddressBase58: string,
  signTransaction: (tx: VersionedTransaction) => Promise<VersionedTransaction>
): TransactionPartialSigner {
  const addr = address(walletAddressBase58);
  return {
    address: addr,
    signTransactions: async (transactions) => {
      const out: SignatureDictionary[] = [];
      for (const kitTx of transactions) {
        const vtx = kitTransactionToVersionedTransaction(kitTx);
        const signed = await signTransaction(vtx);
        // Wallet-adapter returns signatures by index. We must pick the index that corresponds
        // to the requested signer pubkey among required signers.
        const keys = signed.message.staticAccountKeys;
        const required = signed.message.header.numRequiredSignatures;
        const signerIndex = keys
          .slice(0, required)
          .findIndex((k) => k.toBase58() === walletAddressBase58);
        if (signerIndex < 0) {
          throw new Error("Signer pubkey not found in required signers");
        }
        const sig = signed.signatures?.[signerIndex];
        if (!sig || sig.length !== 64 || sig.every((b) => b === 0)) {
          throw new Error("Wallet did not return a valid signature for this transaction");
        }
        out.push({ [addr]: new Uint8Array(sig) as SignatureBytes } as SignatureDictionary);
      }
      return out;
    },
  };
}

export async function sendKitInstructionsWithWallet(
  rpc: MainnetSolanaRpc,
  connection: Connection,
  instructions: readonly Instruction[],
  feePayerSigner: TransactionPartialSigner,
  lookupTableAddresses: readonly Address[]
): Promise<string> {
  const { value: latestBlockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();

  const addressesByLookupTableAddress =
    lookupTableAddresses.length > 0
      ? await fetchAddressesForLookupTables([...lookupTableAddresses], rpc)
      : {};

  const transactionMessage = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayerSigner(feePayerSigner, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
    (tx) => appendTransactionMessageInstructions([...instructions], tx),
    (tx) =>
      Object.keys(addressesByLookupTableAddress).length > 0
        ? compressTransactionMessageUsingAddressLookupTables(tx, addressesByLookupTableAddress)
        : tx
  );

  const signedTransaction = await signTransactionMessageWithSigners(transactionMessage);
  const wire = getBase64EncodedWireTransaction(signedTransaction);
  const raw = base64ToBytes(wire);

  // Sanity-check signature & fee payer before hitting RPC.
  try {
    const vtx = VersionedTransaction.deserialize(raw);
    const feePayerPk = vtx.message.staticAccountKeys?.[0]?.toBase58?.() ?? "";
    const expectedFeePayer = String(feePayerSigner.address);
    const sig0 = vtx.signatures?.[0];
    const sig0Empty = !sig0 || sig0.length !== 64 || sig0.every((b) => b === 0);
    if (!feePayerPk || feePayerPk !== expectedFeePayer) {
      throw new Error(`Fee payer mismatch. tx=${feePayerPk || "unknown"} signer=${expectedFeePayer}`);
    }
    if (sig0Empty) {
      throw new Error("Missing fee payer signature (index 0)");
    }

    const sim = await connection.simulateTransaction(vtx, { sigVerify: true, commitment: "processed" });
    if (sim.value.err) {
      const logs = sim.value.logs ?? [];
      throw new Error(
        `Preflight simulation failed: ${JSON.stringify(sim.value.err)}${logs.length ? `\nLogs:\n${logs.join("\n")}` : ""}`
      );
    }
  } catch (e) {
    // If simulateTransaction fails (e.g. RPC issues), proceed to sendRawTransaction to preserve existing behavior,
    // but surface signature/fee-payer issues early.
    if (e instanceof Error && /Fee payer mismatch|Missing fee payer signature|Preflight simulation failed/.test(e.message)) {
      throw e;
    }
  }

  return sendRawVersionedWithLogs(connection, raw);
}

// NOTE: klend-sdk/KaminoVault usage moved to server-only module `kaminoTxServer.ts`
