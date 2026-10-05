import type { RtDailyAuditMaterialization, RtSourceEvent } from "../drizzle/schema";
import { getRtDailyAuditMaterialization, getRtDailyAuditMaterializationsForRange, getRtForwardShadowTradesForEntryDateAndMode, getRtRealtimeDecisionStatsForDate, getRtSourceEventsForDateAndSymbol, upsertRtDailyAuditMaterialization } from "./db";
import { KIOXIA_ATR_FORWARD_SHADOW_SPEC } from "./kioxiaAtrForwardShadow";
import { KIOXIA_CONFIRMED_MORNING_LONG_SPEC } from "./kioxiaConfirmedMorningLong";
import { JPX_EQUITY_CALENDAR_VERSION, nextTokyoEquityTradeDate } from "./jpxEquityCalendar";
import { KIOXIA_NORMALIZED_COMPARISON_PLAN_SPECS } from "./monitoringComparisonNormalizedTrend";
import { MONITORING_COMPARISON_COMPONENT, MONITORING_COMPARISON_MATERIALIZATION_VERSION } from "./monitoringComparisonMaterializer";
import { parseRelayCandleProvenance, type RelayValueSource } from "./relayProvenance";
import { sha256Stable } from "./runtimeIdentity";

export const KIOXIA_MANIFEST_V2_COMPONENT = "kioxia_manifest_v2";
export const KIOXIA_MANIFEST_V2_VERSION = "285a-session-manifest-v3-selector-correctness";
export const KIOXIA_SELECTOR_SNAPSHOT_COMPONENT = "kioxia_next_day_selector";
export const KIOXIA_SELECTOR_RESULT_COMPONENT = "kioxia_next_day_selector_result";
export const KIOXIA_SELECTOR_VERSION = "285a-next-day-selector-v2-correctness";
export const KIOXIA_SELECTOR_START_DATE = "2026-10-01";
const FEATURE_COVERAGE_MINIMUM = 0.98;
const MAX_CONSECUTIVE_MISSING = 2;

export type KioxiaSessionClass = "pre_open" | "morning_continuous" | "lunch" | "afternoon_continuous" | "closing_auction_acceptance" | "close_observation" | "after_close" | "unknown";

type Candle = { time: string; open: number; high: number; low: number; close: number; volume: number; valueSource: RelayValueSource | "unknown"; isNoTrade: boolean; sourceEventId: string };
type MaterializationRow = Pick<RtDailyAuditMaterialization, "tradeDate" | "status" | "resultJson">;
type PlanSpec = typeof KIOXIA_NORMALIZED_COMPARISON_PLAN_SPECS[number];
const LOCATION_UPPER_PERCENT_B = 65;
const LOCATION_LOWER_PERCENT_B = 35;

function configuredSelectorSlPct(origin: PlanSpec["origin"], routeId: PlanSpec["routeId"]) {
  if (origin === "current_baseline") {
    if (routeId === "trendLong") return KIOXIA_CONFIRMED_MORNING_LONG_SPEC.primary.slPct;
    if (routeId === "reversalLong") return KIOXIA_ATR_FORWARD_SHADOW_SPEC.routes.reversal_long.slPct;
    if (routeId === "reversalShort") return KIOXIA_ATR_FORWARD_SHADOW_SPEC.routes.reversal_short.slPct;
    if (routeId === "trendShort") return KIOXIA_ATR_FORWARD_SHADOW_SPEC.routes.trend_short.slPct;
    if (routeId === "kioxiaSafeCbShort") return KIOXIA_ATR_FORWARD_SHADOW_SPEC.routes.safe_cb_short.slPct;
    return null;
  }
  if (routeId === "confirmed_morning_long") return KIOXIA_CONFIRMED_MORNING_LONG_SPEC.primary.slPct;
  const route = routeId as keyof typeof KIOXIA_ATR_FORWARD_SHADOW_SPEC.routes;
  return KIOXIA_ATR_FORWARD_SHADOW_SPEC.routes[route]?.slPct ?? null;
}

export const KIOXIA_SELECTOR_CONFIG = Object.freeze({
  version: KIOXIA_SELECTOR_VERSION,
  routeRegistry: KIOXIA_NORMALIZED_COMPARISON_PLAN_SPECS.map(item => ({
    origin: item.origin, strategyVersion: item.strategyVersion, routeId: item.routeId, side: item.side, label: item.label, slPct: configuredSelectorSlPct(item.origin, item.routeId),
  })),
  sessionContract: {
    candleTime: "JST previous-one-minute start label; raw value remains immutable",
    morning: ["09:00", "11:29"],
    afternoon: ["12:30", "15:24"],
    closingAuctionAcceptance: ["15:25", "15:29"],
    closeObservation: "15:30",
  },
  eligibility: {
    validCoverageMinimum: FEATURE_COVERAGE_MINIMUM,
    maximumConsecutiveMissing: MAX_CONSECUTIVE_MISSING,
    closingSixtyMinuteMissingMaximum: 0,
    acceptedValueSources: ["ws_aggregated", "true_no_trade"],
    disallowedValueSources: ["buffer_reuse", "rest_fallback", "unknown"],
  },
  scoring: {
    minimumCompleteFeatureDays: 20,
    minimumCompletedTradesPerRoute: 10,
    posteriorFireRate: "(signalDays + 1) / (eligibleObservedDays + 2)",
    globalShrinkageK: 20,
    routeShrinkageK: 10,
    regimeShrinkageK: 10,
    score: "posteriorFireRate * posteriorTradeR",
    noTradeWhen: ["expectedDailyR<=0", "adverseExpectedDailyR<=0", "posteriorTradeR<=0", "feature_input_missing"],
  },
  regime: {
    trend: "close_vs_ma20_and_ma20_slope_and_closing_60m_slope",
    volatility: "atr14_pct_vs_prior_eligible_feature_day_median",
    location: { percentBUpperInclusive: LOCATION_UPPER_PERCENT_B, percentBLowerInclusive: LOCATION_LOWER_PERCENT_B },
    fallback: ["full", "trend_volatility", "trend", "route_overall", "unavailable"],
  },
  automaticSelection: false,
  automaticAdoption: false,
  orderInstructionConnection: false,
});
export const KIOXIA_SELECTOR_CONFIG_HASH = sha256Stable(KIOXIA_SELECTOR_CONFIG);

