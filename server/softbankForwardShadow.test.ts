import { describe, expect, it } from "vitest";
import type { ForwardSourceEventInput } from "./forwardShadow";
import {
  applySoftbankDepthConfirmTransition,
  applySoftbankRr2ProtectTransition,
  createEmptySoftbankForwardState,
} from "./softbankForwardShadow";

function input(index: number, overrides: Partial<ForwardSourceEventInput> = {}): ForwardSourceEventInput {
  const minutes = 20 + index;
  const candleTime = `09:${String(minutes).padStart(2, "0")}`;
  const close = 99 + index * 0.1;
  return {
    sourceEventId: `source-${index}`,
    candle: {
      symbol: "9984",
      tradeDate: "2026-09-07",
      candleTime,
      open: close - 0.05,
      high: close + 0.05,
      low: close - 0.1,
      close,
      volume: 100,
    },
    board: null,
    ...overrides,
  };
}

function signalInput(sourceEventId = "signal"): ForwardSourceEventInput {
  return {
    sourceEventId,
    candle: {
      symbol: "9984",
      tradeDate: "2026-09-07",
      candleTime: "09:40",
      open: 102.4,
      high: 103.1,
      low: 102.3,
      close: 103,
      volume: 200,
    },
    board: null,
  };
}

function withHistory(variant: "depth_confirm" | "rr2_protect") {
  let state = createEmptySoftbankForwardState(variant);
  for (let index = 0; index < 20; index += 1) {
    state = (variant === "depth_confirm"
      ? applySoftbankDepthConfirmTransition(state, input(index), "signal_quality")
      : applySoftbankRr2ProtectTransition(state, input(index), "signal_quality")).nextState;
  }
  return state;
}

function clockSafeAudit() {
  return {
    engineSequence: 100,
    resultType: "entry",
    routeId: "softbankBreakoutLong",
    marginUsedBefore: 0,
    marginUsedAfter: 0,
    stateHashBefore: "before",
    stateHashAfter: "after",
    causalityStatus: "pass",
    causalityReason: "available_at_decision",
    boardObservedAtMs: 900,
    relayAssembledAtMs: 1_000,
    relaySentAtMs: 1_200,
    cloudReceivedAtMs: 50_000,
    decisionStartedAtMs: 50_100,
    decisionCompletedAtMs: 50_300,
  };
}

describe("9984 A: 次イベント100株ask depth確認", () => {
  it("現行入口をpending化し、価格昇順100株VWAPでブレイク継続時だけ入る", () => {
    const signal = applySoftbankDepthConfirmTransition(withHistory("depth_confirm"), signalInput(), "signal_quality");
    expect(signal.resultType).toBe("pending");
    expect(signal.nextState.dailySlotConsumed).toBe(false);

    const confirmed = applySoftbankDepthConfirmTransition(signal.nextState, {
      ...input(21),
      sourceEventId: "confirm",
      candle: { ...input(21).candle, candleTime: "09:41", open: 103, high: 103.2, low: 102.8, close: 103.1 },
      board: {
        asks: [
          { price: 102.9, qty: 40 },
          { price: 102.8, qty: 60 },
          { price: 103.0, qty: 300 },
        ],
      },
      currentAudit: clockSafeAudit(),
    }, "signal_quality");

    expect(confirmed.resultType).toBe("entry");
    expect(confirmed.openedPosition?.entryPrice).toBeCloseTo(102.84, 8);
    expect(confirmed.openedPosition?.shares).toBe(100);
    expect(confirmed.openedPosition?.slPct).toBe(0.4);
    expect(confirmed.openedPosition?.tpPct).toBe(0.8);
    expect(confirmed.nextState.dailySlotConsumed).toBe(true);
  });

  it("ask合計100株未満なら拒否し、日次枠と元初動を再利用しない", () => {
    const signal = applySoftbankDepthConfirmTransition(withHistory("depth_confirm"), signalInput(), "signal_quality");
    const rejected = applySoftbankDepthConfirmTransition(signal.nextState, {
      ...input(21),
      sourceEventId: "confirm-insufficient",
      candle: { ...input(21).candle, candleTime: "09:41" },
      board: { asks: [{ price: 103, qty: 99 }] },
      currentAudit: clockSafeAudit(),
    }, "signal_quality");

    expect(rejected.resultType).toBe("rejected");
    expect(rejected.actions[0]).toMatchObject({
      reason: "insufficient_ask_depth_for_100_shares",
      dailySlotConsumed: false,
      originalImpulseReusable: false,
    });
    expect(rejected.nextState.pending).toBeNull();
    expect(rejected.nextState.dailySlotConsumed).toBe(false);
  });

  it("Windowsとcloudの壁時計差ではなく、同一時計区間合計500msで鮮度判定する", () => {
    const signal = applySoftbankDepthConfirmTransition(withHistory("depth_confirm"), signalInput(), "signal_quality");
    const confirmed = applySoftbankDepthConfirmTransition(signal.nextState, {
      ...input(21),
      sourceEventId: "confirm-clock-skew",
      candle: { ...input(21).candle, candleTime: "09:41" },
      board: { asks: [{ price: 102.9, qty: 100 }] },
      currentAudit: clockSafeAudit(),
    }, "signal_quality");

    expect(confirmed.resultType).toBe("entry");
    expect(confirmed.openedPosition?.boardAgeMs).toBe(500);
  });

  it("pending状態をJSON復元しても次イベントdepth確認結果が一致する", () => {
    const signal = applySoftbankDepthConfirmTransition(withHistory("depth_confirm"), signalInput(), "signal_quality");
    const restored = JSON.parse(JSON.stringify(signal.nextState));
    const confirmed = applySoftbankDepthConfirmTransition(restored, {
      ...input(21),
      sourceEventId: "confirm-after-restart",
      candle: { ...input(21).candle, candleTime: "09:41" },
      board: { asks: [{ price: 102.9, qty: 100 }] },
      currentAudit: clockSafeAudit(),
    }, "signal_quality");
    expect(confirmed.resultType).toBe("entry");
    expect(confirmed.openedPosition?.entryPrice).toBe(102.9);
  });
});

