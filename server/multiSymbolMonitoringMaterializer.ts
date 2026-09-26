import type {
  RtForwardShadowTrade,
  RtSignalCandidate,
  RtSignalCandidateTrade,
} from "../drizzle/schema";
import {
  acquireRtNamedWorkerLock,
  getClosedRtAuditTradeDates,
  getRtAuditTradeDateFinality,
  getRtDailyAuditMaterializationsForRange,
  getRtForwardShadowTradesForEntryDate,
  getRtSignalCandidatesForDate,
  getRtSignalCandidateTradesForDate,
  releaseRtNamedWorkerLock,
  upsertRtDailyAuditMaterialization,
} from "./db";
import { randomUUID } from "node:crypto";
import {
  CURRENT_SIGNAL_VIRTUAL_ENGINE_VERSION,
  resolveCurrentSignalCandidateVersion,
} from "./currentSignalCandidateRegistry";
import {
  MULTI_SYMBOL_MONITORING_PLAN_BY_VERSION,
  MULTI_SYMBOL_MONITORING_PLAN_DEFINITIONS,
  TEN_MONITORED_SYMBOLS,
  type MonitoringPlanDefinition,
} from "./multiSymbolMonitoringRegistry";

export const MULTI_SYMBOL_MONITORING_COMPONENT = "monitoring_trend_10_symbols";
export const MULTI_SYMBOL_MONITORING_MATERIALIZATION_VERSION = "monitoring-trend-10-symbols-daily-v1";
export const MULTI_SYMBOL_MONITORING_START_DATE = "2026-09-07";
const MULTI_SYMBOL_MONITORING_BACKFILL_LOCK = "monitoring-trend-10-symbol-backfill-v1";

export interface DailyMonitoringPlanSnapshot extends MonitoringPlanDefinition {
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
}

export interface MultiSymbolMonitoringDailySnapshot {
  component: typeof MULTI_SYMBOL_MONITORING_COMPONENT;
  materializationVersion: typeof MULTI_SYMBOL_MONITORING_MATERIALIZATION_VERSION;
  tradeDate: string;
  scope: {
    symbols: readonly string[];
    currentOutcome: "signal_quality_100_share_including_margin_blocks";
    shadowOutcome: "signal_quality_100_share";
    automaticAdoption: false;
    intradayExecutionChanged: false;
  };
  ready: boolean;
  incompleteReason: string | null;
  summary: {
    plans: number;
    signals: number;
    completedTrades: number;
    openTrades: number;
    missingTrades: number;
  };
  plans: DailyMonitoringPlanSnapshot[];
}

function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizePer100(pnl: unknown, shares: unknown): number | null {
  const value = finite(pnl);
  const quantity = finite(shares);
  if (value === null || quantity === null || quantity <= 0) return null;
  return Math.round(value / quantity * 100 * 1_000_000) / 1_000_000;
}

function summarizePlan(
  definition: MonitoringPlanDefinition,
  signals: number,
  trades: Array<{ completed: boolean; pnlPer100: number | null }>,
): DailyMonitoringPlanSnapshot {
  const completed = trades.filter(trade => trade.completed && trade.pnlPer100 !== null);
  const pnlValues = completed.map(trade => trade.pnlPer100!);
  const wins = pnlValues.filter(value => value > 0);
  const losses = pnlValues.filter(value => value < 0);
  return {
    ...definition,
    signals,
    openedTrades: trades.length,
    completedTrades: completed.length,
    openTrades: trades.length - completed.length,
    missingTrades: Math.max(0, signals - trades.length),
    wins: wins.length,
    losses: losses.length,
    draws: pnlValues.filter(value => value === 0).length,
    pnlPer100: pnlValues.reduce((sum, value) => sum + value, 0),
    grossProfitPer100: wins.reduce((sum, value) => sum + value, 0),
    grossLossPer100: Math.abs(losses.reduce((sum, value) => sum + value, 0)),
  };
}

