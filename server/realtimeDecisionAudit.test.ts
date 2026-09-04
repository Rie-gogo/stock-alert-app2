import { beforeEach, describe, expect, it, vi } from "vitest";

const outboxHarness = vi.hoisted(() => {
  const memory = { row: null as any, claimed: false };
  const dbMock = {
    acquireRtCurrentEngineLock: vi.fn(async () => true),
    getLatestRtTradeAt: vi.fn(),
    insertRtRealtimeDecisionEvent: vi.fn(async (input: any) => {
      memory.row = { id: 77, ...input };
      memory.claimed = false;
      return memory.row;
    }),
    claimNextRtCandidateVirtualWork: vi.fn(async ({ ownerToken }: { ownerToken: string }) => {
      if (!memory.row || memory.claimed || memory.row.candidateVirtualStatus === "processed") return null;
      memory.claimed = true;
      return { ...memory.row, candidateVirtualClaimToken: ownerToken };
    }),
    completeRtCandidateVirtualWork: vi.fn(async () => {
      memory.row.candidateVirtualStatus = "processed";
    }),
    failRtCandidateVirtualWork: vi.fn(async () => {
      memory.row.candidateVirtualStatus = "error";
      memory.claimed = false;
    }),
    upsertRtSignalCandidate: vi.fn(async input => ({ id: 88, ...input })),
    releaseRtCurrentEngineLock: vi.fn(),
  };
  return { memory, dbMock };
});
const dbMock = outboxHarness.dbMock;
const virtualMock = vi.hoisted(() => vi.fn(async () => ({ closed: 0, opened: 1 })));
const marketContextMock = vi.hoisted(() => ({
  deriveCurrentRawSignalForEvent: vi.fn(async () => ({ type: "sell", reason: "raw_sell" })),
  deriveCurrentBoardExitSignal: vi.fn(() => "sell_pressure"),
}));
const engineMock = vi.hoisted(() => ({
  getCandleCounters: vi.fn(() => ({ "8035": 31 })),
  getDashboardStatus: vi.fn(() => ({ currentTradeDate: "2026-09-07", lastCandleReceivedAt: "volatile" })),
  getOpenPositions: vi.fn(() => []),
  getSignalHistory: vi.fn(() => []),
  getSymbolConfig: vi.fn(() => ({ sl: { long: 0.6, short: 0.6 }, tp: { long: 1.2, short: 1.2 }, telMaxHoldingMinutes: 20 })),
  resolveRestoredRiskOverrides: vi.fn(() => ({ slPct: 0.6, tpPct: 1.2 })),
  resolveSpecializedFiredStateKeys: vi.fn(() => ["telShortBreak"]),
  getSymbolPnlMap: vi.fn(() => ({ "8035": 0 })),
}));
vi.mock("./db", () => outboxHarness.dbMock);
vi.mock("./realtimeSimEngine", () => engineMock);
vi.mock("./signalCandidateVirtualEngine", () => ({ processSignalQualityVirtualTradesForEvent: virtualMock }));
vi.mock("./currentVirtualMarketContext", () => marketContextMock);

import { drainCurrentCandidateVirtualQueue, processCurrentEngineAudited } from "./realtimeDecisionAudit";

