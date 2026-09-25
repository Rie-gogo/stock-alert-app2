import type { ForwardSourceEventInput } from "./forwardShadow";
import {
  TEL_EXECUTABLE_DEPTH_MAX_BOARD_AGE_MS,
  calculateClockSafeBoardAge,
  calculateDepthVwap,
} from "./telExecutableConfirmDepth";

/**
 * 現行売買・既存シャドーとは独立した比較用約定規約。
 *
 * シグナル足終値を約定価格へ流用しない。シグナル判定後に正式な
 * engineSequenceで現れる「最初の同一銘柄source event」だけを候補とし、
 * そのeventの新鮮な同時点板100株VWAPで約定可能性を判定する。
 */
export const MONITORING_COMPARISON_CONTRACT = Object.freeze({
  comparisonGeneration: "monitoring-comparison-strict-next-depth-v1",
  shares: 100,
  maxBoardAgeMs: TEL_EXECUTABLE_DEPTH_MAX_BOARD_AGE_MS,
  eventSelection: "strict_next_same_symbol_source_event" as const,
  longPriceSource: "ask_depth_vwap_100" as const,
  shortPriceSource: "bid_depth_vwap_100" as const,
  closePriceFallback: false,
});

export type MonitoringComparisonSide = "long" | "short";

export interface MonitoringComparisonSignal {
  comparisonGeneration: string;
  strategyVersion: string;
  routeId: string | null;
  symbol: string;
  side: MonitoringComparisonSide;
  signalSourceEventId: string;
  signalEngineSequence: number;
  signalTradeDate: string;
  signalTime: string;
  theoreticalSignalPrice: number;
  /** cloud時計。同じcloud時計のentry event受信時刻とのみ比較する。 */
  signalDecisionCompletedAtMs: number;
  /** Windows時計。同じWindows時計の次event板観測時刻とのみ比較する。 */
  signalBoardObservedAtMs: number | null;
}

export interface MonitoringComparisonSourceEvent extends ForwardSourceEventInput {
  currentAudit: NonNullable<ForwardSourceEventInput["currentAudit"]>;
}

export type MonitoringComparisonUnfillableReason =
  | "missing_engine_sequence"
  | "trade_date_mismatch"
  | "source_event_arrived_before_signal_decision_completed"
  | "board_observation_not_later_than_signal_event"
  | "source_event_causality_failed"
  | "board_timestamps_unavailable"
  | "board_timestamps_noncausal"
  | "board_stale"
  | "board_depth_insufficient";

export type MonitoringComparisonEntryResolution =
  | {
      status: "waiting";
      reason: "different_symbol" | "same_or_earlier_engine_sequence";
    }
  | {
      status: "unfillable";
      reason: MonitoringComparisonUnfillableReason;
      entrySourceEventId: string;
      entryEngineSequence: number | null;
      boardAgeMs: number | null;
    }
  | {
      status: "filled";
      entrySourceEventId: string;
      entryEngineSequence: number;
      entryTime: string;
      entryPrice: number;
      priceSource: "ask_depth_vwap_100" | "bid_depth_vwap_100";
      shares: 100;
      availableShares: number;
      levelsUsed: number;
      boardAgeMs: number;
    };

export interface MonitoringComparisonEntryState {
  signal: MonitoringComparisonSignal;
  resolution: MonitoringComparisonEntryResolution | null;
}

function unfillable(
  event: MonitoringComparisonSourceEvent,
  reason: MonitoringComparisonUnfillableReason,
  boardAgeMs: number | null,
): MonitoringComparisonEntryResolution {
  return {
    status: "unfillable",
    reason,
    entrySourceEventId: event.sourceEventId,
    entryEngineSequence: event.currentAudit.engineSequence,
    boardAgeMs,
  };
}

/**
 * 1件のsource eventを比較用entry候補として評価する純粋関数。
 * 最初の後続同銘柄eventがunfillableなら、後の良い板を選び直してはならない。
 */
