import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  getRtAuditTradeDateWatermark: vi.fn(),
  getRtDailyAuditMaterialization: vi.fn(),
  getLatestRtPremarketContextSnapshot: vi.fn(),
  finalizeRtMarketContextSelectorResult: vi.fn(),
  finalizeRtPremarketContextSelectorResult: vi.fn(),
}));
const performanceMock = vi.hoisted(() => ({
  resolveMarketContextV4RouteCandidatesCached: vi.fn(),
  buildIntradayContextPerformanceSelectorDecision: vi.fn(),
  buildPremarketContextPerformanceSelectorDecision: vi.fn(),
}));
const v3Mock = vi.hoisted(() => ({
  buildMarketContextSelectorShadowDecision: vi.fn(),
  buildPremarketMarketContextSelectorShadowDecision: vi.fn(),
}));

vi.mock("./db", () => dbMock);
vi.mock("./marketContextPerformanceSelector", () => performanceMock);
vi.mock("./marketContextSelectorShadow", () => v3Mock);
vi.mock("./routeGranularNextDaySelector", () => ({
  ROUTE_GRANULAR_SELECTOR_SNAPSHOT_COMPONENT: "route_component",
  ROUTE_GRANULAR_SELECTOR_VERSION: "route_version",
}));

import {
  enqueueMarketContextSelectorWorker,
  enqueuePremarketContextSelectorWorker,
  marketContextSelectorWorkerEnabled,
} from "./marketContextSelectorWorker";

const watermark = (overrides: Record<string, unknown> = {}) => ({
  source: { count: 1, maxId: 1, processed: 1, processing: 0, failed: 0 },
  decision: { count: 1, maxId: 1 },
  candidateOutbox: { processed: 1, pending: 0, processing: 0, retryableError: 0, terminal: 0 },
  shadowOutbox: { count: 1, processed: 1, pending: 0, processing: 0, error: 0 },
  unresolvedGaps: 0,
  latestUpstreamCreatedAt: null,
  ...overrides,
});

function input(sourceEventId = "worker:1") {
  return {
    sourceEventId,
    tradeDate: "2030-10-01",
    checkpoint: "09:05" as const,
    intradayRegime: { state: "up", allowedDirections: ["long"], checkpoint: true, decisionAt: "09:05", reasonCodes: [] } as any,
  };
}

async function flushWorker() {
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
}

describe("market-context detached selector worker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.MARKET_CONTEXT_PERFORMANCE_SELECTOR_ENABLED;
    dbMock.getRtAuditTradeDateWatermark.mockResolvedValue(watermark());
    dbMock.getRtDailyAuditMaterialization.mockResolvedValue({ resultJson: { selectorVersion: "v3" } });
    dbMock.getLatestRtPremarketContextSnapshot.mockResolvedValue({ resultJson: { regime: { state: "up", allowedDirections: ["long"] } } });
    dbMock.finalizeRtMarketContextSelectorResult.mockResolvedValue(null);
    dbMock.finalizeRtPremarketContextSelectorResult.mockResolvedValue(null);
    performanceMock.resolveMarketContextV4RouteCandidatesCached.mockResolvedValue({ selectorVersion: "v4", inputHash: "hash", source: "catalog", catalogAudit: {}, scores: [] });
    performanceMock.buildIntradayContextPerformanceSelectorDecision.mockReturnValue({ selectorVersion: "v4", selections: [] });
    performanceMock.buildPremarketContextPerformanceSelectorDecision.mockReturnValue({ selectorVersion: "v4", checkpoint: "08:30", selections: [] });
    v3Mock.buildMarketContextSelectorShadowDecision.mockReturnValue({ selectorVersion: "v3" });
    v3Mock.buildPremarketMarketContextSelectorShadowDecision.mockReturnValue({ selectorVersion: "v3" });
  });

  it("is feature-flag reversible", () => {
    expect(marketContextSelectorWorkerEnabled()).toBe(true);
    process.env.MARKET_CONTEXT_PERFORMANCE_SELECTOR_ENABLED = "false";
    expect(marketContextSelectorWorkerEnabled()).toBe(false);
  });

  it("defers only the selector when upstream queues have backlog", async () => {
    dbMock.getRtAuditTradeDateWatermark.mockResolvedValue(watermark({ shadowOutbox: { count: 2, processed: 1, pending: 1, processing: 0, error: 0 } }));
    enqueueMarketContextSelectorWorker(input("worker:backlog"));
    await flushWorker();
    expect(performanceMock.resolveMarketContextV4RouteCandidatesCached).not.toHaveBeenCalled();
    expect(dbMock.finalizeRtMarketContextSelectorResult).toHaveBeenCalledWith(expect.objectContaining({
      sourceEventId: "worker:backlog",
      selectorResult: expect.objectContaining({ selectorReason: "selector_deferred_receive_priority" }),
    }));
  });

  it("uses bounded snapshots and never touches current/shadow dispatch when queues are clear", async () => {
    enqueueMarketContextSelectorWorker(input("worker:clear"));
    await flushWorker();
    expect(dbMock.getRtDailyAuditMaterialization).toHaveBeenCalledTimes(1);
    expect(dbMock.getLatestRtPremarketContextSnapshot).toHaveBeenCalledTimes(1);
    expect(performanceMock.resolveMarketContextV4RouteCandidatesCached).toHaveBeenCalledTimes(1);
    expect(dbMock.finalizeRtMarketContextSelectorResult).toHaveBeenCalledWith(expect.objectContaining({
      sourceEventId: "worker:clear",
      selectorResult: expect.objectContaining({
        contextPerformanceSelectorV4: { selectorVersion: "v4", selections: [] },
        selectorWorker: expect.objectContaining({ status: "completed", input: "bounded_snapshot_reads_only" }),
      }),
    }));
  });

  it("records the 08:30 decision only after the immutable premarket snapshot has been scheduled", async () => {
    enqueuePremarketContextSelectorWorker({
      sourceSnapshotId: "premarket:worker:1",
      tradeDate: "2030-10-01",
      premarketRegime: { state: "up", allowedDirections: ["long"], qualityStatus: "verified", confidence: "low", reasonCodes: [] } as any,
    });
    await flushWorker();
    expect(dbMock.finalizeRtPremarketContextSelectorResult).toHaveBeenCalledWith(expect.objectContaining({
      sourceSnapshotId: "premarket:worker:1",
      selectorResult: expect.objectContaining({
        contextPerformanceSelectorV4: { selectorVersion: "v4", checkpoint: "08:30", selections: [] },
        selectorWorker: expect.objectContaining({ status: "completed", checkpoint: "08:30" }),
      }),
    }));
  });
});
