import { NextRequest, NextResponse } from "next/server";
import Decimal from "decimal.js";
import { createSolanaRpc, address as toAddress } from "@solana/kit";
import { Farms, FarmState } from "@kamino-finance/farms-sdk";
import { JupiterTokenMetadataService } from "@/lib/services/solana/tokenMetadata";
import { getSafeSolanaRpcEndpoint } from "@/lib/solana/solanaRpcEndpoint";
import { isLikelySolanaAddress } from "@/lib/kamino/kvaultVaultAddress";

const DEFAULT_PUBKEY = "11111111111111111111111111111111";

type RewardRow = {
  tokenMint: string;
  tokenSymbol?: string;
  tokenLogoUrl?: string;
  amount: string; // ui amount
  usdValue?: number;
};

async function fetchJupiterUsdPriceMap(mints: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const uniq = Array.from(new Set(mints.map((m) => (m || "").trim()).filter(Boolean)));
  if (uniq.length === 0) return out;

  const CHUNK = 80;
  for (let i = 0; i < uniq.length; i += CHUNK) {
    const chunk = uniq.slice(i, i + CHUNK);
    const url = `https://api.jup.ag/tokens/v2/search?query=${encodeURIComponent(chunk.join(","))}`;
    try {
      const res = await fetch(url, { cache: "no-store", headers: { Accept: "application/json" } });
      if (!res.ok) continue;
      const rows = (await res.json().catch(() => [])) as Array<{ id?: string; usdPrice?: number }>;
      if (!Array.isArray(rows)) continue;
      for (const r of rows) {
        const id = typeof r?.id === "string" ? r.id.trim() : "";
        const p = typeof r?.usdPrice === "number" ? r.usdPrice : undefined;
        if (id && typeof p === "number" && Number.isFinite(p) && p > 0) out.set(id, p);
      }
    } catch {
      // ignore
    }
  }
  return out;
}

/**
 * GET /api/protocols/kamino/rewards?address=<solana_wallet>
 *
 * Returns pending rewards across all farms for the user (no claim).
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const address = (searchParams.get("address") || "").trim();
    if (!address) {
      return NextResponse.json({ success: false, error: "Address parameter is required", data: [] }, { status: 400 });
    }
    if (!isLikelySolanaAddress(address)) {
      return NextResponse.json({ success: false, error: "Invalid Solana wallet address", data: [] }, { status: 400 });
    }

    const rpc = createSolanaRpc(getSafeSolanaRpcEndpoint() as Parameters<typeof createSolanaRpc>[0]);
    const farms = new Farms(rpc);
    const user = toAddress(address);
    const currentTime = new Decimal(Math.floor(Date.now() / 1000));

    const userFarms = await farms.getAllFarmsForUser(user, currentTime);
    const farmAddresses = Array.from(userFarms.keys());
    if (farmAddresses.length === 0) {
      return NextResponse.json({ success: true, data: [], count: 0 });
    }

    const farmStates = await FarmState.fetchMultiple(rpc, farmAddresses);

    // Aggregate by reward mint.
    const byMint = new Map<string, Decimal>();
    for (let i = 0; i < farmAddresses.length; i++) {
      const farmAddress = farmAddresses[i];
      const farmState = farmStates[i];
      const userFarm = userFarms.get(farmAddress);
      if (!farmState || !userFarm) continue;

      const pending = Array.isArray((userFarm as { pendingRewards?: unknown }).pendingRewards)
        ? ((userFarm as { pendingRewards: any[] }).pendingRewards as any[])
        : [];
      const rewardInfos = Array.isArray((farmState as { rewardInfos?: unknown }).rewardInfos)
        ? ((farmState as { rewardInfos: any[] }).rewardInfos as any[])
        : [];

      for (let idx = 0; idx < pending.length; idx++) {
        const reward = pending[idx];
        const info = rewardInfos[idx];
        const mint = typeof reward?.rewardTokenMint?.toString === "function" ? String(reward.rewardTokenMint.toString()) : String(reward?.rewardTokenMint ?? "");
        if (!mint || mint === DEFAULT_PUBKEY) continue;
        const decimalsRaw = info?.token?.decimals?.toNumber?.();
        const decimals = typeof decimalsRaw === "number" && Number.isFinite(decimalsRaw) ? decimalsRaw : 0;
        const cum = new Decimal(String(reward?.cumulatedPendingRewards ?? "0"));
        if (!cum.isFinite() || cum.lte(0)) continue;
        const amountUi = cum.div(new Decimal(10).pow(decimals));
        if (!amountUi.isFinite() || amountUi.lte(0)) continue;
        byMint.set(mint, (byMint.get(mint) ?? new Decimal(0)).add(amountUi));
      }
    }

    const mints = Array.from(byMint.keys()).filter((m) => isLikelySolanaAddress(m));
    const metadataService = JupiterTokenMetadataService.getInstance();
    const metadataMap = (await metadataService.getMetadataMap(mints).catch(() => ({}))) as Record<
      string,
      { symbol?: string; logoUrl?: string }
    >;
    const priceMap = await fetchJupiterUsdPriceMap(mints);

    const rows: RewardRow[] = [];
    for (const mint of mints) {
      const amount = byMint.get(mint);
      if (!amount || !amount.isFinite() || amount.lte(0)) continue;
      const meta = metadataMap[mint] || {};
      const usdPrice = priceMap.get(mint);
      const usdValue = typeof usdPrice === "number" && Number.isFinite(usdPrice) ? amount.mul(usdPrice).toNumber() : undefined;
      rows.push({
        tokenMint: mint,
        tokenSymbol: meta.symbol,
        tokenLogoUrl: meta.logoUrl,
        amount: amount.toString(),
        usdValue,
      });
    }

    rows.sort((a, b) => (b.usdValue ?? 0) - (a.usdValue ?? 0));
    return NextResponse.json({ success: true, data: rows, count: rows.length });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ success: false, error: message, data: [] }, { status: 500 });
  }
}

