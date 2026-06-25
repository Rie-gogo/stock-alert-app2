/**
 * sim_atr_dynamic_stop.ts
 * 改良策1: ATR連動型の動的損切り幅
 * 
 * 現行版（B・C適用済み）をベースに、固定損切り-0.5%/利確+1.5%を
 * ATR（7本）× 係数で動的に計算する方式に変更。
 * 
 * ロジック:
 *   ATR率 = ATR(7) / 現在価格
 *   動的損切り幅 = max(0.5%, min(1.0%, ATR率 × 1.5 × 100))
 *   動的利確幅 = 動的損切り幅 × 3（リスクリワード比3:1維持）
 * 
 * 7営業日（2026-06-17〜06-25）で現行版（固定SL/TP）と比較する。
 * 
 * 実行: cd /home/ubuntu/stock-alert-app && npx tsx analysis/sim_atr_dynamic_stop.ts
 */
import * as fs from "fs";
import { detectSignals, calcMA, calcRSI, calcBollinger, type CandleWithSignal } from "../server/routers/stockData";
import { TARGET_STOCKS } from "../shared/stocks";
import { getHigherTfTrend } from "../server/vwap";
import { calcATR } from "../server/intradayRegime";
import type { BoardSnapshot } from "../drizzle/schema";

// === 定数（現行版と完全一致、SL/TPは動的版で上書き） ===
const INITIAL_CAPITAL_PER_STOCK = 3_000_000;
const LOT_RATIO = 0.9;
const FIXED_STOP_LOSS_PERCENT = 0.5;  // 現行版固定値
const FIXED_TAKE_PROFIT_PERCENT = 1.5; // 現行版固定値
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

// === ATR動的損切り幅パラメータ ===
// 1分足ATRは非常に小さいため、直近30本（30分間）のATRを使用し
// 係数を大きくすることで「通常の値動きの範囲」を超えた位置にSLを設定
const ATR_SL_PERIOD = 30;         // ATR計算期間（30分間の値動き）
const ATR_SL_MULTIPLIER = 3.0;    // ATR × この係数 = 損切り幅（30分ATRの3倍）
const ATR_SL_MIN_PERCENT = 0.3;   // 最小損切り幅（%）- 低ボラ銘柄でも最低限確保
const ATR_SL_MAX_PERCENT = 1.2;   // 最大損切り幅（%）- 高ボラ銘柄の上限
const RISK_REWARD_RATIO = 3.0;    // リスクリワード比（利確 = 損切り × この値）

// === 型定義 ===
interface RtCandleRow { symbol: string; tradeDate: string; candleTime: string; open: number; high: number; low: number; close: number; volume: number; boardSnapshot: BoardSnapshot | null; }
interface OpenPosition { symbol: string; side: "long" | "short"; entryPrice: number; shares: number; entryTime: string; entryReason: string; stopLossPct: number; takeProfitPct: number; }
interface Trade { date: string; time: string; sym: string; action: string; price: number; pnl?: number; reason: string; shares: number; slPct?: number; tpPct?: number; }

// === ヘルパー ===
function calcShares(price: number): number { return Math.max(100, Math.floor(Math.floor(INITIAL_CAPITAL_PER_STOCK * LOT_RATIO / price) / 100) * 100); }
function timeToMinutes(t: string): number { const [h, m] = t.split(":").map(Number); return h * 60 + m; }
function checkVolumeUnavailable(buffer: CandleWithSignal[]): boolean { if (buffer.length < 10) return false; const lb = Math.min(buffer.length, 20); const rc = buffer.slice(-lb); return (rc.filter(c => c.volume === 0).length / lb) >= VOLUME_UNAVAILABLE_RATIO; }
function calcCurrentExposure(op: Map<string, OpenPosition>): number { let t = 0; for (const p of op.values()) t += p.entryPrice * p.shares; return t; }

