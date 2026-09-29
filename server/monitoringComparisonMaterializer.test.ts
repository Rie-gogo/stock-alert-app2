import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  KIOXIA_ATR_FORWARD_STRATEGY_VERSION,
  KIOXIA_FORWARD_STRATEGY_VERSION,
} from "./runtimeIdentity";
import { buildMonitoringComparisonForDateData } from "./monitoringComparisonMaterializer";

function source(id: number, sourceEventId: string, symbol: string, time: string, board: unknown) {
  return {
    id,
    sourceEventId,
    relaySessionId: "relay-1",
    eventSeq: id,
    symbol,
    tradeDate: "2026-09-25",
    candleTime: time,
    payloadHash: `hash-${id}`,
    payloadJson: {
      symbol,
      tradeDate: "2026-09-25",
      candleTime: time,
      open: 1_000,
      high: 1_005,
      low: 995,
      close: 1_001,
      volume: 1_000,
      board,
    },
    relayReceivedAtMs: id * 10_000 + 100,
    relaySentAtMs: id * 10_000 + 200,
    cloudReceivedAtMs: id * 10_000 + 300,
    correctedEventId: null,
    status: "processed",
    processingStage: "completed",
    claimToken: null,
    leaseUntil: null,
    attemptCount: 1,
    resultAction: "none",
    resultJson: {},
    errorDetail: null,
    createdAt: new Date(),
    processedAt: new Date(),
  } as any;
}

function decision(id: number, sourceEventId: string, symbol: string, time: string) {
  return {
    id,
    sourceEventDbId: id,
    sourceEventId,
    relaySessionId: "relay-1",
    eventSeq: id,
    tradeDate: "2026-09-25",
    symbol,
    candleTime: time,
    decisionStartedAtMs: id * 10_000 + 350,
    decisionCompletedAtMs: id * 10_000 + 400,
    resultType: "no_signal",
    routeId: null,
    side: null,
    reason: null,
    inputHash: `input-${id}`,
    stateBeforeJson: {},
    stateAfterJson: {},
    stateHashBefore: "before",
    stateHashAfter: "after",
    signalReferencePrice: "1001",
    marketObservedPrice: "1001",
    boardPriceTime: null,
    executablePriceProxy: null,
    simulatedBarFillPrice: null,
    brokerExecutionPrice: null,
    shares: null,
    amount: null,
    marginUsedBefore: 0,
    marginUsedAfter: 0,
    causalityStatus: "pass",
    causalityReason: "available_before_decision",
    resultJson: {
      availabilityTimeline: {
        boardObservedAtMs: id * 10_000,
        relayAssembledAtMs: id * 10_000 + 100,
        relaySentAtMs: id * 10_000 + 200,
        cloudReceivedAtMs: id * 10_000 + 300,
      },
    },
  } as any;
}

const board = {
  asks: [{ price: 1_003, qty: 100 }],
  bids: [{ price: 1_001, qty: 100 }],
};

