import type { RtDailyAuditMaterialization, RtSourceEvent } from "../drizzle/schema";
import { getRtDailyAuditMaterialization, getRtDailyAuditMaterializationsForRange, getRtForwardShadowTradesForEntryDateAndMode, getRtSourceEventsForDateAndSymbol, upsertRtDailyAuditMaterialization } from "./db";
import { KIOXIA_NORMALIZED_COMPARISON_PLAN_SPECS } from "./monitoringComparisonNormalizedTrend";
import { MONITORING_COMPARISON_COMPONENT, MONITORING_COMPARISON_MATERIALIZATION_VERSION } from "./monitoringComparisonMaterializer";
import { parseRelayCandleProvenance, type RelayValueSource } from "./relayProvenance";
import { sha256Stable } from "./runtimeIdentity";

export const KIOXIA_MANIFEST_V2_COMPONENT = "kioxia_manifest_v2";
export const KIOXIA_MANIFEST_V2_VERSION = "285a-session-manifest-v2";
export const KIOXIA_SELECTOR_SNAPSHOT_COMPONENT = "kioxia_next_day_selector";
export const KIOXIA_SELECTOR_RESULT_COMPONENT = "kioxia_next_day_selector_result";
export const KIOXIA_SELECTOR_VERSION = "285a-next-day-selector-v1";
export const KIOXIA_SELECTOR_START_DATE = "2026-10-01";
const FEATURE_COVERAGE_MINIMUM = 0.98;
const MAX_CONSECUTIVE_MISSING = 2;

export type KioxiaSessionClass = "pre_open" | "morning_continuous" | "lunch" | "afternoon_continuous" | "closing_auction_acceptance" | "close_observation" | "after_close" | "unknown";

type Candle = { time: string; open: number; high: number; low: number; close: number; volume: number; valueSource: RelayValueSource | "unknown"; sourceEventId: string };
type MaterializationRow = Pick<RtDailyAuditMaterialization, "tradeDate" | "status" | "resultJson">;
type PlanSpec = typeof KIOXIA_NORMALIZED_COMPARISON_PLAN_SPECS[number];

