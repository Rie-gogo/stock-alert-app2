import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

const inputPath = process.argv[2];
if (!inputPath) {
  throw new Error("Usage: node scripts/push-premarket-context-snapshot.mjs <snapshot.json>");
}

const defaultKeyPath = resolve(homedir(), ".stock-alert", "premarket_ingest.key");
const keyPath = process.env.STOCK_ALERT_PREMARKET_KEY_FILE || defaultKeyPath;
const ingestKey = (process.env.STOCK_ALERT_PREMARKET_INGEST_KEY
  || await readFile(keyPath, "utf8")).trim();
if (ingestKey.length < 32) throw new Error("Premarket ingest key is missing or too short");

const snapshot = JSON.parse(await readFile(resolve(inputPath), "utf8"));
const baseUrl = process.env.STOCK_ALERT_BASE_URL || "https://stockalert-ulxu9jpf.manus.space";
const endpoint = `${baseUrl}/api/trpc/trading.pushPremarketMarketContextAutomated`;
const response = await fetch(endpoint, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ json: { ...snapshot, ingestKey } }),
  signal: AbortSignal.timeout(20_000),
});
const body = await response.json().catch(() => null);
if (!response.ok) {
  throw new Error(`Premarket snapshot delivery failed: HTTP ${response.status}`);
}
const result = body?.result?.data?.json;
if (!result?.accepted || result?.payloadMismatch) {
  throw new Error(`Premarket snapshot rejected: ${JSON.stringify(result ?? body)}`);
}
console.log(JSON.stringify({
  accepted: true,
  duplicate: Boolean(result.duplicate),
  sourceSnapshotId: result.sourceSnapshotId,
  qualityStatus: result.qualityStatus ?? result.result?.regime?.qualityStatus ?? null,
}));
