import { describe, expect, it } from "vitest";
import { buildLearningApplicationAudit } from "./aiForecastLearningAudit";
import type { QuantBaseline } from "./aiDailyForecastService";

const baseline: QuantBaseline = {
  symbol: "285A",
  direction: "up",
  atr5: 2,
  score: 0.4,
  closeSlope: 0.1,
  momentum3: 0.1,
  closeLocation: 0.6,
  forecastLow: 98,
  forecastHigh: 108,
  zoneType: "pullback",
  zoneLow: 99,
  zoneHigh: 102,
  confirmPrice: 102,
  firstTarget: 105,
  stretchTarget: 108,
  stopReference: 98,
  usableDates: ["2026-10-09"],
  excludedDates: [],
  originalUnroundedPrices: {},
  noTradeReasonCodes: [],
};

describe("AI forecast learning application audit v4", () => {
  it("cold-startを監査し、類似事例がない場合に自動適用しない", () => {
    const audit = buildLearningApplicationAudit({
      checkpoint: "08:30",
      baselines: [{ symbol: "285A", baseline }],
      macroRegime: "up",
      learningSnapshot: null,
    });
    expect(audit.learningMode).toBe("cold_start");
    expect(audit.learningApplied).toBe(false);
    expect(audit.symbols[0]).toMatchObject({
      noSimilarAnalog: true,
      eligibleExampleCount: 0,
      sameCondition: { count: 0 },
    });
  });

  it("遠い事例を類似事例として強制採用しない", () => {
    const audit = buildLearningApplicationAudit({
      checkpoint: "08:30",
      baselines: [{ symbol: "285A", baseline }],
      macroRegime: "up",
      learningSnapshot: {
        sourceSnapshotId: "learning:1",
        asOfDate: "2026-10-09",
        modelVersion: "ai-forecast-learning-v1",
        payloadHash: "hash",
        learning: {
          generatedFrom: { learningMode: "learned" },
          symbols: [
            {
              symbol: "285A",
              analogCases: [
                {
                  identity: {
                    tradeDate: "2026-10-01",
                    symbol: "285A",
                    entryCandleTime: "09:31",
                  },
                  side: "short",
                  checkpoint: "14:30",
                  gapBucket: "large_down",
                  fiveMinuteSma20Direction: "down",
                  bbPositionBucket: "outer",
                  rsiBucket: "overbought",
                  macroRegime: "down",
                  expectedRrBucket: "below_1",
                  pnl: 100,
                  realizedR: 1,
                },
              ],
            },
          ],
        },
      },
    });
    expect(audit.symbols[0]!.nearestCandidates).toHaveLength(0);
    expect(audit.symbols[0]!.noSimilarAnalog).toBe(true);
  });
});
