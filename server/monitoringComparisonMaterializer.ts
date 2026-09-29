import type {
  RtForwardShadowEvent,
  RtForwardShadowTrade,
  RtRealtimeDecisionEvent,
  RtSignalCandidate,
  RtSignalCandidateTrade,
  RtSourceEvent,
  RtTrade,
} from "../drizzle/schema";
import {
  getRtForwardShadowEventsForDate,
  getRtForwardShadowTradesForEntryDate,
  getRtRealtimeDecisionEventsForDate,
  getRtSignalCandidateTradesForDate,
  getRtSignalCandidatesForDate,
  getRtSourceEventsForDate,
  getRtTradesForDate,
} from "./db";
import {
  CURRENT_SIGNAL_VIRTUAL_ENGINE_VERSION,
  resolveCurrentSignalCandidateVersion,
} from "./currentSignalCandidateRegistry";
import { parseBoardObservedAtMs } from "./realtimeDecisionAudit";
import {
  KIOXIA_ATR_FORWARD_STRATEGY_VERSION,
  KIOXIA_FORWARD_STRATEGY_VERSION,
} from "./runtimeIdentity";
import {
  MONITORING_COMPARISON_CONTRACT,
  classifyMonitoringAttribution,
  resolveMonitoringComparisonEntry,
  resolveMonitoringComparisonExit,
  type MonitoringComparisonEntryResolution,
  type MonitoringComparisonExitResolution,
  type MonitoringComparisonSignal,
  type MonitoringComparisonSourceEvent,
} from "./monitoringComparisonContract";
import { collectRouteAttributionMappingVersions } from "./kioxiaRouteAttribution";

/**
 * 閉場後だけに保存する285Aの比較・正規化snapshot。
 * 現行DRY_RUN、通常rt_trades、shadow state、source ingestionには書き込まない。
 */
export const MONITORING_COMPARISON_COMPONENT = "monitoring_comparison_285a";
export const MONITORING_COMPARISON_MATERIALIZATION_VERSION =
  "monitoring-comparison-285a-route-normalized-v4";

export type MonitoringComparisonOrigin = "current_baseline" | "forward_shadow";
export type MonitoringComparisonDisposition =
  | "accepted"
  | "margin_block"
  | "shadow_only"
  | "entry"
  | "rejected";

type IntrinsicOutcome = {
  status: "completed" | "open" | "not_applicable" | "not_linked";
  priceSource: "rt_trades" | "candidate_virtual" | "forward_shadow" | null;
  entryPrice: number | null;
  exitPrice: number | null;
  pnlPer100: number | null;
  completed: boolean;
  exitReason: string | null;
  entrySourceEventId: string | null;
  exitSourceEventId: string | null;
};

type NormalizedOutcome = {
  status: "filled" | "unfillable_entry" | "unfillable_exit" | "open" | "not_applicable";
  entry: MonitoringComparisonEntryResolution | null;
  exit: MonitoringComparisonExitResolution | null;
  pnlPer100: number | null;
};

export interface MonitoringComparisonMaterializedEntry {
  origin: MonitoringComparisonOrigin;
  comparisonGeneration: string;
  strategyVersion: string;
  evaluationMode: "signal_quality";
  sourceDisposition: MonitoringComparisonDisposition;
  rejectionStage: "none" | "entry_condition_rejected" | "route_ended" | null;
  rejectionReason: string | null;
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
  entryIntentSourceEventId: string | null;
  exitIntentSourceEventId: string | null;
  intrinsic: IntrinsicOutcome;
  normalized: NormalizedOutcome;
  entryQuality: Record<string, unknown>;
}

type CandidateSignal = MonitoringComparisonSignal & {
  origin: MonitoringComparisonOrigin;
  sourceDisposition: MonitoringComparisonDisposition;
  rejectionStage: MonitoringComparisonMaterializedEntry["rejectionStage"];
  rejectionReason: string | null;
  intrinsic: IntrinsicOutcome;
  entryIntentSourceEventId: string | null;
  exitIntentSourceEventId: string | null;
};

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
  const board = record(sourcePayload(source).board);
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
    candle: { symbol, tradeDate, candleTime, open: open!, high: high!, low: low!, close: close!, volume: volume! },
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

