import { NextRequest, NextResponse } from 'next/server';
import { normalizeAddress, toCanonicalAddress } from '@/lib/utils/addressNormalization';
import { getDecibelExecutorAccount } from '@/lib/protocols/decibel/executorSubmit';

type DecibelDelegationDto = {
  delegated_account?: string;
  permission_type?: string;
  expiration_time_s?: number | null;
};

const DECIBEL_API_KEY = process.env.DECIBEL_API_KEY;
const DECIBEL_API_BASE_URL =
  process.env.DECIBEL_API_BASE_URL || 'https://api.testnet.aptoslabs.com/decibel';

/**
 * GET /api/protocols/decibel/delegations
 * Proxies Decibel delegations endpoint and returns a normalized UI-friendly shape.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const subaccount = searchParams.get('subaccount');
    if (!subaccount) {
      return NextResponse.json(
        { success: false, error: 'Subaccount parameter is required' },
        { status: 400 }
      );
    }
    if (!DECIBEL_API_KEY) {
      return NextResponse.json(
        { success: false, error: 'Decibel API key not configured' },
        { status: 503 }
      );
    }

    const executorAddress = toCanonicalAddress(
      getDecibelExecutorAccount().accountAddress.toString()
    );
    const canonicalSubaccount = toCanonicalAddress(subaccount.trim());
    const baseUrl = DECIBEL_API_BASE_URL.replace(/\/$/, '');
    const url = `${baseUrl}/api/v1/delegations?subaccount=${encodeURIComponent(canonicalSubaccount)}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${DECIBEL_API_KEY}`,
        'Content-Type': 'application/json',
      },
    });
    const text = await response.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : [];
    } catch {
      return NextResponse.json(
        { success: false, error: 'Invalid response from Decibel API' },
        { status: 502 }
      );
    }

    if (!response.ok) {
      return NextResponse.json(
        {
          success: false,
          error:
            typeof data === 'object' && data !== null && 'message' in (data as object)
              ? (data as { message: string }).message
              : `Decibel API error: ${response.status}`,
        },
        { status: response.status >= 500 ? 502 : response.status }
      );
    }

    const delegations = (Array.isArray(data) ? data : []) as DecibelDelegationDto[];
    const normalizedDelegations = delegations.map((item) => ({
      delegatedAccount: item.delegated_account ? toCanonicalAddress(item.delegated_account) : '',
      permissionType: item.permission_type ?? '',
      expirationTimeS: item.expiration_time_s ?? null,
      isExpired:
        typeof item.expiration_time_s === 'number'
          ? item.expiration_time_s <= Math.floor(Date.now() / 1000)
          : false,
    }));

    const isDelegatedToExecutor = !!executorAddress && normalizedDelegations.some((item) => {
      if (!item.delegatedAccount) return false;
      if (normalizeAddress(item.delegatedAccount) !== normalizeAddress(executorAddress)) return false;
      if (item.isExpired) return false;
      const permission = item.permissionType.toLowerCase();
      return permission.includes('trade') && permission.includes('perp');
    });

    return NextResponse.json({
      success: true,
      subaccount: canonicalSubaccount,
      executorAddress,
      isDelegatedToExecutor,
      data: normalizedDelegations,
    });
  } catch (error) {
    console.error('[Decibel] delegations error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
