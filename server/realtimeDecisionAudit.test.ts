import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  acquireRtCurrentEngineLock: vi.fn(async () => true),
  getLatestRtTradeAt: vi.fn(),
  insertRtRealtimeDecisionEvent: vi.fn(async () => ({ id: 77 })),
  releaseRtCurrentEngineLock: vi.fn(),
}));
const engineMock = vi.hoisted(() => ({
  getCandleCounters: vi.fn(() => ({ "8035": 31 })),
  getDashboardStatus: vi.fn(() => ({ currentTradeDate: "2026-09-07", lastCandleReceivedAt: "volatile" })),
  getOpenPositions: vi.fn(() => []),
  getSignalHistory: vi.fn(() => []),
  getSymbolPnlMap: vi.fn(() => ({ "8035": 0 })),
}));
vi.mock("./db", () => dbMock);
vi.mock("./realtimeSimEngine", () => engineMock);

import { processCurrentEngineAudited } from "./realtimeDecisionAudit";

describe("現行実時判断監査", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.getLatestRtTradeAt.mockResolvedValue({
      side: "long", price: 100, shares: 100, amount: 10_000,
      reason: "東京エレクトロン始値方向付き短期ブレイクLONG",
    });
  });

  it("現行処理を一度だけ実行し、engineSequence・利用可能時刻・価格4区分・因果違反を保存する", async () => {
    const run = vi.fn(async () => ({
      symbol: "8035", tradeDate: "2026-09-07", candleTime: "10:00", action: "entry" as const,
    }));
    const result = await processCurrentEngineAudited({
      sourceEvent: {
        id: 10, sourceEventId: "relay:10", relaySessionId: "relay", eventSeq: 10,
        symbol: "8035", tradeDate: "2026-09-07", candleTime: "10:00",
        relayReceivedAtMs: 1_000, relaySentAtMs: 1_010, cloudReceivedAtMs: 1_020,
      } as never,
      candle: { symbol: "8035", tradeDate: "2026-09-07", candleTime: "10:00", open: 99, high: 101, low: 98, close: 100, volume: 100 },
      board: { currentPrice: 100.2, currentPriceTime: "10:00:30" } as never,
      inputHash: "hash",
      run,
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(result.audit).toMatchObject({ engineSequence: 77, resultType: "entry", causalityStatus: "violation" });
    expect(dbMock.insertRtRealtimeDecisionEvent).toHaveBeenCalledWith(expect.objectContaining({
      sourceEventId: "relay:10",
      signalReferencePrice: "100",
      marketObservedPrice: "100.2",
      executablePriceProxy: "100.2",
      simulatedBarFillPrice: "100",
      brokerExecutionPrice: null,
      causalityStatus: "violation",
      resultJson: expect.objectContaining({
        availabilityTimeline: expect.objectContaining({ relayAssembledAtMs: 1_000, relaySentAtMs: 1_010, cloudReceivedAtMs: 1_020 }),
        priceLabels: expect.objectContaining({ brokerExecutionPrice: "unavailable_in_dry_run" }),
      }),
    }));
    expect(dbMock.releaseRtCurrentEngineLock).toHaveBeenCalledTimes(1);
  });
});
