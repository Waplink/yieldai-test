"use client";

import {
  APTOS_CONNECT_ACCOUNT_URL,
  AboutAptosConnect,
  AboutAptosConnectEducationScreen,
  AdapterNotDetectedWallet,
  AdapterWallet,
  AptosPrivacyPolicy,
  WalletItem,
  WalletSortingOptions,
  groupAndSortWallets,
  isAptosConnectWallet,
  isInstallRequired,
  truncateAddress,
  useWallet,
} from "@aptos-labs/wallet-adapter-react";
import { useWallet as useSolanaWallet } from "@solana/wallet-adapter-react";
import { WalletReadyState, WalletName } from "@solana/wallet-adapter-base";
import { DialogDescription } from "./ui/dialog";
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  Copy,
  LogOut,
  User,
  Loader2,
} from "lucide-react";
import { useCallback, useState, useEffect, useMemo } from "react";
import { Button } from "./ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { useToast } from "./ui/use-toast";
import { getSolanaWalletAddress } from "@/lib/wallet/getSolanaWalletAddress";

interface WalletSelectorProps extends WalletSortingOptions {
  /** External control for dialog open state */
  externalOpen?: boolean;
  /** Callback when dialog open state changes (for external control) */
  onExternalOpenChange?: (open: boolean) => void;
}

