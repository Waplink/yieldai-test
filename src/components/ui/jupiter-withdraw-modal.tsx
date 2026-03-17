"use client";

import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Loader2 } from "lucide-react";
import { formatNumber } from "@/lib/utils/numberFormat";

interface JupiterWithdrawModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (amountUi: number) => void;
  isLoading?: boolean;
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
  token,
}: JupiterWithdrawModalProps) {
  const [percentage, setPercentage] = useState<number[]>([100]);

  useEffect(() => {
    if (!isOpen) {
      setPercentage([100]);
    }
  }, [isOpen]);

  const amountUi = useMemo(() => {
    return (token.suppliedAmount * percentage[0]) / 100;
  }, [token.suppliedAmount, percentage]);

  return (
    <Dialog open={isOpen} onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="sm:max-w-md w-[95vw] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg sm:text-xl">
            {token.logoUrl ? (
              <Image src={token.logoUrl} alt={token.symbol} width={24} height={24} className="object-contain rounded-full" unoptimized />
            ) : null}
            Withdraw {token.symbol}
          </DialogTitle>
          <DialogDescription className="text-sm">
            Select the percentage to withdraw from your Jupiter position.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
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

          <div className="rounded-md border p-3 text-sm space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Supplied</span>
              <span>{formatNumber(token.suppliedAmount, 6)} {token.symbol}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Withdraw</span>
              <span>{formatNumber(amountUi, 6)} {token.symbol}</span>
            </div>
          </div>
        </div>

        <DialogFooter className="gap-2 flex-col sm:flex-row">
          <Button variant="outline" onClick={onClose} disabled={isLoading} className="w-full sm:w-auto h-10">
            Cancel
          </Button>
          <Button
            onClick={() => onConfirm(amountUi)}
            disabled={isLoading || amountUi <= 0}
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

