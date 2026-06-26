/**
 * 現行仕様シミュレーション（直近5日間）
 * 適用済み改良:
 *   - 改良策3改: medium直接エントリー禁止
 *   - 改良策5: 11:00-11:30, 12:30-13:00 エントリー禁止
 * 
 * 対象日: 2026-06-19, 06-22, 06-23, 06-24, 06-25
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

// === 本番エンジンからインポート ===
const serverDir = path.resolve(__dirname, "../server");
const { detectSignals } = require(path.resolve(serverDir, "routers/stockData"));
const { calcATR } = require(path.resolve(serverDir, "intradayRegime"));

// === 定数（本番エンジンと同一） ===
const CAPITAL = 3_000_000;
const LEVERAGE = 3.3;
const MARGIN_USAGE = 0.9;
const MAX_TOTAL_EXPOSURE = CAPITAL * LEVERAGE * MARGIN_USAGE;
const MAX_CONCURRENT = 3;
const LOT_SIZE = Math.floor(MAX_TOTAL_EXPOSURE / MAX_CONCURRENT);

const SL_PCT = 0.5;
const TP_PCT = 1.5;
const NO_ENTRY_BEFORE = "09:30";
const NO_ENTRY_AFTER = "15:15";
const MARKET_CLOSE_TIME = "15:15";
const MIN_CANDLES_FOR_SIGNAL = 30;
const BOARD_SCORE_THRESHOLD = 1;
const ATR_FILTER_PERIOD = 14;
const ATR_FILTER_THRESHOLD = 0.0003;
const NO_REENTRY_AFTER_STOPLOSS_MIN = 15;
const PULLBACK_MAX_WAIT = 10;
const PULLBACK_DEPTH_LOOKBACK = 20;
const PULLBACK_DEPTH_MIN = 0.2;
const PULLBACK_DEPTH_MAX = 0.8;
const ROUND_LEVEL_CONFIRM_BARS = 3;
const ROUND_PULLBACK_MAX_WAIT = 8;

// 改良策5: エントリー禁止時間帯
const BLOCKED_WINDOWS = [
  { start: "11:00", end: "11:30" },
  { start: "12:30", end: "13:00" },
];

// 監視対象銘柄
const ALLOWED_SYMBOLS = new Set([
  "6920","8035","6857","6526","6976","6981","5803","5016",
  "9984","7203","8306","8316","6758","6723","7011","9107","3436"
]);

// === 型定義 ===
interface CandleWithSignal {
  time: string; dayKey: string; timestamp: number;
  open: number; high: number; low: number; close: number; volume: number;
  ma5: number | null; ma25: number | null; rsi: number | null;
  bbUpper: number | null; bbMiddle: number | null; bbLower: number | null;
  signal?: any;
}

interface RtCandleRow {
  symbol: string; tradeDate: string; candleTime: string;
  open: number; high: number; low: number; close: number; volume: number;
  boardSnapshot?: any;
}

interface Position {
  symbol: string; side: "long" | "short"; entryPrice: number; shares: number;
  entryTime: string; entryReason: string;
}

interface Trade {
  date: string; time: string; sym: string; action: string;
  price: number; pnl?: number; reason: string; shares: number;
  confidence?: string;
}

// === ヘルパー関数 ===
function calcMA(data: number[], period: number): (number | null)[] {
  const result: (number | null)[] = [];
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) { result.push(null); continue; }
    let sum = 0; for (let j = i - period + 1; j <= i; j++) sum += data[j];
    result.push(sum / period);
  }
  return result;
}

function calcRSI(data: number[], period: number): (number | null)[] {
  const result: (number | null)[] = [null];
  let gains = 0, losses = 0;
  for (let i = 1; i < data.length; i++) {
    const diff = data[i] - data[i - 1];
    if (i <= period) {
      if (diff > 0) gains += diff; else losses -= diff;
      if (i === period) { result.push(100 - 100 / (1 + gains / period / (losses / period || 0.001))); }
      else result.push(null);
    } else {
      const d = diff > 0 ? diff : 0; const l = diff < 0 ? -diff : 0;
      gains = (gains * (period - 1) + d) / period;
      losses = (losses * (period - 1) + l) / period;
      result.push(100 - 100 / (1 + gains / (losses || 0.001)));
    }
  }
  return result;
}

function calcBollinger(data: number[], period: number): { upper: (number | null)[]; middle: (number | null)[]; lower: (number | null)[] } {
  const upper: (number | null)[] = []; const middle: (number | null)[] = []; const lower: (number | null)[] = [];
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) { upper.push(null); middle.push(null); lower.push(null); continue; }
    const slice = data.slice(i - period + 1, i + 1);
    const avg = slice.reduce((a, b) => a + b, 0) / period;
    const std = Math.sqrt(slice.reduce((a, b) => a + (b - avg) ** 2, 0) / period);
    middle.push(avg); upper.push(avg + 2 * std); lower.push(avg - 2 * std);
  }
  return { upper, middle, lower };
}

function calcShares(price: number): number {
  return Math.max(100, Math.floor(LOT_SIZE / price / 100) * 100);
}

function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function calcCurrentExposure(positions: Map<string, Position>): number {
  let total = 0;
  for (const p of positions.values()) total += p.entryPrice * p.shares;
  return total;
}

function getHigherTfTrend(buffer: CandleWithSignal[], idx: number, lookback: number): "up" | "down" | "neutral" {
  if (idx < lookback) return "neutral";
  const recent = buffer.slice(idx - lookback, idx + 1);
  const first = recent[0].close; const last = recent[recent.length - 1].close;
  const change = (last - first) / first;
  if (change > 0.002) return "up";
  if (change < -0.002) return "down";
  return "neutral";
}

function checkVolumeUnavailable(buffer: CandleWithSignal[]): boolean {
  if (buffer.length < 5) return false;
  const recent = buffer.slice(-5);
  return recent.every(c => c.volume === 0);
}

// 板読みスコア（改良案B・C適用版）
function boardReadingScoreBC(bprHistory: number[], side: "long" | "short", snapshot?: any): number {
  let score = 0;
  if (!snapshot) return 0;
  const bpr = snapshot.buyPressureRatio;
  if (side === "long") {
    if (bpr > 55) score += 2; else if (bpr > 50) score += 1; else if (bpr < 40) score -= 2; else if (bpr < 45) score -= 1;
  } else {
    if (bpr < 45) score += 2; else if (bpr < 50) score += 1; else if (bpr > 60) score -= 2; else if (bpr > 55) score -= 1;
  }
  if (snapshot.signal === "buy_pressure" && side === "long") score += 1;
  if (snapshot.signal === "sell_pressure" && side === "short") score += 1;
  if (snapshot.signal === "buy_pressure" && side === "short") score -= 1;
  if (snapshot.signal === "sell_pressure" && side === "long") score -= 1;
  if (bprHistory.length >= 3) {
    const recent = bprHistory.slice(-3);
    const trend = recent[2] - recent[0];
    if (side === "long" && trend > 5) score += 1; else if (side === "long" && trend < -5) score -= 1;
    if (side === "short" && trend < -5) score += 1; else if (side === "short" && trend > 5) score -= 1;
  }
  // 改良案B: 歩み値方向推定
  if (snapshot.estimatedTickDirection) {
    const dir = snapshot.estimatedTickDirection;
    if (side === "long" && dir > 0.6) score += 2; else if (side === "long" && dir < 0.4) score -= 2;
    if (side === "short" && dir < 0.4) score += 2; else if (side === "short" && dir > 0.6) score -= 2;
  }
  // 改良案C: 見せ板検出
  if (snapshot.fakeOrderDetected) {
    if (side === "long" && snapshot.fakeOrderSide === "buy") score -= 1;
    if (side === "short" && snapshot.fakeOrderSide === "sell") score -= 1;
    if (side === "long" && snapshot.fakeOrderSide === "sell") score += 1;
    if (side === "short" && snapshot.fakeOrderSide === "buy") score += 1;
  }
  return score;
}

// 板読み早期利確
function shouldBoardEarlyExit(pos: Position, currentPrice: number, snapshot?: any): boolean {
  if (!snapshot) return false;
  const unrealizedPct = pos.side === "long"
    ? (currentPrice - pos.entryPrice) / pos.entryPrice * 100
    : (pos.entryPrice - currentPrice) / pos.entryPrice * 100;
  if (unrealizedPct < 0.3) return false;
  if (pos.side === "long" && snapshot.signal === "sell_pressure" && snapshot.buyPressureRatio < 40) return true;
  if (pos.side === "short" && snapshot.signal === "buy_pressure" && snapshot.buyPressureRatio > 60) return true;
  return false;
}

// 時間帯フィルター
function isTimeBlocked(candleTime: string): boolean {
  for (const w of BLOCKED_WINDOWS) {
    if (candleTime >= w.start && candleTime < w.end) return true;
  }
  return false;
}

// ステートマシントリガー判定
function isStateMachineTrigger(reason: string | undefined): boolean {
  if (!reason) return false;
  return reason.startsWith("ダウ理論: 直近高値更新") ||
         reason.startsWith("ダウ理論: 直近安値更新") ||
         reason.startsWith("大台超え") ||
         reason.startsWith("大台割れ");
}

// === シミュレーション関数 ===
function simulateDay(dayData: RtCandleRow[]): { trades: Trade[]; totalPnl: number; entryByHour: Map<string, { count: number; pnl: number }> } {
  const buffers = new Map<string, CandleWithSignal[]>();
  const bprHistories = new Map<string, number[]>();
  const openPositions = new Map<string, Position>();
  const pullbackStates = new Map<string, any>();
  const roundLevelPendingStates = new Map<string, any>();
  const roundPullbackStates = new Map<string, any>();
  const lastStopLossTime = new Map<string, string>();
  const trades: Trade[] = [];
  let totalPnl = 0;
  const entryByHour = new Map<string, { count: number; pnl: number }>();

  const sorted = dayData
    .filter(c => ALLOWED_SYMBOLS.has(c.symbol))
    .filter(c => !(c.candleTime >= "11:30" && c.candleTime < "12:30"))
    .sort((a, b) => a.candleTime < b.candleTime ? -1 : a.candleTime > b.candleTime ? 1 : a.symbol < b.symbol ? -1 : 1);

  for (const candle of sorted) {
    const { symbol, candleTime, open, high, low, close, volume, boardSnapshot } = candle;
    const tradeDate = candle.tradeDate;

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

    // 決済チェック
    const existingPos = openPositions.get(symbol);
    if (existingPos) {
      const { entryPrice, shares, side } = existingPos;
      if (candleTime >= MARKET_CLOSE_TIME) {
        const pnl = side === "long" ? (close - entryPrice) * shares : (entryPrice - close) * shares;
        totalPnl += pnl; trades.push({ date: tradeDate, time: candleTime, sym: symbol, action: "forced_close", price: close, pnl, reason: "大引け強制決済", shares });
        const hour = existingPos.entryTime.substring(0, 2);
        const h = entryByHour.get(hour) ?? { count: 0, pnl: 0 }; h.count++; h.pnl += pnl; entryByHour.set(hour, h);
        openPositions.delete(symbol); continue;
      }
      let exitPrice: number | null = null, exitReason = "";
      if (side === "long") {
        const sl = entryPrice * (1 - SL_PCT / 100); const tp = entryPrice * (1 + TP_PCT / 100);
        if (low <= sl) { exitPrice = sl; exitReason = "損切り"; } else if (high >= tp) { exitPrice = tp; exitReason = "利確"; }
      } else {
        const sl = entryPrice * (1 + SL_PCT / 100); const tp = entryPrice * (1 - TP_PCT / 100);
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
        const hour = existingPos.entryTime.substring(0, 2);
        const h = entryByHour.get(hour) ?? { count: 0, pnl: 0 }; h.count++; h.pnl += pnl; entryByHour.set(hour, h);
        openPositions.delete(symbol); if (exitReason === "損切り") lastStopLossTime.set(symbol, candleTime);
      }
      continue;
    }

    // エントリー禁止時間帯
    if (candleTime < NO_ENTRY_BEFORE || candleTime >= NO_ENTRY_AFTER) continue;
    // 改良策5: 追加禁止時間帯
    if (isTimeBlocked(candleTime)) continue;
    if (buffer.length < MIN_CANDLES_FOR_SIGNAL) continue;
    if (openPositions.size >= MAX_CONCURRENT) continue;

    // シグナル検出
    const withSignals = detectSignals(buffer); const latestSignal = withSignals[withSignals.length - 1]; buffer[buffer.length - 1] = latestSignal;
    const firstCandle = buffer[0]; const priceChangeRatio = (close - firstCandle.open) / firstCandle.open * 100; const isBullish = priceChangeRatio >= 0.2;

    const sig = latestSignal.signal;
    if (!sig) continue;

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
          if (brScore < BOARD_SCORE_THRESHOLD) continue;
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
        if (brScore < BOARD_SCORE_THRESHOLD) continue;
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
          if (brScore < BOARD_SCORE_THRESHOLD) continue;
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
          if (brScore < BOARD_SCORE_THRESHOLD) continue;
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

    // === 直接エントリー判定 ===
    const isMedium = sig.confidence === "medium";

    // 買いエントリー
    if (sig.type === "buy" && !openPositions.has(symbol)) {
      if (sig.reason?.includes("VWAPクロス上抜け")) continue;
      if (boardSnapshot?.signal === "sell_pressure") continue;
      const brScore = getBoardScore("long");
      if (brScore < BOARD_SCORE_THRESHOLD) continue;

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
        // 改良策3改: medium直接エントリー禁止
        if (isMedium) continue;
        const shares = calcShares(close); const amount = close * shares;
        if (buffer.length >= ATR_FILTER_PERIOD + 1) { const h = buffer.map(c => c.high); const l = buffer.map(c => c.low); const cl = buffer.map(c => c.close); const atr = calcATR(h, l, cl, ATR_FILTER_PERIOD); if (atr[atr.length-1] !== null && close > 0 && (atr[atr.length-1]! / close) < ATR_FILTER_THRESHOLD) continue; }
        if (calcCurrentExposure(openPositions) + amount > MAX_TOTAL_EXPOSURE) continue;
        if (checkVolumeUnavailable(buffer)) continue;
        const lastSL = lastStopLossTime.get(symbol); if (lastSL && timeToMinutes(candleTime) - timeToMinutes(lastSL) < NO_REENTRY_AFTER_STOPLOSS_MIN) continue;
        openPositions.set(symbol, { symbol, side: "long", entryPrice: close, shares, entryTime: candleTime, entryReason: sig.reason });
        trades.push({ date: tradeDate, time: candleTime, sym: symbol, action: "buy", price: close, reason: sig.reason, shares, confidence: sig.confidence });
      }
    }

    // 売りエントリー
    if (sig.type === "sell" && !openPositions.has(symbol)) {
      if (isBullish) continue;
      if (boardSnapshot?.signal === "buy_pressure") continue;
      const brScore = getBoardScore("short");
      if (brScore < BOARD_SCORE_THRESHOLD) continue;

      if (sig.reason?.startsWith("ダウ理論: 直近安値更新")) {
        const htf = getHigherTfTrend(buffer, buffer.length - 1, 5);
        if (htf !== "down") continue;
        if (buffer.length >= PULLBACK_DEPTH_LOOKBACK) { const lw = buffer.slice(-PULLBACK_DEPTH_LOOKBACK); const sh = Math.max(...lw.map(c => c.high)); const sl2 = Math.min(...lw.map(c => c.low)); if (sh > sl2) { const pd = (close - sl2) / (sh - sl2); if (pd < PULLBACK_DEPTH_MIN || pd > PULLBACK_DEPTH_MAX) continue; } }
      } else if (sig.reason?.startsWith("大台割れ")) {
        const m = sig.reason.match(/(\d+(?:\.\d+)?)円/); const level = m ? parseFloat(m[1]) : close;
        roundLevelPendingStates.set(symbol, { direction: "sell", level, confirmCount: 0, reason: sig.reason });
      } else {
        // 改良策3改: medium直接エントリー禁止
        if (isMedium) continue;
        const shares = calcShares(close); const amount = close * shares;
        if (buffer.length >= ATR_FILTER_PERIOD + 1) { const h = buffer.map(c => c.high); const l = buffer.map(c => c.low); const cl = buffer.map(c => c.close); const atr = calcATR(h, l, cl, ATR_FILTER_PERIOD); if (atr[atr.length-1] !== null && close > 0 && (atr[atr.length-1]! / close) < ATR_FILTER_THRESHOLD) continue; }
        if (calcCurrentExposure(openPositions) + amount > MAX_TOTAL_EXPOSURE) continue;
        if (checkVolumeUnavailable(buffer)) continue;
        const lastSL = lastStopLossTime.get(symbol); if (lastSL && timeToMinutes(candleTime) - timeToMinutes(lastSL) < NO_REENTRY_AFTER_STOPLOSS_MIN) continue;
        openPositions.set(symbol, { symbol, side: "short", entryPrice: close, shares, entryTime: candleTime, entryReason: sig.reason });
        trades.push({ date: tradeDate, time: candleTime, sym: symbol, action: "short", price: close, reason: sig.reason, shares, confidence: sig.confidence });
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
    const hour = pos.entryTime.substring(0, 2);
    const h = entryByHour.get(hour) ?? { count: 0, pnl: 0 }; h.count++; h.pnl += pnl; entryByHour.set(hour, h);
  }

  return { trades, totalPnl, entryByHour };
}

// === データローダー ===
const DATES = ["2026-06-17", "2026-06-18", "2026-06-19", "2026-06-22", "2026-06-23", "2026-06-24", "2026-06-25"];

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
console.log("現行仕様シミュレーション（直近5日間）");
console.log("適用済み改良: ③改 medium直接禁止 + ⑤ 時間帯フィルター(11:00-11:30, 12:30-13:00)");
console.log(`対象日: ${DATES.join(", ")}`);
console.log("=".repeat(80));
console.log("");

// データプリロード
const allDayData = new Map<string, RtCandleRow[]>();
for (const date of DATES) {
  const data = loadDayData(date);
  allDayData.set(date, data);
  console.log(`  ${date}: ${data.length}件のデータ`);
}
console.log("");

// 日別シミュレーション
let grandTotal = 0;
let grandTrades = 0, grandWins = 0, grandLosses = 0, grandSL = 0, grandTP = 0;
const allTrades: Trade[] = [];
const dailyResults: { date: string; pnl: number; trades: number; wins: number; losses: number; sl: number; tp: number }[] = [];
const aggEntryByHour = new Map<string, { count: number; pnl: number }>();
const symbolPnl = new Map<string, { pnl: number; trades: number; wins: number }>();

for (const date of DATES) {
  const dayData = allDayData.get(date)!;
  if (dayData.length === 0) {
    console.log(`${date}: データなし`);
    dailyResults.push({ date, pnl: 0, trades: 0, wins: 0, losses: 0, sl: 0, tp: 0 });
    continue;
  }
  const result = simulateDay(dayData);
  const closed = result.trades.filter(t => t.pnl !== undefined);
  const wins = closed.filter(t => (t.pnl ?? 0) > 0).length;
  const losses = closed.filter(t => (t.pnl ?? 0) < 0).length;
  const sl = result.trades.filter(t => t.reason === "損切り").length;
  const tp = result.trades.filter(t => t.reason === "利確").length;
  
  grandTotal += result.totalPnl; grandTrades += closed.length; grandWins += wins; grandLosses += losses; grandSL += sl; grandTP += tp;
  allTrades.push(...result.trades);
  dailyResults.push({ date, pnl: result.totalPnl, trades: closed.length, wins, losses, sl, tp });
  
  // 時間帯別集計
  for (const [hour, data] of result.entryByHour) {
    const h = aggEntryByHour.get(hour) ?? { count: 0, pnl: 0 };
    h.count += data.count; h.pnl += data.pnl;
    aggEntryByHour.set(hour, h);
  }
  
  // 銘柄別集計
  for (const t of closed) {
    const s = symbolPnl.get(t.sym) ?? { pnl: 0, trades: 0, wins: 0 };
    s.pnl += t.pnl ?? 0; s.trades++; if ((t.pnl ?? 0) > 0) s.wins++;
    symbolPnl.set(t.sym, s);
  }
  
  const wr = closed.length > 0 ? Math.round(wins / closed.length * 100) : 0;
  console.log(`${date}: ${result.totalPnl >= 0 ? "+" : ""}${Math.round(result.totalPnl).toLocaleString()}円 (${closed.length}T, 勝率${wr}%, SL${sl}, TP${tp})`);
}

console.log("");
console.log("━".repeat(80));
console.log("【総合結果】");
console.log("━".repeat(80));
const wr = grandTrades > 0 ? Math.round(grandWins / grandTrades * 100) : 0;
const pf = grandLosses > 0 ? (allTrades.filter(t => (t.pnl ?? 0) > 0).reduce((s, t) => s + (t.pnl ?? 0), 0) / Math.abs(allTrades.filter(t => (t.pnl ?? 0) < 0).reduce((s, t) => s + (t.pnl ?? 0), 0))).toFixed(2) : "∞";
console.log(`合計損益: ${grandTotal >= 0 ? "+" : ""}${Math.round(grandTotal).toLocaleString()}円`);
console.log(`取引数: ${grandTrades}件 (勝${grandWins} / 負${grandLosses})`);
console.log(`勝率: ${wr}%`);
console.log(`PF: ${pf}`);
console.log(`SL: ${grandSL}回 / TP: ${grandTP}回`);
console.log(`1日平均損益: ${grandTotal >= 0 ? "+" : ""}${Math.round(grandTotal / DATES.length).toLocaleString()}円`);
console.log("");

// 日別詳細
console.log("━".repeat(80));
console.log("【日別詳細】");
console.log("━".repeat(80));
console.log("日付       | 損益          | 取引 | 勝 | 負 | 勝率  | SL | TP");
console.log("-----------|--------------|------|----|----|-------|----|----|");
for (const d of dailyResults) {
  const dwr = d.trades > 0 ? Math.round(d.wins / d.trades * 100) : 0;
  console.log(`${d.date} | ${(d.pnl >= 0 ? "+" : "") + Math.round(d.pnl).toLocaleString().padStart(10)}円 | ${String(d.trades).padStart(4)} | ${String(d.wins).padStart(2)} | ${String(d.losses).padStart(2)} | ${String(dwr).padStart(3)}%  | ${String(d.sl).padStart(2)} | ${String(d.tp).padStart(2)}`);
}
console.log("");

// 銘柄別
console.log("━".repeat(80));
console.log("【銘柄別パフォーマンス】");
console.log("━".repeat(80));
const sortedSymbols = [...symbolPnl.entries()].sort((a, b) => b[1].pnl - a[1].pnl);
console.log("銘柄   | 損益          | 取引 | 勝率");
console.log("-------|--------------|------|------");
for (const [sym, data] of sortedSymbols) {
  const swr = data.trades > 0 ? Math.round(data.wins / data.trades * 100) : 0;
  console.log(`${sym.padEnd(6)} | ${(data.pnl >= 0 ? "+" : "") + Math.round(data.pnl).toLocaleString().padStart(10)}円 | ${String(data.trades).padStart(4)} | ${String(swr).padStart(3)}%`);
}
console.log("");

// 時間帯別
console.log("━".repeat(80));
console.log("【エントリー時間帯別パフォーマンス】");
console.log("━".repeat(80));
const sortedHours = [...aggEntryByHour.entries()].sort((a, b) => a[0].localeCompare(b[0]));
console.log("時間帯 | エントリー数 | 損益          | 平均損益/件");
console.log("-------|------------|--------------|----------");
for (const [hour, data] of sortedHours) {
  const avg = data.count > 0 ? Math.round(data.pnl / data.count) : 0;
  console.log(`${hour}時台  | ${String(data.count).padStart(6)}件   | ${(data.pnl >= 0 ? "+" : "") + Math.round(data.pnl).toLocaleString().padStart(10)}円 | ${(avg >= 0 ? "+" : "") + avg.toLocaleString()}円`);
}
console.log("");

// 全トレード詳細
console.log("━".repeat(80));
console.log("【全トレード詳細】");
console.log("━".repeat(80));
const closedTrades = allTrades.filter(t => t.pnl !== undefined);
console.log("日付       | 時刻  | 銘柄   | 方向    | 価格     | 損益        | 理由");
console.log("-----------|-------|--------|---------|---------|------------|----");
for (const t of allTrades) {
  if (t.action === "buy" || t.action === "short") {
    console.log(`${t.date} | ${t.time} | ${t.sym.padEnd(6)} | ${t.action === "buy" ? "買い  " : "売り  "} | ${t.price.toLocaleString().padStart(7)} | ${"".padStart(10)} | ${t.reason}`);
  } else {
    const pnlStr = t.pnl !== undefined ? `${t.pnl >= 0 ? "+" : ""}${Math.round(t.pnl).toLocaleString()}円` : "";
    console.log(`${t.date} | ${t.time} | ${t.sym.padEnd(6)} | ${t.action.padEnd(7)} | ${t.price.toLocaleString().padStart(7)} | ${pnlStr.padStart(10)} | ${t.reason}`);
  }
}
