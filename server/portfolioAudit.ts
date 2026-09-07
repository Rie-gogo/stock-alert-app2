import type { RtRealtimeDecisionEvent } from "../drizzle/schema";
import {
  getRtCandidateVirtualGapsForDate,
  getRtPortfolioMaterializationProgress,
  getRtRealtimeDecisionEventsForDate,
  getRtSignalCandidatesForDate,
  getRtSignalCandidateTradesForDate,
  upsertRtDailyAuditMaterialization,
  upsertRtPortfolioMaterializationProgress,
  upsertRtPortfolioAuditEvent,
} from "./db";
import { getRuntimeIdentity } from "./runtimeIdentity";
import {
  CURRENT_SIGNAL_CANDIDATE_VERSION,
  CURRENT_SIGNAL_VIRTUAL_ENGINE_VERSION,
} from "./currentSignalCandidateRegistry";
import { sha256Stable } from "./runtimeIdentity";
import type { RtSignalCandidate, RtSignalCandidateTrade } from "../drizzle/schema";

export const CURRENT_PORTFOLIO_AUDIT_VERSION = "current-10-symbol-891m-receipt-order-v1";
export const NORMALIZED_PORTFOLIO_AUDIT_VERSION = "current-10-symbol-891m-minute-priority-v1";
export const ALL_CANDIDATE_RECEIPT_PORTFOLIO_VERSION = "current-10-symbol-891m-all-candidates-receipt-v2";
export const ALL_CANDIDATE_MINUTE_PORTFOLIO_VERSION = "current-10-symbol-891m-all-candidates-minute-v2";
export const PORTFOLIO_MATERIALIZATION_VERSION = "portfolio-materialization-p0-v1";
export const PORTFOLIO_BUNDLE_COMPONENT = "portfolio_bundle";
export const PORTFOLIO_MAX_EXPOSURE = 8_910_000;
const FIXED_CONTROL_PRIORITY = ["285A", "6146", "6857", "8035", "5803", "6981", "6976", "6526", "3436", "9984"] as const;

type AuditResultJson = {
  result?: { action?: string };
  trade?: {
    price?: string | number;
    shares?: number;
    amount?: number;
    reason?: string;
  };
};

type OpenAllocation = {
  symbol: string;
  sourceEventId: string;
  requiredMargin: number;
};

function resultJson(event: RtRealtimeDecisionEvent): AuditResultJson {
  return event.resultJson && typeof event.resultJson === "object"
    ? event.resultJson as AuditResultJson
    : {};
}

function isMarginBlock(event: RtRealtimeDecisionEvent): boolean {
  return /margin|証拠金/i.test(`${event.reason ?? ""} ${JSON.stringify(event.resultJson ?? {})}`);
}

function requiredMarginFor(event: RtRealtimeDecisionEvent): number | null {
  const trade = resultJson(event).trade;
  if (trade?.amount !== undefined && trade.amount !== null) return Math.round(Number(trade.amount));
  if (event.amount !== null && event.amount !== undefined) return Math.round(Number(event.amount));
  const price = Number(event.simulatedBarFillPrice ?? event.signalReferencePrice ?? 0);
  if (!(price > 0)) return null;
  const shares = event.shares && event.shares > 0
    ? event.shares
    : Math.max(100, Math.floor((3_000_000 * 0.9) / price / 100) * 100);
  return Math.round(price * shares);
}

function chooseBlocker(open: Map<string, OpenAllocation>): OpenAllocation | null {
  return Array.from(open.values()).sort((a, b) =>
    b.requiredMargin - a.requiredMargin || a.sourceEventId.localeCompare(b.sourceEventId))[0] ?? null;
}

/**
 * 現行実時エンジンが処理したengineSequence順をそのまま使う監査版。
 * 売買判断を再計算せず、現行監査台帳の採用・決済・margin_blockを共有891万円の履歴として写す。
 */
export async function buildActualReceiptPortfolioAuditForDate(tradeDate: string) {
  const identity = getRuntimeIdentity();
  const targetSymbols = new Set(identity.activeEntrySymbols);
  const events = (await getRtRealtimeDecisionEventsForDate(tradeDate))
    .filter(event => targetSymbols.has(event.symbol));
  const open = new Map<string, OpenAllocation>();
  let accepted = 0;
  let marginBlocked = 0;
  let closed = 0;
  let notCandidate = 0;
  let marginStateMismatches = 0;

  for (const event of events) {
    const reconstructedMarginBefore = Array.from(open.values()).reduce((sum, item) => sum + item.requiredMargin, 0);
    const json = resultJson(event);
    const action = json.result?.action ?? "none";
    let decision: "accepted" | "margin_block" | "not_candidate" | "closed" = "not_candidate";
    const requiredMargin = requiredMarginFor(event);
    let blocker: OpenAllocation | null = null;

    if (event.resultType === "entry" || action === "entry") {
      decision = "accepted";
      accepted += 1;
      if (requiredMargin !== null) {
        open.set(event.symbol, {
          symbol: event.symbol,
          sourceEventId: event.sourceEventId,
          requiredMargin,
        });
      }
    } else if (event.resultType === "exit" || ["exit", "stop_loss", "take_profit", "forced_close"].includes(action)) {
      decision = "closed";
      closed += 1;
      open.delete(event.symbol);
    } else if (isMarginBlock(event)) {
      decision = "margin_block";
      marginBlocked += 1;
      blocker = chooseBlocker(open);
    } else {
      notCandidate += 1;
    }

    const reconstructedMarginAfter = Array.from(open.values()).reduce((sum, item) => sum + item.requiredMargin, 0);
    const reportedMarginBefore = event.marginUsedBefore ?? reconstructedMarginBefore;
    const reportedMarginAfter = event.marginUsedAfter ?? reconstructedMarginAfter;
    const marginBeforeMatched = Math.abs(reportedMarginBefore - reconstructedMarginBefore) <= 1;
    const marginAfterMatched = Math.abs(reportedMarginAfter - reconstructedMarginAfter) <= 1;
    if (!marginBeforeMatched || !marginAfterMatched) marginStateMismatches += 1;
    await upsertRtPortfolioAuditEvent({
      portfolioVersion: CURRENT_PORTFOLIO_AUDIT_VERSION,
      mode: "actual_receipt",
      generation: 1,
      sourceEventId: event.sourceEventId,
      tradeDate,
      candleTime: event.candleTime,
      batchKey: `${tradeDate}:${event.candleTime}`,
      symbol: event.symbol,
      routeId: event.routeId,
      side: event.side,
      priorityRank: event.id,
      decision,
      shares: event.shares,
      requiredMargin,
      marginUsedBefore: reportedMarginBefore,
      marginUsedAfter: reportedMarginAfter,
      blockerSourceEventId: blocker?.sourceEventId ?? null,
      blockerSymbol: blocker?.symbol ?? null,
      detailJson: {
        engineSequence: event.id,
        sourceEventDbId: event.sourceEventDbId,
        sourceEventId: event.sourceEventId,
        auditResultType: event.resultType,
        action,
        reportedMarginUsedBefore: event.marginUsedBefore,
        reportedMarginUsedAfter: event.marginUsedAfter,
        reconstructedMarginBefore,
        reconstructedMarginAfter,
        marginBeforeMatched,
        marginAfterMatched,
        reconstructedOpenSymbols: Array.from(open.keys()).sort(),
        portfolioMaxExposure: PORTFOLIO_MAX_EXPOSURE,
      },
    });
  }

  return {
    portfolioVersion: CURRENT_PORTFOLIO_AUDIT_VERSION,
    tradeDate,
    processed: events.length,
    accepted,
    marginBlocked,
    closed,
    notCandidate,
    marginStateMismatches,
    openAtEnd: Array.from(open.values()).sort((a, b) => a.symbol.localeCompare(b.symbol)),
    maxExposure: PORTFOLIO_MAX_EXPOSURE,
  };
}

