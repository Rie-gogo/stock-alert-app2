/**
 * debug_v3c.ts - sim_bc_only.tsを6/17のみで実行し取引詳細を表示
 */
import * as fs from "fs";
import { detectSignals, calcMA, calcRSI, calcBollinger, type CandleWithSignal } from "../server/routers/stockData";
import { TARGET_STOCKS } from "../shared/stocks";
import { getHigherTfTrend } from "../server/vwap";
import { calcATR } from "../server/intradayRegime";
import type { BoardSnapshot } from "../drizzle/schema";

const INITIAL_CAPITAL_PER_STOCK = 3_000_000;
const LOT_RATIO = 0.9;
const STOP_LOSS_PERCENT = 0.5;
const TAKE_PROFIT_PERCENT = 1.5;
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

interface RtCandleRow { symbol: string; tradeDate: string; candleTime: string; open: number; high: number; low: number; close: number; volume: number; boardSnapshot: BoardSnapshot | null; }
interface OpenPosition { symbol: string; side: "long" | "short"; entryPrice: number; shares: number; entryTime: string; entryReason: string; }
interface Trade { date: string; time: string; sym: string; action: string; price: number; pnl?: number; reason: string; shares: number; }

function calcShares(price: number): number { return Math.max(100, Math.floor(Math.floor(INITIAL_CAPITAL_PER_STOCK * LOT_RATIO / price) / 100) * 100); }
function timeToMinutes(t: string): number { const [h, m] = t.split(":").map(Number); return h * 60 + m; }
function checkVolumeUnavailable(buffer: CandleWithSignal[]): boolean { if (buffer.length < 10) return false; const lb = Math.min(buffer.length, 20); const rc = buffer.slice(-lb); return (rc.filter(c => c.volume === 0).length / lb) >= VOLUME_UNAVAILABLE_RATIO; }
function calcCurrentExposure(op: Map<string, OpenPosition>): number { let t = 0; for (const p of op.values()) t += p.entryPrice * p.shares; return t; }

function boardReadingScoreOriginal(bprHistoryArr: number[], side: "long" | "short", snapshot: BoardSnapshot | null): number {
  if (!snapshot) return 1;
  let score = 0;
  const bpr = snapshot.buyPressureRatio;
  if (snapshot.marketOrderRatio >= 0.08) { if (side === "long" && bpr > 1.0) score += 2; else if (side === "long" && bpr < 1.0) score -= 2; else if (side === "short" && bpr < 1.0) score += 2; else if (side === "short" && bpr > 1.0) score -= 2; }
  if (side === "long") { if (snapshot.largeSellWall) score += 1; if (snapshot.largeBuyWall) score -= 1; } else { if (snapshot.largeBuyWall) score += 1; if (snapshot.largeSellWall) score -= 1; }
  if (bprHistoryArr.length >= 3) { const delta = bprHistoryArr[bprHistoryArr.length - 1] - bprHistoryArr[0]; if (side === "long" && delta >= 0.15) score += 1; else if (side === "long" && delta <= -0.15) score -= 1; else if (side === "short" && delta <= -0.15) score += 1; else if (side === "short" && delta >= 0.15) score -= 1; }
  if (bprHistoryArr.length >= 3 && bprHistoryArr.every(h => h >= 0.85 && h <= 1.15) && bpr >= 0.85 && bpr <= 1.15) { score -= 2; }
  else if (bpr > 1.2 || bpr < 0.8) { score += 1; }
  else if (bprHistoryArr.length >= 3 && Math.abs(bprHistoryArr[bprHistoryArr.length - 1] - bprHistoryArr[0]) >= 0.1) { score += 1; }
  else { score -= 2; }
  if (side === "long" && bpr >= 1.4) score += 1; else if (side === "long" && bpr <= 0.65) score -= 1; else if (side === "short" && bpr <= 0.65) score += 1; else if (side === "short" && bpr >= 1.4) score -= 1;
  return score;
}

