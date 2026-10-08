import type { RtDailyAuditMaterialization } from "../drizzle/schema";
import {
  getRtDailyAuditMaterialization,
  getRtDailyAuditMaterializationsForRange,
  listRtStrategyVersionsForCatalogAudit,
  upsertRtDailyAuditMaterialization,
} from "./db";
import {
  combinePremarketAndIntraday,
  type IntradayMarketRegime,
  type MarketContextBar,
  type PremarketMarketRegime,
} from "./marketContextSelectorShadow";
import {
  ROUTE_GRANULAR_MONITORING_COMPONENT,
  ROUTE_GRANULAR_MONITORING_START_DATE,
  ROUTE_GRANULAR_MONITORING_VERSION,
  type RouteGranularDailyPlan,
  type RouteGranularDailySnapshot,
} from "./routeGranularMonitoringMaterializer";
import { ROUTE_GRANULAR_VARIANTS } from "./routeGranularMonitoringRegistry";
import {
  ROUTE_GRANULAR_SELECTOR_SNAPSHOT_COMPONENT,
  ROUTE_GRANULAR_SELECTOR_VERSION,
} from "./routeGranularNextDaySelector";
import {
  RETIRED_SIX_SHADOW_VERSIONS,
  RETIRED_STOPPED_CURRENT_CANONICAL_LOGICS,
} from "./retiredSixStrategies";
import { sha256Stable } from "./runtimeIdentity";

/**
 * v4 is a selector-only observation layer. It never dispatches a strategy, changes
 * a current/shadow engine, or uses its own historical P&L to auto-adopt/reject a
 * route. v3 decision rows remain immutable audit history and are intentionally not
 * read by v4 selection.
 */
export const MARKET_CONTEXT_PERFORMANCE_SELECTOR_VERSION = "market-context-performance-selector-shadow-v4";
export const MARKET_CONTEXT_PERFORMANCE_COMPONENT = "market_context_performance_snapshot";
export const MARKET_CONTEXT_PERFORMANCE_VERSION = "market-context-performance-snapshot-v1";
export const MARKET_CONTEXT_PERFORMANCE_CONFIG = Object.freeze({
  selectorVersion: MARKET_CONTEXT_PERFORMANCE_SELECTOR_VERSION,
  component: MARKET_CONTEXT_PERFORMANCE_COMPONENT,
  materializationVersion: MARKET_CONTEXT_PERFORMANCE_VERSION,
  input: "closed_route_granular_daily_snapshots_and_frozen_v4_context_decisions_only",
  decisionAuthority: "frozen_premarket_and_intraday_context_route_style_affinity",
  historicalPnlRole: "display_and_future_conditional_learning_only",
  unconditionalRecentPnlUsedForSelection: false,
  conditionalRankingApplied: false,
  automaticSelection: false,
  automaticAdoption: false,
  orderInstructionConnection: false,
  formalPerformanceUse: false,
});
export const MARKET_CONTEXT_PERFORMANCE_CONFIG_HASH = sha256Stable(MARKET_CONTEXT_PERFORMANCE_CONFIG);
const routeCandidatesByTradeDate = new Map<string, Promise<Awaited<ReturnType<typeof resolveMarketContextV4RouteCandidatesUncached>>>>();

export type ContextCheckpoint = "08:30" | "09:05" | "09:15" | "10:00" | "12:35" | "13:30";
export type Direction = "long" | "short";
type Value = Record<string, unknown>;

function object(value: unknown): Value {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Value : {};
}
function finite(value: unknown): number | null {
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}
function stableObject(value: unknown): Value { return object(value); }
function recordArray(value: unknown): Value[] { return Array.isArray(value) ? value.map(object) : []; }

/** Incremental per-instrument/day state. It admits one validated bar per minute. */
export class RollingMarketContextBars {
  private readonly byMinute = new Map<string, MarketContextBar>();
  private activeTradeDate: string | null = null;

