import { NextRequest, NextResponse } from "next/server";
import { JupiterTokenMetadataService } from "@/lib/services/solana/tokenMetadata";
import { extractKvaultVaultAddress, isLikelySolanaAddress } from "@/lib/kamino/kvaultVaultAddress";

const KAMINO_API_BASE_URL = "https://api.kamino.finance";
const RETRY_ATTEMPTS = 5;
const RETRY_DELAY_MS = 2000;
const KNOWN_SOLANA_TOKEN_BY_MINT: Record<string, { symbol: string; logoUrl?: string }> = {
  // Wrapped SOL
  So11111111111111111111111111111111111111112: { symbol: "SOL", logoUrl: "/token_ico/sol.png" },
  // Stables / majors used across Jupiter/Kamino
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: "USDC", logoUrl: "/token_ico/usdc.png" },
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { symbol: "USDT", logoUrl: "/token_ico/usdt.png" },
  "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH": { symbol: "USDG", logoUrl: "/token_ico/usdg.png" },
  USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA: { symbol: "USDS", logoUrl: "/token_ico/usds.png" },
  JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD: { symbol: "JupUSD", logoUrl: "/token_ico/jupusd.png" },
  HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr: { symbol: "EURC", logoUrl: "/token_ico/eurc.png" },
};

type KaminoMarketRow = {
  lendingMarket: string;
  name?: string;
  isPrimary?: boolean;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, init);
      if (response.ok) return response;

      const shouldRetry =
        response.status === 502 || response.status === 503 || response.status === 504;

      if (!shouldRetry || attempt === RETRY_ATTEMPTS) {
        return response;
      }
    } catch (error) {
      lastError = error;
      if (attempt === RETRY_ATTEMPTS) break;
    }

    await sleep(RETRY_DELAY_MS);
  }

  throw lastError instanceof Error ? lastError : new Error("Kamino request failed after retries");
}

function hasEarnVaultBalance(item: unknown): boolean {
  if (!item || typeof item !== "object") return false;
  const o = item as Record<string, unknown>;
  const total = Number.parseFloat(String(o.totalShares ?? "0"));
  const staked = Number.parseFloat(String(o.stakedShares ?? "0"));
  const unstaked = Number.parseFloat(String(o.unstakedShares ?? "0"));
  return (
    (Number.isFinite(total) && total > 0) ||
    (Number.isFinite(staked) && staked > 0) ||
    (Number.isFinite(unstaked) && unstaked > 0)
  );
}

type KaminoVaultMeta = {
  vaultAddress: string;
  vaultName?: string;
  tokenMint?: string;
  tokenSymbol?: string;
  tokenLogoUrl?: string;
};

function buildVaultAddressToMetaMap(vaults: KaminoVaultCatalogRow[]): Map<string, KaminoVaultMeta> {
  const m = new Map<string, KaminoVaultMeta>();
  for (const v of vaults) {
    const addr = typeof v?.address === "string" ? v.address.trim() : "";
    if (!addr) continue;
    const vaultName = typeof v.state?.name === "string" ? v.state.name.trim() : undefined;
    const tokenMint = typeof v.state?.tokenMint === "string" ? v.state.tokenMint.trim() : undefined;
    const known = tokenMint ? KNOWN_SOLANA_TOKEN_BY_MINT[tokenMint] : undefined;
    m.set(addr, {
      vaultAddress: addr,
      vaultName,
      tokenMint,
      tokenSymbol: known?.symbol,
      tokenLogoUrl: known?.logoUrl,
    });
  }
  return m;
}

function enrichEarnPositionPayload(pos: unknown, vaultMetaByAddress: Map<string, KaminoVaultMeta>): unknown {
  const vaultAddress = extractKvaultVaultAddress(pos);
  if (!vaultAddress || !pos || typeof pos !== "object") return pos;
  const o = pos as Record<string, unknown>;
  const meta = vaultMetaByAddress.get(vaultAddress);

  const out: Record<string, unknown> = { ...o, vaultAddress };
  if (meta?.vaultName && typeof out.vaultName !== "string") out.vaultName = meta.vaultName;
  if (meta?.tokenMint && typeof out.tokenMint !== "string") out.tokenMint = meta.tokenMint;
  if (meta?.tokenSymbol && typeof out.tokenSymbol !== "string") out.tokenSymbol = meta.tokenSymbol;
  if (meta?.tokenLogoUrl && typeof out.tokenLogoUrl !== "string") out.tokenLogoUrl = meta.tokenLogoUrl;
  return out;
}

function parseDecimalField(value: unknown): number | undefined {
  const n = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(n) ? n : undefined;
}

