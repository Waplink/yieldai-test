import {
  YIELD_AI_VAULT_MODULE,
  USDC_FA_METADATA_MAINNET,
} from "@/lib/constants/yieldAiVault";

/**
 * Builds the payload for vault::init_vault (create AI agent safe).
 * Function: {MODULE}::vault::init_vault
 * Arguments: max_per_tx (u64), max_daily (u64) in on-chain base units (e.g. USDC 6 decimals).
 */
export function buildInitVaultPayload(params: {
  maxPerTxBaseUnits: bigint | string;
  maxDailyBaseUnits: bigint | string;
}): {
  function: string;
  typeArguments: string[];
  functionArguments: string[];
} {
  const { maxPerTxBaseUnits, maxDailyBaseUnits } = params;
  return {
    function: `${YIELD_AI_VAULT_MODULE}::init_vault`,
    typeArguments: [],
    functionArguments: [String(maxPerTxBaseUnits), String(maxDailyBaseUnits)],
  };
}

/**
 * Builds the payload for vault::deposit (Yield AI safe).
 * Function: {MODULE}::vault::deposit
 * Arguments: safe_address (address), metadata (address), amount (u64).
 */
export function buildVaultDepositPayload(params: {
  safeAddress: string;
  /** FA metadata object address (default: USDC mainnet). */
  metadata?: string;
  amountBaseUnits: bigint | string;
}): {
  function: string;
  typeArguments: string[];
  functionArguments: string[];
} {
  const { safeAddress, amountBaseUnits, metadata = USDC_FA_METADATA_MAINNET } = params;
  return {
    function: `${YIELD_AI_VAULT_MODULE}::deposit`,
    typeArguments: [],
    functionArguments: [safeAddress, metadata, String(amountBaseUnits)],
  };
}

/**
 * Builds the payload for vault::withdraw (Yield AI safe).
 * Owner signs; FA is transferred from safe to owner's primary store.
 * Function: {MODULE}::vault::withdraw
 * Arguments: safe_address (address), metadata (address), amount (u64).
 */
export function buildVaultWithdrawPayload(params: {
  safeAddress: string;
  /** FA metadata object address (e.g. USDC mainnet). */
  metadata: string;
  amountBaseUnits: bigint | string;
}): {
  function: string;
  typeArguments: string[];
  functionArguments: string[];
} {
  const { safeAddress, metadata, amountBaseUnits } = params;
  return {
    function: `${YIELD_AI_VAULT_MODULE}::withdraw`,
    typeArguments: [],
    functionArguments: [safeAddress, metadata, String(amountBaseUnits)],
  };
}

/**
 * Builds the payload for vault::execute_withdraw_full_as_owner.
 * Owner signs; protocol position is fully withdrawn from adapter back to safe.
 * Function: {MODULE}::execute_withdraw_full_as_owner
 * Arguments: safe_address (address), adapter_address (address), metadata (address).
 */
export function buildVaultExecuteWithdrawFullAsOwnerPayload(params: {
  safeAddress: string;
  adapterAddress: string;
  metadata: string;
}): {
  function: string;
  typeArguments: string[];
  functionArguments: string[];
} {
  const { safeAddress, adapterAddress, metadata } = params;
  return {
    function: `${YIELD_AI_VAULT_MODULE}::execute_withdraw_full_as_owner`,
    typeArguments: [],
    functionArguments: [safeAddress, adapterAddress, metadata],
  };
}
