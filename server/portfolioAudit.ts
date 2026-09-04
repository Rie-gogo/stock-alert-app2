import type { RtRealtimeDecisionEvent } from "../drizzle/schema";
import {
  getRtRealtimeDecisionEventsForDate,
  upsertRtPortfolioAuditEvent,
} from "./db";
import { getRuntimeIdentity } from "./runtimeIdentity";

export const CURRENT_PORTFOLIO_AUDIT_VERSION = "current-10-symbol-891m-receipt-order-v1";
export const NORMALIZED_PORTFOLIO_AUDIT_VERSION = "current-10-symbol-891m-minute-priority-v1";
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
