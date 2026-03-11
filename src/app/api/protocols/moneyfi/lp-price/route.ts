import { NextResponse } from 'next/server';

const EXPLORER_LP_URL =
  'https://explorer.aptoslabs.com/account/0x951a31b39db54a4e32af927dce9fae7aa1ad14a1bb73318405ccf6cd5d66b3be/modules/view/moneyfi_adapter/get_lp_price?network=mainnet';

/**
 * GET /api/protocols/moneyfi/lp-price
 * Server-side proxy to Aptos Explorer LP price view URL.
 */
export async function GET() {
  try {
    const response = await fetch(EXPLORER_LP_URL, {
      method: 'GET',
      headers: {
        Accept: 'application/json, text/plain, text/html;q=0.9, */*;q=0.8',
      },
      cache: 'no-store',
    });

    const contentType = response.headers.get('content-type') || '';
    const rawText = await response.text();

    let parsed: unknown = rawText;
    if (contentType.includes('application/json')) {
      try {
        parsed = JSON.parse(rawText);
      } catch {
        parsed = rawText;
      }
    }

    return NextResponse.json(
      {
        success: response.ok,
        status: response.status,
        sourceUrl: EXPLORER_LP_URL,
        contentType,
        data: parsed,
      },
      { status: response.ok ? 200 : response.status }
    );
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}

