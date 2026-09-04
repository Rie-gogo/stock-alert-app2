import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  applyForwardStrategyLifecyclePolicy,
  applyForwardShadowTransition,
  calculateForwardExitForTest,
  calculateForwardTradeMetrics,
  evaluateForwardDecision,
  replayForwardShadowDay,
} from "./forwardShadow";
import { sha256Stable } from "./runtimeIdentity";

function position(side: "long" | "short") {
  return {
    side,
    entrySourceEventId: "entry-1",
    signalTime: "10:00",
    entryTime: "10:01",
    theoreticalSignalPrice: 100,
    entryPrice: 100,
    shares: 100,
    slPct: 0.6,
    tpPct: 1.2,
  };
}

function candle(overrides: Partial<{ open: number; high: number; low: number; close: number }> = {}) {
  return {
    symbol: "8035",
    tradeDate: "2026-09-03",
    candleTime: "10:02",
    open: 100,
    high: 100.2,
    low: 99.8,
    close: 100,
    volume: 100,
    ...overrides,
  };
}

describe("前向きシャドーの因果的約定", () => {
  it("同一足でTPとSLへ到達した場合はSLを優先する", () => {
    expect(calculateForwardExitForTest(position("long"), candle({ high: 102, low: 99 }))).toEqual({
      price: 99.4,
      reason: "stop_loss",
    });
    expect(calculateForwardExitForTest(position("short"), candle({ high: 101, low: 98 }))).toEqual({
      price: 100.6,
      reason: "stop_loss",
    });
  });

  it("SLを不利に飛び越えた始値で窓開けした場合は不利な始値を使う", () => {
    expect(calculateForwardExitForTest(position("long"), candle({ open: 98, high: 99, low: 97.5 }))?.price).toBe(98);
    expect(calculateForwardExitForTest(position("short"), candle({ open: 102, high: 102.5, low: 101 }))?.price).toBe(102);
  });
});

describe("前向き評価の判定", () => {
  const lossIndexes = new Set([2, 5, 8, 11, 14, 17]);
  const winning20 = Array.from({ length: 20 }, (_, index) => ({
    pnl: lossIndexes.has(index) ? -100 : 300,
    pnlAfterAdverseExit: lossIndexes.has(index) ? -120 : 280,
    realizedR: lossIndexes.has(index) ? "-0.166667" : "0.500000",
  }));

  it("2週間前は件数があっても採用判定しない", () => {
    const metrics = calculateForwardTradeMetrics(winning20);
    expect(evaluateForwardDecision(metrics, "2026-09-15").status).toBe("monitoring");
  });

  it("2週間以上かつ20件でもeligibleにせず中間継続判定だけにする", () => {
    const metrics = calculateForwardTradeMetrics(winning20);
    expect(evaluateForwardDecision(metrics, "2026-09-16")).toMatchObject({
      status: "interim_continue",
      reason: "interim_thresholds_met",
    });
  });

  it("4週間で10件未満なら採用せず、8週間で標本不足とする", () => {
    const fourTrades = winning20.slice(0, 4);
    expect(evaluateForwardDecision(calculateForwardTradeMetrics(fourTrades), "2026-09-30").status).toBe("interim_continue");
    expect(evaluateForwardDecision(calculateForwardTradeMetrics(fourTrades), "2026-10-28").status).toBe("insufficient");
  });

  it("4週間かつ10件で基準を満たす場合はeligibleにする", () => {
    const tenTrades = winning20.slice(0, 10);
    expect(evaluateForwardDecision(calculateForwardTradeMetrics(tenTrades), "2026-09-30")).toMatchObject({
      status: "eligible",
      reason: "four_weeks_and_ten_signals_manual_review_required",
    });
  });

  it("5連敗は期間を待たず停止する", () => {
    const losses = Array.from({ length: 5 }, () => ({ pnl: -100, pnlAfterAdverseExit: -110, realizedR: "-1.000000" }));
    expect(evaluateForwardDecision(calculateForwardTradeMetrics(losses), "2026-09-07").status).toBe("stopped");
  });

  it("旧8035 Aは件数・期間にかかわらず停止・監査専用として表示する", () => {
    const metrics = calculateForwardTradeMetrics(winning20);
    const decision = evaluateForwardDecision(metrics, "2026-09-16");
    expect(applyForwardStrategyLifecyclePolicy("candidate-8035-executable-confirm-v1", decision)).toMatchObject({
      status: "stopped",
      reason: "superseded_by_depth_v2_audit_only",
    });
  });
});

describe("シャドー注文安全境界", () => {
  it("orderBridgeや通常rt_tradesへ接続しない", () => {
    const source = readFileSync(new URL("./forwardShadow.ts", import.meta.url), "utf8");
    expect(source).not.toContain("./orderBridge");
    expect(source).not.toContain("insertRtTrade(");
    expect(source).toContain("insertRtForwardShadowTrade(");
  });
});

describe("当日固定版再生監査", () => {
  it("同じ純粋コアの実時保存結果と再生結果が一致すれば差分0になる", () => {
    const sourceEvent = {
      sourceEventId: "session:1",
      status: "processed",
      resultAction: "none",
      payloadJson: {
        symbol: "8035", tradeDate: "2026-09-03", candleTime: "09:40",
        open: 100, high: 100.1, low: 99.9, close: 100, volume: 100,
      },
    };
    const input = {
      sourceEventId: sourceEvent.sourceEventId,
      candle: sourceEvent.payloadJson,
      board: null,
    };
    const storedEvents = (["signal_quality", "capital_constrained"] as const).map(evaluationMode => {
      const stateBefore = {
        tradeDate: "2026-09-03",
        candles: [],
        pendingEntry: null,
        position: null,
        dailySlotConsumed: false,
        stopped: false,
        lastSourceEventId: null,
        lastResultType: null,
        lastActions: [],
      };
      const transition = applyForwardShadowTransition(stateBefore, input, evaluationMode);
      return {
        sourceEventId: sourceEvent.sourceEventId,
        evaluationMode,
        resultType: transition.resultType,
        stateHashBefore: sha256Stable(stateBefore),
        stateHashAfter: sha256Stable(transition.nextState),
      };
    });
    expect(replayForwardShadowDay([sourceEvent], storedEvents)).toMatchObject({
      replayedEvents: 2,
      mismatches: 0,
      invalidPayloads: 0,
    });
  });
});
