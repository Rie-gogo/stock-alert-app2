import { describe, expect, it } from "vitest";
import {
  applyBollingerDirectionalTransition,
  bollingerDirectionalVariantConfig,
  buildBollingerIntradaySmaDirectionPlan,
  buildBollingerDirectionalPlan,
  calculateBollingerBands,
  calculateBollingerDirectionalMovingAverage,
  createEmptyBollingerDirectionalState,
  type BollingerDirectionalCandle,
  type BollingerDirectionalVariant,
} from "./bollingerDirectionalShadow";

function plan(direction: "long" | "short" | "wait" = "long") {
  const regimeState = direction === "long" ? "up" : direction === "short" ? "down" : "mixed";
  return buildBollingerDirectionalPlan({
    tradeDate: "2026-10-07",
    snapshot: {
      sourceSnapshotId: "premarket:2026-10-07:scheduled:test",
      qualityStatus: "verified",
      regimeState,
      confidence: "high",
    },
  });
}

function history(): BollingerDirectionalCandle[] {
  return Array.from({ length: 20 }, (_, index) => ({
    sourceEventId: `history:${index}`,
    candleTime: `09:${String(index).padStart(2, "0")}`,
    open: index % 2 === 0 ? 98 : 102,
    high: index % 2 === 0 ? 99 : 103,
    low: index % 2 === 0 ? 97 : 101,
    close: index % 2 === 0 ? 98 : 102,
    volume: 1_000,
  }));
}

function source(id: string, candleTime: string, candle: { open: number; high: number; low: number; close: number }, side: "long" | "short" = "long") {
  const price = side === "long" ? candle.close + 0.05 : candle.close - 0.05;
  return {
    sourceEventId: id,
    candle: { symbol: "285A", tradeDate: "2026-10-07", candleTime, ...candle, volume: 1_000 },
    board: side === "long"
      ? { asks: [{ price, qty: 100 }], bids: [{ price: price - 0.1, qty: 100 }] }
      : { asks: [{ price: price + 0.1, qty: 100 }], bids: [{ price, qty: 100 }] },
    currentAudit: {
      boardObservedAtMs: 1_000,
      relayAssembledAtMs: 1_100,
      relaySentAtMs: 1_200,
      cloudReceivedAtMs: 2_000,
      decisionCompletedAtMs: 2_500,
    },
  } as any;
}

function seeded(variant: BollingerDirectionalVariant, direction: "long" | "short" = "long") {
  const state = createEmptyBollingerDirectionalState(plan(direction), variant);
  state.candles = history();
  return state;
}

const VARIANT: BollingerDirectionalVariant = "fixed_stop_140_cooldown_30";
const SMA20_VARIANT: BollingerDirectionalVariant = "fixed_stop_140_cooldown_30_sma20_gap060";
const SMA20_DYNAMIC_VARIANT: BollingerDirectionalVariant = "fixed_stop_140_cooldown_30_sma20_dynamic_gap060";
const SMA10_SLOPE_VARIANT: BollingerDirectionalVariant = "fixed_stop_140_cooldown_30_sma10_slope_gap050";

function risingFiveMinuteHistory(): BollingerDirectionalCandle[] {
  return Array.from({ length: 105 }, (_, index) => {
    const minute = 9 * 60 + index;
    const bucket = Math.floor(index / 5);
    const close = 90 + bucket * 0.2;
    return {
      sourceEventId: `five-minute:${index}`,
      candleTime: `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`,
      open: close - 0.05,
      high: close + 0.1,
      low: close - 0.1,
      close,
      volume: 1_000,
    };
  });
}

