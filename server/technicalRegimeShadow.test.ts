import { describe, expect, it } from "vitest";
import type { ForwardSourceEventInput } from "./forwardShadow";
import {
  applyTechnicalRegimeShadowTransition,
  buildTechnicalRegimePlan,
  createEmptyTechnicalRegimeShadowState,
} from "./technicalRegimeShadow";

function source(input: { id: string; time: string; open: number; high: number; low: number; close: number; volume?: number; asks?: Array<{ price: number; qty: number }> }): ForwardSourceEventInput {
  return {
    sourceEventId: input.id,
    candle: { symbol: "285A", tradeDate: "2026-10-05", candleTime: input.time, open: input.open, high: input.high, low: input.low, close: input.close, volume: input.volume ?? 100 },
    board: { asks: input.asks ?? [{ price: input.close, qty: 100 }], bids: [{ price: input.close - 0.1, qty: 100 }] },
    currentAudit: {
      engineSequence: 1, resultType: "no_signal", routeId: null, marginUsedBefore: 0, marginUsedAfter: 0,
      stateHashBefore: "a", stateHashAfter: "b", causalityStatus: "ok", causalityReason: "ok",
      boardObservedAtMs: 1_000, relayAssembledAtMs: 1_100, relaySentAtMs: 1_200,
      cloudReceivedAtMs: 1_300, decisionStartedAtMs: 1_350, decisionCompletedAtMs: 1_400,
    },
  };
}

function upPlan() {
  return buildTechnicalRegimePlan({
    symbol: "285A",
    sourceTradeDate: "2026-10-02",
    featureWrapper: {
      featureEligible: true,
      provenanceStatus: "provenance_present",
      features: {
        open: 98, high: 100, low: 96, close: 99, atr14Pct: 2,
        bollinger20: { middle: 99, plus2: 103, minus2: 95 },
      },
      technicalRegime: { eligible: true, setup: "up_breakout", confidence: "high" },
    },
  });
}

describe("10-symbol technical-regime shadow A", () => {
  it("D-1 featureだけから翌日planを固定する", () => {
    expect(upPlan()).toMatchObject({ sourceTradeDate: "2026-10-02", kind: "trend_breakout_long", priorHigh: 100, priorClose: 99 });
    const unavailable = buildTechnicalRegimePlan({ symbol: "285A", sourceTradeDate: "2026-10-02", featureWrapper: { featureEligible: false } });
    expect(unavailable.kind).toBe("no_trade");
  });

  it("確定1分足でsignalを作り、同じ足ではなく次eventのfresh ask depthで入る", () => {
    let state = createEmptyTechnicalRegimeShadowState(upPlan(), "2026-10-05");
    for (let index = 0; index < 9; index += 1) {
      state = applyTechnicalRegimeShadowTransition(state, source({ id: `warm-${index}`, time: `09:${String(15 + index).padStart(2, "0")}`, open: 98.5, high: 99.2, low: 98.4, close: 99, volume: 100 }), "signal_quality").nextState;
    }
    const signal = applyTechnicalRegimeShadowTransition(state, source({ id: "signal", time: "09:24", open: 99.8, high: 101.2, low: 99.7, close: 101, volume: 200 }), "signal_quality");
    expect(signal.resultType).toBe("pending");
    expect(signal.openedPosition).toBeNull();

    const entry = applyTechnicalRegimeShadowTransition(signal.nextState, source({ id: "entry", time: "09:25", open: 101, high: 101.3, low: 100.9, close: 101.2, asks: [{ price: 101.1, qty: 100 }] }), "signal_quality");
    expect(entry.resultType).toBe("entry");
    expect(entry.openedPosition).toMatchObject({ side: "long", entrySourceEventId: "entry", entryPrice: 101.1, targetPrice: 103, shares: 100 });
    expect(entry.openedPosition!.rewardRisk).toBeGreaterThanOrEqual(1.2);

    const exit = applyTechnicalRegimeShadowTransition(entry.nextState, source({ id: "exit", time: "09:26", open: 101.2, high: 103.1, low: 101, close: 102.8 }), "signal_quality");
    expect(exit.resultType).toBe("exit");
    expect(exit.closedPosition).toMatchObject({ exitPrice: 103, exitReason: "technical_target", pnl: 190 });
  });

  it("古い板ではentryせず、日次枠も消費しない", () => {
    let state = createEmptyTechnicalRegimeShadowState(upPlan(), "2026-10-05");
    state.pending = { side: "long", signalSourceEventId: "signal", signalTime: "10:00", theoreticalSignalPrice: 101, triggerPrice: 100, stopPrice: 99.95, targetCandidates: [103], signalKind: "breakout" };
    const stale = source({ id: "stale", time: "10:01", open: 101, high: 101.2, low: 100.9, close: 101, asks: [{ price: 101.1, qty: 100 }] });
    stale.currentAudit!.relaySentAtMs = 8_000;
    stale.currentAudit!.decisionCompletedAtMs = 8_200;
    const result = applyTechnicalRegimeShadowTransition(state, stale, "signal_quality");
    expect(result.resultType).toBe("rejected");
    expect(result.nextState.dailySlotConsumed).toBe(false);
    expect(result.actions[0]).toMatchObject({ reason: "board_stale_over_5000ms" });
  });
});
