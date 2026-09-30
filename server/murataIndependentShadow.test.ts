import { describe, expect, it } from "vitest";
import type { ForwardSourceEventInput } from "./forwardShadow";
import {
  MURATA_INDEPENDENT_SHADOW_SPECS,
  applyMurataIndependentShadowTransition,
  createEmptyMurataIndependentShadowState,
} from "./murataIndependentShadow";

const date = "2026-10-01";

function time(index: number) {
  const total = 9 * 60 + 25 + index;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function source(index: number, overrides: Partial<ForwardSourceEventInput> = {}): ForwardSourceEventInput {
  const close = 97.55 + index * 0.045;
  const base: ForwardSourceEventInput = {
    sourceEventId: `6981:${index}`,
    candle: {
      symbol: "6981",
      tradeDate: date,
      candleTime: time(index),
      open: close - 0.04,
      high: close + 0.06,
      low: close - 0.10,
      close,
      volume: 100,
      provenance: {
        relayVersion: "kabu-relay-provenance-v1",
        rawCandleTime: time(index),
        barStartJst: time(index),
        barEndJst: time(index + 1),
        valueSource: "ws_aggregated",
        isNoTrade: false,
        clockHealth: { timezone: "JST", monotonicAnomaly: false },
      },
    } as any,
    board: { bids: [{ price: close - 0.02, qty: 10_000 }], asks: [{ price: close + 0.02, qty: 10_000 }] },
    currentAudit: {
      engineSequence: index + 1,
      resultType: "no_signal",
      routeId: null,
      marginUsedBefore: 0,
      marginUsedAfter: 0,
      stateHashBefore: "before",
      stateHashAfter: "after",
      causalityStatus: "pass",
      causalityReason: "ok",
      boardObservedAtMs: 1_000 + index * 1_000,
      relayAssembledAtMs: 1_010 + index * 1_000,
      relaySentAtMs: 1_020 + index * 1_000,
      cloudReceivedAtMs: 1_030 + index * 1_000,
      decisionStartedAtMs: 1_040 + index * 1_000,
      decisionCompletedAtMs: 1_050 + index * 1_000,
    },
  };
  return {
    ...base,
    ...overrides,
    candle: { ...base.candle, ...(overrides.candle ?? {}) },
    currentAudit: { ...base.currentAudit!, ...(overrides.currentAudit ?? {}) },
  };
}

function buildLongSignalState() {
  let state = createEmptyMurataIndependentShadowState("deep_reversal_long");
  for (let index = 0; index < 20; index += 1) {
    const close = index <= 7 ? 100 - index * 0.34 : 97.62 + (index - 7) * 0.05;
    state = applyMurataIndependentShadowTransition("deep_reversal_long", state, source(index, {
      candle: { ...source(index).candle, open: close - 0.03, high: close + 0.04, low: index === 7 ? 97.45 : close - 0.05, close, volume: 100 },
    })).nextState;
  }
  return state;
}

describe("6981 private A/B independent forward shadows", () => {
  it("fixes A/B as dry-run-only independent 100-share candidates with the user-specified exits", () => {
    expect(MURATA_INDEPENDENT_SHADOW_SPECS).toMatchObject({
      dryRunOnly: true,
      automaticSelection: false,
      automaticAdoption: false,
      orderInstructionConnection: false,
      shares: 100,
      deep_reversal_long: { entry: { startTime: "09:45", endTime: "11:29", minVolumeRatio: 0.6 }, exit: { slPct: 0.4, tpPct: 0.8, maxHoldingMinutes: 10 } },
      morning_breakdown_short: { entry: { startTime: "09:55", endTime: "10:45", minVolumeRatio: 0.6, shockRangePct: 0.8, shockVolumeRatio: 2 }, exit: { slPct: 0.8, tpPct: 2.4, maxHoldingMinutes: 30 } },
    });
    expect(MURATA_INDEPENDENT_SHADOW_SPECS.deep_reversal_long.exit.tpPct).toBe(2 * MURATA_INDEPENDENT_SHADOW_SPECS.deep_reversal_long.exit.slPct);
    expect(MURATA_INDEPENDENT_SHADOW_SPECS.morning_breakdown_short.exit.tpPct).toBeCloseTo(3 * MURATA_INDEPENDENT_SHADOW_SPECS.morning_breakdown_short.exit.slPct, 8);
  });

  it("uses trigger -> confirmation -> strictly later directional depth event, applies 0.10% adverse entry, and gives same-bar SL priority", () => {
    const state = buildLongSignalState();
    const trigger = source(20, {
      sourceEventId: "6981:trigger",
      candle: { ...source(20).candle, candleTime: "09:45", open: 98.18, high: 98.58, low: 98.12, close: 98.5, volume: 100 },
    });
    const pending = applyMurataIndependentShadowTransition("deep_reversal_long", state, trigger);
    expect(pending.resultType).toBe("pending");
    expect(pending.nextState.pending?.phase).toBe("await_confirmation");

    const confirmation = applyMurataIndependentShadowTransition("deep_reversal_long", pending.nextState, source(21, {
      sourceEventId: "6981:confirmation",
      candle: { ...source(21).candle, candleTime: "09:46", open: 98.48, high: 98.72, low: 98.45, close: 98.65, volume: 100 },
    }));
    expect(confirmation.resultType).toBe("pending");
    expect(confirmation.nextState.pending?.phase).toBe("await_execution");

    const entry = applyMurataIndependentShadowTransition("deep_reversal_long", confirmation.nextState, source(22, {
      sourceEventId: "6981:entry",
      candle: { ...source(22).candle, candleTime: "09:47", open: 98.62, high: 98.75, low: 98.58, close: 98.7, volume: 100 },
      board: { bids: [{ price: 98.68, qty: 10_000 }], asks: [{ price: 98.7, qty: 10_000 }] },
    }));
    expect(entry.openedPosition).toMatchObject({ side: "long", executableDepthVwap: 98.7, entryPrice: 98.7987, shares: 100, slPct: 0.4, tpPct: 0.8 });

    const exit = applyMurataIndependentShadowTransition("deep_reversal_long", entry.nextState, source(23, {
      sourceEventId: "6981:same-bar-stop-and-target",
      candle: { ...source(23).candle, candleTime: "09:48", open: 98.9, high: 99.7, low: 98.0, close: 99.1, volume: 100 },
    }));
    expect(exit.resultType).toBe("exit");
    expect(exit.closedPosition?.exitReason).toBe("stop_loss");
    expect(exit.closedPosition?.pnl).toBeLessThan(0);
  });

  it("cancels a failed confirmation without consuming the daily slot, so a later trigger may be searched", () => {
    const state = buildLongSignalState();
    const trigger = applyMurataIndependentShadowTransition("deep_reversal_long", state, source(20, {
      candle: { ...source(20).candle, candleTime: "09:45", open: 98.18, high: 98.58, low: 98.12, close: 98.5, volume: 100 },
    }));
    const failed = applyMurataIndependentShadowTransition("deep_reversal_long", trigger.nextState, source(21, {
      candle: { ...source(21).candle, candleTime: "09:46", open: 98.6, high: 98.63, low: 98.35, close: 98.4, volume: 100 },
    }));
    expect(failed.resultType).toBe("rejected");
    expect(failed.nextState.pending).toBeNull();
    expect(failed.nextState.dailySlotConsumed).toBe(false);
    expect(failed.actions).toContainEqual(expect.objectContaining({ type: "confirmation_rejected", continueSearch: true }));
  });

  it("fails closed on absent provenance or an intra-session time gap and never treats the day as a no-trade win", () => {
    const missing = source(0, { candle: { ...source(0).candle, provenance: undefined } as any });
    const unresolved = applyMurataIndependentShadowTransition("morning_breakdown_short", createEmptyMurataIndependentShadowState("morning_breakdown_short"), missing);
    expect(unresolved.resultType).toBe("rejected");
    expect(unresolved.nextState.dayUnresolved).toBe(true);
    expect(unresolved.actions).toContainEqual(expect.objectContaining({ type: "unresolved" }));

    let state = createEmptyMurataIndependentShadowState("morning_breakdown_short");
    state = applyMurataIndependentShadowTransition("morning_breakdown_short", state, source(30, { candle: { ...source(30).candle, candleTime: "09:55" } })).nextState;
    const gap = applyMurataIndependentShadowTransition("morning_breakdown_short", state, source(32, { candle: { ...source(32).candle, candleTime: "09:57" } }));
    expect(gap.nextState.dayUnresolved).toBe(true);
    expect(gap.actions).toContainEqual(expect.objectContaining({ reason: "intra_morning_candle_time_gap" }));
  });
});
