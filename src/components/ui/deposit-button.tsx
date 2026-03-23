import { Button } from "@/components/ui/button";
import { ExternalLink, ArrowLeft, ArrowRight, ChevronDown } from "lucide-react";
import { Protocol } from "@/lib/protocols/getProtocolsList";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useState, useEffect, useCallback, useRef } from "react";
import { DepositModal } from "./deposit-modal";
import { JupiterDepositModal } from "./jupiter-deposit-modal";
import { useWalletData } from "@/contexts/WalletContext";
import { cn } from "@/lib/utils";
import { getAptosWalletNameFromStorage, isDerivedAptosWalletReliable } from "@/lib/aptosWalletUtils";
import { getSolanaWalletAddress } from "@/lib/wallet/getSolanaWalletAddress";
import { useWallet as useSolanaWallet } from "@solana/wallet-adapter-react";
import { Connection, PublicKey, SystemProgram, Transaction, VersionedTransaction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
} from "@solana/spl-token";
import { useSolanaPortfolio } from "@/hooks/useSolanaPortfolio";
import { useToast } from "@/components/ui/use-toast";
import { ToastAction } from "@/components/ui/toast";
import { Token as SolanaToken } from "@/lib/types/token";
import {
  useWallet,
  AboutAptosConnect,
  AboutAptosConnectEducationScreen,
  AdapterNotDetectedWallet,
  AdapterWallet,
  AptosPrivacyPolicy,
  WalletItem,
  groupAndSortWallets,
  isInstallRequired,
} from "@aptos-labs/wallet-adapter-react";

interface DepositButtonProps {
  protocol: Protocol;
  className?: string;
  tokenIn?: {
    symbol: string;
    logo: string;
    decimals: number;
    address?: string;
  };
  tokenOut?: {
    symbol: string;
    logo: string;
    address?: string;
    decimals: number;
  };
  balance?: bigint;
  priceUSD?: number;
  poolAddress?: string;
  solanaTokensOverride?: SolanaToken[];
  refreshSolanaOverride?: () => Promise<void>;
}

const JUPITER_MINT_BY_SYMBOL: Record<string, string> = {
  WSOL: "So11111111111111111111111111111111111111112",
  JUPUSD: "JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  EURC: "HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr",
  USDG: "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH",
  USDS: "USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA",
};
const JUPITER_PREFER_LEGACY_SYMBOLS = new Set(["WSOL", "USDG"]);
const SOL_FEE_RESERVE_UI = 0.003;

function normalizeMint(value?: string | null): string {
  return (value ?? "").trim();
}

function canonicalJupiterSymbol(value?: string | null): string {
  const normalized = (value ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (normalized.startsWith("WSOL")) return "WSOL";
  if (normalized.startsWith("SOL")) return "WSOL";
  if (normalized.startsWith("USDC")) return "USDC";
  if (normalized.startsWith("USDT")) return "USDT";
  if (normalized.startsWith("USDS")) return "USDS";
  if (normalized.startsWith("USDG")) return "USDG";
  if (normalized.startsWith("EURC")) return "EURC";
  if (normalized.startsWith("JUPUSD")) return "JUPUSD";
  return normalized;
}

function decodeBase64Tx(base64Tx: string): Uint8Array {
  const decoded = atob(base64Tx);
  return Uint8Array.from(decoded, (char) => char.charCodeAt(0));
}

function isVersionedTransactionBytes(serialized: Uint8Array): boolean {
  // Solana versioned transaction starts with a version discriminator bit.
  return serialized.length > 0 && (serialized[0] & 0x80) !== 0;
}

function getErrorText(error: unknown): string {
  if (error instanceof Error) return error.message || "Unknown error";
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const maybeMessage = (error as { message?: unknown }).message;
    if (typeof maybeMessage === "string" && maybeMessage.trim().length > 0) {
      return maybeMessage;
    }
    try {
      return JSON.stringify(error);
    } catch {
      return "Unknown error";
    }
  }
  return "Unknown error";
}

function toBase58Address(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof (value as { toBase58?: () => string }).toBase58 === "function") {
    try {
      return (value as { toBase58: () => string }).toBase58();
    } catch {
      // noop
    }
  }
  if (typeof (value as { toString?: () => string }).toString === "function") {
    try {
      return (value as { toString: () => string }).toString();
    } catch {
      // noop
    }
  }
  return "";
}

