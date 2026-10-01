import { randomUUID } from "node:crypto";
import type { ForwardEvaluationMode, ForwardSourceEventInput } from "./forwardShadow";
import {
  acquireRtForwardShadowStateLock,
  claimOrRetryRtForwardShadowEvent,
  closeRtForwardShadowTrade,
  failRtForwardShadowEvent,
  getRtForwardShadowState,
  getRtStrategyVersion,
  insertRtForwardShadowTrade,
  releaseRtForwardShadowStateLock,
  updateRtForwardShadowEvent,
  upsertRtForwardShadowState,
  upsertRtStrategyVersion,
} from "./db";
import { createForwardShadowLockOwnerToken } from "./forwardShadowLock";
import {
  BASELINE_STRATEGY_GIT_SHA,
  FORWARD_EVALUATION_POLICY,
  KIOXIA_REVERSAL_LONG_EXACT_REOPEN_VERSION,
  getRuntimeIdentity,
  sha256Stable,
} from "./runtimeIdentity";
import {
  KIOXIA_CURRENT_REVERSAL_LONG_EXACT_REOPEN_COLLECTION_START_DATE,
  KIOXIA_CURRENT_REVERSAL_LONG_EXACT_SPEC,
  applyKioxiaCurrentReversalLongExactTransition,
  emptyKioxiaCurrentReversalLongExactState,
  parseKioxiaCurrentReversalLongExactState,
  type KioxiaCurrentReversalLongExactTransition,
} from "./kioxiaCurrentReversalLongExact";

const MODES: readonly ForwardEvaluationMode[] = FORWARD_EVALUATION_POLICY.evaluationModes;
let ensured = false;

async function ensureVersion() {
  if (ensured) return;
  const identity = getRuntimeIdentity();
  const config = {
    ...KIOXIA_CURRENT_REVERSAL_LONG_EXACT_SPEC,
    collectionStartDate: KIOXIA_CURRENT_REVERSAL_LONG_EXACT_REOPEN_COLLECTION_START_DATE,
    formalEvaluationStartDate: KIOXIA_CURRENT_REVERSAL_LONG_EXACT_REOPEN_COLLECTION_START_DATE,
    evaluationPolicy: FORWARD_EVALUATION_POLICY,
    evaluationModes: MODES,
    dryRunOnly: true,
    eligibleForAdoption: false,
    automaticAdoption: false,
    automaticSelection: false,
    orderInstructionConnection: false,
    currentTradeTableConnection: false,
  };
  await upsertRtStrategyVersion({
    versionId: KIOXIA_REVERSAL_LONG_EXACT_REOPEN_VERSION,
    strategyId: "candidate-285a-current-reversal-long-exact-monitoring-reopen",
    baselineGitSha: BASELINE_STRATEGY_GIT_SHA,
    buildGitSha: identity.buildGitSha ?? identity.runtimeBuildIdentifier,
    sourceTreeHash: identity.sourceTreeHash,
    configHash: sha256Stable(config),
    configJson: config,
    learningCutoffDate: "2026-10-01",
    evaluationStartDate: KIOXIA_CURRENT_REVERSAL_LONG_EXACT_REOPEN_COLLECTION_START_DATE,
    evaluationPurpose: "candidate",
    eligibleForAdoption: false,
    status: "monitoring",
    statusReason: "exact_copy_of_stopped_current_reversal_long_monitoring_only_manual_review_required",
  });
  ensured = true;
}

