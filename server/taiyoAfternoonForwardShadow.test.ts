import { describe, expect, it } from "vitest";
import type { ForwardSourceEventInput } from "./forwardShadow";
import {
  applyTaiyoAfternoonDepthTransition,
  applyTaiyoAfternoonRr2Transition,
  calculateTaiyoAfternoonDepthVwap,
  calculateTaiyoAfternoonShortMetrics,
  createEmptyTaiyoAfternoonState,
  normalizeTaiyoAfternoonState,
  type TaiyoAfternoonInitialPending,
  type TaiyoAfternoonPosition,
} from "./taiyoAfternoonForwardShadow";

function sourceEvent(options: {
  id: string;
  time: string;
  tradeDate?: string;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  volume?: number;
  board?: unknown;
  audit?: Partial<NonNullable<ForwardSourceEventInput["currentAudit"]>>;
}): ForwardSourceEventInput {
  const close = options.close ?? 99;
  return {
    sourceEventId: options.id,
    candle: {
      symbol: "6976",
      tradeDate: options.tradeDate ?? "2026-09-07",
      candleTime: options.time,
      open: options.open ?? close + 0.2,
      high: options.high ?? close + 0.3,
      low: options.low ?? close - 0.3,
      close,
      volume: options.volume ?? 100,
    },
    board: options.board ?? null,
    currentAudit: {
      engineSequence: 1,
      resultType: "none",
      routeId: null,
      marginUsedBefore: 0,
      marginUsedAfter: 0,
      stateHashBefore: "before",
      stateHashAfter: "after",
      causalityStatus: "causal",
      causalityReason: "test",
      boardObservedAtMs: 1_000,
      relayAssembledAtMs: 1_100,
      relaySentAtMs: 1_200,
      cloudReceivedAtMs: 5_000,
      decisionStartedAtMs: 5_100,
      decisionCompletedAtMs: 5_150,
      ...options.audit,
    },
  };
}

function initialPending(): TaiyoAfternoonInitialPending {
  return {
    triggerSourceEventId: "trigger-1",
    triggerTime: "13:00",
    triggerClose: 100,
    recentLow: 100.2,
    morningMovePct: 3.5,
    reversalPctFromHigh: 1.4,
    maSlope2Pct: -0.05,
    volumeRatio: 1.3,
  };
}

function shortPosition(): TaiyoAfternoonPosition {
  return {
    side: "short",
    signalSourceEventId: "trigger-1",
    entrySourceEventId: "entry-1",
    entryTradeDate: "2026-09-07",
    signalTime: "13:00",
    entryTime: "13:02",
    theoreticalSignalPrice: 99,
    entryPrice: 99,
    shares: 100,
    slPct: 0.8,
    tpPct: 1.6,
    executionProxyKind: "bid_depth_vwap_100",
    entryBoardAgeMs: 300,
    entryAdverseMovePct: 0.05,
  };
}

function validBidBoard() {
  return {
    bids: [
      { price: 98.96, qty: 60 },
      { price: 98.94, qty: 40 },
    ],
    asks: [{ price: 98.98, qty: 100 }],
  };
}

function validAskBoard() {
  return {
    bids: [{ price: 98.9, qty: 100 }],
    asks: [
      { price: 99.02, qty: 60 },
      { price: 99.04, qty: 40 },
    ],
  };
}

