import { describe, expect, it } from "vitest";
import type { ForwardSourceEventInput } from "./forwardShadow";
import {
  applyDiscoLongPriorThreeBTransition,
  applyDiscoLongProfitProtectionATransition,
  createEmptyDiscoLongState,
} from "./discoConfirmedLongForwardShadow";

function source(
  index: number,
  candle: Partial<ForwardSourceEventInput["candle"]> = {},
): ForwardSourceEventInput {
  const totalMinute = 25 + index;
  const hour = 9 + Math.floor(totalMinute / 60);
  const minute = totalMinute % 60;
  const close = 100 + index * 0.05;
  return {
    sourceEventId: `source-${index}`,
    candle: {
      symbol: "6146",
      tradeDate: "2026-09-18",
      candleTime: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
      open: close - 0.02,
      high: close + 0.05,
      low: close - 0.1,
      close,
      volume: 100,
      ...candle,
    },
    board: null,
  };
}

function preparedState(variant: "profit_protection_a" | "prior_three_b", pattern: "bull" | "mixed" | "two_bear" = "bull") {
  let state = createEmptyDiscoLongState(variant);
  for (let index = 0; index < 20; index += 1) {
    const base = source(index);
    const lastThreeIndex = index - 17;
    let open = base.candle.open;
    if (lastThreeIndex >= 0 && pattern === "mixed") {
      open = lastThreeIndex === 0
        ? base.candle.close - 0.02
        : lastThreeIndex === 1
          ? base.candle.close + 0.02
          : base.candle.close;
    }
    if (lastThreeIndex >= 0 && pattern === "two_bear") {
      open = lastThreeIndex < 2 ? base.candle.close + 0.02 : base.candle.close - 0.02;
    }
    state = (variant === "profit_protection_a"
      ? applyDiscoLongProfitProtectionATransition(state, { ...base, candle: { ...base.candle, open } }, "signal_quality")
      : applyDiscoLongPriorThreeBTransition(state, { ...base, candle: { ...base.candle, open } }, "signal_quality")).nextState;
  }
  return state;
}

function signalInput(sourceEventId = "signal"): ForwardSourceEventInput {
  return {
    sourceEventId,
    candle: {
      symbol: "6146",
      tradeDate: "2026-09-18",
      candleTime: "09:45",
      open: 101,
      high: 102.2,
      low: 100.9,
      close: 102,
      volume: 200,
    },
    board: null,
  };
}

describe("6146 LONG A: +0.50%到達後+0.25%利益保護", () => {
  it("現行と同じ確定足終値で入り、発動足では決済せず次イベントから保護する", () => {
    const entry = applyDiscoLongProfitProtectionATransition(
      preparedState("profit_protection_a"), signalInput(), "signal_quality",
    );
    expect(entry.resultType).toBe("entry");
    expect(entry.openedPosition).toMatchObject({ entryPrice: 102, slPct: 0.5, tpPct: 1.8, shares: 100 });

    const armed = applyDiscoLongProfitProtectionATransition(entry.nextState, {
      ...source(21),
      sourceEventId: "arm",
      candle: { ...source(21).candle, candleTime: "09:46", open: 102.3, high: 102.6, low: 102.2, close: 102.5 },
    }, "signal_quality");
    expect(armed.closedPosition).toBeNull();
    expect(armed.actions).toContainEqual(expect.objectContaining({
      type: "profit_protection_armed",
      effectiveFromNextSourceEvent: true,
    }));

    const protectedExit = applyDiscoLongProfitProtectionATransition(armed.nextState, {
      ...source(22),
      sourceEventId: "protect",
      candle: { ...source(22).candle, candleTime: "09:47", open: 102.3, high: 102.4, low: 102.2, close: 102.3 },
    }, "signal_quality");
    expect(protectedExit.closedPosition?.exitReason).toBe("profit_protection");
    expect(protectedExit.closedPosition?.exitPrice).toBeCloseTo(102 * 1.0025, 8);
  });

  it("SLと準備済み利益保護が同じ足ならSLを優先する", () => {
    const entry = applyDiscoLongProfitProtectionATransition(
      preparedState("profit_protection_a"), signalInput(), "signal_quality",
    );
    const armed = applyDiscoLongProfitProtectionATransition(entry.nextState, {
      ...source(21), sourceEventId: "arm",
      candle: { ...source(21).candle, candleTime: "09:46", open: 102.3, high: 102.6, low: 102.2, close: 102.5 },
    }, "signal_quality");
    const stopped = applyDiscoLongProfitProtectionATransition(armed.nextState, {
      ...source(22), sourceEventId: "stop",
      candle: { ...source(22).candle, candleTime: "09:47", open: 102, high: 102.3, low: 101.4, close: 101.7 },
    }, "signal_quality");
    expect(stopped.closedPosition?.exitReason).toBe("stop_loss");
    expect(stopped.closedPosition?.exitPrice).toBeCloseTo(102 * 0.995, 8);
  });
});

describe("6146 LONG B: 直前3本足構成確認", () => {
  it("直前3本がすべて陽線なら最初の適格候補を見送り、その日の再探索を終了する", () => {
    const rejected = applyDiscoLongPriorThreeBTransition(
      preparedState("prior_three_b", "bull"), signalInput(), "signal_quality",
    );
    expect(rejected.resultType).toBe("rejected");
    expect(rejected.nextState.dailySlotConsumed).toBe(true);
    expect(rejected.actions[0]).toMatchObject({
      type: "prior_three_filter_rejected",
      reason: "all_three_bullish",
      nextCandleSearchAllowed: false,
    });

    const later = applyDiscoLongPriorThreeBTransition(rejected.nextState, {
      ...signalInput("later"),
      candle: { ...signalInput("later").candle, candleTime: "09:46", close: 102.5, high: 102.7 },
    }, "signal_quality");
    expect(later.openedPosition).toBeNull();
    expect(later.nextState.dailySlotConsumed).toBe(true);
  });

  it("直前3本のうち2本以上が陰線でも日次終了する", () => {
    const rejected = applyDiscoLongPriorThreeBTransition(
      preparedState("prior_three_b", "two_bear"), signalInput(), "signal_quality",
    );
    expect(rejected.actions[0]).toMatchObject({
      reason: "two_or_more_bearish",
      bearish: 2,
      dailySlotConsumed: true,
    });
  });

  it("陽線1・陰線1・同値1なら現行と同じ価格とSL/TPで入る", () => {
    const entry = applyDiscoLongPriorThreeBTransition(
      preparedState("prior_three_b", "mixed"), signalInput(), "signal_quality",
    );
    expect(entry.resultType).toBe("entry");
    expect(entry.openedPosition).toMatchObject({ entryPrice: 102, slPct: 0.5, tpPct: 1.8, shares: 100 });
    expect(entry.actions[0]).toMatchObject({
      priorThreePattern: { bullish: 1, bearish: 1, doji: 1, rejectionReason: null },
    });
  });
});
