import { useCallback, useState } from 'react';
import { executeDeposit } from '../transactions/DepositTransaction';
import { ProtocolKey } from '../transactions/types';
import { useToast } from '@/components/ui/use-toast';
import { showTransactionSuccessToast } from '@/components/ui/transaction-toast';
import { ToastAction } from '@/components/ui/toast';
import { protocols } from '../protocols/protocolsRegistry';
import { useWallet } from '@aptos-labs/wallet-adapter-react';
import { GasStationService } from '@/lib/services/gasStation';

async function getAptosExpireTimestampSecs(ttlSeconds: number): Promise<number | undefined> {
  try {
    const res = await fetch('https://fullnode.mainnet.aptoslabs.com/v1');
    if (!res.ok) return undefined;
    const ledger = await res.json();
    const ledgerTimestampUsec = Number(ledger?.ledger_timestamp);
    if (!Number.isFinite(ledgerTimestampUsec) || ledgerTimestampUsec <= 0) return undefined;
    const ledgerTimestampSecs = Math.floor(ledgerTimestampUsec / 1_000_000);
    return ledgerTimestampSecs + ttlSeconds;
  } catch {
    return undefined;
  }
}

export function useDeposit() {
  const wallet = useWallet();
  const [isLoading, setIsLoading] = useState(false);
  const { toast } = useToast();
  const gasStationAvailable = GasStationService.getInstance().isAvailable();

  const deposit = useCallback(async (
    protocolKey: ProtocolKey,
    token: string,
    amount: bigint,
    options?: { marketAddress?: string }
  ) => {
    try {
      console.log('Starting deposit:', { protocolKey, token, amount });
      setIsLoading(true);

      const protocolInstance = protocols[protocolKey];
      console.log('Protocol instance:', protocolInstance);
      console.log('Protocol instance type:', typeof protocolInstance);

      if (!protocolInstance) {
        throw new Error(`Protocol ${protocolKey} not found`);
      }

      console.log('Protocol instance methods:', Object.getOwnPropertyNames(Object.getPrototypeOf(protocolInstance)));

      if (typeof protocolInstance.buildDeposit !== 'function') {
        throw new Error(`Protocol ${protocolKey} does not have buildDeposit method`);
      }

      const payload = await executeDeposit(protocolInstance, token, amount, wallet, options);
      console.log('Generated payload:', payload);

      if (!payload || typeof payload !== 'object') {
        throw new Error('Invalid payload generated');
      }

      console.log('Submitting transaction with payload:', payload);
      const isAptreeDeposit = protocolKey === 'aptree';

      if (!wallet.connected) {
        throw new Error('Wallet not connected');
      }
      if (!wallet.signAndSubmitTransaction) {
        throw new Error('Wallet does not support signAndSubmitTransaction');
      }

      console.log('Transaction arguments:', {
        function: payload.function,
        typeArguments: payload.type_arguments,
        functionArguments: payload.arguments,
        readableFunctionArguments: payload.arguments.map((arg) => String(arg)),
        decodedAptreeArguments:
          protocolKey === 'aptree'
            ? {
                amountUsdtRaw: String(payload.arguments[0] ?? ''),
                referralCode: String(payload.arguments[1] ?? ''),
              }
            : undefined,
        rawArguments: payload.arguments.map(arg => ({
          value: arg,
          type: typeof arg,
          length: arg.length
        }))
      });

      // Determine appropriate gas limit based on token type
      let maxGasAmount = 20000; // Default for most tokens
      
      // For APT transactions, use higher gas limit since gas station is working
      if (token === '0x1::aptos_coin::AptosCoin' || token === '0xa') {
        maxGasAmount = 2000; // Increased gas limit for APT transactions with gas station
      }

      // Use signAndSubmitTransaction with global Gas Station transactionSubmitter from WalletProvider
      // Gas Station will automatically sponsor the transaction (free for user)
      const ttlSeconds = gasStationAvailable ? 100 : 1800;
      const expireTimestamp = await getAptosExpireTimestampSecs(ttlSeconds);
      const txInputData = {
        function: payload.function as `${string}::${string}::${string}`,
        typeArguments: payload.type_arguments,
        functionArguments: payload.arguments
      };
      const txInput = {
        data: {
          ...txInputData,
        },
        options: {
          maxGasAmount: maxGasAmount,
          ...(expireTimestamp ? { expireTimestamp } : {}),
        },
      } as any;

      let response;

      if (isAptreeDeposit) {
        // Gasless APTree flow: wallet signs/submits with explicit Gas Station submitter.
        const gasStationSubmitter = GasStationService.getInstance().getTransactionSubmitter();
        if (!gasStationSubmitter) {
          throw new Error('Gas Station is not available. Configure NEXT_PUBLIC_APTOS_GAS_STATION_KEY.');
        }
        try {
          response = await wallet.signAndSubmitTransaction({
            ...txInput,
            transactionSubmitter: gasStationSubmitter as any,
          } as any);
        } catch (gasError) {
          const ge = gasError as any;
          const statusCode = ge?.statusCode ?? ge?.response?.status ?? 'unknown';
          const rawMessage =
            ge?.message ||
            ge?.error ||
            ge?.response?.data?.message ||
            ge?.response?.statusText ||
            '';
          const messageText =
            typeof rawMessage === 'string' && rawMessage.trim().length > 0
              ? rawMessage
              : 'Gas Station rejected sponsorship request';
          throw new Error(`Gas Station error (${statusCode}): ${messageText}`);
        }
      } else {
        try {
          response = await wallet.signAndSubmitTransaction(txInput);
        } catch (submitError) {
          const message = submitError instanceof Error ? submitError.message : String(submitError);
          const isGasStationRuleMissing =
            message.includes('Rule not found') || message.includes('signAndSubmit: 404');
          const shouldFallbackToWalletGas = isAptreeDeposit && isGasStationRuleMissing;

          if (!shouldFallbackToWalletGas) {
            throw submitError;
          }

          // Fallback path for wallets without signTransaction support.
          response = await wallet.signAndSubmitTransaction({
            ...txInput,
            transactionSubmitter: null,
          } as any);
        }
      }
      console.log('Transaction response:', response);

      if (response.hash) {
        console.log('Checking transaction status for hash:', response.hash);
        const maxAttempts = 10;
        const delay = 2000;
        // Small initial delay so fullnode/indexer has time to index tx hash.
        await new Promise(resolve => setTimeout(resolve, 1200));
        
        for (let i = 0; i < maxAttempts; i++) {
          console.log(`Checking transaction status attempt ${i + 1}/${maxAttempts}`);
          try {
            const txResponse = await fetch(`https://fullnode.mainnet.aptoslabs.com/v1/transactions/wait_by_hash/${response.hash}`);
            if (txResponse.status === 404) {
              await new Promise(resolve => setTimeout(resolve, delay));
              continue;
            }
            const txData = await txResponse.json();
            console.log('Transaction success:', txData.success);
            console.log('Transaction vm_status:', txData.vm_status);
            
            if (txData.success && txData.vm_status === "Executed successfully") {
              console.log('Transaction confirmed successfully, showing toast...');
              showTransactionSuccessToast({ hash: response.hash });
              if (typeof window !== 'undefined') {
                window.dispatchEvent(
                  new CustomEvent('refreshPositions', { detail: { protocol: protocolKey } })
                );
              }
              console.log('Toast should be shown now');
              return response;
            } else if (txData.vm_status) {
              console.error('Transaction failed with status:', txData.vm_status);
              throw new Error(`Transaction failed: ${txData.vm_status}`);
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            // wait_by_hash may still transiently fail while tx is being indexed.
            if (!message.includes('404')) {
              console.error(`Attempt ${i + 1} failed:`, error);
            }
          }
          
          console.log(`Waiting ${delay}ms before next attempt...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
        
        console.error('Transaction status check timeout');
        throw new Error('Transaction status check timeout');
      }

      return response;
    } catch (error) {
      const rawMessage =
        error instanceof Error
          ? error.message
          : typeof error === 'object' && error !== null
            ? ((error as any).message || (error as any).error || '')
            : String(error);
      const message =
        typeof rawMessage === 'string' && rawMessage.trim().length > 0
          ? rawMessage
          : 'Unknown deposit error';
      const isUserRejected =
        message.includes('User has rejected the request') || message.includes('User rejected');
      const isGasStationRuleMissing =
        message.includes('Rule not found') && message.includes('bridge::deposit');
      if (!isUserRejected) {
        console.error('Deposit error:', error);
      }
      toast({
        title: isUserRejected ? "Transaction canceled" : isGasStationRuleMissing ? "Gasless rule missing" : "Error",
        description: isUserRejected
          ? "Deposit request was canceled in wallet."
          : isGasStationRuleMissing
            ? "Gas Station does not have a sponsorship rule for APTree deposit yet. Add rule for bridge::deposit to enable gasless tx."
            : message || 'Failed to deposit',
        variant: isUserRejected ? "default" : "destructive"
      });
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, [wallet, toast, gasStationAvailable]);

  return {
    deposit,
    isLoading,
  };
} 