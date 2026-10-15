#!/usr/bin/env node
/** AIが生成・検証したv6 checkpoint計画をimmutable ingest endpointへ送る。 */
import { readFile } from "node:fs/promises";
import { validateAiIntradayFiles } from "./ai-intraday-preflight.mjs";
const baseUrl = (
  process.env.AI_DAILY_FORECAST_APP_URL ||
  "https://stockalert-ulxu9jpf.manus.space"
).replace(/\/$/, "");
const ingestKey = process.env.AI_DAILY_FORECAST_INGEST_KEY;
const file = process.argv[2];
const inputFlag = process.argv.indexOf("--input");
const inputFile = inputFlag >= 0 ? process.argv[inputFlag + 1] : undefined;
if (!file || (inputFlag >= 0 && !inputFile))
  throw new Error(
    "usage: node scripts/ingest-ai-intraday-forecast.mjs /secure/path/intraday-forecast.json [--input /secure/path/intraday-input.json]"
  );
const payload = JSON.parse(await readFile(file, "utf8"));
for (const field of [
  "sourceRevisionId",
  "morningSourceSnapshotId",
  "tradeDate",
  "checkpoint",
  "capturedAtMs",
  "inputHash",
  "aiFinalForecast",
  "generatorId",
  "promptVersion",
])
  if (payload[field] === undefined || payload[field] === null)
    throw new Error(`intraday forecast payload missing ${field}`);
const localPreflight = await validateAiIntradayFiles(file, inputFile);
if (!localPreflight.valid)
  throw new Error(
    `ai_intraday_preflight_failed:${localPreflight.reasonCodes.join(",")}`
  );
if (!ingestKey || ingestKey.length < 32)
  throw new Error(
    "AI_DAILY_FORECAST_INGEST_KEY is required (minimum 32 characters)"
  );
const frozenInput = inputFile
  ? JSON.parse(await readFile(inputFile, "utf8"))
  : null;
if (frozenInput) {
  if (
    frozenInput.tradeDate !== payload.tradeDate ||
    frozenInput.checkpoint !== payload.checkpoint ||
    frozenInput.morningSourceSnapshotId !== payload.morningSourceSnapshotId ||
    frozenInput.inputHash !== payload.inputHash ||
    !frozenInput.inputSnapshotToken ||
    frozenInput.materializationWatermark?.status !== "complete"
  )
    throw new Error("intraday frozen input identity mismatch");
} else {
  // Legacy files without a signed input keep the server-side non-persisting preflight.
  const preflightResponse = await fetch(
    `${baseUrl}/api/trpc/trading.preflightAiIntradayForecast?batch=1`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        0: {
          json: {
            ingestKey,
            tradeDate: payload.tradeDate,
            checkpoint: payload.checkpoint,
            aiFinalForecast: payload.aiFinalForecast,
          },
        },
      }),
    }
  );
  if (!preflightResponse.ok)
    throw new Error(
      `intraday preflight endpoint: HTTP ${preflightResponse.status}`
    );
  const preflightEnvelope = await preflightResponse.json();
  const preflight = preflightEnvelope?.[0]?.result?.data?.json;
  if (!preflight?.valid)
    throw new Error(
      `intraday preflight rejected: ${(preflight?.reasonCodes ?? ["unknown"]).join(",")}`
    );
  if (preflight.inputHash !== payload.inputHash)
    throw new Error("intraday preflight input hash mismatch");
}
const input = {
  ...payload,
  sourceMode: payload.sourceMode ?? "scheduled_ai_forecast",
  ...(frozenInput
    ? {
        frozenInput,
        inputSnapshotToken: frozenInput.inputSnapshotToken,
      }
    : {}),
  ingestKey,
};
const RETRY_DELAYS_MS = [0, 1_500, 5_000];
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
let result = null;
for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt += 1) {
  if (RETRY_DELAYS_MS[attempt] > 0) await delay(RETRY_DELAYS_MS[attempt]);
  const response = await fetch(
    `${baseUrl}/api/trpc/trading.ingestAiIntradayForecast?batch=1`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ 0: { json: input } }),
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
  if (failure.status === 503 && attempt + 1 < RETRY_DELAYS_MS.length) {
    console.error(
      JSON.stringify({
        status: "retrying_intraday_ingest",
        reasonCode: failure.reasonCode,
        attempt: attempt + 1,
      })
    );
    continue;
  }
  throw new Error(
    `intraday ingest endpoint: HTTP ${failure.status} ${failure.trpcCode ?? "UNKNOWN"} ${failure.reasonCode} attempts=${attempt + 1}`
  );
}
if (!result?.sourceRevisionId)
  throw new Error("intraday ingest endpoint returned no revision identity");
console.log(
  JSON.stringify(
    {
      status: "persisted",
      sourceRevisionId: result.sourceRevisionId,
      tradeDate: result.tradeDate,
      checkpoint: result.checkpoint,
      cutoffCandleTime: result.cutoffCandleTime,
      qualityStatus: result.qualityStatus,
      generatorId: result.aiModelId,
    },
    null,
    2
  )
);
