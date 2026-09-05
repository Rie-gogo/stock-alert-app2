import { describe, expect, it } from "vitest";
import type { ForwardSourceEventInput } from "./forwardShadow";
import {
  applyTaiyoBoardDemandTransition,
  applyTaiyoRr2ProtectTransition,
  calculateTaiyoBoardDemandMetrics,
  createEmptyTaiyoForwardState,
  normalizeTaiyoForwardState,
  type TaiyoForwardState,
} from "./taiyoForwardShadow";
import { analyzeOrderBook } from "./kabuStation";

const tradeDate = "2026-09-08";

function source(input: {
  id: string;
  time: string;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  board?: unknown;
  audit?: ForwardSourceEventInput["currentAudit"];
}): ForwardSourceEventInput {
  const close = input.close ?? 100;
  return {
    sourceEventId: input.id,
    candle: {
      symbol: "6976",
      tradeDate,
      candleTime: input.time,
      open: input.open ?? close,
      high: input.high ?? close,
      low: input.low ?? close,
      close,
      volume: 1_000,
    },
    board: input.board ?? null,
    currentAudit: input.audit,
  };
}

function pendingState(variant: TaiyoForwardState["variant"]): TaiyoForwardState {
  const state = createEmptyTaiyoForwardState(variant);
  state.tradeDate = tradeDate;
  state.dayOpen = 95;
  state.pending = {
    side: "long",
    triggerClose: 100,
    triggerTime: "10:00",
    triggerMaSlope2Pct: 0.1,
    triggerVolumeRatio: 1.2,
    triggerOpenMovePct: 5,
    signalSourceEventId: "trigger",
  };
  return state;
}

function pendingStateWithHistory(variant: TaiyoForwardState["variant"]): TaiyoForwardState {
  const state = pendingState(variant);
  state.candles = Array.from({ length: 20 }, (_, index) => ({
    time: `09:${String(25 + index).padStart(2, "0")}`,
    open: 100,
    high: 100.2,
    low: 99.8,
    close: 100,
    volume: 100,
  }));
  return state;
}

function freshAudit(overrides: Partial<NonNullable<ForwardSourceEventInput["currentAudit"]>> = {}) {
  return {
    engineSequence: 10,
    resultType: "no_signal",
    routeId: null,
    marginUsedBefore: 0,
    marginUsedAfter: 0,
    stateHashBefore: "before",
    stateHashAfter: "after",
    causalityStatus: "causal",
    causalityReason: "fixture",
    boardObservedAtMs: 10_000,
    relayAssembledAtMs: 10_100,
    relaySentAtMs: 10_200,
    cloudReceivedAtMs: 999_999_000,
    decisionStartedAtMs: 999_999_100,
    decisionCompletedAtMs: 999_999_200,
    ...overrides,
  };
}

function board(input: { bidQty?: number; askQty?: number; askLevels?: Array<{ price: number; qty: number }> } = {}) {
  const asks = input.askLevels ?? [
    { price: 102.1, qty: input.askQty ?? 100 },
    { price: 102.2, qty: input.askQty ?? 100 },
  ];
  return {
    asks,
    bids: [
      { price: 101.9, qty: input.bidQty ?? 150 },
      { price: 101.8, qty: input.bidQty ?? 150 },
    ],
    overSellQty: 0,
    underBuyQty: 0,
  };
}

