import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AI_POSTMARKET_REVIEW_ID_SUFFIX,
  aiPostmarketLearningInputHash,
  aiPostmarketReviewIdempotencyOutcomeForTest,
  assertAiPostmarketFinalityForTest,
  isPostmarketReviewBeforeForecastForTest,
  validateAiPostmarketLearningReviewForTest,
} from "./aiPostmarketLearningService";
import { closedTradeDateWatermarkHash } from "./closedTradeDateTailDrain";
import { snapshotFromCandles } from "./aiForecastLearningService";

const symbols = [
  "285A",
  "3436",
  "5803",
  "6146",
  "6526",
  "6857",
  "6976",
  "6981",
  "8035",
  "9984",
] as const;

const metrics = {
  pnl: 100,
  totalR: 1,
  winRatePct: 60,
  maxDrawdown: 20,
};
const readyWatermark = {
  source: { count: 1, maxId: 1, processed: 1, processing: 0, failed: 0 },
  decision: { count: 1, maxId: 1 },
  candidateOutbox: {
    processed: 1,
    pending: 0,
    processing: 0,
    retryableError: 0,
    terminal: 0,
  },
  shadowOutbox: { count: 1, processed: 1, pending: 0, processing: 0, error: 0 },
  unresolvedGaps: 0,
  latestUpstreamCreatedAt: new Date("2026-10-10T09:00:00Z"),
};
const referenceIndex = {
  eventSymbolById: Object.fromEntries(symbols.map(symbol => [`event:${symbol}`, symbol])),
  tradeSymbolByEntryId: Object.fromEntries(symbols.map(symbol => [`trade:${symbol}`, symbol])),
};
const prepared = {
  tradeDate: "2026-10-10",
  inputHash: "a".repeat(64),
  currentDay: { referenceIndex },
} as const;

function review(input: Partial<Record<string, unknown>> = {}) {
  return {
    reviewId: `ai-learning-review:2026-10-10:${AI_POSTMARKET_REVIEW_ID_SUFFIX}`,
    tradeDate: "2026-10-10",
    inputHash: "a".repeat(64),
    generatedAtMs: Date.parse("2026-10-11T00:00:00+09:00"),
    generatorId: "codex-postmarket-test",
    promptVersion: "codex-postmarket-learning-v1",
    model: "codex-test",
    status: "candidate",
    symbolReviews: symbols.map(symbol => ({
      symbol,
      strengths: ["immutable evidence reviewed"],
      failureTags: ["test_tag"],
      evidence: {
        eventIds: [`event:${symbol}`],
        tradeEntrySourceEventIds: [`trade:${symbol}`],
      },
      reproducibility: "unverified",
      confidence: 0.5,
    })),
    hypotheses: [],
    validation: {
      method: "walk_forward",
      learningPeriod: { start: "2026-09-01", end: "2026-10-01" },
      validationPeriod: { start: "2026-10-02", end: "2026-10-09" },
      closedTrades: 10,
      validationBusinessDays: 3,
      dataQuality: "verified",
      excludesDegradedInvalid: true,
      baseline: metrics,
      normalExecution: metrics,
      adverseExecution010Pct: metrics,
    },
    policyAdvice: { advice: [], prohibitions: ["do_not_mutate_app_rules"] },
    ...input,
  };
}