export function WalletSelector({ externalOpen, onExternalOpenChange, ...walletSortingOptions }: WalletSelectorProps) {
  const { account, connected: aptosConnected, disconnect, wallet } = useWallet();
  const { publicKey: solanaPublicKey, connected: solanaConnected, wallet: solanaWallet, disconnect: disconnectSolana, wallets: solanaWallets, select: selectSolana, connect: connectSolana } = useSolanaWallet();
  const [internalDialogOpen, setInternalDialogOpen] = useState(false);
  
  // Use external control if provided, otherwise use internal state
  const isDialogOpen = externalOpen !== undefined ? externalOpen : internalDialogOpen;
  const setIsDialogOpen = onExternalOpenChange !== undefined ? onExternalOpenChange : setInternalDialogOpen;
  const [mounted, setMounted] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isSolanaDialogOpen, setIsSolanaDialogOpen] = useState(false);
  const [isSolanaConnecting, setIsSolanaConnecting] = useState(false);
  const { toast } = useToast();

  // Cross-chain Solana address (from Aptos derived wallet)
  const crossChainSolanaAddress = useMemo(() => getSolanaWalletAddress(wallet), [wallet]);
  
  // Direct Solana address (from Solana adapter)
  const directSolanaAddress = useMemo(() => solanaPublicKey?.toBase58() ?? null, [solanaPublicKey]);
  
  // Also check adapter state directly for Phantom
  const adapterSolanaAddress = useMemo(() => solanaWallet?.adapter?.publicKey?.toBase58() ?? null, [solanaWallet]);
  
  // Effective Solana address - prefer cross-chain, then direct, then adapter
  const solanaAddress = crossChainSolanaAddress ?? directSolanaAddress ?? adapterSolanaAddress;
  
  // Check if any wallet is connected
  const isAnyWalletConnected = aptosConnected || solanaConnected || !!solanaAddress;

  useEffect(() => {
    setMounted(true);
  }, []);

  // Reset connecting state when wallet connects
  useEffect(() => {
    if (aptosConnected || solanaConnected) {
      // connecting state from wallet adapter will be reset automatically
    }
  }, [aptosConnected, solanaConnected]);

  const closeDialog = useCallback(() => setIsDialogOpen(false), []);
  const closeSolanaDialog = useCallback(() => setIsSolanaDialogOpen(false), []);

  // Available Solana wallets (excluding not detected)
  const availableSolanaWallets = useMemo(() => {
    const filtered = solanaWallets.filter(
      (w) => w.readyState !== WalletReadyState.NotDetected
    );
    // Remove duplicates by name
    const seen = new Set<string>();
    return filtered.filter((w) => {
      const name = w.adapter.name;
      if (seen.has(name)) return false;
      seen.add(name);
      return true;
    });
  }, [solanaWallets]);

  // Handle Solana wallet selection
  const handleSolanaWalletSelect = useCallback(async (walletName: string) => {
    try {
      setIsSolanaConnecting(true);
      selectSolana(walletName as WalletName);
      setIsSolanaDialogOpen(false);
      
      // Auto-connect after selection
      setTimeout(async () => {
        try {
          await connectSolana();
          toast({
            title: "Wallet Connected",
            description: `Connected to ${walletName}`,
          });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : "Failed to connect wallet";
          // Don't show error for user rejection
          if (!message.includes("reject") && !message.includes("Reject")) {
            toast({
              variant: "destructive",
              title: "Connection Failed",
              description: message,
            });
          }
        } finally {
          setIsSolanaConnecting(false);
        }
      }, 100);
    } catch (err: unknown) {
      setIsSolanaConnecting(false);
      toast({
        variant: "destructive",
        title: "Selection Failed",
        description: err instanceof Error ? err.message : "Failed to select wallet",
      });
    }
  }, [selectSolana, connectSolana, toast]);

  const copyAddress = useCallback(async () => {
    if (!account?.address) return;
    try {
      await navigator.clipboard.writeText(account.address.toString());
      toast({
        title: "Success",
        description: "Copied wallet address to clipboard",
      });
    } catch {
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to copy wallet address",
      });
    }
  }, [account?.address, toast]);

  const copySolanaAddress = useCallback(async () => {
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
  }, [solanaAddress, toast]);

  const handleDisconnect = useCallback(async () => {
    try {
      // Disconnect both Aptos and Solana if connected
      if (aptosConnected) {
        await disconnect();
      }
      if (solanaConnected) {
        await disconnectSolana();
      }
      toast({
        title: "Success",
        description: "Wallet disconnected successfully",
      });
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to disconnect wallet",
      });
    }
  }, [aptosConnected, solanaConnected, disconnect, disconnectSolana, toast]);

  // Handler for disconnecting only Solana
  const handleDisconnectSolanaOnly = useCallback(async () => {
    try {
      if (solanaConnected) {
        await disconnectSolana();
        toast({
          title: "Success",
          description: "Solana wallet disconnected",
        });
      }
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to disconnect Solana wallet",
      });
    }
  }, [solanaConnected, disconnectSolana, toast]);

  // Handler for disconnecting only Aptos
  const handleDisconnectAptosOnly = useCallback(async () => {
    try {
      if (aptosConnected) {
        await disconnect();
        toast({
          title: "Success",
          description: "Aptos wallet disconnected",
        });
      }
    } catch (error) {
      // Suppress benign disconnect errors
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("WalletNotConnected") || msg.includes("WalletDisconnected")) {
        toast({
          title: "Success",
          description: "Aptos wallet disconnected",
        });
        return;
      }
      toast({
        variant: "destructive",
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to disconnect Aptos wallet",
      });
    }
  }, [aptosConnected, disconnect, toast]);

  if (!mounted) {
    return null;
  }

  // Determine what address to show in the button
  const displayAddress = account?.ansName || 
    truncateAddress(account?.address?.toString()) || 
    (solanaAddress ? truncateAddress(solanaAddress) : null) ||
    "Unknown";

  return (
    <>
      {isAnyWalletConnected ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button>
              {displayAddress}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            {/* Solana Block */}
            <div className="px-3 py-2 border-b">
              <p className="text-xs font-medium uppercase text-muted-foreground mb-2">
                Solana
              </p>
              {solanaAddress ? (
                <>
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <span className="font-mono text-sm truncate">
                      {truncateAddress(solanaAddress)}
                    </span>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 shrink-0"
                      onClick={copySolanaAddress}
                      aria-label="Copy Solana address"
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full justify-start gap-2 text-muted-foreground hover:text-foreground"
                    onClick={handleDisconnectSolanaOnly}
                  >
                    <LogOut className="h-4 w-4" /> Disconnect
                  </Button>
                </>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start gap-2"
                  onClick={() => setIsSolanaDialogOpen(true)}
                >
                  Connect Solana
                </Button>
              )}
            </div>

            {/* Aptos Block */}
            <div className="px-3 py-2">
              <p className="text-xs font-medium uppercase text-muted-foreground mb-2">
                Aptos
              </p>
              {aptosConnected && account?.address ? (
                <>
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <span className="font-mono text-sm truncate">
                      {truncateAddress(account.address.toString())}
                    </span>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 shrink-0"
                      onClick={copyAddress}
                      aria-label="Copy Aptos address"
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full justify-start gap-2 text-muted-foreground hover:text-foreground"
                    onClick={handleDisconnectAptosOnly}
                  >
                    <LogOut className="h-4 w-4" /> Disconnect
                  </Button>
                </>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start gap-2"
                  onClick={() => setIsDialogOpen(true)}
                >
                  Connect Aptos
                </Button>
              )}
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <DialogTrigger asChild>
            <Button disabled={isConnecting}>
              {isConnecting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Connecting...
                </>
              ) : (
                'Connect Wallet'
              )}
            </Button>
          </DialogTrigger>
          <ConnectWalletDialog close={closeDialog} isConnecting={isConnecting} {...walletSortingOptions} />
        </Dialog>
      )}

      {/* Dialog for connecting Aptos wallets (external control) - always render for external open */}
      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <ConnectWalletDialog close={closeDialog} isConnecting={isConnecting} {...walletSortingOptions} />
      </Dialog>

      {/* Dialog for connecting Solana wallets */}
      <Dialog open={isSolanaDialogOpen} onOpenChange={setIsSolanaDialogOpen}>
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
              availableSolanaWallets.map((w, i) => (
                <Button
                  key={`${w.adapter.name}-${i}`}
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
    </>
  );
}