async function acquireWithWait(sourceEventId: string, mode: ForwardEvaluationMode) {
  const ownerToken = createForwardShadowLockOwnerToken({ strategyVersion: KIOXIA_REVERSAL_LONG_EXACT_REOPEN_VERSION, sourceEventId, evaluationMode: mode });
  const deadline = Date.now() + 6_000;
  do {
    if (await acquireRtForwardShadowStateLock({ strategyVersion: KIOXIA_REVERSAL_LONG_EXACT_REOPEN_VERSION, evaluationMode: mode, ownerToken, leaseMs: 8_000 })) return ownerToken;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error(`kioxia_current_reversal_long_exact_lock_timeout:${mode}`);
}

async function processMode(source: ForwardSourceEventInput, mode: ForwardEvaluationMode) {
  const stored = await getRtForwardShadowState({ strategyVersion: KIOXIA_REVERSAL_LONG_EXACT_REOPEN_VERSION, evaluationMode: mode });
  const initial = parseKioxiaCurrentReversalLongExactState(stored?.stateJson, source.candle.tradeDate);
  const initialHash = sha256Stable(initial);
  const claim = await claimOrRetryRtForwardShadowEvent({
    claimToken: randomUUID(),
    leaseMs: 30_000,
    data: {
      strategyVersion: KIOXIA_REVERSAL_LONG_EXACT_REOPEN_VERSION,
      sourceEventId: source.sourceEventId,
      evaluationMode: mode,
      tradeDate: source.candle.tradeDate,
      symbol: source.candle.symbol,
      candleTime: source.candle.candleTime,
      resultType: "pending",
      decisionJson: { status: "claimed", purpose: "exact_current_reopen", route: "kioxiaReversalLong", eligibleForAdoption: false, orderInstructionCreated: false },
      stateHashBefore: initialHash,
      stateHashAfter: initialHash,
    },
  });
  if (claim !== "claimed") return { mode, status: claim };
  let ownerToken: string | null = null;
  try {
    ownerToken = await acquireWithWait(source.sourceEventId, mode);
    const latest = await getRtForwardShadowState({ strategyVersion: KIOXIA_REVERSAL_LONG_EXACT_REOPEN_VERSION, evaluationMode: mode });
    const state = parseKioxiaCurrentReversalLongExactState(latest?.stateJson, source.candle.tradeDate);
    const stateHashBefore = sha256Stable(state);
    const transition: KioxiaCurrentReversalLongExactTransition = applyKioxiaCurrentReversalLongExactTransition(state, source, mode);
    const stateHashAfter = sha256Stable(transition.nextState);
    if (transition.openedPosition) {
      const position = transition.openedPosition;
      await insertRtForwardShadowTrade({
        strategyVersion: KIOXIA_REVERSAL_LONG_EXACT_REOPEN_VERSION,
        evaluationMode: mode,
        symbol: "285A",
        side: "long",
        entrySourceEventId: position.entrySourceEventId,
        entryTradeDate: source.candle.tradeDate,
        signalCandleTime: position.signalTime,
        entryCandleTime: position.entryTime,
        theoreticalSignalPrice: String(position.theoreticalSignalPrice),
        entryPrice: String(position.entryPrice),
        shares: position.shares,
        slPct: String(position.slPct),
        tpPct: String(position.tpPct),
      });
    }
    if (transition.closedPosition) {
      const closed = transition.closedPosition;
      await closeRtForwardShadowTrade({
        strategyVersion: KIOXIA_REVERSAL_LONG_EXACT_REOPEN_VERSION,
        evaluationMode: mode,
        entrySourceEventId: closed.position.entrySourceEventId,
        exitSourceEventId: source.sourceEventId,
        exitTradeDate: source.candle.tradeDate,
        exitCandleTime: source.candle.candleTime,
        exitPrice: String(closed.exitPrice),
        exitReason: closed.exitReason,
        pnl: closed.pnl,
        pnlAfterAdverseExit: closed.pnlAfterAdverseExit,
        realizedR: String(closed.realizedR),
      });
    }
    await upsertRtForwardShadowState({ strategyVersion: KIOXIA_REVERSAL_LONG_EXACT_REOPEN_VERSION, evaluationMode: mode, stateJson: transition.nextState, stateHash: stateHashAfter, lastSourceEventId: source.sourceEventId });
    await updateRtForwardShadowEvent({
      strategyVersion: KIOXIA_REVERSAL_LONG_EXACT_REOPEN_VERSION,
      sourceEventId: source.sourceEventId,
      evaluationMode: mode,
      resultType: transition.resultType,
      decisionJson: {
        actions: transition.actions,
        purpose: "exact_current_reopen",
        route: "kioxiaReversalLong",
        eligibleForAdoption: false,
        automaticAdoption: false,
        automaticSelection: false,
        orderInstructionCreated: false,
        normalTradeTableWritten: false,
        stateHashBefore,
      },
      stateHashAfter,
    });
    return { mode, status: "processed" as const, resultType: transition.resultType, stateHashAfter };
  } catch (error) {
    await failRtForwardShadowEvent({ strategyVersion: KIOXIA_REVERSAL_LONG_EXACT_REOPEN_VERSION, sourceEventId: source.sourceEventId, evaluationMode: mode, errorDetail: String(error), stateHashBefore: initialHash });
    throw error;
  } finally {
    if (ownerToken) await releaseRtForwardShadowStateLock({ strategyVersion: KIOXIA_REVERSAL_LONG_EXACT_REOPEN_VERSION, evaluationMode: mode, ownerToken });
  }
}

export async function processKioxiaCurrentReversalLongExactReopenSourceEvent(source: ForwardSourceEventInput) {
  if (source.candle.symbol !== "285A") return { skipped: "non_285a_symbol" as const };
  if (source.candle.tradeDate < KIOXIA_CURRENT_REVERSAL_LONG_EXACT_REOPEN_COLLECTION_START_DATE) return { skipped: "before_collection_start" as const };
  if (!getRuntimeIdentity().tradingLogicMatchesBaseline) return { skipped: "baseline_trading_logic_mismatch" as const };
  await ensureVersion();
  const version = await getRtStrategyVersion(KIOXIA_REVERSAL_LONG_EXACT_REOPEN_VERSION);
  if (version?.status === "stopped" || version?.status === "insufficient") return { skipped: `strategy_${version.status}` as const };
  const results = [];
  for (const mode of MODES) results.push(await processMode(source, mode));
  return { skipped: false as const, strategyVersion: KIOXIA_REVERSAL_LONG_EXACT_REOPEN_VERSION, results };
}

export function replayKioxiaCurrentReversalLongExactDay(inputs: ForwardSourceEventInput[], mode: ForwardEvaluationMode) {
  let state = emptyKioxiaCurrentReversalLongExactState();
  for (const source of inputs.filter(item => item.candle.symbol === "285A")) state = applyKioxiaCurrentReversalLongExactTransition(state, source, mode).nextState;
  return { state, stateHash: sha256Stable(state) };
}

/** Closed-day replay parity for the exact, separately stateful reopening. */
export function auditKioxiaCurrentReversalLongExactDay(
  sourceEvents: Array<{ sourceEventId: string; status?: string; resultAction?: string | null; payloadJson: unknown }>,
  storedEvents: Array<{ sourceEventId: string; evaluationMode: ForwardEvaluationMode; resultType: string; stateHashBefore: string | null; stateHashAfter: string | null }>,
) {
  let replayedEvents = 0;
  let mismatches = 0;
  let invalidPayloads = 0;
  const stored = new Map(storedEvents.map(item => [`${item.sourceEventId}:${item.evaluationMode}`, item]));
  for (const mode of MODES) {
    let state = emptyKioxiaCurrentReversalLongExactState();
    for (const sourceEvent of sourceEvents) {
      if (sourceEvent.status !== "processed" || sourceEvent.resultAction === "correction_ignored") continue;
      const payload = sourceEvent.payloadJson as Record<string, unknown> | null;
      if (!payload || payload.symbol !== "285A" || typeof payload.tradeDate !== "string" || typeof payload.candleTime !== "string" || ![payload.open, payload.high, payload.low, payload.close, payload.volume].every(value => typeof value === "number")) {
        if (payload?.symbol === "285A") invalidPayloads += 1;
        continue;
      }
      if (payload.tradeDate < KIOXIA_CURRENT_REVERSAL_LONG_EXACT_REOPEN_COLLECTION_START_DATE) continue;
      const source: ForwardSourceEventInput = {
        sourceEventId: sourceEvent.sourceEventId,
        candle: { symbol: "285A", tradeDate: payload.tradeDate, candleTime: payload.candleTime, open: payload.open as number, high: payload.high as number, low: payload.low as number, close: payload.close as number, volume: payload.volume as number },
        board: payload.board ?? null,
      };
      const normalized = parseKioxiaCurrentReversalLongExactState(state, source.candle.tradeDate);
      const before = sha256Stable(normalized);
      const transition = applyKioxiaCurrentReversalLongExactTransition(normalized, source, mode);
      const after = sha256Stable(transition.nextState);
      const saved = stored.get(`${source.sourceEventId}:${mode}`);
      if (saved && (saved.resultType !== transition.resultType || saved.stateHashBefore !== before || saved.stateHashAfter !== after)) mismatches += 1;
      if (saved) replayedEvents += 1;
      state = transition.nextState;
    }
  }
  return { strategyVersion: KIOXIA_REVERSAL_LONG_EXACT_REOPEN_VERSION, replayedEvents, mismatches, invalidPayloads, parity: mismatches === 0 && invalidPayloads === 0 };
}

export function resetKioxiaCurrentReversalLongExactVersionCacheForTest() { ensured = false; }
