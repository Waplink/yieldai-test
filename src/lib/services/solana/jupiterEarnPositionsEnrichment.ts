import { clusterApiUrl, Connection, PublicKey } from "@solana/web3.js";
import { SolanaPortfolioService } from "@/lib/services/solana/portfolio";

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

/** Same Helius key injection as SolanaPortfolioService — bare helius URLs without ?api-key= get 401. */
function buildHeliusEndpointFromKey(): string | null {
  const apiKey =
    process.env.SOLANA_RPC_API_KEY || process.env.NEXT_PUBLIC_SOLANA_RPC_API_KEY || "";
  if (!apiKey.trim()) return null;
  return `https://mainnet.helius-rpc.com/?api-key=${apiKey.trim()}`;
}

function normalizeRpcEndpoint(endpoint: string): string | null {
  try {
    const parsed = new URL(endpoint);
    const isHelius = parsed.hostname.includes("helius-rpc.com");
    if (!isHelius) return parsed.toString();

    const keyInUrl = parsed.searchParams.get("api-key");
    if (keyInUrl && keyInUrl.trim().length > 0) return parsed.toString();

    const apiKey =
      process.env.SOLANA_RPC_API_KEY || process.env.NEXT_PUBLIC_SOLANA_RPC_API_KEY || "";
    if (!apiKey) return null;
    parsed.searchParams.set("api-key", apiKey);
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * When `SOLANA_RPC_API_KEY` is set, try Helius with that key **first** so enrichment never hits a bare
 * Helius URL from `SOLANA_RPC_URL` before the keyed endpoint (avoids 401 "missing api key").
 * Then custom env URLs (normalized), Ankr, public cluster.
 */
function getSolanaRpcEndpointList(): string[] {
  const directEnvEndpoints = [process.env.SOLANA_RPC_URL, process.env.NEXT_PUBLIC_SOLANA_RPC_URL]
    .filter(Boolean)
    .map((endpoint) => normalizeRpcEndpoint(endpoint as string))
    .filter(Boolean) as string[];

  const heliusFromKey = buildHeliusEndpointFromKey();

  const list = [
    ...(heliusFromKey ? [heliusFromKey] : []),
    ...directEnvEndpoints,
    "https://rpc.ankr.com/solana",
    clusterApiUrl("mainnet-beta"),
  ];
  return Array.from(new Set(list));
}

function mergeMintMapsPreferMax(a: Map<string, bigint>, b: Map<string, bigint>): Map<string, bigint> {
  const out = new Map(a);
  for (const [k, v] of b) {
    const av = out.get(k) ?? BigInt(0);
    out.set(k, v > av ? v : av);
  }
  return out;
}

/**
 * Fallback: same RPC list as enrichment (Helius key first, etc.). Sums multiple token accounts per mint.
 */
async function fetchWalletSplBalancesByMintViaRpc(ownerBase58: string): Promise<Map<string, bigint>> {
  const owner = new PublicKey(ownerBase58);
  const endpoints = getSolanaRpcEndpointList();
  let lastError: Error | null = null;

  for (const endpoint of endpoints) {
    try {
      const connection = new Connection(endpoint, "confirmed");
      const [legacy, token2022] = await Promise.all([
        connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }, "confirmed"),
        connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID }, "confirmed"),
      ]);

      const map = new Map<string, bigint>();
      for (const acc of [...legacy.value, ...token2022.value]) {
        const data = acc.account.data as {
          program?: string;
          parsed?: {
            info?: { mint?: string; tokenAmount?: { amount?: string } };
            parsed?: { info?: { mint?: string; tokenAmount?: { amount?: string } } };
          };
        };
        const inner = data.parsed?.info ?? data.parsed?.parsed?.info;
        const mint = inner?.mint;
        const amount = inner?.tokenAmount?.amount;
        if (!mint || amount === undefined) continue;
        try {
          const raw = BigInt(String(amount).split(".")[0] || "0");
          if (raw <= BigInt(0)) continue;
          map.set(mint, (map.get(mint) ?? BigInt(0)) + raw);
        } catch {
          // ignore
        }
      }
      return map;
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      continue;
    }
  }

  throw lastError ?? new Error("Solana RPC: all endpoints failed");
}

