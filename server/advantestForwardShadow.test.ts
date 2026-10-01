import { describe, expect, it } from "vitest";
import type { ForwardSourceEventInput } from "./forwardShadow";
import {
  applyAdvantestForwardTransition,
  createEmptyAdvantestForwardState,
  type AdvantestForwardState,
} from "./advantestForwardShadow";

const TRADE_DATE = "2026-10-02";

function audit() {
  return {
    engineSequence: 1,
    resultType: "no_signal",
    routeId: null,
    marginUsedBefore: 0,
    marginUsedAfter: 0,
    stateHashBefore: "before",
    stateHashAfter: "after",
    causalityStatus: "pass",
    causalityReason: "available_at_decision",
    boardObservedAtMs: 900,
    relayAssembledAtMs: 1_000,
    relaySentAtMs: 1_100,
    cloudReceivedAtMs: 50_000,
    decisionStartedAtMs: 50_050,
    decisionCompletedAtMs: 50_200,
  };
}

function source(
  sourceEventId: string,
  candleTime: string,
  values: { open: number; high: number; low: number; close: number; volume: number },
  board: unknown = null,
): ForwardSourceEventInput {
  return {
    sourceEventId,
    candle: { symbol: "6857", tradeDate: TRADE_DATE, candleTime, ...values },
    board,
    currentAudit: board ? audit() : undefined,
  };
}

function shortReadyState(priorBearBodyPct = 0.14): AdvantestForwardState {
  const state = createEmptyAdvantestForwardState("short_body008_depth");
  state.tradeDate = TRADE_DATE;
  state.candles = Array.from({ length: 21 }, (_, index) => {
    if (index === 0) {
      return { symbol: "6857", tradeDate: TRADE_DATE, candleTime: "09:30", open: 100, high: 100.4, low: 99.8, close: 100.2, volume: 100 };
    }
    const minute = 30 + index;
    const close = index < 11 ? 104 + index * 0.05 : 104.5 - (index - 11) * 0.15;
    const open = index === 20 ? close / (1 - priorBearBodyPct / 100) : close + 0.08;
    return {
      symbol: "6857",
      tradeDate: TRADE_DATE,
      candleTime: `09:${String(minute).padStart(2, "0")}`,
      open,
      high: open + 0.08,
      low: close - 0.08,
      close,
      volume: 100,
    };
  });
  return state;
}

function longReadyState(): AdvantestForwardState {
  const state = createEmptyAdvantestForwardState("confirmed_continuation_depth");
  state.tradeDate = TRADE_DATE;
  state.candles = Array.from({ length: 21 }, (_, index) => {
    if (index === 0) {
      return { symbol: "6857", tradeDate: TRADE_DATE, candleTime: "09:39", open: 100, high: 100.3, low: 99.9, close: 100.2, volume: 100 };
    }
    if (index === 20) {
      return { symbol: "6857", tradeDate: TRADE_DATE, candleTime: "09:59", open: 102.2, high: 102.7, low: 102.15, close: 102.65, volume: 100 };
    }
    const close = 102 + index * 0.01;
    return {
      symbol: "6857",
      tradeDate: TRADE_DATE,
      candleTime: `09:${String(39 + index).padStart(2, "0")}`,
      open: close - 0.03,
      high: close + 0.05,
      low: close - 0.05,
      close,
      volume: 100,
    };
  });
  return state;
}

