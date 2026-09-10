import { and, eq, inArray, sql } from "drizzle-orm";
import type {
  InsertRtSignalCandidate,
  InsertRtSignalCandidateTrade,
  RtRealtimeDecisionEvent,
  RtSignalCandidateTrade,
} from "../drizzle/schema";
import {
  rtAuditTradeDateFinality,
  rtCandidateVirtualGaps,
  rtCandidateVirtualRepairArchive,
  rtCandidateVirtualRepairRuns,
  rtCandidateVirtualRepairStage,
  rtDailyAuditMaterializations,
  rtPortfolioMaterializationProgress,
  rtRealtimeDecisionEvents,
  rtSignalCandidates,
  rtSignalCandidateTrades,
} from "../drizzle/schema";
import { getDb, getRtRealtimeDecisionEventsForDateAndSymbol } from "./db";
import {
  CURRENT_SIGNAL_CANDIDATE_VERSION,
  CURRENT_SIGNAL_VIRTUAL_ENGINE_VERSION,
  parseMarginCandidateReason,
  parseRequiredMarginFromReason,
  resolveCurrentRouteSpecFromAuditRoute,
  type CurrentRouteSpec,
} from "./currentSignalCandidateRegistry";
import {
  adversePct,
  evaluateSignalQualityExit,
  favorablePct,
  type VirtualState,
} from "./signalCandidateVirtualEngine";
import { getRuntimeIdentity, sha256Stable } from "./runtimeIdentity";

export const FUJIKURA_REPAIR_VERSION = "fujikura-candidate-virtual-repair-v1";
export const FUJIKURA_REPAIR_SYMBOL = "5803";
export const FUJIKURA_REPAIR_TRADE_DATE = "2026-09-08";
const EXPECTED_CURRENT_SOURCE_HASH = "42006f0ef757255a1b1eda86fa7c37dd28a4b42f7d23503867b9fefdf24dfeda";
const EXTERNAL_ROUTE_ID = "high_fade_break_short";

type CandidateDescriptor = {
  side: "long" | "short";
  routeId: string;
  signalReason: string;
  capitalShares: number;
  requiredMargin: number;
  realtimeDecision: "accepted" | "margin_block";
  routeSpec: CurrentRouteSpec;
};

type CandidatePayload = Omit<InsertRtSignalCandidate, "id" | "createdAt">;
type TradePayload = Omit<InsertRtSignalCandidateTrade, "id" | "candidateId" | "createdAt" | "updatedAt"> & {
  candidateSourceEventId: string;
};

type RepairReplayResult = {
  candidates: CandidatePayload[];
  trades: TradePayload[];
  stats: {
    candidateCount: number;
    acceptedCount: number;
    marginBlockCount: number;
    virtualTradeCount: number;
    completedTradeCount: number;
    totalPnl: number;
    firstExitCandleTime: string | null;
  };
};

type CandidateWorkPayload = {
  sourceEvent: { id: number; sourceEventId: string; relayReceivedAtMs: number | null };
  candle: {
    symbol: string;
    tradeDate: string;
    candleTime: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  };
  inputHash: string;
  auditReason: string | null;
  candidateReason: string | null;
  resultType: "no_signal" | "pending" | "rejected" | "entry" | "hold" | "exit";
  latestTrade: { action?: string; side?: string; shares?: number; amount?: number; reason?: string } | null;
  marginUsedBefore: number;
  decisionCompletedAtMs: number;
  rawSignal: { type: "buy" | "sell"; reason: string } | null;
  boardSignal: "buy_pressure" | "sell_pressure" | "large_buy_wall" | "large_sell_wall" | "neutral" | null;
  candidateDescriptorStatus?: "not_candidate" | "complete" | "error";
  candidateDescriptor?: CandidateDescriptor | null;
  candidateDescriptorError?: string | null;
};

