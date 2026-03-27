import { Connection, PublicKey, clusterApiUrl } from "@solana/web3.js";
import { Token } from "@/lib/types/token";
import { JupiterTokenMetadataService } from "./tokenMetadata";

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";

const KNOWN_TOKENS: Record<
  string,
  { symbol: string; name: string }
> = {
  [WRAPPED_SOL_MINT]: { symbol: "SOL", name: "Solana" },
};

export interface SolanaPortfolio {
  tokens: Token[];
  totalValueUsd: number;
}

type ParsedTokenAccount =
  Awaited<ReturnType<Connection["getParsedTokenAccountsByOwner"]>>["value"][number];

export class SolanaPortfolioService {
  private static instance: SolanaPortfolioService;
  private connection: Connection;
  private rpcEndpoints: string[];

  private constructor() {
    // Build robust RPC list with key-safe Helius handling.
    const directEnvEndpoints = [
      process.env.SOLANA_RPC_URL,
      process.env.NEXT_PUBLIC_SOLANA_RPC_URL,
    ]
      .filter(Boolean)
      .map((endpoint) => this.normalizeRpcEndpoint(endpoint as string))
      .filter(Boolean) as string[];
    const fallbackHelius = this.buildHeliusEndpointFromKey();

    this.rpcEndpoints = [
      ...directEnvEndpoints,
      ...(fallbackHelius ? [fallbackHelius] : []),
      "https://rpc.ankr.com/solana",
      clusterApiUrl("mainnet-beta"),
    ];
    // Deduplicate while preserving order.
    this.rpcEndpoints = Array.from(new Set(this.rpcEndpoints));

    const endpoint = this.rpcEndpoints[0] || clusterApiUrl("mainnet-beta");
    this.connection = new Connection(endpoint, "confirmed");
  }

