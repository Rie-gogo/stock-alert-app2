import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  claimRtSourceEvent: vi.fn(),
  completeRtSourceEvent: vi.fn(),
  getPriorRtSourceEventForCandle: vi.fn(),
  getRtRealtimeDecisionEvent: vi.fn(),
  getRtSourceEvent: vi.fn(),
  markRtSourceEventEngineStarted: vi.fn(),
  reclaimRtSourceEventProcessing: vi.fn(),
}));
const processCandleMock = vi.hoisted(() => vi.fn());
const auditedCurrentMock = vi.hoisted(() => vi.fn(async (input: { run: () => Promise<unknown> }) => ({
  result: await input.run(),
  audit: {
    saved: true,
    engineSequence: 1,
    resultType: "no_signal",
    routeId: null,
    marginUsedBefore: 0,
    marginUsedAfter: 0,
    stateHashBefore: "before",
    stateHashAfter: "after",
    causalityStatus: "pass",
    causalityReason: "test",
  },
})));
const shadowMock = vi.hoisted(() => vi.fn());
const shadowDrainMock = vi.hoisted(() => vi.fn());
const candidateDrainMock = vi.hoisted(() => vi.fn());
const boardMock = vi.hoisted(() => vi.fn());

vi.mock("./db", () => dbMock);
vi.mock("./realtimeSimEngine", () => ({ processCandle: processCandleMock }));
vi.mock("./realtimeDecisionAudit", () => ({
  processCurrentEngineAudited: auditedCurrentMock,
  drainCurrentCandidateVirtualQueue: candidateDrainMock,
}));
vi.mock("./forwardShadowSequence", () => ({
  enqueueAndDrainForwardShadow: shadowMock,
  drainForwardShadowDispatchQueue: shadowDrainMock,
}));
vi.mock("./kabuStation", () => ({ updateOrderBook: boardMock }));

import { ingestSourceCandle } from "./sourceEventIngestion";

const input = {
  symbol: "8035",
  tradeDate: "2026-09-03",
  candleTime: "10:00",
  open: 100,
  high: 101,
  low: 99,
  close: 100.5,
  volume: 1000,
  sourceEventId: "session-a:1",
  relaySessionId: "session-a",
  eventSeq: 1,
  payloadHash: "a".repeat(64),
};

