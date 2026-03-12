import { NextRequest, NextResponse } from 'next/server';
import { AptosWalletService } from '@/lib/services/aptos/wallet';
import { normalizeAddress } from '@/lib/utils/addressNormalization';

const APTREE_EARN_TOKEN_ADDRESS =
  '0x5ecc6aff1d75144990a3798c904cc7c49e5c0cc3d5a134babc5b60184012310d';
const APTREE_DECIMALS = 6;

/**
 * GET /api/protocols/aptree/userPositions
 * Minimal APTree positions: map wallet AET balance into protocol position format.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const address = searchParams.get('address');

  if (!address) {
    return NextResponse.json(
      { success: false, error: 'Address parameter is required' },
      { status: 400 }
    );
  }

  try {
    const walletService = AptosWalletService.getInstance();
    const walletData = await walletService.getBalances(address);
    const balances = walletData?.balances || [];

    const aptreeBalance = balances.find((b) => {
      const assetType = typeof b?.asset_type === 'string' ? b.asset_type : '';
      return (
        normalizeAddress(assetType).toLowerCase() ===
        normalizeAddress(APTREE_EARN_TOKEN_ADDRESS).toLowerCase()
      );
    });

    const rawBalance = aptreeBalance?.amount || '0';
    const normalizedBalance = Number(rawBalance) / Math.pow(10, APTREE_DECIMALS);

    const positions =
      Number(rawBalance) > 0
        ? [
            {
              poolId: 1,
              assetName: 'AET',
              balance: rawBalance, // raw on-chain units
              value: normalizedBalance.toString(), // human units with decimals=6
              type: 'deposit',
              assetInfo: {
                symbol: 'AET',
                logoUrl: '/token_ico/aet.png',
                decimals: APTREE_DECIMALS,
                name: 'APTree Earn Token',
              },
            },
          ]
        : [];

    return NextResponse.json({
      success: true,
      data: positions,
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to load APTree positions',
        data: [],
      },
      { status: 500 }
    );
  }
}
