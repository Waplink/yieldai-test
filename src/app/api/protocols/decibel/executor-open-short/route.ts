import { NextRequest, NextResponse } from "next/server";
import { normalizeAddress, toCanonicalAddress } from "@/lib/utils/addressNormalization";
import { buildConfigureUserSettingsPayload } from "@/lib/protocols/decibel/configureUserSettings";
import { buildOpenMarketOrderPayload, type DecibelMarketConfig } from "@/lib/protocols/decibel/closePosition";
import { getDecibelExecutorAccount, submitExecutorEntryFunction } from "@/lib/protocols/decibel/executorSubmit";

type DelegationDto = {
  delegated_account?: string;
  permission_type?: string;
  expiration_time_s?: number | null;
};

const DECIBEL_API_KEY = process.env.DECIBEL_API_KEY;
const DECIBEL_API_BASE_URL =
  process.env.DECIBEL_API_BASE_URL || "https://api.testnet.aptoslabs.com/decibel";

const DEFAULT_MIN_SIZE_USD = 10;
const DEFAULT_MAX_SIZE_USD = 100;

function parseAllowlist(): string[] {
  const raw = process.env.DECIBEL_EXECUTOR_ALLOWLIST || "";
  return raw
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
    .map((v) => normalizeAddress(toCanonicalAddress(v)));
}

function getSizeLimits() {
  const minRaw = Number(process.env.DECIBEL_EXECUTOR_MIN_SIZE_USD ?? DEFAULT_MIN_SIZE_USD);
  const maxRaw = Number(process.env.DECIBEL_EXECUTOR_MAX_SIZE_USD ?? DEFAULT_MAX_SIZE_USD);
  const min = Number.isFinite(minRaw) && minRaw > 0 ? minRaw : DEFAULT_MIN_SIZE_USD;
  const max = Number.isFinite(maxRaw) && maxRaw >= min ? maxRaw : DEFAULT_MAX_SIZE_USD;
  return { min, max };
}

