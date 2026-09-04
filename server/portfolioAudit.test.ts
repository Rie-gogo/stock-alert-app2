import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  getRtRealtimeDecisionEventsForDate: vi.fn(),
  getRtSignalCandidatesForDate: vi.fn(),
  getRtSignalCandidateTradesForDate: vi.fn(),
  upsertRtPortfolioAuditEvent: vi.fn(),
}));
vi.mock("./db", () => dbMock);

import {
  buildActualReceiptPortfolioAuditForDate,
  buildAllCandidateMinutePortfolioForDate,
  buildAllCandidateReceiptPortfolioForDate,
  buildMinuteNormalizedPortfolioAuditForDate,
} from "./portfolioAudit";

const entry = {
  id: 1, sourceEventDbId: 1, sourceEventId: "e1", symbol: "285A", tradeDate: "2026-09-07", candleTime: "10:00",
  routeId: "confirmed_morning_long", side: "long", resultType: "entry", reason: "entry",
  shares: 100, amount: 6_000_000, simulatedBarFillPrice: "60000", signalReferencePrice: "60000",
  marginUsedBefore: 0, marginUsedAfter: 6_000_000, resultJson: { result: { action: "entry" }, trade: { amount: 6_000_000 } },
};
const blocked = {
  ...entry, id: 2, sourceEventDbId: 2, sourceEventId: "e2", symbol: "8035", routeId: "tel_open_direction_breakout_long",
  resultType: "rejected", reason: "margin_block", amount: 4_000_000, simulatedBarFillPrice: "40000", signalReferencePrice: "40000",
  marginUsedBefore: 6_000_000, marginUsedAfter: 6_000_000, resultJson: { result: { action: "none", reason: "margin_block" }, trade: { amount: 4_000_000 } },
};

