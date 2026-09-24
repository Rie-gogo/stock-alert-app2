import { drainCurrentCandidateVirtualQueue } from "./realtimeDecisionAudit";

export const REALTIME_CANDIDATE_DRAIN_LIMITS = Object.freeze({
  maxRows: 8,
  maxDurationMs: 1_500,
  maxAttempts: 5,
});

const FAST_RESCHEDULE_MS = 25;
const WORKER_BUSY_RESCHEDULE_MS = 250;
const RETRYABLE_ERROR_RESCHEDULE_MS = 1_000;

let realtimeDrainScheduled = false;
let realtimeDrainRunning = false;
let realtimeDrainRequested = false;

async function runRealtimeCandidateDrain(): Promise<void> {
  if (realtimeDrainRunning) return;
  realtimeDrainRunning = true;
  let nextDelayMs: number | null = null;
  try {
    const result = await drainCurrentCandidateVirtualQueue(REALTIME_CANDIDATE_DRAIN_LIMITS);
    if (result.stoppedReason === "max_batch" || result.stoppedReason === "max_duration") {
      nextDelayMs = FAST_RESCHEDULE_MS;
    } else if (result.stoppedReason === "worker_busy") {
      nextDelayMs = WORKER_BUSY_RESCHEDULE_MS;
    } else if (result.stoppedReason === "retryable_error") {
      nextDelayMs = RETRYABLE_ERROR_RESCHEDULE_MS;
    }
  } catch (error) {
    // 永続outboxは残る。短い間隔でDBを連打せず、次のsource event・起動時回収・2分cronでも再開する。
    console.error("[CandidateVirtualWorker] 受信後の非同期drainに失敗。永続outboxから再試行します:", error);
    nextDelayMs = RETRYABLE_ERROR_RESCHEDULE_MS;
  } finally {
    realtimeDrainRunning = false;
    if (realtimeDrainRequested) {
      realtimeDrainRequested = false;
      nextDelayMs = nextDelayMs === null ? FAST_RESCHEDULE_MS : Math.min(nextDelayMs, FAST_RESCHEDULE_MS);
    }
    if (nextDelayMs !== null) scheduleCurrentCandidateVirtualDrain(nextDelayMs);
  }
}

/**
 * 現行売買のHTTP応答を待たせず、保存済みcandidate/virtual outboxだけを小分けに処理する。
 * 2分cronはruntime停止・再起動・一時エラー時の回復経路として引き続き残す。
 */
export function scheduleCurrentCandidateVirtualDrain(delayMs = 0): void {
  if (realtimeDrainRunning) {
    realtimeDrainRequested = true;
    return;
  }
  if (realtimeDrainScheduled) return;
  realtimeDrainScheduled = true;
  setTimeout(() => {
    realtimeDrainScheduled = false;
    void runRealtimeCandidateDrain();
  }, delayMs);
  // source event直後にworkerを確実に開始させるため、この短いtimerはunrefしない。
}