describe("9984 B: 2R＋利益保護", () => {
  it("現行と同じ確定足終値で入り、準備足では決済せず次イベントで+0.05%を保護する", () => {
    const entry = applySoftbankRr2ProtectTransition(withHistory("rr2_protect"), signalInput(), "signal_quality");
    expect(entry.resultType).toBe("entry");
    expect(entry.openedPosition).toMatchObject({ entryPrice: 103, slPct: 0.5, tpPct: 1 });

    const armed = applySoftbankRr2ProtectTransition(entry.nextState, {
      ...input(21),
      sourceEventId: "arm",
      candle: { ...input(21).candle, candleTime: "09:41", open: 103.1, high: 103.3, low: 103.04, close: 103.2 },
    }, "signal_quality");
    expect(armed.closedPosition).toBeNull();
    expect(armed.actions).toContainEqual(expect.objectContaining({ type: "profit_protection_armed" }));

    const protectionExit = applySoftbankRr2ProtectTransition(armed.nextState, {
      ...input(22),
      sourceEventId: "protect",
      candle: { ...input(22).candle, candleTime: "09:42", open: 103.06, high: 103.1, low: 103.04, close: 103.05 },
    }, "signal_quality");
    expect(protectionExit.closedPosition?.exitReason).toBe("profit_protection");
    expect(protectionExit.closedPosition?.exitPrice).toBeCloseTo(103 * 1.0005, 8);
  });

  it("窓下げはSL価格より不利な当足始値を採用する", () => {
    const entry = applySoftbankRr2ProtectTransition(withHistory("rr2_protect"), signalInput(), "signal_quality");
    const stopped = applySoftbankRr2ProtectTransition(entry.nextState, {
      ...input(21),
      sourceEventId: "gap-stop",
      candle: { ...input(21).candle, candleTime: "09:41", open: 101.5, high: 102, low: 101.4, close: 101.8 },
    }, "signal_quality");
    expect(stopped.closedPosition).toMatchObject({ exitReason: "stop_loss", exitPrice: 101.5 });
  });

  it("SLと準備済み利益保護が同じ足で成立した場合もSLを優先する", () => {
    const entry = applySoftbankRr2ProtectTransition(withHistory("rr2_protect"), signalInput(), "signal_quality");
    const armed = applySoftbankRr2ProtectTransition(entry.nextState, {
      ...input(21),
      sourceEventId: "arm",
      candle: { ...input(21).candle, candleTime: "09:41", open: 103.1, high: 103.3, low: 103.1, close: 103.2 },
    }, "signal_quality");
    const stopped = applySoftbankRr2ProtectTransition(armed.nextState, {
      ...input(22),
      sourceEventId: "sl-priority",
      candle: { ...input(22).candle, candleTime: "09:42", open: 103.1, high: 103.2, low: 102.4, close: 102.6 },
    }, "signal_quality");
    expect(stopped.closedPosition?.exitReason).toBe("stop_loss");
  });

  it("利益保護準備状態をJSON復元しても次イベントからだけ有効になる", () => {
    const entry = applySoftbankRr2ProtectTransition(withHistory("rr2_protect"), signalInput(), "signal_quality");
    const armed = applySoftbankRr2ProtectTransition(entry.nextState, {
      ...input(21),
      sourceEventId: "arm-before-restart",
      candle: { ...input(21).candle, candleTime: "09:41", open: 103.1, high: 103.3, low: 103.04, close: 103.2 },
    }, "signal_quality");
    const restored = JSON.parse(JSON.stringify(armed.nextState));
    const protectionExit = applySoftbankRr2ProtectTransition(restored, {
      ...input(22),
      sourceEventId: "protect-after-restart",
      candle: { ...input(22).candle, candleTime: "09:42", open: 103.06, high: 103.1, low: 103.04, close: 103.05 },
    }, "signal_quality");
    expect(protectionExit.closedPosition?.exitReason).toBe("profit_protection");
  });
});
