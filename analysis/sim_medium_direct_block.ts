/**
 * sim_medium_direct_block.ts
 * 改良策3改: mediumシグナルの直接エントリーを禁止
 * 
 * ルール:
 * - mediumシグナルはステートマシンのトリガー（ダウ理論→押し目、大台→確認）としてのみ使用
 * - mediumシグナルによる直接エントリー（三尊、逆三尊、長い上ヒゲ、RSI系等）は禁止
 * - strongシグナルは従来通り全て許可
 * 
 * さらに②の高ボラSL0.8/TP2.4との組み合わせも検証
 * 
 * 実行: cd /home/ubuntu/stock-alert-app && npx tsx analysis/sim_medium_direct_block.ts
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

// === 高ボラ銘柄リスト（前回分析結果） ===
const HIGH_VOL_SYMBOLS = new Set(["6920", "6981", "6976", "5016", "6526", "5803"]);

interface SimConfig {
  label: string;
  blockMediumDirect: boolean; // mediumの直接エントリーを禁止するか
  highVolSL: number;
  highVolTP: number;
  defaultSL: number;
  defaultTP: number;
}

// === 型定義 ===
interface RtCandleRow { symbol: string; tradeDate: string; candleTime: string; open: number; high: number; low: number; close: number; volume: number; boardSnapshot: BoardSnapshot | null; }
interface OpenPosition { symbol: string; side: "long" | "short"; entryPrice: number; shares: number; entryTime: string; entryReason: string; }
interface Trade { date: string; time: string; sym: string; action: string; price: number; pnl?: number; reason: string; shares: number; confidence?: string; blockedReason?: string; }

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

// === ステートマシントリガー判定 ===
function isStateMachineTrigger(reason: string | undefined): boolean {
  if (!reason) return false;
  // ダウ理論（押し目ステートマシンのトリガー）
  if (reason.startsWith("ダウ理論: 直近高値更新")) return true;
  if (reason.startsWith("ダウ理論: 直近安値更新")) return true;
  // 大台（大台確認ステートマシンのトリガー）
  if (reason.startsWith("大台超え")) return true;
  if (reason.startsWith("大台割れ")) return true;
  return false;
}

// === シミュレーション関数 ===
function simulateDay(dayData: RtCandleRow[], config: SimConfig): { trades: Trade[]; totalPnl: number; blockedCount: number; blockedReasons: string[] } {
  const buffers = new Map<string, CandleWithSignal[]>();
  const openPositions = new Map<string, OpenPosition>();
  const pullbackStates = new Map<string, any>();
  const roundLevelPendingStates = new Map<string, any>();
  const roundPullbackStates = new Map<string, any>();
  const bprHistories = new Map<string, number[]>();
  const lastStopLossTime = new Map<string, string>();
  const trades: Trade[] = [];
  const blockedReasons: string[] = [];
  let totalPnl = 0;
  let blockedCount = 0;

  const sorted = dayData
    .filter(c => ALLOWED_SYMBOLS.has(c.symbol))
    .filter(c => !(c.candleTime >= "11:30" && c.candleTime < "12:30"))
    .sort((a, b) => a.candleTime < b.candleTime ? -1 : a.candleTime > b.candleTime ? 1 : a.symbol < b.symbol ? -1 : 1);

  for (const candle of sorted) {
    const { symbol, candleTime, open, high, low, close, volume, boardSnapshot } = candle;
    const tradeDate = candle.tradeDate;
    
    // 銘柄別SL/TP
    const slPct = HIGH_VOL_SYMBOLS.has(symbol) ? config.highVolSL : config.defaultSL;
    const tpPct = HIGH_VOL_SYMBOLS.has(symbol) ? config.highVolTP : config.defaultTP;
    
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

    // === ここからが直接エントリー判定 ===
    // mediumの直接エントリーブロック判定
    const isMedium = sig.confidence === "medium";
    const isTrigger = isStateMachineTrigger(sig.reason);

    // 買いエントリー
    if (sig.type === "buy" && !openPositions.has(symbol)) {
      if (sig.reason?.includes("VWAPクロス上抜け")) continue;
      if (boardSnapshot?.signal === "sell_pressure") continue;
      const brScore = getBoardScore("long");
      if (brScore < 1) continue;
      
      if (sig.reason?.startsWith("ダウ理論: 直近高値更新") && sig.recentSwingLow != null) {
        // ステートマシントリガー → mediumでもOK
        const htf = getHigherTfTrend(buffer, buffer.length - 1, 5);
        if (htf === "up" && buffer.length >= PULLBACK_DEPTH_LOOKBACK) {
          const lw = buffer.slice(-PULLBACK_DEPTH_LOOKBACK); const sh = Math.max(...lw.map(c => c.high)); const sl2 = Math.min(...lw.map(c => c.low));
          if (sh > sl2) { const pd = (sh - close) / (sh - sl2); if (pd >= PULLBACK_DEPTH_MIN && pd <= PULLBACK_DEPTH_MAX) { pullbackStates.set(symbol, { recentSwingLow: sig.recentSwingLow, signalPrice: close, waitCount: 0, pulledBack: false, reason: sig.reason }); } }
        }
      } else if (sig.reason?.startsWith("大台超え")) {
        // ステートマシントリガー → mediumでもOK
        const m = sig.reason.match(/(\d+(?:\.\d+)?)円/); const level = m ? parseFloat(m[1]) : close;
        roundLevelPendingStates.set(symbol, { direction: "buy", level, confirmCount: 0, reason: sig.reason });
      } else {
        // === 直接エントリー: mediumブロック判定 ===
        if (config.blockMediumDirect && isMedium) {
          blockedCount++;
          blockedReasons.push(`${tradeDate} ${candleTime} ${symbol} BUY blocked: ${sig.reason}`);
          continue;
        }
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
      if (brScore < 1) continue;
      
      if (sig.reason?.startsWith("ダウ理論: 直近安値更新")) {
        // ステートマシントリガー → mediumでもOK
        const htf = getHigherTfTrend(buffer, buffer.length - 1, 5);
        if (htf !== "down") continue;
        if (buffer.length >= PULLBACK_DEPTH_LOOKBACK) { const lw = buffer.slice(-PULLBACK_DEPTH_LOOKBACK); const sh = Math.max(...lw.map(c => c.high)); const sl2 = Math.min(...lw.map(c => c.low)); if (sh > sl2) { const pd = (close - sl2) / (sh - sl2); if (pd < PULLBACK_DEPTH_MIN || pd > PULLBACK_DEPTH_MAX) continue; } }
      } else if (sig.reason?.startsWith("大台割れ")) {
        // ステートマシントリガー → mediumでもOK
        const m = sig.reason.match(/(\d+(?:\.\d+)?)円/); const level = m ? parseFloat(m[1]) : close;
        roundLevelPendingStates.set(symbol, { direction: "sell", level, confirmCount: 0, reason: sig.reason });
      } else {
        // === 直接エントリー: mediumブロック判定 ===
        if (config.blockMediumDirect && isMedium) {
          blockedCount++;
          blockedReasons.push(`${tradeDate} ${candleTime} ${symbol} SELL blocked: ${sig.reason}`);
          continue;
        }
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
  }

  return { trades, totalPnl, blockedCount, blockedReasons };
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
console.log("改良策3改 + 改良策4: medium直接エントリー禁止 & 高ボラSL/TP最適化");
console.log("（B・C適用版ベース、6日間、6/23除外）");
console.log("=".repeat(80));
console.log("");

// データプリロード
const allDayData = new Map<string, RtCandleRow[]>();
for (const date of DATES) { allDayData.set(date, loadDayData(date)); }

// テスト設定
const CONFIGS: SimConfig[] = [
  // ベースライン
  { label: "ベースライン（現行: SL0.5/TP1.5, medium直接OK）", blockMediumDirect: false, highVolSL: 0.5, highVolTP: 1.5, defaultSL: 0.5, defaultTP: 1.5 },
  
  // ③ medium直接エントリー禁止のみ
  { label: "③ medium直接禁止のみ（SL/TP現行）", blockMediumDirect: true, highVolSL: 0.5, highVolTP: 1.5, defaultSL: 0.5, defaultTP: 1.5 },
  
  // ② 高ボラSL0.8/TP2.4のみ
  { label: "② 高ボラSL0.8/TP2.4のみ（medium直接OK）", blockMediumDirect: false, highVolSL: 0.8, highVolTP: 2.4, defaultSL: 0.5, defaultTP: 1.5 },
  
  // ②+③ 組み合わせ
  { label: "②+③ 高ボラSL0.8/TP2.4 + medium直接禁止", blockMediumDirect: true, highVolSL: 0.8, highVolTP: 2.4, defaultSL: 0.5, defaultTP: 1.5 },
  
  // 追加: 高ボラSL0.7/TP2.1 + medium直接禁止
  { label: "高ボラSL0.7/TP2.1 + medium直接禁止", blockMediumDirect: true, highVolSL: 0.7, highVolTP: 2.1, defaultSL: 0.5, defaultTP: 1.5 },
  
  // 追加: 高ボラSL1.0/TP3.0 + medium直接禁止
  { label: "高ボラSL1.0/TP3.0 + medium直接禁止", blockMediumDirect: true, highVolSL: 1.0, highVolTP: 3.0, defaultSL: 0.5, defaultTP: 1.5 },
];

interface Result { label: string; totalPnl: number; trades: number; wins: number; losses: number; slCount: number; tpCount: number; blockedCount: number; daily: { date: string; pnl: number; trades: number }[]; }
const results: Result[] = [];

for (const config of CONFIGS) {
  let totalPnl = 0, totalTrades = 0, totalWins = 0, totalLosses = 0, totalSL = 0, totalTP = 0, totalBlocked = 0;
  const daily: { date: string; pnl: number; trades: number }[] = [];
  let allBlockedReasons: string[] = [];
  
  for (const date of DATES) {
    const dayData = allDayData.get(date)!;
    if (dayData.length === 0) { daily.push({ date, pnl: 0, trades: 0 }); continue; }
    const result = simulateDay(dayData, config);
    const closed = result.trades.filter(t => t.pnl !== undefined);
    totalPnl += result.totalPnl; totalTrades += closed.length;
    totalWins += closed.filter(t => (t.pnl ?? 0) > 0).length;
    totalLosses += closed.filter(t => (t.pnl ?? 0) < 0).length;
    totalSL += result.trades.filter(t => t.reason === "損切り").length;
    totalTP += result.trades.filter(t => t.reason === "利確").length;
    totalBlocked += result.blockedCount;
    allBlockedReasons.push(...result.blockedReasons);
    daily.push({ date, pnl: result.totalPnl, trades: closed.length });
  }
  
  results.push({ label: config.label, totalPnl, trades: totalTrades, wins: totalWins, losses: totalLosses, slCount: totalSL, tpCount: totalTP, blockedCount: totalBlocked, daily });
  const wr = totalTrades > 0 ? Math.round(totalWins / totalTrades * 100) : 0;
  console.log(`${config.label}`);
  console.log(`  → ${totalPnl >= 0 ? "+" : ""}${Math.round(totalPnl).toLocaleString()}円 (${totalTrades}T, 勝率${wr}%, SL${totalSL}, TP${totalTP}, blocked${totalBlocked})`);
  
  // ブロックされたエントリーの詳細（最初の設定のみ）
  if (config.blockMediumDirect && config.label.includes("③") && allBlockedReasons.length > 0) {
    console.log(`  ブロックされたmedium直接エントリー (${allBlockedReasons.length}件):`);
    for (const r of allBlockedReasons) console.log(`    ${r}`);
  }
  console.log("");
}

// ランキング
console.log("=".repeat(80));
console.log("結果ランキング（損益順）");
console.log("=".repeat(80));
console.log("");

const baseline = results[0];
const sorted2 = [...results].sort((a, b) => b.totalPnl - a.totalPnl);

console.log("順位 | パラメータ                                        | 合計損益      | 差分         | 取引 | 勝率  | SL | TP | ブロック");
console.log("-----|---------------------------------------------------|--------------|-------------|------|-------|----|----|-------");
for (let i = 0; i < sorted2.length; i++) {
  const r = sorted2[i];
  const diff = r.totalPnl - baseline.totalPnl;
  const wr = r.trades > 0 ? Math.round(r.wins / r.trades * 100) : 0;
  console.log(`${String(i+1).padStart(4)} | ${r.label.padEnd(49)} | ${(r.totalPnl >= 0 ? "+" : "") + Math.round(r.totalPnl).toLocaleString().padStart(10)}円 | ${(diff >= 0 ? "+" : "") + Math.round(diff).toLocaleString().padStart(9)}円 | ${String(r.trades).padStart(4)} | ${String(wr).padStart(3)}%  | ${String(r.slCount).padStart(2)} | ${String(r.tpCount).padStart(2)} | ${String(r.blockedCount).padStart(4)}`);
}

// 日別比較
console.log("");
console.log("=".repeat(80));
console.log("日別損益比較");
console.log("=".repeat(80));
console.log("");
console.log("日付       | ベースライン    | ③medium禁止  | ②高ボラSL    | ②+③組合せ");
console.log("-----------|---------------|-------------|-------------|-------------");
for (let i = 0; i < DATES.length; i++) {
  const d = DATES[i];
  const vals = results.slice(0, 4).map(r => {
    const day = r.daily[i];
    return `${day.pnl >= 0 ? "+" : ""}${Math.round(day.pnl).toLocaleString().padStart(8)}円(${day.trades}T)`;
  });
  console.log(`${d} | ${vals.join(" | ")}`);
}
