/**
 * sim_symbol_optimize.ts
 * 改良策4: 銘柄ごとのパラメータ最適化
 * 
 * 分析内容:
 * 1. 各銘柄の現行パフォーマンスを個別に分析
 * 2. 銘柄をボラティリティグループに分類
 * 3. グループ別にSL/TP/板読み閾値を最適化
 * 4. 最適パラメータの組み合わせで全体シミュレーション
 * 
 * 実行: cd /home/ubuntu/stock-alert-app && npx tsx analysis/sim_symbol_optimize.ts
 */
import * as fs from "fs";
import { detectSignals, calcMA, calcRSI, calcBollinger, type CandleWithSignal } from "../server/routers/stockData";
import { TARGET_STOCKS } from "../shared/stocks";
import { getHigherTfTrend } from "../server/vwap";
import { calcATR } from "../server/intradayRegime";
import type { BoardSnapshot } from "../drizzle/schema";

// === 定数 ===
const INITIAL_CAPITAL_PER_STOCK = 3_000_000;
const LOT_RATIO = 0.9;
const MARGIN_CAPITAL = 3_000_000;
const MARGIN_MULTIPLIER = 3.3;
const MARGIN_USAGE_LIMIT = 0.9;
const MAX_TOTAL_EXPOSURE = MARGIN_CAPITAL * MARGIN_MULTIPLIER * MARGIN_USAGE_LIMIT;
const NO_ENTRY_AFTER = "15:15";
const NO_ENTRY_BEFORE = "09:30";
const MIN_CANDLES_FOR_SIGNAL = 30;
const PULLBACK_MAX_WAIT = 5;
const ROUND_PULLBACK_MAX_WAIT = 5;
const ATR_FILTER_PERIOD = 7;
const ATR_FILTER_THRESHOLD = 0.0012;
const PULLBACK_DEPTH_MIN = 0.30;
const PULLBACK_DEPTH_MAX = 0.70;
const PULLBACK_DEPTH_LOOKBACK = 20;
const NO_REENTRY_AFTER_STOPLOSS_MIN = 30;
const VOLUME_UNAVAILABLE_RATIO = 0.9;
const BOARD_EARLY_EXIT_MIN_PROFIT_PCT = 0.05;
const ROUND_LEVEL_CONFIRM_BARS = 5;
const MARKET_CLOSE_TIME = "15:30";
const ALLOWED_SYMBOLS = new Set(TARGET_STOCKS.map(s => s.symbol));

// === 銘柄別パラメータ ===
interface SymbolParams {
  slPercent: number;
  tpPercent: number;
  boardScoreThreshold: number;
}

// === 型定義 ===
interface RtCandleRow { symbol: string; tradeDate: string; candleTime: string; open: number; high: number; low: number; close: number; volume: number; boardSnapshot: BoardSnapshot | null; }
interface OpenPosition { symbol: string; side: "long" | "short"; entryPrice: number; shares: number; entryTime: string; entryReason: string; }
interface Trade { date: string; time: string; sym: string; action: string; price: number; pnl?: number; reason: string; shares: number; }

// === ヘルパー ===
function calcShares(price: number): number { return Math.max(100, Math.floor(Math.floor(INITIAL_CAPITAL_PER_STOCK * LOT_RATIO / price) / 100) * 100); }
function timeToMinutes(t: string): number { const [h, m] = t.split(":").map(Number); return h * 60 + m; }
function checkVolumeUnavailable(buffer: CandleWithSignal[]): boolean { if (buffer.length < 10) return false; const lb = Math.min(buffer.length, 20); const rc = buffer.slice(-lb); return (rc.filter(c => c.volume === 0).length / lb) >= VOLUME_UNAVAILABLE_RATIO; }
function calcCurrentExposure(op: Map<string, OpenPosition>): number { let t = 0; for (const p of op.values()) t += p.entryPrice * p.shares; return t; }

function estimateTickDirection(bprHistoryArr: number[], snapshot: BoardSnapshot | null): "uptick" | "downtick" | "neutral" {
  if (!snapshot) return "neutral";
  const mod = (snapshot as any).marketOrderDirection;
  if (mod === "buy") return "uptick"; if (mod === "sell") return "downtick";
  if (bprHistoryArr.length < 3) return "neutral";
  const recent = bprHistoryArr.slice(-Math.min(5, bprHistoryArr.length));
  const trend = recent[recent.length - 1] - recent[0];
  if (trend >= 0.2) return "uptick"; if (trend <= -0.2) return "downtick";
  const last = recent[recent.length - 1];
  if (last >= 1.3) return "uptick"; if (last <= 0.7) return "downtick";
  return "neutral";
}

function detectFakeOrder(snapshot: BoardSnapshot | null): { cancelDetected: boolean; icebergDetected: boolean; icebergSide: "buy" | "sell" | null } {
  if (!snapshot) return { cancelDetected: false, icebergDetected: false, icebergSide: null };
  const snap = snapshot as any;
  const cancelDetected = !!(snap.askCancelDetected || snap.bidCancelDetected);
  let icebergDetected = false; let icebergSide: "buy" | "sell" | null = null;
  if (snap.icebergAskDetected) { icebergDetected = true; icebergSide = "buy"; }
  if (snap.icebergBidDetected) { icebergDetected = true; icebergSide = "sell"; }
  return { cancelDetected, icebergDetected, icebergSide };
}