function fixedPriority(event: RtRealtimeDecisionEvent): number {
  const symbolRank = FIXED_CONTROL_PRIORITY.indexOf(event.symbol as typeof FIXED_CONTROL_PRIORITY[number]);
  return (symbolRank < 0 ? 999 : symbolRank) * 10_000 + event.id;
}

/**
 * 同一分に現れた「実採用または証拠金拒否」候補だけを固定順へ並べ替える局所反実仮想。
 * margin_block候補の仮想exitが未収録の段階では日跨ぎの代替portfolio損益を計算せず、
 * blocker→blocked辺と候補集合の欠損を診断するためだけに使う。
 */
export async function buildMinuteNormalizedPortfolioAuditForDate(tradeDate: string) {
  const identity = getRuntimeIdentity();
  const targetSymbols = new Set(identity.activeEntrySymbols);
  const events = (await getRtRealtimeDecisionEventsForDate(tradeDate))
    .filter(event => targetSymbols.has(event.symbol));
  const candidateEvents = events.filter(event => event.resultType === "entry" || isMarginBlock(event));
  const groups = new Map<string, RtRealtimeDecisionEvent[]>();
  for (const event of candidateEvents) {
    const key = `${tradeDate}:${event.candleTime}`;
    groups.set(key, [...(groups.get(key) ?? []), event]);
  }

  let accepted = 0;
  let marginBlocked = 0;
  let incompleteCandidates = 0;
  const blockEdges: Array<{ blockerSourceEventId: string; blockedSourceEventId: string }> = [];
  for (const [batchKey, group] of Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b))) {
    const ordered = [...group].sort((a, b) => fixedPriority(a) - fixedPriority(b));
    const batchBaseMargin = Math.max(0, Math.min(...ordered.map(event => event.marginUsedBefore ?? 0)));
    let allocatedInBatch = 0;
    const batchAccepted: OpenAllocation[] = [];
    for (let index = 0; index < ordered.length; index += 1) {
      const event = ordered[index];
      const requiredMargin = requiredMarginFor(event);
      const canAllocate = requiredMargin !== null
        && batchBaseMargin + allocatedInBatch + requiredMargin <= PORTFOLIO_MAX_EXPOSURE;
      const blocker = canAllocate ? null : chooseBlocker(new Map(batchAccepted.map(item => [item.symbol, item])));
      const decision = requiredMargin === null
        ? "missing" as const
        : canAllocate
          ? "accepted" as const
          : "margin_block" as const;
      if (decision === "accepted") {
        accepted += 1;
        allocatedInBatch += requiredMargin!;
        batchAccepted.push({
          symbol: event.symbol,
          sourceEventId: event.sourceEventId,
          requiredMargin: requiredMargin!,
        });
      } else if (decision === "margin_block") {
        marginBlocked += 1;
        if (blocker) blockEdges.push({ blockerSourceEventId: blocker.sourceEventId, blockedSourceEventId: event.sourceEventId });
      } else {
        incompleteCandidates += 1;
      }
      await upsertRtPortfolioAuditEvent({
        portfolioVersion: NORMALIZED_PORTFOLIO_AUDIT_VERSION,
        mode: "minute_normalized",
        generation: 1,
        sourceEventId: event.sourceEventId,
        tradeDate,
        candleTime: event.candleTime,
        batchKey,
        symbol: event.symbol,
        routeId: event.routeId,
        side: event.side,
        priorityRank: index + 1,
        decision,
        shares: event.shares,
        requiredMargin,
        marginUsedBefore: batchBaseMargin + allocatedInBatch - (decision === "accepted" ? requiredMargin! : 0),
        marginUsedAfter: batchBaseMargin + allocatedInBatch,
        blockerSourceEventId: blocker?.sourceEventId ?? null,
        blockerSymbol: blocker?.symbol ?? null,
        detailJson: {
          engineSequence: event.id,
          fixedPriority: fixedPriority(event),
          priorityRule: FIXED_CONTROL_PRIORITY,
          candidateSet: ordered.map(item => ({
            sourceEventId: item.sourceEventId,
            symbol: item.symbol,
            routeId: item.routeId,
            engineSequence: item.id,
          })),
          scope: "same_minute_local_counterfactual",
          hypotheticalExitCoverage: isMarginBlock(event) ? "missing_for_margin_blocked_candidate" : "actual_only",
          eligibleForPortfolioPnlComparison: false,
          note: "10銘柄の全発火仮想exitが揃うまではblocker因果診断専用",
        },
      });
    }
  }

  return {
    portfolioVersion: NORMALIZED_PORTFOLIO_AUDIT_VERSION,
    tradeDate,
    candidateBatches: groups.size,
    candidates: candidateEvents.length,
    accepted,
    marginBlocked,
    incompleteCandidates,
    blockEdges,
    priorityRule: FIXED_CONTROL_PRIORITY,
    scope: "same_minute_local_counterfactual" as const,
    eligibleForPortfolioPnlComparison: false,
  };
}

type CandidateAllocation = {
  candidate: RtSignalCandidate;
  trade: RtSignalCandidateTrade | null;
  requiredMargin: number;
  blocker: CandidateAllocation | null;
};