/**
 * SPL + Token-2022 balances by mint (raw amounts, summed per mint).
 * Uses the same RPC path as `SolanaPortfolioService` (no uiAmount filter) merged with the enrichment RPC list.
 */
export async function fetchWalletSplBalancesByMint(ownerBase58: string): Promise<Map<string, bigint>> {
  let fromPortfolio = new Map<string, bigint>();
  try {
    fromPortfolio = await SolanaPortfolioService.getInstance().getRawSplBalancesByMint(ownerBase58);
  } catch (e) {
    console.warn("[Jupiter enrich] getRawSplBalancesByMint failed:", e instanceof Error ? e.message : e);
  }

  let fromRpc = new Map<string, bigint>();
  try {
    fromRpc = await fetchWalletSplBalancesByMintViaRpc(ownerBase58);
  } catch (e) {
    console.warn("[Jupiter enrich] RPC SPL balances failed:", e instanceof Error ? e.message : e);
  }

  if (fromPortfolio.size === 0) return fromRpc;
  if (fromRpc.size === 0) return fromPortfolio;
  return mergeMintMapsPreferMax(fromPortfolio, fromRpc);
}

export function parseBigIntSafe(s: unknown): bigint {
  try {
    const t = String(s ?? "0").trim();
    if (!t) return BigInt(0);
    const intPart = t.split(".")[0] || "0";
    return BigInt(intPart);
  } catch {
    return BigInt(0);
  }
}

const BASE58_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Jupiter sometimes exposes the jl mint as `token.address`; older payloads may use string `id`.
 */
export function resolveJlMintFromToken(token: Record<string, unknown> | undefined): string {
  if (!token) return "";
  const addr = typeof token.address === "string" ? token.address.trim() : "";
  if (addr) return addr;
  const id = token.id;
  if (typeof id === "string" && BASE58_ADDR.test(id)) return id.trim();
  return "";
}

/**
 * Scaffold rows from `/earn/positions` may omit `totalAssets` / `totalSupply` needed for backfill.
 * Merge catalog fields from `GET /lend/v1/earn/tokens` by jl mint.
 */
export function mergeEarnTokenCatalogIntoPositionRows(
  rows: unknown[],
  earnTokens: unknown[]
): unknown[] {
  const byJl = new Map<string, Record<string, unknown>>();
  for (const et of earnTokens) {
    if (!et || typeof et !== "object") continue;
    const t = et as Record<string, unknown>;
    const jl = typeof t.address === "string" ? t.address.trim() : "";
    if (jl) byJl.set(jl, t);
  }

  return rows.map((row) => {
    if (!row || typeof row !== "object") return row;
    const r = row as Record<string, unknown>;
    const token = r.token as Record<string, unknown> | undefined;
    if (!token) return row;
    const jl = resolveJlMintFromToken(token);
    if (!jl) return row;
    const catalog = byJl.get(jl);
    if (!catalog) return row;

    return {
      ...r,
      token: {
        ...catalog,
        ...token,
        totalSupply: token.totalSupply ?? catalog.totalSupply,
        totalAssets: token.totalAssets ?? catalog.totalAssets,
        asset: token.asset ?? catalog.asset,
      },
    };
  });
}

/** Dedupe by `address` — first occurrence wins (prefer earlier list = e.g. official before lite). */
export function mergeEarnTokenCatalogArrays(parts: unknown[][]): unknown[] {
  const byAddr = new Map<string, unknown>();
  for (const part of parts) {
    if (!Array.isArray(part)) continue;
    for (const t of part) {
      if (!t || typeof t !== "object") continue;
      const rec = t as Record<string, unknown>;
      const addressValue = rec.address;
      const addr = typeof addressValue === "string" ? addressValue.trim() : "";
      if (!addr || byAddr.has(addr)) continue;
      byAddr.set(addr, t);
    }
  }
  return Array.from(byAddr.values());
}