export function DepositButton({
  protocol,
  className,
  tokenIn,
  tokenOut = tokenIn,
  balance,
  priceUSD,
  poolAddress,
  solanaTokensOverride,
  refreshSolanaOverride,
}: DepositButtonProps) {
  const isJupiterProtocol = protocol.name.toLowerCase() === "jupiter";

  const [isExternalDialogOpen, setIsExternalDialogOpen] = useState(false);
  const [isNativeDialogOpen, setIsNativeDialogOpen] = useState(false);
  const [isJupiterDialogOpen, setIsJupiterDialogOpen] = useState(false);
  const [isJupiterDepositing, setIsJupiterDepositing] = useState(false);
  const isJupiterDepositInFlightRef = useRef(false);
  const attemptedSolanaReconnectRef = useRef(false);
  const [isWalletDialogOpen, setIsWalletDialogOpen] = useState(false);
  const [protocolAPY, setProtocolAPY] = useState<number>(0); // No fallback - use real APR from API
  const [resolvedTokenIn, setResolvedTokenIn] = useState<DepositButtonProps['tokenIn']>(tokenIn);
  const [resolvedPriceUSD, setResolvedPriceUSD] = useState<number>(priceUSD || 0);
  const walletData = useWalletData();
  const { connected, wallet: aptosWallet } = useWallet();
  const {
    publicKey: solanaPublicKey,
    signTransaction,
    sendTransaction,
    connecting: solanaConnecting,
    wallet: solanaWallet,
    wallets: solanaWallets,
    select: selectSolanaWallet,
    connect: connectSolanaWallet,
  } = useSolanaWallet();
  const {
    address: hookedSolanaAddress,
    tokens: hookedSolanaTokens,
    refresh: hookedRefreshSolana,
  } = useSolanaPortfolio({
    enabled: isJupiterProtocol && !solanaTokensOverride,
  });
  const solanaTokens = solanaTokensOverride ?? hookedSolanaTokens;
  const refreshSolana = refreshSolanaOverride ?? hookedRefreshSolana;
  const { toast } = useToast();

  const jupiterSymbol = canonicalJupiterSymbol(tokenIn?.symbol);
  const jupiterDisplaySymbol = jupiterSymbol === "WSOL" ? "SOL" : (tokenIn?.symbol || "");
  const isTrustWallet = (solanaWallet?.adapter?.name || "").toLowerCase().includes("trust");
  const adapterAny = solanaWallet?.adapter as
    | {
        connected?: boolean;
        sendTransaction?: (
          transaction: unknown,
          connection: Connection,
          options?: { skipPreflight?: boolean; preflightCommitment?: "processed" | "confirmed" | "finalized" }
        ) => Promise<string>;
        signTransaction?: (transaction: unknown) => Promise<{ serialize: () => Uint8Array }>;
      }
    | undefined;
  const adapterPublicKey = (solanaWallet?.adapter?.publicKey as PublicKey | null) ?? null;
  const adapterAddress = toBase58Address(adapterPublicKey);
  const derivedSolanaAddress = getSolanaWalletAddress(aptosWallet ?? null) ?? "";
  const effectiveSolanaAddress =
    toBase58Address(solanaPublicKey) || adapterAddress || hookedSolanaAddress || derivedSolanaAddress || "";
  const adapterSendTransaction =
    typeof adapterAny?.sendTransaction === "function"
      ? adapterAny.sendTransaction.bind(adapterAny)
      : undefined;
  const adapterSignTransaction =
    typeof adapterAny?.signTransaction === "function"
      ? adapterAny.signTransaction.bind(adapterAny)
      : undefined;
  const activeSendTransaction = sendTransaction ?? adapterSendTransaction;
  const activeSignTransaction = signTransaction ?? adapterSignTransaction;
  const hasSolanaSigner = !!activeSendTransaction || !!activeSignTransaction;
  const adapterSeemsReady = !!solanaWallet?.adapter?.connected || (!!adapterAddress && hasSolanaSigner);
  const hasAnySolanaSession =
    !!adapterAddress ||
    !!hookedSolanaAddress ||
    !!derivedSolanaAddress ||
    !!solanaConnecting ||
    !!solanaWallet?.adapter?.connected;
  const solanaAdapterIdentity = `${solanaWallet?.adapter?.name || "unknown"}:${effectiveSolanaAddress || "no-address"}:${solanaWallet?.adapter?.connected ? "connected" : "disconnected"}`;
  const prevSolanaAdapterIdentityRef = useRef<string>(solanaAdapterIdentity);
  const jupiterMint = normalizeMint(tokenIn?.address);
  const jupiterMintBySymbol = JUPITER_MINT_BY_SYMBOL[jupiterSymbol];
  const jupiterWalletAmount = (() => {
    const resolvedMint = jupiterMint || jupiterMintBySymbol || "";
    if (!resolvedMint) return 0;

    const token =
      solanaTokens.find((t) => normalizeMint(t.address) === resolvedMint) ||
      (jupiterMintBySymbol
        ? solanaTokens.find((t) => normalizeMint(t.address) === jupiterMintBySymbol)
        : undefined) ||
      (jupiterSymbol
        ? solanaTokens.find(
            (t) => canonicalJupiterSymbol(t.symbol) === jupiterSymbol
          )
        : undefined);

    if (!token) return 0;
    const rawAmount = Number(token.amount);
    const decimals = Number(token.decimals);
    if (!Number.isFinite(rawAmount) || !Number.isFinite(decimals) || decimals < 0) return 0;
    return rawAmount / Math.pow(10, decimals);
  })();

  // Fetch real APR data for Amnis Finance, Echelon, and Kofi Finance
  useEffect(() => {
    if (protocol.name === 'Amnis Finance') {
      const fetchAmnisAPR = async () => {
        try {
          const response = await fetch('/api/protocols/amnis/pools');
          if (response.ok) {
            const data = await response.json();
            if (data.success && data.pools && data.pools.length > 0) {
              // Use APT staking pool APR
              const aptPool = data.pools.find((pool: any) => pool.asset === 'APT');
              if (aptPool && aptPool.apr) {
                setProtocolAPY(aptPool.apr);
              }
            }
          }
        } catch (error) {
          console.error('Error fetching Amnis APR:', error);
        }
      };

      fetchAmnisAPR();
    } else if (protocol.name === 'Echelon') {
      const fetchEchelonAPY = async () => {
        try {
          const response = await fetch('/api/protocols/echelon/v2/pools');
          if (response.ok) {
            const data = await response.json();
            if (data.success && data.data && data.data.length > 0) {
              // Find the pool for this specific token
              const tokenAddr = tokenIn?.address;
              const pool = data.data.find((pool: any) =>
                (pool.token === tokenAddr ||
                  pool.coinAddress === tokenAddr ||
                  pool.faAddress === tokenAddr) &&
                pool.asset &&
                !pool.asset.includes('(Borrow)')
              );
              if (pool && pool.depositApy) {
                setProtocolAPY(pool.depositApy);
              } else {
              }
            }
          }
        } catch (error) {
          console.error('Error fetching Echelon APR:', error);
        }
      };

      fetchEchelonAPY();
    } else if (protocol.name === 'Kofi Finance') {
      const fetchKofiAPY = async () => {
        try {
          const response = await fetch('/api/protocols/kofi/pools');
          if (response.ok) {
            const data = await response.json();
            if (data.success && data.data && data.data.length > 0) {
              // Find stkAPT staking pool
              const stkAPTPool = data.data.find((pool: any) =>
                pool.stakingToken === 'stkAPT' || pool.asset?.includes('stkAPT')
              );
              if (stkAPTPool && stkAPTPool.stakingApr) {
                setProtocolAPY(stkAPTPool.stakingApr);
              } else {
              }
            }
          }
        } catch (error) {
          console.error('Error fetching Kofi Finance APR:', error);
        }
      };

      fetchKofiAPY();
    } else if (protocol.name === 'Moar Market') {
      const fetchMoarAPY = async () => {
        try {
          const response = await fetch('/api/protocols/moar/pools');
          if (response.ok) {
            const data = await response.json();
            if (data.success && data.data && data.data.length > 0) {
              // Find the pool for this specific token
              const pool = data.data.find((pool: any) =>
                pool.token === tokenIn?.address
              );
              if (pool && pool.totalAPY) {
                setProtocolAPY(pool.totalAPY);
              }
            }
          }
        } catch (error) {
          console.error('Error fetching Moar Market APR:', error);
        }
      };

      fetchMoarAPY();
    } else if (protocol.name === 'Auro Finance') {
      const fetchAuroAPY = async () => {
        try {
          const response = await fetch('/api/protocols/auro/pools');
          if (response.ok) {
            const data = await response.json();
            if (data.success && data.data && data.data.length > 0) {
              // Find the pool for this specific token - only COLLATERAL type
              const pool = data.data.find((pool: any) =>
                pool.type === 'COLLATERAL' && pool.collateralTokenAddress === tokenIn?.address
              );
              if (pool && pool.totalSupplyApr) {
                setProtocolAPY(pool.totalSupplyApr);
              }
            }
          }
        } catch (error) {
          console.error('Error fetching Auro Finance APR:', error);
        }
      };

      fetchAuroAPY();
    }
  }, [protocol.name, tokenIn?.address]);

  // Resolve token metadata for Echelon deposits (e.g. DLP) when tokenList doesn't contain the token.
  // This is only triggered when the DepositModal is opened, to avoid spamming requests for every table row.
  useEffect(() => {
    const resolveTokenInfo = async () => {
      if (!isNativeDialogOpen) return;
      if (protocol.name !== 'Echelon') return;
      if (!tokenIn?.address) return;

      // If we already have a usable logo from tokenList, don't fetch.
      if (tokenIn.logo && tokenIn.logo !== '/file.svg') {
        setResolvedTokenIn(tokenIn);
        setResolvedPriceUSD(priceUSD || 0);
        return;
      }

      try {
        const res = await fetch(`/api/tokens/info?address=${encodeURIComponent(tokenIn.address)}`);
        if (!res.ok) return;
        const data = await res.json();
        if (!data?.success || !data?.data) return;

        const fetched = data.data;
        setResolvedTokenIn({
          symbol: fetched.symbol ?? tokenIn.symbol,
          logo: fetched.logoUrl ?? tokenIn.logo ?? '/file.svg',
          decimals: typeof fetched.decimals === 'number' ? fetched.decimals : tokenIn.decimals,
          address: tokenIn.address
        });
        setResolvedPriceUSD(typeof fetched.price === 'number' ? fetched.price : (priceUSD || 0));
      } catch {
        // Ignore token resolution failures; modal will use provided tokenIn props.
      }
    };

    resolveTokenInfo();
  }, [isNativeDialogOpen, protocol.name, tokenIn?.address, tokenIn?.logo, tokenIn?.decimals, priceUSD]);

  // Закрываем диалог подключения кошелька, когда кошелек подключится
  useEffect(() => {
    if (connected && isWalletDialogOpen) {
      setIsWalletDialogOpen(false);
    }
  }, [connected, isWalletDialogOpen]);

  // Reset local Jupiter flow state when active Solana adapter identity changes.
  // This prevents stale signer/in-flight state after switching wallets (Trust <-> Phantom).
  useEffect(() => {
    if (prevSolanaAdapterIdentityRef.current !== solanaAdapterIdentity) {
      const isDepositFlowBusy = isJupiterDepositing || isJupiterDepositInFlightRef.current;
      // Do not interrupt active "reconnect -> submit" flow to avoid button flicker.
      if (!isDepositFlowBusy) {
        isJupiterDepositInFlightRef.current = false;
        setIsJupiterDepositing(false);
      }
      attemptedSolanaReconnectRef.current = false;
      prevSolanaAdapterIdentityRef.current = solanaAdapterIdentity;
    }
  }, [solanaAdapterIdentity, isJupiterDepositing]);

  const resolveSolanaSession = useCallback(() => {
    const connectedAdapterFromList = solanaWallets.find((w) => w?.adapter?.connected)?.adapter;
    const runtimeAdapter = (solanaWallet?.adapter || connectedAdapterFromList) as
      | {
          connected?: boolean;
          publicKey?: PublicKey | null;
          sendTransaction?: (
            transaction: unknown,
            connection: Connection,
            options?: { skipPreflight?: boolean; preflightCommitment?: "processed" | "confirmed" | "finalized" }
          ) => Promise<string>;
          signTransaction?: (transaction: unknown) => Promise<{ serialize: () => Uint8Array }>;
        }
      | undefined;

    const runtimeAdapterAddress = toBase58Address(runtimeAdapter?.publicKey);
    const runtimeSignerAddress = toBase58Address(solanaPublicKey) || runtimeAdapterAddress || "";

    const runtimeSend =
      sendTransaction ??
      (typeof runtimeAdapter?.sendTransaction === "function"
        ? runtimeAdapter.sendTransaction.bind(runtimeAdapter)
        : undefined);
    const runtimeSign =
      signTransaction ??
      (typeof runtimeAdapter?.signTransaction === "function"
        ? runtimeAdapter.signTransaction.bind(runtimeAdapter)
        : undefined);

    return {
      adapter: runtimeAdapter,
      signerAddress: runtimeSignerAddress,
      sendTransaction: runtimeSend,
      signTransaction: runtimeSign,
      hasSigner: !!runtimeSend || !!runtimeSign,
      hasSession:
        !!runtimeSignerAddress ||
        !!runtimeAdapter?.connected ||
        !!solanaConnecting ||
        !!hookedSolanaAddress ||
        !!getSolanaWalletAddress(aptosWallet ?? null),
      adapterReady: !!runtimeAdapter?.connected || (!!runtimeAdapterAddress && (!!runtimeSend || !!runtimeSign)),
    };
  }, [solanaWallet, solanaWallets, solanaPublicKey, hookedSolanaAddress, aptosWallet, sendTransaction, signTransaction, solanaConnecting]);

  const waitForReadySolanaSession = useCallback(
    async (retries = 20, delayMs = 250) => {
      let session = resolveSolanaSession();
      for (let i = 0; i < retries && (!session.signerAddress || !session.hasSigner); i++) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        session = resolveSolanaSession();
      }
      return session;
    },
    [resolveSolanaSession]
  );

  const recoverSolanaWalletSelection = useCallback(async () => {
    const preferredName =
      (solanaWallet?.adapter?.name as string | undefined) ||
      (solanaWallets.find((w) => w?.adapter?.connected)?.adapter?.name as string | undefined) ||
      (() => {
        try {
          const raw = window.localStorage.getItem("walletName");
          if (!raw) return undefined;
          const parsed = JSON.parse(raw);
          return typeof parsed === "string" ? parsed : undefined;
        } catch {
          return undefined;
        }
      })();

    if (!preferredName) return;

    const exists = solanaWallets.some((w) => w?.adapter?.name === preferredName);
    if (exists && typeof selectSolanaWallet === "function") {
      try {
        selectSolanaWallet(preferredName as any);
      } catch {
        // ignore
      }
    }

    if (typeof connectSolanaWallet === "function") {
      try {
        await connectSolanaWallet();
      } catch {
        // ignore
      }
    }
  }, [solanaWallet, solanaWallets, selectSolanaWallet, connectSolanaWallet]);

  const handleClick = async () => {
    if (isJupiterProtocol) {
      const session = resolveSolanaSession();
      if (!session.signerAddress || !session.hasSigner) {
        if (session.hasSession || hasAnySolanaSession || !!effectiveSolanaAddress) {
          // Allow opening modal while wallet APIs are still warming up after reconnect.
          setIsJupiterDialogOpen(true);
          return;
        }
        toast({
          title: "Solana wallet required",
          description: "Connect Solana wallet to deposit to Jupiter.",
          variant: "destructive",
        });
        return;
      }
      setIsJupiterDialogOpen(true);
      return;
    }

    // Если кошелек не подключен, открываем диалог подключения
    if (!connected) {
      setIsWalletDialogOpen(true);
      return;
    }

    if (protocol.depositType === 'external') {
      setIsExternalDialogOpen(true);
    } else if (protocol.depositType === 'native' && tokenIn && balance) {
      setIsNativeDialogOpen(true);
    } else {
    }
  };

  const closeWalletDialog = useCallback(() => setIsWalletDialogOpen(false), []);

  const handleExternalConfirm = () => {
    if (protocol.depositUrl) {
      window.open(protocol.depositUrl, '_blank');
    }
    setIsExternalDialogOpen(false);
  };

  const handleNativeConfirm = (data: { amount: bigint }) => {
    setIsNativeDialogOpen(false);
  };

  const handleJupiterDepositConfirm = async (amountUi: number) => {
    if (isJupiterDepositInFlightRef.current || isJupiterDepositing) {
      return;
    }
    setIsJupiterDepositing(true);

    const depositAssetMint = jupiterMint || jupiterMintBySymbol || normalizeMint(tokenIn?.address);
    if (!depositAssetMint) {
      toast({
        title: "Token error",
        description: "Jupiter token address is missing.",
        variant: "destructive",
      });
      setIsJupiterDepositing(false);
      return;
    }
    const session = await waitForReadySolanaSession();
    const signerAddress = session.signerAddress || toBase58Address(solanaPublicKey) || adapterAddress || "";
    const runtimeSendTransaction = session.sendTransaction ?? activeSendTransaction;
    const runtimeSignTransaction = session.signTransaction ?? activeSignTransaction;
    let resolvedSignerAddress = signerAddress;
    let resolvedSendTransaction = runtimeSendTransaction;
    let resolvedSignTransaction = runtimeSignTransaction;

    if (!resolvedSignerAddress || (!resolvedSendTransaction && !resolvedSignTransaction)) {
      const adapter = (session.adapter ||
        solanaWallet?.adapter ||
        solanaWallets.find((w) => w?.adapter?.connected)?.adapter) as { connect?: () => Promise<void> } | undefined;
      if (adapter && typeof adapter.connect === "function" && !attemptedSolanaReconnectRef.current) {
        attemptedSolanaReconnectRef.current = true;
        try {
          await adapter.connect();
        } catch (reconnectError) {
          // ignore and keep fallback handling below
          console.warn("[Jupiter][Deposit] adapter reconnect failed", reconnectError);
        }
        const retried = await waitForReadySolanaSession(8, 250);
        resolvedSignerAddress =
          retried.signerAddress ||
          toBase58Address(solanaPublicKey) ||
          toBase58Address((session.adapter as { publicKey?: PublicKey | null } | undefined)?.publicKey) ||
          toBase58Address(solanaWallet?.adapter?.publicKey) ||
          "";
        resolvedSendTransaction = retried.sendTransaction ?? activeSendTransaction;
        resolvedSignTransaction = retried.signTransaction ?? activeSignTransaction;
      }
    }

    if (!resolvedSignerAddress || (!resolvedSendTransaction && !resolvedSignTransaction)) {
      await recoverSolanaWalletSelection();
      const retriedAfterSelect = await waitForReadySolanaSession(10, 250);
      resolvedSignerAddress =
        retriedAfterSelect.signerAddress ||
        toBase58Address(solanaPublicKey) ||
        toBase58Address(solanaWallet?.adapter?.publicKey) ||
        "";
      resolvedSendTransaction = retriedAfterSelect.sendTransaction ?? activeSendTransaction;
      resolvedSignTransaction = retriedAfterSelect.signTransaction ?? activeSignTransaction;
    }

    if (!resolvedSignerAddress || (!resolvedSendTransaction && !resolvedSignTransaction)) {
      if (session.hasSession || hasAnySolanaSession) {
        toast({
          title: "Solana wallet reconnecting",
          description: "Wallet API is unavailable after auto-reconnect attempts. Reconnect Solana wallet and try again.",
        });
        setIsJupiterDepositing(false);
        return;
      }
      toast({
        title: "Solana wallet required",
        description: "Connect Solana wallet to deposit to Jupiter.",
        variant: "destructive",
      });
      setIsJupiterDepositing(false);
      return;
    }
    if (!Number.isFinite(amountUi) || amountUi <= 0) {
      toast({
        title: "Invalid amount",
        description: "Enter a valid deposit amount.",
        variant: "destructive",
      });
      setIsJupiterDepositing(false);
      return;
    }
    if (jupiterSymbol === "WSOL") {
      const maxSpendableSol = Math.max(0, jupiterWalletAmount - SOL_FEE_RESERVE_UI);
      if (amountUi > maxSpendableSol + 1e-12) {
        toast({
          title: "Leave SOL for fees",
          description: `For SOL deposits, keep about ${SOL_FEE_RESERVE_UI} SOL for network fees. Max now: ${maxSpendableSol.toFixed(6)} SOL.`,
          variant: "destructive",
        });
        setIsJupiterDepositing(false);
        return;
      }
    }
    if (amountUi > jupiterWalletAmount + 1e-12) {
      toast({
        title: "Insufficient balance",
        description: `Available: ${jupiterWalletAmount.toFixed(6)} ${jupiterDisplaySymbol || tokenIn?.symbol || "token"}.`,
        variant: "destructive",
      });
      setIsJupiterDepositing(false);
      return;
    }

    const decimals = tokenIn?.decimals ?? 0;
    const amountBaseUnits = Math.floor(amountUi * Math.pow(10, decimals));
    if (!Number.isFinite(amountBaseUnits) || amountBaseUnits <= 0) {
      toast({
        title: "Amount too small",
        description: "Increase amount to meet token precision.",
        variant: "destructive",
      });
      setIsJupiterDepositing(false);
      return;
    }

    try {
      isJupiterDepositInFlightRef.current = true;
      setIsJupiterDepositing(true);
      const endpoint =
        process.env.NEXT_PUBLIC_SOLANA_RPC_URL ||
        process.env.SOLANA_RPC_URL ||
        (process.env.NEXT_PUBLIC_SOLANA_RPC_API_KEY || process.env.SOLANA_RPC_API_KEY
          ? `https://mainnet.helius-rpc.com/?api-key=${process.env.NEXT_PUBLIC_SOLANA_RPC_API_KEY || process.env.SOLANA_RPC_API_KEY}`
          : "https://mainnet.helius-rpc.com/?api-key=29798653-2d13-4d8a-96ad-df70b015e234");
      const connection = new Connection(endpoint, "confirmed");

      // SOL uses dedicated 2-step flow:
      // 1) wrap SOL -> WSOL (separate transaction), 2) Jupiter deposit.
      if (jupiterSymbol === "WSOL") {
        const owner = new PublicKey(resolvedSignerAddress);
        const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, owner, false);
        const {
          blockhash: wrapBlockhash,
          lastValidBlockHeight: wrapLastValidBlockHeight,
        } = await connection.getLatestBlockhash("confirmed");
        const wrapTx = new Transaction();
        wrapTx.feePayer = owner;
        wrapTx.recentBlockhash = wrapBlockhash;
        wrapTx.add(
          createAssociatedTokenAccountIdempotentInstruction(owner, wsolAta, owner, NATIVE_MINT)
        );
        wrapTx.add(
          SystemProgram.transfer({
            fromPubkey: owner,
            toPubkey: wsolAta,
            lamports: amountBaseUnits,
          })
        );
        wrapTx.add(createSyncNativeInstruction(wsolAta));

        let wrapSignature: string;
        const wrapAttemptErrors: string[] = [];
        if (resolvedSendTransaction && !isTrustWallet) {
          try {
            wrapSignature = await resolvedSendTransaction(wrapTx as any, connection, {
              skipPreflight: false,
              preflightCommitment: "confirmed",
            });
          } catch (sendError) {
            wrapAttemptErrors.push(`sendTransaction: ${getErrorText(sendError)}`);
            if (!resolvedSignTransaction) {
              throw new Error(wrapAttemptErrors.join(" | "));
            }
            const signedWrap = await resolvedSignTransaction(wrapTx as any);
            wrapSignature = await connection.sendRawTransaction(signedWrap.serialize(), {
              skipPreflight: false,
              preflightCommitment: "confirmed",
            });
          }
        } else {
          if (!resolvedSignTransaction) {
            throw new Error("Solana signer is not ready");
          }
          try {
            const signedWrap = await resolvedSignTransaction(wrapTx as any);
            wrapSignature = await connection.sendRawTransaction(signedWrap.serialize(), {
              skipPreflight: false,
              preflightCommitment: "confirmed",
            });
          } catch (signError) {
            wrapAttemptErrors.push(`signTransaction: ${getErrorText(signError)}`);
            if (!resolvedSendTransaction) {
              throw new Error(wrapAttemptErrors.join(" | "));
            }
            wrapSignature = await resolvedSendTransaction(wrapTx as any, connection, {
              skipPreflight: false,
              preflightCommitment: "confirmed",
            });
          }
        }
        const wrapConfirmation = await connection.confirmTransaction(
          {
            signature: wrapSignature,
            blockhash: wrapBlockhash,
            lastValidBlockHeight: wrapLastValidBlockHeight,
          },
          "confirmed"
        );
        if (wrapConfirmation.value.err) {
          throw new Error(`SOL wrap failed: ${JSON.stringify(wrapConfirmation.value.err)}`);
        }
      }

      const txResp = await fetch("/api/protocols/jupiter/deposit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          asset: depositAssetMint,
          signer: resolvedSignerAddress,
          amount: String(amountBaseUnits),
          preferLegacyInstruction: JUPITER_PREFER_LEGACY_SYMBOLS.has(jupiterSymbol),
        }),
      });
      const txData = await txResp.json().catch(() => null);
      if (!txResp.ok || !txData?.success || !txData?.data?.transaction) {
        throw new Error(txData?.error || `Deposit prepare failed: ${txResp.status}`);
      }

      const serialized = decodeBase64Tx(txData.data.transaction);

      const txForWallet = isVersionedTransactionBytes(serialized)
        ? VersionedTransaction.deserialize(serialized)
        : Transaction.from(serialized);

      let signature: string;
      const attemptErrors: string[] = [];
      if (resolvedSendTransaction && !isTrustWallet) {
        try {
          signature = await resolvedSendTransaction(txForWallet as any, connection, {
            skipPreflight: false,
            preflightCommitment: "confirmed",
          });
        } catch (sendError) {
          attemptErrors.push(`sendTransaction: ${getErrorText(sendError)}`);
          if (!resolvedSignTransaction) {
            throw new Error(attemptErrors.join(" | "));
          }
          const signed = await resolvedSignTransaction(txForWallet as any);
          signature = await connection.sendRawTransaction(signed.serialize(), {
            skipPreflight: false,
            preflightCommitment: "confirmed",
          });
        }
      } else {
        if (!resolvedSignTransaction) {
          throw new Error("Solana signer is not ready");
        }
        try {
          const signed = await resolvedSignTransaction(txForWallet as any);
          signature = await connection.sendRawTransaction(signed.serialize(), {
            skipPreflight: false,
            preflightCommitment: "confirmed",
          });
        } catch (signError) {
          attemptErrors.push(`signTransaction: ${getErrorText(signError)}`);
          if (!resolvedSendTransaction) {
            throw new Error(attemptErrors.join(" | "));
          }
          signature = await resolvedSendTransaction(txForWallet as any, connection, {
            skipPreflight: false,
            preflightCommitment: "confirmed",
          });
        }
      }
      const confirmation = await connection.confirmTransaction(signature, "confirmed");
      if (confirmation.value.err) {
        throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
      }

      await refreshSolana();
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("refreshPositions", { detail: { protocol: "jupiter" } }));
      }
      toast({
        title: "Deposit submitted",
        description: `Deposited ${amountUi} ${tokenIn?.symbol || jupiterDisplaySymbol || "token"}.`,
        action: (
          <ToastAction altText="View on Solscan" onClick={() => window.open(`https://solscan.io/tx/${signature}`, "_blank")}>
            View on Solscan
          </ToastAction>
        ),
      });
      setIsJupiterDialogOpen(false);
    } catch (error) {
      const message = getErrorText(error);
      const normalized = message.toLowerCase();
      if (
        normalized.includes("public_signrawtransaction") &&
        normalized.includes("already pending")
      ) {
        toast({
          title: "Signature request already pending",
          description: "Approve or reject the existing wallet request, then try again.",
          variant: "destructive",
        });
      } else if (normalized.includes("user rejected")) {
        toast({
          title: "Transaction cancelled",
          description: "Request was rejected in wallet.",
        });
      } else {
        toast({ title: "Deposit failed", description: message, variant: "destructive" });
      }
    } finally {
      isJupiterDepositInFlightRef.current = false;
      setIsJupiterDepositing(false);
    }
  };

  return (
    <>
      <Button
        variant={protocol.depositType === 'native' ? "default" : "secondary"}
        className={cn(
          className,
          protocol.depositType === 'native' && "bg-primary hover:bg-primary/90 text-primary-foreground font-semibold"
        )}
        onClick={handleClick}
      >
        Deposit
        {protocol.depositType === 'external' && (
          <ExternalLink className="ml-2 h-4 w-4" />
        )}
      </Button>

      <AlertDialog open={isExternalDialogOpen} onOpenChange={setIsExternalDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Go to protocol website?</AlertDialogTitle>
            <AlertDialogDescription>
              You will be redirected to {protocol.name} website to complete the deposit.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleExternalConfirm}>Continue</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {protocol.depositType === 'native' && !isJupiterProtocol && tokenIn && tokenIn.address && balance && (
        <DepositModal
          isOpen={isNativeDialogOpen}
          onClose={() => setIsNativeDialogOpen(false)}
          protocol={{
            name: protocol.name,
            logo: protocol.logoUrl || '/file.svg', // Add fallback
            apy: (() => {
              return protocolAPY;
            })(),
            key: protocol.key
          }}
          tokenIn={{
            symbol: resolvedTokenIn?.symbol ?? tokenIn.symbol,
            logo: resolvedTokenIn?.logo || tokenIn.logo || '/file.svg',
            decimals: resolvedTokenIn?.decimals ?? tokenIn.decimals,
            address: resolvedTokenIn?.address ?? tokenIn.address
          }}
          tokenOut={{
            symbol: resolvedTokenIn?.symbol ?? tokenIn.symbol,
            logo: resolvedTokenIn?.logo || tokenIn.logo || '/file.svg',
            decimals: resolvedTokenIn?.decimals ?? tokenIn.decimals,
            address: resolvedTokenIn?.address ?? tokenIn.address
          }}
          priceUSD={resolvedPriceUSD || 0}
        poolAddress={poolAddress}
        />
      )}

      {isJupiterProtocol && tokenIn && tokenIn.address && (
        <JupiterDepositModal
          isOpen={isJupiterDialogOpen}
          onClose={() => setIsJupiterDialogOpen(false)}
          onConfirm={handleJupiterDepositConfirm}
          isLoading={isJupiterDepositing}
          token={{
            symbol: jupiterDisplaySymbol,
            logoUrl: tokenIn.logo,
            availableAmount: jupiterWalletAmount,
            apy: protocolAPY,
            priceUsd: priceUSD || 0,
          }}
        />
      )}

      <Dialog open={isWalletDialogOpen} onOpenChange={setIsWalletDialogOpen}>
        <DialogContent className="max-h-screen overflow-auto">
          <ConnectWalletDialog close={closeWalletDialog} />
        </DialogContent>
      </Dialog>
    </>
  );
}

