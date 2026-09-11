import type {
  RtCandidateVirtualGap,
  RtPortfolioAuditEvent,
  RtPortfolioMaterializationProgress,
  RtRealtimeDecisionEvent,
  RtSignalCandidate,
  RtSignalCandidateTrade,
} from "../drizzle/schema";
import { getStockName } from "../shared/stocks";
import {
  CURRENT_SIGNAL_CANDIDATE_VERSION,
  CURRENT_SIGNAL_VIRTUAL_ENGINE_VERSION,
} from "./currentSignalCandidateRegistry";
import { getRtSignalCandidateLedgerBundle } from "./db";
import {
  ALL_CANDIDATE_MINUTE_PORTFOLIO_VERSION,
  ALL_CANDIDATE_RECEIPT_PORTFOLIO_VERSION,
} from "./portfolioAudit";
import { getRuntimeIdentity } from "./runtimeIdentity";

export const RT_SIGNAL_CANDIDATE_LEDGER_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isValidRtSignalCandidateLedgerDate(value: string): boolean {
  if (!RT_SIGNAL_CANDIDATE_LEDGER_DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export const RT_SIGNAL_ROUTE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  reversalLong: "反転LONG",
  reversalShort: "反転SHORT",
  trendLong: "順張りLONG",
  trendShort: "順張りSHORT",
  kioxiaSafeCbShort: "キオクシア大台割れ安全SHORT",
  telShortBreak: "東京エレクトロン短期ブレイク",
  peakReversalShort: "高値反転SHORT",
  afternoonLowBreakShort: "フジクラ後場安値更新SHORT",
  lowReversalBreakLong: "安値反転ブレイクLONG",
  highFadeBreakShort: "高値失速ブレイクSHORT",
  openingBreakShort: "寄り付きブレイクSHORT",
  taiyoCandidateB: "太陽誘電候補B",
  taiyoMorningInitialShort: "太陽誘電朝初動SHORT",
  taiyoAfternoonReversal: "太陽誘電後場反転",
  advantestHighFadeShort: "アドバンテスト高値失速SHORT",
  advantestConfirmedBreakLong: "アドバンテスト確認型LONG",
  discoConfirmedBreakLong: "ディスコ確認型10本高値更新LONG",
  discoOpeningBreakShort: "ディスコ寄り付き10本安値更新SHORT",
  socionextConfirmedLong: "ソシオネクスト確認型LONG",
  sumcoBreakdownShort: "SUMCO 15本安値更新SHORT",
  softbankBreakoutLong: "ソフトバンクG 10本高値更新LONG",
});

type LedgerOverallStatus =
  | "complete"
  | "pending"
  | "processing"
  | "retryable_error"
  | "terminal_error"
  | "missing";

type VirtualTradeStatus =
  | "completed"
  | "open"
  | "not_generated"
  | "pending"
  | "processing"
  | "retryable_error"
  | "terminal_error"
  | "invalid";

type LedgerOutcome = "win" | "loss" | "draw" | "open" | null;

export type RtSignalCandidateLedgerBundle = {
  candidates: RtSignalCandidate[];
  virtualTrades: RtSignalCandidateTrade[];
  decisionEvents: RtRealtimeDecisionEvent[];
  gaps: RtCandidateVirtualGap[];
  actualReceiptProgress: RtPortfolioMaterializationProgress | null;
  minuteNormalizedProgress: RtPortfolioMaterializationProgress | null;
  actualReceiptPortfolioEvents: RtPortfolioAuditEvent[];
  minuteNormalizedPortfolioEvents: RtPortfolioAuditEvent[];
};

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nullableText(value: unknown, maxLength = 1_000): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return value.slice(0, maxLength);
}

function phaseMissingReason(
  phase: "candidate" | "virtual",
  event: RtRealtimeDecisionEvent | null,
  rowExists: boolean,
): string | null {
  if (!event) return `${phase}_decision_event_missing`;
  const status = phase === "candidate" ? event.candidatePhaseStatus : event.virtualPhaseStatus;
  if (status === "complete" && rowExists) return null;
  if (status === "complete") return `${phase}_row_missing_after_complete`;
  return `${phase}_phase_${status}`;
}

