import { NextResponse } from "next/server";
import { InvestmentData } from "@/types/investments";
import { JupiterTokenMetadataService } from "@/lib/services/solana/tokenMetadata";
import { NATIVE_MINT } from "@solana/spl-token";
import { access } from "node:fs/promises";
import path from "node:path";

const KAMINO_API_BASE_URL = "https://api.kamino.finance";
const RETRY_ATTEMPTS = 5;
const RETRY_DELAY_MS = 2000;
const MIN_TVL_USD = 100_000;

type KaminoVaultRow = {
  address: string;
  state?: {
    name?: string;
    tokenMint?: string;
    tokenMintDecimals?: number;
    vaultFarm?: string;
  };
};

type KaminoVaultMetrics = {
  apy?: string | number;
  tokenPrice?: string | number;
  tokensAvailableUsd?: string | number;
  tokensInvestedUsd?: string | number;
};

function toNumber(value: unknown, fallback = 0): number {
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function toApyPct(apyFraction: unknown): number {
  // API returns APY as a fraction, e.g. 0.038... for 3.8%
  const apy = toNumber(apyFraction, 0);
  return apy * 100;
}

function normalizeLiquiditySymbol(symbol: string, mint: string): string {
  const nativeMint = NATIVE_MINT.toBase58();
  if (mint === nativeMint) return "SOL";
  return symbol;
}

function normalizeIconSymbol(symbol?: string | null): string {
  return (symbol ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

async function resolveLocalTokenIconBySymbol(symbol?: string | null): Promise<string | undefined> {
  const key = normalizeIconSymbol(symbol);
  if (!key) return undefined;

  const relativePath = `/token_ico/${key}.png`;
  const absolutePath = path.join(process.cwd(), "public", "token_ico", `${key}.png`);

  try {
    await access(absolutePath);
    return relativePath;
  } catch {
    return undefined;
  }
}

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

function isLikelyProductionVaultName(name: string): boolean {
  const n = name.trim().toLowerCase();
  if (!n) return false;
  // Exclude obvious internal/test/staging/dev labels from Ideas Pro protocol list.
  const deny = ["test", "stg", "staging", "dev", "dummy"];
  return !deny.some((k) => n.includes(k));
}

export async function GET() {
  try {
    const vaultsRes = await fetchWithRetry(`${KAMINO_API_BASE_URL}/kvaults/vaults`, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
    });

    if (!vaultsRes.ok) {
      console.warn("[Kamino][Pools] kvaults API unavailable, returning empty data", {
        status: vaultsRes.status,
        statusText: vaultsRes.statusText,
      });
      return NextResponse.json({
        success: true,
        data: [],
        count: 0,
      });
    }

    const allVaults = (await vaultsRes.json()) as KaminoVaultRow[];
    const vaults = Array.isArray(allVaults) ? allVaults : [];
    const candidates = vaults.filter((v) => {
      const vaultName = String(v.state?.name ?? "").trim();
      const tokenMint = String(v.state?.tokenMint ?? "").trim();
      return !!v.address && !!tokenMint && isLikelyProductionVaultName(vaultName);
    });

    const tokenMints = Array.from(new Set(candidates.map((v) => String(v.state?.tokenMint ?? "").trim())));

    // Best-effort metadata enrichment (symbol/decimals/logo). If it fails, we still return pools.
    let metadataMap: Record<string, { symbol?: string; decimals?: number; logoUrl?: string }> = {};
    try {
      const metadataService = JupiterTokenMetadataService.getInstance();
      const raw = await metadataService.getMetadataMap(tokenMints);
      metadataMap = raw as any;
    } catch (e) {
      console.warn("[Kamino] token metadata resolve failed, continuing without it", e);
    }

    const displaySymbolByMint = new Map<string, string>();
    for (const mint of tokenMints) {
      if (!mint || displaySymbolByMint.has(mint)) continue;
      const meta = metadataMap[mint];
      const fallback = mint === NATIVE_MINT.toBase58() ? "SOL" : "Unknown";
      displaySymbolByMint.set(mint, normalizeLiquiditySymbol(meta?.symbol || fallback, mint));
    }

    const iconByMint = new Map<string, string | undefined>();
    for (const [mint, symbol] of displaySymbolByMint.entries()) {
      iconByMint.set(mint, await resolveLocalTokenIconBySymbol(symbol));
    }

    const data: InvestmentData[] = [];
    // Sequential to avoid aggressive rate limits on /metrics endpoint.
    for (const v of candidates) {
      const vaultAddress = v.address;
      const vaultName = String(v.state?.name ?? "").trim();
      const tokenMint = String(v.state?.tokenMint ?? "").trim();
      if (!vaultAddress || !vaultName || !tokenMint) continue;

      let metrics: KaminoVaultMetrics | null = null;
      try {
        const mr = await fetchWithRetry(`${KAMINO_API_BASE_URL}/kvaults/vaults/${vaultAddress}/metrics`, {
          method: "GET",
          headers: { Accept: "application/json" },
          cache: "no-store",
        });
        if (!mr.ok) continue;
        metrics = (await mr.json().catch(() => null)) as KaminoVaultMetrics | null;
      } catch {
        continue;
      }
      if (!metrics) continue;

      const depositApy = toApyPct(metrics.apy);
      if (depositApy < 1) continue;

      const tvlUSD = toNumber(metrics.tokensInvestedUsd, 0) + toNumber(metrics.tokensAvailableUsd, 0);
      if (tvlUSD < MIN_TVL_USD) continue;
      const meta = metadataMap[tokenMint];
      const symbol = displaySymbolByMint.get(tokenMint) || "Unknown";
      const localIcon = iconByMint.get(tokenMint);

      data.push({
        // For Ideas Pro: show vault market name from kvault catalog.
        asset: vaultName,
        provider: "Kamino",
        totalAPY: depositApy,
        depositApy,
        // KVaults are yield vaults; borrow APR is not part of this product surface.
        borrowAPY: 0,
        token: tokenMint,
        tokenDecimals: typeof meta?.decimals === "number" ? meta.decimals : undefined,
        protocol: "Kamino",
        logoUrl: localIcon || meta?.logoUrl,
        tvlUSD,
        dailyVolumeUSD: 0,
        poolType: "Vault",
        originalPool: {
          vaultAddress,
          vaultName,
          tokenMint,
          tokenSymbol: symbol,
          vaultFarm: v.state?.vaultFarm,
        },
      });
    }

    data.sort((a, b) => (b.totalAPY || 0) - (a.totalAPY || 0));

    return NextResponse.json(
      {
        success: true,
        data,
        count: data.length,
      },
      {
        headers: {
          "Cache-Control": "public, max-age=120, s-maxage=120, stale-while-revalidate=300",
          "Cdn-Cache-Control": "max-age=120",
          "Surrogate-Control": "max-age=120",
        },
      }
    );
  } catch (error) {
    console.warn("[Kamino][Pools] fallback to empty data after retries", error);
    return NextResponse.json({
      success: true,
      data: [],
      count: 0,
    });
  }
}