function assertRepairScope(tradeDate: string, symbol: string): void {
  if (tradeDate !== FUJIKURA_REPAIR_TRADE_DATE || symbol !== FUJIKURA_REPAIR_SYMBOL) {
    throw new Error(`repair_scope_rejected:${tradeDate}:${symbol}`);
  }
  const identity = getRuntimeIdentity();
  // この修復処理は9/8当時の固定版専用。将来のbuild hashへ追随させず、異なる版では安全に拒否する。
  if (!identity.tradingLogicMatchesBaseline || String(identity.sourceTreeHash) !== EXPECTED_CURRENT_SOURCE_HASH) {
    throw new Error(`repair_runtime_identity_mismatch:${identity.sourceTreeHash}`);
  }
  if (!identity.dryRunRequired || identity.liveOrderApproved) {
    throw new Error("repair_requires_dry_run_and_live_unapproved");
  }
}

function parsePayload(row: RtRealtimeDecisionEvent): CandidateWorkPayload {
  const payload = row.candidateVirtualInputJson as CandidateWorkPayload | null;
  if (!payload?.candle || !payload.sourceEvent?.sourceEventId) {
    throw new Error(`repair_payload_missing:${row.id}`);
  }
  return payload;
}

function descriptorForRepair(row: RtRealtimeDecisionEvent, payload: CandidateWorkPayload): CandidateDescriptor | null {
  const persisted = row.candidateDescriptorJson as CandidateDescriptor | null;
  if (row.candidateDescriptorStatus === "complete" && persisted) return persisted;
  if (row.candidateDescriptorStatus === "not_candidate") return null;
  const externalRouteId = row.routeId;
  const observedSide = payload.rawSignal?.type === "sell" ? "short" : payload.rawSignal?.type === "buy" ? "long" : null;
  if (row.candidateDescriptorStatus !== "error" || externalRouteId !== EXTERNAL_ROUTE_ID) {
    throw new Error(`repair_descriptor_not_recoverable:${row.id}:${externalRouteId ?? "null"}`);
  }
  const routeSpec = resolveCurrentRouteSpecFromAuditRoute({
    externalRouteId,
    symbol: row.symbol,
    side: observedSide,
    entryCandleTime: row.candleTime,
  });
  if (!routeSpec) throw new Error(`repair_route_mapping_missing:${row.id}:${externalRouteId}`);
  const side = routeSpec.side;
  const signalReason = parseMarginCandidateReason(payload.candidateReason) ?? payload.rawSignal?.reason ?? null;
  if (!signalReason) throw new Error(`repair_signal_reason_missing:${row.id}`);
  const price = Number(payload.candle.close);
  const reconstructedShares = Math.floor((3_000_000 * 0.9) / price / 100) * 100;
  const capitalShares = Number(payload.latestTrade?.shares) || reconstructedShares;
  const requiredMargin = parseRequiredMarginFromReason(payload.candidateReason)
    ?? (Number(payload.latestTrade?.amount) || Math.round(price * capitalShares));
  return {
    side,
    routeId: routeSpec.routeId,
    signalReason,
    capitalShares,
    requiredMargin,
    realtimeDecision: row.resultType === "entry" ? "accepted" : "margin_block",
    routeSpec,
  };
}