  private buildHeliusEndpointFromKey(): string | null {
    const apiKey =
      process.env.SOLANA_RPC_API_KEY ||
      process.env.NEXT_PUBLIC_SOLANA_RPC_API_KEY ||
      "";
    if (!apiKey) return null;
    return `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
  }

  private normalizeRpcEndpoint(endpoint: string): string | null {
    try {
      const parsed = new URL(endpoint);
      const isHelius = parsed.hostname.includes("helius-rpc.com");
      if (!isHelius) return parsed.toString();

      const keyInUrl = parsed.searchParams.get("api-key");
      if (keyInUrl && keyInUrl.trim().length > 0) return parsed.toString();

      const apiKey =
        process.env.SOLANA_RPC_API_KEY ||
        process.env.NEXT_PUBLIC_SOLANA_RPC_API_KEY ||
        "";
      if (!apiKey) return null;
      parsed.searchParams.set("api-key", apiKey);
      return parsed.toString();
    } catch {
      return null;
    }
  }

  static getInstance(): SolanaPortfolioService {
    if (!SolanaPortfolioService.instance) {
      SolanaPortfolioService.instance = new SolanaPortfolioService();
    }
    return SolanaPortfolioService.instance;
  }

  /**
   * Raw SPL + Token-2022 amounts by mint (summed across token accounts).
   * Unlike `getPortfolio`, does **not** skip accounts where `uiAmount` is null/0 — needed for
   * Jupiter jl* receipt matching when RPC omits uiAmount.
   */
  async getRawSplBalancesByMint(address: string): Promise<Map<string, bigint>> {
    const owner = new PublicKey(address);
    const loaded = await this.fetchParsedTokenAccountsWithLamports(owner);
    const map = new Map<string, bigint>();
    for (const { account } of loaded.accounts) {
      const parsed = account.data as {
        program: string;
        parsed?: {
          info?: {
            mint?: string;
            tokenAmount?: {
              amount?: string;
            };
          };
          parsed?: {
            info?: {
              mint?: string;
              tokenAmount?: {
                amount?: string;
              };
            };
          };
        };
      };

      const tokenBlock = parsed.parsed as
        | {
            info?: { mint?: string; tokenAmount?: { amount?: string } };
            parsed?: { info?: { mint?: string; tokenAmount?: { amount?: string } } };
          }
        | undefined;
      const info = tokenBlock?.info ?? tokenBlock?.parsed?.info;
      const mint = info?.mint;
      const tokenAmount = info?.tokenAmount;
      if (!mint || !tokenAmount) continue;

      let raw: bigint;
      try {
        raw = BigInt(String(tokenAmount.amount ?? "0").split(".")[0] || "0");
      } catch {
        continue;
      }
      if (raw <= BigInt(0)) continue;

      map.set(mint, (map.get(mint) ?? BigInt(0)) + raw);
    }

    return map;
  }

  private async fetchParsedTokenAccountsWithLamports(
    owner: PublicKey
  ): Promise<{ accounts: ParsedTokenAccount[]; lamports: number }> {
    let lastError: Error | null = null;
    for (const endpoint of this.rpcEndpoints) {
      try {
        const connection = new Connection(endpoint, "confirmed");
        const [legacyAccounts, token2022Accounts, balance] = await Promise.all([
          connection.getParsedTokenAccountsByOwner(
            owner,
            { programId: TOKEN_PROGRAM_ID },
            "confirmed",
          ),
          connection.getParsedTokenAccountsByOwner(
            owner,
            { programId: TOKEN_2022_PROGRAM_ID },
            "confirmed",
          ),
          connection.getBalance(owner, "confirmed"),
        ]);

        const parsedTokenAccounts: ParsedTokenAccount[] = [
          ...(legacyAccounts?.value ?? []),
          ...(token2022Accounts?.value ?? []),
        ];

        this.connection = connection;
        return { accounts: parsedTokenAccounts, lamports: balance };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`Failed to fetch portfolio from ${endpoint}:`, message);
        lastError = error instanceof Error ? error : new Error(message);
        continue;
      }
    }

    throw lastError ?? new Error("Failed to fetch parsed token accounts from all RPC endpoints");
  }

  async getPortfolio(address: string): Promise<SolanaPortfolio> {
    const owner = new PublicKey(address);

    const loaded = await this.fetchParsedTokenAccountsWithLamports(owner);
    const parsedTokenAccounts = loaded.accounts;
    const lamports = loaded.lamports;

    const tokens: Token[] = [];

    for (const { account } of parsedTokenAccounts) {
      const parsed = account.data as {
        program: string;
        parsed?: {
          info?: {
            mint?: string;
            tokenAmount?: {
              amount?: string;
              decimals?: number;
              uiAmount?: number | null;
              uiAmountString?: string;
            };
          };
        };
      };

      const info = parsed.parsed?.info;
      const mint = info?.mint;
      const tokenAmount = info?.tokenAmount;

      if (!mint || !tokenAmount) {
        continue;
      }

      const rawAmount = tokenAmount.amount ?? "0";
      const uiAmount = tokenAmount.uiAmount ?? parseFloat(tokenAmount.uiAmountString ?? "0");
      const decimals = tokenAmount.decimals ?? 0;

      if (!uiAmount || uiAmount <= 0) {
        continue;
      }

      tokens.push({
        address: mint,
        name: KNOWN_TOKENS[mint]?.name ?? mint,
        symbol: KNOWN_TOKENS[mint]?.symbol ?? `${mint.slice(0, 4)}…`,
        decimals,
        amount: rawAmount,
        price: null,
        value: null,
      });
    }

    const hasWrappedSol = tokens.some((token) => token.address === WRAPPED_SOL_MINT);
    if (!hasWrappedSol && lamports > 0) {
      tokens.push({
        address: WRAPPED_SOL_MINT,
        name: KNOWN_TOKENS[WRAPPED_SOL_MINT].name,
        symbol: KNOWN_TOKENS[WRAPPED_SOL_MINT].symbol,
        decimals: 9,
        amount: lamports.toString(),
        price: null,
        value: null,
      });
    }

    console.log(`[SolanaPortfolio] 📊 Processing ${tokens.length} tokens before metadata`);
    tokens.forEach((token, idx) => {
      console.log(`[SolanaPortfolio] Token ${idx + 1}:`, {
        address: token.address,
        symbol: token.symbol,
        name: token.name,
        decimals: token.decimals,
        amount: token.amount,
        hasLogoUrl: !!token.logoUrl,
      });
    });

    const metadataService = JupiterTokenMetadataService.getInstance();
    const requestedMints = tokens.map((token) => token.address);
    console.log(`[SolanaPortfolio] 🔍 Requesting metadata for ${requestedMints.length} mints:`, requestedMints);
    
    const metadataMap = await metadataService.getMetadataMap(requestedMints);
    
    console.log(`[SolanaPortfolio] 📦 Received metadataMap with ${Object.keys(metadataMap).length} entries:`, 
      Object.keys(metadataMap).map(mint => ({
        mint,
        hasMetadata: !!metadataMap[mint],
        symbol: metadataMap[mint]?.symbol,
        name: metadataMap[mint]?.name,
        hasLogoUrl: !!metadataMap[mint]?.logoUrl,
        logoUrl: metadataMap[mint]?.logoUrl,
      }))
    );

    for (const token of tokens) {
      const metadata = metadataMap[token.address];
      console.log(`[SolanaPortfolio] 🔄 Processing token ${token.address}:`, {
        before: {
          symbol: token.symbol,
          name: token.name,
          decimals: token.decimals,
          logoUrl: token.logoUrl,
        },
        metadata: metadata ? {
          symbol: metadata.symbol,
          name: metadata.name,
          decimals: metadata.decimals,
          logoUrl: metadata.logoUrl,
        } : null,
      });

      if (!metadata) {
        console.warn(`[SolanaPortfolio] ⚠️ No metadata found for token: ${token.address} (symbol: ${token.symbol})`);
        continue;
      }

      if (metadata.symbol) {
        const oldSymbol = token.symbol;
        token.symbol = metadata.symbol;
        console.log(`[SolanaPortfolio] ✅ Updated symbol: "${oldSymbol}" -> "${token.symbol}"`);
      }
      if (metadata.name) {
        const oldName = token.name;
        token.name = metadata.name;
        console.log(`[SolanaPortfolio] ✅ Updated name: "${oldName}" -> "${token.name}"`);
      }
      if (metadata.logoUrl) {
        token.logoUrl = metadata.logoUrl;
        console.log(`[SolanaPortfolio] ✅ Set logoUrl for ${token.symbol || token.address}: ${metadata.logoUrl}`);
      } else {
        console.warn(`[SolanaPortfolio] ⚠️ No logoUrl in metadata for ${token.symbol || token.address} (address: ${token.address})`);
      }
      if (
        typeof metadata.decimals === "number" &&
        Number.isFinite(metadata.decimals)
      ) {
        const oldDecimals = token.decimals;
        token.decimals = metadata.decimals;
        console.log(`[SolanaPortfolio] ✅ Updated decimals: ${oldDecimals} -> ${token.decimals}`);
      }
    }

    const uniqueMints = Array.from(new Set(tokens.map((token) => token.address)));
    console.log(`[SolanaPortfolio] 💰 Fetching prices for ${uniqueMints.length} unique mints:`, uniqueMints);

    const priceMap = await this.fetchUsdPrices(uniqueMints);
    console.log(`[SolanaPortfolio] 💰 Received priceMap with ${Object.keys(priceMap).length} prices:`, 
      Object.entries(priceMap).map(([mint, price]) => ({ mint, price }))
    );

    let totalValueUsd = 0;

    for (const token of tokens) {
      const price = priceMap[token.address];
      console.log(`[SolanaPortfolio] 💵 Processing price for ${token.symbol || token.address} (${token.address}):`, {
        hasPrice: typeof price === "number",
        price: price,
        amount: token.amount,
        decimals: token.decimals,
      });

      if (typeof price !== "number") {
        console.warn(`[SolanaPortfolio] ⚠️ No price found for ${token.symbol || token.address} (${token.address}), skipping value calculation`);
        continue;
      }

      const amountInUnits = parseFloat(token.amount) / Math.pow(10, token.decimals);
      const usdValue = amountInUnits * price;

      token.price = price.toString();
      token.value = usdValue.toString();
      totalValueUsd += usdValue;

      console.log(`[SolanaPortfolio] ✅ Calculated values for ${token.symbol || token.address}:`, {
        amountInUnits: amountInUnits.toFixed(6),
        price: price,
        usdValue: usdValue.toFixed(2),
        tokenPrice: token.price,
        tokenValue: token.value,
      });
    }

    tokens.sort((a, b) => {
      const valueA = a.value ? parseFloat(a.value) : 0;
      const valueB = b.value ? parseFloat(b.value) : 0;
      return valueB - valueA;
    });

    console.log(`[SolanaPortfolio] 📋 Final tokens after processing:`, 
      tokens.map((token, idx) => ({
        index: idx + 1,
        address: token.address,
        symbol: token.symbol,
        name: token.name,
        decimals: token.decimals,
        amount: token.amount,
        price: token.price,
        value: token.value,
        logoUrl: token.logoUrl,
        hasLogoUrl: !!token.logoUrl,
      }))
    );
    console.log(`[SolanaPortfolio] 💰 Total value USD: ${totalValueUsd.toFixed(2)}`);

    return {
      tokens,
      totalValueUsd,
    };
  }

  private async fetchUsdPrices(mints: string[]): Promise<Record<string, number>> {
    if (!mints.length) {
      return {};
    }

    const result: Record<string, number> = {};

    const ids = [...new Set(mints)];
    const chunkSize = 50;

    const fetchBatch = async (idsChunk: string[]) => {
      if (!idsChunk.length) return;

      const url = new URL("https://api.jup.ag/price/v3");
      url.searchParams.set("ids", idsChunk.join(","));

      try {
        const headers: HeadersInit = {
          'Accept': 'application/json',
        };
        
        // Добавляем API ключ, если он есть
        const apiKey = process.env.NEXT_PUBLIC_JUP_API_KEY || process.env.JUP_API_KEY;
        console.log(`[SolanaPortfolio] 💰 Price API - API Key check:`, {
          hasNextPublicKey: !!process.env.NEXT_PUBLIC_JUP_API_KEY,
          hasJupApiKey: !!process.env.JUP_API_KEY,
          finalApiKey: apiKey ? `${apiKey.substring(0, 8)}...` : 'NOT FOUND',
          apiKeyLength: apiKey?.length || 0,
        });
        
        if (apiKey) {
          headers['x-api-key'] = apiKey;
          console.log(`[SolanaPortfolio] ✅ Price API key added to headers`);
        } else {
          console.warn(`[SolanaPortfolio] ⚠️ No Price API key found! Check JUP_API_KEY or NEXT_PUBLIC_JUP_API_KEY env variable`);
        }

        // TODO: proxy Jupiter Price API through our backend service to avoid direct client calls.
        const response = await fetch(url.toString(), { 
          cache: "no-store",
          headers,
        });
        
        if (!response.ok) {
          console.warn(`[SolanaPortfolio] Price API response not OK: ${response.status} ${response.statusText}`);
          return;
        }

        const data = (await response.json()) as Record<
          string,
          { usdPrice?: number }
        >;

        console.log(`[SolanaPortfolio] 💰 Price API response for chunk:`, {
          requestedIds: idsChunk.length,
          responseKeys: Object.keys(data).length,
          responseData: Object.entries(data).map(([mint, value]) => ({
            mint,
            usdPrice: value?.usdPrice,
            hasPrice: typeof value?.usdPrice === "number",
          })),
        });

        for (const [mint, value] of Object.entries(data)) {
          if (typeof value?.usdPrice === "number") {
            result[mint] = value.usdPrice;
            console.log(`[SolanaPortfolio] ✅ Price found for ${mint}: $${value.usdPrice}`);
          } else {
            console.warn(`[SolanaPortfolio] ⚠️ No valid price for ${mint}:`, value);
          }
        }
      } catch (error) {
        console.error("Failed to fetch Solana token prices:", error);
      }
    };

    for (let i = 0; i < ids.length; i += chunkSize) {
      const chunk = ids.slice(i, i + chunkSize);
      await fetchBatch(chunk);
    }

    return result;
  }
}