interface ConnectWalletDialogProps extends WalletSortingOptions {
  close: () => void;
  isConnecting?: boolean;
}

function ConnectWalletDialog({
  close,
  isConnecting = false,
  ...walletSortingOptions
}: ConnectWalletDialogProps) {
  const { wallets = [], notDetectedWallets = [] } = useWallet();

  const { aptosConnectWallets, availableWallets, installableWallets } =
    groupAndSortWallets(
      [...wallets, ...notDetectedWallets],
      walletSortingOptions
    );

  const hasAptosConnectWallets = !!aptosConnectWallets.length;

  return (
    <DialogContent className="max-h-screen overflow-auto">
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
                isConnecting={isConnecting}
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
            <WalletRow key={wallet.name} wallet={wallet} onConnect={close} isConnecting={isConnecting} />
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
                    isConnecting={isConnecting}
                  />
                ))}
              </CollapsibleContent>
            </Collapsible>
          )}
        </div>
      </AboutAptosConnect>
    </DialogContent>
  );
}

interface WalletRowProps {
  wallet: AdapterWallet | AdapterNotDetectedWallet;
  onConnect?: () => void;
}

interface WalletRowProps {
  wallet: AdapterWallet | AdapterNotDetectedWallet;
  onConnect?: () => void;
  isConnecting?: boolean;
}

function WalletRow({ wallet, onConnect, isConnecting = false }: WalletRowProps) {
  return (
    <WalletItem
      wallet={wallet}
      onConnect={onConnect}
      className="flex items-center justify-between px-4 py-3 gap-4 border rounded-md"
    >
      <div className="flex items-center gap-4">
        <WalletItem.Icon className="h-6 w-6" />
        <WalletItem.Name className="text-base font-normal" />
      </div>
      {isInstallRequired(wallet) ? (
        <Button size="sm" variant="ghost" asChild>
          <WalletItem.InstallLink />
        </Button>
      ) : (
        <WalletItem.ConnectButton asChild>
          <Button size="sm" disabled={isConnecting}>
            {isConnecting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Connecting...
              </>
            ) : (
              'Connect'
            )}
          </Button>
        </WalletItem.ConnectButton>
      )}
    </WalletItem>
  );
}

function AptosConnectWalletRow({ wallet, onConnect, isConnecting = false }: WalletRowProps) {
  return (
    <WalletItem wallet={wallet} onConnect={onConnect}>
      <WalletItem.ConnectButton asChild>
        <Button size="lg" variant="outline" className="w-full gap-4" disabled={isConnecting}>
          {isConnecting ? (
            <>
              <Loader2 className="h-5 w-5 animate-spin" />
              <span className="text-base font-normal">Connecting...</span>
            </>
          ) : (
            <>
              <WalletItem.Icon className="h-5 w-5" />
              <WalletItem.Name className="text-base font-normal" />
            </>
          )}
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
