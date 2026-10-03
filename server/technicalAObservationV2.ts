import type {
  RtDailyAuditMaterialization,
  RtRealtimeDecisionEvent,
  RtSourceEvent,
} from "../drizzle/schema";
import {
  getClosedRtAuditTradeDates,
  getRtAuditTradeDateFinality,
  getRtAuditTradeDateWatermark,
  getRtDailyAuditMaterialization,
  getRtDailyAuditMaterializationsForRange,
  getRtRealtimeDecisionEventsForDateAndSymbol,
  getRtSourceEventsForDateAndSymbol,
  getRtSourceEventTradeDates,
  upsertRtDailyAuditMaterialization,
} from "./db";
import type { ForwardEvaluationMode, ForwardSourceEventInput } from "./forwardShadow";
import { TEN_MONITORED_SYMBOLS } from "./multiSymbolMonitoringRegistry";
import { nextTokyoEquityTradeDate } from "./kioxiaNextDaySelector";
import { parseRelayCandleProvenance } from "./relayProvenance";
import { sha256Stable } from "./runtimeIdentity";
import {
  applyTechnicalRegimeShadowTransition,
  createEmptyTechnicalRegimeShadowState,
  type TechnicalPlanKind,
  type TechnicalRegimePlan,
  type TechnicalRegimeShadowState,
} from "./technicalRegimeShadow";
import {
  classifyTechnicalMarketRegimeReferenceObservationV2,
  type TechnicalMarketRegime,
} from "./technicalMarketRegime";

/**
 * Historical observations from the relay before v5.10 lack source provenance.
 * v2 can use them only to bootstrap a labelled reference feature timeline.
 * v1 does not import this module and remains strict about ws provenance.
 */
export const TECHNICAL_A_OBSERVATION_V2_VERSION = "technical-a-observation-v2";
export const TECHNICAL_A_OBSERVATION_V2_FEATURE_COMPONENT = "technical_a_observation_v2_feature";
export const TECHNICAL_A_OBSERVATION_V2_PLAN_COMPONENT = "technical_a_observation_v2_plan";
export const TECHNICAL_A_OBSERVATION_V2_RESULT_COMPONENT = "technical_a_observation_v2_result";
export const TECHNICAL_A_OBSERVATION_V2_FEATURE_START_DATE = "2026-08-26";
export const TECHNICAL_A_OBSERVATION_V2_COLLECTION_START_DATE = "2026-10-05";
export const TECHNICAL_A_OBSERVATION_V2_FORMAL_START_DATE = "2026-10-05";
export const TECHNICAL_A_OBSERVATION_V2_LEARNING_CUTOFF_DATE = "2026-10-02";
export const TECHNICAL_A_OBSERVATION_V2_MAX_BOARD_AGE_MS = 5_000;

export const TECHNICAL_A_OBSERVATION_V2_VERSIONS = Object.freeze({
  "285A": "observation-285a-technical-a-v2",
  "3436": "observation-3436-technical-a-v2",
  "5803": "observation-5803-technical-a-v2",
  "6146": "observation-6146-technical-a-v2",
  "6526": "observation-6526-technical-a-v2",
  "6857": "observation-6857-technical-a-v2",
  "6976": "observation-6976-technical-a-v2",
  "6981": "observation-6981-technical-a-v2",
  "8035": "observation-8035-technical-a-v2",
  "9984": "observation-9984-technical-a-v2",
} as const);

const CONTINUOUS_LABELS = [
  ...labels("09:00", "11:29"),
  ...labels("12:30", "15:24"),
];
const CLOSING_60_LABELS = labels("14:25", "15:24");
const V2_CONFIG = Object.freeze({
  version: TECHNICAL_A_OBSERVATION_V2_VERSION,
  sourceTier: "legacy_reference_bootstrap_or_verified_relay",
  session: {
    continuousMinutes: 325,
    morning: ["09:00", "11:29"],
    afternoon: ["12:30", "15:24"],
    fixedClosingWindow: ["14:25", "15:24"],
  },
  quality: {
    minimumCoverage: 0.98,
    maximumContiguousMissing: 2,
    closingMinimumObserved: 59,
    closingMaximumContiguousMissing: 1,
    noImputation: true,
  },
  formalPerformanceUse: false,
  automaticSelection: false,
  automaticAdoption: false,
  orderInstructionConnection: false,
});
export const TECHNICAL_A_OBSERVATION_V2_CONFIG_HASH = sha256Stable(V2_CONFIG);

type RecordValue = Record<string, unknown>;
type ObservationSymbol = keyof typeof TECHNICAL_A_OBSERVATION_V2_VERSIONS;
type ObservationStatus = "data_blocked" | "plan_ready_no_signal" | "signal_rejected" | "entered" | "closed";
type ObservationCandle = {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  sourceEventId: string;
  sourceId: number;
  eventSeq: number;
  payloadHash: string;
  provenance: ReturnType<typeof parseRelayCandleProvenance>;
};
type ObservationFeatureRow = Pick<RtDailyAuditMaterialization, "tradeDate" | "status" | "resultJson">;

