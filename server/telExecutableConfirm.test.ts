import { describe, expect, it } from "vitest";
import type { ForwardSourceEventInput } from "./forwardShadow";
import {
  TEL_EXECUTABLE_CONFIRM_VERSION,
  applyTelExecutableConfirmTransition,
  createEmptyTelExecutableConfirmState,
  type TelExecutableConfirmState,
} from "./telExecutableConfirm";

function candle(time: string, close = 100, overrides: Partial<ForwardSourceEventInput["candle"]> = {}): ForwardSourceEventInput["candle"] {
  return {
    symbol: "8035", tradeDate: "2026-09-07", candleTime: time,
    open: close - 0.1, high: close + 0.2, low: close - 0.2, close, volume: 100,
    ...overrides,
  };
}

function input(id: string, time: string, close: number, boardPrice: number | null, overrides: Partial<ForwardSourceEventInput["candle"]> = {}): ForwardSourceEventInput {
  return { sourceEventId: id, candle: candle(time, close, overrides), board: boardPrice === null ? null : { currentPrice: boardPrice } };
}

function signalReadyState(): TelExecutableConfirmState {
  const state = createEmptyTelExecutableConfirmState();
  state.tradeDate = "2026-09-07";
  state.candles = Array.from({ length: 20 }, (_, index) => ({
    time: `09:${String(40 + index).padStart(2, "0")}`,
    open: 100, high: 100.2, low: 99.8, close: 100, volume: 100,
  }));
  return state;
}

describe("8035 次イベント・ブレイク継続確認A案", () => {
  it("別strategyVersionで、次イベント板が元高値を維持し0.10%不利以内の時だけ入る", () => {
    expect(TEL_EXECUTABLE_CONFIRM_VERSION).toBe("candidate-8035-executable-confirm-v1");
    const signal = applyTelExecutableConfirmTransition(signalReadyState(), input("s1", "10:00", 101, 101, {
      open: 100, high: 101.1, low: 99.9, volume: 200,
    }), "signal_quality");
    expect(signal.resultType).toBe("pending");
    expect(signal.nextState.pending?.breakoutLevel).toBe(100.2);
    const entry = applyTelExecutableConfirmTransition(signal.nextState, input("s2", "10:01", 101.1, 101.05), "signal_quality");
    expect(entry.resultType).toBe("entry");
    expect(entry.openedPosition).toMatchObject({ entryPrice: 101.05, shares: 100, signalSourceEventId: "s1" });
  });

  it("レンジ復帰・0.10%超不利・板欠損を拒否し、同じ初動を同イベントで再利用しない", () => {
    const pending = signalReadyState();
    pending.pending = {
      side: "long", signalSourceEventId: "origin", signalTime: "10:00",
      theoreticalSignalPrice: 101, breakoutLevel: 100.2, metrics: {},
    };
    for (const [id, price, reason] of [
      ["range", 100.1, "breakout_not_maintained_at_next_event"],
      ["gap", 101.2, "adverse_entry_gap_over_010pct"],
      ["missing", null, "executable_price_proxy_unavailable"],
    ] as const) {
      const state = structuredClone(pending);
      const result = applyTelExecutableConfirmTransition(state, input(id, "10:01", 101.2, price, { high: 101.3, volume: 300 }), "signal_quality");
      expect(result.resultType).toBe("rejected");
      expect(result.actions[0]).toMatchObject({ reason, dailySlotConsumed: false, originalImpulseReusable: false });
      expect(result.nextState.pending).toBeNull();
      expect(result.nextState.dailySlotConsumed).toBe(false);
    }
  });

  it("SLをTPより優先し、窓開けは不利な当足始値で決済する", () => {
    const state = createEmptyTelExecutableConfirmState();
    state.tradeDate = "2026-09-07";
    state.dailySlotConsumed = true;
    state.position = {
      side: "long", signalSourceEventId: "s1", entrySourceEventId: "s2", signalTime: "10:00", entryTime: "10:01",
      theoreticalSignalPrice: 100, entryPrice: 100, breakoutLevel: 99.5, adverseEntryPct: 0,
      shares: 100, slPct: 0.6, tpPct: 1.2,
    };
    const result = applyTelExecutableConfirmTransition(state, input("s3", "10:02", 100, 100, {
      open: 99, low: 98.9, high: 102,
    }), "signal_quality");
    expect(result.closedPosition).toMatchObject({ exitReason: "stop_loss", exitPrice: 99 });
  });
});
