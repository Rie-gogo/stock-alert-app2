import { randomUUID } from "node:crypto";
import {
  acquireRtNamedWorkerLock,
  getRtDailyAuditMaterialization,
  getRtPortfolioMaterializationProgress,
  releaseRtNamedWorkerLock,
  upsertRtDailyAuditMaterialization,
} from "./db";
import {
  ALL_CANDIDATE_MINUTE_PORTFOLIO_VERSION,
  ALL_CANDIDATE_RECEIPT_PORTFOLIO_VERSION,
  PORTFOLIO_BUNDLE_COMPONENT,
  PORTFOLIO_MATERIALIZATION_VERSION,
  materializePortfolioBundleForDate,
} from "./portfolioAudit";
import { compareTelCurrentParityForDate } from "./telParityComparison";
import { buildDivergenceHypotheses, buildOutcomeLabelsForDate } from "./outcomeDivergenceAudit";
import { materializeNextForwardReplayForDate } from "./forwardReplayMaterializer";

export const TEL_PARITY_MATERIALIZATION_COMPONENT = "tel_current_parity";
export const TEL_PARITY_MATERIALIZATION_VERSION = "baseline-8035-current-parity-materialized-v1";
export const OUTCOME_LABELS_MATERIALIZATION_COMPONENT = "outcome_labels";
export const OUTCOME_LABELS_MATERIALIZATION_VERSION = "current-outcome-labels-materialized-v1";
export const DIVERGENCE_MATERIALIZATION_COMPONENT = "divergence_hypotheses";
export const DIVERGENCE_MATERIALIZATION_VERSION = "current-divergence-materialized-v1";
const AUDIT_MATERIALIZER_LOCK_NAME = "audit-materializer-p0-v1";

