import { describe, expect, it } from "vitest";
import { KIOXIA_NORMALIZED_COMPARISON_PLAN_SPECS } from "./monitoringComparisonNormalizedTrend";
import { buildKioxiaManifestV2, calculateKioxiaSelectorDailyFeature, classifyKioxiaSelectorRegime, classifyKioxiaSession, nextTokyoEquityTradeDate, scoreKioxiaSelectorRoute } from "./kioxiaNextDaySelector";

function event(time: string, valueSource?: string, overrides: Record<string, unknown> = {}) {
  return {
    sourceEventId: `s:${time}`, eventSeq: 1, candleTime: time, correctedEventId: null,
    payloadJson: { open: 100, high: 101, low: 99, close: 100, volume: 10, ...overrides, ...(valueSource ? { provenance: { valueSource, rawCandleTime: time, ...((overrides.provenance as object | undefined) ?? {}) } } : {}) },
  } as any;
}
function labels(from: string, to: string) { const a = Number(from.slice(0, 2)) * 60 + Number(from.slice(3)); const b = Number(to.slice(0, 2)) * 60 + Number(to.slice(3)); return Array.from({ length: b - a + 1 }, (_, i) => { const n = a + i; return `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`; }); }

describe("285A manifest v2 session contract", () => {
  it("classifies all special session boundaries without treating closing auction as a normal minute", () => {
    expect(classifyKioxiaSession("08:59")).toBe("pre_open");
    expect(classifyKioxiaSession("09:00")).toBe("morning_continuous");
    expect(classifyKioxiaSession("11:30")).toBe("lunch");
    expect(classifyKioxiaSession("12:30")).toBe("afternoon_continuous");
    expect(classifyKioxiaSession("15:25")).toBe("closing_auction_acceptance");
    expect(classifyKioxiaSession("15:30")).toBe("close_observation");
    expect(classifyKioxiaSession("15:31")).toBe("after_close");
  });

  it("marks old payloads as unknown provenance rather than reconstructing their coverage", () => {
    const result = buildKioxiaManifestV2({ tradeDate: "2026-09-29", events: [event("09:00")], sourceDecisionCount: 1, processedThroughEngineSequence: 1, watermark: {}, causalityViolationCount: 0 });
    expect(result.featureEligible).toBe(false);
    expect(result.reasonCodes).toContain("unknown_or_non_ws_provenance");
  });

  it("accepts only a complete ws-aggregated 325-minute continuous session", () => {
    const events = [...labels("09:00", "11:29"), ...labels("12:30", "15:24")].map(time => event(time, "ws_aggregated"));
    const result = buildKioxiaManifestV2({ tradeDate: "2026-10-01", events, sourceDecisionCount: 325, processedThroughEngineSequence: 325, watermark: {}, causalityViolationCount: 0 });
    expect(result.featureEligible).toBe(true);
    expect((result.actual as any).continuousUnique).toBe(325);
  });

  it("does not allow rest fallback to fill a missing measured bar", () => {
    const events = [...labels("09:00", "11:29"), ...labels("12:30", "15:24")].map(time => event(time, time === "14:55" ? "rest_fallback" : "ws_aggregated"));
    const result = buildKioxiaManifestV2({ tradeDate: "2026-10-01", events, sourceDecisionCount: 325, processedThroughEngineSequence: 325, watermark: {}, causalityViolationCount: 0 });
    expect(result.featureEligible).toBe(false);
    expect(result.reasonCodes).toContain("unknown_or_non_ws_provenance");
  });

  it("accepts an explicitly proven true no-trade minute without treating fallback as market data", () => {
    const events = [...labels("09:00", "11:29"), ...labels("12:30", "15:24")]
      .map(time => event(time, time === "14:55" ? "unknown" : "ws_aggregated", time === "14:55"
        ? { open: 100, high: 100, low: 100, close: 100, volume: 0, provenance: { isNoTrade: true } }
        : {}));
    const result = buildKioxiaManifestV2({ tradeDate: "2026-10-01", events, sourceDecisionCount: 325, processedThroughEngineSequence: 325, watermark: {}, causalityViolationCount: 0 });
    expect(result.featureEligible).toBe(true);
    expect((result.valueSources as any).true_no_trade).toBe(1);
  });

  it("rejects a day with a saved causality violation", () => {
    const events = [...labels("09:00", "11:29"), ...labels("12:30", "15:24")].map(time => event(time, "ws_aggregated"));
    const result = buildKioxiaManifestV2({ tradeDate: "2026-10-01", events, sourceDecisionCount: 325, processedThroughEngineSequence: 325, watermark: {}, causalityViolationCount: 1 });
    expect(result.featureEligible).toBe(false);
    expect(result.reasonCodes).toContain("causality_violation");
  });
});

