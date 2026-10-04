import type { ForwardEvaluationMode, ForwardSourceEventInput } from "./forwardShadow";
import { calculateClockSafeBoardAge, calculateDepthVwap } from "./telExecutableConfirmDepth";
import {
  buildTechnicalAnalysisSnapshot,
  TECHNICAL_ANALYSIS_SHADOW_VERSION,
  type TechnicalAnalysisSnapshotV2,
  type TechnicalIndicatorSet,
  type TechnicalSignalType,
} from "./technicalAnalysisShadowV2";

export const TECHNICAL_REGIME_SHADOW_A_COLLECTION_START_DATE = "2026-10-05";
export const TECHNICAL_REGIME_SHADOW_A_LEARNING_CUTOFF_DATE = "2026-10-02";
export const TECHNICAL_REGIME_SHADOW_A_FORMAL_START_DATE = "2026-10-05";
// ユーザー承認済みの初期検証方針: 固定1.2Rでは拒否せず、技術的な目標が
// 損切りと同方向でない（reward/risk > 0）ことだけを要求する。
export const TECHNICAL_REGIME_SHADOW_A_MINIMUM_REWARD_RISK = 0;
export const TECHNICAL_REGIME_SHADOW_A_MAX_BOARD_AGE_MS = 5_000;

export type TechnicalPlanKind = "trend_breakout_long" | "trend_breakdown_short" | "range_reversal" | "no_trade";
export type TechnicalShadowSide = "long" | "short";
export type TechnicalShadowResultType = "no_signal" | "pending" | "rejected" | "entry" | "hold" | "exit";

export interface TechnicalRegimePlan {
  analysisVersion: typeof TECHNICAL_ANALYSIS_SHADOW_VERSION;
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
  dailyTrend: "up" | "down" | "range" | "unknown";
  dailyIndicators: Partial<TechnicalIndicatorSet>;
  exitPolicy: {
    stopBasis: "swing_support_resistance_atr";
    targetBasis: "nearest_technical_level";
    breakEvenAfterR: number;
    exitOnOppositeConfirmedSignal: boolean;
    exitOnConfirmedSma21Break: boolean;
    dayEndFlattenTime: string;
    dailyLossLimitR: number;
  };
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
  signalKind: "breakout" | "reversal" | "pullback" | "retracement" | "ma21_turn";
  technicalSignalType: TechnicalSignalType;
  signalAnalysis: Record<string, unknown>;
}

export interface TechnicalShadowFiveMinuteCandle extends TechnicalShadowCandle {
  bucketStart: string;
  memberTimes: string[];
  complete: boolean;
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
  initialStopPrice: number;
  breakEvenArmed: boolean;
  technicalSignalType: TechnicalSignalType;
}

export interface TechnicalRegimeShadowState {
  version: 2;
  tradeDate: string;
  plan: TechnicalRegimePlan;
  candles: TechnicalShadowCandle[];
  fiveMinuteCandles: TechnicalShadowFiveMinuteCandle[];
  pending: TechnicalShadowPending | null;
  position: TechnicalShadowPosition | null;
  dailySlotConsumed: boolean;
  lastSourceEventId: string | null;
  lastResultType: TechnicalShadowResultType | null;
  lastActions: Array<Record<string, unknown>>;
  lastAnalysis: TechnicalAnalysisSnapshotV2 | null;
  realizedDailyR: number;
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
  const dailyTechnical = object(features.technicalIndicators);
  const movingAverages = object(features.movingAverages);
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
    analysisVersion: TECHNICAL_ANALYSIS_SHADOW_VERSION,
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
    dailyTrend: regime.trend === "up" || regime.trend === "down" || regime.trend === "range" ? regime.trend : "unknown",
    dailyIndicators: {
      sma5: finite(object(movingAverages["5"]).value),
      sma21: finite(object(movingAverages["21"]).value) ?? finite(object(movingAverages["20"]).value),
      sma50: finite(object(movingAverages["50"]).value),
      macd: finite(dailyTechnical.macd),
      macdSignal: finite(dailyTechnical.macdSignal),
      macdHistogram: finite(dailyTechnical.macdHistogram),
      rsi14: finite(dailyTechnical.rsi14),
      stochasticK: finite(dailyTechnical.stochasticK),
      stochasticD: finite(dailyTechnical.stochasticD),
      rciShort: finite(dailyTechnical.rciShort),
      rciMedium: finite(dailyTechnical.rciMedium),
      rciLong: finite(dailyTechnical.rciLong),
    },
    exitPolicy: {
      stopBasis: "swing_support_resistance_atr",
      targetBasis: "nearest_technical_level",
      breakEvenAfterR: 1,
      exitOnOppositeConfirmedSignal: true,
      exitOnConfirmedSma21Break: true,
      dayEndFlattenTime: "15:20",
      dailyLossLimitR: -1,
    },
    reasonCodes,
  };
}

