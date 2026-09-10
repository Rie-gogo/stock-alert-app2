import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  getRtCandidateVirtualGapsForDate: vi.fn(async () => []),
  getRtPortfolioMaterializationProgress: vi.fn(async () => null),
  getRtRealtimeDecisionEventsForDate: vi.fn(async () => []),
  getRtSignalCandidatesForDate: vi.fn(async () => []),
  getRtSignalCandidateTradesForDate: vi.fn(async () => []),
  upsertRtDailyAuditMaterialization: vi.fn(),
  upsertRtPortfolioMaterializationProgress: vi.fn(async input => input),
  upsertRtPortfolioAuditEvent: vi.fn(async input => input),
}));

vi.mock("./db", () => dbMock);
vi.mock("./runtimeIdentity", async importOriginal => {
  const actual = await importOriginal<typeof import("./runtimeIdentity")>();
  return {
    ...actual,
    getRuntimeIdentity: vi.fn(() => ({ activeEntrySymbols: ["8035", "285A"] })),
  };
});

import {
  materializeAllCandidateMinutePortfolioBatch,
  materializeAllCandidateReceiptPortfolioBatch,
} from "./portfolioAudit";

function decision(id: number, candleTime: string, status = "processed") {
  return {
    id,
    sourceEventId: `source:${id}`,
    candleTime,
    candidateVirtualStatus: status,
  };
}

function candidate(id: number, engineSequence: number, candleTime: string, symbol = "8035") {
  return {
    id,
    candidateVersion: "current-10-symbol-candidates-v2-disco-short-paused",
    sourceEventId: `source:${engineSequence}`,
    engineSequence,
    tradeDate: "2026-09-07",
    candleTime,
    symbol,
    routeId: "route",
    side: "long",
    theoreticalEntryPrice: "100",
    capitalShares: 100,
    requiredMargin: 10_000,
    realtimeDecision: "accepted",
  };
}

