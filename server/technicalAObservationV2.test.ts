import { describe, expect, it } from "vitest";
import type { RtSourceEvent } from "../drizzle/schema";
import type { ForwardSourceEventInput } from "./forwardShadow";
import {
  buildTechnicalAObservationV2Feature,
  buildTechnicalAObservationV2Manifest,
  replayTechnicalAObservationV2Day,
  TECHNICAL_A_OBSERVATION_V2_FEATURE_COMPONENT,
} from "./technicalAObservationV2";
import { classifyTechnicalMarketRegime, classifyTechnicalMarketRegimeReferenceObservationV2 } from "./technicalMarketRegime";
import type { TechnicalRegimePlan } from "./technicalRegimeShadow";

function labels(from: string, to: string) {
  const [fromHour, fromMinute] = from.split(":").map(Number);
  const [toHour, toMinute] = to.split(":").map(Number);
  const result: string[] = [];
  for (let value = fromHour * 60 + fromMinute; value <= toHour * 60 + toMinute; value += 1) {
    result.push(`${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`);
  }
  return result;
}

const sessionLabels = [...labels("09:00", "11:29"), ...labels("12:30", "15:24")];

function sourceEvent(time: string, id: number, overrides: Record<string, unknown> = {}): RtSourceEvent {
  const close = 100 + id / 100;
  return {
    id,
    sourceEventId: `source-${id}`,
    relaySessionId: "legacy-session",
    eventSeq: id,
    symbol: "285A",
    tradeDate: "2026-10-01",
    candleTime: time,
    payloadHash: `hash-${id}`,
    payloadJson: { symbol: "285A", tradeDate: "2026-10-01", candleTime: time, open: close - 0.1, high: close + 0.2, low: close - 0.2, close, volume: 100 + id, board: null, ...overrides },
    relayReceivedAtMs: 1_000 + id,
    relaySentAtMs: 900 + id,
    cloudReceivedAtMs: 1_100 + id,
    correctedEventId: null,
    status: "processed",
    processingStage: "engine_completed",
    claimToken: null,
    leaseUntil: null,
    attemptCount: 1,
    resultAction: "none",
    resultJson: null,
    errorDetail: null,
    createdAt: new Date("2026-10-01T06:30:00Z"),
    processedAt: new Date("2026-10-01T06:30:00Z"),
  };
}

function completeSession(): RtSourceEvent[] {
  return sessionLabels.map((time, index) => sourceEvent(time, index + 1));
}

function plan(): TechnicalRegimePlan {
  return {
    symbol: "285A",
    sourceTradeDate: "2026-10-01",
    kind: "trend_breakout_long",
    setup: "up_breakout",
    confidence: "medium",
    priorOpen: 98,
    priorHigh: 100,
    priorLow: 96,
    priorClose: 99,
    atrPrice: 1,
    bollingerMiddle: 99,
    bollingerPlus2: 103,
    bollingerMinus2: 95,
    reasonCodes: ["legacy_reference_bootstrap", "d_minus_1_feature_frozen"],
  };
}

function replaySource(id: string, time: string, close: number, high = close + 0.2): ForwardSourceEventInput {
  return {
    sourceEventId: id,
    candle: { symbol: "285A", tradeDate: "2026-10-02", candleTime: time, open: close - 0.1, high, low: close - 0.2, close, volume: 120 },
    board: { asks: [{ price: close + 0.05, qty: 100 }], bids: [{ price: close - 0.05, qty: 100 }] },
    currentAudit: {
      engineSequence: Number(id.replace(/\D/g, "")) || 1,
      resultType: "no_signal",
      routeId: null,
      marginUsedBefore: 0,
      marginUsedAfter: 0,
      stateHashBefore: "a",
      stateHashAfter: "b",
      causalityStatus: "pass",
      causalityReason: "ok",
      boardObservedAtMs: 1_000,
      relayAssembledAtMs: 1_100,
      relaySentAtMs: 1_200,
      cloudReceivedAtMs: 1_300,
      decisionStartedAtMs: 1_350,
      decisionCompletedAtMs: 1_400,
    },
  };
}

