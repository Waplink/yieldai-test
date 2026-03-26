import { NextRequest, NextResponse } from 'next/server';

/** Override in `.env` when hosting a series endpoint that returns longer history (e.g. 7d). */
const EXTERNAL_FUNDING_URL =
  process.env.DECIBEL_FUNDING_SERIES_URL?.trim() || 'https://yieldai.aoserver.ru/funding.php';
const FUNDING_WINDOW = '7d';

/**
 * Maps our `window` query to what yieldai funding.php actually honors.
 * `window=7d` still returns ~24h of points; use `period=week` for ~7d series and weighted APR.
 */
function upstreamQueryString(
  marketName: string | undefined,
  windowParam: string,
  weightedAverage: boolean
): string {
  const params = new URLSearchParams();
  if (marketName) {
    params.set('market_name', marketName);
    if (weightedAverage) {
      params.set('weighted_average', 'true');
    }
  }
  const w = windowParam.trim().toLowerCase();
  if (w === '7d' || w === 'week') {
    params.set('period', 'week');
  } else if (w === '24h' || w === '1d' || w === 'day') {
    params.set('period', 'day');
  } else {
    params.set('window', windowParam);
  }
  return params.toString();
}

/**
 * GET /api/protocols/decibel/funding
 * - With ?market_name=BTC/USD&series_only=true: raw time-series for that market only (for charts).
 * - With ?market_name=BTC/USD (default): weighted average APR; `window` 24h | 7d maps to `period` day | week.
 * - Without market_name: raw time-series for chart + open interest; same mapping.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const marketName = searchParams.get('market_name')?.trim();
    const windowParam = searchParams.get('window')?.trim() || FUNDING_WINDOW;
    const seriesOnly =
      searchParams.get('series_only') === 'true' || searchParams.get('series_only') === '1';

    const weightedAverage = Boolean(marketName) && !seriesOnly;
    const qs = upstreamQueryString(marketName || undefined, windowParam, weightedAverage);
    const url = `${EXTERNAL_FUNDING_URL}?${qs}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });

    const json = await res.json().catch(() => null);
    if (!res.ok) {
      return NextResponse.json(
        { success: false, error: json?.error || `Upstream returned ${res.status}` },
        { status: res.status >= 500 ? 502 : res.status }
      );
    }
    return NextResponse.json(json);
  } catch (err) {
    console.error('[Decibel funding] proxy error:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Failed to fetch funding' },
      { status: 502 }
    );
  }
}
