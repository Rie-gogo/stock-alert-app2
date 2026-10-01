import type { RtForwardShadowEvent, RtForwardShadowTrade, RtSignalCandidate, RtSignalCandidateTrade } from "../drizzle/schema";
import {
  getRtForwardShadowEventsForDate,
  getRtForwardShadowTradesForEntryDate,
  getRtSignalCandidateTradesForDate,
  getRtSignalCandidatesForDate,
  listRtStrategyVersionsForCatalogAudit,
} from "./db";
import { resolveMonitoringCandidateVirtualGeneration } from "./multiSymbolMonitoringMaterializer";
import { ROUTE_GRANULAR_VARIANTS, auditRouteGranularCatalog, type RouteGranularVariant } from "./routeGranularMonitoringRegistry";

export const ROUTE_GRANULAR_MONITORING_COMPONENT = "monitoring_route_granular_10_symbols";
export const ROUTE_GRANULAR_MONITORING_VERSION = "monitoring-route-granular-10-symbols-v1";
export const ROUTE_GRANULAR_MONITORING_START_DATE = "2026-10-02";

type Action = Record<string, unknown>;
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function finite(value: unknown): number | null { const n = Number(value); return Number.isFinite(n) ? n : null; }
function per100(pnl: unknown, shares: unknown) { const value = finite(pnl); const quantity = finite(shares); return value === null || quantity === null || quantity <= 0 ? null : Math.round(value / quantity * 100 * 1_000_000) / 1_000_000; }
function actions(event: RtForwardShadowEvent): Action[] { const raw = record(event.decisionJson).actions; return Array.isArray(raw) ? raw.map(record) : []; }
function routeForForwardEvent(event: RtForwardShadowEvent): string | null {
  const action = actions(event).find(item => typeof item.route === "string" && ["entry", "entry_rejected", "pending", "route_ended"].includes(String(item.type)));
  return typeof action?.route === "string" ? action.route : null;
}
function sideForForwardEvent(event: RtForwardShadowEvent): "long" | "short" | null {
  const action = actions(event).find(item => ["entry", "entry_rejected", "pending", "route_ended"].includes(String(item.type)) && (item.side === "long" || item.side === "short"));
  return action?.side === "long" || action?.side === "short" ? action.side : null;
}
function isRoutedEvent(event: RtForwardShadowEvent, variant: RouteGranularVariant) {
  if (event.strategyVersion !== variant.strategyVersion || event.evaluationMode !== "signal_quality") return false;
  if (variant.shadowRouteId && routeForForwardEvent(event) !== variant.shadowRouteId) return false;
  if (variant.shadowSide && sideForForwardEvent(event) !== variant.shadowSide) return false;
  return true;
}

export type RouteGranularDailyPlan = RouteGranularVariant & {
  signals: number;
  openedTrades: number;
  completedTrades: number;
  openTrades: number;
  missingTrades: number;
  wins: number;
  losses: number;
  draws: number;
  pnlPer100: number;
  grossProfitPer100: number;
  grossLossPer100: number;
  sourceDisposition: { currentCandidates: number; shadowEvents: number; unavailable: boolean };
};

export type RouteGranularDailySnapshot = {
  component: typeof ROUTE_GRANULAR_MONITORING_COMPONENT;
  materializationVersion: typeof ROUTE_GRANULAR_MONITORING_VERSION;
  tradeDate: string;
  ready: boolean;
  incompleteReason: string | null;
  catalogAudit: ReturnType<typeof auditRouteGranularCatalog>;
  scope: { compositePlansSelectable: false; unclassifiedSelectable: false; source: "closed_daily_ledger_only"; automaticAdoption: false };
  summary: { variants: number; signals: number; completedTrades: number; openTrades: number; missingTrades: number };
  plans: RouteGranularDailyPlan[];
};

function summarize(input: { variant: RouteGranularVariant; signals: number; rows: Array<{ completed: boolean; pnl: number | null }> ; shadowEvents: number }): RouteGranularDailyPlan {
  const completed = input.rows.filter(row => row.completed && row.pnl !== null);
  const values = completed.map(row => row.pnl!);
  const wins = values.filter(value => value > 0);
  const losses = values.filter(value => value < 0);
  const unavailable = input.variant.origin === "unavailable" || input.variant.origin === "unclassified";
  const missingTrades = unavailable ? 0 : input.variant.origin === "current" ? Math.max(0, input.signals - input.rows.length) : 0;
  return {
    ...input.variant,
    signals: input.signals,
    openedTrades: input.rows.length,
    completedTrades: completed.length,
    openTrades: input.rows.length - completed.length,
    missingTrades,
    wins: wins.length,
    losses: losses.length,
    draws: values.filter(value => value === 0).length,
    pnlPer100: values.reduce((sum, value) => sum + value, 0),
    grossProfitPer100: wins.reduce((sum, value) => sum + value, 0),
    grossLossPer100: Math.abs(losses.reduce((sum, value) => sum + value, 0)),
    sourceDisposition: { currentCandidates: input.variant.origin === "current" ? input.signals : 0, shadowEvents: input.shadowEvents, unavailable },
  };
}