function shouldBoardEarlyExit(pos: OpenPosition, currentPrice: number, snapshot: BoardSnapshot | null): boolean {
  if (!snapshot) return false;
  const profitPct = pos.side === "long" ? (currentPrice - pos.entryPrice) / pos.entryPrice * 100 : (pos.entryPrice - currentPrice) / pos.entryPrice * 100;
  if (profitPct < BOARD_EARLY_EXIT_MIN_PROFIT_PCT) return false;
  if (pos.side === "long" && (snapshot.signal === "sell_pressure" || snapshot.signal === "large_sell_wall")) return true;
  if (pos.side === "short" && (snapshot.signal === "buy_pressure" || snapshot.signal === "large_buy_wall")) return true;
  return false;
}

// Load 6/17 data
const raw = JSON.parse(fs.readFileSync("/tmp/rt_candles_20260617.json", "utf8"));
for (const c of raw) { c.open = Number(c.open); c.high = Number(c.high); c.low = Number(c.low); c.close = Number(c.close); c.volume = Number(c.volume); if (typeof c.boardSnapshot === "string") c.boardSnapshot = JSON.parse(c.boardSnapshot); }

// Run exact sim_bc_only logic (useBC=false for baseline)
const buffers = new Map<string, CandleWithSignal[]>();
const openPositions = new Map<string, OpenPosition>();
const pullbackStates = new Map<string, any>();
const roundLevelPendingStates = new Map<string, any>();
const roundPullbackStates = new Map<string, any>();
const bprHistories = new Map<string, number[]>();
const lastStopLossTime = new Map<string, string>();
const trades: Trade[] = [];
let totalPnl = 0;

const sorted = raw
  .filter((c: any) => ALLOWED_SYMBOLS.has(c.symbol))
  .filter((c: any) => { const ct = c.candleTime as string; return !(ct >= "11:30" && ct < "12:30"); })
  .sort((a: any, b: any) => a.candleTime < b.candleTime ? -1 : a.candleTime > b.candleTime ? 1 : a.symbol < b.symbol ? -1 : 1);

