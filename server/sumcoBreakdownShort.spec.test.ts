import { describe, expect, it } from "vitest";
import {
  SUMCO_BREAKDOWN_SHORT_REASON_PREFIX,
  calculateSumcoBreakdownShortMetrics,
  evaluateSumcoBreakdownShortOrderApproval,
  isSumcoBreakdownShortEntryTime,
  type SumcoBreakdownShortCandle,
} from "./sumcoBreakdownShort";

function buildEligibleCandles(): SumcoBreakdownShortCandle[] {
  return Array.from({ length: 21 }, (_, index) => {
    const close = index === 20 ? 99 : 101 - index * 0.08;
    return {
      time: `09:${String(10 + index).padStart(2, "0")}`,
      open: close + (index === 20 ? 0.2 : 0.04),
      high: close + 0.12,
      low: close - 0.08,
      close,
      volume: index === 20 ? 1200 : 1000,
    };
  });
}

describe("SUMCO専用15本安値更新SHORT仕様", () => {
  it("09:30と11:00を含み、境界外を除外する", () => {
    expect(isSumcoBreakdownShortEntryTime("09:29")).toBe(false);
    expect(isSumcoBreakdownShortEntryTime("09:30")).toBe(true);
    expect(isSumcoBreakdownShortEntryTime("11:00")).toBe(true);
    expect(isSumcoBreakdownShortEntryTime("11:01")).toBe(false);
  });

  it("15本安値更新・陰線・MA8二本傾き・出来高を同時に確認する", () => {
    const metrics = calculateSumcoBreakdownShortMetrics(buildEligibleCandles());
    expect(metrics).not.toBeNull();
    expect(metrics?.closeBreaksLow).toBe(true);
    expect(metrics?.bearishCandle).toBe(true);
    expect(metrics?.maSlope2Pct).toBeLessThanOrEqual(-0.05);
    expect(metrics?.volumeRatio).toBeGreaterThanOrEqual(1.0);
    expect(metrics?.eligible).toBe(true);
  });

  it("LIVE新規注文を拒否し、DRY_RUNと決済を許可する", () => {
    const reason = `${SUMCO_BREAKDOWN_SHORT_REASON_PREFIX}: test`;
    expect(evaluateSumcoBreakdownShortOrderApproval({ reason, instructionType: "entry", isDryRun: true })).toEqual({ allowed: true });
    expect(evaluateSumcoBreakdownShortOrderApproval({ reason, instructionType: "entry", isDryRun: false })).toEqual({
      allowed: false,
      code: "sumco_breakdown_short_live_not_approved",
    });
    expect(evaluateSumcoBreakdownShortOrderApproval({ reason, instructionType: "exit", isDryRun: false })).toEqual({ allowed: true });
  });
});