describe("285A selector causal feature contract", () => {
  it("uses only the closing 30/60 minutes for the closing slope", () => {
    const times = [...labels("09:00", "11:29"), ...labels("12:30", "15:24")];
    const events = times.map((time, index) => {
      const closingIndex = index - (times.length - 60);
      const open = closingIndex >= 0 ? 100 + closingIndex / 10 : 200 - index / 3;
      const close = closingIndex >= 0 ? 100 + (closingIndex + 1) / 10 : open - 0.1;
      return event(time, "ws_aggregated", { open, high: Math.max(open, close) + 0.1, low: Math.min(open, close) - 0.1, close, volume: 10 });
    });
    const history = Array.from({ length: 19 }, (_, index) => ({ features: { close: 90 + index, high: 91 + index, low: 89 + index, volume: 1000 } }));
    const feature = calculateKioxiaSelectorDailyFeature({ manifest: { featureEligible: true, tradeDate: "2026-10-01" }, events, history });
    expect((feature.intraday as any).sixtyMinute.startTime).toBe("14:25");
    expect((feature.intraday as any).sixtyMinute.endTime).toBe("15:24");
    expect((feature.intraday as any).sixtyMinute.slopePct).toBeGreaterThan(0);
    expect((feature.intraday as any).thirtyMinute.startTime).toBe("14:55");
  });

  it("accepts both legacy wrapper history and ten-symbol raw feature history", () => {
    const events = [...labels("09:00", "11:29"), ...labels("12:30", "15:24")]
      .map((time, index) => event(time, "ws_aggregated", { open: 100 + index * 0.01, high: 101 + index * 0.01, low: 99 + index * 0.01, close: 100.5 + index * 0.01, volume: 100 }));
    const rawHistory = Array.from({ length: 52 }, (_, index) => ({ sourceDate: `d${index}`, open: 90 + index, high: 91 + index, low: 89 + index, close: 90.5 + index, volume: 1000 }));
    const raw = calculateKioxiaSelectorDailyFeature({ manifest: { featureEligible: true, tradeDate: "2026-10-01" }, events, history: rawHistory });
    const wrapped = calculateKioxiaSelectorDailyFeature({ manifest: { featureEligible: true, tradeDate: "2026-10-01" }, events, history: rawHistory.map(features => ({ features })) });
    expect((raw.movingAverages as any)["21"].value).toBe((wrapped.movingAverages as any)["21"].value);
    expect((raw.technicalIndicators as any).macd).not.toBeNull();
    expect((raw.technicalIndicators as any).rciLong).not.toBeNull();
  });

  it("classifies trend, volatility and location with the sealed thresholds", () => {
    const regime = classifyKioxiaSelectorRegime({
      close: 110,
      atr14Pct: 2,
      movingAverages: { "20": { value: 100, slopePct: 0.1 } },
      intraday: { sixtyMinute: { slopePct: 0.2 } },
      bollinger20: { percentB: 65 },
    }, [{ atr14Pct: 1 }, { atr14Pct: 1.5 }]);
    expect(regime).toMatchObject({ trend: "up", volatility: "high", location: "upper", full: "up|high|upper" });
    expect(regime.atr14MedianPct).toBe(1.25);
  });
});