function candidateRequiredMargin(candidate: RtSignalCandidate): number {
  const recorded = Number(candidate.requiredMargin);
  if (Number.isFinite(recorded) && recorded > 0) return Math.round(recorded);
  return Math.round(Number(candidate.theoreticalEntryPrice) * candidate.capitalShares);
}

function hasCompleteVirtualExit(trade: RtSignalCandidateTrade | null): trade is RtSignalCandidateTrade {
  return Boolean(trade?.completed && trade.exitSourceEventId && trade.exitCandleTime && trade.exitPrice !== null);
}

function virtualPnlAtCapital(candidate: RtSignalCandidate, trade: RtSignalCandidateTrade | null): number | null {
  if (!trade?.completed || trade.pnl === null || trade.pnl === undefined) return null;
  return Math.round(Number(trade.pnl) * (candidate.capitalShares / Math.max(1, trade.shares)));
}

function exitAuditSourceId(trade: RtSignalCandidateTrade): string {
  return `virtual-exit:${sha256Stable({
    candidateId: trade.candidateId,
    exitSourceEventId: trade.exitSourceEventId,
  }).slice(0, 48)}`;
}

async function persistCandidatePortfolioDecision(input: {
  version: string;
  mode: "actual_receipt" | "minute_normalized";
  generation: number;
  allocation: CandidateAllocation;
  decision: "accepted" | "margin_block" | "symbol_position_block";
  marginBefore: number;
  marginAfter: number;
  priorityRank: number;
  batchKey: string;
  reason: string;
}) {
  const { candidate, trade, requiredMargin, blocker } = input.allocation;
  await upsertRtPortfolioAuditEvent({
    portfolioVersion: input.version,
    mode: input.mode,
    generation: input.generation,
    sourceEventId: candidate.sourceEventId,
    tradeDate: candidate.tradeDate,
    candleTime: candidate.candleTime,
    batchKey: input.batchKey,
    symbol: candidate.symbol,
    routeId: candidate.routeId,
    side: candidate.side,
    priorityRank: input.priorityRank,
    decision: input.decision,
    shares: candidate.capitalShares,
    requiredMargin,
    marginUsedBefore: input.marginBefore,
    marginUsedAfter: input.marginAfter,
    blockerSourceEventId: blocker?.candidate.sourceEventId ?? null,
    blockerSymbol: blocker?.candidate.symbol ?? null,
    detailJson: {
      candidateId: candidate.id,
      candidateVersion: candidate.candidateVersion,
      virtualEngineVersion: CURRENT_SIGNAL_VIRTUAL_ENGINE_VERSION,
      realtimeDecision: candidate.realtimeDecision,
      signalQualityPnl100: trade?.pnl ?? null,
      capitalPnl: virtualPnlAtCapital(candidate, trade),
      virtualExitComplete: Boolean(trade?.completed),
      virtualExitSourceEventId: trade?.exitSourceEventId ?? null,
      allocationReason: input.reason,
      eligibleForPortfolioPnlComparison: hasCompleteVirtualExit(trade),
      maxExposure: PORTFOLIO_MAX_EXPOSURE,
    },
  });
}

async function persistCandidatePortfolioExit(input: {
  version: string;
  mode: "actual_receipt" | "minute_normalized";
  generation: number;
  allocation: CandidateAllocation;
  marginBefore: number;
  marginAfter: number;
  priorityRank: number;
  batchKey: string;
}) {
  const trade = input.allocation.trade;
  if (!trade?.exitSourceEventId || !trade.exitCandleTime) return;
  await upsertRtPortfolioAuditEvent({
    portfolioVersion: input.version,
    mode: input.mode,
    generation: input.generation,
    sourceEventId: exitAuditSourceId(trade),
    tradeDate: trade.exitTradeDate ?? trade.tradeDate,
    candleTime: trade.exitCandleTime,
    batchKey: input.batchKey,
    symbol: trade.symbol,
    routeId: trade.routeId,
    side: trade.side,
    priorityRank: input.priorityRank,
    decision: "closed",
    shares: input.allocation.candidate.capitalShares,
    requiredMargin: input.allocation.requiredMargin,
    marginUsedBefore: input.marginBefore,
    marginUsedAfter: input.marginAfter,
    blockerSourceEventId: null,
    blockerSymbol: null,
    detailJson: {
      candidateId: trade.candidateId,
      virtualExitSourceEventId: trade.exitSourceEventId,
      virtualExitReason: trade.exitReason,
      signalQualityPnl100: trade.pnl,
      capitalPnl: virtualPnlAtCapital(input.allocation.candidate, trade),
      eligibleForPortfolioPnlComparison: true,
    },
  });
}

async function loadAllCandidateInputs(tradeDate: string) {
  const candidates = await getRtSignalCandidatesForDate({
    candidateVersion: CURRENT_SIGNAL_CANDIDATE_VERSION,
    tradeDate,
  });
  const trades = await getRtSignalCandidateTradesForDate({
    virtualEngineVersion: CURRENT_SIGNAL_VIRTUAL_ENGINE_VERSION,
    tradeDate,
  });
  const tradeByCandidate = new Map(trades.map(trade => [trade.candidateId, trade]));
  return candidates.map(candidate => ({
    candidate,
    trade: tradeByCandidate.get(candidate.id) ?? null,
    requiredMargin: candidateRequiredMargin(candidate),
    blocker: null,
  } satisfies CandidateAllocation));
}