function kioxiaRouteSide(route: string | null): "long" | "short" | null {
  switch (route) {
    case "confirmed_morning_long":
    case "reversal_long":
      return "long";
    case "reversal_short":
    case "trend_short":
    case "safe_cb_short":
      return "short";
    default:
      return null;
  }
}

function per100(pnl: unknown, shares: unknown): number | null {
  const value = finite(pnl);
  const quantity = finite(shares);
  return value === null || quantity === null || quantity <= 0 ? null : Math.round(value / quantity * 100);
}

function currentActualOutcome(
  candidate: RtSignalCandidate,
  virtual: RtSignalCandidateTrade | undefined,
  trades: RtTrade[],
  sourceById: Map<string, RtSourceEvent>,
): IntrinsicOutcome {
  if (candidate.realtimeDecision === "shadow_only") {
    return { status: "not_applicable", priceSource: null, entryPrice: null, exitPrice: null, pnlPer100: null, completed: false, exitReason: null, entrySourceEventId: null, exitSourceEventId: null };
  }
  if (candidate.realtimeDecision === "accepted") {
    const action = candidate.side === "long" ? "buy" : "short";
    const entry = trades.find(trade => trade.symbol === candidate.symbol && trade.side === candidate.side
      && trade.action === action && trade.tradeTime === candidate.candleTime) ?? null;
    if (!entry) {
      return { status: "not_linked", priceSource: null, entryPrice: null, exitPrice: null, pnlPer100: null, completed: false, exitReason: null, entrySourceEventId: null, exitSourceEventId: null };
    }
    const exitAction = candidate.side === "long" ? "sell" : "cover";
    // acceptedはrt_tradesが唯一の実取引結果であり、candidate 100株virtualの
    // 独立したexit（同じsignalでも時刻が異なり得る）で置き換えない。現行は
    // 同一銘柄・sideを同時に複数保有しないため、entry後の最初の決済が対応するexit。
    const exit = trades.find(trade => trade.symbol === candidate.symbol
      && trade.side === candidate.side
      && trade.action === exitAction
      && trade.tradeTime > entry.tradeTime) ?? null;
    const completed = Boolean(exit && exit.pnl !== null);
    const exitSourceEventId = exit
      ? Array.from(sourceById.values()).find(source => source.symbol === candidate.symbol && source.candleTime === exit.tradeTime)?.sourceEventId ?? null
      : null;
    return {
      status: completed ? "completed" : "open",
      priceSource: "rt_trades",
      entryPrice: Number(entry.price),
      exitPrice: exit ? Number(exit.price) : null,
      pnlPer100: completed ? per100(exit?.pnl, entry.shares) : null,
      completed,
      exitReason: exit?.reason ?? null,
      entrySourceEventId: candidate.sourceEventId,
      exitSourceEventId,
    };
  }
  if (!virtual) {
    return { status: "not_linked", priceSource: null, entryPrice: null, exitPrice: null, pnlPer100: null, completed: false, exitReason: null, entrySourceEventId: null, exitSourceEventId: null };
  }
  const completed = virtual.completed && virtual.pnl !== null && virtual.exitPrice !== null;
  return {
    status: completed ? "completed" : "open",
    priceSource: "candidate_virtual",
    entryPrice: Number(virtual.entryPrice),
    exitPrice: virtual.exitPrice === null ? null : Number(virtual.exitPrice),
    pnlPer100: completed ? per100(virtual.pnl, virtual.shares) : null,
    completed,
    exitReason: virtual.exitReason ?? null,
    entrySourceEventId: virtual.entrySourceEventId,
    exitSourceEventId: virtual.exitSourceEventId ?? null,
  };
}

function forwardOutcome(trade: RtForwardShadowTrade | undefined): IntrinsicOutcome {
  if (!trade) return { status: "not_linked", priceSource: null, entryPrice: null, exitPrice: null, pnlPer100: null, completed: false, exitReason: null, entrySourceEventId: null, exitSourceEventId: null };
  const completed = trade.pnl !== null && trade.exitPrice !== null && trade.exitSourceEventId !== null;
  return {
    status: completed ? "completed" : "open",
    priceSource: "forward_shadow",
    entryPrice: Number(trade.entryPrice),
    exitPrice: trade.exitPrice === null ? null : Number(trade.exitPrice),
    pnlPer100: completed ? per100(trade.pnl, trade.shares) : null,
    completed,
    exitReason: trade.exitReason ?? null,
    entrySourceEventId: trade.entrySourceEventId,
    exitSourceEventId: trade.exitSourceEventId,
  };
}

