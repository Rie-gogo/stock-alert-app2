/**
 * Strict closed-session technical feature contract shared by closed-date monitoring.
 *
 * This module deliberately contains no selector scoring, dashboard, route registry,
 * database materializer, dispatcher, or order-path code. The compatibility aliases
 * preserve the sealed daily feature payload consumed by existing 10-symbol snapshots.
 */
import type { RtSourceEvent } from "../drizzle/schema";
import {
  parseRelayCandleProvenance,
  type RelayValueSource,
} from "./relayProvenance";
import { sha256Stable } from "./runtimeIdentity";

/** Historical payload marker retained so already-sealed feature JSON remains byte-compatible. */
export const STRICT_TECHNICAL_FEATURE_MANIFEST_VERSION =
  "285a-session-manifest-v3-selector-correctness";
/** Compatibility export only; no 285A selector materializer uses this module. */
export const KIOXIA_MANIFEST_V2_VERSION =
  STRICT_TECHNICAL_FEATURE_MANIFEST_VERSION;

export const STRICT_TECHNICAL_FEATURE_CONTRACT = Object.freeze({
  sessionContract: {
    candleTime:
      "JST previous-one-minute start label; raw value remains immutable",
    morning: ["09:00", "11:29"],
    afternoon: ["12:30", "15:24"],
    closingAuctionAcceptance: ["15:25", "15:29"],
    closeObservation: "15:30",
  },
  eligibility: {
    validCoverageMinimum: 0.98,
    maximumConsecutiveMissing: 2,
    closingSixtyMinuteMissingMaximum: 0,
    acceptedValueSources: ["ws_aggregated", "true_no_trade"],
    disallowedValueSources: ["buffer_reuse", "rest_fallback", "unknown"],
  },
  regime: {
    trend: "close_vs_ma20_and_ma20_slope_and_closing_60m_slope",
    volatility: "atr14_pct_vs_prior_eligible_feature_day_median",
    location: { percentBUpperInclusive: 65, percentBLowerInclusive: 35 },
  },
});

/**
 * Sealed legacy config hash written inside historical-compatible manifests.
 * It is a payload compatibility value, not a registry or a selector dependency.
 */
export const STRICT_TECHNICAL_FEATURE_CONFIG_HASH =
  "0fd6951f82b73da3aed4678d501ed71dd1932266538ddad994b9ab3fb4d0e73d";
export const STRICT_TECHNICAL_FEATURE_SESSION_CONTRACT_HASH = sha256Stable(
  STRICT_TECHNICAL_FEATURE_CONTRACT.sessionContract
);

const FEATURE_COVERAGE_MINIMUM = 0.98;
const MAX_CONSECUTIVE_MISSING = 2;

export type StrictTechnicalFeatureSessionClass =
  | "pre_open"
  | "morning_continuous"
  | "lunch"
  | "afternoon_continuous"
  | "closing_auction_acceptance"
  | "close_observation"
  | "after_close"
  | "unknown";

type Candle = {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  valueSource: RelayValueSource | "unknown";
  isNoTrade: boolean;
  sourceEventId: string;
};
const LOCATION_UPPER_PERCENT_B = 65;
const LOCATION_LOWER_PERCENT_B = 35;
function isTimeIn(time: string, from: string, to: string) {
  return time >= from && time <= to;
}
function minutes(time: string) {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}
function labelFor(total: number) {
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}
function rangeLabels(from: string, to: string) {
  const out: string[] = [];
  for (let value = minutes(from); value <= minutes(to); value += 1)
    out.push(labelFor(value));
  return out;
}
const MORNING_LABELS = rangeLabels("09:00", "11:29");
const AFTERNOON_LABELS = rangeLabels("12:30", "15:24");
const CONTINUOUS_LABELS = [...MORNING_LABELS, ...AFTERNOON_LABELS];