function candidateFromDescriptor(row: RtRealtimeDecisionEvent, payload: CandidateWorkPayload, descriptor: CandidateDescriptor): CandidatePayload {
  return {
    candidateVersion: CURRENT_SIGNAL_CANDIDATE_VERSION,
    sourceEventId: row.sourceEventId,
    sourceEventDbId: row.sourceEventDbId,
    engineSequence: row.id,
    tradeDate: row.tradeDate,
    candleTime: row.candleTime,
    symbol: row.symbol,
    routeId: descriptor.routeId,
    side: descriptor.side,
    signalReason: descriptor.signalReason,
    theoreticalEntryPrice: String(payload.candle.close),
    signalQualityShares: 100,
    capitalShares: descriptor.capitalShares,
    requiredMargin: descriptor.requiredMargin,
    marginUsedBefore: Number(payload.marginUsedBefore) || 0,
    marginLimit: 8_910_000,
    realtimeDecision: descriptor.realtimeDecision,
    slPct: String(descriptor.routeSpec.slPct),
    tpPct: String(descriptor.routeSpec.tpPct),
    maxHoldingMinutes: descriptor.routeSpec.maxHoldingMinutes,
    sessionExitTime: descriptor.routeSpec.sessionExitTime,
    profitProtectionJson: descriptor.routeSpec.profitProtection,
    entryObservedAtMs: payload.sourceEvent.relayReceivedAtMs,
    decisionAtMs: payload.decisionCompletedAtMs,
    inputJson: {
      auditVersion: "current-realtime-audit-v1",
      realtimeDecisionId: row.id,
      inputHash: payload.inputHash,
      acceptedByCurrentRealtime: descriptor.realtimeDecision === "accepted",
      marginBlockedByCurrentRealtime: descriptor.realtimeDecision === "margin_block",
      requiredMarginSource: descriptor.realtimeDecision === "accepted" ? "rt_trade_amount" : "margin_block_reason_or_reconstructed",
      eligibleNominalRiskReward: descriptor.routeSpec.eligibleNominalRiskReward,
      routeSpec: descriptor.routeSpec,
      repairVersion: FUJIKURA_REPAIR_VERSION,
      repairedFromSavedPayload: true,
    },
  };
}

function asTradeForEvaluation(trade: TradePayload): RtSignalCandidateTrade {
  return {
    id: 0,
    candidateId: 0,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...trade,
  } as RtSignalCandidateTrade;
}

