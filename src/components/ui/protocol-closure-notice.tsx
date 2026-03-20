"use client";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ProtocolKey } from "@/lib/transactions/types";
import { cn } from "@/lib/utils";
import { AlertTriangle, ExternalLink } from "lucide-react";

type ClosureNotice = {
  title: string;
  description: string;
  url: string;
};

const CLOSURE_NOTICES: Partial<Record<ProtocolKey, ClosureNotice>> = {
  earnium: {
    title: "Earnium is winding down",
    description:
      "We strongly encourage liquidity providers and users to withdraw funds and remove liquidity positions as soon as possible.",
    url: "https://x.com/earnium_io/status/2029859848897319215",
  },
  auro: {
    title: "Auro Finance is discontinuing the project",
    description:
      "If you currently have funds on the platform, please withdraw your assets as soon as possible.",
    url: "https://x.com/AuroFinance_/status/2034253492068766028",
  },
};

export function ProtocolClosureNotice({
  protocolKey,
  stopPropagation = false,
  className,
}: {
  protocolKey: ProtocolKey;
  stopPropagation?: boolean;
  className?: string;
}) {
  const notice = CLOSURE_NOTICES[protocolKey];
  if (!notice) return null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label={`${notice.title} (closure notice)`}
          className={cn(
            "h-8 w-8 p-0 text-destructive hover:bg-destructive/10 hover:text-destructive",
            className
          )}
          onClick={(e) => {
            if (stopPropagation) {
              e.stopPropagation();
            }
          }}
        >
          <AlertTriangle className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 max-w-[90vw] p-4" align="start" sideOffset={8}>
        <div className="space-y-3">
          <div>
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-destructive" />
              <h4 className="font-semibold text-sm">{notice.title}</h4>
            </div>
          </div>
          <p className="text-sm text-muted-foreground">{notice.description}</p>
          <a
            href={notice.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 text-sm text-destructive hover:underline"
          >
            Read the official update
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </PopoverContent>
    </Popover>
  );
}

