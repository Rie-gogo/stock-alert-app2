import { describe, expect, it } from "vitest";
import { KIOXIA_NORMALIZED_COMPARISON_PLAN_SPECS } from "./monitoringComparisonNormalizedTrend";
import { buildKioxiaManifestV2, classifyKioxiaSession, scoreKioxiaSelectorRoute } from "./kioxiaNextDaySelector";

function event(time: string, valueSource?: string) {
  return {
    sourceEventId: `s:${time}`, eventSeq: 1, candleTime: time, correctedEventId: null,
    payloadJson: { open: 100, high: 101, low: 99, close: 100, volume: 10, ...(valueSource ? { provenance: { valueSource, rawCandleTime: time } } : {}) },
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
    const result = buildKioxiaManifestV2({ tradeDate: "2026-09-29", events: [event("09:00")], sourceDecisionCount: 1, processedThroughEngineSequence: 1, watermark: {} });
    expect(result.featureEligible).toBe(false);
    expect(result.reasonCodes).toContain("unknown_or_non_ws_provenance");
  });

  it("accepts only a complete ws-aggregated 325-minute continuous session", () => {
    const events = [...labels("09:00", "11:29"), ...labels("12:30", "15:24")].map(time => event(time, "ws_aggregated"));
    const result = buildKioxiaManifestV2({ tradeDate: "2026-10-01", events, sourceDecisionCount: 325, processedThroughEngineSequence: 325, watermark: {} });
    expect(result.featureEligible).toBe(true);
    expect((result.actual as any).continuousUnique).toBe(325);
  });

  it("does not allow rest fallback to fill a missing measured bar", () => {
    const events = [...labels("09:00", "11:29"), ...labels("12:30", "15:24")].map(time => event(time, time === "14:55" ? "rest_fallback" : "ws_aggregated"));
    const result = buildKioxiaManifestV2({ tradeDate: "2026-10-01", events, sourceDecisionCount: 325, processedThroughEngineSequence: 325, watermark: {} });
    expect(result.featureEligible).toBe(false);
    expect(result.reasonCodes).toContain("unknown_or_non_ws_provenance");
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
});
