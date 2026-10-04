import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";

const dbMock = vi.hoisted(() => ({
  getRtMarketContextEvent: vi.fn(),
  getRtMarketContextEventsForDate: vi.fn(),
  getLatestRtMarketContextEventForInstrumentDate: vi.fn(),
  getLatestRtMarketContextEventForRelaySession: vi.fn(),
  getLatestRtPremarketContextSnapshot: vi.fn(),
  insertRtMarketContextEvent: vi.fn(),
}));

vi.mock("./db", () => dbMock);

import {
  ingestMarketContext,
  marketContextIngressViolation,
  MARKET_CONTEXT_DAY_SESSION_END,
  MARKET_CONTEXT_DAY_SESSION_START,
} from "./marketContextIngestion";
import { tradingRouter } from "./routers/trading";

const input = {
  instrumentKey: "nikkei225_mini_front" as const,
  providerSymbol: "NK225mini-test",
  productType: "future" as const,
  contractMonth: "2026/12",
  marketSession: "day_night" as const,
  tradeDate: "2026-10-05",
  candleTime: "09:05",
  open: 50000,
  high: 50010,
  low: 49990,
  close: 50005,
  volume: null,
  previousClose: 49900,
  valueSource: "ws_aggregated" as const,
  sourceEventId: "relay-1:market:100",
  relaySessionId: "relay-1",
  eventSeq: 100,
  payloadHash: "a".repeat(64),
  observedAtMs: Date.now() - 1_000,
  relaySentAtMs: Date.now() - 500,
};

function persisted(overrides: Record<string, unknown> = {}) {
  return {
    ...input,
    relayPayloadHash: input.payloadHash,
    id: 1,
    payloadJson: {},
    cloudReceivedAtMs: 1_790_000_000_200,
    correctedEventId: null,
    qualityStatus: "verified",
    resultJson: { monitoringOnly: true },
    createdAt: new Date("2026-10-05T00:05:00.000Z"),
    ...overrides,
  };
}