function boardReadingScoreBC(bprHistoryArr: number[], side: "long" | "short", snapshot: BoardSnapshot | null): number {
  if (!snapshot) return 1;
  let score = 0; const bpr = snapshot.buyPressureRatio;
  if (snapshot.marketOrderRatio >= 0.08) { if (side === "long" && bpr > 1.0) score += 2; else if (side === "long" && bpr < 1.0) score -= 2; else if (side === "short" && bpr < 1.0) score += 2; else if (side === "short" && bpr > 1.0) score -= 2; }
  if (side === "long") { if (snapshot.largeSellWall) score += 1; if (snapshot.largeBuyWall) score -= 1; } else { if (snapshot.largeBuyWall) score += 1; if (snapshot.largeSellWall) score -= 1; }
  if (bprHistoryArr.length >= 3) { const delta = bprHistoryArr[bprHistoryArr.length - 1] - bprHistoryArr[0]; if (side === "long" && delta >= 0.15) score += 1; else if (side === "long" && delta <= -0.15) score -= 1; else if (side === "short" && delta <= -0.15) score += 1; else if (side === "short" && delta >= 0.15) score -= 1; }
  const { cancelDetected, icebergDetected, icebergSide } = detectFakeOrder(snapshot);
  let mode: string;
  if (cancelDetected) { mode = "trap"; } else { mode = detectMarketMode(bprHistoryArr, snapshot); }
  if (mode === "active" || mode === "building") score += 1; else if (mode === "trap" || mode === "quiet") score -= 2;
  if (side === "long" && bpr >= 1.4) score += 1; else if (side === "long" && bpr <= 0.65) score -= 1; else if (side === "short" && bpr <= 0.65) score += 1; else if (side === "short" && bpr >= 1.4) score -= 1;
  const tickDir = estimateTickDirection(bprHistoryArr, snapshot);
  if (tickDir === "uptick") { if (side === "long") score += 2; else score -= 2; } else if (tickDir === "downtick") { if (side === "short") score += 2; else score -= 2; }
  if (icebergDetected && icebergSide) { if (side === "long" && icebergSide === "buy") score += 1; else if (side === "short" && icebergSide === "sell") score += 1; else if (side === "long" && icebergSide === "sell") score -= 1; else if (side === "short" && icebergSide === "buy") score -= 1; }
  return score;
}

function detectMarketMode(bprHistoryArr: number[], snapshot: BoardSnapshot): string {
  const bpr = snapshot.buyPressureRatio;
  if (bprHistoryArr.length >= 3 && bprHistoryArr.every(h => h >= 0.85 && h <= 1.15) && bpr >= 0.85 && bpr <= 1.15) return "quiet";
  if (bpr > 1.2 || bpr < 0.8) return "active";
  if (bprHistoryArr.length >= 3) { const delta = Math.abs(bprHistoryArr[bprHistoryArr.length - 1] - bprHistoryArr[0]); if (delta >= 0.1) return "building"; }
  return "trap";
}

function shouldBoardEarlyExit(pos: OpenPosition, currentPrice: number, snapshot: BoardSnapshot | null): boolean {
  if (!snapshot) return false;
  const profitPct = pos.side === "long" ? (currentPrice - pos.entryPrice) / pos.entryPrice * 100 : (pos.entryPrice - currentPrice) / pos.entryPrice * 100;
  if (profitPct < BOARD_EARLY_EXIT_MIN_PROFIT_PCT) return false;
  if (pos.side === "long" && (snapshot.signal === "sell_pressure" || snapshot.signal === "large_sell_wall")) return true;
  if (pos.side === "short" && (snapshot.signal === "buy_pressure" || snapshot.signal === "large_buy_wall")) return true;
  return false;
}

