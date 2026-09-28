import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyTelExecutableConfirmState, TEL_EXECUTABLE_CONFIRM_VERSION } from "./telExecutableConfirm";
import { readFileSync } from "node:fs";

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
import { ARCHIVED_NO_SIGNAL_STATUS_REASON } from "./shadowArchiveLifecycle";

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

  it("旧Aを停止・監査保持の別versionとして保存し、注文モジュールへ接続しない", async () => {
    const result = await processTelExecutableConfirmSourceEvent({
      sourceEventId: "next", board: { currentPrice: 100.05 },
      candle: { symbol: "8035", tradeDate: "2026-09-07", candleTime: "10:01", open: 100, high: 100.2, low: 99.9, close: 100.1, volume: 100 },
    });
    expect(result.skipped).toBe(false);
    expect(dbMock.upsertRtStrategyVersion).toHaveBeenCalledWith(expect.objectContaining({
      versionId: TEL_EXECUTABLE_CONFIRM_VERSION,
      evaluationPurpose: "candidate",
      eligibleForAdoption: false,
      status: "stopped",
      statusReason: "superseded_by_candidate_8035_executable_depth_v2_before_formal_start",
    }));
    expect(dbMock.insertRtForwardShadowTrade).toHaveBeenCalledTimes(2);
    expect(dbMock.insertRtForwardShadowTrade).toHaveBeenCalledWith(expect.objectContaining({
      strategyVersion: TEL_EXECUTABLE_CONFIRM_VERSION,
      evaluationMode: "signal_quality",
      shares: 100,
    }));
    expect(dbMock.upsertRtForwardShadowState).toHaveBeenCalledTimes(2);
  });

  it("DB upsertは既存versionの明示lifecycleを起動時再登録で上書きしない", () => {
    const source = readFileSync(new URL("./db.ts", import.meta.url), "utf8");
    expect(source).toContain("eligibleForAdoption: data.eligibleForAdoption");
    expect(source).toContain("lifecycle変更はupdateRtStrategyVersionStatusの明示操作だけに限定する");
    expect(source).not.toContain("data.eligibleForAdoption === false");
  });

  it("archived_no_signalの停止版は新しいsource eventでもcandidate/state/tradeを作らない", async () => {
    dbMock.getRtStrategyVersion.mockResolvedValue({
      status: "stopped",
      statusReason: ARCHIVED_NO_SIGNAL_STATUS_REASON,
    });

    const result = await processTelExecutableConfirmSourceEvent({
      sourceEventId: "archived:next",
      board: { currentPrice: 100.05 },
      candle: { symbol: "8035", tradeDate: "2026-09-29", candleTime: "09:31", open: 100, high: 100.2, low: 99.9, close: 100.1, volume: 100 },
    });

    expect(result).toEqual({ skipped: "strategy_stopped" });
    expect(dbMock.claimOrRetryRtForwardShadowEvent).not.toHaveBeenCalled();
    expect(dbMock.upsertRtForwardShadowState).not.toHaveBeenCalled();
    expect(dbMock.insertRtForwardShadowTrade).not.toHaveBeenCalled();
  });
});