function replay(events: RtRealtimeDecisionEvent[]): RepairReplayResult {
  const candidates: CandidatePayload[] = [];
  const trades: TradePayload[] = [];
  for (const row of [...events].sort((a, b) => a.id - b.id)) {
    const payload = parsePayload(row);
    const candle = payload.candle;
    for (const trade of trades.filter(item => !item.completed && item.symbol === row.symbol && item.entrySourceEventId !== row.sourceEventId)) {
      const stateRaw = trade.stateJson as Partial<VirtualState> & { routeSpec?: CurrentRouteSpec };
      const state: VirtualState = {
        armedAt: typeof stateRaw.armedAt === "string" ? stateRaw.armedAt : null,
        mfePct: Number(stateRaw.mfePct) || 0,
        maePct: Number(stateRaw.maePct) || 0,
      };
      const entry = Number(trade.entryPrice);
      state.mfePct = Math.max(state.mfePct, favorablePct(trade.side, entry, candle.high, candle.low));
      state.maePct = Math.max(state.maePct, adversePct(trade.side, entry, candle.high, candle.low));
      const protection = stateRaw.routeSpec?.profitProtection;
      if (!state.armedAt && trade.side === "short" && protection) {
        const trigger = entry * (1 - protection.triggerPct / 100);
        if (candle.low <= trigger) state.armedAt = candle.candleTime;
      }
      const exit = evaluateSignalQualityExit({
        trade: asTradeForEvaluation(trade),
        candle,
        state,
        rawSignal: payload.rawSignal,
        boardSignal: payload.boardSignal ?? "neutral",
      });
      trade.stateJson = {
        ...(trade.stateJson as object),
        ...state,
        lastMarketContext: { sourceEventId: row.sourceEventId, rawSignal: payload.rawSignal, boardSignal: payload.boardSignal ?? "neutral" },
      };
      trade.mfePct = String(state.mfePct);
      trade.maePct = String(state.maePct);
      if (exit) {
        const shares = trade.shares ?? 100;
        const pnl = Math.round((trade.side === "long" ? exit.exitPrice - entry : entry - exit.exitPrice) * shares);
        trade.exitSourceEventId = row.sourceEventId;
        trade.exitTradeDate = row.tradeDate;
        trade.exitCandleTime = row.candleTime;
        trade.exitPrice = String(exit.exitPrice);
        trade.exitReason = exit.reasonCode;
        trade.exitReasonCode = exit.reasonCode;
        trade.exitReasonDetail = exit.reasonDetail;
        trade.pnl = pnl;
        trade.realizedR = String((pnl / (entry * shares)) * 100 / Number(trade.slPct));
        trade.completed = true;
      }
    }

    const descriptor = descriptorForRepair(row, payload);
    if (!descriptor) continue;
    const candidate = candidateFromDescriptor(row, payload, descriptor);
    candidates.push(candidate);
    trades.push({
      virtualEngineVersion: CURRENT_SIGNAL_VIRTUAL_ENGINE_VERSION,
      candidateSourceEventId: candidate.sourceEventId,
      entrySourceEventId: candidate.sourceEventId,
      tradeDate: candidate.tradeDate,
      symbol: candidate.symbol,
      routeId: candidate.routeId,
      side: candidate.side,
      entryCandleTime: candidate.candleTime,
      entryPrice: candidate.theoreticalEntryPrice,
      shares: 100,
      slPct: candidate.slPct,
      tpPct: candidate.tpPct,
      maxHoldingMinutes: candidate.maxHoldingMinutes,
      stateJson: { routeSpec: descriptor.routeSpec, armedAt: null, mfePct: 0, maePct: 0 },
      exitSourceEventId: null,
      exitTradeDate: null,
      exitCandleTime: null,
      exitPrice: null,
      exitReason: null,
      exitReasonCode: null,
      exitReasonDetail: null,
      pnl: null,
      realizedR: null,
      mfePct: "0",
      maePct: "0",
      completed: false,
    });
  }
  const orderedCandidates = [...candidates].sort((a, b) => a.engineSequence - b.engineSequence);
  const orderedTrades = [...trades].sort((a, b) => a.entrySourceEventId.localeCompare(b.entrySourceEventId));
  const closed = orderedTrades.filter(trade => trade.completed);
  return {
    candidates: orderedCandidates,
    trades: orderedTrades,
    stats: {
      candidateCount: orderedCandidates.length,
      acceptedCount: orderedCandidates.filter(candidate => candidate.realtimeDecision === "accepted").length,
      marginBlockCount: orderedCandidates.filter(candidate => candidate.realtimeDecision === "margin_block").length,
      virtualTradeCount: orderedTrades.length,
      completedTradeCount: closed.length,
      totalPnl: closed.reduce((sum, trade) => sum + Number(trade.pnl ?? 0), 0),
      firstExitCandleTime: closed.map(trade => trade.exitCandleTime).filter((value): value is string => Boolean(value)).sort()[0] ?? null,
    },
  };
}

export const replayFujikuraCandidateVirtualRepairForTest = replay;

function canonicalReplay(result: RepairReplayResult) {
  return {
    candidates: result.candidates,
    trades: result.trades,
    stats: result.stats,
  };
}

export function hashFujikuraRepairReplayForTest(result: RepairReplayResult): string {
  return sha256Stable(canonicalReplay(result));
}

function repairInputHash(events: RtRealtimeDecisionEvent[]): string {
  return sha256Stable(events.map(event => ({
    id: event.id,
    sourceEventId: event.sourceEventId,
    inputHash: event.inputHash,
    descriptorStatus: event.candidateDescriptorStatus,
    descriptor: event.candidateDescriptorJson,
    payload: event.candidateVirtualInputJson,
  })));
}

function stageSignature(rows: Array<{ entityType: string; entityKey: string; payloadHash: string }>): string {
  return sha256Stable(rows
    .map(row => ({ entityType: row.entityType, entityKey: row.entityKey, payloadHash: row.payloadHash }))
    .sort((a, b) => `${a.entityType}:${a.entityKey}`.localeCompare(`${b.entityType}:${b.entityKey}`)));
}

