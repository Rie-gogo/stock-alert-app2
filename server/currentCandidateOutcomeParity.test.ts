import { describe, expect, it } from "vitest";
import type {
  RtRealtimeDecisionEvent,
  RtSignalCandidate,
  RtSignalCandidateTrade,
} from "../drizzle/schema";
import { compareCurrentCandidateOutcomes } from "./currentCandidateOutcomeParity";

function candidate(input: Partial<RtSignalCandidate> & Pick<RtSignalCandidate, "id" | "engineSequence" | "sourceEventId" | "symbol" | "routeId">) {
  return {
    candidateVersion: "current-10-symbol-candidates-v2-disco-short-paused",
    tradeDate: "2026-09-08",
    candleTime: "10:00",
    side: "long",
    realtimeDecision: "accepted",
    ...input,
  } as RtSignalCandidate;
}

function virtualTrade(input: Partial<RtSignalCandidateTrade> & Pick<RtSignalCandidateTrade, "id" | "candidateId" | "symbol" | "routeId">) {
  return {
    virtualEngineVersion: "current-10-symbol-signal-quality-v2-disco-short-paused",
    tradeDate: "2026-09-08",
    side: "long",
    shares: 100,
    entryPrice: "100",
    completed: true,
    exitSourceEventId: `${input.symbol}-virtual-exit`,
    exitCandleTime: "10:10",
    exitPrice: "100",
    exitReason: "利確",
    exitReasonCode: "take_profit",
    pnl: 1_000,
    ...input,
  } as RtSignalCandidateTrade;
}

function decision(input: Partial<RtRealtimeDecisionEvent> & Pick<RtRealtimeDecisionEvent, "id" | "sourceEventId" | "symbol">) {
  return {
    tradeDate: "2026-09-08",
    candleTime: "10:00",
    resultType: "hold",
    resultJson: { result: { action: "none" }, trade: null },
    ...input,
  } as RtRealtimeDecisionEvent;
}

describe("current candidate outcome parity", () => {
  it("9/8既知差分を100株へ正規化し、最初の不一致を固定する", () => {
    const candidates = [
      candidate({ id: 1, engineSequence: 10, sourceEventId: "285-entry", symbol: "285A", routeId: "trendLong" }),
      candidate({ id: 2, engineSequence: 20, sourceEventId: "5803-entry", symbol: "5803", routeId: "highFadeBreakShort", side: "short" }),
      candidate({ id: 3, engineSequence: 30, sourceEventId: "match-entry", symbol: "9984", routeId: "softbankBreakoutLong" }),
      candidate({ id: 4, engineSequence: 40, sourceEventId: "blocked", symbol: "3436", routeId: "sumcoBreakdownShort", side: "short", realtimeDecision: "margin_block" }),
      candidate({ id: 5, engineSequence: 50, sourceEventId: "open-entry", symbol: "6526", routeId: "socionextConfirmedLong" }),
    ];
    const virtualTrades = [
      virtualTrade({
        id: 101,
        candidateId: 1,
        symbol: "285A",
        routeId: "trendLong",
        exitSourceEventId: "285-virtual-exit",
        exitCandleTime: "10:08",
        exitPrice: "96",
        exitReason: "損切り",
        exitReasonCode: "stop_loss",
        pnl: -4_000,
      }),
      virtualTrade({
        id: 102,
        candidateId: 2,
        symbol: "5803",
        routeId: "highFadeBreakShort",
        side: "short",
        exitSourceEventId: "5803-virtual-exit",
        exitCandleTime: "10:12",
        exitPrice: "101.5",
        exitReason: "損切り",
        exitReasonCode: "stop_loss",
        pnl: -1_500,
      }),
      virtualTrade({
        id: 103,
        candidateId: 3,
        symbol: "9984",
        routeId: "softbankBreakoutLong",
        exitSourceEventId: "match-exit",
        exitCandleTime: "10:10",
        exitPrice: "101",
        pnl: 1_000,
      }),
      virtualTrade({
        id: 105,
        candidateId: 5,
        symbol: "6526",
        routeId: "socionextConfirmedLong",
        completed: false,
        exitSourceEventId: null,
        exitCandleTime: null,
        exitPrice: null,
        exitReason: null,
        exitReasonCode: null,
        pnl: null,
      }),
    ];
    const decisions = [
      decision({ id: 10, sourceEventId: "285-entry", symbol: "285A", resultType: "entry", routeId: "trendLong", side: "long", shares: 500, resultJson: { result: { action: "entry" }, trade: { shares: 500, price: 100 } } }),
      decision({ id: 11, sourceEventId: "285-actual-exit", symbol: "285A", candleTime: "10:20", resultType: "exit", shares: 500, simulatedBarFillPrice: "178", reason: "利確", resultJson: { result: { action: "take_profit", pnl: 195_000 }, trade: { shares: 500, price: 178, pnl: 195_000, reason: "利確" } } }),
      decision({ id: 20, sourceEventId: "5803-entry", symbol: "5803", resultType: "entry", routeId: "highFadeBreakShort", side: "short", shares: 500, resultJson: { result: { action: "entry" }, trade: { shares: 500, price: 100 } } }),
      decision({ id: 21, sourceEventId: "5803-actual-exit", symbol: "5803", candleTime: "10:20", resultType: "exit", shares: 500, simulatedBarFillPrice: "92.0364", reason: "利確", resultJson: { result: { action: "take_profit", pnl: 39_818 }, trade: { shares: 500, price: 92.0364, pnl: 39_818, reason: "利確" } } }),
      decision({ id: 30, sourceEventId: "match-entry", symbol: "9984", resultType: "entry", routeId: "softbankBreakoutLong", side: "long", shares: 100, resultJson: { result: { action: "entry" }, trade: { shares: 100, price: 100 } } }),
      decision({ id: 31, sourceEventId: "match-exit", symbol: "9984", candleTime: "10:10", resultType: "exit", shares: 100, simulatedBarFillPrice: "101", reason: "利確", resultJson: { result: { action: "take_profit", pnl: 1_000 }, trade: { shares: 100, price: 101, pnl: 1_000, reason: "利確" } } }),
      decision({ id: 50, sourceEventId: "open-entry", symbol: "6526", resultType: "entry", routeId: "socionextConfirmedLong", side: "long", shares: 100, resultJson: { result: { action: "entry" }, trade: { shares: 100, price: 100 } } }),
    ];

    const result = compareCurrentCandidateOutcomes({ candidates, virtualTrades, decisions });

    expect(result).toMatchObject({
      acceptedCandidates: 4,
      marginBlockedExcluded: 1,
      matched: 1,
      mismatched: 2,
      incomplete: 1,
    });
    expect(result.firstMismatch).toMatchObject({
      sourceEventId: "285-entry",
      symbol: "285A",
      actual: { pnlPer100: 39_000, outcome: "win" },
      virtual: { pnlPer100: -4_000, outcome: "loss" },
    });
    expect(result.details.find(item => item.symbol === "5803")).toMatchObject({
      status: "mismatch",
      actual: { pnlPer100: 7_963.6, outcome: "win" },
      virtual: { pnlPer100: -1_500, outcome: "loss" },
    });
    expect(result.details.find(item => item.symbol === "9984")).toMatchObject({
      status: "match",
      mismatchFields: [],
    });
    expect(result.details.find(item => item.symbol === "6526")).toMatchObject({
      status: "incomplete",
      missing: ["actual_exit", "virtual_exit"],
    });
  });
});