describe("10銘柄共有portfolio監査", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.getRtRealtimeDecisionEventsForDate.mockResolvedValue([entry, blocked]);
  });

  it("実受信順の採用・margin_blockとブロック元を保存する", async () => {
    const result = await buildActualReceiptPortfolioAuditForDate("2026-09-07");
    expect(result).toMatchObject({ accepted: 1, marginBlocked: 1 });
    expect(dbMock.upsertRtPortfolioAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      sourceEventId: "e2", decision: "margin_block", blockerSourceEventId: "e1", blockerSymbol: "285A",
    }));
  });

  it("同一分の固定順を局所反実仮想として保存し、portfolio損益には使わない", async () => {
    const result = await buildMinuteNormalizedPortfolioAuditForDate("2026-09-07");
    expect(result.eligibleForPortfolioPnlComparison).toBe(false);
    expect(result.blockEdges).toContainEqual({ blockerSourceEventId: "e1", blockedSourceEventId: "e2" });
    expect(dbMock.upsertRtPortfolioAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      detailJson: expect.objectContaining({ scope: "same_minute_local_counterfactual", eligibleForPortfolioPnlComparison: false }),
    }));
  });

  it("全candidateを仮想exitまで追跡し、実受信順891万円portfolioの損益とblocker辺を計算する", async () => {
    const candidates = [
      { id: 1, candidateVersion: "current-10-symbol-candidates-v1", sourceEventId: "c1", engineSequence: 1, tradeDate: "2026-09-07", candleTime: "10:00", symbol: "285A", routeId: "r1", side: "long", theoreticalEntryPrice: "60000", capitalShares: 100, requiredMargin: 6_500_000, realtimeDecision: "accepted" },
      { id: 2, candidateVersion: "current-10-symbol-candidates-v1", sourceEventId: "c2", engineSequence: 2, tradeDate: "2026-09-07", candleTime: "10:00", symbol: "8035", routeId: "r2", side: "long", theoreticalEntryPrice: "40000", capitalShares: 100, requiredMargin: 4_000_000, realtimeDecision: "margin_block" },
    ];
    dbMock.getRtSignalCandidatesForDate.mockResolvedValue(candidates);
    dbMock.getRtSignalCandidateTradesForDate.mockResolvedValue([
      { candidateId: 1, tradeDate: "2026-09-07", symbol: "285A", routeId: "r1", side: "long", shares: 100, completed: true, pnl: 1000, exitSourceEventId: "x1", exitTradeDate: "2026-09-07", exitCandleTime: "10:10", exitPrice: "61000" },
      { candidateId: 2, tradeDate: "2026-09-07", symbol: "8035", routeId: "r2", side: "long", shares: 100, completed: true, pnl: 2000, exitSourceEventId: "x2", exitTradeDate: "2026-09-07", exitCandleTime: "10:11", exitPrice: "42000" },
    ]);
    dbMock.getRtRealtimeDecisionEventsForDate.mockResolvedValue([
      { sourceEventId: "x1", id: 3 },
      { sourceEventId: "x2", id: 4 },
    ]);
    const receipt = await buildAllCandidateReceiptPortfolioForDate("2026-09-07");
    expect(receipt).toMatchObject({ candidates: 2, accepted: 1, marginBlocked: 1, closed: 1, realizedPnl: 1000, eligibleForPortfolioPnlComparison: true });
    expect(receipt.blockEdges).toEqual([{ blockerSourceEventId: "c1", blockedSourceEventId: "c2" }]);
    expect(dbMock.upsertRtPortfolioAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      sourceEventId: "c1",
      requiredMargin: 6_500_000,
    }));

    const minute = await buildAllCandidateMinutePortfolioForDate("2026-09-07");
    expect(minute.eligibleForPortfolioPnlComparison).toBe(true);
    expect(minute.candidates).toBe(2);
  });

  it("仮想exit未完了ならportfolio損益比較を不適格にする", async () => {
    dbMock.getRtSignalCandidatesForDate.mockResolvedValue([
      { id: 3, candidateVersion: "current-10-symbol-candidates-v1", sourceEventId: "c3", engineSequence: 3, tradeDate: "2026-09-07", candleTime: "10:20", symbol: "5803", routeId: "r3", side: "short", theoreticalEntryPrice: "10000", capitalShares: 100, requiredMargin: 1_000_000, realtimeDecision: "margin_block" },
    ]);
    dbMock.getRtSignalCandidateTradesForDate.mockResolvedValue([
      { candidateId: 3, tradeDate: "2026-09-07", symbol: "5803", routeId: "r3", side: "short", shares: 100, completed: false, pnl: null, exitSourceEventId: null, exitTradeDate: null, exitCandleTime: null, exitPrice: null },
    ]);
    dbMock.getRtRealtimeDecisionEventsForDate.mockResolvedValue([]);
    const receipt = await buildAllCandidateReceiptPortfolioForDate("2026-09-07");
    const minute = await buildAllCandidateMinutePortfolioForDate("2026-09-07");
    expect(receipt.eligibleForPortfolioPnlComparison).toBe(false);
    expect(minute.eligibleForPortfolioPnlComparison).toBe(false);
    expect(dbMock.upsertRtPortfolioAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      sourceEventId: "c3",
      detailJson: expect.objectContaining({ eligibleForPortfolioPnlComparison: false }),
    }));
  });

  it("実受信順・同一分固定順とも同一銘柄1ポジションを専用区分で強制する", async () => {
    dbMock.getRtSignalCandidatesForDate.mockResolvedValue([
      { id: 11, candidateVersion: "current-10-symbol-candidates-v1", sourceEventId: "same-1", engineSequence: 11, tradeDate: "2026-09-08", candleTime: "10:00", symbol: "8035", routeId: "r1", side: "long", theoreticalEntryPrice: "40000", capitalShares: 100, requiredMargin: 4_000_000, realtimeDecision: "accepted" },
      { id: 12, candidateVersion: "current-10-symbol-candidates-v1", sourceEventId: "same-2", engineSequence: 12, tradeDate: "2026-09-08", candleTime: "10:05", symbol: "8035", routeId: "r2", side: "short", theoreticalEntryPrice: "40000", capitalShares: 100, requiredMargin: 4_000_000, realtimeDecision: "margin_block" },
    ]);
    dbMock.getRtSignalCandidateTradesForDate.mockResolvedValue([
      { candidateId: 11, tradeDate: "2026-09-08", symbol: "8035", routeId: "r1", side: "long", shares: 100, completed: true, pnl: 1000, exitSourceEventId: "same-x1", exitTradeDate: "2026-09-08", exitCandleTime: "10:10", exitPrice: "41000" },
      { candidateId: 12, tradeDate: "2026-09-08", symbol: "8035", routeId: "r2", side: "short", shares: 100, completed: true, pnl: 1000, exitSourceEventId: "same-x2", exitTradeDate: "2026-09-08", exitCandleTime: "10:11", exitPrice: "39000" },
    ]);
    dbMock.getRtRealtimeDecisionEventsForDate.mockResolvedValue([
      { sourceEventId: "same-x1", id: 13 },
      { sourceEventId: "same-x2", id: 14 },
    ]);

    const receipt = await buildAllCandidateReceiptPortfolioForDate("2026-09-08");
    expect(receipt).toMatchObject({ accepted: 1, marginBlocked: 0, symbolPositionBlocked: 1, closed: 1, openAtEnd: 0 });
    expect(dbMock.upsertRtPortfolioAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      sourceEventId: "same-2",
      decision: "symbol_position_block",
      blockerSourceEventId: "same-1",
      blockerSymbol: "8035",
      detailJson: expect.objectContaining({ allocationReason: "same_symbol_position_open" }),
    }));

    dbMock.upsertRtPortfolioAuditEvent.mockClear();
    const minute = await buildAllCandidateMinutePortfolioForDate("2026-09-08");
    expect(minute).toMatchObject({ accepted: 1, marginBlocked: 0, symbolPositionBlocked: 1, closed: 1, openAtEnd: 0 });
    expect(dbMock.upsertRtPortfolioAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      sourceEventId: "same-2",
      decision: "symbol_position_block",
      detailJson: expect.objectContaining({ allocationReason: "same_symbol_position_open" }),
    }));
  });
});
