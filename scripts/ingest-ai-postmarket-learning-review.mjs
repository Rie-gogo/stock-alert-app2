#!/usr/bin/env node
/** Codexが検証した閉場後reviewだけをimmutable ingest endpointへ送る。 */
import { readFile } from "node:fs/promises";

const baseUrl = (
  process.env.AI_DAILY_FORECAST_APP_URL ||
  "https://stockalert-ulxu9jpf.manus.space"
).replace(/\/$/, "");
const ingestKey = process.env.AI_DAILY_FORECAST_INGEST_KEY;
const file = process.argv[2];

if (!file)
  throw new Error(
    "usage: node scripts/ingest-ai-postmarket-learning-review.mjs /secure/path/postmarket-learning-review.json"
  );
if (!ingestKey || ingestKey.length < 32)
  throw new Error("AI_DAILY_FORECAST_INGEST_KEY is required (minimum 32 characters)");

const review = JSON.parse(await readFile(file, "utf8"));
for (const field of [
  "reviewId",
  "tradeDate",
  "inputHash",
  "generatedAtMs",
  "generatorId",
  "promptVersion",
  "model",
  "status",
  "symbolReviews",
  "hypotheses",
  "validation",
  "policyAdvice",
])
  if (review[field] === undefined || review[field] === null)
    throw new Error(`postmarket review payload missing ${field}`);

const response = await fetch(
  `${baseUrl}/api/trpc/trading.ingestAiPostmarketLearningReview?batch=1`,
  {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ 0: { json: { ingestKey, review } } }),
  }
);
if (!response.ok) throw new Error(`postmarket review ingest endpoint: HTTP ${response.status}`);
const envelope = await response.json();
const result = envelope?.[0]?.result?.data?.json;
if (!result?.reviewId || !result?.payloadHash)
  throw new Error("postmarket review ingest endpoint returned no immutable identity");
console.log(
  JSON.stringify(
    {
      status: result.duplicate ? "duplicate" : "persisted",
      reviewId: result.reviewId,
      tradeDate: result.tradeDate,
      reviewStatus: result.status,
      payloadHash: result.payloadHash,
      automaticRuleMutation: false,
      orderInstructionConnection: false,
    },
    null,
    2
  )
);
