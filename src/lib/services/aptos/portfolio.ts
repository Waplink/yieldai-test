import { AptosWalletService } from './wallet';
import { PanoraPricesService } from '../panora/prices';
import { FungibleAssetBalance } from '@/lib/types/aptos';
import { TokenPrice } from '@/lib/types/panora';
import { normalizeAddress } from '@/lib/utils/addressNormalization';

interface PortfolioToken {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  amount: string;
  price: string | null;
  value: string | null;
  logoUrl?: string;
}

const APTREE_EARN_TOKEN_ADDRESS = '0x5ecc6aff1d75144990a3798c904cc7c49e5c0cc3d5a134babc5b60184012310d';
const APTREE_EARN_TOKEN_ADDRESS_LOWER = APTREE_EARN_TOKEN_ADDRESS.toLowerCase();

// In-memory cache for Echelon markets (one request per 60s max)
const ECHELON_CACHE_TTL_MS = 60_000;
type EchelonMarketAsset = {
  address?: string;
  faAddress?: string;
  symbol: string;
  name: string;
  decimals?: number;
  price?: number;
  icon?: string;
};

type EchelonMarketsData = { assets: EchelonMarketAsset[] };

let echelonCache: { data: EchelonMarketsData; ts: number } | null = null;

function normalizeAssetTypeForLookup(assetType: string): string {
  const segment = assetType.includes('::') ? assetType.split('::')[0]! : assetType;
  const withPrefix = segment.startsWith('0x') ? segment : `0x${segment}`;
  return normalizeAddress(withPrefix).toLowerCase();
}

function resolveEchelonIconUrl(icon: string | undefined): string | undefined {
  if (!icon) return undefined;
  if (icon.startsWith('http://') || icon.startsWith('https://')) return icon;
  if (icon.startsWith('//')) return `https:${icon}`;
  if (icon.startsWith('/')) return `https://app.echelon.market${icon}`;
  return `https://app.echelon.market/${icon}`;
}

async function getEchelonMarkets(): Promise<EchelonMarketsData | null> {
  if (echelonCache && Date.now() - echelonCache.ts < ECHELON_CACHE_TTL_MS) {
    return echelonCache.data;
  }
  try {
    // Use same-origin proxy to avoid browser CORS issues.
    const res = await fetch('/api/protocols/echelon/markets', {
      headers: { 'Accept': 'application/json' },
    });
    if (!res.ok) return null;
    const json = await res.json();
    // Route shape: { success: true, data: <echelonMarketsData> }
    const raw = json?.data ?? null;
    if (!raw) return null;
    const data: EchelonMarketsData = {
      assets: Array.isArray(raw.assets) ? raw.assets : [],
    };
    echelonCache = { data, ts: Date.now() };
    return data;
  } catch {
    return null;
  }
}

export class AptosPortfolioService {
  private walletService: AptosWalletService;
  private pricesService: PanoraPricesService;

  constructor() {
    this.walletService = AptosWalletService.getInstance();
    this.pricesService = PanoraPricesService.getInstance();
  }

  async getPortfolio(address: string): Promise<{ tokens: PortfolioToken[] }> {
    try {
      
      // Получаем балансы из кошелька
      const walletData = await this.walletService.getBalances(address);
      const balances = (walletData.balances || []).filter((balance: FungibleAssetBalance) => {
        const assetType = (balance?.asset_type || '').toLowerCase();
        return assetType !== APTREE_EARN_TOKEN_ADDRESS_LOWER;
      });

      if (!balances.length) {
        console.log('No balances found');
        return { tokens: [] };
      }

      // Собираем адреса токенов
      const tokenAddresses = balances.map((balance: FungibleAssetBalance) => balance.asset_type);

      // Получаем цены для всех токенов одним запросом
      const pricesResponse = await this.pricesService.getPrices(1, tokenAddresses);
      // Handle both array and object with data property
      const prices = Array.isArray(pricesResponse) ? pricesResponse : (pricesResponse.data || []);

      // Объединяем данные
      const tokens: PortfolioToken[] = balances.map((balance: FungibleAssetBalance) => {
        const price = prices.find((p: TokenPrice) => 
          p.tokenAddress === balance.asset_type || 
          p.faAddress === balance.asset_type
        );
        
        // Если нет цены, используем дефолтные значения
        // Panora can return a placeholder object with null fields; treat it as missing.
        const hasValidPrice =
          !!price &&
          typeof price.usdPrice === 'string' &&
          price.usdPrice.length > 0 &&
          typeof price.decimals === 'number' &&
          Number.isFinite(price.decimals) &&
          typeof price.symbol === 'string' &&
          price.symbol.length > 0 &&
          typeof price.name === 'string' &&
          price.name.length > 0;

        if (!hasValidPrice) {
          console.log('No price found for token:', balance.asset_type);
          return {
            address: balance.asset_type,
            name: balance.asset_type.split('::').pop() || balance.asset_type,
            symbol: balance.asset_type.split('::').pop() || balance.asset_type,
            decimals: 8, // дефолтное значение
            amount: balance.amount,
            price: null,
            value: null
          };
        }

        // Вычисляем value с учетом decimals
        const amount = parseFloat(balance.amount) / Math.pow(10, price!.decimals);
        const value = (amount * parseFloat(price!.usdPrice)).toString();

        return {
          address: balance.asset_type,
          name: price!.name,
          symbol: price!.symbol,
          decimals: price!.decimals,
          amount: balance.amount,
          price: price!.usdPrice,
          value
        };
      });

      // Fallback: fill missing prices from Echelon API (one request, cached 60s)
      const missingPriceTokens = tokens.filter((t) => t.price === null);
      if (missingPriceTokens.length > 0) {
        const echelonData = await getEchelonMarkets();
        const assets = echelonData?.assets ?? [];
        const echelonByAddress = new Map<string, { symbol: string; name: string; decimals: number; price: number; logoUrl?: string }>();
        for (const a of assets) {
          const addr = a.address ?? a.faAddress;
          if (!addr || a.price == null) continue;
          const key = normalizeAssetTypeForLookup(addr);
          echelonByAddress.set(key, {
            symbol: a.symbol,
            name: a.name,
            decimals: a.decimals ?? 8,
            price: a.price,
            logoUrl: resolveEchelonIconUrl(a.icon),
          });
          if (a.faAddress && a.faAddress !== addr) {
            echelonByAddress.set(normalizeAddress(a.faAddress).toLowerCase(), {
              symbol: a.symbol,
              name: a.name,
              decimals: a.decimals ?? 8,
              price: a.price,
              logoUrl: resolveEchelonIconUrl(a.icon),
            });
          }
        }
        for (const token of missingPriceTokens) {
          const key = normalizeAssetTypeForLookup(token.address);
          const e = echelonByAddress.get(key);
          if (e) {
            token.name = e.name;
            token.symbol = e.symbol;
            token.decimals = e.decimals;
            token.price = String(e.price);
            const amount = parseFloat(token.amount) / Math.pow(10, e.decimals);
            token.value = (amount * e.price).toString();
            token.logoUrl = e.logoUrl;
          }
        }
      }

      // Сортируем по значению
      tokens.sort((a, b) => {
        const valueA = a.value ? parseFloat(a.value) : 0;
        const valueB = b.value ? parseFloat(b.value) : 0;
        return valueB - valueA;
      });

      return { tokens };
    } catch (error) {
      console.error('Error in getPortfolio:', error);
      return { tokens: [] };
    }
  }
} 