describe("taiyoAfternoonForwardShadow", () => {
  it("uses the first saved candle at or after 09:00 as day open", () => {
    let state = createEmptyTaiyoAfternoonState("rr2_exit");
    state = applyTaiyoAfternoonRr2Transition(state, sourceEvent({ id: "pre", time: "08:59", open: 95, close: 95 }), "signal_quality").nextState;
    state = applyTaiyoAfternoonRr2Transition(state, sourceEvent({ id: "open", time: "09:00", open: 100, close: 100 }), "signal_quality").nextState;
    expect(state.dayOpen).toBe(100);
  });

  it("detects the current afternoon short trigger from causal candle history", () => {
    const candles = [] as Array<{ time: string; open: number; high: number; low: number; close: number; volume: number }>;
    for (let index = 0; index < 20; index += 1) {
      candles.push({ time: `11:${String(20 + index).padStart(2, "0")}`, open: 104, high: 104.2, low: 103.8, close: 104, volume: 100 });
    }
    for (let index = 0; index < 9; index += 1) {
      const close = 103 - index * 0.25;
      candles.push({ time: `12:${String(50 + index).padStart(2, "0")}`, open: close + 0.1, high: close + 0.2, low: close - 0.1, close, volume: 100 });
    }
    candles.push({ time: "13:00", open: 100.9, high: 101, low: 100.1, close: 100.2, volume: 150 });
    const metrics = calculateTaiyoAfternoonShortMetrics(candles, 100, 105);
    expect(metrics?.eligible).toBe(true);
    expect(metrics?.morningMovePct).toBeGreaterThanOrEqual(3);
    expect(metrics?.reversalPctFromHigh).toBeGreaterThanOrEqual(1);
    expect(metrics?.volumeRatio).toBeGreaterThanOrEqual(1.2);
  });

  it("opens RR2 at the completed confirmation close and gives stop priority with adverse gap", () => {
    const state = createEmptyTaiyoAfternoonState("rr2_exit");
    state.tradeDate = "2026-09-07";
    state.initialPending = initialPending();
    const entry = applyTaiyoAfternoonRr2Transition(state, sourceEvent({ id: "confirm", time: "13:01", open: 99.8, close: 99 }), "signal_quality");
    expect(entry.resultType).toBe("entry");
    expect(entry.openedPosition).toMatchObject({ entryPrice: 99, slPct: 0.8, tpPct: 1.6, shares: 100 });

    const bothTouched = applyTaiyoAfternoonRr2Transition(entry.nextState, sourceEvent({
      id: "both",
      time: "13:02",
      open: 100.2,
      high: 101,
      low: 96,
      close: 98,
    }), "signal_quality");
    expect(bothTouched.closedPosition).toMatchObject({ exitReason: "stop_loss", exitPrice: 100.2 });
  });

  it("does not reuse the same candle after confirmation failure", () => {
    const state = createEmptyTaiyoAfternoonState("rr2_exit");
    state.tradeDate = "2026-09-07";
    state.initialPending = initialPending();
    const rejected = applyTaiyoAfternoonRr2Transition(state, sourceEvent({
      id: "failed-confirm",
      time: "13:01",
      open: 98,
      close: 99,
    }), "signal_quality");
    expect(rejected.resultType).toBe("rejected");
    expect(rejected.nextState.initialPending).toBeNull();
    expect(rejected.nextState.dailySlotConsumed).toBe(false);
    expect(rejected.actions[0]).toMatchObject({ sameCandleRedetectionAllowed: false, nextSourceEventSearchAllowed: true });
  });

  it("calculates bid and ask 100-share depth VWAP in executable price order", () => {
    expect(calculateTaiyoAfternoonDepthVwap(validBidBoard(), "bid")?.price).toBeCloseTo(98.952, 6);
    expect(calculateTaiyoAfternoonDepthVwap(validAskBoard(), "ask")?.price).toBeCloseTo(99.028, 6);
    expect(calculateTaiyoAfternoonDepthVwap({ bids: [{ price: 99, qty: 99 }] }, "bid")).toBeNull();
  });

  it("opens depth variant on the next event when continuation, original low, freshness, and 0.10% cap hold", () => {
    const state = createEmptyTaiyoAfternoonState("depth_execution");
    state.tradeDate = "2026-09-07";
    state.initialPending = initialPending();
    const confirmed = applyTaiyoAfternoonDepthTransition(state, sourceEvent({ id: "confirm", time: "13:01", open: 99.8, close: 99 }), "signal_quality");
    expect(confirmed.resultType).toBe("pending");
    expect(confirmed.nextState.executionPending).not.toBeNull();

    const entered = applyTaiyoAfternoonDepthTransition(confirmed.nextState, sourceEvent({
      id: "depth-entry",
      time: "13:02",
      close: 98.95,
      board: validBidBoard(),
    }), "signal_quality");
    expect(entered.resultType).toBe("entry");
    expect(entered.openedPosition?.entryPrice).toBeCloseTo(98.952, 6);
    expect(entered.openedPosition).toMatchObject({ executionProxyKind: "bid_depth_vwap_100", entryBoardAgeMs: 250 });
  });

  it("rejects depth entry beyond the 0.10% adverse cap without consuming the day", () => {
    const state = createEmptyTaiyoAfternoonState("depth_execution");
    state.tradeDate = "2026-09-07";
    state.executionPending = {
      signalSourceEventId: "trigger-1",
      triggerSourceEventId: "trigger-1",
      confirmationSourceEventId: "confirm",
      triggerTime: "13:00",
      confirmationTime: "13:01",
      confirmationClose: 100,
      originalRecentLow: 101,
    };
    const rejected = applyTaiyoAfternoonDepthTransition(state, sourceEvent({
      id: "too-low",
      time: "13:02",
      close: 99.8,
      board: { bids: [{ price: 99.89, qty: 100 }], asks: [{ price: 99.9, qty: 100 }] },
    }), "signal_quality");
    expect(rejected.resultType).toBe("rejected");
    expect(rejected.actions[0]).toMatchObject({ reason: "adverse_entry_move_over_010pct", dailySlotConsumed: false });
    expect(rejected.nextState.executionPending).toBeNull();
  });

  it("rejects stale or undersized bid depth without consuming the daily slot", () => {
    const pending = {
      signalSourceEventId: "trigger-1",
      triggerSourceEventId: "trigger-1",
      confirmationSourceEventId: "confirm",
      triggerTime: "13:00",
      confirmationTime: "13:01",
      confirmationClose: 99,
      originalRecentLow: 100,
    };
    const staleState = createEmptyTaiyoAfternoonState("depth_execution");
    staleState.tradeDate = "2026-09-07";
    staleState.executionPending = pending;
    const stale = applyTaiyoAfternoonDepthTransition(staleState, sourceEvent({
      id: "stale",
      time: "13:02",
      close: 98.95,
      board: validBidBoard(),
      audit: { boardObservedAtMs: 1_000, relayAssembledAtMs: 1_100, relaySentAtMs: 7_000 },
    }), "signal_quality");
    expect(stale.actions[0]).toMatchObject({ reason: "board_snapshot_stale_over_5000ms", dailySlotConsumed: false });

    const shallowState = createEmptyTaiyoAfternoonState("depth_execution");
    shallowState.tradeDate = "2026-09-07";
    shallowState.executionPending = pending;
    const shallow = applyTaiyoAfternoonDepthTransition(shallowState, sourceEvent({
      id: "shallow",
      time: "13:02",
      close: 98.95,
      board: { bids: [{ price: 98.95, qty: 99 }], asks: [{ price: 98.98, qty: 100 }] },
    }), "signal_quality");
    expect(shallow.actions[0]).toMatchObject({ reason: "board_depth_under_100_shares", dailySlotConsumed: false });
  });

  it("closes RR2 at the first event reaching the 45-minute boundary", () => {
    const state = createEmptyTaiyoAfternoonState("rr2_exit");
    state.tradeDate = "2026-09-07";
    state.position = { ...shortPosition(), executionProxyKind: "confirmation_candle_close" };
    state.dailySlotConsumed = true;
    const exited = applyTaiyoAfternoonRr2Transition(state, sourceEvent({
      id: "rr2-time",
      time: "13:47",
      open: 98.2,
      high: 98.4,
      low: 97.8,
      close: 98,
    }), "signal_quality");
    expect(exited.closedPosition).toMatchObject({ exitReason: "time_exit", exitPrice: 98 });
  });

  it("executes a depth time-exit intent with fresh ask-side 100-share VWAP", () => {
    const state = createEmptyTaiyoAfternoonState("depth_execution");
    state.tradeDate = "2026-09-07";
    state.position = shortPosition();
    state.dailySlotConsumed = true;
    const exited = applyTaiyoAfternoonDepthTransition(state, sourceEvent({
      id: "depth-time",
      time: "13:47",
      open: 98.2,
      high: 98.4,
      low: 97.8,
      close: 98,
      board: { bids: [{ price: 97.98, qty: 100 }], asks: [{ price: 98.02, qty: 60 }, { price: 98.04, qty: 40 }] },
    }), "signal_quality");
    expect(exited.closedPosition).toMatchObject({
      exitReason: "time_exit",
      executionProxyKind: "ask_depth_vwap_100",
      exitIntentRetryCount: 0,
    });
    expect(exited.closedPosition?.exitPrice).toBeCloseTo(98.028, 6);
  });

  it("latches a stop exit intent, retries missing ask depth, and never changes the reason", () => {
    const state = createEmptyTaiyoAfternoonState("depth_execution");
    state.tradeDate = "2026-09-07";
    state.position = shortPosition();
    state.dailySlotConsumed = true;
    const missingBoard = applyTaiyoAfternoonDepthTransition(state, sourceEvent({
      id: "stop-detected",
      time: "13:03",
      open: 100,
      high: 100.5,
      low: 98,
      close: 99.5,
      board: null,
    }), "signal_quality");
    expect(missingBoard.resultType).toBe("hold");
    expect(missingBoard.nextState.exitIntent).toMatchObject({ reason: "stop_loss", retryCount: 1 });

    const retried = applyTaiyoAfternoonDepthTransition(missingBoard.nextState, sourceEvent({
      id: "retry",
      time: "13:04",
      open: 97,
      high: 97.2,
      low: 96,
      close: 96.5,
      board: validAskBoard(),
    }), "signal_quality");
    expect(retried.closedPosition).toMatchObject({ exitReason: "stop_loss", executionProxyKind: "ask_depth_vwap_100", exitIntentRetryCount: 1 });
    expect(retried.nextState.exitIntent).toBeNull();
    expect(retried.nextState.position).toBeNull();
  });

  it("preserves an open position and exit intent across JSON restart and trade-date rollover", () => {
    const state = createEmptyTaiyoAfternoonState("depth_execution");
    state.tradeDate = "2026-09-07";
    state.position = shortPosition();
    state.exitIntent = {
      reason: "time_exit",
      detectedSourceEventId: "time-boundary",
      detectedTradeDate: "2026-09-07",
      detectedCandleTime: "13:47",
      theoreticalExitPrice: 98,
      retryCount: 2,
    };
    const restored = normalizeTaiyoAfternoonState(JSON.parse(JSON.stringify(state)), "depth_execution", "2026-09-08");
    expect(restored.tradeDate).toBe("2026-09-08");
    expect(restored.position?.entrySourceEventId).toBe("entry-1");
    expect(restored.exitIntent).toMatchObject({ reason: "time_exit", retryCount: 2 });
    expect(restored.dailySlotConsumed).toBe(true);
  });

  it("rejects collection dates before 2026-09-07", () => {
    const result = applyTaiyoAfternoonRr2Transition(
      createEmptyTaiyoAfternoonState("rr2_exit"),
      sourceEvent({ id: "old", tradeDate: "2026-09-04", time: "13:00" }),
      "signal_quality",
    );
    expect(result.resultType).toBe("rejected");
    expect(result.actions[0]).toMatchObject({ type: "not_collecting", collectionStartDate: "2026-09-07" });
  });
});
