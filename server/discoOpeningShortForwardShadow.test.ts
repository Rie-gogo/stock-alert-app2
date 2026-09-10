import { describe, expect, it } from "vitest";
import type { ForwardSourceEventInput } from "./forwardShadow";
import {
  DISCO_SHORT_BASELINE_SPEC,
  DISCO_SHORT_EXECUTABLE_SPEC,
  DISCO_SHORT_RETEST_SPEC,
  applyDiscoExecutableATransition,
  applyDiscoPausedBaselineTransition,
  applyDiscoRetestBTransition,
  calculateDiscoShortTriggerMetrics,
  createEmptyDiscoShortState,
} from "./discoOpeningShortForwardShadow";

const TRADE_DATE = "2026-09-11";

function source(input: {
  id: string;
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  board?: unknown;
  currentAudit?: ForwardSourceEventInput["currentAudit"];
}): ForwardSourceEventInput {
  return {
    sourceEventId: input.id,
    candle: {
      symbol: "6146",
      tradeDate: TRADE_DATE,
      candleTime: input.time,
      open: input.open,
      high: input.high,
      low: input.low,
      close: input.close,
      volume: input.volume ?? 100,
    },
    board: input.board ?? null,
    currentAudit: input.currentAudit,
  };
}

function warmupSources(): ForwardSourceEventInput[] {
  return Array.from({ length: 29 }, (_, index) => {
    const close = 60_000 - index * 20;
    return source({
      id: `warm-${index}`,
      time: `09:${String(index).padStart(2, "0")}`,
      open: close + 10,
      high: close + 60,
      low: close - 60,
      close,
    });
  });
}

function triggerSource(): ForwardSourceEventInput {
  return source({
    id: "trigger",
    time: "09:30",
    open: 59_200,
    high: 59_220,
    low: 58_940,
    close: 59_000,
    volume: 100,
  });
}

function runWarmup(
  variant: "paused_baseline" | "executable_a" | "retest_b",
  transition: typeof applyDiscoPausedBaselineTransition,
) {
  let state = createEmptyDiscoShortState(variant);
  for (const event of warmupSources()) {
    state = transition(state, event, "signal_quality").nextState;
  }
  return state;
}