// === ATR連動型の動的損切り幅計算 ===
function calcDynamicStopLoss(buffer: CandleWithSignal[], currentPrice: number): { slPct: number; tpPct: number; atrRatio: number } {
  if (buffer.length < ATR_SL_PERIOD + 1) {
    // バッファ不足時は固定値
    return { slPct: FIXED_STOP_LOSS_PERCENT, tpPct: FIXED_TAKE_PROFIT_PERCENT, atrRatio: 0 };
  }
  
  const highs = buffer.map(c => c.high);
  const lows = buffer.map(c => c.low);
  const closes = buffer.map(c => c.close);
  const atrArr = calcATR(highs, lows, closes, ATR_SL_PERIOD);
  const latestATR = atrArr[atrArr.length - 1];
  
  if (latestATR === null || currentPrice <= 0) {
    return { slPct: FIXED_STOP_LOSS_PERCENT, tpPct: FIXED_TAKE_PROFIT_PERCENT, atrRatio: 0 };
  }
  
  // ATR率 = ATR(30本) / 現在価格
  const atrRatio = latestATR / currentPrice;
  
  // 動的損切り幅 = max(MIN%, min(MAX%, ATR率 × 係数 × 100))
  const rawSlPct = atrRatio * ATR_SL_MULTIPLIER * 100;
  const slPct = Math.max(ATR_SL_MIN_PERCENT, Math.min(ATR_SL_MAX_PERCENT, rawSlPct));
  
  // 利確幅 = 損切り幅 × リスクリワード比
  const tpPct = slPct * RISK_REWARD_RATIO;
  
  return { slPct, tpPct, atrRatio };
}

// === 改良案B: 歩み値方向推定 ===
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

// === 改良案C: 見せ板検出強化 ===
function detectFakeOrder(snapshot: BoardSnapshot | null): { cancelDetected: boolean; icebergDetected: boolean; icebergSide: "buy" | "sell" | null } {
  if (!snapshot) return { cancelDetected: false, icebergDetected: false, icebergSide: null };
  const snap = snapshot as any;
  const cancelDetected = !!(snap.askCancelDetected || snap.bidCancelDetected);
  let icebergDetected = false; let icebergSide: "buy" | "sell" | null = null;
  if (snap.icebergAskDetected) { icebergDetected = true; icebergSide = "buy"; }
  if (snap.icebergBidDetected) { icebergDetected = true; icebergSide = "sell"; }
  return { cancelDetected, icebergDetected, icebergSide };
}

// === 板読みスコア（B・C適用版） ===
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

