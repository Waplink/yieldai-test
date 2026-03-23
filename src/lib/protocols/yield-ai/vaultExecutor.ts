import {
  Aptos,
  AptosConfig,
  Network,
  Account,
  Ed25519PrivateKey,
} from "@aptos-labs/ts-sdk";
import { toCanonicalAddress } from "@/lib/utils/addressNormalization";
import {
  YIELD_AI_VAULT_ENTRYPOINTS,
  USDC_FA_METADATA_MAINNET,
  MOAR_ADAPTER_ADDRESS_MAINNET,
} from "@/lib/constants/yieldAiVault";

const APTOS_API_KEY = process.env.APTOS_API_KEY;

const config = new AptosConfig({
  network: Network.MAINNET,
  ...(APTOS_API_KEY && {
    clientConfig: {
      HEADERS: { Authorization: `Bearer ${APTOS_API_KEY}` },
    },
  }),
});

const aptos = new Aptos(config);

/** Aptos SDK entry function id shape: `0xaddr::module::function` */
type EntryFunctionId = `${string}::${string}::${string}`;

let cachedExecutorAccount: Account | null = null;

function getExecutorAccount(): Account {
  if (cachedExecutorAccount) return cachedExecutorAccount;

  const privateKeyHex = process.env.YIELD_AI_EXECUTOR_PRIVATE_KEY;
  if (!privateKeyHex) {
    throw new Error("YIELD_AI_EXECUTOR_PRIVATE_KEY is not configured");
  }

  const keyHex = privateKeyHex.replace(/^0x/, "").trim();
  const account = Account.fromPrivateKey({
    privateKey: new Ed25519PrivateKey(keyHex),
  });

  cachedExecutorAccount = account;
  return account;
}

async function buildAndSubmit(options: {
  function: string;
  functionArguments: (string | number | bigint)[];
  maxGasAmount?: number;
  dryRun?: boolean;
  logPrefix?: string;
}) {
  const {
    function: fn,
    functionArguments,
    maxGasAmount = 50_000,
    dryRun = false,
    logPrefix = "[Yield AI]",
  } = options;

  const executor = getExecutorAccount();
  const executorAddress = executor.accountAddress;

  if (dryRun) {
    console.log(`${logPrefix} dryRun tx build:`, {
      function: fn,
      sender: executorAddress.toString(),
      functionArguments,
    });
    return { hash: null as string | null, dryRun: true };
  }

  const transaction = await aptos.transaction.build.simple({
    sender: executorAddress,
    withFeePayer: false,
    data: {
      function: fn as EntryFunctionId,
      typeArguments: [],
      functionArguments: functionArguments.map((a) =>
        typeof a === "bigint" ? a.toString() : String(a)
      ),
    },
    options: { maxGasAmount },
  });

  const senderAuthenticator = aptos.transaction.sign({
    signer: executor,
    transaction,
  });

  const result = await aptos.transaction.submit.simple({
    transaction,
    senderAuthenticator,
  });

  const hash = result.hash as string;

  console.log(`${logPrefix} tx submitted:`, {
    hash,
    function: fn,
  });

  // Wait until this tx is committed so the next tx from the same executor gets a fresh sequence number.
  // Without this, rapid back-to-back submits hit: invalid_transaction_update / mempool payload mismatch.
  await aptos.waitForTransaction({
    transactionHash: hash,
  });

  console.log(`${logPrefix} tx confirmed on-chain:`, { hash, function: fn });

  return { hash, dryRun: false };
}

export async function executeClaimApt(options: {
  safeAddress: string;
  adapterAddress?: string;
  rewardId: string;
  farmingIdentifier: string;
  maxGasAmount?: number;
  dryRun?: boolean;
}) {
  const {
    safeAddress,
    adapterAddress = MOAR_ADAPTER_ADDRESS_MAINNET,
    rewardId,
    farmingIdentifier,
    maxGasAmount,
    dryRun,
  } = options;

  return buildAndSubmit({
    function: YIELD_AI_VAULT_ENTRYPOINTS.executeClaimApt,
    functionArguments: [
      toCanonicalAddress(safeAddress),
      toCanonicalAddress(adapterAddress),
      rewardId,
      farmingIdentifier,
    ],
    maxGasAmount,
    dryRun,
    logPrefix: "[Yield AI] execute_claim_apt",
  });
}

export async function executeSwapAptToUsdc(options: {
  safeAddress: string;
  feeTier: bigint | number;
  amountInBaseUnits: bigint;
  amountOutMinBaseUnits: bigint;
  sqrtPriceLimit: bigint;
  toToken: string;
  deadlineUnixSeconds: bigint | number;
  maxGasAmount?: number;
  dryRun?: boolean;
}) {
  const {
    safeAddress,
    feeTier,
    amountInBaseUnits,
    amountOutMinBaseUnits,
    sqrtPriceLimit,
    toToken,
    deadlineUnixSeconds,
    maxGasAmount,
    dryRun,
  } = options;

  return buildAndSubmit({
    function: YIELD_AI_VAULT_ENTRYPOINTS.executeSwapAptToFa,
    functionArguments: [
      toCanonicalAddress(safeAddress),
      feeTier,
      amountInBaseUnits,
      amountOutMinBaseUnits,
      sqrtPriceLimit,
      toCanonicalAddress(toToken),
      deadlineUnixSeconds,
    ],
    maxGasAmount,
    dryRun,
    logPrefix: "[Yield AI] execute_swap_apt_to_fa",
  });
}

export async function executeDepositToMoar(options: {
  safeAddress: string;
  amountBaseUnits: bigint;
  adapterAddress?: string;
  metadataAddress?: string;
  maxGasAmount?: number;
  dryRun?: boolean;
}) {
  const {
    safeAddress,
    amountBaseUnits,
    adapterAddress = MOAR_ADAPTER_ADDRESS_MAINNET,
    metadataAddress = USDC_FA_METADATA_MAINNET,
    maxGasAmount,
    dryRun,
  } = options;

  return buildAndSubmit({
    function: YIELD_AI_VAULT_ENTRYPOINTS.executeDeposit,
    functionArguments: [
      toCanonicalAddress(safeAddress),
      toCanonicalAddress(adapterAddress),
      amountBaseUnits,
      toCanonicalAddress(metadataAddress),
    ],
    maxGasAmount,
    dryRun,
    logPrefix: "[Yield AI] execute_deposit",
  });
}

