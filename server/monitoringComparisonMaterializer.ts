import type {
  RtForwardShadowEvent,
  RtRealtimeDecisionEvent,
  RtSignalCandidate,
  RtSourceEvent,
} from "../drizzle/schema";
import {
  getRtForwardShadowEventsForDate,
  getRtRealtimeDecisionEventsForDate,
  getRtSignalCandidatesForDate,
  getRtSourceEventsForDate,
} from "./db";
import { resolveCurrentSignalCandidateVersion } from "./currentSignalCandidateRegistry";
import { parseBoardObservedAtMs } from "./realtimeDecisionAudit";
import {
  KIOXIA_ATR_FORWARD_STRATEGY_VERSION,
  KIOXIA_FORWARD_STRATEGY_VERSION,
} from "./runtimeIdentity";
import {
  MONITORING_COMPARISON_CONTRACT,
  classifyMonitoringAttribution,
  resolveMonitoringComparisonEntry,
  type MonitoringComparisonEntryResolution,
  type MonitoringComparisonSignal,
  type MonitoringComparisonSourceEvent,
} from "./monitoringComparisonContract";

export const MONITORING_COMPARISON_COMPONENT = "monitoring_comparison_285a";
export const MONITORING_COMPARISON_MATERIALIZATION_VERSION =
  "monitoring-comparison-285a-strict-next-depth-materialized-v2";

type MonitoringComparisonOrigin = "current_baseline" | "forward_shadow";

interface NormalizedSignal extends MonitoringComparisonSignal {
  origin: MonitoringComparisonOrigin;
  evaluationMode: "signal_quality";
  sourceDisposition: "accepted" | "margin_block" | "shadow_only" | "forward_shadow";
}

type MaterializedResolution = MonitoringComparisonEntryResolution | {
  status: "unfillable";
  reason: "signal_source_event_missing" | "signal_decision_missing" | "no_later_same_symbol_source_event";
  entrySourceEventId: null;
  entryEngineSequence: null;
  boardAgeMs: null;
};

