"use client";

import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Loader2 } from "lucide-react";
import { formatNumber } from "@/lib/utils/numberFormat";

interface JupiterWithdrawModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (amountUi: number) => void;
  isLoading?: boolean;
  /** Default: `Withdraw ${token.symbol}` */
  title?: string;
  /** Default: Jupiter position copy */
  description?: string;
  /**
   * Amount input + Half/Max instead of %-slider (e.g. vault shares when API balance is missing).
   */
  useAmountInput?: boolean;
  token: {
    symbol: string;
    logoUrl?: string;
    suppliedAmount: number;
  };
}

export function JupiterWithdrawModal({
  isOpen,
  onClose,
  onConfirm,
  isLoading = false,
  title,
  description,
  useAmountInput = false,
  token,
}: JupiterWithdrawModalProps) {
  const [percentage, setPercentage] = useState<number[]>([100]);
  const [amount, setAmount] = useState("");

  const dialogTitle = title ?? `Withdraw ${token.symbol}`;
  const dialogDescription =
    description ??
    (useAmountInput
      ? `Enter the amount to withdraw in ${token.symbol}.`
      : "Select the percentage to withdraw from your Jupiter position.");

  useEffect(() => {
    if (!isOpen) {
      setPercentage([100]);
      setAmount("");
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !useAmountInput) return;
    if (token.suppliedAmount > 0) {
      setAmount(String(token.suppliedAmount));
    } else {
      setAmount("");
    }
  }, [isOpen, useAmountInput, token.suppliedAmount]);

  const amountUiSlider = useMemo(() => {
    return (token.suppliedAmount * percentage[0]) / 100;
  }, [token.suppliedAmount, percentage]);

  const amountUiInput = Number(amount);
  const inputValid = Number.isFinite(amountUiInput) && amountUiInput > 0;
  const inputExceeds =
    inputValid && token.suppliedAmount > 0 && amountUiInput > token.suppliedAmount + 1e-12;

  const amountUi = useAmountInput ? amountUiInput : amountUiSlider;
  const canSubmit = useAmountInput ? inputValid && !inputExceeds : amountUiSlider > 0;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="sm:max-w-md w-[95vw] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg sm:text-xl">
            {token.logoUrl ? (
              <Image src={token.logoUrl} alt={token.symbol} width={24} height={24} className="object-contain rounded-full" unoptimized />
            ) : null}
            {dialogTitle}
          </DialogTitle>
          <DialogDescription className="text-sm">{dialogDescription}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {useAmountInput ? (
            <div className="grid gap-4">
              <div className="grid grid-cols-4 items-center gap-4">
                <Label htmlFor="jupiter-withdraw-amount-input" className="text-right">
                  Amount
                </Label>
                <div className="col-span-3 flex flex-wrap items-center gap-2">
                  <Input
                    id="jupiter-withdraw-amount-input"
                    type="number"
                    min="0"
                    step="any"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="0.00"
                    disabled={isLoading}
                    className={inputExceeds ? "border-destructive text-destructive" : ""}
                  />
                  <span className="text-sm">{token.symbol}</span>
                </div>
              </div>
              {inputExceeds ? (
                <p className="text-sm text-destructive -mt-2">Amount exceeds available balance.</p>
              ) : null}
              {token.suppliedAmount > 0 ? (
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setAmount(String(token.suppliedAmount / 2))}
                    disabled={isLoading}
                  >
                    Half
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setAmount(String(token.suppliedAmount))}
                    disabled={isLoading}
                  >
                    Max
                  </Button>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="space-y-2">
              <Slider
                value={percentage}
                onValueChange={setPercentage}
                max={100}
                min={0}
                step={1}
                disabled={isLoading}
                className="w-full"
              />
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">0%</span>
                <span className="font-semibold">{percentage[0]}%</span>
                <span className="text-muted-foreground">100%</span>
              </div>
            </div>
          )}

          <div className="rounded-md border p-3 text-sm space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Supplied</span>
              <span>
                {formatNumber(token.suppliedAmount, 6)} {token.symbol}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Withdraw</span>
              <span>
                {formatNumber(amountUi, 6)} {token.symbol}
              </span>
            </div>
          </div>
        </div>

        <DialogFooter className="gap-2 flex-col sm:flex-row">
          <Button variant="outline" onClick={onClose} disabled={isLoading} className="w-full sm:w-auto h-10">
            Cancel
          </Button>
          <Button
            onClick={() => onConfirm(amountUi)}
            disabled={isLoading || !canSubmit}
            className="w-full sm:w-auto h-10"
          >
            {isLoading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Withdrawing...
              </>
            ) : (
              "Withdraw"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

