/**
 * sweep_atr_final.ts
 * sim_bc_only.tsのロジックを完全に踏襲し、SL/TPの計算のみをATR連動に変更。
 * パラメータスイープで最適な設定を探索する。
 * 
 * 実行: cd /home/ubuntu/stock-alert-app && npx tsx analysis/sweep_atr_final.ts
 */
import * as fs from "fs";
import { detectSignals, calcMA, calcRSI, calcBollinger, type CandleWithSignal } from "../server/routers/stockData";
import { TARGET_STOCKS } from "../shared/stocks";
import { getHigherTfTrend } from "../server/vwap";
import { calcATR } from "../server/intradayRegime";
import type { BoardSnapshot } from "../drizzle/schema";

// === 固定定数 ===
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
const BOARD_SCORE_THRESHOLD = 1;
const BOARD_EARLY_EXIT_MIN_PROFIT_PCT = 0.05;
const ROUND_LEVEL_CONFIRM_BARS = 5;
const MARKET_CLOSE_TIME = "15:30";
const ALLOWED_SYMBOLS = new Set(TARGET_STOCKS.map(s => s.symbol));

// === ATR SL/TP パラメータ ===
interface AtrSlParams {
  atrPeriod: number;       // ATR計算期間（30本=30分）
  atrMultiplier: number;   // ATR係数
  minSl: number;           // 最小SL%
  maxSl: number;           // 最大SL%
  rrRatio: number;         // リスクリワード比（0=TP固定1.5%）
  fixedTp: number;         // TP固定値（rrRatio=0の場合に使用）
  label: string;
}

// === 型定義 ===
interface RtCandleRow { symbol: string; tradeDate: string; candleTime: string; open: number; high: number; low: number; close: number; volume: number; boardSnapshot: BoardSnapshot | null; }
interface OpenPosition { symbol: string; side: "long" | "short"; entryPrice: number; shares: number; entryTime: string; entryReason: string; slPct: number; tpPct: number; }
interface Trade { date: string; time: string; sym: string; action: string; price: number; pnl?: number; reason: string; shares: number; }

// === ヘルパー ===
function calcShares(price: number): number { return Math.max(100, Math.floor(Math.floor(INITIAL_CAPITAL_PER_STOCK * LOT_RATIO / price) / 100) * 100); }
function timeToMinutes(t: string): number { const [h, m] = t.split(":").map(Number); return h * 60 + m; }
function checkVolumeUnavailable(buffer: CandleWithSignal[]): boolean { if (buffer.length < 10) return false; const lb = Math.min(buffer.length, 20); const rc = buffer.slice(-lb); return (rc.filter(c => c.volume === 0).length / lb) >= VOLUME_UNAVAILABLE_RATIO; }
function calcCurrentExposure(op: Map<string, OpenPosition>): number { let t = 0; for (const p of op.values()) t += p.entryPrice * p.shares; return t; }

// ATR連動SL/TP計算
function calcDynamicSlTp(buffer: CandleWithSignal[], close: number, params: AtrSlParams): { slPct: number; tpPct: number } {
  if (buffer.length < params.atrPeriod + 1) {
    // バッファ不足時はデフォルト
    const sl = Math.max(params.minSl, Math.min(params.maxSl, 0.5));
    const tp = params.rrRatio > 0 ? sl * params.rrRatio : params.fixedTp;
    return { slPct: sl, tpPct: tp };
  }
  const h = buffer.map(c => c.high);
  const l = buffer.map(c => c.low);
  const cl = buffer.map(c => c.close);
  const atr = calcATR(h, l, cl, params.atrPeriod);
  const latestATR = atr[atr.length - 1];
  if (latestATR === null || close <= 0) {
    const sl = Math.max(params.minSl, Math.min(params.maxSl, 0.5));
    const tp = params.rrRatio > 0 ? sl * params.rrRatio : params.fixedTp;
    return { slPct: sl, tpPct: tp };
  }
  const atrPct = (latestATR / close) * 100 * params.atrMultiplier;
  const slPct = Math.max(params.minSl, Math.min(params.maxSl, atrPct));
  const tpPct = params.rrRatio > 0 ? slPct * params.rrRatio : params.fixedTp;
  return { slPct, tpPct };
}

