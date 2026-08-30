import { describe, expect, it } from "vitest";
import {
  SOFTBANK_BREAKOUT_LONG_REASON_PREFIX,
  SOFTBANK_BREAKOUT_LONG_SPEC,
  calculateSoftbankBreakoutLongMetrics,
  evaluateSoftbankBreakoutLongOrderApproval,
  isSoftbankBreakoutLongEntryTime,
  type SoftbankBreakoutLongCandle,
} from "./softbankBreakoutLong";

function buildEligibleCandles(): SoftbankBreakoutLongCandle[] {
  return Array.from({ length: 21 }, (_, index) => {
    const close = index === 20 ? 102 : 100 + index * 0.05;
    return {
      time: `09:${String(20 + index).padStart(2, "0")}`,
      open: index === 20 ? close - 0.5 : close - 0.02,
      high: close + 0.1,
      low: close - 0.1,
      close,
      volume: index === 20 ? 1_300 : 1_000,
    };
  });
}

describe("ソフトバンクG専用10本高値更新LONG仕様", () => {
  it("09:40と10:30を含み、境界外を除外する", () => {
    expect(isSoftbankBreakoutLongEntryTime("09:39")).toBe(false);
    expect(isSoftbankBreakoutLongEntryTime("09:40")).toBe(true);
    expect(isSoftbankBreakoutLongEntryTime("10:30")).toBe(true);
    expect(isSoftbankBreakoutLongEntryTime("10:31")).toBe(false);
  });

  it("10本高値更新・陽線・MA8二本傾き・出来高を同時に確認する", () => {
    const metrics = calculateSoftbankBreakoutLongMetrics(buildEligibleCandles());
    expect(metrics).not.toBeNull();
    expect(metrics?.closeBreaksHigh).toBe(true);
    expect(metrics?.bullishCandle).toBe(true);
    expect(metrics?.maSlope2Pct).toBeGreaterThanOrEqual(SOFTBANK_BREAKOUT_LONG_SPEC.primary.minMaSlopePct);
    expect(metrics?.volumeRatio).toBeGreaterThanOrEqual(SOFTBANK_BREAKOUT_LONG_SPEC.primary.minVolumeRatio);
    expect(metrics?.eligible).toBe(true);
  });

  it("出来高が1.2倍未満なら発火しない", () => {
    const candles = buildEligibleCandles();
    candles[candles.length - 1].volume = 1_199;
    expect(calculateSoftbankBreakoutLongMetrics(candles)?.eligible).toBe(false);
  });

  it("LIVE新規注文を拒否し、DRY_RUNと決済を許可する", () => {
    const reason = `${SOFTBANK_BREAKOUT_LONG_REASON_PREFIX}: test`;
    expect(evaluateSoftbankBreakoutLongOrderApproval({ reason, instructionType: "entry", isDryRun: true })).toEqual({ allowed: true });
    expect(evaluateSoftbankBreakoutLongOrderApproval({ reason, instructionType: "entry", isDryRun: false })).toEqual({
      allowed: false,
      code: "softbank_breakout_long_live_not_approved",
    });
    expect(evaluateSoftbankBreakoutLongOrderApproval({ reason, instructionType: "exit", isDryRun: false })).toEqual({ allowed: true });
  });
});