async function fetchDecibel(path: string) {
  if (!DECIBEL_API_KEY) throw new Error("Decibel API key not configured");
  const baseUrl = DECIBEL_API_BASE_URL.replace(/\/$/, "");
  const res = await fetch(`${baseUrl}${path}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${DECIBEL_API_KEY}`,
      "Content-Type": "application/json",
    },
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error("Invalid response from Decibel API");
  }
  if (!res.ok) {
    const msg =
      typeof data === "object" && data !== null && "message" in (data as object)
        ? String((data as { message?: string }).message)
        : `Decibel API error: ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

function resolveMarketForAsset(
  asset: "BTC" | "APT",
  markets: Array<DecibelMarketConfig & { market_addr?: string; market_name?: string }>
): (DecibelMarketConfig & { market_addr: string; market_name: string }) | null {
  const extractBaseSymbol = (name: string): string => {
    const upper = name.toUpperCase();
    return upper.split(/[-/_\s]/)[0] || upper;
  };
  const candidates = markets.filter((m) => {
    const name = (m.market_name || "").toUpperCase();
    if (!name) return false;
    if (name.startsWith(`${asset}-`) || name.startsWith(`${asset}/`) || name.startsWith(`${asset}_`)) {
      return true;
    }
    return extractBaseSymbol(name) === asset;
  });
  const selected = candidates[0];
  if (!selected?.market_addr || !selected?.market_name) return null;
  return {
    ...selected,
    market_addr: selected.market_addr,
    market_name: selected.market_name,
  };
}

function normalizeMarketsPayload(data: unknown): Array<DecibelMarketConfig & { market_addr?: string; market_name?: string }> {
  if (Array.isArray(data)) return data as Array<DecibelMarketConfig & { market_addr?: string; market_name?: string }>;
  if (!data || typeof data !== "object") return [];
  const obj = data as Record<string, unknown>;
  const candidates: unknown[] = [];
  if (Array.isArray(obj.items)) candidates.push(...obj.items);
  if (Array.isArray(obj.markets)) candidates.push(...obj.markets);
  if (Array.isArray(obj.data)) candidates.push(...obj.data);
  return candidates as Array<DecibelMarketConfig & { market_addr?: string; market_name?: string }>;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const subaccountRaw = typeof body.subaccount === "string" ? body.subaccount.trim() : "";
    const ownerRaw = typeof body.owner === "string" ? body.owner.trim() : "";
    const assetRaw = typeof body.asset === "string" ? body.asset.trim().toUpperCase() : "";
    const sizeUsd = Number(body.sizeUsd);

    if (!subaccountRaw || !ownerRaw) {
      return NextResponse.json(
        { success: false, error: "subaccount and owner are required" },
        { status: 400 }
      );
    }

    const canonicalSubaccount = toCanonicalAddress(subaccountRaw);
    const canonicalOwner = toCanonicalAddress(ownerRaw);
    if (!canonicalSubaccount.startsWith("0x") || !canonicalOwner.startsWith("0x")) {
      return NextResponse.json({ success: false, error: "Invalid address" }, { status: 400 });
    }

    const allowlist = parseAllowlist();
    if (
      allowlist.length > 0 &&
      !allowlist.includes(normalizeAddress(canonicalOwner))
    ) {
      return NextResponse.json(
        { success: false, error: "Owner is not allowlisted for executor trading" },
        { status: 403 }
      );
    }

    if (assetRaw !== "BTC" && assetRaw !== "APT") {
      return NextResponse.json(
        { success: false, error: "asset must be BTC or APT" },
        { status: 400 }
      );
    }

    const { min, max } = getSizeLimits();
    if (!Number.isFinite(sizeUsd) || sizeUsd < min || sizeUsd > max) {
      return NextResponse.json(
        {
          success: false,
          error: `sizeUsd must be between ${min} and ${max}`,
        },
        { status: 400 }
      );
    }

    const executorAddress = toCanonicalAddress(
      getDecibelExecutorAccount().accountAddress.toString()
    );
    if (!executorAddress) {
      return NextResponse.json(
        { success: false, error: "Executor address is not configured" },
        { status: 503 }
      );
    }

    const delegations = (await fetchDecibel(
      `/api/v1/delegations?subaccount=${encodeURIComponent(canonicalSubaccount)}`
    )) as DelegationDto[];
    const hasDelegation = (Array.isArray(delegations) ? delegations : []).some((item) => {
      const delegated = item.delegated_account ? toCanonicalAddress(item.delegated_account) : "";
      const notExpired =
        typeof item.expiration_time_s === "number"
          ? item.expiration_time_s > Math.floor(Date.now() / 1000)
          : true;
      const permission = (item.permission_type || "").toLowerCase();
      const canTrade = permission.includes("trade");
      const canTradePerps = permission.includes("perp");
      return (
        delegated &&
        normalizeAddress(delegated) === normalizeAddress(executorAddress) &&
        notExpired &&
        canTrade &&
        canTradePerps
      );
    });
    if (!hasDelegation) {
      return NextResponse.json(
        { success: false, error: "No active delegation to executor for this subaccount" },
        { status: 403 }
      );
    }

    const marketsRaw = await fetchDecibel("/api/v1/markets");
    const markets = normalizeMarketsPayload(marketsRaw);
    const selectedMarket = resolveMarketForAsset(assetRaw, markets);
    if (!selectedMarket) {
      return NextResponse.json(
        { success: false, error: `Market not found for asset ${assetRaw}` },
        { status: 404 }
      );
    }

    const prices = (await fetchDecibel(
      `/api/v1/prices?market=${encodeURIComponent(selectedMarket.market_addr)}`
    )) as Array<{ mark_px?: number; mid_px?: number }>;
    const firstPrice = Array.isArray(prices) ? prices[0] : null;
    const markPx = Number(firstPrice?.mark_px ?? firstPrice?.mid_px ?? NaN);
    if (!Number.isFinite(markPx) || markPx <= 0) {
      return NextResponse.json(
        { success: false, error: "Failed to resolve mark price for market order" },
        { status: 502 }
      );
    }

    const isTestnet = DECIBEL_API_BASE_URL.includes("testnet");
    const network = isTestnet ? "testnet" : "mainnet";

    const configurePayload = buildConfigureUserSettingsPayload({
      subaccountAddr: canonicalSubaccount,
      marketAddr: selectedMarket.market_addr,
      isCross: true,
      userLeverage: 1,
      isTestnet,
    });
    const configureTxHash = await submitExecutorEntryFunction({
      network,
      fn: configurePayload.function,
      functionArguments: configurePayload.functionArguments as (string | number | boolean | bigint | null)[],
      maxGasAmount: 20_000,
    });

    const openPayload = buildOpenMarketOrderPayload({
      subaccountAddr: canonicalSubaccount,
      marketAddr: selectedMarket.market_addr,
      orderSizeUsd: sizeUsd,
      markPx,
      marketConfig: selectedMarket,
      isLong: false,
      slippageBps: 50,
      isTestnet,
    });
    const openTxHash = await submitExecutorEntryFunction({
      network,
      fn: openPayload.function,
      functionArguments: openPayload.functionArguments as (string | number | boolean | bigint | null)[],
      maxGasAmount: 30_000,
    });

    return NextResponse.json({
      success: true,
      data: {
        subaccount: canonicalSubaccount,
        owner: canonicalOwner,
        asset: assetRaw,
        sizeUsd,
        marketAddr: selectedMarket.market_addr,
        marketName: selectedMarket.market_name,
        configureTxHash,
        openTxHash,
      },
    });
  } catch (error) {
    console.error("[Decibel] executor-open-short error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
