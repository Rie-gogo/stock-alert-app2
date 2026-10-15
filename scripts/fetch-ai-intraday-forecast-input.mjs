#!/usr/bin/env node
/** AI v6 checkpoint判断用。Secret認証後、checkpoint以前の確定データだけを取得する。 */
import { writeFile } from "node:fs/promises";
const baseUrl = (
  process.env.AI_DAILY_FORECAST_APP_URL ||
  "https://stockalert-ulxu9jpf.manus.space"
).replace(/\/$/, "");
const ingestKey = process.env.AI_DAILY_FORECAST_INGEST_KEY;
const tradeDate = process.argv[2];
const checkpoint = process.argv[3];
const outputIndex = process.argv.indexOf("--out");
const outputPath = outputIndex >= 0 ? process.argv[outputIndex + 1] : null;
if (!ingestKey || ingestKey.length < 32)
  throw new Error(
    "AI_DAILY_FORECAST_INGEST_KEY is required (minimum 32 characters)"
  );
if (
  !/^\d{4}-\d{2}-\d{2}$/.test(tradeDate || "") ||
  !/^\d{2}:\d{2}$/.test(checkpoint || "")
)
  throw new Error(
    "usage: node scripts/fetch-ai-intraday-forecast-input.mjs YYYY-MM-DD HH:MM [--out path]"
  );
const CHECKPOINT_VALID_UNTIL = {
  "09:15": "09:29",
  "09:30": "09:44",
  "09:45": "09:59",
  "10:00": "10:14",
  "10:15": "10:29",
  "10:30": "10:44",
  "10:45": "10:59",
  "11:00": "11:14",
  "11:15": "11:29",
  "11:30": "12:34",
  "12:35": "12:59",
  "13:00": "13:29",
  "13:30": "13:59",
  "14:00": "14:29",
  "14:30": "14:59",
  "15:00": "15:19",
};
const RETRY_INTERVAL_MS = 15_000;
const MAX_MATERIALIZATION_WAIT_MS = 120_000;
const ANALYSIS_RESERVE_MS = 4 * 60_000;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function parseEnvelope(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
function trpcFailure(response, envelope) {
  const error = envelope?.[0]?.error?.json ?? envelope?.[0]?.error ?? null;
  return {
    status: response.status,
    reasonCode:
      typeof error?.message === "string"
        ? error.message
        : `http_${response.status}`,
    trpcCode: typeof error?.data?.code === "string" ? error.data.code : null,
  };
}
const validUntil = CHECKPOINT_VALID_UNTIL[checkpoint];
if (!validUntil)
  throw new Error(`unsupported intraday checkpoint: ${checkpoint}`);
const validUntilMs = Date.parse(`${tradeDate}T${validUntil}:59+09:00`);
const retryDeadlineMs = Math.min(
  Date.now() + MAX_MATERIALIZATION_WAIT_MS,
  validUntilMs - ANALYSIS_RESERVE_MS
);
let result = null;
let attempt = 0;
let waitingReported = false;
while (!result) {
  attempt += 1;
  const response = await fetch(
    `${baseUrl}/api/trpc/trading.prepareAiIntradayForecastInput?batch=1`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        0: { json: { ingestKey, tradeDate, checkpoint } },
      }),
    }
  );
  const responseText = await response.text();
  const envelope = parseEnvelope(responseText);
  const candidate = envelope?.[0]?.result?.data?.json;
  if (response.ok && candidate) {
    result = candidate;
    break;
  }
  const failure = trpcFailure(response, envelope);
  if (
    failure.status === 503 &&
    Date.now() + RETRY_INTERVAL_MS <= retryDeadlineMs
  ) {
    if (!waitingReported) {
      console.error(
        JSON.stringify({
          status: "waiting_for_intraday_materialization",
          tradeDate,
          checkpoint,
          reasonCode: failure.reasonCode,
          retryIntervalMs: RETRY_INTERVAL_MS,
          retryDeadlineMs,
        })
      );
      waitingReported = true;
    }
    await delay(RETRY_INTERVAL_MS);
    continue;
  }
  const reasonCode =
    failure.reasonCode === "ai_intraday_materialization_pending"
      ? "ai_intraday_materialization_timeout"
      : failure.reasonCode;
  throw new Error(
    `intraday input endpoint: HTTP ${failure.status} ${failure.trpcCode ?? "UNKNOWN"} ${reasonCode} attempts=${attempt}`
  );
}
if (
  !result?.inputHash ||
  !result?.inputSnapshotToken ||
  result?.materializationWatermark?.status !== "complete" ||
  !Array.isArray(result?.currentSession?.symbols) ||
  result.currentSession.symbols.length !== 10
)
  throw new Error("intraday input contract invalid");
const serialized = `${JSON.stringify(result, null, 2)}\n`;
if (outputPath) await writeFile(outputPath, serialized, "utf8");
else process.stdout.write(serialized);
