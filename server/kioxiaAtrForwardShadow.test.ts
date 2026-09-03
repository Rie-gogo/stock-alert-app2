import { describe, expect, it } from "vitest";
import {
  KIOXIA_ATR_FORWARD_SHADOW_SPEC,
  applyKioxiaAtrForwardTransition,
  applyKioxiaAtrRouteGuardForTest,
  calculateKioxiaAtrForwardExitForTest,
  emptyKioxiaAtrForwardState,
  type KioxiaAtrForwardPosition,
} from "./kioxiaAtrForwardShadow";

function minuteAt(index: number): string {
  const total = 9 * 60 + index;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function board(currentPrice: number, bpr = 1) {
  return {
    currentPrice,
    asks: [{ price: currentPrice + 1, qty: 1_000 }],
    bids: [{ price: currentPrice - 1, qty: Math.round(1_000 * bpr) }],
    overSellQty: 0,
    underBuyQty: 0,
    marketOrderBuyQty: 0,
    marketOrderSellQty: 0,
    marketOrderDirection: "neutral",
  };
}

function confirmedHistory(lowAtr = false) {
  return Array.from({ length: 29 }, (_, index) => {
    const close = 999 + index * 0.02;
    return {
      time: minuteAt(31 + index),
      open: index === 0 ? 995 : close - 0.05,
      high: lowAtr ? close + 0.1 : close + 0.8,
      low: lowAtr ? close - 0.1 : close - 3.0,
      close,
      volume: 100,
    };
  });
}

function confirmedInput(sourceEventId: string, highAtr = true) {
  return {
    sourceEventId,
    candle: {
      symbol: "285A",
      tradeDate: "2026-09-07",
      candleTime: "10:00",
      open: 999,
      high: 1_003,
      low: highAtr ? 998 : 999.8,
      close: 1_002,
      volume: 200,
    },
    board: board(1_002.25),
  };
}

function position(side: "long" | "short"): KioxiaAtrForwardPosition {
  return {
    route: side === "long" ? "reversal_long" : "trend_short",
    side,
    entrySourceEventId: `entry:${side}`,
    signalTime: "10:00",
    entryTime: "10:00",
    theoreticalSignalPrice: 1_000,
    entryPrice: 1_000,
    shares: 100,
    slPct: side === "long" ? 0.6 : 0.8,
    tpPct: side === "long" ? 1.2 : 1.6,
  };
}

describe("285A第2シャドー ATR0.36%経路別日次終了", () => {
  it("0.36%未満だけ該当経路を終了し、境界0.36%と他4経路は継続する", () => {
    const state = emptyKioxiaAtrForwardState();
    const low = applyKioxiaAtrRouteGuardForTest(state, "confirmed_morning_long", 0.3599);
    expect(low.ended).toBe(true);
    expect(state.routeEnded.confirmed_morning_long).toBe(true);
    expect(state.routeEnded.reversal_long).toBe(false);
    expect(state.routeEnded.reversal_short).toBe(false);
    expect(state.routeEnded.trend_short).toBe(false);
    expect(state.routeEnded.safe_cb_short).toBe(false);
    expect(applyKioxiaAtrRouteGuardForTest(state, "reversal_long", 0.36).ended).toBe(false);
  });

  it("低ATRの確認型LONG候補ではその経路だけ当日終了し、板現在値で約定しない", () => {
    const state = emptyKioxiaAtrForwardState();
    state.tradeDate = "2026-09-07";
    state.candles = confirmedHistory(true);
    const result = applyKioxiaAtrForwardTransition(state, confirmedInput("low-atr", false), "signal_quality");
    expect(result.resultType).toBe("rejected");
    expect(result.openedPosition).toBeNull();
    expect(result.nextState.routeEnded.confirmed_morning_long).toBe(true);
    expect(result.nextState.routeEnded.reversal_long).toBe(false);
    expect(result.actions).toContainEqual(expect.objectContaining({
      type: "route_ended",
      route: "confirmed_morning_long",
      reason: "atr_below_036",
      thresholdPct: 0.36,
    }));
  });

  it("ATR0.36%以上では現行確認型LONGを100株・受信時点板現在値で約定する", () => {
    const state = emptyKioxiaAtrForwardState();
    state.tradeDate = "2026-09-07";
    state.candles = confirmedHistory(false);
    const result = applyKioxiaAtrForwardTransition(state, confirmedInput("entry"), "signal_quality");
    expect(result.resultType).toBe("entry");
    expect(result.openedPosition).toMatchObject({
      route: "confirmed_morning_long",
      side: "long",
      entryPrice: 1_002.25,
      theoreticalSignalPrice: 1_002,
      shares: 100,
      slPct: 0.8,
      tpPct: 1.6,
    });
    expect(result.nextState.routeFired.confirmed_morning_long).toBe(true);
  });

  it("板現在値が無ければ候補経路を消費せず、後続イベントで再探索できる", () => {
    const state = emptyKioxiaAtrForwardState();
    state.tradeDate = "2026-09-07";
    state.candles = confirmedHistory(false);
    const result = applyKioxiaAtrForwardTransition(state, { ...confirmedInput("no-board"), board: null }, "signal_quality");
    expect(result.resultType).toBe("rejected");
    expect(result.nextState.position).toBeNull();
    expect(result.nextState.routeFired.confirmed_morning_long).toBe(false);
    expect(result.nextState.routeEnded.confirmed_morning_long).toBe(false);
    expect(result.actions).toContainEqual(expect.objectContaining({ reason: "executable_price_unavailable" }));
  });

  it("現行BPR0.70ガードは反転SHORTだけを終了し、第2候補の他経路状態を変更しない", () => {
    const state = emptyKioxiaAtrForwardState();
    state.tradeDate = "2026-09-07";
    state.dayOpen = 1_000;
    state.dayHigh = 1_040;
    state.routeFired.confirmed_morning_long = true;
    state.routeFired.reversal_long = true;
    state.candles = Array.from({ length: 30 }, (_, index) => {
      const close = 1_030 - index * 0.35;
      return { time: minuteAt(30 + index), open: close + 0.2, high: close + 1, low: close - 1, close, volume: 100 };
    });
    const result = applyKioxiaAtrForwardTransition(state, {
      sourceEventId: "bpr-guard",
      candle: {
        symbol: "285A", tradeDate: "2026-09-07", candleTime: "10:00",
        open: 1_020, high: 1_021, low: 1_017, close: 1_018, volume: 100,
      },
      board: board(1_018, 0.6),
    }, "signal_quality");
    expect(result.nextState.routeEnded.reversal_short).toBe(true);
    expect(result.nextState.routeEnded.safe_cb_short).toBe(false);
    expect(result.actions).toContainEqual(expect.objectContaining({ route: "reversal_short", reason: "current_bpr_guard" }));
  });

  it("現行SL/TPは全経路でTPがSLの2倍以上、同一足ではSLを優先し窓開けは不利な始値を使う", () => {
    for (const route of Object.values(KIOXIA_ATR_FORWARD_SHADOW_SPEC.routes)) {
      expect(route.tpPct).toBeGreaterThanOrEqual(route.slPct * 2);
    }
    expect(calculateKioxiaAtrForwardExitForTest(position("long"), {
      symbol: "285A", tradeDate: "2026-09-07", candleTime: "10:01",
      open: 990, high: 1_020, low: 989, close: 1_010, volume: 100,
    }, board(1_010))).toEqual({ price: 990, reason: "stop_loss" });
    expect(calculateKioxiaAtrForwardExitForTest(position("short"), {
      symbol: "285A", tradeDate: "2026-09-07", candleTime: "10:01",
      open: 1_012, high: 1_020, low: 980, close: 990, volume: 100,
    }, board(990))).toEqual({ price: 1_012, reason: "stop_loss" });
  });

  it("前場ポジションは11:27〜11:29欠損時も12:30の最初の受信で決済する", () => {
    expect(calculateKioxiaAtrForwardExitForTest(position("long"), {
      symbol: "285A", tradeDate: "2026-09-07", candleTime: "12:30",
      open: 1_001, high: 1_002, low: 1_000, close: 1_001, volume: 100,
    }, board(1_001))).toEqual({ price: 1_001, reason: "session_exit" });
  });
});
