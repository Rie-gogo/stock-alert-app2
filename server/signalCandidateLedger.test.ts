import { describe, expect, it, vi } from "vitest";
import type {
  RtCandidateVirtualGap,
  RtPortfolioAuditEvent,
  RtPortfolioMaterializationProgress,
  RtRealtimeDecisionEvent,
  RtSignalCandidate,
  RtSignalCandidateTrade,
} from "../drizzle/schema";

vi.mock("./runtimeIdentity", () => ({
  getRuntimeIdentity: () => ({
    runtimeBuildIdentifier: "test-build",
    sourceTreeHash: "42006f0ef757255a1b1eda86fa7c37dd28a4b42f7d23503867b9fefdf24dfeda",
    baselineTradingSourceTreeHash: "42006f0ef757255a1b1eda86fa7c37dd28a4b42f7d23503867b9fefdf24dfeda",
    tradingLogicMatchesBaseline: true,
    dryRunRequired: true,
    liveOrderApproved: false,
  }),
}));

import {
  buildRtSignalCandidateLedger,
  isValidRtSignalCandidateLedgerDate,
  type RtSignalCandidateLedgerBundle,
} from "./signalCandidateLedger";

function candidate(input: {
  id: number;
  sourceEventId: string;
  engineSequence: number;
  decision: "accepted" | "margin_block";
  symbol?: string;
  routeId?: string;
}): RtSignalCandidate {
  return {
    id: input.id,
    candidateVersion: "current-10-symbol-candidates-v1",
    sourceEventId: input.sourceEventId,
    sourceEventDbId: input.id,
    engineSequence: input.engineSequence,
    tradeDate: "2026-09-08",
    candleTime: input.engineSequence === 2 ? "09:46" : "09:45",
    symbol: input.symbol ?? "5803",
    routeId: input.routeId ?? "lowReversalBreakLong",
    side: "long",
    signalReason: "保存済みKABUシグナル",
    theoreticalEntryPrice: "5308.0000",
    signalQualityShares: 100,
    capitalShares: 1000,
    requiredMargin: 5_308_000,
    marginUsedBefore: input.decision === "margin_block" ? 8_000_000 : 0,
    marginLimit: 8_910_000,
    realtimeDecision: input.decision,
    slPct: "0.5000",
    tpPct: "0.5000",
    maxHoldingMinutes: null,
    sessionExitTime: "11:27",
    profitProtectionJson: null,
    entryObservedAtMs: 1,
    decisionAtMs: 2,
    inputJson: {},
    createdAt: new Date("2026-09-08T00:00:00Z"),
  };
}

function decisionEvent(input: {
  id: number;
  sourceEventId: string;
  candidateStatus?: RtRealtimeDecisionEvent["candidatePhaseStatus"];
  virtualStatus?: RtRealtimeDecisionEvent["virtualPhaseStatus"];
}): RtRealtimeDecisionEvent {
  return {
    id: input.id,
    sourceEventDbId: input.id,
    sourceEventId: input.sourceEventId,
    relaySessionId: "relay",
    eventSeq: input.id,
    tradeDate: "2026-09-08",
    symbol: "5803",
    candleTime: "09:45",
    decisionStartedAtMs: 1,
    decisionCompletedAtMs: 2,
    resultType: "entry",
    routeId: "lowReversalBreakLong",
    side: "long",
    reason: "保存済みKABUシグナル",
    inputHash: "a".repeat(64),
    stateBeforeJson: {},
    stateAfterJson: {},
    stateHashBefore: "b".repeat(64),
    stateHashAfter: "c".repeat(64),
    signalReferencePrice: "5308.0000",
    marketObservedPrice: "5308.0000",
    boardPriceTime: null,
    executablePriceProxy: null,
    simulatedBarFillPrice: "5308.0000",
    brokerExecutionPrice: null,
    shares: 1000,
    amount: 5_308_000,
    marginUsedBefore: 0,
    marginUsedAfter: 5_308_000,
    causalityStatus: "pass",
    causalityReason: null,
    resultJson: {},
    candidateVirtualStatus: "processed",
    candidateVirtualInputJson: {},
    candidateDescriptorJson: {},
    candidateDescriptorStatus: "complete",
    candidatePhaseStatus: input.candidateStatus ?? "complete",
    candidatePhaseAttemptCount: 1,
    candidatePhaseLastError: null,
    candidatePhaseProcessedAt: new Date("2026-09-08T00:00:01Z"),
    virtualPhaseStatus: input.virtualStatus ?? "complete",
    virtualPhaseAttemptCount: 1,
    virtualPhaseLastError: null,
    virtualPhaseProcessedAt: new Date("2026-09-08T00:00:01Z"),
    candidateVirtualClaimToken: null,
    candidateVirtualLeaseUntil: null,
    candidateVirtualAttemptCount: 1,
    candidateVirtualLastError: null,
    candidateVirtualProcessedAt: new Date("2026-09-08T00:00:01Z"),
    candidateVirtualTerminalAt: null,
    createdAt: new Date("2026-09-08T00:00:00Z"),
  };
}

