import type { ForwardEvaluationMode, ForwardSourceEventInput } from "./forwardShadow";
import { calculateClockSafeBoardAge, calculateDepthVwap } from "./telExecutableConfirmDepth";

export const TECHNICAL_REGIME_SHADOW_A_COLLECTION_START_DATE = "2026-10-05";
export const TECHNICAL_REGIME_SHADOW_A_LEARNING_CUTOFF_DATE = "2026-10-02";
export const TECHNICAL_REGIME_SHADOW_A_FORMAL_START_DATE = "2026-10-05";
export const TECHNICAL_REGIME_SHADOW_A_MINIMUM_REWARD_RISK = 1.2;
export const TECHNICAL_REGIME_SHADOW_A_MAX_BOARD_AGE_MS = 5_000;

export type TechnicalPlanKind = "trend_breakout_long" | "trend_breakdown_short" | "range_reversal" | "no_trade";
export type TechnicalShadowSide = "long" | "short";
export type TechnicalShadowResultType = "no_signal" | "pending" | "rejected" | "entry" | "hold" | "exit";

export interface TechnicalRegimePlan {
  sourceTradeDate: string | null;
  symbol: string;
  kind: TechnicalPlanKind;
  setup: string;
  confidence: string;
  priorOpen: number | null;
  priorHigh: number | null;
  priorLow: number | null;
  priorClose: number | null;
  atrPrice: number | null;
  bollingerMiddle: number | null;
  bollingerPlus2: number | null;
  bollingerMinus2: number | null;
  reasonCodes: string[];
}

