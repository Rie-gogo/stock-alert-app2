#!/usr/bin/env node
/** 30分AI判断用。Secret認証後、checkpoint以前の確定データだけを取得する。 */
import { writeFile } from "node:fs/promises";
const baseUrl = (process.env.AI_DAILY_FORECAST_APP_URL || "https://stockalert-ulxu9jpf.manus.space").replace(/\/$/, "");
const ingestKey = process.env.AI_DAILY_FORECAST_INGEST_KEY;
const tradeDate = process.argv[2];
const checkpoint = process.argv[3];
const outputIndex = process.argv.indexOf("--out");
const outputPath = outputIndex >= 0 ? process.argv[outputIndex + 1] : null;
if (!ingestKey || ingestKey.length < 32) throw new Error("AI_DAILY_FORECAST_INGEST_KEY is required (minimum 32 characters)");
if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate || "") || !/^\d{2}:\d{2}$/.test(checkpoint || "")) throw new Error("usage: node scripts/fetch-ai-intraday-forecast-input.mjs YYYY-MM-DD HH:MM [--out path]");
const response = await fetch(`${baseUrl}/api/trpc/trading.prepareAiIntradayForecastInput?batch=1`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ 0: { json: { ingestKey, tradeDate, checkpoint } } }) });
if (!response.ok) throw new Error(`intraday input endpoint: HTTP ${response.status}`);
const envelope = await response.json(); const result = envelope?.[0]?.result?.data?.json;
if (!result?.inputHash || !Array.isArray(result?.currentSession?.symbols) || result.currentSession.symbols.length !== 10) throw new Error("intraday input contract invalid");
const serialized = `${JSON.stringify(result, null, 2)}\n`;
if (outputPath) await writeFile(outputPath, serialized, "utf8"); else process.stdout.write(serialized);
