import { randomUUID } from "node:crypto";
import type { ForwardEvaluationMode, ForwardSourceEventInput } from "./forwardShadow";
import {
  acquireRtForwardShadowStateLock, claimOrRetryRtForwardShadowEvent, closeRtForwardShadowTrade,
  failRtForwardShadowEvent, getRtForwardShadowState, getRtStrategyVersion, insertRtForwardShadowTrade,
  releaseRtForwardShadowStateLock, updateRtForwardShadowEvent, upsertRtForwardShadowState, upsertRtStrategyVersion,
} from "./db";
import { createForwardShadowLockOwnerToken } from "./forwardShadowLock";
import { AI_DAILY_FORECAST_VERSIONS, BASELINE_STRATEGY_GIT_SHA, FORWARD_EVALUATION_POLICY, getRuntimeIdentity, sha256Stable } from "./runtimeIdentity";
import { calculateDepthVwap } from "./telExecutableConfirmDepth";
import { AI_DAILY_FORECAST_SYMBOLS, getAiDailyForecastDashboard, type AiDailyForecastSymbol } from "./aiDailyForecastService";

export const AI_DAILY_FORECAST_LEARNING_CUTOFF_DATE = "2026-10-08";
export const AI_DAILY_FORECAST_COLLECTION_START_DATE = "2026-10-09";
export const AI_DAILY_FORECAST_STRATEGY_VERSIONS = AI_DAILY_FORECAST_VERSIONS as Record<AiDailyForecastSymbol, string>;
const MODES: readonly ForwardEvaluationMode[] = FORWARD_EVALUATION_POLICY.evaluationModes;
const symbols = new Set<string>(AI_DAILY_FORECAST_SYMBOLS);
const ensured = new Set<string>();

type Side = "long" | "short";
export type AiDailyForecastPlan = { sourceSnapshotId: string; qualityStatus: string; symbol: string; direction: string; forecastLow: number; forecastHigh: number; zoneLow: number; zoneHigh: number; confirmPrice: number; firstTarget: number; stretchTarget: number; atr5: number; stopPrice: number; entryBlockedByRevision: boolean };
type Plan = AiDailyForecastPlan;
type Position = { side: Side; entrySourceEventId: string; signalTime: string; entryTime: string; entryPrice: number; targetPrice: number; stopPrice: number; shares: number; sourceBoardAgeMs: number; deliveryBoardAgeMs: number | null };
type State = { tradeDate: string; plan: Plan | null; touched: { sourceEventId: string; time: string; side: Side } | null; position: Position | null; dailySlotConsumed: boolean; lastSourceEventId: string | null; lastActions: Array<Record<string, unknown>> };

