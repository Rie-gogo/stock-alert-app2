import { beforeEach, describe, expect, it, vi } from "vitest";

const memory = vi.hoisted(() => ({
  states: new Map<string, any>(),
  claims: new Set<string>(),
  trades: [] as any[],
  events: [] as any[],
  failFixedStopRegistration: false,
}));

vi.mock("./db", () => ({
  upsertRtStrategyVersion: vi.fn(async data => {
    if (memory.failFixedStopRegistration && data.configJson?.variant === "fixed_stop_140_cooldown_30") {
      throw new Error("forced_fixed_stop_registration_failure");
    }
  }),
  getRtStrategyVersion: vi.fn(async () => ({ status: "monitoring", statusReason: null })),
  updateRtStrategyVersionStatus: vi.fn(),
  acquireRtForwardShadowStateLock: vi.fn(async () => true),
  releaseRtForwardShadowStateLock: vi.fn(),
  getRtForwardShadowState: vi.fn(async ({ strategyVersion, evaluationMode }) => memory.states.get(`${strategyVersion}:${evaluationMode}`) ?? null),
  upsertRtForwardShadowState: vi.fn(async data => memory.states.set(`${data.strategyVersion}:${data.evaluationMode}`, { ...data })),
  claimOrRetryRtForwardShadowEvent: vi.fn(async ({ data }) => {
    const key = `${data.strategyVersion}:${data.sourceEventId}:${data.evaluationMode}`;
    if (memory.claims.has(key)) return "completed";
    memory.claims.add(key);
    memory.events.push({ ...data });
    return "claimed";
  }),
  failRtForwardShadowEvent: vi.fn(),
  updateRtForwardShadowEvent: vi.fn(async data => {
    const target = memory.events.find(item => item.strategyVersion === data.strategyVersion
      && item.sourceEventId === data.sourceEventId
      && item.evaluationMode === data.evaluationMode);
    Object.assign(target, data);
  }),
  insertRtForwardShadowTrade: vi.fn(async data => memory.trades.push({ ...data })),
  closeRtForwardShadowTrade: vi.fn(async data => {
    const target = memory.trades.find(item => item.strategyVersion === data.strategyVersion
      && item.evaluationMode === data.evaluationMode
      && item.entrySourceEventId === data.entrySourceEventId);
    Object.assign(target, data);
  }),
  getRtForwardShadowTrades: vi.fn(async () => memory.trades),
  getLatestRtPremarketContextSnapshot: vi.fn(async () => ({
    sourceSnapshotId: "test:premarket", qualityStatus: "verified", regimeState: "up", confidence: "medium",
  })),
}));

import { processForwardShadowSourceEvent } from "./forwardShadow";
describe("8035未見データ前向きシャドー統合", () => {
  beforeEach(() => {
    memory.states.clear();
    memory.claims.clear();
    memory.trades.length = 0;
    memory.events.length = 0;
    memory.failFixedStopRegistration = false;
  });

  it("Bollinger基準variantが失敗しても、残る4案の両modeを継続する", async () => {
    memory.failFixedStopRegistration = true;
    // 基準案のversion登録だけを強制失敗させ、独立variantの継続を確認する。
    const result: any = await processForwardShadowSourceEvent({
      sourceEventId: "bollinger-isolation:1",
      internalSkipAiDailyForecastShadow: true,
      candle: { symbol: "285A", tradeDate: "2026-10-13", candleTime: "09:00", open: 100, high: 100.1, low: 99.9, close: 100, volume: 100 },
      board: null,
    });
    const evaluations = result.bollingerDirectionalShadow.evaluations;
    expect(evaluations.some((item: any) => item.skipped === "isolated_mode_error" || item.skipped === "isolated_variant_registration_error")).toBe(true);
    const continuedVersions = new Set(memory.events.map(item => item.strategyVersion));
    for (const marker of [
      "bollinger-directional-sma20-dynamic-gap060",
      "bollinger-directional-sma20-slope-gap060",
      "bollinger-directional-sma20-slope-bbwidth5-gap060",
      "bollinger-directional-sma10-slope-gap050",
    ]) expect(memory.events.filter(item => item.strategyVersion.includes(marker))).toHaveLength(2);
  });

});
