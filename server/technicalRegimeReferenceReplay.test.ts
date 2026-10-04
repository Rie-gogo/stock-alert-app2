import { describe, expect, it } from "vitest";
import {
  replayFrozenReferenceTechnicalPlan,
  type FrozenReferenceTechnicalPlan,
  type ReferenceTechnicalCandle,
} from "./technicalRegimeReferenceReplay";

function candle(symbol: string, time: string, values: Partial<ReferenceTechnicalCandle>): ReferenceTechnicalCandle {
  return {
    symbol, tradeDate: "2026-10-02", candleTime: time,
    open: 100, high: 101, low: 99, close: 100, volume: 100,
    ...values,
  };
}

function warm(symbol: string, base: number, volume: number) {
  return Array.from({ length: 10 }, (_, index) => candle(symbol, `09:${String(index).padStart(2, "0")}`, {
    open: base - 5, high: base + 5, low: base - 10, close: base, volume,
  }));
}

describe("reference-only technical replay", () => {
  it("reproduces the documented 285A recovery plan without joining formal OOS", () => {
    const plan: FrozenReferenceTechnicalPlan = {
      version: "technical-reference-replay-v1", symbol: "285A", sourceTradeDate: "2026-10-01", targetTradeDate: "2026-10-02",
      side: "long", signalWindow: { start: "09:15", end: "11:20" },
      triggerPrice: 19_120, stopPrice: 19_080, targetPrice: 19_245, minVolumeRatio: 1.2,
      requireBullishCandle: true, requireBearishCandle: false, requireVwapConfirmation: true,
      rationale: ["D-1 up trend", "recover prior close", "target below D-1 high"],
    };
    const candles = [
      ...warm("285A", 18_900, 112_560),
      candle("285A", "10:56", { open: 19_100, high: 19_140, low: 19_095, close: 19_135, volume: 243_000 }),
      candle("285A", "10:57", { open: 19_135, high: 19_135, low: 19_105, close: 19_110, volume: 104_900 }),
      candle("285A", "11:09", { open: 19_205, high: 19_245, low: 19_200, close: 19_235, volume: 229_600 }),
    ];
    expect(replayFrozenReferenceTechnicalPlan(plan, candles)).toMatchObject({
      status: "closed", signalTime: "10:56", entryTime: "10:57", entryPrice: 19_135,
      exitTime: "11:09", exitPrice: 19_245, exitReason: "technical_target", pnlPer100: 11_000,
    });
  });

  it("uses the corrected saved 6146 next-bar open and frozen technical target", () => {
    const plan: FrozenReferenceTechnicalPlan = {
      version: "technical-reference-replay-v1", symbol: "6146", sourceTradeDate: "2026-10-01", targetTradeDate: "2026-10-02",
      side: "long", signalWindow: { start: "09:15", end: "11:20" },
      triggerPrice: 60_550, stopPrice: 60_540, targetPrice: 61_050, minVolumeRatio: 1.2,
      requireBullishCandle: true, requireBearishCandle: false, requireVwapConfirmation: true,
      rationale: ["D-1 high breakout", "D-1 hourly up trend", "frozen technical resistance target"],
    };
    const candles = [
      ...warm("6146", 60_200, 9_150),
      candle("6146", "09:23", { open: 60_540, high: 60_840, low: 60_540, close: 60_730, volume: 15_500 }),
      candle("6146", "09:24", { open: 60_730, high: 61_100, low: 60_700, close: 61_040, volume: 15_900 }),
    ];
    expect(replayFrozenReferenceTechnicalPlan(plan, candles)).toMatchObject({
      status: "closed", signalTime: "09:23", entryTime: "09:24", entryPrice: 60_730,
      exitTime: "09:24", exitPrice: 61_050, exitReason: "technical_target", pnlPer100: 32_000,
    });
  });

  it("does not manufacture a trade when the frozen D-1 trigger is not crossed", () => {
    const plan: FrozenReferenceTechnicalPlan = {
      version: "technical-reference-replay-v1", symbol: "285A", sourceTradeDate: "2026-10-01", targetTradeDate: "2026-10-02",
      side: "long", signalWindow: { start: "09:15", end: "11:20" },
      triggerPrice: 19_120, stopPrice: 19_080, targetPrice: 19_245, minVolumeRatio: 1.2,
      requireBullishCandle: true, requireBearishCandle: false, requireVwapConfirmation: true, rationale: [],
    };
    const candles = [...warm("285A", 18_900, 100), candle("285A", "10:56", { open: 19_000, high: 19_110, low: 18_990, close: 19_110, volume: 300 })];
    expect(replayFrozenReferenceTechnicalPlan(plan, candles).status).toBe("no_signal");
  });

  it("rejects a signal when the frozen target is no longer beyond the next-bar entry", () => {
    const plan: FrozenReferenceTechnicalPlan = {
      version: "technical-reference-replay-v1", symbol: "285A", sourceTradeDate: "2026-10-01", targetTradeDate: "2026-10-02",
      side: "long", signalWindow: { start: "09:15", end: "11:20" },
      triggerPrice: 100, stopPrice: 99, targetPrice: 101, minVolumeRatio: 1.2,
      requireBullishCandle: true, requireBearishCandle: false, requireVwapConfirmation: true, rationale: [],
    };
    const candles = [
      ...warm("285A", 99, 100),
      candle("285A", "10:00", { open: 100, high: 102, low: 100, close: 101.5, volume: 200 }),
      candle("285A", "10:01", { open: 102, high: 103, low: 101, close: 102, volume: 100 }),
    ];
    expect(replayFrozenReferenceTechnicalPlan(plan, candles)).toMatchObject({
      status: "signal_rejected_invalid_levels", entryPrice: 102, pnlPer100: null,
    });
  });

  it("rejects a technically valid price ladder when next-bar execution leaves less than 1.2R", () => {
    const plan: FrozenReferenceTechnicalPlan = {
      version: "technical-reference-replay-v1", symbol: "5803", sourceTradeDate: "2026-10-01", targetTradeDate: "2026-10-02",
      side: "long", signalWindow: { start: "09:15", end: "11:20" },
      triggerPrice: 100, stopPrice: 99, targetPrice: 102, minVolumeRatio: 1.2,
      requireBullishCandle: true, requireBearishCandle: false, requireVwapConfirmation: true, rationale: [],
    };
    const candles = [
      ...warm("5803", 99, 100),
      candle("5803", "10:00", { open: 100, high: 102, low: 100, close: 101.5, volume: 200 }),
      candle("5803", "10:01", { open: 101.8, high: 102, low: 101, close: 101.9, volume: 100 }),
    ];
    expect(replayFrozenReferenceTechnicalPlan(plan, candles)).toMatchObject({
      status: "signal_rejected_reward_risk", entryPrice: 101.8, pnlPer100: null,
    });
  });

  it("waits for a causal pullback reclaim before using the following bar open", () => {
    const plan: FrozenReferenceTechnicalPlan = {
      version: "technical-reference-replay-v1", symbol: "5803", sourceTradeDate: "2026-10-01", targetTradeDate: "2026-10-02",
      side: "long", signalWindow: { start: "09:15", end: "11:20" },
      triggerPrice: 100, stopPrice: 99, targetPrice: 105, minimumRewardRisk: 0, minVolumeRatio: 1.1,
      requireBullishCandle: true, requireBearishCandle: false, requireVwapConfirmation: true,
      entryConfirmation: "pullback_reclaim", maxConfirmationBars: 20, rationale: [],
    };
    const candles = [
      ...warm("5803", 99, 100),
      candle("5803", "09:15", { open: 100, high: 102, low: 100, close: 101.5, volume: 200 }),
      candle("5803", "09:16", { open: 101.5, high: 102, low: 101, close: 101.2, volume: 100 }),
      candle("5803", "09:17", { open: 100.4, high: 101.5, low: 100.2, close: 101.4, volume: 120 }),
      candle("5803", "09:18", { open: 101.4, high: 105, low: 101, close: 104, volume: 100 }),
    ];
    expect(replayFrozenReferenceTechnicalPlan(plan, candles)).toMatchObject({
      status: "closed", signalTime: "09:15", confirmationTime: "09:17",
      entryTime: "09:18", entryPrice: 101.4, exitPrice: 105,
    });
  });

  it("requires a causal local pivot and structure break for micro trend turn", () => {
    const plan: FrozenReferenceTechnicalPlan = {
      version: "technical-reference-replay-v1", symbol: "3436", sourceTradeDate: "2026-10-01", targetTradeDate: "2026-10-02",
      side: "short", signalWindow: { start: "09:15", end: "11:20" },
      triggerPrice: 100, stopPrice: 102, targetPrice: 95, minimumRewardRisk: 0, minVolumeRatio: 1.1,
      requireBullishCandle: false, requireBearishCandle: true, requireVwapConfirmation: true,
      entryConfirmation: "micro_trend_turn", maxConfirmationBars: 20, rationale: [],
    };
    const candles = [
      ...warm("3436", 101, 100),
      candle("3436", "09:15", { open: 100, high: 100, low: 98, close: 99, volume: 200 }),
      candle("3436", "09:16", { open: 99, high: 101, low: 98.5, close: 100.5, volume: 100 }),
      candle("3436", "09:17", { open: 100.5, high: 101.5, low: 99, close: 100, volume: 100 }),
      candle("3436", "09:18", { open: 100, high: 100.8, low: 98.8, close: 99.5, volume: 100 }),
      candle("3436", "09:19", { open: 99.5, high: 99.7, low: 97, close: 97.5, volume: 100 }),
      candle("3436", "09:20", { open: 97.5, high: 98, low: 95, close: 95.5, volume: 100 }),
    ];
    expect(replayFrozenReferenceTechnicalPlan(plan, candles)).toMatchObject({
      status: "closed", signalTime: "09:15", confirmationTime: "09:19",
      entryTime: "09:20", entryPrice: 97.5, exitPrice: 95,
    });
  });
});
