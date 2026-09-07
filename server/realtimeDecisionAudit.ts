import { randomUUID } from "node:crypto";
import type { RtSourceEvent } from "../drizzle/schema";
import {
  acquireRtCandidateVirtualWorkerLock,
  acquireRtCurrentEngineLock,
  claimNextRtCandidateVirtualWork,
  completeRtCandidateVirtualWork,
  getRtSignalCandidateBySourceEventId,
  getLatestRtTradeAt,
  insertRtRealtimeDecisionEvent,
  markRtCandidateVirtualPhaseComplete,
  markRtCandidateVirtualPhaseError,
  markRtCandidateVirtualPhaseProcessing,
  markRtPortfolioMaterializationsDirtyFrom,
  releaseRtCandidateVirtualWorkerLock,
  releaseRtCurrentEngineLock,
  terminalizeExhaustedRtCandidateVirtualWork,
  upsertRtSignalCandidate,
} from "./db";
import type { KabuOrderBook } from "./kabuStation";
import {
  getCandleCounters,
  getDashboardStatus,
  getOpenPositions,
  getSignalHistory,
  getSymbolPnlMap,
  type RtCandle1Min,
} from "./realtimeSimEngine";
import { sha256Stable } from "./runtimeIdentity";
import {
  CURRENT_SIGNAL_CANDIDATE_VERSION,
  parseMarginCandidateReason,
  parseRequiredMarginFromReason,
  resolveCurrentRouteSpec,
  type CandidateSide,
} from "./currentSignalCandidateRegistry";
import { processSignalQualityVirtualTradesForEvent } from "./signalCandidateVirtualEngine";
import type { RtRealtimeDecisionEvent, RtSignalCandidate } from "../drizzle/schema";
import {
  deriveCurrentBoardExitSignal,
  deriveCurrentRawSignalForEvent,
} from "./currentVirtualMarketContext";

export const CURRENT_REALTIME_AUDIT_VERSION = "current-realtime-audit-v1";
const CURRENT_ENGINE_LOCK_NAME = "current-realtime-engine-v1";
const LOCK_WAIT_MS = 10_000;
const LOCK_RETRY_MS = 100;

export type CurrentEngineResult = {
  symbol: string;
  tradeDate: string;
  candleTime: string;
  action: "entry" | "exit" | "stop_loss" | "take_profit" | "forced_close" | "none";
  reason?: string;
  pnl?: number;
};

type CandidateVirtualWorkPayload = {
  sourceEvent: Pick<RtSourceEvent, "id" | "sourceEventId" | "relayReceivedAtMs">;
  candle: RtCandle1Min;
  inputHash: string;
  auditReason: string | null;
  candidateReason: string | null;
  resultType: "no_signal" | "pending" | "rejected" | "entry" | "hold" | "exit";
  decisionSignal: ReturnType<typeof getSignalHistory>[number] | null;
  latestTrade: Awaited<ReturnType<typeof getLatestRtTradeAt>>;
  marginUsedBefore: number;
  decisionCompletedAtMs: number;
  rawSignal: Awaited<ReturnType<typeof deriveCurrentRawSignalForEvent>>;
  boardSignal: ReturnType<typeof deriveCurrentBoardExitSignal>;
  marketContextError: string | null;
  candidateDescriptorStatus?: "not_candidate" | "complete" | "error";
  candidateDescriptor: CandidateDescriptor | null;
  candidateDescriptorError: string | null;
};

type CandidateDescriptor = {
  side: CandidateSide;
  routeId: string;
  signalReason: string;
  capitalShares: number;
  requiredMargin: number;
  realtimeDecision: "accepted" | "margin_block";
  routeSpec: ReturnType<typeof resolveCurrentRouteSpec>;
};

export type AuditedCurrentEngineResult = {
  result: CurrentEngineResult;
  audit: {
    saved: boolean;
    engineSequence: number | null;
    resultType: "no_signal" | "pending" | "rejected" | "entry" | "hold" | "exit";
    routeId: string | null;
    marginUsedBefore: number;
    marginUsedAfter: number;
    stateHashBefore: string;
    stateHashAfter: string;
    causalityStatus: "pass" | "violation" | "unverified" | "not_applicable";
    causalityReason: string;
    boardObservedAtMs: number | null;
    relayAssembledAtMs: number | null;
    relaySentAtMs: number | null;
    cloudReceivedAtMs: number | null;
    decisionStartedAtMs: number;
    decisionCompletedAtMs: number;
    error?: string;
  };
};

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function createOwnerToken(sourceEventId: string): string {
  return sha256Stable({
    scope: CURRENT_ENGINE_LOCK_NAME,
    sourceEventId,
    nonce: randomUUID(),
  });
}

