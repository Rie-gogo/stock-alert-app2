/**
 * replay_current_7days.ts
 * 現行版（改良なし）のシミュレーションを7営業日分バッチ実行する。
 * replay_today_full.tsのsimulate関数をそのまま流用。
 * 
 * 実行: cd /home/ubuntu/stock-alert-app && npx tsx analysis/replay_current_7days.ts
 */
import * as fs from "fs";
import { detectSignals, calcMA, calcRSI, calcBollinger, type CandleWithSignal } from "../server/routers/stockData";
import { TARGET_STOCKS } from "../shared/stocks";
import { getHigherTfTrend } from "../server/vwap";
import { calcATR } from "../server/intradayRegime";
import type { BoardSnapshot } from "../drizzle/schema";

// ============================================================
// 定数（realtimeSimEngine.tsと完全一致）
// ============================================================
const INITIAL_CAPITAL_PER_STOCK = 3_000_000;
const LOT_RATIO = 0.9;
const STOP_LOSS_PERCENT = 0.5;
const TAKE_PROFIT_PERCENT = 1.5;
const MARGIN_CAPITAL = 3_000_000;
const MARGIN_MULTIPLIER = 3.3;
const MARGIN_USAGE_LIMIT = 0.9;
const MAX_TOTAL_EXPOSURE = MARGIN_CAPITAL * MARGIN_MULTIPLIER * MARGIN_USAGE_LIMIT;
const MARKET_CLOSE_TIME = "15:30";
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
const BOARD_SCORE_THRESHOLD = 1;
const BOARD_EARLY_EXIT_MIN_PROFIT_PCT = 0.05;
const ROUND_LEVEL_CONFIRM_BARS = 5;
const ALLOWED_SYMBOLS = new Set(TARGET_STOCKS.map(s => s.symbol));

// ============================================================
// 型定義
// ============================================================
interface RtCandleRow {
  symbol: string; tradeDate: string; candleTime: string;
  open: number; high: number; low: number; close: number; volume: number;
  boardSnapshot: BoardSnapshot | null;
}
interface OpenPosition { symbol: string; side: "long" | "short"; entryPrice: number; shares: number; entryTime: string; entryReason: string; }
interface Trade { symbol: string; symbolName: string; action: string; price: number; shares: number; pnl: number | null; reason: string; tradeTime: string; side: "long" | "short"; tradeDate: string; }

// ============================================================
// ヘルパー
// ============================================================
function calcShares(price: number): number { return Math.max(100, Math.floor(Math.floor(INITIAL_CAPITAL_PER_STOCK * LOT_RATIO / price) / 100) * 100); }
function timeToMinutes(t: string): number { const [h, m] = t.split(":").map(Number); return h * 60 + m; }
function checkVolumeUnavailable(buffer: CandleWithSignal[]): boolean { if (buffer.length < 10) return false; const lb = Math.min(buffer.length, 20); const rc = buffer.slice(-lb); return (rc.filter(c => c.volume === 0).length / lb) >= VOLUME_UNAVAILABLE_RATIO; }
function getStockName(sym: string): string { return TARGET_STOCKS.find(s => s.symbol === sym)?.name ?? sym; }
function calcCurrentExposure(op: Map<string, OpenPosition>): number { let t = 0; for (const p of op.values()) t += p.entryPrice * p.shares; return t; }