for (const candle of sorted) {
  const { symbol, candleTime, open, high, low, close, volume, boardSnapshot } = candle;
  const tradeDate = candle.tradeDate;
  if (!buffers.has(symbol)) buffers.set(symbol, []);
  const buffer = buffers.get(symbol) as CandleWithSignal[];
  if (boardSnapshot) { const h = bprHistories.get(symbol) ?? []; h.push(boardSnapshot.buyPressureRatio); if (h.length > 5) h.shift(); bprHistories.set(symbol, h); }
  const c4s: CandleWithSignal = { time: `${tradeDate}T${candleTime}:00`, dayKey: tradeDate, timestamp: new Date(`${tradeDate}T${candleTime}:00+09:00`).getTime(), open, high, low, close, volume, ma5: null, ma25: null, rsi: null, bbUpper: null, bbMiddle: null, bbLower: null };
  buffer.push(c4s);
  const closes = buffer.map(c => c.close); const li = buffer.length - 1;
  const ma5S = calcMA(closes, 5); const ma25S = calcMA(closes, 25); const rsiS = calcRSI(closes, 14); const bbS = calcBollinger(closes, 20);
  buffer[li].ma5 = ma5S[li]; buffer[li].ma25 = ma25S[li]; buffer[li].rsi = rsiS[li]; buffer[li].bbUpper = bbS.upper[li]; buffer[li].bbMiddle = bbS.middle[li]; buffer[li].bbLower = bbS.lower[li];

  const existingPos = openPositions.get(symbol);
  if (existingPos) {
    const { entryPrice, shares, side } = existingPos;
    if (candleTime >= MARKET_CLOSE_TIME) { const pnl = side === "long" ? (close - entryPrice) * shares : (entryPrice - close) * shares; totalPnl += pnl; trades.push({ date: tradeDate, time: candleTime, sym: symbol, action: "forced_close", price: close, pnl, reason: "大引け", shares }); openPositions.delete(symbol); continue; }
    let exitPrice: number | null = null, exitReason = "";
    if (side === "long") { const sl = entryPrice * (1 - STOP_LOSS_PERCENT / 100); const tp = entryPrice * (1 + TAKE_PROFIT_PERCENT / 100); if (low <= sl) { exitPrice = sl; exitReason = "損切り"; } else if (high >= tp) { exitPrice = tp; exitReason = "利確"; } }
    else { const sl = entryPrice * (1 + STOP_LOSS_PERCENT / 100); const tp = entryPrice * (1 - TAKE_PROFIT_PERCENT / 100); if (high >= sl) { exitPrice = sl; exitReason = "損切り"; } else if (low <= tp) { exitPrice = tp; exitReason = "利確"; } }
    if (exitPrice === null && buffer.length >= MIN_CANDLES_FOR_SIGNAL) { const ws = detectSignals(buffer); const latest = ws[ws.length - 1]; buffer[buffer.length - 1] = latest; if (latest.signal) { if (side === "long" && latest.signal.type === "sell") { exitPrice = close; exitReason = "シグナル反転"; } else if (side === "short" && latest.signal.type === "buy") { exitPrice = close; exitReason = "シグナル反転"; } } }
    if (exitPrice === null && shouldBoardEarlyExit(existingPos, close, boardSnapshot)) { exitPrice = close; exitReason = "板読み早期利確"; }
    if (exitPrice !== null) { const pnl = side === "long" ? (exitPrice - entryPrice) * shares : (entryPrice - exitPrice) * shares; totalPnl += pnl; trades.push({ date: tradeDate, time: candleTime, sym: symbol, action: "exit", price: exitPrice, pnl, reason: exitReason, shares }); openPositions.delete(symbol); if (exitReason === "損切り") lastStopLossTime.set(symbol, candleTime); }
    continue;
  }

  if (candleTime < NO_ENTRY_BEFORE || candleTime >= NO_ENTRY_AFTER) continue;
  if (buffer.length < MIN_CANDLES_FOR_SIGNAL) continue;

  const withSignals = detectSignals(buffer); const latestSignal = withSignals[withSignals.length - 1]; buffer[buffer.length - 1] = latestSignal;
  const firstCandle = buffer[0]; const priceChangeRatio = (close - firstCandle.open) / firstCandle.open * 100; const isBullish = priceChangeRatio >= 0.2;
  const getBoardScore = (side: "long" | "short") => boardReadingScoreOriginal(bprHistories.get(symbol) ?? [], side, boardSnapshot);

  const ps = pullbackStates.get(symbol);
  if (ps) {
    ps.waitCount++;
    if (low < ps.recentSwingLow || ps.waitCount > PULLBACK_MAX_WAIT) { pullbackStates.delete(symbol); }
    else { if (!ps.pulledBack && close < ps.signalPrice) ps.pulledBack = true; if (ps.pulledBack && close > ps.signalPrice) { pullbackStates.delete(symbol); if (boardSnapshot?.signal === "sell_pressure") { continue; } const brScore = getBoardScore("long"); if (brScore < BOARD_SCORE_THRESHOLD) { continue; } const shares = calcShares(close); const amount = close * shares; if (buffer.length >= ATR_FILTER_PERIOD + 1) { const h = buffer.map(c => c.high); const l = buffer.map(c => c.low); const cl = buffer.map(c => c.close); const atr = calcATR(h, l, cl, ATR_FILTER_PERIOD); if (atr[atr.length-1] !== null && close > 0 && (atr[atr.length-1]! / close) < ATR_FILTER_THRESHOLD) { continue; } } if (calcCurrentExposure(openPositions) + amount > MAX_TOTAL_EXPOSURE) { continue; } if (checkVolumeUnavailable(buffer)) { continue; } const lastSL = lastStopLossTime.get(symbol); if (lastSL && timeToMinutes(candleTime) - timeToMinutes(lastSL) < NO_REENTRY_AFTER_STOPLOSS_MIN) { continue; } openPositions.set(symbol, { symbol, side: "long", entryPrice: close, shares, entryTime: candleTime, entryReason: ps.reason }); trades.push({ date: tradeDate, time: candleTime, sym: symbol, action: "buy", price: close, reason: `押し目: ${ps.reason}`, shares }); } }
    continue;
  }
  const rp = roundLevelPendingStates.get(symbol);
  if (rp) {
    if (openPositions.has(symbol)) { roundLevelPendingStates.delete(symbol); }
    else { const valid = rp.direction === "buy" ? close >= rp.level : close <= rp.level; if (valid) { rp.confirmCount++; if (rp.confirmCount >= ROUND_LEVEL_CONFIRM_BARS) { roundLevelPendingStates.delete(symbol); roundPullbackStates.set(symbol, { ...rp, signalPrice: close, waitCount: 0, pulledBack: false }); } } else { roundLevelPendingStates.delete(symbol); } continue; }
  }
  const rpb = roundPullbackStates.get(symbol);
  if (rpb) {
    rpb.waitCount++; const side: "long" | "short" = rpb.direction === "buy" ? "long" : "short";
    if ((rpb.direction === "buy" && close < rpb.level) || (rpb.direction === "sell" && close > rpb.level)) { roundPullbackStates.delete(symbol); continue; }
    if (rpb.waitCount > ROUND_PULLBACK_MAX_WAIT) { roundPullbackStates.delete(symbol); if (boardSnapshot && side === "long" && boardSnapshot.signal === "sell_pressure") { continue; } if (boardSnapshot && side === "short" && boardSnapshot.signal === "buy_pressure") { continue; } const brScore = getBoardScore(side); if (brScore < BOARD_SCORE_THRESHOLD) { continue; } const shares = calcShares(close); const amount = close * shares; if (buffer.length >= ATR_FILTER_PERIOD + 1) { const h = buffer.map(c => c.high); const l = buffer.map(c => c.low); const cl = buffer.map(c => c.close); const atr = calcATR(h, l, cl, ATR_FILTER_PERIOD); if (atr[atr.length-1] !== null && close > 0 && (atr[atr.length-1]! / close) < ATR_FILTER_THRESHOLD) { continue; } } if (calcCurrentExposure(openPositions) + amount > MAX_TOTAL_EXPOSURE) { continue; } if (checkVolumeUnavailable(buffer)) { continue; } openPositions.set(symbol, { symbol, side, entryPrice: close, shares, entryTime: candleTime, entryReason: `${rpb.reason} (押し目なし)` }); trades.push({ date: tradeDate, time: candleTime, sym: symbol, action: side === "long" ? "buy" : "short", price: close, reason: `${rpb.reason} (押し目なし)`, shares }); continue; }
    if (rpb.direction === "buy") { if (!rpb.pulledBack && close < rpb.signalPrice) rpb.pulledBack = true; if (rpb.pulledBack && close > rpb.signalPrice) { roundPullbackStates.delete(symbol); if (boardSnapshot?.signal === "sell_pressure") { continue; } const brScore = getBoardScore("long"); if (brScore < BOARD_SCORE_THRESHOLD) { continue; } const shares = calcShares(close); const amount = close * shares; if (buffer.length >= ATR_FILTER_PERIOD + 1) { const h = buffer.map(c => c.high); const l = buffer.map(c => c.low); const cl = buffer.map(c => c.close); const atr = calcATR(h, l, cl, ATR_FILTER_PERIOD); if (atr[atr.length-1] !== null && close > 0 && (atr[atr.length-1]! / close) < ATR_FILTER_THRESHOLD) { continue; } } if (calcCurrentExposure(openPositions) + amount > MAX_TOTAL_EXPOSURE) { continue; } openPositions.set(symbol, { symbol, side: "long", entryPrice: close, shares, entryTime: candleTime, entryReason: `${rpb.reason} (押し目確認後)` }); trades.push({ date: tradeDate, time: candleTime, sym: symbol, action: "buy", price: close, reason: `${rpb.reason} (押し目確認後)`, shares }); continue; } }
    else { if (!rpb.pulledBack && close > rpb.signalPrice) rpb.pulledBack = true; if (rpb.pulledBack && close < rpb.signalPrice) { roundPullbackStates.delete(symbol); if (boardSnapshot?.signal === "buy_pressure") { continue; } const brScore = getBoardScore("short"); if (brScore < BOARD_SCORE_THRESHOLD) { continue; } const shares = calcShares(close); const amount = close * shares; if (buffer.length >= ATR_FILTER_PERIOD + 1) { const h = buffer.map(c => c.high); const l = buffer.map(c => c.low); const cl = buffer.map(c => c.close); const atr = calcATR(h, l, cl, ATR_FILTER_PERIOD); if (atr[atr.length-1] !== null && close > 0 && (atr[atr.length-1]! / close) < ATR_FILTER_THRESHOLD) { continue; } } if (calcCurrentExposure(openPositions) + amount > MAX_TOTAL_EXPOSURE) { continue; } openPositions.set(symbol, { symbol, side: "short", entryPrice: close, shares, entryTime: candleTime, entryReason: `${rpb.reason} (押し目確認後)` }); trades.push({ date: tradeDate, time: candleTime, sym: symbol, action: "short", price: close, reason: `${rpb.reason} (押し目確認後)`, shares }); continue; } }
    continue;
  }

  const sig = latestSignal.signal;
  if (!sig) continue;
  if (sig.type === "buy" && !openPositions.has(symbol)) {
    if (sig.reason?.includes("VWAPクロス上抜け")) continue;
    if (boardSnapshot?.signal === "sell_pressure") continue;
    const brScore = getBoardScore("long"); if (brScore < BOARD_SCORE_THRESHOLD) continue;
    if (sig.reason?.startsWith("ダウ理論: 直近高値更新") && sig.recentSwingLow != null) { const htf = getHigherTfTrend(buffer, buffer.length - 1, 5); if (htf === "up" && buffer.length >= PULLBACK_DEPTH_LOOKBACK) { const lw = buffer.slice(-PULLBACK_DEPTH_LOOKBACK); const sh = Math.max(...lw.map(c => c.high)); const sl2 = Math.min(...lw.map(c => c.low)); if (sh > sl2) { const pd = (sh - close) / (sh - sl2); if (pd >= PULLBACK_DEPTH_MIN && pd <= PULLBACK_DEPTH_MAX) { pullbackStates.set(symbol, { recentSwingLow: sig.recentSwingLow, signalPrice: close, waitCount: 0, pulledBack: false, reason: sig.reason }); } } } }
    else if (sig.reason?.startsWith("大台超え")) { const m = sig.reason.match(/(\d+(?:\.\d+)?)円/); const level = m ? parseFloat(m[1]) : close; roundLevelPendingStates.set(symbol, { direction: "buy", level, confirmCount: 0, reason: sig.reason }); }
    else { const shares = calcShares(close); const amount = close * shares; if (buffer.length >= ATR_FILTER_PERIOD + 1) { const h = buffer.map(c => c.high); const l = buffer.map(c => c.low); const cl = buffer.map(c => c.close); const atr = calcATR(h, l, cl, ATR_FILTER_PERIOD); if (atr[atr.length-1] !== null && close > 0 && (atr[atr.length-1]! / close) < ATR_FILTER_THRESHOLD) { continue; } } if (calcCurrentExposure(openPositions) + amount > MAX_TOTAL_EXPOSURE) continue; if (checkVolumeUnavailable(buffer)) continue; const lastSL = lastStopLossTime.get(symbol); if (lastSL && timeToMinutes(candleTime) - timeToMinutes(lastSL) < NO_REENTRY_AFTER_STOPLOSS_MIN) continue; openPositions.set(symbol, { symbol, side: "long", entryPrice: close, shares, entryTime: candleTime, entryReason: sig.reason! }); trades.push({ date: tradeDate, time: candleTime, sym: symbol, action: "buy", price: close, reason: sig.reason!, shares }); }
  }
  if (sig.type === "sell" && !openPositions.has(symbol)) {
    if (isBullish) continue;
    if (boardSnapshot?.signal === "buy_pressure") continue;
    const brScore = getBoardScore("short"); if (brScore < BOARD_SCORE_THRESHOLD) continue;
    if (sig.reason?.startsWith("ダウ理論: 直近安値更新")) { const htf = getHigherTfTrend(buffer, buffer.length - 1, 5); if (htf !== "down") continue; if (buffer.length >= PULLBACK_DEPTH_LOOKBACK) { const lw = buffer.slice(-PULLBACK_DEPTH_LOOKBACK); const sh = Math.max(...lw.map(c => c.high)); const sl2 = Math.min(...lw.map(c => c.low)); if (sh > sl2) { const pd = (close - sl2) / (sh - sl2); if (pd < PULLBACK_DEPTH_MIN || pd > PULLBACK_DEPTH_MAX) continue; } } }
    else if (sig.reason?.startsWith("大台割れ")) { const m = sig.reason.match(/(\d+(?:\.\d+)?)円/); const level = m ? parseFloat(m[1]) : close; roundLevelPendingStates.set(symbol, { direction: "sell", level, confirmCount: 0, reason: sig.reason }); continue; }
    else { const shares = calcShares(close); const amount = close * shares; if (buffer.length >= ATR_FILTER_PERIOD + 1) { const h = buffer.map(c => c.high); const l = buffer.map(c => c.low); const cl = buffer.map(c => c.close); const atr = calcATR(h, l, cl, ATR_FILTER_PERIOD); if (atr[atr.length-1] !== null && close > 0 && (atr[atr.length-1]! / close) < ATR_FILTER_THRESHOLD) { continue; } } if (calcCurrentExposure(openPositions) + amount > MAX_TOTAL_EXPOSURE) continue; if (checkVolumeUnavailable(buffer)) continue; const lastSL = lastStopLossTime.get(symbol); if (lastSL && timeToMinutes(candleTime) - timeToMinutes(lastSL) < NO_REENTRY_AFTER_STOPLOSS_MIN) continue; openPositions.set(symbol, { symbol, side: "short", entryPrice: close, shares, entryTime: candleTime, entryReason: sig.reason! }); trades.push({ date: tradeDate, time: candleTime, sym: symbol, action: "short", price: close, reason: sig.reason!, shares }); }
  }
}

// 残ポジション強制決済
for (const [symbol, pos] of openPositions.entries()) { const symCandles = sorted.filter((c: any) => c.symbol === symbol); const last = symCandles[symCandles.length - 1]; if (!last) continue; const pnl = pos.side === "long" ? (last.close - pos.entryPrice) * pos.shares : (pos.entryPrice - last.close) * pos.shares; totalPnl += pnl; trades.push({ date: last.tradeDate, time: last.candleTime, sym: symbol, action: "forced_close", price: last.close, pnl, reason: "データ終了", shares: pos.shares }); }

console.log(`=== 6/17 sim_bc_only.ts ロジック再現 ===`);
console.log(`取引数: ${trades.filter(t => t.action === "buy" || t.action === "short").length}`);
console.log(`合計損益: ${totalPnl >= 0 ? "+" : ""}${Math.round(totalPnl).toLocaleString()}円`);
console.log(`\nエントリー一覧:`);
for (const t of trades.filter(t => t.action === "buy" || t.action === "short")) {
  console.log(`  ${t.time} ${t.sym} ${t.action} @${t.price} ${t.reason}`);
}