  append(bar: MarketContextBar): void {
    if (this.activeTradeDate !== bar.tradeDate) {
      this.byMinute.clear();
      this.activeTradeDate = bar.tradeDate;
    }
    const previous = this.byMinute.get(bar.candleTime);
    // A same-minute correction cannot silently replace an already accepted source
    // event. The ingress boundary rejects corrections; keep first state here too.
    if (!previous) this.byMinute.set(bar.candleTime, bar);
  }

  hydrate(bars: readonly MarketContextBar[]): void {
    this.byMinute.clear();
    this.activeTradeDate = bars.at(-1)?.tradeDate ?? null;
    for (const bar of bars) this.append(bar);
  }

  bars(): MarketContextBar[] {
    return Array.from(this.byMinute.values()).sort((left, right) => left.candleTime.localeCompare(right.candleTime));
  }

  count(): number { return this.byMinute.size; }
  tradeDate(): string | null { return this.activeTradeDate; }
}

export type MarketContextPerformanceRow = {
  contextKey: string;
  checkpoint: ContextCheckpoint;
  combinedState: string;
  allowedDirections: Direction[];
  symbol: string;
  rowId: string | null;
  canonicalLogic: string | null;
  strategyVersion: string | null;
  routeGroupId: string | null;
  direction: Direction | null;
  routeStyle: string | null;
  marketAffinityScore: number | null;
  signals: number;
  completedTrades: number;
  wins: number;
  losses: number;
  draws: number;
  pnlPer100: number;
  profitFactor: number | null;
  status: "observed" | "no_signal" | "open_trade" | "no_completed_trade";
};

export type MarketContextPerformanceSnapshot = {
  component: typeof MARKET_CONTEXT_PERFORMANCE_COMPONENT;
  materializationVersion: typeof MARKET_CONTEXT_PERFORMANCE_VERSION;
  tradeDate: string;
  immutable: true;
  monitoringOnly: true;
  formalPerformanceUse: false;
  automaticSelection: false;
  automaticAdoption: false;
  orderInstructionConnection: false;
  inputCutoff: string;
  source: "closed_route_granular_daily_snapshot_and_frozen_v4_context_decisions";
  snapshotReady: boolean;
  reason: string | null;
  rows: MarketContextPerformanceRow[];
  summary: { contexts: number; selectedAlternatives: number; observedTrades: number; pnlPer100: number };
  inputHash: string;
  configHash: string;
};

function routeStyle(row: Value): "trend_long" | "reversal_long" | "trend_short" | "reversal_short" | null {
  const group = String(row.routeGroupId ?? "").toLowerCase();
  const direction = String(row.direction ?? "");
  if (direction === "long") return group.includes("reversal") || group.includes("low_reversal") || group.includes("deep_reversal") ? "reversal_long" : "trend_long";
  if (direction === "short") return group.includes("reversal") || group.includes("high_fade") || group.includes("peak_reversal") ? "reversal_short" : "trend_short";
  return null;
}

function affinity(style: ReturnType<typeof routeStyle>, states: string[]): number {
  if (!style) return 0;
  return states.reduce((best, state) => {
    let score = 0;
    if (state === "gap_down_recovery") score = style === "reversal_long" ? 5 : style === "trend_long" ? 3 : 0;
    else if (state === "gap_up_failure") score = style === "reversal_short" ? 5 : style === "trend_short" ? 3 : 0;
    else if (state === "strong_up" || state === "up") score = style === "trend_long" ? 4 : style === "reversal_long" ? 2 : 0;
    else if (state === "strong_down" || state === "down") score = style === "trend_short" ? 4 : style === "reversal_short" ? 2 : 0;
    return Math.max(best, score);
  }, 0);
}

function candidateEligible(row: Value): boolean {
  // Route-granular v5 deliberately separates market-context eligibility from
  // positive/negative recent P&L; a negative history remains visible, not excluded.
  return row.marketContextEligible === true || (row.marketContextEligible === undefined && row.selectable === true);
}