function isTimeIn(time: string, from: string, to: string) { return time >= from && time <= to; }
function minutes(time: string) { const [h, m] = time.split(":").map(Number); return h * 60 + m; }
function labelFor(total: number) { return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`; }
function rangeLabels(from: string, to: string) { const out: string[] = []; for (let value = minutes(from); value <= minutes(to); value += 1) out.push(labelFor(value)); return out; }
const MORNING_LABELS = rangeLabels("09:00", "11:29");
const AFTERNOON_LABELS = rangeLabels("12:30", "15:24");
const CONTINUOUS_LABELS = [...MORNING_LABELS, ...AFTERNOON_LABELS];

export function classifyKioxiaSession(time: string): KioxiaSessionClass {
  if (time === "08:59") return "pre_open";
  if (isTimeIn(time, "09:00", "11:29")) return "morning_continuous";
  if (isTimeIn(time, "11:30", "12:29")) return "lunch";
  if (isTimeIn(time, "12:30", "15:24")) return "afternoon_continuous";
  if (isTimeIn(time, "15:25", "15:29")) return "closing_auction_acceptance";
  if (time === "15:30") return "close_observation";
  if (time > "15:30") return "after_close";
  return "unknown";
}

function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function finite(value: unknown): number | null { const n = Number(value); return Number.isFinite(n) ? n : null; }
function average(values: number[]) { return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null; }
function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}
function pct(value: number, denominator: number) { return denominator > 0 ? value / denominator * 100 : null; }

function sourceCandle(event: RtSourceEvent): Candle | null {
  const raw = object(event.payloadJson);
  const open = finite(raw.open), high = finite(raw.high), low = finite(raw.low), close = finite(raw.close), volume = finite(raw.volume);
  if (open === null || high === null || low === null || close === null || volume === null) return null;
  const provenance = parseRelayCandleProvenance(raw.provenance);
  return { time: event.candleTime, open, high, low, close, volume, valueSource: provenance?.valueSource ?? "unknown", isNoTrade: provenance?.isNoTrade === true, sourceEventId: event.sourceEventId };
}

function longestConsecutive(values: string[], expected: string[]) {
  const set = new Set(values); let current = 0; let longest = 0;
  for (const label of expected) { if (set.has(label)) current = 0; else { current += 1; longest = Math.max(longest, current); } }
  return longest;
}
function rollingMissing(values: string[], expected: string[]) { return expected.filter(label => !new Set(values).has(label)); }
function sessionCount(candles: Candle[], session: KioxiaSessionClass) { return candles.filter(candle => classifyKioxiaSession(candle.time) === session).length; }
function sourceLabel(candle: Candle) { return candle.isNoTrade ? "true_no_trade" : candle.valueSource; }
function acceptedFeatureSource(candle: Candle) {
  const provenNoTrade = candle.isNoTrade && candle.volume === 0 && candle.open === candle.high && candle.high === candle.low && candle.low === candle.close;
  return candle.valueSource === "ws_aggregated" || provenNoTrade;
}
function valuesBySource(candles: Candle[]) { const counts: Record<string, number> = {}; for (const candle of candles) { const label = sourceLabel(candle); counts[label] = (counts[label] ?? 0) + 1; } return counts; }
function typicalPrice(candle: Pick<Candle, "high" | "low" | "close">) { return (candle.high + candle.low + candle.close) / 3; }

/** The sealed reference contract uses the final 30/60 continuous minutes, not day-wide chunks. */
function closingTimeframeFeatures(candles: Candle[], size: number) {
  if (candles.length < size) return null;
  const window = candles.slice(-size);
  const first = window[0], last = window.at(-1)!;
  const high = Math.max(...window.map(x => x.high)), low = Math.min(...window.map(x => x.low));
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
    vwap: volume > 0 ? window.reduce((sum, bar) => sum + typicalPrice(bar) * bar.volume, 0) / volume : null,
    endPositionPct: high > low ? (last.close - low) / (high - low) * 100 : null,
  };
}

/**
 * 前場・後場をまたがない60分ローソク足。最後の端数も独立足として保存する。
 * 翌日選択器だけが閉場後に読み、日中シグナルには接続しない。
 */
function sessionBars60(candles: Candle[]) {
  const sessions = [
    candles.filter(candle => classifyKioxiaSession(candle.time) === "morning_continuous"),
    candles.filter(candle => classifyKioxiaSession(candle.time) === "afternoon_continuous"),
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
        vwap: volume > 0 ? window.reduce((sum, item) => sum + typicalPrice(item) * item.volume, 0) / volume : null,
        returnPct: pct(last.close - first.open, first.open),
        closePositionPct: high > low ? (last.close - low) / (high - low) * 100 : null,
      });
    }
    return bars;
  });
}

export function buildKioxiaManifestV2(input: { tradeDate: string; events: RtSourceEvent[]; sourceDecisionCount: number; processedThroughEngineSequence: number; watermark: unknown; causalityViolationCount: number; }): Record<string, unknown> {
  const candles = input.events.map(sourceCandle).filter((item): item is Candle => item !== null).sort((a, b) => a.time.localeCompare(b.time));
  const continuous = candles.filter(candle => classifyKioxiaSession(candle.time) === "morning_continuous" || classifyKioxiaSession(candle.time) === "afternoon_continuous");
  const unique = new Map<string, Candle>();
  const duplicates: string[] = [];
  for (const candle of continuous) { if (unique.has(candle.time)) duplicates.push(candle.time); else unique.set(candle.time, candle); }
  const uniqueContinuous = Array.from(unique.values());
  const actual = uniqueContinuous.map(candle => candle.time);
  const missing = rollingMissing(actual, CONTINUOUS_LABELS);
  const closingExpected = rangeLabels("14:25", "15:24");
  const closingMissing = rollingMissing(actual, closingExpected);
  const invalidSource = uniqueContinuous.filter(candle => !acceptedFeatureSource(candle));
  const anomalies = {
    duplicateTimes: duplicates,
    correctionCount: input.events.filter(event => event.correctedEventId !== null).length,
    timeReversalCount: input.events.reduce((count, event, index) => index > 0 && event.eventSeq < input.events[index - 1].eventSeq ? count + 1 : count, 0),
    causalityViolationCount: input.causalityViolationCount,
  };
  const latencyValues = input.events.map(event => {
    const audit = object(object(event.resultJson).realtimeAudit);
    const boardObservedAtMs = finite(audit.boardObservedAtMs);
    const decisionCompletedAtMs = finite(audit.decisionCompletedAtMs);
    return {
      boardToCloudMs: boardObservedAtMs !== null && event.cloudReceivedAtMs !== null ? event.cloudReceivedAtMs - boardObservedAtMs : null,
      relayAssembleToSentMs: event.relayReceivedAtMs !== null && event.relaySentAtMs !== null ? event.relaySentAtMs - event.relayReceivedAtMs : null,
      relayToCloudMs: event.relaySentAtMs !== null && event.cloudReceivedAtMs !== null ? event.cloudReceivedAtMs - event.relaySentAtMs : null,
      cloudToDecisionMs: decisionCompletedAtMs !== null && event.cloudReceivedAtMs !== null ? decisionCompletedAtMs - event.cloudReceivedAtMs : null,
    };
  });
  const latencyFields = ["boardToCloudMs", "relayAssembleToSentMs", "relayToCloudMs", "cloudToDecisionMs"] as const;
  const latency = Object.fromEntries(latencyFields.map(field => {
    const values = latencyValues.map(item => finite(item[field])).filter((value): value is number => value !== null);
    return [field, { count: values.length, average: average(values), maximum: values.length ? Math.max(...values) : null, inversionCount: values.filter(value => value < 0).length }];
  }));
  const rawBySession: Record<string, number> = {};
  for (const session of ["pre_open", "morning_continuous", "lunch", "afternoon_continuous", "closing_auction_acceptance", "close_observation", "after_close", "unknown"] as KioxiaSessionClass[]) rawBySession[session] = sessionCount(candles, session);
  const coverage = uniqueContinuous.length / CONTINUOUS_LABELS.length;
  const reasons: string[] = [];
  if (input.events.length === 0) reasons.push("no_source_events");
  if (invalidSource.length > 0) reasons.push("unknown_or_non_ws_provenance");
  if (coverage < FEATURE_COVERAGE_MINIMUM) reasons.push("continuous_coverage_below_98pct");
  if (longestConsecutive(actual, CONTINUOUS_LABELS) > MAX_CONSECUTIVE_MISSING) reasons.push("consecutive_missing_exceeds_2");
  if (closingMissing.length > 0) reasons.push("closing_60min_missing");
  if (duplicates.length > 0 || anomalies.correctionCount > 0) reasons.push("unresolved_duplicate_or_correction");
  if (anomalies.timeReversalCount > 0) reasons.push("relay_event_sequence_reversal");
  if (anomalies.causalityViolationCount > 0) reasons.push("causality_violation");
  const featureEligible = reasons.length === 0;
  return {
    manifestVersion: KIOXIA_MANIFEST_V2_VERSION,
    contractHash: sha256Stable(KIOXIA_SELECTOR_CONFIG.sessionContract),
    configHash: KIOXIA_SELECTOR_CONFIG_HASH,
    generatedAt: new Date().toISOString(),
    tradeDate: input.tradeDate,
    rawCount: input.events.length,
    rawBySession,
    expected: { morning: MORNING_LABELS.length, afternoon: AFTERNOON_LABELS.length, continuous: CONTINUOUS_LABELS.length, closingAuctionAcceptance: 5, closeObservation: 1 },
    actual: { continuousUnique: uniqueContinuous.length, coverage, missing, maximumConsecutiveMissing: longestConsecutive(actual, CONTINUOUS_LABELS), closing60MinuteMissing: closingMissing },
    valueSources: valuesBySource(candles),
    fallbackOrUnknownTimes: candles.filter(c => !acceptedFeatureSource(c)).map(c => ({ time: c.time, valueSource: sourceLabel(c) })),
    latency,
    anomalies,
    watermark: input.watermark,
    queueAndFinality: { sourceDecisionCount: input.sourceDecisionCount, processedThroughEngineSequence: input.processedThroughEngineSequence },
    featureEligible,
    signalQualityEligible: featureEligible,
    capitalConstrainedEligible: featureEligible,
    reasonCodes: reasons.length ? reasons : ["eligible"],
    provenanceStatus: candles.length && invalidSource.length === 0 ? "provenance_present" : "unknown_provenance",
  };
}

export function calculateKioxiaSelectorDailyFeature(input: { manifest: Record<string, unknown>; events: RtSourceEvent[]; history: Record<string, unknown>[] }) {
  const manifest = input.manifest;
  if (manifest.featureEligible !== true) return { featureEligible: false, missingReasons: manifest.reasonCodes ?? ["insufficient_feature_source"] };
  const continuous = input.events.map(sourceCandle).filter((item): item is Candle => item !== null).filter(c => classifyKioxiaSession(c.time) === "morning_continuous" || classifyKioxiaSession(c.time) === "afternoon_continuous").sort((a, b) => a.time.localeCompare(b.time));
  if (continuous.length !== CONTINUOUS_LABELS.length) return { featureEligible: false, missingReasons: ["continuous_candle_count_changed"] };
  const first = continuous[0], last = continuous.at(-1)!;
  const high = Math.max(...continuous.map(c => c.high)), low = Math.min(...continuous.map(c => c.low));
  const previous = input.history.at(-1);
  const priorClose = previous ? finite(object(previous.features).close) : null;
  const daily = [...input.history.map(item => object(item.features)).filter(item => finite(item.close) !== null), { close: last.close, high, low, volume: continuous.reduce((sum, c) => sum + c.volume, 0) }];
  const closes = daily.map(item => finite(item.close)!).filter((x): x is number => x !== null);
  const ma = (period: number) => closes.length >= period ? average(closes.slice(-period)) : null;
  const maSlope = (period: number) => closes.length >= period + 1 && ma(period) !== null ? pct(ma(period)! - average(closes.slice(-period - 1, -1))!, average(closes.slice(-period - 1, -1))!) : null;
  const typicalVolume = daily.map(item => finite(item.volume) ?? 0);
  const range = high - low;
  const body = last.close - first.open;
  const upperWick = high - Math.max(first.open, last.close);
  const lowerWick = Math.min(first.open, last.close) - low;
  const bbValues = closes.slice(-20);
  const bbMean = average(bbValues);
  const variance = bbMean === null ? null : average(bbValues.map(v => (v - bbMean) ** 2));
  const std = variance === null ? null : Math.sqrt(variance);
  const trueRanges = daily.slice(1).map((item, index) => {
    const h = finite(item.high), l = finite(item.low), prev = finite(daily[index].close);
    return h === null || l === null || prev === null ? null : Math.max(h - l, Math.abs(h - prev), Math.abs(l - prev));
  }).filter((x): x is number => x !== null);
  const atr14 = trueRanges.length >= 14 ? average(trueRanges.slice(-14)) : null;
  const intradayVwap = continuous.reduce((sum, c) => sum + typicalPrice(c) * c.volume, 0) / Math.max(1, continuous.reduce((sum, c) => sum + c.volume, 0));
  return {
    featureEligible: true,
    sourceDate: manifest.tradeDate,
    open: first.open, high, low, close: last.close, volume: continuous.reduce((sum, c) => sum + c.volume, 0),
    returnPct: priorClose ? pct(last.close - priorClose, priorClose) : null,
    gapPct: priorClose ? pct(first.open - priorClose, priorClose) : null,
    bodyPct: pct(body, first.open), upperWickPct: pct(upperWick, first.open), lowerWickPct: pct(lowerWick, first.open),
    atr14Pct: atr14 ? pct(atr14, last.close) : null,
    movingAverages: Object.fromEntries([5, 10, 20, 25, 50].map(period => [String(period), { value: ma(period), slopePct: maSlope(period), positionPct: ma(period) ? pct(last.close - ma(period)!, ma(period)!) : null }])),
    bollinger20: bbMean === null || std === null ? null : { middle: bbMean, plus1: bbMean + std, minus1: bbMean - std, plus2: bbMean + 2 * std, minus2: bbMean - 2 * std, bandwidthPct: pct(4 * std, bbMean), percentB: std > 0 ? (last.close - (bbMean - 2 * std)) / (4 * std) * 100 : null },
    volumeRatio: { to5: typicalVolume.length >= 6 ? pct(typicalVolume.at(-1)! - average(typicalVolume.slice(-6, -1))!, average(typicalVolume.slice(-6, -1))!) : null, to20: typicalVolume.length >= 21 ? pct(typicalVolume.at(-1)! - average(typicalVolume.slice(-21, -1))!, average(typicalVolume.slice(-21, -1))!) : null },
    intraday: { vwap: intradayVwap, distanceFromVwapPct: pct(last.close - intradayVwap, intradayVwap), thirtyMinute: closingTimeframeFeatures(continuous, 30), sixtyMinute: closingTimeframeFeatures(continuous, 60), sessionBars60: sessionBars60(continuous), closingPositionPct: range > 0 ? (last.close - low) / range * 100 : null },
    recentHighLow: { high, low, distanceFromHighPct: pct(last.close - high, high), distanceFromLowPct: pct(last.close - low, low) },
    missingReasons: [],
  };
}

export function classifyKioxiaSelectorRegime(features: Record<string, unknown>, priorFeatureRows: Record<string, unknown>[]) {
  const ma20 = object(object(features.movingAverages)["20"]);
  const close = finite(features.close), ma20Value = finite(ma20.value), ma20Slope = finite(ma20.slopePct);
  const closingSixtySlope = finite(object(object(features.intraday).sixtyMinute).slopePct);
  const trend = close !== null && ma20Value !== null && ma20Slope !== null && closingSixtySlope !== null
    && close > ma20Value && ma20Slope > 0 && closingSixtySlope >= 0
    ? "up"
    : close !== null && ma20Value !== null && ma20Slope !== null && closingSixtySlope !== null
      && close < ma20Value && ma20Slope < 0 && closingSixtySlope <= 0
      ? "down"
      : "range";
  const atr = finite(features.atr14Pct);
  const priorAtr = priorFeatureRows.map(item => finite(item.atr14Pct)).filter((value): value is number => value !== null);
  const atrMedian = median(priorAtr);
  const volatility = atr === null || atrMedian === null ? "unknown" : atr > atrMedian ? "high" : "normal";
  const percentB = finite(object(features.bollinger20).percentB);
  const location = percentB === null ? "unknown" : percentB >= LOCATION_UPPER_PERCENT_B ? "upper" : percentB <= LOCATION_LOWER_PERCENT_B ? "lower" : "middle";
  return { trend, volatility, location, atr14MedianPct: atrMedian, full: `${trend}|${volatility}|${location}` };
}

function parseComparisonEntries(rows: MaterializationRow[]): Array<Record<string, unknown> & { tradeDate: string }> {
  return rows.flatMap(row => {
    const result = object(row.resultJson); const entries = result.entries;
    return row.status === "complete" && Array.isArray(entries) ? entries.map(item => ({ ...object(item), tradeDate: row.tradeDate })) : [];
  });
}
function planKey(item: Pick<PlanSpec, "origin" | "strategyVersion" | "routeId" | "side">) { return `${item.origin}|${item.strategyVersion}|${item.routeId}|${item.side}`; }
function selectorSlPct(spec: PlanSpec | undefined) {
  return spec ? configuredSelectorSlPct(spec.origin, spec.routeId) : null;
}
function intrinsicR(entry: Record<string, unknown>) {
  const intrinsic = object(entry.intrinsic); const pnl = finite(intrinsic.pnlPer100), entryPrice = finite(intrinsic.entryPrice);
  const strategy = String(entry.strategyVersion ?? ""); const route = String(entry.routeId ?? "");
  const spec = KIOXIA_NORMALIZED_COMPARISON_PLAN_SPECS.find(item => planKey(item) === `${entry.origin}|${strategy}|${route}|${entry.side}`);
  const sl = selectorSlPct(spec);
  return pnl === null || entryPrice === null || !sl || sl <= 0 ? null : pnl / (entryPrice * sl / 100 * 100);
}
function entrySignal(entry: Record<string, unknown>) { return entry.sourceDisposition === "accepted" || entry.sourceDisposition === "margin_block" || entry.sourceDisposition === "entry"; }
function completed(entry: Record<string, unknown>) { return object(entry.intrinsic).completed === true && intrinsicR(entry) !== null; }
function adverseR(entry: Record<string, unknown>) {
  const r = intrinsicR(entry);
  const spec = KIOXIA_NORMALIZED_COMPARISON_PLAN_SPECS.find(item => planKey(item) === `${entry.origin}|${entry.strategyVersion}|${entry.routeId}|${entry.side}`);
  const sl = selectorSlPct(spec);
  return r === null || sl === null ? null : r - 0.1 / sl;
}

function posterior(values: number[], prior: number, weight: number) {
  const raw = average(values);
  return raw === null ? null : (values.length * raw + weight * prior) / (values.length + weight);
}

function regimeFallbackEntries(input: {
  observed: Array<{ regime: Record<string, string>; entries: Record<string, unknown>[] }>;
  key: string;
  target: Record<string, string>;
}) {
  const routeEntries = (days: typeof input.observed) => days.flatMap(day => day.entries.filter(entry => planKey(entry as any) === input.key && completed(entry)));
  const levels = [
    { level: "full", days: input.observed.filter(day => day.regime.full === input.target.full) },
    { level: "trend_volatility", days: input.observed.filter(day => day.regime.trend === input.target.trend && day.regime.volatility === input.target.volatility) },
    { level: "trend", days: input.observed.filter(day => day.regime.trend === input.target.trend) },
  ] as const;
  for (const item of levels) {
    const entries = routeEntries(item.days);
    if (entries.length) return { level: item.level, entries };
  }
  const entries = routeEntries(input.observed);
  return entries.length ? { level: "route_overall" as const, entries } : { level: "unavailable" as const, entries: [] };
}

export function scoreKioxiaSelectorRoute(input: { spec: PlanSpec; history: Array<{ tradeDate: string; featureEligible: boolean; regime: Record<string, string>; entries: Record<string, unknown>[] }> }) {
  const key = planKey(input.spec);
  const eligible = input.history.filter(day => day.featureEligible);
  // history is already bounded by KIOXIA_SELECTOR_START_DATE and the frozen strategy versions.
  const observed = eligible;
  const signals = observed.filter(day => day.entries.some(entry => planKey(entry as any) === key && entrySignal(entry))).length;
  const allTradeEntries = observed.flatMap(day => day.entries.filter(entry => planKey(entry as any) === key && completed(entry)));
  const allTrades = allTradeEntries.map(intrinsicR).filter((value): value is number => value !== null);
  const globalTradeEntries = eligible.flatMap(day => day.entries.filter(completed));
  const globalTrades = globalTradeEntries.map(intrinsicR).filter((value): value is number => value !== null);
  const globalMean = average(globalTrades) ?? 0;
  const globalPosterior = globalTrades.length * globalMean / (globalTrades.length + KIOXIA_SELECTOR_CONFIG.scoring.globalShrinkageK);
  const routePosterior = posterior(allTrades, globalPosterior, KIOXIA_SELECTOR_CONFIG.scoring.routeShrinkageK);
  const targetRegime = input.history.at(-1)?.regime ?? { full: "unknown", trend: "unknown", volatility: "unknown" };
  const fallback = regimeFallbackEntries({ observed, key, target: targetRegime });
  const cellTrades = fallback.entries.map(intrinsicR).filter((value): value is number => value !== null);
  const posteriorTradeR = routePosterior === null
    ? null
    : fallback.level === "route_overall"
      ? routePosterior
      : posterior(cellTrades, routePosterior, KIOXIA_SELECTOR_CONFIG.scoring.regimeShrinkageK);
  const fireRate = (signals + 1) / (observed.length + 2);
  const expectedDailyR = posteriorTradeR === null ? null : fireRate * posteriorTradeR;
  const globalAdverse = globalTradeEntries.map(adverseR).filter((value): value is number => value !== null);
  const globalAdverseMean = average(globalAdverse) ?? 0;
  const globalAdversePosterior = globalAdverse.length * globalAdverseMean / (globalAdverse.length + KIOXIA_SELECTOR_CONFIG.scoring.globalShrinkageK);
  const allAdverse = allTradeEntries.map(adverseR).filter((value): value is number => value !== null);
  const routeAdversePosterior = posterior(allAdverse, globalAdversePosterior, KIOXIA_SELECTOR_CONFIG.scoring.routeShrinkageK);
  const cellAdverse = fallback.entries.map(adverseR).filter((value): value is number => value !== null);
  const adversePosterior = routeAdversePosterior === null
    ? null
    : fallback.level === "route_overall"
      ? routeAdversePosterior
      : posterior(cellAdverse, routeAdversePosterior, KIOXIA_SELECTOR_CONFIG.scoring.regimeShrinkageK);
  const adverseExpectedDailyR = adversePosterior === null ? null : fireRate * adversePosterior;
  const confidence = allTrades.length === 0 ? "insufficient" : allTrades.length < 10 ? "reference_low_confidence" : observed.length >= 20 ? "review_candidate" : "reference_low_confidence";
  const exclusionReasons = [
    ...(observed.length < 20 ? ["fewer_than_20_complete_feature_days"] : []),
    ...(allTrades.length < 10 ? ["fewer_than_10_completed_trades"] : []),
    ...(allTrades.length === 0 ? ["no_completed_trade"] : []),
    ...(expectedDailyR === null || expectedDailyR <= 0 ? ["non_positive_expected_daily_r"] : []),
    ...(adverseExpectedDailyR === null || adverseExpectedDailyR <= 0 ? ["non_positive_adverse_expected_daily_r"] : []),
    ...(posteriorTradeR === null || posteriorTradeR <= 0 ? ["non_positive_posterior_trade_r"] : []),
  ];
  return { ...input.spec, eligibleDays: observed.length, signalDays: signals, rawFireRate: observed.length ? signals / observed.length : null, posteriorFireRate: fireRate, completedTrades: allTrades.length, globalRawMeanR: globalMean, globalPosteriorR: globalPosterior, routePosteriorR: routePosterior, regimePosteriorR: posteriorTradeR, fallbackLevel: fallback.level, fallbackSampleSize: cellTrades.length, expectedDailyR, adverseExpectedDailyR, confidence, exclusionReasons, selectable: exclusionReasons.length === 0 };
}

export { nextTokyoEquityTradeDate } from "./jpxEquityCalendar";

export async function materializeKioxiaManifestV2ForDate(input: { tradeDate: string; sourceDecisionCount: number; processedThroughEngineSequence: number; watermark: unknown }) {
  const existing = await getRtDailyAuditMaterialization({ component: KIOXIA_MANIFEST_V2_COMPONENT, version: KIOXIA_MANIFEST_V2_VERSION, tradeDate: input.tradeDate });
  if (existing) return { created: false, result: existing.resultJson };
  const [events, decisionStats] = await Promise.all([
    getRtSourceEventsForDateAndSymbol({ tradeDate: input.tradeDate, symbol: "285A" }),
    getRtRealtimeDecisionStatsForDate(input.tradeDate),
  ]);
  const causalityViolationCount = decisionStats
    .filter(item => item.symbol === "285A" && item.causalityStatus === "violation")
    .reduce((sum, item) => sum + item.eventCount, 0);
  const result = buildKioxiaManifestV2({ ...input, events, causalityViolationCount });
  await upsertRtDailyAuditMaterialization({ component: KIOXIA_MANIFEST_V2_COMPONENT, version: KIOXIA_MANIFEST_V2_VERSION, tradeDate: input.tradeDate, status: "complete", processedThroughEngineSequence: input.processedThroughEngineSequence, sourceDecisionCount: input.sourceDecisionCount, resultJson: result, lastError: null, generatedAt: new Date() });
  return { created: true, result };
}

export async function materializeKioxiaNextDaySelectorForSourceDate(input: { sourceTradeDate: string; sourceDecisionCount: number; processedThroughEngineSequence: number }) {
  const targetDate = nextTokyoEquityTradeDate(input.sourceTradeDate);
  const existing = await getRtDailyAuditMaterialization({ component: KIOXIA_SELECTOR_SNAPSHOT_COMPONENT, version: KIOXIA_SELECTOR_VERSION, tradeDate: targetDate });
  if (existing) return { created: false, targetDate, result: existing.resultJson };
  const manifestRow = await getRtDailyAuditMaterialization({ component: KIOXIA_MANIFEST_V2_COMPONENT, version: KIOXIA_MANIFEST_V2_VERSION, tradeDate: input.sourceTradeDate });
  const manifest = object(manifestRow?.resultJson);
  const historyRows = await getRtDailyAuditMaterializationsForRange({ component: KIOXIA_MANIFEST_V2_COMPONENT, version: KIOXIA_MANIFEST_V2_VERSION, fromDate: KIOXIA_SELECTOR_START_DATE, toDate: input.sourceTradeDate });
  const comparisonRows = await getRtDailyAuditMaterializationsForRange({ component: MONITORING_COMPARISON_COMPONENT, version: MONITORING_COMPARISON_MATERIALIZATION_VERSION, fromDate: KIOXIA_SELECTOR_START_DATE, toDate: input.sourceTradeDate });
  const sourceEvents = await getRtSourceEventsForDateAndSymbol({ tradeDate: input.sourceTradeDate, symbol: "285A" });
  const featureHistory: Record<string, unknown>[] = [];
  for (const row of historyRows) {
    const rowManifest = object(row.resultJson);
    const events = row.tradeDate === input.sourceTradeDate ? sourceEvents : await getRtSourceEventsForDateAndSymbol({ tradeDate: row.tradeDate, symbol: "285A" });
    const features = calculateKioxiaSelectorDailyFeature({ manifest: rowManifest, events, history: featureHistory });
    const priorFeatures = featureHistory.filter(day => day.featureEligible === true).map(day => object(day.features));
    featureHistory.push({ tradeDate: row.tradeDate, features, featureEligible: features.featureEligible === true, regime: features.featureEligible === true ? classifyKioxiaSelectorRegime(features, priorFeatures) : { full: "unknown", trend: "unknown", volatility: "unknown", location: "unknown" } });
  }
  const priorHistory = featureHistory.slice(0, -1);
  const currentFeature = calculateKioxiaSelectorDailyFeature({ manifest, events: sourceEvents, history: priorHistory });
  const priorFeatures = priorHistory.filter(day => day.featureEligible === true).map(day => object(day.features));
  const regime = currentFeature.featureEligible === true ? classifyKioxiaSelectorRegime(currentFeature, priorFeatures) : { full: "unknown", trend: "unknown", volatility: "unknown", location: "unknown" };
  const entries = parseComparisonEntries(comparisonRows);
  const history = featureHistory.map(day => ({
    tradeDate: String(day.tradeDate),
    featureEligible: day.featureEligible === true,
    regime: object(day.regime) as Record<string, string>,
    entries: entries.filter(entry => entry.tradeDate === day.tradeDate),
  }));
  const scores = KIOXIA_NORMALIZED_COMPARISON_PLAN_SPECS.map(spec => scoreKioxiaSelectorRoute({ spec, history }));
  const selectable = currentFeature.featureEligible === true ? scores.filter(score => score.selectable).sort((a, b) => Number(b.expectedDailyR) - Number(a.expectedDailyR)) : [];
  const references = currentFeature.featureEligible === true ? scores.filter(score => score.expectedDailyR !== null && score.expectedDailyR > 0).sort((a, b) => Number(b.expectedDailyR) - Number(a.expectedDailyR)) : [];
  const first = selectable[0] ?? null, second = selectable[1] ?? null;
  const result = {
    selectorVersion: KIOXIA_SELECTOR_VERSION, calendarVersion: JPX_EQUITY_CALENDAR_VERSION, configHash: KIOXIA_SELECTOR_CONFIG_HASH, codeHash: sha256Stable({ selector: KIOXIA_SELECTOR_VERSION, config: KIOXIA_SELECTOR_CONFIG }), generatedAt: new Date().toISOString(), sourceTradeDate: input.sourceTradeDate, targetDate, immutable: true,
    featureSource: { manifestVersion: KIOXIA_MANIFEST_V2_VERSION, manifestHash: sha256Stable(manifest), eligible: currentFeature.featureEligible === true, features: currentFeature, regime },
    scores, referencePrimary: references[0] ?? null, referenceSecondary: references[1] ?? null, primary: first, secondary: second, recommendation: first ? "reference_only" : "no_trade", noTradeReason: first ? null : currentFeature.featureEligible === true ? "all_routes_non_positive_or_insufficient" : "insufficient_feature_source",
    formalPerformanceUse: false, retrospectiveDiagnosticOnly: input.sourceTradeDate < KIOXIA_SELECTOR_START_DATE,
  };
  await upsertRtDailyAuditMaterialization({ component: KIOXIA_SELECTOR_SNAPSHOT_COMPONENT, version: KIOXIA_SELECTOR_VERSION, tradeDate: targetDate, status: "complete", processedThroughEngineSequence: input.processedThroughEngineSequence, sourceDecisionCount: input.sourceDecisionCount, resultJson: result, lastError: null, generatedAt: new Date() });
  return { created: true, targetDate, result };
}

export async function materializeKioxiaNextDaySelectorResultForDate(input: { tradeDate: string; sourceDecisionCount: number; processedThroughEngineSequence: number }) {
  const existing = await getRtDailyAuditMaterialization({ component: KIOXIA_SELECTOR_RESULT_COMPONENT, version: KIOXIA_SELECTOR_VERSION, tradeDate: input.tradeDate });
  if (existing) return { created: false, result: existing.resultJson };
  const snapshot = await getRtDailyAuditMaterialization({ component: KIOXIA_SELECTOR_SNAPSHOT_COMPONENT, version: KIOXIA_SELECTOR_VERSION, tradeDate: input.tradeDate });
  const selection = object(snapshot?.resultJson); const primary = object(selection.primary);
  const comparison = await getRtDailyAuditMaterialization({ component: MONITORING_COMPARISON_COMPONENT, version: MONITORING_COMPARISON_MATERIALIZATION_VERSION, tradeDate: input.tradeDate });
  const entries = parseComparisonEntries(comparison ? [comparison] : []);
  const selected: Array<Record<string, unknown> & { tradeDate: string }> = primary.routeId ? entries.filter(entry => planKey(entry as any) === planKey(primary as any)) : [];
  const closed = selected.filter(completed); const r = closed.map(intrinsicR).filter((value): value is number => value !== null);
  const signalCount = selected.filter(entrySignal).length;
  const intrinsicOpenCount = selected.filter(entry => entrySignal(entry) && object(entry.intrinsic).completed !== true).length;
  const capitalForwardTrades = await getRtForwardShadowTradesForEntryDateAndMode({ entryTradeDate: input.tradeDate, evaluationMode: "capital_constrained" });
  const capitalByEntry = new Map(capitalForwardTrades.map(trade => [`${trade.strategyVersion}:${trade.entrySourceEventId}`, trade]));
  const currentCapital = selected.filter(entry => entry.origin === "current_baseline" && entry.sourceDisposition === "accepted" && completed(entry));
  const shadowCapital = selected.filter(entry => entry.origin === "forward_shadow" && entry.sourceDisposition === "entry")
    .map(entry => capitalByEntry.get(`${String(entry.strategyVersion)}:${String(object(entry.intrinsic).entrySourceEventId ?? entry.signalSourceEventId)}`))
    .filter((trade): trade is NonNullable<typeof trade> => Boolean(trade));
  const capitalR = [
    ...currentCapital.map(intrinsicR).filter((value): value is number => value !== null),
    ...shadowCapital.map(trade => finite(trade.realizedR)).filter((value): value is number => value !== null),
  ];
  const result = { selectorVersion: KIOXIA_SELECTOR_VERSION, tradeDate: input.tradeDate, snapshotFound: Boolean(snapshot), selectedRoute: primary.routeId ? primary : null, signalQuality: { signalCount, openTrades: intrinsicOpenCount, completedTrades: r.length, wins: r.filter(x => x > 0).length, losses: r.filter(x => x < 0).length, totalR: r.reduce((a, b) => a + b, 0), outcome: r.length ? "observed" : signalCount === 0 ? "no_signal" : intrinsicOpenCount > 0 ? "open_trade" : "no_completed_trade" }, capitalConstrained: { mode: "separate_existing_891m_ledger", acceptedOrCapitalTradeCount: capitalR.length, marginBlockCount: selected.filter(entry => entry.sourceDisposition === "margin_block").length, completedTrades: capitalR.length, wins: capitalR.filter(x => x > 0).length, losses: capitalR.filter(x => x < 0).length, totalR: capitalR.reduce((a, b) => a + b, 0), outcome: capitalR.length ? "observed" : signalCount === 0 ? "no_signal" : "no_capital_constrained_completion" }, formalPerformanceUse: false, automaticAdoption: false, orderInstructionConnection: false };
  await upsertRtDailyAuditMaterialization({ component: KIOXIA_SELECTOR_RESULT_COMPONENT, version: KIOXIA_SELECTOR_VERSION, tradeDate: input.tradeDate, status: "complete", processedThroughEngineSequence: input.processedThroughEngineSequence, sourceDecisionCount: input.sourceDecisionCount, resultJson: result, lastError: null, generatedAt: new Date() });
  return { created: true, result };
}

export async function getKioxiaNextDaySelectorDashboard(asOfDate: string) {
  const [snapshots, results, manifests] = await Promise.all([
    getRtDailyAuditMaterializationsForRange({ component: KIOXIA_SELECTOR_SNAPSHOT_COMPONENT, version: KIOXIA_SELECTOR_VERSION, fromDate: KIOXIA_SELECTOR_START_DATE, toDate: asOfDate }),
    getRtDailyAuditMaterializationsForRange({ component: KIOXIA_SELECTOR_RESULT_COMPONENT, version: KIOXIA_SELECTOR_VERSION, fromDate: KIOXIA_SELECTOR_START_DATE, toDate: asOfDate }),
    getRtDailyAuditMaterializationsForRange({ component: KIOXIA_MANIFEST_V2_COMPONENT, version: KIOXIA_MANIFEST_V2_VERSION, fromDate: KIOXIA_SELECTOR_START_DATE, toDate: asOfDate }),
  ]);
  return { selectorVersion: KIOXIA_SELECTOR_VERSION, configHash: KIOXIA_SELECTOR_CONFIG_HASH, automaticAdoption: false, automaticSelection: false, orderInstructionConnection: false, snapshots: snapshots.map(row => row.resultJson), results: results.map(row => row.resultJson), manifests: manifests.map(row => row.resultJson) };
}