/** 全candidateを現行engineSequence順で再配分し、仮想exitで証拠金を解放する正式portfolio v2。 */
export async function buildAllCandidateReceiptPortfolioForDate(tradeDate: string) {
  const allocations = await loadAllCandidateInputs(tradeDate);
  const decisions = await getRtRealtimeDecisionEventsForDate(tradeDate);
  const sequenceBySource = new Map(decisions.map(event => [event.sourceEventId, event.id]));
  const allocationsMissingExitSequence = new Set<number>();
  type TimelineItem = { sequence: number; kind: "entry" | "exit"; allocation: CandidateAllocation };
  const timeline: TimelineItem[] = [];
  for (const allocation of allocations) {
    timeline.push({ sequence: allocation.candidate.engineSequence, kind: "entry", allocation });
    const exitSource = allocation.trade?.exitSourceEventId;
    const exitSequence = exitSource ? sequenceBySource.get(exitSource) : null;
    if (exitSequence !== null && exitSequence !== undefined) {
      timeline.push({ sequence: exitSequence, kind: "exit", allocation });
    } else if (hasCompleteVirtualExit(allocation.trade)) {
      allocationsMissingExitSequence.add(allocation.candidate.id);
    }
  }
  timeline.sort((a, b) => a.sequence - b.sequence || (a.kind === "exit" ? -1 : 1));

  const open = new Map<number, CandidateAllocation>();
  const openBySymbol = new Map<string, CandidateAllocation>();
  let marginUsed = 0;
  let accepted = 0;
  let marginBlocked = 0;
  let symbolPositionBlocked = 0;
  let closed = 0;
  let realizedPnl = 0;
  const blockEdges: Array<{ blockerSourceEventId: string; blockedSourceEventId: string }> = [];

  for (const item of timeline) {
    const allocation = item.allocation;
    if (item.kind === "exit") {
      if (!open.has(allocation.candidate.id)) continue;
      const before = marginUsed;
      marginUsed = Math.max(0, marginUsed - allocation.requiredMargin);
      open.delete(allocation.candidate.id);
      if (openBySymbol.get(allocation.candidate.symbol)?.candidate.id === allocation.candidate.id) {
        openBySymbol.delete(allocation.candidate.symbol);
      }
      closed += 1;
      realizedPnl += virtualPnlAtCapital(allocation.candidate, allocation.trade) ?? 0;
      await persistCandidatePortfolioExit({
        version: ALL_CANDIDATE_RECEIPT_PORTFOLIO_VERSION,
        mode: "actual_receipt",
        generation: 1,
        allocation,
        marginBefore: before,
        marginAfter: marginUsed,
        priorityRank: item.sequence,
        batchKey: `${tradeDate}:${allocation.trade?.exitCandleTime ?? "unknown"}`,
      });
      continue;
    }

    const openValues = Array.from(open.values());
    const symbolBlocker = openBySymbol.get(allocation.candidate.symbol) ?? null;
    const marginBlocker = openValues.sort((a, b) => b.requiredMargin - a.requiredMargin)[0] ?? null;
    const blocker = symbolBlocker ?? marginBlocker;
    allocation.blocker = blocker;
    const blockedBySymbol = symbolBlocker !== null;
    const blockedByMargin = !blockedBySymbol
      && marginUsed + allocation.requiredMargin > PORTFOLIO_MAX_EXPOSURE;
    const canAllocate = !blockedBySymbol && !blockedByMargin;
    const before = marginUsed;
    if (canAllocate) {
      open.set(allocation.candidate.id, allocation);
      openBySymbol.set(allocation.candidate.symbol, allocation);
      marginUsed += allocation.requiredMargin;
      accepted += 1;
    } else if (blockedBySymbol) {
      symbolPositionBlocked += 1;
      if (blocker) blockEdges.push({
        blockerSourceEventId: blocker.candidate.sourceEventId,
        blockedSourceEventId: allocation.candidate.sourceEventId,
      });
    } else {
      marginBlocked += 1;
      if (blocker) blockEdges.push({
        blockerSourceEventId: blocker.candidate.sourceEventId,
        blockedSourceEventId: allocation.candidate.sourceEventId,
      });
    }
    await persistCandidatePortfolioDecision({
      version: ALL_CANDIDATE_RECEIPT_PORTFOLIO_VERSION,
      mode: "actual_receipt",
      generation: 1,
      allocation,
      decision: canAllocate ? "accepted" : blockedBySymbol ? "symbol_position_block" : "margin_block",
      marginBefore: before,
      marginAfter: marginUsed,
      priorityRank: item.sequence,
      batchKey: `${tradeDate}:${allocation.candidate.candleTime}`,
      reason: canAllocate ? "engine_sequence_allocation" : blockedBySymbol ? "same_symbol_position_open" : "891m_limit",
    });
  }

  return {
    portfolioVersion: ALL_CANDIDATE_RECEIPT_PORTFOLIO_VERSION,
    tradeDate,
    candidates: allocations.length,
    accepted,
    marginBlocked,
    symbolPositionBlocked,
    closed,
    realizedPnl,
    openAtEnd: open.size,
    blockEdges,
    eligibleForPortfolioPnlComparison: allocations.every(item => hasCompleteVirtualExit(item.trade))
      && allocationsMissingExitSequence.size === 0,
  };
}