// === シミュレーション関数（銘柄別パラメータ対応） ===
function simulateDay(dayData: RtCandleRow[], symbolParamsMap: Map<string, SymbolParams>, defaultParams: SymbolParams): { trades: Trade[]; totalPnl: number } {
  const buffers = new Map<string, CandleWithSignal[]>();
  const openPositions = new Map<string, OpenPosition>();
  const pullbackStates = new Map<string, any>();
  const roundLevelPendingStates = new Map<string, any>();
  const roundPullbackStates = new Map<string, any>();
  const bprHistories = new Map<string, number[]>();
  const lastStopLossTime = new Map<string, string>();
  const trades: Trade[] = [];
  let totalPnl = 0;

  const sorted = dayData
    .filter(c => ALLOWED_SYMBOLS.has(c.symbol))
    .filter(c => !(c.candleTime >= "11:30" && c.candleTime < "12:30"))
    .sort((a, b) => a.candleTime < b.candleTime ? -1 : a.candleTime > b.candleTime ? 1 : a.symbol < b.symbol ? -1 : 1);

  for (const candle of sorted) {
    const { symbol, candleTime, open, high, low, close, volume, boardSnapshot } = candle;
    const tradeDate = candle.tradeDate;
    const params = symbolParamsMap.get(symbol) ?? defaultParams;
    
    if (!buffers.has(symbol)) buffers.set(symbol, []);
    const buffer = buffers.get(symbol)!;
    if (boardSnapshot) {
      const h = bprHistories.get(symbol) ?? [];
      h.push(boardSnapshot.buyPressureRatio);
      if (h.length > 5) h.shift();
      bprHistories.set(symbol, h);
    }
    const c4s: CandleWithSignal = { time: `${tradeDate}T${candleTime}:00`, dayKey: tradeDate, timestamp: new Date(`${tradeDate}T${candleTime}:00+09:00`).getTime(), open, high, low, close, volume, ma5: null, ma25: null, rsi: null, bbUpper: null, bbMiddle: null, bbLower: null };
    buffer.push(c4s);
    const closes = buffer.map(c => c.close);
    const li = buffer.length - 1;
    const ma5S = calcMA(closes, 5); const ma25S = calcMA(closes, 25); const rsiS = calcRSI(closes, 14); const bbS = calcBollinger(closes, 20);
    buffer[li].ma5 = ma5S[li]; buffer[li].ma25 = ma25S[li]; buffer[li].rsi = rsiS[li]; buffer[li].bbUpper = bbS.upper[li]; buffer[li].bbMiddle = bbS.middle[li]; buffer[li].bbLower = bbS.lower[li];

    // 決済チェック（銘柄別SL/TP）
    const existingPos = openPositions.get(symbol);
    if (existingPos) {
      const { entryPrice, shares, side } = existingPos;
      if (candleTime >= MARKET_CLOSE_TIME) {
        const pnl = side === "long" ? (close - entryPrice) * shares : (entryPrice - close) * shares;
        totalPnl += pnl; trades.push({ date: tradeDate, time: candleTime, sym: symbol, action: "forced_close", price: close, pnl, reason: "大引け強制決済", shares });
        openPositions.delete(symbol); continue;
      }
      let exitPrice: number | null = null, exitReason = "";
      if (side === "long") {
        const sl = entryPrice * (1 - params.slPercent / 100);
        const tp = entryPrice * (1 + params.tpPercent / 100);
        if (low <= sl) { exitPrice = sl; exitReason = "損切り"; } else if (high >= tp) { exitPrice = tp; exitReason = "利確"; }
      } else {
        const sl = entryPrice * (1 + params.slPercent / 100);
        const tp = entryPrice * (1 - params.tpPercent / 100);
        if (high >= sl) { exitPrice = sl; exitReason = "損切り"; } else if (low <= tp) { exitPrice = tp; exitReason = "利確"; }
      }
      if (exitPrice === null && buffer.length >= MIN_CANDLES_FOR_SIGNAL) {
        const ws = detectSignals(buffer); const latest = ws[ws.length - 1]; buffer[buffer.length - 1] = latest;
        if (latest.signal) {
          if (side === "long" && latest.signal.type === "sell") { exitPrice = close; exitReason = "シグナル反転"; }
          else if (side === "short" && latest.signal.type === "buy") { exitPrice = close; exitReason = "シグナル反転"; }
        }
      }
      if (exitPrice === null && shouldBoardEarlyExit(existingPos, close, boardSnapshot)) { exitPrice = close; exitReason = "板読み早期利確"; }
      if (exitPrice !== null) {
        const pnl = side === "long" ? (exitPrice - entryPrice) * shares : (entryPrice - exitPrice) * shares;
        totalPnl += pnl; trades.push({ date: tradeDate, time: candleTime, sym: symbol, action: "exit", price: exitPrice, pnl, reason: exitReason, shares });
        openPositions.delete(symbol); if (exitReason === "損切り") lastStopLossTime.set(symbol, candleTime);
      }
      continue;
    }

    // エントリー禁止
    if (candleTime < NO_ENTRY_BEFORE || candleTime >= NO_ENTRY_AFTER) continue;
    if (buffer.length < MIN_CANDLES_FOR_SIGNAL) continue;

    // シグナル検出
    const withSignals = detectSignals(buffer); const latestSignal = withSignals[withSignals.length - 1]; buffer[buffer.length - 1] = latestSignal;
    const firstCandle = buffer[0]; const priceChangeRatio = (close - firstCandle.open) / firstCandle.open * 100; const isBullish = priceChangeRatio >= 0.2;

    const getBoardScore = (side: "long" | "short") => boardReadingScoreBC(bprHistories.get(symbol) ?? [], side, boardSnapshot);

    // 押し目確認ステートマシン
    const ps = pullbackStates.get(symbol);
    if (ps) {
      ps.waitCount++;
      if (low < ps.recentSwingLow || ps.waitCount > PULLBACK_MAX_WAIT) { pullbackStates.delete(symbol); }
      else {
        if (!ps.pulledBack && close < ps.signalPrice) ps.pulledBack = true;
        if (ps.pulledBack && close > ps.signalPrice) {
          pullbackStates.delete(symbol);
          if (boardSnapshot?.signal === "sell_pressure") continue;
          const brScore = getBoardScore("long");
          if (brScore < params.boardScoreThreshold) continue;
          const shares = calcShares(close); const amount = close * shares;
          if (buffer.length >= ATR_FILTER_PERIOD + 1) { const h = buffer.map(c => c.high); const l = buffer.map(c => c.low); const cl = buffer.map(c => c.close); const atr = calcATR(h, l, cl, ATR_FILTER_PERIOD); if (atr[atr.length-1] !== null && close > 0 && (atr[atr.length-1]! / close) < ATR_FILTER_THRESHOLD) continue; }
          if (calcCurrentExposure(openPositions) + amount > MAX_TOTAL_EXPOSURE) continue;
          if (checkVolumeUnavailable(buffer)) continue;
          const lastSL = lastStopLossTime.get(symbol); if (lastSL && timeToMinutes(candleTime) - timeToMinutes(lastSL) < NO_REENTRY_AFTER_STOPLOSS_MIN) continue;
          openPositions.set(symbol, { symbol, side: "long", entryPrice: close, shares, entryTime: candleTime, entryReason: ps.reason });
          trades.push({ date: tradeDate, time: candleTime, sym: symbol, action: "buy", price: close, reason: `押し目確認: ${ps.reason}`, shares });
        }
      }
      continue;
    }

    // 大台確認バーステートマシン
    const rp = roundLevelPendingStates.get(symbol);
    if (rp) {
      if (openPositions.has(symbol)) { roundLevelPendingStates.delete(symbol); }
      else {
        const valid = rp.direction === "buy" ? close >= rp.level : close <= rp.level;
        if (valid) { rp.confirmCount++; if (rp.confirmCount >= ROUND_LEVEL_CONFIRM_BARS) { roundLevelPendingStates.delete(symbol); roundPullbackStates.set(symbol, { ...rp, signalPrice: close, waitCount: 0, pulledBack: false }); } }
        else { roundLevelPendingStates.delete(symbol); }
        continue;
      }
    }

    // 大台確認後の押し目待ち
    const rpb = roundPullbackStates.get(symbol);
    if (rpb) {
      rpb.waitCount++;
      const side: "long" | "short" = rpb.direction === "buy" ? "long" : "short";
      if ((rpb.direction === "buy" && close < rpb.level) || (rpb.direction === "sell" && close > rpb.level)) { roundPullbackStates.delete(symbol); continue; }
      if (rpb.waitCount > ROUND_PULLBACK_MAX_WAIT) {
        roundPullbackStates.delete(symbol);
        if (boardSnapshot && side === "long" && boardSnapshot.signal === "sell_pressure") continue;
        if (boardSnapshot && side === "short" && boardSnapshot.signal === "buy_pressure") continue;
        const brScore = getBoardScore(side);
        if (brScore < params.boardScoreThreshold) continue;
        const shares = calcShares(close); const amount = close * shares;
        if (buffer.length >= ATR_FILTER_PERIOD + 1) { const h = buffer.map(c => c.high); const l = buffer.map(c => c.low); const cl = buffer.map(c => c.close); const atr = calcATR(h, l, cl, ATR_FILTER_PERIOD); if (atr[atr.length-1] !== null && close > 0 && (atr[atr.length-1]! / close) < ATR_FILTER_THRESHOLD) continue; }
        if (calcCurrentExposure(openPositions) + amount > MAX_TOTAL_EXPOSURE) continue;
        if (checkVolumeUnavailable(buffer)) continue;
        openPositions.set(symbol, { symbol, side, entryPrice: close, shares, entryTime: candleTime, entryReason: `${rpb.reason} (押し目なし)` });
        trades.push({ date: tradeDate, time: candleTime, sym: symbol, action: side === "long" ? "buy" : "short", price: close, reason: `${rpb.reason} (押し目なし)`, shares });
        continue;
      }
      if (rpb.direction === "buy") {
        if (!rpb.pulledBack && close < rpb.signalPrice) rpb.pulledBack = true;
        if (rpb.pulledBack && close > rpb.signalPrice) {
          roundPullbackStates.delete(symbol);
          if (boardSnapshot?.signal === "sell_pressure") continue;
          const brScore = getBoardScore("long");
          if (brScore < params.boardScoreThreshold) continue;
          const shares = calcShares(close); const amount = close * shares;
          if (buffer.length >= ATR_FILTER_PERIOD + 1) { const h = buffer.map(c => c.high); const l = buffer.map(c => c.low); const cl = buffer.map(c => c.close); const atr = calcATR(h, l, cl, ATR_FILTER_PERIOD); if (atr[atr.length-1] !== null && close > 0 && (atr[atr.length-1]! / close) < ATR_FILTER_THRESHOLD) continue; }
          if (calcCurrentExposure(openPositions) + amount > MAX_TOTAL_EXPOSURE) continue;
          openPositions.set(symbol, { symbol, side: "long", entryPrice: close, shares, entryTime: candleTime, entryReason: `${rpb.reason} (押し目確認後)` });
          trades.push({ date: tradeDate, time: candleTime, sym: symbol, action: "buy", price: close, reason: `${rpb.reason} (押し目確認後)`, shares });
          continue;
        }
      } else {
        if (!rpb.pulledBack && close > rpb.signalPrice) rpb.pulledBack = true;
        if (rpb.pulledBack && close < rpb.signalPrice) {
          roundPullbackStates.delete(symbol);
          if (boardSnapshot?.signal === "buy_pressure") continue;
          const brScore = getBoardScore("short");
          if (brScore < params.boardScoreThreshold) continue;
          const shares = calcShares(close); const amount = close * shares;
          if (buffer.length >= ATR_FILTER_PERIOD + 1) { const h = buffer.map(c => c.high); const l = buffer.map(c => c.low); const cl = buffer.map(c => c.close); const atr = calcATR(h, l, cl, ATR_FILTER_PERIOD); if (atr[atr.length-1] !== null && close > 0 && (atr[atr.length-1]! / close) < ATR_FILTER_THRESHOLD) continue; }
          if (calcCurrentExposure(openPositions) + amount > MAX_TOTAL_EXPOSURE) continue;
          openPositions.set(symbol, { symbol, side: "short", entryPrice: close, shares, entryTime: candleTime, entryReason: `${rpb.reason} (押し目確認後)` });
          trades.push({ date: tradeDate, time: candleTime, sym: symbol, action: "short", price: close, reason: `${rpb.reason} (押し目確認後)`, shares });
          continue;
        }
      }
      continue;
    }

    const sig = latestSignal.signal;
    if (!sig) continue;

    // 買いエントリー
    if (sig.type === "buy" && !openPositions.has(symbol)) {
      if (sig.reason?.includes("VWAPクロス上抜け")) continue;
      if (boardSnapshot?.signal === "sell_pressure") continue;
      const brScore = getBoardScore("long");
      if (brScore < params.boardScoreThreshold) continue;
      if (sig.reason?.startsWith("ダウ理論: 直近高値更新") && sig.recentSwingLow != null) {
        const htf = getHigherTfTrend(buffer, buffer.length - 1, 5);
        if (htf === "up" && buffer.length >= PULLBACK_DEPTH_LOOKBACK) {
          const lw = buffer.slice(-PULLBACK_DEPTH_LOOKBACK); const sh = Math.max(...lw.map(c => c.high)); const sl2 = Math.min(...lw.map(c => c.low));
          if (sh > sl2) { const pd = (sh - close) / (sh - sl2); if (pd >= PULLBACK_DEPTH_MIN && pd <= PULLBACK_DEPTH_MAX) { pullbackStates.set(symbol, { recentSwingLow: sig.recentSwingLow, signalPrice: close, waitCount: 0, pulledBack: false, reason: sig.reason }); } }
        }
      } else if (sig.reason?.startsWith("大台超え")) {
        const m = sig.reason.match(/(\d+(?:\.\d+)?)円/); const level = m ? parseFloat(m[1]) : close;
        roundLevelPendingStates.set(symbol, { direction: "buy", level, confirmCount: 0, reason: sig.reason });
      } else {
        const shares = calcShares(close); const amount = close * shares;
        if (buffer.length >= ATR_FILTER_PERIOD + 1) { const h = buffer.map(c => c.high); const l = buffer.map(c => c.low); const cl = buffer.map(c => c.close); const atr = calcATR(h, l, cl, ATR_FILTER_PERIOD); if (atr[atr.length-1] !== null && close > 0 && (atr[atr.length-1]! / close) < ATR_FILTER_THRESHOLD) continue; }
        if (calcCurrentExposure(openPositions) + amount > MAX_TOTAL_EXPOSURE) continue;
        if (checkVolumeUnavailable(buffer)) continue;
        const lastSL = lastStopLossTime.get(symbol); if (lastSL && timeToMinutes(candleTime) - timeToMinutes(lastSL) < NO_REENTRY_AFTER_STOPLOSS_MIN) continue;
        openPositions.set(symbol, { symbol, side: "long", entryPrice: close, shares, entryTime: candleTime, entryReason: sig.reason });
        trades.push({ date: tradeDate, time: candleTime, sym: symbol, action: "buy", price: close, reason: sig.reason, shares });
      }
    }

    // 売りエントリー
    if (sig.type === "sell" && !openPositions.has(symbol)) {
      if (isBullish) continue;
      if (boardSnapshot?.signal === "buy_pressure") continue;
      const brScore = getBoardScore("short");
      if (brScore < params.boardScoreThreshold) continue;
      if (sig.reason?.startsWith("ダウ理論: 直近安値更新")) {
        const htf = getHigherTfTrend(buffer, buffer.length - 1, 5);
        if (htf !== "down") continue;
        if (buffer.length >= PULLBACK_DEPTH_LOOKBACK) { const lw = buffer.slice(-PULLBACK_DEPTH_LOOKBACK); const sh = Math.max(...lw.map(c => c.high)); const sl2 = Math.min(...lw.map(c => c.low)); if (sh > sl2) { const pd = (close - sl2) / (sh - sl2); if (pd < PULLBACK_DEPTH_MIN || pd > PULLBACK_DEPTH_MAX) continue; } }
      } else if (sig.reason?.startsWith("大台割れ")) {
        const m = sig.reason.match(/(\d+(?:\.\d+)?)円/); const level = m ? parseFloat(m[1]) : close;
        roundLevelPendingStates.set(symbol, { direction: "sell", level, confirmCount: 0, reason: sig.reason });
      } else {
        const shares = calcShares(close); const amount = close * shares;
        if (buffer.length >= ATR_FILTER_PERIOD + 1) { const h = buffer.map(c => c.high); const l = buffer.map(c => c.low); const cl = buffer.map(c => c.close); const atr = calcATR(h, l, cl, ATR_FILTER_PERIOD); if (atr[atr.length-1] !== null && close > 0 && (atr[atr.length-1]! / close) < ATR_FILTER_THRESHOLD) continue; }
        if (calcCurrentExposure(openPositions) + amount > MAX_TOTAL_EXPOSURE) continue;
        if (checkVolumeUnavailable(buffer)) continue;
        const lastSL = lastStopLossTime.get(symbol); if (lastSL && timeToMinutes(candleTime) - timeToMinutes(lastSL) < NO_REENTRY_AFTER_STOPLOSS_MIN) continue;
        openPositions.set(symbol, { symbol, side: "short", entryPrice: close, shares, entryTime: candleTime, entryReason: sig.reason });
        trades.push({ date: tradeDate, time: candleTime, sym: symbol, action: "short", price: close, reason: sig.reason, shares });
      }
    }
  }

  // 残ポジション強制決済
  for (const [symbol, pos] of openPositions.entries()) {
    const symCandles = sorted.filter(c => c.symbol === symbol);
    const last = symCandles[symCandles.length - 1];
    if (!last) continue;
    const pnl = pos.side === "long" ? (last.close - pos.entryPrice) * pos.shares : (pos.entryPrice - last.close) * pos.shares;
    totalPnl += pnl;
    trades.push({ date: last.tradeDate, time: last.candleTime, sym: symbol, action: "forced_close", price: last.close, pnl, reason: "データ終了時決済", shares: pos.shares });
  }

  return { trades, totalPnl };
}