/**
 * A frozen D-1 selector snapshot remains immutable audit history.  If a route is
 * explicitly retired later, only the read-model candidate set excludes it; the
 * persisted snapshot, its original hash, and all historical materializations are
 * left untouched.  Do not broadly intersect with today's catalog: that would
 * incorrectly remove unrelated historical versions from the same D-1 snapshot.
 */
export function excludeExplicitlyRetiredRoutesFromFrozenScores(scores: Value[]): Value[] {
  const retiredVersions = new Set<string>(RETIRED_SIX_SHADOW_VERSIONS);
  const retiredCurrentLogics = new Set<string>(RETIRED_STOPPED_CURRENT_CANONICAL_LOGICS);
  return scores.filter(row =>
    !retiredVersions.has(String(row.strategyVersion ?? ""))
    && !retiredCurrentLogics.has(String(row.canonicalLogic ?? ""))
  );
}

/**
 * Resolve the immutable D-1 route selector snapshot when it exists. If the strict
 * upstream snapshot is unavailable, freeze a bounded code-catalog/lifecycle view.
 * This fallback never filters candidates by realised P&L.
 */
async function resolveMarketContextV4RouteCandidatesUncached(tradeDate: string) {
  const snapshot = await getRtDailyAuditMaterialization({
    component: ROUTE_GRANULAR_SELECTOR_SNAPSHOT_COMPONENT,
    version: ROUTE_GRANULAR_SELECTOR_VERSION,
    tradeDate,
  });
  const stored = object(snapshot?.resultJson);
  if (snapshot?.status === "complete" && Array.isArray(stored.scores)) {
    const frozenScores = recordArray(stored.scores);
    const scores = excludeExplicitlyRetiredRoutesFromFrozenScores(frozenScores);
    return {
      selectorVersion: stored.selectorVersion ?? ROUTE_GRANULAR_SELECTOR_VERSION,
      inputHash: sha256Stable({
        frozenInputHash: stored.inputHash ?? null,
        retiredSixFilterVersion: "explicit-six-logic-retirement-2026-10-08",
        scores,
      }),
      source: "frozen_d_minus_one_route_selector_snapshot" as const,
      scores,
      catalogAudit: stored.catalogAudit ?? null,
    };
  }
  const lifecycleRows = await listRtStrategyVersionsForCatalogAudit();
  const lifecycleByVersion = new Map(lifecycleRows.map(row => [row.versionId, row]));
  const scores = ROUTE_GRANULAR_VARIANTS
    .filter(variant => {
      if (variant.lifecycleRequirement === "current_candidate_ledger") return true;
      if (variant.lifecycleRequirement !== "monitoring_candidate" || !variant.strategyVersion) return false;
      const lifecycle = lifecycleByVersion.get(variant.strategyVersion);
      return lifecycle?.status === "monitoring" && lifecycle.evaluationPurpose === "candidate";
    })
    .map(variant => ({
      ...variant,
      selectable: false,
      marketContextEligible: true,
      marketContextEvidenceLevel: "unobserved",
      marketContextCompletedTrades: 0,
      marketContextRecent10PnlPer100: null,
      marketContextAllPnlPer100: null,
      marketContextExclusionReasons: [],
    }));
  return {
    selectorVersion: "market-context-v4-code-catalog-lifecycle-fallback",
    inputHash: sha256Stable({ tradeDate, scores, lifecycleRows: lifecycleRows.map(row => ({ versionId: row.versionId, status: row.status, evaluationPurpose: row.evaluationPurpose })) }),
    source: "bounded_code_catalog_and_lifecycle_fallback" as const,
    scores,
    catalogAudit: null,
  };
}

export async function resolveMarketContextV4RouteCandidates(tradeDate: string) {
  return resolveMarketContextV4RouteCandidatesUncached(tradeDate);
}

