import type { RtOutcomeLabel, RtRealtimeDecisionEvent, RtSourceEvent } from "../drizzle/schema";
import {
  getRtOutcomeLabelsThroughDate,
  getRtRealtimeDecisionEventsForDate,
  getRtSourceEventsForDate,
  upsertRtDivergenceHypothesis,
  upsertRtOutcomeLabel,
} from "./db";
import { getRuntimeIdentity } from "./runtimeIdentity";

export const CURRENT_OUTCOME_BASELINE_VERSION = "current-realtime-outcome-label-v1";
export const DIVERGENCE_ANALYSIS_VERSION = "current-vs-history-divergence-v1";

type CandlePayload = {
  open: number;
  high: number;
  low: number;
  close: number;
  candleTime: string;
};

function payloadCandle(event: RtSourceEvent | undefined): CandlePayload | null {
  if (!event?.payloadJson || typeof event.payloadJson !== "object") return null;
  const raw = event.payloadJson as Record<string, unknown>;
  if (![raw.open, raw.high, raw.low, raw.close].every(value => typeof value === "number")
    || typeof raw.candleTime !== "string") return null;
  return {
    open: raw.open as number,
    high: raw.high as number,
    low: raw.low as number,
    close: raw.close as number,
    candleTime: raw.candleTime,
  };
}

function eventAction(event: RtRealtimeDecisionEvent): string {
  if (!event.resultJson || typeof event.resultJson !== "object") return "none";
  const result = (event.resultJson as Record<string, unknown>).result;
  return result && typeof result === "object" ? String((result as Record<string, unknown>).action ?? "none") : "none";
}

function resultPnl(event: RtRealtimeDecisionEvent): number | null {
  if (!event.resultJson || typeof event.resultJson !== "object") return null;
  const result = (event.resultJson as Record<string, unknown>).result;
  if (result && typeof result === "object" && typeof (result as Record<string, unknown>).pnl === "number") {
    return Math.round((result as Record<string, unknown>).pnl as number);
  }
  return null;
}

function sideFor(event: RtRealtimeDecisionEvent): "long" | "short" | null {
  if (event.side === "long" || event.side === "short") return event.side;
  if (event.routeId?.toLowerCase().includes("long")) return "long";
  if (event.routeId?.toLowerCase().includes("short")) return "short";
  return null;
}

function priceFor(event: RtRealtimeDecisionEvent): number | null {
  const value = Number(event.simulatedBarFillPrice ?? event.signalReferencePrice ?? 0);
  return value > 0 && Number.isFinite(value) ? value : null;
}

function returnPct(side: "long" | "short", entryPrice: number, price: number): number {
  return side === "long"
    ? (price - entryPrice) / entryPrice * 100
    : (entryPrice - price) / entryPrice * 100;
}

function firstUniqueFutureCandles(input: {
  afterEngineSequence: number;
  untilEngineSequence: number | null;
  events: RtRealtimeDecisionEvent[];
  sourceByDbId: Map<number, RtSourceEvent>;
}) {
  const seen = new Set<string>();
  const candles: CandlePayload[] = [];
  for (const event of input.events) {
    if (event.id <= input.afterEngineSequence) continue;
    if (input.untilEngineSequence !== null && event.id > input.untilEngineSequence) break;
    const candle = payloadCandle(input.sourceByDbId.get(event.sourceEventDbId));
    if (!candle || seen.has(candle.candleTime)) continue;
    seen.add(candle.candleTime);
    candles.push(candle);
  }
  return candles;
}

function isMarginBlock(event: RtRealtimeDecisionEvent): boolean {
  return /margin|証拠金/i.test(`${event.reason ?? ""} ${JSON.stringify(event.resultJson ?? {})}`);
}

function outcomeMetrics(side: "long" | "short", entryPrice: number, candles: CandlePayload[]) {
  if (!candles.length) return {
    mfePct: null,
    maePct: null,
    after1mPct: null,
    after3mPct: null,
    after5mPct: null,
  };
  const favorable = candles.map(candle => returnPct(side, entryPrice, side === "long" ? candle.high : candle.low));
  const adverse = candles.map(candle => returnPct(side, entryPrice, side === "long" ? candle.low : candle.high));
  const at = (index: number) => candles[index] ? returnPct(side, entryPrice, candles[index].close) : null;
  return {
    mfePct: Math.max(...favorable),
    maePct: Math.min(...adverse),
    after1mPct: at(0),
    after3mPct: at(2),
    after5mPct: at(4),
  };
}