// === データローダー ===
const DATES = ["2026-06-17", "2026-06-18", "2026-06-19", "2026-06-22", "2026-06-24", "2026-06-25"];

function loadDayData(date: string): RtCandleRow[] {
  const file = `/tmp/rt_candles_${date.replace(/-/g, "")}.json`;
  if (!fs.existsSync(file)) return [];
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const c of raw) {
    c.open = Number(c.open); c.high = Number(c.high); c.low = Number(c.low); c.close = Number(c.close); c.volume = Number(c.volume);
    if (typeof c.boardSnapshot === "string") c.boardSnapshot = JSON.parse(c.boardSnapshot);
  }
  return raw;
}

// === メイン ===
console.log("=".repeat(80));
console.log("改良策4: 銘柄ごとのパラメータ最適化");
console.log("（B・C適用版ベース、6日間、6/23除外）");
console.log("=".repeat(80));
console.log("");

// データプリロード
const allDayData = new Map<string, RtCandleRow[]>();
for (const date of DATES) { allDayData.set(date, loadDayData(date)); }

// === STEP 1: 銘柄別パフォーマンス分析 ===
console.log("━━━ STEP 1: 銘柄別パフォーマンス分析（現行パラメータ） ━━━");
console.log("");

const defaultParams: SymbolParams = { slPercent: 0.5, tpPercent: 1.5, boardScoreThreshold: 1 };
const symbolStats = new Map<string, { pnl: number; trades: number; wins: number; losses: number; sl: number; tp: number }>();

