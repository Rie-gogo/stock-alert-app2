import { calcATR } from "./intradayRegime";
import {
  KIOXIA_CONFIRMED_MORNING_LONG_SPEC,
  calculateKioxiaConfirmedMorningLongMetrics,
  isKioxiaConfirmedMorningLongEntryTime,
} from "./kioxiaConfirmedMorningLong";
import { calcBollinger, calcMA, calcRSI, detectSignals, type CandleWithSignal } from "./routers/stockData";
import { getHigherTfTrend } from "./vwap";

export type KioxiaAtrForwardRoute =
  | "confirmed_morning_long"
  | "reversal_long"
  | "reversal_short"
  | "trend_short"
  | "safe_cb_short";

export type KioxiaAtrForwardEvaluationMode = "signal_quality" | "capital_constrained";
export type KioxiaAtrForwardResultType = "no_signal" | "pending" | "entry" | "hold" | "exit" | "rejected" | "error";

export const KIOXIA_ATR_FORWARD_SHADOW_SPEC = Object.freeze({
  symbol: "285A",
  dryRunOnly: true,
  liveOrderApproved: false,
  candidateKey: "285a_current_five_routes_atr036_route_daily_end",
  learningCutoffDate: "2026-09-03",
  evaluationStartDate: "2026-09-07",
  entry: Object.freeze({
    atrPeriod: 7,
    minimumAtrPct: 0.36,
    currentCommonMinimumAtrPct: 0.12,
    lowAtrAction: "end_only_the_triggered_route_for_the_trade_date",
    executablePriceSource: "board_current_price_at_server_receipt",
  }),
  routes: Object.freeze({
    confirmed_morning_long: Object.freeze({
      side: "long" as const,
      startTime: "09:45",
      endTime: "11:20",
      slPct: 0.8,
      tpPct: 1.6,
    }),
    reversal_long: Object.freeze({
      side: "long" as const,
      startTime: "09:45",
      endTime: "11:27",
      minimumDropFromDayHighPct: 2.5,
      minimumMa8Slope2Pct: 0.02,
      lookback: 10,
      slPct: 0.6,
      tpPct: 1.2,
    }),
    reversal_short: Object.freeze({
      side: "short" as const,
      startTime: "09:45",
      endTime: "11:20",
      minimumRiseFromOpenPct: 3.0,
      minimumDropFromDayHighPct: 1.5,
      minimumBuyPressureRatio: 0.70,
      lookback: 10,
      slPct: 0.8,
      tpPct: 1.6,
    }),
    trend_short: Object.freeze({
      side: "short" as const,
      startTime: "10:15",
      endTime: "14:20",
      maximumOpenGainPct: -1.5,
      maximumMa8Slope2Pct: -0.02,
      minimumVolumeRatio: 1.0,
      lookback: 10,
      slPct: 0.8,
      tpPct: 1.6,
    }),
    safe_cb_short: Object.freeze({
      side: "short" as const,
      maximumDropFromOpenPct: -8.0,
      maximumReboundFromDayLowPct: 1.0,
      minimumVolumeRatio: 0.45,
      volumeLookback: 20,
      fastEntryVolumeRatio: 1.5,
      fastEntryPreviousDistancePct: 0.05,
      confirmationBars: 2,
      pullbackMaximumWait: 1,
      slPct: 0.6,
      tpPct: 1.5,
    }),
  }),
  exit: Object.freeze({
    boardEarlyExitMinimumProfitPct: 0.05,
    morningSessionExitTime: "11:27",
    marketExitTime: "15:25",
    stopLossPriority: true,
    gapFill: "adverse_current_candle_open",
  }),
});