describe("6146停止中SHORT・現行/A/B前向きシャドー", () => {
  it("停止前の現行入口を同じ確定足情報から再現する", () => {
    const metrics = calculateDiscoShortTriggerMetrics([
      ...warmupSources().map(item => ({
        time: item.candle.candleTime,
        open: item.candle.open,
        high: item.candle.high,
        low: item.candle.low,
        close: item.candle.close,
        volume: item.candle.volume,
      })),
      {
        time: "09:30", open: 59_200, high: 59_220, low: 58_940, close: 59_000, volume: 100,
      },
    ]);
    expect(metrics?.eligible).toBe(true);
    expect(metrics?.breakoutLevel).toBe(59_380);

    const transition = applyDiscoPausedBaselineTransition(
      runWarmup("paused_baseline", applyDiscoPausedBaselineTransition),
      triggerSource(),
      "signal_quality",
    );
    expect(transition.resultType).toBe("entry");
    expect(transition.openedPosition).toMatchObject({
      side: "short",
      entryPrice: 59_000,
      shares: 100,
      slPct: 0.5,
      tpPct: 2.0,
      executionProxyKind: "signal_candle_close",
    });
  });

  it("A案は次の6146イベントで因果的な100株bid depthが安値割れを維持した場合だけ入る", () => {
    const pending = applyDiscoExecutableATransition(
      runWarmup("executable_a", applyDiscoExecutableATransition),
      triggerSource(),
      "signal_quality",
    );
    expect(pending.resultType).toBe("pending");

    const accepted = applyDiscoExecutableATransition(
      pending.nextState,
      source({
        id: "next-event",
        time: "09:31",
        open: 58_980,
        high: 59_000,
        low: 58_900,
        close: 58_920,
        board: {
          bids: [{ price: 58_950, qty: 60 }, { price: 58_940, qty: 100 }],
          asks: [{ price: 58_970, qty: 100 }],
        },
        currentAudit: {
          engineSequence: 31,
          resultType: "none",
          routeId: null,
          marginUsedBefore: 0,
          marginUsedAfter: 0,
          stateHashBefore: "before",
          stateHashAfter: "after",
          causalityStatus: "pass",
          causalityReason: "available_before_decision",
          boardObservedAtMs: 900,
          relayAssembledAtMs: 1_000,
          relaySentAtMs: 1_100,
          cloudReceivedAtMs: 2_000,
          decisionStartedAtMs: 2_050,
          decisionCompletedAtMs: 2_100,
        },
      }),
      "signal_quality",
    );
    expect(accepted.resultType).toBe("entry");
    expect(accepted.openedPosition?.entryPrice).toBeCloseTo(58_946, 6);
    expect(accepted.openedPosition?.executionProxyKind).toBe("bid_depth_vwap_100");
  });

  it("A案は古い板を拒否して日次枠を消費しない", () => {
    const pending = applyDiscoExecutableATransition(
      runWarmup("executable_a", applyDiscoExecutableATransition),
      triggerSource(),
      "signal_quality",
    );
    const rejected = applyDiscoExecutableATransition(
      pending.nextState,
      source({
        id: "stale-next-event",
        time: "09:31",
        open: 58_980,
        high: 59_000,
        low: 58_900,
        close: 58_920,
        board: { bids: [{ price: 58_950, qty: 100 }], asks: [{ price: 58_970, qty: 100 }] },
        currentAudit: {
          engineSequence: 31,
          resultType: "none",
          routeId: null,
          marginUsedBefore: 0,
          marginUsedAfter: 0,
          stateHashBefore: "before",
          stateHashAfter: "after",
          causalityStatus: "pass",
          causalityReason: "available_before_decision",
          boardObservedAtMs: 900,
          relayAssembledAtMs: 1_000,
          relaySentAtMs: 7_000,
          cloudReceivedAtMs: 8_000,
          decisionStartedAtMs: 8_050,
          decisionCompletedAtMs: 8_100,
        },
      }),
      "signal_quality",
    );
    expect(rejected.resultType).toBe("rejected");
    expect(rejected.actions[0]).toMatchObject({
      reason: "board_snapshot_stale_over_5000ms",
      dailySlotConsumed: false,
    });
    expect(rejected.nextState.dailySlotConsumed).toBe(false);
  });

  it("B案は失敗リテスト後の再安値更新まで待ってから入る", () => {
    const pending = applyDiscoRetestBTransition(
      runWarmup("retest_b", applyDiscoRetestBTransition),
      triggerSource(),
      "signal_quality",
    );
    expect(pending.resultType).toBe("pending");

    const retested = applyDiscoRetestBTransition(
      pending.nextState,
      source({
        id: "failed-retest",
        time: "09:31",
        open: 59_100,
        high: 59_350,
        low: 59_050,
        close: 59_250,
      }),
      "signal_quality",
    );
    expect(retested.resultType).toBe("pending");
    expect(retested.actions[0]?.type).toBe("failed_retest_confirmed");

    const entered = applyDiscoRetestBTransition(
      retested.nextState,
      source({
        id: "rebreak",
        time: "09:32",
        open: 59_000,
        high: 59_020,
        low: 58_780,
        close: 58_800,
      }),
      "signal_quality",
    );
    expect(entered.resultType).toBe("entry");
    expect(entered.openedPosition).toMatchObject({
      signalSourceEventId: "trigger",
      entrySourceEventId: "rebreak",
      entryPrice: 58_800,
      executionProxyKind: "rebreak_candle_close",
    });
  });

  it("3案はすべて注文非接続で、採用候補A/BはTPがSLの2倍以上", () => {
    expect(DISCO_SHORT_BASELINE_SPEC.orderInstructionConnection).toBe(false);
    expect(DISCO_SHORT_BASELINE_SPEC.eligibleForAdoption).toBe(false);
    for (const spec of [DISCO_SHORT_EXECUTABLE_SPEC, DISCO_SHORT_RETEST_SPEC]) {
      expect(spec.orderInstructionConnection).toBe(false);
      expect(spec.automaticAdoption).toBe(false);
      expect(spec.exit.tpPct).toBeGreaterThanOrEqual(spec.exit.slPct * 2);
    }
  });
});