for (const date of DATES) {
  const dayData = allDayData.get(date)!;
  if (dayData.length === 0) continue;
  const result = simulateDay(dayData, new Map(), defaultParams);
  for (const t of result.trades) {
    if (t.pnl === undefined) continue;
    const s = symbolStats.get(t.sym) ?? { pnl: 0, trades: 0, wins: 0, losses: 0, sl: 0, tp: 0 };
    s.pnl += t.pnl; s.trades++;
    if (t.pnl > 0) s.wins++; else s.losses++;
    if (t.reason === "損切り") s.sl++;
    if (t.reason === "利確") s.tp++;
    symbolStats.set(t.sym, s);
  }
}

// ATR分析（ボラティリティ分類用）
const symbolATRs = new Map<string, number[]>();
for (const date of DATES) {
  const dayData = allDayData.get(date)!;
  const bySymbol = new Map<string, RtCandleRow[]>();
  for (const c of dayData) {
    if (!bySymbol.has(c.symbol)) bySymbol.set(c.symbol, []);
    bySymbol.get(c.symbol)!.push(c);
  }
  for (const [sym, candles] of bySymbol) {
    if (candles.length < 30) continue;
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);
    const closes = candles.map(c => c.close);
    const atrs = calcATR(highs, lows, closes, 14);
    const validATRs = atrs.filter(a => a !== null) as number[];
    if (validATRs.length > 0) {
      const avgATR = validATRs.reduce((a, b) => a + b, 0) / validATRs.length;
      const avgPrice = closes.reduce((a, b) => a + b, 0) / closes.length;
      const atrPct = (avgATR / avgPrice) * 100;
      if (!symbolATRs.has(sym)) symbolATRs.set(sym, []);
      symbolATRs.get(sym)!.push(atrPct);
    }
  }
}

