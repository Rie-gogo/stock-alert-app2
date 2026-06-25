/**
 * debug_v3d.ts - sweep_v3のsimulateDay関数を6/17で実行し、
 * ステートマシンの動作を追跡する
 */
import * as fs from "fs";
import { detectSignals, calcMA, calcRSI, calcBollinger, type CandleWithSignal } from "../server/routers/stockData";
import { TARGET_STOCKS } from "../shared/stocks";
import { getHigherTfTrend } from "../server/vwap";
import { calcATR } from "../server/intradayRegime";
import type { BoardSnapshot } from "../drizzle/schema";

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
const ROUND_LEVEL_CONFIRM_BARS = 5;
const MARKET_CLOSE_TIME = "15:30";
const ALLOWED_SYMBOLS = new Set(TARGET_STOCKS.map(s => s.symbol));

function calcShares(price: number): number { return Math.max(100, Math.floor(Math.floor(INITIAL_CAPITAL_PER_STOCK * LOT_RATIO / price) / 100) * 100); }
function timeToMinutes(t: string): number { const [h, m] = t.split(":").map(Number); return h * 60 + m; }
function checkVolumeUnavailable(buffer: CandleWithSignal[]): boolean { if (buffer.length < 10) return false; const lb = Math.min(buffer.length, 20); const rc = buffer.slice(-lb); return (rc.filter(c => c.volume === 0).length / lb) >= VOLUME_UNAVAILABLE_RATIO; }
function calcCurrentExposure(op: Map<string, any>): number { let t = 0; for (const p of op.values()) t += p.entryPrice * p.shares; return t; }

function boardReadingScoreBC(bprHistoryArr: number[], side: "long" | "short", snapshot: BoardSnapshot | null): number {
  if (!snapshot) return 1;
  return 1; // simplified - no boardSnapshot in 6/17 data
}

const raw = JSON.parse(fs.readFileSync("/tmp/rt_candles_20260617.json", "utf8"));
for (const c of raw) { c.open = Number(c.open); c.high = Number(c.high); c.low = Number(c.low); c.close = Number(c.close); c.volume = Number(c.volume); if (typeof c.boardSnapshot === "string") c.boardSnapshot = JSON.parse(c.boardSnapshot); }

const sorted = raw
  .filter((c: any) => ALLOWED_SYMBOLS.has(c.symbol))
  .filter((c: any) => { const ct = c.candleTime as string; return !(ct >= "11:30" && ct < "12:30"); })
  .sort((a: any, b: any) => a.candleTime < b.candleTime ? -1 : a.candleTime > b.candleTime ? 1 : a.symbol < b.symbol ? -1 : 1);

const buffers = new Map<string, CandleWithSignal[]>();
const openPositions = new Map<string, any>();
const pullbackStates = new Map<string, any>();
const roundLevelPendingStates = new Map<string, any>();
const roundPullbackStates = new Map<string, any>();
const bprHistories = new Map<string, number[]>();
const lastStopLossTime = new Map<string, string>();
let tradeCount = 0;
let roundSignals = 0, roundConfirmed = 0, roundPBSet = 0, roundPBEntry = 0;
let doEntryAttempts = 0, doEntryBoardBlock = 0, doEntryAtrBlock = 0, doEntryExpBlock = 0, doEntryVolBlock = 0, doEntrySLBlock = 0, doEntrySuccess = 0;