// === シミュレーション関数 ===
function simulateDay(
  dayData: RtCandleRow[],
  useDynamicStop: boolean,  // true = ATR連動動的SL/TP, false = 固定SL/TP
): { trades: Trade[]; totalPnl: number; slStats: { slPcts: number[]; tpPcts: number[] } } {
  
  const buffers = new Map<string, CandleWithSignal[]>();
  const openPositions = new Map<string, OpenPosition>();
  const pullbackStates = new Map<string, any>();
  const roundLevelPendingStates = new Map<string, any>();
  const roundPullbackStates = new Map<string, any>();
  const bprHistories = new Map<string, number[]>();
  const prevSnapshots = new Map<string, BoardSnapshot | null>();
  const lastStopLossTime = new Map<string, string>();
  const trades: Trade[] = [];
  let totalPnl = 0;
  const slStats = { slPcts: [] as number[], tpPcts: [] as number[] };

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
        totalPnl += pnl; trades.push({ date: tradeDate, time: candleTime, sym: symbol, action: "forced_close", price: close, pnl, reason: "大引け強制決済", shares });
        openPositions.delete(symbol); continue;
      }
      let exitPrice: number | null = null, exitReason = "";
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
        totalPnl += pnl; trades.push({ date: tradeDate, time: candleTime, sym: symbol, action: "exit", price: exitPrice, pnl, reason: exitReason, shares, slPct: stopLossPct, tpPct: takeProfitPct });
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

    const getBoardScore = (side: "long" | "short") => {
      return boardReadingScoreBC(bprHistories.get(symbol) ?? [], side, boardSnapshot, prevSnap);
    };

    // エントリー時のSL/TP決定
    const getStopParams = (): { slPct: number; tpPct: number } => {
      if (useDynamicStop) {
        const result = calcDynamicStopLoss(buffer, close);
        slStats.slPcts.push(result.slPct);
        slStats.tpPcts.push(result.tpPct);
        return result;
      } else {
        slStats.slPcts.push(FIXED_STOP_LOSS_PERCENT);
        slStats.tpPcts.push(FIXED_TAKE_PROFIT_PERCENT);
        return { slPct: FIXED_STOP_LOSS_PERCENT, tpPct: FIXED_TAKE_PROFIT_PERCENT };
      }
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
          const brScore = getBoardScore("long");
          if (brScore < BOARD_SCORE_THRESHOLD) continue;
          const shares = calcShares(close); const amount = close * shares;
          if (buffer.length >= ATR_FILTER_PERIOD + 1) { const h = buffer.map(c => c.high); const l = buffer.map(c => c.low); const cl = buffer.map(c => c.close); const atr = calcATR(h, l, cl, ATR_FILTER_PERIOD); if (atr[atr.length-1] !== null && close > 0 && (atr[atr.length-1]! / close) < ATR_FILTER_THRESHOLD) continue; }
          if (calcCurrentExposure(openPositions) + amount > MAX_TOTAL_EXPOSURE) continue;
          if (checkVolumeUnavailable(buffer)) continue;
          const lastSL = lastStopLossTime.get(symbol); if (lastSL && timeToMinutes(candleTime) - timeToMinutes(lastSL) < NO_REENTRY_AFTER_STOPLOSS_MIN) continue;
          const { slPct, tpPct } = getStopParams();
          openPositions.set(symbol, { symbol, side: "long", entryPrice: close, shares, entryTime: candleTime, entryReason: ps.reason, stopLossPct: slPct, takeProfitPct: tpPct });
          trades.push({ date: tradeDate, time: candleTime, sym: symbol, action: "buy", price: close, reason: `押し目確認: ${ps.reason}`, shares, slPct, tpPct });
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
        const { slPct, tpPct } = getStopParams();
        openPositions.set(symbol, { symbol, side, entryPrice: close, shares, entryTime: candleTime, entryReason: `${rpb.reason} (押し目なし)`, stopLossPct: slPct, takeProfitPct: tpPct });
        trades.push({ date: tradeDate, time: candleTime, sym: symbol, action: side === "long" ? "buy" : "short", price: close, reason: `${rpb.reason} (押し目なし)`, shares, slPct, tpPct });
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
          const { slPct, tpPct } = getStopParams();
          openPositions.set(symbol, { symbol, side: "long", entryPrice: close, shares, entryTime: candleTime, entryReason: `${rpb.reason} (押し目確認後)`, stopLossPct: slPct, takeProfitPct: tpPct });
          trades.push({ date: tradeDate, time: candleTime, sym: symbol, action: "buy", price: close, reason: `${rpb.reason} (押し目確認後)`, shares, slPct, tpPct });
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
          const { slPct, tpPct } = getStopParams();
          openPositions.set(symbol, { symbol, side: "short", entryPrice: close, shares, entryTime: candleTime, entryReason: `${rpb.reason} (押し目確認後)`, stopLossPct: slPct, takeProfitPct: tpPct });
          trades.push({ date: tradeDate, time: candleTime, sym: symbol, action: "short", price: close, reason: `${rpb.reason} (押し目確認後)`, shares, slPct, tpPct });
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
        const shares = calcShares(close); const amount = close * shares;
        if (buffer.length >= ATR_FILTER_PERIOD + 1) { const h = buffer.map(c => c.high); const l = buffer.map(c => c.low); const cl = buffer.map(c => c.close); const atr = calcATR(h, l, cl, ATR_FILTER_PERIOD); if (atr[atr.length-1] !== null && close > 0 && (atr[atr.length-1]! / close) < ATR_FILTER_THRESHOLD) continue; }
        if (calcCurrentExposure(openPositions) + amount > MAX_TOTAL_EXPOSURE) continue;
        if (checkVolumeUnavailable(buffer)) continue;
        const lastSL = lastStopLossTime.get(symbol); if (lastSL && timeToMinutes(candleTime) - timeToMinutes(lastSL) < NO_REENTRY_AFTER_STOPLOSS_MIN) continue;
        const { slPct, tpPct } = getStopParams();
        openPositions.set(symbol, { symbol, side: "long", entryPrice: close, shares, entryTime: candleTime, entryReason: sig.reason, stopLossPct: slPct, takeProfitPct: tpPct });
        trades.push({ date: tradeDate, time: candleTime, sym: symbol, action: "buy", price: close, reason: sig.reason, shares, slPct, tpPct });
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
        const shares = calcShares(close); const amount = close * shares;
        if (buffer.length >= ATR_FILTER_PERIOD + 1) { const h = buffer.map(c => c.high); const l = buffer.map(c => c.low); const cl = buffer.map(c => c.close); const atr = calcATR(h, l, cl, ATR_FILTER_PERIOD); if (atr[atr.length-1] !== null && close > 0 && (atr[atr.length-1]! / close) < ATR_FILTER_THRESHOLD) continue; }
        if (calcCurrentExposure(openPositions) + amount > MAX_TOTAL_EXPOSURE) continue;
        if (checkVolumeUnavailable(buffer)) continue;
        const lastSL = lastStopLossTime.get(symbol); if (lastSL && timeToMinutes(candleTime) - timeToMinutes(lastSL) < NO_REENTRY_AFTER_STOPLOSS_MIN) continue;
        const { slPct, tpPct } = getStopParams();
        openPositions.set(symbol, { symbol, side: "short", entryPrice: close, shares, entryTime: candleTime, entryReason: sig.reason, stopLossPct: slPct, takeProfitPct: tpPct });
        trades.push({ date: tradeDate, time: candleTime, sym: symbol, action: "short", price: close, reason: sig.reason, shares, slPct, tpPct });
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

  return { trades, totalPnl, slStats };
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

// === メイン実行 ===
console.log("=".repeat(80));
console.log("改良策1: ATR連動型の動的損切り幅 シミュレーション比較");
console.log("=".repeat(80));
console.log("");
console.log(`パラメータ: ATR期間=${ATR_SL_PERIOD}, 係数=${ATR_SL_MULTIPLIER}, 最小SL=${ATR_SL_MIN_PERCENT}%, 最大SL=${ATR_SL_MAX_PERCENT}%, RR比=${RISK_REWARD_RATIO}`);
console.log(`現行版: 固定SL=${FIXED_STOP_LOSS_PERCENT}%, 固定TP=${FIXED_TAKE_PROFIT_PERCENT}%`);
console.log("");

// 現行版（B・C適用、固定SL/TP）
const resultsFixed: { date: string; pnl: number; trades: number; wins: number; losses: number; stopLosses: number }[] = [];
console.log("--- 現行版（B・C適用、固定SL/TP -0.5%/+1.5%） ---");
for (const date of DATES) {
  const dayData = loadDayData(date);
  if (dayData.length === 0) { console.log(`  ${date}: データなし`); continue; }
  const { trades, totalPnl } = simulateDay(dayData, false);
  const wins = trades.filter(t => t.pnl && t.pnl > 0).length;
  const losses = trades.filter(t => t.pnl && t.pnl < 0).length;
  const stopLosses = trades.filter(t => t.reason === "損切り").length;
  const entryTrades = trades.filter(t => t.action === "buy" || t.action === "short").length;
  resultsFixed.push({ date, pnl: totalPnl, trades: entryTrades, wins, losses, stopLosses });
  console.log(`  ${date}: 損益 ${totalPnl >= 0 ? "+" : ""}${Math.round(totalPnl).toLocaleString()}円 | 取引${entryTrades}回 | 勝${wins} 負${losses} | 損切り${stopLosses}回`);
}

console.log("");

// 改良策1版（B・C適用、ATR連動動的SL/TP）
const resultsDynamic: { date: string; pnl: number; trades: number; wins: number; losses: number; stopLosses: number }[] = [];
const allSlPcts: number[] = [];
const allTpPcts: number[] = [];
console.log("--- 改良策1版（B・C適用、ATR連動動的SL/TP） ---");
for (const date of DATES) {
  const dayData = loadDayData(date);
  if (dayData.length === 0) { console.log(`  ${date}: データなし`); continue; }
  const { trades, totalPnl, slStats } = simulateDay(dayData, true);
  const wins = trades.filter(t => t.pnl && t.pnl > 0).length;
  const losses = trades.filter(t => t.pnl && t.pnl < 0).length;
  const stopLosses = trades.filter(t => t.reason === "損切り").length;
  const entryTrades = trades.filter(t => t.action === "buy" || t.action === "short").length;
  resultsDynamic.push({ date, pnl: totalPnl, trades: entryTrades, wins, losses, stopLosses });
  allSlPcts.push(...slStats.slPcts);
  allTpPcts.push(...slStats.tpPcts);
  console.log(`  ${date}: 損益 ${totalPnl >= 0 ? "+" : ""}${Math.round(totalPnl).toLocaleString()}円 | 取引${entryTrades}回 | 勝${wins} 負${losses} | 損切り${stopLosses}回`);
}

console.log("");
console.log("=".repeat(80));
console.log("集計結果");
console.log("=".repeat(80));

const fixedTotal = resultsFixed.reduce((s, r) => s + r.pnl, 0);
const fixedTrades = resultsFixed.reduce((s, r) => s + r.trades, 0);
const fixedWins = resultsFixed.reduce((s, r) => s + r.wins, 0);
const fixedLosses = resultsFixed.reduce((s, r) => s + r.losses, 0);
const fixedSL = resultsFixed.reduce((s, r) => s + r.stopLosses, 0);

const dynTotal = resultsDynamic.reduce((s, r) => s + r.pnl, 0);
const dynTrades = resultsDynamic.reduce((s, r) => s + r.trades, 0);
const dynWins = resultsDynamic.reduce((s, r) => s + r.wins, 0);
const dynLosses = resultsDynamic.reduce((s, r) => s + r.losses, 0);
const dynSL = resultsDynamic.reduce((s, r) => s + r.stopLosses, 0);

console.log("");
console.log(`                    | 現行版（固定SL/TP） | 改良策1（ATR連動）  | 変化`);
console.log(`--------------------+--------------------+--------------------+----------`);
console.log(`合計損益            | ${fixedTotal >= 0 ? "+" : ""}${Math.round(fixedTotal).toLocaleString().padStart(12)}円 | ${dynTotal >= 0 ? "+" : ""}${Math.round(dynTotal).toLocaleString().padStart(12)}円 | ${(dynTotal - fixedTotal) >= 0 ? "+" : ""}${Math.round(dynTotal - fixedTotal).toLocaleString()}円`);
console.log(`取引回数            | ${String(fixedTrades).padStart(12)}回 | ${String(dynTrades).padStart(12)}回 | ${dynTrades - fixedTrades >= 0 ? "+" : ""}${dynTrades - fixedTrades}回`);
console.log(`勝率                | ${((fixedWins / (fixedWins + fixedLosses)) * 100).toFixed(1).padStart(11)}% | ${((dynWins / (dynWins + dynLosses)) * 100).toFixed(1).padStart(11)}% | ${(((dynWins / (dynWins + dynLosses)) - (fixedWins / (fixedWins + fixedLosses))) * 100).toFixed(1)}pt`);
console.log(`損切り回数          | ${String(fixedSL).padStart(12)}回 | ${String(dynSL).padStart(12)}回 | ${dynSL - fixedSL >= 0 ? "+" : ""}${dynSL - fixedSL}回`);
console.log(`1取引平均損益       | ${fixedTrades > 0 ? (fixedTotal / fixedTrades >= 0 ? "+" : "") + Math.round(fixedTotal / fixedTrades).toLocaleString() : "N/A"}円 | ${dynTrades > 0 ? (dynTotal / dynTrades >= 0 ? "+" : "") + Math.round(dynTotal / dynTrades).toLocaleString() : "N/A"}円 |`);

// ATR連動SL/TPの統計
if (allSlPcts.length > 0) {
  const avgSL = allSlPcts.reduce((s, v) => s + v, 0) / allSlPcts.length;
  const avgTP = allTpPcts.reduce((s, v) => s + v, 0) / allTpPcts.length;
  const minSL = Math.min(...allSlPcts);
  const maxSL = Math.max(...allSlPcts);
  console.log("");
  console.log("--- ATR連動SL/TP統計 ---");
  console.log(`  平均SL幅: ${avgSL.toFixed(3)}% | 平均TP幅: ${avgTP.toFixed(3)}%`);
  console.log(`  SL幅範囲: ${minSL.toFixed(3)}% 〜 ${maxSL.toFixed(3)}%`);
  console.log(`  SL=0.5%（最小値）に張り付いた回数: ${allSlPcts.filter(v => v === ATR_SL_MIN_PERCENT).length}/${allSlPcts.length}`);
  console.log(`  SL=1.0%（最大値）に張り付いた回数: ${allSlPcts.filter(v => v === ATR_SL_MAX_PERCENT).length}/${allSlPcts.length}`);
}

// 日別比較
console.log("");
console.log("--- 日別比較 ---");
for (let i = 0; i < DATES.length; i++) {
  const f = resultsFixed[i];
  const d = resultsDynamic[i];
  if (!f || !d) continue;
  const diff = d.pnl - f.pnl;
  console.log(`  ${f.date}: 固定${f.pnl >= 0 ? "+" : ""}${Math.round(f.pnl).toLocaleString()}円 → 動的${d.pnl >= 0 ? "+" : ""}${Math.round(d.pnl).toLocaleString()}円 (${diff >= 0 ? "+" : ""}${Math.round(diff).toLocaleString()}円) | SL: ${f.stopLosses}→${d.stopLosses}回`);
}
