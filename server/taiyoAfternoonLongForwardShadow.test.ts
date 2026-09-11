import { describe, expect, it } from "vitest";
import type { ForwardSourceEventInput } from "./forwardShadow";
import {
  TAIYO_AFTERNOON_LONG_RR2_SPEC,
  TAIYO_AFTERNOON_LONG_WINRATE_SPEC,
  applyTaiyoAfternoonLongRr2Transition,
  applyTaiyoAfternoonLongWinrateTransition,
  createEmptyTaiyoAfternoonLongState,
  type TaiyoAfternoonLongState,
  type TaiyoAfternoonLongVariant,
} from "./taiyoAfternoonLongForwardShadow";

function event(id: string, time: string, input: Partial<ForwardSourceEventInput["candle"]> = {}): ForwardSourceEventInput {
  return {
    sourceEventId: id,
    candle: {
      symbol: "6976",
      tradeDate: "2026-09-14",
      candleTime: time,
      open: input.open ?? 96,
      high: input.high ?? 96.2,
      low: input.low ?? 95.8,
      close: input.close ?? 96,
      volume: input.volume ?? 100,
    },
    board: null,
  };
}

function seed(variant: TaiyoAfternoonLongVariant) {
  let state = createEmptyTaiyoAfternoonLongState(variant);
  const apply = variant === "rr2_10" ? applyTaiyoAfternoonLongRr2Transition : applyTaiyoAfternoonLongWinrateTransition;
  state = apply(state, event("open", "09:00", { open: 100, high: 100, low: 99.8, close: 100 }), "signal_quality").nextState;
  for (let index = 0; index < 20; index += 1) {
    const hour = index < 10 ? "11" : "12";
    const minute = index < 10 ? 40 + index : 40 + index - 10;
    state = apply(state, event(`seed-${index}`, `${hour}:${minute}`, {
      open: 96,
      high: 96.2,
      low: index === 0 ? 95 : 95.8,
      close: 96,
      volume: 100,
    }), "signal_quality").nextState;
  }
  return state;
}

function applyFor(variant: TaiyoAfternoonLongVariant, state: TaiyoAfternoonLongState, source: ForwardSourceEventInput) {
  return variant === "rr2_10"
    ? applyTaiyoAfternoonLongRr2Transition(state, source, "signal_quality")
    : applyTaiyoAfternoonLongWinrateTransition(state, source, "signal_quality");
}

describe("6976後場反転LONG A/B", () => {
  it("Aは前場2%以上下落・安値1%反発・5本高値更新後の次イベント確認で10分2R LONGに入る", () => {
    let state = seed("rr2_10");
    const pending = applyFor("rr2_10", state, event("trigger", "13:00", {
      open: 96, high: 97.1, low: 95.9, close: 97, volume: 200,
    }));
    expect(pending.resultType).toBe("pending");
    const entered = applyFor("rr2_10", pending.nextState, event("confirm", "13:01", {
      open: 97, high: 97.3, low: 96.9, close: 97.2, volume: 100,
    }));
    expect(entered.openedPosition).toMatchObject({
      side: "long", entryPrice: 97.2, shares: 100,
      slPct: 0.8, tpPct: 1.6,
    });
    const timed = applyFor("rr2_10", entered.nextState, event("time", "13:11", {
      open: 97.3, high: 97.4, low: 97.1, close: 97.25,
    }));
    expect(timed.closedPosition).toMatchObject({ exitReason: "time_exit", exitPrice: 97.25 });
  });

  it("Bは前場方向を要求せず安値1.5%回復を確認し、0.3/1.2・30分で追跡する", () => {
    let state = seed("recovery_winrate");
    const pending = applyFor("recovery_winrate", state, event("trigger", "13:00", {
      open: 96, high: 97.1, low: 95.9, close: 97, volume: 200,
    }));
    const entered = applyFor("recovery_winrate", pending.nextState, event("confirm", "13:01", {
      open: 97, high: 97.45, low: 96.9, close: 97.4,
    }));
    expect(entered.openedPosition).toMatchObject({ slPct: 1.2, tpPct: 0.3 });
    const target = 97.4 * 1.003;
    const exited = applyFor("recovery_winrate", entered.nextState, event("tp", "13:02", {
      open: 97.4, high: target + 0.01, low: 97.3, close: 97.5,
    }));
    expect(exited.closedPosition).toMatchObject({ exitReason: "take_profit", exitPrice: target });
  });

  it("同一足でSLとTPへ届いた場合はSLを優先し、窓下落は不利な始値を使う", () => {
    let state = seed("rr2_10");
    state = applyFor("rr2_10", state, event("trigger", "13:00", {
      open: 96, high: 97.1, low: 95.9, close: 97, volume: 200,
    })).nextState;
    state = applyFor("rr2_10", state, event("confirm", "13:01", {
      open: 97, high: 97.3, low: 96.9, close: 97.2,
    })).nextState;
    const exited = applyFor("rr2_10", state, event("both", "13:02", {
      open: 95, high: 100, low: 94.8, close: 98,
    }));
    expect(exited.closedPosition).toMatchObject({ exitReason: "stop_loss", exitPrice: 95 });
  });

  it("確認失敗は日次枠を消費せず、その失敗足自体では再検出しない", () => {
    let state = seed("recovery_winrate");
    state = applyFor("recovery_winrate", state, event("trigger", "13:00", {
      open: 96, high: 97.1, low: 95.9, close: 97, volume: 200,
    })).nextState;
    const rejected = applyFor("recovery_winrate", state, event("failed", "13:01", {
      open: 97.4, high: 98, low: 97.2, close: 97.3, volume: 200,
    }));
    expect(rejected.resultType).toBe("rejected");
    expect(rejected.nextState.pending).toBeNull();
    expect(rejected.nextState.dailySlotConsumed).toBe(false);
  });

  it("Aは2Rを守り、Bの例外は自動採用禁止として仕様に固定される", () => {
    expect(TAIYO_AFTERNOON_LONG_RR2_SPEC.exit.tpPct).toBeGreaterThanOrEqual(TAIYO_AFTERNOON_LONG_RR2_SPEC.exit.slPct * 2);
    expect(TAIYO_AFTERNOON_LONG_WINRATE_SPEC.riskRewardPolicy).toMatchObject({
      exception: "user_approved_forward_shadow_tp_below_2r_2026-09-12",
      automaticAdoption: false,
    });
    expect(TAIYO_AFTERNOON_LONG_RR2_SPEC.orderInstructionConnection).toBe(false);
    expect(TAIYO_AFTERNOON_LONG_WINRATE_SPEC.orderInstructionConnection).toBe(false);
  });
});