function currentSignals(input: {
  candidates: RtSignalCandidate[];
  candidateTrades: RtSignalCandidateTrade[];
  trades: RtTrade[];
  decisionBySourceId: Map<string, RtRealtimeDecisionEvent>;
  sourceById: Map<string, RtSourceEvent>;
}): CandidateSignal[] {
  const candidateTradeById = new Map(input.candidateTrades.map(trade => [trade.candidateId, trade]));
  const result: CandidateSignal[] = [];
  for (const candidate of input.candidates.filter(item => item.symbol === "285A")) {
    const decision = input.decisionBySourceId.get(candidate.sourceEventId);
    const source = input.sourceById.get(candidate.sourceEventId);
    if (!decision || !source) continue;
    const virtual = candidateTradeById.get(candidate.id);
    const intrinsic = currentActualOutcome(candidate, virtual, input.trades, input.sourceById);
    result.push({
      origin: "current_baseline",
      sourceDisposition: candidate.realtimeDecision === "accepted" ? "accepted" : candidate.realtimeDecision === "margin_block" ? "margin_block" : "shadow_only",
      rejectionStage: "none",
      rejectionReason: null,
      comparisonGeneration: MONITORING_COMPARISON_CONTRACT.comparisonGeneration,
      strategyVersion: `baseline:${candidate.candidateVersion}`,
      routeId: candidate.routeId,
      symbol: candidate.symbol,
      side: candidate.side,
      signalSourceEventId: candidate.sourceEventId,
      // 次eventの選択はrt_realtime_decision_events.id（全体の確定処理順）で統一する。
      // candidate側のengineSequenceは監査上保存するが、異世代のID体系と混在させない。
      signalEngineSequence: decision.id,
      signalTradeDate: candidate.tradeDate,
      signalTime: candidate.candleTime,
      theoreticalSignalPrice: Number(candidate.theoreticalEntryPrice),
      signalDecisionCompletedAtMs: decision.decisionCompletedAtMs,
      signalBoardObservedAtMs: boardObservedAtMs(source, decision),
      intrinsic,
      entryIntentSourceEventId: candidate.sourceEventId,
      exitIntentSourceEventId: intrinsic.exitSourceEventId,
    });
  }
  return result;
}

function shadowSignals(input: {
  events: RtForwardShadowEvent[];
  trades: RtForwardShadowTrade[];
  decisionBySourceId: Map<string, RtRealtimeDecisionEvent>;
  sourceById: Map<string, RtSourceEvent>;
}): CandidateSignal[] {
  const supported = new Set([KIOXIA_FORWARD_STRATEGY_VERSION, KIOXIA_ATR_FORWARD_STRATEGY_VERSION]);
  const tradeByEntry = new Map(input.trades.filter(trade => trade.evaluationMode === "signal_quality")
    .map(trade => [`${trade.strategyVersion}:${trade.entrySourceEventId}`, trade]));
  const result: CandidateSignal[] = [];
  for (const event of input.events) {
    if (event.symbol !== "285A" || event.evaluationMode !== "signal_quality" || !supported.has(event.strategyVersion)) continue;
    const decision = input.decisionBySourceId.get(event.sourceEventId);
    const source = input.sourceById.get(event.sourceEventId);
    if (!decision || !source) continue;
    const actions = actionList(event);
    const relevant = actions.filter(action => ["entry", "entry_rejected", "route_ended"].includes(String(action.type)));
    for (const action of relevant) {
      const entry = action.type === "entry";
      const route = typeof action.route === "string"
        ? action.route
        : event.strategyVersion === KIOXIA_FORWARD_STRATEGY_VERSION ? "confirmed_morning_long" : null;
      // entry_rejected/route_endedはpositionをまだ持たずsideを省略する既存payloadがある。
      // route仕様から補完して、拒否記録を候補母集団から落とさない。
      const side = actionSide(action.side) ?? kioxiaRouteSide(route);
      const theoreticalSignalPrice = finite(action.theoreticalSignalPrice)
        ?? finite(sourcePayload(source).close);
      if (!side || !route || theoreticalSignalPrice === null) continue;
      const trade = entry ? tradeByEntry.get(`${event.strategyVersion}:${event.sourceEventId}`) : undefined;
      const intrinsic = entry ? forwardOutcome(trade) : {
        status: "not_applicable" as const,
        priceSource: null,
        entryPrice: null,
        exitPrice: null,
        pnlPer100: null,
        completed: false,
        exitReason: null,
        entrySourceEventId: null,
        exitSourceEventId: null,
      };
      result.push({
        origin: "forward_shadow",
        sourceDisposition: entry ? "entry" : "rejected",
        rejectionStage: entry ? "none" : action.type === "route_ended" ? "route_ended" : "entry_condition_rejected",
        rejectionReason: entry ? null : typeof action.reason === "string" ? action.reason : "unspecified_rejection",
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
        intrinsic,
        entryIntentSourceEventId: entry ? event.sourceEventId : null,
        exitIntentSourceEventId: intrinsic.exitSourceEventId,
      });
    }
  }
  return result;
}