export function unavailableTechnicalRegimePlan(symbol: string, reason: string): TechnicalRegimePlan {
  return {
    analysisVersion: TECHNICAL_ANALYSIS_SHADOW_VERSION,
    sourceTradeDate: null, symbol, kind: "no_trade", setup: "unknown", confidence: "unavailable",
    priorOpen: null, priorHigh: null, priorLow: null, priorClose: null, atrPrice: null,
    bollingerMiddle: null, bollingerPlus2: null, bollingerMinus2: null,
    dailyTrend: "unknown", dailyIndicators: {},
    exitPolicy: { stopBasis: "swing_support_resistance_atr", targetBasis: "nearest_technical_level", breakEvenAfterR: 1, exitOnOppositeConfirmedSignal: true, exitOnConfirmedSma21Break: true, dayEndFlattenTime: "15:20", dailyLossLimitR: -1 },
    reasonCodes: [reason],
  };
}

export function createEmptyTechnicalRegimeShadowState(plan: TechnicalRegimePlan, tradeDate = ""): TechnicalRegimeShadowState {
  return {
    version: 2,
    tradeDate,
    plan,
    candles: [],
    fiveMinuteCandles: [],
    pending: null,
    position: null,
    dailySlotConsumed: false,
    lastSourceEventId: null,
    lastResultType: null,
    lastActions: [],
    lastAnalysis: null,
    realizedDailyR: 0,
  };
}

