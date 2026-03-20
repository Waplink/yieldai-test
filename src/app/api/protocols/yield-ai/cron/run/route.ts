import { NextRequest, NextResponse } from "next/server";
import { createErrorResponse, createSuccessResponse } from "@/lib/utils/http";
import { runYieldAiVaultCronPass } from "@/lib/protocols/yield-ai/yieldAiVaultWorker";

type CronRunBody = {
  /** Some clients send `"true"` / `"false"` instead of JSON booleans. */
  dryRun?: boolean | string;
  pageSize?: number;
  maxSafesProcessedPerRun?: number;
  maxTxPerRun?: number;
  concurrencyReads?: number;
};

function getGlobalLockKey() {
  return "__yieldAiVaultCronRunning";
}

export async function POST(request: NextRequest) {
  const secret = process.env.YIELD_AI_CRON_SECRET;
  const provided = request.headers.get("x-cron-secret");

  if (!secret) {
    return NextResponse.json(
      createErrorResponse(
        new Error("YIELD_AI_CRON_SECRET is not configured on the server")
      ),
      { status: 500 }
    );
  }

  if (!provided || provided !== secret) {
    return NextResponse.json(createErrorResponse(new Error("Unauthorized")), {
      status: 401,
    });
  }

  const lockKey = getGlobalLockKey();
  const g = globalThis as any;
  if (g[lockKey]) {
    return NextResponse.json(
      createErrorResponse(new Error("Cron worker is already running")),
      { status: 429 }
    );
  }

  g[lockKey] = true;

  try {
    const contentLength = request.headers.get("content-length");
    const raw = await request.text();
    const rawTrimmed = raw.trim();

    let body: CronRunBody = {};
    if (rawTrimmed.length > 0) {
      try {
        body = JSON.parse(rawTrimmed) as CronRunBody;
      } catch (parseErr) {
        console.error("[Yield AI] cron: invalid JSON body", {
          contentLength,
          rawByteLength: Buffer.byteLength(raw, "utf8"),
          rawPreview: raw.slice(0, 400),
          parseErr:
            parseErr instanceof Error ? parseErr.message : String(parseErr),
        });
      }
    } else {
      console.warn("[Yield AI] cron: empty request body (defaults will apply)", {
        contentLength,
        contentType: request.headers.get("content-type"),
      });
    }

    const dryRun =
      body.dryRun === true ||
      (typeof body.dryRun === "string" &&
        body.dryRun.toLowerCase() === "true");

    console.log("[Yield AI] cron: parsed request", {
      contentLength,
      contentType: request.headers.get("content-type"),
      rawByteLength: Buffer.byteLength(raw, "utf8"),
      rawPreview:
        rawTrimmed.length > 0
          ? `${rawTrimmed.slice(0, 300)}${rawTrimmed.length > 300 ? "…" : ""}`
          : "(empty)",
      dryRunFromPayload: body.dryRun,
      dryRunResolved: dryRun,
      pageSize: body.pageSize,
      maxSafesProcessedPerRun: body.maxSafesProcessedPerRun,
      maxTxPerRun: body.maxTxPerRun,
      concurrencyReads: body.concurrencyReads,
    });

    const result = await runYieldAiVaultCronPass({
      dryRun,
      pageSize:
        typeof body.pageSize === "number" && body.pageSize > 0 ? body.pageSize : undefined,
      maxSafesProcessedPerRun:
        typeof body.maxSafesProcessedPerRun === "number" &&
        body.maxSafesProcessedPerRun > 0
          ? body.maxSafesProcessedPerRun
          : undefined,
      maxTxPerRun:
        typeof body.maxTxPerRun === "number" && body.maxTxPerRun > 0 ? body.maxTxPerRun : undefined,
      concurrencyReads:
        typeof body.concurrencyReads === "number" && body.concurrencyReads > 0
          ? body.concurrencyReads
          : undefined,
    });

    return NextResponse.json(createSuccessResponse(result));
  } catch (error) {
    console.error("[Yield AI] cron run endpoint error:", error);
    return NextResponse.json(
      createErrorResponse(
        error instanceof Error ? error : new Error("Unknown cron run error")
      ),
      { status: 500 }
    );
  } finally {
    g[lockKey] = false;
  }
}

