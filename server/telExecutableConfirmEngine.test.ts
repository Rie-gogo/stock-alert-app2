import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyTelExecutableConfirmState, TEL_EXECUTABLE_CONFIRM_VERSION } from "./telExecutableConfirm";

const dbMock = vi.hoisted(() => ({
  acquireRtForwardShadowStateLock: vi.fn(async () => true),
  claimOrRetryRtForwardShadowEvent: vi.fn(async () => "claimed"),
  closeRtForwardShadowTrade: vi.fn(),
  failRtForwardShadowEvent: vi.fn(),
  getRtForwardShadowState: vi.fn(),
  getRtStrategyVersion: vi.fn(async () => ({ status: "monitoring" })),
  insertRtForwardShadowTrade: vi.fn(),
  releaseRtForwardShadowStateLock: vi.fn(),
  updateRtForwardShadowEvent: vi.fn(),
  upsertRtForwardShadowState: vi.fn(),
  upsertRtStrategyVersion: vi.fn(),
}));
vi.mock("./db", () => dbMock);

import { processTelExecutableConfirmSourceEvent, resetTelExecutableConfirmVersionCacheForTest } from "./telExecutableConfirmEngine";

describe("8035改善案A 独立永続化", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetTelExecutableConfirmVersionCacheForTest();
    const state = createEmptyTelExecutableConfirmState();
    state.tradeDate = "2026-09-07";
    state.pending = {
      side: "long", signalSourceEventId: "origin", signalTime: "10:00",
      theoreticalSignalPrice: 100, breakoutLevel: 99.5, metrics: {},
    };
    dbMock.getRtForwardShadowState.mockResolvedValue({ stateJson: state });
  });

  it("別version・2評価方式・100株品質版で保存し、注文モジュールへ接続しない", async () => {
    const result = await processTelExecutableConfirmSourceEvent({
      sourceEventId: "next", board: { currentPrice: 100.05 },
      candle: { symbol: "8035", tradeDate: "2026-09-07", candleTime: "10:01", open: 100, high: 100.2, low: 99.9, close: 100.1, volume: 100 },
    });
    expect(result.skipped).toBe(false);
    expect(dbMock.upsertRtStrategyVersion).toHaveBeenCalledWith(expect.objectContaining({
      versionId: TEL_EXECUTABLE_CONFIRM_VERSION,
      evaluationPurpose: "candidate",
      eligibleForAdoption: true,
    }));
    expect(dbMock.insertRtForwardShadowTrade).toHaveBeenCalledTimes(2);
    expect(dbMock.insertRtForwardShadowTrade).toHaveBeenCalledWith(expect.objectContaining({
      strategyVersion: TEL_EXECUTABLE_CONFIRM_VERSION,
      evaluationMode: "signal_quality",
      shares: 100,
    }));
    expect(dbMock.upsertRtForwardShadowState).toHaveBeenCalledTimes(2);
  });
});
