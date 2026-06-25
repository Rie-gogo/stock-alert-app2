/**
 * sim_time_filter_sweep.ts
 * 改良策5: 時間帯フィルタースイープ
 * 
 * 現行ベースライン（③改 medium直接禁止適用後）に対して、
 * 追加の時間帯フィルターを適用した場合の効果を検証する。
 * 
 * 検証パターン:
 * 1. 前場序盤（09:30〜10:00）エントリー禁止
 * 2. 前場序盤（09:30〜09:45）エントリー禁止
 * 3. 昼休み前（11:00〜11:30）エントリー禁止
 * 4. 後場序盤（12:30〜13:00）エントリー禁止
 * 5. 後場後半のみ許可（14:00〜15:15のみ）
 * 6. 10:00〜14:30のみ許可（ゴールデンタイム限定）
 * 7. 各種組み合わせ
 * 
 * 実行: cd /home/ubuntu/stock-alert-app && npx tsx analysis/sim_time_filter_sweep.ts
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
const SL_PCT = 0.5;
const TP_PCT = 1.5;

interface TimeFilter {
  label: string;
  // エントリー禁止時間帯リスト（start〜endの範囲でエントリー禁止）
  blockedWindows: { start: string; end: string }[];
  // 板読みスコア引き上げ時間帯（この時間帯では閾値を引き上げ）
  elevatedScoreWindows?: { start: string; end: string; threshold: number }[];
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

function detectMarketMode(bprHistoryArr: number[], snapshot: BoardSnapshot): string {
  const bpr = snapshot.buyPressureRatio;
  if (bprHistoryArr.length >= 3 && bprHistoryArr.every(h => h >= 0.85 && h <= 1.15) && bpr >= 0.85 && bpr <= 1.15) return "quiet";
  if (bpr > 1.2 || bpr < 0.8) return "active";
  if (bprHistoryArr.length >= 3) { const delta = Math.abs(bprHistoryArr[bprHistoryArr.length - 1] - bprHistoryArr[0]); if (delta >= 0.1) return "building"; }
  return "trap";
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

function shouldBoardEarlyExit(pos: OpenPosition, currentPrice: number, snapshot: BoardSnapshot | null): boolean {
  if (!snapshot) return false;
  const profitPct = pos.side === "long" ? (currentPrice - pos.entryPrice) / pos.entryPrice * 100 : (pos.entryPrice - currentPrice) / pos.entryPrice * 100;
  if (profitPct < BOARD_EARLY_EXIT_MIN_PROFIT_PCT) return false;
  if (pos.side === "long" && (snapshot.signal === "sell_pressure" || snapshot.signal === "large_sell_wall")) return true;
  if (pos.side === "short" && (snapshot.signal === "buy_pressure" || snapshot.signal === "large_buy_wall")) return true;
  return false;
}

// === 時間帯フィルター判定 ===
function isTimeBlocked(candleTime: string, filter: TimeFilter, boardScore: number): boolean {
  // エントリー禁止時間帯チェック
  for (const w of filter.blockedWindows) {
    if (candleTime >= w.start && candleTime < w.end) return true;
  }
  // 板読みスコア引き上げ時間帯チェック
  if (filter.elevatedScoreWindows) {
    for (const w of filter.elevatedScoreWindows) {
      if (candleTime >= w.start && candleTime < w.end) {
        if (boardScore < w.threshold) return true;
      }
    }
  }
  return false;
}

// === シミュレーション関数 ===
function simulateDay(dayData: RtCandleRow[], filter: TimeFilter): { trades: Trade[]; totalPnl: number; timeBlockedCount: number; entryByHour: Map<string, { count: number; pnl: number }> } {
  const buffers = new Map<string, CandleWithSignal[]>();
  const openPositions = new Map<string, OpenPosition>();
  const pullbackStates = new Map<string, any>();
  const roundLevelPendingStates = new Map<string, any>();
  const roundPullbackStates = new Map<string, any>();
  const bprHistories = new Map<string, number[]>();
  const lastStopLossTime = new Map<string, string>();
  const trades: Trade[] = [];
  let totalPnl = 0;
  let timeBlockedCount = 0;
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
        // エントリー時間帯別集計
        const hour = existingPos.entryTime.substring(0, 2);
        const hourData = entryByHour.get(hour) ?? { count: 0, pnl: 0 };
        hourData.count++; hourData.pnl += pnl;
        entryByHour.set(hour, hourData);
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
        // エントリー時間帯別集計
        const hour = existingPos.entryTime.substring(0, 2);
        const hourData = entryByHour.get(hour) ?? { count: 0, pnl: 0 };
        hourData.count++; hourData.pnl += pnl;
        entryByHour.set(hour, hourData);
        openPositions.delete(symbol); if (exitReason === "損切り") lastStopLossTime.set(symbol, candleTime);
      }
      continue;
    }

    // エントリー禁止（基本）
    if (candleTime < NO_ENTRY_BEFORE || candleTime >= NO_ENTRY_AFTER) continue;
    if (buffer.length < MIN_CANDLES_FOR_SIGNAL) continue;

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
          if (brScore < 1) continue;
          // ★時間帯フィルター（ステートマシン経由エントリーにも適用）
          if (isTimeBlocked(candleTime, filter, brScore)) { timeBlockedCount++; continue; }
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
        if (brScore < 1) continue;
        // ★時間帯フィルター
        if (isTimeBlocked(candleTime, filter, brScore)) { timeBlockedCount++; continue; }
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
          if (brScore < 1) continue;
          // ★時間帯フィルター
          if (isTimeBlocked(candleTime, filter, brScore)) { timeBlockedCount++; continue; }
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
          if (brScore < 1) continue;
          // ★時間帯フィルター
          if (isTimeBlocked(candleTime, filter, brScore)) { timeBlockedCount++; continue; }
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
    // ★改良策3改: medium直接エントリー禁止（常に適用）
    const isMedium = sig.confidence === "medium";

    // 買いエントリー
    if (sig.type === "buy" && !openPositions.has(symbol)) {
      if (sig.reason?.includes("VWAPクロス上抜け")) continue;
      if (boardSnapshot?.signal === "sell_pressure") continue;
      const brScore = getBoardScore("long");
      if (brScore < 1) continue;

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
        // 直接エントリー: mediumブロック
        if (isMedium) continue;
        // ★時間帯フィルター
        if (isTimeBlocked(candleTime, filter, brScore)) { timeBlockedCount++; continue; }
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
      if (brScore < 1) continue;

      if (sig.reason?.startsWith("ダウ理論: 直近安値更新")) {
        const htf = getHigherTfTrend(buffer, buffer.length - 1, 5);
        if (htf !== "down") continue;
        if (buffer.length >= PULLBACK_DEPTH_LOOKBACK) { const lw = buffer.slice(-PULLBACK_DEPTH_LOOKBACK); const sh = Math.max(...lw.map(c => c.high)); const sl2 = Math.min(...lw.map(c => c.low)); if (sh > sl2) { const pd = (close - sl2) / (sh - sl2); if (pd < PULLBACK_DEPTH_MIN || pd > PULLBACK_DEPTH_MAX) continue; } }
      } else if (sig.reason?.startsWith("大台割れ")) {
        const m = sig.reason.match(/(\d+(?:\.\d+)?)円/); const level = m ? parseFloat(m[1]) : close;
        roundLevelPendingStates.set(symbol, { direction: "sell", level, confirmCount: 0, reason: sig.reason });
      } else {
        // 直接エントリー: mediumブロック
        if (isMedium) continue;
        // ★時間帯フィルター
        if (isTimeBlocked(candleTime, filter, brScore)) { timeBlockedCount++; continue; }
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
    const hour = pos.entryTime.substring(0, 2);
    const hourData = entryByHour.get(hour) ?? { count: 0, pnl: 0 };
    hourData.count++; hourData.pnl += pnl;
    entryByHour.set(hour, hourData);
    trades.push({ date: last.tradeDate, time: last.candleTime, sym: symbol, action: "forced_close", price: last.close, pnl, reason: "データ終了時決済", shares: pos.shares });
  }

  return { trades, totalPnl, timeBlockedCount, entryByHour };
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

// === スイープ設定 ===
const FILTERS: TimeFilter[] = [
  // ベースライン（フィルターなし）
  { label: "ベースライン（③改適用後, 時間帯フィルターなし）", blockedWindows: [] },

  // 単体フィルター
  { label: "A: 前場序盤禁止（09:30-10:00）", blockedWindows: [{ start: "09:30", end: "10:00" }] },
  { label: "B: 前場序盤禁止（09:30-09:45）", blockedWindows: [{ start: "09:30", end: "09:45" }] },
  { label: "C: 昼休み前禁止（11:00-11:30）", blockedWindows: [{ start: "11:00", end: "11:30" }] },
  { label: "D: 後場序盤禁止（12:30-13:00）", blockedWindows: [{ start: "12:30", end: "13:00" }] },
  { label: "E: 後場序盤禁止（12:30-13:30）", blockedWindows: [{ start: "12:30", end: "13:30" }] },
  { label: "F: 大引け前禁止（14:30-15:15）", blockedWindows: [{ start: "14:30", end: "15:15" }] },
  { label: "G: 大引け前禁止（14:00-15:15）", blockedWindows: [{ start: "14:00", end: "15:15" }] },

  // 組み合わせフィルター
  { label: "H: A+C（前場序盤+昼休み前禁止）", blockedWindows: [{ start: "09:30", end: "10:00" }, { start: "11:00", end: "11:30" }] },
  { label: "I: A+D（前場序盤+後場序盤禁止）", blockedWindows: [{ start: "09:30", end: "10:00" }, { start: "12:30", end: "13:00" }] },
  { label: "J: A+C+D（前場序盤+昼前+後場序盤禁止）", blockedWindows: [{ start: "09:30", end: "10:00" }, { start: "11:00", end: "11:30" }, { start: "12:30", end: "13:00" }] },
  { label: "K: B+E（序盤15分+後場30分禁止）", blockedWindows: [{ start: "09:30", end: "09:45" }, { start: "12:30", end: "13:30" }] },

  // ゴールデンタイム限定
  { label: "L: 10:00-14:30のみ許可", blockedWindows: [{ start: "09:30", end: "10:00" }, { start: "14:30", end: "15:15" }] },
  { label: "M: 10:00-14:00のみ許可", blockedWindows: [{ start: "09:30", end: "10:00" }, { start: "14:00", end: "15:15" }] },
  { label: "N: 10:00-11:30 + 12:30-14:30のみ許可", blockedWindows: [{ start: "09:30", end: "10:00" }, { start: "11:00", end: "12:30" }, { start: "14:30", end: "15:15" }] },

  // 板読みスコア引き上げ方式
  { label: "O: 前場序盤は板スコア≥3で許可", blockedWindows: [], elevatedScoreWindows: [{ start: "09:30", end: "10:00", threshold: 3 }] },
  { label: "P: 前場序盤は板スコア≥2で許可", blockedWindows: [], elevatedScoreWindows: [{ start: "09:30", end: "10:00", threshold: 2 }] },
  { label: "Q: 前場序盤+後場序盤は板スコア≥2で許可", blockedWindows: [], elevatedScoreWindows: [{ start: "09:30", end: "10:00", threshold: 2 }, { start: "12:30", end: "13:00", threshold: 2 }] },
];

// === メイン ===
console.log("=".repeat(80));
console.log("改良策5: 時間帯フィルタースイープ");
console.log("（③改 medium直接禁止適用後ベース、6日間、6/23除外）");
console.log("=".repeat(80));
console.log("");

// データプリロード
const allDayData = new Map<string, RtCandleRow[]>();
for (const date of DATES) { allDayData.set(date, loadDayData(date)); }

interface Result { label: string; totalPnl: number; trades: number; wins: number; losses: number; slCount: number; tpCount: number; timeBlocked: number; daily: { date: string; pnl: number; trades: number }[]; entryByHour: Map<string, { count: number; pnl: number }>; }
const results: Result[] = [];

for (const filter of FILTERS) {
  let totalPnl = 0, totalTrades = 0, totalWins = 0, totalLosses = 0, totalSL = 0, totalTP = 0, totalTimeBlocked = 0;
  const daily: { date: string; pnl: number; trades: number }[] = [];
  const aggEntryByHour = new Map<string, { count: number; pnl: number }>();

  for (const date of DATES) {
    const dayData = allDayData.get(date)!;
    if (dayData.length === 0) { daily.push({ date, pnl: 0, trades: 0 }); continue; }
    const result = simulateDay(dayData, filter);
    const closed = result.trades.filter(t => t.pnl !== undefined);
    totalPnl += result.totalPnl; totalTrades += closed.length;
    totalWins += closed.filter(t => (t.pnl ?? 0) > 0).length;
    totalLosses += closed.filter(t => (t.pnl ?? 0) < 0).length;
    totalSL += result.trades.filter(t => t.reason === "損切り").length;
    totalTP += result.trades.filter(t => t.reason === "利確").length;
    totalTimeBlocked += result.timeBlockedCount;
    daily.push({ date, pnl: result.totalPnl, trades: closed.length });
    // 時間帯別集計
    for (const [hour, data] of result.entryByHour) {
      const agg = aggEntryByHour.get(hour) ?? { count: 0, pnl: 0 };
      agg.count += data.count; agg.pnl += data.pnl;
      aggEntryByHour.set(hour, agg);
    }
  }

  results.push({ label: filter.label, totalPnl, trades: totalTrades, wins: totalWins, losses: totalLosses, slCount: totalSL, tpCount: totalTP, timeBlocked: totalTimeBlocked, daily, entryByHour: aggEntryByHour });
}

// ランキング出力
console.log("=".repeat(80));
console.log("結果ランキング（損益順）");
console.log("=".repeat(80));
console.log("");

const baseline = results[0];
const sorted2 = [...results].sort((a, b) => b.totalPnl - a.totalPnl);

console.log("順位 | パラメータ                                           | 合計損益      | 差分         | 取引 | 勝率  | SL | TP | 時間ブロック");
console.log("-----|------------------------------------------------------|--------------|-------------|------|-------|----|----|--------");
for (let i = 0; i < sorted2.length; i++) {
  const r = sorted2[i];
  const diff = r.totalPnl - baseline.totalPnl;
  const wr = r.trades > 0 ? Math.round(r.wins / r.trades * 100) : 0;
  console.log(`${String(i+1).padStart(4)} | ${r.label.padEnd(52)} | ${(r.totalPnl >= 0 ? "+" : "") + Math.round(r.totalPnl).toLocaleString().padStart(10)}円 | ${(diff >= 0 ? "+" : "") + Math.round(diff).toLocaleString().padStart(9)}円 | ${String(r.trades).padStart(4)} | ${String(wr).padStart(3)}%  | ${String(r.slCount).padStart(2)} | ${String(r.tpCount).padStart(2)} | ${String(r.timeBlocked).padStart(5)}`);
}

// ベースラインの時間帯別エントリー分析
console.log("");
console.log("=".repeat(80));
console.log("ベースラインのエントリー時間帯別パフォーマンス");
console.log("=".repeat(80));
console.log("");
console.log("時間帯 | エントリー数 | 合計損益      | 平均損益/件");
console.log("-------|------------|--------------|----------");
const baselineHours = results[0].entryByHour;
const sortedHours = [...baselineHours.entries()].sort((a, b) => a[0].localeCompare(b[0]));
for (const [hour, data] of sortedHours) {
  const avg = data.count > 0 ? Math.round(data.pnl / data.count) : 0;
  console.log(`${hour}時台 | ${String(data.count).padStart(8)}件 | ${(data.pnl >= 0 ? "+" : "") + Math.round(data.pnl).toLocaleString().padStart(10)}円 | ${(avg >= 0 ? "+" : "") + avg.toLocaleString().padStart(8)}円`);
}

// 日別比較（上位5パターン）
console.log("");
console.log("=".repeat(80));
console.log("日別損益比較（上位5パターン）");
console.log("=".repeat(80));
console.log("");
const top5 = sorted2.slice(0, 5);
const headerLabels = top5.map((r, i) => `#${i+1}(${r.label.substring(0, 12)})`);
console.log(`日付       | ${headerLabels.join(" | ")}`);
console.log(`-----------|${headerLabels.map(() => "-------------").join("|")}`);
for (let i = 0; i < DATES.length; i++) {
  const d = DATES[i];
  const vals = top5.map(r => {
    const day = r.daily[i];
    return `${day.pnl >= 0 ? "+" : ""}${Math.round(day.pnl).toLocaleString().padStart(8)}円`;
  });
  console.log(`${d} | ${vals.join(" | ")}`);
}

// 結果をファイルに保存
const output = results.map(r => ({
  label: r.label,
  totalPnl: Math.round(r.totalPnl),
  trades: r.trades,
  winRate: r.trades > 0 ? Math.round(r.wins / r.trades * 100) : 0,
  slCount: r.slCount,
  tpCount: r.tpCount,
  timeBlocked: r.timeBlocked,
  daily: r.daily.map(d => ({ ...d, pnl: Math.round(d.pnl) })),
}));
fs.writeFileSync("/tmp/time_filter_sweep_result.json", JSON.stringify(output, null, 2));
console.log("\n結果を /tmp/time_filter_sweep_result.json に保存しました。");
