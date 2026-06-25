/**
 * 6/24のシミュレーションを詳細デバッグ出力付きで実行し、
 * 実際のrt_tradesと突き合わせる
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

interface RtCandleRow { symbol: string; tradeDate: string; candleTime: string; open: number; high: number; low: number; close: number; volume: number; boardSnapshot: BoardSnapshot | null; }
interface OpenPosition { symbol: string; side: "long" | "short"; entryPrice: number; shares: number; entryTime: string; entryReason: string; }

function calcShares(price: number): number { return Math.max(100, Math.floor(Math.floor(INITIAL_CAPITAL_PER_STOCK * LOT_RATIO / price) / 100) * 100); }
function timeToMinutes(t: string): number { const [h, m] = t.split(":").map(Number); return h * 60 + m; }
function checkVolumeUnavailable(buffer: CandleWithSignal[]): boolean { if (buffer.length < 10) return false; const lb = Math.min(buffer.length, 20); const rc = buffer.slice(-lb); return (rc.filter(c => c.volume === 0).length / lb) >= VOLUME_UNAVAILABLE_RATIO; }
function getStockName(sym: string): string { return TARGET_STOCKS.find(s => s.symbol === sym)?.name ?? sym; }
function calcCurrentExposure(op: Map<string, OpenPosition>): number { let t = 0; for (const p of op.values()) t += p.entryPrice * p.shares; return t; }

function boardReadingScore(bprHistoryArr: number[], side: "long" | "short", snapshot: BoardSnapshot | null): number {
  if (!snapshot) return 1;
  let score = 0;
  const bpr = snapshot.buyPressureRatio;
  if (snapshot.marketOrderRatio >= 0.08) {
    if (side === "long" && bpr > 1.0) score += 2; else if (side === "long" && bpr < 1.0) score -= 2;
    else if (side === "short" && bpr < 1.0) score += 2; else if (side === "short" && bpr > 1.0) score -= 2;
  }
  if (side === "long") { if (snapshot.largeSellWall) score += 1; if (snapshot.largeBuyWall) score -= 1; }
  else { if (snapshot.largeBuyWall) score += 1; if (snapshot.largeSellWall) score -= 1; }
  if (bprHistoryArr.length >= 3) {
    const delta = bprHistoryArr[bprHistoryArr.length - 1] - bprHistoryArr[0];
    if (side === "long" && delta >= 0.15) score += 1; else if (side === "long" && delta <= -0.15) score -= 1;
    else if (side === "short" && delta <= -0.15) score += 1; else if (side === "short" && delta >= 0.15) score -= 1;
  }
  const mode = detectMarketMode(bprHistoryArr, snapshot);
  if (mode === "active" || mode === "building") score += 1; else if (mode === "trap" || mode === "quiet") score -= 2;
  if (side === "long" && bpr >= 1.4) score += 1; else if (side === "long" && bpr <= 0.65) score -= 1;
  else if (side === "short" && bpr <= 0.65) score += 1; else if (side === "short" && bpr >= 1.4) score -= 1;
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
// メイン
// ============================================================
const data: RtCandleRow[] = JSON.parse(fs.readFileSync("/tmp/rt_candles_20260624.json", "utf8"));
for (const c of data) { c.open = Number(c.open); c.high = Number(c.high); c.low = Number(c.low); c.close = Number(c.close); c.volume = Number(c.volume); if (typeof c.boardSnapshot === 'string') c.boardSnapshot = JSON.parse(c.boardSnapshot as any); }

const sorted = data.filter(c => ALLOWED_SYMBOLS.has(c.symbol)).filter(c => !(c.candleTime >= "11:30" && c.candleTime < "12:30"))
  .sort((a, b) => a.candleTime < b.candleTime ? -1 : a.candleTime > b.candleTime ? 1 : a.symbol < b.symbol ? -1 : 1);

const buffers = new Map<string, CandleWithSignal[]>();
const openPositions = new Map<string, OpenPosition>();
const pullbackStates = new Map<string, any>();
const roundLevelPendingStates = new Map<string, any>();
const roundPullbackStates = new Map<string, any>();
const bprHistories = new Map<string, number[]>();
const lastStopLossTime = new Map<string, string>();

// 実際の取引記録
const ACTUAL_TRADES = [
  { time: "10:00", sym: "6920", action: "short", price: 50770 },
  { time: "10:07", sym: "6920", action: "cover", pnl: -25385 },
  { time: "10:08", sym: "5016", action: "short", price: 4705 },
  { time: "10:11", sym: "5016", action: "cover", pnl: -11762 },
  { time: "10:22", sym: "5803", action: "short", price: 6270 },
  { time: "10:24", sym: "5803", action: "cover", pnl: -12540 },
  { time: "11:08", sym: "6920", action: "buy", price: 51670 },
  { time: "11:17", sym: "6976", action: "short", price: 16415 },
  { time: "11:21", sym: "6920", action: "sell", pnl: -25835 },
  { time: "11:26", sym: "6976", action: "cover", pnl: -8207 },
  { time: "12:29", sym: "6920", action: "short", price: 51240 },
  { time: "12:30", sym: "6920", action: "cover", pnl: -25620 },
  { time: "13:04", sym: "8035", action: "short", price: 69320 },
  { time: "13:07", sym: "6976", action: "short", price: 16620 },
  { time: "13:28", sym: "6976", action: "cover", pnl: -8310 },
];

console.log("=== 6/24 デバッグシミュレーション ===");
console.log(`データ: ${sorted.length}本 (昼休み除外後)`);
console.log("");

// 注目銘柄のエントリー/決済をトラッキング
const WATCH = new Set(["6920", "5016", "5803", "6976", "8035"]);
let totalPnl = 0;
const trades: {time: string; sym: string; action: string; price: number; pnl?: number; reason: string}[] = [];

for (const candle of sorted) {
  const { symbol, candleTime, open, high, low, close, volume, boardSnapshot } = candle;
  if (!buffers.has(symbol)) buffers.set(symbol, []);
  const buffer = buffers.get(symbol)!;
  if (boardSnapshot) { const h = bprHistories.get(symbol) ?? []; h.push(boardSnapshot.buyPressureRatio); if (h.length > 5) h.shift(); bprHistories.set(symbol, h); }
  const tradeDate = candle.tradeDate;
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
      totalPnl += pnl;
      trades.push({ time: candleTime, sym: symbol, action: "forced_close", price: close, pnl, reason: "大引け強制決済" });
      if (WATCH.has(symbol)) console.log(`[EXIT] ${candleTime} ${symbol} 大引け強制決済 @${close} pnl=${Math.round(pnl)}`);
      openPositions.delete(symbol); continue;
    }
    let exitPrice: number | null = null, exitReason = "";
    if (side === "long") {
      const sl = entryPrice * (1 - STOP_LOSS_PERCENT / 100); const tp = entryPrice * (1 + TAKE_PROFIT_PERCENT / 100);
      if (low <= sl) { exitPrice = sl; exitReason = "損切り"; }
      else if (high >= tp) { exitPrice = tp; exitReason = "利確"; }
    } else {
      const sl = entryPrice * (1 + STOP_LOSS_PERCENT / 100); const tp = entryPrice * (1 - TAKE_PROFIT_PERCENT / 100);
      if (high >= sl) { exitPrice = sl; exitReason = "損切り"; }
      else if (low <= tp) { exitPrice = tp; exitReason = "利確"; }
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
      totalPnl += pnl;
      trades.push({ time: candleTime, sym: symbol, action: "exit", price: exitPrice, pnl, reason: exitReason });
      if (WATCH.has(symbol)) console.log(`[EXIT] ${candleTime} ${symbol} ${exitReason} @${Math.round(exitPrice)} pnl=${Math.round(pnl)}`);
      openPositions.delete(symbol); if (exitReason === "損切り") lastStopLossTime.set(symbol, candleTime); continue;
    }
    continue;
  }

  // エントリー禁止
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
        if (brScore < BOARD_SCORE_THRESHOLD) { if (WATCH.has(symbol)) console.log(`[BLOCK] ${candleTime} ${symbol} 押し目確認LONG boardScore=${brScore}<${BOARD_SCORE_THRESHOLD}`); continue; }
        const shares = calcShares(close); const amount = close * shares;
        if (buffer.length >= ATR_FILTER_PERIOD + 1) { const h = buffer.map(c => c.high); const l = buffer.map(c => c.low); const cl = buffer.map(c => c.close); const atr = calcATR(h, l, cl, ATR_FILTER_PERIOD); if (atr[atr.length-1] !== null && close > 0 && (atr[atr.length-1]! / close) < ATR_FILTER_THRESHOLD) { if (WATCH.has(symbol)) console.log(`[BLOCK] ${candleTime} ${symbol} ATRフィルター`); continue; } }
        if (calcCurrentExposure(openPositions) + amount > MAX_TOTAL_EXPOSURE) { if (WATCH.has(symbol)) console.log(`[BLOCK] ${candleTime} ${symbol} 証拠金上限`); continue; }
        if (checkVolumeUnavailable(buffer)) continue;
        const lastSL = lastStopLossTime.get(symbol); if (lastSL && timeToMinutes(candleTime) - timeToMinutes(lastSL) < NO_REENTRY_AFTER_STOPLOSS_MIN) { if (WATCH.has(symbol)) console.log(`[BLOCK] ${candleTime} ${symbol} 損切り後再エントリー禁止`); continue; }
        openPositions.set(symbol, { symbol, side: "long", entryPrice: close, shares, entryTime: candleTime, entryReason: ps.reason });
        trades.push({ time: candleTime, sym: symbol, action: "buy", price: close, reason: `押し目確認: ${ps.reason}` });
        if (WATCH.has(symbol)) console.log(`[ENTRY] ${candleTime} ${symbol} BUY @${close} x${shares} [押し目確認: ${ps.reason}]`);
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
      if (valid) { rp.confirmCount++; if (rp.confirmCount >= ROUND_LEVEL_CONFIRM_BARS) { roundLevelPendingStates.delete(symbol); roundPullbackStates.set(symbol, { ...rp, signalPrice: close, waitCount: 0, pulledBack: false }); if (WATCH.has(symbol)) console.log(`[CONFIRM] ${candleTime} ${symbol} 大台${rp.direction} 5本確認完了 level=${rp.level}`); } }
      else { if (WATCH.has(symbol)) console.log(`[CANCEL] ${candleTime} ${symbol} 大台確認失敗 close=${close} level=${rp.level}`); roundLevelPendingStates.delete(symbol); }
      continue;
    }
  }

  // 大台確認後の押し目待ち
  const rpb = roundPullbackStates.get(symbol);
  if (rpb) {
    rpb.waitCount++;
    const side: "long" | "short" = rpb.direction === "buy" ? "long" : "short";
    if ((rpb.direction === "buy" && close < rpb.level) || (rpb.direction === "sell" && close > rpb.level)) { if (WATCH.has(symbol)) console.log(`[CANCEL] ${candleTime} ${symbol} 大台押し目キャンセル close=${close} level=${rpb.level}`); roundPullbackStates.delete(symbol); continue; }
    if (rpb.waitCount > ROUND_PULLBACK_MAX_WAIT) {
      roundPullbackStates.delete(symbol);
      if (boardSnapshot && side === "long" && boardSnapshot.signal === "sell_pressure") continue;
      if (boardSnapshot && side === "short" && boardSnapshot.signal === "buy_pressure") { if (WATCH.has(symbol)) console.log(`[BLOCK] ${candleTime} ${symbol} 大台${side} buy_pressure`); continue; }
      const brScore = boardReadingScore(bprHistories.get(symbol) ?? [], side, boardSnapshot);
      if (brScore < BOARD_SCORE_THRESHOLD) { if (WATCH.has(symbol)) console.log(`[BLOCK] ${candleTime} ${symbol} 大台${side} boardScore=${brScore}<${BOARD_SCORE_THRESHOLD}`); continue; }
      const shares = calcShares(close); const amount = close * shares;
      if (buffer.length >= ATR_FILTER_PERIOD + 1) { const h = buffer.map(c => c.high); const l = buffer.map(c => c.low); const cl = buffer.map(c => c.close); const atr = calcATR(h, l, cl, ATR_FILTER_PERIOD); if (atr[atr.length-1] !== null && close > 0 && (atr[atr.length-1]! / close) < ATR_FILTER_THRESHOLD) { if (WATCH.has(symbol)) console.log(`[BLOCK] ${candleTime} ${symbol} 大台${side} ATRフィルター`); continue; } }
      if (calcCurrentExposure(openPositions) + amount > MAX_TOTAL_EXPOSURE) { if (WATCH.has(symbol)) console.log(`[BLOCK] ${candleTime} ${symbol} 大台${side} 証拠金上限 exposure=${calcCurrentExposure(openPositions)}+${amount}>${MAX_TOTAL_EXPOSURE}`); continue; }
      if (checkVolumeUnavailable(buffer)) continue;
      openPositions.set(symbol, { symbol, side, entryPrice: close, shares, entryTime: candleTime, entryReason: `${rpb.reason} (押し目なし)` });
      trades.push({ time: candleTime, sym: symbol, action: side === "long" ? "buy" : "short", price: close, reason: `${rpb.reason} (押し目なし)` });
      if (WATCH.has(symbol)) console.log(`[ENTRY] ${candleTime} ${symbol} ${side.toUpperCase()} @${close} x${shares} [${rpb.reason} (押し目なし)]`);
      continue;
    }
    if (rpb.direction === "buy") {
      if (!rpb.pulledBack && close < rpb.signalPrice) rpb.pulledBack = true;
      if (rpb.pulledBack && close > rpb.signalPrice) {
        roundPullbackStates.delete(symbol);
        if (boardSnapshot?.signal === "sell_pressure") continue;
        const brScore = boardReadingScore(bprHistories.get(symbol) ?? [], "long", boardSnapshot);
        if (brScore < BOARD_SCORE_THRESHOLD) { if (WATCH.has(symbol)) console.log(`[BLOCK] ${candleTime} ${symbol} 大台LONG押し目 boardScore=${brScore}`); continue; }
        const shares = calcShares(close); const amount = close * shares;
        if (buffer.length >= ATR_FILTER_PERIOD + 1) { const h = buffer.map(c => c.high); const l = buffer.map(c => c.low); const cl = buffer.map(c => c.close); const atr = calcATR(h, l, cl, ATR_FILTER_PERIOD); if (atr[atr.length-1] !== null && close > 0 && (atr[atr.length-1]! / close) < ATR_FILTER_THRESHOLD) continue; }
        if (calcCurrentExposure(openPositions) + amount > MAX_TOTAL_EXPOSURE) continue;
        openPositions.set(symbol, { symbol, side: "long", entryPrice: close, shares, entryTime: candleTime, entryReason: `${rpb.reason} (押し目確認後)` });
        trades.push({ time: candleTime, sym: symbol, action: "buy", price: close, reason: `${rpb.reason} (押し目確認後)` });
        if (WATCH.has(symbol)) console.log(`[ENTRY] ${candleTime} ${symbol} BUY @${close} x${shares} [${rpb.reason} (押し目確認後)]`);
        continue;
      }
    } else {
      if (!rpb.pulledBack && close > rpb.signalPrice) rpb.pulledBack = true;
      if (rpb.pulledBack && close < rpb.signalPrice) {
        roundPullbackStates.delete(symbol);
        if (boardSnapshot?.signal === "buy_pressure") continue;
        const brScore = boardReadingScore(bprHistories.get(symbol) ?? [], "short", boardSnapshot);
        if (brScore < BOARD_SCORE_THRESHOLD) { if (WATCH.has(symbol)) console.log(`[BLOCK] ${candleTime} ${symbol} 大台SHORT押し目 boardScore=${brScore}`); continue; }
        const shares = calcShares(close); const amount = close * shares;
        if (buffer.length >= ATR_FILTER_PERIOD + 1) { const h = buffer.map(c => c.high); const l = buffer.map(c => c.low); const cl = buffer.map(c => c.close); const atr = calcATR(h, l, cl, ATR_FILTER_PERIOD); if (atr[atr.length-1] !== null && close > 0 && (atr[atr.length-1]! / close) < ATR_FILTER_THRESHOLD) continue; }
        if (calcCurrentExposure(openPositions) + amount > MAX_TOTAL_EXPOSURE) continue;
        openPositions.set(symbol, { symbol, side: "short", entryPrice: close, shares, entryTime: candleTime, entryReason: `${rpb.reason} (押し目確認後)` });
        trades.push({ time: candleTime, sym: symbol, action: "short", price: close, reason: `${rpb.reason} (押し目確認後)` });
        if (WATCH.has(symbol)) console.log(`[ENTRY] ${candleTime} ${symbol} SHORT @${close} x${shares} [${rpb.reason} (押し目確認後)]`);
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
    if (brScore < BOARD_SCORE_THRESHOLD) { if (WATCH.has(symbol)) console.log(`[BLOCK] ${candleTime} ${symbol} BUY boardScore=${brScore} reason=${sig.reason?.slice(0,40)}`); continue; }
    if (sig.reason?.startsWith("ダウ理論: 直近高値更新") && sig.recentSwingLow != null) {
      const htf = getHigherTfTrend(buffer, buffer.length - 1, 5);
      if (htf === "up" && buffer.length >= PULLBACK_DEPTH_LOOKBACK) {
        const lw = buffer.slice(-PULLBACK_DEPTH_LOOKBACK); const sh = Math.max(...lw.map(c => c.high)); const sl = Math.min(...lw.map(c => c.low));
        if (sh > sl) { const pd = (sh - close) / (sh - sl); if (pd >= PULLBACK_DEPTH_MIN && pd <= PULLBACK_DEPTH_MAX) { pullbackStates.set(symbol, { recentSwingLow: sig.recentSwingLow, signalPrice: close, waitCount: 0, pulledBack: false, reason: sig.reason }); if (WATCH.has(symbol)) console.log(`[PULLBACK_START] ${candleTime} ${symbol} ダウ理論押し目待ち`); } }
      }
    } else if (sig.reason?.startsWith("大台超え")) {
      const m = sig.reason.match(/(\d+(?:\.\d+)?)円/); const level = m ? parseFloat(m[1]) : close;
      roundLevelPendingStates.set(symbol, { direction: "buy", level, confirmCount: 0, reason: sig.reason });
      if (WATCH.has(symbol)) console.log(`[ROUND_START] ${candleTime} ${symbol} 大台超え level=${level}`);
    } else {
      const shares = calcShares(close); const amount = close * shares; let canEntry = true; let blockReason = "";
      if (buffer.length >= ATR_FILTER_PERIOD + 1) { const h = buffer.map(c => c.high); const l = buffer.map(c => c.low); const cl = buffer.map(c => c.close); const atr = calcATR(h, l, cl, ATR_FILTER_PERIOD); if (atr[atr.length-1] !== null && close > 0 && (atr[atr.length-1]! / close) < ATR_FILTER_THRESHOLD) { canEntry = false; blockReason = "ATR"; } }
      if (calcCurrentExposure(openPositions) + amount > MAX_TOTAL_EXPOSURE) { canEntry = false; blockReason = "証拠金"; }
      if (checkVolumeUnavailable(buffer)) { canEntry = false; blockReason = "出来高"; }
      const lastSL = lastStopLossTime.get(symbol); if (lastSL && timeToMinutes(candleTime) - timeToMinutes(lastSL) < NO_REENTRY_AFTER_STOPLOSS_MIN) { canEntry = false; blockReason = "損切り後禁止"; }
      if (canEntry) { openPositions.set(symbol, { symbol, side: "long", entryPrice: close, shares, entryTime: candleTime, entryReason: sig.reason }); trades.push({ time: candleTime, sym: symbol, action: "buy", price: close, reason: sig.reason }); if (WATCH.has(symbol)) console.log(`[ENTRY] ${candleTime} ${symbol} BUY @${close} x${shares} [${sig.reason?.slice(0,50)}]`); }
      else { if (WATCH.has(symbol)) console.log(`[BLOCK] ${candleTime} ${symbol} BUY ${blockReason} [${sig.reason?.slice(0,40)}]`); }
    }
  }

  // 売りエントリー
  if (sig.type === "sell" && !openPositions.has(symbol)) {
    if (isBullish) { if (WATCH.has(symbol) && sig.reason) console.log(`[BLOCK] ${candleTime} ${symbol} SHORT HybridA(bullish) [${sig.reason?.slice(0,40)}]`); continue; }
    if (boardSnapshot?.signal === "buy_pressure") { if (WATCH.has(symbol)) console.log(`[BLOCK] ${candleTime} ${symbol} SHORT buy_pressure`); continue; }
    const brScore = boardReadingScore(bprHistories.get(symbol) ?? [], "short", boardSnapshot);
    if (brScore < BOARD_SCORE_THRESHOLD) { if (WATCH.has(symbol)) console.log(`[BLOCK] ${candleTime} ${symbol} SHORT boardScore=${brScore} [${sig.reason?.slice(0,40)}]`); continue; }
    if (sig.reason?.startsWith("ダウ理論: 直近安値更新")) {
      const htf = getHigherTfTrend(buffer, buffer.length - 1, 5);
      if (htf !== "down") { if (WATCH.has(symbol)) console.log(`[BLOCK] ${candleTime} ${symbol} SHORT ダウ理論 htf=${htf}`); continue; }
      if (buffer.length >= PULLBACK_DEPTH_LOOKBACK) { const lw = buffer.slice(-PULLBACK_DEPTH_LOOKBACK); const sh = Math.max(...lw.map(c => c.high)); const sl = Math.min(...lw.map(c => c.low)); if (sh > sl) { const pd = (close - sl) / (sh - sl); if (pd < PULLBACK_DEPTH_MIN || pd > PULLBACK_DEPTH_MAX) { if (WATCH.has(symbol)) console.log(`[BLOCK] ${candleTime} ${symbol} SHORT ダウ理論 pullbackDepth=${pd.toFixed(2)}`); continue; } } }
    } else if (sig.reason?.startsWith("大台割れ")) {
      const m = sig.reason.match(/(\d+(?:\.\d+)?)円/); const level = m ? parseFloat(m[1]) : close;
      roundLevelPendingStates.set(symbol, { direction: "sell", level, confirmCount: 0, reason: sig.reason });
      if (WATCH.has(symbol)) console.log(`[ROUND_START] ${candleTime} ${symbol} 大台割れ level=${level}`);
    } else {
      const shares = calcShares(close); const amount = close * shares; let canEntry = true; let blockReason = "";
      if (buffer.length >= ATR_FILTER_PERIOD + 1) { const h = buffer.map(c => c.high); const l = buffer.map(c => c.low); const cl = buffer.map(c => c.close); const atr = calcATR(h, l, cl, ATR_FILTER_PERIOD); if (atr[atr.length-1] !== null && close > 0 && (atr[atr.length-1]! / close) < ATR_FILTER_THRESHOLD) { canEntry = false; blockReason = "ATR"; } }
      if (calcCurrentExposure(openPositions) + amount > MAX_TOTAL_EXPOSURE) { canEntry = false; blockReason = "証拠金"; }
      if (checkVolumeUnavailable(buffer)) { canEntry = false; blockReason = "出来高"; }
      const lastSL = lastStopLossTime.get(symbol); if (lastSL && timeToMinutes(candleTime) - timeToMinutes(lastSL) < NO_REENTRY_AFTER_STOPLOSS_MIN) { canEntry = false; blockReason = "損切り後禁止"; }
      if (canEntry) { openPositions.set(symbol, { symbol, side: "short", entryPrice: close, shares, entryTime: candleTime, entryReason: sig.reason }); trades.push({ time: candleTime, sym: symbol, action: "short", price: close, reason: sig.reason }); if (WATCH.has(symbol)) console.log(`[ENTRY] ${candleTime} ${symbol} SHORT @${close} x${shares} [${sig.reason?.slice(0,50)}]`); }
      else { if (WATCH.has(symbol)) console.log(`[BLOCK] ${candleTime} ${symbol} SHORT ${blockReason} [${sig.reason?.slice(0,40)}]`); }
    }
  }
}

// 残ポジション
for (const [symbol, pos] of openPositions.entries()) {
  const symCandles = sorted.filter(c => c.symbol === symbol);
  const last = symCandles[symCandles.length - 1];
  if (!last) continue;
  const pnl = pos.side === "long" ? (last.close - pos.entryPrice) * pos.shares : (pos.entryPrice - last.close) * pos.shares;
  totalPnl += pnl;
  trades.push({ time: last.candleTime, sym: symbol, action: "forced_close", price: last.close, pnl, reason: "データ終了時決済" });
  console.log(`[FORCED] ${last.candleTime} ${symbol} ${pos.side} @${pos.entryPrice}→${last.close} pnl=${Math.round(pnl)}`);
}

console.log("\n=== シミュレーション取引一覧 ===");
for (const t of trades) {
  const pnlStr = t.pnl !== undefined ? ` pnl=${Math.round(t.pnl)}` : "";
  console.log(`${t.time} ${t.sym} ${t.action.padEnd(12)} @${t.price} [${t.reason.slice(0,50)}]${pnlStr}`);
}
console.log(`\n合計損益: ${Math.round(totalPnl)}`);
console.log(`\n=== 実際のrt_trades ===`);
for (const t of ACTUAL_TRADES) {
  const pnlStr = (t as any).pnl !== undefined ? ` pnl=${(t as any).pnl}` : "";
  console.log(`${t.time} ${t.sym} ${t.action.padEnd(12)} @${t.price ?? ""}${pnlStr}`);
}
console.log(`実際の合計: -117,659`);
