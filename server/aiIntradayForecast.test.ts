import { describe, expect, it } from "vitest";
import { AI_DAILY_FORECAST_SYMBOLS, buildQuantBaseline, type AiDailyForecastInput } from "./aiDailyForecastService";
import { _aiIntradayForecastTest, validateAiIntradayForecastOutput, type AiIntradayForecastInput } from "./aiIntradayForecastService";

const bars = Array.from({ length: 6 }, (_, index) => ({ tradeDate: `2026-10-0${index + 1}`, open: 100 + index, high: 103 + index, low: 99 + index, close: 102 + index, volume: 1_000, barCount: 300, distinctMinuteCount: 300, firstTime: "09:00", lastTime: "15:29", duplicateMinuteCount: 0, maxGapMinutes: 0, usable: true, qualityReasons: [] }));
const priorData: AiDailyForecastInput = { tradeDate: "2026-10-09", dataCutoffDate: "2026-10-08", capturedAtMs: 1, macroSnapshot: null, macroSnapshotId: null, inputQuality: "verified", qualityReasonCodes: [], symbols: AI_DAILY_FORECAST_SYMBOLS.map(symbol => ({ symbol, dailyBars: bars, baseline: buildQuantBaseline(symbol, bars) })) };
const forecast = (symbol: string) => ({ symbol, direction: "up", forecastLow: 98, forecastHigh: 108, zoneType: "pullback", zoneLow: 99, zoneHigh: 102, confirmPrice: 102, firstTarget: 105, stretchTarget: 108, baselineDecision: "maintained", aiAdjustment: { reason: "causal checkpoint evidence retained", exceptionReason: null }, rationale: "Only checkpoint data and prior behavior were used", evidenceUsed: ["checkpoint candles"], macroAgreement: "aligned", confidenceBasis: ["completed candles"] });
const intradayInput = { tradeDate: "2026-10-09", checkpoint: "10:00", cutoffCandleTime: "09:59", effectiveFrom: "10:00", validUntil: "10:29", capturedAtMs: 1, morningSourceSnapshotId: "morning", morningInputHash: "hash", morningForecast: {}, previousIntradayForecast: null, priorData, currentSession: { symbols: [], nikkei225Mini: {} }, learning: [], inputQuality: "verified", qualityReasonCodes: [] } as unknown as AiIntradayForecastInput;
const control = (symbol: string) => ({ symbol, planDecision: "maintained", changeReason: "No causal contradiction at checkpoint", entryWindowStart: "10:00", entryWindowEnd: "10:29", forceExitTime: "15:20", openPositionAction: "keep", learningEvidenceUsed: ["prior closed shadow performance"] });

describe("AI intraday forecast causal contract", () => {
  it("uses only minutes completed before each checkpoint and excludes the lunch break", () => {
    const expected = _aiIntradayForecastTest.expectedSessionMinutes("12:34");
    expect(expected[0]).toBe("09:00");
    expect(expected.at(-1)).toBe("12:34");
    expect(expected).not.toContain("11:30");
    expect(expected).not.toContain("12:29");
  });
  it("retains only complete causal five-minute buckets", () => {
    const candles = ["09:00", "09:01", "09:02", "09:03", "09:04", "09:05", "09:06", "09:08", "09:09"].map((candleTime, index) => ({ candleTime, open: 100 + index, high: 101 + index, low: 99 + index, close: 100.5 + index, volume: 1_000 }));
    const completed = _aiIntradayForecastTest.completedFiveMinuteBars(candles);
    expect(completed).toHaveLength(1);
    expect(completed[0]?.candleTime).toBe("09:04");
  });
  it("accepts exactly ten bounded plans and rejects a window outside the checkpoint", () => {
    const output = { forecast: { forecasts: AI_DAILY_FORECAST_SYMBOLS.map(forecast), marketSummary: "checkpoint", globalReasonCodes: ["causal_checkpoint_only"] }, controls: AI_DAILY_FORECAST_SYMBOLS.map(control), checkpointSummary: "No look-ahead data used" };
    expect(validateAiIntradayForecastOutput(output, intradayInput).valid).toBe(true);
    output.controls[0]!.entryWindowStart = "09:59";
    const result = validateAiIntradayForecastOutput(output, intradayInput);
    expect(result.valid).toBe(false);
    expect(result.reasonCodes).toContain("entry_window_outside_checkpoint:285A");
  });
  it("feeds closed losses and their exit reasons into later AI inputs without changing parameters automatically", () => {
    const performance = _aiIntradayForecastTest.summarizeLearning([
      { id: 1, symbol: "8035", entryTradeDate: "2026-10-08", entryCandleTime: "10:01", exitCandleTime: "10:12", side: "long", pnl: -12_000, realizedR: "-1", exitReason: "stop_loss" },
      { id: 2, symbol: "8035", entryTradeDate: "2026-10-09", entryCandleTime: "09:45", exitCandleTime: "10:05", side: "short", pnl: 8_000, realizedR: "0.7", exitReason: "first_target" },
    ] as never[], "8035");
    expect(performance.all).toMatchObject({ closedTrades: 2, wins: 1, losses: 1, totalPnl: -4_000 });
    expect(performance.recentLosses[0]).toMatchObject({ tradeDate: "2026-10-08", exitReason: "stop_loss", pnl: -12_000 });
  });
});
