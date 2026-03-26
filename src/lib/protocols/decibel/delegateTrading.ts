import { PACKAGE_MAINNET, PACKAGE_TESTNET } from './closePosition';
import { toCanonicalAddress } from '@/lib/utils/addressNormalization';

export interface DelegateTradingParams {
  subaccountAddr: string;
  accountToDelegateTo: string;
  expirationTimestampSecs?: number | null;
  isTestnet?: boolean;
}

function assertAptosAddress(value: string, field: string): string {
  if (!value || !value.startsWith('0x')) {
    throw new Error(`${field} must be a valid Aptos address`);
  }
  const canonical = toCanonicalAddress(value);
  if (!/^0x[0-9a-fA-F]{64}$/.test(canonical)) {
    throw new Error(`${field} must be a valid Aptos address`);
  }
  return canonical;
}

export function buildDelegateTradingPayload(
  params: DelegateTradingParams
): {
  function: string;
  typeArguments: string[];
  functionArguments: unknown[];
} {
  const {
    subaccountAddr,
    accountToDelegateTo,
    expirationTimestampSecs = null,
    isTestnet = false,
  } = params;
  const pkg = isTestnet ? PACKAGE_TESTNET : PACKAGE_MAINNET;
  const canonicalSubaccount = assertAptosAddress(subaccountAddr, 'subaccountAddr');
  const canonicalDelegateTo = assertAptosAddress(accountToDelegateTo, 'accountToDelegateTo');

  if (
    expirationTimestampSecs != null &&
    (!Number.isFinite(expirationTimestampSecs) || expirationTimestampSecs < 0)
  ) {
    throw new Error('expirationTimestampSecs must be a positive unix timestamp');
  }

  return {
    function: `${pkg}::dex_accounts_entry::delegate_trading_to_for_subaccount`,
    typeArguments: [],
    functionArguments: [
      canonicalSubaccount,
      canonicalDelegateTo,
      expirationTimestampSecs == null ? null : Math.floor(expirationTimestampSecs),
    ],
  };
}
