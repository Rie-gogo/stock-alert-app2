import { describe, expect, it } from "vitest";
import {
  buildStrictTechnicalFeatureManifest,
  calculateStrictTechnicalDailyFeature,
  classifyStrictTechnicalFeatureRegime,
  classifyStrictTechnicalFeatureSession,
  STRICT_TECHNICAL_FEATURE_CONFIG_HASH,
  STRICT_TECHNICAL_FEATURE_SESSION_CONTRACT_HASH,
} from "./technicalRegimeFeatureContract";
import { nextTokyoEquityTradeDate } from "./jpxEquityCalendar";
import { sha256Stable } from "./runtimeIdentity";

function event(
  time: string,
  valueSource?: string,
  overrides: Record<string, unknown> = {}
) {
  return {
    sourceEventId: `s:${time}`,
    eventSeq: 1,
    candleTime: time,
    correctedEventId: null,
    payloadJson: {
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 10,
      ...overrides,
      ...(valueSource
        ? {
            provenance: {
              valueSource,
              rawCandleTime: time,
              ...((overrides.provenance as object | undefined) ?? {}),
            },
          }
        : {}),
    },
    resultJson: {},
    cloudReceivedAtMs: null,
    relayReceivedAtMs: null,
    relaySentAtMs: null,
  } as any;
}

function labels(from: string, to: string) {
  const a = Number(from.slice(0, 2)) * 60 + Number(from.slice(3));
  const b = Number(to.slice(0, 2)) * 60 + Number(to.slice(3));
  return Array.from({ length: b - a + 1 }, (_, index) => {
    const value = a + index;
    return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
  });
}

function fullSessionEvents() {
  const times = [...labels("09:00", "11:29"), ...labels("12:30", "15:24")];
  return times.map((time, index) => {
    const close = 100 + index / 10;
    return event(time, "ws_aggregated", {
      open: close - 0.05,
      high: close + 0.15,
      low: close - 0.2,
      close,
      volume: 10 + index,
    });
  });
}

function hashStableManifest(value: Record<string, unknown>) {
  const clone = structuredClone(value);
  delete (clone as Record<string, unknown>).generatedAt;
  return sha256Stable(clone);
}