export interface MonitoringComparisonMaterializedEntry {
  origin: MonitoringComparisonOrigin;
  comparisonGeneration: string;
  strategyVersion: string;
  evaluationMode: "signal_quality";
  sourceDisposition: "accepted" | "margin_block" | "shadow_only" | "forward_shadow";
  signalSourceEventId: string;
  signalEngineSequence: number;
  tradeDate: string;
  signalTime: string;
  symbol: string;
  routeId: string;
  attributionStatus: "classified" | "unclassified";
  includeInOverallPnl: true;
  includeInRouteComparison: boolean;
  side: "long" | "short";
  theoreticalSignalPrice: number;
  resolution: MaterializedResolution;
  adverseEntryGapPct: number | null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function availabilityTimeline(decision: RtRealtimeDecisionEvent): Record<string, unknown> {
  return record(record(decision.resultJson).availabilityTimeline);
}

function sourcePayload(source: RtSourceEvent): Record<string, unknown> {
  return record(source.payloadJson);
}

function boardObservedAtMs(source: RtSourceEvent, decision: RtRealtimeDecisionEvent): number | null {
  const timelineValue = finite(availabilityTimeline(decision).boardObservedAtMs);
  if (timelineValue !== null) return timelineValue;
  const payload = sourcePayload(source);
  const board = record(payload.board);
  return parseBoardObservedAtMs(source.tradeDate, typeof board.currentPriceTime === "string" ? board.currentPriceTime : undefined);
}

function toComparisonSourceEvent(
  source: RtSourceEvent,
  decision: RtRealtimeDecisionEvent,
): MonitoringComparisonSourceEvent | null {
  const payload = sourcePayload(source);
  const open = finite(payload.open);
  const high = finite(payload.high);
  const low = finite(payload.low);
  const close = finite(payload.close);
  const volume = finite(payload.volume);
  const symbol = typeof payload.symbol === "string" ? payload.symbol : source.symbol;
  const tradeDate = typeof payload.tradeDate === "string" ? payload.tradeDate : source.tradeDate;
  const candleTime = typeof payload.candleTime === "string" ? payload.candleTime : source.candleTime;
  if ([open, high, low, close, volume].some(value => value === null)) return null;
  const timeline = availabilityTimeline(decision);
  return {
    sourceEventId: source.sourceEventId,
    candle: {
      symbol,
      tradeDate,
      candleTime,
      open: open!,
      high: high!,
      low: low!,
      close: close!,
      volume: volume!,
    },
    board: payload.board ?? null,
    currentAudit: {
      engineSequence: decision.id,
      resultType: decision.resultType,
      routeId: decision.routeId,
      marginUsedBefore: decision.marginUsedBefore ?? 0,
      marginUsedAfter: decision.marginUsedAfter ?? 0,
      stateHashBefore: decision.stateHashBefore,
      stateHashAfter: decision.stateHashAfter,
      causalityStatus: decision.causalityStatus,
      causalityReason: decision.causalityReason ?? "",
      boardObservedAtMs: boardObservedAtMs(source, decision),
      relayAssembledAtMs: finite(timeline.relayAssembledAtMs) ?? source.relayReceivedAtMs,
      relaySentAtMs: finite(timeline.relaySentAtMs) ?? source.relaySentAtMs,
      cloudReceivedAtMs: finite(timeline.cloudReceivedAtMs) ?? source.cloudReceivedAtMs,
      decisionStartedAtMs: decision.decisionStartedAtMs,
      decisionCompletedAtMs: decision.decisionCompletedAtMs,
    },
  };
}

function actionList(event: RtForwardShadowEvent): Array<Record<string, unknown>> {
  const actions = record(event.decisionJson).actions;
  return Array.isArray(actions) ? actions.map(record) : [];
}

function actionSide(value: unknown): "long" | "short" | null {
  return value === "long" || value === "short" ? value : null;
}

function currentSignals(
  candidates: RtSignalCandidate[],
  decisionBySourceId: Map<string, RtRealtimeDecisionEvent>,
  sourceById: Map<string, RtSourceEvent>,
): NormalizedSignal[] {
  const result: NormalizedSignal[] = [];
  for (const candidate of candidates.filter(item => item.symbol === "285A")) {
    const decision = decisionBySourceId.get(candidate.sourceEventId);
    const source = sourceById.get(candidate.sourceEventId);
    if (!decision || !source) continue;
    result.push({
      origin: "current_baseline",
      evaluationMode: "signal_quality",
      sourceDisposition: candidate.realtimeDecision,
      comparisonGeneration: MONITORING_COMPARISON_CONTRACT.comparisonGeneration,
      strategyVersion: `baseline:${candidate.candidateVersion}`,
      routeId: candidate.routeId,
      symbol: candidate.symbol,
      side: candidate.side,
      signalSourceEventId: candidate.sourceEventId,
      signalEngineSequence: candidate.engineSequence,
      signalTradeDate: candidate.tradeDate,
      signalTime: candidate.candleTime,
      theoreticalSignalPrice: Number(candidate.theoreticalEntryPrice),
      signalDecisionCompletedAtMs: decision.decisionCompletedAtMs,
      signalBoardObservedAtMs: boardObservedAtMs(source, decision),
    });
  }
  return result;
}

function shadowSignals(
  events: RtForwardShadowEvent[],
  decisionBySourceId: Map<string, RtRealtimeDecisionEvent>,
  sourceById: Map<string, RtSourceEvent>,
): NormalizedSignal[] {
  const supported = new Set([KIOXIA_FORWARD_STRATEGY_VERSION, KIOXIA_ATR_FORWARD_STRATEGY_VERSION]);
  const result: NormalizedSignal[] = [];
  for (const event of events) {
    if (event.symbol !== "285A" || event.evaluationMode !== "signal_quality" || !supported.has(event.strategyVersion)) continue;
    const entry = actionList(event).find(action => action.type === "entry");
    const side = actionSide(entry?.side);
    const theoreticalSignalPrice = finite(entry?.theoreticalSignalPrice);
    const decision = decisionBySourceId.get(event.sourceEventId);
    const source = sourceById.get(event.sourceEventId);
    if (!entry || !side || theoreticalSignalPrice === null || !decision || !source) continue;
    const route = typeof entry.route === "string"
      ? entry.route
      : event.strategyVersion === KIOXIA_FORWARD_STRATEGY_VERSION
        ? "confirmed_morning_long"
        : null;
    result.push({
      origin: "forward_shadow",
      evaluationMode: "signal_quality",
      sourceDisposition: "forward_shadow",
      comparisonGeneration: MONITORING_COMPARISON_CONTRACT.comparisonGeneration,
      strategyVersion: event.strategyVersion,
      routeId: route,
      symbol: event.symbol,
      side,
      signalSourceEventId: event.sourceEventId,
      signalEngineSequence: decision.id,
      signalTradeDate: event.tradeDate,
      signalTime: event.candleTime,
      theoreticalSignalPrice,
      signalDecisionCompletedAtMs: decision.decisionCompletedAtMs,
      signalBoardObservedAtMs: boardObservedAtMs(source, decision),
    });
  }
  return result;
}

function adverseEntryGapPct(signal: NormalizedSignal, resolution: MaterializedResolution): number | null {
  if (resolution.status !== "filled" || signal.theoreticalSignalPrice <= 0) return null;
  return signal.side === "long"
    ? (resolution.entryPrice - signal.theoreticalSignalPrice) / signal.theoreticalSignalPrice * 100
    : (signal.theoreticalSignalPrice - resolution.entryPrice) / signal.theoreticalSignalPrice * 100;
}

export function buildMonitoringComparisonForDateData(input: {
  tradeDate: string;
  sourceEvents: RtSourceEvent[];
  decisionEvents: RtRealtimeDecisionEvent[];
  candidates: RtSignalCandidate[];
  shadowEvents: RtForwardShadowEvent[];
}) {
  const sourceById = new Map(input.sourceEvents.map(item => [item.sourceEventId, item]));
  const decisionBySourceId = new Map(input.decisionEvents.map(item => [item.sourceEventId, item]));
  const comparisonEventBySequence = new Map<number, MonitoringComparisonSourceEvent>();
  for (const decision of input.decisionEvents) {
    const source = sourceById.get(decision.sourceEventId);
    const normalized = source ? toComparisonSourceEvent(source, decision) : null;
    if (normalized) comparisonEventBySequence.set(decision.id, normalized);
  }
  const decisions = input.decisionEvents.slice().sort((a, b) => a.id - b.id);
  const signals = [
    ...currentSignals(input.candidates, decisionBySourceId, sourceById),
    ...shadowSignals(input.shadowEvents, decisionBySourceId, sourceById),
  ].sort((a, b) => a.signalEngineSequence - b.signalEngineSequence
    || a.strategyVersion.localeCompare(b.strategyVersion)
    || a.routeId?.localeCompare(b.routeId ?? "") || 0);

  const entries: MonitoringComparisonMaterializedEntry[] = signals.map(signal => {
    const nextDecision = decisions.find(item => item.id > signal.signalEngineSequence && item.symbol === signal.symbol);
    const nextEvent = nextDecision ? comparisonEventBySequence.get(nextDecision.id) : null;
    const resolution: MaterializedResolution = nextDecision && nextEvent
      ? resolveMonitoringComparisonEntry(signal, nextEvent)
      : {
          status: "unfillable",
          reason: nextDecision ? "signal_source_event_missing" : "no_later_same_symbol_source_event",
          entrySourceEventId: null,
          entryEngineSequence: null,
          boardAgeMs: null,
        };
    const attribution = classifyMonitoringAttribution(signal.routeId);
    return {
      origin: signal.origin,
      comparisonGeneration: signal.comparisonGeneration,
      strategyVersion: signal.strategyVersion,
      evaluationMode: signal.evaluationMode,
      sourceDisposition: signal.sourceDisposition,
      signalSourceEventId: signal.signalSourceEventId,
      signalEngineSequence: signal.signalEngineSequence,
      tradeDate: signal.signalTradeDate,
      signalTime: signal.signalTime,
      symbol: signal.symbol,
      routeId: attribution.routeId,
      attributionStatus: attribution.attributionStatus,
      includeInOverallPnl: attribution.includeInOverallPnl,
      includeInRouteComparison: attribution.includeInRouteComparison,
      side: signal.side,
      theoreticalSignalPrice: signal.theoreticalSignalPrice,
      resolution,
      adverseEntryGapPct: adverseEntryGapPct(signal, resolution),
    };
  });

  const filled = entries.filter(item => item.resolution.status === "filled");
  const unfillable = entries.filter(item => item.resolution.status === "unfillable");
  const byStrategy = Object.fromEntries(Array.from(new Set(entries.map(item => item.strategyVersion))).sort().map(version => {
    const rows = entries.filter(item => item.strategyVersion === version);
    return [version, {
      signals: rows.length,
      filled: rows.filter(item => item.resolution.status === "filled").length,
      unfillable: rows.filter(item => item.resolution.status === "unfillable").length,
    }];
  }));
  return {
    component: MONITORING_COMPARISON_COMPONENT,
    materializationVersion: MONITORING_COMPARISON_MATERIALIZATION_VERSION,
    comparisonGeneration: MONITORING_COMPARISON_CONTRACT.comparisonGeneration,
    tradeDate: input.tradeDate,
    scope: {
      symbols: ["285A"],
      evaluationMode: "signal_quality",
      entryContract: MONITORING_COMPARISON_CONTRACT,
      existingCurrentAndShadowExecutionChanged: false,
      pnlComparisonStatus: "not_started_until_entry_contract_is_accepted",
    },
    summary: {
      signals: entries.length,
      filled: filled.length,
      unfillable: unfillable.length,
      fillRatePct: entries.length ? filled.length / entries.length * 100 : 0,
      byStrategy,
    },
    entries,
  };
}

export async function materializeMonitoringComparisonForDate(tradeDate: string) {
  const candidateVersion = resolveCurrentSignalCandidateVersion(tradeDate);
  const [sourceEvents, decisionEvents, candidates, shadowEvents] = await Promise.all([
    getRtSourceEventsForDate(tradeDate),
    getRtRealtimeDecisionEventsForDate(tradeDate),
    getRtSignalCandidatesForDate({ candidateVersion, tradeDate }),
    getRtForwardShadowEventsForDate(tradeDate),
  ]);
  return buildMonitoringComparisonForDateData({
    tradeDate,
    sourceEvents,
    decisionEvents,
    candidates,
    shadowEvents,
  });
}