function overallStatus(input: {
  event: RtRealtimeDecisionEvent | null;
  virtualTrade: RtSignalCandidateTrade | null;
  unresolvedGaps: RtCandidateVirtualGap[];
}): LedgerOverallStatus {
  const { event, virtualTrade, unresolvedGaps } = input;
  if (unresolvedGaps.length > 0) return "terminal_error";
  if (!event) return "missing";
  const statuses = [event.candidatePhaseStatus, event.virtualPhaseStatus];
  if (statuses.includes("terminal_error")) return "terminal_error";
  if (statuses.includes("retryable_error")) return "retryable_error";
  if (statuses.includes("processing")) return "processing";
  if (statuses.includes("pending")) return "pending";
  if (event.candidatePhaseStatus !== "complete" || event.virtualPhaseStatus !== "complete" || !virtualTrade) {
    return "missing";
  }
  return "complete";
}

function virtualStatus(
  event: RtRealtimeDecisionEvent | null,
  trade: RtSignalCandidateTrade | null,
  unresolvedVirtualGap: boolean,
): VirtualTradeStatus {
  if (unresolvedVirtualGap || event?.virtualPhaseStatus === "terminal_error") return "terminal_error";
  if (event?.virtualPhaseStatus === "retryable_error") return "retryable_error";
  if (event?.virtualPhaseStatus === "processing") return "processing";
  if (event?.virtualPhaseStatus === "pending") return "pending";
  if (!trade) return "not_generated";
  if (!trade.completed) return "open";
  if (nullableNumber(trade.pnl) === null) return "invalid";
  return "completed";
}

function outcomeFor(trade: RtSignalCandidateTrade | null): LedgerOutcome {
  if (!trade) return null;
  if (!trade.completed) return "open";
  const pnl = nullableNumber(trade.pnl);
  if (pnl === null) return null;
  if (pnl > 0) return "win";
  if (pnl < 0) return "loss";
  return "draw";
}

function portfolioFor(
  progress: RtPortfolioMaterializationProgress | null,
  event: RtPortfolioAuditEvent | null,
) {
  const activeEvent = progress?.activeGeneration !== null
    && progress?.activeGeneration !== undefined
    && event?.generation === progress.activeGeneration
    ? event
    : null;
  return {
    status: progress?.status ?? "not_materialized",
    activeGeneration: progress?.activeGeneration ?? null,
    decision: activeEvent?.decision ?? null,
    blockerSourceEventId: activeEvent?.blockerSourceEventId ?? null,
    blockerSymbol: activeEvent?.blockerSymbol ?? null,
    marginUsedBefore: nullableNumber(activeEvent?.marginUsedBefore),
    marginUsedAfter: nullableNumber(activeEvent?.marginUsedAfter),
  };
}