function nextSameSymbolDecision(
  decisions: RtRealtimeDecisionEvent[],
  sequence: number,
  symbol: string,
): RtRealtimeDecisionEvent | null {
  return decisions.find(item => item.id > sequence && item.symbol === symbol) ?? null;
}

function entryQuality(input: {
  entry: MonitoringComparisonEntryResolution | null;
  signal: CandidateSignal;
  decisions: RtRealtimeDecisionEvent[];
  eventsBySequence: Map<number, MonitoringComparisonSourceEvent>;
}): Record<string, unknown> {
  if (input.entry?.status !== "filled") return { status: "not_available_without_filled_entry", labels: {} };
  const entrySequence = input.entry.entryEngineSequence;
  const entryPrice = input.entry.entryPrice;
  const labels: Record<string, unknown> = {};
  for (const minutes of [1, 3, 5, 10, 15, 30, 45]) {
    const future = input.decisions.filter(decision => decision.id > entrySequence && decision.symbol === input.signal.symbol)
      .map(decision => input.eventsBySequence.get(decision.id))
      .filter((event): event is MonitoringComparisonSourceEvent => Boolean(event));
    const entryMinutes = Number(input.entry.entryTime.slice(0, 2)) * 60 + Number(input.entry.entryTime.slice(3));
    const eligible = future.filter(event => {
      const eventMinutes = Number(event.candle.candleTime.slice(0, 2)) * 60 + Number(event.candle.candleTime.slice(3));
      return eventMinutes >= entryMinutes + minutes;
    });
    const endpoint = eligible[0] ?? null;
    if (!endpoint) {
      labels[String(minutes)] = { status: "unavailable_before_session_end", availableAtMs: null };
      continue;
    }
    const path = future.filter(event => {
      const eventMinutes = Number(event.candle.candleTime.slice(0, 2)) * 60 + Number(event.candle.candleTime.slice(3));
      const endpointMinutes = Number(endpoint.candle.candleTime.slice(0, 2)) * 60 + Number(endpoint.candle.candleTime.slice(3));
      return eventMinutes <= endpointMinutes;
    });
    const high = Math.max(...path.map(event => event.candle.high));
    const low = Math.min(...path.map(event => event.candle.low));
    const multiplier = input.signal.side === "long" ? 1 : -1;
    labels[String(minutes)] = {
      status: "available",
      endpointSourceEventId: endpoint.sourceEventId,
      endpointTime: endpoint.candle.candleTime,
      availableAtMs: endpoint.currentAudit.decisionCompletedAtMs,
      fixedReturnPct: (endpoint.candle.close - entryPrice) / entryPrice * 100 * multiplier,
      mfePct: (input.signal.side === "long" ? high - entryPrice : entryPrice - low) / entryPrice * 100,
      maePct: (input.signal.side === "long" ? low - entryPrice : entryPrice - high) / entryPrice * 100,
    };
  }
  return { status: "diagnostic_only_not_strategy_outcome", labels };
}

