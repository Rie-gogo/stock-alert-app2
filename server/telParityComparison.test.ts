import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  getRtRealtimeDecisionEventsForDate: vi.fn(),
  getRtSourceEventsForDate: vi.fn(),
  upsertRtReplayComparison: vi.fn(),
}));
vi.mock("./db", () => dbMock);

import { compareTelCurrentParityForDate } from "./telParityComparison";

describe("8035現行完全再現の日次比較", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.getRtSourceEventsForDate.mockResolvedValue([{
      id: 1, sourceEventId: "s1", status: "processed", resultAction: "none",
      payloadJson: { symbol: "8035", tradeDate: "2026-09-07", candleTime: "09:00", open: 100, high: 101, low: 99, close: 100, volume: 100 },
    }]);
    dbMock.getRtRealtimeDecisionEventsForDate.mockResolvedValue([{
      id: 1, sourceEventDbId: 1, sourceEventId: "s1", symbol: "8035", candleTime: "09:00",
      routeId: null, marginUsedBefore: 0, stateHashAfter: "realtime",
      stateAfterJson: { positions: [], symbolCandleCount: 999 }, resultJson: { result: { action: "none" } },
    }]);
  });

  it("engineSequence順で最初の項目別不一致を保存し、後続連鎖と区別できる", async () => {
    const result = await compareTelCurrentParityForDate("2026-09-07");
    expect(result).toMatchObject({ processed: 1, matched: 0, mismatched: 1 });
    expect(result.firstMismatch).toMatchObject({ engineSequence: 1, mismatchType: "symbolCandleCount" });
    expect(result.restartAudit.matched).toBe(true);
    expect(dbMock.upsertRtReplayComparison).toHaveBeenCalledWith(expect.objectContaining({
      matchStatus: "mismatch", isFirstMismatch: true, mismatchType: "symbolCandleCount",
      diffJson: expect.objectContaining({ fields: expect.objectContaining({ symbolCandleCount: expect.any(Object) }) }),
    }));
  });
});