function virtualTrade(input: {
  id: number;
  candidateId: number;
  pnl: number;
}): RtSignalCandidateTrade {
  return {
    id: input.id,
    virtualEngineVersion: "current-10-symbol-signal-quality-v1",
    candidateId: input.candidateId,
    entrySourceEventId: `source:${input.candidateId}`,
    tradeDate: "2026-09-08",
    symbol: "5803",
    routeId: "lowReversalBreakLong",
    side: "long",
    entryCandleTime: "09:45",
    entryPrice: "5308.0000",
    shares: 100,
    slPct: "0.5000",
    tpPct: "0.5000",
    maxHoldingMinutes: null,
    stateJson: {},
    exitSourceEventId: `exit:${input.candidateId}`,
    exitTradeDate: "2026-09-08",
    exitCandleTime: "09:51",
    exitPrice: input.pnl >= 0 ? "5334.5400" : "5281.4600",
    exitReason: "take_profit",
    exitReasonCode: "take_profit",
    exitReasonDetail: null,
    pnl: input.pnl,
    realizedR: "1.000000",
    mfePct: "0.500000",
    maePct: "0.100000",
    completed: true,
    createdAt: new Date("2026-09-08T00:00:00Z"),
    updatedAt: new Date("2026-09-08T00:00:00Z"),
  };
}

function progress(mode: "actual_receipt" | "minute_normalized"): RtPortfolioMaterializationProgress {
  return {
    id: mode === "actual_receipt" ? 1 : 2,
    portfolioVersion: mode === "actual_receipt"
      ? "current-10-symbol-891m-all-candidates-receipt-v2"
      : "current-10-symbol-891m-all-candidates-minute-v2",
    mode,
    tradeDate: "2026-09-08",
    status: "complete",
    activeGeneration: 2,
    buildingGeneration: 3,
    processedThroughEngineSequence: 2,
    sourceDecisionCount: 2,
    openAllocationsJson: {},
    marginUsed: 0,
    dirtyFromEngineSequence: null,
    resultJson: {},
    lastError: null,
    generatedAt: new Date("2026-09-08T07:00:00Z"),
    createdAt: new Date("2026-09-08T00:00:00Z"),
    updatedAt: new Date("2026-09-08T07:00:00Z"),
  };
}

function portfolioEvent(input: {
  id: number;
  sourceEventId: string;
  mode: "actual_receipt" | "minute_normalized";
  decision: "accepted" | "margin_block";
}): RtPortfolioAuditEvent {
  return {
    id: input.id,
    portfolioVersion: input.mode === "actual_receipt"
      ? "current-10-symbol-891m-all-candidates-receipt-v2"
      : "current-10-symbol-891m-all-candidates-minute-v2",
    mode: input.mode,
    generation: 2,
    sourceEventId: input.sourceEventId,
    tradeDate: "2026-09-08",
    candleTime: "09:45",
    batchKey: "2026-09-08:09:45",
    symbol: "5803",
    routeId: "lowReversalBreakLong",
    side: "long",
    priorityRank: 1,
    decision: input.decision,
    shares: 1000,
    requiredMargin: 5_308_000,
    marginUsedBefore: 0,
    marginUsedAfter: input.decision === "accepted" ? 5_308_000 : 0,
    blockerSourceEventId: input.decision === "margin_block" ? "source:blocker" : null,
    blockerSymbol: input.decision === "margin_block" ? "285A" : null,
    detailJson: {},
    createdAt: new Date("2026-09-08T00:00:00Z"),
  };
}