describe("AI postmarket Codex learning review contract", () => {
  it("closed/finality・watermark・materializationが揃わない限りfail-closedにする", () => {
    const hash = closedTradeDateWatermarkHash(readyWatermark);
    expect(() =>
      assertAiPostmarketFinalityForTest({
        tradeDate: "2026-10-09",
        finality: { status: "open", watermarkHash: hash },
        watermark: readyWatermark,
        materializationStatus: "complete",
      })
    ).toThrow("finality_not_closed");
    expect(() =>
      assertAiPostmarketFinalityForTest({
        tradeDate: "2026-10-09",
        finality: { status: "closed", watermarkHash: "b".repeat(64) },
        watermark: readyWatermark,
        materializationStatus: "complete",
      })
    ).toThrow("watermark_changed");
    expect(() =>
      assertAiPostmarketFinalityForTest({
        tradeDate: "2026-10-09",
        finality: { status: "closed", watermarkHash: hash },
        watermark: readyWatermark,
        materializationStatus: "processing",
      })
    ).toThrow("materialization_incomplete");
  });

  it("JPX現物休場日をno-opとして拒否する（2026-10-12）", () => {
    const hash = closedTradeDateWatermarkHash(readyWatermark);
    expect(() =>
      assertAiPostmarketFinalityForTest({
        tradeDate: "2026-10-12",
        finality: { status: "closed", watermarkHash: hash },
        watermark: readyWatermark,
        materializationStatus: "complete",
      })
    ).toThrow("non_trading_date");
  });

  it("input hashは取得時刻を含めず、同じimmutable inputで安定する", () => {
    const input = {
      contractVersion: "ai-postmarket-learning-contract-v1",
      tradeDate: "2026-10-10",
      dataFinality: { status: "closed" },
      inputQuality: "verified",
      qualityReasonCodes: [],
      snapshots: { morning: [], intraday: [] },
      currentDay: { symbols: [], referenceIndex: {} },
      historical: {
        closedTradeDates: [],
        examples: [],
        maximumExamples: 500,
        strategyLearningSource: "signal_quality_only",
        executionAuditSource: "capital_constrained_separate_not_market_case",
      },
      dataState: { coldStart: true, smallSample: true, missing: [] },
    } as any;
    const first = aiPostmarketLearningInputHash(input);
    const second = aiPostmarketLearningInputHash({ ...input, inputHash: "ignored" });
    expect(first).toBe(second);
  });

  it("entry後の足をentry causal特徴へ混ぜない", () => {
    const candles = [
      { candleTime: "09:00", open: 100, high: 101, low: 99, close: 100, volume: 1 },
      { candleTime: "09:01", open: 100, high: 10_000, low: 1, close: 9_999, volume: 1 },
    ];
    const before = snapshotFromCandles(candles, "09:00");
    const mutated = snapshotFromCandles(
      [{ ...candles[0]! }, { ...candles[1]!, close: 1, high: 1, low: 1 }],
      "09:00"
    );
    expect(mutated).toEqual(before);
  });

  it("同一reviewIdは同一payloadだけduplicate、異hashはreject対象にする", () => {
    expect(aiPostmarketReviewIdempotencyOutcomeForTest(null, "a")).toBe("insert");
    expect(aiPostmarketReviewIdempotencyOutcomeForTest("a", "a")).toBe("duplicate");
    expect(aiPostmarketReviewIdempotencyOutcomeForTest("a", "b")).toBe("conflict");
  });

  it("same-day review、標本不足、劣化品質、通常／不利約定またはDD悪化のvalidatedを拒否する", () => {
    const sameDay = review({
      status: "validated",
      generatedAtMs: Date.parse("2026-10-10T18:00:00+09:00"),
    });
    expect(
      validateAiPostmarketLearningReviewForTest({ review: sameDay, prepared }).reasonCodes
    ).toContain("same_day_review_cannot_be_validated");

    const degraded = review({
      status: "validated",
      validation: {
        ...(review().validation as Record<string, unknown>),
        closedTrades: 9,
        validationBusinessDays: 2,
        dataQuality: "degraded",
        normalExecution: { ...metrics, pnl: 99 },
        adverseExecution010Pct: { ...metrics, maxDrawdown: 21 },
      },
    });
    const rejected = validateAiPostmarketLearningReviewForTest({
      review: degraded,
      prepared,
    });
    expect(rejected.valid).toBe(false);
    expect(rejected.reasonCodes).toEqual(
      expect.arrayContaining([
        "validated_requires_ten_closed_trades",
        "validated_requires_three_validation_business_days",
        "validated_cannot_include_degraded_or_invalid_data",
        "validated_normal_pnl_degrades_baseline",
        "validated_adverse_010pct_max_drawdown_worsens",
      ])
    );
  });

  it("reference ownershipをsymbol別に検証し、他銘柄のevent/trade根拠を拒否する", () => {
    const invalid = review();
    (invalid.symbolReviews[1] as any).evidence.eventIds = ["event:285A"];
    const result = validateAiPostmarketLearningReviewForTest({
      review: invalid,
      prepared,
    });
    expect(result.valid).toBe(false);
    expect(result.reasonCodes).toContain(
      "symbol:3436:event_reference_not_owned:event:285A"
    );
  });

  it("reviewは翌日以降だけを入力候補にし、app側の自動rule mutationは追加しない", () => {
    expect(isPostmarketReviewBeforeForecastForTest("2026-10-10", "2026-10-10")).toBe(false);
    expect(isPostmarketReviewBeforeForecastForTest("2026-10-10", "2026-10-13")).toBe(true);
    const daily = readFileSync(
      new URL("./aiDailyForecastService.ts", import.meta.url),
      "utf8"
    );
    const intraday = readFileSync(
      new URL("./aiIntradayForecastService.ts", import.meta.url),
      "utf8"
    );
    expect(daily).toContain("getLatestLearningReviewApplicationBefore(input.tradeDate)");
    expect(intraday).toContain("latestLearningReview: priorData.latestLearningReview");
    expect(daily).not.toContain("automaticRuleMutation: true");
  });
});
