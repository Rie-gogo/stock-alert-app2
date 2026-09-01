import { describe, expect, it } from "vitest";
import {
  TEL_OPEN_DIRECTION_BREAKOUT_REASON_PREFIX,
  TEL_OPEN_DIRECTION_BREAKOUT_SPEC,
  calculateTelOpenDirectionBreakoutMetrics,
  evaluateTelOpenDirectionBreakoutOrderApproval,
  isTelOpenDirectionBreakoutEntryTime,
  type TelOpenDirectionBreakoutCandle,
} from "./telOpenDirectionBreakout";

function flatPrefix(): TelOpenDirectionBreakoutCandle[] {
  return Array.from({ length: 20 }, (_, index) => ({
    time: `09:${String(40 + index).padStart(2, "0")}`,
    open: 100,
    high: 100.1,
    low: 99.9,
    close: 100,
    volume: 100,
  }));
}

describe("8035始値方向付き短期ブレイク仕様", () => {
  it("時間境界10:00〜10:30を両端含みで固定する", () => {
    expect(isTelOpenDirectionBreakoutEntryTime("09:59")).toBe(false);
    expect(isTelOpenDirectionBreakoutEntryTime("10:00")).toBe(true);
    expect(isTelOpenDirectionBreakoutEntryTime("10:30")).toBe(true);
    expect(isTelOpenDirectionBreakoutEntryTime("10:31")).toBe(false);
  });

  it("LONGは5本高値更新・陽線・MA8上向き・出来高1.0倍・始値比+0.25%以上で成立する", () => {
    const metrics = calculateTelOpenDirectionBreakoutMetrics([
      ...flatPrefix(),
      { time: "10:00", open: 100.2, high: 100.31, low: 100.19, close: 100.3, volume: 100 },
    ]);
    expect(metrics).not.toBeNull();
    expect(metrics?.openGainPct).toBeCloseTo(0.3, 10);
    expect(metrics?.volumeRatio).toBeCloseTo(1, 10);
    expect(metrics?.longEligible).toBe(true);
    expect(metrics?.shortEligible).toBe(false);
  });

  it("SHORTは5本安値更新・陰線・MA8下向き・出来高1.0倍・始値比-0.25%以下で成立する", () => {
    const metrics = calculateTelOpenDirectionBreakoutMetrics([
      ...flatPrefix(),
      { time: "10:00", open: 99.8, high: 99.81, low: 99.69, close: 99.7, volume: 100 },
    ]);
    expect(metrics).not.toBeNull();
    expect(metrics?.openGainPct).toBeCloseTo(-0.3, 10);
    expect(metrics?.shortEligible).toBe(true);
    expect(metrics?.longEligible).toBe(false);
  });

  it("始値方向が0.25%未満なら価格更新条件を満たしても拒否する", () => {
    const metrics = calculateTelOpenDirectionBreakoutMetrics([
      ...flatPrefix(),
      { time: "10:00", open: 100.1, high: 100.21, low: 100.09, close: 100.2, volume: 100 },
    ]);
    expect(metrics?.closeBreaksHigh).toBe(true);
    expect(metrics?.longEligible).toBe(false);
  });

  it("設定TP/SL比2倍・20分・高値反転停止を固定する", () => {
    expect(TEL_OPEN_DIRECTION_BREAKOUT_SPEC.primary).toMatchObject({
      slPct: 0.6,
      tpPct: 1.2,
      maxHoldingMinutes: 20,
      minOpenDirectionPct: 0.25,
    });
    expect(TEL_OPEN_DIRECTION_BREAKOUT_SPEC.fallback).toMatchObject({
      trendLongSlPct: 0.7,
      trendLongTpPct: 1.4,
      trendShortSlPct: 0.6,
      trendShortTpPct: 1.8,
      peakReversalShortEnabled: false,
    });
  });

  it("DRY_RUN entryと決済を許可し、8035のLIVE新規entryだけを拒否する", () => {
    const reason = `${TEL_OPEN_DIRECTION_BREAKOUT_REASON_PREFIX}LONG: テスト`;
    expect(evaluateTelOpenDirectionBreakoutOrderApproval({ symbol: "8035", reason, instructionType: "entry", isDryRun: true }))
      .toEqual({ allowed: true });
    expect(evaluateTelOpenDirectionBreakoutOrderApproval({ symbol: "8035", reason, instructionType: "entry", isDryRun: false }))
      .toEqual({ allowed: false, code: "tel_open_direction_breakout_live_not_approved" });
    expect(evaluateTelOpenDirectionBreakoutOrderApproval({ symbol: "8035", reason, instructionType: "exit", isDryRun: false }))
      .toEqual({ allowed: true });
    expect(evaluateTelOpenDirectionBreakoutOrderApproval({ symbol: "285A", reason, instructionType: "entry", isDryRun: false }))
      .toEqual({ allowed: true });
  });
});
