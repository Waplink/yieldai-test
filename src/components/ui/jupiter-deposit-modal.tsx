"use client";

import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";
import { formatNumber } from "@/lib/utils/numberFormat";

interface JupiterDepositModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (amountUi: number) => void;
  isLoading?: boolean;
  token: {
    symbol: string;
    logoUrl?: string;
    availableAmount: number;
    apy?: number;
  };
}

export function JupiterDepositModal({
  isOpen,
  onClose,
  onConfirm,
  isLoading = false,
  token,
}: JupiterDepositModalProps) {
  const [amount, setAmount] = useState("");
  const amountUi = Number(amount);
  const isValid = Number.isFinite(amountUi) && amountUi > 0;
  const exceeds = isValid && amountUi > token.availableAmount;

  useEffect(() => {
    if (!isOpen) {
      setAmount("");
    }
  }, [isOpen]);

  const estimatedDaily = useMemo(() => {
    if (!isValid || !token.apy || token.apy <= 0) return 0;
    return (amountUi * token.apy) / 100 / 365;
  }, [amountUi, isValid, token.apy]);

  return (
    <Dialog open={isOpen} onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="sm:max-w-md w-[95vw] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg sm:text-xl">
            {token.logoUrl ? (
              <Image src={token.logoUrl} alt={token.symbol} width={24} height={24} className="object-contain rounded-full" unoptimized />
            ) : null}
            Deposit to Jupiter
          </DialogTitle>
          <DialogDescription className="text-sm">
            Enter amount to deposit {token.symbol}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="jupiter-deposit-amount" className="text-sm font-medium">Amount</Label>
            <Input
              id="jupiter-deposit-amount"
              type="number"
              min="0"
              step="any"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              disabled={isLoading}
              className={exceeds ? "border-destructive" : ""}
            />
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>Available: {formatNumber(token.availableAmount, 6)} {token.symbol}</span>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setAmount(String(token.availableAmount / 2))}
                  className="hover:text-foreground"
                  disabled={isLoading}
                >
                  Half
                </button>
                <button
                  type="button"
                  onClick={() => setAmount(String(token.availableAmount))}
                  className="hover:text-foreground"
                  disabled={isLoading}
                >
                  Max
                </button>
              </div>
            </div>
            {exceeds && (
              <p className="text-sm text-destructive">
                Amount exceeds available balance.
              </p>
            )}
          </div>

          {token.apy && token.apy > 0 ? (
            <div className="rounded-md border p-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">APR</span>
                <span className="font-medium">{formatNumber(token.apy, 2)}%</span>
              </div>
              <div className="flex items-center justify-between mt-1">
                <span className="text-muted-foreground">Est. daily</span>
                <span className="font-medium">{formatNumber(estimatedDaily, 6)} {token.symbol}</span>
              </div>
            </div>
          ) : null}
        </div>

        <DialogFooter className="gap-2 flex-col sm:flex-row">
          <Button variant="outline" onClick={onClose} disabled={isLoading} className="w-full sm:w-auto h-10">
            Cancel
          </Button>
          <Button
            onClick={() => onConfirm(amountUi)}
            disabled={!isValid || exceeds || isLoading}
            className="w-full sm:w-auto h-10"
          >
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

