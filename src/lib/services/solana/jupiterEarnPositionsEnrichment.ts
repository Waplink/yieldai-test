import { clusterApiUrl, Connection, PublicKey } from "@solana/web3.js";

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

function getSolanaRpcUrl(): string {
  const direct = process.env.SOLANA_RPC_URL || process.env.NEXT_PUBLIC_SOLANA_RPC_URL;
  if (direct?.trim()) return direct.trim();
  const key = process.env.SOLANA_RPC_API_KEY || process.env.NEXT_PUBLIC_SOLANA_RPC_API_KEY;
  if (key?.trim()) return `https://mainnet.helius-rpc.com/?api-key=${key.trim()}`;
  return clusterApiUrl("mainnet-beta");
}

/**
 * SPL + Token-2022 balances by mint (raw amount string as in chain).
 */
export async function fetchWalletSplBalancesByMint(ownerBase58: string): Promise<Map<string, bigint>> {
  const owner = new PublicKey(ownerBase58);
  const connection = new Connection(getSolanaRpcUrl(), "confirmed");
  const [legacy, token2022] = await Promise.all([
    connection.getParsedTokenAccountsByOwner(owner, TOKEN_PROGRAM_ID, "confirmed"),
    connection.getParsedTokenAccountsByOwner(owner, TOKEN_2022_PROGRAM_ID, "confirmed"),
  ]);

  const map = new Map<string, bigint>();
  for (const acc of [...legacy.value, ...token2022.value]) {
    const data = acc.account.data as {
      program?: string;
      parsed?: {
        info?: { mint?: string; tokenAmount?: { amount?: string } };
      };
    };
    const mint = data.parsed?.info?.mint;
    const amount = data.parsed?.info?.tokenAmount?.amount;
    if (!mint || amount === undefined) continue;
    try {
      map.set(mint, BigInt(String(amount)));
    } catch {
      // ignore
    }
  }
  return map;
}

function parseBigIntSafe(s: unknown): bigint {
  try {
    const t = String(s ?? "0").trim();
    if (!t) return BigInt(0);
    const intPart = t.split(".")[0] || "0";
    return BigInt(intPart);
  } catch {
    return BigInt(0);
  }
}

/**
 * Jupiter Lend `/earn/positions` often returns shares=0 while jl* SPL balances sit in the wallet.
 * Merge wallet jl balances into `shares` and recompute `underlyingAssets` from vault ratio totalAssets/totalSupply.
 */
export function enrichJupiterEarnPositionsWithWalletShares(
  rows: unknown[],
  mintToBalance: Map<string, bigint>
): { enriched: unknown[]; rowsTouched: number } {
  let rowsTouched = 0;
  const enriched = rows.map((row) => {
    if (!row || typeof row !== "object") return row;
    const r = row as Record<string, unknown>;
    const token = r.token as Record<string, unknown> | undefined;
    if (!token) return row;

    const jlMint = typeof token.address === "string" ? token.address.trim() : "";
    if (!jlMint) return row;

    const walletJl = mintToBalance.get(jlMint) ?? BigInt(0);
    if (walletJl === BigInt(0)) return row;

    const apiShares = parseBigIntSafe(r.shares);
    const effectiveShares = apiShares + walletJl;
    if (effectiveShares === BigInt(0)) return row;

    const totalAssets = parseBigIntSafe(token.totalAssets);
    const totalSupply = parseBigIntSafe(token.totalSupply);

    let underlyingRaw = parseBigIntSafe(r.underlyingAssets);
    if (totalSupply > BigInt(0) && totalAssets > BigInt(0)) {
      underlyingRaw = (effectiveShares * totalAssets) / totalSupply;
    }

    rowsTouched += 1;

    return {
      ...r,
      shares: String(effectiveShares),
      underlyingAssets: String(underlyingRaw),
    };
  });

  return { enriched, rowsTouched };
}