export interface TechnicalShadowCandle {
  sourceEventId: string;
  candleTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TechnicalShadowPending {
  side: TechnicalShadowSide;
  signalSourceEventId: string;
  signalTime: string;
  theoreticalSignalPrice: number;
  triggerPrice: number;
  stopPrice: number;
  targetCandidates: number[];
  signalKind: "breakout" | "reversal";
}

export interface TechnicalShadowPosition {
  side: TechnicalShadowSide;
  signalSourceEventId: string;
  entrySourceEventId: string;
  signalTime: string;
  entryTime: string;
  theoreticalSignalPrice: number;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  counterfactual2RTarget: number;
  rewardRisk: number;
  shares: number;
  slPct: number;
  tpPct: number;
  executionProxyKind: "ask_depth_vwap_100" | "bid_depth_vwap_100";
  boardAgeMs: number;
}

export interface TechnicalRegimeShadowState {
  version: 1;
  tradeDate: string;
  plan: TechnicalRegimePlan;
  candles: TechnicalShadowCandle[];
  pending: TechnicalShadowPending | null;
  position: TechnicalShadowPosition | null;
  dailySlotConsumed: boolean;
  lastSourceEventId: string | null;
  lastResultType: TechnicalShadowResultType | null;
  lastActions: Array<Record<string, unknown>>;
}

export interface TechnicalRegimeTransition {
  nextState: TechnicalRegimeShadowState;
  resultType: TechnicalShadowResultType;
  actions: Array<Record<string, unknown>>;
  openedPosition: TechnicalShadowPosition | null;
  closedPosition: {
    position: TechnicalShadowPosition;
    exitPrice: number;
    exitReason: string;
    pnl: number;
    pnlAfterAdverseExit: number;
    realizedR: number;
  } | null;
}

type RecordValue = Record<string, unknown>;

function object(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function buildTechnicalRegimePlan(input: {
  symbol: string;
  sourceTradeDate: string | null;
  featureWrapper: unknown;
}): TechnicalRegimePlan {
  const wrapper = object(input.featureWrapper);
  const features = object(wrapper.features);
  const regime = object(wrapper.technicalRegime);
  const bollinger = object(features.bollinger20);
  const priorClose = finite(features.close);
  const atrPct = finite(features.atr14Pct);
  const eligible = wrapper.featureEligible === true
    && regime.eligible === true
    && (wrapper.provenanceStatus === "verified" || wrapper.provenanceStatus === "provenance_present");
  const setup = String(regime.setup ?? "unknown");
  const confidence = String(regime.confidence ?? "unavailable");
  let kind: TechnicalPlanKind = "no_trade";
  if (eligible && confidence !== "low" && confidence !== "unavailable") {
    if (setup === "up_breakout" || setup === "up_trend") kind = "trend_breakout_long";
    else if (setup === "down_breakout" || setup === "down_trend") kind = "trend_breakdown_short";
    else if (setup === "upper_reversal" || setup === "lower_reversal" || setup === "range" || setup === "range_compression") kind = "range_reversal";
  }
  const reasonCodes = eligible
    ? kind === "no_trade" ? ["technical_confidence_too_low"] : ["d_minus_1_feature_frozen"]
    : ["d_minus_1_feature_or_provenance_unavailable"];
  return {
    sourceTradeDate: input.sourceTradeDate,
    symbol: input.symbol,
    kind,
    setup,
    confidence,
    priorOpen: finite(features.open),
    priorHigh: finite(features.high),
    priorLow: finite(features.low),
    priorClose,
    atrPrice: priorClose !== null && atrPct !== null ? priorClose * atrPct / 100 : null,
    bollingerMiddle: finite(bollinger.middle),
    bollingerPlus2: finite(bollinger.plus2),
    bollingerMinus2: finite(bollinger.minus2),
    reasonCodes,
  };
}

export function unavailableTechnicalRegimePlan(symbol: string, reason: string): TechnicalRegimePlan {
  return {
    sourceTradeDate: null, symbol, kind: "no_trade", setup: "unknown", confidence: "unavailable",
    priorOpen: null, priorHigh: null, priorLow: null, priorClose: null, atrPrice: null,
    bollingerMiddle: null, bollingerPlus2: null, bollingerMinus2: null, reasonCodes: [reason],
  };
}

export function createEmptyTechnicalRegimeShadowState(plan: TechnicalRegimePlan, tradeDate = ""): TechnicalRegimeShadowState {
  return {
    version: 1,
    tradeDate,
    plan,
    candles: [],
    pending: null,
    position: null,
    dailySlotConsumed: false,
    lastSourceEventId: null,
    lastResultType: null,
    lastActions: [],
  };
}

export function normalizeTechnicalRegimeShadowState(
  value: unknown,
  tradeDate: string,
  plan: TechnicalRegimePlan,
): TechnicalRegimeShadowState {
  const raw = object(value);
  if (raw.tradeDate !== tradeDate) return createEmptyTechnicalRegimeShadowState(plan, tradeDate);
  return {
    version: 1,
    tradeDate,
    plan: object(raw.plan).symbol === plan.symbol ? raw.plan as unknown as TechnicalRegimePlan : plan,
    candles: Array.isArray(raw.candles) ? raw.candles.slice(-64) as TechnicalShadowCandle[] : [],
    pending: raw.pending && typeof raw.pending === "object" ? raw.pending as TechnicalShadowPending : null,
    position: raw.position && typeof raw.position === "object" ? raw.position as TechnicalShadowPosition : null,
    dailySlotConsumed: raw.dailySlotConsumed === true,
    lastSourceEventId: typeof raw.lastSourceEventId === "string" ? raw.lastSourceEventId : null,
    lastResultType: typeof raw.lastResultType === "string" ? raw.lastResultType as TechnicalShadowResultType : null,
    lastActions: Array.isArray(raw.lastActions) ? raw.lastActions as Array<Record<string, unknown>> : [],
  };
}

function average(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function inEntryWindow(time: string) {
  return (time >= "09:15" && time <= "11:20") || (time >= "12:35" && time <= "14:30");
}

function roundStep(price: number) {
  if (price < 1_000) return 10;
  if (price < 5_000) return 50;
  if (price < 10_000) return 100;
  if (price < 50_000) return 500;
  return 1_000;
}

function nextRound(price: number, side: TechnicalShadowSide) {
  const step = roundStep(price);
  return side === "long" ? Math.ceil((price + 1e-9) / step) * step : Math.floor((price - 1e-9) / step) * step;
}

function uniqueFinite(values: Array<number | null | undefined>) {
  return Array.from(new Set(values.filter((value): value is number => value !== null && value !== undefined && Number.isFinite(value))));
}

function signalFromPlan(state: TechnicalRegimeShadowState): TechnicalShadowPending | null {
  const plan = state.plan;
  const current = state.candles.at(-1);
  if (!current || state.candles.length < 10 || !inEntryWindow(current.candleTime)) return null;
  if (plan.priorHigh === null || plan.priorLow === null || plan.priorClose === null || plan.atrPrice === null || plan.atrPrice <= 0) return null;
  const priorVolumes = state.candles.slice(-11, -1).map(item => item.volume).filter(value => value >= 0);
  const typicalVolume = average(priorVolumes);
  const volumeRatio = typicalVolume !== null && typicalVolume > 0 ? current.volume / typicalVolume : 0;
  const totalVolume = state.candles.reduce((sum, item) => sum + item.volume, 0);
  const vwap = totalVolume > 0
    ? state.candles.reduce((sum, item) => sum + ((item.high + item.low + item.close) / 3) * item.volume, 0) / totalVolume
    : current.close;
  const buffer = Math.max(plan.priorClose * 0.0005, plan.atrPrice * 0.02);
  const make = (side: TechnicalShadowSide, triggerPrice: number, signalKind: "breakout" | "reversal") => {
    const stopPrice = side === "long" ? triggerPrice - buffer : triggerPrice + buffer;
    const targetCandidates = side === "long"
      ? uniqueFinite([plan.bollingerMiddle, plan.bollingerPlus2, plan.priorHigh! + plan.atrPrice! * 0.35, nextRound(current.close, side)]).filter(value => value > current.close)
      : uniqueFinite([plan.bollingerMiddle, plan.bollingerMinus2, plan.priorLow! - plan.atrPrice! * 0.35, nextRound(current.close, side)]).filter(value => value < current.close);
    return {
      side,
      signalSourceEventId: current.sourceEventId,
      signalTime: current.candleTime,
      theoreticalSignalPrice: current.close,
      triggerPrice,
      stopPrice,
      targetCandidates,
      signalKind,
    } satisfies TechnicalShadowPending;
  };
  if (plan.kind === "trend_breakout_long"
    && current.close > plan.priorHigh && current.close > current.open && current.close > vwap && volumeRatio >= 1.2) {
    return make("long", plan.priorHigh, "breakout");
  }
  if (plan.kind === "trend_breakdown_short"
    && current.close < plan.priorLow && current.close < current.open && current.close < vwap && volumeRatio >= 1.2) {
    return make("short", plan.priorLow, "breakout");
  }
  if (plan.kind === "range_reversal") {
    if (current.low < plan.priorLow && current.close > plan.priorLow && current.close > current.open && volumeRatio >= 1.1) {
      return make("long", plan.priorLow, "reversal");
    }
    if (current.high > plan.priorHigh && current.close < plan.priorHigh && current.close < current.open && volumeRatio >= 1.1) {
      return make("short", plan.priorHigh, "reversal");
    }
  }
  return null;
}

function sharesForMode(mode: ForwardEvaluationMode, price: number) {
  if (mode === "signal_quality") return 100;
  return Math.max(100, Math.floor(Math.floor(3_000_000 * 0.9 / price) / 100) * 100);
}

function confirmPending(
  state: TechnicalRegimeShadowState,
  input: ForwardSourceEventInput,
  mode: ForwardEvaluationMode,
  actions: Array<Record<string, unknown>>,
): TechnicalShadowPosition | null {
  const pending = state.pending;
  if (!pending) return null;
  state.pending = null;
  const clockAge = calculateClockSafeBoardAge(input.currentAudit);
  const depth = calculateDepthVwap({ board: input.board, side: pending.side, shares: 100 });
  const entryPrice = depth?.price ?? null;
  const maintained = entryPrice !== null && (pending.side === "long" ? entryPrice > pending.triggerPrice : entryPrice < pending.triggerPrice);
  const adverseEntryPct = entryPrice === null ? null : pending.side === "long"
    ? (entryPrice - pending.theoreticalSignalPrice) / pending.theoreticalSignalPrice * 100
    : (pending.theoreticalSignalPrice - entryPrice) / pending.theoreticalSignalPrice * 100;
  const targetPrice = entryPrice === null ? null : pending.side === "long"
    ? pending.targetCandidates.filter(value => value > entryPrice).sort((a, b) => a - b)[0] ?? null
    : pending.targetCandidates.filter(value => value < entryPrice).sort((a, b) => b - a)[0] ?? null;
  const risk = entryPrice === null ? null : pending.side === "long" ? entryPrice - pending.stopPrice : pending.stopPrice - entryPrice;
  const reward = entryPrice === null || targetPrice === null ? null : pending.side === "long" ? targetPrice - entryPrice : entryPrice - targetPrice;
  const rewardRisk = risk !== null && reward !== null && risk > 0 ? reward / risk : null;
  const accepted = clockAge.timestampsAvailable && clockAge.causal && clockAge.fresh
    && entryPrice !== null && maintained && adverseEntryPct !== null && adverseEntryPct <= 0.15
    && targetPrice !== null && risk !== null && risk > 0 && rewardRisk !== null
    && rewardRisk >= TECHNICAL_REGIME_SHADOW_A_MINIMUM_REWARD_RISK;
  if (!accepted || entryPrice === null || targetPrice === null || risk === null || rewardRisk === null || clockAge.boardAgeMs === null) {
    actions.push({
      type: "entry_rejected", side: pending.side, routeId: `technical_${pending.signalKind}_${pending.side}`,
      reason: !clockAge.timestampsAvailable ? "board_timestamps_unavailable"
        : !clockAge.causal ? "board_clock_not_causal"
          : !clockAge.fresh ? "board_stale_over_5000ms"
            : entryPrice === null ? "insufficient_directional_depth_100_shares"
              : !maintained ? "technical_trigger_not_maintained_next_event"
                : adverseEntryPct !== null && adverseEntryPct > 0.15 ? "adverse_entry_over_015pct"
                  : targetPrice === null ? "no_d_minus_1_technical_target_beyond_entry"
                    : risk === null || risk <= 0 ? "technical_stop_not_valid"
                      : "technical_reward_risk_below_1_2",
      signalSourceEventId: pending.signalSourceEventId, theoreticalSignalPrice: pending.theoreticalSignalPrice,
      executableEntryPrice: entryPrice, stopPrice: pending.stopPrice, targetPrice, rewardRisk,
      boardAgeMs: clockAge.boardAgeMs, dailySlotConsumed: false,
    });
    return null;
  }
  const shares = sharesForMode(mode, entryPrice);
  const counterfactual2RTarget = pending.side === "long" ? entryPrice + risk * 2 : entryPrice - risk * 2;
  const position: TechnicalShadowPosition = {
    side: pending.side,
    signalSourceEventId: pending.signalSourceEventId,
    entrySourceEventId: input.sourceEventId,
    signalTime: pending.signalTime,
    entryTime: input.candle.candleTime,
    theoreticalSignalPrice: pending.theoreticalSignalPrice,
    entryPrice,
    stopPrice: pending.stopPrice,
    targetPrice,
    counterfactual2RTarget,
    rewardRisk,
    shares,
    slPct: risk / entryPrice * 100,
    tpPct: Math.abs(targetPrice - entryPrice) / entryPrice * 100,
    executionProxyKind: pending.side === "long" ? "ask_depth_vwap_100" : "bid_depth_vwap_100",
    boardAgeMs: clockAge.boardAgeMs,
  };
  actions.push({
    type: "entry", side: position.side, routeId: `technical_${pending.signalKind}_${pending.side}`,
    signalSourceEventId: pending.signalSourceEventId, executableEntryPrice: entryPrice,
    stopPrice: position.stopPrice, targetPrice: position.targetPrice,
    technicalRewardRisk: position.rewardRisk, counterfactual2RTarget, shares, depth,
  });
  return position;
}

function closePosition(state: TechnicalRegimeShadowState, input: ForwardSourceEventInput) {
  const position = state.position;
  if (!position) return null;
  const candle = input.candle;
  let exitPrice: number | null = null;
  let exitReason: string | null = null;
  if (position.side === "long") {
    if (candle.open <= position.stopPrice) { exitPrice = candle.open; exitReason = "technical_stop_gap"; }
    else if (candle.low <= position.stopPrice) { exitPrice = position.stopPrice; exitReason = "technical_stop"; }
    else if (candle.high >= position.targetPrice) { exitPrice = position.targetPrice; exitReason = "technical_target"; }
  } else {
    if (candle.open >= position.stopPrice) { exitPrice = candle.open; exitReason = "technical_stop_gap"; }
    else if (candle.high >= position.stopPrice) { exitPrice = position.stopPrice; exitReason = "technical_stop"; }
    else if (candle.low <= position.targetPrice) { exitPrice = position.targetPrice; exitReason = "technical_target"; }
  }
  if (exitPrice === null && candle.candleTime >= "15:20") {
    exitPrice = candle.close;
    exitReason = "day_end_flatten";
  }
  if (exitPrice === null || exitReason === null) return null;
  const direction = position.side === "long" ? 1 : -1;
  const pnl = Math.round((exitPrice - position.entryPrice) * direction * position.shares);
  const adverseExit = position.side === "long" ? exitPrice * 0.999 : exitPrice * 1.001;
  const pnlAfterAdverseExit = Math.round((adverseExit - position.entryPrice) * direction * position.shares);
  const initialRisk = Math.abs(position.entryPrice - position.stopPrice) * position.shares;
  return {
    position, exitPrice, exitReason, pnl, pnlAfterAdverseExit,
    realizedR: initialRisk > 0 ? pnl / initialRisk : 0,
  };
}

export function applyTechnicalRegimeShadowTransition(
  previous: TechnicalRegimeShadowState,
  input: ForwardSourceEventInput,
  mode: ForwardEvaluationMode,
): TechnicalRegimeTransition {
  const state: TechnicalRegimeShadowState = {
    ...previous,
    candles: [...previous.candles],
    pending: previous.pending ? { ...previous.pending, targetCandidates: [...previous.pending.targetCandidates] } : null,
    position: previous.position ? { ...previous.position } : null,
    lastActions: [],
  };
  const actions: Array<Record<string, unknown>> = [];
  let openedPosition: TechnicalShadowPosition | null = null;
  let closedPosition: TechnicalRegimeTransition["closedPosition"] = null;
  let resultType: TechnicalShadowResultType = "no_signal";

  if (state.position) {
    closedPosition = closePosition(state, input);
    if (closedPosition) {
      actions.push({ type: "exit", side: closedPosition.position.side, routeId: `technical_${closedPosition.position.side}`, exitPrice: closedPosition.exitPrice, exitReason: closedPosition.exitReason, pnl: closedPosition.pnl });
      state.position = null;
      resultType = "exit";
    } else resultType = "hold";
  } else if (state.pending) {
    openedPosition = confirmPending(state, input, mode, actions);
    if (openedPosition) {
      state.position = openedPosition;
      state.dailySlotConsumed = true;
      resultType = "entry";
    } else resultType = "rejected";
  }

  state.candles.push({ sourceEventId: input.sourceEventId, candleTime: input.candle.candleTime, open: input.candle.open, high: input.candle.high, low: input.candle.low, close: input.candle.close, volume: input.candle.volume });
  state.candles = state.candles.slice(-64);

  if (!state.position && !state.pending && !state.dailySlotConsumed && resultType !== "exit") {
    const pending = signalFromPlan(state);
    if (pending) {
      state.pending = pending;
      actions.push({ type: "signal_pending_next_event", side: pending.side, routeId: `technical_${pending.signalKind}_${pending.side}`, triggerPrice: pending.triggerPrice, stopPrice: pending.stopPrice, targetCandidates: pending.targetCandidates, planKind: state.plan.kind, sourceFeatureDate: state.plan.sourceTradeDate });
      resultType = "pending";
    } else if (state.plan.kind === "no_trade") {
      actions.push({ type: "no_trade_plan", reasonCodes: state.plan.reasonCodes, sourceFeatureDate: state.plan.sourceTradeDate });
    }
  }

  state.lastSourceEventId = input.sourceEventId;
  state.lastResultType = resultType;
  state.lastActions = actions;
  return { nextState: state, resultType, actions, openedPosition, closedPosition };
}