/** 同一分はexit先行・固定銘柄優先で全candidateを再配分する日次確定portfolio v2。 */
export async function buildAllCandidateMinutePortfolioForDate(tradeDate: string) {
  const allocations = await loadAllCandidateInputs(tradeDate);
  const groups = new Map<string, { entries: CandidateAllocation[]; exits: CandidateAllocation[] }>();
  for (const allocation of allocations) {
    const entryKey = allocation.candidate.candleTime;
    const entryGroup = groups.get(entryKey) ?? { entries: [], exits: [] };
    entryGroup.entries.push(allocation);
    groups.set(entryKey, entryGroup);
    const exitTime = allocation.trade?.exitCandleTime;
    if (exitTime && (allocation.trade?.exitTradeDate ?? tradeDate) === tradeDate) {
      const exitGroup = groups.get(exitTime) ?? { entries: [], exits: [] };
      exitGroup.exits.push(allocation);
      groups.set(exitTime, exitGroup);
    }
  }

  const open = new Map<number, CandidateAllocation>();
  const openBySymbol = new Map<string, CandidateAllocation>();
  let marginUsed = 0;
  let accepted = 0;
  let marginBlocked = 0;
  let symbolPositionBlocked = 0;
  let closed = 0;
  let realizedPnl = 0;
  const blockEdges: Array<{ blockerSourceEventId: string; blockedSourceEventId: string }> = [];
  let priorityCounter = 0;

  for (const [candleTime, group] of Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b))) {
    for (const allocation of group.exits.sort((a, b) => a.candidate.engineSequence - b.candidate.engineSequence)) {
      if (!open.has(allocation.candidate.id)) continue;
      const before = marginUsed;
      marginUsed = Math.max(0, marginUsed - allocation.requiredMargin);
      open.delete(allocation.candidate.id);
      if (openBySymbol.get(allocation.candidate.symbol)?.candidate.id === allocation.candidate.id) {
        openBySymbol.delete(allocation.candidate.symbol);
      }
      closed += 1;
      realizedPnl += virtualPnlAtCapital(allocation.candidate, allocation.trade) ?? 0;
      priorityCounter += 1;
      await persistCandidatePortfolioExit({
        version: ALL_CANDIDATE_MINUTE_PORTFOLIO_VERSION,
        mode: "minute_normalized",
        generation: 1,
        allocation,
        marginBefore: before,
        marginAfter: marginUsed,
        priorityRank: priorityCounter,
        batchKey: `${tradeDate}:${candleTime}`,
      });
    }
    const entries = [...group.entries].sort((a, b) => {
      const aRank = FIXED_CONTROL_PRIORITY.indexOf(a.candidate.symbol as typeof FIXED_CONTROL_PRIORITY[number]);
      const bRank = FIXED_CONTROL_PRIORITY.indexOf(b.candidate.symbol as typeof FIXED_CONTROL_PRIORITY[number]);
      return (aRank < 0 ? 999 : aRank) - (bRank < 0 ? 999 : bRank)
        || a.candidate.engineSequence - b.candidate.engineSequence;
    });
    for (const allocation of entries) {
      const symbolBlocker = openBySymbol.get(allocation.candidate.symbol) ?? null;
      const marginBlocker = Array.from(open.values()).sort((a, b) => b.requiredMargin - a.requiredMargin)[0] ?? null;
      const blocker = symbolBlocker ?? marginBlocker;
      allocation.blocker = blocker;
      const before = marginUsed;
      const blockedBySymbol = symbolBlocker !== null;
      const blockedByMargin = !blockedBySymbol
        && marginUsed + allocation.requiredMargin > PORTFOLIO_MAX_EXPOSURE;
      const canAllocate = !blockedBySymbol && !blockedByMargin;
      if (canAllocate) {
        open.set(allocation.candidate.id, allocation);
        openBySymbol.set(allocation.candidate.symbol, allocation);
        marginUsed += allocation.requiredMargin;
        accepted += 1;
      } else if (blockedBySymbol) {
        symbolPositionBlocked += 1;
        if (blocker) blockEdges.push({
          blockerSourceEventId: blocker.candidate.sourceEventId,
          blockedSourceEventId: allocation.candidate.sourceEventId,
        });
      } else {
        marginBlocked += 1;
        if (blocker) blockEdges.push({
          blockerSourceEventId: blocker.candidate.sourceEventId,
          blockedSourceEventId: allocation.candidate.sourceEventId,
        });
      }
      priorityCounter += 1;
      await persistCandidatePortfolioDecision({
        version: ALL_CANDIDATE_MINUTE_PORTFOLIO_VERSION,
        mode: "minute_normalized",
        generation: 1,
        allocation,
        decision: canAllocate ? "accepted" : blockedBySymbol ? "symbol_position_block" : "margin_block",
        marginBefore: before,
        marginAfter: marginUsed,
        priorityRank: priorityCounter,
        batchKey: `${tradeDate}:${candleTime}`,
        reason: canAllocate ? "exit_first_fixed_symbol_priority" : blockedBySymbol ? "same_symbol_position_open" : "891m_limit",
      });
    }
  }

  return {
    portfolioVersion: ALL_CANDIDATE_MINUTE_PORTFOLIO_VERSION,
    tradeDate,
    candidates: allocations.length,
    accepted,
    marginBlocked,
    symbolPositionBlocked,
    closed,
    realizedPnl,
    openAtEnd: open.size,
    blockEdges,
    priorityRule: FIXED_CONTROL_PRIORITY,
    eligibleForPortfolioPnlComparison: allocations.every(item => hasCompleteVirtualExit(item.trade)),
  };
}

type MaterializedPortfolioState = {
  accepted: number;
  marginBlocked: number;
  symbolPositionBlocked: number;
  closed: number;
  realizedPnl: number;
  blockEdges: Array<{ blockerSourceEventId: string; blockedSourceEventId: string }>;
  processedTimelineItems: number;
  lastProcessedMinute: string | null;
};

const EMPTY_MATERIALIZED_STATE: MaterializedPortfolioState = {
  accepted: 0,
  marginBlocked: 0,
  symbolPositionBlocked: 0,
  closed: 0,
  realizedPnl: 0,
  blockEdges: [],
  processedTimelineItems: 0,
  lastProcessedMinute: null,
};

function parseMaterializedState(value: unknown): MaterializedPortfolioState {
  if (!value || typeof value !== "object") return structuredClone(EMPTY_MATERIALIZED_STATE);
  const raw = value as Partial<MaterializedPortfolioState>;
  return {
    accepted: Number(raw.accepted ?? 0),
    marginBlocked: Number(raw.marginBlocked ?? 0),
    symbolPositionBlocked: Number(raw.symbolPositionBlocked ?? 0),
    closed: Number(raw.closed ?? 0),
    realizedPnl: Number(raw.realizedPnl ?? 0),
    blockEdges: Array.isArray(raw.blockEdges) ? raw.blockEdges : [],
    processedTimelineItems: Number(raw.processedTimelineItems ?? 0),
    lastProcessedMinute: typeof raw.lastProcessedMinute === "string" ? raw.lastProcessedMinute : null,
  };
}

function parseOpenCandidateIds(value: unknown): number[] {
  if (!value || typeof value !== "object") return [];
  const ids = (value as { candidateIds?: unknown }).candidateIds;
  return Array.isArray(ids) ? ids.map(Number).filter(Number.isFinite) : [];
}

function candidateVirtualCoverage(decisions: RtRealtimeDecisionEvent[]) {
  const incomplete = decisions.filter(event => ["pending", "processing", "error"].includes(event.candidateVirtualStatus));
  const maxDecisionId = decisions.reduce((max, event) => Math.max(max, event.id), 0);
  const firstIncompleteId = incomplete.reduce<number | null>((min, event) => min === null ? event.id : Math.min(min, event.id), null);
  return {
    sourceDecisionCount: decisions.length,
    maxDecisionId,
    safeHighWater: firstIncompleteId === null ? maxDecisionId : Math.max(0, firstIncompleteId - 1),
    pending: decisions.filter(event => event.candidateVirtualStatus === "pending").length,
    processing: decisions.filter(event => event.candidateVirtualStatus === "processing").length,
    retryableErrors: decisions.filter(event => event.candidateVirtualStatus === "error").length,
    terminal: decisions.filter(event => event.candidateVirtualStatus === "terminal").length,
  };
}

function restoreOpenAllocations(
  ids: number[],
  allocationById: Map<number, CandidateAllocation>,
): { open: Map<number, CandidateAllocation>; openBySymbol: Map<string, CandidateAllocation> } {
  const open = new Map<number, CandidateAllocation>();
  const openBySymbol = new Map<string, CandidateAllocation>();
  for (const id of ids) {
    const allocation = allocationById.get(id);
    if (!allocation) throw new Error(`portfolio_open_allocation_missing:${id}`);
    open.set(id, allocation);
    openBySymbol.set(allocation.candidate.symbol, allocation);
  }
  return { open, openBySymbol };
}

