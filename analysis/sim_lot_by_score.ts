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
import { calcATR, calcADX } from "../server/intradayRegime";
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

interface LotTier { minScore: number; maxScore: number; shares: number; }
interface LotMultiplier { minScore: number; maxScore: number; multiplier: number; }

interface SimConfig {
  label: string;
  blockMediumDirect: boolean;
  mediumConditionalAllow: boolean;
  mediumMinBoardScore: number;
  mediumMinADX: number;
  timeFilter: boolean;
  pullbackMin: number;
  pullbackMax: number;
  highVolSL: number;
  highVolTP: number;
  defaultSL: number;
  defaultTP: number;
  lotByScore: boolean; // スコア連動ロットを使うか
  lotTiers: LotTier[]; // スコア別ロット設定（固定株数方式）
  lotMultipliers?: LotMultiplier[]; // スコア別倍率設定（資金比率方式）
}

// === 型定義 ===
interface RtCandleRow { symbol: string; tradeDate: string; candleTime: string; open: number; high: number; low: number; close: number; volume: number; boardSnapshot: BoardSnapshot | null; }
interface OpenPosition { symbol: string; side: "long" | "short"; entryPrice: number; shares: number; entryTime: string; entryReason: string; }
interface Trade { date: string; time: string; sym: string; action: string; price: number; pnl?: number; reason: string; shares: number; confidence?: string; blockedReason?: string; }

