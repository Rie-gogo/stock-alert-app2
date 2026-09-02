import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  claimRtSourceEvent: vi.fn(),
  completeRtSourceEvent: vi.fn(),
  getPriorRtSourceEventForCandle: vi.fn(),
  getRtSourceEvent: vi.fn(),
}));
const processCandleMock = vi.hoisted(() => vi.fn());
const shadowMock = vi.hoisted(() => vi.fn());
const boardMock = vi.hoisted(() => vi.fn());

vi.mock("./db", () => dbMock);
vi.mock("./realtimeSimEngine", () => ({ processCandle: processCandleMock }));
vi.mock("./forwardShadow", () => ({ processForwardShadowSourceEvent: shadowMock }));
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
    processCandleMock.mockResolvedValue({ symbol: "8035", tradeDate: "2026-09-03", candleTime: "10:00", action: "none" });
    shadowMock.mockResolvedValue({ skipped: false, results: [] });
  });

  it("最初のイベントだけ現行エンジンとシャドーへ渡す", async () => {
    dbMock.claimRtSourceEvent.mockResolvedValue(true);
    const result = await ingestSourceCandle(input);
    expect(processCandleMock).toHaveBeenCalledTimes(1);
    expect(shadowMock).toHaveBeenCalledTimes(1);
    expect(dbMock.completeRtSourceEvent).toHaveBeenCalledWith(expect.objectContaining({ status: "processed" }));
    expect(result.sourceEventDuplicate).toBe(false);
  });

  it("同じイベントIDの再送は現行エンジンもシャドーも再実行しない", async () => {
    dbMock.claimRtSourceEvent.mockResolvedValue(false);
    dbMock.getRtSourceEvent.mockResolvedValue({ status: "processed", payloadHash: "a".repeat(64), resultJson: { action: "entry" } });
    const result = await ingestSourceCandle(input);
    expect(processCandleMock).not.toHaveBeenCalled();
    expect(shadowMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ action: "none", reason: "duplicate_source_event", sourceEventDuplicate: true });
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
});