describe("6857 SHORT A: 前足陰線実体0.08%＋次イベントbid depth", () => {
  it("0.08%以上の現行高値失速条件をpending化し、次イベント100株bidでのみ入る", () => {
    const signal = applyAdvantestForwardTransition(shortReadyState(), source("short-signal", "10:00", {
      open: 103.05, high: 103.1, low: 102.7, close: 102.8, volume: 250,
    }), "signal_quality");
    expect(signal.resultType).toBe("pending");
    expect(signal.nextState.dailySlotConsumed).toBe(false);

    const entry = applyAdvantestForwardTransition(signal.nextState, source("short-entry", "10:01", {
      open: 102.8, high: 102.9, low: 102.65, close: 102.7, volume: 120,
    }, { bids: [{ price: 102.75, qty: 100 }] }), "signal_quality");
    expect(entry.resultType).toBe("entry");
    expect(entry.openedPosition).toMatchObject({
      side: "short",
      entryPrice: 102.75,
      shares: 100,
      slPct: 1,
      tpPct: 3,
      executionProxyKind: "bid_depth_vwap_100",
    });
  });

  it("前足陰線実体が0.08%未満なら候補化しない", () => {
    const signal = applyAdvantestForwardTransition(shortReadyState(0.06), source("short-weak", "10:00", {
      open: 103.05, high: 103.1, low: 102.7, close: 102.8, volume: 250,
    }), "signal_quality");
    expect(signal.resultType).toBe("no_signal");
    expect(signal.nextState.pending).toBeNull();
  });

  it("古い板は拒否し、日次枠を消費せず元初動だけを捨てる", () => {
    const signal = applyAdvantestForwardTransition(shortReadyState(), source("short-stale-signal", "10:00", {
      open: 103.05, high: 103.1, low: 102.7, close: 102.8, volume: 250,
    }), "signal_quality");
    const stale = source("short-stale-entry", "10:01", {
      open: 102.8, high: 102.9, low: 102.65, close: 102.7, volume: 120,
    }, { bids: [{ price: 102.75, qty: 100 }] });
    stale.currentAudit = { ...audit(), relaySentAtMs: 7_000, decisionCompletedAtMs: 50_500 };
    const rejected = applyAdvantestForwardTransition(signal.nextState, stale, "signal_quality");
    expect(rejected.resultType).toBe("rejected");
    expect(rejected.actions[0]).toMatchObject({
      reason: "board_snapshot_stale_over_5000ms",
      dailySlotConsumed: false,
      originalImpulseReusable: false,
    });
    expect(rejected.nextState.pending).toBeNull();
    expect(rejected.nextState.dailySlotConsumed).toBe(false);
  });
});

describe("6857 LONG B: 二段階高値更新＋次イベントask depth", () => {
  it("直前足と確認足の二段階高値更新をpending化し、次イベントaskで入る", () => {
    const signal = applyAdvantestForwardTransition(longReadyState(), source("long-signal", "10:00", {
      open: 102.7, high: 103.1, low: 102.65, close: 103.05, volume: 120,
    }), "signal_quality");
    expect(signal.resultType).toBe("pending");

    const entry = applyAdvantestForwardTransition(signal.nextState, source("long-entry", "10:01", {
      open: 103.05, high: 103.2, low: 102.95, close: 103.15, volume: 110,
    }, { asks: [{ price: 103.1, qty: 100 }] }), "signal_quality");
    expect(entry.resultType).toBe("entry");
    expect(entry.openedPosition).toMatchObject({
      side: "long",
      entryPrice: 103.1,
      shares: 100,
      slPct: 0.5,
      tpPct: 1,
      executionProxyKind: "ask_depth_vwap_100",
    });
  });

  it("SLとTPが同じ足で触れた場合はSLを優先する", () => {
    const signal = applyAdvantestForwardTransition(longReadyState(), source("long-priority-signal", "10:00", {
      open: 102.7, high: 103.1, low: 102.65, close: 103.05, volume: 120,
    }), "signal_quality");
    const entry = applyAdvantestForwardTransition(signal.nextState, source("long-priority-entry", "10:01", {
      open: 103.05, high: 103.2, low: 102.95, close: 103.15, volume: 110,
    }, { asks: [{ price: 103.1, qty: 100 }] }), "signal_quality");
    const exit = applyAdvantestForwardTransition(entry.nextState, source("long-priority-exit", "10:02", {
      open: 103.1, high: 104.2, low: 102.4, close: 103, volume: 130,
    }), "signal_quality");
    expect(exit.closedPosition?.exitReason).toBe("stop_loss");
  });
});