/** Pure builder: output always contains allowlisted zero-fire and unavailable rows. */
export function buildRouteGranularDailySnapshot(input: {
  tradeDate: string;
  candidates: RtSignalCandidate[];
  candidateTrades: RtSignalCandidateTrade[];
  shadowEvents: RtForwardShadowEvent[];
  shadowTrades: RtForwardShadowTrade[];
  lifecycleRows?: Parameters<typeof auditRouteGranularCatalog>[1];
}): RouteGranularDailySnapshot {
  const tradeByCandidate = new Map(input.candidateTrades.map(trade => [trade.candidateId, trade]));
  const shadowEventByEntryKey = new Map(input.shadowEvents.map(event => [`${event.strategyVersion}:${event.sourceEventId}`, event]));
  const plans = ROUTE_GRANULAR_VARIANTS.map(variant => {
    if (variant.origin === "current") {
      const candidates = input.candidates.filter(candidate => candidate.symbol === variant.symbol
        && candidate.realtimeDecision !== "shadow_only"
        && candidate.routeId === variant.candidateRouteId
        && candidate.side === variant.direction);
      const rows = candidates.flatMap(candidate => {
        const trade = tradeByCandidate.get(candidate.id);
        return trade ? [{ completed: trade.completed, pnl: per100(trade.pnl, trade.shares) }] : [];
      });
      return summarize({ variant, signals: candidates.length, rows, shadowEvents: 0 });
    }
    if (variant.origin !== "forward_shadow" || !variant.strategyVersion) return summarize({ variant, signals: 0, rows: [], shadowEvents: 0 });
    const events = input.shadowEvents.filter(event => isRoutedEvent(event, variant));
    const trades = input.shadowTrades.filter(trade => trade.symbol === variant.symbol
      && trade.strategyVersion === variant.strategyVersion
      && trade.evaluationMode === "signal_quality"
      && (() => {
        const event = shadowEventByEntryKey.get(`${trade.strategyVersion}:${trade.entrySourceEventId}`) ?? {} as RtForwardShadowEvent;
        return (!variant.shadowRouteId || routeForForwardEvent(event) === variant.shadowRouteId)
          && (!variant.shadowSide || sideForForwardEvent(event) === variant.shadowSide);
      })());
    return summarize({
      variant,
      signals: events.length,
      rows: trades.map(trade => ({ completed: trade.pnl !== null && trade.exitTradeDate !== null, pnl: per100(trade.pnl, trade.shares) })),
      shadowEvents: events.length,
    });
  });
  const openTrades = plans.reduce((sum, item) => sum + item.openTrades, 0);
  const missingTrades = plans.reduce((sum, item) => sum + item.missingTrades, 0);
  const catalogAudit = auditRouteGranularCatalog(ROUTE_GRANULAR_VARIANTS, input.lifecycleRows ?? []);
  const ready = openTrades === 0 && missingTrades === 0 && catalogAudit.complete;
  return {
    component: ROUTE_GRANULAR_MONITORING_COMPONENT,
    materializationVersion: ROUTE_GRANULAR_MONITORING_VERSION,
    tradeDate: input.tradeDate,
    ready,
    incompleteReason: ready ? null : `open_trades=${openTrades},missing_current_trades=${missingTrades},catalog_complete=${catalogAudit.complete}`,
    catalogAudit,
    scope: { compositePlansSelectable: false, unclassifiedSelectable: false, source: "closed_daily_ledger_only", automaticAdoption: false },
    summary: { variants: plans.length, signals: plans.reduce((sum, item) => sum + item.signals, 0), completedTrades: plans.reduce((sum, item) => sum + item.completedTrades, 0), openTrades, missingTrades },
    plans,
  };
}

/** Called only by the closed-date audit materializer; never by source ingestion or a UI request. */
export async function materializeRouteGranularMonitoringForDate(tradeDate: string) {
  const generation = resolveMonitoringCandidateVirtualGeneration(tradeDate);
  const [candidates, candidateTrades, shadowEvents, shadowTrades, lifecycleRows] = await Promise.all([
    getRtSignalCandidatesForDate({ candidateVersion: generation.candidateVersion, tradeDate }),
    getRtSignalCandidateTradesForDate({ virtualEngineVersion: generation.virtualEngineVersion, tradeDate }),
    getRtForwardShadowEventsForDate(tradeDate),
    getRtForwardShadowTradesForEntryDate(tradeDate),
    listRtStrategyVersionsForCatalogAudit(),
  ]);
  return buildRouteGranularDailySnapshot({ tradeDate, candidates, candidateTrades, shadowEvents, shadowTrades, lifecycleRows });
}
