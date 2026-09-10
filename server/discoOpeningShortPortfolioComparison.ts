import type { RtForwardShadowTrade, RtSignalCandidate, RtSignalCandidateTrade } from "../drizzle/schema";
import {
  getRtForwardShadowTrades,
  getRtRealtimeDecisionEventsForDate,
  getRtSignalCandidatesForDate,
  getRtSignalCandidateTradesForDate,
} from "./db";
import {
  CURRENT_SIGNAL_CANDIDATE_VERSION,
  CURRENT_SIGNAL_VIRTUAL_ENGINE_VERSION,
} from "./currentSignalCandidateRegistry";
import {
  DISCO_SHORT_BASELINE_VERSION,
  DISCO_SHORT_EXECUTABLE_A_VERSION,
  DISCO_SHORT_RETEST_B_VERSION,
  getRuntimeIdentity,
} from "./runtimeIdentity";
import { FIXED_CONTROL_PRIORITY, PORTFOLIO_MAX_EXPOSURE } from "./portfolioAudit";

export const DISCO_SHORT_PORTFOLIO_COMPONENT = "disco_short_portfolio_comparison";
export const DISCO_SHORT_PORTFOLIO_VERSION = "position-b-10-symbol-891m-v1";

export type DiscoPortfolioScenario = "paused_current" | "paused_baseline" | "executable_a" | "retest_b";
export type DiscoPortfolioOrder = "actual_receipt" | "minute_normalized";

export type DiscoPortfolioAllocation = {
  id: string;
  sourceKind: "current_candidate" | "disco_forward_shadow";
  strategyVersion: string;
  sourceEventId: string;
  exitSourceEventId: string | null;
  symbol: string;
  routeId: string;
  side: "long" | "short";
  entryTime: string;
  exitTime: string | null;
  entrySequence: number | null;
  exitSequence: number | null;
  shares: number;
  requiredMargin: number;
  pnl: number | null;
  completed: boolean;
};

type PortfolioDecision = {
  allocationId: string;
  sourceEventId: string;
  symbol: string;
  routeId: string;
  side: "long" | "short";
  entryTime: string;
  decision: "accepted" | "margin_block" | "symbol_position_block";
  blockerAllocationId: string | null;
  blockerSymbol: string | null;
  marginUsedBefore: number;
  marginUsedAfter: number;
  requiredMargin: number;
};

function priorityFor(symbol: string): number {
  const rank = FIXED_CONTROL_PRIORITY.indexOf(symbol as typeof FIXED_CONTROL_PRIORITY[number]);
  return rank < 0 ? 999 : rank;
}

/**
 * 現行10銘柄候補と6146代替案を、同一銘柄1建玉・総エクスポージャ891万円で比較する。
 * 売買ロジックや注文は呼ばず、既に確定した候補・シャドー取引だけを配分する純粋計算。
 */