function object(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function average(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function pct(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator * 100 : null;
}

function timeToMinute(time: string): number {
  const [hour, minute] = time.split(":").map(Number);
  return hour * 60 + minute;
}

function label(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

function labels(from: string, to: string): string[] {
  const result: string[] = [];
  for (let value = timeToMinute(from); value <= timeToMinute(to); value += 1) result.push(label(value));
  return result;
}

function isContinuousTime(time: string): boolean {
  return (time >= "09:00" && time <= "11:29") || (time >= "12:30" && time <= "15:24");
}

function longestMissing(expected: string[], observed: Iterable<string>): number {
  const actual = new Set(observed);
  let longest = 0;
  let current = 0;
  for (const item of expected) {
    if (actual.has(item)) current = 0;
    else {
      current += 1;
      longest = Math.max(longest, current);
    }
  }
  return longest;
}

function missingLabels(expected: string[], observed: Iterable<string>): string[] {
  const actual = new Set(observed);
  return expected.filter(item => !actual.has(item));
}

function sourceCandle(event: RtSourceEvent): ObservationCandle | null {
  const payload = object(event.payloadJson);
  const open = finite(payload.open);
  const high = finite(payload.high);
  const low = finite(payload.low);
  const close = finite(payload.close);
  const volume = finite(payload.volume);
  if ([open, high, low, close, volume].some(value => value === null)) return null;
  return {
    time: event.candleTime,
    open: open!,
    high: high!,
    low: low!,
    close: close!,
    volume: volume!,
    sourceEventId: event.sourceEventId,
    sourceId: event.id,
    eventSeq: event.eventSeq,
    payloadHash: event.payloadHash,
    provenance: parseRelayCandleProvenance(payload.provenance),
  };
}

function validOhlcv(candle: ObservationCandle): boolean {
  return candle.open > 0
    && candle.high > 0
    && candle.low > 0
    && candle.close > 0
    && candle.volume >= 0
    && candle.high >= Math.max(candle.open, candle.close)
    && candle.low <= Math.min(candle.open, candle.close)
    && candle.high >= candle.low;
}

function typicalPrice(candle: Pick<ObservationCandle, "high" | "low" | "close">): number {
  return (candle.high + candle.low + candle.close) / 3;
}

function fixedClockBars(candles: ObservationCandle[]) {
  const configs = [
    { session: "morning", labels: labels("09:00", "11:29") },
    { session: "afternoon", labels: labels("12:30", "15:24") },
  ] as const;
  return configs.flatMap(config => {
    const byTime = new Map(candles.filter(candle => config.labels.includes(candle.time)).map(candle => [candle.time, candle]));
    const result: Array<Record<string, unknown>> = [];
    for (let start = 0; start < config.labels.length; start += 60) {
      const expected = config.labels.slice(start, start + 60);
      const observed = expected.map(item => byTime.get(item)).filter((item): item is ObservationCandle => Boolean(item));
      if (!observed.length) continue;
      const first = observed[0]!;
      const last = observed.at(-1)!;
      const high = Math.max(...observed.map(item => item.high));
      const low = Math.min(...observed.map(item => item.low));
      const volume = observed.reduce((sum, item) => sum + item.volume, 0);
      result.push({
        session: config.session,
        fixedStartTime: expected[0],
        fixedEndTime: expected.at(-1),
        observedStartTime: first.time,
        observedEndTime: last.time,
        expectedMinutes: expected.length,
        observedMinutes: observed.length,
        missingLabels: missingLabels(expected, observed.map(item => item.time)),
        open: first.open,
        high,
        low,
        close: last.close,
        volume,
        vwap: volume > 0 ? observed.reduce((sum, item) => sum + typicalPrice(item) * item.volume, 0) / volume : null,
        returnPct: pct(last.close - first.open, first.open),
      });
    }
    return result;
  });
}

function fixedClosingSixty(candles: ObservationCandle[]) {
  const expected = CLOSING_60_LABELS;
  const map = new Map(candles.map(candle => [candle.time, candle]));
  const observed = expected.map(item => map.get(item)).filter((item): item is ObservationCandle => Boolean(item));
  const missing = missingLabels(expected, observed.map(item => item.time));
  if (!observed.length) return { expectedMinutes: 60, observedMinutes: 0, missingLabels: missing, maximumConsecutiveMissing: 60, value: null };
  const first = observed[0]!;
  const last = observed.at(-1)!;
  const high = Math.max(...observed.map(item => item.high));
  const low = Math.min(...observed.map(item => item.low));
  const volume = observed.reduce((sum, item) => sum + item.volume, 0);
  return {
    expectedMinutes: 60,
    observedMinutes: observed.length,
    missingLabels: missing,
    maximumConsecutiveMissing: longestMissing(expected, observed.map(item => item.time)),
    value: {
      fixedStartTime: "14:25",
      fixedEndTime: "15:24",
      observedStartTime: first.time,
      observedEndTime: last.time,
      open: first.open,
      high,
      low,
      close: last.close,
      volume,
      vwap: volume > 0 ? observed.reduce((sum, item) => sum + typicalPrice(item) * item.volume, 0) / volume : null,
      slopePct: pct(last.close - first.open, first.open),
      rangePct: pct(high - low, first.open),
      endPositionPct: high > low ? (last.close - low) / (high - low) * 100 : null,
    },
  };
}

function provenanceTier(candles: ObservationCandle[]): "verified" | "legacy_reference_bootstrap" | "mixed_or_unverifiable" {
  const hasProvenance = candles.map(candle => candle.provenance);
  if (hasProvenance.every(item => item === null)) return "legacy_reference_bootstrap";
  const verified = hasProvenance.every(item => item?.valueSource === "ws_aggregated" || item?.isNoTrade === true);
  return verified ? "verified" : "mixed_or_unverifiable";
}

/** Pure data-quality manifest. It never repairs, carries forward, or imports raw values. */
export function buildTechnicalAObservationV2Manifest(input: {
  tradeDate: string;
  events: RtSourceEvent[];
  watermark: unknown;
  sourceDecisionCount: number;
  processedThroughEngineSequence: number;
}) {
  const rawEvents = input.events
    .filter(event => event.status === "processed" && event.resultAction !== "correction_ignored")
    .slice()
    .sort((a, b) => a.id - b.id || a.sourceEventId.localeCompare(b.sourceEventId));
  const parsed = rawEvents.map(sourceCandle);
  const invalidPayloads = parsed.filter((item): item is null => item === null).length;
  const candles = parsed.filter((item): item is ObservationCandle => item !== null);
  const continuousRaw = candles.filter(candle => isContinuousTime(candle.time));
  const byTime = new Map<string, ObservationCandle>();
  const duplicateTimes: string[] = [];
  for (const candle of continuousRaw) {
    if (byTime.has(candle.time)) duplicateTimes.push(candle.time);
    else byTime.set(candle.time, candle);
  }
  const continuous = Array.from(byTime.values()).sort((a, b) => a.time.localeCompare(b.time));
  const officialOrder = [...continuousRaw].sort((a, b) => a.eventSeq - b.eventSeq || a.sourceId - b.sourceId);
  const sourceTimeInversions = officialOrder.reduce((sum, candle, index) => (
    index > 0 && officialOrder[index - 1]!.time > candle.time ? sum + 1 : sum
  ), 0);
  const observedTimes = continuous.map(candle => candle.time);
  const missing = missingLabels(CONTINUOUS_LABELS, observedTimes);
  const closing = fixedClosingSixty(continuous);
  const badOhlcv = continuous.filter(candle => !validOhlcv(candle));
  const tier = provenanceTier(continuous);
  const reasons: string[] = [];
  if (!rawEvents.length) reasons.push("no_processed_source_events");
  if (invalidPayloads > 0) reasons.push("invalid_or_missing_ohlcv");
  if (badOhlcv.length > 0) reasons.push("invalid_ohlc_relationship");
  if (continuous.length / CONTINUOUS_LABELS.length < 0.98) reasons.push("continuous_coverage_below_98pct");
  if (longestMissing(CONTINUOUS_LABELS, observedTimes) > 2) reasons.push("continuous_missing_run_exceeds_2");
  if (closing.observedMinutes < 59) reasons.push("closing_fixed_60_below_59");
  if (closing.maximumConsecutiveMissing > 1) reasons.push("closing_fixed_60_missing_run_exceeds_1");
  if (duplicateTimes.length > 0 || rawEvents.some(event => event.correctedEventId !== null)) reasons.push("unresolved_duplicate_or_correction");
  if (sourceTimeInversions > 0) reasons.push("source_time_inversion");
  if (tier === "mixed_or_unverifiable") reasons.push("mixed_or_unverifiable_provenance");
  const featureEligible = reasons.length === 0;
  const partialClosing = closing.observedMinutes === 59;
  const sourceRange = rawEvents.length
    ? {
        firstStoredId: Math.min(...rawEvents.map(event => event.id)),
        lastStoredId: Math.max(...rawEvents.map(event => event.id)),
        firstSourceEventId: rawEvents.reduce((selected, event) => event.id < selected.id ? event : selected).sourceEventId,
        lastSourceEventId: rawEvents.reduce((selected, event) => event.id > selected.id ? event : selected).sourceEventId,
        minEventSeq: Math.min(...rawEvents.map(event => event.eventSeq)),
        maxEventSeq: Math.max(...rawEvents.map(event => event.eventSeq)),
      }
    : null;
  const inputHash = sha256Stable({
    component: TECHNICAL_A_OBSERVATION_V2_FEATURE_COMPONENT,
    version: TECHNICAL_A_OBSERVATION_V2_VERSION,
    tradeDate: input.tradeDate,
    events: rawEvents.map(event => ({ id: event.id, sourceEventId: event.sourceEventId, eventSeq: event.eventSeq, candleTime: event.candleTime, payloadHash: event.payloadHash, correctedEventId: event.correctedEventId, status: event.status })),
    watermark: input.watermark,
  });
  return {
    manifestVersion: TECHNICAL_A_OBSERVATION_V2_VERSION,
    configHash: TECHNICAL_A_OBSERVATION_V2_CONFIG_HASH,
    tradeDate: input.tradeDate,
    sourceTier: tier,
    provenanceStatus: tier,
    formalPerformanceUse: false,
    legacyReferenceOnly: tier === "legacy_reference_bootstrap",
    inputHash,
    inputWatermark: input.watermark,
    inputSourceRange: sourceRange,
    sourceDecisionCount: input.sourceDecisionCount,
    processedThroughEngineSequence: input.processedThroughEngineSequence,
    actual: {
      continuousUnique: continuous.length,
      coveragePct: continuous.length / CONTINUOUS_LABELS.length * 100,
      missingLabels: missing,
      maximumConsecutiveMissing: longestMissing(CONTINUOUS_LABELS, observedTimes),
      closingFixed60: closing,
    },
    anomalies: {
      invalidPayloads,
      invalidOhlcvTimes: badOhlcv.map(candle => candle.time),
      duplicateTimes,
      correctionCount: rawEvents.filter(event => event.correctedEventId !== null).length,
      sourceTimeInversions,
    },
    missingLabels: {
      continuous: missing,
      closingFixed60: closing.missingLabels,
      closingLabel: partialClosing ? "partial_59_of_60" : closing.observedMinutes === 60 ? "complete_60_of_60" : "insufficient_closing_window",
    },
    confidenceCap: partialClosing || tier === "legacy_reference_bootstrap" ? "medium" : "high",
    featureEligible,
    dataStatus: featureEligible ? "reference_ready" : "data_blocked",
    reasonCodes: featureEligible
      ? tier === "legacy_reference_bootstrap" ? ["legacy_reference_bootstrap"] : ["eligible_verified_relay"]
      : reasons,
  };
}

function manifestValue(manifest: unknown, name: string): RecordValue {
  return object(object(manifest)[name]);
}

function featureHistoryRows(rows: ObservationFeatureRow[], symbol: string, beforeDate: string): Array<RecordValue> {
  return rows
    .filter(row => row.status === "complete" && row.tradeDate < beforeDate)
    .sort((a, b) => a.tradeDate.localeCompare(b.tradeDate))
    .map(row => object(object(row.resultJson).featuresBySymbol)[symbol])
    .map(object)
    .filter(row => row.featureEligible === true)
    .map(row => object(row.features));
}

/** Causal daily/hourly feature builder with fixed-clock bars and no gap interpolation. */
export function buildTechnicalAObservationV2DailyFeature(input: {
  symbol: string;
  manifest: RecordValue;
  events: RtSourceEvent[];
  priorFeatures: RecordValue[];
}) {
  if (input.manifest.featureEligible !== true) {
    return {
      featureEligible: false,
      missingReasons: Array.isArray(input.manifest.reasonCodes) ? input.manifest.reasonCodes : ["data_blocked"],
      missingLabels: object(input.manifest.missingLabels),
    };
  }
  const all = input.events.map(sourceCandle).filter((item): item is ObservationCandle => item !== null);
  const continuous = all.filter(candle => isContinuousTime(candle.time)).sort((a, b) => a.time.localeCompare(b.time));
  if (!continuous.length) return { featureEligible: false, missingReasons: ["no_continuous_observed_candles"] };
  const first = continuous[0]!;
  const last = continuous.at(-1)!;
  const high = Math.max(...continuous.map(candle => candle.high));
  const low = Math.min(...continuous.map(candle => candle.low));
  const volume = continuous.reduce((sum, candle) => sum + candle.volume, 0);
  const dailyCurrent = { open: first.open, high, low, close: last.close, volume };
  const historical = input.priorFeatures
    .filter(item => finite(item.open) !== null && finite(item.high) !== null && finite(item.low) !== null && finite(item.close) !== null)
    .map(item => ({
      open: finite(item.open)!, high: finite(item.high)!, low: finite(item.low)!, close: finite(item.close)!, volume: finite(item.volume) ?? 0,
    }));
  const daily = [...historical, dailyCurrent];
  const closes = daily.map(item => item.close);
  const movingAverage = (period: number) => closes.length >= period ? average(closes.slice(-period)) : null;
  const movingSlope = (period: number) => {
    if (closes.length < period + 1) return null;
    const prior = average(closes.slice(-period - 1, -1));
    const current = movingAverage(period);
    return prior !== null && current !== null ? pct(current - prior, prior) : null;
  };
  const trueRanges = daily.slice(1).map((item, index) => {
    const priorClose = daily[index]!.close;
    return Math.max(item.high - item.low, Math.abs(item.high - priorClose), Math.abs(item.low - priorClose));
  });
  const atr14 = trueRanges.length >= 14 ? average(trueRanges.slice(-14)) : null;
  const bbValues = closes.length >= 20 ? closes.slice(-20) : [];
  const bbMean = average(bbValues);
  const variance = bbMean === null ? null : average(bbValues.map(value => (value - bbMean) ** 2));
  const std = variance === null ? null : Math.sqrt(variance);
  const closing = fixedClosingSixty(continuous);
  const bars60 = fixedClockBars(continuous);
  const typicalVolume = daily.map(item => item.volume);
  const average5 = typicalVolume.length >= 6 ? average(typicalVolume.slice(-6, -1)) : null;
  const average20 = typicalVolume.length >= 21 ? average(typicalVolume.slice(-21, -1)) : null;
  const intradayVwap = volume > 0
    ? continuous.reduce((sum, candle) => sum + typicalPrice(candle) * candle.volume, 0) / volume
    : null;
  const priorClose = historical.at(-1)?.close ?? null;
  return {
    featureEligible: true,
    sourceDate: input.manifest.tradeDate,
    sourceTier: input.manifest.sourceTier,
    open: first.open,
    high,
    low,
    close: last.close,
    volume,
    observedOpenTime: first.time,
    observedCloseTime: last.time,
    returnPct: priorClose === null ? null : pct(last.close - priorClose, priorClose),
    gapPct: priorClose === null ? null : pct(first.open - priorClose, priorClose),
    atr14Pct: atr14 === null ? null : pct(atr14, last.close),
    movingAverages: Object.fromEntries([5, 20, 25, 50].map(period => [String(period), {
      value: movingAverage(period),
      slopePct: movingSlope(period),
      positionPct: movingAverage(period) === null ? null : pct(last.close - movingAverage(period)!, movingAverage(period)!),
    }])),
    bollinger20: bbMean === null || std === null ? null : {
      middle: bbMean,
      plus1: bbMean + std,
      minus1: bbMean - std,
      plus2: bbMean + 2 * std,
      minus2: bbMean - 2 * std,
      bandwidthPct: pct(4 * std, bbMean),
      percentB: std > 0 ? (last.close - (bbMean - 2 * std)) / (4 * std) * 100 : null,
    },
    volumeRatio: {
      to5: average5 && average5 > 0 ? volume / average5 : null,
      to20: average20 && average20 > 0 ? volume / average20 : null,
    },
    intraday: {
      vwap: intradayVwap,
      distanceFromVwapPct: intradayVwap === null ? null : pct(last.close - intradayVwap, intradayVwap),
      sixtyMinute: closing.value,
      sixtyMinuteQuality: {
        observedMinutes: closing.observedMinutes,
        missingLabels: closing.missingLabels,
        maximumConsecutiveMissing: closing.maximumConsecutiveMissing,
      },
      sessionBars60: bars60,
      closingPositionPct: high > low ? (last.close - low) / (high - low) * 100 : null,
    },
    recentHighLow: {
      high,
      low,
      distanceFromHighPct: pct(last.close - high, high),
      distanceFromLowPct: pct(last.close - low, low),
    },
    inputMissingLabels: object(input.manifest.missingLabels),
    missingReasons: [],
  };
}

/** Builds one immutable v2 feature row using only rows up to the current closed date. */
export function buildTechnicalAObservationV2Feature(input: {
  tradeDate: string;
  eventsBySymbol: Record<string, RtSourceEvent[]>;
  watermark: unknown;
  sourceDecisionCount: number;
  processedThroughEngineSequence: number;
  priorFeatures: ObservationFeatureRow[];
}) {
  const featuresBySymbol: Record<string, RecordValue> = {};
  for (const symbol of TEN_MONITORED_SYMBOLS) {
    const events = input.eventsBySymbol[symbol] ?? [];
    const manifest = buildTechnicalAObservationV2Manifest({
      tradeDate: input.tradeDate,
      events,
      watermark: input.watermark,
      sourceDecisionCount: input.sourceDecisionCount,
      processedThroughEngineSequence: input.processedThroughEngineSequence,
    });
    const prior = featureHistoryRows(input.priorFeatures, symbol, input.tradeDate);
    const features = buildTechnicalAObservationV2DailyFeature({ symbol, manifest, events, priorFeatures: prior });
    featuresBySymbol[symbol] = {
      symbol,
      manifest,
      manifestHash: sha256Stable(manifest),
      featureEligible: features.featureEligible === true,
      features,
      provenanceStatus: manifest.provenanceStatus,
      sourceTier: manifest.sourceTier,
      formalPerformanceUse: false,
      reasonCodes: manifest.reasonCodes,
    };
  }
  for (const symbol of TEN_MONITORED_SYMBOLS) {
    const current = featuresBySymbol[symbol]!;
    const history = input.priorFeatures
      .filter(row => row.status === "complete" && row.tradeDate < input.tradeDate)
      .sort((a, b) => a.tradeDate.localeCompare(b.tradeDate))
      .map(row => object(object(object(row.resultJson).featuresBySymbol)[symbol]))
      .filter(value => Object.keys(value).length > 0);
    current.technicalRegime = classifyTechnicalMarketRegimeReferenceObservationV2({
      current,
      history,
      universeCurrent: featuresBySymbol,
    });
  }
  const inputHash = sha256Stable({
    component: TECHNICAL_A_OBSERVATION_V2_FEATURE_COMPONENT,
    version: TECHNICAL_A_OBSERVATION_V2_VERSION,
    tradeDate: input.tradeDate,
    watermark: input.watermark,
    sourceDecisionCount: input.sourceDecisionCount,
    processedThroughEngineSequence: input.processedThroughEngineSequence,
    featuresBySymbol,
  });
  return {
    component: TECHNICAL_A_OBSERVATION_V2_FEATURE_COMPONENT,
    version: TECHNICAL_A_OBSERVATION_V2_VERSION,
    tradeDate: input.tradeDate,
    immutable: true,
    generatedAt: new Date().toISOString(),
    inputHash,
    watermark: input.watermark,
    sourceDecisionCount: input.sourceDecisionCount,
    processedThroughEngineSequence: input.processedThroughEngineSequence,
    sourceTier: "legacy_reference_bootstrap_or_verified_relay",
    formalPerformanceUse: false,
    featuresBySymbol,
  };
}

function selectedPendingDate(input: { requestedTradeDate: string; sourceDates: string[]; existingRows: ObservationFeatureRow[] }) {
  const completed = new Set(input.existingRows.filter(row => row.status === "complete").map(row => row.tradeDate));
  return [...input.sourceDates]
    .filter(date => date <= input.requestedTradeDate)
    .sort()
    .find(date => !completed.has(date)) ?? input.requestedTradeDate;
}

function watermarkNumbers(watermark: unknown): { sourceDecisionCount: number; processedThroughEngineSequence: number } {
  const raw = object(watermark);
  const decision = object(raw.decision);
  return {
    sourceDecisionCount: Math.max(0, Math.trunc(finite(decision.count) ?? 0)),
    processedThroughEngineSequence: Math.max(0, Math.trunc(finite(decision.maxId) ?? 0)),
  };
}

/** One invocation writes at most one historical date; legacy rows are reference-only. */
export async function materializeTechnicalAObservationV2FeatureForDate(input: {
  tradeDate: string;
  sourceDecisionCount: number;
  processedThroughEngineSequence: number;
  watermark: unknown;
}) {
  const [closedDates, sourceDates, existingRows] = await Promise.all([
    getClosedRtAuditTradeDates({ fromDate: TECHNICAL_A_OBSERVATION_V2_FEATURE_START_DATE, toDate: input.tradeDate }),
    getRtSourceEventTradeDates({ fromDate: TECHNICAL_A_OBSERVATION_V2_FEATURE_START_DATE, toDate: input.tradeDate }),
    getRtDailyAuditMaterializationsForRange({ component: TECHNICAL_A_OBSERVATION_V2_FEATURE_COMPONENT, version: TECHNICAL_A_OBSERVATION_V2_VERSION, fromDate: TECHNICAL_A_OBSERVATION_V2_FEATURE_START_DATE, toDate: input.tradeDate }),
  ]);
  const materializedTradeDate = selectedPendingDate({
    requestedTradeDate: input.tradeDate,
    sourceDates: Array.from(new Set([...sourceDates, ...closedDates])).sort(),
    existingRows,
  });
  const existing = await getRtDailyAuditMaterialization({ component: TECHNICAL_A_OBSERVATION_V2_FEATURE_COMPONENT, version: TECHNICAL_A_OBSERVATION_V2_VERSION, tradeDate: materializedTradeDate });
  if (existing) return { created: false, materializedTradeDate, result: existing.resultJson };
  const [finality, historicalWatermark] = materializedTradeDate === input.tradeDate
    ? [null, null]
    : await Promise.all([
      getRtAuditTradeDateFinality(materializedTradeDate),
      getRtAuditTradeDateWatermark(materializedTradeDate),
    ]);
  const watermark = materializedTradeDate === input.tradeDate ? input.watermark : historicalWatermark;
  const storedCounts = watermarkNumbers(watermark);
  const [priorFeatures, ...sourceGroups] = await Promise.all([
    getRtDailyAuditMaterializationsForRange({ component: TECHNICAL_A_OBSERVATION_V2_FEATURE_COMPONENT, version: TECHNICAL_A_OBSERVATION_V2_VERSION, fromDate: TECHNICAL_A_OBSERVATION_V2_FEATURE_START_DATE, toDate: materializedTradeDate }),
    ...TEN_MONITORED_SYMBOLS.map(symbol => getRtSourceEventsForDateAndSymbol({ tradeDate: materializedTradeDate, symbol })),
  ]);
  const result = buildTechnicalAObservationV2Feature({
    tradeDate: materializedTradeDate,
    eventsBySymbol: Object.fromEntries(TEN_MONITORED_SYMBOLS.map((symbol, index) => [symbol, sourceGroups[index] as RtSourceEvent[]])),
    watermark,
    sourceDecisionCount: materializedTradeDate === input.tradeDate ? input.sourceDecisionCount : storedCounts.sourceDecisionCount,
    processedThroughEngineSequence: materializedTradeDate === input.tradeDate ? input.processedThroughEngineSequence : storedCounts.processedThroughEngineSequence,
    priorFeatures: priorFeatures as ObservationFeatureRow[],
  });
  await upsertRtDailyAuditMaterialization({
    component: TECHNICAL_A_OBSERVATION_V2_FEATURE_COMPONENT,
    version: TECHNICAL_A_OBSERVATION_V2_VERSION,
    tradeDate: materializedTradeDate,
    status: "complete",
    processedThroughEngineSequence: materializedTradeDate === input.tradeDate ? input.processedThroughEngineSequence : storedCounts.processedThroughEngineSequence,
    sourceDecisionCount: materializedTradeDate === input.tradeDate ? input.sourceDecisionCount : storedCounts.sourceDecisionCount,
    resultJson: result,
    lastError: null,
    generatedAt: new Date(),
  });
  return { created: true, materializedTradeDate, result };
}

function observationPlan(input: { symbol: string; sourceTradeDate: string; wrapper: unknown }): TechnicalRegimePlan {
  const wrapper = object(input.wrapper);
  const features = object(wrapper.features);
  const regime = object(wrapper.technicalRegime);
  const bollinger = object(features.bollinger20);
  const close = finite(features.close);
  const atrPct = finite(features.atr14Pct);
  const eligible = wrapper.featureEligible === true && regime.eligible === true
    && (wrapper.provenanceStatus === "verified" || wrapper.provenanceStatus === "legacy_reference_bootstrap");
  const setup = String(regime.setup ?? "unknown");
  const confidence = String(regime.confidence ?? "unavailable");
  let kind: TechnicalPlanKind = "no_trade";
  if (eligible && confidence !== "low" && confidence !== "unavailable") {
    if (setup === "up_breakout" || setup === "up_trend") kind = "trend_breakout_long";
    else if (setup === "down_breakout" || setup === "down_trend") kind = "trend_breakdown_short";
    else if (["upper_reversal", "lower_reversal", "range", "range_compression"].includes(setup)) kind = "range_reversal";
  }
  return {
    sourceTradeDate: input.sourceTradeDate,
    symbol: input.symbol,
    kind,
    setup,
    confidence,
    priorOpen: finite(features.open),
    priorHigh: finite(features.high),
    priorLow: finite(features.low),
    priorClose: close,
    atrPrice: close !== null && atrPct !== null ? close * atrPct / 100 : null,
    bollingerMiddle: finite(bollinger.middle),
    bollingerPlus2: finite(bollinger.plus2),
    bollingerMinus2: finite(bollinger.minus2),
    reasonCodes: !eligible
      ? ["data_blocked", "d_minus_1_v2_feature_unavailable"]
      : kind === "no_trade"
        ? ["plan_ready_no_signal", "technical_confidence_too_low"]
        : [wrapper.provenanceStatus === "legacy_reference_bootstrap" ? "legacy_reference_bootstrap" : "verified_relay_feature", "d_minus_1_feature_frozen"],
  };
}

/** Immutable D-1 plan. Its existence never upgrades legacy data to formal/unseen evidence. */
export async function materializeTechnicalAObservationV2PlanForSourceDate(input: {
  sourceTradeDate: string;
  sourceDecisionCount: number;
  processedThroughEngineSequence: number;
  watermark: unknown;
}) {
  const targetDate = nextTokyoEquityTradeDate(input.sourceTradeDate);
  const existing = await getRtDailyAuditMaterialization({ component: TECHNICAL_A_OBSERVATION_V2_PLAN_COMPONENT, version: TECHNICAL_A_OBSERVATION_V2_VERSION, tradeDate: targetDate });
  if (existing) return { created: false, targetDate, result: existing.resultJson };
  const featureRow = await getRtDailyAuditMaterialization({ component: TECHNICAL_A_OBSERVATION_V2_FEATURE_COMPONENT, version: TECHNICAL_A_OBSERVATION_V2_VERSION, tradeDate: input.sourceTradeDate });
  if (!featureRow || featureRow.status !== "complete") throw new Error("technical_a_observation_v2_feature_missing");
  const featureResult = object(featureRow.resultJson);
  const featuresBySymbol = object(featureResult.featuresBySymbol);
  const plansBySymbol = Object.fromEntries(TEN_MONITORED_SYMBOLS.map(symbol => {
    const wrapper = object(featuresBySymbol[symbol]);
    const plan = observationPlan({ symbol, sourceTradeDate: input.sourceTradeDate, wrapper });
    return [symbol, {
      plan,
      status: plan.reasonCodes.includes("data_blocked") ? "data_blocked" : "plan_ready_no_signal",
      sourceTier: wrapper.sourceTier ?? "unknown",
      provenanceStatus: wrapper.provenanceStatus ?? "unknown",
      featureInputHash: featureResult.inputHash ?? null,
      technicalRegime: wrapper.technicalRegime ?? null,
      reasonCodes: plan.reasonCodes,
    }];
  }));
  const result = {
    component: TECHNICAL_A_OBSERVATION_V2_PLAN_COMPONENT,
    version: TECHNICAL_A_OBSERVATION_V2_VERSION,
    immutable: true,
    generatedAt: new Date().toISOString(),
    sourceTradeDate: input.sourceTradeDate,
    dataCutoff: input.sourceTradeDate,
    targetDate,
    featureInputHash: featureResult.inputHash ?? null,
    inputHash: sha256Stable({ configHash: TECHNICAL_A_OBSERVATION_V2_CONFIG_HASH, sourceTradeDate: input.sourceTradeDate, targetDate, featureInputHash: featureResult.inputHash ?? null, plansBySymbol, watermark: input.watermark }),
    inputWatermark: input.watermark,
    plansBySymbol,
    sourceTier: "legacy_reference_bootstrap_or_verified_relay",
    formalPerformanceUse: false,
    retrospectiveDiagnosticOnly: targetDate < TECHNICAL_A_OBSERVATION_V2_FORMAL_START_DATE,
    automaticSelection: false,
    automaticAdoption: false,
    orderInstructionConnection: false,
  };
  await upsertRtDailyAuditMaterialization({
    component: TECHNICAL_A_OBSERVATION_V2_PLAN_COMPONENT,
    version: TECHNICAL_A_OBSERVATION_V2_VERSION,
    tradeDate: targetDate,
    status: "complete",
    processedThroughEngineSequence: input.processedThroughEngineSequence,
    sourceDecisionCount: input.sourceDecisionCount,
    resultJson: result,
    lastError: null,
    generatedAt: new Date(),
  });
  return { created: true, targetDate, result };
}

function ratio(value: number | null, base: number | null): number | null {
  return value !== null && base !== null && base > 0 ? value / base : null;
}

/** Saved for every v2 event, including no signal, so near misses cannot be hidden by a no-trade. */
export function technicalAObservationV2NearMiss(state: TechnicalRegimeShadowState): RecordValue {
  const plan = state.plan;
  const current = state.candles.at(-1);
  if (plan.reasonCodes.includes("data_blocked")) {
    return { status: "data_blocked", reasonCodes: plan.reasonCodes, unmetConditions: ["d_minus_1_data_quality"] };
  }
  if (plan.kind === "no_trade") {
    return { status: "plan_ready_no_signal", reasonCodes: plan.reasonCodes, unmetConditions: ["d_minus_1_setup_or_confidence"] };
  }
  if (!current || state.candles.length < 10) {
    return { status: "plan_ready_no_signal", warmupCandlesRemaining: Math.max(0, 10 - state.candles.length), unmetConditions: ["ten_completed_intraday_candles"] };
  }
  const prior = state.candles.slice(-11, -1);
  const volumeBase = average(prior.map(candle => candle.volume).filter(value => value >= 0));
  const volumeRatio = ratio(current.volume, volumeBase);
  const allVolume = state.candles.reduce((sum, candle) => sum + candle.volume, 0);
  const vwap = allVolume > 0
    ? state.candles.reduce((sum, candle) => sum + (candle.high + candle.low + candle.close) / 3 * candle.volume, 0) / allVolume
    : null;
  const longPlan = plan.kind === "trend_breakout_long";
  const shortPlan = plan.kind === "trend_breakdown_short";
  const trigger = longPlan ? plan.priorHigh : shortPlan ? plan.priorLow : null;
  const triggerDistancePct = trigger === null ? null : longPlan
    ? Math.max(0, trigger - current.close) / trigger * 100
    : shortPlan
      ? Math.max(0, current.close - trigger) / trigger * 100
      : null;
  const vwapDistancePct = vwap === null ? null : longPlan
    ? Math.max(0, vwap - current.close) / vwap * 100
    : shortPlan
      ? Math.max(0, current.close - vwap) / vwap * 100
      : null;
  const threshold = plan.kind === "range_reversal" ? 1.1 : 1.2;
  const volumeShortfall = volumeRatio === null ? null : Math.max(0, threshold - volumeRatio);
  const unmet = [
    ...(triggerDistancePct !== null && triggerDistancePct > 0 ? ["price_break"] : []),
    ...(vwapDistancePct !== null && vwapDistancePct > 0 ? ["vwap_confirmation"] : []),
    ...(volumeShortfall !== null && volumeShortfall > 0 ? ["volume_ratio"] : []),
  ];
  return {
    status: "plan_ready_no_signal",
    planKind: plan.kind,
    priceBreakDistancePct: triggerDistancePct,
    vwapDistancePct,
    volumeRatio,
    volumeRatioMinimum: threshold,
    volumeRatioShortfall: volumeShortfall,
    requiredRewardRisk: 1.2,
    boardFreshnessMaximumMs: TECHNICAL_A_OBSERVATION_V2_MAX_BOARD_AGE_MS,
    unmetConditions: unmet.length ? unmet : ["intra_minute_signal_not_formed"],
  };
}

function observationStatus(plan: TechnicalRegimePlan, transition: ReturnType<typeof applyTechnicalRegimeShadowTransition>): ObservationStatus {
  if (plan.reasonCodes.includes("data_blocked")) return "data_blocked";
  if (transition.closedPosition) return "closed";
  if (transition.openedPosition) return "entered";
  if (transition.resultType === "rejected") return "signal_rejected";
  return "plan_ready_no_signal";
}

/** Pure official-order replay. The caller supplies a frozen plan and stored source events only. */
export function replayTechnicalAObservationV2Day(input: {
  symbol: string;
  mode: ForwardEvaluationMode;
  plan: TechnicalRegimePlan;
  events: ForwardSourceEventInput[];
}) {
  const ordered = input.events
    .filter(event => event.candle.symbol === input.symbol)
    .slice()
    .sort((a, b) => (a.currentAudit?.engineSequence ?? Number.MAX_SAFE_INTEGER) - (b.currentAudit?.engineSequence ?? Number.MAX_SAFE_INTEGER)
      || a.sourceEventId.localeCompare(b.sourceEventId));
  const tradeDate = ordered[0]?.candle.tradeDate ?? "";
  let state = createEmptyTechnicalRegimeShadowState(input.plan, tradeDate);
  const events: Array<RecordValue> = [];
  const trades: Array<RecordValue> = [];
  for (const source of ordered) {
    const transition = applyTechnicalRegimeShadowTransition(state, source, input.mode);
    const status = observationStatus(input.plan, transition);
    const action = transition.actions.at(-1) ?? null;
    const nearMiss = status === "plan_ready_no_signal"
      ? technicalAObservationV2NearMiss(transition.nextState)
      : status === "signal_rejected"
        ? { ...(object(action)), requiredRewardRisk: 1.2, boardFreshnessMaximumMs: TECHNICAL_A_OBSERVATION_V2_MAX_BOARD_AGE_MS }
        : null;
    events.push({
      sourceEventId: source.sourceEventId,
      engineSequence: source.currentAudit?.engineSequence ?? null,
      candleTime: source.candle.candleTime,
      status,
      resultType: transition.resultType,
      actions: transition.actions,
      nearMiss,
      stateHashAfter: sha256Stable(transition.nextState),
    });
    if (transition.openedPosition) trades.push({
      status: "entered",
      side: transition.openedPosition.side,
      signalTime: transition.openedPosition.signalTime,
      entryTime: transition.openedPosition.entryTime,
      entryPrice: transition.openedPosition.entryPrice,
      stopPrice: transition.openedPosition.stopPrice,
      targetPrice: transition.openedPosition.targetPrice,
      rewardRisk: transition.openedPosition.rewardRisk,
      shares: transition.openedPosition.shares,
    });
    if (transition.closedPosition) {
      const latest = trades.at(-1);
      if (latest) Object.assign(latest, {
        status: "closed",
        exitTime: source.candle.candleTime,
        exitPrice: transition.closedPosition.exitPrice,
        exitReason: transition.closedPosition.exitReason,
        pnl: transition.closedPosition.pnl,
        realizedR: transition.closedPosition.realizedR,
      });
    }
    state = transition.nextState;
  }
  const finalStatus = events.at(-1)?.status ?? (input.plan.reasonCodes.includes("data_blocked") ? "data_blocked" : "plan_ready_no_signal");
  return {
    symbol: input.symbol,
    mode: input.mode,
    tradeDate,
    plan: input.plan,
    planHash: sha256Stable(input.plan),
    officialEventSequence: ordered.map(event => ({ sourceEventId: event.sourceEventId, engineSequence: event.currentAudit?.engineSequence ?? null })),
    status: finalStatus,
    events,
    trades,
    finalState: state,
    finalStateHash: sha256Stable(state),
  };
}

/** Converts only saved KABU source + saved current audit into a replay input. */
export function technicalAObservationV2ReplayInput(event: RtSourceEvent, decision: RtRealtimeDecisionEvent | undefined): ForwardSourceEventInput | null {
  const payload = object(event.payloadJson);
  const open = finite(payload.open);
  const high = finite(payload.high);
  const low = finite(payload.low);
  const close = finite(payload.close);
  const volume = finite(payload.volume);
  if (typeof payload.symbol !== "string" || typeof payload.tradeDate !== "string" || typeof payload.candleTime !== "string"
    || [open, high, low, close, volume].some(value => value === null)) return null;
  const result = object(decision?.resultJson);
  const availability = object(result.availabilityTimeline);
  return {
    sourceEventId: event.sourceEventId,
    candle: { symbol: payload.symbol, tradeDate: payload.tradeDate, candleTime: payload.candleTime, open: open!, high: high!, low: low!, close: close!, volume: volume! },
    board: payload.board ?? null,
    currentAudit: decision ? {
      engineSequence: decision.id,
      resultType: decision.resultType,
      routeId: decision.routeId,
      marginUsedBefore: decision.marginUsedBefore ?? 0,
      marginUsedAfter: decision.marginUsedAfter ?? 0,
      stateHashBefore: decision.stateHashBefore,
      stateHashAfter: decision.stateHashAfter,
      causalityStatus: decision.causalityStatus,
      causalityReason: decision.causalityReason ?? "",
      boardObservedAtMs: finite(availability.boardObservedAtMs),
      relayAssembledAtMs: finite(availability.relayAssembledAtMs),
      relaySentAtMs: finite(availability.relaySentAtMs),
      cloudReceivedAtMs: finite(availability.cloudReceivedAtMs),
      decisionStartedAtMs: decision.decisionStartedAtMs,
      decisionCompletedAtMs: decision.decisionCompletedAtMs,
    } : undefined,
  };
}

/** Retrospective-only helper. It cannot write state, shadow events, trades, or plans. */
export async function replayTechnicalAObservationV2PseudoUnseenDay(input: {
  tradeDate: string;
  sourceTradeDate: string;
}) {
  const planRow = await getRtDailyAuditMaterialization({ component: TECHNICAL_A_OBSERVATION_V2_PLAN_COMPONENT, version: TECHNICAL_A_OBSERVATION_V2_VERSION, tradeDate: input.tradeDate });
  if (!planRow || planRow.status !== "complete") throw new Error("technical_a_observation_v2_frozen_plan_missing");
  const planSnapshot = object(planRow.resultJson);
  if (planSnapshot.dataCutoff !== input.sourceTradeDate) throw new Error("technical_a_observation_v2_plan_cutoff_mismatch");
  const planRows = object(planSnapshot.plansBySymbol);
  const reports: Record<string, unknown> = {};
  for (const symbol of TEN_MONITORED_SYMBOLS) {
    const [sourceEvents, decisions] = await Promise.all([
      getRtSourceEventsForDateAndSymbol({ tradeDate: input.tradeDate, symbol }),
      getRtRealtimeDecisionEventsForDateAndSymbol({ tradeDate: input.tradeDate, symbol }),
    ]);
    const bySource = new Map(decisions.map(decision => [decision.sourceEventId, decision]));
    const events = sourceEvents
      .filter(event => event.status === "processed" && event.resultAction !== "correction_ignored")
      .map(event => technicalAObservationV2ReplayInput(event, bySource.get(event.sourceEventId)))
      .filter((event): event is ForwardSourceEventInput => event !== null);
    const plan = object(planRows[symbol]).plan as TechnicalRegimePlan | undefined;
    if (!plan) throw new Error(`technical_a_observation_v2_plan_missing:${symbol}`);
    reports[symbol] = Object.fromEntries(([
      ["signal_quality", replayTechnicalAObservationV2Day({ symbol, mode: "signal_quality", plan, events })],
      ["capital_constrained", replayTechnicalAObservationV2Day({ symbol, mode: "capital_constrained", plan, events })],
    ] as const));
  }
  const fingerprint = sha256Stable({ planInputHash: planSnapshot.inputHash, sourceTradeDate: input.sourceTradeDate, tradeDate: input.tradeDate, reports });
  return {
    kind: "retrospective_diagnostic_only",
    formalPerformanceUse: false,
    sourceTradeDate: input.sourceTradeDate,
    tradeDate: input.tradeDate,
    planInputHash: planSnapshot.inputHash ?? null,
    planSnapshotHash: sha256Stable(planSnapshot),
    reports,
    fingerprint,
  };
}

function latestModeSummary(symbol: string, planRecord: RecordValue, events: any[], trades: any[], mode: ForwardEvaluationMode) {
  const version = TECHNICAL_A_OBSERVATION_V2_VERSIONS[symbol as ObservationSymbol];
  const scopedEvents = events.filter(event => event.strategyVersion === version && event.evaluationMode === mode);
  const scopedTrades = trades.filter(trade => trade.strategyVersion === version && trade.evaluationMode === mode);
  const latest = scopedEvents.at(-1) ?? null;
  const decision = object(latest?.decisionJson);
  const status = String(decision.observationStatus ?? planRecord.status ?? "data_blocked") as ObservationStatus;
  return {
    mode,
    strategyVersion: version,
    status,
    eventCount: scopedEvents.length,
    resultType: latest?.resultType ?? null,
    nearMiss: decision.nearMiss ?? null,
    actions: decision.actions ?? [],
    entries: scopedTrades.filter(trade => trade.exitPrice === null).length,
    closedTrades: scopedTrades.filter(trade => trade.exitPrice !== null).length,
    trades: scopedTrades.map(trade => ({ side: trade.side, signalTime: trade.signalCandleTime, entryTime: trade.entryCandleTime, entryPrice: trade.entryPrice, stopLossPct: trade.slPct, targetPct: trade.tpPct, exitTime: trade.exitCandleTime, exitPrice: trade.exitPrice, exitReason: trade.exitReason, pnl: trade.pnl })),
  };
}

/** Creates a closed-day result snapshot for UI/API; it never runs strategy logic. */
export async function materializeTechnicalAObservationV2ResultForDate(input: {
  tradeDate: string;
  sourceDecisionCount: number;
  processedThroughEngineSequence: number;
}) {
  const existing = await getRtDailyAuditMaterialization({ component: TECHNICAL_A_OBSERVATION_V2_RESULT_COMPONENT, version: TECHNICAL_A_OBSERVATION_V2_VERSION, tradeDate: input.tradeDate });
  if (existing) return { created: false, result: existing.resultJson };
  const planRow = await getRtDailyAuditMaterialization({ component: TECHNICAL_A_OBSERVATION_V2_PLAN_COMPONENT, version: TECHNICAL_A_OBSERVATION_V2_VERSION, tradeDate: input.tradeDate });
  const planSnapshot = object(planRow?.resultJson);
  const planRows = object(planSnapshot.plansBySymbol);
  const { getRtForwardShadowEventsForDateAndStrategy, getRtForwardShadowTrades } = await import("./db");
  const allVersions = Object.values(TECHNICAL_A_OBSERVATION_V2_VERSIONS);
  const [eventGroups, tradeGroups] = await Promise.all([
    Promise.all(allVersions.map(strategyVersion => getRtForwardShadowEventsForDateAndStrategy({ tradeDate: input.tradeDate, strategyVersion }))),
    Promise.all(allVersions.map(strategyVersion => getRtForwardShadowTrades(strategyVersion))),
  ]);
  const events = eventGroups.flat();
  const trades = tradeGroups.flat().filter(trade => trade.entryTradeDate === input.tradeDate);
  const result = {
    component: TECHNICAL_A_OBSERVATION_V2_RESULT_COMPONENT,
    version: TECHNICAL_A_OBSERVATION_V2_VERSION,
    immutable: true,
    generatedAt: new Date().toISOString(),
    tradeDate: input.tradeDate,
    planSnapshotFound: Boolean(planRow),
    planInputHash: planSnapshot.inputHash ?? null,
    formalPerformanceUse: false,
    symbols: TEN_MONITORED_SYMBOLS.map(symbol => {
      const planRecord = object(planRows[symbol]);
      return {
        symbol,
        plan: planRecord.plan ?? null,
        sourceTier: planRecord.sourceTier ?? null,
        provenanceStatus: planRecord.provenanceStatus ?? null,
        modes: [
          latestModeSummary(symbol, planRecord, events, trades, "signal_quality"),
          latestModeSummary(symbol, planRecord, events, trades, "capital_constrained"),
        ],
      };
    }),
    automaticSelection: false,
    automaticAdoption: false,
    orderInstructionConnection: false,
  };
  await upsertRtDailyAuditMaterialization({
    component: TECHNICAL_A_OBSERVATION_V2_RESULT_COMPONENT,
    version: TECHNICAL_A_OBSERVATION_V2_VERSION,
    tradeDate: input.tradeDate,
    status: "complete",
    processedThroughEngineSequence: input.processedThroughEngineSequence,
    sourceDecisionCount: input.sourceDecisionCount,
    resultJson: result,
    lastError: null,
    generatedAt: new Date(),
  });
  return { created: true, result };
}

/** Snapshot-only dashboard reader; it has no raw-source or hot-path queries. */
export async function getTechnicalAObservationV2Dashboard(asOfDate: string) {
  const [plans, results] = await Promise.all([
    getRtDailyAuditMaterializationsForRange({ component: TECHNICAL_A_OBSERVATION_V2_PLAN_COMPONENT, version: TECHNICAL_A_OBSERVATION_V2_VERSION, fromDate: TECHNICAL_A_OBSERVATION_V2_FEATURE_START_DATE, toDate: asOfDate }),
    getRtDailyAuditMaterializationsForRange({ component: TECHNICAL_A_OBSERVATION_V2_RESULT_COMPONENT, version: TECHNICAL_A_OBSERVATION_V2_VERSION, fromDate: TECHNICAL_A_OBSERVATION_V2_FEATURE_START_DATE, toDate: asOfDate }),
  ]);
  return {
    version: TECHNICAL_A_OBSERVATION_V2_VERSION,
    configHash: TECHNICAL_A_OBSERVATION_V2_CONFIG_HASH,
    plans: plans.filter(row => row.status === "complete").map(row => row.resultJson),
    results: results.filter(row => row.status === "complete").map(row => row.resultJson),
    dataSource: "immutable_v2_observation_snapshots_only",
    formalPerformanceUse: false,
    automaticSelection: false,
    automaticAdoption: false,
    orderInstructionConnection: false,
  };
}

export function technicalAObservationV2StrategyVersion(symbol: string): string {
  const version = TECHNICAL_A_OBSERVATION_V2_VERSIONS[symbol as ObservationSymbol];
  if (!version) throw new Error(`technical_a_observation_v2_unknown_symbol:${symbol}`);
  return version;
}

export function technicalAObservationV2RegimeConfidence(wrapper: unknown): string {
  return String(object(object(wrapper).technicalRegime).confidence ?? "unavailable");
}

export function technicalAObservationV2AtrMedian(input: Array<RecordValue>): number | null {
  return median(input.map(item => finite(item.atr14Pct)).filter((value): value is number => value !== null));
}