describe("market-context ingress boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.getRtMarketContextEvent.mockResolvedValue(null);
    dbMock.getRtMarketContextEventsForDate.mockResolvedValue([]);
    dbMock.getLatestRtMarketContextEventForInstrumentDate.mockResolvedValue(null);
    dbMock.getLatestRtMarketContextEventForRelaySession.mockResolvedValue(null);
    dbMock.getLatestRtPremarketContextSnapshot.mockResolvedValue(null);
    dbMock.insertRtMarketContextEvent.mockImplementation(async (row: Record<string, unknown>) => persisted({
      sourceEventId: row.sourceEventId,
      relaySessionId: row.relaySessionId,
      eventSeq: row.eventSeq,
      payloadHash: row.payloadHash,
      candleTime: row.candleTime,
      resultJson: row.resultJson,
      qualityStatus: row.qualityStatus,
    }));
  });

  it("accepts only the Nikkei 225 mini day/night feed during the declared day session", () => {
    expect(marketContextIngressViolation(input)).toBeNull();
    expect(MARKET_CONTEXT_DAY_SESSION_START).toBe("08:45");
    expect(MARKET_CONTEXT_DAY_SESSION_END).toBe("15:45");
    expect(marketContextIngressViolation({ ...input, instrumentKey: "nikkei225_cash" } as never)).toBe("unexpected_market_context_instrument");
    expect(marketContextIngressViolation({ ...input, productType: "index" } as never)).toBe("market_context_product_must_be_future");
    expect(marketContextIngressViolation({ ...input, marketSession: "cash" } as never)).toBe("market_context_session_must_be_day_night");
    expect(marketContextIngressViolation({ ...input, candleTime: "08:44" })).toBe("market_context_candle_time_outside_day_session");
    expect(marketContextIngressViolation({ ...input, candleTime: "15:46" })).toBe("market_context_candle_time_outside_day_session");
  });

  it("rejects invalid or correction-style input before any database query", async () => {
    const malformed = await ingestMarketContext({ ...input, low: 50006 });
    expect(malformed).toMatchObject({ accepted: false, reason: "market_context_ohlc_invalid" });
    const correction = await ingestMarketContext({ ...input, correctedEventId: "older-market-event" });
    expect(correction).toMatchObject({ accepted: false, reason: "market_context_correction_not_accepted" });
    expect(dbMock.getRtMarketContextEvent).not.toHaveBeenCalled();
    expect(dbMock.insertRtMarketContextEvent).not.toHaveBeenCalled();
  });

  it("treats identical sourceEventId with different content as a fail-closed mismatch", async () => {
    dbMock.getRtMarketContextEvent.mockResolvedValue(persisted({ payloadHash: "b".repeat(64) }));
    const result = await ingestMarketContext(input);
    expect(result).toMatchObject({ accepted: false, duplicate: true, payloadMismatch: true });
    expect(dbMock.insertRtMarketContextEvent).not.toHaveBeenCalled();
  });

  it("treats a changed relay payload hash for the same source identity as a mismatch", async () => {
    dbMock.getRtMarketContextEvent.mockResolvedValue(persisted({ relayPayloadHash: "b".repeat(64) }));
    const result = await ingestMarketContext(input);
    expect(result).toMatchObject({ accepted: false, duplicate: true, payloadMismatch: true });
    expect(dbMock.insertRtMarketContextEvent).not.toHaveBeenCalled();
  });

  it("rejects candle-time and relay-sequence inversions without writing", async () => {
    dbMock.getLatestRtMarketContextEventForInstrumentDate.mockResolvedValue(persisted({ candleTime: "09:06" }));
    let result = await ingestMarketContext(input);
    expect(result).toMatchObject({ accepted: false, reason: "market_context_candle_time_non_monotonic" });
    expect(dbMock.insertRtMarketContextEvent).not.toHaveBeenCalled();

    dbMock.getLatestRtMarketContextEventForInstrumentDate.mockResolvedValue(null);
    dbMock.getLatestRtMarketContextEventForRelaySession.mockResolvedValue(persisted({ eventSeq: 101 }));
    result = await ingestMarketContext(input);
    expect(result).toMatchObject({ accepted: false, reason: "market_context_event_sequence_non_monotonic" });
    expect(dbMock.insertRtMarketContextEvent).not.toHaveBeenCalled();
  });

  it("records a valid mini bar only in the isolated market-context path", async () => {
    const result = await ingestMarketContext(input);
    expect(result).toMatchObject({ accepted: true, duplicate: false, payloadMismatch: false, qualityStatus: "verified" });
    expect(dbMock.insertRtMarketContextEvent).toHaveBeenCalledWith(expect.objectContaining({
      instrumentKey: "nikkei225_mini_front",
      productType: "future",
      marketSession: "day_night",
      sourceEventId: input.sourceEventId,
      eventSeq: input.eventSeq,
    }));
  });

  it("fails closed if a concurrent insert exposes a mismatched immutable source identity", async () => {
    dbMock.insertRtMarketContextEvent.mockResolvedValue(persisted({ payloadHash: "c".repeat(64) }));
    const result = await ingestMarketContext(input);
    expect(result).toMatchObject({ accepted: false, duplicate: true, payloadMismatch: true });
  });

  it("keeps the Windows-compatible public procedure while rejecting invalid endpoint payloads", async () => {
    const caller = tradingRouter.createCaller({} as never);
    await expect(caller.pushMarketContext(input)).resolves.toMatchObject({ accepted: true });
    await expect(caller.pushMarketContext({ ...input, instrumentKey: "nikkei225_cash" } as never))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller.pushMarketContext({ ...input, marketSession: "cash" } as never))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller.pushMarketContext({ ...input, candleTime: "15:46" }))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
    const { sourceEventId: _sourceEventId, ...withoutIdentity } = input;
    await expect(caller.pushMarketContext(withoutIdentity as never))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("does not import the current engine, standard source ingestion, shadow sequence, or order bridge", async () => {
    const source = await readFile(new URL("./marketContextIngestion.ts", import.meta.url), "utf8");
    for (const forbidden of ["./realtimeSimEngine", "./sourceEventIngestion", "./forwardShadowSequence", "./forwardShadow", "./orderBridge", "processCandle("]) {
      expect(source).not.toContain(forbidden);
    }
    const router = await readFile(new URL("./routers/trading.ts", import.meta.url), "utf8");
    expect(router).toContain("pushMarketContext: publicProcedure");
  });
});
