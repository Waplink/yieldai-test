import { Aptos, AptosConfig, Network } from "@aptos-labs/ts-sdk";
import { toCanonicalAddress } from "@/lib/utils/addressNormalization";
import {
  APTOS_COIN_TYPE,
  COIN_BALANCE_VIEW,
  YIELD_AI_VAULT_VIEWS,
  USDC_FA_METADATA_MAINNET,
  MOAR_ADAPTER_ADDRESS_MAINNET,
  APT_CLAIM_THRESHOLD_OCTAS,
  USDC_DEPOSIT_THRESHOLD_BASE_UNITS,
  APT_SWAP_RESERVE_OCTAS,
  USDC_DEPOSIT_RESERVE_BASE_UNITS,
  APT_REWARD_ID,
  APT_FARMING_IDENTIFIER,
  SWAP_FEE_TIER,
  SWAP_AMOUNT_OUT_MIN,
  SWAP_SQRT_PRICE_LIMIT,
  SWAP_DEADLINE_SECONDS,
} from "@/lib/constants/yieldAiVault";
import {
  executeClaimApt,
  executeSwapAptToUsdc,
  executeDepositToMoar,
} from "@/lib/protocols/yield-ai/vaultExecutor";

const config = new AptosConfig({
  network: Network.MAINNET,
  ...(process.env.APTOS_API_KEY && {
    clientConfig: {
      HEADERS: { Authorization: `Bearer ${process.env.APTOS_API_KEY}` },
    },
  }),
});

const aptos = new Aptos(config);

function parseBool(v: any): boolean {
  if (typeof v === "boolean") return v;
  const s = String(v).toLowerCase();
  return s === "true" || s === "1";
}

function parseNumber(v: any): number {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  const s = String(v);
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function toBigIntSafe(v: any): bigint {
  try {
    if (typeof v === "bigint") return v;
    if (typeof v === "number") return BigInt(Math.trunc(v));
    return BigInt(String(v));
  } catch {
    return 0n;
  }
}

function envBigInt(name: string, fallback: bigint): bigint {
  const raw = process.env[name];
  if (raw == null) return fallback;
  try {
    return BigInt(raw);
  } catch {
    return fallback;
  }
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array<R>(items.length);
  let idx = 0;

  const workers = Array.from({ length: limit }, async () => {
    while (true) {
      const current = idx++;
      if (current >= items.length) return;
      results[current] = await mapper(items[current], current);
    }
  });

  await Promise.all(workers);
  return results;
}

type SafeEntry = {
  safe_address: string;
  owner?: string;
  paused: boolean;
  exists: boolean;
};

function parseSafeEntry(raw: any): SafeEntry | null {
  if (!raw) return null;

  // Case 1: object shape
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const safe_address =
      raw.safe_address ?? raw.safeAddress ?? raw.safe_addr ?? raw.safe ?? null;
    if (typeof safe_address !== "string") return null;

    const paused = parseBool(raw.paused ?? raw.isPaused ?? raw.paused_ ?? false);
    const exists = parseBool(raw.exists ?? raw.exists_ ?? raw.isExists ?? true);
    return {
      safe_address,
      owner: typeof raw.owner === "string" ? raw.owner : undefined,
      paused,
      exists,
    };
  }

  // Case 2: tuple / array shape: (safe_address, owner, paused, exists)
  if (Array.isArray(raw)) {
    const [safe_address, owner, paused, exists] = raw;
    if (typeof safe_address !== "string") return null;
    return {
      safe_address,
      owner: typeof owner === "string" ? owner : undefined,
      paused: parseBool(paused),
      exists: parseBool(exists),
    };
  }

  return null;
}

async function getAptBalanceBaseUnits(safeAddress: string): Promise<bigint> {
  const addr = toCanonicalAddress(safeAddress);
  const res = await aptos.view({
    payload: {
      function: COIN_BALANCE_VIEW,
      typeArguments: [APTOS_COIN_TYPE],
      functionArguments: [addr],
    },
  });

  const raw = Array.isArray(res) ? res[0] : (res as any);
  return toBigIntSafe(raw);
}

async function getUsdcBalanceBaseUnitsViaView(safeAddress: string): Promise<bigint> {
  // USDC is an FA. We read its balance via on-chain view:
  // primary_fungible_store::balance<0x1::fungible_asset::Metadata>(owner, metadata_object)
  const safeAddr = toCanonicalAddress(safeAddress);
  const metadataAddr = toCanonicalAddress(USDC_FA_METADATA_MAINNET);

  const res = await aptos.view({
    payload: {
      function: "0x1::primary_fungible_store::balance",
      typeArguments: ["0x1::fungible_asset::Metadata"],
      functionArguments: [safeAddr, metadataAddr],
    },
  });

  const raw = Array.isArray(res) ? res[0] : (res as any);
  return toBigIntSafe(raw);
}

