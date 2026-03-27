const JUPITER_LOCAL_ICON_BY_SYMBOL: Record<string, string> = {
  SOL: "/token_ico/sol.png",
  WSOL: "/token_ico/sol.png",
  USDC: "/token_ico/usdc.png",
  USDT: "/token_ico/usdt.png",
  USDS: "/token_ico/usds.png",
  USDG: "/token_ico/usdg.png",
  EURC: "/token_ico/eurc.png",
  JUPUSD: "/token_ico/jupusd.png",
};

function canonicalJupiterSymbol(symbol?: string | null): string {
  const normalized = (symbol ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (normalized.startsWith("WSOL")) return "WSOL";
  if (normalized.startsWith("SOL")) return "SOL";
  if (normalized.startsWith("USDC")) return "USDC";
  if (normalized.startsWith("USDT")) return "USDT";
  if (normalized.startsWith("USDS")) return "USDS";
  if (normalized.startsWith("USDG")) return "USDG";
  if (normalized.startsWith("EURC")) return "EURC";
  if (normalized.startsWith("JUPUSD")) return "JUPUSD";
  return normalized;
}

export function getPreferredJupiterTokenIcon(symbol?: string | null, fallbackLogoUrl?: string | null): string | undefined {
  const key = canonicalJupiterSymbol(symbol);
  if (key && JUPITER_LOCAL_ICON_BY_SYMBOL[key]) {
    return JUPITER_LOCAL_ICON_BY_SYMBOL[key];
  }

  const fallback = (fallbackLogoUrl ?? "").trim();
  return fallback.length > 0 ? fallback : undefined;
}