function causesFor(input: {
  event: RtRealtimeDecisionEvent;
  metrics: ReturnType<typeof outcomeMetrics>;
  entryPrice: number;
}) {
  const causes: Array<{ code: string; usesFuture: boolean }> = [];
  const observedPrice = Number(input.event.executablePriceProxy ?? 0);
  if (observedPrice > 0) {
    const gap = Math.abs(observedPrice - input.entryPrice) / input.entryPrice * 100;
    if (gap >= 0.1) causes.push({ code: "executable_proxy_gap_ge_010pct", usesFuture: false });
  }
  if (input.event.causalityStatus === "violation") {
    causes.push({ code: "causality_violation", usesFuture: false });
  }
  if (input.metrics.after3mPct !== null && input.metrics.after3mPct <= 0 && (input.metrics.mfePct ?? 0) < 0.1) {
    causes.push({ code: "no_positive_followthrough_3m", usesFuture: true });
  }
  return causes;
}

export async function buildOutcomeLabelsForDate(tradeDate: string) {
  const identity = getRuntimeIdentity();
  const targets = new Set(identity.activeEntrySymbols);
  const [decisionEvents, sourceEvents] = await Promise.all([
    getRtRealtimeDecisionEventsForDate(tradeDate),
    getRtSourceEventsForDate(tradeDate),
  ]);
  const sourceByDbId = new Map(sourceEvents.map(event => [event.id, event]));
  const bySymbol = new Map<string, RtRealtimeDecisionEvent[]>();
  for (const event of decisionEvents.filter(event => targets.has(event.symbol))) {
    bySymbol.set(event.symbol, [...(bySymbol.get(event.symbol) ?? []), event]);
  }

  let labels = 0;
  let completed = 0;
  let blocked = 0;
  for (const events of Array.from(bySymbol.values())) {
    for (const entry of events) {
      const actualEntry = entry.resultType === "entry" || eventAction(entry) === "entry";
      const marginBlocked = isMarginBlock(entry);
      if (!actualEntry && !marginBlocked) continue;
      const side = sideFor(entry);
      const entryPrice = priceFor(entry);
      if (!side || !entryPrice || !entry.routeId) continue;
      const exit = actualEntry
        ? events.find(event => event.id > entry.id
          && (event.resultType === "exit" || ["exit", "stop_loss", "take_profit", "forced_close"].includes(eventAction(event)))) ?? null
        : null;
      const futureCandles = firstUniqueFutureCandles({
        afterEngineSequence: entry.id,
        untilEngineSequence: exit?.id ?? null,
        events,
        sourceByDbId,
      });
      const metrics = outcomeMetrics(side, entryPrice, futureCandles);
      const exitPrice = exit ? priceFor(exit) : null;
      const shares = entry.shares && entry.shares > 0
        ? entry.shares
        : Math.max(100, Math.floor((3_000_000 * 0.9) / entryPrice / 100) * 100);
      const finalPnl = exit ? (resultPnl(exit) ?? (exitPrice === null ? null : Math.round(returnPct(side, entryPrice, exitPrice) / 100 * entryPrice * shares))) : null;
      const causes = causesFor({ event: entry, metrics, entryPrice });
      await upsertRtOutcomeLabel({
        baselineVersion: CURRENT_OUTCOME_BASELINE_VERSION,
        entrySourceEventId: entry.sourceEventId,
        exitSourceEventId: exit?.sourceEventId ?? null,
        tradeDate,
        symbol: entry.symbol,
        routeId: entry.routeId,
        side,
        entryPrice: String(entryPrice),
        exitPrice: exitPrice === null ? null : String(exitPrice),
        shares,
        mfePct: metrics.mfePct === null ? null : String(metrics.mfePct),
        maePct: metrics.maePct === null ? null : String(metrics.maePct),
        after1mPct: metrics.after1mPct === null ? null : String(metrics.after1mPct),
        after3mPct: metrics.after3mPct === null ? null : String(metrics.after3mPct),
        after5mPct: metrics.after5mPct === null ? null : String(metrics.after5mPct),
        finalPnl,
        counterfactualJson: {
          source: actualEntry ? "actual_realtime" : "margin_blocked_candidate",
          diagnosisOnly: true,
          causes,
          futureFeaturePolicy: "MFE_MAE_and_after_1_3_5m_are_diagnosis_only",
          entryFeaturePolicy: "only_observed_at_lte_decision_at_may_become_future_candidate_condition",
          exitCoverage: actualEntry ? (exit ? "actual_exit" : "open_or_missing_exit") : "missing_virtual_exit_pending_full_signal_replay",
          adverseExitStress: exitPrice === null ? null : {
            pnlAt005Pct: Math.round(returnPct(side, entryPrice, side === "long" ? exitPrice * 0.9995 : exitPrice * 1.0005) / 100 * entryPrice * shares),
            pnlAt010Pct: Math.round(returnPct(side, entryPrice, side === "long" ? exitPrice * 0.999 : exitPrice * 1.001) / 100 * entryPrice * shares),
          },
        },
        diagnosisOnly: true,
        completed: Boolean(exit),
      });
      labels += 1;
      if (exit) completed += 1;
      if (marginBlocked) blocked += 1;
    }
  }
  return { baselineVersion: CURRENT_OUTCOME_BASELINE_VERSION, tradeDate, labels, completed, blocked };
}

