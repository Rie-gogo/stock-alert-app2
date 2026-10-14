#!/usr/bin/env node
/** 2026-10-14 AI shadow台帳の限定修復。prepareとapplyを必ず分離する。 */
const baseUrl = (process.env.AI_DAILY_FORECAST_APP_URL || "https://stockalert-ulxu9jpf.manus.space").replace(/\/$/, "");
const ingestKey = process.env.AI_DAILY_FORECAST_INGEST_KEY;
const phase = process.argv[2];
const tradeDate = "2026-10-14";
const planHashIndex = process.argv.indexOf("--plan-hash");
const expectedPlanHash = planHashIndex >= 0 ? process.argv[planHashIndex + 1] : null;

if (!ingestKey || ingestKey.length < 32)
  throw new Error("AI_DAILY_FORECAST_INGEST_KEY is required (minimum 32 characters)");
if (phase !== "prepare" && phase !== "apply")
  throw new Error("usage: node scripts/repair-ai-shadow-ledger.mjs prepare | apply --plan-hash <64hex>");
if (phase === "apply" && !/^[a-f0-9]{64}$/.test(expectedPlanHash || ""))
  throw new Error("apply requires --plan-hash <64hex>");

const procedure = phase === "prepare"
  ? "prepareAiShadowLedgerRepair"
  : "applyAiShadowLedgerRepair";
const json = phase === "prepare"
  ? { ingestKey, tradeDate }
  : { ingestKey, tradeDate, expectedPlanHash };
const response = await fetch(`${baseUrl}/api/trpc/trading.${procedure}?batch=1`, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json" },
  body: JSON.stringify({ 0: { json } }),
});
if (!response.ok) throw new Error(`AI shadow ledger repair ${phase}: HTTP ${response.status}`);
const envelope = await response.json();
const result = envelope?.[0]?.result?.data?.json;
if (!result?.repairId || !result?.planHash)
  throw new Error(`AI shadow ledger repair ${phase}: invalid response`);
console.log(JSON.stringify(result, null, 2));


