/** Shared helpers for Kamino kVault (Earn) pubkey extraction from API payloads. */

export function isLikelySolanaAddress(input: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(input.trim());
}

function getDeep(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const p of parts) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[p];
  }
  return current;
}

/**
 * Extract kVault vault pubkey from a user-position or pool payload.
 * Prefer explicit vault fields before root `address` (may be a position PDA in some responses).
 */
export function extractKvaultVaultAddress(pos: unknown): string | undefined {
  if (!pos || typeof pos !== "object") return undefined;
  const o = pos as Record<string, unknown>;
  const tryStr = (v: unknown): string | undefined => {
    if (typeof v !== "string") return undefined;
    const t = v.trim();
    if (!t || !isLikelySolanaAddress(t)) return undefined;
    return t;
  };

  const direct =
    tryStr(o.vaultAddress) ??
    tryStr(o.vaultPubkey) ??
    tryStr(o.earnVaultAddress) ??
    tryStr(o.earnVault) ??
    tryStr(o.kvaultAddress) ??
    tryStr(o.kVaultAddress) ??
    tryStr(o.kVault);

  if (direct) return direct;

  const nested =
    tryStr(getDeep(pos, "vault.address")) ??
    tryStr(getDeep(pos, "vault.vaultAddress")) ??
    tryStr(getDeep(pos, "vault.pubkey")) ??
    tryStr(getDeep(pos, "state.vaultAddress")) ??
    tryStr(getDeep(pos, "state.vault")) ??
    tryStr(getDeep(pos, "vaultState.vaultAddress")) ??
    tryStr(getDeep(pos, "meta.vaultAddress"));

  if (nested) return nested;

  const vault = o.vault;
  if (vault && typeof vault === "object") {
    const v = vault as Record<string, unknown>;
    const n = tryStr(v.address) ?? tryStr(v.vaultAddress) ?? tryStr(v.pubkey);
    if (n) return n;
  }
  if (typeof o.vault === "string" && o.vault.trim().length > 0) {
    const t = tryStr(o.vault);
    if (t) return t;
  }

  return tryStr(o.address);
}