async function getTotalSafes(): Promise<number> {
  const res = await aptos.view({
    payload: {
      function: YIELD_AI_VAULT_VIEWS.getTotalSafes,
      typeArguments: [],
      functionArguments: [],
    },
  });

  const raw = Array.isArray(res) ? res[0] : (res as any);
  return parseNumber(raw);
}

async function getSafesRangeInfo(start: number, limit: number): Promise<SafeEntry[]> {
  const res = await aptos.view({
    payload: {
      function: YIELD_AI_VAULT_VIEWS.getSafesRangeInfo,
      typeArguments: [],
      functionArguments: [String(start), String(limit)],
    },
  });

  // Some view calls return [vec] as the first element, others return vec directly.
  const maybeVec = Array.isArray(res) ? res[0] : res;
  const list = Array.isArray(maybeVec) ? maybeVec : Array.isArray(res) ? res : [];
  const parsed = list
    .map((x: any) => parseSafeEntry(x))
    .filter((x: SafeEntry | null) => x != null) as SafeEntry[];

  return parsed;
}

export type YieldAiVaultCronRunResult = {
  runId: string;
  startedAtUnixMs: number;
  totalSafes: number;
  pageSize: number;
  maxSafesProcessedPerRun: number;
  maxTxPerRun: number;
  processedSafes: number;
  txCount: number;
  claimedSafes: number;
  swappedSafes: number;
  depositedSafes: number;
  txHashes: {
    claim: string[];
    swap: string[];
    deposit: string[];
  };
  dryRun: boolean;
};