export function simulateDiscoShortPortfolio(input: {
  allocations: DiscoPortfolioAllocation[];
  order: DiscoPortfolioOrder;
  maxExposure?: number;
}) {
  const maxExposure = input.maxExposure ?? PORTFOLIO_MAX_EXPOSURE;
  type TimelineItem = { kind: "entry" | "exit"; allocation: DiscoPortfolioAllocation };
  const timeline: TimelineItem[] = [];
  const missingEntrySequence: string[] = [];
  const missingExitSequence: string[] = [];
  const incompleteTrades: string[] = [];
  for (const allocation of input.allocations) {
    if (allocation.entrySequence === null) missingEntrySequence.push(allocation.id);
    if (!allocation.completed) incompleteTrades.push(allocation.id);
    timeline.push({ kind: "entry", allocation });
    if (allocation.completed && allocation.exitTime !== null) {
      if (allocation.exitSequence === null) missingExitSequence.push(allocation.id);
      timeline.push({ kind: "exit", allocation });
    }
  }
  timeline.sort((a, b) => {
    if (input.order === "actual_receipt") {
      const aSequence = a.kind === "entry" ? a.allocation.entrySequence : a.allocation.exitSequence;
      const bSequence = b.kind === "entry" ? b.allocation.entrySequence : b.allocation.exitSequence;
      return (aSequence ?? Number.MAX_SAFE_INTEGER) - (bSequence ?? Number.MAX_SAFE_INTEGER)
        || (a.kind === "exit" ? -1 : 1)
        || a.allocation.id.localeCompare(b.allocation.id);
    }
    const aTime = a.kind === "entry" ? a.allocation.entryTime : a.allocation.exitTime!;
    const bTime = b.kind === "entry" ? b.allocation.entryTime : b.allocation.exitTime!;
    return aTime.localeCompare(bTime)
      || (a.kind === "exit" ? -1 : 1)
      || priorityFor(a.allocation.symbol) - priorityFor(b.allocation.symbol)
      || (a.allocation.entrySequence ?? Number.MAX_SAFE_INTEGER) - (b.allocation.entrySequence ?? Number.MAX_SAFE_INTEGER)
      || a.allocation.id.localeCompare(b.allocation.id);
  });

  const open = new Map<string, DiscoPortfolioAllocation>();
  const openBySymbol = new Map<string, DiscoPortfolioAllocation>();
  const acceptedIds = new Set<string>();
  const decisions: PortfolioDecision[] = [];
  let marginUsed = 0;
  let closed = 0;
  let realizedPnl = 0;
  let maxMarginUsed = 0;
  for (const item of timeline) {
    const allocation = item.allocation;
    if (item.kind === "exit") {
      if (!open.has(allocation.id)) continue;
      marginUsed = Math.max(0, marginUsed - allocation.requiredMargin);
      open.delete(allocation.id);
      if (openBySymbol.get(allocation.symbol)?.id === allocation.id) openBySymbol.delete(allocation.symbol);
      closed += 1;
      realizedPnl += allocation.pnl ?? 0;
      continue;
    }
    const marginBefore = marginUsed;
    const symbolBlocker = openBySymbol.get(allocation.symbol) ?? null;
    const marginBlocker = Array.from(open.values())
      .sort((a, b) => b.requiredMargin - a.requiredMargin || a.id.localeCompare(b.id))[0] ?? null;
    const blockedBySymbol = symbolBlocker !== null;
    const blockedByMargin = !blockedBySymbol && marginUsed + allocation.requiredMargin > maxExposure;
    const blocker = symbolBlocker ?? (blockedByMargin ? marginBlocker : null);
    const decision = blockedBySymbol ? "symbol_position_block" : blockedByMargin ? "margin_block" : "accepted";
    if (decision === "accepted") {
      open.set(allocation.id, allocation);
      openBySymbol.set(allocation.symbol, allocation);
      acceptedIds.add(allocation.id);
      marginUsed += allocation.requiredMargin;
      maxMarginUsed = Math.max(maxMarginUsed, marginUsed);
    }
    decisions.push({
      allocationId: allocation.id,
      sourceEventId: allocation.sourceEventId,
      symbol: allocation.symbol,
      routeId: allocation.routeId,
      side: allocation.side,
      entryTime: allocation.entryTime,
      decision,
      blockerAllocationId: blocker?.id ?? null,
      blockerSymbol: blocker?.symbol ?? null,
      marginUsedBefore: marginBefore,
      marginUsedAfter: marginUsed,
      requiredMargin: allocation.requiredMargin,
    });
  }
  const marginBlocked = decisions.filter(item => item.decision === "margin_block").length;
  const symbolPositionBlocked = decisions.filter(item => item.decision === "symbol_position_block").length;
  const complete = missingEntrySequence.length === 0
    && missingExitSequence.length === 0
    && incompleteTrades.length === 0
    && open.size === 0;
  return {
    order: input.order,
    maxExposure,
    candidates: input.allocations.length,
    accepted: acceptedIds.size,
    marginBlocked,
    symbolPositionBlocked,
    closed,
    realizedPnl,
    maxMarginUsed,
    openAtEnd: open.size,
    complete,
    missingEntrySequence,
    missingExitSequence,
    incompleteTrades,
    decisions,
  };
}

function currentAllocation(input: {
  candidate: RtSignalCandidate;
  trade: RtSignalCandidateTrade | null;
  exitSequence: number | null;
}): DiscoPortfolioAllocation {
  const { candidate, trade } = input;
  const completed = Boolean(trade?.completed && trade.exitSourceEventId && trade.exitCandleTime && trade.exitPrice !== null);
  const signalQualityShares = Math.max(1, trade?.shares ?? candidate.signalQualityShares);
  const pnl = completed && trade?.pnl !== null && trade?.pnl !== undefined
    ? Math.round(Number(trade.pnl) * candidate.capitalShares / signalQualityShares)
    : null;
  return {
    id: `current:${candidate.id}`,
    sourceKind: "current_candidate",
    strategyVersion: candidate.candidateVersion,
    sourceEventId: candidate.sourceEventId,
    exitSourceEventId: trade?.exitSourceEventId ?? null,
    symbol: candidate.symbol,
    routeId: candidate.routeId,
    side: candidate.side,
    entryTime: candidate.candleTime,
    exitTime: trade?.exitCandleTime ?? null,
    entrySequence: candidate.engineSequence,
    exitSequence: input.exitSequence,
    shares: candidate.capitalShares,
    requiredMargin: Math.round(Number(candidate.requiredMargin)),
    pnl,
    completed,
  };
}