function finalizeEligibility(input: {
  complete: boolean;
  allocations: CandidateAllocation[];
  missingExitSequence?: Set<number>;
  openSize: number;
}) {
  return input.complete
    && input.openSize === 0
    && input.allocations.every(item => hasCompleteVirtualExit(item.trade))
    && (input.missingExitSequence?.size ?? 0) === 0;
}

function materializationGeneration(
  progress: Awaited<ReturnType<typeof getRtPortfolioMaterializationProgress>>,
  rebuildFromStart: boolean,
): number {
  if (rebuildFromStart) {
    return Math.max(progress?.activeGeneration ?? 0, progress?.buildingGeneration ?? 0) + 1;
  }
  return progress?.buildingGeneration ?? progress?.activeGeneration ?? 1;
}

/** engineSequence順の正式portfolioをbounded batchで増分materializeする。 */
export async function materializeAllCandidateReceiptPortfolioBatch(
  tradeDate: string,
  options: { maxTimelineItems?: number; finalizeDay?: boolean } = {},
) {
  const allocations = await loadAllCandidateInputs(tradeDate);
  const allocationById = new Map(allocations.map(item => [item.candidate.id, item]));
  const decisions = await getRtRealtimeDecisionEventsForDate(tradeDate);
  const gaps = (await getRtCandidateVirtualGapsForDate(tradeDate)).filter(gap => !gap.resolved);
  const coverage = candidateVirtualCoverage(decisions);
  const progress = await getRtPortfolioMaterializationProgress({
    portfolioVersion: ALL_CANDIDATE_RECEIPT_PORTFOLIO_VERSION,
    mode: "actual_receipt",
    tradeDate,
  });
  const rebuildFromStart = progress?.dirtyFromEngineSequence !== null
    && progress?.dirtyFromEngineSequence !== undefined
    && progress.dirtyFromEngineSequence <= progress.processedThroughEngineSequence;
  const generation = materializationGeneration(progress, rebuildFromStart);
  const cursor = rebuildFromStart ? 0 : progress?.processedThroughEngineSequence ?? 0;
  if (cursor > coverage.safeHighWater) throw new Error(`portfolio_cursor_ahead_of_safe_high_water:${cursor}:${coverage.safeHighWater}`);
  const state = rebuildFromStart ? structuredClone(EMPTY_MATERIALIZED_STATE) : parseMaterializedState(progress?.resultJson);
  const { open, openBySymbol } = restoreOpenAllocations(
    rebuildFromStart ? [] : parseOpenCandidateIds(progress?.openAllocationsJson),
    allocationById,
  );
  let marginUsed = Array.from(open.values()).reduce((sum, allocation) => sum + allocation.requiredMargin, 0);
  const sequenceBySource = new Map(decisions.map(event => [event.sourceEventId, event.id]));
  const allocationsMissingExitSequence = new Set<number>();
  type TimelineItem = { sequence: number; kind: "entry" | "exit"; allocation: CandidateAllocation };
  const timeline: TimelineItem[] = [];
  for (const allocation of allocations) {
    timeline.push({ sequence: allocation.candidate.engineSequence, kind: "entry", allocation });
    const exitSource = allocation.trade?.exitSourceEventId;
    const exitSequence = exitSource ? sequenceBySource.get(exitSource) : null;
    if (exitSequence !== null && exitSequence !== undefined) timeline.push({ sequence: exitSequence, kind: "exit", allocation });
    else if (hasCompleteVirtualExit(allocation.trade)) allocationsMissingExitSequence.add(allocation.candidate.id);
  }
  timeline.sort((a, b) => a.sequence - b.sequence || (a.kind === "exit" ? -1 : 1));
  const available = timeline.filter(item => item.sequence > cursor && item.sequence <= coverage.safeHighWater);
  const limit = Math.max(1, options.maxTimelineItems ?? 250);
  let batch = available.slice(0, limit);
  if (batch.length > 0) {
    const lastSequence = batch[batch.length - 1].sequence;
    batch = available.filter(item => item.sequence <= lastSequence);
  }
  for (const item of batch) {
    const allocation = item.allocation;
    if (item.kind === "exit") {
      if (!open.has(allocation.candidate.id)) continue;
      const before = marginUsed;
      marginUsed = Math.max(0, marginUsed - allocation.requiredMargin);
      open.delete(allocation.candidate.id);
      if (openBySymbol.get(allocation.candidate.symbol)?.candidate.id === allocation.candidate.id) openBySymbol.delete(allocation.candidate.symbol);
      state.closed += 1;
      state.realizedPnl += virtualPnlAtCapital(allocation.candidate, allocation.trade) ?? 0;
      state.processedTimelineItems += 1;
      await persistCandidatePortfolioExit({
        version: ALL_CANDIDATE_RECEIPT_PORTFOLIO_VERSION,
        mode: "actual_receipt",
        generation,
        allocation,
        marginBefore: before,
        marginAfter: marginUsed,
        priorityRank: item.sequence,
        batchKey: `${tradeDate}:${allocation.trade?.exitCandleTime ?? "unknown"}`,
      });
      continue;
    }
    const symbolBlocker = openBySymbol.get(allocation.candidate.symbol) ?? null;
    const marginBlocker = Array.from(open.values()).sort((a, b) => b.requiredMargin - a.requiredMargin)[0] ?? null;
    const blocker = symbolBlocker ?? marginBlocker;
    allocation.blocker = blocker;
    const blockedBySymbol = symbolBlocker !== null;
    const blockedByMargin = !blockedBySymbol && marginUsed + allocation.requiredMargin > PORTFOLIO_MAX_EXPOSURE;
    const canAllocate = !blockedBySymbol && !blockedByMargin;
    const before = marginUsed;
    if (canAllocate) {
      open.set(allocation.candidate.id, allocation);
      openBySymbol.set(allocation.candidate.symbol, allocation);
      marginUsed += allocation.requiredMargin;
      state.accepted += 1;
    } else if (blockedBySymbol) {
      state.symbolPositionBlocked += 1;
      if (blocker) state.blockEdges.push({ blockerSourceEventId: blocker.candidate.sourceEventId, blockedSourceEventId: allocation.candidate.sourceEventId });
    } else {
      state.marginBlocked += 1;
      if (blocker) state.blockEdges.push({ blockerSourceEventId: blocker.candidate.sourceEventId, blockedSourceEventId: allocation.candidate.sourceEventId });
    }
    state.processedTimelineItems += 1;
    await persistCandidatePortfolioDecision({
      version: ALL_CANDIDATE_RECEIPT_PORTFOLIO_VERSION,
      mode: "actual_receipt",
      generation,
      allocation,
      decision: canAllocate ? "accepted" : blockedBySymbol ? "symbol_position_block" : "margin_block",
      marginBefore: before,
      marginAfter: marginUsed,
      priorityRank: item.sequence,
      batchKey: `${tradeDate}:${allocation.candidate.candleTime}`,
      reason: canAllocate ? "engine_sequence_allocation" : blockedBySymbol ? "same_symbol_position_open" : "891m_limit",
    });
  }
  const remainingAtSafe = available.length > batch.length;
  const nextCursor = batch.length > 0 ? batch[batch.length - 1].sequence : remainingAtSafe ? cursor : coverage.safeHighWater;
  const complete = Boolean(options.finalizeDay)
    && !remainingAtSafe
    && coverage.pending === 0
    && coverage.processing === 0
    && coverage.retryableErrors === 0
    && coverage.terminal === 0
    && gaps.length === 0
    && nextCursor >= coverage.maxDecisionId
    && open.size === 0
    && allocations.every(item => hasCompleteVirtualExit(item.trade))
    && allocationsMissingExitSequence.size === 0;
  const result = {
    ...state,
    portfolioVersion: ALL_CANDIDATE_RECEIPT_PORTFOLIO_VERSION,
    generation,
    tradeDate,
    candidates: allocations.length,
    openAtEnd: open.size,
    eligibleForPortfolioPnlComparison: finalizeEligibility({ complete, allocations, missingExitSequence: allocationsMissingExitSequence, openSize: open.size }),
    coverage,
    unresolvedGaps: gaps.length,
  };
  await upsertRtPortfolioMaterializationProgress({
    portfolioVersion: ALL_CANDIDATE_RECEIPT_PORTFOLIO_VERSION,
    mode: "actual_receipt",
    tradeDate,
    status: complete ? "complete" : "processing",
    activeGeneration: complete ? generation : progress?.activeGeneration ?? null,
    buildingGeneration: complete ? null : generation,
    processedThroughEngineSequence: nextCursor,
    sourceDecisionCount: coverage.sourceDecisionCount,
    openAllocationsJson: { candidateIds: Array.from(open.keys()) },
    marginUsed,
    dirtyFromEngineSequence: null,
    resultJson: result,
    lastError: null,
    generatedAt: complete ? new Date() : null,
  });
  return { ...result, status: complete ? "complete" as const : "processing" as const, processedThroughEngineSequence: nextCursor };
}

