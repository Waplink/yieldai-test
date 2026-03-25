import { fromVersionedTransaction } from "@solana/compat";
import { KaminoVault } from "@kamino-finance/klend-sdk";
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
import { Connection, VersionedMessage, VersionedTransaction } from "@solana/web3.js";

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

export function getSolanaRpcEndpoint(): string {
  return (
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL ||
    process.env.SOLANA_RPC_URL ||
    (process.env.NEXT_PUBLIC_SOLANA_RPC_API_KEY || process.env.SOLANA_RPC_API_KEY
      ? `https://mainnet.helius-rpc.com/?api-key=${process.env.NEXT_PUBLIC_SOLANA_RPC_API_KEY || process.env.SOLANA_RPC_API_KEY}`
      : "https://mainnet.helius-rpc.com/?api-key=29798653-2d13-4d8a-96ad-df70b015e234")
  );
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
        const signedKit = fromVersionedTransaction(signed);
        const sig = signedKit.signatures[addr];
        if (!sig) {
          throw new Error("Wallet did not return a signature for this transaction");
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
  const sentSig = await connection.sendRawTransaction(raw, {
    skipPreflight: false,
    maxRetries: 3,
  });
  await connection.confirmTransaction(sentSig, "confirmed");
  return sentSig;
}

export async function loadKaminoVaultForAddress(
  rpc: MainnetSolanaRpc,
  vaultAddress: string
): Promise<{ vault: KaminoVault; lookupTable: Address }> {
  const vault = new KaminoVault(rpc as ConstructorParameters<typeof KaminoVault>[0], address(vaultAddress.trim()));
  const state = await vault.getState();
  return { vault, lookupTable: state.vaultLookupTable };
}

/** Deposit underlying tokens into a Kamino kVault (Earn). Returns transaction signature. */
export async function depositToKaminoVault(params: {
  vaultAddress: string;
  amountUi: number;
  signerAddress: string;
  signTransaction: (tx: VersionedTransaction) => Promise<VersionedTransaction>;
}): Promise<string> {
  const amountDec = new Decimal(params.amountUi);
  if (!amountDec.isFinite() || amountDec.lte(0)) {
    throw new Error("Enter a positive amount.");
  }
  const rpc = createMainnetRpc();
  const connection = new Connection(getSolanaRpcEndpoint(), "confirmed");
  const signer = createWalletAdapterPartialSigner(params.signerAddress, params.signTransaction);
  const { vault, lookupTable } = await loadKaminoVaultForAddress(rpc, params.vaultAddress);
  const dep = await vault.depositIxs(signer, amountDec, undefined, undefined, signer);
  const stakeExtra =
    dep.stakeInFarmIfNeededIxs.length > 0 ? dep.stakeInFarmIfNeededIxs : dep.stakeInFlcFarmIfNeededIxs;
  const ixs = [...dep.depositIxs, ...stakeExtra];
  // Some wallets (e.g. Phantom) error during signing when ALT lookups are unresolved.
  // Avoid LUT compression for better wallet compatibility.
  void lookupTable;
  return sendKitInstructionsWithWallet(rpc, connection, ixs, signer, []);
}
