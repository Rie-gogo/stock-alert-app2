import type { BoardSnapshot } from "../drizzle/schema";
import type { RtCandle1Min } from "./realtimeSimEngine";
import type { KabuOrderBook } from "./kabuStation";
import { analyzeOrderBook } from "./kabuStation";
import { calcATR } from "./intradayRegime";
import { detectSignals, type CandleWithSignal } from "./routers/stockData";
import { getHigherTfTrend } from "./vwap";
import {
  TEL_OPEN_DIRECTION_BREAKOUT_REASON_PREFIX,
  TEL_OPEN_DIRECTION_BREAKOUT_SPEC,
  calculateTelOpenDirectionBreakoutMetrics,
} from "./telOpenDirectionBreakout";
import {
  TEL_CAUSALITY_AUDIT_VERSION,
  TEL_CURRENT_PARITY_VERSION,
  TEL_EXECUTABLE_CONFIRM_VERSION,
} from "./runtimeIdentity";
export {
  TEL_CAUSALITY_AUDIT_VERSION,
  TEL_CURRENT_PARITY_VERSION,
  TEL_EXECUTABLE_CONFIRM_VERSION,
} from "./runtimeIdentity";
export const TEL_AUDIT_LEARNING_CUTOFF_DATE = "2026-09-04";
export const TEL_AUDIT_EVALUATION_START_DATE = "2026-09-07";

const MAX_TOTAL_EXPOSURE = 8_910_000;
const INITIAL_CAPITAL_PER_STOCK = 3_000_000;
const LOT_RATIO = 0.9;
const ATR_PERIOD = 7;
const ATR_THRESHOLD = 0.0012;
const BOARD_SCORE_THRESHOLD = 1;
const AM_SESSION_CLOSE_TIME = "11:27";
const MARKET_CLOSE_TIME = "15:25";

export type TelParityRoute =
  | "open_direction_breakout_long"
  | "open_direction_breakout_short"
  | "fallback_trend_long"
  | "fallback_trend_short";
export type TelParityResultType = "no_signal" | "rejected" | "entry" | "hold" | "exit";

export interface TelParityPosition {
  route: TelParityRoute;
  side: "long" | "short";
  entryPrice: number;
  entryTime: string;
  entrySourceEventId: string;
  shares: number;
  slPct: number;
  tpPct: number;
  entryReason: string;
}

interface StoredBoardState {
  previousAsks: Array<{ price: number; qty: number }>;
  previousBids: Array<{ price: number; qty: number }>;
  bprHistory: number[];
  micro: Array<{
    bpr: number;
    askCancel: boolean;
    bidCancel: boolean;
    iceAsk: boolean;
    iceBid: boolean;
    direction: "buy" | "sell" | "neutral";
  }>;
}

export interface TelCurrentParityState {
  version: 1;
  tradeDate: string | null;
  candles: RtCandle1Min[];
  position: TelParityPosition | null;
  fired: {
    primary: boolean;
    fallbackTrendLong: boolean;
    fallbackTrendShort: boolean;
  };
  lastStopLossTime: string | null;
  board: StoredBoardState;
  lastSourceEventId: string | null;
  lastResultType: TelParityResultType | null;
  lastDecision: Record<string, unknown> | null;
}

export interface TelParityInput {
  sourceEventId: string;
  candle: RtCandle1Min;
  board: unknown;
  marginUsedBefore: number;
  evaluationMode: "signal_quality" | "capital_constrained";
}

export interface TelParityTransition {
  nextState: TelCurrentParityState;
  resultType: TelParityResultType;
  decision: Record<string, unknown>;
  openedPosition: TelParityPosition | null;
  closedPosition: (TelParityPosition & { exitPrice: number; exitReason: string; pnl: number }) | null;
}

export function createEmptyTelCurrentParityState(): TelCurrentParityState {
  return {
    version: 1,
    tradeDate: null,
    candles: [],
    position: null,
    fired: { primary: false, fallbackTrendLong: false, fallbackTrendShort: false },
    lastStopLossTime: null,
    board: { previousAsks: [], previousBids: [], bprHistory: [], micro: [] },
    lastSourceEventId: null,
    lastResultType: null,
    lastDecision: null,
  };
}