/** 同一分固定優先順位版を、次分受信＋以前outbox完了の分だけbounded batchで確定する。 */
export async function materializeAllCandidateMinutePortfolioBatch(
  tradeDate: string,
  options: { maxMinutes?: number; finalizeDay?: boolean } = {},
) {
  const allocations = await loadAllCandidateInputs(tradeDate);
  const allocationById = new Map(allocations.map(item => [item.candidate.id, item]));
  const decisions = await getRtRealtimeDecisionEventsForDate(tradeDate);
  const gaps = (await getRtCandidateVirtualGapsForDate(tradeDate)).filter(gap => !gap.resolved);
  const coverage = candidateVirtualCoverage(decisions);
  const progress = await getRtPortfolioMaterializationProgress({
    portfolioVersion: ALL_CANDIDATE_MINUTE_PORTFOLIO_VERSION,
    mode: "minute_normalized",
    tradeDate,
  });
  const rebuildFromStart = progress?.dirtyFromEngineSequence !== null
    && progress?.dirtyFromEngineSequence !== undefined
    && progress.dirtyFromEngineSequence <= progress.processedThroughEngineSequence;
  const generation = materializationGeneration(progress, rebuildFromStart);
  const state = rebuildFromStart ? structuredClone(EMPTY_MATERIALIZED_STATE) : parseMaterializedState(progress?.resultJson);
  const { open, openBySymbol } = restoreOpenAllocations(
    rebuildFromStart ? [] : parseOpenCandidateIds(progress?.openAllocationsJson),
    allocationById,
  );
  let marginUsed = Array.from(open.values()).reduce((sum, allocation) => sum + allocation.requiredMargin, 0);
  const safeDecisions = decisions.filter(event => event.id <= coverage.safeHighWater);
  const safeMinutes = Array.from(new Set(safeDecisions.map(event => event.candleTime))).sort();
  const finalizableMinutes = options.finalizeDay ? safeMinutes : safeMinutes.slice(0, -1);
  const pendingMinutes = finalizableMinutes.filter(minute => !state.lastProcessedMinute || minute > state.lastProcessedMinute);
  const batchMinutes = pendingMinutes.slice(0, Math.max(1, options.maxMinutes ?? 30));
  const groups = new Map<string, { entries: CandidateAllocation[]; exits: CandidateAllocation[] }>();
  for (const allocation of allocations) {
    const entryGroup = groups.get(allocation.candidate.candleTime) ?? { entries: [], exits: [] };
    entryGroup.entries.push(allocation);
    groups.set(allocation.candidate.candleTime, entryGroup);
    const exitTime = allocation.trade?.exitCandleTime;
    if (exitTime && (allocation.trade?.exitTradeDate ?? tradeDate) === tradeDate) {
      const exitGroup = groups.get(exitTime) ?? { entries: [], exits: [] };
      exitGroup.exits.push(allocation);
      groups.set(exitTime, exitGroup);
    }
  }
  for (const candleTime of batchMinutes) {
    const group = groups.get(candleTime) ?? { entries: [], exits: [] };
    for (const allocation of group.exits.sort((a, b) => a.candidate.engineSequence - b.candidate.engineSequence)) {
      if (!open.has(allocation.candidate.id)) continue;
      const before = marginUsed;
      marginUsed = Math.max(0, marginUsed - allocation.requiredMargin);
      open.delete(allocation.candidate.id);
      if (openBySymbol.get(allocation.candidate.symbol)?.candidate.id === allocation.candidate.id) openBySymbol.delete(allocation.candidate.symbol);
      state.closed += 1;
      state.realizedPnl += virtualPnlAtCapital(allocation.candidate, allocation.trade) ?? 0;
      state.processedTimelineItems += 1;
      await persistCandidatePortfolioExit({
        version: ALL_CANDIDATE_MINUTE_PORTFOLIO_VERSION,
        mode: "minute_normalized",
        generation,
        allocation,
        marginBefore: before,
        marginAfter: marginUsed,
        priorityRank: state.processedTimelineItems,
        batchKey: `${tradeDate}:${candleTime}`,
      });
    }
    const entries = [...group.entries].sort((a, b) => {
      const aRank = FIXED_CONTROL_PRIORITY.indexOf(a.candidate.symbol as typeof FIXED_CONTROL_PRIORITY[number]);
      const bRank = FIXED_CONTROL_PRIORITY.indexOf(b.candidate.symbol as typeof FIXED_CONTROL_PRIORITY[number]);
      return (aRank < 0 ? 999 : aRank) - (bRank < 0 ? 999 : bRank)
        || a.candidate.engineSequence - b.candidate.engineSequence;
    });
    for (const allocation of entries) {
      const symbolBlocker = openBySymbol.get(allocation.candidate.symbol) ?? null;
      const marginBlocker = Array.from(open.values()).sort((a, b) => b.requiredMargin - a.requiredMargin)[0] ?? null;
      const blocker = symbolBlocker ?? marginBlocker;
      allocation.blocker = blocker;
      const before = marginUsed;
      const blockedBySymbol = symbolBlocker !== null;
      const blockedByMargin = !blockedBySymbol && marginUsed + allocation.requiredMargin > PORTFOLIO_MAX_EXPOSURE;
      const canAllocate = !blockedBySymbol && !blockedByMargin;
      if (canAllocate) {
        open.set(allocation.candidate.id, allocation);
        openBySymbol.set(allocation.candidate.symbol, allocation);
        marginUsed += allocation.requiredMargin;
        state.accepted += 1;
      } else if (blockedBySymbol) {
        state.symbolPositionBlocked += 1;
        if (blocker) state.blockEdges.push({ blockerSourceEventId: blocker.candidate.sourceEventId, blockedSourceEventId: allocation.candidate.sourceEventId });
      } else {
        state.marginBlocked += 1;
        if (blocker) state.blockEdges.push({ blockerSourceEventId: blocker.candidate.sourceEventId, blockedSourceEventId: allocation.candidate.sourceEventId });
      }
      state.processedTimelineItems += 1;
      await persistCandidatePortfolioDecision({
        version: ALL_CANDIDATE_MINUTE_PORTFOLIO_VERSION,
        mode: "minute_normalized",
        generation,
        allocation,
        decision: canAllocate ? "accepted" : blockedBySymbol ? "symbol_position_block" : "margin_block",
        marginBefore: before,
        marginAfter: marginUsed,
        priorityRank: state.processedTimelineItems,
        batchKey: `${tradeDate}:${candleTime}`,
        reason: canAllocate ? "exit_first_fixed_symbol_priority" : blockedBySymbol ? "same_symbol_position_open" : "891m_limit",
      });
    }
    state.lastProcessedMinute = candleTime;
  }
  const lastProcessedMinute = state.lastProcessedMinute;
  const nextCursor = lastProcessedMinute
    ? safeDecisions.filter(event => event.candleTime <= lastProcessedMinute).reduce((max, event) => Math.max(max, event.id), 0)
    : 0;
  const latestSafeMinute = safeMinutes.at(-1) ?? null;
  const remainingMinutes = pendingMinutes.length > batchMinutes.length;
  const complete = Boolean(options.finalizeDay)
    && !remainingMinutes
    && coverage.pending === 0
    && coverage.processing === 0
    && coverage.retryableErrors === 0
    && coverage.terminal === 0
    && gaps.length === 0
    && (latestSafeMinute === null || lastProcessedMinute === latestSafeMinute)
    && open.size === 0
    && allocations.every(item => hasCompleteVirtualExit(item.trade));
  const result = {
    ...state,
    portfolioVersion: ALL_CANDIDATE_MINUTE_PORTFOLIO_VERSION,
    generation,
    tradeDate,
    candidates: allocations.length,
    openAtEnd: open.size,
    priorityRule: FIXED_CONTROL_PRIORITY,
    eligibleForPortfolioPnlComparison: finalizeEligibility({ complete, allocations, openSize: open.size }),
    coverage,
    unresolvedGaps: gaps.length,
  };
  await upsertRtPortfolioMaterializationProgress({
    portfolioVersion: ALL_CANDIDATE_MINUTE_PORTFOLIO_VERSION,
    mode: "minute_normalized",
    tradeDate,
    status: complete ? "complete" : "processing",
    activeGeneration: complete ? generation : progress?.activeGeneration ?? null,
    buildingGeneration: complete ? null : generation,
    processedThroughEngineSequence: nextCursor,
    sourceDecisionCount: coverage.sourceDecisionCount,
    openAllocationsJson: { candidateIds: Array.from(open.keys()) },
    marginUsed,
    dirtyFromEngineSequence: null,
    resultJson: result,
    lastError: null,
    generatedAt: complete ? new Date() : null,
  });
  return { ...result, status: complete ? "complete" as const : "processing" as const, processedThroughEngineSequence: nextCursor };
}

