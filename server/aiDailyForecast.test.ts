import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  AI_DAILY_FORECAST_SYMBOLS,
  buildQuantBaseline,
  validateAiDailyForecastOutput,
  type AiDailyForecastInput,
} from "./aiDailyForecastService";
import { applyAiDailyForecastSelectionTransitionForTest, applyAiDailyForecastTransitionForTest, type AiDailyForecastPlan } from "./aiDailyForecastShadowEngine";
import type { ForwardSourceEventInput } from "./forwardShadow";

const bars = Array.from({ length: 6 }, (_, index) => ({
  tradeDate: `2026-10-0${index + 1}`, open: 100 + index, high: 103 + index, low: 99 + index, close: 102 + index,
  volume: 1_000, barCount: 300, distinctMinuteCount: 300, firstTime: "09:00", lastTime: "15:29", duplicateMinuteCount: 0, maxGapMinutes: 0, usable: true, qualityReasons: [],
}));
const baseline = buildQuantBaseline("8035", bars);
const forecast = (symbol: string) => ({ symbol, direction: "up", forecastLow: 98, forecastHigh: 108, zoneType: "pullback", zoneLow: 99, zoneHigh: 102, confirmPrice: 102, firstTarget: 105, stretchTarget: 108, baselineDecision: "maintained", aiAdjustment: { reason: "quant baseline retained", exceptionReason: null }, rationale: "D-1 deterministic baseline retained", evidenceUsed: ["D-1 daily bars"], macroAgreement: "aligned", confidenceBasis: ["five usable daily sessions"] });
const input: AiDailyForecastInput = { tradeDate: "2026-10-09", dataCutoffDate: "2026-10-08", capturedAtMs: 1, macroSnapshot: null, macroSnapshotId: null, inputQuality: "verified", qualityReasonCodes: [], symbols: AI_DAILY_FORECAST_SYMBOLS.map(symbol => ({ symbol, dailyBars: bars, baseline: buildQuantBaseline(symbol, bars) })) };
const source = (id: string, candleTime: string, open: number, high: number, low: number, close: number, board = { asks: [{ price: 103, qty: 10_000 }], bids: [{ price: 101, qty: 10_000 }] }): ForwardSourceEventInput => ({ sourceEventId: id, candle: { symbol: "8035", tradeDate: "2026-10-09", candleTime, open, high, low, close, volume: 1000 }, board, currentAudit: { engineSequence: 1, resultType: "no_trade", routeId: null, marginUsedBefore: 0, marginUsedAfter: 0, stateHashBefore: "a", stateHashAfter: "a", causalityStatus: "verified", causalityReason: "test", boardObservedAtMs: 1_000, relayAssembledAtMs: 1_100, relaySentAtMs: 1_110, cloudReceivedAtMs: 2_000, decisionStartedAtMs: 2_001, decisionCompletedAtMs: 2_002 } });
const plan: AiDailyForecastPlan = { sourceSnapshotId: "ai:test", qualityStatus: "verified", symbol: "8035", direction: "up", forecastLow: 98, forecastHigh: 108, zoneLow: 99, zoneHigh: 102, confirmPrice: 102, firstTarget: 105, stretchTarget: 108, atr5: 2, stopPrice: 98, entryBlockedByRevision: false, checkpoint: "08:30", entryWindowStart: "09:00", entryWindowEnd: "15:19", forceExitTime: "15:20", openPositionAction: "keep" };

