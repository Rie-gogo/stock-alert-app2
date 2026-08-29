import { describe, expect, it } from "vitest";
import type { BoardSnapshot } from "../drizzle/schema";
import {
  TAIYO_CANDIDATE_A_SPEC,
  calculateTaiyoCandidateAMetrics,
  evaluateTaiyoCandidateABoard,
  evaluateTaiyoCandidateAConfirmation,
  isTaiyoCandidateAConfirmationTime,
  isTaiyoCandidateAInitialTriggerTime,
  type TaiyoCandidateAMetrics,
} from "./taiyoCandidateA";

function board(overrides: Partial<BoardSnapshot> = {}): BoardSnapshot {
  return {
    buyPressureRatio: 1,
    largeBuyWall: false,
    largeSellWall: false,
    marketOrderRatio: 0,
    marketOrderDirection: "neutral",
    signal: "neutral",
    ...overrides,
  };
}

function confirmationMetrics(overrides: Partial<TaiyoCandidateAMetrics> = {}): TaiyoCandidateAMetrics {
  return {
    side: "long",
    closeBreaksHigh: true,
    closeBreaksLow: false,
    maSlope2Pct: 0.1,
    volumeRatio: 1,
    directionalOpenMovePct: 1.6,
    bodyPct: 0.275,
    ...overrides,
  };
}