/**
 * The same closed D-1 snapshot/catalog applies to the 08:30 premarket decision and
 * every intraday fixed checkpoint of a trade date. A rejected lookup is evicted so
 * the next fixed checkpoint can retry without a polling loop or raw-data scan.
 */
export async function resolveMarketContextV4RouteCandidatesCached(tradeDate: string) {
  const cached = routeCandidatesByTradeDate.get(tradeDate);
  if (cached) return cached;
  const pending = resolveMarketContextV4RouteCandidatesUncached(tradeDate).catch(error => {
    routeCandidatesByTradeDate.delete(tradeDate);
    throw error;
  });
  routeCandidatesByTradeDate.set(tradeDate, pending);
  return pending;
}

function selectionForScores(input: {
  scores: Value[];
  allowedDirections: Direction[];
  states: string[];
}) {
  const symbols = Array.from(new Set(input.scores.map(row => String(row.symbol ?? "")).filter(Boolean))).sort();
  return symbols.map(symbol => {
    const all = input.scores.filter(row => String(row.symbol ?? "") === symbol);
    const candidates = all
      .filter(candidateEligible)
      .filter(row => input.allowedDirections.includes(String(row.direction) as Direction))
      .map(row => ({ row, routeStyle: routeStyle(row), marketAffinityScore: affinity(routeStyle(row), input.states) }))
      .filter(row => row.marketAffinityScore > 0);
    const bestScore = candidates.reduce((best, item) => Math.max(best, item.marketAffinityScore), 0);
    // Do not rank ties by historical P&L. The group is immutable evidence for later
    // conditional learning, not an automated winner selection.
    const selected = candidates
      .filter(item => item.marketAffinityScore === bestScore)
      .sort((left, right) => `${left.row.routeGroupId ?? ""}:${left.row.rowId ?? ""}`.localeCompare(`${right.row.routeGroupId ?? ""}:${right.row.rowId ?? ""}`));
    const first = selected[0] ?? null;
    const selectedAlternatives = selected.map(item => ({
      rowId: String(item.row.rowId ?? "") || null,
      canonicalLogic: String(item.row.canonicalLogic ?? "") || null,
      strategyVersion: String(item.row.strategyVersion ?? "") || null,
      routeGroupId: String(item.row.routeGroupId ?? "") || null,
      direction: item.row.direction === "long" || item.row.direction === "short" ? item.row.direction : null,
      routeStyle: item.routeStyle,
      marketAffinityScore: item.marketAffinityScore,
      marketContextEvidenceLevel: item.row.marketContextEvidenceLevel ?? "unavailable",
      marketContextCompletedTrades: finite(item.row.marketContextCompletedTrades),
      marketContextRecent10PnlPer100: finite(item.row.marketContextRecent10PnlPer100),
      marketContextAllPnlPer100: finite(item.row.marketContextAllPnlPer100),
    }));
    return {
      symbol,
      selectedRowId: first?.row.rowId ?? null,
      selectedCanonicalLogic: first?.row.canonicalLogic ?? null,
      selectedStrategyVersion: first?.row.strategyVersion ?? null,
      selectedDirection: first?.row.direction ?? null,
      routeStyle: first?.routeStyle ?? null,
      marketAffinityScore: first?.marketAffinityScore ?? null,
      selectedAlternatives,
      decision: first ? selected.length > 1 ? "selector_shadow_group" : "selector_shadow" : "no_selection",
      reason: first ? "frozen_market_context_route_style_affinity" : input.allowedDirections.length === 0 ? "combined_market_direction_unconfirmed" : all.some(candidateEligible) ? "no_route_style_compatible_with_market_regime" : "no_active_route_candidate",
      unconditionalRecentPnlUsedForSelection: false,
      conditionalRankingApplied: false,
    };
  });
}

function contextKey(checkpoint: ContextCheckpoint, state: string, directions: Direction[]) {
  return `${checkpoint}:${state}:${directions.join("+") || "wait"}`;
}

