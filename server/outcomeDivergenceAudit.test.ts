import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  getRtOutcomeLabelsThroughDate: vi.fn(async () => []),
  getRtRealtimeDecisionEventsForDate: vi.fn(),
  getRtSourceEventsForDate: vi.fn(),
  upsertRtDivergenceHypothesis: vi.fn(),
  upsertRtOutcomeLabel: vi.fn(),
}));
vi.mock("./db", () => dbMock);

import { buildDivergenceHypotheses, buildOutcomeLabelsForDate } from "./outcomeDivergenceAudit";

describe("成績乖離診断ラベル", () => {
  beforeEach(() => vi.clearAllMocks());

  it("MFE・MAE・1/3/5分後を診断専用として保存する", async () => {
    dbMock.getRtRealtimeDecisionEventsForDate.mockResolvedValue([
      { id: 1, sourceEventDbId: 1, sourceEventId: "entry", symbol: "8035", tradeDate: "2026-09-07", candleTime: "10:00", routeId: "tel_open_direction_breakout_long", side: "long", resultType: "entry", simulatedBarFillPrice: "100", shares: 100, executablePriceProxy: "100.2", causalityStatus: "violation", resultJson: { result: { action: "entry" } } },
      { id: 2, sourceEventDbId: 2, sourceEventId: "h1", symbol: "8035", resultType: "hold", resultJson: { result: { action: "none" } } },
      { id: 3, sourceEventDbId: 3, sourceEventId: "h2", symbol: "8035", resultType: "hold", resultJson: { result: { action: "none" } } },
      { id: 4, sourceEventDbId: 4, sourceEventId: "h3", symbol: "8035", resultType: "hold", resultJson: { result: { action: "none" } } },
      { id: 5, sourceEventDbId: 5, sourceEventId: "exit", symbol: "8035", resultType: "exit", simulatedBarFillPrice: "99", resultJson: { result: { action: "stop_loss", pnl: -100 } } },
    ]);
    dbMock.getRtSourceEventsForDate.mockResolvedValue([
      { id: 1, payloadJson: { open: 100, high: 100, low: 100, close: 100, candleTime: "10:00" } },
      { id: 2, payloadJson: { open: 100, high: 100.05, low: 99.8, close: 99.9, candleTime: "10:01" } },
      { id: 3, payloadJson: { open: 99.9, high: 100, low: 99.7, close: 99.8, candleTime: "10:02" } },
      { id: 4, payloadJson: { open: 99.8, high: 99.9, low: 99.5, close: 99.6, candleTime: "10:03" } },
      { id: 5, payloadJson: { open: 99.6, high: 99.7, low: 99, close: 99, candleTime: "10:04" } },
    ]);
    const result = await buildOutcomeLabelsForDate("2026-09-07");
    expect(result).toMatchObject({ labels: 1, completed: 1 });
    expect(dbMock.upsertRtOutcomeLabel).toHaveBeenCalledWith(expect.objectContaining({
      diagnosisOnly: true,
      after1mPct: expect.any(String),
      after3mPct: expect.any(String),
      counterfactualJson: expect.objectContaining({
        futureFeaturePolicy: "MFE_MAE_and_after_1_3_5m_are_diagnosis_only",
      }),
    }));
  });

  it("過去比較だけでは確信度highを付けず、自動シャドー化しない", async () => {
    dbMock.getRtOutcomeLabelsThroughDate.mockResolvedValue([{
      tradeDate: "2026-09-07", symbol: "8035", routeId: "route", entrySourceEventId: "loss", finalPnl: -100,
      counterfactualJson: { causes: [{ code: "no_positive_followthrough_3m", usesFuture: true }] },
    }]);
    await buildDivergenceHypotheses("2026-09-07");
    expect(dbMock.upsertRtDivergenceHypothesis).toHaveBeenCalledWith(expect.objectContaining({
      confidence: "low", status: "observing",
      metricsJson: expect.objectContaining({ mayBecomeEntryCondition: false }),
    }));
  });
});