function shadowAllocation(input: {
  trade: RtForwardShadowTrade;
  entrySequence: number | null;
  exitSequence: number | null;
}): DiscoPortfolioAllocation {
  const { trade } = input;
  const completed = Boolean(trade.closedAt && trade.exitSourceEventId && trade.exitCandleTime && trade.exitPrice !== null && trade.pnl !== null);
  return {
    id: `shadow:${trade.strategyVersion}:${trade.id}`,
    sourceKind: "disco_forward_shadow",
    strategyVersion: trade.strategyVersion,
    sourceEventId: trade.entrySourceEventId,
    exitSourceEventId: trade.exitSourceEventId,
    symbol: trade.symbol,
    routeId: "discoOpeningBreakShort",
    side: trade.side,
    entryTime: trade.entryCandleTime,
    exitTime: trade.exitCandleTime,
    entrySequence: input.entrySequence,
    exitSequence: input.exitSequence,
    shares: trade.shares,
    requiredMargin: Math.round(Number(trade.entryPrice) * trade.shares),
    pnl: completed ? Number(trade.pnl) : null,
    completed,
  };
}

export async function buildDiscoShortPortfolioComparisonForDate(tradeDate: string) {
  const identity = getRuntimeIdentity();
  const activeSymbols = new Set(identity.activeEntrySymbols);
  const [candidates, candidateTrades, decisions, baselineTrades, executableTrades, retestTrades] = await Promise.all([
    getRtSignalCandidatesForDate({ candidateVersion: CURRENT_SIGNAL_CANDIDATE_VERSION, tradeDate }),
    getRtSignalCandidateTradesForDate({ virtualEngineVersion: CURRENT_SIGNAL_VIRTUAL_ENGINE_VERSION, tradeDate }),
    getRtRealtimeDecisionEventsForDate(tradeDate),
    getRtForwardShadowTrades(DISCO_SHORT_BASELINE_VERSION),
    getRtForwardShadowTrades(DISCO_SHORT_EXECUTABLE_A_VERSION),
    getRtForwardShadowTrades(DISCO_SHORT_RETEST_B_VERSION),
  ]);
  const sequenceBySource = new Map(decisions.map(event => [event.sourceEventId, event.id]));
  const tradeByCandidate = new Map(candidateTrades.map(trade => [trade.candidateId, trade]));
  const base = candidates
    .filter(candidate => activeSymbols.has(candidate.symbol))
    .filter(candidate => !(candidate.symbol === "6146" && candidate.routeId === "discoOpeningBreakShort"))
    .map(candidate => {
      const trade = tradeByCandidate.get(candidate.id) ?? null;
      return currentAllocation({
        candidate,
        trade,
        exitSequence: trade?.exitSourceEventId ? sequenceBySource.get(trade.exitSourceEventId) ?? null : null,
      });
    });
  const toOverlay = (trades: RtForwardShadowTrade[]) => trades
    .filter(trade => trade.evaluationMode === "capital_constrained" && trade.entryTradeDate === tradeDate)
    .map(trade => shadowAllocation({
      trade,
      entrySequence: sequenceBySource.get(trade.entrySourceEventId) ?? null,
      exitSequence: trade.exitSourceEventId ? sequenceBySource.get(trade.exitSourceEventId) ?? null : null,
    }));
  const scenarios: Record<DiscoPortfolioScenario, DiscoPortfolioAllocation[]> = {
    paused_current: base,
    paused_baseline: [...base, ...toOverlay(baselineTrades)],
    executable_a: [...base, ...toOverlay(executableTrades)],
    retest_b: [...base, ...toOverlay(retestTrades)],
  };
  return {
    component: DISCO_SHORT_PORTFOLIO_COMPONENT,
    version: DISCO_SHORT_PORTFOLIO_VERSION,
    tradeDate,
    semantics: {
      base: "current_10_symbol_candidates_with_6146_opening_short_removed",
      overlays: "capital_constrained_forward_shadow_trades",
      sameSymbolPolicy: "first_open_position_blocks_later_entry",
      actualReceiptOrder: "realtime_engine_sequence",
      normalizedOrder: "exit_first_then_fixed_symbol_priority",
      maxExposure: PORTFOLIO_MAX_EXPOSURE,
      automaticAdoption: false,
      orderInstructionConnection: false,
    },
    scenarios: Object.fromEntries(Object.entries(scenarios).map(([scenario, allocations]) => [scenario, {
      actualReceipt: simulateDiscoShortPortfolio({ allocations, order: "actual_receipt" }),
      minuteNormalized: simulateDiscoShortPortfolio({ allocations, order: "minute_normalized" }),
    }])) as Record<DiscoPortfolioScenario, {
      actualReceipt: ReturnType<typeof simulateDiscoShortPortfolio>;
      minuteNormalized: ReturnType<typeof simulateDiscoShortPortfolio>;
    }>,
  };
}