// 銘柄名マップ
const symbolNames = new Map(TARGET_STOCKS.map(s => [s.symbol, s.name]));

// ランキング表示
const statsArr = [...symbolStats.entries()].sort((a, b) => b[1].pnl - a[1].pnl);
console.log("銘柄   | 名前                | 損益          | 取引 | 勝率  | SL | TP | 平均ATR%");
console.log("-------|---------------------|--------------|------|-------|----|----|--------");
for (const [sym, s] of statsArr) {
  const wr = s.trades > 0 ? Math.round(s.wins / s.trades * 100) : 0;
  const atrArr = symbolATRs.get(sym) ?? [];
  const avgATR = atrArr.length > 0 ? (atrArr.reduce((a, b) => a + b, 0) / atrArr.length).toFixed(3) : "N/A";
  const name = (symbolNames.get(sym) ?? sym).slice(0, 10).padEnd(10);
  console.log(`${sym.padEnd(6)} | ${name.padEnd(19)} | ${(s.pnl >= 0 ? "+" : "") + Math.round(s.pnl).toLocaleString().padStart(10)}円 | ${String(s.trades).padStart(4)} | ${String(wr).padStart(3)}%  | ${String(s.sl).padStart(2)} | ${String(s.tp).padStart(2)} | ${avgATR}%`);
}