describe("6976候補A 監査仕様", () => {
  it("本番未有効と固定パラメータを明示する", () => {
    expect(TAIYO_CANDIDATE_A_SPEC.productionEnabled).toBe(false);
    expect(TAIYO_CANDIDATE_A_SPEC.primary).toMatchObject({
      startTime: "09:45",
      initialTriggerEndTime: "10:29",
      confirmationEndTime: "10:30",
      lookback: 5,
      maPeriod: 8,
      minVolumeRatio: 1,
      minDirectionalOpenMovePct: 1.6,
      minBodyPct: 0.275,
      confirmationBars: 1,
      slPct: 0.8,
      tpPct: 1.1,
      maxHoldingMinutes: 5,
      maxHoldingExit: "elapsed_boundary_completed_candle_close",
      boardEarlyExit: false,
    });
    expect(TAIYO_CANDIDATE_A_SPEC.board.evaluatedOn).toBe("initial_break_candle");
    expect(TAIYO_CANDIDATE_A_SPEC.board.genericBoardReadingScoreUsedForEntry).toBe(false);
    expect(TAIYO_CANDIDATE_A_SPEC.fallback).toMatchObject({
      startTime: "10:31",
      onlyWhenPrimaryDidNotEnter: true,
    });
    expect(TAIYO_CANDIDATE_A_SPEC.fallback.enabledRoutes).toEqual([
      "taiyo_morning_initial_short",
      "taiyo_afternoon_reversal_short",
    ]);
    expect(TAIYO_CANDIDATE_A_SPEC.fallback.disabledRoutes).toEqual(["taiyo_afternoon_reversal_long"]);
    expect(TAIYO_CANDIDATE_A_SPEC.commonEngineEntryGate).toMatchObject({
      atrPeriod: 7,
      minAtrPct: 0.12,
    });
  });

  it("10:29は初動可、10:30は既存pendingの確認だけ可、10:31は候補A時間窓外と固定する", () => {
    expect(isTaiyoCandidateAInitialTriggerTime("09:45")).toBe(true);
    expect(isTaiyoCandidateAInitialTriggerTime("10:29")).toBe(true);
    expect(isTaiyoCandidateAInitialTriggerTime("10:30")).toBe(false);
    expect(isTaiyoCandidateAConfirmationTime("10:30")).toBe(true);
    expect(isTaiyoCandidateAConfirmationTime("10:31")).toBe(false);
  });

  it("初動は終値5本高値更新・陽線・MA8二本上向き・直前20本比出来高1.0倍でLONGになる", () => {
    const candles = Array.from({ length: 20 }, (_, index) => ({
      time: `09:${String(25 + index).padStart(2, "0")}`,
      open: 100 + index * 0.1,
      high: 100.5 + index * 0.1,
      low: 99.5 + index * 0.1,
      close: 100 + index * 0.1,
      volume: 100,
    }));
    candles.push({ time: "09:45", open: 101, high: 104, low: 100.5, close: 103, volume: 100 });
    const metrics = calculateTaiyoCandidateAMetrics(candles, 100);
    expect(metrics?.side).toBe("long");
    expect(metrics?.closeBreaksHigh).toBe(true);
    expect(metrics?.maSlope2Pct).toBeGreaterThan(0);
    expect(metrics?.volumeRatio).toBe(1);
  });

  it("LONG板はBPR 0.80を許可し0.79を拒否、sell方向・売りsignal・板欠損を拒否する", () => {
    expect(evaluateTaiyoCandidateABoard("long", board({ buyPressureRatio: 0.8 })).allowed).toBe(true);
    expect(evaluateTaiyoCandidateABoard("long", board({ buyPressureRatio: 0.79 }))).toMatchObject({ allowed: false, code: "board_bpr" });
    expect(evaluateTaiyoCandidateABoard("long", board({ marketOrderDirection: "sell" }))).toMatchObject({ allowed: false, code: "board_signal" });
    expect(evaluateTaiyoCandidateABoard("long", board({ signal: "sell_pressure" }))).toMatchObject({ allowed: false, code: "board_signal" });
    expect(evaluateTaiyoCandidateABoard("long", board({ signal: "large_sell_wall" }))).toMatchObject({ allowed: false, code: "board_signal" });
    expect(evaluateTaiyoCandidateABoard("long", null)).toEqual({ allowed: false, code: "board_missing", detail: "boardSnapshot=null" });
  });

  it("SHORT板はBPR 1.20を許可し1.21を拒否、buy方向と買いsignalを拒否する", () => {
    expect(evaluateTaiyoCandidateABoard("short", board({ buyPressureRatio: 1.2 })).allowed).toBe(true);
    expect(evaluateTaiyoCandidateABoard("short", board({ buyPressureRatio: 1.21 }))).toMatchObject({ allowed: false, code: "board_bpr" });
    expect(evaluateTaiyoCandidateABoard("short", board({ marketOrderDirection: "buy" }))).toMatchObject({ allowed: false, code: "board_signal" });
    expect(evaluateTaiyoCandidateABoard("short", board({ signal: "buy_pressure" }))).toMatchObject({ allowed: false, code: "board_signal" });
    expect(evaluateTaiyoCandidateABoard("short", board({ signal: "large_buy_wall" }))).toMatchObject({ allowed: false, code: "board_signal" });
  });

  it("始値方向1.600%と実体0.275%は確認足へ適用し、境界を許可する", () => {
    const pending = { side: "long" as const, triggerClose: 101, triggerTime: "09:45" };
    const candle = { time: "09:46", open: 101.2, high: 102, low: 101, close: 101.8, volume: 100 };
    expect(evaluateTaiyoCandidateAConfirmation({ pending, candle, metrics: confirmationMetrics() })).toEqual({ allowed: true });
    expect(evaluateTaiyoCandidateAConfirmation({
      pending,
      candle,
      metrics: confirmationMetrics({ directionalOpenMovePct: 1.599 }),
    })).toEqual({ allowed: false, codes: ["confirm_open_move"] });
    expect(evaluateTaiyoCandidateAConfirmation({
      pending,
      candle,
      metrics: confirmationMetrics({ bodyPct: 0.274 }),
    })).toEqual({ allowed: false, codes: ["confirm_body"] });
  });

  it("確認失敗理由を複数保持し、状態機械側が同じ足を再検出できる情報を失わない", () => {
    const result = evaluateTaiyoCandidateAConfirmation({
      pending: { side: "long", triggerClose: 102, triggerTime: "09:45" },
      candle: { time: "09:46", open: 101, high: 101.5, low: 100.5, close: 100.8, volume: 100 },
      metrics: confirmationMetrics({ directionalOpenMovePct: 1.2, bodyPct: 0.1 }),
    });
    expect(result).toEqual({
      allowed: false,
      codes: ["confirm_price", "confirm_candle_color", "confirm_open_move", "confirm_body"],
    });
  });
});