export async function runYieldAiVaultCronPass(options: {
  dryRun?: boolean;
  pageSize?: number;
  maxSafesProcessedPerRun?: number;
  maxTxPerRun?: number;
  concurrencyReads?: number;
}) {
  const dryRun = Boolean(options.dryRun);
  const pageSize = options.pageSize ?? envNumber("YIELD_AI_CRON_PAGE_SIZE", 100);
  const maxSafesProcessedPerRun =
    options.maxSafesProcessedPerRun ?? envNumber("YIELD_AI_CRON_MAX_SAFES_PER_RUN", 500);
  const maxTxPerRun = options.maxTxPerRun ?? envNumber("YIELD_AI_CRON_MAX_TX_PER_RUN", 200);
  const concurrencyReads =
    options.concurrencyReads ?? envNumber("YIELD_AI_CRON_CONCURRENCY_READS", 10);

  const aptSwapReserve = envBigInt("YIELD_AI_APT_SWAP_RESERVE_OCTAS", APT_SWAP_RESERVE_OCTAS);
  const usdcDepositReserve = envBigInt(
    "YIELD_AI_USDC_DEPOSIT_RESERVE_BASE_UNITS",
    USDC_DEPOSIT_RESERVE_BASE_UNITS
  );

  const runId = `run_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  const startedAtUnixMs = Date.now();

  console.log("[Yield AI] cron run started:", {
    runId,
    dryRun,
    pageSize,
    maxSafesProcessedPerRun,
    maxTxPerRun,
    concurrencyReads,
  });

  const totalSafes = await getTotalSafes();
  console.log("[Yield AI] total safes:", { totalSafes, runId });

  const txHashes = { claim: [] as string[], swap: [] as string[], deposit: [] as string[] };

  let processedSafes = 0;
  let txCount = 0;
  let claimedSafes = 0;
  let swappedSafes = 0;
  let depositedSafes = 0;

  for (let start = 0; start < totalSafes; start += pageSize) {
    if (processedSafes >= maxSafesProcessedPerRun) break;
    if (txCount >= maxTxPerRun) break;

    const rangeSafes = await getSafesRangeInfo(start, pageSize);
    if (rangeSafes.length === 0) continue;

    const safeCandidates = rangeSafes.filter((s) => s.exists && !s.paused);
    const safeCandidatesLimited = safeCandidates.slice(0, maxSafesProcessedPerRun - processedSafes);

    // Initial reads (parallelized), so we can decide actions without extra view spam.
    const initialBalances = await mapWithConcurrency(
      safeCandidatesLimited,
      concurrencyReads,
      async (safe) => {
        const [aptBalance, usdcBalance] = await Promise.all([
          getAptBalanceBaseUnits(safe.safe_address),
          getUsdcBalanceBaseUnitsViaView(safe.safe_address),
        ]);
        return { safe, aptBalance, usdcBalance };
      }
    );

    for (const item of initialBalances) {
      if (processedSafes >= maxSafesProcessedPerRun) break;
      if (txCount >= maxTxPerRun) break;

      processedSafes += 1;

      const safeAddress = item.safe.safe_address;
      let aptBalance = item.aptBalance;
      let usdcBalance = item.usdcBalance;

      // Step A: claim APT
      if (aptBalance > APT_CLAIM_THRESHOLD_OCTAS && txCount < maxTxPerRun) {
        try {
          console.log("[Yield AI] claim attempt:", { runId, safeAddress });
          const result = await executeClaimApt({
            safeAddress,
            adapterAddress: MOAR_ADAPTER_ADDRESS_MAINNET,
            rewardId: APT_REWARD_ID,
            farmingIdentifier: APT_FARMING_IDENTIFIER,
            dryRun,
          });

          txCount += 1;
          if (!dryRun && result.hash) txHashes.claim.push(result.hash);
          if (!dryRun) claimedSafes += 1;

          // Re-read APT after claim to decide swap amount.
          aptBalance = await getAptBalanceBaseUnits(safeAddress);
        } catch (e) {
          console.error("[Yield AI] claim failed, skipping safe:", {
            runId,
            safeAddress,
            error: e instanceof Error ? e.message : String(e),
          });
          continue; // Skip to next safe
        }
      }

      // Step B: swap APT -> USDC
      if (aptBalance > APT_CLAIM_THRESHOLD_OCTAS && txCount < maxTxPerRun) {
        const amountIn = aptBalance > aptSwapReserve ? aptBalance - aptSwapReserve : 0n;
        if (amountIn > 0n) {
          try {
            console.log("[Yield AI] swap attempt:", { runId, safeAddress, amountIn });
            const deadline = BigInt(Math.floor(Date.now() / 1000)) + SWAP_DEADLINE_SECONDS;

            const result = await executeSwapAptToUsdc({
              safeAddress,
              feeTier: SWAP_FEE_TIER,
              amountInBaseUnits: amountIn,
              amountOutMinBaseUnits: SWAP_AMOUNT_OUT_MIN,
              sqrtPriceLimit: SWAP_SQRT_PRICE_LIMIT,
              toToken: USDC_FA_METADATA_MAINNET,
              deadlineUnixSeconds: deadline,
              dryRun,
            });

            txCount += 1;
            if (!dryRun && result.hash) txHashes.swap.push(result.hash);
            if (!dryRun) swappedSafes += 1;

            // Re-read USDC after swap to decide deposit amount.
            usdcBalance = await getUsdcBalanceBaseUnitsViaView(safeAddress);
          } catch (e) {
            console.error("[Yield AI] swap failed, skipping safe:", {
              runId,
              safeAddress,
              error: e instanceof Error ? e.message : String(e),
            });
            continue;
          }
        }
      }

      // Step C: deposit into Moar
      if (usdcBalance > USDC_DEPOSIT_THRESHOLD_BASE_UNITS && txCount < maxTxPerRun) {
        const amountToDeposit =
          usdcBalance > usdcDepositReserve ? usdcBalance - usdcDepositReserve : 0n;
        if (amountToDeposit > 0n) {
          try {
            console.log("[Yield AI] deposit attempt:", { runId, safeAddress, amountToDeposit });

            const result = await executeDepositToMoar({
              safeAddress,
              amountBaseUnits: amountToDeposit,
              dryRun,
            });

            txCount += 1;
            if (!dryRun && result.hash) txHashes.deposit.push(result.hash);
            if (!dryRun) depositedSafes += 1;
          } catch (e) {
            console.error("[Yield AI] deposit failed (policy caps likely), skipping safe:", {
              runId,
              safeAddress,
              error: e instanceof Error ? e.message : String(e),
            });
            continue;
          }
        }
      }
    }
  }

  const endedAtUnixMs = Date.now();
  console.log("[Yield AI] cron run finished:", {
    runId,
    durationMs: endedAtUnixMs - startedAtUnixMs,
    processedSafes,
    txCount,
    claimedSafes,
    swappedSafes,
    depositedSafes,
  });

  return {
    runId,
    startedAtUnixMs,
    totalSafes,
    pageSize,
    maxSafesProcessedPerRun,
    maxTxPerRun,
    processedSafes,
    txCount,
    claimedSafes,
    swappedSafes,
    depositedSafes,
    txHashes,
    dryRun,
  } satisfies YieldAiVaultCronRunResult;
}