function buildDecision(input: {
  tradeDate: string;
  sourceId: string;
  checkpoint: ContextCheckpoint;
  intraday: IntradayMarketRegime | null;
  premarket: PremarketMarketRegime | null;
  routeSelectorSnapshot: unknown;
}) {
  const snapshot = stableObject(input.routeSelectorSnapshot);
  const scores = recordArray(snapshot.scores);
  const combined = input.intraday
    ? combinePremarketAndIntraday(input.premarket, input.intraday)
    : {
        state: input.premarket?.allowedDirections[0] ?? "wait",
        confidence: input.premarket?.confidence ?? "unavailable",
        allowedDirections: input.premarket?.allowedDirections ?? [],
        reasonCodes: input.premarket?.allowedDirections?.length ? ["premarket_direction_frozen_before_open"] : ["premarket_direction_unconfirmed"],
      };
  const allowedDirections = combined.allowedDirections.filter((item): item is Direction => item === "long" || item === "short");
  const states = [input.intraday?.state ?? "unavailable", input.premarket?.state ?? "unavailable"];
  const result = {
    version: MARKET_CONTEXT_PERFORMANCE_SELECTOR_VERSION,
    tradeDate: input.tradeDate,
    sourceId: input.sourceId,
    checkpoint: input.checkpoint,
    decisionStage: input.checkpoint === "08:30" ? "premarket_0830_frozen_context" : "intraday_fixed_checkpoint_frozen_context",
    immutable: true,
    monitoringOnly: true,
    formalPerformanceUse: false,
    automaticSelection: false,
    automaticAdoption: false,
    orderInstructionConnection: false,
    selectionPolicy: "frozen_market_context_route_style_affinity_then_parallel_ties",
    historicalPnlRole: "display_and_future_conditional_learning_only",
    unconditionalRecentPnlUsedForSelection: false,
    conditionalRankingApplied: false,
    inputStatus: {
      premarketAvailable: Boolean(input.premarket),
      premarketQuality: input.premarket?.qualityStatus ?? "missing",
      intradayAvailable: Boolean(input.intraday),
      routeSelectorSnapshotPresent: scores.length > 0,
      routeSelectorSnapshotVersion: snapshot.selectorVersion ?? null,
      routeSelectorSnapshotInputHash: snapshot.inputHash ?? null,
    },
    premarketRegime: input.premarket,
    intradayRegime: input.intraday,
    combinedRegime: combined,
    contextKey: contextKey(input.checkpoint, combined.state, allowedDirections),
    selections: selectionForScores({ scores, allowedDirections, states }),
  };
  return { ...result, decisionHash: sha256Stable(result) };
}

export function buildPremarketContextPerformanceSelectorDecision(input: {
  tradeDate: string;
  sourceSnapshotId: string;
  premarketRegime: PremarketMarketRegime;
  routeSelectorSnapshot: unknown;
}) {
  return buildDecision({
    tradeDate: input.tradeDate,
    sourceId: input.sourceSnapshotId,
    checkpoint: "08:30",
    intraday: null,
    premarket: input.premarketRegime,
    routeSelectorSnapshot: input.routeSelectorSnapshot,
  });
}

export function buildIntradayContextPerformanceSelectorDecision(input: {
  tradeDate: string;
  sourceEventId: string;
  checkpoint: Exclude<ContextCheckpoint, "08:30">;
  intradayRegime: IntradayMarketRegime;
  premarketRegime: PremarketMarketRegime | null;
  routeSelectorSnapshot: unknown;
}) {
  return buildDecision({
    tradeDate: input.tradeDate,
    sourceId: input.sourceEventId,
    checkpoint: input.checkpoint,
    intraday: input.intradayRegime,
    premarket: input.premarketRegime,
    routeSelectorSnapshot: input.routeSelectorSnapshot,
  });
}

