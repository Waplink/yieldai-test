/**
 * Yield AI Vault contract (mainnet).
 * Module: 0x333d1890e0aa3762bb256f5caeeb142431862628c63063801f44c152ef154700::vault
 */
export const YIELD_AI_VAULT_MODULE =
  "0x333d1890e0aa3762bb256f5caeeb142431862628c63063801f44c152ef154700::vault";

export const VAULT_VIEW = {
  safeRefExists: `${YIELD_AI_VAULT_MODULE}::safe_ref_exists`,
  getSafeCount: `${YIELD_AI_VAULT_MODULE}::get_safe_count`,
  getSafeAddress: `${YIELD_AI_VAULT_MODULE}::get_safe_address`,
} as const;

export const APTOS_COIN_TYPE = "0x1::aptos_coin::AptosCoin";
export const COIN_BALANCE_VIEW = "0x1::coin::balance";

export const YIELD_AI_VAULT_VIEWS = {
  getTotalSafes: `${YIELD_AI_VAULT_MODULE}::get_total_safes`,
  // Returns (safe_address, owner, paused, exists) for range [start, start+limit)
  getSafesRangeInfo: `${YIELD_AI_VAULT_MODULE}::get_safes_range_info`,
} as const;

export const YIELD_AI_VAULT_ENTRYPOINTS = {
  executeClaimApt: `${YIELD_AI_VAULT_MODULE}::execute_claim_apt`,
  executeSwapAptToFa: `${YIELD_AI_VAULT_MODULE}::execute_swap_apt_to_fa`,
  executeDeposit: `${YIELD_AI_VAULT_MODULE}::execute_deposit`,
} as const;

// Thresholds:
// - APT has 8 decimals
// - USDC has 6 decimals
export const APT_CLAIM_THRESHOLD_OCTAS = 10_000_000n; // 0.1 APT
export const USDC_DEPOSIT_THRESHOLD_BASE_UNITS = 100_000n; // 0.1 USDC

/** APT kept on safe after swap: 0 = swap full balance above claim/swap thresholds. */
export const APT_SWAP_RESERVE_OCTAS = 0n;
/** USDC left on safe after deposit: 0 = deposit full detected balance (subject to vault policy caps). */
export const USDC_DEPOSIT_RESERVE_BASE_UNITS = 0n;

// Claim parameters:
export const APT_REWARD_ID = "APT-1";
// From MAINNET_DEPLOY runtime:
export const APT_FARMING_IDENTIFIER =
  "0x22dbe22abf689d8a0f751cab7a32fe5570c49b53fcccd4e5d709b269efda554a-1";

// Swap parameters (APT -> USDC FA):
export const SWAP_FEE_TIER = 1n; // 0.05%
export const SWAP_AMOUNT_OUT_MIN = 0n;
export const SWAP_SQRT_PRICE_LIMIT = 4295048017n;
export const SWAP_DEADLINE_SECONDS = 600n;

/** USDC FA metadata object address (mainnet). Used as second argument to vault::deposit. */
export const USDC_FA_METADATA_MAINNET =
  "0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b";

/** Moar adapter address (mainnet). Used in vault::execute_deposit. */
export const MOAR_ADAPTER_ADDRESS_MAINNET =
  "0x1212d77e4a5f0b527037ed373e393e649645c7c76cc462e1d63c2d85688839d8";