function normalizedOutcome(input: {
  signal: CandidateSignal;
  decisions: RtRealtimeDecisionEvent[];
  eventsBySequence: Map<number, MonitoringComparisonSourceEvent>;
  decisionBySourceId: Map<string, RtRealtimeDecisionEvent>;
}): NormalizedOutcome {
  if (input.signal.sourceDisposition === "rejected" || input.signal.sourceDisposition === "shadow_only") {
    return { status: "not_applicable", entry: null, exit: null, pnlPer100: null };
  }
  const nextEntryDecision = nextSameSymbolDecision(input.decisions, input.signal.signalEngineSequence, input.signal.symbol);
  const nextEntryEvent = nextEntryDecision ? input.eventsBySequence.get(nextEntryDecision.id) : null;
  const entry = nextEntryDecision && nextEntryEvent
    ? resolveMonitoringComparisonEntry(input.signal, nextEntryEvent)
    : {
        status: "unfillable" as const,
        reason: nextEntryDecision ? "signal_source_event_missing" as const : "no_later_same_symbol_source_event" as const,
        entrySourceEventId: null,
        entryEngineSequence: null,
        boardAgeMs: null,
      };
  if (entry.status !== "filled") return { status: "unfillable_entry", entry, exit: null, pnlPer100: null };
  if (!input.signal.intrinsic.completed || !input.signal.exitIntentSourceEventId) {
    return { status: "open", entry, exit: null, pnlPer100: null };
  }
  const exitDecision = input.decisionBySourceId.get(input.signal.exitIntentSourceEventId);
  if (!exitDecision) {
    return { status: "unfillable_exit", entry, exit: { status: "unfillable", reason: "exit_intent_source_missing", exitSourceEventId: null, exitEngineSequence: null, boardAgeMs: null }, pnlPer100: null };
  }
  const exitSource = input.eventsBySequence.get(exitDecision.id);
  if (!exitSource) {
    return { status: "unfillable_exit", entry, exit: { status: "unfillable", reason: "exit_intent_source_missing", exitSourceEventId: null, exitEngineSequence: null, boardAgeMs: null }, pnlPer100: null };
  }
  const exitIntent: MonitoringComparisonSignal = {
    ...input.signal,
    signalSourceEventId: exitSource.sourceEventId,
    signalEngineSequence: exitDecision.id,
    signalTradeDate: exitSource.candle.tradeDate,
    signalTime: exitSource.candle.candleTime,
    theoreticalSignalPrice: exitSource.candle.close,
    signalDecisionCompletedAtMs: exitDecision.decisionCompletedAtMs,
    signalBoardObservedAtMs: exitSource.currentAudit.boardObservedAtMs,
  };
  const nextExitDecision = nextSameSymbolDecision(input.decisions, exitDecision.id, input.signal.symbol);
  const nextExitEvent = nextExitDecision ? input.eventsBySequence.get(nextExitDecision.id) : null;
  const exit = nextExitDecision && nextExitEvent
    ? resolveMonitoringComparisonExit(exitIntent, input.signal.side, nextExitEvent)
    : { status: "unfillable" as const, reason: "no_later_same_symbol_source_event" as const, exitSourceEventId: null, exitEngineSequence: null, boardAgeMs: null };
  if (exit.status !== "filled") return { status: "unfillable_exit", entry, exit, pnlPer100: null };
  const pnlPer100 = Math.round((input.signal.side === "long" ? exit.exitPrice - entry.entryPrice : entry.entryPrice - exit.exitPrice) * 100);
  return { status: "filled", entry, exit, pnlPer100 };
}