async function fetchKaminoEarnPositionUsd(vaultAddress: string, walletAddress: string): Promise<number | undefined> {
  const url = `${KAMINO_API_BASE_URL}/kvaults/${encodeURIComponent(vaultAddress)}/users/${encodeURIComponent(walletAddress)}/pnl`;
  try {
    const res = await fetchWithRetry(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!res.ok) return undefined;
    const pnl = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!pnl || typeof pnl !== "object") return undefined;

    // Prefer explicit current position value if API provides it.
    const directUsd =
      parseDecimalField((pnl as Record<string, unknown>).positionUsd) ??
      parseDecimalField((pnl as Record<string, unknown>).positionValueUsd) ??
      parseDecimalField((pnl as Record<string, unknown>).position_value_usd) ??
      parseDecimalField((pnl.positionValue as Record<string, unknown> | undefined)?.usd);
    if (directUsd !== undefined) return directUsd;

    // Fallback: cost basis + pnl.
    const costBasisUsd = parseDecimalField((pnl.totalCostBasis as Record<string, unknown> | undefined)?.usd);
    const totalPnlUsd = parseDecimalField((pnl.totalPnl as Record<string, unknown> | undefined)?.usd);
    if (costBasisUsd !== undefined || totalPnlUsd !== undefined) {
      return (costBasisUsd ?? 0) + (totalPnlUsd ?? 0);
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export type KaminoUserPositionRow =
  | {
      source: "kamino-lend";
      marketPubkey: string;
      marketName?: string;
      obligation: unknown;
    }
  | {
      source: "kamino-earn";
      position: unknown;
    }
  | {
      /** Steakhouse / vault “farms” — not KLend obligations; see GET /farms/users/{wallet}/transactions */
      source: "kamino-farm";
      farmPubkey: string;
      tokenMint: string;
      tokenSymbol?: string;
      tokenLogoUrl?: string;
      netTokenAmount: string;
      netUsdAmount: string;
      lastActivity: string;
      transactionCount: number;
      /** kVault vault pubkey for SDK (resolved from /kvaults/vaults via vault address or state.vaultFarm). */
      vaultAddress?: string;
      vaultName?: string;
    };

type KaminoVaultCatalogRow = {
  address: string;
  state?: {
    name?: string;
    tokenMint?: string;
    vaultFarm?: string;
  };
};

/** Map farm transaction `farm` field and vault pubkey to the kVault address used by the SDK. */
function buildFarmPubkeyToVaultMap(vaults: KaminoVaultCatalogRow[]): Map<string, { vaultAddress: string; vaultName?: string }> {
  const m = new Map<string, { vaultAddress: string; vaultName?: string }>();
  for (const v of vaults) {
    if (!v?.address) continue;
    const name = typeof v.state?.name === "string" ? v.state.name.trim() : undefined;
    const info = { vaultAddress: v.address, vaultName: name };
    m.set(v.address, info);
    const vf = v.state?.vaultFarm;
    if (typeof vf === "string" && vf.trim()) {
      m.set(vf.trim(), info);
    }
  }
  return m;
}

type KaminoFarmTx = {
  instruction?: string;
  createdOn?: string;
  transactionSignature?: string;
  tokenAmount?: string;
  usdAmount?: string;
  farm?: string;
  token?: string;
};

function parseAmountSigned(tx: KaminoFarmTx): { token: number; usd: number } {
  const token = Number.parseFloat(String(tx.tokenAmount ?? "0"));
  const usd = Number.parseFloat(String(tx.usdAmount ?? "0"));
  const ins = String(tx.instruction ?? "").toLowerCase();
  let sign = 0;
  if (ins === "deposit" || ins === "claim" || ins === "compound" || ins === "stake") sign = 1;
  else if (ins === "withdraw" || ins === "unstake") sign = -1;
  else if (ins === "pending-withdraw") sign = 0;
  else sign = 0;
  return {
    token: Number.isFinite(token) ? token * sign : 0,
    usd: Number.isFinite(usd) ? usd * sign : 0,
  };
}

async function fetchAllFarmUserTransactions(address: string): Promise<KaminoFarmTx[]> {
  const out: KaminoFarmTx[] = [];
  let paginationToken: string | undefined;

  for (let page = 0; page < 25; page++) {
    const url = new URL(`${KAMINO_API_BASE_URL}/farms/users/${address}/transactions`);
    url.searchParams.set("limit", "200");
    if (paginationToken) url.searchParams.set("paginationToken", paginationToken);

    const res = await fetchWithRetry(url.toString(), {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
    });

    if (!res.ok) break;

    const payload = (await res.json().catch(() => null)) as {
      result?: KaminoFarmTx[];
      paginationToken?: string;
    } | null;

    const batch = Array.isArray(payload?.result) ? payload.result : [];
    out.push(...batch);

    paginationToken =
      typeof payload?.paginationToken === "string" && payload.paginationToken.length > 0
        ? payload.paginationToken
        : undefined;

    if (!paginationToken || batch.length === 0) break;
  }

  return out;
}

function aggregateFarmPositions(transactions: KaminoFarmTx[]): KaminoUserPositionRow[] {
  type Agg = {
    farm: string;
    token: string;
    netToken: number;
    netUsd: number;
    lastActivity: string;
    count: number;
  };

  const map = new Map<string, Agg>();

  for (const tx of transactions) {
    const farm = typeof tx.farm === "string" ? tx.farm.trim() : "";
    const token = typeof tx.token === "string" ? tx.token.trim() : "";
    if (!farm || !token) continue;

    const { token: dToken, usd: dUsd } = parseAmountSigned(tx);
    if (dToken === 0 && dUsd === 0) continue;

    const key = `${farm}:${token}`;
    const prev = map.get(key);
    const created = String(tx.createdOn ?? "");
    const next: Agg = prev ?? {
      farm,
      token,
      netToken: 0,
      netUsd: 0,
      lastActivity: created,
      count: 0,
    };

    next.netToken += dToken;
    next.netUsd += dUsd;
    next.count += 1;
    if (created && (!next.lastActivity || created > next.lastActivity)) {
      next.lastActivity = created;
    }

    map.set(key, next);
  }

  const rows: KaminoUserPositionRow[] = [];
  for (const a of map.values()) {
    if (Math.abs(a.netToken) < 1e-12 && Math.abs(a.netUsd) < 1e-12) continue;
    rows.push({
      source: "kamino-farm",
      farmPubkey: a.farm,
      tokenMint: a.token,
      netTokenAmount: String(a.netToken),
      netUsdAmount: String(a.netUsd),
      lastActivity: a.lastActivity,
      transactionCount: a.count,
    });
  }

  return rows;
}

async function enrichFarmRowsWithTokenMetadata(rows: KaminoUserPositionRow[]): Promise<KaminoUserPositionRow[]> {
  const farmRows = rows.filter(
    (r): r is Extract<KaminoUserPositionRow, { source: "kamino-farm" }> => r.source === "kamino-farm"
  );
  if (farmRows.length === 0) return rows;

  const mints = Array.from(new Set(farmRows.map((r) => r.tokenMint).filter(Boolean)));
  if (mints.length === 0) return rows;

  let metadataMap: Record<string, { symbol?: string; logoUrl?: string }> = {};
  try {
    const metadataService = JupiterTokenMetadataService.getInstance();
    metadataMap = (await metadataService.getMetadataMap(mints)) as Record<string, { symbol?: string; logoUrl?: string }>;
  } catch {
    metadataMap = {};
  }

  return rows.map((r) => {
    if (r.source !== "kamino-farm") return r;
    const meta = metadataMap[r.tokenMint] || {};
    const known = KNOWN_SOLANA_TOKEN_BY_MINT[r.tokenMint];
    return {
      ...r,
      tokenSymbol: meta.symbol || known?.symbol || undefined,
      tokenLogoUrl: meta.logoUrl || known?.logoUrl || undefined,
    };
  });
}

/**
 * GET /api/protocols/kamino/userPositions?address=<solana_wallet>
 *
 * Aggregates:
 * - Kamino Lend: GET /kamino-market/{market}/users/{wallet}/obligations (all markets from v2/kamino-market)
 * - Kamino Earn: GET /kvaults/users/{wallet}/positions
 * - Kamino Farms (Steakhouse-style vaults): GET /farms/users/{wallet}/transactions (aggregated net per farm+token)
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const address = (searchParams.get("address") || "").trim();

    if (!address) {
      return NextResponse.json(
        { success: false, error: "Address parameter is required", data: [], count: 0 },
        { status: 400 }
      );
    }

    if (!isLikelySolanaAddress(address)) {
      return NextResponse.json(
        { success: false, error: "Invalid Solana wallet address", data: [], count: 0 },
        { status: 400 }
      );
    }

    const marketsRes = await fetchWithRetry(`${KAMINO_API_BASE_URL}/v2/kamino-market`, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
    });

    if (!marketsRes.ok) {
      const text = await marketsRes.text().catch(() => "");
      throw new Error(`Kamino markets API returned ${marketsRes.status}${text ? `: ${text}` : ""}`);
    }

    const markets = (await marketsRes.json()) as KaminoMarketRow[];
    const marketList = Array.isArray(markets) ? markets : [];

    // kVault catalog used to enrich both Earn positions and Farm aggregations.
    let vaultCatalog: KaminoVaultCatalogRow[] = [];
    try {
      const vaultsRes = await fetchWithRetry(`${KAMINO_API_BASE_URL}/kvaults/vaults`, {
        method: "GET",
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (vaultsRes.ok) {
        const j = await vaultsRes.json().catch(() => []);
        vaultCatalog = Array.isArray(j) ? j : [];
      }
    } catch {
      vaultCatalog = [];
    }
    const vaultMetaByAddress = buildVaultAddressToMetaMap(vaultCatalog);

    const obligationResults = await Promise.all(
      marketList.map(async (m) => {
        if (!m?.lendingMarket) {
          return { market: m, obligations: [] as unknown[] };
        }
        const url = `${KAMINO_API_BASE_URL}/kamino-market/${m.lendingMarket}/users/${address}/obligations?env=mainnet-beta`;
        try {
          const res = await fetchWithRetry(url, {
            method: "GET",
            headers: { Accept: "application/json" },
            cache: "no-store",
          });
          if (!res.ok) {
            return { market: m, obligations: [] as unknown[] };
          }
          const payload = await res.json().catch(() => []);
          return {
            market: m,
            obligations: Array.isArray(payload) ? payload : [],
          };
        } catch {
          return { market: m, obligations: [] as unknown[] };
        }
      })
    );

    const flat: KaminoUserPositionRow[] = [];

    for (const { market, obligations } of obligationResults) {
      if (!obligations.length) continue;
      for (const obligation of obligations) {
        flat.push({
          source: "kamino-lend",
          marketPubkey: market.lendingMarket,
          marketName: market.name,
          obligation,
        });
      }
    }

    let earnRaw: unknown[] = [];
    try {
      const kvRes = await fetchWithRetry(
        `${KAMINO_API_BASE_URL}/kvaults/users/${address}/positions`,
        {
          method: "GET",
          headers: { Accept: "application/json" },
          cache: "no-store",
        }
      );
      if (kvRes.ok) {
        const kvJson = await kvRes.json().catch(() => []);
        earnRaw = Array.isArray(kvJson) ? kvJson : [];
      }
    } catch {
      earnRaw = [];
    }

    for (const pos of earnRaw) {
      if (!hasEarnVaultBalance(pos)) continue;
      const enriched = enrichEarnPositionPayload(pos, vaultMetaByAddress);
      const vaultAddress = extractKvaultVaultAddress(enriched);
      if (!vaultAddress || !enriched || typeof enriched !== "object") {
        flat.push({ source: "kamino-earn", position: enriched });
        continue;
      }

      const positionUsd = await fetchKaminoEarnPositionUsd(vaultAddress, address);
      if (positionUsd === undefined) {
        flat.push({ source: "kamino-earn", position: enriched });
        continue;
      }

      const withUsd = {
        ...(enriched as Record<string, unknown>),
        // Keep multiple aliases so current UI resolvers pick it up without fragile coupling.
        positionUsd,
        positionValueUsd: positionUsd,
        totalValueUsd: positionUsd,
      };
      flat.push({ source: "kamino-earn", position: withUsd });
    }

    let farmTx: KaminoFarmTx[] = [];
    try {
      farmTx = await fetchAllFarmUserTransactions(address);
    } catch {
      farmTx = [];
    }

    const farmRows = aggregateFarmPositions(farmTx);
    const farmRowsWithMeta = await enrichFarmRowsWithTokenMetadata(farmRows);

    const farmToVault = buildFarmPubkeyToVaultMap(vaultCatalog);
    const farmRowsResolved = farmRowsWithMeta.map((r) => {
      if (r.source !== "kamino-farm") return r;
      const meta = farmToVault.get(r.farmPubkey.trim());
      if (!meta) return r;
      return {
        ...r,
        vaultAddress: meta.vaultAddress,
        vaultName: meta.vaultName,
      };
    });
    flat.push(...farmRowsResolved);

    return NextResponse.json({
      success: true,
      data: flat,
      count: flat.length,
      meta: {
        marketsQueried: marketList.length,
        lendPositions: flat.filter((r) => r.source === "kamino-lend").length,
        earnPositions: flat.filter((r) => r.source === "kamino-earn").length,
        farmPositions: flat.filter((r) => r.source === "kamino-farm").length,
        farmTransactionsFetched: farmTx.length,
      },
    });
  } catch (error) {
    console.error("[Kamino] userPositions error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
        data: [],
        count: 0,
      },
      { status: 500 }
    );
  }
}