export function classifyStrictTechnicalFeatureSession(
  time: string
): StrictTechnicalFeatureSessionClass {
  if (time === "08:59") return "pre_open";
  if (isTimeIn(time, "09:00", "11:29")) return "morning_continuous";
  if (isTimeIn(time, "11:30", "12:29")) return "lunch";
  if (isTimeIn(time, "12:30", "15:24")) return "afternoon_continuous";
  if (isTimeIn(time, "15:25", "15:29")) return "closing_auction_acceptance";
  if (time === "15:30") return "close_observation";
  if (time > "15:30") return "after_close";
  return "unknown";
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function finite(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function average(values: number[]) {
  return values.length
    ? values.reduce((a, b) => a + b, 0) / values.length
    : null;
}
function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}
function pct(value: number, denominator: number) {
  return denominator > 0 ? (value / denominator) * 100 : null;
}

function sourceCandle(event: RtSourceEvent): Candle | null {
  const raw = object(event.payloadJson);
  const open = finite(raw.open),
    high = finite(raw.high),
    low = finite(raw.low),
    close = finite(raw.close),
    volume = finite(raw.volume);
  if (
    open === null ||
    high === null ||
    low === null ||
    close === null ||
    volume === null
  )
    return null;
  const provenance = parseRelayCandleProvenance(raw.provenance);
  return {
    time: event.candleTime,
    open,
    high,
    low,
    close,
    volume,
    valueSource: provenance?.valueSource ?? "unknown",
    isNoTrade: provenance?.isNoTrade === true,
    sourceEventId: event.sourceEventId,
  };
}

function longestConsecutive(values: string[], expected: string[]) {
  const set = new Set(values);
  let current = 0;
  let longest = 0;
  for (const label of expected) {
    if (set.has(label)) current = 0;
    else {
      current += 1;
      longest = Math.max(longest, current);
    }
  }
  return longest;
}
function rollingMissing(values: string[], expected: string[]) {
  return expected.filter(label => !new Set(values).has(label));
}
function sessionCount(
  candles: Candle[],
  session: StrictTechnicalFeatureSessionClass
) {
  return candles.filter(
    candle => classifyStrictTechnicalFeatureSession(candle.time) === session
  ).length;
}
function sourceLabel(candle: Candle) {
  return candle.isNoTrade ? "true_no_trade" : candle.valueSource;
}
function acceptedFeatureSource(candle: Candle) {
  const provenNoTrade =
    candle.isNoTrade &&
    candle.volume === 0 &&
    candle.open === candle.high &&
    candle.high === candle.low &&
    candle.low === candle.close;
  return candle.valueSource === "ws_aggregated" || provenNoTrade;
}
function valuesBySource(candles: Candle[]) {
  const counts: Record<string, number> = {};
  for (const candle of candles) {
    const label = sourceLabel(candle);
    counts[label] = (counts[label] ?? 0) + 1;
  }
  return counts;
}
function typicalPrice(candle: Pick<Candle, "high" | "low" | "close">) {
  return (candle.high + candle.low + candle.close) / 3;
}

/** The sealed reference contract uses the final 30/60 continuous minutes, not day-wide chunks. */
function closingTimeframeFeatures(candles: Candle[], size: number) {
  if (candles.length < size) return null;
  const window = candles.slice(-size);
  const first = window[0],
    last = window.at(-1)!;
  const high = Math.max(...window.map(x => x.high)),
    low = Math.min(...window.map(x => x.low));
  const volume = window.reduce((sum, bar) => sum + bar.volume, 0);
  return {
    minutes: size,
    startTime: first.time,
    endTime: last.time,
    open: first.open,
    close: last.close,
    slopePct: pct(last.close - first.open, first.open),
    high,
    low,
    rangePct: pct(high - low, first.open),
    vwap:
      volume > 0
        ? window.reduce((sum, bar) => sum + typicalPrice(bar) * bar.volume, 0) /
          volume
        : null,
    endPositionPct:
      high > low ? ((last.close - low) / (high - low)) * 100 : null,
  };
}

/**
 * 前場・後場をまたがない60分ローソク足。最後の端数も独立足として保存する。
 * 翌日選択器だけが閉場後に読み、日中シグナルには接続しない。
 */
function sessionBars60(candles: Candle[]) {
  const sessions = [
    candles.filter(
      candle =>
        classifyStrictTechnicalFeatureSession(candle.time) ===
        "morning_continuous"
    ),
    candles.filter(
      candle =>
        classifyStrictTechnicalFeatureSession(candle.time) ===
        "afternoon_continuous"
    ),
  ];
  return sessions.flatMap((session, sessionIndex) => {
    const bars: Record<string, unknown>[] = [];
    for (let offset = 0; offset < session.length; offset += 60) {
      const window = session.slice(offset, offset + 60);
      if (!window.length) continue;
      const first = window[0];
      const last = window.at(-1)!;
      const high = Math.max(...window.map(item => item.high));
      const low = Math.min(...window.map(item => item.low));
      const volume = window.reduce((sum, item) => sum + item.volume, 0);
      bars.push({
        session: sessionIndex === 0 ? "morning" : "afternoon",
        minutes: window.length,
        startTime: first.time,
        endTime: last.time,
        open: first.open,
        high,
        low,
        close: last.close,
        volume,
        vwap:
          volume > 0
            ? window.reduce(
                (sum, item) => sum + typicalPrice(item) * item.volume,
                0
              ) / volume
            : null,
        returnPct: pct(last.close - first.open, first.open),
        closePositionPct:
          high > low ? ((last.close - low) / (high - low)) * 100 : null,
      });
    }
    return bars;
  });
}

export function buildStrictTechnicalFeatureManifest(input: {
  tradeDate: string;
  events: RtSourceEvent[];
  sourceDecisionCount: number;
  processedThroughEngineSequence: number;
  watermark: unknown;
  causalityViolationCount: number;
}): Record<string, unknown> {
  const candles = input.events
    .map(sourceCandle)
    .filter((item): item is Candle => item !== null)
    .sort((a, b) => a.time.localeCompare(b.time));
  const continuous = candles.filter(
    candle =>
      classifyStrictTechnicalFeatureSession(candle.time) ===
        "morning_continuous" ||
      classifyStrictTechnicalFeatureSession(candle.time) ===
        "afternoon_continuous"
  );
  const unique = new Map<string, Candle>();
  const duplicates: string[] = [];
  for (const candle of continuous) {
    if (unique.has(candle.time)) duplicates.push(candle.time);
    else unique.set(candle.time, candle);
  }
  const uniqueContinuous = Array.from(unique.values());
  const actual = uniqueContinuous.map(candle => candle.time);
  const missing = rollingMissing(actual, CONTINUOUS_LABELS);
  const closingExpected = rangeLabels("14:25", "15:24");
  const closingMissing = rollingMissing(actual, closingExpected);
  const invalidSource = uniqueContinuous.filter(
    candle => !acceptedFeatureSource(candle)
  );
  const anomalies = {
    duplicateTimes: duplicates,
    correctionCount: input.events.filter(
      event => event.correctedEventId !== null
    ).length,
    timeReversalCount: input.events.reduce(
      (count, event, index) =>
        index > 0 && event.eventSeq < input.events[index - 1].eventSeq
          ? count + 1
          : count,
      0
    ),
    causalityViolationCount: input.causalityViolationCount,
  };
  const latencyValues = input.events.map(event => {
    const audit = object(object(event.resultJson).realtimeAudit);
    const boardObservedAtMs = finite(audit.boardObservedAtMs);
    const decisionCompletedAtMs = finite(audit.decisionCompletedAtMs);
    return {
      boardToCloudMs:
        boardObservedAtMs !== null && event.cloudReceivedAtMs !== null
          ? event.cloudReceivedAtMs - boardObservedAtMs
          : null,
      relayAssembleToSentMs:
        event.relayReceivedAtMs !== null && event.relaySentAtMs !== null
          ? event.relaySentAtMs - event.relayReceivedAtMs
          : null,
      relayToCloudMs:
        event.relaySentAtMs !== null && event.cloudReceivedAtMs !== null
          ? event.cloudReceivedAtMs - event.relaySentAtMs
          : null,
      cloudToDecisionMs:
        decisionCompletedAtMs !== null && event.cloudReceivedAtMs !== null
          ? decisionCompletedAtMs - event.cloudReceivedAtMs
          : null,
    };
  });
  const latencyFields = [
    "boardToCloudMs",
    "relayAssembleToSentMs",
    "relayToCloudMs",
    "cloudToDecisionMs",
  ] as const;
  const latency = Object.fromEntries(
    latencyFields.map(field => {
      const values = latencyValues
        .map(item => finite(item[field]))
        .filter((value): value is number => value !== null);
      return [
        field,
        {
          count: values.length,
          average: average(values),
          maximum: values.length ? Math.max(...values) : null,
          inversionCount: values.filter(value => value < 0).length,
        },
      ];
    })
  );
  const rawBySession: Record<string, number> = {};
  for (const session of [
    "pre_open",
    "morning_continuous",
    "lunch",
    "afternoon_continuous",
    "closing_auction_acceptance",
    "close_observation",
    "after_close",
    "unknown",
  ] as StrictTechnicalFeatureSessionClass[])
    rawBySession[session] = sessionCount(candles, session);
  const coverage = uniqueContinuous.length / CONTINUOUS_LABELS.length;
  const reasons: string[] = [];
  if (input.events.length === 0) reasons.push("no_source_events");
  if (invalidSource.length > 0) reasons.push("unknown_or_non_ws_provenance");
  if (coverage < FEATURE_COVERAGE_MINIMUM)
    reasons.push("continuous_coverage_below_98pct");
  if (longestConsecutive(actual, CONTINUOUS_LABELS) > MAX_CONSECUTIVE_MISSING)
    reasons.push("consecutive_missing_exceeds_2");
  if (closingMissing.length > 0) reasons.push("closing_60min_missing");
  if (duplicates.length > 0 || anomalies.correctionCount > 0)
    reasons.push("unresolved_duplicate_or_correction");
  if (anomalies.timeReversalCount > 0)
    reasons.push("relay_event_sequence_reversal");
  if (anomalies.causalityViolationCount > 0)
    reasons.push("causality_violation");
  const featureEligible = reasons.length === 0;
  return {
    manifestVersion: KIOXIA_MANIFEST_V2_VERSION,
    contractHash: sha256Stable(
      STRICT_TECHNICAL_FEATURE_CONTRACT.sessionContract
    ),
    configHash: STRICT_TECHNICAL_FEATURE_CONFIG_HASH,
    generatedAt: new Date().toISOString(),
    tradeDate: input.tradeDate,
    rawCount: input.events.length,
    rawBySession,
    expected: {
      morning: MORNING_LABELS.length,
      afternoon: AFTERNOON_LABELS.length,
      continuous: CONTINUOUS_LABELS.length,
      closingAuctionAcceptance: 5,
      closeObservation: 1,
    },
    actual: {
      continuousUnique: uniqueContinuous.length,
      coverage,
      missing,
      maximumConsecutiveMissing: longestConsecutive(actual, CONTINUOUS_LABELS),
      closing60MinuteMissing: closingMissing,
    },
    valueSources: valuesBySource(candles),
    fallbackOrUnknownTimes: candles
      .filter(c => !acceptedFeatureSource(c))
      .map(c => ({ time: c.time, valueSource: sourceLabel(c) })),
    latency,
    anomalies,
    watermark: input.watermark,
    queueAndFinality: {
      sourceDecisionCount: input.sourceDecisionCount,
      processedThroughEngineSequence: input.processedThroughEngineSequence,
    },
    featureEligible,
    signalQualityEligible: featureEligible,
    capitalConstrainedEligible: featureEligible,
    reasonCodes: reasons.length ? reasons : ["eligible"],
    provenanceStatus:
      candles.length && invalidSource.length === 0
        ? "provenance_present"
        : "unknown_provenance",
  };
}

export function calculateStrictTechnicalDailyFeature(input: {
  manifest: Record<string, unknown>;
  events: RtSourceEvent[];
  history: Record<string, unknown>[];
}) {
  const manifest = input.manifest;
  if (manifest.featureEligible !== true)
    return {
      featureEligible: false,
      missingReasons: manifest.reasonCodes ?? ["insufficient_feature_source"],
    };
  const continuous = input.events
    .map(sourceCandle)
    .filter((item): item is Candle => item !== null)
    .filter(
      c =>
        classifyStrictTechnicalFeatureSession(c.time) ===
          "morning_continuous" ||
        classifyStrictTechnicalFeatureSession(c.time) === "afternoon_continuous"
    )
    .sort((a, b) => a.time.localeCompare(b.time));
  if (continuous.length !== CONTINUOUS_LABELS.length)
    return {
      featureEligible: false,
      missingReasons: ["continuous_candle_count_changed"],
    };
  const first = continuous[0],
    last = continuous.at(-1)!;
  const high = Math.max(...continuous.map(c => c.high)),
    low = Math.min(...continuous.map(c => c.low));
  const previous = input.history.at(-1);
  const priorClose = previous ? finite(object(previous.features).close) : null;
  const daily = [
    ...input.history
      .map(item => object(item.features))
      .filter(item => finite(item.close) !== null),
    {
      close: last.close,
      high,
      low,
      volume: continuous.reduce((sum, c) => sum + c.volume, 0),
    },
  ];
  const closes = daily
    .map(item => finite(item.close)!)
    .filter((x): x is number => x !== null);
  const ma = (period: number) =>
    closes.length >= period ? average(closes.slice(-period)) : null;
  const maSlope = (period: number) =>
    closes.length >= period + 1 && ma(period) !== null
      ? pct(
          ma(period)! - average(closes.slice(-period - 1, -1))!,
          average(closes.slice(-period - 1, -1))!
        )
      : null;
  const typicalVolume = daily.map(item => finite(item.volume) ?? 0);
  const range = high - low;
  const body = last.close - first.open;
  const upperWick = high - Math.max(first.open, last.close);
  const lowerWick = Math.min(first.open, last.close) - low;
  const bbValues = closes.slice(-20);
  const bbMean = average(bbValues);
  const variance =
    bbMean === null ? null : average(bbValues.map(v => (v - bbMean) ** 2));
  const std = variance === null ? null : Math.sqrt(variance);
  const trueRanges = daily
    .slice(1)
    .map((item, index) => {
      const h = finite(item.high),
        l = finite(item.low),
        prev = finite(daily[index].close);
      return h === null || l === null || prev === null
        ? null
        : Math.max(h - l, Math.abs(h - prev), Math.abs(l - prev));
    })
    .filter((x): x is number => x !== null);
  const atr14 = trueRanges.length >= 14 ? average(trueRanges.slice(-14)) : null;
  const intradayVwap =
    continuous.reduce((sum, c) => sum + typicalPrice(c) * c.volume, 0) /
    Math.max(
      1,
      continuous.reduce((sum, c) => sum + c.volume, 0)
    );
  return {
    featureEligible: true,
    sourceDate: manifest.tradeDate,
    open: first.open,
    high,
    low,
    close: last.close,
    volume: continuous.reduce((sum, c) => sum + c.volume, 0),
    returnPct: priorClose ? pct(last.close - priorClose, priorClose) : null,
    gapPct: priorClose ? pct(first.open - priorClose, priorClose) : null,
    bodyPct: pct(body, first.open),
    upperWickPct: pct(upperWick, first.open),
    lowerWickPct: pct(lowerWick, first.open),
    atr14Pct: atr14 ? pct(atr14, last.close) : null,
    movingAverages: Object.fromEntries(
      [5, 10, 20, 25, 50].map(period => [
        String(period),
        {
          value: ma(period),
          slopePct: maSlope(period),
          positionPct: ma(period)
            ? pct(last.close - ma(period)!, ma(period)!)
            : null,
        },
      ])
    ),
    bollinger20:
      bbMean === null || std === null
        ? null
        : {
            middle: bbMean,
            plus1: bbMean + std,
            minus1: bbMean - std,
            plus2: bbMean + 2 * std,
            minus2: bbMean - 2 * std,
            bandwidthPct: pct(4 * std, bbMean),
            percentB:
              std > 0
                ? ((last.close - (bbMean - 2 * std)) / (4 * std)) * 100
                : null,
          },
    volumeRatio: {
      to5:
        typicalVolume.length >= 6
          ? pct(
              typicalVolume.at(-1)! - average(typicalVolume.slice(-6, -1))!,
              average(typicalVolume.slice(-6, -1))!
            )
          : null,
      to20:
        typicalVolume.length >= 21
          ? pct(
              typicalVolume.at(-1)! - average(typicalVolume.slice(-21, -1))!,
              average(typicalVolume.slice(-21, -1))!
            )
          : null,
    },
    intraday: {
      vwap: intradayVwap,
      distanceFromVwapPct: pct(last.close - intradayVwap, intradayVwap),
      thirtyMinute: closingTimeframeFeatures(continuous, 30),
      sixtyMinute: closingTimeframeFeatures(continuous, 60),
      sessionBars60: sessionBars60(continuous),
      closingPositionPct: range > 0 ? ((last.close - low) / range) * 100 : null,
    },
    recentHighLow: {
      high,
      low,
      distanceFromHighPct: pct(last.close - high, high),
      distanceFromLowPct: pct(last.close - low, low),
    },
    missingReasons: [],
  };
}

export function classifyStrictTechnicalFeatureRegime(
  features: Record<string, unknown>,
  priorFeatureRows: Record<string, unknown>[]
) {
  const ma20 = object(object(features.movingAverages)["20"]);
  const close = finite(features.close),
    ma20Value = finite(ma20.value),
    ma20Slope = finite(ma20.slopePct);
  const closingSixtySlope = finite(
    object(object(features.intraday).sixtyMinute).slopePct
  );
  const trend =
    close !== null &&
    ma20Value !== null &&
    ma20Slope !== null &&
    closingSixtySlope !== null &&
    close > ma20Value &&
    ma20Slope > 0 &&
    closingSixtySlope >= 0
      ? "up"
      : close !== null &&
          ma20Value !== null &&
          ma20Slope !== null &&
          closingSixtySlope !== null &&
          close < ma20Value &&
          ma20Slope < 0 &&
          closingSixtySlope <= 0
        ? "down"
        : "range";
  const atr = finite(features.atr14Pct);
  const priorAtr = priorFeatureRows
    .map(item => finite(item.atr14Pct))
    .filter((value): value is number => value !== null);
  const atrMedian = median(priorAtr);
  const volatility =
    atr === null || atrMedian === null
      ? "unknown"
      : atr > atrMedian
        ? "high"
        : "normal";
  const percentB = finite(object(features.bollinger20).percentB);
  const location =
    percentB === null
      ? "unknown"
      : percentB >= LOCATION_UPPER_PERCENT_B
        ? "upper"
        : percentB <= LOCATION_LOWER_PERCENT_B
          ? "lower"
          : "middle";
  return {
    trend,
    volatility,
    location,
    atr14MedianPct: atrMedian,
    full: `${trend}|${volatility}|${location}`,
  };
}

/** Historical aliases retained solely for sealed feature-payload compatibility. */
export type KioxiaSessionClass = StrictTechnicalFeatureSessionClass;
export const classifyKioxiaSession = classifyStrictTechnicalFeatureSession;
export const buildKioxiaManifestV2 = buildStrictTechnicalFeatureManifest;
export const calculateKioxiaSelectorDailyFeature =
  calculateStrictTechnicalDailyFeature;
export const classifyKioxiaSelectorRegime =
  classifyStrictTechnicalFeatureRegime;
