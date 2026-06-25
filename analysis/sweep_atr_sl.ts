/**
 * sweep_atr_sl.ts
 * 改良策1: ATR連動型SL/TPのパラメータスイープ
 * 
 * 検証パターン:
 * - モード: A=SLのみATR連動(TP固定1.5%), B=SLのみATR連動(TP=SL×RR), C=両方ATR連動
 * - ATR期間: 20, 30, 50
 * - ATR係数: 2.0, 2.5, 3.0, 3.5, 4.0
 * - 最小SL: 0.3%, 0.4%, 0.5%
 * - 最大SL: 0.8%, 1.0%, 1.2%
 * - RR比(モードB,C): 2.0, 2.5, 3.0
 * 
 * 実行: cd /home/ubuntu/stock-alert-app && npx tsx analysis/sweep_atr_sl.ts
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

// === 型定義 ===
interface RtCandleRow { symbol: string; tradeDate: string; candleTime: string; open: number; high: number; low: number; close: number; volume: number; boardSnapshot: BoardSnapshot | null; }
interface OpenPosition { symbol: string; side: "long" | "short"; entryPrice: number; shares: number; entryTime: string; entryReason: string; stopLossPct: number; takeProfitPct: number; }
interface SweepParams { mode: "A" | "B" | "C"; atrPeriod: number; atrMultiplier: number; minSl: number; maxSl: number; rrRatio: number; }
interface SweepResult { params: SweepParams; totalPnl: number; trades: number; wins: number; losses: number; stopLosses: number; avgSlPct: number; avgTpPct: number; maxDrawdown: number; winRate: number; }

// === ヘルパー ===
function calcShares(price: number): number { return Math.max(100, Math.floor(Math.floor(INITIAL_CAPITAL_PER_STOCK * LOT_RATIO / price) / 100) * 100); }
function timeToMinutes(t: string): number { const [h, m] = t.split(":").map(Number); return h * 60 + m; }
function checkVolumeUnavailable(buffer: CandleWithSignal[]): boolean { if (buffer.length < 10) return false; const lb = Math.min(buffer.length, 20); const rc = buffer.slice(-lb); return (rc.filter(c => c.volume === 0).length / lb) >= VOLUME_UNAVAILABLE_RATIO; }
function calcCurrentExposure(op: Map<string, OpenPosition>): number { let t = 0; for (const p of op.values()) t += p.entryPrice * p.shares; return t; }

// === 板読みスコア（B・C適用版） ===
function estimateTickDirection(bprHistoryArr: number[], snapshot: BoardSnapshot | null): "uptick" | "downtick" | "neutral" {
  if (!snapshot) return "neutral";
  const mod = (snapshot as any).marketOrderDirection;
  if (mod === "buy") return "uptick";
  if (mod === "sell") return "downtick";
  if (bprHistoryArr.length < 3) return "neutral";
  const recent = bprHistoryArr.slice(-Math.min(5, bprHistoryArr.length));
  const first = recent[0]; const last = recent[recent.length - 1]; const trend = last - first;
  if (trend >= 0.2) return "uptick";
  if (trend <= -0.2) return "downtick";
  if (last >= 1.3) return "uptick";
  if (last <= 0.7) return "downtick";
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

function detectMarketMode(bprHistoryArr: number[], snapshot: BoardSnapshot): string {
  const bpr = snapshot.buyPressureRatio;
  if (bprHistoryArr.length >= 3 && bprHistoryArr.every(h => h >= 0.85 && h <= 1.15) && bpr >= 0.85 && bpr <= 1.15) return "quiet";
  if (bpr > 1.2 || bpr < 0.8) return "active";
  if (bprHistoryArr.length >= 3) { const delta = Math.abs(bprHistoryArr[bprHistoryArr.length - 1] - bprHistoryArr[0]); if (delta >= 0.1) return "building"; }
  return "trap";
}

function boardReadingScoreBC(bprHistoryArr: number[], side: "long" | "short", snapshot: BoardSnapshot | null, prevSnapshot: BoardSnapshot | null): number {
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
  const { cancelDetected, icebergDetected, icebergSide } = detectFakeOrder(snapshot);
  let mode: string;
  if (cancelDetected) { mode = "trap"; } else { mode = detectMarketMode(bprHistoryArr, snapshot); }
  if (mode === "active" || mode === "building") score += 1; else if (mode === "trap" || mode === "quiet") score -= 2;
  if (side === "long" && bpr >= 1.4) score += 1; else if (side === "long" && bpr <= 0.65) score -= 1;
  else if (side === "short" && bpr <= 0.65) score += 1; else if (side === "short" && bpr >= 1.4) score -= 1;
  const tickDir = estimateTickDirection(bprHistoryArr, snapshot);
  if (tickDir === "uptick") { if (side === "long") score += 2; else score -= 2; }
  else if (tickDir === "downtick") { if (side === "short") score += 2; else score -= 2; }
  if (icebergDetected && icebergSide) {
    if (side === "long" && icebergSide === "buy") score += 1;
    else if (side === "short" && icebergSide === "sell") score += 1;
    else if (side === "long" && icebergSide === "sell") score -= 1;
    else if (side === "short" && icebergSide === "buy") score -= 1;
  }
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

// === シミュレーション関数 ===
function simulateDay(dayData: RtCandleRow[], params: SweepParams): { totalPnl: number; trades: number; wins: number; losses: number; stopLosses: number; slPcts: number[]; tpPcts: number[] } {
  const buffers = new Map<string, CandleWithSignal[]>();
  const openPositions = new Map<string, OpenPosition>();
  const pullbackStates = new Map<string, any>();
  const roundLevelPendingStates = new Map<string, any>();
  const roundPullbackStates = new Map<string, any>();
  const bprHistories = new Map<string, number[]>();
  const prevSnapshots = new Map<string, BoardSnapshot | null>();
  const lastStopLossTime = new Map<string, string>();
  let totalPnl = 0;
  let tradeCount = 0;
  let wins = 0;
  let losses = 0;
  let stopLosses = 0;
  const slPcts: number[] = [];
  const tpPcts: number[] = [];

  const FIXED_TP = 1.5; // モードAで使用

  function getDynamicSL(buffer: CandleWithSignal[], price: number): { slPct: number; tpPct: number } {
    if (buffer.length < params.atrPeriod + 1) {
      return { slPct: 0.5, tpPct: FIXED_TP };
    }
    const highs = buffer.map(c => c.high);
    const lows = buffer.map(c => c.low);
    const closes = buffer.map(c => c.close);
    const atrArr = calcATR(highs, lows, closes, params.atrPeriod);
    const latestATR = atrArr[atrArr.length - 1];
    if (latestATR === null || price <= 0) return { slPct: 0.5, tpPct: FIXED_TP };
    
    const atrRatio = latestATR / price;
    const rawSlPct = atrRatio * params.atrMultiplier * 100;
    const slPct = Math.max(params.minSl, Math.min(params.maxSl, rawSlPct));
    
    let tpPct: number;
    if (params.mode === "A") {
      tpPct = FIXED_TP; // TP固定1.5%
    } else {
      tpPct = slPct * params.rrRatio; // TP = SL × RR比
    }
    
    return { slPct, tpPct };
  }

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
      prevSnapshots.set(symbol, boardSnapshot);
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
      const { entryPrice, shares, side, stopLossPct, takeProfitPct } = existingPos;
      if (candleTime >= MARKET_CLOSE_TIME) {
        const pnl = side === "long" ? (close - entryPrice) * shares : (entryPrice - close) * shares;
        totalPnl += pnl; if (pnl > 0) wins++; else losses++;
        openPositions.delete(symbol); continue;
      }
      let exitPrice: number | null = null; let exitReason = "";
      if (side === "long") {
        const sl = entryPrice * (1 - stopLossPct / 100);
        const tp = entryPrice * (1 + takeProfitPct / 100);
        if (low <= sl) { exitPrice = sl; exitReason = "損切り"; } else if (high >= tp) { exitPrice = tp; exitReason = "利確"; }
      } else {
        const sl = entryPrice * (1 + stopLossPct / 100);
        const tp = entryPrice * (1 - takeProfitPct / 100);
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
        totalPnl += pnl; if (pnl > 0) wins++; else losses++;
        if (exitReason === "損切り") { stopLosses++; lastStopLossTime.set(symbol, candleTime); }
        openPositions.delete(symbol);
      }
      continue;
    }

    // エントリー禁止
    if (candleTime < NO_ENTRY_BEFORE || candleTime >= NO_ENTRY_AFTER) continue;
    if (buffer.length < MIN_CANDLES_FOR_SIGNAL) continue;

    const withSignals = detectSignals(buffer); const latestSignal = withSignals[withSignals.length - 1]; buffer[buffer.length - 1] = latestSignal;
    const firstCandle = buffer[0]; const priceChangeRatio = (close - firstCandle.open) / firstCandle.open * 100; const isBullish = priceChangeRatio >= 0.2;
    const prevSnap = prevSnapshots.get(symbol) ?? null;

    const getBoardScore = (side: "long" | "short") => boardReadingScoreBC(bprHistories.get(symbol) ?? [], side, boardSnapshot, prevSnap);

    const tryEntry = (side: "long" | "short", reason: string): boolean => {
      const brScore = getBoardScore(side);
      if (brScore < BOARD_SCORE_THRESHOLD) return false;
      const shares = calcShares(close); const amount = close * shares;
      if (buffer.length >= ATR_FILTER_PERIOD + 1) { const h = buffer.map(c => c.high); const l = buffer.map(c => c.low); const cl = buffer.map(c => c.close); const atr = calcATR(h, l, cl, ATR_FILTER_PERIOD); if (atr[atr.length-1] !== null && close > 0 && (atr[atr.length-1]! / close) < ATR_FILTER_THRESHOLD) return false; }
      if (calcCurrentExposure(openPositions) + amount > MAX_TOTAL_EXPOSURE) return false;
      if (checkVolumeUnavailable(buffer)) return false;
      const lastSL = lastStopLossTime.get(symbol); if (lastSL && timeToMinutes(candleTime) - timeToMinutes(lastSL) < NO_REENTRY_AFTER_STOPLOSS_MIN) return false;
      const { slPct, tpPct } = getDynamicSL(buffer, close);
      slPcts.push(slPct); tpPcts.push(tpPct);
      openPositions.set(symbol, { symbol, side, entryPrice: close, shares, entryTime: candleTime, entryReason: reason, stopLossPct: slPct, takeProfitPct: tpPct });
      tradeCount++;
      return true;
    };

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
          tryEntry("long", ps.reason);
        }
      }
      continue;
    }

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

    const rpb = roundPullbackStates.get(symbol);
    if (rpb) {
      rpb.waitCount++;
      const side: "long" | "short" = rpb.direction === "buy" ? "long" : "short";
      if ((rpb.direction === "buy" && close < rpb.level) || (rpb.direction === "sell" && close > rpb.level)) { roundPullbackStates.delete(symbol); continue; }
      if (rpb.waitCount > ROUND_PULLBACK_MAX_WAIT) {
        roundPullbackStates.delete(symbol);
        if (boardSnapshot && side === "long" && boardSnapshot.signal === "sell_pressure") continue;
        if (boardSnapshot && side === "short" && boardSnapshot.signal === "buy_pressure") continue;
        tryEntry(side, `${rpb.reason} (押し目なし)`);
        continue;
      }
      if (rpb.direction === "buy") {
        if (!rpb.pulledBack && close < rpb.signalPrice) rpb.pulledBack = true;
        if (rpb.pulledBack && close > rpb.signalPrice) { roundPullbackStates.delete(symbol); if (boardSnapshot?.signal !== "sell_pressure") tryEntry("long", `${rpb.reason} (押し目確認後)`); continue; }
      } else {
        if (!rpb.pulledBack && close > rpb.signalPrice) rpb.pulledBack = true;
        if (rpb.pulledBack && close < rpb.signalPrice) { roundPullbackStates.delete(symbol); if (boardSnapshot?.signal !== "buy_pressure") tryEntry("short", `${rpb.reason} (押し目確認後)`); continue; }
      }
      continue;
    }

    const sig = latestSignal.signal;
    if (!sig) continue;

    if (sig.type === "buy" && !openPositions.has(symbol)) {
      if (sig.reason?.includes("VWAPクロス上抜け")) continue;
      if (boardSnapshot?.signal === "sell_pressure") continue;
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
        tryEntry("long", sig.reason);
      }
    }

    if (sig.type === "sell" && !openPositions.has(symbol)) {
      if (isBullish) continue;
      if (boardSnapshot?.signal === "buy_pressure") continue;
      if (sig.reason?.startsWith("ダウ理論: 直近安値更新")) {
        const htf = getHigherTfTrend(buffer, buffer.length - 1, 5);
        if (htf !== "down") continue;
        if (buffer.length >= PULLBACK_DEPTH_LOOKBACK) { const lw = buffer.slice(-PULLBACK_DEPTH_LOOKBACK); const sh = Math.max(...lw.map(c => c.high)); const sl2 = Math.min(...lw.map(c => c.low)); if (sh > sl2) { const pd = (close - sl2) / (sh - sl2); if (pd < PULLBACK_DEPTH_MIN || pd > PULLBACK_DEPTH_MAX) continue; } }
      } else if (sig.reason?.startsWith("大台割れ")) {
        const m = sig.reason.match(/(\d+(?:\.\d+)?)円/); const level = m ? parseFloat(m[1]) : close;
        roundLevelPendingStates.set(symbol, { direction: "sell", level, confirmCount: 0, reason: sig.reason });
        continue;
      }
      tryEntry("short", sig.reason);
    }
  }

  // 残ポジション強制決済
  for (const [symbol, pos] of openPositions.entries()) {
    const symCandles = sorted.filter(c => c.symbol === symbol);
    const last = symCandles[symCandles.length - 1];
    if (!last) continue;
    const pnl = pos.side === "long" ? (last.close - pos.entryPrice) * pos.shares : (pos.entryPrice - last.close) * pos.shares;
    totalPnl += pnl; if (pnl > 0) wins++; else losses++;
  }

  return { totalPnl, trades: tradeCount, wins, losses, stopLosses, slPcts, tpPcts };
}

// === データローダー ===
// 6/23はデータ欠損のため除外
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

// === メイン: パラメータスイープ ===
const allDayData = DATES.map(d => ({ date: d, data: loadDayData(d) })).filter(d => d.data.length > 0);
console.log(`データ読み込み完了: ${allDayData.length}日分（6/23データ欠損日は除外）`);

// まず現行版（固定SL=0.5%, TP=1.5%）をベースラインとして計算
const baselineParams: SweepParams = { mode: "A", atrPeriod: 30, atrMultiplier: 0, minSl: 0.5, maxSl: 0.5, rrRatio: 3.0 };
// 固定版用に特別処理
let baselinePnl = 0;
let baselineTrades = 0;
let baselineWins = 0;
let baselineLosses = 0;
let baselineSL = 0;

// 現行版は固定SL/TPなのでパラメータを固定
for (const { data } of allDayData) {
  // 固定版: minSl=maxSl=0.5, mode=A(TP固定1.5%)
  const r = simulateDay(data, { mode: "A", atrPeriod: 30, atrMultiplier: 100, minSl: 0.5, maxSl: 0.5, rrRatio: 3.0 });
  baselinePnl += r.totalPnl;
  baselineTrades += r.trades;
  baselineWins += r.wins;
  baselineLosses += r.losses;
  baselineSL += r.stopLosses;
}
console.log(`\nベースライン（固定SL=0.5%, TP=1.5%）: 損益=${Math.round(baselinePnl).toLocaleString()}円, 取引${baselineTrades}回, 勝率${((baselineWins/(baselineWins+baselineLosses))*100).toFixed(1)}%, 損切り${baselineSL}回`);
console.log("=".repeat(80));

// スイープ実行
const results: SweepResult[] = [];
const modes: ("A" | "B" | "C")[] = ["A", "B"];
const atrPeriods = [20, 30, 50];
const atrMultipliers = [2.0, 2.5, 3.0, 3.5, 4.0, 5.0];
const minSls = [0.3, 0.4, 0.5];
const maxSls = [0.7, 0.8, 1.0, 1.2];
const rrRatios = [2.0, 2.5, 3.0];

let totalCombinations = 0;
for (const mode of modes) {
  for (const atrPeriod of atrPeriods) {
    for (const atrMultiplier of atrMultipliers) {
      for (const minSl of minSls) {
        for (const maxSl of maxSls) {
          if (minSl >= maxSl) continue;
          if (mode === "A") {
            totalCombinations++;
          } else {
            totalCombinations += rrRatios.length;
          }
        }
      }
    }
  }
}
console.log(`スイープ開始: ${totalCombinations}パターン`);

let count = 0;
for (const mode of modes) {
  for (const atrPeriod of atrPeriods) {
    for (const atrMultiplier of atrMultipliers) {
      for (const minSl of minSls) {
        for (const maxSl of maxSls) {
          if (minSl >= maxSl) continue;
          const rrs = mode === "A" ? [3.0] : rrRatios; // モードAはRR不使用（TP固定）
          for (const rrRatio of rrs) {
            const params: SweepParams = { mode, atrPeriod, atrMultiplier, minSl, maxSl, rrRatio };
            let totalPnl = 0, trades = 0, wins = 0, losses = 0, stopLosses = 0;
            const allSlPcts: number[] = [];
            const allTpPcts: number[] = [];
            let maxDrawdown = 0;
            let runningPnl = 0;
            let peak = 0;

            for (const { data } of allDayData) {
              const r = simulateDay(data, params);
              totalPnl += r.totalPnl;
              trades += r.trades;
              wins += r.wins;
              losses += r.losses;
              stopLosses += r.stopLosses;
              allSlPcts.push(...r.slPcts);
              allTpPcts.push(...r.tpPcts);
              runningPnl += r.totalPnl;
              if (runningPnl > peak) peak = runningPnl;
              const dd = peak - runningPnl;
              if (dd > maxDrawdown) maxDrawdown = dd;
            }

            const avgSlPct = allSlPcts.length > 0 ? allSlPcts.reduce((s, v) => s + v, 0) / allSlPcts.length : 0;
            const avgTpPct = allTpPcts.length > 0 ? allTpPcts.reduce((s, v) => s + v, 0) / allTpPcts.length : 0;
            const winRate = (wins + losses) > 0 ? wins / (wins + losses) * 100 : 0;

            results.push({ params, totalPnl, trades, wins, losses, stopLosses, avgSlPct, avgTpPct, maxDrawdown, winRate });
            count++;
            if (count % 100 === 0) process.stdout.write(`  ${count}/${totalCombinations}\r`);
          }
        }
      }
    }
  }
}

console.log(`\nスイープ完了: ${results.length}パターン実行`);
console.log("=".repeat(80));

// 結果をソート（損益降順）
results.sort((a, b) => b.totalPnl - a.totalPnl);

// TOP20を表示
console.log("\n=== TOP20（合計損益順） ===");
console.log("順位 | モード | ATR期間 | 係数 | 最小SL | 最大SL | RR比 | 合計損益    | 取引 | 勝率  | SL回数 | 平均SL% | 平均TP% | MaxDD");
console.log("-".repeat(130));
for (let i = 0; i < Math.min(20, results.length); i++) {
  const r = results[i];
  const p = r.params;
  const diff = r.totalPnl - baselinePnl;
  console.log(
    `${String(i+1).padStart(3)} | ${p.mode.padEnd(4)} | ${String(p.atrPeriod).padStart(5)} | ${p.atrMultiplier.toFixed(1)} | ${p.minSl.toFixed(1)}%  | ${p.maxSl.toFixed(1)}%  | ${p.rrRatio.toFixed(1)} | ${(r.totalPnl >= 0 ? "+" : "")}${Math.round(r.totalPnl).toLocaleString().padStart(9)}円 | ${String(r.trades).padStart(3)} | ${r.winRate.toFixed(1)}% | ${String(r.stopLosses).padStart(4)} | ${r.avgSlPct.toFixed(3)}% | ${r.avgTpPct.toFixed(3)}% | ${Math.round(r.maxDrawdown).toLocaleString()}円 (${diff >= 0 ? "+" : ""}${Math.round(diff).toLocaleString()})`
  );
}

// ベースラインを超えたパターン数
const betterThanBaseline = results.filter(r => r.totalPnl > baselinePnl);
console.log(`\nベースライン(${Math.round(baselinePnl).toLocaleString()}円)を超えたパターン: ${betterThanBaseline.length}/${results.length}`);

// モード別ベスト
console.log("\n=== モード別ベスト ===");
for (const mode of modes) {
  const modeResults = results.filter(r => r.params.mode === mode);
  if (modeResults.length === 0) continue;
  const best = modeResults[0];
  const diff = best.totalPnl - baselinePnl;
  console.log(`モード${mode}: 損益${best.totalPnl >= 0 ? "+" : ""}${Math.round(best.totalPnl).toLocaleString()}円 (${diff >= 0 ? "+" : ""}${Math.round(diff).toLocaleString()}円) | ATR${best.params.atrPeriod}×${best.params.atrMultiplier} | SL${best.params.minSl}〜${best.params.maxSl}% | RR${best.params.rrRatio} | 勝率${best.winRate.toFixed(1)}% | SL${best.stopLosses}回`);
}

// CSVエクスポート
const csvLines = ["mode,atr_period,atr_multiplier,min_sl,max_sl,rr_ratio,total_pnl,trades,win_rate,stop_losses,avg_sl_pct,avg_tp_pct,max_drawdown,diff_from_baseline"];
for (const r of results) {
  const p = r.params;
  csvLines.push(`${p.mode},${p.atrPeriod},${p.atrMultiplier},${p.minSl},${p.maxSl},${p.rrRatio},${Math.round(r.totalPnl)},${r.trades},${r.winRate.toFixed(1)},${r.stopLosses},${r.avgSlPct.toFixed(4)},${r.avgTpPct.toFixed(4)},${Math.round(r.maxDrawdown)},${Math.round(r.totalPnl - baselinePnl)}`);
}
fs.writeFileSync("/home/ubuntu/stock-alert-app/analysis/sweep_atr_sl_results.csv", csvLines.join("\n"));
console.log("\n結果CSV: analysis/sweep_atr_sl_results.csv");