// 板読みスコア（改良案B・C適用版）
function boardReadingScoreBC(bprHistoryArr: number[], side: "long" | "short", snapshot: BoardSnapshot | null): number {
  if (!snapshot) return 1;
  let score = 0;
  const bpr = snapshot.buyPressureRatio;
  if (side === "long") { if (bpr > 1.2) score += 2; else if (bpr > 1.0) score += 1; else if (bpr < 0.8) score -= 2; else if (bpr < 1.0) score -= 1; }
  else { if (bpr < 0.8) score += 2; else if (bpr < 1.0) score += 1; else if (bpr > 1.2) score -= 2; else if (bpr > 1.0) score -= 1; }
  const signal = snapshot.signal;
  if (side === "long") { if (signal === "buy_pressure") score += 2; else if (signal === "sell_pressure") score -= 2; else if (signal === "trap") score -= 1; }
  else { if (signal === "sell_pressure") score += 2; else if (signal === "buy_pressure") score -= 2; else if (signal === "trap") score -= 1; }
  if (bprHistoryArr.length >= 3) { const recent = bprHistoryArr.slice(-3); const trend = recent[2] - recent[0]; if (side === "long" && trend > 0.1) score += 1; else if (side === "long" && trend < -0.1) score -= 1; if (side === "short" && trend < -0.1) score += 1; else if (side === "short" && trend > 0.1) score -= 1; }
  // 改良案B: 歩み値方向推定
  const mod = (snapshot as any).marketOrderDirection;
  if (mod) { if (side === "long" && mod === "buy") score += 2; else if (side === "long" && mod === "sell") score -= 2; if (side === "short" && mod === "sell") score += 2; else if (side === "short" && mod === "buy") score -= 2; }
  else if (bprHistoryArr.length >= 3) { const r3 = bprHistoryArr.slice(-3); const bprTrend = r3[2] - r3[0]; if (Math.abs(bprTrend) >= 0.2) { if (side === "long" && bprTrend > 0) score += 1; else if (side === "long" && bprTrend < 0) score -= 1; if (side === "short" && bprTrend < 0) score += 1; else if (side === "short" && bprTrend > 0) score -= 1; } if (bpr >= 1.3 && side === "long") score += 1; if (bpr <= 0.7 && side === "short") score += 1; }
  // 改良案C: 見せ板検出
  const snap = snapshot as any;
  if (snap.askCancelDetected || snap.bidCancelDetected) score -= 2;
  if (snap.icebergAskDetected) { if (side === "short") score += 1; else score -= 1; }
  if (snap.icebergBidDetected) { if (side === "long") score += 1; else score -= 1; }
  return score;
}

function shouldBoardEarlyExit(pos: OpenPosition, currentPrice: number, snapshot: BoardSnapshot | null): boolean {
  if (!snapshot) return false;
  const profitPct = pos.side === "long" ? (currentPrice - pos.entryPrice) / pos.entryPrice * 100 : (pos.entryPrice - currentPrice) / pos.entryPrice * 100;
  if (profitPct < BOARD_EARLY_EXIT_MIN_PROFIT_PCT) return false;
  const bpr = snapshot.buyPressureRatio;
  if (pos.side === "long" && bpr < 0.7 && snapshot.signal === "sell_pressure") return true;
  if (pos.side === "short" && bpr > 1.3 && snapshot.signal === "buy_pressure") return true;
  return false;
}