// ボラティリティグループ分類
const HIGH_VOL_THRESHOLD = 0.15; // ATR% > 0.15% = 高ボラ
const highVolSymbols: string[] = [];
const midVolSymbols: string[] = [];
const lowVolSymbols: string[] = [];

for (const [sym] of symbolStats) {
  const atrArr = symbolATRs.get(sym) ?? [];
  const avgATR = atrArr.length > 0 ? atrArr.reduce((a, b) => a + b, 0) / atrArr.length : 0;
  if (avgATR >= HIGH_VOL_THRESHOLD) highVolSymbols.push(sym);
  else if (avgATR >= 0.08) midVolSymbols.push(sym);
  else lowVolSymbols.push(sym);
}

console.log("");
console.log("━━━ ボラティリティグループ分類 ━━━");
console.log(`高ボラ (ATR≥0.15%): ${highVolSymbols.join(", ")}`);
console.log(`中ボラ (0.08-0.15%): ${midVolSymbols.join(", ")}`);
console.log(`低ボラ (<0.08%): ${lowVolSymbols.join(", ")}`);
console.log("");

// === STEP 2: 損失銘柄の除外シミュレーション ===
console.log("━━━ STEP 2: 損失銘柄の除外シミュレーション ━━━");
console.log("");

// 損失銘柄を特定
const losingSymbols = statsArr.filter(([_, s]) => s.pnl < 0).map(([sym]) => sym);
console.log(`損失銘柄: ${losingSymbols.join(", ")}`);
console.log("");

// === STEP 3: グループ別パラメータスイープ ===
console.log("━━━ STEP 3: グループ別パラメータスイープ ━━━");
console.log("");

// テストするパラメータセット
interface GroupConfig {
  label: string;
  highVol: SymbolParams;
  midVol: SymbolParams;
  excludeSymbols: string[];
}

const configs: GroupConfig[] = [
  // ベースライン
  { label: "ベースライン（全銘柄同一 SL0.5/TP1.5）", highVol: { slPercent: 0.5, tpPercent: 1.5, boardScoreThreshold: 1 }, midVol: { slPercent: 0.5, tpPercent: 1.5, boardScoreThreshold: 1 }, excludeSymbols: [] },
  
  // A) 高ボラ銘柄のSL拡大
  { label: "高ボラSL0.7/TP2.1, 中ボラ現行", highVol: { slPercent: 0.7, tpPercent: 2.1, boardScoreThreshold: 1 }, midVol: { slPercent: 0.5, tpPercent: 1.5, boardScoreThreshold: 1 }, excludeSymbols: [] },
  { label: "高ボラSL0.8/TP2.4, 中ボラ現行", highVol: { slPercent: 0.8, tpPercent: 2.4, boardScoreThreshold: 1 }, midVol: { slPercent: 0.5, tpPercent: 1.5, boardScoreThreshold: 1 }, excludeSymbols: [] },
  { label: "高ボラSL1.0/TP3.0, 中ボラ現行", highVol: { slPercent: 1.0, tpPercent: 3.0, boardScoreThreshold: 1 }, midVol: { slPercent: 0.5, tpPercent: 1.5, boardScoreThreshold: 1 }, excludeSymbols: [] },
  
  // B) 高ボラ銘柄のSL拡大 + TP固定
  { label: "高ボラSL0.7/TP1.5, 中ボラ現行", highVol: { slPercent: 0.7, tpPercent: 1.5, boardScoreThreshold: 1 }, midVol: { slPercent: 0.5, tpPercent: 1.5, boardScoreThreshold: 1 }, excludeSymbols: [] },
  { label: "高ボラSL0.8/TP1.5, 中ボラ現行", highVol: { slPercent: 0.8, tpPercent: 1.5, boardScoreThreshold: 1 }, midVol: { slPercent: 0.5, tpPercent: 1.5, boardScoreThreshold: 1 }, excludeSymbols: [] },
  
  // C) 損失銘柄除外
  { label: "損失銘柄除外, 全銘柄SL0.5/TP1.5", highVol: { slPercent: 0.5, tpPercent: 1.5, boardScoreThreshold: 1 }, midVol: { slPercent: 0.5, tpPercent: 1.5, boardScoreThreshold: 1 }, excludeSymbols: losingSymbols },
  
  // D) 損失銘柄除外 + 高ボラSL拡大
  { label: "損失除外 + 高ボラSL0.7/TP2.1", highVol: { slPercent: 0.7, tpPercent: 2.1, boardScoreThreshold: 1 }, midVol: { slPercent: 0.5, tpPercent: 1.5, boardScoreThreshold: 1 }, excludeSymbols: losingSymbols },
  { label: "損失除外 + 高ボラSL0.8/TP2.4", highVol: { slPercent: 0.8, tpPercent: 2.4, boardScoreThreshold: 1 }, midVol: { slPercent: 0.5, tpPercent: 1.5, boardScoreThreshold: 1 }, excludeSymbols: losingSymbols },
  
  // E) 中ボラのTP引き下げ（利確しやすく）
  { label: "高ボラ現行, 中ボラSL0.5/TP1.0", highVol: { slPercent: 0.5, tpPercent: 1.5, boardScoreThreshold: 1 }, midVol: { slPercent: 0.5, tpPercent: 1.0, boardScoreThreshold: 1 }, excludeSymbols: [] },
  { label: "高ボラSL0.7/TP2.1, 中ボラSL0.4/TP1.2", highVol: { slPercent: 0.7, tpPercent: 2.1, boardScoreThreshold: 1 }, midVol: { slPercent: 0.4, tpPercent: 1.2, boardScoreThreshold: 1 }, excludeSymbols: [] },
  
  // F) 高ボラ銘柄の板読み閾値引き上げ
  { label: "高ボラSL0.7/TP2.1/板≥2, 中ボラ現行", highVol: { slPercent: 0.7, tpPercent: 2.1, boardScoreThreshold: 2 }, midVol: { slPercent: 0.5, tpPercent: 1.5, boardScoreThreshold: 1 }, excludeSymbols: [] },
];