describe("taiyo forward shadow pure transitions", () => {
  it("BPR1.30以上かつ大口売り壁なしの確認足だけで板需給案をentryする", () => {
    const transition = applyTaiyoBoardDemandTransition(
      pendingState("board_demand"),
      source({ id: "confirm", time: "10:01", open: 101, high: 103, low: 101, close: 102, board: board(), audit: freshAudit() }),
      "signal_quality",
    );
    expect(transition.resultType).toBe("entry");
    expect(transition.openedPosition).toMatchObject({ shares: 100, slPct: 0.5, tpPct: 1, boardPressureRatio: 1.5 });
    expect(transition.nextState.dailySlotConsumed).toBe(true);
  });

  it("BPR未達・板欠損・時刻欠損は日次枠を消費せず拒否する", () => {
    for (const input of [
      source({ id: "low-bpr", time: "10:01", open: 101, close: 102, board: board({ bidQty: 100, askQty: 100 }), audit: freshAudit() }),
      source({ id: "missing-board", time: "10:01", open: 101, close: 102, board: null, audit: freshAudit() }),
      source({ id: "missing-time", time: "10:01", open: 101, close: 102, board: board(), audit: undefined }),
    ]) {
      const transition = applyTaiyoBoardDemandTransition(pendingState("board_demand"), input, "signal_quality");
      expect(transition.resultType).toBe("rejected");
      expect(transition.nextState.dailySlotConsumed).toBe(false);
      expect(transition.nextState.position).toBeNull();
    }
  });

  it("平均の5倍以上の売り板を大口売り壁として拒否する", () => {
    const rawBoard = board({
      bidQty: 1_000,
      askLevels: [
        { price: 102.1, qty: 600 },
        { price: 102.2, qty: 10 },
        { price: 102.3, qty: 10 },
        { price: 102.4, qty: 10 },
        { price: 102.5, qty: 10 },
        { price: 102.6, qty: 10 },
      ],
    });
    const metrics = calculateTaiyoBoardDemandMetrics(rawBoard);
    expect(metrics?.largeAskWallDetected).toBe(true);
    const transition = applyTaiyoBoardDemandTransition(
      pendingState("board_demand"),
      source({ id: "wall", time: "10:01", open: 101, close: 102, board: rawBoard, audit: freshAudit() }),
      "signal_quality",
    );
    expect(transition.resultType).toBe("rejected");
    expect(transition.actions[0]).toMatchObject({ reason: "large_ask_wall_detected" });
  });

  it("実relay camelCaseとschema正規形PascalCaseを同じBPR・壁式で解釈する", () => {
    const camel = {
      asks: [{ price: 102, qty: 100 }, { price: 103, qty: 100 }],
      bids: [{ price: 101, qty: 130 }, { price: 100, qty: 130 }],
      overSellQty: 0,
      underBuyQty: 0,
    };
    const pascal = {
      Asks: [{ Price: 102, Qty: 100 }, { Price: 103, Qty: 100 }],
      Bids: [{ Price: 101, Qty: 130 }, { Price: 100, Qty: 130 }],
      OverSellQty: 0,
      UnderBuyQty: 0,
    };
    expect(calculateTaiyoBoardDemandMetrics(camel)).toEqual(calculateTaiyoBoardDemandMetrics(pascal));
    expect(calculateTaiyoBoardDemandMetrics(camel)?.boardPressureRatio).toBe(1.3);
    const wallBook = {
      symbol: "6976", symbolName: "fixture", currentPrice: 101, currentPriceTime: "09:46:00",
      asks: [{ price: 102, qty: 600 }, { price: 103, qty: 10 }, { price: 104, qty: 10 }, { price: 105, qty: 10 }, { price: 106, qty: 10 }, { price: 107, qty: 10 }],
      bids: [{ price: 101, qty: 1_000 }], marketOrderSellQty: 0, marketOrderBuyQty: 0,
      overSellQty: 0, underBuyQty: 0, vwap: 101, receivedAt: 0,
    };
    expect(calculateTaiyoBoardDemandMetrics(wallBook)?.largeAskWallDetected).toBe(true);
    expect(analyzeOrderBook(wallBook).some(signal => signal.type === "large_ask_wall")).toBe(true);
  });

  it("Windows/cloudの壁時計差を直接比較せず同一時計区間だけで鮮度判定する", () => {
    const transition = applyTaiyoBoardDemandTransition(
      pendingState("board_demand"),
      source({
        id: "skew",
        time: "10:01",
        open: 101,
        close: 102,
        board: board(),
        audit: freshAudit({
          cloudReceivedAtMs: 2_000_000_000,
          decisionStartedAtMs: 2_000_000_100,
          decisionCompletedAtMs: 2_000_000_200,
        }),
      }),
      "signal_quality",
    );
    expect(transition.resultType).toBe("entry");
    expect(transition.openedPosition?.boardAgeMs).toBe(300);
  });

  it("現行確認失敗時は当該足を新しい初動としてsame-candle再検出する", () => {
    const state = pendingStateWithHistory("rr2_protect");
    state.pending!.triggerClose = 102;
    const transition = applyTaiyoRr2ProtectTransition(
      state,
      source({ id: "confirm-failed-redetect", time: "09:46", open: 101, high: 101.6, low: 100.9, close: 101.5 }),
      "signal_quality",
    );
    expect(transition.resultType).toBe("pending");
    expect(transition.nextState.pending).toMatchObject({ triggerTime: "09:46", triggerClose: 101.5 });
    expect(transition.actions.map(action => action.type)).toEqual(["confirmation_rejected", "pending"]);
  });

  it("板需給拒否ではsame-candle再利用せず、次candleから後続候補を再探索する", () => {
    const rejected = applyTaiyoBoardDemandTransition(
      pendingStateWithHistory("board_demand"),
      source({ id: "bpr-reject", time: "09:46", open: 101, high: 102.1, low: 100.9, close: 102, board: board({ bidQty: 100, askQty: 100 }), audit: freshAudit() }),
      "signal_quality",
    );
    expect(rejected.resultType).toBe("rejected");
    expect(rejected.nextState.pending).toBeNull();
    expect(rejected.nextState.dailySlotConsumed).toBe(false);
    const next = applyTaiyoBoardDemandTransition(
      rejected.nextState,
      source({ id: "new-trigger", time: "09:47", open: 102, high: 103.1, low: 101.9, close: 103 }),
      "signal_quality",
    );
    expect(next.resultType).toBe("pending");
    expect(next.nextState.pending).toMatchObject({ triggerTime: "09:47", signalSourceEventId: "new-trigger" });
  });

  it("利益保護は準備足で決済せず、次イベントで+0.16%へ戻れば決済する", () => {
    let state = pendingState("rr2_protect");
    const entry = applyTaiyoRr2ProtectTransition(state, source({ id: "entry", time: "10:01", open: 100.5, close: 101 }), "signal_quality");
    expect(entry.resultType).toBe("entry");
    state = entry.nextState;
    const trigger = 101 * 1.0024;
    const protection = 101 * 1.0016;
    const armed = applyTaiyoRr2ProtectTransition(
      state,
      source({ id: "arm", time: "10:02", open: protection, high: trigger + 0.01, low: protection - 0.01, close: trigger }),
      "signal_quality",
    );
    expect(armed.resultType).toBe("hold");
    expect(armed.nextState.position?.profitProtectionArmedAtSourceEventId).toBe("arm");
    const exited = applyTaiyoRr2ProtectTransition(
      armed.nextState,
      source({ id: "protect", time: "10:03", open: protection + 0.02, high: protection + 0.03, low: protection - 0.01, close: protection }),
      "signal_quality",
    );
    expect(exited.closedPosition?.exitReason).toBe("profit_protection");
    expect(exited.closedPosition?.exitPrice).toBeCloseTo(protection, 8);
  });

  it("同一足ではSLを利益保護・TPより優先し、窓下げ始値を使う", () => {
    let state = pendingState("rr2_protect");
    state = applyTaiyoRr2ProtectTransition(state, source({ id: "entry", time: "10:01", open: 100.5, close: 101 }), "signal_quality").nextState;
    state.position!.profitProtectionArmedAtSourceEventId = "prior";
    const stopLine = 101 * 0.992;
    const transition = applyTaiyoRr2ProtectTransition(
      state,
      source({ id: "gap", time: "10:02", open: stopLine - 1, high: 103, low: stopLine - 1.2, close: 101 }),
      "signal_quality",
    );
    expect(transition.closedPosition).toMatchObject({ exitReason: "stop_loss", exitPrice: stopLine - 1 });
  });

  it("30分到達と前場終了帯欠損後の最初の受信で必ず決済する", () => {
    const timeState = pendingState("board_demand");
    timeState.position = {
      side: "long", signalSourceEventId: "signal", entrySourceEventId: "entry",
      signalTime: "09:59", entryTime: "10:00", theoreticalSignalPrice: 100, entryPrice: 100,
      shares: 100, slPct: 0.5, tpPct: 1, executionProxyKind: "confirmation_candle_close",
      boardPressureRatio: 1.3, largeAskWallRatio: 1, boardAgeMs: 100, profitProtectionArmedAtSourceEventId: null,
    };
    expect(applyTaiyoBoardDemandTransition(
      timeState,
      source({ id: "time-exit", time: "10:30", open: 100, high: 100.2, low: 99.8, close: 100.1 }),
      "signal_quality",
    ).closedPosition?.exitReason).toBe("time_exit");

    const sessionState = pendingState("board_demand");
    sessionState.position = {
      side: "long", signalSourceEventId: "signal", entrySourceEventId: "lunch-entry",
      signalTime: "11:19", entryTime: "11:20", theoreticalSignalPrice: 100, entryPrice: 100,
      shares: 100, slPct: 0.5, tpPct: 1, executionProxyKind: "confirmation_candle_close",
      boardPressureRatio: 1.3, largeAskWallRatio: 1, boardAgeMs: 100, profitProtectionArmedAtSourceEventId: null,
    };
    expect(applyTaiyoBoardDemandTransition(
      sessionState,
      source({ id: "after-lunch-gap", time: "12:30", open: 100, high: 100.2, low: 99.8, close: 100 }),
      "signal_quality",
    ).closedPosition?.exitReason).toBe("session_exit");
  });

  it("取引日変更時は前日のpending・position・日次枠を引き継がない", () => {
    const prior = pendingState("rr2_protect");
    prior.dailySlotConsumed = true;
    prior.position = {
      side: "long", signalSourceEventId: "signal", entrySourceEventId: "entry",
      signalTime: "10:00", entryTime: "10:01", theoreticalSignalPrice: 100, entryPrice: 100,
      shares: 100, slPct: 0.8, tpPct: 1.6, executionProxyKind: "confirmation_candle_close",
      boardPressureRatio: null, largeAskWallRatio: null, boardAgeMs: null, profitProtectionArmedAtSourceEventId: "arm",
    };
    const nextDayInput = source({ id: "next-day", time: "09:00", close: 100 });
    nextDayInput.candle.tradeDate = "2026-09-09";
    const transition = applyTaiyoRr2ProtectTransition(prior, nextDayInput, "signal_quality");
    expect(transition.nextState).toMatchObject({ tradeDate: "2026-09-09", pending: null, position: null, dailySlotConsumed: false });
  });

  it("pendingと利益保護準備状態をJSON再起動後も復元する", () => {
    const pending = pendingState("board_demand");
    const pendingRestored = normalizeTaiyoForwardState(JSON.parse(JSON.stringify(pending)), "board_demand", tradeDate);
    expect(pendingRestored).toEqual(pending);
    const protectedState = pendingState("rr2_protect");
    protectedState.position = {
      side: "long",
      signalSourceEventId: "signal",
      entrySourceEventId: "entry",
      signalTime: "10:00",
      entryTime: "10:01",
      theoreticalSignalPrice: 101,
      entryPrice: 101,
      shares: 100,
      slPct: 0.8,
      tpPct: 1.6,
      executionProxyKind: "confirmation_candle_close",
      boardPressureRatio: null,
      largeAskWallRatio: null,
      boardAgeMs: null,
      profitProtectionArmedAtSourceEventId: "arm",
    };
    const restored = normalizeTaiyoForwardState(JSON.parse(JSON.stringify(protectedState)), "rr2_protect", tradeDate);
    expect(restored.position?.profitProtectionArmedAtSourceEventId).toBe("arm");
  });
});