function number(value: unknown) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; }
function object(value: unknown) { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function minute(time: string) { const [h, m] = time.split(":").map(Number); return h * 60 + m; }
function emptyState(tradeDate: string): State { return { tradeDate, plan: null, touched: null, position: null, dailySlotConsumed: false, lastSourceEventId: null, lastActions: [] }; }
function normalizeState(value: unknown, tradeDate: string): State { const raw = object(value); if (raw.tradeDate !== tradeDate) return emptyState(tradeDate); return { tradeDate, plan: raw.plan && typeof raw.plan === "object" ? raw.plan as Plan : null, touched: raw.touched && typeof raw.touched === "object" ? raw.touched as State["touched"] : null, position: raw.position && typeof raw.position === "object" ? raw.position as Position : null, dailySlotConsumed: raw.dailySlotConsumed === true, lastSourceEventId: typeof raw.lastSourceEventId === "string" ? raw.lastSourceEventId : null, lastActions: Array.isArray(raw.lastActions) ? raw.lastActions as Array<Record<string, unknown>> : [] }; }

function planFromSnapshot(snapshot: Awaited<ReturnType<typeof getAiDailyForecastDashboard>>["snapshot"], symbol: string, entryBlockedByRevision: boolean): Plan | null {
  if (!snapshot || snapshot.qualityStatus === "invalid") return null;
  const payload = object(snapshot.forecastJson); const output = object(payload.aiFinalForecast); const forecasts = Array.isArray(output.forecasts) ? output.forecasts : [];
  const row = forecasts.find(item => object(item).symbol === symbol); const values = object(row); const baseline = (Array.isArray(payload.quantBaseline) ? payload.quantBaseline : []).find(item => object(item).symbol === symbol); const base = object(baseline);
  const direction = String(values.direction ?? ""); const directional = direction === "strong_up" || direction === "up" || direction === "strong_down" || direction === "down";
  const forecastLow = number(values.forecastLow), forecastHigh = number(values.forecastHigh), zoneLow = number(values.zoneLow), zoneHigh = number(values.zoneHigh), confirmPrice = number(values.confirmPrice), firstTarget = number(values.firstTarget), stretchTarget = number(values.stretchTarget), atr5 = number(base.atr5);
  if (!directional || forecastLow === null || forecastHigh === null || zoneLow === null || zoneHigh === null || confirmPrice === null || firstTarget === null || stretchTarget === null || atr5 === null) return null;
  const long = direction === "strong_up" || direction === "up"; const stopPrice = long ? Math.min(forecastLow, zoneLow - 0.15 * atr5) : Math.max(forecastHigh, zoneHigh + 0.15 * atr5);
  if (!(forecastLow < zoneLow && zoneLow <= zoneHigh && zoneHigh < forecastHigh) || !(stopPrice > 0)) return null;
  return { sourceSnapshotId: snapshot.sourceSnapshotId, qualityStatus: snapshot.qualityStatus, symbol, direction, forecastLow, forecastHigh, zoneLow, zoneHigh, confirmPrice, firstTarget, stretchTarget, atr5, stopPrice, entryBlockedByRevision };
}
function sideForPlan(plan: Plan): Side { return plan.direction === "strong_up" || plan.direction === "up" ? "long" : "short"; }
function boardExecution(source: ForwardSourceEventInput, side: Side, mode: ForwardEvaluationMode) {
  const audit = source.currentAudit; const boardAge = audit?.boardObservedAtMs !== null && audit?.boardObservedAtMs !== undefined && audit?.relayAssembledAtMs !== null && audit?.relayAssembledAtMs !== undefined ? audit.relayAssembledAtMs - audit.boardObservedAtMs : null;
  const causal = boardAge !== null && boardAge >= 0 && boardAge <= 5_000;
  if (!causal) return { valid: false as const, reason: boardAge === null ? "board_timestamps_missing" : boardAge < 0 ? "board_future_or_noncausal" : "board_stale" };
  const shares = mode === "signal_quality" ? 100 : Math.max(100, Math.floor(2_700_000 / Math.max(1, source.candle.close) / 100) * 100);
  const vwap = calculateDepthVwap({ board: source.board, side, shares }); if (!vwap) return { valid: false as const, reason: "directional_depth_insufficient" };
  const delivery = audit?.cloudReceivedAtMs !== null && audit?.cloudReceivedAtMs !== undefined && audit?.decisionCompletedAtMs !== undefined ? Math.max(0, (audit.relaySentAtMs ?? audit.relayAssembledAtMs ?? 0) - (audit.boardObservedAtMs ?? 0)) + Math.max(0, audit.decisionCompletedAtMs - audit.cloudReceivedAtMs) : null;
  return { valid: true as const, price: vwap.price, shares, boardAge, delivery };
}
function transition(state: State, source: ForwardSourceEventInput, plan: Plan | null, mode: ForwardEvaluationMode) {
  let next = { ...state, plan: plan ?? state.plan, lastSourceEventId: source.sourceEventId, lastActions: [] as Array<Record<string, unknown>> }; const c = source.candle;
  if (next.position) {
    const p = next.position; let exit: { price: number; reason: string } | null = null;
    if (p.side === "long" && c.low <= p.stopPrice) exit = { price: Math.min(c.open, p.stopPrice), reason: "stop_loss" }; else if (p.side === "short" && c.high >= p.stopPrice) exit = { price: Math.max(c.open, p.stopPrice), reason: "stop_loss" }; else if (p.side === "long" && c.high >= p.targetPrice) exit = { price: p.targetPrice, reason: "first_target" }; else if (p.side === "short" && c.low <= p.targetPrice) exit = { price: p.targetPrice, reason: "first_target" }; else if (c.candleTime >= "15:20") exit = { price: c.close, reason: "day_end" };
    if (exit) { const pnl = Math.round((p.side === "long" ? exit.price - p.entryPrice : p.entryPrice - exit.price) * p.shares); const risk = Math.abs(p.entryPrice - p.stopPrice) * p.shares; next = { ...next, position: null, dailySlotConsumed: true }; return { next, resultType: "exit" as const, opened: null, closed: { position: p, price: exit.price, reason: exit.reason, pnl, realizedR: risk > 0 ? pnl / risk : 0 }, actions: [{ type: "exit", ...exit, stopFirst: exit.reason === "stop_loss" }] }; }
    return { next, resultType: "hold" as const, opened: null, closed: null, actions: [{ type: "hold" }] };
  }
  if (!plan) return { next, resultType: "no_signal" as const, opened: null, closed: null, actions: [{ type: "no_trade", reason: "ai_snapshot_missing_invalid_or_non_directional" }] };
  if (plan.entryBlockedByRevision) return { next, resultType: "no_signal" as const, opened: null, closed: null, actions: [{ type: "no_trade", reason: "market_context_revision_invalidated_unentered_signals" }] };
  if (next.dailySlotConsumed || c.candleTime < "09:00" || c.candleTime > "15:19") return { next, resultType: "no_signal" as const, opened: null, closed: null, actions: [{ type: "no_trade", reason: next.dailySlotConsumed ? "one_entry_per_symbol_per_day_consumed" : "outside_entry_window" }] };
  const side = sideForPlan(plan);
  if (!next.touched) {
    const touched = side === "long" ? c.low <= plan.zoneHigh && c.high >= plan.zoneLow : c.high >= plan.zoneLow && c.low <= plan.zoneHigh;
    if (touched) { next = { ...next, touched: { sourceEventId: source.sourceEventId, time: c.candleTime, side } }; return { next, resultType: "pending" as const, opened: null, closed: null, actions: [{ type: "zone_touched", side, sourceEventId: source.sourceEventId }] }; }
    return { next, resultType: "no_signal" as const, opened: null, closed: null, actions: [{ type: "no_trade", reason: "zone_not_touched" }] };
  }
  if (next.touched.sourceEventId === source.sourceEventId) return { next, resultType: "pending" as const, opened: null, closed: null, actions: [{ type: "await_separate_confirmation_event" }] };
  const confirmed = side === "long" ? c.close >= plan.confirmPrice : c.close <= plan.confirmPrice;
  if (!confirmed) return { next, resultType: "pending" as const, opened: null, closed: null, actions: [{ type: "await_confirmation_price" }] };
  const execution = boardExecution(source, side, mode); if (!execution.valid) return { next, resultType: "rejected" as const, opened: null, closed: null, actions: [{ type: "entry_rejected", reason: execution.reason }] };
  const targetValid = side === "long" ? plan.firstTarget > execution.price : plan.firstTarget < execution.price; const stopValid = side === "long" ? plan.stopPrice < execution.price : plan.stopPrice > execution.price;
  if (!targetValid || !stopValid) return { next, resultType: "rejected" as const, opened: null, closed: null, actions: [{ type: "entry_rejected", reason: "target_or_stop_not_executable" }] };
  const position: Position = { side, entrySourceEventId: source.sourceEventId, signalTime: next.touched.time, entryTime: c.candleTime, entryPrice: execution.price, targetPrice: plan.firstTarget, stopPrice: plan.stopPrice, shares: execution.shares, sourceBoardAgeMs: execution.boardAge, deliveryBoardAgeMs: execution.delivery };
  next = { ...next, position, touched: null }; return { next, resultType: "entry" as const, opened: position, closed: null, actions: [{ type: "entry", side, sourceBoardAgeMs: execution.boardAge, deliveryBoardAgeMs: execution.delivery, boardAgeBasis: "board_observed_to_relay_assembled_same_clock" }] };
}

async function ensureVersion(symbol: AiDailyForecastSymbol) { const version = AI_DAILY_FORECAST_STRATEGY_VERSIONS[symbol]; if (ensured.has(version)) return; const identity = getRuntimeIdentity(); const config = { family: "ai_daily_forecast_shadow", symbol, forecastSnapshot: "immutable_preopen_v1", d1Only: true, entry: "zone_touch_then_separate_confirmation_then_causal_directional_depth_vwap", boardMaximumAgeMs: 5_000, shares: { signal_quality: 100, capital_constrained: "portfolio_proxy" }, exits: { firstTarget: "frozen_ai_snapshot", stop: "min_or_max_forecast_boundary_with_015atr", sameCandlePriority: "stop_first", dayEnd: "15:20" }, evaluation: "monitoring_only", eligibleForAdoption: false, automaticAdoption: false, orderInstructionConnection: false };
  await upsertRtStrategyVersion({ versionId: version, strategyId: `${symbol.toLowerCase()}-ai-daily-v1`, baselineGitSha: BASELINE_STRATEGY_GIT_SHA, buildGitSha: identity.buildGitSha ?? identity.runtimeBuildIdentifier, sourceTreeHash: identity.sourceTreeHash, configHash: sha256Stable(config), configJson: config, learningCutoffDate: AI_DAILY_FORECAST_LEARNING_CUTOFF_DATE, evaluationStartDate: AI_DAILY_FORECAST_COLLECTION_START_DATE, evaluationPurpose: "causality_audit", eligibleForAdoption: false, status: "monitoring", statusReason: "ai_daily_forecast_shadow_manual_review_only" }); ensured.add(version); }

/** 起動時の明示登録。source eventや仮想tradeを作らず、10版をmonitoringで冪等登録する。 */
export async function registerAiDailyForecastShadowLifecycle() {
  for (const symbol of AI_DAILY_FORECAST_SYMBOLS) await ensureVersion(symbol);
}

async function processMode(source: ForwardSourceEventInput, symbol: AiDailyForecastSymbol, mode: ForwardEvaluationMode) { const version = AI_DAILY_FORECAST_STRATEGY_VERSIONS[symbol]; const initial = normalizeState((await getRtForwardShadowState({ strategyVersion: version, evaluationMode: mode }))?.stateJson, source.candle.tradeDate); const hash = sha256Stable(initial); const claim = await claimOrRetryRtForwardShadowEvent({ claimToken: randomUUID(), leaseMs: 30_000, data: { strategyVersion: version, sourceEventId: source.sourceEventId, evaluationMode: mode, tradeDate: source.candle.tradeDate, symbol, candleTime: source.candle.candleTime, resultType: "pending", decisionJson: { status: "claimed", candidateVariant: "ai_daily_forecast", eligibleForAdoption: false }, stateHashBefore: hash, stateHashAfter: hash } }); if (claim !== "claimed") return { mode, status: claim };
  let owner: string | null = null; try { owner = createForwardShadowLockOwnerToken({ strategyVersion: version, sourceEventId: source.sourceEventId, evaluationMode: mode }); if (!await acquireRtForwardShadowStateLock({ strategyVersion: version, evaluationMode: mode, ownerToken: owner, leaseMs: 30_000 })) return { mode, status: "lock_unavailable" }; const latest = normalizeState((await getRtForwardShadowState({ strategyVersion: version, evaluationMode: mode }))?.stateJson, source.candle.tradeDate); const dashboard = await getAiDailyForecastDashboard(source.candle.tradeDate); const plan = planFromSnapshot(dashboard.snapshot, symbol, dashboard.revisions.some(revision => revision.revisionStatus === "market_context_invalidated")); const result = transition(latest, source, plan, mode); const after = sha256Stable(result.next); await upsertRtForwardShadowState({ strategyVersion: version, evaluationMode: mode, stateJson: result.next, stateHash: after, lastSourceEventId: source.sourceEventId }); if (result.opened) { const p = result.opened; await insertRtForwardShadowTrade({ strategyVersion: version, evaluationMode: mode, symbol, side: p.side, entrySourceEventId: p.entrySourceEventId, entryTradeDate: source.candle.tradeDate, signalCandleTime: p.signalTime, entryCandleTime: p.entryTime, theoreticalSignalPrice: String(source.candle.close), entryPrice: String(p.entryPrice), shares: p.shares, slPct: String(Math.abs((p.entryPrice - p.stopPrice) / p.entryPrice * 100)), tpPct: String(Math.abs((p.targetPrice - p.entryPrice) / p.entryPrice * 100)) }); } if (result.closed) await closeRtForwardShadowTrade({ strategyVersion: version, evaluationMode: mode, entrySourceEventId: result.closed.position.entrySourceEventId, exitSourceEventId: source.sourceEventId, exitTradeDate: source.candle.tradeDate, exitCandleTime: source.candle.candleTime, exitPrice: String(result.closed.price), exitReason: result.closed.reason, pnl: result.closed.pnl, pnlAfterAdverseExit: result.closed.pnl, realizedR: String(result.closed.realizedR) }); await updateRtForwardShadowEvent({ strategyVersion: version, sourceEventId: source.sourceEventId, evaluationMode: mode, resultType: result.resultType, decisionJson: { actions: result.actions, plan, eligibleForAdoption: false, automaticAdoption: false, orderInstructionCreated: false, normalTradeTableWritten: false }, stateHashAfter: after }); return { mode, resultType: result.resultType }; } catch (error) { await failRtForwardShadowEvent({ strategyVersion: version, sourceEventId: source.sourceEventId, evaluationMode: mode, errorDetail: String(error), stateHashBefore: hash }); throw error; } finally { if (owner) await releaseRtForwardShadowStateLock({ strategyVersion: version, evaluationMode: mode, ownerToken: owner }); } }

export async function processAiDailyForecastShadowSourceEvent(source: ForwardSourceEventInput) { if (!symbols.has(source.candle.symbol)) return { skipped: "non_ai_forecast_symbol" as const }; if (source.candle.tradeDate < AI_DAILY_FORECAST_COLLECTION_START_DATE) return { skipped: "before_collection_start" as const }; const symbol = source.candle.symbol as AiDailyForecastSymbol; await ensureVersion(symbol); const version = await getRtStrategyVersion(AI_DAILY_FORECAST_STRATEGY_VERSIONS[symbol]); if (version?.status === "stopped" || version?.status === "insufficient") return { skipped: `strategy_${version.status}` as const }; const evaluations = []; for (const mode of MODES) { try { evaluations.push(await processMode(source, symbol, mode)); } catch (error) { evaluations.push({ mode, skipped: "isolated_mode_error", error: String(error) }); } } return { skipped: false as const, symbol, evaluations }; }
export function applyAiDailyForecastTransitionForTest(state: State, source: ForwardSourceEventInput, plan: Plan | null, mode: ForwardEvaluationMode) { return transition(state, source, plan, mode); }