export async function materializePortfolioBundleForDate(
  tradeDate: string,
  options: { finalizeDay?: boolean; maxTimelineItems?: number; maxMinutes?: number } = {},
) {
  const actualReceipt = await materializeAllCandidateReceiptPortfolioBatch(tradeDate, options);
  const minuteNormalized = await materializeAllCandidateMinutePortfolioBatch(tradeDate, options);
  if (actualReceipt.status !== "complete" || minuteNormalized.status !== "complete") {
    return { status: "processing" as const, actualReceipt, minuteNormalized };
  }
  const [actualPilot, normalizedPilot] = await Promise.all([
    buildActualReceiptPortfolioAuditForDate(tradeDate),
    buildMinuteNormalizedPortfolioAuditForDate(tradeDate),
  ]);
  const result = { actualPilot, normalizedPilot, actualReceipt, minuteNormalized };
  await upsertRtDailyAuditMaterialization({
    component: PORTFOLIO_BUNDLE_COMPONENT,
    version: PORTFOLIO_MATERIALIZATION_VERSION,
    tradeDate,
    status: "complete",
    processedThroughEngineSequence: Math.min(actualReceipt.processedThroughEngineSequence, minuteNormalized.processedThroughEngineSequence),
    sourceDecisionCount: actualReceipt.coverage.sourceDecisionCount,
    resultJson: result,
    lastError: null,
    generatedAt: new Date(),
  });
  return { status: "complete" as const, ...result };
}
