import {
  getRtPremarketContextSnapshot,
  insertRtPremarketContextSnapshot,
} from "./db";
import {
  classifyPremarketContext,
  PREMARKET_CONTEXT_RULE_VERSION,
  type PremarketContextInput,
} from "./marketContextSelectorShadow";
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
    cme: input.cme,
    usdJpy: input.usdJpy,
  };
  const inputHash = sha256Stable(canonicalInput);
  const sourceSnapshotId = input.sourceSnapshotId
    ?? `premarket:${input.tradeDate}:${input.capturedAtMs}:${inputHash.slice(0, 20)}`;
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
  const resultJson = {
    monitoringOnly: true,
    currentEngineConnection: false,
    forwardShadowDispatchConnection: false,
    candidateConnection: false,
    marginConnection: false,
    orderInstructionConnection: false,
    automaticAdoption: false,
    regime,
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
    oseDayClose: decimal(input.cme?.oseDayClose),
    cmeBasisPct: decimal(regime.metrics.cmeBasisPct),
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
  return {
    accepted: row.qualityStatus !== "invalid",
    duplicate: false,
    payloadMismatch: false,
    sourceSnapshotId,
    qualityStatus: row.qualityStatus,
    result: row.resultJson,
  };
}
