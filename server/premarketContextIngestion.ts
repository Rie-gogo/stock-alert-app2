import {
  getRtPremarketContextSnapshot,
  insertRtPremarketContextSnapshot,
} from "./db";
import {
  classifyPremarketContext,
  premarketCmeIngressViolation,
  PREMARKET_CONTEXT_RULE_VERSION,
  type PremarketContextInput,
} from "./marketContextSelectorShadow";
import {
  enqueuePremarketContextSelectorWorker,
  marketContextSelectorWorkerEnabled,
} from "./marketContextSelectorWorker";
import { sha256Stable } from "./runtimeIdentity";

export type PremarketContextSubmission = PremarketContextInput & {
  sourceSnapshotId?: string;
};

function decimal(value: number | null | undefined): string | null {
  return value === null || value === undefined || !Number.isFinite(value) ? null : String(value);
}

/**
 * 開場前①〜③の数値snapshotを追記保存する。
 * AI文章そのものは入力にせず、出典・観測時刻付きの構造化値だけを受け付ける。
 */
export async function ingestPremarketContext(input: PremarketContextSubmission) {
  const canonicalInput: PremarketContextInput = {
    tradeDate: input.tradeDate,
    capturedAtMs: input.capturedAtMs,
    collectorVersion: input.collectorVersion,
    sourceMode: input.sourceMode,
    dow: input.dow,
    cme: input.cme ? {
      providerSymbol: input.cme.providerSymbol,
      contractMonth: input.cme.contractMonth,
      currency: input.cme.currency,
      quote: input.cme.quote,
      observedAtMs: input.cme.observedAtMs,
      comparisonPolicy: input.cme.comparisonPolicy,
      previousSession: input.cme.previousSession ?? null,
      sourceUrl: input.cme.sourceUrl,
      status: input.cme.status,
    } : null,
    usdJpy: input.usdJpy,
  };
  const inputHash = sha256Stable(canonicalInput);
  const sourceSnapshotId = input.sourceSnapshotId
    ?? `premarket:${input.tradeDate}:${input.capturedAtMs}:${inputHash.slice(0, 20)}`;
  const cmeIngressViolation = premarketCmeIngressViolation(canonicalInput);
  if (cmeIngressViolation) {
    return {
      accepted: false,
      duplicate: false,
      payloadMismatch: false,
      sourceSnapshotId,
      qualityStatus: "invalid" as const,
      rejectionReason: cmeIngressViolation,
      result: {
        monitoringOnly: true,
        selectorReason: "premarket_cme_input_rejected",
        selectorShadow: null,
      },
    };
  }
  const existing = await getRtPremarketContextSnapshot(sourceSnapshotId);
  if (existing) {
    return {
      accepted: existing.inputHash === inputHash,
      duplicate: true,
      payloadMismatch: existing.inputHash !== inputHash,
      sourceSnapshotId,
      result: existing.resultJson,
    };
  }
  const regime = classifyPremarketContext(canonicalInput);
  const shouldScheduleSelector = regime.qualityStatus !== "invalid" && marketContextSelectorWorkerEnabled();
  const resultJson = {
    monitoringOnly: true,
    currentEngineConnection: false,
    forwardShadowDispatchConnection: false,
    candidateConnection: false,
    marginConnection: false,
    orderInstructionConnection: false,
    automaticAdoption: false,
    regime,
    selectorReason: shouldScheduleSelector
      ? "selector_scheduled_receive_priority"
      : regime.qualityStatus === "invalid"
        ? "premarket_snapshot_invalid"
        : "selector_not_scheduled_feature_disabled",
    selectorWorker: {
      status: shouldScheduleSelector ? "scheduled" : "not_scheduled",
      checkpoint: "08:30",
      receivePriorityIsolation: true,
    },
  };
  const row = await insertRtPremarketContextSnapshot({
    sourceSnapshotId,
    tradeDate: input.tradeDate,
    capturedAtMs: input.capturedAtMs,
    collectorVersion: input.collectorVersion,
    sourceMode: input.sourceMode,
    dowSessionDate: input.dow?.sessionDate ?? null,
    dowClose: decimal(input.dow?.close),
    dowChangePct: decimal(input.dow?.changePct),
    cmeProviderSymbol: input.cme?.providerSymbol ?? null,
    cmeContractMonth: input.cme?.contractMonth ?? null,
    cmeCurrency: input.cme?.currency ?? null,
    cmeQuote: decimal(input.cme?.quote),
    // 同一CME比較の入力・計算値はinputJson/resultJsonへ完全保存する。
    // 旧列は履歴互換のため残すが、v2以降は判定にも新規保存にも使用しない。
    oseDayClose: null,
    cmeBasisPct: null,
    usdJpyPrevious: decimal(input.usdJpy?.previousRate),
    usdJpyCurrent: decimal(input.usdJpy?.currentRate),
    usdJpyChangePct: decimal(regime.metrics.usdJpyChangePct),
    inputHash,
    ruleVersion: PREMARKET_CONTEXT_RULE_VERSION,
    qualityStatus: regime.qualityStatus,
    regimeState: regime.state,
    confidence: regime.confidence,
    inputJson: canonicalInput,
    resultJson,
  });
  if (row.inputHash !== inputHash) {
    return {
      accepted: false,
      duplicate: true,
      payloadMismatch: true,
      sourceSnapshotId,
      qualityStatus: row.qualityStatus,
      result: row.resultJson,
    };
  }
  if (shouldScheduleSelector) {
    enqueuePremarketContextSelectorWorker({
      sourceSnapshotId,
      tradeDate: input.tradeDate,
      premarketRegime: regime,
    });
  }
  return {
    accepted: row.qualityStatus !== "invalid",
    duplicate: false,
    payloadMismatch: false,
    sourceSnapshotId,
    qualityStatus: row.qualityStatus,
    result: row.resultJson,
  };
}