export function buildRtSignalCandidateLedger(input: {
  tradeDate: string;
  bundle: RtSignalCandidateLedgerBundle;
  generatedAt?: Date;
}) {
  const { bundle } = input;
  if (bundle.candidates.some(candidate => candidate.candidateVersion !== CURRENT_SIGNAL_CANDIDATE_VERSION)) {
    throw new Error("rt_signal_candidate_ledger_candidate_version_mismatch");
  }
  if (bundle.virtualTrades.some(trade => trade.virtualEngineVersion !== CURRENT_SIGNAL_VIRTUAL_ENGINE_VERSION)) {
    throw new Error("rt_signal_candidate_ledger_virtual_version_mismatch");
  }
  const virtualByCandidate = new Map(bundle.virtualTrades.map(trade => [trade.candidateId, trade]));
  const decisionBySource = new Map(bundle.decisionEvents.map(event => [event.sourceEventId, event]));
  const gapsBySource = new Map<string, RtCandidateVirtualGap[]>();
  for (const gap of bundle.gaps) {
    const existing = gapsBySource.get(gap.sourceEventId) ?? [];
    existing.push(gap);
    gapsBySource.set(gap.sourceEventId, existing);
  }
  const actualBySource = new Map(bundle.actualReceiptPortfolioEvents.map(event => [event.sourceEventId, event]));
  const minuteBySource = new Map(bundle.minuteNormalizedPortfolioEvents.map(event => [event.sourceEventId, event]));
  const candidateSources = new Set(bundle.candidates.map(candidate => candidate.sourceEventId));

  const rows = bundle.candidates
    .map(candidate => {
      const virtualTrade = virtualByCandidate.get(candidate.id) ?? null;
      const decisionEvent = decisionBySource.get(candidate.sourceEventId) ?? null;
      const allGaps = gapsBySource.get(candidate.sourceEventId) ?? [];
      const unresolvedGaps = allGaps.filter(gap => !gap.resolved);
      const unresolvedCandidateGap = unresolvedGaps.some(gap => gap.phase === "candidate");
      const unresolvedVirtualGap = unresolvedGaps.some(gap => gap.phase === "virtual");
      const status = overallStatus({ event: decisionEvent, virtualTrade, unresolvedGaps });

      return {
        candidateId: candidate.id,
        candidateVersion: candidate.candidateVersion,
        virtualEngineVersion: CURRENT_SIGNAL_VIRTUAL_ENGINE_VERSION,
        sourceEventId: candidate.sourceEventId,
        engineSequence: candidate.engineSequence,
        tradeDate: candidate.tradeDate,
        candleTime: candidate.candleTime,
        symbol: candidate.symbol,
        symbolName: getStockName(candidate.symbol),
        routeId: candidate.routeId,
        logicName: RT_SIGNAL_ROUTE_LABELS[candidate.routeId] ?? `名称未登録（${candidate.routeId}）`,
        side: candidate.side,
        signalReason: candidate.signalReason,
        realtimeDecision: candidate.realtimeDecision,
        capitalShares: candidate.capitalShares,
        requiredMargin: nullableNumber(candidate.requiredMargin),
        marginUsedBefore: nullableNumber(candidate.marginUsedBefore),
        marginLimit: nullableNumber(candidate.marginLimit),
        blockReasonCode: candidate.realtimeDecision === "margin_block" ? "realtime_margin_limit" : null,
        blockReasonLabel: candidate.realtimeDecision === "margin_block" ? "現行の証拠金上限超過" : null,
        blockerSourceEventId: null,
        blockerAvailability: candidate.realtimeDecision === "margin_block" ? "not_recorded" : "not_applicable",
        theoreticalEntryPrice: nullableNumber(candidate.theoreticalEntryPrice),
        signalQualityShares: candidate.signalQualityShares,
        slPct: nullableNumber(candidate.slPct),
        tpPct: nullableNumber(candidate.tpPct),
        maxHoldingMinutes: candidate.maxHoldingMinutes,
        sessionExitTime: candidate.sessionExitTime,
        profitProtectionJson: candidate.profitProtectionJson,
        entryObservedAtMs: candidate.entryObservedAtMs,
        decisionAtMs: candidate.decisionAtMs,
        virtualTrade: {
          status: virtualStatus(decisionEvent, virtualTrade, unresolvedVirtualGap),
          completed: virtualTrade?.completed ?? null,
          entryCandleTime: virtualTrade?.entryCandleTime ?? null,
          entryPrice: nullableNumber(virtualTrade?.entryPrice),
          shares: virtualTrade?.shares ?? null,
          exitCandleTime: virtualTrade?.exitCandleTime ?? null,
          exitPrice: nullableNumber(virtualTrade?.exitPrice),
          exitReasonCode: virtualTrade?.exitReasonCode ?? virtualTrade?.exitReason ?? null,
          exitReasonDetail: virtualTrade?.exitReasonDetail ?? null,
          pnl: nullableNumber(virtualTrade?.pnl),
          outcome: outcomeFor(virtualTrade),
          realizedR: nullableNumber(virtualTrade?.realizedR),
          mfePct: nullableNumber(virtualTrade?.mfePct),
          maePct: nullableNumber(virtualTrade?.maePct),
        },
        audit: {
          overallStatus: status,
          candidatePhase: {
            status: decisionEvent?.candidatePhaseStatus ?? "missing",
            attemptCount: decisionEvent?.candidatePhaseAttemptCount ?? null,
            hasUnresolvedGap: unresolvedCandidateGap,
            missingReason: phaseMissingReason("candidate", decisionEvent, true),
          },
          virtualPhase: {
            status: decisionEvent?.virtualPhaseStatus ?? "missing",
            attemptCount: decisionEvent?.virtualPhaseAttemptCount ?? null,
            hasUnresolvedGap: unresolvedVirtualGap,
            missingReason: phaseMissingReason("virtual", decisionEvent, virtualTrade !== null),
          },
          hasAnyGap: allGaps.length > 0,
          hasUnresolvedGap: unresolvedGaps.length > 0,
          gapReasonCodes: allGaps.map(gap => ({
            phase: gap.phase,
            reasonCode: gap.reasonCode,
            resolved: gap.resolved,
          })),
        },
        portfolioAudit: {
          actualReceipt: portfolioFor(
            bundle.actualReceiptProgress,
            actualBySource.get(candidate.sourceEventId) ?? null,
          ),
          minuteNormalized: portfolioFor(
            bundle.minuteNormalizedProgress,
            minuteBySource.get(candidate.sourceEventId) ?? null,
          ),
        },
      };
    })
    .sort((a, b) => a.engineSequence - b.engineSequence || a.candidateId - b.candidateId);

  const completedRows = rows.filter(row => row.virtualTrade.completed === true && row.virtualTrade.pnl !== null);
  const wins = completedRows.filter(row => row.virtualTrade.outcome === "win").length;
  const losses = completedRows.filter(row => row.virtualTrade.outcome === "loss").length;
  const draws = completedRows.filter(row => row.virtualTrade.outcome === "draw").length;
  const unresolvedGapCount = bundle.gaps.filter(gap => !gap.resolved).length;
  const orphanGaps = bundle.gaps
    .filter(gap => !gap.resolved && !candidateSources.has(gap.sourceEventId))
    .map(gap => {
      const decisionEvent = decisionBySource.get(gap.sourceEventId) ?? null;
      const detail = objectValue(gap.detailJson);
      const statusBefore = objectValue(detail.statusBefore);
      const statusAfter = objectValue(detail.statusAfter);
      return {
        gapId: gap.id,
        decisionEventId: gap.decisionEventId,
        sourceEventId: gap.sourceEventId,
        symbol: decisionEvent?.symbol ?? null,
        symbolName: decisionEvent ? getStockName(decisionEvent.symbol) : null,
        candleTime: decisionEvent?.candleTime ?? null,
        resultType: decisionEvent?.resultType ?? null,
        routeId: decisionEvent?.routeId ?? null,
        side: decisionEvent?.side ?? null,
        signalReason: nullableText(decisionEvent?.reason, 500),
        phase: gap.phase,
        reasonCode: gap.reasonCode,
        error: nullableText(detail.error),
        attemptCount: nullableNumber(detail.attemptCount),
        phaseLastError: nullableText(detail.phaseLastError),
        candidatePhaseAttemptCount: nullableNumber(detail.candidatePhaseAttemptCount)
          ?? decisionEvent?.candidatePhaseAttemptCount
          ?? null,
        virtualPhaseAttemptCount: nullableNumber(detail.virtualPhaseAttemptCount)
          ?? decisionEvent?.virtualPhaseAttemptCount
          ?? null,
        statusBefore: {
          candidate: nullableText(statusBefore.candidate, 64),
          virtual: nullableText(statusBefore.virtual, 64),
        },
        statusAfter: {
          candidate: nullableText(statusAfter.candidate, 64),
          virtual: nullableText(statusAfter.virtual, 64),
        },
      };
    });
  const identity = getRuntimeIdentity();
  const countByOverallStatus = (status: LedgerOverallStatus) => rows.filter(row => row.audit.overallStatus === status).length;
  const completedDenominator = wins + losses + draws;
  const decidedDenominator = wins + losses;
  const signalQualityPnl = completedRows.reduce((sum, row) => sum + (row.virtualTrade.pnl ?? 0), 0);

  const summary = {
    candidateCount: rows.length,
    acceptedCount: rows.filter(row => row.realtimeDecision === "accepted").length,
    marginBlockedCount: rows.filter(row => row.realtimeDecision === "margin_block").length,
    virtualCreatedCount: rows.filter(row => row.virtualTrade.completed !== null).length,
    virtualCompletedCount: rows.filter(row => row.virtualTrade.completed === true).length,
    virtualOpenCount: rows.filter(row => row.virtualTrade.completed === false).length,
    wins,
    losses,
    draws,
    winRateIncludingDrawPct: completedDenominator === 0 ? null : Number(((wins / completedDenominator) * 100).toFixed(2)),
    winRateExcludingDrawPct: decidedDenominator === 0 ? null : Number(((wins / decidedDenominator) * 100).toFixed(2)),
    signalQualityPnl,
    pendingCount: countByOverallStatus("pending") + countByOverallStatus("processing"),
    processingCount: countByOverallStatus("processing"),
    retryableErrorCount: countByOverallStatus("retryable_error"),
    terminalCount: countByOverallStatus("terminal_error"),
    missingDataCount: countByOverallStatus("missing"),
    unresolvedGapCount,
    orphanGapCount: orphanGaps.length,
    coverageComplete: rows.every(row => row.audit.overallStatus === "complete")
      && unresolvedGapCount === 0
      && orphanGaps.length === 0,
    generatedAt: (input.generatedAt ?? new Date()).toISOString(),
    runtimeBuild: identity.runtimeBuildIdentifier,
    fixedSourceHash: identity.sourceTreeHash,
    baselineFixedSourceHash: identity.baselineTradingSourceTreeHash,
    tradingLogicMatchesBaseline: identity.tradingLogicMatchesBaseline,
    dryRunRequired: identity.dryRunRequired,
    liveOrderApproved: identity.liveOrderApproved,
  };

  if (summary.candidateCount !== rows.length
    || summary.acceptedCount + summary.marginBlockedCount !== rows.length
    || summary.virtualCompletedCount !== wins + losses + draws
    || summary.signalQualityPnl !== completedRows.reduce((sum, row) => sum + (row.virtualTrade.pnl ?? 0), 0)) {
    throw new Error("rt_signal_candidate_ledger_integrity_mismatch");
  }

  return {
    tradeDate: input.tradeDate,
    versions: {
      candidate: CURRENT_SIGNAL_CANDIDATE_VERSION,
      virtual: CURRENT_SIGNAL_VIRTUAL_ENGINE_VERSION,
      actualReceiptPortfolio: ALL_CANDIDATE_RECEIPT_PORTFOLIO_VERSION,
      minuteNormalizedPortfolio: ALL_CANDIDATE_MINUTE_PORTFOLIO_VERSION,
    },
    summary,
    rows,
    orphanGaps,
  };
}

export async function getRtSignalCandidateLedger(tradeDate: string) {
  const bundle = await getRtSignalCandidateLedgerBundle({
    candidateVersion: CURRENT_SIGNAL_CANDIDATE_VERSION,
    virtualEngineVersion: CURRENT_SIGNAL_VIRTUAL_ENGINE_VERSION,
    tradeDate,
    actualReceiptPortfolioVersion: ALL_CANDIDATE_RECEIPT_PORTFOLIO_VERSION,
    minuteNormalizedPortfolioVersion: ALL_CANDIDATE_MINUTE_PORTFOLIO_VERSION,
  });
  return buildRtSignalCandidateLedger({ tradeDate, bundle });
}