describe("①〜③方向・1分足ボリンジャー並行shadow", () => {
  it("BBは現在足を含めず、直前の確定20本だけで算出する", () => {
    const candles = history();
    const before = calculateBollingerBands(candles);
    const current = { ...candles[0], sourceEventId: "current", close: 1_000 };
    const after = calculateBollingerBands([...candles, current]);
    expect(before).toMatchObject({ middle: 100, upper: 104, lower: 96, inputCount: 20 });
    expect(after?.middle).not.toBe(before?.middle);
  });

  it("5分足SMAは完了済みbucketだけを使い、SMA10の上向き傾きを因果的に算出する", () => {
    const history = risingFiveMinuteHistory();
    const snapshot = calculateBollingerDirectionalMovingAverage(history, "10:45", 10);
    expect(snapshot).toMatchObject({ timeframeMinutes: 5, period: 10, completedBars: 21 });
    expect(snapshot?.slope).toBeGreaterThan(0);
    expect(bollingerDirectionalVariantConfig(SMA20_VARIANT)).toMatchObject({ movingAveragePeriod: 20, minimumTargetDistancePct: 0.6, requireDirectionalSlope: false });
    expect(bollingerDirectionalVariantConfig(SMA10_SLOPE_VARIANT)).toMatchObject({ movingAveragePeriod: 10, minimumTargetDistancePct: 0.5, requireDirectionalSlope: true });
  });

  it("傾きを使わないSMA20案は20本の完了済み5分足から判定できる", () => {
    const firstTwentyBuckets = risingFiveMinuteHistory().slice(0, 100);
    const withoutSlope = calculateBollingerDirectionalMovingAverage(firstTwentyBuckets, "10:40", 20, false);
    const withSlope = calculateBollingerDirectionalMovingAverage(firstTwentyBuckets, "10:40", 20, true);
    expect(withoutSlope).toMatchObject({ timeframeMinutes: 5, period: 20, completedBars: 20 });
    expect(withSlope).toBeNull();
  });

  it("①〜③不使用のSMA20案は不完全な5分足を除外し、20本揃うまでfail-closedにする", () => {
    const complete = risingFiveMinuteHistory().slice(0, 100);
    const missingOneMinute = complete.filter(candle => candle.sourceEventId !== "five-minute:4");
    expect(calculateBollingerDirectionalMovingAverage(complete, "10:40", 20, false, true))
      .toMatchObject({ period: 20, completedBars: 20 });
    expect(calculateBollingerDirectionalMovingAverage(missingOneMinute, "10:40", 20, false, true)).toBeNull();
  });

  it("①〜③がmixedでも、当日完成5分足SMA20が上なら下側2σ接触をLONG候補にする", () => {
    const intradayPlan = buildBollingerIntradaySmaDirectionPlan("2026-10-07");
    expect(intradayPlan).toMatchObject({ direction: "wait", sourceSnapshotId: null, sourceQuality: "not_applicable", regimeState: "intraday_sma20_dynamic" });
    let state = createEmptyBollingerDirectionalState(intradayPlan, SMA20_DYNAMIC_VARIANT);
    state.candles = risingFiveMinuteHistory().slice(0, 100);
    const bands = calculateBollingerBands(state.candles)!;
    const transition = applyBollingerDirectionalTransition(state, source("dynamic-long-touch", "10:40", {
      open: 93.7,
      high: 94.1,
      low: bands.lower - 0.1,
      close: 94,
    }), "signal_quality");
    expect(transition.resultType).toBe("pending");
    expect(transition.nextState.pending).toMatchObject({ side: "long", movingAverage: { period: 20, completedBars: 20 } });
    expect(transition.actions[0]).toMatchObject({
      type: "signal_pending_next_candle_confirmation",
      side: "long",
      premarketDirectionUsed: false,
    });
  });

  it("①〜③不使用のSMA20案は当日完成5分足SMA20が下なら上側2σ接触をSHORT候補にする", () => {
    const intradayPlan = buildBollingerIntradaySmaDirectionPlan("2026-10-07");
    const state = createEmptyBollingerDirectionalState(intradayPlan, SMA20_DYNAMIC_VARIANT);
    state.candles = risingFiveMinuteHistory().slice(0, 100).map((candle, index) => {
      const bucket = Math.floor(index / 5);
      const close = 110 - bucket * 0.2;
      return { ...candle, open: close + 0.05, high: close + 0.1, low: close - 0.1, close };
    });
    const bands = calculateBollingerBands(state.candles)!;
    const transition = applyBollingerDirectionalTransition(state, source("dynamic-short-touch", "10:40", {
      open: 106.3,
      high: bands.upper + 0.1,
      low: 105.9,
      close: 106,
    }, "short"), "signal_quality");
    expect(transition.resultType).toBe("pending");
    expect(transition.nextState.pending).toMatchObject({ side: "short", movingAverage: { period: 20, completedBars: 20 } });
    expect(transition.actions[0]).toMatchObject({
      type: "signal_pending_next_candle_confirmation",
      side: "short",
      premarketDirectionUsed: false,
    });
  });

  it("SMA10＋傾き案は-2σ接触時に終値がSMA上かつSMA上向きの場合だけ確認待ちにする", () => {
    const state = createEmptyBollingerDirectionalState(plan("long"), SMA10_SLOPE_VARIANT);
    state.candles = risingFiveMinuteHistory();
    const priorBands = calculateBollingerBands(state.candles);
    expect(priorBands).not.toBeNull();
    const accepted = applyBollingerDirectionalTransition(state, source("sma-touch", "10:45", {
      open: 94,
      high: 95.2,
      low: (priorBands?.lower ?? 0) - 0.1,
      close: 95,
    }), "signal_quality");
    expect(accepted.resultType).toBe("pending");
    expect(accepted.nextState.pending?.movingAverage).toMatchObject({ period: 10 });
    expect(accepted.nextState.pending?.movingAverage?.slope).toBeGreaterThan(0);
  });

  it("最低戻し余地を満たさない実行可能価格は、確認足が陽線でもentryしない", () => {
    const state = seeded(SMA20_VARIANT, "long");
    const bands = calculateBollingerBands(state.candles)!;
    state.pending = {
      side: "long",
      touchSourceEventId: "gap-touch",
      touchTime: "10:00",
      touchPrice: bands.lower,
      touchBand: bands.lower,
      bands,
      movingAverage: null,
    };
    const rejected = applyBollingerDirectionalTransition(state, source("gap-confirm", "10:01", {
      open: bands.upper - 0.3,
      high: bands.upper,
      low: bands.upper - 0.4,
      close: bands.upper - 0.1,
    }), "signal_quality");
    expect(rejected.openedPosition).toBeNull();
    expect(rejected.actions[0]).toMatchObject({ type: "entry_rejected", reason: "minimum_fixed_target_distance_not_met", minimumTargetDistancePct: 0.6 });
  });

  it("上昇判断では-2σ接触後の次の陽線で板約定し、入口時に固定した+2σで決済する", () => {
    let state = seeded(VARIANT, "long");
    const touch = applyBollingerDirectionalTransition(state, source("touch", "10:00", { open: 97, high: 98, low: 95, close: 96 }), "signal_quality");
    expect(touch.resultType).toBe("pending");
    expect(touch.actions[0]).toMatchObject({ type: "signal_pending_next_candle_confirmation", side: "long", touchBand: 96 });
    state = touch.nextState;

    const entry = applyBollingerDirectionalTransition(state, source("confirm", "10:01", { open: 96, high: 98, low: 96, close: 97 }), "signal_quality");
    expect(entry.resultType).toBe("entry");
    expect(entry.openedPosition).toMatchObject({ side: "long", slPct: 1.4, shares: 100 });
    expect(entry.openedPosition?.stopPrice).toBeCloseTo((entry.openedPosition?.entryPrice ?? 0) * 0.986);
    const fixedTargetPrice = entry.openedPosition?.initialTargetPrice;
    expect(fixedTargetPrice).toBeGreaterThan(entry.openedPosition?.entryPrice ?? Number.POSITIVE_INFINITY);
    state = entry.nextState;

    const exit = applyBollingerDirectionalTransition(state, source("target", "10:02", { open: 100, high: 110, low: 99, close: 105 }), "signal_quality");
    expect(exit.resultType).toBe("exit");
    expect(exit.closedPosition?.exitReason).toBe("fixed_entry_upper_band");
    expect(exit.closedPosition?.exitPrice).toBeCloseTo(fixedTargetPrice ?? 0);
    expect(exit.closedPosition?.pnl).toBeGreaterThan(0);
  });

  it("接触の次足が方向確認足でなければ拒否し、日次回数は消費しない", () => {
    let state = seeded(VARIANT, "long");
    state = applyBollingerDirectionalTransition(state, source("touch", "10:00", { open: 97, high: 98, low: 95, close: 96 }), "signal_quality").nextState;
    const rejected = applyBollingerDirectionalTransition(state, source("red", "10:01", { open: 97, high: 98, low: 95, close: 96 }), "signal_quality");
    // 拒否足自身も再び-2σへ接触したため、拒否を記録して次足確認を再予約する。
    expect(rejected.resultType).toBe("pending");
    expect(rejected.actions[0]).toMatchObject({ type: "entry_rejected", reason: "next_candle_not_bullish" });
    expect(rejected.actions[1]).toMatchObject({ type: "signal_pending_next_candle_confirmation", side: "long" });
    expect(rejected.nextState.completedTrades).toBe(0);
  });

  it("同じ足でSLと固定目標の両方に触れた場合は1.40%損切りを優先する", () => {
    let state = seeded(VARIANT, "long");
    state = applyBollingerDirectionalTransition(state, source("stop-first:touch", "10:00", { open: 97, high: 98, low: 95, close: 96 }), "signal_quality").nextState;
    state = applyBollingerDirectionalTransition(state, source("stop-first:entry", "10:01", { open: 96, high: 98, low: 96, close: 97 }), "signal_quality").nextState;
    const volatile = source("volatile", "10:02", { open: 97, high: 110, low: 90, close: 100 });
    const stopped = applyBollingerDirectionalTransition(state, volatile, "signal_quality");
    expect(stopped.closedPosition?.exitReason).toBe("fixed_stop_140");
    expect(stopped.nextState.entryBlockedUntilMinute).toBe(10 * 60 + 32);
  });

  it("損切り後30分未満は同一銘柄を再探索せず、30分経過時から再開する", () => {
    let state = seeded(VARIANT, "long");
    state = applyBollingerDirectionalTransition(state, source("cooldown:touch", "10:00", { open: 97, high: 98, low: 95, close: 96 }), "signal_quality").nextState;
    state = applyBollingerDirectionalTransition(state, source("cooldown:entry", "10:01", { open: 96, high: 98, low: 96, close: 97 }), "signal_quality").nextState;
    state = applyBollingerDirectionalTransition(state, source("cooldown:stop", "10:02", { open: 97, high: 98, low: 90, close: 96 }), "signal_quality").nextState;

    const blocked = applyBollingerDirectionalTransition(state, source("cooldown:blocked", "10:31", { open: 97, high: 98, low: 90, close: 96 }), "signal_quality");
    expect(blocked.resultType).toBe("no_signal");
    expect(blocked.nextState.pending).toBeNull();
    expect(blocked.actions[0]).toMatchObject({
      type: "entry_cooldown_active",
      reason: "same_symbol_30_minutes_after_fixed_stop",
      entryBlockedUntilMinute: 10 * 60 + 32,
    });

    const resumed = applyBollingerDirectionalTransition(blocked.nextState, source("cooldown:resumed", "10:32", { open: 97, high: 98, low: 90, close: 96 }), "signal_quality");
    expect(resumed.resultType).toBe("pending");
    expect(resumed.nextState.entryBlockedUntilMinute).toBeNull();
    expect(resumed.actions[0]).toMatchObject({ type: "entry_cooldown_expired", expiredAtMinute: 10 * 60 + 32 });
    expect(resumed.nextState.pending?.side).toBe("long");
  });

  it("1日1回に制限せず、決済の次の足から同日再探索する", () => {
    let state = seeded(VARIANT, "long");
    state = applyBollingerDirectionalTransition(state, source("touch1", "10:00", { open: 97, high: 98, low: 95, close: 96 }), "signal_quality").nextState;
    state = applyBollingerDirectionalTransition(state, source("entry1", "10:01", { open: 96, high: 98, low: 96, close: 97 }), "signal_quality").nextState;
    const exit = applyBollingerDirectionalTransition(state, source("exit1", "10:02", { open: 100, high: 110, low: 99, close: 105 }), "signal_quality");
    expect(exit.nextState.completedTrades).toBe(1);
    const secondTouch = applyBollingerDirectionalTransition(exit.nextState, source("touch2", "10:03", { open: 96, high: 98, low: 90, close: 95 }), "signal_quality");
    expect(secondTouch.resultType).toBe("pending");
  });

  it("下落判断は+2σ接触後の次の陰線でSHORTになる", () => {
    let state = seeded(VARIANT, "short");
    state = applyBollingerDirectionalTransition(state, source("short-touch", "10:00", { open: 103, high: 105, low: 102, close: 104 }, "short"), "signal_quality").nextState;
    const entry = applyBollingerDirectionalTransition(state, source("short-confirm", "10:01", { open: 104, high: 104, low: 102, close: 103 }, "short"), "signal_quality");
    expect(entry.resultType).toBe("entry");
    expect(entry.openedPosition?.side).toBe("short");
    expect(entry.openedPosition?.slPct).toBe(1.4);
    expect(entry.openedPosition?.stopPrice).toBeCloseTo((entry.openedPosition?.entryPrice ?? 0) * 1.014);
  });

  it("mixed・欠損・invalidはfail-closedで売買しない", () => {
    expect(plan("wait").direction).toBe("wait");
    const missing = buildBollingerDirectionalPlan({ tradeDate: "2026-10-07", snapshot: null });
    expect(missing).toMatchObject({ direction: "wait", sourceQuality: "missing" });
    const invalid = buildBollingerDirectionalPlan({ tradeDate: "2026-10-07", snapshot: { sourceSnapshotId: "x", qualityStatus: "invalid", regimeState: "up" } });
    expect(invalid.direction).toBe("wait");
  });
});