function labelCauses(label: RtOutcomeLabel): Array<{ code: string; usesFuture: boolean }> {
  if (!label.counterfactualJson || typeof label.counterfactualJson !== "object") return [];
  const causes = (label.counterfactualJson as Record<string, unknown>).causes;
  if (!Array.isArray(causes)) return [];
  return causes.filter(item => item && typeof item === "object" && typeof (item as Record<string, unknown>).code === "string") as Array<{ code: string; usesFuture: boolean }>;
}

export async function buildDivergenceHypotheses(asOfDate: string) {
  const labels = await getRtOutcomeLabelsThroughDate({
    baselineVersion: CURRENT_OUTCOME_BASELINE_VERSION,
    asOfDate,
  });
  const groups = new Map<string, { symbol: string; routeId: string; causeCode: string; usesFuture: boolean; labels: RtOutcomeLabel[] }>();
  for (const label of labels) {
    for (const cause of labelCauses(label)) {
      const key = `${label.symbol}:${label.routeId}:${cause.code}`;
      const group = groups.get(key) ?? { symbol: label.symbol, routeId: label.routeId, causeCode: cause.code, usesFuture: cause.usesFuture, labels: [] };
      group.labels.push(label);
      groups.set(key, group);
    }
  }
  const saved = [];
  for (const group of Array.from(groups.values())) {
    const current = group.labels.filter(label => label.tradeDate === asOfDate && label.finalPnl !== null && label.finalPnl < 0);
    const historical = group.labels.filter(label => label.tradeDate < asOfDate && label.finalPnl !== null);
    const historicalLosses = historical.filter(label => (label.finalPnl ?? 0) < 0);
    const historicalWins = historical.filter(label => (label.finalPnl ?? 0) > 0);
    const confidence = current.length >= 3 && historicalLosses.length >= 3 && historicalWins.length <= Math.floor(historicalLosses.length / 3)
      ? "medium" as const
      : "low" as const;
    const metricsJson = {
      usesFutureDiagnosticFeature: group.usesFuture,
      mayBecomeEntryCondition: !group.usesFuture,
      confidenceRule: "high_is_forbidden_until_new_strategy_version_reproduces_on_unseen_shadow",
      currentLossSourceEventIds: current.map(label => label.entrySourceEventId),
      historicalLossSourceEventIds: historicalLosses.map(label => label.entrySourceEventId),
      historicalWinSourceEventIds: historicalWins.map(label => label.entrySourceEventId),
    };
    await upsertRtDivergenceHypothesis({
      analysisVersion: DIVERGENCE_ANALYSIS_VERSION,
      asOfDate,
      symbol: group.symbol,
      routeId: group.routeId,
      causeCode: group.causeCode,
      confidence,
      realtimeLossCount: current.length,
      historicalLossHit: historicalLosses.length,
      historicalWinHit: historicalWins.length,
      preventedLossYen: historicalLosses.reduce((sum, label) => sum + Math.abs(label.finalPnl ?? 0), 0),
      lostWinYen: historicalWins.reduce((sum, label) => sum + (label.finalPnl ?? 0), 0),
      followingTradeDeltaYen: 0,
      portfolioDeltaYen: 0,
      status: "observing",
      metricsJson,
    });
    saved.push({ ...group, labels: group.labels.length, confidence });
  }
  return { analysisVersion: DIVERGENCE_ANALYSIS_VERSION, asOfDate, hypotheses: saved };
}
