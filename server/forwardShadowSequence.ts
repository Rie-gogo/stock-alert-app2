import { randomUUID } from "node:crypto";
import {
  claimNextRtShadowDispatch,
  completeRtShadowDispatch,
  enqueueRtShadowDispatch,
  failRtShadowDispatch,
} from "./db";
import { processForwardShadowSourceEvent, type ForwardSourceEventInput } from "./forwardShadow";
import { createForwardShadowLockOwnerToken } from "./forwardShadowLock";

const MAX_DRAIN_ROWS = 100;

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export async function drainForwardShadowDispatchQueue(): Promise<{
  processedEngineSequences: number[];
  stoppedReason: "empty_or_claimed" | "max_batch";
}> {
  const processedEngineSequences: number[] = [];
  for (let i = 0; i < MAX_DRAIN_ROWS; i += 1) {
    const ownerToken = createForwardShadowLockOwnerToken({
      sourceEventId: `dispatch:${randomUUID()}`,
      strategyVersion: "global-engine-sequence-dispatch-v1",
      evaluationMode: "signal_quality",
    });
    const row = await claimNextRtShadowDispatch({ ownerToken, leaseMs: 30_000, maxAttempts: 5 });
    if (!row) {
      return { processedEngineSequences, stoppedReason: "empty_or_claimed" };
    }
    try {
      await processForwardShadowSourceEvent(row.inputJson as ForwardSourceEventInput);
      await completeRtShadowDispatch({ id: row.id, ownerToken });
      processedEngineSequences.push(row.engineSequence);
    } catch (error) {
      await failRtShadowDispatch({ id: row.id, ownerToken, error: errorMessage(error) });
      throw error;
    }
  }
  return { processedEngineSequences, stoppedReason: "max_batch" };
}

export async function enqueueAndDrainForwardShadow(input: ForwardSourceEventInput) {
  const engineSequence = input.currentAudit?.engineSequence;
  if (!engineSequence) {
    return {
      queued: false,
      skipped: true,
      reason: "missing_current_engine_sequence",
      processedEngineSequences: [] as number[],
    };
  }
  await enqueueRtShadowDispatch({
    sourceEventId: input.sourceEventId,
    engineSequence,
    tradeDate: input.candle.tradeDate,
    symbol: input.candle.symbol,
    inputJson: input,
  });
  const drained = await drainForwardShadowDispatchQueue();
  return {
    queued: true,
    skipped: false,
    engineSequence,
    ...drained,
  };
}
