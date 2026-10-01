import { randomUUID } from "node:crypto";
import type { ForwardEvaluationMode, ForwardSourceEventInput } from "./forwardShadow";
import { acquireRtForwardShadowStateLock, claimOrRetryRtForwardShadowEvent, closeRtForwardShadowTrade, failRtForwardShadowEvent, getRtForwardShadowState, getRtStrategyVersion, insertRtForwardShadowTrade, releaseRtForwardShadowStateLock, updateRtForwardShadowEvent, upsertRtForwardShadowState, upsertRtStrategyVersion } from "./db";
import { createForwardShadowLockOwnerToken } from "./forwardShadowLock";
import { BASELINE_STRATEGY_GIT_SHA, FORWARD_EVALUATION_POLICY, KIOXIA_REVERSAL_LONG_REOPEN_VERSION, getRuntimeIdentity, sha256Stable } from "./runtimeIdentity";
import { KIOXIA_ATR_FORWARD_SHADOW_SPEC, applyKioxiaReversalLongReopenTransition, emptyKioxiaAtrForwardState, parseKioxiaAtrForwardState, type KioxiaAtrForwardTransition } from "./kioxiaAtrForwardShadow";

export const KIOXIA_REVERSAL_LONG_REOPEN_COLLECTION_START_DATE = "2026-10-02";
const MODES: readonly ForwardEvaluationMode[] = FORWARD_EVALUATION_POLICY.evaluationModes;
let ensured = false;

async function ensureVersion() {
  if (ensured) return;
  const identity = getRuntimeIdentity();
  const config = {
    ...KIOXIA_ATR_FORWARD_SHADOW_SPEC.routes.reversal_long,
    candidateKey: "285a_reversal_long_monitoring_reopen",
    parentCompositeVersion: "forward-shadow-285a-five-routes-atr036-route-daily-end-v1",
    routeId: "reversal_long",
    collectionStartDate: KIOXIA_REVERSAL_LONG_REOPEN_COLLECTION_START_DATE,
    evaluationPurpose: "candidate_monitoring_reopen",
    dryRunOnly: true,
    eligibleForAdoption: false,
    automaticAdoption: false,
    orderInstructionConnection: false,
    currentTradeTableConnection: false,
    evaluationModes: MODES,
  };
  await upsertRtStrategyVersion({
    versionId: KIOXIA_REVERSAL_LONG_REOPEN_VERSION,
    strategyId: "candidate-285a-reversal-long-monitoring-reopen",
    baselineGitSha: BASELINE_STRATEGY_GIT_SHA,
    buildGitSha: identity.buildGitSha ?? identity.runtimeBuildIdentifier,
    sourceTreeHash: identity.sourceTreeHash,
    configHash: sha256Stable(config),
    configJson: config,
    learningCutoffDate: "2026-10-01",
    evaluationStartDate: KIOXIA_REVERSAL_LONG_REOPEN_COLLECTION_START_DATE,
    evaluationPurpose: "candidate",
    eligibleForAdoption: false,
    status: "monitoring",
    statusReason: "monitoring_reopen_formal_evaluation_gate_pending_manual_review_only",
  });
  ensured = true;
}
async function processMode(source: ForwardSourceEventInput, mode: ForwardEvaluationMode) {
  const base = emptyKioxiaAtrForwardState();
  const existing = await getRtForwardShadowState({ strategyVersion: KIOXIA_REVERSAL_LONG_REOPEN_VERSION, evaluationMode: mode });
  const initial = parseKioxiaAtrForwardState(existing?.stateJson ?? base);
  const initialHash = sha256Stable(initial);
  const claim = await claimOrRetryRtForwardShadowEvent({ claimToken: randomUUID(), leaseMs: 30_000, data: { strategyVersion: KIOXIA_REVERSAL_LONG_REOPEN_VERSION, sourceEventId: source.sourceEventId, evaluationMode: mode, tradeDate: source.candle.tradeDate, symbol: source.candle.symbol, candleTime: source.candle.candleTime, resultType: "pending", decisionJson: { status: "claimed", purpose: "candidate_monitoring_reopen", route: "reversal_long", eligibleForAdoption: false }, stateHashBefore: initialHash, stateHashAfter: initialHash } });
  if (claim !== "claimed") return { mode, status: claim };
  const ownerToken = createForwardShadowLockOwnerToken({ strategyVersion: KIOXIA_REVERSAL_LONG_REOPEN_VERSION, sourceEventId: source.sourceEventId, evaluationMode: mode });
  try {
    if (!await acquireRtForwardShadowStateLock({ strategyVersion: KIOXIA_REVERSAL_LONG_REOPEN_VERSION, evaluationMode: mode, ownerToken, leaseMs: 8_000 })) throw new Error("kioxia_reversal_reopen_state_lock_busy");
    const current = await getRtForwardShadowState({ strategyVersion: KIOXIA_REVERSAL_LONG_REOPEN_VERSION, evaluationMode: mode });
    const transition: KioxiaAtrForwardTransition = applyKioxiaReversalLongReopenTransition(parseKioxiaAtrForwardState(current?.stateJson), source, mode);
    const before = sha256Stable(parseKioxiaAtrForwardState(current?.stateJson));
    const after = sha256Stable(transition.nextState);
    if (transition.openedPosition) await insertRtForwardShadowTrade({ strategyVersion: KIOXIA_REVERSAL_LONG_REOPEN_VERSION, evaluationMode: mode, symbol: "285A", side: "long", entrySourceEventId: transition.openedPosition.entrySourceEventId, entryTradeDate: source.candle.tradeDate, signalCandleTime: transition.openedPosition.signalTime, entryCandleTime: transition.openedPosition.entryTime, theoreticalSignalPrice: String(transition.openedPosition.theoreticalSignalPrice), entryPrice: String(transition.openedPosition.entryPrice), shares: transition.openedPosition.shares, slPct: String(transition.openedPosition.slPct), tpPct: String(transition.openedPosition.tpPct) });
    if (transition.closedPosition) await closeRtForwardShadowTrade({ strategyVersion: KIOXIA_REVERSAL_LONG_REOPEN_VERSION, evaluationMode: mode, entrySourceEventId: transition.closedPosition.position.entrySourceEventId, exitSourceEventId: source.sourceEventId, exitTradeDate: source.candle.tradeDate, exitCandleTime: source.candle.candleTime, exitPrice: String(transition.closedPosition.exitPrice), exitReason: transition.closedPosition.exitReason, pnl: transition.closedPosition.pnl, pnlAfterAdverseExit: transition.closedPosition.pnlAfterAdverseExit, realizedR: String(transition.closedPosition.realizedR) });
    await upsertRtForwardShadowState({ strategyVersion: KIOXIA_REVERSAL_LONG_REOPEN_VERSION, evaluationMode: mode, stateJson: transition.nextState, stateHash: after, lastSourceEventId: source.sourceEventId });
    await updateRtForwardShadowEvent({ strategyVersion: KIOXIA_REVERSAL_LONG_REOPEN_VERSION, sourceEventId: source.sourceEventId, evaluationMode: mode, resultType: transition.resultType, decisionJson: { actions: transition.actions, purpose: "candidate_monitoring_reopen", route: "reversal_long", eligibleForAdoption: false, automaticAdoption: false, orderInstructionCreated: false, normalTradeTableWritten: false, stateHashBefore: before }, stateHashAfter: after });
    return { mode, status: "processed" as const, resultType: transition.resultType };
  } catch (error) {
    await failRtForwardShadowEvent({ strategyVersion: KIOXIA_REVERSAL_LONG_REOPEN_VERSION, sourceEventId: source.sourceEventId, evaluationMode: mode, errorDetail: String(error), stateHashBefore: initialHash });
    throw error;
  } finally { await releaseRtForwardShadowStateLock({ strategyVersion: KIOXIA_REVERSAL_LONG_REOPEN_VERSION, evaluationMode: mode, ownerToken }); }
}
export async function processKioxiaReversalLongReopenSourceEvent(source: ForwardSourceEventInput) {
  if (source.candle.symbol !== "285A") return { skipped: "non_285a_symbol" as const };
  if (source.candle.tradeDate < KIOXIA_REVERSAL_LONG_REOPEN_COLLECTION_START_DATE) return { skipped: "before_collection_start" as const };
  if (!getRuntimeIdentity().tradingLogicMatchesBaseline) return { skipped: "baseline_trading_logic_mismatch" as const };
  await ensureVersion();
  const version = await getRtStrategyVersion(KIOXIA_REVERSAL_LONG_REOPEN_VERSION);
  if (version?.status === "stopped" || version?.status === "insufficient") return { skipped: `strategy_${version.status}` as const };
  const results = await Promise.all(MODES.map(mode => processMode(source, mode)));
  return { skipped: false as const, strategyVersion: KIOXIA_REVERSAL_LONG_REOPEN_VERSION, results };
}
export function resetKioxiaReversalLongReopenVersionCacheForTest() { ensured = false; }