describe("P0 portfolio増分materialization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.getRtCandidateVirtualGapsForDate.mockResolvedValue([]);
    dbMock.getRtPortfolioMaterializationProgress.mockResolvedValue(null);
    dbMock.getRtRealtimeDecisionEventsForDate.mockResolvedValue([]);
    dbMock.getRtSignalCandidatesForDate.mockResolvedValue([]);
    dbMock.getRtSignalCandidateTradesForDate.mockResolvedValue([]);
  });

  it("先頭pendingより前だけをactual_receipt高水位点として処理する", async () => {
    dbMock.getRtRealtimeDecisionEventsForDate.mockResolvedValue([
      decision(1, "10:00"),
      decision(2, "10:01"),
      decision(3, "10:02", "pending"),
      decision(4, "10:03"),
    ]);
    dbMock.getRtSignalCandidatesForDate.mockResolvedValue([
      candidate(11, 2, "10:01"),
      candidate(12, 4, "10:03", "285A"),
    ]);

    const result = await materializeAllCandidateReceiptPortfolioBatch("2026-09-07", { maxTimelineItems: 10 });

    expect(result.processedThroughEngineSequence).toBe(2);
    expect(result.accepted).toBe(1);
    expect(dbMock.upsertRtPortfolioAuditEvent).toHaveBeenCalledTimes(1);
    expect(dbMock.upsertRtPortfolioAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ generation: 1 }));
    expect(dbMock.upsertRtPortfolioMaterializationProgress).toHaveBeenCalledWith(expect.objectContaining({
      status: "processing",
      activeGeneration: null,
      buildingGeneration: 1,
      processedThroughEngineSequence: 2,
      openAllocationsJson: { candidateIds: [11] },
      marginUsed: 10_000,
    }));
  });

  it("minute_normalizedは次分受信前の分だけ確定し、当日finalize時に最終分を処理する", async () => {
    dbMock.getRtRealtimeDecisionEventsForDate.mockResolvedValue([
      decision(1, "10:00"),
      decision(2, "10:01"),
    ]);
    dbMock.getRtSignalCandidatesForDate.mockResolvedValue([
      candidate(11, 1, "10:00"),
      candidate(12, 2, "10:01", "285A"),
    ]);

    const intraday = await materializeAllCandidateMinutePortfolioBatch("2026-09-07", { maxMinutes: 10 });
    expect(intraday.lastProcessedMinute).toBe("10:00");
    expect(intraday.accepted).toBe(1);

    dbMock.getRtPortfolioMaterializationProgress.mockResolvedValue({
      processedThroughEngineSequence: 1,
      resultJson: intraday,
      openAllocationsJson: { candidateIds: [11] },
    });
    const finalized = await materializeAllCandidateMinutePortfolioBatch("2026-09-07", { maxMinutes: 10, finalizeDay: true });
    expect(finalized.lastProcessedMinute).toBe("10:01");
    expect(finalized.accepted).toBe(2);
    expect(finalized.status).toBe("processing");
    expect(finalized.eligibleForPortfolioPnlComparison).toBe(false);
  });

  it("dirtyFromが保存済みcursor以前なら古い集計値を引き継がず先頭から再構築する", async () => {
    dbMock.getRtRealtimeDecisionEventsForDate.mockResolvedValue([
      decision(1, "10:00"),
      decision(2, "10:01"),
      decision(3, "10:02"),
    ]);
    dbMock.getRtSignalCandidatesForDate.mockResolvedValue([candidate(11, 2, "10:01")]);
    dbMock.getRtPortfolioMaterializationProgress.mockResolvedValue({
      processedThroughEngineSequence: 3,
      dirtyFromEngineSequence: 2,
      activeGeneration: 1,
      buildingGeneration: null,
      resultJson: { accepted: 99, processedTimelineItems: 99 },
      openAllocationsJson: { candidateIds: [] },
    });

    const rebuilt = await materializeAllCandidateReceiptPortfolioBatch("2026-09-07", { maxTimelineItems: 10 });

    expect(rebuilt.accepted).toBe(1);
    expect(rebuilt.processedTimelineItems).toBe(1);
    expect(rebuilt.processedThroughEngineSequence).toBe(2);
    expect(rebuilt.generation).toBe(2);
    expect(dbMock.upsertRtPortfolioAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ generation: 2 }));
    expect(dbMock.upsertRtPortfolioMaterializationProgress).toHaveBeenCalledWith(expect.objectContaining({
      activeGeneration: 1,
      buildingGeneration: 2,
      dirtyFromEngineSequence: null,
      openAllocationsJson: { candidateIds: [11] },
    }));
  });

  it("dirty再構築が完全成功した時だけ新generationをactiveへ切り替える", async () => {
    dbMock.getRtRealtimeDecisionEventsForDate.mockResolvedValue([
      decision(1, "10:00"),
      decision(2, "10:01"),
    ]);
    dbMock.getRtSignalCandidatesForDate.mockResolvedValue([{
      ...candidate(11, 1, "10:00"),
      requiredMargin: 9_000_000,
    }]);
    dbMock.getRtSignalCandidateTradesForDate.mockResolvedValue([{
      candidateId: 11,
      completed: true,
      shares: 100,
      exitSourceEventId: "source:2",
      exitTradeDate: "2026-09-07",
      exitCandleTime: "10:01",
      exitPrice: "101",
      pnl: "100",
    }]);
    dbMock.getRtPortfolioMaterializationProgress.mockResolvedValue({
      processedThroughEngineSequence: 1,
      dirtyFromEngineSequence: 1,
      activeGeneration: 1,
      buildingGeneration: null,
      resultJson: { accepted: 1, processedTimelineItems: 1 },
      openAllocationsJson: { candidateIds: [] },
    });

    const rebuilt = await materializeAllCandidateReceiptPortfolioBatch("2026-09-07", {
      maxTimelineItems: 10,
      finalizeDay: true,
    });

    expect(rebuilt.status).toBe("complete");
    expect(rebuilt.generation).toBe(2);
    expect(rebuilt.marginBlocked).toBe(1);
    expect(dbMock.upsertRtPortfolioAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ generation: 2 }));
    expect(dbMock.upsertRtPortfolioMaterializationProgress).toHaveBeenCalledWith(expect.objectContaining({
      status: "complete",
      activeGeneration: 2,
      buildingGeneration: null,
    }));
  });

  it("unresolved gapがあれば2方式ともcompleteにしない", async () => {
    dbMock.getRtRealtimeDecisionEventsForDate.mockResolvedValue([decision(1, "10:00", "terminal")]);
    dbMock.getRtCandidateVirtualGapsForDate.mockResolvedValue([{ resolved: false }]);

    const receipt = await materializeAllCandidateReceiptPortfolioBatch("2026-09-07", { finalizeDay: true });
    const minute = await materializeAllCandidateMinutePortfolioBatch("2026-09-07", { finalizeDay: true });

    expect(receipt.status).toBe("processing");
    expect(minute.status).toBe("processing");
    expect(receipt.unresolvedGaps).toBe(1);
    expect(minute.unresolvedGaps).toBe(1);
  });
});