// === シミュレーション関数 ===
function simulateDay(dayData: RtCandleRow[], params: AtrSlParams): { trades: Trade[]; totalPnl: number; slPcts: number[] } {
  const buffers = new Map<string, CandleWithSignal[]>();
  const openPositions = new Map<string, OpenPosition>();
  const pullbackStates = new Map<string, any>();
  const roundLevelPendingStates = new Map<string, any>();
  const roundPullbackStates = new Map<string, any>();
  const bprHistories = new Map<string, number[]>();
  const prevSnapshots = new Map<string, BoardSnapshot | null>();
  const lastStopLossTime = new Map<string, string>();
  const trades: Trade[] = [];
  const slPcts: number[] = [];
  let totalPnl = 0;

  const sorted = dayData
    .filter(c => ALLOWED_SYMBOLS.has(c.symbol))
    .filter(c => !(c.candleTime >= "11:30" && c.candleTime < "12:30"))
    .sort((a, b) => a.candleTime < b.candleTime ? -1 : a.candleTime > b.candleTime ? 1 : a.symbol < b.symbol ? -1 : 1);

  for (const candle of sorted) {
    const { symbol, candleTime, open, high, low, close, volume, boardSnapshot } = candle;
    const tradeDate = candle.tradeDate;
    if (!buffers.has(symbol)) buffers.set(symbol, []);
    const buffer = buffers.get(symbol)!;
    const prevSnap = prevSnapshots.get(symbol) ?? null;
    if (boardSnapshot) { const h = bprHistories.get(symbol) ?? []; h.push(boardSnapshot.buyPressureRatio); if (h.length > 5) h.shift(); bprHistories.set(symbol, h); prevSnapshots.set(symbol, boardSnapshot); }
    const c4s: CandleWithSignal = { time: `${tradeDate}T${candleTime}:00`, dayKey: tradeDate, timestamp: new Date(`${tradeDate}T${candleTime}:00+09:00`).getTime(), open, high, low, close, volume, ma5: null, ma25: null, rsi: null, bbUpper: null, bbMiddle: null, bbLower: null };
    buffer.push(c4s);
    const closes = buffer.map(c => c.close); const li = buffer.length - 1;
    const ma5S = calcMA(closes, 5); const ma25S = calcMA(closes, 25); const rsiS = calcRSI(closes, 14); const bbS = calcBollinger(closes, 20);
    buffer[li].ma5 = ma5S[li]; buffer[li].ma25 = ma25S[li]; buffer[li].rsi = rsiS[li]; buffer[li].bbUpper = bbS.upper[li]; buffer[li].bbMiddle = bbS.middle[li]; buffer[li].bbLower = bbS.lower[li];

    // 決済チェック（ATR連動SL/TP使用）
    const existingPos = openPositions.get(symbol);
    if (existingPos) {
      const { entryPrice, shares, side, slPct, tpPct } = existingPos;
      if (candleTime >= MARKET_CLOSE_TIME) {
        const pnl = side === "long" ? (close - entryPrice) * shares : (entryPrice - close) * shares;
        totalPnl += pnl; trades.push({ date: tradeDate, time: candleTime, sym: symbol, action: "forced_close", price: close, pnl, reason: "大引け強制決済", shares });
        openPositions.delete(symbol); continue;
      }
      let exitPrice: number | null = null, exitReason = "";
      if (side === "long") {
        const sl = entryPrice * (1 - slPct / 100); const tp = entryPrice * (1 + tpPct / 100);
        if (low <= sl) { exitPrice = sl; exitReason = "損切り"; } else if (high >= tp) { exitPrice = tp; exitReason = "利確"; }
      } else {
        const sl = entryPrice * (1 + slPct / 100); const tp = entryPrice * (1 - tpPct / 100);
        if (high >= sl) { exitPrice = sl; exitReason = "損切り"; } else if (low <= tp) { exitPrice = tp; exitReason = "利確"; }
      }
      if (exitPrice === null && buffer.length >= MIN_CANDLES_FOR_SIGNAL) {
        const ws = detectSignals(buffer); const latest = ws[ws.length - 1]; buffer[buffer.length - 1] = latest;
        if (latest.signal) { if (side === "long" && latest.signal.type === "sell") { exitPrice = close; exitReason = "シグナル反転"; } else if (side === "short" && latest.signal.type === "buy") { exitPrice = close; exitReason = "シグナル反転"; } }
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

    // ステートマシン: pullbackStates
    const ps = pullbackStates.get(symbol);
    if (ps) {
      ps.waitCount++;
      if (low < ps.recentSwingLow || ps.waitCount > PULLBACK_MAX_WAIT) { pullbackStates.delete(symbol); }
      else { if (!ps.pulledBack && close < ps.signalPrice) ps.pulledBack = true; if (ps.pulledBack && close > ps.signalPrice) { pullbackStates.delete(symbol); if (boardSnapshot?.signal === "sell_pressure") { continue; } const brScore = getBoardScore("long"); if (brScore < BOARD_SCORE_THRESHOLD) { continue; } const shares = calcShares(close); const amount = close * shares; if (buffer.length >= ATR_FILTER_PERIOD + 1) { const h2 = buffer.map(c => c.high); const l2 = buffer.map(c => c.low); const cl2 = buffer.map(c => c.close); const atr2 = calcATR(h2, l2, cl2, ATR_FILTER_PERIOD); if (atr2[atr2.length-1] !== null && close > 0 && (atr2[atr2.length-1]! / close) < ATR_FILTER_THRESHOLD) { continue; } } if (calcCurrentExposure(openPositions) + amount > MAX_TOTAL_EXPOSURE) { continue; } if (checkVolumeUnavailable(buffer)) { continue; } const { slPct, tpPct } = calcDynamicSlTp(buffer, close, params); slPcts.push(slPct); openPositions.set(symbol, { symbol, side: "long", entryPrice: close, shares, entryTime: candleTime, entryReason: ps.reason, slPct, tpPct }); trades.push({ date: tradeDate, time: candleTime, sym: symbol, action: "buy", price: close, reason: ps.reason, shares }); } }
      continue;
    }

    // ステートマシン: roundLevelPendingStates
    const rp = roundLevelPendingStates.get(symbol);
    if (rp) {
      if (openPositions.has(symbol)) { roundLevelPendingStates.delete(symbol); }
      else { const valid = rp.direction === "buy" ? close >= rp.level : close <= rp.level; if (valid) { rp.confirmCount++; if (rp.confirmCount >= ROUND_LEVEL_CONFIRM_BARS) { roundLevelPendingStates.delete(symbol); roundPullbackStates.set(symbol, { ...rp, signalPrice: close, waitCount: 0, pulledBack: false }); } } else { roundLevelPendingStates.delete(symbol); } continue; }
    }

    // ステートマシン: roundPullbackStates（大台超え/割れ→押し目確認）
    const rpb = roundPullbackStates.get(symbol);
    if (rpb) {
      rpb.waitCount++; const side: "long" | "short" = rpb.direction === "buy" ? "long" : "short";
      if ((rpb.direction === "buy" && close < rpb.level) || (rpb.direction === "sell" && close > rpb.level)) { roundPullbackStates.delete(symbol); continue; }
      if (rpb.waitCount > ROUND_PULLBACK_MAX_WAIT) {
        roundPullbackStates.delete(symbol);
        if (boardSnapshot && side === "long" && boardSnapshot.signal === "sell_pressure") { continue; }
        if (boardSnapshot && side === "short" && boardSnapshot.signal === "buy_pressure") { continue; }
        const brScore = getBoardScore(side); if (brScore < BOARD_SCORE_THRESHOLD) { continue; }
        const shares = calcShares(close); const amount = close * shares;
        if (buffer.length >= ATR_FILTER_PERIOD + 1) { const h2 = buffer.map(c => c.high); const l2 = buffer.map(c => c.low); const cl2 = buffer.map(c => c.close); const atr2 = calcATR(h2, l2, cl2, ATR_FILTER_PERIOD); if (atr2[atr2.length-1] !== null && close > 0 && (atr2[atr2.length-1]! / close) < ATR_FILTER_THRESHOLD) { continue; } }
        if (calcCurrentExposure(openPositions) + amount > MAX_TOTAL_EXPOSURE) { continue; }
        const { slPct, tpPct } = calcDynamicSlTp(buffer, close, params); slPcts.push(slPct);
        openPositions.set(symbol, { symbol, side, entryPrice: close, shares, entryTime: candleTime, entryReason: `${rpb.reason} (押し目なし)`, slPct, tpPct });
        trades.push({ date: tradeDate, time: candleTime, sym: symbol, action: side === "long" ? "buy" : "short", price: close, reason: `${rpb.reason} (押し目なし)`, shares });
        continue;
      }
      if (rpb.direction === "buy") {
        if (!rpb.pulledBack && close < rpb.signalPrice) rpb.pulledBack = true;
        if (rpb.pulledBack && close > rpb.signalPrice) {
          roundPullbackStates.delete(symbol);
          if (boardSnapshot?.signal === "sell_pressure") continue;
          const brScore = getBoardScore("long"); if (brScore < BOARD_SCORE_THRESHOLD) continue;
          const shares = calcShares(close); const amount = close * shares;
          if (buffer.length >= ATR_FILTER_PERIOD + 1) { const h2 = buffer.map(c => c.high); const l2 = buffer.map(c => c.low); const cl2 = buffer.map(c => c.close); const atr2 = calcATR(h2, l2, cl2, ATR_FILTER_PERIOD); if (atr2[atr2.length-1] !== null && close > 0 && (atr2[atr2.length-1]! / close) < ATR_FILTER_THRESHOLD) continue; }
          if (calcCurrentExposure(openPositions) + amount > MAX_TOTAL_EXPOSURE) continue;
          const { slPct, tpPct } = calcDynamicSlTp(buffer, close, params); slPcts.push(slPct);
          openPositions.set(symbol, { symbol, side: "long", entryPrice: close, shares, entryTime: candleTime, entryReason: `${rpb.reason} (押し目確認後)`, slPct, tpPct });
          trades.push({ date: tradeDate, time: candleTime, sym: symbol, action: "buy", price: close, reason: `${rpb.reason} (押し目確認後)`, shares });
          continue;
        }
      } else {
        if (!rpb.pulledBack && close > rpb.signalPrice) rpb.pulledBack = true;
        if (rpb.pulledBack && close < rpb.signalPrice) {
          roundPullbackStates.delete(symbol);
          if (boardSnapshot?.signal === "buy_pressure") continue;
          const brScore = getBoardScore("short"); if (brScore < BOARD_SCORE_THRESHOLD) continue;
          const shares = calcShares(close); const amount = close * shares;
          if (buffer.length >= ATR_FILTER_PERIOD + 1) { const h2 = buffer.map(c => c.high); const l2 = buffer.map(c => c.low); const cl2 = buffer.map(c => c.close); const atr2 = calcATR(h2, l2, cl2, ATR_FILTER_PERIOD); if (atr2[atr2.length-1] !== null && close > 0 && (atr2[atr2.length-1]! / close) < ATR_FILTER_THRESHOLD) continue; }
          if (calcCurrentExposure(openPositions) + amount > MAX_TOTAL_EXPOSURE) continue;
          const { slPct, tpPct } = calcDynamicSlTp(buffer, close, params); slPcts.push(slPct);
          openPositions.set(symbol, { symbol, side: "short", entryPrice: close, shares, entryTime: candleTime, entryReason: `${rpb.reason} (押し目確認後)`, slPct, tpPct });
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
      const brScore = getBoardScore("long"); if (brScore < BOARD_SCORE_THRESHOLD) continue;
      if (sig.reason?.startsWith("ダウ理論: 直近高値更新") && sig.recentSwingLow != null) {
        const htf = getHigherTfTrend(buffer, buffer.length - 1, 5);
        if (htf === "up" && buffer.length >= PULLBACK_DEPTH_LOOKBACK) { const lw = buffer.slice(-PULLBACK_DEPTH_LOOKBACK); const sh = Math.max(...lw.map(c => c.high)); const sl2 = Math.min(...lw.map(c => c.low)); if (sh > sl2) { const pd = (sh - close) / (sh - sl2); if (pd >= PULLBACK_DEPTH_MIN && pd <= PULLBACK_DEPTH_MAX) { pullbackStates.set(symbol, { recentSwingLow: sig.recentSwingLow, signalPrice: close, waitCount: 0, pulledBack: false, reason: sig.reason }); } } }
      } else if (sig.reason?.startsWith("大台超え")) {
        const m = sig.reason.match(/(\d+(?:\.\d+)?)円/); const level = m ? parseFloat(m[1]) : close;
        roundLevelPendingStates.set(symbol, { direction: "buy", level, confirmCount: 0, reason: sig.reason });
      } else {
        const shares = calcShares(close); const amount = close * shares;
        if (buffer.length >= ATR_FILTER_PERIOD + 1) { const h2 = buffer.map(c => c.high); const l2 = buffer.map(c => c.low); const cl2 = buffer.map(c => c.close); const atr2 = calcATR(h2, l2, cl2, ATR_FILTER_PERIOD); if (atr2[atr2.length-1] !== null && close > 0 && (atr2[atr2.length-1]! / close) < ATR_FILTER_THRESHOLD) continue; }
        if (calcCurrentExposure(openPositions) + amount > MAX_TOTAL_EXPOSURE) continue;
        if (checkVolumeUnavailable(buffer)) continue;
        const lastSL = lastStopLossTime.get(symbol); if (lastSL && timeToMinutes(candleTime) - timeToMinutes(lastSL) < NO_REENTRY_AFTER_STOPLOSS_MIN) continue;
        const { slPct, tpPct } = calcDynamicSlTp(buffer, close, params); slPcts.push(slPct);
        openPositions.set(symbol, { symbol, side: "long", entryPrice: close, shares, entryTime: candleTime, entryReason: sig.reason, slPct, tpPct });
        trades.push({ date: tradeDate, time: candleTime, sym: symbol, action: "buy", price: close, reason: sig.reason!, shares });
      }
    }

    // 売りエントリー
    if (sig.type === "sell" && !openPositions.has(symbol)) {
      if (isBullish) continue;
      if (boardSnapshot?.signal === "buy_pressure") continue;
      const brScore = getBoardScore("short"); if (brScore < BOARD_SCORE_THRESHOLD) continue;
      if (sig.reason?.startsWith("ダウ理論: 直近安値更新")) {
        const htf = getHigherTfTrend(buffer, buffer.length - 1, 5);
        if (htf !== "down") continue;
        if (buffer.length >= PULLBACK_DEPTH_LOOKBACK) { const lw = buffer.slice(-PULLBACK_DEPTH_LOOKBACK); const sh = Math.max(...lw.map(c => c.high)); const sl2 = Math.min(...lw.map(c => c.low)); if (sh > sl2) { const pd = (close - sl2) / (sh - sl2); if (pd < PULLBACK_DEPTH_MIN || pd > PULLBACK_DEPTH_MAX) continue; } }
      } else if (sig.reason?.startsWith("大台割れ")) {
        const m = sig.reason.match(/(\d+(?:\.\d+)?)円/); const level = m ? parseFloat(m[1]) : close;
        roundLevelPendingStates.set(symbol, { direction: "sell", level, confirmCount: 0, reason: sig.reason });
        continue;
      }
      const shares = calcShares(close); const amount = close * shares;
      if (buffer.length >= ATR_FILTER_PERIOD + 1) { const h2 = buffer.map(c => c.high); const l2 = buffer.map(c => c.low); const cl2 = buffer.map(c => c.close); const atr2 = calcATR(h2, l2, cl2, ATR_FILTER_PERIOD); if (atr2[atr2.length-1] !== null && close > 0 && (atr2[atr2.length-1]! / close) < ATR_FILTER_THRESHOLD) continue; }
      if (calcCurrentExposure(openPositions) + amount > MAX_TOTAL_EXPOSURE) continue;
      if (checkVolumeUnavailable(buffer)) continue;
      const lastSL = lastStopLossTime.get(symbol); if (lastSL && timeToMinutes(candleTime) - timeToMinutes(lastSL) < NO_REENTRY_AFTER_STOPLOSS_MIN) continue;
      const { slPct, tpPct } = calcDynamicSlTp(buffer, close, params); slPcts.push(slPct);
      openPositions.set(symbol, { symbol, side: "short", entryPrice: close, shares, entryTime: candleTime, entryReason: sig.reason, slPct, tpPct });
      trades.push({ date: tradeDate, time: candleTime, sym: symbol, action: "short", price: close, reason: sig.reason!, shares });
    }
  }

  // 残ポジション強制決済
  for (const [symbol, pos] of openPositions.entries()) {
    const symCandles = sorted.filter(c => c.symbol === symbol);
    const last = symCandles[symCandles.length - 1];
    if (!last) continue;
    const pnl = pos.side === "long" ? (last.close - pos.entryPrice) * pos.shares : (pos.entryPrice - last.close) * pos.shares;
    totalPnl += pnl; trades.push({ date: last.tradeDate, time: last.candleTime, sym: symbol, action: "forced_close", price: last.close, pnl, reason: "データ終了時決済", shares: pos.shares });
  }

  return { trades, totalPnl, slPcts };
}

// === データローダー ===
const DATES = ["2026-06-17", "2026-06-18", "2026-06-19", "2026-06-22", "2026-06-24", "2026-06-25"];
function loadDayData(date: string): RtCandleRow[] {
  const file = `/tmp/rt_candles_${date.replace(/-/g, "")}.json`;
  if (!fs.existsSync(file)) return [];
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const c of raw) { c.open = Number(c.open); c.high = Number(c.high); c.low = Number(c.low); c.close = Number(c.close); c.volume = Number(c.volume); if (typeof c.boardSnapshot === "string") c.boardSnapshot = JSON.parse(c.boardSnapshot); }
  return raw;
}

// === パラメータ定義 ===
const SWEEP_PARAMS: AtrSlParams[] = [
  // ベースライン: 固定SL/TP
  { atrPeriod: 30, atrMultiplier: 0, minSl: 0.5, maxSl: 0.5, rrRatio: 0, fixedTp: 1.5, label: "固定 SL0.5/TP1.5（ベースライン）" },
  
  // パターンA: SLのみATR連動、TP固定1.5%
  { atrPeriod: 30, atrMultiplier: 2.0, minSl: 0.3, maxSl: 0.8, rrRatio: 0, fixedTp: 1.5, label: "ATR×2.0 SL[0.3-0.8] TP固定1.5" },
  { atrPeriod: 30, atrMultiplier: 2.5, minSl: 0.3, maxSl: 0.8, rrRatio: 0, fixedTp: 1.5, label: "ATR×2.5 SL[0.3-0.8] TP固定1.5" },
  { atrPeriod: 30, atrMultiplier: 3.0, minSl: 0.3, maxSl: 0.8, rrRatio: 0, fixedTp: 1.5, label: "ATR×3.0 SL[0.3-0.8] TP固定1.5" },
  { atrPeriod: 30, atrMultiplier: 3.0, minSl: 0.3, maxSl: 1.0, rrRatio: 0, fixedTp: 1.5, label: "ATR×3.0 SL[0.3-1.0] TP固定1.5" },
  { atrPeriod: 30, atrMultiplier: 3.0, minSl: 0.4, maxSl: 1.0, rrRatio: 0, fixedTp: 1.5, label: "ATR×3.0 SL[0.4-1.0] TP固定1.5" },
  { atrPeriod: 30, atrMultiplier: 3.5, minSl: 0.3, maxSl: 1.0, rrRatio: 0, fixedTp: 1.5, label: "ATR×3.5 SL[0.3-1.0] TP固定1.5" },
  
  // パターンB: SL・TP両方ATR連動（RR比2.0）
  { atrPeriod: 30, atrMultiplier: 2.5, minSl: 0.3, maxSl: 0.8, rrRatio: 2.0, fixedTp: 0, label: "ATR×2.5 SL[0.3-0.8] RR2.0" },
  { atrPeriod: 30, atrMultiplier: 3.0, minSl: 0.3, maxSl: 0.8, rrRatio: 2.0, fixedTp: 0, label: "ATR×3.0 SL[0.3-0.8] RR2.0" },
  { atrPeriod: 30, atrMultiplier: 3.0, minSl: 0.3, maxSl: 1.0, rrRatio: 2.0, fixedTp: 0, label: "ATR×3.0 SL[0.3-1.0] RR2.0" },
  
  // パターンC: SL・TP両方ATR連動（RR比2.5）
  { atrPeriod: 30, atrMultiplier: 2.5, minSl: 0.3, maxSl: 0.8, rrRatio: 2.5, fixedTp: 0, label: "ATR×2.5 SL[0.3-0.8] RR2.5" },
  { atrPeriod: 30, atrMultiplier: 3.0, minSl: 0.3, maxSl: 0.8, rrRatio: 2.5, fixedTp: 0, label: "ATR×3.0 SL[0.3-0.8] RR2.5" },
  { atrPeriod: 30, atrMultiplier: 3.0, minSl: 0.3, maxSl: 1.0, rrRatio: 2.5, fixedTp: 0, label: "ATR×3.0 SL[0.3-1.0] RR2.5" },
  
  // パターンD: SL・TP両方ATR連動（RR比3.0）
  { atrPeriod: 30, atrMultiplier: 2.5, minSl: 0.3, maxSl: 0.8, rrRatio: 3.0, fixedTp: 0, label: "ATR×2.5 SL[0.3-0.8] RR3.0" },
  { atrPeriod: 30, atrMultiplier: 3.0, minSl: 0.3, maxSl: 0.8, rrRatio: 3.0, fixedTp: 0, label: "ATR×3.0 SL[0.3-0.8] RR3.0" },
  { atrPeriod: 30, atrMultiplier: 3.0, minSl: 0.3, maxSl: 1.0, rrRatio: 3.0, fixedTp: 0, label: "ATR×3.0 SL[0.3-1.0] RR3.0" },
  { atrPeriod: 30, atrMultiplier: 3.0, minSl: 0.4, maxSl: 1.2, rrRatio: 3.0, fixedTp: 0, label: "ATR×3.0 SL[0.4-1.2] RR3.0" },
];

// === メイン実行 ===
console.log("=".repeat(90));
console.log("ATR連動SL/TP パラメータスイープ（6日間: 6/23除外）");
console.log("=".repeat(90));

interface SweepResult { label: string; totalPnl: number; trades: number; wins: number; losses: number; stopLosses: number; avgSl: number; }
const results: SweepResult[] = [];

for (const params of SWEEP_PARAMS) {
  let totalPnl = 0, totalTrades = 0, totalWins = 0, totalLosses = 0, totalSL = 0;
  const allSlPcts: number[] = [];
  
  for (const date of DATES) {
    const dayData = loadDayData(date);
    if (dayData.length === 0) continue;
    const result = simulateDay(dayData, params);
    const closedTrades = result.trades.filter(t => t.pnl !== undefined);
    totalPnl += result.totalPnl;
    totalTrades += closedTrades.length;
    totalWins += closedTrades.filter(t => (t.pnl ?? 0) > 0).length;
    totalLosses += closedTrades.filter(t => (t.pnl ?? 0) <= 0).length;
    totalSL += closedTrades.filter(t => t.reason === "損切り").length;
    allSlPcts.push(...result.slPcts);
  }
  
  const avgSl = allSlPcts.length > 0 ? allSlPcts.reduce((a, b) => a + b, 0) / allSlPcts.length : 0;
  results.push({ label: params.label, totalPnl, trades: totalTrades, wins: totalWins, losses: totalLosses, stopLosses: totalSL, avgSl });
  console.log(`${params.label.padEnd(40)} | ${(totalPnl >= 0 ? "+" : "") + Math.round(totalPnl).toLocaleString().padStart(10)}円 | ${totalTrades}T W${totalWins} L${totalLosses} SL${totalSL} | 勝率${totalTrades > 0 ? Math.round(totalWins/totalTrades*100) : 0}% | 平均SL${avgSl.toFixed(3)}%`);
}

// ベースラインとの比較
console.log("\n" + "=".repeat(90));
console.log("ベースラインとの差分");
console.log("=".repeat(90));
const baseline = results[0];
for (let i = 1; i < results.length; i++) {
  const r = results[i];
  const diff = r.totalPnl - baseline.totalPnl;
  const diffPct = baseline.totalPnl !== 0 ? (diff / Math.abs(baseline.totalPnl) * 100).toFixed(1) : "N/A";
  const slDiff = r.stopLosses - baseline.stopLosses;
  console.log(`${r.label.padEnd(40)} | ${(diff >= 0 ? "+" : "") + Math.round(diff).toLocaleString().padStart(10)}円 (${diffPct}%) | SL差${slDiff >= 0 ? "+" : ""}${slDiff}`);
}