/** Closed-day parity audit for the separate reopening state. No writes, no order path. */
export function auditKioxiaReversalLongReopenDay(sourceEvents: Array<{ sourceEventId: string; status?: string; resultAction?: string | null; payloadJson: unknown }>, storedEvents: Array<{ sourceEventId: string; evaluationMode: ForwardEvaluationMode; resultType: string; stateHashBefore: string | null; stateHashAfter: string | null }>) {
  let replayedEvents = 0; let mismatches = 0; let invalidPayloads = 0;
  const stored = new Map(storedEvents.map(item => [`${item.sourceEventId}:${item.evaluationMode}`, item]));
  for (const mode of MODES) {
    let state = emptyKioxiaAtrForwardState();
    for (const sourceEvent of sourceEvents) {
      if (sourceEvent.status !== "processed" || sourceEvent.resultAction === "correction_ignored") continue;
      const payload = sourceEvent.payloadJson as Record<string, unknown> | null;
      if (!payload || payload.symbol !== "285A" || typeof payload.tradeDate !== "string" || typeof payload.candleTime !== "string" || ![payload.open, payload.high, payload.low, payload.close, payload.volume].every(value => typeof value === "number")) { if (payload?.symbol === "285A") invalidPayloads += 1; continue; }
      const source: ForwardSourceEventInput = { sourceEventId: sourceEvent.sourceEventId, candle: { symbol: "285A", tradeDate: payload.tradeDate, candleTime: payload.candleTime, open: payload.open as number, high: payload.high as number, low: payload.low as number, close: payload.close as number, volume: payload.volume as number }, board: payload.board ?? null };
      if (source.candle.tradeDate < KIOXIA_REVERSAL_LONG_REOPEN_COLLECTION_START_DATE) continue;
      const before = sha256Stable(parseKioxiaAtrForwardState(state));
      const transition = applyKioxiaReversalLongReopenTransition(state, source, mode);
      const after = sha256Stable(transition.nextState);
      const saved = stored.get(`${source.sourceEventId}:${mode}`);
      if (saved && (saved.resultType !== transition.resultType || saved.stateHashBefore !== before || saved.stateHashAfter !== after)) mismatches += 1;
      state = transition.nextState; replayedEvents += 1;
    }
  }
  return { strategyVersion: KIOXIA_REVERSAL_LONG_REOPEN_VERSION, replayedEvents, mismatches, invalidPayloads, parity: mismatches === 0 && invalidPayloads === 0 };
}