export interface KioxiaAtrForwardCandle {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface KioxiaAtrForwardSourceEventInput {
  sourceEventId: string;
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
  board: unknown | null;
}

export interface KioxiaAtrForwardPosition {
  route: KioxiaAtrForwardRoute;
  side: "long" | "short";
  entrySourceEventId: string;
  signalTime: string;
  entryTime: string;
  theoreticalSignalPrice: number;
  entryPrice: number;
  shares: number;
  slPct: number;
  tpPct: number;
}

interface SafeCbPending {
  stage: "confirmation" | "pullback";
  level: number;
  signalPrice: number;
  confirmCount: number;
  waitCount: number;
  pulledBack: boolean;
  reason: string;
}

type RouteFlags = Record<KioxiaAtrForwardRoute, boolean>;

export interface KioxiaAtrForwardShadowState {
  tradeDate: string;
  dayOpen: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  candles: KioxiaAtrForwardCandle[];
  bprHistory: number[];
  routeEnded: RouteFlags;
  routeFired: RouteFlags;
  safeCbPending: SafeCbPending | null;
  position: KioxiaAtrForwardPosition | null;
  stopped: boolean;
  lastSourceEventId: string | null;
  lastResultType: KioxiaAtrForwardResultType | null;
  lastActions: Array<Record<string, unknown>>;
}

interface KioxiaAtrCandidate {
  route: KioxiaAtrForwardRoute;
  side: "long" | "short";
  slPct: number;
  tpPct: number;
  reason: string;
  metrics: Record<string, number | boolean | string | null>;
  preEntryRejectionReason?: string;
}

export interface KioxiaAtrClosedPosition {
  position: KioxiaAtrForwardPosition;
  exitPrice: number;
  exitReason: string;
  pnl: number;
  pnlAfterAdverseExit: number;
  realizedR: number;
}

export interface KioxiaAtrForwardTransition {
  nextState: KioxiaAtrForwardShadowState;
  resultType: KioxiaAtrForwardResultType;
  actions: Array<Record<string, unknown>>;
  openedPosition: KioxiaAtrForwardPosition | null;
  closedPosition: KioxiaAtrClosedPosition | null;
}

interface BoardView {
  currentPrice: number | null;
  buyPressureRatio: number | null;
  marketOrderRatio: number;
  signal: string | null;
  largeBuyWall: boolean;
  largeSellWall: boolean;
  marketOrderDirection: string | null;
  askCancelDetected: boolean;
  bidCancelDetected: boolean;
  icebergAskDetected: boolean;
  icebergBidDetected: boolean;
  icebergAskCount: number;
  icebergBidCount: number;
  largeTradeDirection: string | null;
}

const ROUTES: KioxiaAtrForwardRoute[] = [
  "confirmed_morning_long",
  "reversal_long",
  "reversal_short",
  "trend_short",
  "safe_cb_short",
];

function emptyFlags(): RouteFlags {
  return {
    confirmed_morning_long: false,
    reversal_long: false,
    reversal_short: false,
    trend_short: false,
    safe_cb_short: false,
  };
}

export function emptyKioxiaAtrForwardState(): KioxiaAtrForwardShadowState {
  return {
    tradeDate: "",
    dayOpen: null,
    dayHigh: null,
    dayLow: null,
    candles: [],
    bprHistory: [],
    routeEnded: emptyFlags(),
    routeFired: emptyFlags(),
    safeCbPending: null,
    position: null,
    stopped: false,
    lastSourceEventId: null,
    lastResultType: null,
    lastActions: [],
  };
}

function parseRouteFlags(value: unknown): RouteFlags {
  const raw = value && typeof value === "object" ? value as Partial<RouteFlags> : {};
  return Object.fromEntries(ROUTES.map(route => [route, raw[route] === true])) as RouteFlags;
}

export function parseKioxiaAtrForwardState(value: unknown): KioxiaAtrForwardShadowState {
  if (!value || typeof value !== "object") return emptyKioxiaAtrForwardState();
  const raw = value as Partial<KioxiaAtrForwardShadowState>;
  return {
    tradeDate: typeof raw.tradeDate === "string" ? raw.tradeDate : "",
    dayOpen: typeof raw.dayOpen === "number" ? raw.dayOpen : null,
    dayHigh: typeof raw.dayHigh === "number" ? raw.dayHigh : null,
    dayLow: typeof raw.dayLow === "number" ? raw.dayLow : null,
    // 1営業日の全1分足を保持し、日中の始値・高値・安値とHTF判定を失わない。
    candles: Array.isArray(raw.candles) ? raw.candles.slice(-420) : [],
    bprHistory: Array.isArray(raw.bprHistory)
      ? raw.bprHistory.filter(item => typeof item === "number" && Number.isFinite(item)).slice(-5)
      : [],
    routeEnded: parseRouteFlags(raw.routeEnded),
    routeFired: parseRouteFlags(raw.routeFired),
    safeCbPending: raw.safeCbPending ?? null,
    position: raw.position ?? null,
    stopped: raw.stopped === true,
    lastSourceEventId: typeof raw.lastSourceEventId === "string" ? raw.lastSourceEventId : null,
    lastResultType: raw.lastResultType ?? null,
    lastActions: Array.isArray(raw.lastActions) ? raw.lastActions : [],
  };
}

function normalizeState(value: unknown, input: KioxiaAtrForwardSourceEventInput): KioxiaAtrForwardShadowState {
  let state = parseKioxiaAtrForwardState(value);
  if (state.tradeDate !== input.candle.tradeDate) {
    state = emptyKioxiaAtrForwardState();
    state.tradeDate = input.candle.tradeDate;
  }
  return state;
}

function toFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function readBoard(value: unknown): BoardView {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const currentPrice = toFiniteNumber(raw.currentPrice);
  const asks = Array.isArray(raw.asks) ? raw.asks as Array<Record<string, unknown>> : [];
  const bids = Array.isArray(raw.bids) ? raw.bids as Array<Record<string, unknown>> : [];
  const totalAskQty = toFiniteNumber(raw.totalAskQty)
    ?? asks.reduce((sum, item) => sum + Math.max(0, toFiniteNumber(item.qty) ?? 0), 0) + Math.max(0, toFiniteNumber(raw.overSellQty) ?? 0);
  const totalBidQty = toFiniteNumber(raw.totalBidQty)
    ?? bids.reduce((sum, item) => sum + Math.max(0, toFiniteNumber(item.qty) ?? 0), 0) + Math.max(0, toFiniteNumber(raw.underBuyQty) ?? 0);
  const buyPressureRatio = toFiniteNumber(raw.buyPressureRatio)
    ?? (totalAskQty > 0 ? Math.round((totalBidQty / totalAskQty) * 100) / 100 : null);
  const marketBuyQty = Math.max(0, toFiniteNumber(raw.marketOrderBuyQty) ?? 0);
  const marketSellQty = Math.max(0, toFiniteNumber(raw.marketOrderSellQty) ?? 0);
  const marketQty = marketBuyQty + marketSellQty;
  const totalQty = totalAskQty + totalBidQty + marketQty;
  const largeBuyWall = raw.largeBuyWall === true || toFiniteNumber(raw.largeBidWallPrice) !== null;
  const largeSellWall = raw.largeSellWall === true || toFiniteNumber(raw.largeAskWallPrice) !== null;
  const derivedSignal = buyPressureRatio !== null && buyPressureRatio >= 1.5
    ? "buy_pressure"
    : buyPressureRatio !== null && buyPressureRatio <= 0.67
      ? "sell_pressure"
      : largeBuyWall
        ? "large_buy_wall"
        : largeSellWall
          ? "large_sell_wall"
          : marketQty > 0 && totalQty > 0 && marketQty / totalQty >= 0.1
            ? "market_surge"
            : "neutral";
  return {
    currentPrice: currentPrice !== null && currentPrice > 0 ? currentPrice : null,
    buyPressureRatio,
    marketOrderRatio: toFiniteNumber(raw.marketOrderRatio) ?? (totalQty > 0 ? marketQty / totalQty : 0),
    signal: typeof raw.signal === "string" ? raw.signal : derivedSignal,
    largeBuyWall,
    largeSellWall,
    marketOrderDirection: typeof raw.marketOrderDirection === "string" ? raw.marketOrderDirection : null,
    askCancelDetected: raw.askCancelDetected === true,
    bidCancelDetected: raw.bidCancelDetected === true,
    icebergAskDetected: raw.icebergAskDetected === true,
    icebergBidDetected: raw.icebergBidDetected === true,
    icebergAskCount: toFiniteNumber(raw.icebergAskCount) ?? (raw.icebergAskDetected === true ? 1 : 0),
    icebergBidCount: toFiniteNumber(raw.icebergBidCount) ?? (raw.icebergBidDetected === true ? 1 : 0),
    largeTradeDirection: typeof raw.largeTradeDirection === "string" ? raw.largeTradeDirection : null,
  };
}

function average(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function calculateMaContext(candles: readonly KioxiaAtrForwardCandle[]) {
  if (candles.length < 21) return null;
  const currentMa = average(candles.slice(-8).map(item => item.close));
  const previousMa = average(candles.slice(-9, -1).map(item => item.close));
  const ma2Ago = average(candles.slice(-10, -2).map(item => item.close));
  const maSlope2Pct = ma2Ago > 0 ? (currentMa - ma2Ago) / ma2Ago * 100 : 0;
  const priorVolumes = candles.slice(-21, -1);
  const averageVolume = average(priorVolumes.map(item => item.volume));
  const current = candles[candles.length - 1];
  return {
    currentMa,
    previousMa,
    ma2Ago,
    maSlope2Pct,
    volumeRatio: averageVolume > 0 ? current.volume / averageVolume : 0,
    openGainPct: candles[0].open > 0 ? (current.close - candles[0].open) / candles[0].open * 100 : 0,
  };
}

function calculateAtrPct(candles: readonly KioxiaAtrForwardCandle[]): number | null {
  if (candles.length < KIOXIA_ATR_FORWARD_SHADOW_SPEC.entry.atrPeriod + 1) return null;
  const atr = calcATR(
    candles.map(item => item.high),
    candles.map(item => item.low),
    candles.map(item => item.close),
    KIOXIA_ATR_FORWARD_SHADOW_SPEC.entry.atrPeriod,
  ).at(-1);
  const close = candles.at(-1)?.close ?? 0;
  return atr !== null && atr !== undefined && close > 0 ? atr / close * 100 : null;
}

export function shouldEndKioxiaAtrRouteForDay(atrPct: number | null): boolean {
  return atrPct !== null && atrPct < KIOXIA_ATR_FORWARD_SHADOW_SPEC.entry.minimumAtrPct;
}

export function applyKioxiaAtrRouteGuardForTest(
  state: KioxiaAtrForwardShadowState,
  route: KioxiaAtrForwardRoute,
  atrPct: number | null,
): { ended: boolean; actions: Array<Record<string, unknown>> } {
  if (!shouldEndKioxiaAtrRouteForDay(atrPct)) return { ended: false, actions: [] };
  state.routeEnded[route] = true;
  if (route === "safe_cb_short") state.safeCbPending = null;
  return {
    ended: true,
    actions: [{
      type: "route_ended",
      route,
      reason: "atr_below_036",
      atrPct,
      thresholdPct: KIOXIA_ATR_FORWARD_SHADOW_SPEC.entry.minimumAtrPct,
    }],
  };
}

function toSignalCandles(candles: readonly KioxiaAtrForwardCandle[], tradeDate: string): CandleWithSignal[] {
  const closes = candles.map(item => item.close);
  const ma5 = calcMA(closes, 5);
  const ma25 = calcMA(closes, 25);
  const rsi = calcRSI(closes, 14);
  const bb = calcBollinger(closes, 20);
  return candles.map((item, index) => ({
    time: `${tradeDate}T${item.time}:00`,
    dayKey: tradeDate,
    timestamp: new Date(`${tradeDate}T${item.time}:00+09:00`).getTime(),
    open: item.open,
    high: item.high,
    low: item.low,
    close: item.close,
    volume: item.volume,
    ma5: ma5[index],
    ma25: ma25[index],
    rsi: rsi[index],
    bbUpper: bb.upper[index],
    bbMiddle: bb.middle[index],
    bbLower: bb.lower[index],
  }));
}

function estimateTickDirection(board: BoardView, history: readonly number[]): "uptick" | "downtick" | "neutral" {
  if (board.marketOrderDirection === "buy") return "uptick";
  if (board.marketOrderDirection === "sell") return "downtick";
  if (history.length < 3) return "neutral";
  const trend = history[history.length - 1] - history[0];
  if (trend >= 0.2) return "uptick";
  if (trend <= -0.2) return "downtick";
  const latest = history[history.length - 1];
  if (latest >= 1.3) return "uptick";
  if (latest <= 0.7) return "downtick";
  return "neutral";
}

function boardReadingScore(side: "long" | "short", board: BoardView, history: readonly number[]): number {
  if (board.buyPressureRatio === null) return 1;
  const bpr = board.buyPressureRatio;
  let score = 0;
  if (board.marketOrderRatio >= 0.08) {
    if (side === "long" && bpr >= 0.8 && bpr <= 1.2) score += 2;
    else if (side === "long" && (bpr < 0.8 || bpr >= 1.5)) score -= 2;
    else if (side === "short" && bpr < 1.0) score += 2;
    else if (side === "short" && bpr > 1.0) score -= 2;
  }
  if (side === "long") {
    if (board.largeSellWall) score += 1;
    if (board.largeBuyWall) score -= 1;
  } else {
    if (board.largeBuyWall) score += 1;
    if (board.largeSellWall) score -= 1;
  }
  if (history.length >= 3) {
    const delta = history[history.length - 1] - history[0];
    if (side === "long" && delta >= 0.15) score += 1;
    else if (side === "long" && delta <= -0.15) score -= 1;
    else if (side === "short" && delta <= -0.15) score += 1;
    else if (side === "short" && delta >= 0.15) score -= 1;
  }
  const cancelDetected = board.askCancelDetected || board.bidCancelDetected;
  let mode: "active" | "building" | "trap" | "quiet";
  if (cancelDetected) mode = "trap";
  else if (history.length >= 3 && history.every(item => item >= 0.85 && item <= 1.15) && bpr >= 0.85 && bpr <= 1.15) mode = "quiet";
  else if (bpr > 1.2 || bpr < 0.8) mode = "active";
  else if (history.length >= 3 && Math.abs(history[history.length - 1] - history[0]) >= 0.1) mode = "building";
  else mode = "trap";
  score += mode === "active" || mode === "building" ? 1 : -2;
  if (side === "long" && (bpr >= 1.5 || bpr <= 0.65)) score -= 1;
  else if (side === "short" && bpr <= 0.65) score += 1;
  else if (side === "short" && bpr >= 1.4) score -= 1;
  if (side === "short" && board.signal === "neutral") score -= 2;
  const tickDirection = estimateTickDirection(board, history);
  if (tickDirection === "uptick") score += side === "long" ? 2 : -2;
  if (tickDirection === "downtick") score += side === "short" ? 2 : -2;
  const icebergSide = board.icebergBidDetected ? "sell" : board.icebergAskDetected ? "buy" : null;
  if (icebergSide) score += (icebergSide === "buy" && side === "long") || (icebergSide === "sell" && side === "short") ? 1 : -1;
  if (board.icebergAskCount >= 2) score += side === "short" ? 2 : -2;
  if (board.icebergBidCount >= 2) score += side === "long" ? 2 : -2;
  if (board.largeTradeDirection === "buy") score += side === "long" ? 1 : -1;
  if (board.largeTradeDirection === "sell") score += side === "short" ? 1 : -1;
  return score;
}

function safeCbBlockedByDay(state: KioxiaAtrForwardShadowState, candle: KioxiaAtrForwardSourceEventInput["candle"]): boolean {
  const dayOpen = state.dayOpen ?? candle.open;
  const dayLow = state.dayLow ?? candle.low;
  const dropFromOpenPct = dayOpen > 0 ? (candle.close - dayOpen) / dayOpen * 100 : 0;
  const reboundFromDayLowPct = dayLow > 0 ? (candle.close - dayLow) / dayLow * 100 : 0;
  return dropFromOpenPct <= KIOXIA_ATR_FORWARD_SHADOW_SPEC.routes.safe_cb_short.maximumDropFromOpenPct
    || reboundFromDayLowPct >= KIOXIA_ATR_FORWARD_SHADOW_SPEC.routes.safe_cb_short.maximumReboundFromDayLowPct;
}

function safeCbVolumeMetrics(candles: readonly KioxiaAtrForwardCandle[]) {
  const current = candles.at(-1);
  const prior = candles.slice(-21, -1);
  const averageVolume = prior.length > 0 ? average(prior.map(item => item.volume)) : 0;
  return {
    volumeRatio: current && averageVolume > 0 ? current.volume / averageVolume : 0,
    averageVolume,
    zeroVolumeBars: prior.filter(item => item.volume <= 0).length,
    enoughHistory: prior.length >= 20,
  };
}

function safeCbInitialSignalAllowed(
  state: KioxiaAtrForwardShadowState,
  candle: KioxiaAtrForwardSourceEventInput["candle"],
  board: BoardView,
): boolean {
  if (board.signal === "buy_pressure") return false;
  const ma = calculateMaContext(state.candles);
  if (!ma || ma.currentMa > ma.previousMa) return false;
  const recentHigh = Math.max(...state.candles.slice(-20).map(item => item.high));
  if (recentHigh > 0 && (recentHigh - candle.close) / recentHigh * 100 > 2.0) return false;
  if (board.signal === "neutral" && boardReadingScore("short", board, state.bprHistory) < 1) return false;
  return getHigherTfTrend(state.candles, state.candles.length - 1, 3) !== "up";
}

function safeCbPendingEntryAllowed(
  state: KioxiaAtrForwardShadowState,
  board: BoardView,
): boolean {
  if (getHigherTfTrend(state.candles, state.candles.length - 1, 3) === "up") return false;
  if (board.signal === "buy_pressure") return false;
  return boardReadingScore("short", board, state.bprHistory) >= 1;
}

function confirmedMorningCandidate(state: KioxiaAtrForwardShadowState): KioxiaAtrCandidate | null {
  const route = "confirmed_morning_long" as const;
  if (state.routeEnded[route] || state.routeFired[route]) return null;
  const current = state.candles.at(-1);
  if (!current || !isKioxiaConfirmedMorningLongEntryTime(current.time)) return null;
  const metrics = calculateKioxiaConfirmedMorningLongMetrics(state.candles);
  if (!metrics?.eligible) return null;
  return {
    route,
    side: "long",
    slPct: KIOXIA_ATR_FORWARD_SHADOW_SPEC.routes[route].slPct,
    tpPct: KIOXIA_ATR_FORWARD_SHADOW_SPEC.routes[route].tpPct,
    reason: "キオクシア確認型前場LONG",
    metrics: {
      bodyPct: metrics.bodyPct,
      maSlope2Pct: metrics.maSlope2Pct,
      volumeRatio: metrics.volumeRatio,
      openGainPct: metrics.openGainPct,
    },
  };
}

function reversalLongCandidate(state: KioxiaAtrForwardShadowState, board: BoardView): KioxiaAtrCandidate | null {
  const route = "reversal_long" as const;
  const spec = KIOXIA_ATR_FORWARD_SHADOW_SPEC.routes[route];
  const current = state.candles.at(-1);
  if (!current || state.routeEnded[route] || state.routeFired[route] || current.time < spec.startTime || current.time > spec.endTime) return null;
  if (state.candles.length < 10) return null;
  const dayHigh = state.dayHigh ?? current.high;
  const dropFromHighPct = dayHigh > 0 ? (dayHigh - current.close) / dayHigh * 100 : 0;
  const ma = calculateMaContext(state.candles);
  const recentHigh = Math.max(...state.candles.slice(-1 - spec.lookback, -1).map(item => item.high));
  if (!ma || dropFromHighPct < spec.minimumDropFromDayHighPct || ma.currentMa <= ma.previousMa
    || ma.maSlope2Pct < spec.minimumMa8Slope2Pct || current.high <= recentHigh) return null;
  return {
    route,
    side: "long",
    slPct: spec.slPct,
    tpPct: spec.tpPct,
    reason: "反転LONG",
    metrics: { dropFromHighPct, maSlope2Pct: ma.maSlope2Pct, recentHigh },
    preEntryRejectionReason: board.signal === "sell_pressure" ? "sell_pressure" : undefined,
  };
}

function reversalShortCandidate(
  state: KioxiaAtrForwardShadowState,
  board: BoardView,
  safeCbReady: boolean,
): { candidate: KioxiaAtrCandidate | null; bprGuardEnded: boolean } {
  const route = "reversal_short" as const;
  const spec = KIOXIA_ATR_FORWARD_SHADOW_SPEC.routes[route];
  const current = state.candles.at(-1);
  if (!current || state.routeEnded[route] || state.routeFired[route] || safeCbReady
    || current.time < spec.startTime || current.time > spec.endTime || state.candles.length < 10) {
    return { candidate: null, bprGuardEnded: false };
  }
  const dayOpen = state.dayOpen ?? current.open;
  const dayHigh = state.dayHigh ?? current.high;
  const riseFromOpenPct = dayOpen > 0 ? (dayHigh - dayOpen) / dayOpen * 100 : 0;
  const dropFromHighPct = dayHigh > 0 ? (dayHigh - current.close) / dayHigh * 100 : 0;
  const ma = calculateMaContext(state.candles);
  const recentLow = Math.min(...state.candles.slice(-1 - spec.lookback, -1).map(item => item.low));
  if (!ma || riseFromOpenPct < spec.minimumRiseFromOpenPct || dropFromHighPct < spec.minimumDropFromDayHighPct
    || ma.currentMa >= ma.previousMa || current.low >= recentLow) return { candidate: null, bprGuardEnded: false };
  if (board.buyPressureRatio !== null && board.buyPressureRatio < spec.minimumBuyPressureRatio) {
    return { candidate: null, bprGuardEnded: true };
  }
  return {
    bprGuardEnded: false,
    candidate: {
      route,
      side: "short",
      slPct: spec.slPct,
      tpPct: spec.tpPct,
      reason: "反転SHORT",
      metrics: { riseFromOpenPct, dropFromHighPct, recentLow, buyPressureRatio: board.buyPressureRatio },
    },
  };
}

function trendShortCandidate(
  state: KioxiaAtrForwardShadowState,
  board: BoardView,
  safeCbReady: boolean,
): KioxiaAtrCandidate | null {
  const route = "trend_short" as const;
  const spec = KIOXIA_ATR_FORWARD_SHADOW_SPEC.routes[route];
  const current = state.candles.at(-1);
  const ma = calculateMaContext(state.candles);
  if (!current || !ma || state.routeEnded[route] || state.routeFired[route] || safeCbReady
    || current.time < spec.startTime || current.time > spec.endTime) return null;
  const recentLow = Math.min(...state.candles.slice(-1 - spec.lookback, -1).map(item => item.low));
  const eligible = ma.openGainPct <= spec.maximumOpenGainPct
    && ma.currentMa <= ma.previousMa
    && ma.maSlope2Pct <= spec.maximumMa8Slope2Pct
    && current.low < recentLow
    && current.close < current.open
    && ma.volumeRatio >= spec.minimumVolumeRatio;
  if (!eligible || board.signal === "buy_pressure") return null;
  if (getHigherTfTrend(state.candles, state.candles.length - 1, 3) === "up") return null;
  if (board.signal === "neutral" && boardReadingScore("short", board, state.bprHistory) < 1) return null;
  return {
    route,
    side: "short",
    slPct: spec.slPct,
    tpPct: spec.tpPct,
    reason: "順張りSHORT",
    metrics: { openGainPct: ma.openGainPct, maSlope2Pct: ma.maSlope2Pct, volumeRatio: ma.volumeRatio, recentLow },
  };
}

function safeCbCandidate(
  state: KioxiaAtrForwardShadowState,
  input: KioxiaAtrForwardSourceEventInput,
  board: BoardView,
  safeCbReady: boolean,
  signalReason: string | null,
  actions: Array<Record<string, unknown>>,
): KioxiaAtrCandidate | null {
  const route = "safe_cb_short" as const;
  const spec = KIOXIA_ATR_FORWARD_SHADOW_SPEC.routes[route];
  if (state.routeEnded[route] || state.routeFired[route]) return null;
  const current = input.candle;
  const entryCandidate = (reason: string, fromPending: boolean): KioxiaAtrCandidate | null => {
    if (fromPending && !safeCbPendingEntryAllowed(state, board)) return null;
    const volume = safeCbVolumeMetrics(state.candles);
    if (volume.enoughHistory && volume.volumeRatio < spec.minimumVolumeRatio) {
      state.routeEnded[route] = true;
      state.safeCbPending = null;
      actions.push({
        type: "route_ended",
        route,
        reason: "current_volume_guard",
        volumeRatio: volume.volumeRatio,
        thresholdRatio: spec.minimumVolumeRatio,
        averageVolume: volume.averageVolume,
        zeroVolumeBars: volume.zeroVolumeBars,
      });
      return null;
    }
    return {
      route,
      side: "short",
      slPct: spec.slPct,
      tpPct: spec.tpPct,
      reason,
      metrics: {
        volumeRatio: volume.volumeRatio,
        averageVolume: volume.averageVolume,
        zeroVolumeBars: volume.zeroVolumeBars,
      },
    };
  };

  // 現行exclusiveEntryRoutes境界により、適格な大台割れがある足だけ確認カウントを進める。
  if (state.safeCbPending && !safeCbReady) return null;
  if (state.safeCbPending?.stage === "confirmation") {
    if (current.close > state.safeCbPending.level) {
      state.safeCbPending = null;
      return null;
    }
    state.safeCbPending.confirmCount += 1;
    if (state.safeCbPending.confirmCount >= spec.confirmationBars) {
      state.safeCbPending = {
        ...state.safeCbPending,
        stage: "pullback",
        signalPrice: current.close,
        waitCount: 0,
        pulledBack: false,
      };
    }
    return null;
  }

  if (state.safeCbPending?.stage === "pullback") {
    const pending = state.safeCbPending;
    pending.waitCount += 1;
    if (current.close > pending.level) {
      state.safeCbPending = null;
      return null;
    }
    if (pending.waitCount > spec.pullbackMaximumWait) {
      state.safeCbPending = null;
      return entryCandidate("大台確認SHORT（押し目なし・強トレンド）", true);
    }
    if (!pending.pulledBack && current.close > pending.signalPrice) pending.pulledBack = true;
    if (pending.pulledBack && current.close < pending.signalPrice) {
      state.safeCbPending = null;
      return entryCandidate("大台確認SHORT（押し目確認後）", true);
    }
    return null;
  }

  if (!safeCbReady) return null;
  if (!signalReason) return null;
  if (!safeCbInitialSignalAllowed(state, current, board)) return null;
  const levelMatch = signalReason.match(/(\d+(?:\.\d+)?)円/);
  const level = levelMatch ? Number(levelMatch[1]) : current.close;
  const currentVolumeWindow = state.candles.slice(-spec.volumeLookback);
  const currentVolumeAverage = currentVolumeWindow.length > 0 ? average(currentVolumeWindow.map(item => item.volume)) : 0;
  const currentVolumeRatio = currentVolumeAverage > 0 ? current.volume / currentVolumeAverage : 0;
  if (currentVolumeRatio >= spec.fastEntryVolumeRatio) return entryCandidate("大台割れSHORT（即エントリー: vol）", false);
  const previousClose = state.candles.at(-2)?.close;
  if (previousClose !== undefined && previousClose >= level
    && (previousClose - level) / level * 100 <= spec.fastEntryPreviousDistancePct) {
    return entryCandidate("大台割れSHORT（即エントリー: 前足近接）", false);
  }
  state.safeCbPending = {
    stage: "confirmation",
    level,
    signalPrice: current.close,
    confirmCount: 0,
    waitCount: 0,
    pulledBack: false,
    reason: signalReason,
  };
  return null;
}

function sharesForMode(mode: KioxiaAtrForwardEvaluationMode, price: number): number {
  if (mode === "signal_quality") return 100;
  const rawShares = Math.floor((3_000_000 * 0.9) / price);
  return Math.max(100, Math.floor(rawShares / 100) * 100);
}

function pnlFor(position: KioxiaAtrForwardPosition, exitPrice: number): number {
  const perShare = position.side === "long" ? exitPrice - position.entryPrice : position.entryPrice - exitPrice;
  return Math.round(perShare * position.shares);
}

function riskYen(position: KioxiaAtrForwardPosition): number {
  return position.entryPrice * position.shares * position.slPct / 100;
}

function adverseExitPrice(position: KioxiaAtrForwardPosition, exitPrice: number): number {
  return position.side === "long" ? exitPrice * 0.999 : exitPrice * 1.001;
}

function shouldBoardEarlyExit(position: KioxiaAtrForwardPosition, candle: KioxiaAtrForwardSourceEventInput["candle"], board: BoardView): boolean {
  const pnlPct = position.side === "long"
    ? (candle.close - position.entryPrice) / position.entryPrice * 100
    : (position.entryPrice - candle.close) / position.entryPrice * 100;
  if (pnlPct < KIOXIA_ATR_FORWARD_SHADOW_SPEC.exit.boardEarlyExitMinimumProfitPct) return false;
  return position.side === "long"
    ? board.signal === "sell_pressure" || board.signal === "large_sell_wall"
    : board.signal === "buy_pressure" || board.signal === "large_buy_wall";
}

export function calculateKioxiaAtrForwardExitForTest(
  position: KioxiaAtrForwardPosition,
  candle: KioxiaAtrForwardSourceEventInput["candle"],
  boardValue: unknown,
): { price: number; reason: "stop_loss" | "take_profit" | "board_early_exit" | "session_exit" } | null {
  const board = readBoard(boardValue);
  const stopLine = position.side === "long"
    ? position.entryPrice * (1 - position.slPct / 100)
    : position.entryPrice * (1 + position.slPct / 100);
  const takeProfitLine = position.side === "long"
    ? position.entryPrice * (1 + position.tpPct / 100)
    : position.entryPrice * (1 - position.tpPct / 100);
  if (position.side === "long" && candle.low <= stopLine) return { price: Math.min(candle.open, stopLine), reason: "stop_loss" };
  if (position.side === "short" && candle.high >= stopLine) return { price: Math.max(candle.open, stopLine), reason: "stop_loss" };
  if (position.side === "long" && candle.high >= takeProfitLine) return { price: takeProfitLine, reason: "take_profit" };
  if (position.side === "short" && candle.low <= takeProfitLine) return { price: takeProfitLine, reason: "take_profit" };
  if (shouldBoardEarlyExit(position, candle, board)) return { price: candle.close, reason: "board_early_exit" };
  if (position.entryTime < "11:30" && candle.candleTime >= KIOXIA_ATR_FORWARD_SHADOW_SPEC.exit.morningSessionExitTime) {
    return { price: candle.close, reason: "session_exit" };
  }
  if (candle.candleTime >= KIOXIA_ATR_FORWARD_SHADOW_SPEC.exit.marketExitTime) return { price: candle.close, reason: "session_exit" };
  return null;
}

function finalize(
  state: KioxiaAtrForwardShadowState,
  input: KioxiaAtrForwardSourceEventInput,
  resultType: KioxiaAtrForwardResultType,
  actions: Array<Record<string, unknown>>,
  openedPosition: KioxiaAtrForwardPosition | null,
  closedPosition: KioxiaAtrClosedPosition | null,
): KioxiaAtrForwardTransition {
  state.lastSourceEventId = input.sourceEventId;
  state.lastResultType = resultType;
  state.lastActions = actions;
  return { nextState: state, resultType, actions, openedPosition, closedPosition };
}

/** 実時・Vitest・16時再生が共有する285A第2候補の副作用なし状態遷移。 */
export function applyKioxiaAtrForwardTransition(
  stateBefore: KioxiaAtrForwardShadowState,
  input: KioxiaAtrForwardSourceEventInput,
  mode: KioxiaAtrForwardEvaluationMode,
): KioxiaAtrForwardTransition {
  const state = normalizeState(stateBefore, input);
  const actions: Array<Record<string, unknown>> = [];
  let openedPosition: KioxiaAtrForwardPosition | null = null;
  let closedPosition: KioxiaAtrClosedPosition | null = null;
  const board = readBoard(input.board);

  state.dayOpen ??= input.candle.open;
  state.dayHigh = state.dayHigh === null ? input.candle.high : Math.max(state.dayHigh, input.candle.high);
  state.dayLow = state.dayLow === null ? input.candle.low : Math.min(state.dayLow, input.candle.low);
  state.candles.push({
    time: input.candle.candleTime,
    open: input.candle.open,
    high: input.candle.high,
    low: input.candle.low,
    close: input.candle.close,
    volume: input.candle.volume,
  });
  state.candles = state.candles.slice(-420);
  if (board.buyPressureRatio !== null) state.bprHistory = [...state.bprHistory, board.buyPressureRatio].slice(-5);

  if (state.stopped || input.candle.tradeDate < KIOXIA_ATR_FORWARD_SHADOW_SPEC.evaluationStartDate) {
    return finalize(state, input, "rejected", [{
      type: "not_collecting",
      stopped: state.stopped,
      evaluationStartDate: KIOXIA_ATR_FORWARD_SHADOW_SPEC.evaluationStartDate,
    }], null, null);
  }

  if (state.position) {
    const exit = calculateKioxiaAtrForwardExitForTest(state.position, input.candle, input.board);
    if (!exit) return finalize(state, input, "hold", actions, null, null);
    const position = { ...state.position };
    const pnl = pnlFor(position, exit.price);
    const pnlAfterAdverseExit = pnlFor(position, adverseExitPrice(position, exit.price));
    const realizedR = riskYen(position) > 0 ? pnl / riskYen(position) : 0;
    closedPosition = { position, exitPrice: exit.price, exitReason: exit.reason, pnl, pnlAfterAdverseExit, realizedR };
    state.position = null;
    actions.push({ type: "exit", route: position.route, reason: exit.reason, exitPrice: exit.price, pnl, pnlAfterAdverseExit, realizedR });
    return finalize(state, input, "exit", actions, null, closedPosition);
  }

  if (state.candles.length < 30 || input.candle.candleTime < "09:30" || input.candle.candleTime >= "15:05"
    || (input.candle.candleTime >= "11:30" && input.candle.candleTime < "12:30")
    || (input.candle.candleTime >= "12:30" && input.candle.candleTime < "12:50")) {
    return finalize(state, input, "no_signal", actions, null, null);
  }

  const signalCandles = toSignalCandles(state.candles, input.candle.tradeDate);
  const latestSignal = detectSignals(signalCandles).at(-1)?.signal;
  const isRoundBreakdown = latestSignal?.type === "sell" && latestSignal.reason.startsWith("大台割れ");
  const safeCbBlockedNow = isRoundBreakdown && safeCbBlockedByDay(state, input.candle);
  const safeCbReady = Boolean(isRoundBreakdown && !safeCbBlockedNow && !state.routeEnded.safe_cb_short);
  const roundBreakdownHasPriority = isRoundBreakdown && !safeCbBlockedNow;

  let candidate = confirmedMorningCandidate(state);
  if (!candidate) candidate = reversalLongCandidate(state, board);
  if (!candidate) {
    const reversal = reversalShortCandidate(state, board, roundBreakdownHasPriority);
    if (reversal.bprGuardEnded) {
      state.routeEnded.reversal_short = true;
      actions.push({
        type: "route_ended",
        route: "reversal_short",
        reason: "current_bpr_guard",
        buyPressureRatio: board.buyPressureRatio,
      });
      return finalize(state, input, "rejected", actions, null, null);
    }
    candidate = reversal.candidate;
  }
  if (!candidate) candidate = trendShortCandidate(state, board, roundBreakdownHasPriority);
  if (!candidate) {
    candidate = safeCbCandidate(
      state,
      input,
      board,
      safeCbReady,
      isRoundBreakdown ? latestSignal?.reason ?? null : null,
      actions,
    );
  }

  if (!candidate) {
    if (actions.some(action => action.type === "route_ended")) return finalize(state, input, "rejected", actions, null, null);
    return finalize(state, input, state.safeCbPending ? "pending" : "no_signal", actions, null, null);
  }

  if (candidate.preEntryRejectionReason) {
    actions.push({
      type: "entry_rejected",
      route: candidate.route,
      reason: candidate.preEntryRejectionReason,
      metrics: candidate.metrics,
    });
    return finalize(state, input, "rejected", actions, null, null);
  }

  const atrPct = calculateAtrPct(state.candles);
  const guard = applyKioxiaAtrRouteGuardForTest(state, candidate.route, atrPct);
  if (guard.ended) {
    actions.push({
      ...guard.actions[0],
      theoreticalSignalPrice: input.candle.close,
      metrics: candidate.metrics,
    });
    return finalize(state, input, "rejected", actions, null, null);
  }

  if (candidate.side === "short" && input.candle.candleTime >= "13:00"
    && board.buyPressureRatio !== null && board.buyPressureRatio >= 0.65) {
    actions.push({ type: "entry_rejected", route: candidate.route, reason: "pm_bpr_block", buyPressureRatio: board.buyPressureRatio });
    return finalize(state, input, "rejected", actions, null, null);
  }
  const openGainPct = state.dayOpen && state.dayOpen > 0 ? (input.candle.close - state.dayOpen) / state.dayOpen * 100 : 0;
  if (candidate.side === "short" && input.candle.candleTime >= "13:00" && openGainPct <= -5) {
    actions.push({ type: "entry_rejected", route: candidate.route, reason: "pm_lowzone_block", openGainPct });
    return finalize(state, input, "rejected", actions, null, null);
  }
  if (candidate.side === "long" && input.candle.candleTime >= "13:00" && openGainPct >= 4) {
    actions.push({ type: "entry_rejected", route: candidate.route, reason: "pm_highzone_block", openGainPct });
    return finalize(state, input, "rejected", actions, null, null);
  }
  if (board.currentPrice === null) {
    actions.push({ type: "entry_rejected", route: candidate.route, reason: "executable_price_unavailable", atrPct });
    return finalize(state, input, "rejected", actions, null, null);
  }

  const shares = sharesForMode(mode, board.currentPrice);
  state.position = {
    route: candidate.route,
    side: candidate.side,
    entrySourceEventId: input.sourceEventId,
    signalTime: input.candle.candleTime,
    entryTime: input.candle.candleTime,
    theoreticalSignalPrice: input.candle.close,
    entryPrice: board.currentPrice,
    shares,
    slPct: candidate.slPct,
    tpPct: candidate.tpPct,
  };
  state.routeFired[candidate.route] = true;
  if (candidate.route === "safe_cb_short") state.safeCbPending = null;
  openedPosition = { ...state.position };
  actions.push({
    type: "entry",
    route: candidate.route,
    side: candidate.side,
    theoreticalSignalPrice: input.candle.close,
    executableEntryPrice: board.currentPrice,
    executionPriceSource: KIOXIA_ATR_FORWARD_SHADOW_SPEC.entry.executablePriceSource,
    atrPct,
    shares,
    metrics: candidate.metrics,
  });
  return finalize(state, input, "entry", actions, openedPosition, null);
}
