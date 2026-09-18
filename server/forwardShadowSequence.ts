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
const DEFAULT_DRAIN_DURATION_MS = 20_000;
const REALTIME_DRAIN_ROWS = 8;
const REALTIME_DRAIN_DURATION_MS = 1_500;
const REALTIME_DRAIN_RESCHEDULE_MS = 25;

let realtimeDrainScheduled = false;
let realtimeDrainRunning = false;
let realtimeDrainRequested = false;

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export async function drainForwardShadowDispatchQueue(): Promise<{
  processedEngineSequences: number[];
  stoppedReason: "empty_or_claimed" | "max_batch" | "max_duration";
}>;
export async function drainForwardShadowDispatchQueue(options: {
  maxRows?: number;
  maxDurationMs?: number;
}): Promise<{
  processedEngineSequences: number[];
  stoppedReason: "empty_or_claimed" | "max_batch" | "max_duration";
}>;
export async function drainForwardShadowDispatchQueue(options: {
  maxRows?: number;
  maxDurationMs?: number;
} = {}): Promise<{
  processedEngineSequences: number[];
  stoppedReason: "empty_or_claimed" | "max_batch" | "max_duration";
}> {
  const maxRows = options.maxRows ?? MAX_DRAIN_ROWS;
  const maxDurationMs = options.maxDurationMs ?? DEFAULT_DRAIN_DURATION_MS;
  const startedAt = Date.now();
  const processedEngineSequences: number[] = [];
  for (let i = 0; i < maxRows; i += 1) {
    if (Date.now() - startedAt >= maxDurationMs) {
      return { processedEngineSequences, stoppedReason: "max_duration" };
    }
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

/**
 * 受信経路では永続キューへの登録だけを待つ。重いstrategy評価はHTTP応答を塞がない。
 */
export async function enqueueForwardShadow(input: ForwardSourceEventInput) {
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
  return {
    queued: true,
    skipped: false,
    engineSequence,
    deferred: true,
  };
}

async function runRealtimeDrain(): Promise<void> {
  if (realtimeDrainRunning) return;
  realtimeDrainRunning = true;
  let shouldContinue = false;
  try {
    const result = await drainForwardShadowDispatchQueue({
      maxRows: REALTIME_DRAIN_ROWS,
      maxDurationMs: REALTIME_DRAIN_DURATION_MS,
    });
    shouldContinue = result.stoppedReason === "max_batch" || result.stoppedReason === "max_duration";
  } catch (error) {
    // 永続queueは残る。次のsource eventまたは定期workerが同じ先頭から再開する。
    console.error("[ForwardShadowWorker] 非同期drain失敗。永続queueから再試行します:", error);
  } finally {
    realtimeDrainRunning = false;
    if (shouldContinue || realtimeDrainRequested) {
      realtimeDrainRequested = false;
      scheduleForwardShadowDispatchDrain(REALTIME_DRAIN_RESCHEDULE_MS);
    }
  }
}

/** HTTP応答後に同一runtime内の軽量workerを起動する。queueがある限りbounded batchで追随する。 */
export function scheduleForwardShadowDispatchDrain(delayMs = 0): void {
  if (realtimeDrainRunning) {
    realtimeDrainRequested = true;
    return;
  }
  if (realtimeDrainScheduled) return;
  realtimeDrainScheduled = true;
  setTimeout(() => {
    realtimeDrainScheduled = false;
    void runRealtimeDrain();
  }, delayMs);
  // 応答直後の短いtimerはunrefしない。runtimeがidle判定へ入る前にworkerを確実に開始する。
}

/** replayや管理処理向け互換API。リアルタイム受信経路からは呼ばない。 */
export async function enqueueAndDrainForwardShadow(input: ForwardSourceEventInput) {
  const queued = await enqueueForwardShadow(input);
  if (queued.skipped) return { ...queued, processedEngineSequences: [] as number[] };
  const drained = await drainForwardShadowDispatchQueue();
  return { ...queued, ...drained };
}
