#!/usr/bin/env node
/** AIが生成・検証した30分計画をimmutable ingest endpointへ送る。 */
import { readFile } from "node:fs/promises";
const baseUrl = (process.env.AI_DAILY_FORECAST_APP_URL || "https://stockalert-ulxu9jpf.manus.space").replace(/\/$/, "");
const ingestKey = process.env.AI_DAILY_FORECAST_INGEST_KEY;
const file = process.argv[2];
if (!file) throw new Error("usage: node scripts/ingest-ai-intraday-forecast.mjs /secure/path/intraday-forecast.json");
if (!ingestKey || ingestKey.length < 32) throw new Error("AI_DAILY_FORECAST_INGEST_KEY is required (minimum 32 characters)");
const payload = JSON.parse(await readFile(file, "utf8"));
for (const field of ["sourceRevisionId", "morningSourceSnapshotId", "tradeDate", "checkpoint", "capturedAtMs", "inputHash", "aiFinalForecast", "generatorId", "promptVersion"]) if (payload[field] === undefined || payload[field] === null) throw new Error(`intraday forecast payload missing ${field}`);
const input = { ...payload, sourceMode: payload.sourceMode ?? "scheduled_ai_forecast", ingestKey };
const response = await fetch(`${baseUrl}/api/trpc/trading.ingestAiIntradayForecast?batch=1`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ 0: { json: input } }) });
if (!response.ok) throw new Error(`intraday ingest endpoint: HTTP ${response.status}`);
const envelope = await response.json(); const result = envelope?.[0]?.result?.data?.json;
if (!result?.sourceRevisionId) throw new Error("intraday ingest endpoint returned no revision identity");
console.log(JSON.stringify({ status: "persisted", sourceRevisionId: result.sourceRevisionId, tradeDate: result.tradeDate, checkpoint: result.checkpoint, cutoffCandleTime: result.cutoffCandleTime, qualityStatus: result.qualityStatus, generatorId: result.aiModelId }, null, 2));