export function buildMonitoringComparisonForDateData(input: {
  tradeDate: string;
  sourceEvents: RtSourceEvent[];
  decisionEvents: RtRealtimeDecisionEvent[];
  candidates: RtSignalCandidate[];
  candidateTrades?: RtSignalCandidateTrade[];
  normalTrades?: RtTrade[];
  shadowEvents: RtForwardShadowEvent[];
  shadowTrades?: RtForwardShadowTrade[];
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
    ...currentSignals({
      candidates: input.candidates,
      candidateTrades: input.candidateTrades ?? [],
      trades: input.normalTrades ?? [],
      decisionBySourceId,
      sourceById,
    }),
    ...shadowSignals({
      events: input.shadowEvents,
      trades: input.shadowTrades ?? [],
      decisionBySourceId,
      sourceById,
    }),
  ].sort((a, b) => a.signalEngineSequence - b.signalEngineSequence
    || a.strategyVersion.localeCompare(b.strategyVersion)
    || (a.routeId ?? "").localeCompare(b.routeId ?? ""));

  const entries: MonitoringComparisonMaterializedEntry[] = signals.map(signal => {
    const attribution = classifyMonitoringAttribution(signal.routeId);
    const normalized = normalizedOutcome({ signal, decisions, eventsBySequence: comparisonEventBySequence, decisionBySourceId });
    return {
      origin: signal.origin,
      comparisonGeneration: signal.comparisonGeneration,
      strategyVersion: signal.strategyVersion,
      evaluationMode: "signal_quality",
      sourceDisposition: signal.sourceDisposition,
      rejectionStage: signal.rejectionStage,
      rejectionReason: signal.rejectionReason,
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
      entryIntentSourceEventId: signal.entryIntentSourceEventId,
      exitIntentSourceEventId: signal.exitIntentSourceEventId,
      intrinsic: signal.intrinsic,
      normalized,
      entryQuality: entryQuality({ entry: normalized.entry, signal, decisions, eventsBySequence: comparisonEventBySequence }),
    };
  });

  const byRoute = Object.fromEntries(Array.from(new Set(entries.map(entry => `${entry.strategyVersion}:${entry.routeId}`))).sort().map(key => {
    const rows = entries.filter(entry => `${entry.strategyVersion}:${entry.routeId}` === key);
    return [key, {
      strategyVersion: rows[0]?.strategyVersion ?? null,
      routeId: rows[0]?.routeId ?? null,
      sourceDispositions: Object.fromEntries(["accepted", "margin_block", "shadow_only", "entry", "rejected"].map(status => [status, rows.filter(row => row.sourceDisposition === status).length])),
      intrinsicCompleted: rows.filter(row => row.intrinsic.completed).length,
      normalizedFilled: rows.filter(row => row.normalized.status === "filled").length,
      normalizedUnfillable: rows.filter(row => row.normalized.status === "unfillable_entry" || row.normalized.status === "unfillable_exit").length,
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
      entryAndExitContract: {
        ...MONITORING_COMPARISON_CONTRACT,
        exitEventSelection: "strict_next_same_symbol_source_event_after_exit_intent",
        exitLongPriceSource: "bid_depth_vwap_100",
        exitShortPriceSource: "ask_depth_vwap_100",
      },
      tables: {
        intrinsic: "saved_implementation_outcomes_only",
        normalized: "strict_next_depth_entry_and_exit_preserving_saved_exit_intent",
        entryQuality: "future_labels_diagnostic_only_not_strategy_ranking",
      },
      existingCurrentAndShadowExecutionChanged: false,
      automaticSelection: false,
      routeAttributionMappingVersions: collectRouteAttributionMappingVersions(input.candidates),
    },
    summary: {
      candidateOrEntryRows: entries.length,
      byRoute,
      rejected: entries.filter(entry => entry.sourceDisposition === "rejected").length,
      accepted: entries.filter(entry => entry.sourceDisposition === "accepted").length,
      marginBlocked: entries.filter(entry => entry.sourceDisposition === "margin_block").length,
      shadowOnly: entries.filter(entry => entry.sourceDisposition === "shadow_only").length,
      normalizedFilled: entries.filter(entry => entry.normalized.status === "filled").length,
      normalizedUnfillable: entries.filter(entry => entry.normalized.status === "unfillable_entry" || entry.normalized.status === "unfillable_exit").length,
    },
    entries,
  };
}

export async function materializeMonitoringComparisonForDate(tradeDate: string) {
  const candidateVersion = resolveCurrentSignalCandidateVersion(tradeDate);
  const [sourceEvents, decisionEvents, candidates, candidateTrades, normalTrades, shadowEvents, shadowTrades] = await Promise.all([
    getRtSourceEventsForDate(tradeDate),
    getRtRealtimeDecisionEventsForDate(tradeDate),
    getRtSignalCandidatesForDate({ candidateVersion, tradeDate }),
    getRtSignalCandidateTradesForDate({ virtualEngineVersion: CURRENT_SIGNAL_VIRTUAL_ENGINE_VERSION, tradeDate }),
    getRtTradesForDate(tradeDate),
    getRtForwardShadowEventsForDate(tradeDate),
    getRtForwardShadowTradesForEntryDate(tradeDate),
  ]);
  return buildMonitoringComparisonForDateData({
    tradeDate,
    sourceEvents,
    decisionEvents,
    candidates,
    candidateTrades,
    normalTrades,
    shadowEvents,
    shadowTrades,
  });
}
