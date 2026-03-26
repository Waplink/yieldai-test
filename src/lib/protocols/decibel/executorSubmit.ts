import {
  Aptos,
  AptosConfig,
  Account,
  Ed25519PrivateKey,
  Network,
} from "@aptos-labs/ts-sdk";

type EntryFunctionId = `${string}::${string}::${string}`;

const APTOS_API_KEY = process.env.APTOS_API_KEY;

let cachedExecutorAccount: Account | null = null;

export function getDecibelExecutorAccount(): Account {
  if (cachedExecutorAccount) return cachedExecutorAccount;
  const privateKeyHex = process.env.YIELD_AI_EXECUTOR_PRIVATE_KEY;
  if (!privateKeyHex) {
    throw new Error("YIELD_AI_EXECUTOR_PRIVATE_KEY is not configured");
  }
  const keyHex = privateKeyHex.replace(/^0x/, "").trim();
  cachedExecutorAccount = Account.fromPrivateKey({
    privateKey: new Ed25519PrivateKey(keyHex),
  });
  return cachedExecutorAccount;
}

function getAptosClient(network: "mainnet" | "testnet"): Aptos {
  const aptosNetwork = network === "testnet" ? Network.TESTNET : Network.MAINNET;
  const config = new AptosConfig({
    network: aptosNetwork,
    ...(APTOS_API_KEY && {
      clientConfig: {
        HEADERS: { Authorization: `Bearer ${APTOS_API_KEY}` },
      },
    }),
  });
  return new Aptos(config);
}

export async function submitExecutorEntryFunction(params: {
  network: "mainnet" | "testnet";
  fn: string;
  functionArguments: (string | number | boolean | bigint | null)[];
  maxGasAmount?: number;
}): Promise<string> {
  const { network, fn, functionArguments, maxGasAmount = 20_000 } = params;
  const aptos = getAptosClient(network);
  const executor = getDecibelExecutorAccount();

  const transaction = await aptos.transaction.build.simple({
    sender: executor.accountAddress,
    withFeePayer: false,
    data: {
      function: fn as EntryFunctionId,
      typeArguments: [],
      functionArguments,
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

  await aptos.waitForTransaction({
    transactionHash: hash,
  });
  return hash;
}