export function buildMultiSymbolMonitoringDailySnapshot(input: {
  tradeDate: string;
  candidates: RtSignalCandidate[];
  candidateTrades: RtSignalCandidateTrade[];
  shadowTrades: RtForwardShadowTrade[];
}): MultiSymbolMonitoringDailySnapshot {
  const candidateTradeByCandidateId = new Map(input.candidateTrades.map(trade => [trade.candidateId, trade]));
  const activeCandidates = input.candidates.filter(candidate => candidate.realtimeDecision !== "shadow_only");
  const plans = MULTI_SYMBOL_MONITORING_PLAN_DEFINITIONS.map(definition => {
    if (definition.origin === "current") {
      const signals = activeCandidates.filter(candidate => candidate.symbol === definition.symbol);
      const trades = signals.flatMap(candidate => {
        const trade = candidateTradeByCandidateId.get(candidate.id);
        if (!trade) return [];
        return [{
          completed: trade.completed,
          pnlPer100: normalizePer100(trade.pnl, trade.shares),
        }];
      });
      return summarizePlan(definition, signals.length, trades);
    }

    const trades = input.shadowTrades
      .filter(trade => trade.strategyVersion === definition.strategyVersion
        && trade.evaluationMode === "signal_quality"
        && trade.symbol === definition.symbol)
      .map(trade => ({
        completed: trade.pnl !== null && trade.exitTradeDate !== null,
        pnlPer100: normalizePer100(trade.pnl, trade.shares),
      }));
    return summarizePlan(definition, trades.length, trades);
  });
  const openTrades = plans.reduce((sum, plan) => sum + plan.openTrades, 0);
  const missingTrades = plans.reduce((sum, plan) => sum + plan.missingTrades, 0);
  const ready = openTrades === 0 && missingTrades === 0;
  return {
    component: MULTI_SYMBOL_MONITORING_COMPONENT,
    materializationVersion: MULTI_SYMBOL_MONITORING_MATERIALIZATION_VERSION,
    tradeDate: input.tradeDate,
    scope: {
      symbols: TEN_MONITORED_SYMBOLS,
      currentOutcome: "signal_quality_100_share_including_margin_blocks",
      shadowOutcome: "signal_quality_100_share",
      automaticAdoption: false,
      intradayExecutionChanged: false,
    },
    ready,
    incompleteReason: ready ? null : `open_trades=${openTrades},missing_current_trades=${missingTrades}`,
    summary: {
      plans: plans.length,
      signals: plans.reduce((sum, plan) => sum + plan.signals, 0),
      completedTrades: plans.reduce((sum, plan) => sum + plan.completedTrades, 0),
      openTrades,
      missingTrades,
    },
    plans,
  };
}

export async function materializeMultiSymbolMonitoringForDate(tradeDate: string) {
  const candidateVersion = resolveCurrentSignalCandidateVersion(tradeDate);
  const [candidates, candidateTrades, shadowTrades] = await Promise.all([
    getRtSignalCandidatesForDate({ candidateVersion, tradeDate }),
    getRtSignalCandidateTradesForDate({
      virtualEngineVersion: CURRENT_SIGNAL_VIRTUAL_ENGINE_VERSION,
      tradeDate,
    }),
    getRtForwardShadowTradesForEntryDate(tradeDate),
  ]);
  return buildMultiSymbolMonitoringDailySnapshot({
    tradeDate,
    candidates,
    candidateTrades,
    shadowTrades: shadowTrades.filter(trade => MULTI_SYMBOL_MONITORING_PLAN_BY_VERSION.has(trade.strategyVersion)),
  });
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

/**
 * 当日の全監査componentが完了した後だけ、過去の確定日を新しい順に1日ずつ埋める。
 * 既存2分workerから高々1日呼ばれるため、日中受信や通常shadowと競合しない。
 */
export async function materializeNextMissingMultiSymbolMonitoringDate(asOfDate: string) {
  const ownerToken = `monitoring-backfill:${randomUUID()}`;
  const acquired = await acquireRtNamedWorkerLock({
    lockName: MULTI_SYMBOL_MONITORING_BACKFILL_LOCK,
    ownerToken,
    leaseMs: 110_000,
  });
  if (!acquired) return { status: "worker_busy" as const };
  try {
    const [closedDates, existingRows] = await Promise.all([
      getClosedRtAuditTradeDates({ fromDate: MULTI_SYMBOL_MONITORING_START_DATE, toDate: asOfDate }),
      getRtDailyAuditMaterializationsForRange({
        component: MULTI_SYMBOL_MONITORING_COMPONENT,
        version: MULTI_SYMBOL_MONITORING_MATERIALIZATION_VERSION,
        fromDate: MULTI_SYMBOL_MONITORING_START_DATE,
        toDate: asOfDate,
      }),
    ]);
    const completeDates = new Set(existingRows.filter(row => row.status === "complete").map(row => row.tradeDate));
    const tradeDate = closedDates.slice().sort().reverse().find(date => !completeDates.has(date));
    if (!tradeDate) return { status: "complete" as const };

    const finality = await getRtAuditTradeDateFinality(tradeDate);
    if (!finality || finality.status !== "closed") {
      return { status: "deferred" as const, tradeDate, reason: "trade_date_not_closed" as const };
    }
    const watermark = record(finality.watermarkJson);
    const decision = record(watermark.decision);
    const sourceDecisionCount = Math.max(0, Math.trunc(finite(decision.count) ?? 0));
    const processedThroughEngineSequence = Math.max(0, Math.trunc(finite(decision.maxId) ?? 0));
    const result = await materializeMultiSymbolMonitoringForDate(tradeDate);
    await upsertRtDailyAuditMaterialization({
      component: MULTI_SYMBOL_MONITORING_COMPONENT,
      version: MULTI_SYMBOL_MONITORING_MATERIALIZATION_VERSION,
      tradeDate,
      status: result.ready ? "complete" : "incomplete_source",
      processedThroughEngineSequence,
      sourceDecisionCount,
      resultJson: result,
      lastError: result.incompleteReason,
      generatedAt: result.ready ? new Date() : null,
    });
    return {
      status: result.ready ? "materialized" as const : "incomplete_source" as const,
      tradeDate,
      summary: result.summary,
    };
  } finally {
    await releaseRtNamedWorkerLock(MULTI_SYMBOL_MONITORING_BACKFILL_LOCK, ownerToken);
  }
}