async function acquireWithWait(sourceEventId: string): Promise<string> {
  const ownerToken = createOwnerToken(sourceEventId);
  const deadline = Date.now() + LOCK_WAIT_MS;
  do {
    if (await acquireRtCurrentEngineLock({
      lockName: CURRENT_ENGINE_LOCK_NAME,
      ownerToken,
      leaseMs: 30_000,
    })) return ownerToken;
    await sleep(LOCK_RETRY_MS);
  } while (Date.now() < deadline);
  throw new Error(`current_engine_lock_timeout:${sourceEventId}`);
}

function sortRecord<T>(value: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * 現行売買ファイルを変更せずに取得できる外部状態だけを保存する。
 * pending内部状態は8035 parity版が別状態で保持し、coverageで未収録を明示する。
 */
export function captureRealtimeAuditState(symbol: string) {
  const dashboard = getDashboardStatus();
  const positions = getOpenPositions()
    .map(position => ({ ...position }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
  const counters = sortRecord(getCandleCounters());
  const pnl = sortRecord(getSymbolPnlMap());
  const latestSymbolSignals = getSignalHistory(100)
    .filter(event => event.symbol === symbol)
    .slice(0, 10)
    .map(event => ({ ...event }));
  return {
    version: CURRENT_REALTIME_AUDIT_VERSION,
    coverage: {
      externalRuntimeState: true,
      openPositions: true,
      symbolPnl: true,
      candleCounters: true,
      latestSymbolSignals: true,
      internalPendingState: false,
      internalFiredSets: false,
    },
    currentTradeDate: dashboard.currentTradeDate,
    lastCandleReceivedAt: dashboard.lastCandleReceivedAt,
    symbol,
    symbolCandleCount: counters[symbol] ?? 0,
    symbolPnl: pnl[symbol] ?? 0,
    counters,
    pnl,
    positions,
    latestSymbolSignals,
  };
}

/** 接続監視用の壁時計値を除外し、同じ入力列なら同じ値になる状態ハッシュを作る。 */
export function hashRealtimeAuditState(state: ReturnType<typeof captureRealtimeAuditState>): string {
  const { lastCandleReceivedAt: _volatileObservedAt, ...deterministicState } = state;
  return sha256Stable(deterministicState);
}

export function resolveRealtimeRouteId(reason: string | null | undefined): string | null {
  const value = reason ?? "";
  const routes: Array<[RegExp, string]> = [
    [/東京エレクトロン(?:始値方向付き)?短期ブレイク.*LONG/i, "8035_open_direction_breakout_long"],
    [/東京エレクトロン(?:始値方向付き)?短期ブレイク.*SHORT/i, "8035_open_direction_breakout_short"],
    [/キオクシア確認型前場LONG/i, "285A_confirmed_morning_long"],
    [/反転LONG/i, "reversal_long"],
    [/反転SHORT/i, "reversal_short"],
    [/順張りLONG/i, "trend_long"],
    [/順張りSHORT/i, "trend_short"],
    [/大台割れSHORT|安全CB/i, "safe_cb_short"],
    [/安値反転ブレイクLONG/i, "low_reversal_break_long"],
    [/高値失速ブレイクSHORT/i, "high_fade_break_short"],
    [/後場安値更新SHORT/i, "afternoon_low_break_short"],
    [/寄り付き.*SHORT/i, "opening_break_short"],
    [/確認型.*LONG/i, "confirmed_break_long"],
    [/15本安値更新/i, "sumco_15bar_breakdown_short"],
    [/10本高値更新/i, "ten_bar_breakout_long"],
  ];
  return routes.find(([pattern]) => pattern.test(value))?.[1] ?? null;
}

function classifyResult(result: CurrentEngineResult, hasPositionAfter: boolean, auditReason?: string | null) {
  if (result.action === "entry") return "entry" as const;
  if (["exit", "stop_loss", "take_profit", "forced_close"].includes(result.action)) return "exit" as const;
  const reason = auditReason ?? result.reason ?? "";
  if (/pending|確認待ち|保留/i.test(reason)) return "pending" as const;
  if (/block|reject|拒否|margin|証拠金/i.test(reason)) return "rejected" as const;
  if (hasPositionAfter) return "hold" as const;
  return "no_signal" as const;
}

function evaluateCausality(input: {
  result: CurrentEngineResult;
  latestTrade: Awaited<ReturnType<typeof getLatestRtTradeAt>>;
  board: Omit<KabuOrderBook, "symbol" | "receivedAt"> | null;
}) {
  const trade = input.latestTrade;
  if (input.result.action === "entry") {
    return {
      status: "violation" as const,
      reason: "current_engine_bar_close_fill_is_not_executable_after_candle_receipt",
    };
  }
  if (trade && /時間決済|最大保有|前場強制決済/.test(trade.reason)) {
    return {
      status: "violation" as const,
      reason: "completed_bar_open_or_intrabar_price_used_after_candle_receipt",
    };
  }
  if (["stop_loss", "take_profit"].includes(input.result.action)) {
    return {
      status: "unverified" as const,
      reason: "bar_high_low_triggered_simulated_fill_requires_separate_execution_model",
    };
  }
  if (input.result.action === "none") {
    return {
      status: "pass" as const,
      reason: "no_fill_price_used",
    };
  }
  return {
    status: input.board?.currentPrice ? "pass" as const : "unverified" as const,
    reason: input.board?.currentPrice
      ? "board_current_price_observed_at_or_before_decision"
      : "board_current_price_missing",
  };
}

function currentMarginUsed(): number {
  return Math.round(getOpenPositions().reduce(
    (sum, position) => sum + position.entryPrice * position.shares,
    0,
  ));
}

function inferCandidateSide(input: {
  latestTrade: Awaited<ReturnType<typeof getLatestRtTradeAt>>;
  decisionSignal: ReturnType<typeof getSignalHistory>[number] | undefined;
  rawSignal: Awaited<ReturnType<typeof deriveCurrentRawSignalForEvent>>;
}): CandidateSide | null {
  if (input.latestTrade?.side === "long" || input.latestTrade?.side === "short") return input.latestTrade.side;
  if (input.decisionSignal?.action === "buy") return "long";
  if (input.decisionSignal?.action === "short") return "short";
  if (input.rawSignal?.type === "buy") return "long";
  if (input.rawSignal?.type === "sell") return "short";
  return null;
}

function buildCandidateDescriptor(input: {
  candle: RtCandle1Min;
  auditReason: string | null;
  candidateReason: string | null;
  resultType: AuditedCurrentEngineResult["audit"]["resultType"];
  decisionSignal: ReturnType<typeof getSignalHistory>[number] | undefined;
  latestTrade: Awaited<ReturnType<typeof getLatestRtTradeAt>>;
  rawSignal: Awaited<ReturnType<typeof deriveCurrentRawSignalForEvent>>;
}): CandidateDescriptor | null {
  const isAccepted = input.resultType === "entry"
    && (input.latestTrade?.action === "buy" || input.latestTrade?.action === "short");
  const isMarginBlock = input.resultType === "rejected"
    && /証拠金(?:ブロック|使用率制限)|margin_block/i.test(input.candidateReason ?? input.auditReason ?? "");
  if (!isAccepted && !isMarginBlock) return null;
  const signalReason = isMarginBlock
    ? parseMarginCandidateReason(input.candidateReason)
    : input.latestTrade?.reason ?? input.auditReason;
  if (!signalReason) throw new Error(`candidate_reason_missing:${input.candle.symbol}:${input.candle.tradeDate}:${input.candle.candleTime}`);
  const side = inferCandidateSide({
    latestTrade: input.latestTrade,
    decisionSignal: input.decisionSignal,
    rawSignal: input.rawSignal,
  });
  if (!side) throw new Error(`candidate_side_missing:${input.candle.symbol}:${input.candle.tradeDate}:${input.candle.candleTime}`);
  const routeSpec = resolveCurrentRouteSpec({
    symbol: input.candle.symbol,
    side,
    reason: signalReason,
    entryCandleTime: input.candle.candleTime,
  });
  const price = input.candle.close;
  const reconstructedShares = Math.floor((3_000_000 * 0.9) / price / 100) * 100;
  const capitalShares = isAccepted && input.latestTrade?.shares
    ? input.latestTrade.shares
    : reconstructedShares;
  const requiredMargin = isAccepted && input.latestTrade?.amount
    ? Math.round(input.latestTrade.amount)
    : parseRequiredMarginFromReason(input.candidateReason) ?? Math.round(price * capitalShares);
  return {
    side,
    routeId: routeSpec.routeId,
    signalReason,
    capitalShares,
    requiredMargin,
    realtimeDecision: isAccepted ? "accepted" : "margin_block",
    routeSpec,
  };
}

async function saveStructuredCandidate(input: {
  sourceEvent: Pick<RtSourceEvent, "id" | "sourceEventId" | "relayReceivedAtMs">;
  candle: RtCandle1Min;
  inputHash: string;
  auditId: number;
  descriptor: CandidateDescriptor | null;
  marginUsedBefore: number;
  decisionCompletedAtMs: number;
}): Promise<RtSignalCandidate | null> {
  const descriptor = input.descriptor;
  if (!descriptor) return null;
  const price = input.candle.close;

  const candidate = await upsertRtSignalCandidate({
    candidateVersion: CURRENT_SIGNAL_CANDIDATE_VERSION,
    sourceEventId: input.sourceEvent.sourceEventId,
    sourceEventDbId: input.sourceEvent.id,
    engineSequence: input.auditId,
    tradeDate: input.candle.tradeDate,
    candleTime: input.candle.candleTime,
    symbol: input.candle.symbol,
    routeId: descriptor.routeId,
    side: descriptor.side,
    signalReason: descriptor.signalReason,
    theoreticalEntryPrice: String(price),
    signalQualityShares: 100,
    capitalShares: descriptor.capitalShares,
    requiredMargin: descriptor.requiredMargin,
    marginUsedBefore: input.marginUsedBefore,
    marginLimit: 8_910_000,
    realtimeDecision: descriptor.realtimeDecision,
    slPct: String(descriptor.routeSpec.slPct),
    tpPct: String(descriptor.routeSpec.tpPct),
    maxHoldingMinutes: descriptor.routeSpec.maxHoldingMinutes,
    sessionExitTime: descriptor.routeSpec.sessionExitTime,
    profitProtectionJson: descriptor.routeSpec.profitProtection,
    entryObservedAtMs: input.sourceEvent.relayReceivedAtMs,
    decisionAtMs: input.decisionCompletedAtMs,
    inputJson: {
      auditVersion: CURRENT_REALTIME_AUDIT_VERSION,
      realtimeDecisionId: input.auditId,
      inputHash: input.inputHash,
      acceptedByCurrentRealtime: descriptor.realtimeDecision === "accepted",
      marginBlockedByCurrentRealtime: descriptor.realtimeDecision === "margin_block",
      requiredMarginSource: descriptor.realtimeDecision === "accepted" ? "rt_trade_amount" : "margin_block_reason_or_reconstructed",
      eligibleNominalRiskReward: descriptor.routeSpec.eligibleNominalRiskReward,
      routeSpec: descriptor.routeSpec,
    },
  });
  await markRtPortfolioMaterializationsDirtyFrom({
    tradeDate: input.candle.tradeDate,
    engineSequence: input.auditId,
  });
  return candidate;
}

function candidateVirtualErrorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function descriptorForPayload(
  payload: CandidateVirtualWorkPayload,
  persistedStatus?: RtRealtimeDecisionEvent["candidateDescriptorStatus"],
  persistedDescriptor?: CandidateDescriptor | null,
): CandidateDescriptor | null {
  const status = persistedStatus ?? payload.candidateDescriptorStatus;
  if (status === "error" || payload.candidateDescriptorError) {
    throw new Error(payload.candidateDescriptorError ?? "candidate_descriptor_error_without_detail");
  }
  if (status === "complete") {
    const descriptor = persistedDescriptor ?? payload.candidateDescriptor;
    if (!descriptor) throw new Error("candidate_descriptor_complete_without_payload");
    return descriptor;
  }
  if (status === "not_candidate") return null;
  if (payload.candidateDescriptor !== undefined) return payload.candidateDescriptor;
  return buildCandidateDescriptor({
    candle: payload.candle,
    auditReason: payload.auditReason,
    candidateReason: payload.candidateReason,
    resultType: payload.resultType,
    decisionSignal: payload.decisionSignal ?? undefined,
    latestTrade: payload.latestTrade,
    rawSignal: payload.rawSignal,
  });
}

async function processCandidateVirtualWork(row: RtRealtimeDecisionEvent, ownerToken: string, maxAttempts: number): Promise<"processed" | "retryable_error" | "terminal"> {
  const payload = row.candidateVirtualInputJson as CandidateVirtualWorkPayload | null;
  if (!payload) {
    const error = `candidate_virtual_payload_missing:${row.id}`;
    await markRtCandidateVirtualPhaseProcessing({ id: row.id, ownerToken, phase: "candidate" });
    await markRtCandidateVirtualPhaseError({ row, ownerToken, phase: "candidate", error, terminal: true });
    await markRtCandidateVirtualPhaseProcessing({ id: row.id, ownerToken, phase: "virtual" });
    await markRtCandidateVirtualPhaseError({ row, ownerToken, phase: "virtual", error, terminal: true });
    await completeRtCandidateVirtualWork({ id: row.id, ownerToken });
    return "terminal";
  }

  let descriptor: CandidateDescriptor | null = null;
  let structuredCandidate: RtSignalCandidate | null = null;
  let retryableOutcome = false;
  let terminalOutcome = row.candidatePhaseStatus === "terminal_error" || row.virtualPhaseStatus === "terminal_error";
  const candidateDone = ["complete", "not_applicable", "terminal_error"].includes(row.candidatePhaseStatus);

  if (!candidateDone) {
    await markRtCandidateVirtualPhaseProcessing({ id: row.id, ownerToken, phase: "candidate" });
    try {
      descriptor = descriptorForPayload(
        payload,
        row.candidateDescriptorStatus,
        row.candidateDescriptorJson as CandidateDescriptor | null,
      );
      structuredCandidate = await saveStructuredCandidate({
        sourceEvent: payload.sourceEvent,
        candle: payload.candle,
        inputHash: payload.inputHash,
        auditId: row.id,
        descriptor,
        marginUsedBefore: payload.marginUsedBefore,
        decisionCompletedAtMs: payload.decisionCompletedAtMs,
      });
      await markRtCandidateVirtualPhaseComplete({
        id: row.id,
        ownerToken,
        phase: "candidate",
        notApplicable: descriptor === null,
      });
    } catch (error) {
      const terminal = row.candidatePhaseAttemptCount + 1 >= maxAttempts;
      await markRtCandidateVirtualPhaseError({
        row,
        ownerToken,
        phase: "candidate",
        error: candidateVirtualErrorMessage(error),
        terminal,
      });
      retryableOutcome = retryableOutcome || !terminal;
      terminalOutcome = terminalOutcome || terminal;
    }
  } else if (row.candidatePhaseStatus === "complete") {
    try {
      descriptor = descriptorForPayload(
        payload,
        row.candidateDescriptorStatus,
        row.candidateDescriptorJson as CandidateDescriptor | null,
      );
      if (descriptor) {
        structuredCandidate = await getRtSignalCandidateBySourceEventId({
          candidateVersion: CURRENT_SIGNAL_CANDIDATE_VERSION,
          sourceEventId: payload.sourceEvent.sourceEventId,
        });
      }
      if (descriptor && !structuredCandidate) throw new Error(`candidate_phase_complete_without_candidate:${row.id}`);
    } catch (error) {
      await markRtCandidateVirtualPhaseError({
        row,
        ownerToken,
        phase: "candidate",
        error: candidateVirtualErrorMessage(error),
        terminal: true,
      });
      terminalOutcome = true;
    }
  }

  const virtualDone = ["complete", "not_applicable", "terminal_error"].includes(row.virtualPhaseStatus);
  if (!virtualDone) {
    await markRtCandidateVirtualPhaseProcessing({ id: row.id, ownerToken, phase: "virtual" });
    try {
      await processSignalQualityVirtualTradesForEvent({
        sourceEventId: payload.sourceEvent.sourceEventId,
        candle: payload.candle,
        candidate: structuredCandidate,
        rawSignal: payload.rawSignal,
        boardSignal: payload.boardSignal,
      });
      await markRtCandidateVirtualPhaseComplete({ id: row.id, ownerToken, phase: "virtual" });
    } catch (error) {
      const terminal = row.virtualPhaseAttemptCount + 1 >= maxAttempts;
      await markRtCandidateVirtualPhaseError({
        row,
        ownerToken,
        phase: "virtual",
        error: candidateVirtualErrorMessage(error),
        terminal,
      });
      retryableOutcome = retryableOutcome || !terminal;
      terminalOutcome = terminalOutcome || terminal;
    }
  }

  await completeRtCandidateVirtualWork({ id: row.id, ownerToken });
  return terminalOutcome ? "terminal" : retryableOutcome ? "retryable_error" : "processed";
}

export async function drainCurrentCandidateVirtualQueue(options: {
  maxRows?: number;
  maxDurationMs?: number;
  maxAttempts?: number;
} = {}): Promise<{
  processedEngineSequences: number[];
  terminalizedRows: number;
  stoppedReason: "empty_or_claimed" | "worker_busy" | "retryable_error" | "max_batch" | "max_duration";
}> {
  const maxRows = options.maxRows ?? 100;
  const maxDurationMs = options.maxDurationMs ?? 20_000;
  const maxAttempts = options.maxAttempts ?? 5;
  const startedAt = Date.now();
  const processedEngineSequences: number[] = [];
  const ownerToken = sha256Stable({ scope: "current-candidate-virtual-worker-v2", nonce: randomUUID() });
  if (!await acquireRtCandidateVirtualWorkerLock({ ownerToken, leaseMs: maxDurationMs + 10_000 })) {
    return { processedEngineSequences, terminalizedRows: 0, stoppedReason: "worker_busy" };
  }
  try {
    const terminalizedRows = await terminalizeExhaustedRtCandidateVirtualWork({ maxAttempts, limit: maxRows });
    for (let index = 0; index < maxRows; index += 1) {
      if (Date.now() - startedAt >= maxDurationMs) {
        return { processedEngineSequences, terminalizedRows, stoppedReason: "max_duration" };
      }
      const row = await claimNextRtCandidateVirtualWork({ ownerToken, leaseMs: maxDurationMs + 10_000, maxAttempts });
      if (!row) return { processedEngineSequences, terminalizedRows, stoppedReason: "empty_or_claimed" };
      const outcome = await processCandidateVirtualWork(row, ownerToken, maxAttempts);
      if (outcome === "retryable_error") {
        return { processedEngineSequences, terminalizedRows, stoppedReason: "retryable_error" };
      }
      processedEngineSequences.push(row.id);
    }
    return { processedEngineSequences, terminalizedRows, stoppedReason: "max_batch" };
  } finally {
    await releaseRtCandidateVirtualWorkerLock(ownerToken);
  }
}

function parseBoardObservedAtMs(tradeDate: string, value: string | null | undefined): number | null {
  if (!value) return null;
  const normalized = value.includes("T") ? value : `${tradeDate}T${value}`;
  const withZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(normalized) ? normalized : `${normalized}+09:00`;
  const parsed = Date.parse(withZone);
  return Number.isFinite(parsed) ? parsed : null;
}

function nonNegativeDelta(later: number | null | undefined, earlier: number | null | undefined): number | null {
  if (later === null || later === undefined || earlier === null || earlier === undefined) return null;
  return Math.max(0, later - earlier);
}

export async function processCurrentEngineAudited(input: {
  sourceEvent: RtSourceEvent;
  candle: RtCandle1Min;
  board: Omit<KabuOrderBook, "symbol" | "receivedAt"> | null;
  inputHash: string;
  run: () => Promise<CurrentEngineResult>;
}): Promise<AuditedCurrentEngineResult> {
  const ownerToken = await acquireWithWait(input.sourceEvent.sourceEventId);
  const stateBefore = captureRealtimeAuditState(input.candle.symbol);
  const stateHashBefore = hashRealtimeAuditState(stateBefore);
  const marginUsedBefore = currentMarginUsed();
  const decisionStartedAtMs = Date.now();
  let result: CurrentEngineResult | null = null;
  try {
    result = await input.run();
    const decisionCompletedAtMs = Date.now();
    const latestTrade = result.action === "none"
      ? null
      : await getLatestRtTradeAt({
          tradeDate: input.candle.tradeDate,
          symbol: input.candle.symbol,
          tradeTime: input.candle.candleTime,
        });
    const stateAfter = captureRealtimeAuditState(input.candle.symbol);
    const stateHashAfter = hashRealtimeAuditState(stateAfter);
    const marginUsedAfter = currentMarginUsed();
    const positionAfter = getOpenPositions().find(position => position.symbol === input.candle.symbol);
    const beforeSignalKeys = new Set(stateBefore.latestSymbolSignals.map(signal => JSON.stringify(signal)));
    const decisionSignal = stateAfter.latestSymbolSignals.find(signal => signal.time === input.candle.candleTime
      && !beforeSignalKeys.has(JSON.stringify(signal)));
    const auditReason = latestTrade?.reason ?? result.reason ?? decisionSignal?.reason ?? null;
    const isMarginBlockResult = result.action === "none"
      && /証拠金(?:ブロック|使用率制限)|margin_block/i.test(
        `${result.reason ?? ""} ${decisionSignal?.reason ?? ""}`,
      );
    // 現行engineの返り値はmargin block時に短い`margin_block`だけを返す。
    // 監査表示は返り値を保持し、candidate復元だけは同じ判断で追加された詳細signal reasonを使う。
    const candidateReason = isMarginBlockResult
      ? decisionSignal?.reason ?? result.reason ?? latestTrade?.reason ?? null
      : latestTrade?.reason ?? result.reason ?? decisionSignal?.reason ?? null;
    const resultType = classifyResult(result, Boolean(positionAfter), auditReason);
    const positionBefore = stateBefore.positions.find(position => position.symbol === input.candle.symbol);
    const routeId = resultType === "exit"
      ? resolveRealtimeRouteId(positionBefore?.entryReason ?? candidateReason ?? auditReason)
      : resolveRealtimeRouteId(candidateReason ?? auditReason);
    const causality = evaluateCausality({ result, latestTrade, board: input.board });
    const boardObservedAtMs = parseBoardObservedAtMs(input.candle.tradeDate, input.board?.currentPriceTime);
    const availabilityTimeline = {
      sourceEventId: input.sourceEvent.sourceEventId,
      candleLogicalAt: `${input.candle.tradeDate}T${input.candle.candleTime}:00+09:00`,
      boardObservedAt: input.board?.currentPriceTime ?? null,
      boardObservedAtMs,
      relayAssembledAtMs: input.sourceEvent.relayReceivedAtMs,
      relaySentAtMs: input.sourceEvent.relaySentAtMs,
      cloudReceivedAtMs: input.sourceEvent.cloudReceivedAtMs,
      decisionStartedAtMs,
      decisionCompletedAtMs,
    };
    const latency = {
      relayAssemblyToSendMs: nonNegativeDelta(input.sourceEvent.relaySentAtMs, input.sourceEvent.relayReceivedAtMs),
      relaySendToCloudMs: nonNegativeDelta(input.sourceEvent.cloudReceivedAtMs, input.sourceEvent.relaySentAtMs),
      cloudToDecisionStartMs: nonNegativeDelta(decisionStartedAtMs, input.sourceEvent.cloudReceivedAtMs),
      decisionDurationMs: nonNegativeDelta(decisionCompletedAtMs, decisionStartedAtMs),
      boardAgeAtDecisionMs: nonNegativeDelta(decisionStartedAtMs, boardObservedAtMs),
    };
    let rawSignal: Awaited<ReturnType<typeof deriveCurrentRawSignalForEvent>> = null;
    let marketContextError: string | null = null;
    try {
      rawSignal = await deriveCurrentRawSignalForEvent(input.candle);
    } catch (error) {
      marketContextError = candidateVirtualErrorMessage(error);
      console.error("[RealtimeAudit] raw signal再計算に失敗。outboxへunavailableとして固定:", error);
    }
    const boardSignal = deriveCurrentBoardExitSignal(input.candle.symbol, input.board);
    let candidateDescriptor: CandidateDescriptor | null = null;
    let candidateDescriptorError: string | null = null;
    try {
      candidateDescriptor = buildCandidateDescriptor({
        candle: input.candle,
        auditReason,
        candidateReason,
        resultType,
        decisionSignal,
        latestTrade,
        rawSignal,
      });
    } catch (error) {
      candidateDescriptorError = candidateVirtualErrorMessage(error);
    }
    const candidateDescriptorStatus: CandidateVirtualWorkPayload["candidateDescriptorStatus"] = candidateDescriptorError
      ? "error"
      : candidateDescriptor
        ? "complete"
        : "not_candidate";
    const candidateVirtualInput: CandidateVirtualWorkPayload = {
      sourceEvent: {
        id: input.sourceEvent.id,
        sourceEventId: input.sourceEvent.sourceEventId,
        relayReceivedAtMs: input.sourceEvent.relayReceivedAtMs,
      },
      candle: input.candle,
      inputHash: input.inputHash,
      auditReason,
      candidateReason,
      resultType,
      decisionSignal: decisionSignal ?? null,
      latestTrade,
      marginUsedBefore,
      decisionCompletedAtMs,
      rawSignal,
      boardSignal,
      marketContextError,
      candidateDescriptorStatus,
      candidateDescriptor,
      candidateDescriptorError,
    };
    try {
      const saved = await insertRtRealtimeDecisionEvent({
        sourceEventDbId: input.sourceEvent.id,
        sourceEventId: input.sourceEvent.sourceEventId,
        relaySessionId: input.sourceEvent.relaySessionId,
        eventSeq: input.sourceEvent.eventSeq,
        tradeDate: input.candle.tradeDate,
        symbol: input.candle.symbol,
        candleTime: input.candle.candleTime,
        decisionStartedAtMs,
        decisionCompletedAtMs,
        resultType,
        routeId,
        side: latestTrade?.side ?? positionAfter?.side ?? null,
        reason: auditReason,
        inputHash: input.inputHash,
        stateBeforeJson: stateBefore,
        stateAfterJson: stateAfter,
        stateHashBefore,
        stateHashAfter,
        signalReferencePrice: String(input.candle.close),
        marketObservedPrice: input.board?.currentPrice ? String(input.board.currentPrice) : null,
        boardPriceTime: input.board?.currentPriceTime ?? null,
        executablePriceProxy: input.board?.currentPrice ? String(input.board.currentPrice) : null,
        simulatedBarFillPrice: latestTrade ? String(latestTrade.price) : null,
        brokerExecutionPrice: null,
        shares: latestTrade?.shares ?? positionAfter?.shares ?? null,
        amount: latestTrade?.amount ?? null,
        marginUsedBefore,
        marginUsedAfter,
        causalityStatus: causality.status,
        causalityReason: causality.reason,
        resultJson: {
          result,
          trade: latestTrade,
          decisionSignal: decisionSignal ?? null,
          candidateReason,
          rawSignal,
          boardSignal,
          marketContextError,
          stateCoverage: stateAfter.coverage,
          availabilityTimeline,
          latency,
          priceLabels: {
            signalReferencePrice: "candle.close",
            marketObservedPrice: "board.currentPrice_observed_before_or_at_decision",
            executablePriceProxy: "board.currentPrice_as_dry_run_executable_price_proxy",
            simulatedBarFillPrice: "rt_trades.price_from_bar_simulation",
            brokerExecutionPrice: "unavailable_in_dry_run",
          },
        },
        candidateVirtualStatus: "pending",
        candidateVirtualInputJson: candidateVirtualInput,
        candidateDescriptorJson: candidateDescriptor,
        candidateDescriptorStatus,
        candidatePhaseStatus: "pending",
        candidatePhaseAttemptCount: 0,
        candidatePhaseLastError: candidateDescriptorError,
        candidatePhaseProcessedAt: null,
        virtualPhaseStatus: "pending",
        virtualPhaseAttemptCount: 0,
        virtualPhaseLastError: null,
        virtualPhaseProcessedAt: null,
        candidateVirtualClaimToken: null,
        candidateVirtualLeaseUntil: null,
        candidateVirtualAttemptCount: 0,
        candidateVirtualLastError: null,
        candidateVirtualProcessedAt: null,
        candidateVirtualTerminalAt: null,
      });
      return {
        result,
        audit: {
          saved: true,
          engineSequence: saved.id,
          resultType,
          routeId,
          marginUsedBefore,
          marginUsedAfter,
          stateHashBefore,
          stateHashAfter,
          causalityStatus: causality.status,
          causalityReason: causality.reason,
          boardObservedAtMs,
          relayAssembledAtMs: input.sourceEvent.relayReceivedAtMs,
          relaySentAtMs: input.sourceEvent.relaySentAtMs,
          cloudReceivedAtMs: input.sourceEvent.cloudReceivedAtMs,
          decisionStartedAtMs,
          decisionCompletedAtMs,
        },
      };
    } catch (auditError) {
      console.error("[RealtimeAudit] 現行判断は完了したが監査台帳保存に失敗:", auditError);
      return {
        result,
        audit: {
          saved: false,
          engineSequence: null,
          resultType,
          routeId,
          marginUsedBefore,
          marginUsedAfter,
          stateHashBefore,
          stateHashAfter,
          causalityStatus: causality.status,
          causalityReason: causality.reason,
          boardObservedAtMs,
          relayAssembledAtMs: input.sourceEvent.relayReceivedAtMs,
          relaySentAtMs: input.sourceEvent.relaySentAtMs,
          cloudReceivedAtMs: input.sourceEvent.cloudReceivedAtMs,
          decisionStartedAtMs,
          decisionCompletedAtMs,
          error: String(auditError),
        },
      };
    }
  } finally {
    try {
      await releaseRtCurrentEngineLock({ lockName: CURRENT_ENGINE_LOCK_NAME, ownerToken });
    } catch (releaseError) {
      console.error("[RealtimeAudit] 現行エンジンリース解放失敗:", releaseError);
    }
  }
}
