import { describe, expect, it } from "vitest";
import {
  applyKioxiaCurrentReversalLongExactTransition,
  emptyKioxiaCurrentReversalLongExactState,
  parseKioxiaCurrentReversalLongExactState,
} from "./kioxiaCurrentReversalLongExact";

function source(input: Partial<{ time: string; open: number; high: number; low: number; close: number; volume: number; board: unknown }> = {}) {
  return {
    sourceEventId: `source:${input.time ?? "10:00"}`,
    candle: {
      symbol: "285A",
      tradeDate: "2026-10-02",
      candleTime: input.time ?? "10:00",
      open: input.open ?? 100,
      high: input.high ?? 101,
      low: input.low ?? 99,
      close: input.close ?? 100,
      volume: input.volume ?? 100,
    },
    board: input.board ?? null,
  } as any;
}

function seededState() {
  const state = emptyKioxiaCurrentReversalLongExactState();
  state.tradeDate = "2026-10-02";
  state.candles = Array.from({ length: 30 }, (_, index) => ({
    time: `09:${String(index).padStart(2, "0")}`,
    open: index === 0 ? 109 : 104 + index * 0.03,
    high: index === 0 ? 110 : 105 + index * 0.03,
    low: 103,
    close: index === 0 ? 109 : 104 + index * 0.03,
    volume: 100,
  }));
  return state;
}

describe("exact current 285A reversal-long reopen", () => {
  it("uses the old current rule's completed-candle entry and isolated one-day state", () => {
    const state = seededState();
    const result = applyKioxiaCurrentReversalLongExactTransition(state, source({ time: "10:00", open: 106, high: 108, low: 105, close: 107, volume: 200 }), "signal_quality");
    expect(result.resultType).toBe("entry");
    expect(result.openedPosition).toMatchObject({ side: "long", entryPrice: 107, shares: 100, slPct: 0.6, tpPct: 1.2, executionProxyKind: "completed_candle_close" });
    expect(result.nextState.dailySlotConsumed).toBe(true);
    expect(parseKioxiaCurrentReversalLongExactState(result.nextState, "2026-10-03")).toMatchObject({ tradeDate: "2026-10-03", candles: [], position: null, dailySlotConsumed: false });
  });

  it("preserves current-engine same-bar stop-loss precedence over take-profit", () => {
    const state = seededState();
    state.position = {
      side: "long", signalSourceEventId: "entry", entrySourceEventId: "entry", signalTime: "10:00", entryTime: "10:00",
      theoreticalSignalPrice: 100, entryPrice: 100, shares: 100, slPct: 0.6, tpPct: 1.2, dayHigh: 105, dropFromHighPct: 2.5, maSlope2Pct: 0.03, executionProxyKind: "completed_candle_close",
    };
    const result = applyKioxiaCurrentReversalLongExactTransition(state, source({ time: "10:01", high: 102, low: 99, close: 101 }), "signal_quality");
    expect(result.resultType).toBe("exit");
    expect(result.closedPosition).toMatchObject({ exitReason: "stop_loss", exitPrice: 99.4, pnl: -60 });
  });

  it("rejects sell-pressure without consuming the daily successful-entry slot", () => {
    const state = seededState();
    const result = applyKioxiaCurrentReversalLongExactTransition(state, source({ time: "10:00", open: 106, high: 108, low: 105, close: 107, volume: 200, board: { signal: "sell_pressure" } }), "signal_quality");
    expect(result.resultType).toBe("rejected");
    expect(result.nextState.dailySlotConsumed).toBe(false);
    expect(result.nextState.position).toBeNull();
  });
});
