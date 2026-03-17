import { NextResponse } from 'next/server';
import { getReserveApyMetrics, EchoReserveData } from '@/lib/utils/apy';
import tokenList from '@/lib/data/tokenList.json';

const ECHO_CONTRACT = '0xeab7ea4d635b6b6add79d5045c4a45d8148d88287b1cfa1c3b6a4b56f46839ed';
const CANONICAL_USDC_FA_ADDRESS = '0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b';
const FULLNODE_VIEW_URL = 'https://fullnode.mainnet.aptoslabs.com/v1/view';
const APTOS_API_KEY = process.env.APTOS_API_KEY;

type ATokenInfo = { symbol: string; token_address: string };

function normalizeTokenAddress(address: string): string {
  if (!address) return '';
  const prefixed = address.startsWith('0x') ? address : `0x${address}`;
  return `0x${prefixed.slice(2).replace(/^0+/, '') || '0'}`;
}

async function callView(functionFullname: string, args: string[]): Promise<unknown> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (APTOS_API_KEY) {
    headers['Authorization'] = `Bearer ${APTOS_API_KEY}`;
  }
  const res = await fetch(FULLNODE_VIEW_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ function: functionFullname, type_arguments: [], arguments: args }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Echo view error: ${res.status} ${text}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

function parseATokens(result: unknown): ATokenInfo[] {
  if (!Array.isArray(result)) return [];
  const arr = result.length === 1 && Array.isArray(result[0]) ? result[0] : result;
  return arr
    .map((item: unknown) => {
      if (Array.isArray(item) && item.length >= 2) {
        return { symbol: String(item[0]), token_address: normalizeTokenAddress(String(item[1])) };
      }
      if (item && typeof item === 'object' && 'symbol' in item && 'token_address' in item) {
        return {
          symbol: String((item as ATokenInfo).symbol),
          token_address: normalizeTokenAddress((item as ATokenInfo).token_address),
        };
      }
      return null;
    })
    .filter(Boolean) as ATokenInfo[];
}

function canonicalizeEchoSymbol(symbolGuess: string): { symbol: string; pricingAddressOverride?: string } {
  if (symbolGuess === 'USDCn') {
    return { symbol: 'USDC', pricingAddressOverride: CANONICAL_USDC_FA_ADDRESS };
  }
  return { symbol: symbolGuess };
}

/** Find token in tokenList by symbol; return faAddress or tokenAddress for dashboard lookup. */
function getTokenAddressFromTokenListBySymbol(symbol: string): string | null {
  const tokens = (tokenList as { data: { data: Array<{ symbol?: string; faAddress?: string; tokenAddress?: string }> } })
    .data.data;
  const t = tokens.find((x) => x.symbol?.toLowerCase() === symbol?.toLowerCase());
  if (!t) return null;
  const addr = t.faAddress ?? t.tokenAddress ?? null;
  return addr ? normalizeTokenAddress(addr) : null;
}

function parseCoinAssetPairs(result: unknown): Map<string, string> {
  const map = new Map<string, string>();
  if (!Array.isArray(result) || result.length < 2) return map;
  const typesArr = Array.isArray(result[0])
    ? result[0]
    : typeof result[0] === 'object' && result[0] != null
      ? []
      : [result[0]];
  const addrsArr = Array.isArray(result[1])
    ? result[1]
    : typeof result[1] === 'object' && result[1] != null
      ? []
      : [result[1]];
  const len = Math.min(typesArr.length, addrsArr.length);
  for (let i = 0; i < len; i++) {
    const t = String(typesArr[i] ?? '');
    const a = String(addrsArr[i] ?? '').trim();
    if (t && a) {
      const fa = normalizeTokenAddress(a);
      map.set(t, fa);
      map.set(fa, fa);
    }
  }
  return map;
}

function resolveUnderlyingToFa(underlying: string, coinAssetPairs: Map<string, string>): string {
  if (!underlying) return '';
  const norm = underlying.includes('::') ? underlying.trim() : normalizeTokenAddress(underlying);
  return coinAssetPairs.get(norm) ?? coinAssetPairs.get(underlying) ?? norm;
}