function jstTradeDate(now = new Date()): string {
  return new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function canFinalizeTradeDate(tradeDate: string, now = new Date()): boolean {
  const today = jstTradeDate(now);
  if (tradeDate < today) return true;
  if (tradeDate > today) return false;
  const jstTime = new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(11, 16);
  return jstTime >= "15:31";
}

async function persistComponent(input: {
  component: string;
  version: string;
  tradeDate: string;
  result: unknown;
  processedThroughEngineSequence: number;
  sourceDecisionCount: number;
}) {
  return upsertRtDailyAuditMaterialization({
    component: input.component,
    version: input.version,
    tradeDate: input.tradeDate,
    status: "complete",
    processedThroughEngineSequence: input.processedThroughEngineSequence,
    sourceDecisionCount: input.sourceDecisionCount,
    resultJson: input.result,
    lastError: null,
    generatedAt: new Date(),
  });
}

/**
 * 一回のHeartbeatでportfolio batchと高々一つの重い監査componentだけを処理する。
 * 16時レポートはこの関数を呼ばず、保存済みsnapshotだけを読む。
 */
async function materializeNextAuditComponentUnlocked(
  tradeDate: string,
  options: { now?: Date; maxTimelineItems?: number; maxMinutes?: number } = {},
) {
  const finalizeDay = canFinalizeTradeDate(tradeDate, options.now);
  const existingPortfolio = await getRtDailyAuditMaterialization({
    component: PORTFOLIO_BUNDLE_COMPONENT,
    version: PORTFOLIO_MATERIALIZATION_VERSION,
    tradeDate,
  });
  const portfolio = existingPortfolio?.status === "complete"
    ? existingPortfolio.resultJson as { status: "complete" }
    : await materializePortfolioBundleForDate(tradeDate, {
        finalizeDay,
        maxTimelineItems: options.maxTimelineItems ?? 250,
        maxMinutes: options.maxMinutes ?? 30,
      });
  const actualProgress = await getRtPortfolioMaterializationProgress({
    portfolioVersion: ALL_CANDIDATE_RECEIPT_PORTFOLIO_VERSION,
    mode: "actual_receipt",
    tradeDate,
  });
  const minuteProgress = await getRtPortfolioMaterializationProgress({
    portfolioVersion: ALL_CANDIDATE_MINUTE_PORTFOLIO_VERSION,
    mode: "minute_normalized",
    tradeDate,
  });
  const processedThrough = Math.min(
    actualProgress?.processedThroughEngineSequence ?? 0,
    minuteProgress?.processedThroughEngineSequence ?? 0,
  );
  const sourceDecisionCount = Math.max(
    actualProgress?.sourceDecisionCount ?? 0,
    minuteProgress?.sourceDecisionCount ?? 0,
  );
  if (existingPortfolio?.status !== "complete") {
    await upsertRtDailyAuditMaterialization({
      component: PORTFOLIO_BUNDLE_COMPONENT,
      version: PORTFOLIO_MATERIALIZATION_VERSION,
      tradeDate,
      status: portfolio.status,
      processedThroughEngineSequence: processedThrough,
      sourceDecisionCount,
      resultJson: portfolio,
      lastError: null,
      generatedAt: portfolio.status === "complete" ? new Date() : null,
    });
  }
  if (!finalizeDay || portfolio.status !== "complete") {
    return { status: "processing" as const, component: PORTFOLIO_BUNDLE_COMPONENT, portfolio };
  }

  const telParity = await getRtDailyAuditMaterialization({
    component: TEL_PARITY_MATERIALIZATION_COMPONENT,
    version: TEL_PARITY_MATERIALIZATION_VERSION,
    tradeDate,
  });
  if (telParity?.status !== "complete" || telParity.sourceDecisionCount !== sourceDecisionCount) {
    const result = await compareTelCurrentParityForDate(tradeDate);
    await persistComponent({
      component: TEL_PARITY_MATERIALIZATION_COMPONENT,
      version: TEL_PARITY_MATERIALIZATION_VERSION,
      tradeDate,
      result,
      processedThroughEngineSequence: processedThrough,
      sourceDecisionCount,
    });
    return { status: "processing" as const, component: TEL_PARITY_MATERIALIZATION_COMPONENT, result };
  }

  const forwardReplay = await materializeNextForwardReplayForDate({
    tradeDate,
    processedThroughEngineSequence: processedThrough,
    sourceDecisionCount,
  });
  if (forwardReplay.status !== "complete") {
    return { status: "processing" as const, component: "forward_strategy_replay", result: forwardReplay };
  }

  const labels = await getRtDailyAuditMaterialization({
    component: OUTCOME_LABELS_MATERIALIZATION_COMPONENT,
    version: OUTCOME_LABELS_MATERIALIZATION_VERSION,
    tradeDate,
  });
  if (labels?.status !== "complete" || labels.sourceDecisionCount !== sourceDecisionCount) {
    const result = await buildOutcomeLabelsForDate(tradeDate);
    await persistComponent({
      component: OUTCOME_LABELS_MATERIALIZATION_COMPONENT,
      version: OUTCOME_LABELS_MATERIALIZATION_VERSION,
      tradeDate,
      result,
      processedThroughEngineSequence: processedThrough,
      sourceDecisionCount,
    });
    return { status: "processing" as const, component: OUTCOME_LABELS_MATERIALIZATION_COMPONENT, result };
  }

  const divergence = await getRtDailyAuditMaterialization({
    component: DIVERGENCE_MATERIALIZATION_COMPONENT,
    version: DIVERGENCE_MATERIALIZATION_VERSION,
    tradeDate,
  });
  if (divergence?.status !== "complete" || divergence.sourceDecisionCount !== sourceDecisionCount) {
    const result = await buildDivergenceHypotheses(tradeDate);
    await persistComponent({
      component: DIVERGENCE_MATERIALIZATION_COMPONENT,
      version: DIVERGENCE_MATERIALIZATION_VERSION,
      tradeDate,
      result,
      processedThroughEngineSequence: processedThrough,
      sourceDecisionCount,
    });
    return { status: "processing" as const, component: DIVERGENCE_MATERIALIZATION_COMPONENT, result };
  }

  return {
    status: "complete" as const,
    component: "all",
    processedThroughEngineSequence: processedThrough,
    sourceDecisionCount,
  };
}

export async function materializeNextAuditComponentForDate(
  tradeDate: string,
  options: { now?: Date; maxTimelineItems?: number; maxMinutes?: number } = {},
) {
  const ownerToken = `audit-materializer:${randomUUID()}`;
  const acquired = await acquireRtNamedWorkerLock({
    lockName: AUDIT_MATERIALIZER_LOCK_NAME,
    ownerToken,
    leaseMs: 110_000,
  });
  if (!acquired) return { status: "worker_busy" as const, component: "none" };
  try {
    return await materializeNextAuditComponentUnlocked(tradeDate, options);
  } finally {
    await releaseRtNamedWorkerLock(AUDIT_MATERIALIZER_LOCK_NAME, ownerToken);
  }
}

export async function readAuditMaterializationsForReport(tradeDate: string) {
  const [portfolio, telParity, outcomeLabels, divergence] = await Promise.all([
    getRtDailyAuditMaterialization({ component: PORTFOLIO_BUNDLE_COMPONENT, version: PORTFOLIO_MATERIALIZATION_VERSION, tradeDate }),
    getRtDailyAuditMaterialization({ component: TEL_PARITY_MATERIALIZATION_COMPONENT, version: TEL_PARITY_MATERIALIZATION_VERSION, tradeDate }),
    getRtDailyAuditMaterialization({ component: OUTCOME_LABELS_MATERIALIZATION_COMPONENT, version: OUTCOME_LABELS_MATERIALIZATION_VERSION, tradeDate }),
    getRtDailyAuditMaterialization({ component: DIVERGENCE_MATERIALIZATION_COMPONENT, version: DIVERGENCE_MATERIALIZATION_VERSION, tradeDate }),
  ]);
  return { portfolio, telParity, outcomeLabels, divergence };
}