export function resolveMonitoringComparisonEntry(
  signal: MonitoringComparisonSignal,
  event: MonitoringComparisonSourceEvent,
): MonitoringComparisonEntryResolution {
  if (event.candle.symbol !== signal.symbol) {
    return { status: "waiting", reason: "different_symbol" };
  }

  const engineSequence = event.currentAudit.engineSequence;
  if (engineSequence !== null && engineSequence <= signal.signalEngineSequence) {
    return { status: "waiting", reason: "same_or_earlier_engine_sequence" };
  }
  if (engineSequence === null) {
    return unfillable(event, "missing_engine_sequence", null);
  }
  if (event.candle.tradeDate !== signal.signalTradeDate) {
    return unfillable(event, "trade_date_mismatch", null);
  }

  // cloud時計同士だけを比較し、次eventがsignal判定完了後に到着したことを確認する。
  const cloudReceivedAtMs = event.currentAudit.cloudReceivedAtMs;
  if (cloudReceivedAtMs === null || cloudReceivedAtMs < signal.signalDecisionCompletedAtMs) {
    return unfillable(event, "source_event_arrived_before_signal_decision_completed", null);
  }

  // Windows時計同士だけを比較し、同一または巻き戻った板観測を拒否する。
  const boardObservedAtMs = event.currentAudit.boardObservedAtMs;
  if (
    signal.signalBoardObservedAtMs !== null
    && (boardObservedAtMs === null || boardObservedAtMs <= signal.signalBoardObservedAtMs)
  ) {
    return unfillable(event, "board_observation_not_later_than_signal_event", null);
  }
  // 現行売買判断がnot_applicable/unverifiedでも、source event自体の板時刻は
  // 下記の同一時計検査で独立に確認できる。明示的violationだけを拒否する。
  if (event.currentAudit.causalityStatus === "violation") {
    return unfillable(event, "source_event_causality_failed", null);
  }

  const age = calculateClockSafeBoardAge(event.currentAudit);
  if (!age.timestampsAvailable) {
    return unfillable(event, "board_timestamps_unavailable", null);
  }
  if (!age.causal) {
    return unfillable(event, "board_timestamps_noncausal", null);
  }
  if (!age.fresh || age.boardAgeMs === null) {
    return unfillable(event, "board_stale", age.boardAgeMs);
  }

  const depth = calculateDepthVwap({
    board: event.board,
    side: signal.side,
    shares: MONITORING_COMPARISON_CONTRACT.shares,
  });
  if (!depth) {
    return unfillable(event, "board_depth_insufficient", age.boardAgeMs);
  }

  return {
    status: "filled",
    entrySourceEventId: event.sourceEventId,
    entryEngineSequence: engineSequence,
    entryTime: event.candle.candleTime,
    entryPrice: depth.price,
    priceSource: signal.side === "long" ? "ask_depth_vwap_100" : "bid_depth_vwap_100",
    shares: 100,
    availableShares: depth.availableShares,
    levelsUsed: depth.levelsUsed,
    boardAgeMs: age.boardAgeMs,
  };
}

/** terminalになった比較entryを後続eventで上書きしない。 */
export function applyMonitoringComparisonEntryEvent(
  state: MonitoringComparisonEntryState,
  event: MonitoringComparisonSourceEvent,
): MonitoringComparisonEntryState {
  if (state.resolution?.status === "filled" || state.resolution?.status === "unfillable") {
    return state;
  }
  const resolution = resolveMonitoringComparisonEntry(state.signal, event);
  if (resolution.status === "waiting") return state;
  return { ...state, resolution };
}

export function canUseMonitoringOutcomeLabel(input: {
  availableAtMs: number;
  evaluationCutoffMs: number;
}): boolean {
  return Number.isFinite(input.availableAtMs)
    && Number.isFinite(input.evaluationCutoffMs)
    && input.availableAtMs <= input.evaluationCutoffMs;
}

export function classifyMonitoringAttribution(routeId: string | null): {
  routeId: string;
  attributionStatus: "classified" | "unclassified";
  includeInOverallPnl: true;
  includeInRouteComparison: boolean;
} {
  const normalized = routeId?.trim() ?? "";
  return normalized.length > 0
    ? {
        routeId: normalized,
        attributionStatus: "classified",
        includeInOverallPnl: true,
        includeInRouteComparison: true,
      }
    : {
        routeId: "unclassified",
        attributionStatus: "unclassified",
        includeInOverallPnl: true,
        includeInRouteComparison: false,
      };
}
