import { describe, expect, it } from "vitest";
import {
  applyTelExecutableConfirmTransition,
  calculateClockSafeBoardAge,
  calculateDepthVwap,
  createEmptyTelExecutableConfirmState,
} from "./telExecutableConfirmDepth";

function pendingState() {
  const state = createEmptyTelExecutableConfirmState();
  state.tradeDate = "2026-09-07";
  state.pending = {
    side: "long",
    signalSourceEventId: "signal:1",
    signalTime: "10:00",
    theoreticalSignalPrice: 100,
    breakoutLevel: 99.9,
    metrics: {},
  };
  return state;
}

function input(decisionAtMs = 4_000) {
  return {
    sourceEventId: "confirm:1",
    candle: { symbol: "8035", tradeDate: "2026-09-07", candleTime: "10:01", open: 100, high: 101, low: 99, close: 100, volume: 1_000 },
    board: { asks: [{ price: 100.04, qty: 40 }, { price: 100.08, qty: 80 }], bids: [{ price: 99.98, qty: 100 }] },
    currentAudit: {
      relayAssembledAtMs: 1_000,
      relaySentAtMs: 1_200,
      cloudReceivedAtMs: 3_000,
      boardObservedAtMs: 900,
      decisionCompletedAtMs: decisionAtMs,
    },
  } as any;
}

describe("8035板depth VWAP改善案A v2", () => {
  it("100株LONGはaskを数量分消費したVWAPで入り、時刻・鮮度を保存する", () => {
    const depth = calculateDepthVwap({ board: input().board, side: "long", shares: 100 });
    expect(depth?.price).toBeCloseTo(100.064, 6);
    const result = applyTelExecutableConfirmTransition(pendingState(), input(), "signal_quality");
    expect(result.resultType).toBe("entry");
    expect(result.openedPosition).toMatchObject({
      executionProxyKind: "ask_depth_vwap",
      boardAgeMs: 1_200,
      shares: 100,
      slPct: 0.6,
      tpPct: 1.2,
    });
    expect(result.openedPosition?.entryPrice).toBeCloseTo(100.064, 6);
  });

  it("5秒超の板、未来観測、数量不足は日次枠を消費せず拒否する", () => {
    const stale = applyTelExecutableConfirmTransition(pendingState(), input(9_000), "signal_quality");
    expect(stale.resultType).toBe("rejected");
    expect(stale.nextState.dailySlotConsumed).toBe(false);
    expect(stale.actions[0]).toMatchObject({ reason: "board_snapshot_stale_over_5000ms", originalImpulseReusable: false });

    const futureInput = input(4_000);
    futureInput.currentAudit.relaySentAtMs = 500;
    expect(applyTelExecutableConfirmTransition(pendingState(), futureInput, "signal_quality").actions[0])
      .toMatchObject({ reason: "same_clock_interval_negative" });

    const thin = input();
    thin.board.asks = [{ price: 100.04, qty: 50 }];
    expect(applyTelExecutableConfirmTransition(pendingState(), thin, "signal_quality").actions[0])
      .toMatchObject({ reason: "insufficient_orderbook_depth_for_shares" });
  });

  it("Windowsとcloudの絶対時計差を直接引かず、各環境内の経過時間だけを合算する", () => {
    const age = calculateClockSafeBoardAge({
      relayAssembledAtMs: 100_000,
      relaySentAtMs: 100_100,
      cloudReceivedAtMs: 1_000,
      decisionCompletedAtMs: 1_500,
    } as any);
    expect(age).toMatchObject({
      causal: true,
      fresh: true,
      relayPackagingMs: 100,
      cloudProcessingMs: 500,
      boardAgeMs: 600,
      basis: "same_clock_intervals",
    });
  });
});