export function normalizeTechnicalRegimeShadowState(
  value: unknown,
  tradeDate: string,
  plan: TechnicalRegimePlan,
): TechnicalRegimeShadowState {
  const raw = object(value);
  if (raw.tradeDate !== tradeDate) return createEmptyTechnicalRegimeShadowState(plan, tradeDate);
  const storedPlan = object(raw.plan);
  const normalizedPlan: TechnicalRegimePlan = storedPlan.symbol === plan.symbol
    ? {
      ...plan,
      ...storedPlan as unknown as Partial<TechnicalRegimePlan>,
      dailyIndicators: { ...plan.dailyIndicators, ...object(storedPlan.dailyIndicators) },
      exitPolicy: { ...plan.exitPolicy, ...object(storedPlan.exitPolicy) },
    } as TechnicalRegimePlan
    : plan;
  return {
    version: 2,
    tradeDate,
    plan: normalizedPlan,
    candles: Array.isArray(raw.candles) ? raw.candles.slice(-64) as TechnicalShadowCandle[] : [],
    fiveMinuteCandles: Array.isArray(raw.fiveMinuteCandles) ? raw.fiveMinuteCandles.slice(-64) as TechnicalShadowFiveMinuteCandle[] : [],
    pending: raw.pending && typeof raw.pending === "object" ? raw.pending as TechnicalShadowPending : null,
    position: raw.position && typeof raw.position === "object" ? raw.position as TechnicalShadowPosition : null,
    dailySlotConsumed: raw.dailySlotConsumed === true,
    lastSourceEventId: typeof raw.lastSourceEventId === "string" ? raw.lastSourceEventId : null,
    lastResultType: typeof raw.lastResultType === "string" ? raw.lastResultType as TechnicalShadowResultType : null,
    lastActions: Array.isArray(raw.lastActions) ? raw.lastActions as Array<Record<string, unknown>> : [],
    lastAnalysis: raw.lastAnalysis && typeof raw.lastAnalysis === "object" ? raw.lastAnalysis as unknown as TechnicalAnalysisSnapshotV2 : null,
    realizedDailyR: finite(raw.realizedDailyR) ?? 0,
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

function signalKind(type: TechnicalSignalType): TechnicalShadowPending["signalKind"] {
  if (type === "trend_pullback") return "pullback";
  if (type === "trend_retracement") return "retracement";
  if (type === "ma21_turn") return "ma21_turn";
  if (type === "range_reversal") return "reversal";
  return "breakout";
}

function signalFromPlan(state: TechnicalRegimeShadowState, analysis: TechnicalAnalysisSnapshotV2): TechnicalShadowPending | null {
  const plan = state.plan;
  const current = state.candles.at(-1);
  if (!current || state.candles.length < 22 || !inEntryWindow(current.candleTime)) return null;
  if (plan.priorHigh === null || plan.priorLow === null || plan.priorClose === null || plan.atrPrice === null || plan.atrPrice <= 0) return null;
  const allowed = plan.kind === "trend_breakout_long" ? ["long"]
    : plan.kind === "trend_breakdown_short" ? ["short"]
      : plan.kind === "range_reversal" ? ["long", "short"] : [];
  const selected = analysis.signals
    .filter(item => item.executableInShadow && item.status === "confirmed" && allowed.includes(item.side))
    .sort((a, b) => b.confidenceCompleteness - a.confidenceCompleteness || a.id.localeCompare(b.id))[0];
  if (!selected || selected.entryCandidate === null || selected.stopCandidate === null) return null;
  const kind = signalKind(selected.type);
  const fallbackTargets = selected.side === "long"
    ? uniqueFinite([plan.bollingerMiddle, plan.bollingerPlus2, plan.priorHigh + plan.atrPrice * 0.35, nextRound(current.close, selected.side)]).filter(value => value > current.close)
    : uniqueFinite([plan.bollingerMiddle, plan.bollingerMinus2, plan.priorLow - plan.atrPrice * 0.35, nextRound(current.close, selected.side)]).filter(value => value < current.close);
  return {
    side: selected.side,
    signalSourceEventId: current.sourceEventId,
    signalTime: current.candleTime,
    theoreticalSignalPrice: selected.entryCandidate,
    triggerPrice: selected.type === "support_resistance_breakout"
      ? selected.side === "long" ? plan.priorHigh : plan.priorLow
      : selected.entryCandidate,
    stopPrice: selected.stopCandidate,
    targetCandidates: selected.targetCandidates.length ? selected.targetCandidates : fallbackTargets,
    signalKind: kind,
    technicalSignalType: selected.type,
    signalAnalysis: {
      signalId: selected.id,
      metConditions: selected.metConditions,
      unmetConditions: selected.unmetConditions,
      confidenceCompleteness: selected.confidenceCompleteness,
      marketState: selected.marketState,
    },
  };
}

function bucketStart(time: string) {
  const [hour, minute] = time.split(":").map(Number);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return time;
  return `${String(hour).padStart(2, "0")}:${String(Math.floor(minute / 5) * 5).padStart(2, "0")}`;
}

function appendFiveMinuteCandle(state: TechnicalRegimeShadowState, candle: TechnicalShadowCandle) {
  const bucket = bucketStart(candle.candleTime);
  const previous = state.fiveMinuteCandles.at(-1);
  if (previous?.bucketStart === bucket) {
    const memberTimes = Array.from(new Set([...previous.memberTimes, candle.candleTime])).sort();
    state.fiveMinuteCandles[state.fiveMinuteCandles.length - 1] = {
      ...previous,
      sourceEventId: candle.sourceEventId,
      high: Math.max(previous.high, candle.high),
      low: Math.min(previous.low, candle.low),
      close: candle.close,
      volume: previous.volume + (previous.memberTimes.includes(candle.candleTime) ? 0 : candle.volume),
      memberTimes,
      complete: memberTimes.length === 5,
    };
  } else {
    state.fiveMinuteCandles.push({ ...candle, bucketStart: bucket, memberTimes: [candle.candleTime], complete: false });
  }
  state.fiveMinuteCandles = state.fiveMinuteCandles.slice(-64);
}

function analyzeState(state: TechnicalRegimeShadowState) {
  return buildTechnicalAnalysisSnapshot({
    oneMinuteCandles: state.candles.map(item => ({ time: item.candleTime, open: item.open, high: item.high, low: item.low, close: item.close, volume: item.volume })),
    fiveMinuteCandles: state.fiveMinuteCandles.filter(item => item.complete).map(item => ({ time: item.bucketStart, open: item.open, high: item.high, low: item.low, close: item.close, volume: item.volume })),
    dailyContext: {
      trend: state.plan.dailyTrend,
      priorHigh: state.plan.priorHigh,
      priorLow: state.plan.priorLow,
      priorClose: state.plan.priorClose,
      atrPrice: state.plan.atrPrice,
      bollingerMiddle: state.plan.bollingerMiddle,
      bollingerUpper: state.plan.bollingerPlus2,
      bollingerLower: state.plan.bollingerMinus2,
      sma5: state.plan.dailyIndicators.sma5 ?? null,
      sma21: state.plan.dailyIndicators.sma21 ?? null,
      sma50: state.plan.dailyIndicators.sma50 ?? null,
      macd: state.plan.dailyIndicators.macd ?? null,
      macdSignal: state.plan.dailyIndicators.macdSignal ?? null,
      rsi14: state.plan.dailyIndicators.rsi14 ?? null,
    },
  });
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
    && rewardRisk > TECHNICAL_REGIME_SHADOW_A_MINIMUM_REWARD_RISK;
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
                      : "technical_reward_not_positive",
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
    initialStopPrice: pending.stopPrice,
    breakEvenArmed: false,
    technicalSignalType: pending.technicalSignalType,
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
  if (exitPrice === null && candle.candleTime >= state.plan.exitPolicy.dayEndFlattenTime) {
    exitPrice = candle.close;
    exitReason = "day_end_flatten";
  }
  if (exitPrice === null || exitReason === null) {
    const initialStop = Number.isFinite(position.initialStopPrice) ? position.initialStopPrice : position.stopPrice;
    const initialRiskPerShare = Math.abs(position.entryPrice - initialStop);
    const favorableReached = position.side === "long"
      ? candle.high >= position.entryPrice + initialRiskPerShare * state.plan.exitPolicy.breakEvenAfterR
      : candle.low <= position.entryPrice - initialRiskPerShare * state.plan.exitPolicy.breakEvenAfterR;
    if (!position.breakEvenArmed && initialRiskPerShare > 0 && favorableReached) {
      position.stopPrice = position.entryPrice;
      position.breakEvenArmed = true;
    }
    return null;
  }
  const direction = position.side === "long" ? 1 : -1;
  const pnl = Math.round((exitPrice - position.entryPrice) * direction * position.shares);
  const adverseExit = position.side === "long" ? exitPrice * 0.999 : exitPrice * 1.001;
  const pnlAfterAdverseExit = Math.round((adverseExit - position.entryPrice) * direction * position.shares);
  const initialStop = Number.isFinite(position.initialStopPrice) ? position.initialStopPrice : position.stopPrice;
  const initialRisk = Math.abs(position.entryPrice - initialStop) * position.shares;
  return {
    position, exitPrice, exitReason, pnl, pnlAfterAdverseExit,
    realizedR: initialRisk > 0 ? pnl / initialRisk : 0,
  };
}

function closePositionFromAnalysis(
  state: TechnicalRegimeShadowState,
  input: ForwardSourceEventInput,
  analysis: TechnicalAnalysisSnapshotV2,
) {
  const position = state.position;
  if (!position) return null;
  const indicator = analysis.timeframes.oneMinute.indicators;
  const oppositeConfirmed = analysis.signals.some(signal => signal.executableInShadow && signal.status === "confirmed" && signal.side !== position.side);
  const smaBreak = position.side === "long"
    ? indicator.sma21 !== null && input.candle.close < indicator.sma21 && (indicator.macdHistogram ?? 0) < 0
    : indicator.sma21 !== null && input.candle.close > indicator.sma21 && (indicator.macdHistogram ?? 0) > 0;
  const exitReason = state.plan.exitPolicy.exitOnOppositeConfirmedSignal && oppositeConfirmed
    ? "technical_opposite_confirmed_signal"
    : state.plan.exitPolicy.exitOnConfirmedSma21Break && smaBreak
      ? "technical_sma21_break_with_macd_confirmation"
      : null;
  if (!exitReason) return null;
  const exitPrice = input.candle.close;
  const direction = position.side === "long" ? 1 : -1;
  const pnl = Math.round((exitPrice - position.entryPrice) * direction * position.shares);
  const adverseExit = position.side === "long" ? exitPrice * 0.999 : exitPrice * 1.001;
  const pnlAfterAdverseExit = Math.round((adverseExit - position.entryPrice) * direction * position.shares);
  const initialStop = Number.isFinite(position.initialStopPrice) ? position.initialStopPrice : position.stopPrice;
  const initialRisk = Math.abs(position.entryPrice - initialStop) * position.shares;
  return { position, exitPrice, exitReason, pnl, pnlAfterAdverseExit, realizedR: initialRisk > 0 ? pnl / initialRisk : 0 };
}

export function applyTechnicalRegimeShadowTransition(
  previous: TechnicalRegimeShadowState,
  input: ForwardSourceEventInput,
  mode: ForwardEvaluationMode,
): TechnicalRegimeTransition {
  const state: TechnicalRegimeShadowState = {
    ...previous,
    candles: [...previous.candles],
    fiveMinuteCandles: previous.fiveMinuteCandles.map(item => ({ ...item, memberTimes: [...item.memberTimes] })),
    pending: previous.pending ? { ...previous.pending, targetCandidates: [...previous.pending.targetCandidates] } : null,
    position: previous.position ? { ...previous.position } : null,
    lastActions: [],
    lastAnalysis: previous.lastAnalysis,
  };
  const actions: Array<Record<string, unknown>> = [];
  let openedPosition: TechnicalShadowPosition | null = null;
  let closedPosition: TechnicalRegimeTransition["closedPosition"] = null;
  let resultType: TechnicalShadowResultType = "no_signal";

  if (state.position) {
    closedPosition = closePosition(state, input);
    if (closedPosition) {
      actions.push({ type: "exit", side: closedPosition.position.side, routeId: `technical_${closedPosition.position.side}`, exitPrice: closedPosition.exitPrice, exitReason: closedPosition.exitReason, pnl: closedPosition.pnl });
      state.realizedDailyR += closedPosition.realizedR;
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

  const completedCandle = { sourceEventId: input.sourceEventId, candleTime: input.candle.candleTime, open: input.candle.open, high: input.candle.high, low: input.candle.low, close: input.candle.close, volume: input.candle.volume };
  state.candles.push(completedCandle);
  state.candles = state.candles.slice(-64);
  appendFiveMinuteCandle(state, completedCandle);
  const analysis = analyzeState(state);
  state.lastAnalysis = analysis;
  const visibleSignals = analysis.signals
    .filter(item => item.status === "confirmed" || item.confidenceCompleteness >= 0.5)
    .map(item => ({
      id: item.id,
      symbol: state.plan.symbol,
      occurredAt: analysis.asOfTime,
      timeframe: item.timeframe,
      side: item.side,
      type: item.type,
      status: item.status,
      executableInShadow: item.executableInShadow,
      confidenceCompleteness: item.confidenceCompleteness,
      metConditions: item.metConditions,
      unmetConditions: item.unmetConditions,
      evidence: item.evidence,
      entryCandidate: item.entryCandidate,
      stopCandidate: item.stopCandidate,
      targetCandidates: item.targetCandidates,
      cancelReason: item.cancelReason,
    }));
  actions.push({
    type: "technical_analysis_snapshot_v2",
    symbol: state.plan.symbol,
    version: analysis.version,
    asOfTime: analysis.asOfTime,
    combinedState: analysis.combinedState,
    timeframeAgreement: analysis.timeframeAgreement,
    timeframes: {
      oneMinute: analysis.timeframes.oneMinute.state,
      fiveMinute: analysis.timeframes.fiveMinute.state,
      daily: analysis.timeframes.daily.state,
    },
    indicators: analysis.timeframes.oneMinute.indicators,
    supports: analysis.supports,
    resistances: analysis.resistances,
    patterns: analysis.patterns,
    volume: analysis.volume,
    signalCandidateCount: analysis.signals.length,
    visibleSignals,
    confidenceMeaning: "condition_completeness_not_predicted_win_rate",
    displayAndShadowEvaluationOnly: true,
  });

  if (state.position && resultType === "hold") {
    const analysisExit = closePositionFromAnalysis(state, input, analysis);
    if (analysisExit) {
      closedPosition = analysisExit;
      state.realizedDailyR += analysisExit.realizedR;
      actions.push({
        type: "exit",
        side: analysisExit.position.side,
        routeId: `technical_${analysisExit.position.technicalSignalType}_${analysisExit.position.side}`,
        exitPrice: analysisExit.exitPrice,
        exitReason: analysisExit.exitReason,
        pnl: analysisExit.pnl,
      });
      state.position = null;
      resultType = "exit";
    }
  }

  if (!state.position && !state.pending && !state.dailySlotConsumed && resultType !== "exit" && state.realizedDailyR > state.plan.exitPolicy.dailyLossLimitR) {
    const pending = signalFromPlan(state, analysis);
    if (pending) {
      state.pending = pending;
      actions.push({ type: "signal_pending_next_event", side: pending.side, routeId: `technical_${pending.signalKind}_${pending.side}`, technicalSignalType: pending.technicalSignalType, signalAnalysis: pending.signalAnalysis, triggerPrice: pending.triggerPrice, stopPrice: pending.stopPrice, targetCandidates: pending.targetCandidates, planKind: state.plan.kind, sourceFeatureDate: state.plan.sourceTradeDate });
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
