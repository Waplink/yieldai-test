"use client";

import { useState, useEffect, useRef, Suspense, useMemo } from 'react';
import { useSearchParams } from 'next/navigation';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Copy, LogOut, ChevronDown, Loader2 } from 'lucide-react';
import { BridgeView } from '@/components/bridge/BridgeView';
import { useWallet as useSolanaWallet } from '@solana/wallet-adapter-react';
import { useWallet as useAptosWallet } from '@aptos-labs/wallet-adapter-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useToast } from '@/components/ui/use-toast';
import { SolanaWalletSelector } from '@/components/SolanaWalletSelector';
import { WalletSelector } from '@/components/WalletSelector';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { WalletReadyState, WalletName } from '@solana/wallet-adapter-base';
import { useSolanaPortfolio } from '@/hooks/useSolanaPortfolio';
import { AptosPortfolioService } from '@/lib/services/aptos/portfolio';
import { Token } from '@/lib/types/token';
import { TokenList } from '@/components/portfolio/TokenList';
import { formatCurrency } from '@/lib/utils/numberFormat';
import { cn } from '@/lib/utils';
import { ScrollArea } from '@/components/ui/scroll-area';
import { executeSolanaToAptosBridge } from '@/components/bridge/SolanaToAptosBridge';
import { executeAptosToSolanaBridge } from '@/components/bridge/AptosToSolanaBridge';
import { executeAptosNativeToSolanaBridge } from '@/components/bridge/AptosNativeToSolanaBridge';
import { isDerivedAptosWallet, isDerivedAptosWalletReliable, getAptosWalletNameFromStorage } from '@/lib/aptosWalletUtils';
import { ActionLog, type ActionLogItem } from '@/components/bridge/ActionLog';
import { useAptosClient } from '@/contexts/AptosClientContext';
import { GasStationService } from '@/lib/services/gasStation';
import { performMintOnSolana } from '@/lib/cctp-mint-core';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from '@/components/ui/dialog';

// USDC token addresses
const USDC_SOLANA = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // USDC on Solana
const USDC_APTOS = '0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b'; // USDC on Aptos

// Chains configuration
const CHAINS = [
  { id: 'Solana', name: 'Solana' },
  { id: 'Aptos', name: 'Aptos' },
];

// Tokens configuration
const TOKENS = [
  {
    id: USDC_SOLANA,
    symbol: 'USDC',
    name: 'USD Coin',
    chain: 'Solana',
  },
  {
    id: USDC_APTOS,
    symbol: 'USDC',
    name: 'USD Coin',
    chain: 'Aptos',
  },
];

function BridgePageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toast } = useToast();

  // Wallet connections
  const { publicKey: solanaPublicKey, connected: solanaConnected, disconnect: disconnectSolana, wallet: solanaWallet, wallets, select, connect: connectSolana, signTransaction: signSolanaTransaction, signMessage: signSolanaMessage } = useSolanaWallet();
  const { connection: solanaConnection } = useConnection();
  const { account: aptosAccount, connected: aptosConnected, wallet: aptosWallet, wallets: aptosWallets, connect: connectAptos, disconnect: disconnectAptos } = useAptosWallet();

  // Get Solana address - prefer adapter state over hook state for reliability
  // The hook state can desync from the actual adapter state
  const solanaAdapterConnected = solanaWallet?.adapter?.connected ?? false;
  const solanaAdapterPublicKey = solanaWallet?.adapter?.publicKey;
  
  // Use adapter state if available, fall back to hook state
  const effectiveSolanaConnected = solanaConnected || solanaAdapterConnected;
  const solanaAddress = solanaPublicKey?.toBase58() || solanaAdapterPublicKey?.toBase58() || null;

  // Re-check both wallets before mint (state may be lost during attestation wait)
  // Note: effectiveSolanaConnected is computed later, so we track both hook state and adapter state
  const solanaConnectedRef = useRef(solanaConnected);
  const solanaPublicKeyRef = useRef(solanaPublicKey);
  const signSolanaTransactionRef = useRef(signSolanaTransaction);
  const solanaWalletRef = useRef(solanaWallet);
  const aptosConnectedRef = useRef(aptosConnected);
  const aptosAccountRef = useRef(aptosAccount);
  useEffect(() => {
    // Track effective connection state (hook state OR adapter state)
    solanaConnectedRef.current = solanaConnected || (solanaWallet?.adapter?.connected ?? false);
    solanaPublicKeyRef.current = solanaPublicKey || solanaWallet?.adapter?.publicKey || null;
    signSolanaTransactionRef.current = signSolanaTransaction;
    solanaWalletRef.current = solanaWallet;
    aptosConnectedRef.current = aptosConnected;
    aptosAccountRef.current = aptosAccount;
  }, [solanaConnected, solanaPublicKey, signSolanaTransaction, solanaWallet, aptosConnected, aptosAccount]);

  // Solana wallet selector state
  const [isSolanaDialogOpen, setIsSolanaDialogOpen] = useState(false);
  const [isSolanaConnecting, setIsSolanaConnecting] = useState(false);
  // Force re-render counter - used after manual reconnect to update UI
  const [, forceUpdate] = useState(0);
  // Aptos wallet selector state
  const [isAptosDialogOpen, setIsAptosDialogOpen] = useState(false);
  const [isAptosConnecting, setIsAptosConnecting] = useState(false);
  
  // Fallback state for Aptos native when React state desyncs (e.g., after Solana disconnect)
  // This keeps track of the Aptos native wallet info so UI can show it while adapter reconnects
  const [aptosNativeFallback, setAptosNativeFallback] = useState<{
    address: string;
    name: string;
  } | null>(null);

  // Balance expansion state
  const [isSolanaBalanceExpanded, setIsSolanaBalanceExpanded] = useState(false);
  const [isAptosBalanceExpanded, setIsAptosBalanceExpanded] = useState(false);

  // Solana portfolio
  const {
    tokens: solanaTokens,
    totalValueUsd: solanaTotalValue,
    isLoading: isSolanaLoading,
    refresh: refreshSolana,
  } = useSolanaPortfolio();

  // Aptos portfolio state
  const [aptosTokens, setAptosTokens] = useState<Token[]>([]);
  const [aptosTotalValue, setAptosTotalValue] = useState<number>(0);
  const [isAptosLoading, setIsAptosLoading] = useState(false);

  // Form state variables (must be declared before useMemo hooks that use them)
  const [sourceChain, setSourceChain] = useState<typeof CHAINS[0] | null>(CHAINS[0]);
  const [sourceToken, setSourceToken] = useState<typeof TOKENS[0] | null>(
    TOKENS.find((t) => t.chain === 'Solana') || null
  );
  const [destChain, setDestChain] = useState<typeof CHAINS[0] | null>(CHAINS[1]);
  const [destToken, setDestToken] = useState<typeof TOKENS[0] | null>(
    TOKENS.find((t) => t.chain === 'Aptos') || null
  );
  const [transferAmount, setTransferAmount] = useState<string>('0.1');
  const [destinationAddress, setDestinationAddress] = useState<string>('');
  const [isTransferring, setIsTransferring] = useState(false);
  const [transferStatus, setTransferStatus] = useState<string>('');
  const [actionLog, setActionLog] = useState<ActionLogItem[]>([]);
  const [lastSolanaToAptosParams, setLastSolanaToAptosParams] = useState<{ signature: string; finalRecipient: string } | null>(null);
  const [lastAptosToSolanaParams, setLastAptosToSolanaParams] = useState<{ signature: string; finalRecipient: string } | null>(null);

  // Reliable derived vs native: localStorage AptosWalletName first ("X (Solana)" = derived), then wallet.name
  const solanaWalletNameForDerived = (solanaWallet as { adapter?: { name?: string }; name?: string })?.adapter?.name ?? (solanaWallet as { name?: string })?.name ?? '';
  const isDerivedWallet = useMemo(() => {
    if (aptosWallet) {
      if (isDerivedAptosWalletReliable(aptosWallet)) return true;
      return Boolean(solanaWalletNameForDerived && aptosWallet.name === solanaWalletNameForDerived);
    }
    const stored = getAptosWalletNameFromStorage();
    return Boolean(stored != null && stored !== '' && String(stored).trim().endsWith(' (Solana)'));
  }, [aptosWallet, solanaWalletNameForDerived]);

  // Restore Solana wallet from localStorage on bridge load
  // Priority: walletName first (standalone wallets like Phantom), then AptosWalletName for derived
  const hasTriggeredRestore = useRef(false);
  const prevSolanaConnected = useRef(solanaConnected);
  const prevEffectiveSolanaConnected = useRef(effectiveSolanaConnected);
  
  // Pending reconnect after Aptos derived disconnect (set by handleDisconnectAptos)
  const [pendingReconnectWallet, setPendingReconnectWallet] = useState<string | null>(null);
  
  // Effect to handle pending reconnect with fresh state
  useEffect(() => {
    if (!pendingReconnectWallet || effectiveSolanaConnected) {
      if (pendingReconnectWallet && effectiveSolanaConnected) {
        console.log('[pendingReconnect] Already connected, clearing pending');
        setPendingReconnectWallet(null);
      }
      return;
    }
    
    const walletToConnect = wallets.find(w => w.adapter.name === pendingReconnectWallet);
    if (!walletToConnect) {
      console.log('[pendingReconnect] Wallet not found:', pendingReconnectWallet);
      setPendingReconnectWallet(null);
      return;
    }
    
    console.log('[pendingReconnect] Attempting reconnect for:', pendingReconnectWallet);
    
    const doReconnect = async () => {
      try {
        select(pendingReconnectWallet as WalletName);
        
        // Wait a bit for selection to take effect
        await new Promise(r => setTimeout(r, 100));
        
        const adapter = walletToConnect.adapter;
        if (!adapter.connected) {
          console.log('[pendingReconnect] Calling adapter.connect()');
          await adapter.connect();
          console.log('[pendingReconnect] Adapter connected:', adapter.connected, adapter.publicKey?.toBase58());
        }
        
        // Force re-render to pick up new state
        forceUpdate(n => n + 1);
        setPendingReconnectWallet(null);
        
      } catch (e) {
        console.log('[pendingReconnect] Failed:', (e as Error)?.message);
        setPendingReconnectWallet(null);
      }
    };
    
    doReconnect();
  }, [pendingReconnectWallet, effectiveSolanaConnected, wallets, select]);
  
  // Reset restore flag when Solana disconnects (allows re-restore on reconnect attempt)
  // Check both hook state AND effective state (adapter state) since Phantom may only update adapter
  useEffect(() => {
    const wasConnected = prevSolanaConnected.current || prevEffectiveSolanaConnected.current;
    const isNowDisconnected = !solanaConnected && !effectiveSolanaConnected;
    
    if (wasConnected && isNowDisconnected) {
      console.log('[bridge-restore] Resetting hasTriggeredRestore flag (was connected, now disconnected)');
      hasTriggeredRestore.current = false;
    }
    
    prevSolanaConnected.current = solanaConnected;
    prevEffectiveSolanaConnected.current = effectiveSolanaConnected;
  }, [solanaConnected, effectiveSolanaConnected]);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    
    const walletNames = new Set<string>(wallets?.map((w) => String(w.adapter.name)) ?? []);
    const raw = window.localStorage.getItem('walletName');
    const aptosRaw = window.localStorage.getItem('AptosWalletName');
    const skipFlag = window.sessionStorage.getItem('skip_auto_connect_solana');
    
    console.log('[bridge-restore] Effect running:', {
      solanaConnected,
      walletCount: wallets?.length,
      walletNames: Array.from(walletNames),
      rawWalletName: raw,
      aptosWalletName: aptosRaw,
      skipFlag,
      hasTriggeredRestore: hasTriggeredRestore.current,
    });
    
    if (solanaConnected) {
      console.log('[bridge-restore] Already connected, skipping');
      return;
    }
    
    // Check skip flag
    if (skipFlag === '1') {
      console.log('[bridge-restore] Skip flag is set');
      return;
    }
    
    let savedName: string | null = null;
    
    // Primary: walletName — canonical Solana wallet key (prioritizes standalone wallets like Phantom)
    if (raw) {
      try {
        const p = JSON.parse(raw) as string | null;
        console.log('[bridge-restore] Parsed walletName:', p, 'exists in wallets:', p ? walletNames.has(p) : false);
        if (p && walletNames.has(p)) savedName = p;
      } catch {
        console.log('[bridge-restore] walletName not JSON, raw value:', raw, 'exists:', walletNames.has(raw));
        if (typeof raw === "string" && raw.length > 0 && walletNames.has(raw)) savedName = raw;
      }
    }
    
    // Secondary: AptosWalletName for derived wallets (e.g. "Trust (Solana)")
    if (!savedName && aptosRaw) {
      try {
        const parsed = JSON.parse(aptosRaw) as string | null;
        const aptosName = typeof parsed === 'string' ? parsed : aptosRaw;
        if (aptosName?.endsWith(' (Solana)')) {
          const name = aptosName.slice(0, -' (Solana)'.length).trim();
          console.log('[bridge-restore] Derived from AptosWalletName:', name, 'exists:', walletNames.has(name));
          if (name && walletNames.has(name)) savedName = name;
        }
      } catch {}
    }
    
    if (!savedName) {
      console.log('[bridge-restore] No valid saved wallet found');
      return;
    }
    
    console.log('[bridge-restore] Will restore:', savedName);

    const tryRestore = () => {
      if (solanaConnected || !wallets?.length) {
        console.log('[bridge-restore] tryRestore: skip (connected or no wallets)');
        return;
      }
      const exists = wallets.some((w) => w.adapter.name === savedName);
      if (!exists) {
        console.log('[bridge-restore] tryRestore: wallet not found:', savedName);
        return;
      }
      if (hasTriggeredRestore.current) {
        console.log('[bridge-restore] tryRestore: already triggered');
        return;
      }
      hasTriggeredRestore.current = true;
      console.log('[bridge-restore] tryRestore: selecting and connecting:', savedName);
      select(savedName as WalletName);
      
      const doConnect = async (attempt: number) => {
        // Check current wallet state from the adapter
        const currentWallet = wallets.find(w => w.adapter.name === savedName);
        console.log(`[bridge-restore] Attempt ${attempt}:`, {
          savedName,
          currentWalletFound: !!currentWallet,
          currentWalletName: currentWallet?.adapter?.name,
          currentWalletConnected: currentWallet?.adapter?.connected,
          currentWalletPublicKey: currentWallet?.adapter?.publicKey?.toBase58(),
          solanaConnected,
        });
        
        try {
          await connectSolana();
          console.log(`[bridge-restore] connectSolana resolved (attempt ${attempt}), now checking state...`);
          // Check state after connect
          setTimeout(() => {
            console.log(`[bridge-restore] Post-connect state (attempt ${attempt}):`, {
              adapterConnected: currentWallet?.adapter?.connected,
              adapterPublicKey: currentWallet?.adapter?.publicKey?.toBase58(),
            });
          }, 100);
        } catch (e: any) {
          console.log(`[bridge-restore] connectSolana failed (attempt ${attempt}):`, e?.name, e?.message);
          // If connection fails, try re-selecting the wallet
          if (attempt < 3) {
            select(savedName as WalletName);
          }
        }
      };
      
      setTimeout(() => doConnect(1), 150);
      setTimeout(() => doConnect(2), 500);
      setTimeout(() => doConnect(3), 1200);
    };

    tryRestore();
    const t1 = setTimeout(tryRestore, 400);
    const t2 = setTimeout(tryRestore, 1200);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [wallets, solanaConnected, select, connectSolana]);

  // Skip auto-connect derived when user explicitly disconnected Aptos (set synchronously on click)
  const skipAutoConnectDerivedRef = useRef(false);
  const hasTriedAutoConnectDerived = useRef(false);
  useEffect(() => {
    if (!aptosConnected || !aptosWallet || typeof window === "undefined") return;
    // Any successful connection means user intent is explicit again; allow derived auto-connect later.
    sessionStorage.removeItem("skip_auto_connect_derived_aptos");
    skipAutoConnectDerivedRef.current = false;
    hasTriedAutoConnectDerived.current = false;
  }, [aptosConnected, aptosWallet, solanaWalletNameForDerived]);

  // Restore native Aptos wallet after refresh if user selected native (Petra, etc.)
  const hasRestoredNativeAptosRef = useRef(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = getAptosWalletNameFromStorage();
    if (!stored || String(stored).trim().endsWith(" (Solana)")) return; // only native preference
    if (!aptosWallets?.length) return;
    if (aptosConnected && aptosWallet?.name === stored) {
      hasRestoredNativeAptosRef.current = false;
      return;
    }
    if (hasRestoredNativeAptosRef.current) return;
    const exists = aptosWallets.some((w) => w.name === stored);
    if (!exists) return;
    hasRestoredNativeAptosRef.current = true;
    // Wrap in async IIFE to catch errors (user may reject popup)
    (async () => {
      try {
        await connectAptos(stored);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Silently ignore user rejection and already connected errors
        if (msg.includes("User") || msg.includes("rejected") || msg.includes("already connected")) {
          console.log('[native-aptos-restore] User rejected or already connected:', msg);
        } else {
          console.error('[native-aptos-restore] Connect error:', e);
        }
      }
    })();
  }, [aptosWallets, aptosConnected, aptosWallet?.name, connectAptos]);
  useEffect(() => {
    // Use effectiveSolanaConnected to account for adapter state desync
    if (!effectiveSolanaConnected || aptosConnected || !aptosWallets?.length || !solanaWallet) return;
    if (skipAutoConnectDerivedRef.current) return;
    if (typeof window !== "undefined" && sessionStorage.getItem("skip_auto_connect_derived_aptos") === "1") return;
    const solanaWalletName = (solanaWallet as { adapter?: { name?: string }; name?: string }).adapter?.name ?? (solanaWallet as { name?: string }).name ?? '';
    const derivedNameForCurrentSolana = `${solanaWalletName} (Solana)`;
    // Autoconnect derived ONLY when storage still indicates derived should be used.
    // If user disconnected derived, we remove AptosWalletName — don't reconnect it automatically.
    const storedAptos = getAptosWalletNameFromStorage();
    if (!storedAptos) return;
    if (!String(storedAptos).trim().endsWith(" (Solana)")) return; // don't override native
    if (String(storedAptos).trim() !== derivedNameForCurrentSolana) return; // only for current Solana wallet
    const derived = aptosWallets.find((w) => w.name === derivedNameForCurrentSolana);
    if (derived && !hasTriedAutoConnectDerived.current) {
      hasTriedAutoConnectDerived.current = true;
      // Wrap in async IIFE to catch errors (user may reject popup)
      (async () => {
        try {
          await connectAptos(derived.name);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          // Silently ignore user rejection and already connected errors
          if (msg.includes("User") || msg.includes("rejected") || msg.includes("already connected")) {
            console.log('[derived-auto-connect] User rejected or already connected:', msg);
          } else {
            console.error('[derived-auto-connect] Connect error:', e);
          }
        }
      })();
    }
  }, [effectiveSolanaConnected, aptosConnected, aptosWallets, connectAptos, solanaWallet]);

  // On Vercel, after connecting native Aptos (e.g. Petra), adapter state can stay disconnected due to WalletDisconnectedError.
  // Resync: if localStorage says native Aptos is selected but adapter reports not connected, try connect once.
  const hasTriedAptosResyncRef = useRef(false);
  useEffect(() => {
    if (aptosConnected) {
      hasTriedAptosResyncRef.current = false;
      return;
    }
    if (!aptosWallet?.name || typeof window === "undefined") return;
    const stored = getAptosWalletNameFromStorage();
    if (!stored || stored !== aptosWallet.name) return;
    if (String(stored).trim().endsWith(" (Solana)")) return; // only resync native
    if (hasTriedAptosResyncRef.current) return;
    hasTriedAptosResyncRef.current = true;
    // Wrap in async IIFE to catch errors (user may reject popup)
    (async () => {
      try {
        await connectAptos(aptosWallet.name);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Silently ignore user rejection and already connected errors
        if (msg.includes("User") || msg.includes("rejected") || msg.includes("already connected")) {
          console.log('[aptos-resync] User rejected or already connected:', msg);
        } else {
          console.error('[aptos-resync] Connect error:', e);
        }
      }
    })();
  }, [aptosConnected, aptosWallet, connectAptos]);

  // Suppress WalletDisconnectedError from wallet adapters (Aptos derived disconnect triggers Solana disconnect on Vercel).
  // Adapter often catches and console.error's it, so we patch console.error and also handle unhandledrejection.
  useEffect(() => {
    const isWalletDisconnectedError = (err: unknown) => {
      if (err == null) return false;
      if (typeof err === "string") return err.includes("WalletDisconnectedError");
      if (typeof err === "object") {
        const name = (err as { name?: string }).name;
        const msg = (err as { message?: string }).message;
        return name === "WalletDisconnectedError" || (typeof msg === "string" && msg.includes("WalletDisconnectedError"));
      }
      return false;
    };
    const orig = console.error;
    console.error = (...args: unknown[]) => {
      if (args.some(isWalletDisconnectedError)) return;
      orig.apply(console, args);
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      if (isWalletDisconnectedError(e?.reason)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      console.error = orig;
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  const aptosClient = useAptosClient();
  const aptosTransactionSubmitter = useMemo(() => GasStationService.getInstance().getTransactionSubmitter(), []);

  // Debug log for connection state
  useEffect(() => {
    console.log('[bridge-state] Connection state changed:', {
      solanaConnected,
      solanaAdapterConnected,
      effectiveSolanaConnected,
      solanaAddress,
      solanaWalletName: solanaWallet?.adapter?.name,
      walletCount: wallets?.length,
    });
  }, [solanaConnected, solanaAdapterConnected, effectiveSolanaConnected, solanaAddress, solanaWallet, wallets]);

  // Aptos stored name (client-only, avoid hydration mismatch)
  const [storedAptosName, setStoredAptosName] = useState<string | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    setStoredAptosName(getAptosWalletNameFromStorage());
  }, [aptosConnected, aptosWallet?.name]);
  
  // Sync storedAptosName when fallback is set (ensures consistency)
  useEffect(() => {
    if (aptosNativeFallback && aptosNativeFallback.name) {
      console.log('[storedAptosName] Syncing with fallback:', aptosNativeFallback.name);
      setStoredAptosName(aptosNativeFallback.name);
      // Also ensure localStorage is updated
      if (typeof window !== "undefined") {
        window.localStorage.setItem("AptosWalletName", aptosNativeFallback.name);
      }
    }
  }, [aptosNativeFallback]);

  // Show Aptos as connected when adapter says so OR when native is selected and connecting (so UI doesn't stay on button)
  // Also use fallback state when React state desyncs from actual adapter state (e.g., after Solana disconnect)
  const aptosNativeSelected = Boolean(storedAptosName && !String(storedAptosName).trim().endsWith(" (Solana)"));
  // Check if fallback represents a native wallet (not derived from Solana)
  const fallbackIsNative = Boolean(aptosNativeFallback && !aptosNativeFallback.name.endsWith(' (Solana)'));
  const showAptosAsConnected = Boolean(
    (aptosConnected && aptosAccount) ||
    (aptosWallet && storedAptosName === aptosWallet.name && aptosNativeSelected) ||
    fallbackIsNative  // Simplified: if fallback exists and is native, show it regardless of storedAptosName
  );
  // Don't show "Connecting..." when we have fallback - fallback means we have a cached address to display
  const aptosConnecting = Boolean(
    !aptosNativeFallback &&  // Don't show connecting when we have fallback address
    (aptosWallet && storedAptosName === aptosWallet.name && aptosNativeSelected && !aptosConnected)
  );
  
  // Debug log for showAptosAsConnected
  useEffect(() => {
    console.log('[showAptosAsConnected] Debug:', {
      showAptosAsConnected,
      aptosConnecting,
      condition1_adapterConnected: Boolean(aptosConnected && aptosAccount),
      condition2_walletMatch: Boolean(aptosWallet && storedAptosName === aptosWallet.name && aptosNativeSelected),
      condition3_fallbackIsNative: fallbackIsNative,
      aptosConnected,
      aptosAccount: aptosAccount?.address?.toString() || null,
      aptosWallet: aptosWallet?.name || null,
      storedAptosName,
      aptosNativeSelected,
      aptosNativeFallback: aptosNativeFallback ? { name: aptosNativeFallback.name, address: aptosNativeFallback.address.slice(0, 10) + '...' } : null,
    });
  }, [showAptosAsConnected, aptosConnecting, aptosConnected, aptosAccount, aptosWallet, storedAptosName, aptosNativeSelected, fallbackIsNative, aptosNativeFallback]);
  
  // Track previous aptosConnected state to detect reconnection (false -> true transition)
  const prevAptosConnectedRef = useRef(aptosConnected);
  
  // Clear fallback only when Aptos reconnects AFTER being disconnected (false -> true)
  // This prevents clearing the fallback when it's set while still connected
  useEffect(() => {
    const wasDisconnected = !prevAptosConnectedRef.current;
    const isNowConnected = aptosConnected && aptosAccount;
    
    // Only clear fallback on actual reconnection (was disconnected, now connected)
    if (wasDisconnected && isNowConnected && aptosNativeFallback) {
      console.log('[aptosNativeFallback] Clearing fallback, adapter reconnected after disconnect:', aptosAccount.address.toString());
      setAptosNativeFallback(null);
    }
    
    // Update previous state ref
    prevAptosConnectedRef.current = aptosConnected;
  }, [aptosConnected, aptosAccount, aptosNativeFallback]);

  const DOMAIN_APTOS = 9;

  // Check if both wallets are connected (use effective state that includes adapter state)
  const bothWalletsConnected = Boolean(effectiveSolanaConnected && aptosConnected && aptosAccount);

  // Determine missing wallet for alert
  const missingWallet = useMemo(() => {
    if (!effectiveSolanaConnected) return 'Solana';
    if (!aptosConnected || !aptosAccount) return 'Aptos';
    return null;
  }, [effectiveSolanaConnected, aptosConnected, aptosAccount]);

  // Check if bridge button should be disabled
  const bridgeButtonDisabled = useMemo(() => {
    if (!bothWalletsConnected) return true;
    if (!sourceChain || !destChain) return true;
    if (sourceChain.id === destChain.id) return true; // Same chain selected
    if (!sourceToken || !destToken) return true;
    if (!transferAmount || !transferAmount.trim()) return true;
    const amountNum = parseFloat(transferAmount);
    if (isNaN(amountNum) || amountNum <= 0) return true;
    return false;
  }, [bothWalletsConnected, sourceChain, destChain, sourceToken, destToken, transferAmount]);

  // Bridge button alert message
  const bridgeButtonAlert = useMemo(() => {
    if (!bothWalletsConnected) return null;
    if (sourceChain && destChain && sourceChain.id === destChain.id) {
      return 'Please select different blockchains for "From" and "To" to enable bridging.';
    }
    return null;
  }, [bothWalletsConnected, sourceChain, destChain]);

  // Copy address handlers
  const copySolanaAddress = async () => {
    if (!solanaAddress) return;
    try {
      await navigator.clipboard.writeText(solanaAddress);
      toast({
        title: "Success",
        description: "Copied Solana address to clipboard",
      });
    } catch {
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to copy Solana address",
      });
    }
  };

  const copyAptosAddress = async () => {
    const address = aptosAccount?.address?.toString() || aptosNativeFallback?.address;
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      toast({
        title: "Success",
        description: "Copied Aptos address to clipboard",
      });
    } catch {
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to copy Aptos address",
      });
    }
  };

  // Disconnect handlers
  // Ref to track current Aptos wallet name (avoids stale closures in timeouts)
  // Note: aptosConnectedRef already exists at component level for mint state tracking
  const aptosWalletNameRef = useRef(aptosWallet?.name);
  useEffect(() => {
    aptosWalletNameRef.current = aptosWallet?.name;
  }, [aptosWallet?.name]);

  const handleDisconnectSolana = async () => {
    // Get Aptos native wallet name from multiple sources
    // 1. From localStorage AptosWalletName
    // 2. From current aptosWallet.name (React state)
    let savedAptosNativeName: string | null = null;
    
    // Debug: log all sources
    const rawAptosStorage = typeof window !== "undefined" ? window.localStorage.getItem("AptosWalletName") : null;
    const currentAptosWalletName = aptosWallet?.name;
    
    console.log('[handleDisconnectSolana] Debug sources:', {
      rawAptosStorage,
      currentAptosWalletName,
      aptosConnected,
    });
    
    // Try to get native Aptos wallet name
    // First from localStorage
    if (typeof window !== "undefined" && rawAptosStorage) {
      try {
        let parsed = rawAptosStorage;
        try {
          parsed = JSON.parse(rawAptosStorage) as string;
        } catch {}
        if (parsed && !parsed.endsWith(' (Solana)')) {
          savedAptosNativeName = parsed;
        }
      } catch {}
    }
    
    // If not found in localStorage, try from React state (aptosWallet.name)
    if (!savedAptosNativeName && currentAptosWalletName && !currentAptosWalletName.endsWith(' (Solana)')) {
      savedAptosNativeName = currentAptosWalletName;
    }
    
    console.log('[handleDisconnectSolana] Starting disconnect, savedAptosNativeName:', savedAptosNativeName);
    
    // Save Aptos native wallet info to fallback state BEFORE disconnecting
    // This ensures UI can show the wallet while React state potentially desyncs
    if (savedAptosNativeName && aptosConnected && aptosAccount) {
      const fallbackInfo = {
        address: aptosAccount.address.toString(),
        name: savedAptosNativeName,
      };
      console.log('[handleDisconnectSolana] Setting aptosNativeFallback:', fallbackInfo);
      setAptosNativeFallback(fallbackInfo);
    }
    
    try {
      if (typeof window !== "undefined") {
        try {
          // Set skip flag to prevent SolanaWalletRestore from reconnecting
          window.sessionStorage.setItem("skip_auto_connect_solana", "1");
        } catch {}
      }
      await disconnectSolana();
      // Remove walletName AFTER disconnect to prevent immediate reconnect by autoConnect
      if (typeof window !== "undefined") {
        try {
          window.localStorage.removeItem("walletName");
        } catch {}
      }
      toast({
        title: "Success",
        description: "Solana wallet disconnected",
      });
      
      // If we had a native Aptos wallet, ensure it stays connected
      // Aptos native should be independent of Solana - only tied to AptosWalletName
      if (savedAptosNativeName) {
        console.log('[handleDisconnectSolana] Will restore Aptos native after delay:', savedAptosNativeName);
        
        const walletName = savedAptosNativeName;
        
        // Direct reconnect function without using state
        const attemptReconnect = (attempt: number) => {
          try {
            const currentlyConnected = aptosConnectedRef.current;
            const currentWalletName = aptosWalletNameRef.current;
            
            console.log(`[handleDisconnectSolana] Reconnect attempt ${attempt}:`, {
              walletName,
              currentlyConnected,
              currentWalletName,
            });
            
            // If ref shows already connected to the right wallet, skip reconnect attempts
            // The fallback UI will display the cached address - no need to call connectAptos
            // which would just throw "already connected" error
            if (currentlyConnected && currentWalletName === walletName) {
              console.log(`[handleDisconnectSolana] Ref shows already connected to ${walletName}, skipping reconnect (using fallback UI)`);
              return;
            }
            
            // Check if wallet exists in available wallets
            // Note: aptosWallets is captured from closure - this is intentional
            const walletToConnect = aptosWallets?.find(w => w.name === walletName);
            if (!walletToConnect) {
              console.log(`[handleDisconnectSolana] Wallet not found for attempt ${attempt}:`, walletName);
              return;
            }
            
            // Skip derived wallets
            if (walletName.endsWith(' (Solana)')) {
              console.log(`[handleDisconnectSolana] Skipping derived wallet for attempt ${attempt}:`, walletName);
              return;
            }
            
            console.log(`[handleDisconnectSolana] Calling connectAptos (attempt ${attempt}) for:`, walletName);
            // Wrap in async IIFE to catch errors
            (async () => {
              try {
                await connectAptos(walletName);
                console.log(`[handleDisconnectSolana] connectAptos returned (attempt ${attempt})`);
              } catch (connectError) {
                const msg = connectError instanceof Error ? connectError.message : String(connectError);
                // Silently ignore "already connected" errors
                if (msg.includes("already connected")) {
                  console.log(`[handleDisconnectSolana] connectAptos (attempt ${attempt}) - already connected, using fallback`);
                } else {
                  console.log(`[handleDisconnectSolana] connectAptos error (attempt ${attempt}):`, connectError);
                }
              }
            })();
          } catch (e) {
            console.error(`[handleDisconnectSolana] Error in attempt ${attempt}:`, e);
          }
        };
        
        // Schedule reconnect attempts at various intervals
        // Starting after 1500ms to let cascade disconnect settle
        console.log('[handleDisconnectSolana] Scheduling reconnect attempts...');
        
        // First ensure AptosWalletName is preserved
        window.setTimeout(() => {
          if (typeof window === "undefined") return;
          console.log('[handleDisconnectSolana] Ensuring AptosWalletName is set:', walletName);
          window.localStorage.setItem("AptosWalletName", walletName);
        }, 500);
        
        // Reconnect attempts at increasing intervals
        window.setTimeout(() => {
          console.log('[handleDisconnectSolana] Timeout 1 (1500ms) fired');
          attemptReconnect(1);
        }, 1500);
        
        window.setTimeout(() => {
          console.log('[handleDisconnectSolana] Timeout 2 (2000ms) fired');
          attemptReconnect(2);
        }, 2000);
        
        window.setTimeout(() => {
          console.log('[handleDisconnectSolana] Timeout 3 (3000ms) fired');
          attemptReconnect(3);
        }, 3000);
        
        window.setTimeout(() => {
          console.log('[handleDisconnectSolana] Timeout 4 (5000ms) fired');
          attemptReconnect(4);
        }, 5000);
      }
      
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to disconnect Solana wallet",
      });
    }
  };

  const handleDisconnectAptos = async () => {
    skipAutoConnectDerivedRef.current = true;
    if (typeof window !== "undefined") sessionStorage.setItem("skip_auto_connect_derived_aptos", "1");
    // Ensure adapter won't auto-restore derived immediately after disconnect
    if (typeof window !== "undefined") {
      try {
        window.localStorage.removeItem("AptosWalletName");
        // Clear Solana skip flag to allow restore of standalone Solana wallets (like Phantom)
        // after disconnecting Aptos derived (which might cascade disconnect)
        window.sessionStorage.removeItem("skip_auto_connect_solana");
      } catch {}
    }
    setStoredAptosName(null);
    // Clear Aptos native fallback since user explicitly disconnected
    setAptosNativeFallback(null);

    // When disconnecting Aptos derived, Trust (and on Vercel) can disconnect Solana and clear walletName.
    // Save Solana name so we can restore connection and localStorage after.
    const isDerived = aptosWallet && isDerivedAptosWalletReliable(aptosWallet);
    let savedSolanaName: string | null = null;
    if (isDerived && typeof window !== "undefined") {
      const fromAdapter =
        (solanaWallet as { adapter?: { name?: string } })?.adapter?.name ??
        (solanaWallet as { name?: string })?.name;
      const fromStorage = window.localStorage.getItem("walletName");
      const fromAptos = (() => {
        const a = window.localStorage.getItem("AptosWalletName");
        if (a?.endsWith(" (Solana)")) return a.slice(0, -" (Solana)".length).trim();
        return null;
      })();
      let raw = fromAdapter ?? fromStorage ?? fromAptos;
      if (typeof raw === "string" && raw.startsWith('"') && raw.endsWith('"')) {
        try {
          raw = JSON.parse(raw) as string;
        } catch {}
      }
      savedSolanaName = (typeof raw === "string" ? raw.trim() : null) || null;
    }

    let disconnectSucceeded = false;
    try {
      await disconnectAptos();
      disconnectSucceeded = true;
      toast({
        title: "Success",
        description: "Aptos wallet disconnected",
      });
    } catch (error: unknown) {
      const name = (error as { name?: string })?.name;
      const msg = error instanceof Error ? error.message : "";
      const isBenignDisconnect =
        name === "WalletDisconnectedError" ||
        name === "WalletNotConnectedError" ||
        (typeof msg === "string" &&
          (msg.includes("WalletDisconnectedError") || msg.includes("WalletNotConnectedError")));
      const isUserRejected =
        msg === "User has rejected the request" ||
        msg.includes("User rejected") ||
        msg.includes("rejected the request");
      
      if (isBenignDisconnect) {
        // Кошелёк уже считался отключённым — воспринимаем как успешный disconnect.
        disconnectSucceeded = true;
        toast({
          title: "Success",
          description: "Aptos wallet disconnected",
        });
      } else if (isUserRejected) {
        // User explicitly rejected the disconnect - don't continue
        console.log('[handleDisconnectAptos] User rejected disconnect, stopping');
        return; // Stop execution, don't try to restore Solana
      } else {
        toast({
          variant: "destructive",
          title: "Error",
          description: msg || "Failed to disconnect Aptos wallet",
        });
        return; // Stop execution on error
      }
    }

    // Only continue with Solana restore if disconnect actually succeeded
    if (!disconnectSucceeded) {
      return;
    }

    // Restore Solana walletName in localStorage if it was cleared by the Aptos derived disconnect cascade
    // This happens with Phantom especially - disconnecting Aptos derived also disconnects Solana and clears walletName
    // IMPORTANT: The cascade disconnect happens ASYNCHRONOUSLY, so we need to wait before checking
    if (isDerived && savedSolanaName && typeof window !== "undefined") {
      // Wait for cascade disconnect to potentially happen
      setTimeout(() => {
        try {
          const currentWalletName = window.localStorage.getItem("walletName");
          const adapterConnected = solanaWallet?.adapter?.connected ?? false;
          
          console.log('[handleDisconnectAptos] Delayed check (500ms):', {
            savedSolanaName,
            currentWalletName,
            adapterConnected,
          });
          
          // Restore and reconnect if walletName was cleared OR if adapter disconnected
          if (!currentWalletName || !adapterConnected) {
            console.log('[handleDisconnectAptos] Need to restore, setting walletName:', savedSolanaName);
            window.localStorage.setItem("walletName", JSON.stringify(savedSolanaName));
            
            // Trigger reconnect via state (useEffect will handle with fresh references)
            console.log('[handleDisconnectAptos] Setting pendingReconnectWallet:', savedSolanaName);
            setPendingReconnectWallet(savedSolanaName);
          } else {
            console.log('[handleDisconnectAptos] No restore needed, wallet still connected');
          }
        } catch (e) {
          console.log('[handleDisconnectAptos] Error:', e);
        }
      }, 500); // Wait 500ms for cascade disconnect to happen
    }

  };

  // Helper to truncate address
  const truncateAddress = (address: string) => {
    if (!address) return '';
    return `${address.slice(0, 8)}...${address.slice(-8)}`;
  };

  // Solana wallet selection logic
  const availableSolanaWallets = useMemo(() => {
    const filtered = wallets.filter(
      (wallet) => wallet.readyState !== WalletReadyState.NotDetected
    );
    const seen = new Set<string>();
    return filtered.filter((wallet) => {
      const name = wallet.adapter.name;
      if (seen.has(name)) {
        return false;
      }
      seen.add(name);
      return true;
    });
  }, [wallets]);

  const handleSolanaWalletSelect = async (walletName: string) => {
    console.log('[bridge] handleSolanaWalletSelect called with:', walletName);
    console.log('[bridge] Available wallets:', wallets.map(w => w.adapter.name));
    console.log('[bridge] Current wallet:', solanaWallet?.adapter?.name);
    console.log('[bridge] Connected:', solanaConnected);
    
    try {
      setIsSolanaConnecting(true);
      
      // Clear skip flag since user is explicitly connecting
      if (typeof window !== "undefined") {
        try {
          window.sessionStorage.removeItem("skip_auto_connect_solana");
          // Pre-set walletName in localStorage to help adapter find it
          window.localStorage.setItem("walletName", JSON.stringify(walletName));
        } catch {}
      }
      
      // Find the wallet adapter
      const targetWallet = wallets.find(w => w.adapter.name === walletName);
      console.log('[bridge] Target wallet found:', targetWallet?.adapter?.name, 'readyState:', targetWallet?.readyState);
      
      if (!targetWallet) {
        throw new Error(`Wallet ${walletName} not found in available wallets`);
      }
      
      select(walletName as WalletName);
      setIsSolanaDialogOpen(false);
      
      // Poll for wallet selection, then connect
      const maxAttempts = 10;
      let attempt = 0;
      
      const tryConnect = async () => {
        attempt++;
        console.log('[bridge] Connection attempt', attempt, 'current wallet:', solanaWallet?.adapter?.name);
        
        try {
          await connectSolana();
          console.log('[bridge] connectSolana() succeeded');
          toast({
            title: "Wallet Connected",
            description: `Connected to ${walletName}`,
          });
          setIsSolanaConnecting(false);
        } catch (error: any) {
          console.log('[bridge] connectSolana() failed:', error?.name, error?.message);
          
          if (attempt < maxAttempts) {
            // Retry with increasing delay
            setTimeout(tryConnect, 200 * attempt);
          } else {
            toast({
              variant: "destructive",
              title: "Connection Failed",
              description: error.message || "Failed to connect wallet",
            });
            setIsSolanaConnecting(false);
          }
        }
      };
      
      // Start connection attempts after a short delay
      setTimeout(tryConnect, 150);
      
    } catch (error: any) {
      console.log('[bridge] handleSolanaWalletSelect error:', error);
      setIsSolanaConnecting(false);
      toast({
        variant: "destructive",
        title: "Selection Failed",
        description: error.message || "Failed to select wallet",
      });
    }
  };


  // Ensure source and destination chains/tokens are always set
  useEffect(() => {
    if (!sourceChain) {
      setSourceChain(CHAINS[0]); // Solana
    }
    if (!sourceToken) {
      const solanaToken = TOKENS.find((t) => t.chain === 'Solana');
      if (solanaToken) {
        setSourceToken(solanaToken);
      }
    }
    if (!destChain) {
      setDestChain(CHAINS[1]); // Aptos
    }
    if (!destToken) {
      const aptosToken = TOKENS.find((t) => t.chain === 'Aptos');
      if (aptosToken) {
        setDestToken(aptosToken);
      }
    }
  }, []); // Run once on mount

  // Read destination address from query parameter
  useEffect(() => {
    const destination = searchParams.get('destination');
    if (destination) {
      // Decode and set destination address
      const decodedAddress = decodeURIComponent(destination);
      setDestinationAddress(decodedAddress);
    }
  }, [searchParams]);

  // Load Aptos portfolio when wallet is connected
  useEffect(() => {
    const loadAptosPortfolio = async () => {
      if (!aptosAccount?.address) {
        setAptosTokens([]);
        setAptosTotalValue(0);
        return;
      }

      try {
        setIsAptosLoading(true);
        const portfolioService = new AptosPortfolioService();
        const portfolio = await portfolioService.getPortfolio(aptosAccount.address.toString());
        setAptosTokens(portfolio.tokens);
        
        // Calculate total value from tokens
        const total = portfolio.tokens.reduce((sum, token) => {
          return sum + (token.value ? parseFloat(token.value) : 0);
        }, 0);
        setAptosTotalValue(total);
      } catch (error) {
        console.error('Error loading Aptos portfolio:', error);
        setAptosTokens([]);
        setAptosTotalValue(0);
      } finally {
        setIsAptosLoading(false);
      }
    };

    loadAptosPortfolio();
  }, [aptosAccount?.address]);

  // Helper function to add action to log
  const addAction = (message: string, status: 'pending' | 'success' | 'error', link?: string, linkText?: string, startTime?: number) => {
    const now = Date.now();
    const newAction: ActionLogItem = {
      id: now.toString() + Math.random().toString(36).substr(2, 9),
      message,
      status,
      timestamp: new Date(),
      link,
      linkText,
      startTime: startTime || now,
      duration: startTime ? now - startTime : undefined,
    };
    setActionLog(prev => [...prev, newAction]);
    console.log(`[Bridge Action] ${status.toUpperCase()}: ${message}`, link ? `Link: ${link}` : '');
    return newAction.id;
  };

  // Helper function to update last action
  const updateLastAction = (message: string, status: 'pending' | 'success' | 'error', link?: string, linkText?: string) => {
    const now = Date.now();
    setActionLog(prev => {
      const newLog = [...prev];
      if (newLog.length > 0) {
        const lastAction = newLog[newLog.length - 1];
        const startTime = lastAction.startTime || lastAction.timestamp.getTime();
        newLog[newLog.length - 1] = {
          ...lastAction,
          message,
          status,
          link,
          linkText,
          duration: now - startTime,
        };
      }
      return newLog;
    });
  };

  // Handle transfer - route to appropriate bridge component
  const handleTransfer = async () => {
    if (!sourceChain || !destChain || !sourceToken || !destToken) {
      toast({
        variant: "destructive",
        title: "Error",
        description: "Please select source and destination chains/tokens",
      });
      return;
    }

    setIsTransferring(true);
    setTransferStatus('Initializing transfer...');
    setActionLog([]);
    setLastSolanaToAptosParams(null);
    setLastAptosToSolanaParams(null);
    const transferStartTime = Date.now();
    addAction('Initializing transfer...', 'pending', undefined, undefined, transferStartTime);

    try {
      // Determine bridge direction
      const isSolanaToAptos = sourceChain.id === 'Solana' && destChain.id === 'Aptos';
      const isAptosToSolana = sourceChain.id === 'Aptos' && destChain.id === 'Solana';

      if (isSolanaToAptos) {
        // Solana -> Aptos: Use SolanaToAptosBridge
        if (!solanaPublicKey || !signSolanaTransaction || !solanaConnection || !aptosAccount) {
          throw new Error('Please connect both Solana and Aptos wallets');
        }

        setTransferStatus('Starting Solana -> Aptos bridge...');
        updateLastAction('Starting Solana -> Aptos bridge...', 'pending');
        console.log('[Bridge] Solana -> Aptos transfer initiated');

        // Execute burn on Solana
        const burnTxSignature = await executeSolanaToAptosBridge(
          transferAmount,
          solanaPublicKey,
          signSolanaTransaction,
          solanaConnection,
          aptosAccount.address.toString(),
          (status) => {
            setTransferStatus(status);
            updateLastAction(status, 'pending');
          }
        );

        console.log('[Bridge] Burn transaction completed:', burnTxSignature);
        // Last action is "Burn completed! Transaction: ..." (pending) from callback — mark it success
        updateLastAction(
          `Burn completed! Transaction: ${burnTxSignature.slice(0, 8)}...${burnTxSignature.slice(-8)}`,
          'success',
          `https://solscan.io/tx/${burnTxSignature}`,
          'View transaction on Solscan'
        );
        addAction(
          'Burn transaction sent on Solana',
          'success',
          `https://solscan.io/tx/${burnTxSignature}`,
          'View transaction on Solscan'
        );
        setLastSolanaToAptosParams({ signature: burnTxSignature, finalRecipient: aptosAccount.address.toString() });
        setLastAptosToSolanaParams(null);

        // Wait for Solana confirmation
        setTransferStatus('Waiting for Solana transaction confirmation...');
        addAction('Waiting for Solana transaction confirmation...', 'pending');
        
        const waitForSolanaConfirmation = async (): Promise<void> => {
          const { Connection } = await import('@solana/web3.js');
          const connection = solanaConnection || new Connection(
            process.env.NEXT_PUBLIC_SOLANA_RPC_URL || 
            process.env.SOLANA_RPC_URL || 
            'https://mainnet.helius-rpc.com/?api-key=29798653-2d13-4d8a-96ad-df70b015e234',
            'confirmed'
          );

          const maxConfirmationAttempts = 30;
          const confirmationDelay = 2000;

          for (let attempt = 1; attempt <= maxConfirmationAttempts; attempt++) {
            try {
              const txStatus = await connection.getSignatureStatus(burnTxSignature);
              
              if (txStatus?.value?.confirmationStatus === 'finalized' || 
                  txStatus?.value?.confirmationStatus === 'confirmed') {
                updateLastAction(
                  'Solana transaction confirmed',
                  'success',
                  `https://solscan.io/tx/${burnTxSignature}`,
                  'View transaction on Solscan'
                );
                return;
              }
              
              if (txStatus?.value?.err) {
                throw new Error(`Transaction failed: ${JSON.stringify(txStatus.value.err)}`);
              }
              
              if (attempt % 5 === 0) {
                updateLastAction(
                  `Waiting for confirmation... (${attempt}/${maxConfirmationAttempts})`,
                  'pending'
                );
              }
            } catch (error: any) {
              if (attempt === maxConfirmationAttempts) {
                throw new Error(`Failed to confirm transaction: ${error.message}`);
              }
            }
            
            await new Promise(resolve => setTimeout(resolve, confirmationDelay));
          }
          
          throw new Error('Transaction confirmation timeout');
        };

        // Poll for attestation with exponential backoff (same logic as bridge2)
        const pollForAttestation = async (): Promise<void> => {
          const maxAttempts = 15;
          const initialDelay = 10000;
          const maxDelay = 30000;

          await new Promise(resolve => setTimeout(resolve, initialDelay));

          for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const delay = Math.min(initialDelay * Math.pow(1.5, attempt - 1), maxDelay);
            const attemptStartTime = Date.now();
            
            if (attempt === 1) {
              addAction(
                `Requesting attestation from Circle... (attempt ${attempt}/${maxAttempts})`,
                'pending',
                `https://iris-api.circle.com/v1/messages/5/${burnTxSignature}`,
                'View attestation request',
                attemptStartTime
              );
            } else {
              updateLastAction(
                `Requesting attestation from Circle... (attempt ${attempt}/${maxAttempts})`,
                'pending',
                `https://iris-api.circle.com/v1/messages/5/${burnTxSignature}`,
                'View attestation request'
              );
            }
            
            try {
              const requestBody = {
                signature: burnTxSignature.trim(),
                sourceDomain: '5', // Solana CCTP V1 domain
                finalRecipient: aptosAccount.address.toString().trim(),
              };
              
              console.log(`[Bridge] Calling mint API, attempt ${attempt}/${maxAttempts}`);

              const response = await fetch('/api/aptos/mint-cctp', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify(requestBody),
              });

              const data = await response.json();

              // 200 + pending = attestation not ready, retry (no 404 in console)
              if (response.ok && data.data?.pending) {
                if (attempt < maxAttempts) {
                  updateLastAction(
                    `Requesting attestation from Circle... (attempt ${attempt}/${maxAttempts}) — ${data.data?.message || 'waiting'}`,
                    'pending',
                    `https://iris-api.circle.com/v1/messages/5/${burnTxSignature}`,
                    'View attestation request'
                  );
                  await new Promise(resolve => setTimeout(resolve, delay));
                  continue;
                }
              }

              if (response.ok) {
                // Success! Attestation received and minting completed
                updateLastAction(
                  'Attestation received and minting completed',
                  'success',
                  `https://iris-api.circle.com/v1/messages/5/${burnTxSignature}`,
                  'View attestation'
                );
                
                console.log('[Bridge] USDC minted successfully on Aptos', data);
                
                // Add recipient wallet action
                const recipientAddress = data.data?.transaction?.finalRecipient || aptosAccount.address.toString();
                if (recipientAddress) {
                  addAction(
                    'Recipient wallet',
                    'success',
                    `https://explorer.aptoslabs.com/account/${recipientAddress}?network=mainnet`,
                    'View recipient wallet on Aptos Explorer'
                  );
                }
                
                // Add minting action
                const mintTxHash = data.data?.transaction?.hash;
                if (mintTxHash) {
                  addAction(
                    'USDC minted successfully on Aptos',
                    'success',
                    `https://explorer.aptoslabs.com/txn/${mintTxHash}?network=mainnet`,
                    'View mint transaction on Aptos Explorer'
                  );
                }
                
                toast({
                  title: "USDC Minted on Aptos",
                  description: `USDC has been automatically minted on Aptos. Account: ${data.data?.accountAddress || 'N/A'}`,
                });
                setTransferStatus(`Transfer complete! USDC minted on Aptos. Transaction: ${burnTxSignature.slice(0, 8)}...${burnTxSignature.slice(-8)}`);
                return; // Success
              } else {
                const errorMessage = data.error?.message || '';
                const isAttestationError = 
                  errorMessage.includes('404') ||
                  errorMessage.includes('not found') ||
                  errorMessage.includes('EINVALID_ATTESTATION') ||
                  errorMessage.includes('EINVALID_ATTESTATION_LENGTH') ||
                  errorMessage.includes('attestation') ||
                  response.status === 404;

                if (isAttestationError && attempt < maxAttempts) {
                  updateLastAction(
                    `Requesting attestation from Circle... (attempt ${attempt}/${maxAttempts}) - ${errorMessage.substring(0, 50)}${errorMessage.length > 50 ? '...' : ''}`,
                    'pending',
                    `https://iris-api.circle.com/v1/messages/5/${burnTxSignature}`,
                    'View attestation request'
                  );
                  await new Promise(resolve => setTimeout(resolve, delay));
                  continue;
                } else if (attempt < maxAttempts) {
                  updateLastAction(
                    `Requesting attestation from Circle... (attempt ${attempt}/${maxAttempts}) - ${errorMessage.substring(0, 50)}${errorMessage.length > 50 ? '...' : ''}`,
                    'pending',
                    `https://iris-api.circle.com/v1/messages/5/${burnTxSignature}`,
                    'View attestation request'
                  );
                  await new Promise(resolve => setTimeout(resolve, delay));
                  continue;
                } else {
                  updateLastAction(
                    `Requesting attestation from Circle failed. Max attempts reached: ${errorMessage.substring(0, 80)}${errorMessage.length > 80 ? '...' : ''}`,
                    'error',
                    `https://iris-api.circle.com/v1/messages/5/${burnTxSignature}`,
                    'View attestation request'
                  );
                  throw new Error(data.error?.message || 'Failed to get attestation after all attempts');
                }
              }
            } catch (error: any) {
              const errorMessage = error.message || '';
              const isNetworkError = errorMessage.includes('fetch') || 
                                    errorMessage.includes('network') ||
                                    errorMessage.includes('ECONNREFUSED');
              const isAttestationError = errorMessage.includes('EINVALID_ATTESTATION') ||
                                        errorMessage.includes('attestation');
              
              if (attempt < maxAttempts) {
                const errorType = isNetworkError ? 'Network error' : 
                                 isAttestationError ? 'Attestation error' : 
                                 'Error';
                updateLastAction(
                  `Requesting attestation from Circle... (attempt ${attempt}/${maxAttempts}) - ${errorType}: ${errorMessage.substring(0, 50)}${errorMessage.length > 50 ? '...' : ''}`,
                  'pending',
                  `https://iris-api.circle.com/v1/messages/5/${burnTxSignature}`,
                  'View attestation request'
                );
                await new Promise(resolve => setTimeout(resolve, delay));
                continue;
              }
              
              updateLastAction(
                `Requesting attestation from Circle failed. Max attempts reached: ${errorMessage.substring(0, 80)}${errorMessage.length > 80 ? '...' : ''}`,
                'error',
                `https://iris-api.circle.com/v1/messages/5/${burnTxSignature}`,
                'View attestation request'
              );
              throw error;
            }
          }
          
          throw new Error('Attestation polling timeout - attestation not ready after all attempts');
        };

        // Execute: wait for confirmation, then poll for attestation
        // Note: Don't set isTransferring to false in finally - wait for async operations to complete
        waitForSolanaConfirmation()
          .then(() => {
            setTransferStatus('Solana transaction confirmed. Waiting for Circle attestation...');
            return pollForAttestation();
          })
          .then(() => {
            // Success - minting completed
            setIsTransferring(false);
          })
          .catch((error) => {
            console.error('[Bridge] Error in confirmation or attestation polling:', error);
            const mintingAptosUrl = `/minting-aptos?signature=${encodeURIComponent(burnTxSignature)}`;
            updateLastAction(
              `Error: ${error.message || 'Failed to complete minting'}`,
              'error',
              mintingAptosUrl,
              'Mint manually on /minting-aptos'
            );
            
            addAction(
              `Recipient wallet`,
              'pending',
              `https://explorer.aptoslabs.com/account/${aptosAccount.address.toString()}?network=mainnet`,
              'View recipient wallet on Aptos Explorer'
            );
            
            addAction(
              `Minting failed: ${error.message || 'Unknown error'}`,
              'error',
              mintingAptosUrl,
              'Mint manually on /minting-aptos'
            );
            toast({
              title: "Minting Failed",
              description: error.message || "Failed to automatically mint USDC on Aptos. You can mint manually later.",
              variant: "destructive",
            });
            setTransferStatus(`Transfer initiated! Transaction: ${burnTxSignature.slice(0, 8)}...${burnTxSignature.slice(-8)}. Minting failed, you can mint manually later.`);
            setIsTransferring(false);
          });

        // Don't set isTransferring to false here - wait for async operations above
        return; // Exit early, async operations will handle setIsTransferring(false)

      } else if (isAptosToSolana) {
        // Aptos -> Solana: derived (Gas Station + Solana sign) или native (bytecode + Aptos sign, газ — кошелёк пользователя)
        if (!aptosAccount || !aptosWallet || !solanaPublicKey || !signSolanaTransaction || !solanaConnection) {
          throw new Error('Please connect both Solana and Aptos wallets');
        }
        const destSolana = destinationAddress || solanaAddress;
        if (!destSolana) {
          throw new Error('Solana destination address is required');
        }

        setTransferStatus('Starting Aptos -> Solana bridge...');
        updateLastAction('Starting Aptos -> Solana bridge...', 'pending');

        let burnTxHash: string;
        if (isDerivedWallet) {
          if (!solanaWallet || !signSolanaMessage) {
            throw new Error('Please connect Solana wallet (required for derived Aptos).');
          }
          console.log('[Bridge] Aptos -> Solana (derived wallet)');
          burnTxHash = await executeAptosToSolanaBridge({
            amount: transferAmount,
            aptosAccount,
            aptosWallet: aptosWallet as any,
            aptosClient,
            solanaPublicKey,
            solanaWallet,
            signMessage: signSolanaMessage ?? undefined,
            transactionSubmitter: aptosTransactionSubmitter as any,
            destinationSolanaAddress: destSolana,
            onStatusUpdate: (s) => {
              setTransferStatus(s);
              updateLastAction(s, 'pending');
            },
          });
        } else {
          if (isDerivedAptosWalletReliable(aptosWallet)) {
            throw new Error('Use a native Aptos wallet (e.g. Petra) or connect via Solana for derived wallet.');
          }
          console.log('[Bridge] Aptos -> Solana (native wallet, bytecode, user pays gas)');
          burnTxHash = await executeAptosNativeToSolanaBridge({
            amount: transferAmount,
            aptosAccount,
            aptosWallet: aptosWallet as any,
            aptosClient,
            destinationSolanaAddress: destSolana,
            onStatusUpdate: (s) => {
              setTransferStatus(s);
              updateLastAction(s, 'pending');
            },
          });
        }

        updateLastAction(
          `Burn completed! Transaction: ${burnTxHash.slice(0, 8)}...${burnTxHash.slice(-8)}`,
          'success',
          `https://explorer.aptoslabs.com/txn/${burnTxHash}?network=mainnet`,
          'View transaction on Aptos Explorer'
        );
        addAction(
          'Burn transaction sent on Aptos',
          'success',
          `https://explorer.aptoslabs.com/txn/${burnTxHash}?network=mainnet`,
          'View transaction on Aptos Explorer'
        );
        setLastAptosToSolanaParams({ signature: burnTxHash, finalRecipient: destSolana });
        setLastSolanaToAptosParams(null);

        setTransferStatus('Waiting for Aptos transaction confirmation...');
        addAction('Waiting for Aptos transaction confirmation...', 'pending', `https://explorer.aptoslabs.com/txn/${burnTxHash}?network=mainnet`, 'View on Aptos Explorer');

        const waitForAptosConfirmation = async (): Promise<void> => {
          const maxAttempts = 30;
          const delay = 2000;
          for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const res = await fetch(`https://fullnode.mainnet.aptoslabs.com/v1/transactions/by_hash/${burnTxHash}`);
            if (res.ok) {
              const txData = await res.json();
              if (txData.success && txData.vm_status === 'Executed successfully') {
                updateLastAction('Aptos transaction confirmed', 'success', `https://explorer.aptoslabs.com/txn/${burnTxHash}?network=mainnet`, 'View on Aptos Explorer');
                return;
              }
              if (txData.vm_status) throw new Error(`Transaction failed: ${txData.vm_status}`);
            }
            if (attempt % 5 === 0) {
              updateLastAction(`Waiting for Aptos confirmation... (${attempt}/${maxAttempts})`, 'pending', `https://explorer.aptoslabs.com/txn/${burnTxHash}?network=mainnet`, 'View on Aptos Explorer');
            }
            await new Promise((r) => setTimeout(r, delay));
          }
          throw new Error('Aptos transaction confirmation timeout');
        };
        await waitForAptosConfirmation();

        // Circle API: GET /v1/messages/{sourceDomainId}/{transactionHash} — без дублирования "messages"
        let irisBase = typeof process !== 'undefined' && process.env?.NEXT_PUBLIC_CIRCLE_CCTP_ATTESTATION_URL
          ? process.env.NEXT_PUBLIC_CIRCLE_CCTP_ATTESTATION_URL
          : 'https://iris-api.circle.com/v1';
        irisBase = irisBase.replace(/\/messages\/?$/, '') || irisBase;
        const maxAttestationAttempts = 15;
        const initialAttestationDelay = 10000;
        const maxAttestationDelay = 60000;
        let attestationData: { messages: Array<{ message?: string; attestation?: string; eventNonce?: string }> } | null = null;
        const attestationUrl = `${irisBase}/messages/${DOMAIN_APTOS}/${burnTxHash.trim()}`;

        setTransferStatus('Waiting for attestation from Circle...');
        addAction('Requesting attestation from Circle...', 'pending', attestationUrl, 'View attestation request');

        for (let att = 1; att <= maxAttestationAttempts; att++) {
          updateLastAction(
            `Requesting attestation from Circle... (attempt ${att}/${maxAttestationAttempts})`,
            'pending',
            attestationUrl,
            'View attestation request'
          );
          setTransferStatus(`Waiting for attestation... (attempt ${att}/${maxAttestationAttempts})`);
          const attDelay = Math.min(initialAttestationDelay * Math.pow(2, att - 1), maxAttestationDelay);
          if (att > 1) await new Promise((r) => setTimeout(r, attDelay));
          const ar = await fetch(attestationUrl, { method: 'GET', headers: { 'Content-Type': 'application/json' } });
          if (!ar.ok) {
            if (ar.status === 404) continue;
            throw new Error(`Circle API error: ${ar.status} ${ar.statusText}`);
          }
          const data = await ar.json();
          if (!data?.messages?.length || !data.messages[0].message || !data.messages[0].attestation) continue;
          const attVal = (data.messages[0].attestation || '').toUpperCase().trim();
          if (attVal === 'PENDING' || attVal === 'PENDING...') continue;
          attestationData = data;
          break;
        }
        if (!attestationData) throw new Error('Attestation not ready after max attempts. Please try again later.');

        updateLastAction('Attestation received from Circle', 'success', attestationUrl, 'View attestation');
        setTransferStatus('Attestation received! Preparing mint on Solana (sign in wallet)...');
        addAction('Preparing mint transaction on Solana...', 'pending');

        // Re-check both wallets — context can be lost during long attestation wait
        if (!aptosConnectedRef.current || !aptosAccountRef.current) {
          throw new Error(
            'Aptos wallet no longer detected. Please reconnect your Aptos wallet and retry the mint (use the attestation link above on the manual minting page), or try again with both wallets connected from the start.'
          );
        }
        if (!solanaConnectedRef.current || !solanaPublicKeyRef.current || !signSolanaTransactionRef.current) {
          throw new Error(
            'Solana wallet no longer detected. Please reconnect your Solana wallet (the one that will receive USDC and sign the mint tx) and retry, or use the manual minting page with the attestation link above.'
          );
        }

        // Re-establish Solana connection before mint (adapter can report "not connected" after long attestation wait)
        if (solanaWalletRef.current) {
          try {
            await connectSolana();
            await new Promise((r) => setTimeout(r, 400));
          } catch (_) {
            // ignore reconnect errors, proceed with current refs
          }
        }

        let mintTxSignature: string;
        try {
          mintTxSignature = await performMintOnSolana(
            attestationData as any,
            destSolana,
            solanaConnection,
            solanaPublicKeyRef.current!,
            signSolanaTransactionRef.current!,
            (s) => { setTransferStatus(s); updateLastAction(s, 'pending'); }
          );
        } catch (mintErr: any) {
          const msg = mintErr?.message || 'Unknown error';
          const isNotConnected = typeof msg === 'string' && msg.toLowerCase().includes('not connected');
          const mintingSolanaUrl = `/minting-solana?signature=${encodeURIComponent(burnTxHash)}`;

          // On "not connected", try once: reconnect and retry mint (adapter state can be stale after long wait)
          if (isNotConnected && solanaWalletRef.current) {
            updateLastAction('Solana wallet reported not connected. Reconnecting and retrying mint...', 'pending');
            setTransferStatus('Reconnecting Solana wallet...');
            try {
              await connectSolana();
              await new Promise((r) => setTimeout(r, 600));
              if (signSolanaTransactionRef.current && solanaPublicKeyRef.current) {
                updateLastAction('Retrying mint on Solana...', 'pending');
                mintTxSignature = await performMintOnSolana(
                  attestationData as any,
                  destSolana,
                  solanaConnection,
                  solanaPublicKeyRef.current,
                  signSolanaTransactionRef.current,
                  (s) => { setTransferStatus(s); updateLastAction(s, 'pending'); }
                );
                updateLastAction('USDC minted successfully on Solana', 'success', `https://solscan.io/tx/${mintTxSignature}`, 'View transaction on Solscan');
                addAction('Bridge complete!', 'success');
                setTransferStatus(`Transfer complete! USDC minted on Solana. Transaction: ${mintTxSignature.slice(0, 8)}...${mintTxSignature.slice(-8)}`);
                toast({ title: 'USDC Minted on Solana', description: `USDC has been minted on Solana. Transaction: ${mintTxSignature.slice(0, 8)}...${mintTxSignature.slice(-8)}` });
                setIsTransferring(false);
                return;
              }
            } catch (_) {
              // fall through to error handling below
            }
          }

          updateLastAction(`Minting on Solana failed: ${msg}`, 'error', mintingSolanaUrl, 'Mint manually on Solana');
          addAction('Mint manually on Solana', 'error', mintingSolanaUrl, 'Open /minting-solana');
          setTransferStatus(`Minting failed: ${msg}`);
          toast({
            variant: 'destructive',
            title: 'Minting on Solana Failed',
            description: isNotConnected
              ? 'Solana wallet reported "not connected" when signing the mint transaction (Aptos burn was successful). Keep the Solana wallet connected and unlocked during the whole flow, then retry, or use the manual minting page with the attestation link from the log above.'
              : msg + (msg.includes('sign') ? ' You can retry or mint manually on the minting page.' : ''),
          });
          setIsTransferring(false);
          return;
        }

        updateLastAction('USDC minted successfully on Solana', 'success', `https://solscan.io/tx/${mintTxSignature}`, 'View transaction on Solscan');
        addAction('Bridge complete!', 'success');
        setTransferStatus(`Transfer complete! USDC minted on Solana. Transaction: ${mintTxSignature.slice(0, 8)}...${mintTxSignature.slice(-8)}`);
        toast({
          title: 'USDC Minted on Solana',
          description: `USDC has been minted on Solana. Transaction: ${mintTxSignature.slice(0, 8)}...${mintTxSignature.slice(-8)}`,
        });
        setIsTransferring(false);
        return;
      } else {
        throw new Error('Invalid bridge direction. Please select different chains for source and destination.');
      }
    } catch (error: any) {
      console.error('[Bridge] Transfer error:', error);
      setTransferStatus(`Error: ${error.message || 'Unknown error'}`);
      addAction(
        `Transfer failed: ${error.message || 'Unknown error'}`,
        'error'
      );
      toast({
        variant: "destructive",
        title: "Transfer Failed",
        description: error.message || "Failed to initiate transfer",
      });
      setIsTransferring(false);
    }
  };

  return (
    <div className="w-full h-screen overflow-y-auto bg-gradient-to-br from-gray-50 via-white to-gray-100">
      <div className="w-full min-h-full flex items-start justify-center p-4 md:items-center">
        <div className="w-full max-w-2xl space-y-4 py-4">
          <div className="flex items-center justify-between mb-4">
            <button
              onClick={() => router.push("/")}
              className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              <ArrowLeft className="h-4 w-4" />
              Back to Dashboard
            </button>
            <Link href="/privacy-bridge">
              <Button variant="outline" size="sm" className="bg-black text-white border-black hover:bg-gray-800 hover:text-white hover:border-gray-800">
                Privacy Bridge
              </Button>
            </Link>
          </div>

          <BridgeView
            sourceChain={sourceChain}
            sourceToken={sourceToken}
            destChain={destChain}
            destToken={destToken}
            amount={transferAmount}
            destinationAddress={destinationAddress}
            onSourceChainSelect={setSourceChain as any}
            onSourceTokenSelect={setSourceToken as any}
            onDestChainSelect={setDestChain as any}
            onDestTokenSelect={setDestToken as any}
            onAmountChange={setTransferAmount}
            onDestinationAddressChange={setDestinationAddress}
            onTransfer={handleTransfer}
            isTransferring={isTransferring}
            transferStatus={transferStatus}
            chains={CHAINS}
            tokens={TOKENS}
            showSwapButton={true}
            hideSourceWallet={true}
            hideDestinationAddress={true}
            bothWalletsConnected={bothWalletsConnected}
            missingWalletAlert={
              missingWallet ? (
                <div className="p-3 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded text-sm text-yellow-800 dark:text-yellow-200">
                  Please connect {missingWallet} wallet to enable bridging.
                </div>
              ) : null
            }
            bridgeButtonDisabled={bridgeButtonDisabled}
            bridgeButtonAlert={bridgeButtonAlert ? (
              <div>{bridgeButtonAlert}</div>
            ) : null}
            walletSection={
              effectiveSolanaConnected && solanaAddress ? (
                <div className="p-3 border rounded-lg bg-card w-auto space-y-2">
                  {/* Solana Wallet */}
                  <div>
                    <div className="flex items-center justify-between cursor-pointer hover:bg-accent/50 rounded p-1 -m-1 transition-colors" onClick={() => setIsSolanaBalanceExpanded(!isSolanaBalanceExpanded)}>
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-sm font-medium text-muted-foreground shrink-0">Solana</span>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                            <Button variant="ghost" className="h-auto p-0 font-mono text-sm truncate">
                              {truncateAddress(solanaAddress || "")}
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onSelect={copySolanaAddress} className="gap-2">
                              <Copy className="h-4 w-4" /> Copy address
                            </DropdownMenuItem>
                            <DropdownMenuItem onSelect={handleDisconnectSolana} className="gap-2">
                              <LogOut className="h-4 w-4" /> Disconnect
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                      <ChevronDown
                        className={cn(
                          "h-4 w-4 shrink-0 transition-transform text-muted-foreground",
                          isSolanaBalanceExpanded ? "transform rotate-0" : "transform -rotate-90"
                        )}
                      />
                    </div>
                    {isSolanaBalanceExpanded && (
                      <div className="mt-2 pt-2 border-t">
                        <div className="text-sm font-medium pb-2">
                          {isSolanaLoading ? '...' : solanaTotalValue !== null ? formatCurrency(solanaTotalValue, 2) : 'N/A'}
                        </div>
                        <ScrollArea className="max-h-48">
                          {solanaTokens.length > 0 ? (
                            <TokenList tokens={solanaTokens} disableDrag={true} />
                          ) : (
                            <div className="text-sm text-muted-foreground p-2">No tokens found</div>
                          )}
                        </ScrollArea>
                      </div>
                    )}
                  </div>

                  {/* Aptos Wallet: Derived or Native or Connect Button */}
                  {showAptosAsConnected ? (
                    <div>
                      <div className="flex items-center justify-between cursor-pointer hover:bg-accent/50 rounded p-1 -m-1 transition-colors" onClick={() => !aptosConnecting && setIsAptosBalanceExpanded(!isAptosBalanceExpanded)}>
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-sm font-medium text-muted-foreground shrink-0">
                            Aptos {aptosNativeSelected && !aptosConnected ? "(Native)" : isDerivedWallet ? "(Derived)" : "(Native)"}
                          </span>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                              <Button variant="ghost" className="h-auto p-0 font-mono text-sm truncate" disabled={aptosConnecting}>
                                {aptosConnecting ? "Connecting…" : (aptosAccount ? truncateAddress(aptosAccount.address.toString()) : (aptosNativeFallback ? truncateAddress(aptosNativeFallback.address) : "…"))}
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onSelect={copyAptosAddress} className="gap-2" disabled={!aptosAccount && !aptosNativeFallback}>
                                <Copy className="h-4 w-4" /> Copy address
                              </DropdownMenuItem>
                              <DropdownMenuItem onSelect={handleDisconnectAptos} className="gap-2" disabled={aptosConnecting}>
                                <LogOut className="h-4 w-4" /> Disconnect
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                        <ChevronDown
                          className={cn(
                            "h-4 w-4 shrink-0 transition-transform text-muted-foreground",
                            isAptosBalanceExpanded ? "transform rotate-0" : "transform -rotate-90"
                          )}
                        />
                      </div>
                      {isAptosBalanceExpanded && !aptosConnecting && (
                        <div className="mt-2 pt-2 border-t">
                          <div className="text-sm font-medium pb-2">
                            {isAptosLoading ? '...' : formatCurrency(aptosTotalValue, 2)}
                          </div>
                          <ScrollArea className="max-h-48">
                            {aptosTokens.length > 0 ? (
                              <TokenList tokens={aptosTokens} disableDrag={true} />
                            ) : (
                              <div className="text-sm text-muted-foreground p-2">No tokens found</div>
                            )}
                          </ScrollArea>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="relative">
                      <div className="[&>button]:hidden">
                        <WalletSelector />
                      </div>
                      <Button 
                        size="sm" 
                        className="w-full"
                        disabled={isAptosConnecting}
                        onClick={(e) => {
                          e.stopPropagation();
                          // Find and click the hidden WalletSelector button
                          const wrapper = e.currentTarget.parentElement;
                          const hiddenButton = wrapper?.querySelector('button') as HTMLElement;
                          if (hiddenButton) {
                            hiddenButton.click();
                          }
                        }}
                      >
                        {isAptosConnecting ? (
                          <>
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            Connecting...
                          </>
                        ) : (
                          'Connect Aptos Wallet'
                        )}
                      </Button>
                    </div>
                  )}
                </div>
              ) : !effectiveSolanaConnected ? (
                <div className="flex flex-col items-end gap-2">
                  <Dialog open={isSolanaDialogOpen} onOpenChange={setIsSolanaDialogOpen}>
                    <DialogTrigger asChild>
                      <Button size="sm" disabled={isSolanaConnecting}>
                        {isSolanaConnecting ? (
                          <>
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            Connecting...
                          </>
                        ) : (
                          'Connect Solana Wallet'
                        )}
                      </Button>
                    </DialogTrigger>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle>Select Solana Wallet</DialogTitle>
                        <DialogDescription>
                          Choose a wallet to connect to your Solana account
                        </DialogDescription>
                      </DialogHeader>
                      <div className="space-y-2 mt-4">
                        {availableSolanaWallets.length === 0 ? (
                          <div className="text-sm text-muted-foreground p-4 text-center">
                            No Solana wallets detected. Please install a wallet extension.
                          </div>
                        ) : (
                          availableSolanaWallets.map((w, index) => (
                            <Button
                              key={`${w.adapter.name}-${index}-${w.adapter.url || ''}`}
                              variant="outline"
                              className="w-full justify-start"
                              onClick={() => handleSolanaWalletSelect(w.adapter.name)}
                              disabled={isSolanaConnecting}
                            >
                              <div className="flex items-center gap-2">
                                {w.adapter.icon && (
                                  <img src={w.adapter.icon} alt={w.adapter.name} className="w-6 h-6" />
                                )}
                                <span>{w.adapter.name}</span>
                                {w.readyState === WalletReadyState.Loadable && (
                                  <span className="ml-auto text-xs text-muted-foreground">(Install)</span>
                                )}
                              </div>
                            </Button>
                          ))
                        )}
                      </div>
                    </DialogContent>
                  </Dialog>
                  <div className="relative">
                    <div className="[&>button]:hidden">
                      <WalletSelector />
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={isAptosConnecting}
                      onClick={(e) => {
                        e.stopPropagation();
                        const wrapper = e.currentTarget.parentElement;
                        const hiddenButton = wrapper?.querySelector('div button') as HTMLElement | null;
                        if (hiddenButton) hiddenButton.click();
                      }}
                    >
                      {isAptosConnecting ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          Connecting...
                        </>
                      ) : (
                        'Connect Aptos Wallet'
                      )}
                    </Button>
                  </div>
                </div>
              ) : null
            }
          />

          <ActionLog items={actionLog} />
          {(lastSolanaToAptosParams || lastAptosToSolanaParams) && (
            <div className="mt-2 flex flex-wrap gap-2 text-xs">
              {lastSolanaToAptosParams && (
                <Link
                  href={`/minting-aptos?signature=${encodeURIComponent(lastSolanaToAptosParams.signature)}&sourceDomain=5&finalRecipient=${encodeURIComponent(lastSolanaToAptosParams.finalRecipient)}`}
                  className="text-blue-600 hover:underline"
                >
                  Mint on Aptos →
                </Link>
              )}
              {lastAptosToSolanaParams && (
                <Link
                  href={`/minting-solana?signature=${encodeURIComponent(lastAptosToSolanaParams.signature)}&sourceDomain=9&finalRecipient=${encodeURIComponent(lastAptosToSolanaParams.finalRecipient)}`}
                  className="text-blue-600 hover:underline"
                >
                  Mint on Solana →
                </Link>
              )}
            </div>
          )}

        </div>
      </div>
    </div>
  );
}

export default function BridgePage() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <BridgePageContent />
    </Suspense>
  );
}