interface SweepResult { label: string; totalPnl: number; trades: number; wins: number; losses: number; slCount: number; tpCount: number; daily: { date: string; pnl: number; trades: number }[]; }
const results: SweepResult[] = [];

for (const config of configs) {
  // 銘柄別パラメータマップを構築
  const symbolParamsMap = new Map<string, SymbolParams>();
  for (const sym of highVolSymbols) {
    if (!config.excludeSymbols.includes(sym)) symbolParamsMap.set(sym, config.highVol);
  }
  for (const sym of midVolSymbols) {
    if (!config.excludeSymbols.includes(sym)) symbolParamsMap.set(sym, config.midVol);
  }
  for (const sym of lowVolSymbols) {
    if (!config.excludeSymbols.includes(sym)) symbolParamsMap.set(sym, config.midVol);
  }
  
  // 除外銘柄をALLOWED_SYMBOLSから一時的に除外するため、dayDataをフィルタ
  const excludeSet = new Set(config.excludeSymbols);
  
  let totalPnl = 0, totalTrades = 0, totalWins = 0, totalLosses = 0, totalSL = 0, totalTP = 0;
  const daily: { date: string; pnl: number; trades: number }[] = [];
  
  for (const date of DATES) {
    let dayData = allDayData.get(date)!;
    if (excludeSet.size > 0) dayData = dayData.filter(c => !excludeSet.has(c.symbol));
    if (dayData.length === 0) { daily.push({ date, pnl: 0, trades: 0 }); continue; }
    const result = simulateDay(dayData, symbolParamsMap, defaultParams);
    const closed = result.trades.filter(t => t.pnl !== undefined);
    totalPnl += result.totalPnl; totalTrades += closed.length;
    totalWins += closed.filter(t => (t.pnl ?? 0) > 0).length;
    totalLosses += closed.filter(t => (t.pnl ?? 0) < 0).length;
    totalSL += result.trades.filter(t => t.reason === "損切り").length;
    totalTP += result.trades.filter(t => t.reason === "利確").length;
    daily.push({ date, pnl: result.totalPnl, trades: closed.length });
  }
  
  results.push({ label: config.label, totalPnl, trades: totalTrades, wins: totalWins, losses: totalLosses, slCount: totalSL, tpCount: totalTP, daily });
  const wr = totalTrades > 0 ? Math.round(totalWins / totalTrades * 100) : 0;
  console.log(`${config.label}: ${totalPnl >= 0 ? "+" : ""}${Math.round(totalPnl).toLocaleString()}円 (${totalTrades}T, 勝率${wr}%, SL${totalSL})`);
}

// ランキング
console.log("");
console.log("=".repeat(80));
console.log("結果ランキング（損益順）");
console.log("=".repeat(80));
console.log("");

const baseline = results[0];
const sorted2 = [...results].sort((a, b) => b.totalPnl - a.totalPnl);

console.log("順位 | パラメータ                                  | 合計損益      | 差分         | 取引 | 勝率  | SL | TP");
console.log("-----|---------------------------------------------|--------------|-------------|------|-------|----|----|");
for (let i = 0; i < sorted2.length; i++) {
  const r = sorted2[i];
  const diff = r.totalPnl - baseline.totalPnl;
  const wr = r.trades > 0 ? Math.round(r.wins / r.trades * 100) : 0;
  console.log(`${String(i+1).padStart(4)} | ${r.label.padEnd(43)} | ${(r.totalPnl >= 0 ? "+" : "") + Math.round(r.totalPnl).toLocaleString().padStart(10)}円 | ${(diff >= 0 ? "+" : "") + Math.round(diff).toLocaleString().padStart(9)}円 | ${String(r.trades).padStart(4)} | ${String(wr).padStart(3)}%  | ${String(r.slCount).padStart(2)} | ${String(r.tpCount).padStart(2)}`);
}

// 上位3パターンの日別詳細
console.log("");
console.log("=".repeat(80));
console.log("上位3パターン 日別損益");
console.log("=".repeat(80));
for (let i = 0; i < Math.min(3, sorted2.length); i++) {
  const r = sorted2[i];
  console.log(`\n--- ${r.label} ---`);
  for (const d of r.daily) {
    console.log(`  ${d.date}: ${d.pnl >= 0 ? "+" : ""}${Math.round(d.pnl).toLocaleString()}円 (${d.trades}T)`);
  }
}
