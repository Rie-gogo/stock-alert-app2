import { describe, expect, it } from "vitest";
import {
  applyBollingerDirectionalTransition,
  buildBollingerDirectionalPlan,
  calculateBollingerBands,
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

describe("①〜③方向・1分足ボリンジャー並行shadow", () => {
  it("BBは現在足を含めず、直前の確定20本だけで算出する", () => {
    const candles = history();
    const before = calculateBollingerBands(candles);
    const current = { ...candles[0], sourceEventId: "current", close: 1_000 };
    const after = calculateBollingerBands([...candles, current]);
    expect(before).toMatchObject({ middle: 100, upper: 104, lower: 96, inputCount: 20 });
    expect(after?.middle).not.toBe(before?.middle);
  });

  it("上昇判断では-2σ接触後の次の陽線で板約定し、動的+2σで決済する", () => {
    let state = seeded("no_stop", "long");
    const touch = applyBollingerDirectionalTransition(state, source("touch", "10:00", { open: 97, high: 98, low: 95, close: 96 }), "signal_quality");
    expect(touch.resultType).toBe("pending");
    expect(touch.actions[0]).toMatchObject({ type: "signal_pending_next_candle_confirmation", side: "long", touchBand: 96 });
    state = touch.nextState;

    const entry = applyBollingerDirectionalTransition(state, source("confirm", "10:01", { open: 96, high: 98, low: 96, close: 97 }), "signal_quality");
    expect(entry.resultType).toBe("entry");
    expect(entry.openedPosition).toMatchObject({ side: "long", slPct: 0, shares: 100, stopPrice: null });
    state = entry.nextState;

    const exit = applyBollingerDirectionalTransition(state, source("target", "10:02", { open: 100, high: 110, low: 99, close: 105 }), "signal_quality");
    expect(exit.resultType).toBe("exit");
    expect(exit.closedPosition?.exitReason).toBe("dynamic_upper_band");
    expect(exit.closedPosition?.pnl).toBeGreaterThan(0);
  });

  it("接触の次足が方向確認足でなければ拒否し、日次回数は消費しない", () => {
    let state = seeded("no_stop", "long");
    state = applyBollingerDirectionalTransition(state, source("touch", "10:00", { open: 97, high: 98, low: 95, close: 96 }), "signal_quality").nextState;
    const rejected = applyBollingerDirectionalTransition(state, source("red", "10:01", { open: 97, high: 98, low: 95, close: 96 }), "signal_quality");
    // 拒否足自身も再び-2σへ接触したため、拒否を記録して次足確認を再予約する。
    expect(rejected.resultType).toBe("pending");
    expect(rejected.actions[0]).toMatchObject({ type: "entry_rejected", reason: "next_candle_not_bullish" });
    expect(rejected.actions[1]).toMatchObject({ type: "signal_pending_next_candle_confirmation", side: "long" });
    expect(rejected.nextState.completedTrades).toBe(0);
  });

  it("同じ入口・同じ足で、0.60%案だけがstop-first、SLなし案は+2σ決済になる", () => {
    const enter = (variant: BollingerDirectionalVariant) => {
      let state = seeded(variant, "long");
      state = applyBollingerDirectionalTransition(state, source(`${variant}:touch`, "10:00", { open: 97, high: 98, low: 95, close: 96 }), "signal_quality").nextState;
      return applyBollingerDirectionalTransition(state, source(`${variant}:entry`, "10:01", { open: 96, high: 98, low: 96, close: 97 }), "signal_quality").nextState;
    };
    const volatile = source("volatile", "10:02", { open: 97, high: 110, low: 90, close: 100 });
    const stopped = applyBollingerDirectionalTransition(enter("stop_060"), volatile, "signal_quality");
    const noStop = applyBollingerDirectionalTransition(enter("no_stop"), volatile, "signal_quality");
    expect(stopped.closedPosition?.exitReason).toBe("fixed_stop_060");
    expect(noStop.closedPosition?.exitReason).toBe("dynamic_upper_band");
  });

  it("1日1回に制限せず、決済の次の足から同日再探索する", () => {
    let state = seeded("no_stop", "long");
    state = applyBollingerDirectionalTransition(state, source("touch1", "10:00", { open: 97, high: 98, low: 95, close: 96 }), "signal_quality").nextState;
    state = applyBollingerDirectionalTransition(state, source("entry1", "10:01", { open: 96, high: 98, low: 96, close: 97 }), "signal_quality").nextState;
    const exit = applyBollingerDirectionalTransition(state, source("exit1", "10:02", { open: 100, high: 110, low: 99, close: 105 }), "signal_quality");
    expect(exit.nextState.completedTrades).toBe(1);
    const secondTouch = applyBollingerDirectionalTransition(exit.nextState, source("touch2", "10:03", { open: 96, high: 98, low: 90, close: 95 }), "signal_quality");
    expect(secondTouch.resultType).toBe("pending");
  });

  it("下落判断は+2σ接触後の次の陰線でSHORTになる", () => {
    let state = seeded("stop_060", "short");
    state = applyBollingerDirectionalTransition(state, source("short-touch", "10:00", { open: 103, high: 105, low: 102, close: 104 }, "short"), "signal_quality").nextState;
    const entry = applyBollingerDirectionalTransition(state, source("short-confirm", "10:01", { open: 104, high: 104, low: 102, close: 103 }, "short"), "signal_quality");
    expect(entry.resultType).toBe("entry");
    expect(entry.openedPosition?.side).toBe("short");
    expect(entry.openedPosition?.slPct).toBe(0.6);
  });

  it("mixed・欠損・invalidはfail-closedで売買しない", () => {
    expect(plan("wait").direction).toBe("wait");
    const missing = buildBollingerDirectionalPlan({ tradeDate: "2026-10-07", snapshot: null });
    expect(missing).toMatchObject({ direction: "wait", sourceQuality: "missing" });
    const invalid = buildBollingerDirectionalPlan({ tradeDate: "2026-10-07", snapshot: { sourceSnapshotId: "x", qualityStatus: "invalid", regimeState: "up" } });
    expect(invalid.direction).toBe("wait");
  });
});
