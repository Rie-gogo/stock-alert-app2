import { randomUUID } from "node:crypto";
import type { ForwardSourceEventInput } from "./forwardShadow";
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
  getRuntimeIdentity,
  sha256Stable,
} from "./runtimeIdentity";
import {
  TEL_AUDIT_EVALUATION_START_DATE,
  TEL_AUDIT_LEARNING_CUTOFF_DATE,
  TEL_CAUSALITY_AUDIT_VERSION,
  TEL_CURRENT_PARITY_SPEC,
  TEL_CURRENT_PARITY_VERSION,
  applyTelCurrentParityTransition,
  createEmptyTelCurrentParityState,
  type TelCurrentParityState,
  type TelParityInput,
} from "./telCurrentParity";

const MODES = ["signal_quality", "capital_constrained"] as const;
let versionEnsured = false;

async function ensureVersion(): Promise<void> {
  if (versionEnsured) return;
  const identity = getRuntimeIdentity();
  await upsertRtStrategyVersion({
    versionId: TEL_CURRENT_PARITY_VERSION,
    strategyId: "baseline-8035-current-parity",
    baselineGitSha: BASELINE_STRATEGY_GIT_SHA,
    buildGitSha: identity.buildGitSha ?? identity.runtimeBuildIdentifier,
    sourceTreeHash: identity.sourceTreeHash,
    configHash: identity.configHash,
    configJson: TEL_CURRENT_PARITY_SPEC,
    learningCutoffDate: TEL_AUDIT_LEARNING_CUTOFF_DATE,
    evaluationStartDate: TEL_AUDIT_EVALUATION_START_DATE,
    evaluationPurpose: "parity_only",
    eligibleForAdoption: false,
    status: "monitoring",
    statusReason: "現行8035の再現一致専用。因果性違反を保持して診断し、採用審査には使用しない。",
  });
  await upsertRtStrategyVersion({
    versionId: TEL_CAUSALITY_AUDIT_VERSION,
    strategyId: "baseline-8035-causality-audit",
    baselineGitSha: BASELINE_STRATEGY_GIT_SHA,
    buildGitSha: identity.buildGitSha ?? identity.runtimeBuildIdentifier,
    sourceTreeHash: identity.sourceTreeHash,
    configHash: identity.configHash,
    configJson: {
      strategyVersion: TEL_CAUSALITY_AUDIT_VERSION,
      sourceParityVersion: TEL_CURRENT_PARITY_VERSION,
      purpose: "causality_audit",
      eligibleForAdoption: false,
      observedAtRule: "feature_observed_at_must_be_lte_decision_started_at",
      priceSemantics: TEL_CURRENT_PARITY_SPEC.priceSemantics,
    },
    learningCutoffDate: TEL_AUDIT_LEARNING_CUTOFF_DATE,
    evaluationStartDate: TEL_AUDIT_EVALUATION_START_DATE,
    evaluationPurpose: "causality_audit",
    eligibleForAdoption: false,
    status: "monitoring",
    statusReason: "現行8035の利用情報・価格の因果性診断専用。採用審査には使用しない。",
  });
  versionEnsured = true;
}

