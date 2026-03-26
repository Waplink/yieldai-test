function normalize(value?: string | null): string {
  return (value ?? "").trim();
}

function looksLikeHelius(url: string): boolean {
  return url.includes("helius-rpc.com");
}

function hasApiKeyParam(url: string): boolean {
  return /[?&]api-key=/.test(url);
}

function appendApiKey(url: string, apiKey: string): string {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}api-key=${encodeURIComponent(apiKey)}`;
}

/**
 * Resolve an RPC endpoint that works in production:
 * - Prefer explicit RPC URLs
 * - If Helius URL is provided without api-key, try to append api-key from env
 * - Otherwise fall back to Solana public mainnet endpoint
 */
export function getSafeSolanaRpcEndpoint(): string {
  const explicit =
    normalize(process.env.NEXT_PUBLIC_SOLANA_RPC_URL) ||
    normalize(process.env.SOLANA_RPC_URL);

  const apiKey =
    normalize(process.env.NEXT_PUBLIC_SOLANA_RPC_API_KEY) ||
    normalize(process.env.SOLANA_RPC_API_KEY);

  if (explicit) {
    if (looksLikeHelius(explicit) && !hasApiKeyParam(explicit)) {
      if (apiKey) return appendApiKey(explicit, apiKey);
      return "https://api.mainnet-beta.solana.com";
    }
    return explicit;
  }

  if (apiKey) {
    return `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(apiKey)}`;
  }

  return "https://api.mainnet-beta.solana.com";
}

