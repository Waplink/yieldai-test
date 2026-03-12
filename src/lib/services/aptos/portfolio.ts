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
const APTREE_EARN_PRICE_DECIMALS = 9;
const APTREE_EARN_TOKEN_DECIMALS = 6;
const APTOS_VIEW_URL = 'https://fullnode.mainnet.aptoslabs.com/v1/view';
const APTREE_EARN_VIEW_FUNCTION =
  '0x951a31b39db54a4e32af927dce9fae7aa1ad14a1bb73318405ccf6cd5d66b3be::moneyfi_adapter::get_lp_price';

export class AptosPortfolioService {
  private walletService: AptosWalletService;
  private pricesService: PanoraPricesService;

  constructor() {
    this.walletService = AptosWalletService.getInstance();
    this.pricesService = PanoraPricesService.getInstance();
  }

  private async getAptreeEarnPriceUsd(): Promise<number | null> {
    try {
      const response = await fetch(APTOS_VIEW_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          function: APTREE_EARN_VIEW_FUNCTION,
          type_arguments: [],
          arguments: [],
        }),
        cache: 'no-store',
      });

      if (!response.ok) {
        return null;
      }

      const payload = (await response.json()) as unknown;
      if (!Array.isArray(payload) || payload.length === 0) {
        return null;
      }

      const raw = Number(payload[0]);
      if (!Number.isFinite(raw)) {
        return null;
      }

      return raw / Math.pow(10, APTREE_EARN_PRICE_DECIMALS);
    } catch {
      return null;
    }
  }

  async getPortfolio(address: string): Promise<{ tokens: PortfolioToken[] }> {
    try {
      
      // Получаем балансы из кошелька
      const walletData = await this.walletService.getBalances(address);
      const balances = walletData.balances;

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
      const aptreeEarnPriceUsd = await this.getAptreeEarnPriceUsd();

      // Объединяем данные
      const tokens: PortfolioToken[] = balances.map((balance: FungibleAssetBalance) => {
        if (
          normalizeAddress(balance.asset_type || '').toLowerCase() ===
          normalizeAddress(APTREE_EARN_TOKEN_ADDRESS).toLowerCase()
        ) {
          const amount = parseFloat(balance.amount) / Math.pow(10, APTREE_EARN_TOKEN_DECIMALS);
          const hasPrice = typeof aptreeEarnPriceUsd === 'number' && Number.isFinite(aptreeEarnPriceUsd);
          const value = hasPrice ? (amount * aptreeEarnPriceUsd).toString() : null;

          return {
            address: balance.asset_type,
            name: 'APTree Earn Token',
            symbol: 'AET',
            decimals: APTREE_EARN_TOKEN_DECIMALS,
            amount: balance.amount,
            price: hasPrice ? aptreeEarnPriceUsd.toString() : null,
            value,
            logoUrl: '/token_ico/aet.png?v=2',
          };
        }

        const price = prices.find((p: TokenPrice) => 
          p.tokenAddress === balance.asset_type || 
          p.faAddress === balance.asset_type
        );
        
        // Если нет цены, используем дефолтные значения
        if (!price) {
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
        const amount = parseFloat(balance.amount) / Math.pow(10, price.decimals);
        const value = (amount * parseFloat(price.usdPrice)).toString();

        return {
          address: balance.asset_type,
          name: price.name,
          symbol: price.symbol,
          decimals: price.decimals,
          amount: balance.amount,
          price: price.usdPrice,
          value
        };
      });

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