describe("AI daily forecast deterministic contract", () => {
  it("keeps the app as an external-Codex ingest consumer and never invokes an in-server LLM", () => {
    const source = readFileSync(new URL("./aiDailyForecastService.ts", import.meta.url), "utf8");
    expect(source).not.toContain("invokeLLM");
    expect(source).not.toContain("generateAiDailyForecast");
    expect(source).toContain("ingestAiDailyForecastSubmission");
  });
  it("uses exactly D-1 daily inputs and produces an ordered quant baseline", () => {
    expect(baseline.usableDates).toEqual(bars.map(bar => bar.tradeDate));
    expect(baseline.direction).not.toBe("insufficient");
    expect(baseline.forecastLow).toBeLessThan(baseline.zoneLow!);
    expect(baseline.zoneHigh).toBeLessThan(baseline.forecastHigh!);
    expect(baseline.originalUnroundedPrices.forecastLow).not.toBeNull();
  });
  it("rejects duplicate or missing symbols and invalid directional price ordering", () => {
    const output = { forecasts: AI_DAILY_FORECAST_SYMBOLS.map(forecast), marketSummary: "test", globalReasonCodes: ["test"] };
    expect(validateAiDailyForecastOutput(output, input).valid).toBe(true);
    output.forecasts[1] = forecast("8035");
    const result = validateAiDailyForecastOutput(output, input);
    expect(result.valid).toBe(false);
    expect(result.reasonCodes.some(reason => reason.startsWith("duplicate_symbol"))).toBe(true);
  });
  it("requires a separate confirmation event and causal fresh directional depth before entry", () => {
    const initial = { tradeDate: "2026-10-09", activePlanId: plan.sourceSnapshotId, plan, touched: null, position: null, dailySlotConsumed: false, lastSourceEventId: null, lastActions: [] };
    const touched = applyAiDailyForecastTransitionForTest(initial, source("touch", "09:30", 101, 102, 99.5, 100), plan, "signal_quality");
    expect(touched.resultType).toBe("pending");
    const entered = applyAiDailyForecastTransitionForTest(touched.next, source("confirm", "09:31", 102, 103, 101, 102.5), plan, "signal_quality");
    expect(entered.resultType).toBe("entry");
    const stale = source("stale", "09:31", 102, 103, 101, 102.5); stale.currentAudit!.relayAssembledAtMs = 6_001;
    const rejected = applyAiDailyForecastTransitionForTest(touched.next, stale, plan, "signal_quality");
    expect(rejected.resultType).toBe("rejected");
    expect(rejected.actions[0]).toMatchObject({ reason: "board_stale" });
  });
  it("applies stop-first and never changes the frozen target after entry", () => {
    const initial = { tradeDate: "2026-10-09", activePlanId: plan.sourceSnapshotId, plan, touched: { sourceEventId: "touch", time: "09:30", side: "long" as const }, position: null, dailySlotConsumed: false, lastSourceEventId: "touch", lastActions: [] };
    const entered = applyAiDailyForecastTransitionForTest(initial, source("confirm", "09:31", 102, 103, 101, 102.5), plan, "signal_quality");
    const exited = applyAiDailyForecastTransitionForTest(entered.next, source("both", "09:32", 102.5, 106, 97, 102), plan, "signal_quality");
    expect(exited.resultType).toBe("exit");
    expect(exited.closed?.reason).toBe("stop_loss");
    expect(entered.opened?.targetPrice).toBe(105);
  });
  it("blocks only unentered signals after a market-context invalidation revision", () => {
    const blockedPlan = { ...plan, entryBlockedByRevision: true };
    const initial = { tradeDate: "2026-10-09", activePlanId: blockedPlan.sourceSnapshotId, plan: blockedPlan, touched: null, position: null, dailySlotConsumed: false, lastSourceEventId: null, lastActions: [] };
    const result = applyAiDailyForecastTransitionForTest(initial, source("after-revision", "10:00", 101, 103, 99, 102.5), blockedPlan, "signal_quality");
    expect(result.resultType).toBe("no_signal");
    expect(result.actions[0]).toMatchObject({ reason: "market_context_revision_invalidated_unentered_signals" });
  });
  it("resets an unentered touch when a newer checkpoint replaces the plan", () => {
    const initial = { tradeDate: "2026-10-09", activePlanId: plan.sourceSnapshotId, plan, touched: { sourceEventId: "old-touch", time: "09:29", side: "long" as const }, position: null, dailySlotConsumed: false, lastSourceEventId: "old-touch", lastActions: [] };
    const revised = { ...plan, sourceSnapshotId: "ai:1000", checkpoint: "10:00", entryWindowStart: "10:00", entryWindowEnd: "10:29" };
    const result = applyAiDailyForecastSelectionTransitionForTest(initial, source("new-plan", "10:00", 104, 104.5, 103.5, 104), { activePlanId: revised.sourceSnapshotId, plan: revised, disabledReason: null, openPositionAction: "keep" }, "signal_quality");
    expect(result.next.touched).toBeNull();
    expect(result.actions[0]).toMatchObject({ reason: "zone_not_touched" });
  });
  it("can close an open position on the next event only when the AI explicitly changes direction", () => {
    const position = { side: "long" as const, entrySourceEventId: "entry", signalTime: "09:30", entryTime: "09:31", entryPrice: 102, targetPrice: 108, stopPrice: 98, initialRiskPerShare: 4, shares: 100, sourceBoardAgeMs: 100, deliveryBoardAgeMs: 10, planSnapshotId: plan.sourceSnapshotId, forceExitTime: "15:20" };
    const state = { tradeDate: "2026-10-09", activePlanId: plan.sourceSnapshotId, plan, touched: null, position, dailySlotConsumed: false, lastSourceEventId: "entry", lastActions: [] };
    const shortPlan = { ...plan, sourceSnapshotId: "ai:1000-short", direction: "down", firstTarget: 99, stretchTarget: 98, stopPrice: 108, openPositionAction: "exit_next_event_if_direction_changed" as const };
    const result = applyAiDailyForecastSelectionTransitionForTest(state, source("revision", "10:01", 103, 104, 102, 103), { activePlanId: shortPlan.sourceSnapshotId, plan: shortPlan, disabledReason: null, openPositionAction: "exit_next_event_if_direction_changed" }, "signal_quality");
    expect(result.resultType).toBe("exit");
    expect(result.closed?.reason).toBe("ai_direction_revision_exit");
  });
});