describe("strict closed-session technical feature contract", () => {
  it("classifies all session boundaries without treating closing auction as a normal minute", () => {
    expect(classifyStrictTechnicalFeatureSession("08:59")).toBe("pre_open");
    expect(classifyStrictTechnicalFeatureSession("09:00")).toBe(
      "morning_continuous"
    );
    expect(classifyStrictTechnicalFeatureSession("11:30")).toBe("lunch");
    expect(classifyStrictTechnicalFeatureSession("12:30")).toBe(
      "afternoon_continuous"
    );
    expect(classifyStrictTechnicalFeatureSession("15:25")).toBe(
      "closing_auction_acceptance"
    );
    expect(classifyStrictTechnicalFeatureSession("15:30")).toBe(
      "close_observation"
    );
    expect(classifyStrictTechnicalFeatureSession("15:31")).toBe("after_close");
  });

  it("keeps sealed feature eligibility and reason codes for missing and non-WS candles", () => {
    const missing = buildStrictTechnicalFeatureManifest({
      tradeDate: "2026-09-29",
      events: [event("09:00")],
      sourceDecisionCount: 1,
      processedThroughEngineSequence: 1,
      watermark: {},
      causalityViolationCount: 0,
    });
    expect(missing.featureEligible).toBe(false);
    expect(missing.reasonCodes).toContain("unknown_or_non_ws_provenance");

    const restFallback = buildStrictTechnicalFeatureManifest({
      tradeDate: "2026-10-01",
      events: fullSessionEvents().map((row: any) =>
        row.candleTime === "14:55"
          ? {
              ...row,
              payloadJson: {
                ...row.payloadJson,
                provenance: {
                  ...row.payloadJson.provenance,
                  valueSource: "rest_fallback",
                },
              },
            }
          : row
      ),
      sourceDecisionCount: 325,
      processedThroughEngineSequence: 325,
      watermark: {},
      causalityViolationCount: 0,
    });
    expect(restFallback.featureEligible).toBe(false);
    expect(restFallback.reasonCodes).toContain("unknown_or_non_ws_provenance");
  });

  it("preserves the 325-minute strict session, daily feature, regime, eligibility, and reasonCodes on the sealed fixture", () => {
    const events = fullSessionEvents();
    const manifest = buildStrictTechnicalFeatureManifest({
      tradeDate: "2026-10-01",
      events,
      sourceDecisionCount: 325,
      processedThroughEngineSequence: 325,
      watermark: { source: { count: 325 } },
      causalityViolationCount: 0,
    });
    const history = Array.from({ length: 19 }, (_, index) => ({
      features: {
        close: 90 + index,
        high: 91 + index,
        low: 89 + index,
        volume: 1000,
      },
    }));
    const feature = calculateStrictTechnicalDailyFeature({
      manifest,
      events,
      history,
    });
    const regime = classifyStrictTechnicalFeatureRegime(
      feature,
      history.map(item => item.features)
    );

    expect(manifest.featureEligible).toBe(true);
    expect(manifest.reasonCodes).toEqual(["eligible"]);
    expect((manifest.actual as any).continuousUnique).toBe(325);
    const stableManifest = structuredClone(manifest);
    delete (stableManifest as Record<string, unknown>).generatedAt;
    expect({
      manifest: hashStableManifest(manifest),
      feature: sha256Stable(feature),
      regime: sha256Stable(regime),
      combined: sha256Stable({
        manifest: stableManifest,
        feature,
        regime,
      }),
    }).toEqual({
      manifest:
        "cb56422e5e234d8e81d6ae88ce258bb2911ae552edf387e203d6cd108a36c14f",
      feature:
        "6b30da7b8d8d92ea990486a9b715cf5c067da31289813ddc4894e20bdd769849",
      regime:
        "4a3e8f4b0f91e7fb650587588e2023b52118b84dccc1086dc7633e0419f02b54",
      combined:
        "ba928acde48793f938372c569fc3b6618c81d3c23ffb82790740c21e3d1afb91",
    });
    expect(STRICT_TECHNICAL_FEATURE_CONFIG_HASH).toBe(
      "0fd6951f82b73da3aed4678d501ed71dd1932266538ddad994b9ab3fb4d0e73d"
    );
    expect(STRICT_TECHNICAL_FEATURE_SESSION_CONTRACT_HASH).toBe(
      "8821365175f0d803eddff818baf801369bafcd2b4e1b7744af98dd3c0b03d383"
    );
  });

  it("keeps the closing 30/60-minute feature window and sealed regime thresholds", () => {
    const events = fullSessionEvents();
    const manifest = buildStrictTechnicalFeatureManifest({
      tradeDate: "2026-10-01",
      events,
      sourceDecisionCount: 325,
      processedThroughEngineSequence: 325,
      watermark: {},
      causalityViolationCount: 0,
    });
    const history = Array.from({ length: 19 }, (_, index) => ({
      features: {
        close: 90 + index,
        high: 91 + index,
        low: 89 + index,
        volume: 1000,
      },
    }));
    const feature = calculateStrictTechnicalDailyFeature({
      manifest,
      events,
      history,
    });
    expect((feature.intraday as any).sixtyMinute.startTime).toBe("14:25");
    expect((feature.intraday as any).thirtyMinute.startTime).toBe("14:55");
    expect(
      classifyStrictTechnicalFeatureRegime(
        {
          close: 110,
          atr14Pct: 2,
          movingAverages: { "20": { value: 100, slopePct: 0.1 } },
          intraday: { sixtyMinute: { slopePct: 0.2 } },
          bollinger20: { percentB: 65 },
        },
        [{ atr14Pct: 1 }, { atr14Pct: 1.5 }]
      )
    ).toMatchObject({
      trend: "up",
      volatility: "high",
      location: "upper",
      full: "up|high|upper",
      atr14MedianPct: 1.25,
    });
  });

  it("uses the canonical JPX calendar directly", () => {
    expect(nextTokyoEquityTradeDate("2026-10-09")).toBe("2026-10-13");
    expect(nextTokyoEquityTradeDate("2026-12-30")).toBe("2027-01-04");
  });
});
