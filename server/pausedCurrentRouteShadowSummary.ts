import type { RtSignalCandidate, RtSignalCandidateTrade } from "../drizzle/schema";
import {
  getRtForwardShadowTrades,
  getRtSignalCandidatesForDateRange,
  getRtSignalCandidateTradesForDateRange,
} from "./db";
import { DISCO_SHORT_COLLECTION_START_DATE } from "./discoOpeningShortForwardShadow";
import { DISCO_SHORT_BASELINE_VERSION } from "./runtimeIdentity";
import {
  CURRENT_SIGNAL_CANDIDATE_VERSION,
  CURRENT_SIGNAL_VIRTUAL_ENGINE_VERSION,
} from "./currentSignalCandidateRegistry";
import {
  PAUSED_CURRENT_ROUTE_SHADOW_EFFECTIVE_DATE,
  PAUSED_CURRENT_ROUTE_SHADOW_POLICY_VERSION,
  PAUSED_CURRENT_ROUTE_SPECS,
} from "./pausedCurrentRouteShadow";

function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function buildPausedCurrentRouteShadowSummary(input: {
  candidates: RtSignalCandidate[];
  trades: RtSignalCandidateTrade[];
  asOfDate: string;
}) {
  const tradeByCandidate = new Map(input.trades.map(trade => [trade.candidateId, trade]));
  return PAUSED_CURRENT_ROUTE_SPECS
    .filter(spec => spec.captureViaGenericCandidateLedger)
    .map(spec => {
      const matchingCandidates = input.candidates.filter(candidate =>
        candidate.realtimeDecision === "shadow_only"
        && candidate.symbol === spec.symbol
        && candidate.routeId === spec.stateKey,
      );
      // サーバー再起動直後などに同一ルートが再検出されても、元仕様の「1日1回」を
      // 崩さず最初の候補だけを成績集計へ採用する。
      const seenTradeDates = new Set<string>();
      const candidates = matchingCandidates.filter(candidate => {
        if (seenTradeDates.has(candidate.tradeDate)) return false;
        seenTradeDates.add(candidate.tradeDate);
        return true;
      });
      const trades = candidates
        .map(candidate => tradeByCandidate.get(candidate.id) ?? null)
        .filter((trade): trade is RtSignalCandidateTrade => trade !== null);
      const completed = trades.filter(trade => trade.completed && finite(trade.pnl) !== null);
      const wins = completed.filter(trade => finite(trade.pnl)! > 0).length;
      const losses = completed.filter(trade => finite(trade.pnl)! < 0).length;
      const draws = completed.length - wins - losses;
      const pnl = completed.reduce((sum, trade) => sum + (finite(trade.pnl) ?? 0), 0);
      const denominator = wins + losses + draws;
      return {
        policyVersion: PAUSED_CURRENT_ROUTE_SHADOW_POLICY_VERSION,
        candidateVersion: CURRENT_SIGNAL_CANDIDATE_VERSION,
        virtualEngineVersion: CURRENT_SIGNAL_VIRTUAL_ENGINE_VERSION,
        collectionStartDate: PAUSED_CURRENT_ROUTE_SHADOW_EFFECTIVE_DATE,
        asOfDate: input.asOfDate,
        symbol: spec.symbol,
        routeId: spec.stateKey,
        publicRouteId: spec.publicRouteId,
        logicName: spec.label,
        side: spec.side,
        purpose: "paused_current_route_comparison_only" as const,
        eligibleForAdoption: false,
        signals: candidates.length,
        openedVirtualTrades: trades.length,
        openTrades: trades.filter(trade => !trade.completed).length,
        closedTrades: completed.length,
        wins,
        losses,
        draws,
        winRatePct: denominator === 0 ? null : wins / denominator * 100,
        pnl,
      };
    });
}

export async function getPausedCurrentRouteShadowSummary(asOfDate: string) {
  if (asOfDate < PAUSED_CURRENT_ROUTE_SHADOW_EFFECTIVE_DATE) {
    return buildPausedCurrentRouteShadowSummary({ candidates: [], trades: [], asOfDate });
  }
  const [candidates, trades] = await Promise.all([
    getRtSignalCandidatesForDateRange({
      candidateVersion: CURRENT_SIGNAL_CANDIDATE_VERSION,
      fromDate: PAUSED_CURRENT_ROUTE_SHADOW_EFFECTIVE_DATE,
      toDate: asOfDate,
    }),
    getRtSignalCandidateTradesForDateRange({
      virtualEngineVersion: CURRENT_SIGNAL_VIRTUAL_ENGINE_VERSION,
      fromDate: PAUSED_CURRENT_ROUTE_SHADOW_EFFECTIVE_DATE,
      toDate: asOfDate,
    }),
  ]);
  return buildPausedCurrentRouteShadowSummary({ candidates, trades, asOfDate });
}

export function buildPausedDiscoShortShadowSummary(input: {
  trades: Array<{
    evaluationMode: string;
    entryTradeDate: string;
    exitTradeDate: string | null;
    pnl: number | null;
  }>;
  asOfDate: string;
}) {
  const trades = input.trades.filter(trade =>
    trade.evaluationMode === "signal_quality"
    && trade.entryTradeDate >= DISCO_SHORT_COLLECTION_START_DATE
    && trade.entryTradeDate <= input.asOfDate,
  );
  const completed = trades.filter(trade =>
    trade.exitTradeDate !== null
    && trade.exitTradeDate <= input.asOfDate
    && finite(trade.pnl) !== null,
  );
  const wins = completed.filter(trade => finite(trade.pnl)! > 0).length;
  const losses = completed.filter(trade => finite(trade.pnl)! < 0).length;
  const draws = completed.length - wins - losses;
  const pnl = completed.reduce((sum, trade) => sum + (finite(trade.pnl) ?? 0), 0);
  return {
    policyVersion: PAUSED_CURRENT_ROUTE_SHADOW_POLICY_VERSION,
    candidateVersion: DISCO_SHORT_BASELINE_VERSION,
    virtualEngineVersion: DISCO_SHORT_BASELINE_VERSION,
    collectionStartDate: DISCO_SHORT_COLLECTION_START_DATE,
    asOfDate: input.asOfDate,
    symbol: "6146",
    routeId: "discoOpeningBreakShort",
    publicRouteId: "disco_opening_short",
    logicName: "寄り付き10本安値更新SHORT",
    side: "short" as const,
    purpose: "paused_current_route_comparison_only" as const,
    eligibleForAdoption: false,
    source: "dedicated_forward_shadow" as const,
    signals: trades.length,
    openedVirtualTrades: trades.length,
    openTrades: trades.length - completed.length,
    closedTrades: completed.length,
    wins,
    losses,
    draws,
    winRatePct: completed.length === 0 ? null : wins / completed.length * 100,
    pnl,
  };
}

/** 停止した現行11経路だけの軽量な読取専用集計。既存シャドーと発注経路は変更しない。 */
export async function getAllPausedCurrentRouteShadowSummary(asOfDate: string) {
  const [genericRoutes, discoTrades] = await Promise.all([
    getPausedCurrentRouteShadowSummary(asOfDate),
    getRtForwardShadowTrades(DISCO_SHORT_BASELINE_VERSION),
  ]);
  return [
    ...genericRoutes,
    buildPausedDiscoShortShadowSummary({ trades: discoTrades, asOfDate }),
  ];
}
