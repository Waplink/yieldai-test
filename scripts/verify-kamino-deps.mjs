/**
 * Runs after `npm install` (including Vercel build). Confirms Kamino SDK + @solana/kit resolve and load.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);

function readInstalledVersion(packageName) {
  const pkgPath = require.resolve(`${packageName}/package.json`);
  const json = JSON.parse(readFileSync(pkgPath, "utf8"));
  return { version: json.version, path: pkgPath };
}

async function main() {
  const kit = readInstalledVersion("@solana/kit");
  const klend = readInstalledVersion("@kamino-finance/klend-sdk");
  const decimal = readInstalledVersion("decimal.js");

  console.log(
    `[verify-kamino-deps] resolved: @solana/kit@${kit.version}, @kamino-finance/klend-sdk@${klend.version}, decimal.js@${decimal.version}`
  );

  await import("@solana/kit");
  console.log("[verify-kamino-deps] OK: dynamic import @solana/kit");

  await import("@kamino-finance/klend-sdk");
  console.log("[verify-kamino-deps] OK: dynamic import @kamino-finance/klend-sdk");

  console.log("[verify-kamino-deps] All checks passed.");
}

main().catch((err) => {
  console.error("[verify-kamino-deps] FAILED:", err);
  process.exit(1);
});
