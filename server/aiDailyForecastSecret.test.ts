import { describe, expect, it } from "vitest";

describe("AI daily forecast ingest secret", () => {
  it("accepts the configured sender key through the lightweight auth endpoint without generating a forecast", async () => {
    const ingestKey = process.env.AI_DAILY_FORECAST_INGEST_KEY;
    expect(ingestKey).toBeTruthy();
    expect(ingestKey!.length).toBeGreaterThanOrEqual(32);
    const input = encodeURIComponent(JSON.stringify({ 0: { json: { ingestKey } } }));
    const response = await fetch(`http://127.0.0.1:3000/api/trpc/trading.validateAiDailyForecastIngestAuth?batch=1&input=${input}`);
    expect(response.status).toBe(200);
    const payload = await response.json() as Array<{ result?: { data?: { json?: { accepted?: boolean; capability?: string } } } }>;
    expect(payload[0]?.result?.data?.json).toEqual({ accepted: true, capability: "ai_daily_forecast_sender_only" });
  });
});