function dailyPlanStatus(plan: Value) {
  const completedTrades = Math.max(0, Math.trunc(finite(plan.completedTrades) ?? 0));
  const signals = Math.max(0, Math.trunc(finite(plan.signals) ?? 0));
  const openTrades = Math.max(0, Math.trunc(finite(plan.openTrades) ?? 0));
  return completedTrades > 0 ? "observed" as const : signals === 0 ? "no_signal" as const : openTrades > 0 ? "open_trade" as const : "no_completed_trade" as const;
}

export function buildMarketContextPerformanceSnapshot(input: {
  tradeDate: string;
  dailySnapshot: RouteGranularDailySnapshot | null;
  frozenDecisions: unknown[];
}): MarketContextPerformanceSnapshot {
  const plans = input.dailySnapshot?.plans ?? [];
  const planByVersionSide = new Map<string, RouteGranularDailyPlan>();
  for (const plan of plans) {
    if (plan.strategyVersion) planByVersionSide.set(`${plan.strategyVersion}:${plan.direction}`, plan);
  }
  const rows: MarketContextPerformanceRow[] = [];
  for (const rawDecision of input.frozenDecisions) {
    const decision = object(rawDecision);
    const checkpoint = String(decision.checkpoint ?? "") as ContextCheckpoint;
    const combined = object(decision.combinedRegime);
    const directionValues = Array.isArray(combined.allowedDirections)
      ? combined.allowedDirections.filter((item): item is Direction => item === "long" || item === "short")
      : [];
    const decisionSelections = recordArray(decision.selections);
    for (const selection of decisionSelections) {
      for (const alternative of recordArray(selection.selectedAlternatives)) {
        const direction = alternative.direction === "long" || alternative.direction === "short" ? alternative.direction : null;
        const version = typeof alternative.strategyVersion === "string" ? alternative.strategyVersion : null;
        const plan = version && direction ? planByVersionSide.get(`${version}:${direction}`) : null;
        const pnl = finite(plan?.pnlPer100) ?? 0;
        const grossProfit = finite(plan?.grossProfitPer100) ?? 0;
        const grossLoss = finite(plan?.grossLossPer100) ?? 0;
        rows.push({
          contextKey: typeof decision.contextKey === "string" ? decision.contextKey : contextKey(checkpoint, String(combined.state ?? "wait"), directionValues),
          checkpoint,
          combinedState: String(combined.state ?? "wait"),
          allowedDirections: directionValues,
          symbol: String(selection.symbol ?? ""),
          rowId: typeof alternative.rowId === "string" ? alternative.rowId : null,
          canonicalLogic: typeof alternative.canonicalLogic === "string" ? alternative.canonicalLogic : null,
          strategyVersion: version,
          routeGroupId: typeof alternative.routeGroupId === "string" ? alternative.routeGroupId : null,
          direction,
          routeStyle: typeof alternative.routeStyle === "string" ? alternative.routeStyle : null,
          marketAffinityScore: finite(alternative.marketAffinityScore),
          signals: Math.max(0, Math.trunc(finite(plan?.signals) ?? 0)),
          completedTrades: Math.max(0, Math.trunc(finite(plan?.completedTrades) ?? 0)),
          wins: Math.max(0, Math.trunc(finite(plan?.wins) ?? 0)),
          losses: Math.max(0, Math.trunc(finite(plan?.losses) ?? 0)),
          draws: Math.max(0, Math.trunc(finite(plan?.draws) ?? 0)),
          pnlPer100: pnl,
          profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? null : 0,
          status: dailyPlanStatus(plan ? plan as unknown as Value : {}),
        });
      }
    }
  }
  const inputHash = sha256Stable({ tradeDate: input.tradeDate, dailySnapshot: input.dailySnapshot, frozenDecisions: input.frozenDecisions });
  return {
    component: MARKET_CONTEXT_PERFORMANCE_COMPONENT,
    materializationVersion: MARKET_CONTEXT_PERFORMANCE_VERSION,
    tradeDate: input.tradeDate,
    immutable: true,
    monitoringOnly: true,
    formalPerformanceUse: false,
    automaticSelection: false,
    automaticAdoption: false,
    orderInstructionConnection: false,
    inputCutoff: input.tradeDate,
    source: "closed_route_granular_daily_snapshot_and_frozen_v4_context_decisions",
    snapshotReady: Boolean(input.dailySnapshot?.ready),
    reason: input.dailySnapshot?.ready ? null : "route_granular_daily_snapshot_incomplete_or_missing",
    rows,
    summary: {
      contexts: new Set(rows.map(row => row.contextKey)).size,
      selectedAlternatives: rows.length,
      observedTrades: rows.reduce((sum, row) => sum + row.completedTrades, 0),
      pnlPer100: rows.reduce((sum, row) => sum + row.pnlPer100, 0),
    },
    inputHash,
    configHash: MARKET_CONTEXT_PERFORMANCE_CONFIG_HASH,
  };
}

