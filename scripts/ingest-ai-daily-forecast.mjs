#!/usr/bin/env node
/**
 * Codex定期タスクが生成・自己検証済みのforecast JSONをimmutable ingest endpointへ送る。
 * 入力JSONには inputHash, quantBaseline, aiFinalForecast とgenerator識別情報が必要。
 * ingest keyは環境変数のみから付与し、ファイル・標準出力・ログに出さない。
 */
import { readFile } from "node:fs/promises";
const baseUrl = (process.env.AI_DAILY_FORECAST_APP_URL || "https://stockalert-ulxu9jpf.manus.space").replace(/\/$/, "");
const ingestKey = process.env.AI_DAILY_FORECAST_INGEST_KEY;
const file = process.argv[2];
if (!file) throw new Error("usage: node scripts/ingest-ai-daily-forecast.mjs /secure/path/forecast.json");
if (!ingestKey || ingestKey.length < 32) throw new Error("AI_DAILY_FORECAST_INGEST_KEY is required (minimum 32 characters)");
const payload = JSON.parse(await readFile(file, "utf8"));
for (const field of ["sourceSnapshotId", "tradeDate", "capturedAtMs", "inputHash", "quantBaseline", "aiFinalForecast", "generatorId", "promptVersion"]) {
  if (payload[field] === undefined || payload[field] === null) throw new Error(`forecast payload missing ${field}`);
}
const input = { ...payload, sourceMode: payload.sourceMode ?? "scheduled_ai_forecast", ingestKey };
const response = await fetch(`${baseUrl}/api/trpc/trading.ingestAiDailyForecast?batch=1`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ 0: { json: input } }) });
if (!response.ok) throw new Error(`ingest endpoint: HTTP ${response.status}`);
const envelope = await response.json(); const result = envelope?.[0]?.result?.data?.json;
if (!result?.sourceSnapshotId) throw new Error("ingest endpoint returned no snapshot identity");
console.log(JSON.stringify({ status: "persisted", sourceSnapshotId: result.sourceSnapshotId, tradeDate: result.tradeDate, dataCutoffDate: result.dataCutoffDate, qualityStatus: result.qualityStatus, generatorId: result.aiModelId }, null, 2));