export async function prepareFujikuraCandidateVirtualRepair(input: {
  runId: string;
  tradeDate?: string;
  symbol?: string;
}) {
  const tradeDate = input.tradeDate ?? FUJIKURA_REPAIR_TRADE_DATE;
  const symbol = input.symbol ?? FUJIKURA_REPAIR_SYMBOL;
  assertRepairScope(tradeDate, symbol);
  const events = await getRtRealtimeDecisionEventsForDateAndSymbol({ tradeDate, symbol });
  if (events.length === 0) throw new Error("repair_source_events_missing");
  const inputHash = repairInputHash(events);
  const replayA = replay(events);
  const replayB = replay(events);
  const replayHashA = sha256Stable(canonicalReplay(replayA));
  const replayHashB = sha256Stable(canonicalReplay(replayB));
  if (replayHashA !== replayHashB) throw new Error(`repair_replay_hash_mismatch:${replayHashA}:${replayHashB}`);

  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.transaction(async tx => {
    const existing = (await tx.select().from(rtCandidateVirtualRepairRuns).where(eq(rtCandidateVirtualRepairRuns.runId, input.runId)).limit(1))[0];
    if (existing?.status === "applied") throw new Error(`repair_run_already_applied:${input.runId}`);
    await tx.insert(rtCandidateVirtualRepairRuns).values({
      runId: input.runId,
      repairVersion: FUJIKURA_REPAIR_VERSION,
      tradeDate,
      symbol,
      status: "verified",
      inputHash,
      replayHashA,
      replayHashB,
      ...replayA.stats,
      detailJson: { expectedSourceHash: EXPECTED_CURRENT_SOURCE_HASH, eventCount: events.length },
    }).onDuplicateKeyUpdate({ set: {
      status: "verified",
      inputHash,
      replayHashA,
      replayHashB,
      ...replayA.stats,
      detailJson: { expectedSourceHash: EXPECTED_CURRENT_SOURCE_HASH, eventCount: events.length },
    } });
    await tx.delete(rtCandidateVirtualRepairStage).where(eq(rtCandidateVirtualRepairStage.runId, input.runId));
    const stageRows = (["A", "B"] as const).flatMap(replayPass => {
      const result = replayPass === "A" ? replayA : replayB;
      return [
        ...result.candidates.map(candidate => ({
          runId: input.runId,
          replayPass,
          entityType: "candidate" as const,
          entityKey: candidate.sourceEventId,
          payloadHash: sha256Stable(candidate),
          payloadJson: candidate,
        })),
        ...result.trades.map(trade => ({
          runId: input.runId,
          replayPass,
          entityType: "virtual_trade" as const,
          entityKey: trade.entrySourceEventId,
          payloadHash: sha256Stable(trade),
          payloadJson: trade,
        })),
      ];
    });
    if (stageRows.length > 0) await tx.insert(rtCandidateVirtualRepairStage).values(stageRows);
  });
  return { runId: input.runId, inputHash, replayHashA, replayHashB, ...replayA.stats };
}

