import { describe, expect, it } from "vitest";
import {
  MONITORING_COMPARISON_CONTRACT,
  applyMonitoringComparisonEntryEvent,
  canUseMonitoringOutcomeLabel,
  classifyMonitoringAttribution,
  resolveMonitoringComparisonEntry,
  type MonitoringComparisonSignal,
  type MonitoringComparisonSourceEvent,
} from "./monitoringComparisonContract";

function signal(side: "long" | "short" = "long"): MonitoringComparisonSignal {
  return {
    comparisonGeneration: MONITORING_COMPARISON_CONTRACT.comparisonGeneration,
    strategyVersion: "candidate-285a-a-v1",
    routeId: "kioxia-confirmed-morning-long",
    symbol: "285A",
    side,
    signalSourceEventId: "source-100",
    signalEngineSequence: 100,
    signalTradeDate: "2026-09-25",
    signalTime: "09:45",
    theoreticalSignalPrice: 1_000,
    signalDecisionCompletedAtMs: 20_000,
    signalBoardObservedAtMs: 10_000,
  };
}

function source(overrides: Partial<MonitoringComparisonSourceEvent> = {}): MonitoringComparisonSourceEvent {
  return {
    sourceEventId: "source-101",
    candle: {
      symbol: "285A",
      tradeDate: "2026-09-25",
      candleTime: "09:46",
      open: 1_001,
      high: 1_003,
      low: 1_000,
      close: 1_002,
      volume: 1_000,
    },
    board: {
      asks: [{ price: 1_003, qty: 60 }, { price: 1_004, qty: 100 }],
      bids: [{ price: 1_001, qty: 70 }, { price: 1_000, qty: 100 }],
    },
    currentAudit: {
      engineSequence: 101,
      resultType: "none",
      routeId: null,
      marginUsedBefore: 0,
      marginUsedAfter: 0,
      stateHashBefore: "before",
      stateHashAfter: "after",
      causalityStatus: "pass",
      causalityReason: "available_before_decision",
      boardObservedAtMs: 30_000,
      relayAssembledAtMs: 30_100,
      relaySentAtMs: 30_200,
      cloudReceivedAtMs: 30_300,
      decisionStartedAtMs: 30_350,
      decisionCompletedAtMs: 30_400,
    },
    ...overrides,
  };
}

describe("monitoring comparison entry contract v1", () => {
  it("LONGは次の同銘柄eventのask 100株VWAPを使う", () => {
    expect(resolveMonitoringComparisonEntry(signal("long"), source())).toMatchObject({
      status: "filled",
      entryPrice: 1_003.4,
      priceSource: "ask_depth_vwap_100",
      shares: 100,
      levelsUsed: 2,
    });
  });

  it("SHORTは次の同銘柄eventのbid 100株VWAPを使う", () => {
    expect(resolveMonitoringComparisonEntry(signal("short"), source())).toMatchObject({
      status: "filled",
      entryPrice: 1_000.7,
      priceSource: "bid_depth_vwap_100",
      shares: 100,
      levelsUsed: 2,
    });
  });

  it("他銘柄と同一・過去sequenceは候補として消費しない", () => {
    expect(resolveMonitoringComparisonEntry(signal(), source({
      candle: { ...source().candle, symbol: "8035" },
    }))).toEqual({ status: "waiting", reason: "different_symbol" });
    expect(resolveMonitoringComparisonEntry(signal(), source({
      currentAudit: { ...source().currentAudit, engineSequence: 100 },
    }))).toEqual({ status: "waiting", reason: "same_or_earlier_engine_sequence" });
  });

  it("古い板、因果性違反、100株未満をunfillableとして終端化する", () => {
    expect(resolveMonitoringComparisonEntry(signal(), source({
      currentAudit: {
        ...source().currentAudit,
        relaySentAtMs: 36_000,
        decisionCompletedAtMs: 36_100,
      },
    }))).toMatchObject({ status: "unfillable", reason: "board_stale" });
    expect(resolveMonitoringComparisonEntry(signal(), source({
      currentAudit: { ...source().currentAudit, causalityStatus: "violation" },
    }))).toMatchObject({ status: "unfillable", reason: "source_event_causality_failed" });
    expect(resolveMonitoringComparisonEntry(signal(), source({
      board: { asks: [{ price: 1_003, qty: 99 }], bids: [{ price: 1_001, qty: 99 }] },
    }))).toMatchObject({ status: "unfillable", reason: "board_depth_insufficient" });
  });

  it("次eventがunfillableなら後続の良い板へ選び直さない", () => {
    const pending = { signal: signal(), resolution: null };
    const rejected = applyMonitoringComparisonEntryEvent(pending, source({ board: null }));
    const later = applyMonitoringComparisonEntryEvent(rejected, source({
      sourceEventId: "source-102",
      currentAudit: { ...source().currentAudit, engineSequence: 102 },
    }));
    expect(rejected.resolution).toMatchObject({
      status: "unfillable",
      reason: "board_depth_insufficient",
      entrySourceEventId: "source-101",
    });
    expect(later).toEqual(rejected);
  });

  it("終値fallbackを持たず、未来ラベルはavailableAt到達後だけ使う", () => {
    expect(MONITORING_COMPARISON_CONTRACT.closePriceFallback).toBe(false);
    expect(canUseMonitoringOutcomeLabel({ availableAtMs: 10_001, evaluationCutoffMs: 10_000 })).toBe(false);
    expect(canUseMonitoringOutcomeLabel({ availableAtMs: 10_000, evaluationCutoffMs: 10_000 })).toBe(true);
  });

  it("route不明は全体損益へ残し、route比較だけから外す", () => {
    expect(classifyMonitoringAttribution(null)).toEqual({
      routeId: "unclassified",
      attributionStatus: "unclassified",
      includeInOverallPnl: true,
      includeInRouteComparison: false,
    });
    expect(classifyMonitoringAttribution(" route-a ")).toEqual({
      routeId: "route-a",
      attributionStatus: "classified",
      includeInOverallPnl: true,
      includeInRouteComparison: true,
    });
  });
});