function resetForDate(state: TelCurrentParityState, tradeDate: string) {
  if (state.tradeDate === tradeDate) return;
  state.tradeDate = tradeDate;
  state.candles = [];
  state.position = null;
  state.fired = { primary: false, fallbackTrendLong: false, fallbackTrendShort: false };
  state.lastStopLossTime = null;
  state.board = { previousAsks: [], previousBids: [], bprHistory: [], micro: [] };
}

function timeToMinutes(value: string): number {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function average(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function toSignalCandles(candles: readonly RtCandle1Min[]): CandleWithSignal[] {
  return candles.map(candle => ({
    time: `${candle.tradeDate}T${candle.candleTime}:00+09:00`,
    dayKey: candle.tradeDate,
    timestamp: Date.parse(`${candle.tradeDate}T${candle.candleTime}:00+09:00`),
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
    ma5: null,
    ma25: null,
    rsi: null,
    bbUpper: null,
    bbMiddle: null,
    bbLower: null,
  }));
}

function calcShares(price: number): number {
  const raw = Math.floor((INITIAL_CAPITAL_PER_STOCK * LOT_RATIO) / price);
  return Math.max(100, Math.floor(raw / 100) * 100);
}

function toBook(value: unknown): KabuOrderBook | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<KabuOrderBook>;
  if (!Array.isArray(raw.asks) || !Array.isArray(raw.bids)) return null;
  return {
    symbol: String(raw.symbol ?? "8035"),
    symbolName: String(raw.symbolName ?? "東京エレクトロン"),
    currentPrice: Number(raw.currentPrice ?? 0),
    currentPriceTime: String(raw.currentPriceTime ?? ""),
    asks: raw.asks.map(level => ({ price: Number(level.price), qty: Number(level.qty) })),
    bids: raw.bids.map(level => ({ price: Number(level.price), qty: Number(level.qty) })),
    marketOrderSellQty: Number(raw.marketOrderSellQty ?? 0),
    marketOrderBuyQty: Number(raw.marketOrderBuyQty ?? 0),
    overSellQty: Number(raw.overSellQty ?? 0),
    underBuyQty: Number(raw.underBuyQty ?? 0),
    vwap: Number(raw.vwap ?? 0),
    receivedAt: Number(raw.receivedAt ?? 0),
  };
}

function mapLevels(levels: Array<{ price: number; qty: number }>): Map<number, number> {
  return new Map(levels.map(level => [level.price, level.qty]));
}

function buildBoardSnapshot(state: TelCurrentParityState, value: unknown): BoardSnapshot | null {
  if (value && typeof value === "object") {
    const snapshot = value as Partial<BoardSnapshot>;
    if (typeof snapshot.buyPressureRatio === "number" && typeof snapshot.signal === "string") {
      state.board.bprHistory.push(snapshot.buyPressureRatio);
      if (state.board.bprHistory.length > 5) state.board.bprHistory.shift();
      state.board.micro.push({
        bpr: snapshot.buyPressureRatio,
        askCancel: Boolean(snapshot.askCancelDetected),
        bidCancel: Boolean(snapshot.bidCancelDetected),
        iceAsk: Boolean(snapshot.icebergAskDetected),
        iceBid: Boolean(snapshot.icebergBidDetected),
        direction: snapshot.marketOrderDirection === "buy" || snapshot.marketOrderDirection === "sell"
          ? snapshot.marketOrderDirection
          : "neutral",
      });
      if (state.board.micro.length > 6) state.board.micro.shift();
      return snapshot as BoardSnapshot;
    }
  }
  const book = toBook(value);
  if (!book) return null;
  const signals = analyzeOrderBook(book);
  const totalBid = book.bids.reduce((sum, level) => sum + level.qty, 0) + book.underBuyQty;
  const totalAsk = book.asks.reduce((sum, level) => sum + level.qty, 0) + book.overSellQty;
  const totalMarket = book.marketOrderBuyQty + book.marketOrderSellQty;
  const totalAll = totalBid + totalAsk + totalMarket;
  const bpr = Math.round((totalAsk > 0 ? totalBid / totalAsk : 1) * 100) / 100;
  const currentAsk = mapLevels(book.asks);
  const currentBid = mapLevels(book.bids);
  const previousAsk = mapLevels(state.board.previousAsks);
  const previousBid = mapLevels(state.board.previousBids);
  const avgAsk = book.asks.length ? totalAsk / book.asks.length : 0;
  const avgBid = book.bids.length ? totalBid / book.bids.length : 0;
  let askCancel = false;
  let bidCancel = false;
  let iceAsk = false;
  let iceBid = false;
  for (const [price, previousQty] of Array.from(previousAsk.entries())) {
    const ratio = previousQty > 0 ? (previousQty - (currentAsk.get(price) ?? 0)) / previousQty : 0;
    if (ratio >= 0.7 && previousQty >= avgAsk * 5) askCancel = true;
    else if (ratio >= 0.5 && ratio < 0.7) iceAsk = true;
  }
  for (const [price, previousQty] of Array.from(previousBid.entries())) {
    const ratio = previousQty > 0 ? (previousQty - (currentBid.get(price) ?? 0)) / previousQty : 0;
    if (ratio >= 0.7 && previousQty >= avgBid * 5) bidCancel = true;
    else if (ratio >= 0.5 && ratio < 0.7) iceBid = true;
  }
  const direction: "buy" | "sell" | "neutral" = book.marketOrderBuyQty > book.marketOrderSellQty * 1.5
    ? "buy"
    : book.marketOrderSellQty > book.marketOrderBuyQty * 1.5
      ? "sell"
      : "neutral";
  state.board.previousAsks = book.asks;
  state.board.previousBids = book.bids;
  state.board.bprHistory.push(bpr);
  if (state.board.bprHistory.length > 5) state.board.bprHistory.shift();
  state.board.micro.push({ bpr, askCancel, bidCancel, iceAsk, iceBid, direction });
  if (state.board.micro.length > 6) state.board.micro.shift();
  const micro = state.board.micro;
  const largeBuyWall = signals.some(signal => signal.type === "large_bid_wall");
  const largeSellWall = signals.some(signal => signal.type === "large_ask_wall");
  let signal: BoardSnapshot["signal"] = "neutral";
  if (signals.some(item => item.type === "board_buy_pressure")) signal = "buy_pressure";
  else if (signals.some(item => item.type === "board_sell_pressure")) signal = "sell_pressure";
  else if (largeBuyWall) signal = "large_buy_wall";
  else if (largeSellWall) signal = "large_sell_wall";
  else if (signals.some(item => item.type === "market_order_surge")) signal = "market_surge";
  const largeTradeDirection: "buy" | "sell" | "neutral" = micro.filter(item => item.direction === "buy").length >= 2
    && micro.filter(item => item.direction === "buy").length > micro.filter(item => item.direction === "sell").length
    ? "buy"
    : micro.filter(item => item.direction === "sell").length >= 2
      && micro.filter(item => item.direction === "sell").length > micro.filter(item => item.direction === "buy").length
      ? "sell"
      : "neutral";
  return {
    buyPressureRatio: bpr,
    largeBuyWall,
    largeSellWall,
    marketOrderRatio: totalAll > 0 ? Math.round((totalMarket / totalAll) * 1000) / 1000 : 0,
    signal,
    marketOrderDirection: direction,
    askCancelDetected: askCancel,
    bidCancelDetected: bidCancel,
    icebergAskDetected: iceAsk,
    icebergBidDetected: iceBid,
    icebergAskCount: micro.filter(item => item.iceAsk).length,
    icebergBidCount: micro.filter(item => item.iceBid).length,
    cancelAskCount: micro.filter(item => item.askCancel).length,
    cancelBidCount: micro.filter(item => item.bidCancel).length,
    avgBprIn10s: average(micro.map(item => item.bpr)),
    bprDeltaIn10s: micro.length > 1 ? micro[micro.length - 1].bpr - micro[0].bpr : 0,
    largeTradeDirection,
    boardSampleCount: micro.length,
  } as BoardSnapshot;
}

function boardScore(state: TelCurrentParityState, side: "long" | "short", snapshot: BoardSnapshot | null): number {
  if (!snapshot) return 1;
  let score = 0;
  const bpr = snapshot.buyPressureRatio;
  if (snapshot.marketOrderRatio >= 0.08) {
    if (side === "long" && bpr >= 0.8 && bpr <= 1.2) score += 2;
    else if (side === "long" && (bpr < 0.8 || bpr >= 1.5)) score -= 2;
    else if (side === "short" && bpr < 1) score += 2;
    else if (side === "short" && bpr > 1) score -= 2;
  }
  if (side === "long") {
    if (snapshot.largeSellWall) score += 1;
    if (snapshot.largeBuyWall) score -= 1;
  } else {
    if (snapshot.largeBuyWall) score += 1;
    if (snapshot.largeSellWall) score -= 1;
  }
  const history = state.board.bprHistory;
  if (history.length >= 3) {
    const delta = history[history.length - 1] - history[0];
    if (side === "long" && delta >= 0.15) score += 1;
    else if (side === "long" && delta <= -0.15) score -= 1;
    else if (side === "short" && delta <= -0.15) score += 1;
    else if (side === "short" && delta >= 0.15) score -= 1;
  }
  const snap = snapshot as BoardSnapshot & Record<string, unknown>;
  const cancel = Boolean(snap.askCancelDetected || snap.bidCancelDetected);
  const allNeutral = history.length >= 3 && history.every(value => value >= 0.85 && value <= 1.15);
  const mode = cancel
    ? "trap"
    : bpr > 1.2 || bpr < 0.8
      ? "active"
      : allNeutral && bpr >= 0.85 && bpr <= 1.15
        ? "quiet"
        : history.length >= 3 && Math.abs(history[history.length - 1] - history[0]) >= 0.1
          ? "building"
          : "trap";
  score += mode === "active" || mode === "building" ? 1 : -2;
  if (side === "long" && (bpr >= 1.5 || bpr <= 0.65)) score -= 1;
  else if (side === "short" && bpr <= 0.65) score += 1;
  else if (side === "short" && bpr >= 1.4) score -= 1;
  if (side === "short" && snapshot.signal === "neutral") score -= 2;
  const direction = snap.marketOrderDirection === "buy" || snap.marketOrderDirection === "sell"
    ? snap.marketOrderDirection
    : history.length >= 3 && history[history.length - 1] - history[0] >= 0.2
      ? "buy"
      : history.length >= 3 && history[history.length - 1] - history[0] <= -0.2
        ? "sell"
        : bpr >= 1.3
          ? "buy"
          : bpr <= 0.7
            ? "sell"
            : "neutral";
  if (direction === "buy") score += side === "long" ? 2 : -2;
  if (direction === "sell") score += side === "short" ? 2 : -2;
  const iceSide = snap.icebergAskDetected ? "buy" : snap.icebergBidDetected ? "sell" : null;
  if (iceSide) score += iceSide === (side === "long" ? "buy" : "sell") ? 1 : -1;
  const iceAskCount = Number(snap.icebergAskCount ?? 0);
  const iceBidCount = Number(snap.icebergBidCount ?? 0);
  if (iceAskCount >= 2) score += side === "short" ? 2 : -2;
  if (iceBidCount >= 2) score += side === "long" ? 2 : -2;
  if (snap.largeTradeDirection === "buy") score += side === "long" ? 1 : -1;
  if (snap.largeTradeDirection === "sell") score += side === "short" ? 1 : -1;
  return score;
}

function entryGate(
  state: TelCurrentParityState,
  side: "long" | "short",
  candle: RtCandle1Min,
  marginUsedBefore: number,
  evaluationMode: TelParityInput["evaluationMode"],
) {
  const price = candle.close;
  const shares = evaluationMode === "signal_quality" ? 100 : calcShares(price);
  const requiredMargin = price * shares;
  const highs = state.candles.map(item => item.high);
  const lows = state.candles.map(item => item.low);
  const closes = state.candles.map(item => item.close);
  const atr = calcATR(highs, lows, closes, ATR_PERIOD).at(-1) ?? null;
  const atrRatio = atr !== null && price > 0 ? atr / price : null;
  if (atrRatio !== null && atrRatio < ATR_THRESHOLD) {
    return { allowed: false as const, reason: "atr_block", shares, requiredMargin, atrRatio };
  }
  if (side === "short" && candle.candleTime >= "13:00") {
    return { allowed: false as const, reason: "pm_entry_not_applicable_for_8035", shares, requiredMargin, atrRatio };
  }
  if (evaluationMode === "capital_constrained" && marginUsedBefore + requiredMargin > MAX_TOTAL_EXPOSURE) {
    return { allowed: false as const, reason: "margin_block", shares, requiredMargin, atrRatio };
  }
  return { allowed: true as const, reason: null, shares, requiredMargin, atrRatio };
}

function makePosition(input: TelParityInput, route: TelParityRoute, side: "long" | "short", slPct: number, tpPct: number, reason: string, shares: number): TelParityPosition {
  return {
    route,
    side,
    entryPrice: input.candle.close,
    entryTime: input.candle.candleTime,
    entrySourceEventId: input.sourceEventId,
    shares,
    slPct,
    tpPct,
    entryReason: reason,
  };
}

function finalize(state: TelCurrentParityState, input: TelParityInput, resultType: TelParityResultType, decision: Record<string, unknown>, openedPosition: TelParityPosition | null = null, closedPosition: TelParityTransition["closedPosition"] = null): TelParityTransition {
  state.lastSourceEventId = input.sourceEventId;
  state.lastResultType = resultType;
  state.lastDecision = decision;
  return { nextState: state, resultType, decision, openedPosition, closedPosition };
}

function closePosition(state: TelCurrentParityState, input: TelParityInput, snapshot: BoardSnapshot | null): TelParityTransition | null {
  const position = state.position;
  if (!position) return null;
  const candle = input.candle;
  const stopLine = position.side === "long"
    ? position.entryPrice * (1 - position.slPct / 100)
    : position.entryPrice * (1 + position.slPct / 100);
  const tpLine = position.side === "long"
    ? position.entryPrice * (1 + position.tpPct / 100)
    : position.entryPrice * (1 - position.tpPct / 100);
  let exitPrice: number | null = null;
  let exitReason = "";
  if ((position.side === "long" && candle.low <= stopLine) || (position.side === "short" && candle.high >= stopLine)) {
    exitPrice = stopLine;
    exitReason = "stop_loss";
  } else if ((position.side === "long" && candle.high >= tpLine) || (position.side === "short" && candle.low <= tpLine)) {
    exitPrice = tpLine;
    exitReason = "take_profit";
  }
  if (exitPrice === null) {
    const signalCandles = detectSignals(toSignalCandles(state.candles));
    const signal = signalCandles.at(-1)?.signal;
    if ((position.side === "long" && signal?.type === "sell") || (position.side === "short" && signal?.type === "buy")) {
      exitPrice = candle.close;
      exitReason = "signal_reversal";
    }
  }
  if (exitPrice === null && !position.entryReason.startsWith(TEL_OPEN_DIRECTION_BREAKOUT_REASON_PREFIX) && snapshot) {
    const pnlPct = position.side === "long"
      ? (candle.close - position.entryPrice) / position.entryPrice * 100
      : (position.entryPrice - candle.close) / position.entryPrice * 100;
    if (pnlPct >= 0.05 && (position.side === "long"
      ? snapshot.signal === "sell_pressure" || snapshot.signal === "large_sell_wall"
      : snapshot.signal === "buy_pressure" || snapshot.signal === "large_buy_wall")) {
      exitPrice = candle.close;
      exitReason = "board_early_exit";
    }
  }
  const maxHolding = position.route.startsWith("open_direction_breakout") ? 20 : 22;
  if (exitPrice === null && timeToMinutes(candle.candleTime) - timeToMinutes(position.entryTime) > maxHolding) {
    exitPrice = candle.open;
    exitReason = `max_holding_${maxHolding}_next_bar_open`;
  }
  if (exitPrice === null && position.entryTime < "11:30" && candle.candleTime >= AM_SESSION_CLOSE_TIME && candle.candleTime < "11:30") {
    exitPrice = candle.close;
    exitReason = "morning_session_exit";
  }
  if (exitPrice === null && candle.candleTime >= MARKET_CLOSE_TIME) {
    exitPrice = candle.close;
    exitReason = "market_exit";
  }
  if (exitPrice === null) return finalize(state, input, "hold", { action: "hold", route: position.route });
  const pnl = position.side === "long"
    ? (exitPrice - position.entryPrice) * position.shares
    : (position.entryPrice - exitPrice) * position.shares;
  const closed = { ...position, exitPrice, exitReason, pnl };
  if (exitReason === "stop_loss") state.lastStopLossTime = candle.candleTime;
  state.position = null;
  return finalize(state, input, "exit", { action: "exit", route: position.route, exitPrice, exitReason, pnl }, null, closed);
}

export function applyTelCurrentParityTransition(previous: TelCurrentParityState, input: TelParityInput): TelParityTransition {
  const state = structuredClone(previous);
  resetForDate(state, input.candle.tradeDate);
  const snapshot = buildBoardSnapshot(state, input.board);
  state.candles.push({ ...input.candle });
  if (state.candles.length > 420) state.candles.shift();
  if (state.candles.length < 30) {
    return finalize(state, input, "no_signal", { action: "none", reason: "warmup_lt_30" });
  }
  const exit = closePosition(state, input, snapshot);
  if (exit) return exit;
  const candle = input.candle;
  if (candle.candleTime < "09:30" || candle.candleTime >= "14:45") {
    return finalize(state, input, "no_signal", { action: "none", reason: "outside_entry_or_warmup" });
  }
  if (state.fired.primary) {
    return finalize(state, input, "no_signal", { action: "none", reason: "primary_daily_slot_consumed" });
  }
  if (candle.candleTime >= "10:00" && candle.candleTime <= "10:30") {
    const metrics = calculateTelOpenDirectionBreakoutMetrics(
      state.candles.map(item => ({
        time: item.candleTime,
        open: item.open,
        high: item.high,
        low: item.low,
        close: item.close,
        volume: item.volume,
      })),
    );
    const side = metrics?.longEligible ? "long" : metrics?.shortEligible ? "short" : null;
    if (!side) return finalize(state, input, "no_signal", { action: "none", route: "primary", metrics });
    const gate = entryGate(state, side, candle, input.marginUsedBefore, input.evaluationMode);
    const route: TelParityRoute = side === "long" ? "open_direction_breakout_long" : "open_direction_breakout_short";
    if (!gate.allowed) return finalize(state, input, "rejected", { action: "rejected", route, gate, metrics });
    const reason = `${TEL_OPEN_DIRECTION_BREAKOUT_REASON_PREFIX}${side === "long" ? "LONG" : "SHORT"}`;
    const position = makePosition(input, route, side, 0.6, 1.2, reason, gate.shares);
    state.position = position;
    state.fired.primary = true;
    return finalize(state, input, "entry", { action: "entry", route, theoreticalPrice: candle.close, gate, metrics }, position);
  }
  if (candle.candleTime < "10:31") {
    return finalize(state, input, "no_signal", { action: "none", reason: "fallback_not_started" });
  }
  const dayOpen = state.candles[0]?.open ?? candle.open;
  const currentMA = average(state.candles.slice(-8).map(item => item.close));
  const prevMA = average(state.candles.slice(-9, -1).map(item => item.close));
  const ma2Ago = average(state.candles.slice(-10, -2).map(item => item.close));
  const maSlope2 = ma2Ago > 0 ? (currentMA - ma2Ago) / ma2Ago * 100 : 0;
  const volumeBase = state.candles.slice(-21, -1);
  const volumeRatio = average(volumeBase.map(item => item.volume)) > 0
    ? candle.volume / average(volumeBase.map(item => item.volume))
    : 0;
  const openGainPct = dayOpen > 0 ? (candle.close - dayOpen) / dayOpen * 100 : 0;
  if (!state.fired.fallbackTrendLong && candle.candleTime <= "11:27") {
    const recent = state.candles.slice(-21, -1);
    const candidate = openGainPct >= 1.5 && openGainPct <= 2.5
      && currentMA > prevMA && maSlope2 >= 0.02
      && candle.high > Math.max(...recent.map(item => item.high))
      && candle.close > candle.open && volumeRatio >= 1.0;
    if (candidate) {
      const htf = getHigherTfTrend(toSignalCandles(state.candles), state.candles.length - 1, 3);
      const score = boardScore(state, "long", snapshot);
      const blocked = htf === "down" || snapshot?.signal === "sell_pressure" || (snapshot?.buyPressureRatio ?? 0) > 1.6 || score < BOARD_SCORE_THRESHOLD;
      if (blocked) return finalize(state, input, "rejected", { action: "rejected", route: "fallback_trend_long", htf, score, snapshot });
      const gate = entryGate(state, "long", candle, input.marginUsedBefore, input.evaluationMode);
      if (!gate.allowed) return finalize(state, input, "rejected", { action: "rejected", route: "fallback_trend_long", gate });
      const position = makePosition(input, "fallback_trend_long", "long", 0.7, 1.4, "順張りLONG", gate.shares);
      state.position = position;
      state.fired.fallbackTrendLong = true;
      return finalize(state, input, "entry", { action: "entry", route: position.route, theoreticalPrice: candle.close, gate }, position);
    }
  }
  if (!state.fired.fallbackTrendShort && candle.candleTime <= "11:00") {
    const recent = state.candles.slice(-6, -1);
    const candidate = openGainPct >= -4.0 && openGainPct <= -0.5
      && currentMA <= prevMA && maSlope2 <= -0.02
      && candle.low < Math.min(...recent.map(item => item.low))
      && candle.close < candle.open && volumeRatio >= 1.2;
    if (candidate) {
      const htf = getHigherTfTrend(toSignalCandles(state.candles), state.candles.length - 1, 3);
      const score = boardScore(state, "short", snapshot);
      const neutral = snapshot?.signal === "neutral";
      const blocked = htf === "up" || snapshot?.signal === "buy_pressure" || (score < BOARD_SCORE_THRESHOLD && neutral);
      if (blocked) return finalize(state, input, "rejected", { action: "rejected", route: "fallback_trend_short", htf, score, snapshot });
      const gate = entryGate(state, "short", candle, input.marginUsedBefore, input.evaluationMode);
      if (!gate.allowed) return finalize(state, input, "rejected", { action: "rejected", route: "fallback_trend_short", gate });
      const position = makePosition(input, "fallback_trend_short", "short", 0.6, 1.8, "順張りSHORT", gate.shares);
      state.position = position;
      state.fired.fallbackTrendShort = true;
      return finalize(state, input, "entry", { action: "entry", route: position.route, theoreticalPrice: candle.close, gate }, position);
    }
  }
  return finalize(state, input, "no_signal", { action: "none", reason: "no_current_8035_signal" });
}

export const TEL_CURRENT_PARITY_SPEC = Object.freeze({
  strategyVersion: TEL_CURRENT_PARITY_VERSION,
  causalityAuditVersion: TEL_CAUSALITY_AUDIT_VERSION,
  executableConfirmVersion: TEL_EXECUTABLE_CONFIRM_VERSION,
  purpose: "parity_only",
  eligibleForAdoption: false,
  symbol: "8035",
  evaluationStartDate: TEL_AUDIT_EVALUATION_START_DATE,
  primary: TEL_OPEN_DIRECTION_BREAKOUT_SPEC.primary,
  fallback: TEL_OPEN_DIRECTION_BREAKOUT_SPEC.fallback,
  priceSemantics: Object.freeze({
    entry: "completed_candle_close_preserved_for_parity",
    timeExit: "completed_candle_open_preserved_for_parity",
    causalityStatus: "known_violation",
  }),
});