export async function applyFujikuraCandidateVirtualRepair(runId: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const run = (await db.select().from(rtCandidateVirtualRepairRuns).where(eq(rtCandidateVirtualRepairRuns.runId, runId)).limit(1))[0];
  if (!run || run.status !== "verified" || !run.replayHashA || run.replayHashA !== run.replayHashB) {
    throw new Error(`repair_run_not_verified:${runId}`);
  }
  assertRepairScope(run.tradeDate, run.symbol);
  const allStage = await db.select().from(rtCandidateVirtualRepairStage)
    .where(eq(rtCandidateVirtualRepairStage.runId, runId))
    .orderBy(rtCandidateVirtualRepairStage.id);
  const stage = allStage.filter(row => row.replayPass === "A");
  const stageB = allStage.filter(row => row.replayPass === "B");
  if (stageSignature(stage) !== stageSignature(stageB)) throw new Error(`repair_stage_pass_mismatch:${runId}`);
  const candidates = stage.filter(row => row.entityType === "candidate").map(row => row.payloadJson as CandidatePayload);
  const trades = stage.filter(row => row.entityType === "virtual_trade").map(row => row.payloadJson as TradePayload);
  if (sha256Stable(canonicalReplay({ candidates, trades, stats: {
    candidateCount: run.candidateCount,
    acceptedCount: run.acceptedCount,
    marginBlockCount: run.marginBlockCount,
    virtualTradeCount: run.virtualTradeCount,
    completedTradeCount: run.completedTradeCount,
    totalPnl: run.totalPnl,
    firstExitCandleTime: run.firstExitCandleTime,
  } })) !== run.replayHashA) throw new Error(`repair_stage_hash_mismatch:${runId}`);

  await db.transaction(async tx => {
    const currentRun = (await tx.select().from(rtCandidateVirtualRepairRuns).where(eq(rtCandidateVirtualRepairRuns.runId, runId)).limit(1))[0];
    if (currentRun?.status === "applied") return;
    if (currentRun?.status !== "verified") throw new Error(`repair_run_changed:${runId}`);
    const existingCandidates = await tx.select().from(rtSignalCandidates).where(and(
      eq(rtSignalCandidates.candidateVersion, CURRENT_SIGNAL_CANDIDATE_VERSION),
      eq(rtSignalCandidates.tradeDate, run.tradeDate),
      eq(rtSignalCandidates.symbol, run.symbol),
    ));
    const existingCandidateIds = existingCandidates.map(candidate => candidate.id);
    const existingTrades = existingCandidateIds.length > 0
      ? await tx.select().from(rtSignalCandidateTrades).where(inArray(rtSignalCandidateTrades.candidateId, existingCandidateIds))
      : [];
    const decisions = await tx.select().from(rtRealtimeDecisionEvents).where(and(
      eq(rtRealtimeDecisionEvents.tradeDate, run.tradeDate),
      eq(rtRealtimeDecisionEvents.symbol, run.symbol),
    )).orderBy(rtRealtimeDecisionEvents.id);
    if (repairInputHash(decisions) !== run.inputHash) throw new Error(`repair_input_changed_after_verification:${runId}`);
    const decisionIds = decisions.map(event => event.id);
    const gaps = decisionIds.length > 0
      ? await tx.select().from(rtCandidateVirtualGaps).where(inArray(rtCandidateVirtualGaps.decisionEventId, decisionIds))
      : [];
    const archives = [
      ...existingCandidates.map(row => ({ runId, entityType: "candidate" as const, entityKey: String(row.id), payloadHash: sha256Stable(row), payloadJson: row })),
      ...existingTrades.map(row => ({ runId, entityType: "virtual_trade" as const, entityKey: String(row.id), payloadHash: sha256Stable(row), payloadJson: row })),
      ...decisions.map(row => ({ runId, entityType: "decision_event" as const, entityKey: String(row.id), payloadHash: sha256Stable(row), payloadJson: row })),
      ...gaps.map(row => ({ runId, entityType: "gap" as const, entityKey: String(row.id), payloadHash: sha256Stable(row), payloadJson: row })),
    ];
    if (archives.length > 0) await tx.insert(rtCandidateVirtualRepairArchive).values(archives).onDuplicateKeyUpdate({ set: { payloadHash: sql`VALUES(payload_hash)`, payloadJson: sql`VALUES(payload_json)` } });

    if (existingCandidateIds.length > 0) await tx.delete(rtSignalCandidateTrades).where(inArray(rtSignalCandidateTrades.candidateId, existingCandidateIds));
    await tx.delete(rtSignalCandidates).where(and(
      eq(rtSignalCandidates.candidateVersion, CURRENT_SIGNAL_CANDIDATE_VERSION),
      eq(rtSignalCandidates.tradeDate, run.tradeDate),
      eq(rtSignalCandidates.symbol, run.symbol),
    ));

    const candidateIdBySource = new Map<string, number>();
    for (const candidate of candidates.sort((a, b) => a.engineSequence - b.engineSequence)) {
      await tx.insert(rtSignalCandidates).values(candidate);
      const inserted = (await tx.select({ id: rtSignalCandidates.id }).from(rtSignalCandidates).where(and(
        eq(rtSignalCandidates.candidateVersion, candidate.candidateVersion),
        eq(rtSignalCandidates.sourceEventId, candidate.sourceEventId),
      )).limit(1))[0];
      if (!inserted) throw new Error(`repair_candidate_insert_missing:${candidate.sourceEventId}`);
      candidateIdBySource.set(candidate.sourceEventId, inserted.id);
    }
    for (const trade of trades) {
      const candidateId = candidateIdBySource.get(trade.candidateSourceEventId);
      if (!candidateId) throw new Error(`repair_trade_candidate_missing:${trade.candidateSourceEventId}`);
      const { candidateSourceEventId: _candidateSourceEventId, ...tradeInsert } = trade;
      await tx.insert(rtSignalCandidateTrades).values({ ...tradeInsert, candidateId });
    }

    const stagedBySource = new Map(candidates.map(candidate => [candidate.sourceEventId, candidate]));
    for (const decision of decisions) {
      const candidate = stagedBySource.get(decision.sourceEventId);
      const update: Record<string, unknown> = {
        candidateVirtualStatus: "processed",
        candidatePhaseStatus: candidate ? "complete" : "not_applicable",
        candidatePhaseLastError: null,
        candidatePhaseProcessedAt: new Date(),
        virtualPhaseStatus: "complete",
        virtualPhaseLastError: null,
        virtualPhaseProcessedAt: new Date(),
        candidateVirtualClaimToken: null,
        candidateVirtualLeaseUntil: null,
        candidateVirtualLastError: null,
        candidateVirtualProcessedAt: new Date(),
        candidateVirtualTerminalAt: null,
      };
      if (candidate && decision.candidateDescriptorStatus === "error") {
        const payload = parsePayload(decision);
        const descriptor = descriptorForRepair(decision, payload);
        update.candidateDescriptorStatus = "complete";
        update.candidateDescriptorJson = descriptor;
        update.candidateVirtualInputJson = {
          ...payload,
          candidateDescriptorStatus: "complete",
          candidateDescriptor: descriptor,
          candidateDescriptorError: null,
        };
      }
      await tx.update(rtRealtimeDecisionEvents).set(update).where(eq(rtRealtimeDecisionEvents.id, decision.id));
    }
    if (decisionIds.length > 0) await tx.update(rtCandidateVirtualGaps).set({ resolved: true }).where(inArray(rtCandidateVirtualGaps.decisionEventId, decisionIds));
    const earliestSequence = Math.min(...decisions.map(event => event.id));
    await tx.update(rtPortfolioMaterializationProgress).set({
      status: "pending",
      buildingGeneration: null,
      dirtyFromEngineSequence: earliestSequence,
      lastError: null,
      generatedAt: null,
    }).where(eq(rtPortfolioMaterializationProgress.tradeDate, run.tradeDate));
    await tx.update(rtAuditTradeDateFinality).set({
      status: "reopened",
      closedAt: null,
      reason: `candidate_virtual_repair_applied:${runId}`,
    }).where(eq(rtAuditTradeDateFinality.tradeDate, run.tradeDate));
    await tx.update(rtDailyAuditMaterializations).set({
      status: "pending",
      processedThroughEngineSequence: 0,
      sourceDecisionCount: 0,
      resultJson: {},
      lastError: null,
      generatedAt: null,
    }).where(eq(rtDailyAuditMaterializations.tradeDate, run.tradeDate));
    await tx.update(rtCandidateVirtualRepairRuns).set({ status: "applied", appliedAt: new Date() }).where(eq(rtCandidateVirtualRepairRuns.runId, runId));
  });
  return { runId, status: "applied" as const, candidateCount: run.candidateCount, virtualTradeCount: run.virtualTradeCount, totalPnl: run.totalPnl };
}

export async function getFujikuraCandidateVirtualRepair(runId: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return (await db.select().from(rtCandidateVirtualRepairRuns).where(eq(rtCandidateVirtualRepairRuns.runId, runId)).limit(1))[0] ?? null;
}
