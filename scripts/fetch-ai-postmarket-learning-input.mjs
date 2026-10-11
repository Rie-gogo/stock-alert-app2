#!/usr/bin/env node
/** Codex閉場後review用。認証済み・finality済みinputだけをstdoutまたは--outへ出力する。 */
import { writeFile } from "node:fs/promises";

const baseUrl = (
  process.env.AI_DAILY_FORECAST_APP_URL ||
  "https://stockalert-ulxu9jpf.manus.space"
).replace(/\/$/, "");
const ingestKey = process.env.AI_DAILY_FORECAST_INGEST_KEY;
const tradeDate = process.argv[2];
const outputIndex = process.argv.indexOf("--out");
const outputPath = outputIndex >= 0 ? process.argv[outputIndex + 1] : null;

if (!ingestKey || ingestKey.length < 32)
  throw new Error("AI_DAILY_FORECAST_INGEST_KEY is required (minimum 32 characters)");
if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate || ""))
  throw new Error(
    "usage: node scripts/fetch-ai-postmarket-learning-input.mjs YYYY-MM-DD [--out path]"
  );
if (outputIndex >= 0 && !outputPath)
  throw new Error("--out requires a secure output path");

const response = await fetch(
  `${baseUrl}/api/trpc/trading.prepareAiPostmarketLearningInput?batch=1`,
  {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ 0: { json: { ingestKey, tradeDate } } }),
  }
);
if (!response.ok) throw new Error(`postmarket input endpoint: HTTP ${response.status}`);
const envelope = await response.json();
const result = envelope?.[0]?.result?.data?.json;
if (
  !result?.inputHash ||
  result?.inputQuality === "invalid" ||
  !Array.isArray(result?.currentDay?.symbols) ||
  result.currentDay.symbols.length !== 10
)
  throw new Error("postmarket input contract invalid or finality unavailable");

const serialized = `${JSON.stringify(result, null, 2)}\n`;
if (outputPath) await writeFile(outputPath, serialized, "utf8");
else process.stdout.write(serialized);
