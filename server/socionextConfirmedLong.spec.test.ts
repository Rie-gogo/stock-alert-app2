import { describe, expect, it } from "vitest";
import {
  SOCIONEXT_CONFIRMED_LONG_REASON_PREFIX,
  SOCIONEXT_CONFIRMED_LONG_SPEC,
  calculateSocionextConfirmedLongMetrics,
  evaluateSocionextConfirmedLongConfirmation,
  evaluateSocionextConfirmedLongOrderApproval,
  getSocionextConfirmedLongDayOpen,
  isSocionextConfirmedLongConfirmationTime,
  isSocionextConfirmedLongInitialTriggerTime,
  type SocionextConfirmedLongCandle,
} from "./socionextConfirmedLong";

function buildCandles(): SocionextConfirmedLongCandle[] {
  const candles: SocionextConfirmedLongCandle[] = [
    { time: "08:59", open: 110, high: 111, low: 109, close: 110, volume: 50 },
  ];
  for (let index = 0; index < 20; index += 1) {
    const close = 100 + index * 0.1;
    candles.push({
      time: `09:${String(index).padStart(2, "0")}`,
      open: close - 0.05,
      high: close + 0.05,
      low: close - 0.1,
      close,
      volume: 100,
    });
  }
  candles.push({
    time: "09:30",
    open: 102,
    high: 104.1,
    low: 101.9,
    close: 104,
    volume: 180,
  });
  return candles;
}

describe("6526確認型ブレイクLONG仕様", () => {
  it("初動と確認の時間境界を固定する", () => {
    expect(isSocionextConfirmedLongInitialTriggerTime("09:29")).toBe(false);
    expect(isSocionextConfirmedLongInitialTriggerTime("09:30")).toBe(true);
    expect(isSocionextConfirmedLongInitialTriggerTime("10:59")).toBe(true);
    expect(isSocionextConfirmedLongInitialTriggerTime("11:00")).toBe(false);

    expect(isSocionextConfirmedLongConfirmationTime("09:30")).toBe(false);
    expect(isSocionextConfirmedLongConfirmationTime("09:31")).toBe(true);
    expect(isSocionextConfirmedLongConfirmationTime("11:00")).toBe(true);
    expect(isSocionextConfirmedLongConfirmationTime("11:01")).toBe(false);
  });

  it("08:59準備足を除外し09:00以降最初の足を当日始値にする", () => {
    expect(getSocionextConfirmedLongDayOpen(buildCandles())).toBe(99.95);
  });

  it("陽線・当日始値以上・10本高値更新・MA8傾き・出来高を満たす初動を検出する", () => {
    const candles = buildCandles();
    const metrics = calculateSocionextConfirmedLongMetrics(candles, 100);
    expect(metrics).not.toBeNull();
    expect(metrics).toMatchObject({
      closeBreaksHigh: true,
      bullishCandle: true,
      atOrAboveDayOpen: true,
      eligible: true,
    });
    expect(metrics!.maSlope2Pct).toBeGreaterThanOrEqual(SOCIONEXT_CONFIRMED_LONG_SPEC.primary.minMaSlopePct);
    expect(metrics!.volumeRatio).toBeGreaterThanOrEqual(SOCIONEXT_CONFIRMED_LONG_SPEC.primary.minVolumeRatio);
  });

  it("次足終値が初動終値を上回る場合だけ確認成功とする", () => {
    const pending = {
      triggerClose: 104,
      triggerTime: "09:30",
      triggerMaSlope2Pct: 0.1,
      triggerVolumeRatio: 1.8,
      triggerOpenMovePct: 4,
    };
    expect(evaluateSocionextConfirmedLongConfirmation({
      pending,
      candle: { time: "09:31", open: 103.8, high: 104.3, low: 103.7, close: 104.1, volume: 120 },
    })).toEqual({ allowed: true });
    expect(evaluateSocionextConfirmedLongConfirmation({
      pending,
      candle: { time: "09:31", open: 104.1, high: 104.2, low: 103.8, close: 104, volume: 120 },
    })).toEqual({ allowed: false, codes: ["confirm_price"] });
  });

  it("DRY_RUN entryと決済は許可し、LIVE新規entryだけを拒否する", () => {
    const reason = `${SOCIONEXT_CONFIRMED_LONG_REASON_PREFIX}: 10本高値更新後1本確認`;
    expect(evaluateSocionextConfirmedLongOrderApproval({ reason, instructionType: "entry", isDryRun: true })).toEqual({ allowed: true });
    expect(evaluateSocionextConfirmedLongOrderApproval({ reason, instructionType: "entry", isDryRun: false })).toEqual({
      allowed: false,
      code: "socionext_confirmed_long_live_not_approved",
    });
    expect(evaluateSocionextConfirmedLongOrderApproval({ reason, instructionType: "exit", isDryRun: false })).toEqual({ allowed: true });
  });
});