interface ConnectWalletDialogProps {
  close: () => void;
}

function ConnectWalletDialog({ close }: ConnectWalletDialogProps) {
  const { wallets = [], notDetectedWallets = [], wallet: selectedWallet, connected } = useWallet();
  const storedAptosWalletName = getAptosWalletNameFromStorage();
  const isSelectedDerived =
    connected &&
    (
      isDerivedAptosWalletReliable(selectedWallet as { name?: string } | null) ||
      String(storedAptosWalletName || "").trim().endsWith(" (Solana)")
    );

  const { aptosConnectWallets, availableWallets, installableWallets } =
    groupAndSortWallets(
      [...wallets, ...notDetectedWallets],
      {}
    );

  const hasAptosConnectWallets = !!aptosConnectWallets.length;

  return (
    <AboutAptosConnect renderEducationScreen={renderEducationScreen}>
      <DialogHeader>
        <DialogTitle className="flex flex-col text-center leading-snug">
          {hasAptosConnectWallets ? (
            <>
              <span>Log in or sign up</span>
              <span>with Social + Aptos Connect</span>
            </>
          ) : (
            "Connect Wallet"
          )}
        </DialogTitle>
      </DialogHeader>

      {hasAptosConnectWallets && (
        <div className="flex flex-col gap-2 pt-3">
          {aptosConnectWallets.map((wallet) => (
            <AptosConnectWalletRow
              key={wallet.name}
              wallet={wallet}
              onConnect={close}
              isDerivedSelected={isSelectedDerived}
            />
          ))}
          <p className="flex gap-1 justify-center items-center text-muted-foreground text-sm">
            Learn more about{" "}
            <AboutAptosConnect.Trigger className="flex gap-1 py-3 items-center text-foreground">
              Aptos Connect <ArrowRight size={16} />
            </AboutAptosConnect.Trigger>
          </p>
          <AptosPrivacyPolicy className="flex flex-col items-center py-1">
            <p className="text-xs leading-5">
              <AptosPrivacyPolicy.Disclaimer />{" "}
              <AptosPrivacyPolicy.Link className="text-muted-foreground underline underline-offset-4" />
              <span className="text-muted-foreground">.</span>
            </p>
            <AptosPrivacyPolicy.PoweredBy className="flex gap-1.5 items-center text-xs leading-5 text-muted-foreground" />
          </AptosPrivacyPolicy>
          <div className="flex items-center gap-3 pt-4 text-muted-foreground">
            <div className="h-px w-full bg-secondary" />
            Or
            <div className="h-px w-full bg-secondary" />
          </div>
        </div>
      )}

      <div className="flex flex-col gap-3 pt-3">
        {availableWallets.map((wallet) => (
          <WalletRow
            key={wallet.name}
            wallet={wallet}
            onConnect={close}
            isConnected={connected && selectedWallet?.name === wallet.name}
            isDerivedSelected={isSelectedDerived}
          />
        ))}
        {!!installableWallets.length && (
          <Collapsible className="flex flex-col gap-3">
            <CollapsibleTrigger asChild>
              <Button size="sm" variant="ghost" className="gap-2">
                More wallets <ChevronDown />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="flex flex-col gap-3">
              {installableWallets.map((wallet) => (
                <WalletRow
                  key={wallet.name}
                  wallet={wallet}
                  onConnect={close}
                  isConnected={connected && selectedWallet?.name === wallet.name}
                  isDerivedSelected={isSelectedDerived}
                />
              ))}
            </CollapsibleContent>
          </Collapsible>
        )}
      </div>
    </AboutAptosConnect>
  );
}