describe("現行実時判断監査", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    outboxHarness.memory.row = null;
    outboxHarness.memory.claimed = false;
    dbMock.getLatestRtTradeAt.mockResolvedValue({
      action: "buy", side: "long", price: 100, shares: 100, amount: 10_000,
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
    expect(dbMock.upsertRtSignalCandidate).toHaveBeenCalledWith(expect.objectContaining({
      symbol: "8035",
      routeId: "telShortBreak",
      side: "long",
      realtimeDecision: "accepted",
      slPct: "0.6",
      tpPct: "1.2",
    }));
    expect(virtualMock).toHaveBeenCalledWith(expect.objectContaining({
      sourceEventId: "relay:10",
      rawSignal: { type: "sell", reason: "raw_sell" },
      boardSignal: "sell_pressure",
      candidate: expect.objectContaining({ routeId: "telShortBreak" }),
    }));
    expect(dbMock.releaseRtCurrentEngineLock).toHaveBeenCalledTimes(1);
  });

  it("本番同型の短いmargin_block返り値でもsignal履歴から元route・side・必要証拠金を復元する", async () => {
    dbMock.getLatestRtTradeAt.mockResolvedValue(null);
    const detailedSignal = {
      time: "10:00",
      symbol: "8035",
      symbolName: "東京エレクトロン",
      action: "margin_block",
      price: 100,
      shares: 0,
      pnl: null,
      reason: "証拠金使用率制限: 現在6000000円 + 候補4000000円 > 上限8910000円 (東京エレクトロン始値方向付き短期ブレイクSHORT)",
    };
    engineMock.getSignalHistory
      .mockReturnValueOnce([])
      .mockReturnValueOnce([detailedSignal]);
    const run = vi.fn(async () => ({
      symbol: "8035",
      tradeDate: "2026-09-07",
      candleTime: "10:00",
      action: "none" as const,
      reason: "margin_block",
    }));
    const result = await processCurrentEngineAudited({
      sourceEvent: {
        id: 11, sourceEventId: "relay:11", relaySessionId: "relay", eventSeq: 11,
        symbol: "8035", tradeDate: "2026-09-07", candleTime: "10:00",
        relayReceivedAtMs: 2_000, relaySentAtMs: 2_010, cloudReceivedAtMs: 2_020,
      } as never,
      candle: { symbol: "8035", tradeDate: "2026-09-07", candleTime: "10:00", open: 99, high: 101, low: 98, close: 100, volume: 100 },
      board: { currentPrice: 99.9, currentPriceTime: "10:00:30" } as never,
      inputHash: "margin-hash",
      run,
    });
    expect(result.audit.resultType).toBe("rejected");
    expect(result.audit.routeId).toBe("8035_open_direction_breakout_short");
    expect(dbMock.upsertRtSignalCandidate).toHaveBeenCalledWith(expect.objectContaining({
      sourceEventId: "relay:11",
      routeId: "telShortBreak",
      side: "short",
      realtimeDecision: "margin_block",
      requiredMargin: 4_000_000,
      signalQualityShares: 100,
    }));
    expect(virtualMock).toHaveBeenCalledWith(expect.objectContaining({
      sourceEventId: "relay:11",
      rawSignal: { type: "sell", reason: "raw_sell" },
      boardSignal: "sell_pressure",
      candidate: expect.objectContaining({ realtimeDecision: "margin_block", side: "short" }),
    }));
  });

  it("candidate保存失敗を監査outboxへ残し、次回drainで現行判断を再実行せず回復する", async () => {
    dbMock.upsertRtSignalCandidate
      .mockRejectedValueOnce(new Error("candidate temporary failure"))
      .mockImplementationOnce(async input => ({ id: 88, ...input }));
    const run = vi.fn(async () => ({
      symbol: "8035", tradeDate: "2026-09-07", candleTime: "10:00", action: "entry" as const,
    }));

    const result = await processCurrentEngineAudited({
      sourceEvent: {
        id: 12, sourceEventId: "relay:12", relaySessionId: "relay", eventSeq: 12,
        symbol: "8035", tradeDate: "2026-09-07", candleTime: "10:00",
        relayReceivedAtMs: 3_000, relaySentAtMs: 3_010, cloudReceivedAtMs: 3_020,
      } as never,
      candle: { symbol: "8035", tradeDate: "2026-09-07", candleTime: "10:00", open: 99, high: 101, low: 98, close: 100, volume: 100 },
      board: { currentPrice: 100.1, currentPriceTime: "10:00:30" } as never,
      inputHash: "retry-hash",
      run,
    });

    expect(result.audit.saved).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(dbMock.failRtCandidateVirtualWork).toHaveBeenCalledTimes(1);
    expect(virtualMock).not.toHaveBeenCalled();

    const retried = await drainCurrentCandidateVirtualQueue();
    expect(retried.processedEngineSequences).toEqual([77]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(dbMock.completeRtCandidateVirtualWork).toHaveBeenCalledTimes(1);
    expect(virtualMock).toHaveBeenCalledTimes(1);
  });
});