function emptyBundle(): RtSignalCandidateLedgerBundle {
  return {
    candidates: [],
    virtualTrades: [],
    decisionEvents: [],
    gaps: [],
    actualReceiptProgress: progress("actual_receipt"),
    minuteNormalizedProgress: progress("minute_normalized"),
    actualReceiptPortfolioEvents: [],
    minuteNormalizedPortfolioEvents: [],
  };
}

describe("全シグナル監査台帳", () => {
  it("YYYY-MM-DD形式と実在日付を両方検証する", () => {
    expect(isValidRtSignalCandidateLedgerDate("2026-09-08")).toBe(true);
    expect(isValidRtSignalCandidateLedgerDate("2026-02-29")).toBe(false);
    expect(isValidRtSignalCandidateLedgerDate("2026-02-30")).toBe(false);
    expect(isValidRtSignalCandidateLedgerDate("2026-9-8")).toBe(false);
  });

  it("acceptedとmargin_blockをcandidateIdでvirtualへ結合しengineSequence順で集計する", () => {
    const bundle = emptyBundle();
    bundle.candidates = [
      candidate({ id: 2, sourceEventId: "source:2", engineSequence: 2, decision: "margin_block" }),
      candidate({ id: 1, sourceEventId: "source:1", engineSequence: 1, decision: "accepted" }),
    ];
    bundle.virtualTrades = [virtualTrade({ id: 11, candidateId: 1, pnl: 2_654 })];
    bundle.decisionEvents = [
      decisionEvent({ id: 1, sourceEventId: "source:1" }),
      decisionEvent({ id: 2, sourceEventId: "source:2", virtualStatus: "pending" }),
    ];
    bundle.actualReceiptPortfolioEvents = [
      portfolioEvent({ id: 1, sourceEventId: "source:1", mode: "actual_receipt", decision: "accepted" }),
      portfolioEvent({ id: 2, sourceEventId: "source:2", mode: "actual_receipt", decision: "margin_block" }),
    ];
    bundle.minuteNormalizedPortfolioEvents = [
      portfolioEvent({ id: 3, sourceEventId: "source:1", mode: "minute_normalized", decision: "margin_block" }),
      portfolioEvent({ id: 4, sourceEventId: "source:2", mode: "minute_normalized", decision: "accepted" }),
    ];

    const result = buildRtSignalCandidateLedger({
      tradeDate: "2026-09-08",
      bundle,
      generatedAt: new Date("2026-09-09T00:00:00Z"),
    });

    expect(result.rows.map(row => row.candidateId)).toEqual([1, 2]);
    expect(result.rows[0]?.virtualTrade.pnl).toBe(2_654);
    expect(result.rows[0]?.virtualTrade.outcome).toBe("win");
    expect(result.rows[1]?.virtualTrade.status).toBe("pending");
    expect(result.rows[1]?.virtualTrade.pnl).toBeNull();
    expect(result.rows[1]?.virtualTrade.outcome).toBeNull();
    expect(result.rows[0]?.portfolioAudit.actualReceipt.decision).toBe("accepted");
    expect(result.rows[0]?.portfolioAudit.minuteNormalized.decision).toBe("margin_block");
    expect(result.rows[0]?.portfolioAudit.actualReceipt.activeGeneration).toBe(2);
    expect(result.summary).toMatchObject({
      candidateCount: 2,
      acceptedCount: 1,
      marginBlockedCount: 1,
      virtualCreatedCount: 1,
      virtualCompletedCount: 1,
      wins: 1,
      losses: 0,
      draws: 0,
      signalQualityPnl: 2_654,
      pendingCount: 1,
      coverageComplete: false,
      dryRunRequired: true,
      liveOrderApproved: false,
    });
  });

  it("terminal gapとcandidate行へ結合できないgapを隠さない", () => {
    const bundle = emptyBundle();
    bundle.candidates = [candidate({ id: 1, sourceEventId: "source:1", engineSequence: 1, decision: "accepted" })];
    bundle.decisionEvents = [decisionEvent({ id: 1, sourceEventId: "source:1", virtualStatus: "terminal_error" })];
    bundle.gaps = [
      {
        id: 1,
        decisionEventId: 1,
        sourceEventId: "source:1",
        tradeDate: "2026-09-08",
        phase: "virtual",
        reasonCode: "virtual_terminal",
        detailJson: {},
        resolved: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as RtCandidateVirtualGap,
      {
        id: 2,
        decisionEventId: 2,
        sourceEventId: "orphan:2",
        tradeDate: "2026-09-08",
        phase: "candidate",
        reasonCode: "candidate_terminal",
        detailJson: {},
        resolved: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as RtCandidateVirtualGap,
    ];

    const result = buildRtSignalCandidateLedger({ tradeDate: "2026-09-08", bundle });
    expect(result.rows[0]?.audit.overallStatus).toBe("terminal_error");
    expect(result.rows[0]?.audit.hasUnresolvedGap).toBe(true);
    expect(result.rows[0]?.virtualTrade.pnl).toBeNull();
    expect(result.summary.terminalCount).toBe(1);
    expect(result.summary.unresolvedGapCount).toBe(2);
    expect(result.summary.orphanGapCount).toBe(1);
    expect(result.summary.coverageComplete).toBe(false);
    expect(result.orphanGaps).toEqual([{ sourceEventId: "orphan:2", phase: "candidate", reasonCode: "candidate_terminal" }]);
  });

  it("0円の決済だけをdrawとして数え、未生成nullと区別する", () => {
    const bundle = emptyBundle();
    bundle.candidates = [candidate({ id: 1, sourceEventId: "source:1", engineSequence: 1, decision: "accepted" })];
    bundle.virtualTrades = [virtualTrade({ id: 1, candidateId: 1, pnl: 0 })];
    bundle.decisionEvents = [decisionEvent({ id: 1, sourceEventId: "source:1" })];
    const result = buildRtSignalCandidateLedger({ tradeDate: "2026-09-08", bundle });
    expect(result.rows[0]?.virtualTrade.pnl).toBe(0);
    expect(result.rows[0]?.virtualTrade.outcome).toBe("draw");
    expect(result.summary.draws).toBe(1);
    expect(result.summary.virtualCompletedCount).toBe(1);
  });

  it("active generation以外のportfolio eventを表示しない", () => {
    const bundle = emptyBundle();
    bundle.candidates = [candidate({ id: 1, sourceEventId: "source:1", engineSequence: 1, decision: "accepted" })];
    bundle.virtualTrades = [virtualTrade({ id: 1, candidateId: 1, pnl: 100 })];
    bundle.decisionEvents = [decisionEvent({ id: 1, sourceEventId: "source:1" })];
    const stale = portfolioEvent({ id: 1, sourceEventId: "source:1", mode: "actual_receipt", decision: "accepted" });
    stale.generation = 1;
    bundle.actualReceiptPortfolioEvents = [stale];

    const result = buildRtSignalCandidateLedger({ tradeDate: "2026-09-08", bundle });
    expect(result.rows[0]?.portfolioAudit.actualReceipt.activeGeneration).toBe(2);
    expect(result.rows[0]?.portfolioAudit.actualReceipt.decision).toBeNull();
  });

  it("candidate版またはvirtual版が異なるbundleを拒否する", () => {
    const candidateMismatch = emptyBundle();
    candidateMismatch.candidates = [candidate({ id: 1, sourceEventId: "source:1", engineSequence: 1, decision: "accepted" })];
    candidateMismatch.candidates[0]!.candidateVersion = "old-candidate-version";
    expect(() => buildRtSignalCandidateLedger({ tradeDate: "2026-09-08", bundle: candidateMismatch }))
      .toThrow("rt_signal_candidate_ledger_candidate_version_mismatch");

    const virtualMismatch = emptyBundle();
    virtualMismatch.virtualTrades = [virtualTrade({ id: 1, candidateId: 1, pnl: 100 })];
    virtualMismatch.virtualTrades[0]!.virtualEngineVersion = "old-virtual-version";
    expect(() => buildRtSignalCandidateLedger({ tradeDate: "2026-09-08", bundle: virtualMismatch }))
      .toThrow("rt_signal_candidate_ledger_virtual_version_mismatch");
  });
});