interface WalletRowProps {
  wallet: AdapterWallet | AdapterNotDetectedWallet;
  onConnect?: () => void;
  isConnected?: boolean;
  isDerivedSelected?: boolean;
}

function isDerivedAptosWalletName(name?: string): boolean {
  if (!name) return false;
  const normalized = name.toLowerCase();
  return normalized.includes("derived wallet") || normalized.endsWith(" (solana)");
}

function getWalletLabel(walletName: string, isConnected: boolean, isDerivedSelected: boolean): string {
  const normalized = walletName.trim().toLowerCase();
  if (normalized === "aptos") {
    return isConnected && isDerivedSelected ? "APTOS (Derived Wallet)" : "APTOS";
  }
  return walletName;
}

function WalletRow({ wallet, onConnect, isConnected = false, isDerivedSelected = false }: WalletRowProps) {
  const isDerived = isDerivedAptosWalletName(wallet.name);
  const walletLabel = getWalletLabel(wallet.name, isConnected, isDerivedSelected);
  return (
    <WalletItem
      wallet={wallet}
      onConnect={onConnect}
      className="flex items-center justify-between px-4 py-3 gap-4 border rounded-md"
    >
      <div className="flex items-center gap-4">
        <WalletItem.Icon className="h-6 w-6" />
        <span className="text-base font-normal">{walletLabel}</span>
      </div>
      {isInstallRequired(wallet) ? (
        <Button size="sm" variant="ghost" asChild>
          <WalletItem.InstallLink />
        </Button>
      ) : isConnected && isDerived ? (
        <Button size="sm" variant="secondary" disabled>
          Connected
        </Button>
      ) : (
        <WalletItem.ConnectButton asChild>
          <Button size="sm">Connect</Button>
        </WalletItem.ConnectButton>
      )}
    </WalletItem>
  );
}

