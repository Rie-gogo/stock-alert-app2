import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { KIOXIA_FORWARD_STRATEGY_VERSION } from "./runtimeIdentity";
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

describe("285A monitoring comparison materializer", () => {
  it("通常取引・注文・Executor経路へ接続しない", () => {
    const source = readFileSync(new URL("./monitoringComparisonMaterializer.ts", import.meta.url), "utf8");
    expect(source).not.toContain("./orderBridge");
    expect(source).not.toContain("insertRtTrade(");
    expect(source).not.toContain("insertOrderInstruction");
    expect(source).not.toContain("reportOrderExecution");
  });

  it("現行と既存シャドーを同じstrict-next 100株板価格へ正規化する", () => {
    const signalSource = source(1, "s1", "285A", "09:45", {
      asks: [{ price: 1_001, qty: 100 }],
      bids: [{ price: 999, qty: 100 }],
    });
    const otherSymbol = source(2, "s2", "8035", "09:45", {
      asks: [{ price: 50_000, qty: 100 }],
      bids: [{ price: 49_990, qty: 100 }],
    });
    const nextKioxia = source(3, "s3", "285A", "09:46", {
      asks: [{ price: 1_003, qty: 60 }, { price: 1_004, qty: 100 }],
      bids: [{ price: 1_001, qty: 100 }],
    });
    const result = buildMonitoringComparisonForDateData({
      tradeDate: "2026-09-25",
      sourceEvents: [signalSource, otherSymbol, nextKioxia],
      decisionEvents: [decision(1, "s1", "285A", "09:45"), decision(2, "s2", "8035", "09:45"), decision(3, "s3", "285A", "09:46")],
      candidates: [{
        candidateVersion: "current-v1",
        sourceEventId: "s1",
        sourceEventDbId: 1,
        engineSequence: 1,
        tradeDate: "2026-09-25",
        candleTime: "09:45",
        symbol: "285A",
        routeId: "confirmed_morning_long",
        side: "long",
        realtimeDecision: "accepted",
        signalReason: "test",
        theoreticalEntryPrice: "1000",
      } as any],
      shadowEvents: [{
        strategyVersion: KIOXIA_FORWARD_STRATEGY_VERSION,
        sourceEventId: "s1",
        evaluationMode: "signal_quality",
        tradeDate: "2026-09-25",
        symbol: "285A",
        candleTime: "09:45",
        resultType: "entry",
        decisionJson: { actions: [{ type: "entry", side: "long", theoreticalSignalPrice: 1_000 }] },
      } as any],
    });
    expect(result.summary).toMatchObject({ signals: 2, filled: 2, unfillable: 0 });
    expect(result.entries).toHaveLength(2);
    expect(result.entries.every(item => item.resolution.status === "filled"
      && item.resolution.entrySourceEventId === "s3"
      && item.resolution.entryPrice === 1_003.4)).toBe(true);
    expect(result.entries.map(item => item.sourceDisposition).sort()).toEqual(["accepted", "forward_shadow"]);
    expect(result.scope).toMatchObject({
      existingCurrentAndShadowExecutionChanged: false,
      pnlComparisonStatus: "not_started_until_entry_contract_is_accepted",
    });
  });

  it("日末まで次の同銘柄eventが無ければ終値約定せずunfillableにする", () => {
    const only = source(10, "last", "285A", "15:25", {
      asks: [{ price: 1_003, qty: 100 }],
      bids: [{ price: 1_001, qty: 100 }],
    });
    const result = buildMonitoringComparisonForDateData({
      tradeDate: "2026-09-25",
      sourceEvents: [only],
      decisionEvents: [decision(10, "last", "285A", "15:25")],
      candidates: [{
        candidateVersion: "current-v1",
        sourceEventId: "last",
        sourceEventDbId: 10,
        engineSequence: 10,
        tradeDate: "2026-09-25",
        candleTime: "15:25",
        symbol: "285A",
        routeId: "trend_short",
        side: "short",
        realtimeDecision: "accepted",
        signalReason: "test",
        theoreticalEntryPrice: "1001",
      } as any],
      shadowEvents: [],
    });
    expect(result.entries[0]?.resolution).toEqual({
      status: "unfillable",
      reason: "no_later_same_symbol_source_event",
      entrySourceEventId: null,
      entryEngineSequence: null,
      boardAgeMs: null,
    });
  });
});