function parseReserveData(result: unknown): EchoReserveData {
  if (!result) return {};
  if (Array.isArray(result)) {
    if (result.length === 0) return {};
    const first = result.length === 1 ? result[0] : result[0];
    if (first && typeof first === 'object') return first as EchoReserveData;
    return {};
  }
  if (typeof result === 'object') return result as EchoReserveData;
  return {};
}

export async function GET() {
  try {
    const poolDataProvider = `${ECHO_CONTRACT}::pool_data_provider`;
    const variableTokenFactory = `${ECHO_CONTRACT}::variable_token_factory`;

    const aTokensResult = await callView(`${poolDataProvider}::get_all_a_tokens`, []);
    const aTokens = parseATokens(aTokensResult);
    if (aTokens.length === 0) {
      return NextResponse.json(
        { success: true, data: [] },
        { headers: { 'Cache-Control': 'public, max-age=10, s-maxage=10, stale-while-revalidate=30' } }
      );
    }

    const underlyingTokenFactory = `${ECHO_CONTRACT}::underlying_token_factory`;
    const coinPairsResult = await callView(`${underlyingTokenFactory}::get_coin_asset_pairs`, []);
    const coinAssetPairs = parseCoinAssetPairs(coinPairsResult);

    const reservesByUnderlying = new Map<
      string,
      { underlyingNorm: string; symbol: string; pricingAddressOverride?: string }
    >();

    for (const aToken of aTokens) {
      const aTokenAddr = aToken.token_address.startsWith('0x')
        ? aToken.token_address
        : `0x${aToken.token_address}`;
      let underlyingAddr: string;
      try {
        const raw = await callView(`${variableTokenFactory}::get_underlying_asset_address`, [
          aTokenAddr,
        ]);
        underlyingAddr =
          Array.isArray(raw) && raw[0] != null
            ? normalizeTokenAddress(String(raw[0]))
            : raw && typeof raw === 'object' && 'inner' in (raw as { inner?: string })
              ? normalizeTokenAddress(String((raw as { inner: string }).inner))
              : '';
      } catch {
        continue;
      }
      if (!underlyingAddr) continue;
      const underlyingNorm =
        underlyingAddr.startsWith('0x') ? underlyingAddr : `0x${underlyingAddr}`;
      const symbolGuess = aToken.symbol.replace(/^A/, '');
      const canonical = canonicalizeEchoSymbol(symbolGuess);
      if (!reservesByUnderlying.has(underlyingNorm)) {
        reservesByUnderlying.set(underlyingNorm, {
          underlyingNorm,
          symbol: canonical.symbol,
          pricingAddressOverride: canonical.pricingAddressOverride,
        });
      }
    }

    const reserves = Array.from(reservesByUnderlying.values());
    const data = await Promise.all(
      reserves.map(async ({ underlyingNorm, symbol, pricingAddressOverride }) => {
        const token =
          getTokenAddressFromTokenListBySymbol(symbol) ??
          pricingAddressOverride ??
          resolveUnderlyingToFa(underlyingNorm, coinAssetPairs) ??
          underlyingNorm;
        try {
          const reserveRaw = await callView(`${ECHO_CONTRACT}::pool::get_reserve_data`, [
            underlyingNorm,
          ]);
          const reserveData = parseReserveData(reserveRaw);
          const metrics = getReserveApyMetrics(reserveData);
          return {
            underlyingAddress: underlyingNorm,
            token,
            symbol,
            supplyApy: metrics.supplyApy * 100,
            borrowApy: metrics.borrowApy * 100,
            supplyApyFormatted: metrics.supplyApyFormatted,
            borrowApyFormatted: metrics.borrowApyFormatted,
          };
        } catch (e) {
          console.warn('[Echo] reserves get_reserve_data error:', underlyingNorm, e);
          return {
            underlyingAddress: underlyingNorm,
            token,
            symbol,
            supplyApy: 0,
            borrowApy: 0,
            supplyApyFormatted: '0.00%',
            borrowApyFormatted: '0.00%',
          };
        }
      })
    );

    return NextResponse.json(
      { success: true, data },
      {
        headers: {
          'Cache-Control': 'public, max-age=10, s-maxage=10, stale-while-revalidate=30',
        },
      }
    );
  } catch (error) {
    console.error('[Echo] reserves error:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        data: [],
      },
      { status: 500 }
    );
  }
}