function AptosConnectWalletRow({ wallet, onConnect, isDerivedSelected = false }: WalletRowProps) {
  const walletLabel = getWalletLabel(wallet.name, false, isDerivedSelected);
  return (
    <WalletItem wallet={wallet} onConnect={onConnect}>
      <WalletItem.ConnectButton asChild>
        <Button size="lg" variant="outline" className="w-full gap-4">
          <WalletItem.Icon className="h-5 w-5" />
          <span className="text-base font-normal">{walletLabel}</span>
        </Button>
      </WalletItem.ConnectButton>
    </WalletItem>
  );
}

function renderEducationScreen(screen: AboutAptosConnectEducationScreen) {
  return (
    <>
      <DialogHeader className="grid grid-cols-[1fr_4fr_1fr] items-center space-y-0">
        <Button variant="ghost" size="icon" onClick={screen.cancel}>
          <ArrowLeft />
        </Button>
        <DialogTitle className="leading-snug text-base text-center">
          About Aptos Connect
        </DialogTitle>
      </DialogHeader>

      <div className="flex h-[162px] pb-3 items-end justify-center">
        <screen.Graphic />
      </div>
      <div className="flex flex-col gap-2 text-center pb-4">
        <screen.Title className="text-xl" />
        <screen.Description className="text-sm text-muted-foreground [&>a]:underline [&>a]:underline-offset-4 [&>a]:text-foreground" />
      </div>

      <div className="grid grid-cols-3 items-center">
        <Button
          size="sm"
          variant="ghost"
          onClick={screen.back}
          className="justify-self-start"
        >
          Back
        </Button>
        <div className="flex items-center gap-2 place-self-center">
          {screen.screenIndicators.map((ScreenIndicator, i) => (
            <ScreenIndicator key={i} className="py-4">
              <div className="h-0.5 w-6 transition-colors bg-muted [[data-active]>&]:bg-foreground" />
            </ScreenIndicator>
          ))}
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={screen.next}
          className="gap-2 justify-self-end"
        >
          {screen.screenIndex === screen.totalScreens - 1 ? "Finish" : "Next"}
          <ArrowRight size={16} />
        </Button>
      </div>
    </>
  );
}
