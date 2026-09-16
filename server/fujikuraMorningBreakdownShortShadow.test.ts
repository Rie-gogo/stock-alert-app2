import { describe, expect, it } from "vitest";
import type { ForwardSourceEventInput } from "./forwardShadow";
import {
  FUJIKURA_MORNING_SHORT_SPEC,
  applyFujikuraMorningShortTransition,
  createEmptyFujikuraMorningShortState,
} from "./fujikuraMorningBreakdownShortShadow";

const tradeDate = "2026-09-17";

function audit() {
  return {
    engineSequence: 1,
    resultType: "none",
    routeId: null,
    marginUsedBefore: 0,
    marginUsedAfter: 0,
    stateHashBefore: "before",
    stateHashAfter: "after",
    causalityStatus: "causal",
    causalityReason: "ok",
    boardObservedAtMs: 900,
    relayAssembledAtMs: 1_000,
    relaySentAtMs: 1_010,
    cloudReceivedAtMs: 2_000,
    decisionStartedAtMs: 2_005,
    decisionCompletedAtMs: 2_010,
  };
}

function board(bidPrice = 98.42) {
  return {
    buyPressureRatio: 0.6,
    signal: "neutral",
    bids: [{ price: bidPrice, qty: 100_000 }],
    asks: [{ price: bidPrice + 0.02, qty: 100_000 }],
  };
}

function source(index: number, overrides: Partial<ForwardSourceEventInput> = {}): ForwardSourceEventInput {
  const minute = 25 + index;
  const close = 100 - index * 0.02;
  const base: ForwardSourceEventInput = {
    sourceEventId: `5803:${index}`,
    candle: {
      symbol: "5803",
      tradeDate,
      candleTime: `09:${String(minute).padStart(2, "0")}`,
      open: close + 0.02,
      high: index === 0 ? 101 : close + 0.1,
      low: close - 0.1,
      close,
      volume: 100,
    },
    board: board(),
    currentAudit: audit(),
  };
  return {
    ...base,
    ...overrides,
    candle: { ...base.candle, ...(overrides.candle ?? {}) },
    currentAudit: { ...base.currentAudit!, ...(overrides.currentAudit ?? {}) },
  };
}

function signalSource(): ForwardSourceEventInput {
  return source(20, {
    sourceEventId: "5803:signal",
    candle: {
      symbol: "5803",
      tradeDate,
      candleTime: "09:45",
      open: 99.0,
      high: 99.05,
      low: 98.4,
      close: 98.5,
      volume: 120,
    },
  });
}

function stateAtSignal() {
  let state = createEmptyFujikuraMorningShortState();
  for (let index = 0; index < 20; index += 1) {
    state = applyFujikuraMorningShortTransition(state, source(index), "signal_quality").nextState;
  }
  return state;
}

describe("5803前場20本安値更新SHORT・実行可能価格シャドー", () => {
  it("固定条件、TP>SL、DRY_RUN専用を明示する", () => {
    expect(FUJIKURA_MORNING_SHORT_SPEC).toMatchObject({
      symbol: "5803",
      routeId: "fujikuraMorning20BarBreakdownShort",
      dryRunOnly: true,
      eligibleForAdoption: false,
      automaticAdoption: false,
      orderInstructionConnection: false,
      entry: {
        startTime: "09:45",
        endTime: "11:27",
        lowLookback: 20,
        maxMaSlope2Pct: -0.02,
        minVolumeRatio: 0.9,
        minDrawdownFromDayHighPct: 1.2,
        maxBuyPressureRatio: 0.8,
        maximumAdverseEntryPct: 0.10,
      },
      exit: { slPct: 0.7, tpPct: 1.5, maxHoldingMinutes: 10 },
    });
    expect(FUJIKURA_MORNING_SHORT_SPEC.exit.tpPct).toBeGreaterThan(FUJIKURA_MORNING_SHORT_SPEC.exit.slPct);
  });

  it("確定足で条件成立後、次イベントの100株bid depthでだけ仮エントリーする", () => {
    const pending = applyFujikuraMorningShortTransition(stateAtSignal(), signalSource(), "signal_quality");
    expect(pending.resultType).toBe("pending");
    expect(pending.nextState.dailySlotConsumed).toBe(false);

    const entry = applyFujikuraMorningShortTransition(pending.nextState, source(21, {
      sourceEventId: "5803:entry",
      candle: { ...signalSource().candle, candleTime: "09:46", open: 98.45, high: 98.5, low: 98.3, close: 98.4 },
      board: board(98.42),
    }), "signal_quality");
    expect(entry.resultType).toBe("entry");
    expect(entry.openedPosition).toMatchObject({
      side: "short",
      theoreticalSignalPrice: 98.5,
      entryPrice: 98.42,
      shares: 100,
      slPct: 0.7,
      tpPct: 1.5,
      executionProxyKind: "bid_depth_vwap",
    });
    expect(entry.nextState.dailySlotConsumed).toBe(true);
  });

  it("0.10%を超える価格悪化は見送り、日次枠を消費しない", () => {
    const pending = applyFujikuraMorningShortTransition(stateAtSignal(), signalSource(), "signal_quality");
    const rejected = applyFujikuraMorningShortTransition(pending.nextState, source(21, {
      sourceEventId: "5803:bad-entry",
      candle: { ...signalSource().candle, candleTime: "09:46", close: 98.0 },
      board: board(98.0),
    }), "signal_quality");
    expect(rejected.openedPosition).toBeNull();
    expect(rejected.resultType).toBe("rejected");
    expect(rejected.nextState.dailySlotConsumed).toBe(false);
    expect(rejected.actions).toContainEqual(expect.objectContaining({
      type: "entry_rejected",
      reason: "adverse_entry_gap_over_010pct",
    }));
  });

  it("10分境界で確定足終値決済し、0.10%不利決済損益も分けて算出する", () => {
    const pending = applyFujikuraMorningShortTransition(stateAtSignal(), signalSource(), "signal_quality");
    const entry = applyFujikuraMorningShortTransition(pending.nextState, source(21, {
      sourceEventId: "5803:entry",
      candle: { ...signalSource().candle, candleTime: "09:46", close: 98.4 },
      board: board(98.42),
    }), "signal_quality");
    const exit = applyFujikuraMorningShortTransition(entry.nextState, source(31, {
      sourceEventId: "5803:time-exit",
      candle: { ...signalSource().candle, candleTime: "09:56", open: 98.3, high: 98.35, low: 98.15, close: 98.2 },
    }), "signal_quality");
    expect(exit.resultType).toBe("exit");
    expect(exit.closedPosition).toMatchObject({ exitReason: "time_exit", exitPrice: 98.2 });
    expect(exit.closedPosition!.pnl).toBeGreaterThan(exit.closedPosition!.pnlAfterAdverseExit);
  });
});