function frozenV4Decisions(rows: Array<{ resultJson: unknown }>): unknown[] {
  return rows.flatMap(row => {
    const result = object(row.resultJson);
    const decision = result.contextPerformanceSelectorV4;
    return decision && typeof decision === "object" ? [decision] : [];
  });
}

/** Called only by the final, bounded audit materializer after route snapshots exist. */
export async function materializeMarketContextPerformanceForDate(input: {
  tradeDate: string;
  sourceDecisionCount: number;
  processedThroughEngineSequence: number;
  frozenMarketEventResults: Array<{ resultJson: unknown }>;
  frozenPremarketResult: unknown | null;
}) {
  const existing = await getRtDailyAuditMaterialization({
    component: MARKET_CONTEXT_PERFORMANCE_COMPONENT,
    version: MARKET_CONTEXT_PERFORMANCE_VERSION,
    tradeDate: input.tradeDate,
  });
  if (existing) return { created: false, result: existing.resultJson };
  const daily = await getRtDailyAuditMaterialization({
    component: ROUTE_GRANULAR_MONITORING_COMPONENT,
    version: ROUTE_GRANULAR_MONITORING_VERSION,
    tradeDate: input.tradeDate,
  });
  const decisions = frozenV4Decisions(input.frozenMarketEventResults);
  const premarketDecision = object(input.frozenPremarketResult).contextPerformanceSelectorV4;
  if (premarketDecision && typeof premarketDecision === "object") decisions.unshift(premarketDecision);
  const result = buildMarketContextPerformanceSnapshot({
    tradeDate: input.tradeDate,
    dailySnapshot: daily?.status === "complete" ? daily.resultJson as RouteGranularDailySnapshot : null,
    frozenDecisions: decisions,
  });
  await upsertRtDailyAuditMaterialization({
    component: MARKET_CONTEXT_PERFORMANCE_COMPONENT,
    version: MARKET_CONTEXT_PERFORMANCE_VERSION,
    tradeDate: input.tradeDate,
    status: result.snapshotReady ? "complete" : "incomplete_source",
    processedThroughEngineSequence: input.processedThroughEngineSequence,
    sourceDecisionCount: input.sourceDecisionCount,
    resultJson: result,
    lastError: result.reason,
    generatedAt: result.snapshotReady ? new Date() : null,
  });
  return { created: true, result };
}

export async function getMarketContextPerformanceHistory(asOfDate: string) {
  const rows = await getRtDailyAuditMaterializationsForRange({
    component: MARKET_CONTEXT_PERFORMANCE_COMPONENT,
    version: MARKET_CONTEXT_PERFORMANCE_VERSION,
    fromDate: ROUTE_GRANULAR_MONITORING_START_DATE,
    toDate: asOfDate,
  });
  return rows.filter(row => row.status === "complete").map(row => row.resultJson as MarketContextPerformanceSnapshot);
}