// ============================================================
// 板読みスコア（現行版）
// ============================================================
function boardReadingScore(bprHistoryArr: number[], side: "long" | "short", snapshot: BoardSnapshot | null): number {
  if (!snapshot) return 1;
  let score = 0;
  const bpr = snapshot.buyPressureRatio;
  if (snapshot.marketOrderRatio >= 0.08) {
    if (side === "long" && bpr > 1.0) score += 2;
    else if (side === "long" && bpr < 1.0) score -= 2;
    else if (side === "short" && bpr < 1.0) score += 2;
    else if (side === "short" && bpr > 1.0) score -= 2;
  }
  if (side === "long") { if (snapshot.largeSellWall) score += 1; if (snapshot.largeBuyWall) score -= 1; }
  else { if (snapshot.largeBuyWall) score += 1; if (snapshot.largeSellWall) score -= 1; }
  if (bprHistoryArr.length >= 3) {
    const delta = bprHistoryArr[bprHistoryArr.length - 1] - bprHistoryArr[0];
    if (side === "long" && delta >= 0.15) score += 1;
    else if (side === "long" && delta <= -0.15) score -= 1;
    else if (side === "short" && delta <= -0.15) score += 1;
    else if (side === "short" && delta >= 0.15) score -= 1;
  }
  const mode = detectMarketMode(bprHistoryArr, snapshot);
  if (mode === "active" || mode === "building") score += 1;
  else if (mode === "trap" || mode === "quiet") score -= 2;
  if (side === "long" && bpr >= 1.4) score += 1;
  else if (side === "long" && bpr <= 0.65) score -= 1;
  else if (side === "short" && bpr <= 0.65) score += 1;
  else if (side === "short" && bpr >= 1.4) score -= 1;
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

// ============================================================
// simulate（1日分）- 現行版ロジック
// ============================================================
function simulate(candles: RtCandleRow[]): { totalPnl: number; winCount: number; lossCount: number; trades: Trade[] } {
  const tradeDate = candles[0]?.tradeDate ?? "unknown";
  for (const c of candles) { c.open = Number(c.open); c.high = Number(c.high); c.low = Number(c.low); c.close = Number(c.close); c.volume = Number(c.volume); if (typeof c.boardSnapshot === 'string') c.boardSnapshot = JSON.parse(c.boardSnapshot as any); }
  
  const sorted = candles.filter(c => ALLOWED_SYMBOLS.has(c.symbol)).filter(c => !(c.candleTime >= "11:30" && c.candleTime < "12:30"))
    .sort((a, b) => a.candleTime < b.candleTime ? -1 : a.candleTime > b.candleTime ? 1 : a.symbol < b.symbol ? -1 : 1);
  const bySymbol = new Map<string, RtCandleRow[]>();
  for (const c of sorted) { if (!bySymbol.has(c.symbol)) bySymbol.set(c.symbol, []); bySymbol.get(c.symbol)!.push(c); }

  const buffers = new Map<string, CandleWithSignal[]>();
  const openPositions = new Map<string, OpenPosition>();
  const pullbackStates = new Map<string, any>();
  const roundLevelPendingStates = new Map<string, any>();
  const roundPullbackStates = new Map<string, any>();
  const bprHistories = new Map<string, number[]>();
  const lastStopLossTime = new Map<string, string>();
  const allTrades: Trade[] = [];
  let totalPnl = 0, winCount = 0, lossCount = 0;

  for (const candle of sorted) {
    const { symbol, candleTime, open, high, low, close, volume, boardSnapshot } = candle;
    if (!buffers.has(symbol)) buffers.set(symbol, []);
    const buffer = buffers.get(symbol)!;
    if (boardSnapshot) { const h = bprHistories.get(symbol) ?? []; h.push(boardSnapshot.buyPressureRatio); if (h.length > 5) h.shift(); bprHistories.set(symbol, h); }
    const c4s: CandleWithSignal = { time: `${tradeDate}T${candleTime}:00`, dayKey: tradeDate, timestamp: new Date(`${tradeDate}T${candleTime}:00+09:00`).getTime(), open, high, low, close, volume, ma5: null, ma25: null, rsi: null, bbUpper: null, bbMiddle: null, bbLower: null };
    buffer.push(c4s);
    const closes = buffer.map(c => c.close);
    const li = buffer.length - 1;
    const ma5S = calcMA(closes, 5); const ma25S = calcMA(closes, 25); const rsiS = calcRSI(closes, 14); const bbS = calcBollinger(closes, 20);
    buffer[li].ma5 = ma5S[li]; buffer[li].ma25 = ma25S[li]; buffer[li].rsi = rsiS[li]; buffer[li].bbUpper = bbS.upper[li]; buffer[li].bbMiddle = bbS.middle[li]; buffer[li].bbLower = bbS.lower[li];

    // 決済チェック
    const existingPos = openPositions.get(symbol);
    if (existingPos) {
      const { entryPrice, shares, side } = existingPos;
      if (candleTime >= MARKET_CLOSE_TIME) {
        const pnl = side === "long" ? (close - entryPrice) * shares : (entryPrice - close) * shares;
        totalPnl += pnl; if (pnl > 0) winCount++; else lossCount++;
        allTrades.push({ symbol, symbolName: getStockName(symbol), action: "forced_close", price: close, shares, pnl, reason: "大引け強制決済", tradeTime: candleTime, side, tradeDate });
        openPositions.delete(symbol); continue;
      }
      let exitPrice: number | null = null, exitReason = "", exitAction = "exit";
      if (side === "long") {
        const sl = entryPrice * (1 - STOP_LOSS_PERCENT / 100); const tp = entryPrice * (1 + TAKE_PROFIT_PERCENT / 100);
        if (low <= sl) { exitPrice = sl; exitReason = "損切り"; exitAction = "stop_loss"; }
        else if (high >= tp) { exitPrice = tp; exitReason = "利確"; exitAction = "take_profit"; }
      } else {
        const sl = entryPrice * (1 + STOP_LOSS_PERCENT / 100); const tp = entryPrice * (1 - TAKE_PROFIT_PERCENT / 100);
        if (high >= sl) { exitPrice = sl; exitReason = "損切り"; exitAction = "stop_loss"; }
        else if (low <= tp) { exitPrice = tp; exitReason = "利確"; exitAction = "take_profit"; }
      }
      if (exitPrice === null && buffer.length >= MIN_CANDLES_FOR_SIGNAL) {
        const ws = detectSignals(buffer); const latest = ws[ws.length - 1]; buffer[buffer.length - 1] = latest;
        if (latest.signal) {
          if (side === "long" && latest.signal.type === "sell") { exitPrice = close; exitReason = "シグナル反転決済"; }
          else if (side === "short" && latest.signal.type === "buy") { exitPrice = close; exitReason = "シグナル反転決済"; }
        }
      }
      if (exitPrice === null && shouldBoardEarlyExit(existingPos, close, boardSnapshot)) { exitPrice = close; exitReason = "板読み早期利確"; exitAction = "take_profit"; }
      if (exitPrice !== null) {
        const pnl = side === "long" ? (exitPrice - entryPrice) * shares : (entryPrice - exitPrice) * shares;
        totalPnl += pnl; if (pnl > 0) winCount++; else lossCount++;
        allTrades.push({ symbol, symbolName: getStockName(symbol), action: exitAction, price: exitPrice, shares, pnl, reason: exitReason, tradeTime: candleTime, side, tradeDate });
        openPositions.delete(symbol); if (exitAction === "stop_loss") lastStopLossTime.set(symbol, candleTime); continue;
      }
      continue;
    }

    // エントリー禁止時間帯
    if (candleTime < NO_ENTRY_BEFORE || candleTime >= NO_ENTRY_AFTER) continue;
    if (buffer.length < MIN_CANDLES_FOR_SIGNAL) continue;

    // シグナル検出
    const withSignals = detectSignals(buffer); const latestSignal = withSignals[withSignals.length - 1]; buffer[buffer.length - 1] = latestSignal;

    // HybridAフィルター
    const firstCandle = buffer[0]; const priceChangeRatio = (close - firstCandle.open) / firstCandle.open * 100; const isBullish = priceChangeRatio >= 0.2;

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
          const brScore = boardReadingScore(bprHistories.get(symbol) ?? [], "long", boardSnapshot);
          if (brScore < BOARD_SCORE_THRESHOLD) continue;
          const shares = calcShares(close); const amount = close * shares;
          if (buffer.length >= ATR_FILTER_PERIOD + 1) { const h = buffer.map(c => c.high); const l = buffer.map(c => c.low); const cl = buffer.map(c => c.close); const atr = calcATR(h, l, cl, ATR_FILTER_PERIOD); if (atr[atr.length-1] !== null && close > 0 && (atr[atr.length-1]! / close) < ATR_FILTER_THRESHOLD) continue; }
          if (calcCurrentExposure(openPositions) + amount > MAX_TOTAL_EXPOSURE) continue;
          if (checkVolumeUnavailable(buffer)) continue;
          const lastSL = lastStopLossTime.get(symbol); if (lastSL && timeToMinutes(candleTime) - timeToMinutes(lastSL) < NO_REENTRY_AFTER_STOPLOSS_MIN) continue;
          openPositions.set(symbol, { symbol, side: "long", entryPrice: close, shares, entryTime: candleTime, entryReason: ps.reason });
          allTrades.push({ symbol, symbolName: getStockName(symbol), action: "buy", price: close, shares, pnl: null, reason: `押し目確認: ${ps.reason}`, tradeTime: candleTime, side: "long", tradeDate });
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
        const brScore = boardReadingScore(bprHistories.get(symbol) ?? [], side, boardSnapshot);
        if (brScore < BOARD_SCORE_THRESHOLD) continue;
        const shares = calcShares(close); const amount = close * shares;
        if (buffer.length >= ATR_FILTER_PERIOD + 1) { const h = buffer.map(c => c.high); const l = buffer.map(c => c.low); const cl = buffer.map(c => c.close); const atr = calcATR(h, l, cl, ATR_FILTER_PERIOD); if (atr[atr.length-1] !== null && close > 0 && (atr[atr.length-1]! / close) < ATR_FILTER_THRESHOLD) continue; }
        if (calcCurrentExposure(openPositions) + amount > MAX_TOTAL_EXPOSURE) continue;
        if (checkVolumeUnavailable(buffer)) continue;
        openPositions.set(symbol, { symbol, side, entryPrice: close, shares, entryTime: candleTime, entryReason: `${rpb.reason} (押し目なし)` });
        allTrades.push({ symbol, symbolName: getStockName(symbol), action: side === "long" ? "buy" : "short", price: close, shares, pnl: null, reason: `${rpb.reason} (押し目なし)`, tradeTime: candleTime, side, tradeDate });
        continue;
      }
      if (rpb.direction === "buy") {
        if (!rpb.pulledBack && close < rpb.signalPrice) rpb.pulledBack = true;
        if (rpb.pulledBack && close > rpb.signalPrice) {
          roundPullbackStates.delete(symbol);
          if (boardSnapshot?.signal === "sell_pressure") continue;
          const brScore = boardReadingScore(bprHistories.get(symbol) ?? [], "long", boardSnapshot);
          if (brScore < BOARD_SCORE_THRESHOLD) continue;
          const shares = calcShares(close); const amount = close * shares;
          if (buffer.length >= ATR_FILTER_PERIOD + 1) { const h = buffer.map(c => c.high); const l = buffer.map(c => c.low); const cl = buffer.map(c => c.close); const atr = calcATR(h, l, cl, ATR_FILTER_PERIOD); if (atr[atr.length-1] !== null && close > 0 && (atr[atr.length-1]! / close) < ATR_FILTER_THRESHOLD) continue; }
          if (calcCurrentExposure(openPositions) + amount > MAX_TOTAL_EXPOSURE) continue;
          openPositions.set(symbol, { symbol, side: "long", entryPrice: close, shares, entryTime: candleTime, entryReason: `${rpb.reason} (押し目確認後)` });
          allTrades.push({ symbol, symbolName: getStockName(symbol), action: "buy", price: close, shares, pnl: null, reason: `${rpb.reason} (押し目確認後)`, tradeTime: candleTime, side: "long", tradeDate });
          continue;
        }
      } else {
        if (!rpb.pulledBack && close > rpb.signalPrice) rpb.pulledBack = true;
        if (rpb.pulledBack && close < rpb.signalPrice) {
          roundPullbackStates.delete(symbol);
          if (boardSnapshot?.signal === "buy_pressure") continue;
          const brScore = boardReadingScore(bprHistories.get(symbol) ?? [], "short", boardSnapshot);
          if (brScore < BOARD_SCORE_THRESHOLD) continue;
          const shares = calcShares(close); const amount = close * shares;
          if (buffer.length >= ATR_FILTER_PERIOD + 1) { const h = buffer.map(c => c.high); const l = buffer.map(c => c.low); const cl = buffer.map(c => c.close); const atr = calcATR(h, l, cl, ATR_FILTER_PERIOD); if (atr[atr.length-1] !== null && close > 0 && (atr[atr.length-1]! / close) < ATR_FILTER_THRESHOLD) continue; }
          if (calcCurrentExposure(openPositions) + amount > MAX_TOTAL_EXPOSURE) continue;
          openPositions.set(symbol, { symbol, side: "short", entryPrice: close, shares, entryTime: candleTime, entryReason: `${rpb.reason} (押し目確認後)` });
          allTrades.push({ symbol, symbolName: getStockName(symbol), action: "short", price: close, shares, pnl: null, reason: `${rpb.reason} (押し目確認後)`, tradeTime: candleTime, side: "short", tradeDate });
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
      const brScore = boardReadingScore(bprHistories.get(symbol) ?? [], "long", boardSnapshot);
      if (brScore < BOARD_SCORE_THRESHOLD) continue;
      if (sig.reason?.startsWith("ダウ理論: 直近高値更新") && sig.recentSwingLow != null) {
        const htf = getHigherTfTrend(buffer, buffer.length - 1, 5);
        if (htf === "up" && buffer.length >= PULLBACK_DEPTH_LOOKBACK) {
          const lw = buffer.slice(-PULLBACK_DEPTH_LOOKBACK); const sh = Math.max(...lw.map(c => c.high)); const sl = Math.min(...lw.map(c => c.low));
          if (sh > sl) { const pd = (sh - close) / (sh - sl); if (pd >= PULLBACK_DEPTH_MIN && pd <= PULLBACK_DEPTH_MAX) pullbackStates.set(symbol, { recentSwingLow: sig.recentSwingLow, signalPrice: close, waitCount: 0, pulledBack: false, reason: sig.reason }); }
        }
      } else if (sig.reason?.startsWith("大台超え")) {
        const m = sig.reason.match(/(\d+(?:\.\d+)?)円/); const level = m ? parseFloat(m[1]) : close;
        roundLevelPendingStates.set(symbol, { direction: "buy", level, confirmCount: 0, reason: sig.reason });
      } else {
        const shares = calcShares(close); const amount = close * shares; let canEntry = true;
        if (buffer.length >= ATR_FILTER_PERIOD + 1) { const h = buffer.map(c => c.high); const l = buffer.map(c => c.low); const cl = buffer.map(c => c.close); const atr = calcATR(h, l, cl, ATR_FILTER_PERIOD); if (atr[atr.length-1] !== null && close > 0 && (atr[atr.length-1]! / close) < ATR_FILTER_THRESHOLD) canEntry = false; }
        if (calcCurrentExposure(openPositions) + amount > MAX_TOTAL_EXPOSURE) canEntry = false;
        if (checkVolumeUnavailable(buffer)) canEntry = false;
        const lastSL = lastStopLossTime.get(symbol); if (lastSL && timeToMinutes(candleTime) - timeToMinutes(lastSL) < NO_REENTRY_AFTER_STOPLOSS_MIN) canEntry = false;
        if (canEntry) { openPositions.set(symbol, { symbol, side: "long", entryPrice: close, shares, entryTime: candleTime, entryReason: sig.reason }); allTrades.push({ symbol, symbolName: getStockName(symbol), action: "buy", price: close, shares, pnl: null, reason: sig.reason, tradeTime: candleTime, side: "long", tradeDate }); }
      }
    }

    // 売りエントリー
    if (sig.type === "sell" && !openPositions.has(symbol)) {
      if (isBullish) continue;
      if (boardSnapshot?.signal === "buy_pressure") continue;
      const brScore = boardReadingScore(bprHistories.get(symbol) ?? [], "short", boardSnapshot);
      if (brScore < BOARD_SCORE_THRESHOLD) continue;
      if (sig.reason?.startsWith("ダウ理論: 直近安値更新")) {
        const htf = getHigherTfTrend(buffer, buffer.length - 1, 5);
        if (htf !== "down") continue;
        if (buffer.length >= PULLBACK_DEPTH_LOOKBACK) { const lw = buffer.slice(-PULLBACK_DEPTH_LOOKBACK); const sh = Math.max(...lw.map(c => c.high)); const sl = Math.min(...lw.map(c => c.low)); if (sh > sl) { const pd = (close - sl) / (sh - sl); if (pd < PULLBACK_DEPTH_MIN || pd > PULLBACK_DEPTH_MAX) continue; } }
      } else if (sig.reason?.startsWith("大台割れ")) {
        const m = sig.reason.match(/(\d+(?:\.\d+)?)円/); const level = m ? parseFloat(m[1]) : close;
        roundLevelPendingStates.set(symbol, { direction: "sell", level, confirmCount: 0, reason: sig.reason });
      } else {
        const shares = calcShares(close); const amount = close * shares; let canEntry = true;
        if (buffer.length >= ATR_FILTER_PERIOD + 1) { const h = buffer.map(c => c.high); const l = buffer.map(c => c.low); const cl = buffer.map(c => c.close); const atr = calcATR(h, l, cl, ATR_FILTER_PERIOD); if (atr[atr.length-1] !== null && close > 0 && (atr[atr.length-1]! / close) < ATR_FILTER_THRESHOLD) canEntry = false; }
        if (calcCurrentExposure(openPositions) + amount > MAX_TOTAL_EXPOSURE) canEntry = false;
        if (checkVolumeUnavailable(buffer)) canEntry = false;
        const lastSL = lastStopLossTime.get(symbol); if (lastSL && timeToMinutes(candleTime) - timeToMinutes(lastSL) < NO_REENTRY_AFTER_STOPLOSS_MIN) canEntry = false;
        if (canEntry) { openPositions.set(symbol, { symbol, side: "short", entryPrice: close, shares, entryTime: candleTime, entryReason: sig.reason }); allTrades.push({ symbol, symbolName: getStockName(symbol), action: "short", price: close, shares, pnl: null, reason: sig.reason, tradeTime: candleTime, side: "short", tradeDate }); }
      }
    }
  }

  // 残ポジション強制決済
  for (const [symbol, pos] of openPositions.entries()) {
    const sc = bySymbol.get(symbol); if (!sc || sc.length === 0) continue;
    const last = sc[sc.length - 1];
    const pnl = pos.side === "long" ? (last.close - pos.entryPrice) * pos.shares : (pos.entryPrice - last.close) * pos.shares;
    totalPnl += pnl; if (pnl > 0) winCount++; else lossCount++;
    allTrades.push({ symbol, symbolName: getStockName(symbol), action: "forced_close", price: last.close, shares: pos.shares, pnl, reason: "引け強制決済", tradeTime: last.candleTime, side: pos.side, tradeDate });
  }
  return { totalPnl, winCount, lossCount, trades: allTrades };
}

// ============================================================
// 7日分バッチ実行
// ============================================================
const DATA_FILES = [
  "/tmp/rt_candles_20260617.json",
  "/tmp/rt_candles_20260618.json",
  "/tmp/rt_candles_20260619.json",
  "/tmp/rt_candles_20260622.json",
  "/tmp/rt_candles_20260623.json",
  "/tmp/rt_candles_20260624.json",
  "/tmp/rt_candles_20260625.json",
];

console.log("=== 現行版シミュレーション（7営業日） ===");
let grandTotal = 0, grandWin = 0, grandLoss = 0;
const allTrades: Trade[] = [];

for (const f of DATA_FILES) {
  if (!fs.existsSync(f)) { console.log(`SKIP: ${f}`); continue; }
  const candles: RtCandleRow[] = JSON.parse(fs.readFileSync(f, "utf8"));
  if (candles.length === 0) { console.log(`SKIP: ${f} empty`); continue; }
  const tradeDate = candles[0].tradeDate;
  const result = simulate(candles);
  grandTotal += result.totalPnl; grandWin += result.winCount; grandLoss += result.lossCount;
  allTrades.push(...result.trades);
  const exits = result.trades.filter(t => t.pnl !== null);
  console.log(`${tradeDate}: ${result.totalPnl >= 0 ? "+" : ""}${Math.round(result.totalPnl).toLocaleString()}円 (${result.winCount}勝${result.lossCount}敗, ${exits.length}取引)`);
}

console.log("\n=== 7日間サマリー ===");
console.log(`合計損益: ${grandTotal >= 0 ? "+" : ""}${Math.round(grandTotal).toLocaleString()}円`);
console.log(`勝ち: ${grandWin}回, 負け: ${grandLoss}回`);
console.log(`勝率: ${grandWin + grandLoss > 0 ? ((grandWin / (grandWin + grandLoss)) * 100).toFixed(1) : 0}%`);
console.log(`取引回数: ${grandWin + grandLoss}回`);
console.log(`1日平均損益: ${Math.round(grandTotal / 7).toLocaleString()}円`);

// 銘柄別
const bySymPnl = new Map<string, { pnl: number; count: number; win: number; loss: number }>();
for (const t of allTrades) { if (t.pnl === null) continue; const c = bySymPnl.get(t.symbol) ?? { pnl: 0, count: 0, win: 0, loss: 0 }; c.pnl += t.pnl; c.count++; if (t.pnl > 0) c.win++; else c.loss++; bySymPnl.set(t.symbol, c); }
console.log("\n=== 銘柄別損益 ===");
for (const [sym, data] of [...bySymPnl.entries()].sort((a, b) => b[1].pnl - a[1].pnl)) {
  console.log(`${sym} ${getStockName(sym)}: ${data.pnl >= 0 ? "+" : ""}${Math.round(data.pnl).toLocaleString()}円 (${data.win}勝${data.loss}敗)`);
}

// 決済理由別
const byReason = new Map<string, { pnl: number; count: number }>();
for (const t of allTrades) { if (t.pnl === null) continue; let k = t.reason; if (k.includes("損切り")) k = "損切り"; else if (k.includes("利確")) k = "利確"; else if (k.includes("シグナル反転")) k = "シグナル反転決済"; else if (k.includes("強制決済")) k = "大引け強制決済"; const c = byReason.get(k) ?? { pnl: 0, count: 0 }; c.pnl += t.pnl; c.count++; byReason.set(k, c); }
console.log("\n=== 決済理由別 ===");
for (const [r, d] of [...byReason.entries()].sort((a, b) => b[1].pnl - a[1].pnl)) { console.log(`${r}: ${d.pnl >= 0 ? "+" : ""}${Math.round(d.pnl).toLocaleString()}円 (${d.count}回)`); }