describe("Technical A v2 observation data contract", () => {
  it("59/60 closing with <=2 continuous misses is legacy reference-ready and capped medium", () => {
    const events = completeSession().filter(event => !["09:00", "09:01", "14:42"].includes(event.candleTime));
    const manifest = buildTechnicalAObservationV2Manifest({ tradeDate: "2026-10-01", events, watermark: { source: { count: events.length } }, sourceDecisionCount: events.length, processedThroughEngineSequence: 999 });
    expect(manifest.featureEligible).toBe(true);
    expect(manifest.sourceTier).toBe("legacy_reference_bootstrap");
    expect(manifest.confidenceCap).toBe("medium");
    expect(manifest.actual.closingFixed60.observedMinutes).toBe(59);
    expect(manifest.missingLabels.closingLabel).toBe("partial_59_of_60");
    expect(manifest.actual.missingLabels).toContain("09:00");
    expect(manifest.actual.missingLabels).toContain("09:01");
  });

  it("58/60, low coverage, unresolved duplicate, inversion, and invalid OHLC fail closed without imputation", () => {
    const missingTwoAtClose = completeSession().filter(event => !["14:42", "14:43"].includes(event.candleTime));
    expect(buildTechnicalAObservationV2Manifest({ tradeDate: "2026-10-01", events: missingTwoAtClose, watermark: {}, sourceDecisionCount: 0, processedThroughEngineSequence: 0 }).reasonCodes).toContain("closing_fixed_60_below_59");

    const duplicate = [...completeSession(), sourceEvent("10:00", 999)];
    expect(buildTechnicalAObservationV2Manifest({ tradeDate: "2026-10-01", events: duplicate, watermark: {}, sourceDecisionCount: 0, processedThroughEngineSequence: 0 }).reasonCodes).toContain("unresolved_duplicate_or_correction");

    const inverted = completeSession().map(event => ({ ...event }));
    inverted[1] = { ...inverted[1]!, eventSeq: 9999 };
    expect(buildTechnicalAObservationV2Manifest({ tradeDate: "2026-10-01", events: inverted, watermark: {}, sourceDecisionCount: 0, processedThroughEngineSequence: 0 }).reasonCodes).toContain("source_time_inversion");

    const invalid = completeSession();
    invalid[0] = sourceEvent("09:00", 1, { high: 99, low: 101, open: 100, close: 100 });
    const invalidManifest = buildTechnicalAObservationV2Manifest({ tradeDate: "2026-10-01", events: invalid, watermark: {}, sourceDecisionCount: 0, processedThroughEngineSequence: 0 });
    expect(invalidManifest.featureEligible).toBe(false);
    expect(invalidManifest.reasonCodes).toContain("invalid_ohlc_relationship");
  });

  it("fixed clock bars exclude lunch and after-close labels and the feature input remains deterministic", () => {
    const events = [...completeSession(), sourceEvent("12:00", 400), sourceEvent("15:30", 401)];
    const manifest = buildTechnicalAObservationV2Manifest({ tradeDate: "2026-10-01", events, watermark: { marker: "fixed" }, sourceDecisionCount: 10, processedThroughEngineSequence: 20 });
    const build = () => buildTechnicalAObservationV2Feature({
      tradeDate: "2026-10-01",
      eventsBySymbol: Object.fromEntries(["285A", "3436", "5803", "6146", "6526", "6857", "6976", "6981", "8035", "9984"].map(symbol => [symbol, symbol === "285A" ? events : []])),
      watermark: { marker: "fixed" },
      sourceDecisionCount: 10,
      processedThroughEngineSequence: 20,
      priorFeatures: [],
    });
    const first = build();
    const second = build();
    expect(manifest.actual.continuousUnique).toBe(325);
    expect(first.inputHash).toBe(second.inputHash);
    expect(first.component).toBe(TECHNICAL_A_OBSERVATION_V2_FEATURE_COMPONENT);
    const bars = ((first.featuresBySymbol["285A"] as any).features.intraday.sessionBars60 as any[]);
    expect(bars.every(bar => bar.fixedStartTime !== "12:00" && bar.fixedEndTime !== "15:30")).toBe(true);
  });

  it("keeps v1 strict provenance unavailable while v2 reference classification is isolated", () => {
    const wrapper = {
      featureEligible: true,
      provenanceStatus: "legacy_reference_bootstrap",
      features: {
        open: 100, high: 102, low: 99, close: 101, atr14Pct: 1.2,
        movingAverages: { "5": { value: 100, slopePct: 1 }, "20": { value: 99, slopePct: 1 }, "25": { value: 98, slopePct: 1 }, "50": { value: 97, slopePct: 1 } },
        bollinger20: { middle: 99, percentB: 70, bandwidthPct: 2 },
        intraday: { sessionBars60: [] },
      },
    };
    expect(classifyTechnicalMarketRegime({ current: wrapper, history: [], universeCurrent: { "285A": wrapper } }).eligible).toBe(false);
    expect(classifyTechnicalMarketRegimeReferenceObservationV2({ current: wrapper, history: [], universeCurrent: { "285A": wrapper } }).eligible).toBe(true);
  });

  it("replays the same frozen plan and official event order twice with identical state and without all data_blocked", () => {
    const warmup = Array.from({ length: 9 }, (_, index) => replaySource(`e${index + 1}`, `09:${String(10 + index).padStart(2, "0")}`, 99));
    const signal = replaySource("e10", "09:19", 101, 101.2);
    signal.candle.volume = 200;
    const entry = replaySource("e11", "09:20", 101.1, 101.3);
    const inputs = [...warmup, signal, entry];
    const first = replayTechnicalAObservationV2Day({ symbol: "285A", mode: "signal_quality", plan: plan(), events: inputs });
    const second = replayTechnicalAObservationV2Day({ symbol: "285A", mode: "signal_quality", plan: plan(), events: inputs });
    expect(first.planHash).toBe(second.planHash);
    expect(first.officialEventSequence).toEqual(second.officialEventSequence);
    expect(first.finalStateHash).toBe(second.finalStateHash);
    expect(first.trades).toEqual(second.trades);
    expect(first.status).not.toBe("data_blocked");
    expect(first.events.some(event => event.status === "entered")).toBe(true);
  });
});