describe("285A selector fire-rate posterior", () => {
  it("does not retain a one-trade +2.5R route as an always-selected route when it never fires", () => {
    const spec = KIOXIA_NORMALIZED_COMPARISON_PLAN_SPECS.find(item => item.routeId === "safe_cb_short" && item.origin === "forward_shadow")!;
    const history = Array.from({ length: 20 }, (_, index) => ({
      tradeDate: `2026-10-${String(index + 1).padStart(2, "0")}`,
      featureEligible: true,
      regime: { full: "range|normal|middle", trend: "range", volatility: "normal" },
      entries: index === 0 ? [{ origin: spec.origin, strategyVersion: spec.strategyVersion, routeId: spec.routeId, side: spec.side, sourceDisposition: "entry", intrinsic: { completed: true, pnlPer100: 150, entryPrice: 100 } }] : [],
    }));
    const score = scoreKioxiaSelectorRoute({ spec, history });
    expect(score.signalDays).toBe(1);
    expect(score.posteriorFireRate).toBeCloseTo(2 / 22, 8);
    expect(score.expectedDailyR).toBeLessThan(score.regimePosteriorR);
    expect(score.selectable).toBe(false);
    expect(score.exclusionReasons).toContain("fewer_than_10_completed_trades");
  });

  it("scores every Current route in R rather than silently dropping four routes", () => {
    const currentSpecs = KIOXIA_NORMALIZED_COMPARISON_PLAN_SPECS.filter(item => item.origin === "current_baseline");
    const slByRoute: Record<string, number> = {
      trendLong: 0.8,
      reversalLong: 0.6,
      reversalShort: 0.8,
      trendShort: 0.8,
      kioxiaSafeCbShort: 0.6,
    };
    expect(currentSpecs.map(spec => spec.routeId)).toEqual(Object.keys(slByRoute));
    for (const spec of currentSpecs) {
      const history = Array.from({ length: 20 }, (_, index) => ({
        tradeDate: `2026-10-${String(index + 1).padStart(2, "0")}`,
        featureEligible: true,
        regime: { full: "up|normal|upper", trend: "up", volatility: "normal", location: "upper" },
        entries: index < 10 ? [{ origin: spec.origin, strategyVersion: spec.strategyVersion, routeId: spec.routeId, side: spec.side, sourceDisposition: "accepted", intrinsic: { completed: true, pnlPer100: slByRoute[spec.routeId] * 100, entryPrice: 100 } }] : [],
      }));
      const score = scoreKioxiaSelectorRoute({ spec, history });
      expect(score.completedTrades, spec.routeId).toBe(10);
      expect(score.globalPosteriorR, spec.routeId).toBeCloseTo(1 / 3, 8);
      expect(score.routePosteriorR, spec.routeId).toBeCloseTo(2 / 3, 8);
      expect(score.fallbackLevel, spec.routeId).toBe("full");
    }
  });

  it("uses the frozen full to trend-volatility to trend to route fallback order", () => {
    const spec = KIOXIA_NORMALIZED_COMPARISON_PLAN_SPECS.find(item => item.routeId === "safe_cb_short" && item.origin === "forward_shadow")!;
    const history = Array.from({ length: 20 }, (_, index) => ({
      tradeDate: `2026-10-${String(index + 1).padStart(2, "0")}`,
      featureEligible: true,
      regime: index === 19
        ? { full: "up|high|upper", trend: "up", volatility: "high", location: "upper" }
        : { full: "up|normal|lower", trend: "up", volatility: "normal", location: "lower" },
      entries: index < 10 ? [{ origin: spec.origin, strategyVersion: spec.strategyVersion, routeId: spec.routeId, side: spec.side, sourceDisposition: "entry", intrinsic: { completed: true, pnlPer100: 60, entryPrice: 100 } }] : [],
    }));
    const score = scoreKioxiaSelectorRoute({ spec, history });
    expect(score.fallbackLevel).toBe("trend");
    expect(score.fallbackSampleSize).toBe(10);
  });
});

describe("JPX next trade date", () => {
  it("skips weekends and published JPX market holidays", () => {
    expect(nextTokyoEquityTradeDate("2026-10-09")).toBe("2026-10-13");
    expect(nextTokyoEquityTradeDate("2026-12-30")).toBe("2027-01-04");
  });
});
