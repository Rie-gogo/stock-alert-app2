import { describe, expect, it } from "vitest";
import {
  TAIYO_CANDIDATE_B_SPEC,
  calculateTaiyoCandidateBMetrics,
  evaluateTaiyoCandidateBConfirmation,
  getTaiyoCandidateBDayOpen,
  isTaiyoCandidateBConfirmationTime,
  isTaiyoCandidateBInitialTriggerTime,
  type TaiyoCandidateBCandle,
} from "./taiyoCandidateB";

function flatCandles(): TaiyoCandidateBCandle[] {
  return Array.from({ length: 20 }, (_, index) => ({
    time: `09:${String(25 + index).padStart(2, "0")}`,
    open: 100,
    high: 100.2,
    low: 99.8,
    close: 100,
    volume: 100,
  }));
}

describe("6976候補B30分 数値仕様", () => {
  it("10:59までを初動、11:00までを確認に限定する", () => {
    expect(isTaiyoCandidateBInitialTriggerTime("09:44")).toBe(false);
    expect(isTaiyoCandidateBInitialTriggerTime("09:45")).toBe(true);
    expect(isTaiyoCandidateBInitialTriggerTime("10:59")).toBe(true);
    expect(isTaiyoCandidateBInitialTriggerTime("11:00")).toBe(false);
    expect(isTaiyoCandidateBConfirmationTime("11:00")).toBe(true);
    expect(isTaiyoCandidateBConfirmationTime("11:01")).toBe(false);
  });

  it("当日始値は08:59足を使わず、09:00以降の最初の足を使う", () => {
    expect(getTaiyoCandidateBDayOpen([
      { time: "08:59", open: 90, high: 91, low: 89, close: 90, volume: 1 },
      { time: "09:00", open: 100, high: 101, low: 99, close: 100, volume: 1 },
    ])).toBe(100);
  });

  it("LONGは10本終値高値更新・陽線・始値上・MA8上向き・出来高1.0倍以上をすべて要求する", () => {
    const candles = flatCandles();
    candles.push({ time: "09:45", open: 100.1, high: 101.2, low: 100, close: 101, volume: 100 });
    const metrics = calculateTaiyoCandidateBMetrics(candles, 100);
    expect(metrics?.side).toBe("long");
    expect(metrics?.closeBreaksHigh).toBe(true);
    expect(metrics?.volumeRatio).toBe(1);
    expect(metrics!.maSlope2Pct).toBeGreaterThanOrEqual(TAIYO_CANDIDATE_B_SPEC.primary.minAbsMaSlopePct);

    candles[candles.length - 1] = { time: "09:45", open: 100.1, high: 101.2, low: 100, close: 101, volume: 99 };
    expect(calculateTaiyoCandidateBMetrics(candles, 100)?.side).toBeNull();
  });

  it("次足確認は直前終値の方向更新と同方向の足色を要求する", () => {
    const pending = {
      side: "long" as const,
      triggerClose: 101,
      triggerTime: "10:00",
      triggerMaSlope2Pct: 0.1,
      triggerVolumeRatio: 1.2,
      triggerOpenMovePct: 1,
    };
    expect(evaluateTaiyoCandidateBConfirmation({
      pending,
      candle: { time: "10:01", open: 101, high: 102, low: 100.9, close: 101.5, volume: 100 },
    })).toEqual({ allowed: true });
    expect(evaluateTaiyoCandidateBConfirmation({
      pending,
      candle: { time: "10:01", open: 101.5, high: 101.6, low: 100.8, close: 101, volume: 100 },
    })).toEqual({ allowed: false, codes: ["confirm_price", "confirm_candle_color"] });
  });

  it("拒否では枠を消費せず、実エントリー成功時だけ1日枠を消費する仕様を固定する", () => {
    expect(TAIYO_CANDIDATE_B_SPEC.primary.engineRejectionTransition)
      .toBe("next_candle_continue_search_without_consuming_daily_slot");
    expect(TAIYO_CANDIDATE_B_SPEC.primary.dailySlotConsumedOn).toBe("successful_entry_only");
    expect(TAIYO_CANDIDATE_B_SPEC.primary.confirmationFailureTransition)
      .toBe("same_candle_fall_through_and_redetect");
    expect(TAIYO_CANDIDATE_B_SPEC.primary.maxHoldingMinutes).toBe(30);
    expect(TAIYO_CANDIDATE_B_SPEC.primary.tpPct).toBe(0.6);
    expect(TAIYO_CANDIDATE_B_SPEC.primary.slPct).toBe(1.0);
    expect(TAIYO_CANDIDATE_B_SPEC.liveOrderApproved).toBe(false);
  });
});