export const KIOXIA_SELECTOR_CONFIG = Object.freeze({
  version: KIOXIA_SELECTOR_VERSION,
  routeRegistry: KIOXIA_NORMALIZED_COMPARISON_PLAN_SPECS.map(item => ({
    origin: item.origin, strategyVersion: item.strategyVersion, routeId: item.routeId, side: item.side, label: item.label,
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
    posteriorFireRate: "(signalDays + 1) / (eligibleObservedDays + 2)",
    globalShrinkageK: 20,
    routeShrinkageK: 10,
    regimeShrinkageK: 10,
    score: "posteriorFireRate * posteriorTradeR",
    noTradeWhen: ["expectedDailyR<=0", "adverseExpectedDailyR<=0", "posteriorTradeR<=0", "feature_input_missing"],
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
function pct(value: number, denominator: number) { return denominator > 0 ? value / denominator * 100 : null; }

function sourceCandle(event: RtSourceEvent): Candle | null {
  const raw = object(event.payloadJson);
  const open = finite(raw.open), high = finite(raw.high), low = finite(raw.low), close = finite(raw.close), volume = finite(raw.volume);
  if (open === null || high === null || low === null || close === null || volume === null) return null;
  const provenance = parseRelayCandleProvenance(raw.provenance);
  return { time: event.candleTime, open, high, low, close, volume, valueSource: provenance?.valueSource ?? "unknown", sourceEventId: event.sourceEventId };
}

function longestConsecutive(values: string[], expected: string[]) {
  const set = new Set(values); let current = 0; let longest = 0;
  for (const label of expected) { if (set.has(label)) current = 0; else { current += 1; longest = Math.max(longest, current); } }
  return longest;
}
function rollingMissing(values: string[], expected: string[]) { return expected.filter(label => !new Set(values).has(label)); }
function sessionCount(candles: Candle[], session: KioxiaSessionClass) { return candles.filter(candle => classifyKioxiaSession(candle.time) === session).length; }
function valuesBySource(candles: Candle[]) { const counts: Record<string, number> = {}; for (const candle of candles) counts[candle.valueSource] = (counts[candle.valueSource] ?? 0) + 1; return counts; }

function aggregateBars(candles: Candle[], size: number) {
  const sessions = [candles.filter(c => classifyKioxiaSession(c.time) === "morning_continuous"), candles.filter(c => classifyKioxiaSession(c.time) === "afternoon_continuous")];
  const groups = sessions.flatMap(session => Array.from({ length: Math.ceil(session.length / size) }, (_, index) => session.slice(index * size, index * size + size)).filter(group => group.length));
  return groups.map(group => {
    const first = group[0], last = group.at(-1)!;
    const volume = group.reduce((sum, bar) => sum + bar.volume, 0);
    return { open: first.open, close: last.close, high: Math.max(...group.map(x => x.high)), low: Math.min(...group.map(x => x.low)), volume, vwap: volume > 0 ? group.reduce((sum, bar) => sum + bar.close * bar.volume, 0) / volume : null };
  });
}
function timeframeFeatures(candles: Candle[], size: number) {
  const bars = aggregateBars(candles, size);
  if (!bars.length) return null;
  const first = bars[0], last = bars.at(-1)!;
  const high = Math.max(...bars.map(x => x.high)), low = Math.min(...bars.map(x => x.low));
  const volume = bars.reduce((sum, bar) => sum + bar.volume, 0);
  return { bars: bars.length, close: last.close, slopePct: pct(last.close - first.open, first.open), high, low, rangePct: pct(high - low, first.open), vwap: volume > 0 ? bars.reduce((sum, bar) => sum + (bar.vwap ?? bar.close) * bar.volume, 0) / volume : null, endPositionPct: high > low ? (last.close - low) / (high - low) * 100 : null };
}

export function buildKioxiaManifestV2(input: { tradeDate: string; events: RtSourceEvent[]; sourceDecisionCount: number; processedThroughEngineSequence: number; watermark: unknown; }): Record<string, unknown> {
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
  const invalidSource = uniqueContinuous.filter(candle => candle.valueSource !== "ws_aggregated");
  const anomalies = {
    duplicateTimes: duplicates,
    correctionCount: input.events.filter(event => event.correctedEventId !== null).length,
    timeReversalCount: input.events.reduce((count, event, index) => index > 0 && event.eventSeq < input.events[index - 1].eventSeq ? count + 1 : count, 0),
    causalityViolationCount: 0,
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
    fallbackOrUnknownTimes: candles.filter(c => c.valueSource !== "ws_aggregated").map(c => ({ time: c.time, valueSource: c.valueSource })),
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

function dailyFeature(input: { manifest: Record<string, unknown>; events: RtSourceEvent[]; history: Record<string, unknown>[] }) {
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
  const intradayVwap = continuous.reduce((sum, c) => sum + c.close * c.volume, 0) / Math.max(1, continuous.reduce((sum, c) => sum + c.volume, 0));
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
    intraday: { vwap: intradayVwap, distanceFromVwapPct: pct(last.close - intradayVwap, intradayVwap), thirtyMinute: timeframeFeatures(continuous, 30), sixtyMinute: timeframeFeatures(continuous, 60), closingPositionPct: range > 0 ? (last.close - low) / range * 100 : null },
    recentHighLow: { high, low, distanceFromHighPct: pct(last.close - high, high), distanceFromLowPct: pct(last.close - low, low) },
    missingReasons: [],
  };
}

function regimeFor(features: Record<string, unknown>) {
  const ma5 = object(object(features.movingAverages)["5"]), ma20 = object(object(features.movingAverages)["20"]);
  const slope = finite(object(object(features.intraday).thirtyMinute).slopePct);
  const ma5Value = finite(ma5.value), ma20Value = finite(ma20.value);
  const trend = ma5Value !== null && ma20Value !== null && slope !== null && ma5Value > ma20Value && slope >= 0 ? "up" : ma5Value !== null && ma20Value !== null && slope !== null && ma5Value < ma20Value && slope <= 0 ? "down" : "range";
  const atr = finite(features.atr14Pct);
  const volatility = atr !== null && atr >= 2 ? "high" : "normal";
  const percentB = finite(object(features.bollinger20).percentB);
  const location = percentB === null ? "middle" : percentB >= 66.6667 ? "upper" : percentB <= 33.3333 ? "lower" : "middle";
  return { trend, volatility, location, full: `${trend}|${volatility}|${location}` };
}

function parseComparisonEntries(rows: MaterializationRow[]): Array<Record<string, unknown> & { tradeDate: string }> {
  return rows.flatMap(row => {
    const result = object(row.resultJson); const entries = result.entries;
    return row.status === "complete" && Array.isArray(entries) ? entries.map(item => ({ ...object(item), tradeDate: row.tradeDate })) : [];
  });
}
function planKey(item: Pick<PlanSpec, "origin" | "strategyVersion" | "routeId" | "side">) { return `${item.origin}|${item.strategyVersion}|${item.routeId}|${item.side}`; }
function intrinsicR(entry: Record<string, unknown>) {
  const intrinsic = object(entry.intrinsic); const pnl = finite(intrinsic.pnlPer100), entryPrice = finite(intrinsic.entryPrice);
  const strategy = String(entry.strategyVersion ?? ""); const route = String(entry.routeId ?? "");
  const spec = KIOXIA_NORMALIZED_COMPARISON_PLAN_SPECS.find(item => planKey(item) === `${entry.origin}|${strategy}|${route}|${entry.side}`);
  const sl = spec?.origin === "forward_shadow" ? (route === "safe_cb_short" ? 0.6 : route === "reversal_long" ? 0.6 : 0.8) : route === "kioxiaSafeCbShort" ? 0.6 : null;
  return pnl === null || entryPrice === null || !sl || sl <= 0 ? null : pnl / (entryPrice * sl / 100 * 100);
}
function entrySignal(entry: Record<string, unknown>) { return entry.sourceDisposition === "accepted" || entry.sourceDisposition === "margin_block" || entry.sourceDisposition === "entry"; }
function completed(entry: Record<string, unknown>) { return object(entry.intrinsic).completed === true && intrinsicR(entry) !== null; }
function adverseR(entry: Record<string, unknown>) { const r = intrinsicR(entry); return r === null ? null : r - 0.1 / (String(entry.side) === "long" || String(entry.side) === "short" ? (String(entry.routeId).includes("SafeCb") || String(entry.routeId) === "safe_cb_short" ? 0.6 : String(entry.routeId) === "reversal_long" ? 0.6 : 0.8) : 0.8); }

export function scoreKioxiaSelectorRoute(input: { spec: PlanSpec; history: Array<{ tradeDate: string; featureEligible: boolean; regime: Record<string, string>; entries: Record<string, unknown>[] }> }) {
  const key = planKey(input.spec);
  const eligible = input.history.filter(day => day.featureEligible);
  const observed = eligible.filter(day => day.tradeDate >= (input.spec.origin === "current_baseline" ? "2026-09-16" : "2026-09-07"));
  const signals = observed.filter(day => day.entries.some(entry => planKey(entry as any) === key && entrySignal(entry))).length;
  const allTrades = observed.flatMap(day => day.entries.filter(entry => planKey(entry as any) === key && completed(entry)).map(intrinsicR).filter((value): value is number => value !== null));
  const globalTrades = eligible.flatMap(day => day.entries.filter(completed).map(intrinsicR).filter((value): value is number => value !== null));
  const globalMean = average(globalTrades) ?? 0;
  const routeRaw = average(allTrades);
  const routePosterior = routeRaw === null ? globalMean : (allTrades.length * routeRaw + 10 * globalMean) / (allTrades.length + 10);
  const targetRegime = input.history.at(-1)?.regime ?? { full: "unknown", trend: "unknown", volatility: "unknown" };
  const cellTrades = observed.filter(day => day.regime.full === targetRegime.full).flatMap(day => day.entries.filter(entry => planKey(entry as any) === key && completed(entry)).map(intrinsicR).filter((value): value is number => value !== null));
  const cellMean = average(cellTrades);
  const posteriorTradeR = cellMean === null ? routePosterior : (cellTrades.length * cellMean + 10 * routePosterior) / (cellTrades.length + 10);
  const fireRate = (signals + 1) / (observed.length + 2);
  const expectedDailyR = fireRate * posteriorTradeR;
  const adverseValues = allTrades.map((_, i) => adverseR(observed.flatMap(day => day.entries).filter(entry => planKey(entry as any) === key && completed(entry))[i])).filter((value): value is number => value !== null);
  const adversePosterior = adverseValues.length ? (adverseValues.length * (average(adverseValues) ?? 0) + 10 * globalMean) / (adverseValues.length + 10) : routePosterior;
  const adverseExpectedDailyR = fireRate * adversePosterior;
  const confidence = allTrades.length === 0 ? "insufficient" : allTrades.length < 10 ? "reference_low_confidence" : observed.length >= 20 ? "review_candidate" : "reference_low_confidence";
  const exclusionReasons = [
    ...(allTrades.length === 0 ? ["no_completed_trade"] : []),
    ...(expectedDailyR <= 0 ? ["non_positive_expected_daily_r"] : []),
    ...(adverseExpectedDailyR <= 0 ? ["non_positive_adverse_expected_daily_r"] : []),
    ...(posteriorTradeR <= 0 ? ["non_positive_posterior_trade_r"] : []),
  ];
  return { ...input.spec, eligibleDays: observed.length, signalDays: signals, rawFireRate: observed.length ? signals / observed.length : null, posteriorFireRate: fireRate, completedTrades: allTrades.length, globalPosteriorR: globalMean, routePosteriorR: routePosterior, regimePosteriorR: posteriorTradeR, expectedDailyR, adverseExpectedDailyR, confidence, exclusionReasons, selectable: exclusionReasons.length === 0 };
}

function nextTokyoEquityTradeDate(date: string) {
  const closed = new Set(["2026-10-12", "2026-11-03", "2026-11-23", "2026-12-31"]); // remaining 2026 JPX non-trading holidays
  const next = new Date(`${date}T00:00:00Z`);
  do { next.setUTCDate(next.getUTCDate() + 1); } while (next.getUTCDay() === 0 || next.getUTCDay() === 6 || closed.has(next.toISOString().slice(0, 10)));
  return next.toISOString().slice(0, 10);
}

export async function materializeKioxiaManifestV2ForDate(input: { tradeDate: string; sourceDecisionCount: number; processedThroughEngineSequence: number; watermark: unknown }) {
  const existing = await getRtDailyAuditMaterialization({ component: KIOXIA_MANIFEST_V2_COMPONENT, version: KIOXIA_MANIFEST_V2_VERSION, tradeDate: input.tradeDate });
  if (existing) return { created: false, result: existing.resultJson };
  const events = await getRtSourceEventsForDateAndSymbol({ tradeDate: input.tradeDate, symbol: "285A" });
  const result = buildKioxiaManifestV2({ ...input, events });
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
    const features = dailyFeature({ manifest: rowManifest, events, history: featureHistory });
    featureHistory.push({ tradeDate: row.tradeDate, features, featureEligible: features.featureEligible === true, regime: features.featureEligible === true ? regimeFor(features) : { full: "unknown", trend: "unknown", volatility: "unknown", location: "unknown" } });
  }
  const currentFeature = dailyFeature({ manifest, events: sourceEvents, history: featureHistory.slice(0, -1) });
  const regime = currentFeature.featureEligible === true ? regimeFor(currentFeature) : { full: "unknown", trend: "unknown", volatility: "unknown", location: "unknown" };
  const entries = parseComparisonEntries(comparisonRows);
  const history = featureHistory.map(day => ({
    tradeDate: String(day.tradeDate),
    featureEligible: day.featureEligible === true,
    regime: object(day.regime) as Record<string, string>,
    entries: entries.filter(entry => entry.tradeDate === day.tradeDate),
  }));
  const scores = KIOXIA_NORMALIZED_COMPARISON_PLAN_SPECS.map(spec => scoreKioxiaSelectorRoute({ spec, history }));
  const selectable = currentFeature.featureEligible === true ? scores.filter(score => score.selectable).sort((a, b) => b.expectedDailyR - a.expectedDailyR) : [];
  const first = selectable[0] ?? null, second = selectable[1] ?? null;
  const result = {
    selectorVersion: KIOXIA_SELECTOR_VERSION, configHash: KIOXIA_SELECTOR_CONFIG_HASH, codeHash: sha256Stable({ selector: KIOXIA_SELECTOR_VERSION, config: KIOXIA_SELECTOR_CONFIG }), generatedAt: new Date().toISOString(), sourceTradeDate: input.sourceTradeDate, targetDate, immutable: true,
    featureSource: { manifestVersion: KIOXIA_MANIFEST_V2_VERSION, manifestHash: sha256Stable(manifest), eligible: currentFeature.featureEligible === true, features: currentFeature, regime },
    scores, primary: first, secondary: second, recommendation: first ? "reference_only" : "no_trade", noTradeReason: first ? null : currentFeature.featureEligible === true ? "all_routes_non_positive_or_insufficient" : "insufficient_feature_source",
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
  const result = { selectorVersion: KIOXIA_SELECTOR_VERSION, tradeDate: input.tradeDate, snapshotFound: Boolean(snapshot), selectedRoute: primary.routeId ? primary : null, signalQuality: { signalCount: selected.filter(entrySignal).length, completedTrades: r.length, wins: r.filter(x => x > 0).length, losses: r.filter(x => x < 0).length, totalR: r.reduce((a, b) => a + b, 0), outcome: r.length ? "observed" : "no_signal_or_open" }, capitalConstrained: { mode: "separate_existing_891m_ledger", acceptedOrCapitalTradeCount: capitalR.length, marginBlockCount: selected.filter(entry => entry.sourceDisposition === "margin_block").length, completedTrades: capitalR.length, wins: capitalR.filter(x => x > 0).length, losses: capitalR.filter(x => x < 0).length, totalR: capitalR.reduce((a, b) => a + b, 0), outcome: capitalR.length ? "observed" : "no_capital_constrained_completion" }, formalPerformanceUse: false, automaticAdoption: false, orderInstructionConnection: false };
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
