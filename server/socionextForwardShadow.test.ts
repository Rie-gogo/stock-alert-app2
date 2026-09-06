import { describe, expect, it } from "vitest";
import {
  SOCIONEXT_CONFIRM_STRENGTH_SPEC,
  SOCIONEXT_INITIAL_STRENGTH_SPEC,
  applySocionextConfirmationStrengthTransition,
  applySocionextInitialStrengthTransition,
  createEmptySocionextForwardState,
  normalizeSocionextForwardState,
  type SocionextForwardState,
} from "./socionextForwardShadow";
import type { ForwardSourceEventInput } from "./forwardShadow";

function timeAt(minute: number) {
  const hour = 9 + Math.floor(minute / 60);
  const min = minute % 60;
  return `${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

function event(input: {
  id: string;
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  date?: string;
}): ForwardSourceEventInput {
  return {
    sourceEventId: input.id,
    candle: {
      symbol: "6526",
      tradeDate: input.date ?? "2026-09-07",
      candleTime: input.time,
      open: input.open,
      high: input.high,
      low: input.low,
      close: input.close,
      volume: input.volume ?? 100,
    },
    board: null,
  };
}

function seededState(variant: "initial_strength" = "initial_strength") {
  const state = createEmptySocionextForwardState(variant);
  state.tradeDate = "2026-09-07";
  for (let minute = 0; minute < 28; minute += 1) {
    state.candles.push({ time: timeAt(minute), open: minute === 0 ? 100 : 99.9, high: 99.95, low: 99.85, close: 99.9, volume: 100 });
  }
  state.candles.push({ time: "09:28", open: 99.95, high: 100.06, low: 99.9, close: 100.05, volume: 100 });
  state.candles.push({ time: "09:29", open: 100.05, high: 100.15, low: 100, close: 100.14, volume: 100 });
  state.dayOpen = 100;
  return state;
}

function confirmationSeededState() {
  const state = seededState();
  state.variant = "confirmation_strength";
  return state;
}

function strongPendingState() {
  const initial = seededState();
  return applySocionextInitialStrengthTransition(initial, event({
    id: "a-trigger",
    time: "09:30",
    open: 100.2,
    high: 100.55,
    low: 100.15,
    close: 100.5,
    volume: 200,
  }), "signal_quality").nextState;
}

describe("6526 A initial-strength forward shadow", () => {
  it("収集開始日前は判定・取引を作らない", () => {
    const rejected = applySocionextInitialStrengthTransition(createEmptySocionextForwardState("initial_strength"), event({
      id: "before-collection",
      date: "2026-09-04",
      time: "09:30",
      open: 100,
      high: 101,
      low: 99.9,
      close: 100.8,
      volume: 300,
    }), "signal_quality");
    expect(rejected.resultType).toBe("rejected");
    expect(rejected.openedPosition).toBeNull();
    expect(rejected.actions).toContainEqual(expect.objectContaining({ type: "not_collecting" }));
  });

  it("弱い初動候補を検出した時点で日次探索を終了し、後続候補を無視する", () => {
    const weak = applySocionextInitialStrengthTransition(seededState(), event({
      id: "a-weak",
      time: "09:30",
      open: 100.1,
      high: 100.22,
      low: 100.05,
      close: 100.2,
      volume: 200,
    }), "signal_quality");
    expect(weak.resultType).toBe("rejected");
    expect(weak.nextState.dailySearchStopped).toBe(true);
    expect(weak.nextState.dailySlotConsumed).toBe(false);
    expect(weak.actions).toContainEqual(expect.objectContaining({ type: "initial_strength_daily_stop", laterCandidatesIgnored: true }));

    const later = applySocionextInitialStrengthTransition(weak.nextState, event({
      id: "a-later-strong",
      time: "09:31",
      open: 100.2,
      high: 101.1,
      low: 100.2,
      close: 101,
      volume: 300,
    }), "signal_quality");
    expect(later.openedPosition).toBeNull();
    expect(later.nextState.pending).toBeNull();
    expect(later.nextState.dailySearchStopped).toBe(true);
  });

  it("+0.25%以上の初動をpendingにし、次足確認終値で100株LONGへ入る", () => {
    const pending = strongPendingState();
    expect(pending.pending?.triggerOpenMovePct).toBeGreaterThanOrEqual(0.25);

    const entered = applySocionextInitialStrengthTransition(pending, event({
      id: "a-confirm",
      time: "09:31",
      open: 100.5,
      high: 100.65,
      low: 100.45,
      close: 100.6,
    }), "signal_quality");
    expect(entered.resultType).toBe("entry");
    expect(entered.openedPosition).toEqual(expect.objectContaining({
      entryPrice: 100.6,
      shares: 100,
      slPct: 0.25,
      tpPct: 0.5,
    }));
    expect(entered.nextState.dailySlotConsumed).toBe(true);
  });

  it("同一足でSLとTPへ到達した場合はSLを優先し、窓下げは不利な始値で決済する", () => {
    const pending = strongPendingState();
    const entered = applySocionextInitialStrengthTransition(pending, event({ id: "a-confirm", time: "09:31", open: 100.5, high: 100.65, low: 100.45, close: 100.6 }), "signal_quality");
    const exited = applySocionextInitialStrengthTransition(entered.nextState, event({ id: "a-gap", time: "09:32", open: 100, high: 102, low: 99.8, close: 101 }), "signal_quality");
    expect(exited.closedPosition?.exitReason).toBe("stop_loss");
    expect(exited.closedPosition?.exitPrice).toBe(100);
  });

  it("20分到達は確定足終値、11:27欠損後12:30受信は前場越境決済する", () => {
    const positionState = strongPendingState();
    const entered = applySocionextInitialStrengthTransition(positionState, event({ id: "a-confirm", time: "09:31", open: 100.5, high: 100.65, low: 100.45, close: 100.6 }), "signal_quality");
    const timed = applySocionextInitialStrengthTransition(entered.nextState, event({ id: "a-time", time: "09:51", open: 100.62, high: 100.7, low: 100.5, close: 100.61 }), "signal_quality");
    expect(timed.closedPosition).toEqual(expect.objectContaining({ exitReason: "time_exit", exitPrice: 100.61 }));

    const morningState = structuredClone(entered.nextState) as SocionextForwardState;
    morningState.position = { ...entered.openedPosition! };
    const session = applySocionextInitialStrengthTransition(morningState, event({ id: "a-lunch", time: "12:30", open: 101, high: 102, low: 99, close: 100.4 }), "signal_quality");
    expect(session.closedPosition).toEqual(expect.objectContaining({ exitReason: "session_exit", exitPrice: 100.4 }));
  });

  it("JSON再起動復元と翌日の日次停止リセットを維持する", () => {
    const weak = applySocionextInitialStrengthTransition(seededState(), event({ id: "a-weak", time: "09:30", open: 100.1, high: 100.22, low: 100.05, close: 100.2, volume: 200 }), "signal_quality");
    const restored = normalizeSocionextForwardState(JSON.parse(JSON.stringify(weak.nextState)), "initial_strength", "2026-09-07");
    expect(restored.dailySearchStopped).toBe(true);
    const nextDay = normalizeSocionextForwardState(restored, "initial_strength", "2026-09-08");
    expect(nextDay.dailySearchStopped).toBe(false);
    expect(nextDay.candles).toEqual([]);
  });

  it("A案は注文接続を持たず名目TPがSLの2倍である", () => {
    expect(SOCIONEXT_INITIAL_STRENGTH_SPEC.orderInstructionConnection).toBe(false);
    expect(SOCIONEXT_INITIAL_STRENGTH_SPEC.exit.tpPct).toBe(SOCIONEXT_INITIAL_STRENGTH_SPEC.exit.slPct * 2);
  });
});

describe("6526 B confirmation-strength forward shadow", () => {
  function bPendingState() {
    return applySocionextConfirmationStrengthTransition(confirmationSeededState(), event({
      id: "b-trigger",
      time: "09:30",
      open: 100.2,
      high: 100.55,
      low: 100.15,
      close: 100.5,
      volume: 200,
    }), "signal_quality").nextState;
  }

  it("確認終値は上回るが上昇率+0.075%未満なら日次終了し後続を無視する", () => {
    const weak = applySocionextConfirmationStrengthTransition(bPendingState(), event({
      id: "b-weak-confirm",
      time: "09:31",
      open: 100.5,
      high: 100.57,
      low: 100.49,
      close: 100.55,
    }), "signal_quality");
    expect(weak.resultType).toBe("rejected");
    expect(weak.nextState.dailySearchStopped).toBe(true);
    expect(weak.nextState.dailySlotConsumed).toBe(false);
    expect(weak.actions).toContainEqual(expect.objectContaining({ type: "confirmation_strength_daily_stop", laterCandidatesIgnored: true }));

    const later = applySocionextConfirmationStrengthTransition(weak.nextState, event({
      id: "b-later-strong",
      time: "09:32",
      open: 100.6,
      high: 101.3,
      low: 100.5,
      close: 101.2,
      volume: 300,
    }), "signal_quality");
    expect(later.nextState.pending).toBeNull();
    expect(later.openedPosition).toBeNull();
  });

  it("確認上昇率+0.075%以上ならSL0.35%・TP0.70%で100株LONGへ入る", () => {
    const entered = applySocionextConfirmationStrengthTransition(bPendingState(), event({
      id: "b-confirm",
      time: "09:31",
      open: 100.5,
      high: 100.7,
      low: 100.45,
      close: 100.6,
    }), "signal_quality");
    expect(entered.resultType).toBe("entry");
    expect(entered.openedPosition).toEqual(expect.objectContaining({
      entryPrice: 100.6,
      shares: 100,
      slPct: 0.35,
      tpPct: 0.7,
    }));
  });

  it("B案も同一足SL優先と窓下げ不利始値を共有する", () => {
    const entered = applySocionextConfirmationStrengthTransition(bPendingState(), event({
      id: "b-confirm",
      time: "09:31",
      open: 100.5,
      high: 100.7,
      low: 100.45,
      close: 100.6,
    }), "signal_quality");
    const exited = applySocionextConfirmationStrengthTransition(entered.nextState, event({
      id: "b-gap",
      time: "09:32",
      open: 100,
      high: 102,
      low: 99.8,
      close: 101,
    }), "signal_quality");
    expect(exited.closedPosition).toEqual(expect.objectContaining({ exitReason: "stop_loss", exitPrice: 100 }));
  });

  it("確認失敗は日次終了せずsame-candle再検出を許す", () => {
    const failed = applySocionextConfirmationStrengthTransition(bPendingState(), event({
      id: "b-confirm-failed",
      time: "09:31",
      open: 100.5,
      high: 100.55,
      low: 100.3,
      close: 100.4,
      volume: 200,
    }), "signal_quality");
    expect(failed.nextState.dailySearchStopped).toBe(false);
    expect(failed.actions).toContainEqual(expect.objectContaining({ type: "confirmation_rejected", sameCandleRedetectionAllowed: true }));
  });

  it("B案は注文接続を持たず名目TPがSLの2倍である", () => {
    expect(SOCIONEXT_CONFIRM_STRENGTH_SPEC.orderInstructionConnection).toBe(false);
    expect(SOCIONEXT_CONFIRM_STRENGTH_SPEC.exit.tpPct).toBe(SOCIONEXT_CONFIRM_STRENGTH_SPEC.exit.slPct * 2);
  });
});
