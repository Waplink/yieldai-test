import "server-only";

import { KaminoVault } from "@kamino-finance/klend-sdk";
import Decimal from "decimal.js";
import type { Address } from "@solana/addresses";
import { address } from "@solana/addresses";
import type { Instruction } from "@solana/instructions";
import { Buffer } from "buffer";
import { Connection, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { getSafeSolanaRpcEndpoint } from "@/lib/solana/solanaRpcEndpoint";
import { createSolanaRpc } from "@solana/kit";

export function getSolanaRpcEndpoint(): string {
  return getSafeSolanaRpcEndpoint();
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
  const data = Buffer.from(ix.data ? Uint8Array.from(ix.data) : new Uint8Array());
  return new TransactionInstruction({ programId, keys, data });
}

export async function loadKaminoVaultForAddress(params: {
  rpcEndpoint?: string;
  vaultAddress: string;
}): Promise<{ vault: KaminoVault; lookupTable: Address }> {
  const rpcEndpoint = params.rpcEndpoint ?? getSolanaRpcEndpoint();
  const rpc = createSolanaRpc(rpcEndpoint as Parameters<typeof createSolanaRpc>[0]);
  const vault = new KaminoVault(rpc as ConstructorParameters<typeof KaminoVault>[0], address(params.vaultAddress.trim()));
  const state = await vault.getState();
  return { vault, lookupTable: state.vaultLookupTable };
}

function createAddressOnlySigner(ownerBase58: string) {
  const addr = address(ownerBase58.trim());
  return {
    address: addr,
    // Should not be called during ixs building. If it is, we must move signing to client path.
    signTransactions: async () => {
      throw new Error("Server cannot sign transactions");
    },
  };
}

export async function buildKaminoVaultDepositTransactionBase64(params: {
  vaultAddress: string;
  ownerBase58: string;
  amountUi: number;
}): Promise<{ transactionBase64: string }> {
  const amountDec = new Decimal(params.amountUi);
  if (!amountDec.isFinite() || amountDec.lte(0)) {
    throw new Error("Enter a positive amount.");
  }

  const connection = new Connection(getSolanaRpcEndpoint(), "confirmed");
  const { blockhash } = await connection.getLatestBlockhash("confirmed");

  // Build deposit instructions via klend-sdk.
  const { vault, lookupTable } = await loadKaminoVaultForAddress({
    vaultAddress: params.vaultAddress,
  });

  const ownerSigner = createAddressOnlySigner(params.ownerBase58);
  const dep = await vault.depositIxs(ownerSigner, amountDec, undefined, undefined, ownerSigner);
  const stakeExtra =
    dep.stakeInFarmIfNeededIxs.length > 0 ? dep.stakeInFarmIfNeededIxs : dep.stakeInFlcFarmIfNeededIxs;
  const ixs = [...dep.depositIxs, ...stakeExtra];

  // Compile as v0 with ALT to keep tx size under limits.
  const altRes = await connection.getAddressLookupTable(new PublicKey(String(lookupTable)));
  const alt = altRes.value ? [altRes.value] : [];
  const web3Ixs = ixs.map(kitInstructionToWeb3);

  const messageV0 = new TransactionMessage({
    payerKey: new PublicKey(params.ownerBase58),
    recentBlockhash: blockhash,
    instructions: web3Ixs,
  }).compileToV0Message(alt);

  const vtx = new VersionedTransaction(messageV0);
  const raw = vtx.serialize(); // unsigned; wallet will sign
  const transactionBase64 = Buffer.from(raw).toString("base64");
  return { transactionBase64 };
}

export async function buildKaminoVaultWithdrawTransactionBase64(params: {
  vaultAddress: string;
  ownerBase58: string;
  amountUi: number;
}): Promise<{ transactionBase64: string }> {
  const amountDec = new Decimal(params.amountUi);
  if (!amountDec.isFinite() || amountDec.lte(0)) {
    throw new Error("Enter a positive amount.");
  }

  const connection = new Connection(getSolanaRpcEndpoint(), "confirmed");
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const slot = BigInt(await connection.getSlot("confirmed"));

  const { vault, lookupTable } = await loadKaminoVaultForAddress({
    vaultAddress: params.vaultAddress,
  });

  const ownerSigner = createAddressOnlySigner(params.ownerBase58);
  const w = await vault.withdrawIxs(ownerSigner, amountDec, slot, undefined, undefined, ownerSigner);
  const ixs = [...w.unstakeFromFarmIfNeededIxs, ...w.withdrawIxs, ...w.postWithdrawIxs];

  const altRes = await connection.getAddressLookupTable(new PublicKey(String(lookupTable)));
  const alt = altRes.value ? [altRes.value] : [];
  const web3Ixs = ixs.map(kitInstructionToWeb3);

  const messageV0 = new TransactionMessage({
    payerKey: new PublicKey(params.ownerBase58),
    recentBlockhash: blockhash,
    instructions: web3Ixs,
  }).compileToV0Message(alt);

  const vtx = new VersionedTransaction(messageV0);
  const raw = vtx.serialize();
  const transactionBase64 = Buffer.from(raw).toString("base64");
  return { transactionBase64 };
}