/** Safe counts for meta: why wallet jl may not match API rows. */
export function computeJupiterMintDiagnostics(
  rows: unknown[],
  mintToBalance: Map<string, bigint>,
  earnTokens: unknown[]
): {
  earnTokensCatalogSize: number;
  jlMintAddressesFromApiRows: number;
  walletMintsThatMatchEarnJl: number;
  apiJlMintsThatHaveWalletBalance: number;
  walletMintPrefixes8?: string[];
  hint?: string;
} {
  const earnJl = new Set<string>();
  for (const et of earnTokens) {
    if (!et || typeof et !== "object") continue;
    const t = et as Record<string, unknown>;
    const jl = typeof t.address === "string" ? t.address.trim() : "";
    if (jl) earnJl.add(jl);
  }

  const apiJls = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const t = (row as Record<string, unknown>).token as Record<string, unknown> | undefined;
    const jl = resolveJlMintFromToken(t);
    if (jl) apiJls.add(jl);
  }

  let walletMintsThatMatchEarnJl = 0;
  for (const m of mintToBalance.keys()) {
    if (earnJl.has(m)) walletMintsThatMatchEarnJl += 1;
  }

  let apiJlMintsThatHaveWalletBalance = 0;
  for (const jl of apiJls) {
    if ((mintToBalance.get(jl) ?? BigInt(0)) > BigInt(0)) apiJlMintsThatHaveWalletBalance += 1;
  }

  const walletMintPrefixes8 =
    mintToBalance.size > 0
      ? Array.from(mintToBalance.keys())
          .sort()
          .map((m) => (m.length >= 8 ? m.slice(0, 8) : m))
      : undefined;

  let hint: string | undefined;
  if (mintToBalance.size > 0 && walletMintsThatMatchEarnJl === 0) {
    hint =
      "SPL mint(s) in this wallet do not match any Jupiter Lend jl receipt mint (merged lite + official /earn/tokens). Balances like USDC or SOL are not Lend positions; deposits are jl* tokens. Verify the address matches the wallet that holds jl.";
  }

  return {
    earnTokensCatalogSize: earnTokens.length,
    jlMintAddressesFromApiRows: apiJls.size,
    walletMintsThatMatchEarnJl,
    apiJlMintsThatHaveWalletBalance,
    walletMintPrefixes8,
    hint,
  };
}

/**
 * Jupiter Lend `/earn/positions` sometimes returns shares=0 while jl* SPL balances sit in the wallet.
 * We only **backfill** in that case: if API already reports non-zero shares/underlying, we trust it.
 * Adding wallet jl on top of non-zero API shares was doubling amounts on the UI.
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

    const jlMint = resolveJlMintFromToken(token);
    if (!jlMint) return row;

    const apiShares = parseBigIntSafe(r.shares);
    const walletJl = mintToBalance.get(jlMint) ?? BigInt(0);

    // Only fill from chain when API says "no shares" but wallet holds jl receipt tokens.
    if (apiShares > BigInt(0) || walletJl === BigInt(0)) return row;

    const effectiveShares = walletJl;

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

/**
 * When Lend `/earn/positions` omits a market row for the user but the wallet holds jl* SPL,
 * build positions from `GET /lend/v1/earn/tokens` + on-chain balances.
 */
export function appendSyntheticJupiterEarnPositionsFromWallet(
  rows: unknown[],
  mintToBalance: Map<string, bigint>,
  earnTokens: unknown[],
  ownerAddress: string
): { merged: unknown[]; rowsAppended: number } {
  const existingJl = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const t = (row as Record<string, unknown>).token as Record<string, unknown> | undefined;
    const addr = resolveJlMintFromToken(t);
    if (addr) existingJl.add(addr);
  }

  const out = [...rows];
  let rowsAppended = 0;

  for (const et of earnTokens) {
    if (!et || typeof et !== "object") continue;
    const token = et as Record<string, unknown>;
    const jl = typeof token.address === "string" ? token.address.trim() : "";
    if (!jl) continue;

    const bal = mintToBalance.get(jl) ?? BigInt(0);
    if (bal === BigInt(0)) continue;
    if (existingJl.has(jl)) continue;

    existingJl.add(jl);

    const totalSupply = parseBigIntSafe(token.totalSupply);
    const totalAssets = parseBigIntSafe(token.totalAssets);
    let underlyingRaw = BigInt(0);
    if (totalSupply > BigInt(0) && totalAssets > BigInt(0)) {
      underlyingRaw = (bal * totalAssets) / totalSupply;
    }

    out.push({
      token: et,
      ownerAddress: ownerAddress,
      shares: String(bal),
      underlyingAssets: String(underlyingRaw),
      underlyingBalance: "0",
      allowance: "0",
    });
    rowsAppended += 1;
  }

  return { merged: out, rowsAppended };
}