const doEntry = (side: "long" | "short", reason: string, symbol: string, close: number, candleTime: string, buffer: CandleWithSignal[]): boolean => {
  doEntryAttempts++;
  const brScore = boardReadingScoreBC(bprHistories.get(symbol) ?? [], side, null);
  if (brScore < BOARD_SCORE_THRESHOLD) { doEntryBoardBlock++; return false; }
  const shares = calcShares(close); const amount = close * shares;
  if (buffer.length >= ATR_FILTER_PERIOD + 1) { const h = buffer.map(c => c.high); const l = buffer.map(c => c.low); const cl = buffer.map(c => c.close); const atr = calcATR(h, l, cl, ATR_FILTER_PERIOD); if (atr[atr.length-1] !== null && close > 0 && (atr[atr.length-1]! / close) < ATR_FILTER_THRESHOLD) { doEntryAtrBlock++; return false; } }
  if (calcCurrentExposure(openPositions) + amount > MAX_TOTAL_EXPOSURE) { doEntryExpBlock++; return false; }
  if (checkVolumeUnavailable(buffer)) { doEntryVolBlock++; return false; }
  const lastSL = lastStopLossTime.get(symbol); if (lastSL && timeToMinutes(candleTime) - timeToMinutes(lastSL) < NO_REENTRY_AFTER_STOPLOSS_MIN) { doEntrySLBlock++; return false; }
  openPositions.set(symbol, { symbol, side, entryPrice: close, shares, entryTime: candleTime, entryReason: reason, slPct: 0.5, tpPct: 1.5 });
  tradeCount++;
  doEntrySuccess++;
  console.log(`  ENTRY: ${candleTime} ${symbol} ${side} @${close} ${reason}`);
  return true;
};

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

  // Position exit logic
  const existingPos = openPositions.get(symbol);
  if (existingPos) {
    const { entryPrice, shares, side, slPct, tpPct } = existingPos;
    if (candleTime >= MARKET_CLOSE_TIME) { openPositions.delete(symbol); continue; }
    let exitPrice: number | null = null;
    if (side === "long") { const sl = entryPrice * (1 - slPct / 100); const tp = entryPrice * (1 + tpPct / 100); if (low <= sl) exitPrice = sl; else if (high >= tp) exitPrice = tp; }
    else { const sl = entryPrice * (1 + slPct / 100); const tp = entryPrice * (1 - tpPct / 100); if (high >= sl) exitPrice = sl; else if (low <= tp) exitPrice = tp; }
    if (exitPrice === null && buffer.length >= MIN_CANDLES_FOR_SIGNAL) { const ws = detectSignals(buffer); const latest = ws[ws.length - 1]; buffer[buffer.length - 1] = latest; if (latest.signal) { if (side === "long" && latest.signal.type === "sell") exitPrice = close; else if (side === "short" && latest.signal.type === "buy") exitPrice = close; } }
    if (exitPrice !== null) { openPositions.delete(symbol); if (exitPrice < entryPrice * (1 - slPct / 100 + 0.001)) lastStopLossTime.set(symbol, candleTime); }
    continue;
  }

  if (candleTime < NO_ENTRY_BEFORE || candleTime >= NO_ENTRY_AFTER) continue;
  if (buffer.length < MIN_CANDLES_FOR_SIGNAL) continue;

  const withSignals = detectSignals(buffer); const latestSignal = withSignals[withSignals.length - 1]; buffer[buffer.length - 1] = latestSignal;
  const firstCandle = buffer[0]; const priceChangeRatio = (close - firstCandle.open) / firstCandle.open * 100; const isBullish = priceChangeRatio >= 0.2;

  // State machine processing
  const ps = pullbackStates.get(symbol);
  if (ps) {
    ps.waitCount++;
    if (low < ps.recentSwingLow || ps.waitCount > PULLBACK_MAX_WAIT) { pullbackStates.delete(symbol); }
    else { if (!ps.pulledBack && close < ps.signalPrice) ps.pulledBack = true; if (ps.pulledBack && close > ps.signalPrice) { pullbackStates.delete(symbol); doEntry("long", ps.reason, symbol, close, candleTime, buffer); } }
    continue;
  }
  const rp = roundLevelPendingStates.get(symbol);
  if (rp) {
    if (openPositions.has(symbol)) { roundLevelPendingStates.delete(symbol); }
    else { const valid = rp.direction === "buy" ? close >= rp.level : close <= rp.level; if (valid) { rp.confirmCount++; if (rp.confirmCount >= ROUND_LEVEL_CONFIRM_BARS) { roundLevelPendingStates.delete(symbol); roundPullbackStates.set(symbol, { ...rp, signalPrice: close, waitCount: 0, pulledBack: false }); roundConfirmed++; } } else { roundLevelPendingStates.delete(symbol); } continue; }
  }
  const rpb = roundPullbackStates.get(symbol);
  if (rpb) {
    rpb.waitCount++; const side: "long" | "short" = rpb.direction === "buy" ? "long" : "short";
    if ((rpb.direction === "buy" && close < rpb.level) || (rpb.direction === "sell" && close > rpb.level)) { roundPullbackStates.delete(symbol); continue; }
    if (rpb.waitCount > ROUND_PULLBACK_MAX_WAIT) { roundPullbackStates.delete(symbol); roundPBEntry++; doEntry(side, `${rpb.reason} (押し目なし)`, symbol, close, candleTime, buffer); continue; }
    if (rpb.direction === "buy") { if (!rpb.pulledBack && close < rpb.signalPrice) rpb.pulledBack = true; if (rpb.pulledBack && close > rpb.signalPrice) { roundPullbackStates.delete(symbol); roundPBEntry++; doEntry("long", `${rpb.reason} (押し目確認後)`, symbol, close, candleTime, buffer); continue; } }
    else { if (!rpb.pulledBack && close > rpb.signalPrice) rpb.pulledBack = true; if (rpb.pulledBack && close < rpb.signalPrice) { roundPullbackStates.delete(symbol); roundPBEntry++; doEntry("short", `${rpb.reason} (押し目確認後)`, symbol, close, candleTime, buffer); continue; } }
    continue;
  }

  const sig = latestSignal.signal;
  if (!sig) continue;
  if (sig.type === "buy" && !openPositions.has(symbol)) {
    if (sig.reason?.includes("VWAPクロス上抜け")) continue;
    if (sig.reason?.startsWith("ダウ理論: 直近高値更新") && sig.recentSwingLow != null) {
      const htf = getHigherTfTrend(buffer, buffer.length - 1, 5);
      if (htf === "up" && buffer.length >= PULLBACK_DEPTH_LOOKBACK) { const lw = buffer.slice(-PULLBACK_DEPTH_LOOKBACK); const sh = Math.max(...lw.map(c => c.high)); const sl2 = Math.min(...lw.map(c => c.low)); if (sh > sl2) { const pd = (sh - close) / (sh - sl2); if (pd >= PULLBACK_DEPTH_MIN && pd <= PULLBACK_DEPTH_MAX) { pullbackStates.set(symbol, { recentSwingLow: sig.recentSwingLow, signalPrice: close, waitCount: 0, pulledBack: false, reason: sig.reason }); } } }
    } else if (sig.reason?.startsWith("大台超え")) {
      roundSignals++;
      const m = sig.reason.match(/(\d+(?:\.\d+)?)円/); const level = m ? parseFloat(m[1]) : close;
      roundLevelPendingStates.set(symbol, { direction: "buy", level, confirmCount: 0, reason: sig.reason });
    } else { doEntry("long", sig.reason!, symbol, close, candleTime, buffer); }
  }
  if (sig.type === "sell" && !openPositions.has(symbol)) {
    if (isBullish) continue;
    if (sig.reason?.startsWith("ダウ理論: 直近安値更新")) { const htf = getHigherTfTrend(buffer, buffer.length - 1, 5); if (htf !== "down") continue; if (buffer.length >= PULLBACK_DEPTH_LOOKBACK) { const lw = buffer.slice(-PULLBACK_DEPTH_LOOKBACK); const sh = Math.max(...lw.map(c => c.high)); const sl2 = Math.min(...lw.map(c => c.low)); if (sh > sl2) { const pd = (close - sl2) / (sh - sl2); if (pd < PULLBACK_DEPTH_MIN || pd > PULLBACK_DEPTH_MAX) continue; } } }
    else if (sig.reason?.startsWith("大台割れ")) { const m = sig.reason.match(/(\d+(?:\.\d+)?)円/); const level = m ? parseFloat(m[1]) : close; roundLevelPendingStates.set(symbol, { direction: "sell", level, confirmCount: 0, reason: sig.reason }); continue; }
    doEntry("short", sig.reason!, symbol, close, candleTime, buffer);
  }
}

console.log(`\n=== 6/17 sweep_v3 ロジック追跡 ===`);
console.log(`取引数: ${tradeCount}`);
console.log(`大台超えシグナル: ${roundSignals}`);
console.log(`大台確認完了: ${roundConfirmed}`);
console.log(`大台PB→エントリー試行: ${roundPBEntry}`);
console.log(`\ndoEntry統計:`);
console.log(`  試行: ${doEntryAttempts}`);
console.log(`  板読みブロック: ${doEntryBoardBlock}`);
console.log(`  ATRブロック: ${doEntryAtrBlock}`);
console.log(`  エクスポージャーブロック: ${doEntryExpBlock}`);
console.log(`  出来高ブロック: ${doEntryVolBlock}`);
console.log(`  SL再エントリーブロック: ${doEntrySLBlock}`);
console.log(`  成功: ${doEntrySuccess}`);
