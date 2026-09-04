import type { RtRealtimeDecisionEvent } from "../drizzle/schema";
import {
  getRtRealtimeDecisionEventsForDate,
  getRtSignalCandidatesForDate,
  getRtSignalCandidateTradesForDate,
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
  allocation: CandidateAllocation;
  decision: "accepted" | "margin_block";
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
  let marginUsed = 0;
  let accepted = 0;
  let marginBlocked = 0;
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
      closed += 1;
      realizedPnl += virtualPnlAtCapital(allocation.candidate, allocation.trade) ?? 0;
      await persistCandidatePortfolioExit({
        version: ALL_CANDIDATE_RECEIPT_PORTFOLIO_VERSION,
        mode: "actual_receipt",
        allocation,
        marginBefore: before,
        marginAfter: marginUsed,
        priorityRank: item.sequence,
        batchKey: `${tradeDate}:${allocation.trade?.exitCandleTime ?? "unknown"}`,
      });
      continue;
    }

    const openValues = Array.from(open.values());
    const blocker = openValues.sort((a, b) => b.requiredMargin - a.requiredMargin)[0] ?? null;
    allocation.blocker = blocker;
    const canAllocate = marginUsed + allocation.requiredMargin <= PORTFOLIO_MAX_EXPOSURE;
    const before = marginUsed;
    if (canAllocate) {
      open.set(allocation.candidate.id, allocation);
      marginUsed += allocation.requiredMargin;
      accepted += 1;
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
      allocation,
      decision: canAllocate ? "accepted" : "margin_block",
      marginBefore: before,
      marginAfter: marginUsed,
      priorityRank: item.sequence,
      batchKey: `${tradeDate}:${allocation.candidate.candleTime}`,
      reason: canAllocate ? "engine_sequence_allocation" : "891m_limit",
    });
  }

  return {
    portfolioVersion: ALL_CANDIDATE_RECEIPT_PORTFOLIO_VERSION,
    tradeDate,
    candidates: allocations.length,
    accepted,
    marginBlocked,
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
  let marginUsed = 0;
  let accepted = 0;
  let marginBlocked = 0;
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
      closed += 1;
      realizedPnl += virtualPnlAtCapital(allocation.candidate, allocation.trade) ?? 0;
      priorityCounter += 1;
      await persistCandidatePortfolioExit({
        version: ALL_CANDIDATE_MINUTE_PORTFOLIO_VERSION,
        mode: "minute_normalized",
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
      const blocker = Array.from(open.values()).sort((a, b) => b.requiredMargin - a.requiredMargin)[0] ?? null;
      allocation.blocker = blocker;
      const before = marginUsed;
      const canAllocate = marginUsed + allocation.requiredMargin <= PORTFOLIO_MAX_EXPOSURE;
      if (canAllocate) {
        open.set(allocation.candidate.id, allocation);
        marginUsed += allocation.requiredMargin;
        accepted += 1;
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
        allocation,
        decision: canAllocate ? "accepted" : "margin_block",
        marginBefore: before,
        marginAfter: marginUsed,
        priorityRank: priorityCounter,
        batchKey: `${tradeDate}:${candleTime}`,
        reason: canAllocate ? "exit_first_fixed_symbol_priority" : "891m_limit",
      });
    }
  }

  return {
    portfolioVersion: ALL_CANDIDATE_MINUTE_PORTFOLIO_VERSION,
    tradeDate,
    candidates: allocations.length,
    accepted,
    marginBlocked,
    closed,
    realizedPnl,
    openAtEnd: open.size,
    blockEdges,
    priorityRule: FIXED_CONTROL_PRIORITY,
    eligibleForPortfolioPnlComparison: allocations.every(item => hasCompleteVirtualExit(item.trade)),
  };
}
