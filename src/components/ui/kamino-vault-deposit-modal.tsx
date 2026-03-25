"use client";

import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ChevronDown, Loader2 } from "lucide-react";
import { formatNumber } from "@/lib/utils/numberFormat";
import { calcYield } from "@/lib/utils/calcYield";
import { Separator } from "@/components/ui/separator";

interface KaminoVaultDepositModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (amountUi: number) => void;
  isLoading?: boolean;
  vaultLabel: string;
  token: {
    symbol: string;
    logoUrl?: string;
    availableAmount: number;
    apy?: number;
    priceUsd?: number;
  };
}

export function KaminoVaultDepositModal({
  isOpen,
  onClose,
  onConfirm,
  isLoading = false,
  vaultLabel,
  token,
}: KaminoVaultDepositModalProps) {
  const [amount, setAmount] = useState("");
  const [isYieldExpanded, setIsYieldExpanded] = useState(false);
  const amountUi = Number(amount);
  const isValid = Number.isFinite(amountUi) && amountUi > 0;
  const exceeds = isValid && amountUi > token.availableAmount;

  useEffect(() => {
    if (!isOpen) {
      setAmount("");
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    if (token.availableAmount > 0) {
      setAmount(String(token.availableAmount));
    } else {
      setAmount("");
    }
  }, [isOpen, token.availableAmount]);

  const estimatedDaily = useMemo(() => {
    if (!isValid || !token.apy || token.apy <= 0) return 0;
    return (amountUi * token.apy) / 100 / 365;
  }, [amountUi, isValid, token.apy]);

  const yieldResult = useMemo(() => {
    if (!token.apy || token.apy <= 0 || !isValid) {
      return { daily: 0, weekly: 0, monthly: 0, yearly: 0 };
    }
    const scaled = BigInt(Math.floor(amountUi * 1_000_000));
    return calcYield(token.apy, scaled, 6);
  }, [amountUi, isValid, token.apy]);

  const usdValue = useMemo(() => {
    if (!isValid || !token.priceUsd || token.priceUsd <= 0) return 0;
    return amountUi * token.priceUsd;
  }, [amountUi, isValid, token.priceUsd]);

  return (
    <Dialog open={isOpen} onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="sm:max-w-[425px] p-6 rounded-2xl">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <Image
              src="/protocol_ico/kamino.png"
              alt="Kamino"
              width={24}
              height={24}
              className="rounded-full"
              unoptimized
            />
            <DialogTitle>Deposit to Kamino</DialogTitle>
          </div>
          <DialogDescription>Enter amount to deposit {token.symbol}</DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-center gap-2 py-4">
          <div className="flex items-center gap-2">
            {token.logoUrl ? (
              <Image src={token.logoUrl} alt={token.symbol} width={32} height={32} className="object-contain rounded-full" unoptimized />
            ) : null}
            <span>{token.symbol}</span>
          </div>
          <span>-&gt;</span>
          <div className="flex items-center gap-2">
            {token.logoUrl ? (
              <Image src={token.logoUrl} alt={token.symbol} width={32} height={32} className="object-contain rounded-full" unoptimized />
            ) : null}
            <span>{token.symbol}</span>
          </div>
        </div>

        <div className="grid gap-4 py-4">
          <div className="grid grid-cols-4 items-center gap-4">
            <Label htmlFor="kamino-vault-deposit-amount" className="text-right">
              Amount
            </Label>
            <div className="col-span-3 flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <Input
                  id="kamino-vault-deposit-amount"
                  type="number"
                  min="0"
                  step="any"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="0.00"
                  disabled={isLoading}
                  className={`${exceeds ? "border-destructive text-destructive" : ""}`}
                />
                {token.logoUrl ? (
                  <Image
                    src={token.logoUrl}
                    alt={token.symbol}
                    width={16}
                    height={16}
                    className="rounded-full"
                    unoptimized
                  />
                ) : null}
                <span className="text-sm shrink-0">{token.symbol}</span>
                {usdValue > 0 ? (
                  <span className="text-sm text-muted-foreground ml-2">~ ${usdValue.toFixed(2)}</span>
                ) : null}
              </div>
            </div>
          </div>

          {exceeds ? (
            <p className="text-sm text-destructive -mt-2">Amount exceeds available balance.</p>
          ) : null}

          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              type="button"
              onClick={() => setAmount(String(token.availableAmount / 2))}
              disabled={isLoading}
            >
              Half
            </Button>
            <Button
              variant="outline"
              size="sm"
              type="button"
              onClick={() => setAmount(String(token.availableAmount))}
              disabled={isLoading}
            >
              Max
            </Button>
          </div>

          <div
            className="flex items-center justify-between cursor-pointer"
            onClick={() => setIsYieldExpanded((v) => !v)}
          >
            <div className="flex items-center gap-4">
              <div className="text-sm text-muted-foreground">APR {(token.apy || 0).toFixed(2)}%</div>
              <div className="flex items-center gap-2">
                <span className="text-xl font-bold">~ ${estimatedDaily.toFixed(2)}</span>
                <span className="text-sm text-muted-foreground">/day</span>
                <ChevronDown className="h-3 w-3 text-muted-foreground ml-1" />
              </div>
            </div>
          </div>
          {isYieldExpanded ? (
            <div className="space-y-1 text-sm text-muted-foreground">
              <div>~ ${yieldResult.weekly.toFixed(2)} /week</div>
              <div>~ ${yieldResult.monthly.toFixed(2)} /month</div>
              <div>~ ${yieldResult.yearly.toFixed(2)} /year</div>
            </div>
          ) : null}
        </div>

        <Separator />

        <DialogFooter className="gap-2 flex-col sm:flex-row">
          <Button variant="outline" onClick={onClose} disabled={isLoading}>
            Cancel
          </Button>
          <Button onClick={() => onConfirm(amountUi)} disabled={!isValid || exceeds || isLoading}>
            {isLoading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Processing...
              </>
            ) : (
              "Deposit"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