describe("受信イベントの一度きり処理", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.getPriorRtSourceEventForCandle.mockResolvedValue(null);
    dbMock.getRtRealtimeDecisionEvent.mockResolvedValue(null);
    dbMock.markRtSourceEventEngineStarted.mockResolvedValue(true);
    dbMock.reclaimRtSourceEventProcessing.mockResolvedValue(null);
    dbMock.getRtSourceEvent.mockResolvedValue({
      id: 1,
      sourceEventId: input.sourceEventId,
      relaySessionId: input.relaySessionId,
      eventSeq: input.eventSeq,
      symbol: input.symbol,
      tradeDate: input.tradeDate,
      candleTime: input.candleTime,
      payloadHash: input.payloadHash,
      payloadJson: input,
      relayReceivedAtMs: null,
      relaySentAtMs: null,
      cloudReceivedAtMs: Date.now(),
      status: "processing",
    });
    processCandleMock.mockResolvedValue({ symbol: "8035", tradeDate: "2026-09-03", candleTime: "10:00", action: "none" });
    shadowMock.mockResolvedValue({ skipped: false, results: [] });
    shadowDrainMock.mockResolvedValue({ processedEngineSequences: [], stoppedReason: "empty_or_claimed" });
    candidateDrainMock.mockResolvedValue({ processedEngineSequences: [], stoppedReason: "empty_or_claimed" });
  });

  it("最初のイベントだけ現行エンジンとシャドーへ渡す", async () => {
    dbMock.claimRtSourceEvent.mockResolvedValue(true);
    const result = await ingestSourceCandle(input);
    expect(processCandleMock).toHaveBeenCalledTimes(1);
    expect(shadowMock).toHaveBeenCalledTimes(1);
    expect(dbMock.completeRtSourceEvent).toHaveBeenCalledWith(expect.objectContaining({ status: "processed" }));
    expect(result.sourceEventDuplicate).toBe(false);
  });

  it("同じイベントIDの再送は現行エンジンを再実行せず、シャドーerrorだけを冪等再試行する", async () => {
    dbMock.claimRtSourceEvent.mockResolvedValue(false);
    dbMock.getRtSourceEvent.mockResolvedValue({ status: "processed", payloadHash: "a".repeat(64), resultJson: { action: "entry" } });
    const result = await ingestSourceCandle(input);
    expect(processCandleMock).not.toHaveBeenCalled();
    expect(shadowMock).not.toHaveBeenCalled();
    expect(shadowDrainMock).toHaveBeenCalledTimes(1);
    expect(candidateDrainMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ action: "none", reason: "duplicate_source_event", sourceEventDuplicate: true });
  });

  it("最初のシャドー失敗後も現行売買を再実行せず、同じ親イベント内でシャドーだけ1回再試行する", async () => {
    dbMock.claimRtSourceEvent.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    dbMock.getRtSourceEvent.mockResolvedValue({
      status: "processed",
      payloadHash: "a".repeat(64),
      resultJson: { action: "none", shadow: { error: "temporary" } },
    });
    shadowMock.mockRejectedValueOnce(new Error("temporary")).mockResolvedValueOnce({ skipped: false, results: [] });

    const first = await ingestSourceCandle(input);

    expect(first.sourceEventDuplicate).toBe(false);
    expect(processCandleMock).toHaveBeenCalledTimes(1);
    expect(shadowMock).toHaveBeenCalledTimes(2);
    const retry = await ingestSourceCandle(input);
    expect(processCandleMock).toHaveBeenCalledTimes(1);
    expect(shadowMock).toHaveBeenCalledTimes(2);
    expect(shadowDrainMock).toHaveBeenCalledTimes(1);
    expect(retry).toMatchObject({ action: "none", reason: "duplicate_source_event", sourceEventDuplicate: true });
  });

  it("285Aでも親売買は一度だけ実行し、シャドー失敗時は285Aイベントのシャドーだけを再試行する", async () => {
    const kioxiaInput = {
      ...input,
      symbol: "285A",
      tradeDate: "2026-09-04",
      sourceEventId: "kioxia-session:1",
      relaySessionId: "kioxia-session",
    };
    dbMock.claimRtSourceEvent.mockResolvedValue(true);
    processCandleMock.mockResolvedValue({ symbol: "285A", tradeDate: "2026-09-04", candleTime: "10:00", action: "none" });
    shadowMock.mockRejectedValueOnce(new Error("temporary")).mockResolvedValueOnce({ skipped: false, results: [] });

    const result = await ingestSourceCandle(kioxiaInput);

    expect(processCandleMock).toHaveBeenCalledTimes(1);
    expect(shadowMock).toHaveBeenCalledTimes(2);
    expect(shadowMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
      sourceEventId: "kioxia-session:1",
      candle: expect.objectContaining({ symbol: "285A" }),
    }));
    expect(result.sourceEventDuplicate).toBe(false);
  });

  it("同じイベントIDで異なるpayloadは処理しない", async () => {
    dbMock.claimRtSourceEvent.mockResolvedValue(false);
    dbMock.getRtSourceEvent.mockResolvedValue({ status: "processed", payloadHash: "b".repeat(64), resultJson: null });
    const result = await ingestSourceCandle(input);
    expect(processCandleMock).not.toHaveBeenCalled();
    expect(result.reason).toBe("source_event_payload_mismatch");
  });

  it("同一銘柄・時刻の訂正足は追記監査だけ行い、完了済み判断を変更しない", async () => {
    dbMock.claimRtSourceEvent.mockResolvedValue(true);
    dbMock.getPriorRtSourceEventForCandle.mockResolvedValue({ status: "processed", sourceEventId: "session-a:0" });
    const result = await ingestSourceCandle({ ...input, sourceEventId: "session-a:2", eventSeq: 2, correctedEventId: "session-a:0" });
    expect(processCandleMock).not.toHaveBeenCalled();
    expect(shadowMock).not.toHaveBeenCalled();
    expect(result.reason).toBe("correction_stored_not_replayed");
  });

  it("lease期限切れでもengine開始前ならCAS回収後に現行処理を一度だけ再開する", async () => {
    dbMock.claimRtSourceEvent.mockResolvedValue(false);
    dbMock.getRtSourceEvent.mockResolvedValue({
      status: "processing",
      processingStage: "claimed",
      payloadHash: "a".repeat(64),
    });
    dbMock.reclaimRtSourceEventProcessing.mockResolvedValue({
      id: 1,
      status: "processing",
      processingStage: "claimed",
      payloadHash: "a".repeat(64),
    });

    const result = await ingestSourceCandle(input);

    expect(processCandleMock).toHaveBeenCalledTimes(1);
    expect(dbMock.markRtSourceEventEngineStarted).toHaveBeenCalledTimes(1);
    expect(result.sourceEventDuplicate).toBe(false);
  });

  it("engine開始後に停止していても監査行があれば現行処理を再実行せず後処理だけ再開する", async () => {
    dbMock.claimRtSourceEvent.mockResolvedValue(false);
    dbMock.getRtSourceEvent.mockResolvedValue({
      status: "processing",
      processingStage: "engine_started",
      payloadHash: "a".repeat(64),
    });
    dbMock.reclaimRtSourceEventProcessing.mockResolvedValue({
      id: 1,
      status: "processing",
      processingStage: "engine_started",
      payloadHash: "a".repeat(64),
    });
    dbMock.getRtRealtimeDecisionEvent.mockResolvedValue({
      id: 77,
      resultType: "entry",
      routeId: "8035_open_direction_breakout_long",
      marginUsedBefore: 0,
      marginUsedAfter: 10_000,
      stateHashBefore: "before",
      stateHashAfter: "after",
      causalityStatus: "violation",
      causalityReason: "bar_close",
      decisionStartedAtMs: 1_000,
      decisionCompletedAtMs: 1_010,
      resultJson: {
        result: { symbol: "8035", tradeDate: "2026-09-03", candleTime: "10:00", action: "entry" },
        availabilityTimeline: {},
      },
    });

    const result = await ingestSourceCandle(input);

    expect(processCandleMock).not.toHaveBeenCalled();
    expect(candidateDrainMock).toHaveBeenCalledTimes(1);
    expect(shadowMock).toHaveBeenCalledTimes(1);
    expect(dbMock.completeRtSourceEvent).toHaveBeenCalledWith(expect.objectContaining({ status: "processed" }));
    expect(result.reason).toBe("recovered_after_engine_audit");
  });

  it("engine開始済みなのに監査行がない曖昧状態は二重実行せず隔離する", async () => {
    dbMock.claimRtSourceEvent.mockResolvedValue(false);
    dbMock.getRtSourceEvent.mockResolvedValue({
      status: "processing",
      processingStage: "engine_started",
      payloadHash: "a".repeat(64),
    });
    dbMock.reclaimRtSourceEventProcessing.mockResolvedValue({
      id: 1,
      status: "processing",
      processingStage: "engine_started",
      payloadHash: "a".repeat(64),
    });

    const result = await ingestSourceCandle(input);

    expect(processCandleMock).not.toHaveBeenCalled();
    expect(dbMock.completeRtSourceEvent).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
    expect(result.reason).toBe("engine_started_without_audit_quarantined");
  });
});
