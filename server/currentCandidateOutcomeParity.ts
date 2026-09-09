import type {
  RtRealtimeDecisionEvent,
  RtSignalCandidate,
  RtSignalCandidateTrade,
} from "../drizzle/schema";
import {
  getRtRealtimeDecisionEventsForDate,
  getRtSignalCandidatesForDate,
  getRtSignalCandidateTradesForDate,
} from "./db";
import {
  CURRENT_SIGNAL_CANDIDATE_VERSION,
  CURRENT_SIGNAL_VIRTUAL_ENGINE_VERSION,
} from "./currentSignalCandidateRegistry";

export const CURRENT_CANDIDATE_OUTCOME_PARITY_COMPONENT = "current_candidate_outcome_parity";
export const CURRENT_CANDIDATE_OUTCOME_PARITY_VERSION = "current-vs-signal-quality-outcome-v1";

type Outcome = "win" | "loss" | "flat";
type ExitCategory =
  | "stop_loss"
  | "take_profit"
  | "profit_protection"
  | "signal_reversal"
  | "max_holding"
  | "session_exit"
  | "market_close"
  | "other";

export type CurrentCandidateOutcomeParityDetail = {
  candidateId: number;
  engineSequence: number;
  sourceEventId: string;
  symbol: string;
  routeId: string;
  side: "long" | "short";
  status: "match" | "mismatch" | "incomplete";
  missing: string[];
  mismatchFields: string[];
  actual: {
    entryDecisionId: number | null;
    entryCandleTime: string | null;
    routeId: string | null;
    side: "long" | "short" | null;
    entryPrice: number | null;
    exitDecisionId: number | null;
    exitSourceEventId: string | null;
    exitCandleTime: string | null;
    exitPrice: number | null;
    exitReason: string | null;
    exitCategory: ExitCategory | null;
    shares: number | null;
    pnl: number | null;
    pnlPer100: number | null;
    outcome: Outcome | null;
  };
  virtual: {
    tradeId: number | null;
    routeId: string | null;
    side: "long" | "short" | null;
    entryPrice: number | null;
    completed: boolean;
    exitSourceEventId: string | null;
    exitCandleTime: string | null;
    exitPrice: number | null;
    exitReason: string | null;
    exitReasonCode: string | null;
    exitCategory: ExitCategory | null;
    shares: number | null;
    pnl: number | null;
    pnlPer100: number | null;
    outcome: Outcome | null;
  };
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function eventAction(event: RtRealtimeDecisionEvent): string {
  return String(record(record(event.resultJson).result).action ?? "none");
}

function isEntry(event: RtRealtimeDecisionEvent): boolean {
  return event.resultType === "entry" || eventAction(event) === "entry";
}

function isExit(event: RtRealtimeDecisionEvent): boolean {
  return event.resultType === "exit"
    || ["exit", "stop_loss", "take_profit", "forced_close"].includes(eventAction(event));
}

function outcome(pnl: number | null): Outcome | null {
  if (pnl === null) return null;
  if (pnl > 0) return "win";
  if (pnl < 0) return "loss";
  return "flat";
}

function normalizePer100(pnl: number | null, shares: number | null): number | null {
  if (pnl === null || shares === null || shares <= 0) return null;
  return Math.round(pnl / shares * 100 * 1_000_000) / 1_000_000;
}

function exitCategory(reason: string | null, code: string | null): ExitCategory {
  const value = `${code ?? ""} ${reason ?? ""}`.toLowerCase();
  if (/profit[_ ]?protection|利益保護/.test(value)) return "profit_protection";
  if (/stop[_ ]?loss|損切/.test(value)) return "stop_loss";
  if (/take[_ ]?profit|利確/.test(value)) return "take_profit";
  if (/signal[_ ]?reversal|シグナル反転/.test(value)) return "signal_reversal";
  if (/max[_ ]?holding|最大保有/.test(value)) return "max_holding";
  if (/session[_ ]?exit|前場強制|前場終了/.test(value)) return "session_exit";
  if (/market[_ ]?close|大引け|強制決済/.test(value)) return "market_close";
  return "other";
}

function actualTrade(event: RtRealtimeDecisionEvent) {
  return record(record(event.resultJson).trade);
}

function actualPnl(event: RtRealtimeDecisionEvent): number | null {
  const result = record(record(event.resultJson).result);
  const trade = actualTrade(event);
  return finite(result.pnl) ?? finite(trade.pnl);
}

function actualReason(event: RtRealtimeDecisionEvent): string | null {
  const trade = actualTrade(event);
  const value = trade.reason ?? event.reason;
  return typeof value === "string" ? value : null;
}

function actualPrice(event: RtRealtimeDecisionEvent): number | null {
  return finite(event.simulatedBarFillPrice) ?? finite(actualTrade(event).price);
}

function actualShares(entry: RtRealtimeDecisionEvent, exit: RtRealtimeDecisionEvent): number | null {
  return finite(exit.shares)
    ?? finite(actualTrade(exit).shares)
    ?? finite(entry.shares)
    ?? finite(actualTrade(entry).shares);
}

function valuesDiffer(actual: number | null, virtual: number | null, tolerance: number): boolean {
  if (actual === null || virtual === null) return actual !== virtual;
  return Math.abs(actual - virtual) > tolerance;
}

function compareCandidate(input: {
  candidate: RtSignalCandidate;
  virtual: RtSignalCandidateTrade | null;
  decisions: RtRealtimeDecisionEvent[];
}): CurrentCandidateOutcomeParityDetail {
  const entry = input.decisions.find(event => event.sourceEventId === input.candidate.sourceEventId && isEntry(event)) ?? null;
  const nextEntryId = entry === null ? null : input.decisions.find(event =>
    event.id > entry.id && event.symbol === input.candidate.symbol && isEntry(event),
  )?.id ?? null;
  const exit = entry === null ? null : input.decisions.find(event =>
    event.id > entry.id
      && event.symbol === input.candidate.symbol
      && (nextEntryId === null || event.id < nextEntryId)
      && isExit(event),
  ) ?? null;
  const missing: string[] = [];
  if (!entry) missing.push("actual_entry");
  if (entry && !exit) missing.push("actual_exit");
  if (!input.virtual) missing.push("virtual_trade");
  if (input.virtual && !input.virtual.completed) missing.push("virtual_exit");

  const actualPnlValue = exit ? actualPnl(exit) : null;
  const actualSharesValue = entry && exit ? actualShares(entry, exit) : null;
  const actualPnlPer100 = normalizePer100(actualPnlValue, actualSharesValue);
  const actualReasonValue = exit ? actualReason(exit) : null;
  const actualAction = exit ? eventAction(exit) : null;
  const virtualPnl = input.virtual?.pnl === null || input.virtual?.pnl === undefined
    ? null
    : finite(input.virtual.pnl);
  const virtualShares = input.virtual ? finite(input.virtual.shares) : null;
  const virtualPnlPer100 = normalizePer100(virtualPnl, virtualShares);
  const virtualReason = input.virtual?.exitReason ?? null;
  const virtualReasonCode = input.virtual?.exitReasonCode ?? null;
  const actualCategory = exit ? exitCategory(actualReasonValue, actualAction) : null;
  const virtualCategory = input.virtual?.completed ? exitCategory(virtualReason, virtualReasonCode) : null;

  const mismatchFields: string[] = [];
  if (missing.length === 0) {
    if (entry!.routeId !== input.virtual!.routeId) mismatchFields.push("entryRouteId");
    if (entry!.side !== input.virtual!.side) mismatchFields.push("entrySide");
    if (valuesDiffer(actualPrice(entry!), finite(input.virtual!.entryPrice), 0.0001)) mismatchFields.push("entryPrice");
    if (outcome(actualPnlPer100) !== outcome(virtualPnlPer100)) mismatchFields.push("outcome");
    if (exit!.sourceEventId !== input.virtual!.exitSourceEventId) mismatchFields.push("exitSourceEventId");
    if (exit!.candleTime !== input.virtual!.exitCandleTime) mismatchFields.push("exitCandleTime");
    if (valuesDiffer(actualPrice(exit!), finite(input.virtual!.exitPrice), 0.0001)) mismatchFields.push("exitPrice");
    if (actualCategory !== virtualCategory) mismatchFields.push("exitCategory");
    // rt_tradesは整数円、100株仮想台帳も整数円のため、可変株数からの換算誤差1円だけ許容する。
    if (valuesDiffer(actualPnlPer100, virtualPnlPer100, 1)) mismatchFields.push("pnlPer100");
  }

  return {
    candidateId: input.candidate.id,
    engineSequence: input.candidate.engineSequence,
    sourceEventId: input.candidate.sourceEventId,
    symbol: input.candidate.symbol,
    routeId: input.candidate.routeId,
    side: input.candidate.side,
    status: missing.length > 0 ? "incomplete" : mismatchFields.length > 0 ? "mismatch" : "match",
    missing,
    mismatchFields,
    actual: {
      entryDecisionId: entry?.id ?? null,
      entryCandleTime: entry?.candleTime ?? null,
      routeId: entry?.routeId ?? null,
      side: entry?.side ?? null,
      entryPrice: entry ? actualPrice(entry) : null,
      exitDecisionId: exit?.id ?? null,
      exitSourceEventId: exit?.sourceEventId ?? null,
      exitCandleTime: exit?.candleTime ?? null,
      exitPrice: exit ? actualPrice(exit) : null,
      exitReason: actualReasonValue,
      exitCategory: actualCategory,
      shares: actualSharesValue,
      pnl: actualPnlValue,
      pnlPer100: actualPnlPer100,
      outcome: outcome(actualPnlPer100),
    },
    virtual: {
      tradeId: input.virtual?.id ?? null,
      routeId: input.virtual?.routeId ?? null,
      side: input.virtual?.side ?? null,
      entryPrice: finite(input.virtual?.entryPrice),
      completed: input.virtual?.completed ?? false,
      exitSourceEventId: input.virtual?.exitSourceEventId ?? null,
      exitCandleTime: input.virtual?.exitCandleTime ?? null,
      exitPrice: finite(input.virtual?.exitPrice),
      exitReason: virtualReason,
      exitReasonCode: virtualReasonCode,
      exitCategory: virtualCategory,
      shares: virtualShares,
      pnl: virtualPnl,
      pnlPer100: virtualPnlPer100,
      outcome: outcome(virtualPnlPer100),
    },
  };
}

export function compareCurrentCandidateOutcomes(input: {
  candidates: RtSignalCandidate[];
  virtualTrades: RtSignalCandidateTrade[];
  decisions: RtRealtimeDecisionEvent[];
}) {
  const accepted = input.candidates
    .filter(candidate => candidate.realtimeDecision === "accepted")
    .sort((a, b) => a.engineSequence - b.engineSequence || a.id - b.id);
  const virtualByCandidateId = new Map(input.virtualTrades.map(trade => [trade.candidateId, trade]));
  const details = accepted.map(candidate => compareCandidate({
    candidate,
    virtual: virtualByCandidateId.get(candidate.id) ?? null,
    decisions: input.decisions,
  }));
  const matched = details.filter(detail => detail.status === "match").length;
  const mismatched = details.filter(detail => detail.status === "mismatch").length;
  const incomplete = details.filter(detail => detail.status === "incomplete").length;
  return {
    comparisonVersion: CURRENT_CANDIDATE_OUTCOME_PARITY_VERSION,
    candidateVersion: CURRENT_SIGNAL_CANDIDATE_VERSION,
    virtualEngineVersion: CURRENT_SIGNAL_VIRTUAL_ENGINE_VERSION,
    acceptedCandidates: accepted.length,
    marginBlockedExcluded: input.candidates.length - accepted.length,
    matched,
    mismatched,
    incomplete,
    parityRatePct: accepted.length - incomplete > 0
      ? matched / (accepted.length - incomplete) * 100
      : null,
    firstMismatch: details.find(detail => detail.status === "mismatch") ?? null,
    details,
    scope: {
      purpose: "diagnosis_only",
      currentAndShadowExecutionChanged: false,
      marginBlockedPolicy: "excluded_because_no_actual_position; retained_in_signal_quality_ledger",
      pnlNormalization: "actual_variable_shares_normalized_to_100_shares",
    },
  };
}

export async function compareCurrentCandidateOutcomesForDate(tradeDate: string) {
  const [candidates, virtualTrades, decisions] = await Promise.all([
    getRtSignalCandidatesForDate({ candidateVersion: CURRENT_SIGNAL_CANDIDATE_VERSION, tradeDate }),
    getRtSignalCandidateTradesForDate({ virtualEngineVersion: CURRENT_SIGNAL_VIRTUAL_ENGINE_VERSION, tradeDate }),
    getRtRealtimeDecisionEventsForDate(tradeDate),
  ]);
  return {
    tradeDate,
    ...compareCurrentCandidateOutcomes({ candidates, virtualTrades, decisions }),
  };
}
