import { describe, expect, it } from "vitest";
import {
  KIOXIA_FORWARD_SHADOW_SPEC,
  calculateKioxiaForwardEntryMetrics,
} from "./kioxiaForwardShadow";
import {
  applyKioxiaForwardTransition,
  calculateKioxiaForwardExitForTest,
  type KioxiaForwardShadowState,
} from "./kioxiaForwardShadowEngine";
import type { KioxiaConfirmedMorningLongCandle } from "./kioxiaConfirmedMorningLong";

function minuteAt(index: number): string {
  const total = 9 * 60 + index;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function entryHistory(range = 4): KioxiaConfirmedMorningLongCandle[] {
  return Array.from({ length: 20 }, (_, index) => {
    const close = 995 + index * 0.02;
    return {
      time: minuteAt(45 + index),
      open: close - 0.05,
      high: close + range / 2,
      low: close - range / 2,
      close,
      volume: 100,
    };
  });
}

function eligibleCandle(time = "10:05"): KioxiaConfirmedMorningLongCandle {
  return { time, open: 998.8, high: 1_003, low: 999, close: 1_001, volume: 200 };
}

function emptyState(overrides: Partial<KioxiaForwardShadowState> = {}): KioxiaForwardShadowState {
  return {
    tradeDate: "2026-09-04",
    candles: [],
    position: null,
    dailySlotConsumed: false,
    stopped: false,
    lastSourceEventId: null,
    lastResultType: null,
    lastActions: [],
    ...overrides,
  };
}

function openPositionState(): KioxiaForwardShadowState {
  return emptyState({
    candles: Array.from({ length: 8 }, (_, index) => ({
      time: `09:${String(50 + index).padStart(2, "0")}`,
      open: 1_005,
      high: 1_006,
      low: 1_004,
      close: 1_005,
      volume: 100,
    })),
    position: {
      side: "long",
      entrySourceEventId: "entry:1",
      signalTime: "09:49",
      entryTime: "09:49",
      theoreticalSignalPrice: 1_000,
      entryPrice: 1_000,
      shares: 100,
      slPct: 0.8,
      tpPct: 1.6,
      profitProtectionArmedAtSourceEventId: null,
    },
    dailySlotConsumed: true,
  });
}

describe("285A MA8失速確認付き利益保護の純粋仕様", () => {
  it("現行確認型LONG入口と共通ATRを満たす時だけ09:45〜11:20に適格となる", () => {
    const eligible = calculateKioxiaForwardEntryMetrics([...entryHistory(), eligibleCandle("10:05")]);
    expect(eligible).toMatchObject({ eligible: true, atrAccepted: true });

    const before = calculateKioxiaForwardEntryMetrics([...entryHistory(), eligibleCandle("09:44")]);
    const after = calculateKioxiaForwardEntryMetrics([...entryHistory(), eligibleCandle("11:21")]);
    expect(before?.eligible).toBe(false);
    expect(after?.eligible).toBe(false);
    expect(KIOXIA_FORWARD_SHADOW_SPEC.exit).toMatchObject({ slPct: 0.8, tpPct: 1.6 });
  });

  it("ATR拒否では日次枠を消費せず、次の適格イベントを再探索して板現在値でentryする", () => {
    const lowAtrHistory = Array.from({ length: 20 }, (_, index) => ({
      time: minuteAt(45 + index),
      open: index === 0 ? 995 : 999.95,
      high: 1_000.1,
      low: 999.9,
      close: 1_000,
      volume: 100,
    }));
    const lowAtrState = emptyState({ candles: lowAtrHistory });
    const rejected = applyKioxiaForwardTransition(lowAtrState, {
      sourceEventId: "atr:1",
      candle: {
        symbol: "285A", tradeDate: "2026-09-04", candleTime: "10:05",
        open: 999.8, high: 1_002.1, low: 999.8, close: 1_002, volume: 200,
      },
      board: { currentPrice: 1_002.2 },
    }, "signal_quality");
    expect(rejected.resultType).toBe("rejected");
    expect(rejected.nextState.dailySlotConsumed).toBe(false);
    expect(rejected.actions).toContainEqual(expect.objectContaining({ type: "entry_rejected", reason: "atr_block" }));

    const accepted = applyKioxiaForwardTransition(rejected.nextState, {
      sourceEventId: "atr:2",
      candle: {
        symbol: "285A", tradeDate: "2026-09-04", candleTime: "10:06",
        open: 1_001.5, high: 1_006, low: 1_000, close: 1_004, volume: 200,
      },
      board: { currentPrice: 1_004.25 },
    }, "signal_quality");
    expect(accepted.resultType).toBe("entry");
    expect(accepted.nextState.dailySlotConsumed).toBe(true);
    expect(accepted.openedPosition).toMatchObject({ entryPrice: 1_004.25, theoreticalSignalPrice: 1_004, shares: 100 });
  });

  it("入口の板現在値が無ければ約定せず、後続候補を再探索できる", () => {
    const rejected = applyKioxiaForwardTransition(emptyState({ candles: entryHistory() }), {
      sourceEventId: "board-missing:1",
      candle: { symbol: "285A", tradeDate: "2026-09-04", candleTime: "10:05", ...eligibleCandle("10:05") },
      board: null,
    }, "signal_quality");
    expect(rejected.resultType).toBe("rejected");
    expect(rejected.nextState.position).toBeNull();
    expect(rejected.nextState.dailySlotConsumed).toBe(false);
    expect(rejected.actions).toContainEqual({ type: "entry_rejected", reason: "executable_price_unavailable" });
  });

  it("+0.6%到達イベントでは決済せず、次イベント以降の終値+0.3%以下かつMA8二本傾き-0.05%以下で板現在値決済する", () => {
    const armed = applyKioxiaForwardTransition(openPositionState(), {
      sourceEventId: "protect:arm",
      candle: {
        symbol: "285A", tradeDate: "2026-09-04", candleTime: "10:00",
        open: 1_003, high: 1_006, low: 1_001, close: 1_002, volume: 100,
      },
      board: { currentPrice: 1_002.25 },
    }, "signal_quality");
    expect(armed.resultType).toBe("hold");
    expect(armed.closedPosition).toBeNull();
    expect(armed.nextState.position?.profitProtectionArmedAtSourceEventId).toBe("protect:arm");

    const exited = applyKioxiaForwardTransition(armed.nextState, {
      sourceEventId: "protect:exit",
      candle: {
        symbol: "285A", tradeDate: "2026-09-04", candleTime: "10:01",
        open: 1_002, high: 1_003, low: 1_001, close: 1_002, volume: 100,
      },
      board: { currentPrice: 1_001.5 },
    }, "signal_quality");
    expect(exited.resultType).toBe("exit");
    expect(exited.closedPosition).toMatchObject({ exitPrice: 1_001.5, exitReason: "ma8_momentum_protection", pnl: 150 });
  });

  it("MA8失速条件が成立しても板現在値が無ければ決済せず拒否記録を残す", () => {
    const armed = openPositionState();
    armed.position!.profitProtectionArmedAtSourceEventId = "protect:arm";
    armed.candles.push({ time: "10:00", open: 1_002, high: 1_003, low: 1_001, close: 1_002, volume: 100 });
    const result = applyKioxiaForwardTransition(armed, {
      sourceEventId: "protect:no-board",
      candle: {
        symbol: "285A", tradeDate: "2026-09-04", candleTime: "10:01",
        open: 1_002, high: 1_003, low: 1_001, close: 1_002, volume: 100,
      },
      board: null,
    }, "signal_quality");
    expect(result.resultType).toBe("rejected");
    expect(result.nextState.position).not.toBeNull();
    expect(result.actions).toContainEqual(expect.objectContaining({
      type: "exit_rejected",
      reason: "executable_price_unavailable",
      intendedExitReason: "ma8_momentum_protection",
    }));
  });

  it("同一足でTPとSLに触れた場合はSLを優先し、窓下げは当足始値で不利約定する", () => {
    const position = openPositionState().position!;
    const result = calculateKioxiaForwardExitForTest(position, [], {
      symbol: "285A", tradeDate: "2026-09-04", candleTime: "10:10",
      open: 990, high: 1_020, low: 989, close: 1_010, volume: 100,
    }, null, "gap:1");
    expect(result).toEqual({ price: 990, reason: "stop_loss" });
  });

  it("11:27〜11:29が欠けても12:30の最初の後続受信で前場ポジションを決済する", () => {
    const position = openPositionState().position!;
    const result = calculateKioxiaForwardExitForTest(position, [], {
      symbol: "285A", tradeDate: "2026-09-04", candleTime: "12:30",
      open: 1_001, high: 1_005, low: 999, close: 1_002, volume: 100,
    }, null, "session:1");
    expect(result).toEqual({ price: 1_002, reason: "session_exit" });
  });

  it("09:00〜11:20の141本を保持し、96本を超えても当日始値基準で入口を判定する", () => {
    let state = emptyState();
    for (let index = 0; index < 140; index += 1) {
      const close = 1_000 + index * 0.01;
      state = applyKioxiaForwardTransition(state, {
        sourceEventId: `day:${index}`,
        candle: {
          symbol: "285A", tradeDate: "2026-09-04", candleTime: minuteAt(index),
          open: index === 0 ? 1_000 : close - 0.01,
          high: close + 2,
          low: close - 2,
          close,
          volume: 100,
        },
        board: { currentPrice: close },
      }, "signal_quality").nextState;
    }
    const final = applyKioxiaForwardTransition(state, {
      sourceEventId: "day:140",
      candle: {
        symbol: "285A", tradeDate: "2026-09-04", candleTime: "11:20",
        open: 1_003.5, high: 1_008, low: 1_002, close: 1_006, volume: 200,
      },
      board: { currentPrice: 1_006.25 },
    }, "signal_quality");
    expect(final.nextState.candles).toHaveLength(141);
    expect(final.resultType).toBe("entry");
    expect(final.actions).toContainEqual(expect.objectContaining({ type: "entry", openGainPct: 0.6 }));
  });
});