describe("285A monitoring comparison materializer", () => {
  it("通常取引・注文・Executor経路へ接続しない", () => {
    const contents = readFileSync(new URL("./monitoringComparisonMaterializer.ts", import.meta.url), "utf8");
    expect(contents).not.toContain("./orderBridge");
    expect(contents).not.toContain("insertRtTrade(");
    expect(contents).not.toContain("insertOrderInstruction");
    expect(contents).not.toContain("reportOrderExecution");
  });

  it("現行acceptedとmargin_blockを同じ次event板で正規化し、保存済み実取引は別表に残す", () => {
    const s1 = source(1, "s1", "285A", "09:45", board);
    const s2 = source(2, "s2", "285A", "09:46", board);
    const s3 = source(3, "s3", "285A", "09:47", board);
    const result = buildMonitoringComparisonForDateData({
      tradeDate: "2026-09-25",
      sourceEvents: [s1, s2, s3],
      decisionEvents: [decision(1, "s1", "285A", "09:45"), decision(2, "s2", "285A", "09:46"), decision(3, "s3", "285A", "09:47")],
      candidates: [
        { id: 11, candidateVersion: "current-v1", sourceEventId: "s1", sourceEventDbId: 1, engineSequence: 1, tradeDate: "2026-09-25", candleTime: "09:45", symbol: "285A", routeId: "safe_cb_short", side: "short", realtimeDecision: "accepted", signalReason: "test", theoreticalEntryPrice: "1000" },
        { id: 12, candidateVersion: "current-v1", sourceEventId: "s1", sourceEventDbId: 1, engineSequence: 1, tradeDate: "2026-09-25", candleTime: "09:45", symbol: "285A", routeId: "trend_short", side: "short", realtimeDecision: "margin_block", signalReason: "test", theoreticalEntryPrice: "1000" },
      ] as any,
      candidateTrades: [
        { candidateId: 11, entrySourceEventId: "s1", exitSourceEventId: "s2", exitCandleTime: "09:46", entryPrice: "1000", exitPrice: "990", pnl: 1000, shares: 100, completed: true, exitReason: "tp" },
        { candidateId: 12, entrySourceEventId: "s1", exitSourceEventId: "s2", entryPrice: "1000", exitPrice: "990", pnl: 1000, shares: 100, completed: true, exitReason: "tp" },
      ] as any,
      normalTrades: [
        { symbol: "285A", side: "short", action: "short", tradeTime: "09:45", price: "1000", shares: 100 },
        { symbol: "285A", side: "short", action: "cover", tradeTime: "09:46", price: "990", shares: 100, pnl: 1000, reason: "tp" },
      ] as any,
      shadowEvents: [],
      shadowTrades: [],
    });
    expect(result.summary).toMatchObject({ accepted: 1, marginBlocked: 1, normalizedFilled: 2 });
    const accepted = result.entries.find(entry => entry.sourceDisposition === "accepted")!;
    const blocked = result.entries.find(entry => entry.sourceDisposition === "margin_block")!;
    expect(accepted.intrinsic).toMatchObject({ priceSource: "rt_trades", entryPrice: 1000, completed: true, pnlPer100: 1000 });
    expect(accepted.normalized).toMatchObject({ status: "filled", pnlPer100: -200 });
    expect(blocked.intrinsic).toMatchObject({ priceSource: "candidate_virtual", completed: true });
    expect(blocked.normalized).toMatchObject({ status: "filled" });
  });

  it("現行acceptedはcandidate virtualの別exitではなくrt_tradesの実際の決済と後続source eventを使う", () => {
    const s1 = source(1, "s1", "285A", "09:59", board);
    const s2 = source(2, "s2", "285A", "10:42", board);
    const s3 = source(3, "s3", "285A", "11:08", board);
    const s4 = source(4, "s4", "285A", "11:09", board);
    const result = buildMonitoringComparisonForDateData({
      tradeDate: "2026-09-29",
      sourceEvents: [s1, s2, s3, s4],
      decisionEvents: [
        decision(1, "s1", "285A", "09:59"),
        decision(2, "s2", "285A", "10:42"),
        decision(3, "s3", "285A", "11:08"),
        decision(4, "s4", "285A", "11:09"),
      ],
      candidates: [{ id: 19, candidateVersion: "current-v1", sourceEventId: "s1", sourceEventDbId: 1, engineSequence: 1, tradeDate: "2026-09-29", candleTime: "09:59", symbol: "285A", routeId: "kioxiaSafeCbShort", side: "short", realtimeDecision: "accepted", signalReason: "test", theoreticalEntryPrice: "1000" }] as any,
      candidateTrades: [{ candidateId: 19, entrySourceEventId: "s1", exitSourceEventId: "s2", exitCandleTime: "10:42", entryPrice: "1000", exitPrice: "995", pnl: 500, shares: 100, completed: true, exitReason: "signal_reversal" }] as any,
      normalTrades: [
        { symbol: "285A", side: "short", action: "short", tradeTime: "09:59", price: "1000", shares: 100 },
        { symbol: "285A", side: "short", action: "cover", tradeTime: "11:08", price: "1010", shares: 100, pnl: -1000, reason: "sl" },
      ] as any,
      shadowEvents: [],
      shadowTrades: [],
    });
    expect(result.entries[0]?.intrinsic).toMatchObject({
      status: "completed",
      priceSource: "rt_trades",
      exitPrice: 1010,
      pnlPer100: -1000,
      exitSourceEventId: "s3",
    });
  });

  it("Plan Bを5経路別に記録し、entry_rejectedを候補と誤って約定させない", () => {
    const s1 = source(1, "s1", "285A", "09:45", board);
    const s2 = source(2, "s2", "285A", "09:46", board);
    const result = buildMonitoringComparisonForDateData({
      tradeDate: "2026-09-25",
      sourceEvents: [s1, s2],
      decisionEvents: [decision(1, "s1", "285A", "09:45"), decision(2, "s2", "285A", "09:46")],
      candidates: [],
      shadowEvents: [
        { strategyVersion: KIOXIA_ATR_FORWARD_STRATEGY_VERSION, sourceEventId: "s1", evaluationMode: "signal_quality", tradeDate: "2026-09-25", symbol: "285A", candleTime: "09:45", resultType: "entry", decisionJson: { actions: [{ type: "entry", route: "safe_cb_short", side: "short", theoreticalSignalPrice: 1000 }] } },
        { strategyVersion: KIOXIA_ATR_FORWARD_STRATEGY_VERSION, sourceEventId: "s2", evaluationMode: "signal_quality", tradeDate: "2026-09-25", symbol: "285A", candleTime: "09:46", resultType: "rejected", decisionJson: { actions: [{ type: "entry_rejected", route: "trend_short", reason: "pm_bpr_block", theoreticalSignalPrice: 1000 }] } },
      ] as any,
      shadowTrades: [{ strategyVersion: KIOXIA_ATR_FORWARD_STRATEGY_VERSION, evaluationMode: "signal_quality", entrySourceEventId: "s1", exitSourceEventId: null, entryPrice: "1000", exitPrice: null, pnl: null, shares: 100 }] as any,
    });
    expect(result.entries).toHaveLength(2);
    expect(result.entries.map(entry => entry.routeId).sort()).toEqual(["safe_cb_short", "trend_short"]);
    const rejected = result.entries.find(entry => entry.sourceDisposition === "rejected")!;
    expect(rejected).toMatchObject({ rejectionStage: "entry_condition_rejected", rejectionReason: "pm_bpr_block" });
    expect(rejected.side).toBe("short");
    expect(rejected.normalized.status).toBe("not_applicable");
  });

  it("終値へ代替せず、入口または出口の次eventが無い場合をunfillableに固定する", () => {
    const only = source(10, "last", "285A", "15:25", board);
    const result = buildMonitoringComparisonForDateData({
      tradeDate: "2026-09-25",
      sourceEvents: [only],
      decisionEvents: [decision(10, "last", "285A", "15:25")],
      candidates: [{ id: 1, candidateVersion: "current-v1", sourceEventId: "last", sourceEventDbId: 10, engineSequence: 10, tradeDate: "2026-09-25", candleTime: "15:25", symbol: "285A", routeId: "trend_short", side: "short", realtimeDecision: "accepted", signalReason: "test", theoreticalEntryPrice: "1001" }] as any,
      shadowEvents: [],
    });
    expect(result.entries[0]?.normalized).toMatchObject({
      status: "unfillable_entry",
      entry: { status: "unfillable", reason: "no_later_same_symbol_source_event" },
    });
  });

  it("Plan AとPlan BをstrategyVersionとrouteの組で別行にする", () => {
    const s1 = source(1, "s1", "285A", "09:45", board);
    const s2 = source(2, "s2", "285A", "09:46", board);
    const result = buildMonitoringComparisonForDateData({
      tradeDate: "2026-09-25",
      sourceEvents: [s1, s2],
      decisionEvents: [decision(1, "s1", "285A", "09:45"), decision(2, "s2", "285A", "09:46")],
      candidates: [],
      shadowEvents: [
        { strategyVersion: KIOXIA_FORWARD_STRATEGY_VERSION, sourceEventId: "s1", evaluationMode: "signal_quality", tradeDate: "2026-09-25", symbol: "285A", candleTime: "09:45", resultType: "entry", decisionJson: { actions: [{ type: "entry", route: "confirmed_morning_long", side: "long", theoreticalSignalPrice: 1000 }] } },
        { strategyVersion: KIOXIA_ATR_FORWARD_STRATEGY_VERSION, sourceEventId: "s1", evaluationMode: "signal_quality", tradeDate: "2026-09-25", symbol: "285A", candleTime: "09:45", resultType: "entry", decisionJson: { actions: [{ type: "entry", route: "confirmed_morning_long", side: "long", theoreticalSignalPrice: 1000 }] } },
      ] as any,
    });
    expect(Object.keys(result.summary.byRoute)).toHaveLength(2);
  });
});
