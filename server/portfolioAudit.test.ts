import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  getRtRealtimeDecisionEventsForDate: vi.fn(),
  upsertRtPortfolioAuditEvent: vi.fn(),
}));
vi.mock("./db", () => dbMock);

import { buildActualReceiptPortfolioAuditForDate, buildMinuteNormalizedPortfolioAuditForDate } from "./portfolioAudit";

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
});