// === ヘルパー ===
function calcShares(price: number): number { return Math.max(100, Math.floor(Math.floor(INITIAL_CAPITAL_PER_STOCK * LOT_RATIO / price) / 100) * 100); }
function calcSharesByScore(score: number, config: SimConfig, price?: number): number {
  if (!config.lotByScore) return 0;
  // 倍率方式: calcShares(price)の結果に倍率をかける
  if (config.lotMultipliers && config.lotMultipliers.length > 0 && price) {
    const baseShares = calcShares(price);
    for (const tier of config.lotMultipliers) {
      if (score >= tier.minScore && score <= tier.maxScore) {
        return Math.max(100, Math.floor(baseShares * tier.multiplier / 100) * 100);
      }
    }
    return baseShares;
  }
  // 固定株数方式
  for (const tier of config.lotTiers) {
    if (score >= tier.minScore && score <= tier.maxScore) return tier.shares;
  }
  return 100; // default
}
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
    // 改良策5: 時間帯フィルター（11:00-11:30, 12:30-13:00エントリー禁止）
    if (config.timeFilter && ((candleTime >= "11:00" && candleTime < "11:30") || (candleTime >= "12:30" && candleTime < "13:00"))) continue;
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
          const shares = config.lotByScore ? calcSharesByScore(brScore, config, close) : calcShares(close); const amount = close * shares;
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
        const shares = config.lotByScore ? calcSharesByScore(brScore, config, close) : calcShares(close); const amount = close * shares;
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
          const shares = config.lotByScore ? calcSharesByScore(brScore, config, close) : calcShares(close); const amount = close * shares;
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
          const shares = config.lotByScore ? calcSharesByScore(brScore, config, close) : calcShares(close); const amount = close * shares;
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
          if (sh > sl2) { const pd = (sh - close) / (sh - sl2); if (pd >= config.pullbackMin && pd <= config.pullbackMax) { pullbackStates.set(symbol, { recentSwingLow: sig.recentSwingLow, signalPrice: close, waitCount: 0, pulledBack: false, reason: sig.reason }); } }
        }
      } else if (sig.reason?.startsWith("大台超え")) {
        // ステートマシントリガー → mediumでもOK
        const m = sig.reason.match(/(\d+(?:\.\d+)?)円/); const level = m ? parseFloat(m[1]) : close;
        roundLevelPendingStates.set(symbol, { direction: "buy", level, confirmCount: 0, reason: sig.reason });
      } else {
        // === 直接エントリー: mediumブロック判定 ===
        if (config.blockMediumDirect && isMedium) {
          // 条件付き許可: 板読みスコア≥N + ADX≥M
          let allowMedium = false;
          if (config.mediumConditionalAllow) {
            const brScoreForAllow = getBoardScore("long");
            let currentADX = 0;
            if (buffer.length >= 30) {
              const h = buffer.map(c => c.high); const l = buffer.map(c => c.low); const cl = buffer.map(c => c.close);
              const adxArr = calcADX(h, l, cl, 14);
              currentADX = adxArr[adxArr.length - 1] ?? 0;
            }
            if (brScoreForAllow >= config.mediumMinBoardScore && currentADX >= config.mediumMinADX) {
              allowMedium = true;
            }
          }
          if (!allowMedium) {
            blockedCount++;
            blockedReasons.push(`${tradeDate} ${candleTime} ${symbol} BUY blocked: ${sig.reason} (board=${getBoardScore("long")})`);
            continue;
          }
        }
        const shares = config.lotByScore ? calcSharesByScore(brScore, config, close) : calcShares(close); const amount = close * shares;
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
        if (buffer.length >= PULLBACK_DEPTH_LOOKBACK) { const lw = buffer.slice(-PULLBACK_DEPTH_LOOKBACK); const sh = Math.max(...lw.map(c => c.high)); const sl2 = Math.min(...lw.map(c => c.low)); if (sh > sl2) { const pd = (close - sl2) / (sh - sl2); if (pd < config.pullbackMin || pd > config.pullbackMax) continue; } }
      } else if (sig.reason?.startsWith("大台割れ")) {
        // ステートマシントリガー → mediumでもOK
        const m = sig.reason.match(/(\d+(?:\.\d+)?)円/); const level = m ? parseFloat(m[1]) : close;
        roundLevelPendingStates.set(symbol, { direction: "sell", level, confirmCount: 0, reason: sig.reason });
      } else {
        // === 直接エントリー: mediumブロック判定 ===
        if (config.blockMediumDirect && isMedium) {
          // 条件付き許可: 板読みスコア≥N + ADX≥M
          let allowMedium = false;
          if (config.mediumConditionalAllow) {
            const brScoreForAllow = getBoardScore("short");
            let currentADX = 0;
            if (buffer.length >= 30) {
              const h = buffer.map(c => c.high); const l = buffer.map(c => c.low); const cl = buffer.map(c => c.close);
              const adxArr = calcADX(h, l, cl, 14);
              currentADX = adxArr[adxArr.length - 1] ?? 0;
            }
            if (brScoreForAllow >= config.mediumMinBoardScore && currentADX >= config.mediumMinADX) {
              allowMedium = true;
            }
          }
          if (!allowMedium) {
            blockedCount++;
            blockedReasons.push(`${tradeDate} ${candleTime} ${symbol} SELL blocked: ${sig.reason} (board=${getBoardScore("short")})`);
            continue;
          }
        }
        const shares = config.lotByScore ? calcSharesByScore(brScore, config, close) : calcShares(close); const amount = close * shares;
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
console.log("板読みスコア連動ロットサイズ シミュレーション");
console.log("（③改+⑤適用済みベース、7日間: 6/17〜6/25）");
console.log("=".repeat(80));
console.log("");

// データプリロード
const allDayData = new Map<string, RtCandleRow[]>();
for (const date of DATES) { allDayData.set(date, loadDayData(date)); }

// テスト設定
const BASE_CONFIG = {
  blockMediumDirect: true,
  mediumConditionalAllow: false,
  mediumMinBoardScore: 0,
  mediumMinADX: 0,
  timeFilter: true,
  pullbackMin: 0.30,
  pullbackMax: 0.70,
  highVolSL: 0.5,
  highVolTP: 1.5,
  defaultSL: 0.5,
  defaultTP: 1.5,
};

const CONFIGS: SimConfig[] = [
  // ベースライン: 現行仕様（固定ロット）
  { ...BASE_CONFIG, label: "現行仕様（固定ロット）", lotByScore: false, lotTiers: [] },
  
  // 固定株数方式 A: 1-2点→100株、3-5点→200株、6点以上→300株
  { ...BASE_CONFIG, label: "スコア連動A(100/200/300)", lotByScore: true, lotTiers: [
    { minScore: 1, maxScore: 2, shares: 100 },
    { minScore: 3, maxScore: 5, shares: 200 },
    { minScore: 6, maxScore: 10, shares: 300 },
  ] },
];

// 全トレードを保存する構造
interface DetailResult {
  label: string;
  totalPnl: number;
  trades: Trade[];
  daily: { date: string; pnl: number; trades: number }[];
}
const detailResults: DetailResult[] = [];

for (const config of CONFIGS) {
  let totalPnl = 0;
  const allTrades: Trade[] = [];
  const daily: { date: string; pnl: number; trades: number }[] = [];
  
  for (const date of DATES) {
    const dayData = allDayData.get(date)!;
    if (dayData.length === 0) { daily.push({ date, pnl: 0, trades: 0 }); continue; }
    const result = simulateDay(dayData, config);
    const closed = result.trades.filter(t => t.pnl !== undefined);
    totalPnl += result.totalPnl;
    allTrades.push(...result.trades);
    daily.push({ date, pnl: result.totalPnl, trades: closed.length });
  }
  
  detailResults.push({ label: config.label, totalPnl, trades: allTrades, daily });
}

// === サマリー ===
console.log("=".repeat(80));
console.log("サマリー");
console.log("=".repeat(80));
console.log("");

for (const r of detailResults) {
  const closed = r.trades.filter(t => t.pnl !== undefined);
  const wins = closed.filter(t => (t.pnl ?? 0) > 0).length;
  const losses = closed.filter(t => (t.pnl ?? 0) < 0).length;
  const wr = closed.length > 0 ? Math.round(wins / closed.length * 100) : 0;
  const sl = r.trades.filter(t => t.reason === "損切り").length;
  const tp = r.trades.filter(t => t.reason === "利確").length;
  console.log(`${r.label}`);
  console.log(`  合計: ${r.totalPnl >= 0 ? "+" : ""}${Math.round(r.totalPnl).toLocaleString()}円 | ${closed.length}T (${wins}勝${losses}敗) | 勝率${wr}% | SL${sl} TP${tp}`);
  console.log("");
}

// === 日別比較 ===
console.log("=".repeat(80));
console.log("日別損益比較");
console.log("=".repeat(80));
console.log("");
console.log("日付       | 現行(固定ロット)      | スコア連動A(100/200/300) | 差分");
console.log("-----------|---------------------|--------------------------|----------");
for (let i = 0; i < DATES.length; i++) {
  const d = DATES[i];
  const base = detailResults[0].daily[i];
  const a = detailResults[1].daily[i];
  const diff = a.pnl - base.pnl;
  console.log(`${d} | ${(base.pnl >= 0 ? "+" : "") + Math.round(base.pnl).toLocaleString().padStart(8)}円 (${base.trades}T) | ${(a.pnl >= 0 ? "+" : "") + Math.round(a.pnl).toLocaleString().padStart(8)}円 (${a.trades}T)       | ${(diff >= 0 ? "+" : "") + Math.round(diff).toLocaleString()}円`);
}
const totalDiff = detailResults[1].totalPnl - detailResults[0].totalPnl;
console.log(`-----------|---------------------|--------------------------|----------`);
console.log(`合計       | ${(detailResults[0].totalPnl >= 0 ? "+" : "") + Math.round(detailResults[0].totalPnl).toLocaleString().padStart(8)}円       | ${(detailResults[1].totalPnl >= 0 ? "+" : "") + Math.round(detailResults[1].totalPnl).toLocaleString().padStart(8)}円              | ${(totalDiff >= 0 ? "+" : "") + Math.round(totalDiff).toLocaleString()}円`);

// === トレード別詳細比較 ===
console.log("");
console.log("=".repeat(80));
console.log("トレード別詳細比較（現行 vs スコア連動A）");
console.log("=".repeat(80));
console.log("");

const baseTrades = detailResults[0].trades.filter(t => t.pnl !== undefined);
const aTrades = detailResults[1].trades.filter(t => t.pnl !== undefined);

console.log("--- 現行仕様（固定ロット）---");
console.log("# | 日付       | 時刻  | 銀柄   | 方向  | 株数  | エントリー価格 | 決済価格  | 損益       | 理由");
console.log("--|-----------|-------|--------|------|------|-----------|----------|-----------|----------");
for (let i = 0; i < baseTrades.length; i++) {
  const t = baseTrades[i];
  // エントリーを探す
  const entryTrades = detailResults[0].trades.filter(et => et.sym === t.sym && et.date === t.date && (et.action === "buy" || et.action === "short") && !et.pnl);
  const entry = entryTrades.length > 0 ? entryTrades[entryTrades.length - 1] : null;
  const entryPrice = entry ? entry.price : 0;
  const side = t.action.includes("close") || t.reason === "損切り" || t.reason === "利確" ? (entry?.action === "buy" ? "LONG" : "SHORT") : t.action === "buy" ? "LONG" : "SHORT";
  console.log(`${String(i+1).padStart(2)} | ${t.date} | ${t.time} | ${t.sym.padEnd(6)} | ${side.padEnd(5)} | ${String(t.shares).padStart(4)} | ${entryPrice.toLocaleString().padStart(9)} | ${t.price.toLocaleString().padStart(8)} | ${((t.pnl ?? 0) >= 0 ? "+" : "") + Math.round(t.pnl ?? 0).toLocaleString().padStart(8)}円 | ${t.reason}`);
}

console.log("");
console.log("--- スコア連動A (1-2点→100株, 3-5点→200株, 6点以上→300株) ---");
console.log("# | 日付       | 時刻  | 銀柄   | 方向  | 株数  | エントリー価格 | 決済価格  | 損益       | 理由");
console.log("--|-----------|-------|--------|------|------|-----------|----------|-----------|----------");
for (let i = 0; i < aTrades.length; i++) {
  const t = aTrades[i];
  const entryTrades = detailResults[1].trades.filter(et => et.sym === t.sym && et.date === t.date && (et.action === "buy" || et.action === "short") && !et.pnl);
  const entry = entryTrades.length > 0 ? entryTrades[entryTrades.length - 1] : null;
  const entryPrice = entry ? entry.price : 0;
  const side = t.action.includes("close") || t.reason === "損切り" || t.reason === "利確" ? (entry?.action === "buy" ? "LONG" : "SHORT") : t.action === "buy" ? "LONG" : "SHORT";
  console.log(`${String(i+1).padStart(2)} | ${t.date} | ${t.time} | ${t.sym.padEnd(6)} | ${side.padEnd(5)} | ${String(t.shares).padStart(4)} | ${entryPrice.toLocaleString().padStart(9)} | ${t.price.toLocaleString().padStart(8)} | ${((t.pnl ?? 0) >= 0 ? "+" : "") + Math.round(t.pnl ?? 0).toLocaleString().padStart(8)}円 | ${t.reason}`);
}

// === 差分が生じたトレードのハイライト ===
console.log("");
console.log("=".repeat(80));
console.log("差分が生じたトレード（ロットサイズが変わったもの）");
console.log("=".repeat(80));
console.log("");
console.log("日付       | 時刻  | 銀柄   | 方向  | 現行株数 | A株数 | 現行PnL     | A PnL       | 差分       | 理由");
console.log("-----------|-------|--------|------|--------|------|-----------|-------------|-----------|----------");

for (let i = 0; i < Math.max(baseTrades.length, aTrades.length); i++) {
  const bt = baseTrades[i];
  const at = aTrades[i];
  if (!bt || !at) continue;
  if (bt.shares !== at.shares || Math.round(bt.pnl ?? 0) !== Math.round(at.pnl ?? 0)) {
    const diff = (at.pnl ?? 0) - (bt.pnl ?? 0);
    const entryTradesBase = detailResults[0].trades.filter(et => et.sym === bt.sym && et.date === bt.date && (et.action === "buy" || et.action === "short") && !et.pnl);
    const entryBase = entryTradesBase.length > 0 ? entryTradesBase[entryTradesBase.length - 1] : null;
    const side = entryBase?.action === "buy" ? "LONG" : "SHORT";
    console.log(`${bt.date} | ${bt.time} | ${bt.sym.padEnd(6)} | ${side.padEnd(5)} | ${String(bt.shares).padStart(6)} | ${String(at.shares).padStart(4)} | ${((bt.pnl ?? 0) >= 0 ? "+" : "") + Math.round(bt.pnl ?? 0).toLocaleString().padStart(8)}円 | ${((at.pnl ?? 0) >= 0 ? "+" : "") + Math.round(at.pnl ?? 0).toLocaleString().padStart(10)}円 | ${(diff >= 0 ? "+" : "") + Math.round(diff).toLocaleString().padStart(8)}円 | ${bt.reason}`);
  }
}

// === 銀柄別損益比較 ===
console.log("");
console.log("=".repeat(80));
console.log("銀柄別損益比較");
console.log("=".repeat(80));
console.log("");

const symPnlBase = new Map<string, number>();
const symPnlA = new Map<string, number>();
const symTradesBase = new Map<string, number>();
const symTradesA = new Map<string, number>();

for (const t of baseTrades) { symPnlBase.set(t.sym, (symPnlBase.get(t.sym) ?? 0) + (t.pnl ?? 0)); symTradesBase.set(t.sym, (symTradesBase.get(t.sym) ?? 0) + 1); }
for (const t of aTrades) { symPnlA.set(t.sym, (symPnlA.get(t.sym) ?? 0) + (t.pnl ?? 0)); symTradesA.set(t.sym, (symTradesA.get(t.sym) ?? 0) + 1); }

const allSyms = [...new Set([...symPnlBase.keys(), ...symPnlA.keys()])].sort();
console.log("銀柄   | 現行PnL     | A PnL       | 差分       | 現行T | A T");
console.log("-------|-----------|-------------|-----------|-------|-----");
for (const sym of allSyms) {
  const bp = symPnlBase.get(sym) ?? 0;
  const ap = symPnlA.get(sym) ?? 0;
  const diff = ap - bp;
  const bt2 = symTradesBase.get(sym) ?? 0;
  const at2 = symTradesA.get(sym) ?? 0;
  if (bp !== 0 || ap !== 0) {
    console.log(`${sym.padEnd(6)} | ${(bp >= 0 ? "+" : "") + Math.round(bp).toLocaleString().padStart(8)}円 | ${(ap >= 0 ? "+" : "") + Math.round(ap).toLocaleString().padStart(10)}円 | ${(diff >= 0 ? "+" : "") + Math.round(diff).toLocaleString().padStart(8)}円 | ${String(bt2).padStart(5)} | ${String(at2).padStart(4)}`);
  }
}
