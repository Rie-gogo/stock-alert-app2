import { describe, expect, it } from "vitest";
import type { ForwardSourceEventInput } from "./forwardShadow";
import {
  SUMCO_TIME_15_SPEC,
  SUMCO_VOLUME_110_SPEC,
  applySumcoTime15Transition,
  applySumcoVolume110Transition,
  createEmptySumcoForwardState,
  normalizeSumcoForwardState,
} from "./sumcoForwardShadow";

function source(input: Partial<ForwardSourceEventInput["candle"]> & { candleTime: string; sourceEventId?: string }): ForwardSourceEventInput {
  return {
    sourceEventId: input.sourceEventId ?? `sumco-${input.candleTime}`,
    candle: {
      symbol: "3436",
      tradeDate: input.tradeDate ?? "2026-09-08",
      candleTime: input.candleTime,
      open: input.open ?? 100,
      high: input.high ?? 100.2,
      low: input.low ?? 99.8,
      close: input.close ?? 100,
      volume: input.volume ?? 100,
    },
    board: null,
  };
}

function warmup(variant: "volume_110" | "time_15") {
  const state = createEmptySumcoForwardState(variant);
  state.tradeDate = "2026-09-08";
  for (let minute = 0; minute < 30; minute += 1) {
    state.candles.push({ time: `09:${String(minute).padStart(2, "0")}`, open: 100, high: 100.2, low: 99.8, close: 100, volume: 100 });
  }
  return state;
}

describe("3436 VOLUME110/TIME15 pure forward shadow", () => {
  it("2案のTPはSLの2倍で注文経路へ接続しない", () => {
    for (const spec of [SUMCO_VOLUME_110_SPEC, SUMCO_TIME_15_SPEC]) {
      expect(spec.exit.tpPct).toBe(spec.exit.slPct * 2);
      expect(spec.orderInstructionConnection).toBe(false);
    }
  });

  it("VOLUME110は出来高1.10倍以上だけ入り、拒否後は日次枠を消費せず再探索する", () => {
    let state = warmup("volume_110");
    const rejected = applySumcoVolume110Transition(state, source({ candleTime: "09:30", open: 100, high: 100.1, low: 98.4, close: 98.5, volume: 109 }), "signal_quality");
    expect(rejected.resultType).toBe("rejected");
    expect(rejected.nextState.dailySlotConsumed).toBe(false);
    expect(rejected.actions[0]).toMatchObject({ type: "volume_filter_rejected", nextCandleSearchAllowed: true });

    state = rejected.nextState;
    const entered = applySumcoVolume110Transition(state, source({ candleTime: "09:31", open: 98.5, high: 98.6, low: 96.9, close: 97, volume: 120 }), "signal_quality");
    expect(entered.resultType).toBe("entry");
    expect(entered.openedPosition).toMatchObject({ side: "short", entryPrice: 97, shares: 100, slPct: 0.8, tpPct: 1.6 });
  });

  it("TIME15は現行出来高1.0倍の入口を維持する", () => {
    const entered = applySumcoTime15Transition(
      warmup("time_15"),
      source({ candleTime: "09:30", open: 100, high: 100.1, low: 98.4, close: 98.5, volume: 100 }),
      "signal_quality",
    );
    expect(entered.resultType).toBe("entry");
    expect(entered.openedPosition).toMatchObject({ entryPrice: 98.5, shares: 100, slPct: 0.8, tpPct: 1.6 });
  });

  it("現行エンジン同様に30本未満のウォームアップでは入口判定しない", () => {
    const state = createEmptySumcoForwardState("time_15");
    state.tradeDate = "2026-09-08";
    for (let minute = 0; minute < 20; minute += 1) {
      state.candles.push({ time: `09:${String(minute).padStart(2, "0")}`, open: 100, high: 100.2, low: 99.8, close: 100, volume: 100 });
    }
    const result = applySumcoTime15Transition(
      state,
      source({ candleTime: "09:30", open: 100, high: 100.1, low: 98.4, close: 98.5, volume: 100 }),
      "signal_quality",
    );
    expect(result.resultType).toBe("no_signal");
    expect(result.openedPosition).toBeNull();
  });

  it("SHORT出口はSLを優先し、窓上げではより不利な始値を使う", () => {
    const entered = applySumcoTime15Transition(
      warmup("time_15"),
      source({ candleTime: "09:30", open: 100, high: 100.1, low: 98.4, close: 98.5, volume: 100 }),
      "signal_quality",
    );
    const exited = applySumcoTime15Transition(
      entered.nextState,
      source({ candleTime: "09:31", open: 100, high: 100.2, low: 96, close: 98 }),
      "signal_quality",
    );
    expect(exited.closedPosition).toMatchObject({ exitReason: "stop_loss", exitPrice: 100 });
    expect(exited.closedPosition?.pnl).toBe(-150);
  });

  it("15分境界の足が欠けても次の受信足終値で時間決済する", () => {
    const entered = applySumcoVolume110Transition(
      warmup("volume_110"),
      source({ candleTime: "09:30", open: 100, high: 100.1, low: 98.4, close: 98.5, volume: 110 }),
      "signal_quality",
    );
    const exited = applySumcoVolume110Transition(
      entered.nextState,
      source({ candleTime: "09:47", open: 98.4, high: 98.6, low: 98, close: 98.2 }),
      "signal_quality",
    );
    expect(exited.closedPosition).toMatchObject({ exitReason: "time_exit", exitPrice: 98.2 });
  });

  it("前場終了足欠損で次が12:30でも後場へ持ち越さず決済する", () => {
    const entered = applySumcoTime15Transition(
      warmup("time_15"),
      source({ candleTime: "11:00", open: 100, high: 100.1, low: 98.4, close: 98.5, volume: 100 }),
      "signal_quality",
    );
    const exited = applySumcoTime15Transition(
      entered.nextState,
      source({ candleTime: "12:30", open: 98.4, high: 98.6, low: 98, close: 98.2 }),
      "signal_quality",
    );
    expect(exited.closedPosition).toMatchObject({ exitReason: "session_exit", exitPrice: 98.2 });
  });

  it("JSON再起動復元と日次リセットで状態を混同しない", () => {
    const entered = applySumcoTime15Transition(
      warmup("time_15"),
      source({ candleTime: "09:30", open: 100, high: 100.1, low: 98.4, close: 98.5, volume: 100 }),
      "signal_quality",
    );
    const restored = normalizeSumcoForwardState(JSON.parse(JSON.stringify(entered.nextState)), "time_15", "2026-09-08");
    expect(restored.position?.entryPrice).toBe(98.5);
    const nextDay = normalizeSumcoForwardState(restored, "time_15", "2026-09-09");
    expect(nextDay.position).toBeNull();
    expect(nextDay.dailySlotConsumed).toBe(false);
    expect(nextDay.tradeDate).toBe("2026-09-09");
  });

  it("collection開始前は判断を記録して入口を開かない", () => {
    const state = warmup("time_15");
    state.tradeDate = "2026-09-04";
    const rejected = applySumcoTime15Transition(
      state,
      source({ tradeDate: "2026-09-04", candleTime: "09:30", open: 100, high: 100.1, low: 98.4, close: 98.5, volume: 100 }),
      "signal_quality",
    );
    expect(rejected.resultType).toBe("rejected");
    expect(rejected.openedPosition).toBeNull();
  });
});