async function acquireWithWait(sourceEventId: string, mode: typeof MODES[number]) {
  const ownerToken = createForwardShadowLockOwnerToken({
    strategyVersion: TEL_CURRENT_PARITY_VERSION,
    sourceEventId,
    evaluationMode: mode,
  });
  const deadline = Date.now() + 6_000;
  do {
    if (await acquireRtForwardShadowStateLock({
      strategyVersion: TEL_CURRENT_PARITY_VERSION,
      evaluationMode: mode,
      ownerToken,
      leaseMs: 8_000,
    })) return ownerToken;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error(`tel_current_parity_state_lock_timeout:${mode}`);
}

function pnlAfterAdverseExit(input: {
  side: "long" | "short";
  entryPrice: number;
  exitPrice: number;
  shares: number;
}) {
  const adverse = input.side === "long" ? input.exitPrice * 0.999 : input.exitPrice * 1.001;
  return Math.round((input.side === "long"
    ? adverse - input.entryPrice
    : input.entryPrice - adverse) * input.shares);
}

async function processMode(input: ForwardSourceEventInput, mode: typeof MODES[number], marginUsedBefore: number) {
  const claimToken = randomUUID();
  const existingState = await getRtForwardShadowState({
    strategyVersion: TEL_CURRENT_PARITY_VERSION,
    evaluationMode: mode,
  });
  const stateBefore = existingState?.stateJson
    ? existingState.stateJson as TelCurrentParityState
    : createEmptyTelCurrentParityState();
  const stateHashBefore = sha256Stable(stateBefore);
  const claim = await claimOrRetryRtForwardShadowEvent({
    data: {
      strategyVersion: TEL_CURRENT_PARITY_VERSION,
      sourceEventId: input.sourceEventId,
      evaluationMode: mode,
      tradeDate: input.candle.tradeDate,
      symbol: input.candle.symbol,
      candleTime: input.candle.candleTime,
      resultType: "pending",
      decisionJson: { status: "claimed", purpose: "parity_only" },
      stateHashBefore,
      stateHashAfter: stateHashBefore,
    },
    claimToken,
    leaseMs: 30_000,
  });
  if (claim !== "claimed") return { mode, status: claim };

  let ownerToken: string | null = null;
  try {
    ownerToken = await acquireWithWait(input.sourceEventId, mode);
    const latestState = await getRtForwardShadowState({
      strategyVersion: TEL_CURRENT_PARITY_VERSION,
      evaluationMode: mode,
    });
    const state = latestState?.stateJson
      ? latestState.stateJson as TelCurrentParityState
      : createEmptyTelCurrentParityState();
    const actualStateHashBefore = sha256Stable(state);
    const parityInput: TelParityInput = {
      sourceEventId: input.sourceEventId,
      candle: input.candle,
      board: input.board,
      marginUsedBefore: mode === "signal_quality" ? 0 : marginUsedBefore,
      evaluationMode: mode,
    };
    const transition = applyTelCurrentParityTransition(state, parityInput);
    const stateHashAfter = sha256Stable(transition.nextState);
    await upsertRtForwardShadowState({
      strategyVersion: TEL_CURRENT_PARITY_VERSION,
      evaluationMode: mode,
      stateJson: transition.nextState,
      stateHash: stateHashAfter,
      lastSourceEventId: input.sourceEventId,
    });
    if (transition.openedPosition) {
      const position = transition.openedPosition;
      await insertRtForwardShadowTrade({
        strategyVersion: TEL_CURRENT_PARITY_VERSION,
        evaluationMode: mode,
        symbol: "8035",
        side: position.side,
        entrySourceEventId: position.entrySourceEventId,
        entryTradeDate: input.candle.tradeDate,
        signalCandleTime: position.entryTime,
        entryCandleTime: position.entryTime,
        theoreticalSignalPrice: String(position.entryPrice),
        entryPrice: String(position.entryPrice),
        shares: position.shares,
        slPct: String(position.slPct),
        tpPct: String(position.tpPct),
      });
    }
    if (transition.closedPosition) {
      const position = transition.closedPosition;
      const riskAmount = position.entryPrice * position.shares * position.slPct / 100;
      await closeRtForwardShadowTrade({
        strategyVersion: TEL_CURRENT_PARITY_VERSION,
        evaluationMode: mode,
        entrySourceEventId: position.entrySourceEventId,
        exitSourceEventId: input.sourceEventId,
        exitTradeDate: input.candle.tradeDate,
        exitCandleTime: input.candle.candleTime,
        exitPrice: String(position.exitPrice),
        exitReason: position.exitReason,
        pnl: Math.round(position.pnl),
        pnlAfterAdverseExit: pnlAfterAdverseExit({
          side: position.side,
          entryPrice: position.entryPrice,
          exitPrice: position.exitPrice,
          shares: position.shares,
        }),
        realizedR: String(riskAmount > 0 ? position.pnl / riskAmount : 0),
      });
    }
    await updateRtForwardShadowEvent({
      strategyVersion: TEL_CURRENT_PARITY_VERSION,
      sourceEventId: input.sourceEventId,
      evaluationMode: mode,
      resultType: transition.resultType,
      decisionJson: {
        ...transition.decision,
        purpose: "parity_only",
        eligibleForAdoption: false,
        priceSemantics: TEL_CURRENT_PARITY_SPEC.priceSemantics,
        stateHashBefore: actualStateHashBefore,
      },
      stateHashAfter,
    });
    return { mode, status: "processed" as const, resultType: transition.resultType, stateHashAfter };
  } catch (error) {
    await failRtForwardShadowEvent({
      strategyVersion: TEL_CURRENT_PARITY_VERSION,
      sourceEventId: input.sourceEventId,
      evaluationMode: mode,
      errorDetail: String(error),
      stateHashBefore,
    });
    throw error;
  } finally {
    if (ownerToken) {
      await releaseRtForwardShadowStateLock({
        strategyVersion: TEL_CURRENT_PARITY_VERSION,
        evaluationMode: mode,
        ownerToken,
      });
    }
  }
}

export async function processTelCurrentParitySourceEvent(input: ForwardSourceEventInput, marginUsedBefore = 0) {
  if (input.candle.symbol !== "8035") return { skipped: "non_8035_symbol" as const };
  if (input.candle.tradeDate < TEL_AUDIT_EVALUATION_START_DATE) {
    return { skipped: "before_evaluation_start" as const };
  }
  const identity = getRuntimeIdentity();
  if (!identity.tradingLogicMatchesBaseline) return { skipped: "baseline_trading_logic_mismatch" as const };
  await ensureVersion();
  const version = await getRtStrategyVersion(TEL_CURRENT_PARITY_VERSION);
  if (version?.status === "stopped" || version?.status === "insufficient") {
    return { skipped: `strategy_${version.status}` as const };
  }
  const evaluations = [];
  for (const mode of MODES) evaluations.push(await processMode(input, mode, marginUsedBefore));
  return { skipped: false as const, strategyVersion: TEL_CURRENT_PARITY_VERSION, evaluations };
}

export function resetTelCurrentParityVersionCacheForTest() {
  versionEnsured = false;
}
