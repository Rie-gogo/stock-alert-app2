import { describe, expect, it } from "vitest";
import {
  _aiForecastLearningTest,
  AI_FORECAST_LEARNING_MAX_BYTES,
  AI_FORECAST_LEARNING_MODEL_VERSION,
} from "./aiForecastLearningService";

describe("AI forecast learning snapshot", () => {
  const candles = Array.from({ length: 30 }, (_, index) => {
    const minute = 9 * 60 + index;
    const candleTime = `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
    const close = 100 + index;
    return {
      candleTime,
      open: close - 0.4,
      high: close + 0.8,
      low: close - 1,
      close,
      volume: 100 + index,
    };
  });

  it("entry時刻までの確定足だけで技術特徴を固定する", () => {
    const before = _aiForecastLearningTest.snapshotFromCandles(
      candles,
      "09:20"
    ) as Record<string, unknown>;
    const futureMutated = candles.map(candle =>
      candle.candleTime > "09:20"
        ? { ...candle, close: candle.close * 10, high: candle.high * 10 }
        : candle
    );
    const after = _aiForecastLearningTest.snapshotFromCandles(
      futureMutated,
      "09:20"
    ) as Record<string, unknown>;
    expect(after).toEqual(before);
    expect(before.observedAtOrBeforeEntry).toBe(true);
    expect((before.candle as Record<string, unknown>).candleTime).toBe("09:20");
  });

  it("tag候補は判定根拠とfuture利用フラグを保存し、例外削除をしない", () => {
    const candidates = _aiForecastLearningTest.deriveCauseCandidates({
      symbol: "285A",
      side: "long",
      entry: {
        oneMinute: { rsi14: 80, bollinger20: { zScore: 2.2 } },
        fiveMinuteSma20Direction: "down",
        sessionHighUpdated: false,
        sessionLowUpdated: false,
      },
      diagnosisOnly: {
        returns: { m3: -0.3 },
        exitReason: "stop_loss",
        stopThenOriginalTarget: true,
      },
      expectedRR: 0.7,
      gapPct: 1.8,
      macroRegime: "mixed",
    });
    expect(candidates.map(candidate => candidate.tag)).toEqual(
      expect.arrayContaining([
        "low_expected_rr",
        "forecast_baseline_stale_after_large_gap",
        "late_entry_without_session_break",
        "long_chase_above_upper_bb",
        "rsi_extreme_chase",
        "countertrend_to_5m_sma20",
        "no_followthrough_3m",
        "stop_then_original_target",
        "market_context_divergence",
      ])
    );
    expect(
      candidates.find(candidate => candidate.tag === "no_followthrough_3m")
        ?.usesFuture
    ).toBe(true);
    expect(
      candidates.every(
        candidate =>
          candidate.judgementVersion === AI_FORECAST_LEARNING_MODEL_VERSION
      )
    ).toBe(true);
  });

  it("summaryはsignal_quality実績をside別に分け、診断値を同日意思決定入力へ混入しない契約を保持する", () => {
    const base = {
      source: "reference_v1_v2" as const,
      tradeDate: "2026-10-13",
      symbol: "285A",
      checkpoint: "09:30",
      macroRegime: "up",
      entry: {
        candleTime: "09:31",
        bbZScore: 0.4,
        fiveMinuteSma20Direction: "up",
        expectedRR: 1.8,
        gapPct: 0.2,
      },
      causeCandidates: [],
    };
    const result = _aiForecastLearningTest.buildLearningPayloadForTest({
      asOfDate: "2026-10-13",
      examples: [
        {
          ...base,
          side: "long" as const,
          diagnosisOnly: { pnl: 100, realizedR: 1, mfePct: 0.8, maePct: -0.2 },
        },
        {
          ...base,
          side: "short" as const,
          diagnosisOnly: {
            pnl: -50,
            realizedR: -0.5,
            mfePct: 0.1,
            maePct: -0.6,
          },
        },
      ] as any,
    });
    expect(result.qualityStatus).toBe("verified");
    const payload = result.payload as Record<string, unknown>;
    expect(payload.causalBoundary).toEqual({
      usableForTradeDateStrictlyAfter: "2026-10-13",
      diagnosisOnlyExcludedFromDecisionFeatures: true,
    });
    const first = (payload.symbols as Array<Record<string, unknown>>)[0]!;
    expect(first.bySide).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "long", count: 1 }),
        expect.objectContaining({ key: "short", count: 1 }),
      ])
    );
  });

  it("payload容量超過時は例示だけを縮退し、品質理由を明示する", () => {
    const large = "x".repeat(AI_FORECAST_LEARNING_MAX_BYTES);
    const result = _aiForecastLearningTest.buildLearningPayloadForTest({
      asOfDate: "2026-10-13",
      examples: [
        {
          source: "current_v3",
          tradeDate: "2026-10-13",
          symbol: "285A",
          side: "long",
          checkpoint: "09:30",
          macroRegime: null,
          entry: { note: large },
          diagnosisOnly: { pnl: -1 },
          causeCandidates: [],
        },
      ] as any,
    });
    expect(result.qualityStatus).toBe("degraded");
    expect(result.reasons).toContain(
      "learning_payload_examples_trimmed_to_size_limit"
    );
  });

  it("closed AI tradeが0件でもcold-start learning snapshotを生成する", () => {
    const result = _aiForecastLearningTest.buildLearningPayloadForTest({
      asOfDate: "2026-10-10",
      examples: [],
    });
    expect(result.qualityStatus).toBe("verified");
    expect(result.payload).toMatchObject({
      generatedFrom: {
        learningMode: "cold_start",
        coldStartReason: "learning_examples_unavailable",
        automaticRuleMutation: false,
      },
    });
  });

  it("寄り付きgapは前営業日終値を基準にし、欠損を0へ丸めない", () => {
    expect(_aiForecastLearningTest.calculateOpeningGapPct(102, 100)).toBe(2);
    expect(_aiForecastLearningTest.calculateOpeningGapPct(98, 100)).toBe(-2);
    expect(
      _aiForecastLearningTest.calculateOpeningGapPct(100, null)
    ).toBeNull();
  });

  it("entry後またはinvalidの日経225mini eventを因果結合しない", () => {
    const selected = _aiForecastLearningTest.selectCausalMiniEvent(
      [
        { candleTime: "09:29", qualityStatus: "verified", id: "before" },
        { candleTime: "09:30", qualityStatus: "invalid", id: "invalid" },
        { candleTime: "09:31", qualityStatus: "verified", id: "after" },
      ],
      "09:30"
    );
    expect(selected).toMatchObject({ id: "before" });
  });

  it("MFE・MAEはexit後を混入せず、時間差returnは厳密な時刻の足だけを使う", () => {
    const outcome = _aiForecastLearningTest.outcomeFromCandles(
      [
        {
          candleTime: "09:00",
          open: 100,
          high: 101,
          low: 99,
          close: 100,
          volume: 1,
        },
        {
          candleTime: "09:01",
          open: 100,
          high: 102,
          low: 99,
          close: 101,
          volume: 1,
        },
        {
          candleTime: "09:03",
          open: 101,
          high: 102,
          low: 100,
          close: 101,
          volume: 1,
        },
        {
          candleTime: "09:04",
          open: 101,
          high: 150,
          low: 80,
          close: 120,
          volume: 1,
        },
      ],
      {
        side: "long",
        entryCandleTime: "09:00",
        entryPrice: 100,
        exitCandleTime: "09:01",
        exitPrice: 101,
        exitReason: "first_target",
        pnl: 100,
        realizedR: 1,
      },
      { firstTarget: 102, stretchTarget: 104, stopPrice: 98 },
      []
    ) as Record<string, any>;
    expect(outcome.mfePct).toBe(2);
    expect(outcome.maePct).toBe(-1);
    expect(outcome.returns.m1).toBe(1);
    expect(outcome.returns.m3).toBe(1);
    expect(outcome.returns.m5).toBeNull();
    expect(outcome.reasonCodes).toContain("return_5m_exact_candle_missing");
    expect(outcome.postExitCounterfactual.mfePct).toBe(50);
  });

  it("zone・confirmation・targetは保存eventを一次証拠として復元する", () => {
    const relatedEvents = [
      {
        candleTime: "09:00",
        sourceEventId: "zone",
        decisionJson: { actions: [{ type: "zone_touched" }] },
      },
      {
        candleTime: "09:01",
        sourceEventId: "entry",
        decisionJson: { actions: [{ type: "entry" }] },
      },
      {
        candleTime: "09:02",
        sourceEventId: "target",
        decisionJson: { actions: [{ type: "exit", reason: "first_target" }] },
      },
    ] as any;
    const outcome = _aiForecastLearningTest.outcomeFromCandles(
      [
        {
          candleTime: "09:00",
          open: 100,
          high: 100,
          low: 99,
          close: 100,
          volume: 1,
        },
        {
          candleTime: "09:01",
          open: 100,
          high: 102,
          low: 99,
          close: 101,
          volume: 1,
        },
        {
          candleTime: "09:02",
          open: 101,
          high: 103,
          low: 100,
          close: 102,
          volume: 1,
        },
      ],
      {
        side: "long",
        entryCandleTime: "09:01",
        entryPrice: 101,
        exitCandleTime: "09:02",
        exitPrice: 102,
        exitReason: "first_target",
        pnl: 100,
        realizedR: 1,
      },
      { firstTarget: 103, stretchTarget: 105, stopPrice: 99 },
      relatedEvents
    ) as Record<string, any>;
    expect(outcome).toMatchObject({
      zoneTouched: true,
      zoneTouchSourceEventId: "zone",
      confirmationEstablished: true,
      confirmationSourceEventId: "entry",
      targetReachedAt: "09:02",
      firstTargetReached: true,
      stopReachedAt: null,
    });
    expect(outcome.reasonCodes).not.toContain(
      "target_stop_event_evidence_missing"
    );
  });

  it("session break未更新の原因診断は銘柄名ではなく全銘柄に共通適用する", () => {
    const candidates = _aiForecastLearningTest.deriveCauseCandidates({
      symbol: "8035",
      side: "short",
      entry: {
        oneMinute: {},
        sessionHighUpdated: false,
        sessionLowUpdated: false,
      },
      diagnosisOnly: { returns: {} },
      expectedRR: null,
      gapPct: null,
      macroRegime: null,
    });
    expect(candidates.map(candidate => candidate.tag)).toContain(
      "late_entry_without_session_break"
    );
  });
});
