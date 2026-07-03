/**
 * sim_atr_dynamic_sl_latest.ts
 * 
 * ATRベース動的SL幅のシミュレーション（最新11日間: 6/19-7/3）
 * sim_atr_sweep_v2.tsをベースに、日付を更新しパラメータを整理。
 * 
 * 比較パターン:
 * A) 現行（固定SL 0.5% / TP 1.5%）
 * B) ATR×1.5 SL[0.3-0.8] TP固定1.5%
 * C) ATR×2.0 SL[0.3-1.0] TP固定1.5%
 * D) ATR×2.5 SL[0.4-1.2] TP固定1.5%
 * E) ATR×3.0 SL[0.5-1.5] TP固定1.5%
 * F) ATR×2.0 SL[0.3-1.0] RR2.0（TP=SL×2）
 * G) ATR×2.5 SL[0.4-1.2] RR2.5（TP=SL×2.5）
 * H) ATR×3.0 SL[0.5-1.5] RR3.0（TP=SL×3）
 * 
 * 実行: cd /home/ubuntu/stock-alert-app && npx tsx analysis/sim_atr_dynamic_sl_latest.ts
 */
import * as fs from "fs";
import { detectSignals, calcMA, calcRSI, calcBollinger, type CandleWithSignal } from "../server/routers/stockData";
import { TARGET_STOCKS } from "../shared/stocks";
import { getHigherTfTrend } from "../server/vwap";
import { calcATR } from "../server/intradayRegime";
import type { BoardSnapshot } from "../drizzle/schema";

// === 定数（現行版と完全一致） ===
const INITIAL_CAPITAL_PER_STOCK = 3_000_000;
const LOT_RATIO = 0.9;
const STOP_LOSS_PERCENT = 0.5;
const TAKE_PROFIT_PERCENT = 1.5;
const BE_TRIGGER_PERCENT = 0.5;
const MARGIN_CAPITAL = 3_000_000;
const MARGIN_MULTIPLIER = 3.3;
const MARGIN_USAGE_LIMIT = 0.9;
const MAX_TOTAL_EXPOSURE = MARGIN_CAPITAL * MARGIN_MULTIPLIER * MARGIN_USAGE_LIMIT;
const NO_ENTRY_AFTER = "15:15";
const NO_ENTRY_BEFORE = "09:30";
const NO_ENTRY_PRE_LUNCH_START = "11:00";
const NO_ENTRY_PRE_LUNCH_END = "11:30";
const NO_ENTRY_POST_LUNCH_START = "12:30";
const NO_ENTRY_POST_LUNCH_END = "13:00";
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
const PM_BPR_BLOCK_THRESHOLD = 0.65;
const PM_BPR_FILTER_START = "13:00";
const B2_THRESHOLD = 0.2;
const VWAP_DROP_FILTER_5BARS = -0.8;
const VWAP_DROP_FILTER_3BARS = -0.6;
const ALLOWED_SYMBOLS = new Set(TARGET_STOCKS.map(s => s.symbol));

// === 型定義 ===
interface RtCandleRow { symbol: string; tradeDate: string; candleTime: string; open: number; high: number; low: number; close: number; volume: number; boardSnapshot: BoardSnapshot | null; }
interface OpenPosition { symbol: string; side: "long" | "short"; entryPrice: number; shares: number; entryTime: string; entryReason: string; slPct: number; tpPct: number; beTriggered: boolean; }
interface Trade { date: string; time: string; sym: string; side: "long" | "short"; price: number; exitPrice: number; pnl: number; reason: string; shares: number; signalReason: string; }
interface AtrSlParams { atrPeriod: number; mult: number; minSl: number; maxSl: number; rrRatio: number; tpFixed: number; mode: "fixed" | "atr_both" | "atr_sl_only"; label: string; }

// === ヘルパー ===
function calcShares(price: number): number { return Math.max(100, Math.floor(Math.floor(INITIAL_CAPITAL_PER_STOCK * LOT_RATIO / price) / 100) * 100); }
function timeToMinutes(t: string): number { const [h, m] = t.split(":").map(Number); return h * 60 + m; }
function checkVolumeUnavailable(buffer: CandleWithSignal[]): boolean { if (buffer.length < 10) return false; const lb = Math.min(buffer.length, 20); const rc = buffer.slice(-lb); return (rc.filter(c => c.volume === 0).length / lb) >= VOLUME_UNAVAILABLE_RATIO; }
function calcCurrentExposure(op: Map<string, OpenPosition>): number { let t = 0; for (const p of op.values()) t += p.entryPrice * p.shares; return t; }

// === ATR連動SL/TP計算 ===
function getDynamicSlTp(buffer: CandleWithSignal[], close: number, params: AtrSlParams): { slPct: number; tpPct: number } {
  if (params.mode === "fixed") return { slPct: STOP_LOSS_PERCENT, tpPct: TAKE_PROFIT_PERCENT };
  const period = params.atrPeriod;
  if (buffer.length < period + 1) return { slPct: STOP_LOSS_PERCENT, tpPct: TAKE_PROFIT_PERCENT };
  const h = buffer.map(c => c.high); const l = buffer.map(c => c.low); const cl = buffer.map(c => c.close);
  const atr = calcATR(h, l, cl, period); const latestATR = atr[atr.length - 1];
  if (latestATR === null || close <= 0) return { slPct: STOP_LOSS_PERCENT, tpPct: TAKE_PROFIT_PERCENT };
  const atrPct = (latestATR / close) * 100 * params.mult;
  const slPct = Math.max(params.minSl, Math.min(params.maxSl, atrPct));
  const tpPct = params.mode === "atr_both" ? slPct * params.rrRatio : params.tpFixed;
  return { slPct, tpPct };
}

// === 板読み関連 ===
function estimateTickDirection(bprHistoryArr: number[], snapshot: BoardSnapshot | null): "uptick" | "downtick" | "neutral" {
  if (!snapshot) return "neutral";
  const mod = (snapshot as any).marketOrderDirection;
  if (mod === "buy") return "uptick";
  if (mod === "sell") return "downtick";
  if (bprHistoryArr.length < 3) return "neutral";
  const recent = bprHistoryArr.slice(-Math.min(5, bprHistoryArr.length));
  const trend = recent[recent.length - 1] - recent[0];
  if (trend >= 0.2) return "uptick";
  if (trend <= -0.2) return "downtick";
  const last = recent[recent.length - 1];
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

function boardReadingScore(bprHistoryArr: number[], side: "long" | "short", snapshot: BoardSnapshot | null): number {
  if (!snapshot) return 1;
  let score = 0; const bpr = snapshot.buyPressureRatio;
  // A: アグレッシブ注文
  if (snapshot.marketOrderRatio >= 0.08) { if (side === "long" && bpr > 1.0) score += 2; else if (side === "long" && bpr < 1.0) score -= 2; else if (side === "short" && bpr < 1.0) score += 2; else if (side === "short" && bpr > 1.0) score -= 2; }
  // B: 壁
  if (side === "long") { if (snapshot.largeSellWall) score += 1; if (snapshot.largeBuyWall) score -= 1; } else { if (snapshot.largeBuyWall) score += 1; if (snapshot.largeSellWall) score -= 1; }
  // C: BPRトレンド
  if (bprHistoryArr.length >= 3) { const delta = bprHistoryArr[bprHistoryArr.length - 1] - bprHistoryArr[0]; if (side === "long" && delta >= 0.15) score += 1; else if (side === "long" && delta <= -0.15) score -= 1; else if (side === "short" && delta <= -0.15) score += 1; else if (side === "short" && delta >= 0.15) score -= 1; }
  // D: マーケットモード
  const { cancelDetected, icebergDetected, icebergSide } = detectFakeOrder(snapshot);
  let mode: string;
  if (cancelDetected) { mode = "trap"; } else { mode = detectMarketMode(bprHistoryArr, snapshot); }
  if (mode === "active" || mode === "building") score += 1; else if (mode === "trap" || mode === "quiet") score -= 2;
  // E: BPR絶対値
  if (side === "long" && bpr >= 1.4) score += 1; else if (side === "long" && bpr <= 0.65) score -= 1; else if (side === "short" && bpr <= 0.65) score += 1; else if (side === "short" && bpr >= 1.4) score -= 1;
  // F: 歩み値方向推定
  const tickDir = estimateTickDirection(bprHistoryArr, snapshot);
  if (tickDir === "uptick") { if (side === "long") score += 2; else score -= 2; } else if (tickDir === "downtick") { if (side === "short") score += 2; else score -= 2; }
  // G: アイスバーグ
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

// === シミュレーション関数 ===
function simulateDay(dayData: RtCandleRow[], atrParams: AtrSlParams): { trades: Trade[]; totalPnl: number } {
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
  let b2Determined = false;
  let b2Direction: "bullish" | "bearish" | "neutral" = "neutral";

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
      const { entryPrice, shares, side, slPct, tpPct } = existingPos;
      
      // BEトリガー
      if (!existingPos.beTriggered) {
        const beLine = side === "long"
          ? entryPrice * (1 + BE_TRIGGER_PERCENT / 100)
          : entryPrice * (1 - BE_TRIGGER_PERCENT / 100);
        const beHit = side === "long" ? high >= beLine : low <= beLine;
        if (beHit) existingPos.beTriggered = true;
      }
      
      let exitPrice: number | null = null;
      let exitReason = "";
      
      if (side === "long") {
        const stopLine = existingPos.beTriggered ? entryPrice : entryPrice * (1 - slPct / 100);
        const tpLine = entryPrice * (1 + tpPct / 100);
        if (low <= stopLine) { exitPrice = stopLine; exitReason = existingPos.beTriggered ? "BE" : "SL"; }
        else if (high >= tpLine) { exitPrice = tpLine; exitReason = "TP"; }
      } else {
        const stopLine = existingPos.beTriggered ? entryPrice : entryPrice * (1 + slPct / 100);
        const tpLine = entryPrice * (1 - tpPct / 100);
        if (high >= stopLine) { exitPrice = stopLine; exitReason = existingPos.beTriggered ? "BE" : "SL"; }
        else if (low <= tpLine) { exitPrice = tpLine; exitReason = "TP"; }
      }
      
      // シグナル反転決済
      if (exitPrice === null && buffer.length >= 2) {
        const prevCandle = buffer[buffer.length - 2];
        if (prevCandle.signal) {
          if (side === "long" && prevCandle.signal.type === "sell") { exitPrice = close; exitReason = "REVERSAL"; }
          else if (side === "short" && prevCandle.signal.type === "buy") { exitPrice = close; exitReason = "REVERSAL"; }
        }
      }
      
      // 板読み早期利確
      if (exitPrice === null && shouldBoardEarlyExit(existingPos, close, boardSnapshot)) { exitPrice = close; exitReason = "BOARD_EXIT"; }
      
      // 大引け強制決済
      if (exitPrice === null && candleTime >= MARKET_CLOSE_TIME) { exitPrice = close; exitReason = "EOD"; }
      
      if (exitPrice !== null) {
        const pnl = side === "long" ? Math.round((exitPrice - entryPrice) * shares) : Math.round((entryPrice - exitPrice) * shares);
        totalPnl += pnl;
        trades.push({ date: tradeDate, time: candleTime, sym: symbol, side, price: entryPrice, exitPrice, pnl, reason: exitReason, shares, signalReason: existingPos.entryReason });
        openPositions.delete(symbol);
        if (exitReason === "SL") lastStopLossTime.set(symbol, candleTime);
      }
      continue;
    }

    // === エントリーロジック ===
    if (candleTime < NO_ENTRY_BEFORE || candleTime >= NO_ENTRY_AFTER) continue;
    if (candleTime >= NO_ENTRY_PRE_LUNCH_START && candleTime < NO_ENTRY_PRE_LUNCH_END) continue;
    if (candleTime >= NO_ENTRY_POST_LUNCH_START && candleTime < NO_ENTRY_POST_LUNCH_END) continue;
    
    // B2方式
    if (!b2Determined && candleTime >= "09:30") {
      let totalChange = 0, count = 0;
      for (const [sym, buf] of Array.from(buffers.entries())) {
        if (buf.length >= 2) {
          const firstC = buf[0]; const latestC = buf[buf.length - 1];
          totalChange += (latestC.close - firstC.open) / firstC.open * 100;
          count++;
        }
      }
      if (count >= 3) {
        const avg = totalChange / count;
        if (avg >= B2_THRESHOLD) b2Direction = "bullish";
        else if (avg <= -B2_THRESHOLD) b2Direction = "bearish";
        else b2Direction = "neutral";
        b2Determined = true;
      }
    }
    
    if (buffer.length < MIN_CANDLES_FOR_SIGNAL) continue;

    // シグナル検出
    const withSignals = detectSignals(buffer);
    const latestSignal = withSignals[withSignals.length - 1];
    buffer[buffer.length - 1] = latestSignal;

    // 板読みスコア計算
    const getBoardScore = (side: "long" | "short") => boardReadingScore(bprHistories.get(symbol) ?? [], side, boardSnapshot);
    
    // 後場BPRフィルター
    const bprHist = bprHistories.get(symbol) ?? [];
    const currentBpr = bprHist.length > 0 ? bprHist[bprHist.length - 1] : 1.0;

    // エントリー用ヘルパー
    const tryEntry = (side: "long" | "short", reason: string): boolean => {
      // 板圧力ブロック
      if (side === "long" && boardSnapshot?.signal === "sell_pressure") return false;
      if (side === "short" && boardSnapshot?.signal === "buy_pressure") return false;
      // 板読みスコア
      const brScore = getBoardScore(side);
      if (brScore < BOARD_SCORE_THRESHOLD) return false;
      // ATRフィルター（エントリー用）
      if (buffer.length >= ATR_FILTER_PERIOD + 1) {
        const h = buffer.map(c => c.high); const l = buffer.map(c => c.low); const cl = buffer.map(c => c.close);
        const atr = calcATR(h, l, cl, ATR_FILTER_PERIOD);
        if (atr[atr.length - 1] !== null && close > 0 && (atr[atr.length - 1]! / close) < ATR_FILTER_THRESHOLD) return false;
      }
      // 出来高不可フィルター
      if (checkVolumeUnavailable(buffer)) return false;
      // ロット計算＆エクスポージャーチェック
      const shares = calcShares(close);
      const amount = close * shares;
      if (calcCurrentExposure(openPositions) + amount > MAX_TOTAL_EXPOSURE) return false;
      // 損切り後再エントリー禁止
      const lastSL = lastStopLossTime.get(symbol);
      if (lastSL && timeToMinutes(candleTime) - timeToMinutes(lastSL) < NO_REENTRY_AFTER_STOPLOSS_MIN) return false;
      // 後場BPRフィルター
      if (side === "short" && candleTime >= PM_BPR_FILTER_START && currentBpr >= PM_BPR_BLOCK_THRESHOLD) return false;
      // ATR動的SL/TP計算
      const { slPct, tpPct } = getDynamicSlTp(buffer, close, atrParams);
      openPositions.set(symbol, { symbol, side, entryPrice: close, shares, entryTime: candleTime, entryReason: reason, slPct, tpPct, beTriggered: false });
      trades.push({ date: tradeDate, time: candleTime, sym: symbol, side, price: close, exitPrice: 0, pnl: 0, reason: "ENTRY", shares, signalReason: reason });
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
          tryEntry("long", `押し目確認: ${ps.reason}`);
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
        tryEntry(side, `${rpb.reason} (押し目なし)`);
        continue;
      }
      if (rpb.direction === "buy") {
        if (!rpb.pulledBack && close < rpb.signalPrice) rpb.pulledBack = true;
        if (rpb.pulledBack && close > rpb.signalPrice) {
          roundPullbackStates.delete(symbol);
          tryEntry("long", `${rpb.reason} (押し目確認後)`);
        }
      } else {
        if (!rpb.pulledBack && close > rpb.signalPrice) rpb.pulledBack = true;
        if (rpb.pulledBack && close < rpb.signalPrice) {
          roundPullbackStates.delete(symbol);
          tryEntry("short", `${rpb.reason} (押し目確認後)`);
        }
      }
      continue;
    }

    const sig = latestSignal.signal;
    if (!sig) continue;

    // 買いエントリー
    if (sig.type === "buy" && !openPositions.has(symbol)) {
      if (sig.reason?.includes("VWAPクロス上抜け")) continue;
      if (sig.confidence === "medium") continue; // BUY medium全ブロック
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
        tryEntry("long", sig.reason || "buy_signal");
      }
    }

    // 売りエントリー
    if (sig.type === "sell" && !openPositions.has(symbol)) {
      // SHORT medium: B2方式（前場bullish時のみブロック）
      if (sig.confidence === "medium" && b2Direction === "bullish") continue;
      if (sig.reason?.startsWith("ダウ理論: 直近安値更新")) {
        const htf = getHigherTfTrend(buffer, buffer.length - 1, 5);
        if (htf !== "down") continue;
        if (buffer.length >= PULLBACK_DEPTH_LOOKBACK) { const lw = buffer.slice(-PULLBACK_DEPTH_LOOKBACK); const sh = Math.max(...lw.map(c => c.high)); const sl2 = Math.min(...lw.map(c => c.low)); if (sh > sl2) { const pd = (close - sl2) / (sh - sl2); if (pd < PULLBACK_DEPTH_MIN || pd > PULLBACK_DEPTH_MAX) continue; } }
        tryEntry("short", sig.reason || "sell_signal");
      } else if (sig.reason?.startsWith("大台割れ")) {
        const m = sig.reason.match(/(\d+(?:\.\d+)?)円/); const level = m ? parseFloat(m[1]) : close;
        roundLevelPendingStates.set(symbol, { direction: "sell", level, confirmCount: 0, reason: sig.reason });
      } else {
        tryEntry("short", sig.reason || "sell_signal");
      }
    }
  }

  // 残ポジション強制決済
  for (const [symbol, pos] of openPositions.entries()) {
    const symCandles = sorted.filter(c => c.symbol === symbol);
    const last = symCandles[symCandles.length - 1];
    if (!last) continue;
    const pnl = pos.side === "long" ? Math.round((last.close - pos.entryPrice) * pos.shares) : Math.round((pos.entryPrice - last.close) * pos.shares);
    totalPnl += pnl;
    trades.push({ date: last.tradeDate, time: last.candleTime, sym: symbol, side: pos.side, price: pos.entryPrice, exitPrice: last.close, pnl, reason: "EOD", shares: pos.shares, signalReason: pos.entryReason });
  }

  // ENTRYレコードを除外（決済済みのみ集計）
  return { trades: trades.filter(t => t.reason !== "ENTRY"), totalPnl };
}

// === データローダー ===
const DATES = [
  "2026-06-19", "2026-06-22", "2026-06-24", "2026-06-25", "2026-06-26",
  "2026-06-29", "2026-06-30", "2026-07-01", "2026-07-02", "2026-07-03"
];

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
console.log("=".repeat(80));
console.log("ATRベース動的SL パラメータスイープ（10日間: 6/19-7/3）");
console.log("=".repeat(80));
console.log("");

const SWEEP_PARAMS: AtrSlParams[] = [
  // A) ベースライン（固定SL/TP）
  { atrPeriod: 14, mult: 0, minSl: 0.5, maxSl: 0.5, rrRatio: 0, tpFixed: 1.5, mode: "fixed", label: "A) 固定SL0.5/TP1.5（現行）" },
  // B) ATR×1.5 SL[0.3-0.8] TP固定1.5%
  { atrPeriod: 14, mult: 1.5, minSl: 0.3, maxSl: 0.8, rrRatio: 0, tpFixed: 1.5, mode: "atr_sl_only", label: "B) ATR×1.5 SL[0.3-0.8] TP1.5" },
  // C) ATR×2.0 SL[0.3-1.0] TP固定1.5%
  { atrPeriod: 14, mult: 2.0, minSl: 0.3, maxSl: 1.0, rrRatio: 0, tpFixed: 1.5, mode: "atr_sl_only", label: "C) ATR×2.0 SL[0.3-1.0] TP1.5" },
  // D) ATR×2.5 SL[0.4-1.2] TP固定1.5%
  { atrPeriod: 14, mult: 2.5, minSl: 0.4, maxSl: 1.2, rrRatio: 0, tpFixed: 1.5, mode: "atr_sl_only", label: "D) ATR×2.5 SL[0.4-1.2] TP1.5" },
  // E) ATR×3.0 SL[0.5-1.5] TP固定1.5%
  { atrPeriod: 14, mult: 3.0, minSl: 0.5, maxSl: 1.5, rrRatio: 0, tpFixed: 1.5, mode: "atr_sl_only", label: "E) ATR×3.0 SL[0.5-1.5] TP1.5" },
  // F) ATR×2.0 SL[0.3-1.0] RR2.0
  { atrPeriod: 14, mult: 2.0, minSl: 0.3, maxSl: 1.0, rrRatio: 2.0, tpFixed: 0, mode: "atr_both", label: "F) ATR×2.0 SL[0.3-1.0] RR2.0" },
  // G) ATR×2.5 SL[0.4-1.2] RR2.5
  { atrPeriod: 14, mult: 2.5, minSl: 0.4, maxSl: 1.2, rrRatio: 2.5, tpFixed: 0, mode: "atr_both", label: "G) ATR×2.5 SL[0.4-1.2] RR2.5" },
  // H) ATR×3.0 SL[0.5-1.5] RR3.0
  { atrPeriod: 14, mult: 3.0, minSl: 0.5, maxSl: 1.5, rrRatio: 3.0, tpFixed: 0, mode: "atr_both", label: "H) ATR×3.0 SL[0.5-1.5] RR3.0" },
  // 追加: 寄り付き後のボラティリティに対応する広めSL
  { atrPeriod: 14, mult: 2.0, minSl: 0.5, maxSl: 1.5, rrRatio: 0, tpFixed: 1.5, mode: "atr_sl_only", label: "I) ATR×2.0 SL[0.5-1.5] TP1.5" },
  { atrPeriod: 14, mult: 2.0, minSl: 0.5, maxSl: 2.0, rrRatio: 0, tpFixed: 2.0, mode: "atr_sl_only", label: "J) ATR×2.0 SL[0.5-2.0] TP2.0" },
  { atrPeriod: 7, mult: 2.0, minSl: 0.3, maxSl: 1.0, rrRatio: 0, tpFixed: 1.5, mode: "atr_sl_only", label: "K) ATR7×2.0 SL[0.3-1.0] TP1.5" },
  { atrPeriod: 7, mult: 3.0, minSl: 0.5, maxSl: 1.5, rrRatio: 0, tpFixed: 1.5, mode: "atr_sl_only", label: "L) ATR7×3.0 SL[0.5-1.5] TP1.5" },
];

// データプリロード
const allDayData = new Map<string, RtCandleRow[]>();
for (const date of DATES) { allDayData.set(date, loadDayData(date)); }
console.log(`データロード完了: ${DATES.length}日間`);
for (const [d, rows] of allDayData) { console.log(`  ${d}: ${rows.length}行`); }
console.log("");

interface SweepResult {
  label: string; totalPnl: number; trades: number; wins: number; losses: number;
  slCount: number; tpCount: number; beCount: number; eodCount: number;
  daily: { date: string; pnl: number; trades: number }[];
  allTrades: Trade[];
}

const results: SweepResult[] = [];

for (const params of SWEEP_PARAMS) {
  let totalPnl = 0, totalTrades = 0, totalWins = 0, totalLosses = 0, totalSL = 0, totalTP = 0, totalBE = 0, totalEOD = 0;
  const daily: { date: string; pnl: number; trades: number }[] = [];
  const allTrades: Trade[] = [];
  
  for (const date of DATES) {
    const dayData = allDayData.get(date)!;
    if (dayData.length === 0) { daily.push({ date, pnl: 0, trades: 0 }); continue; }
    const result = simulateDay(dayData, params);
    const closed = result.trades;
    const wins = closed.filter(t => t.pnl > 0).length;
    const losses = closed.filter(t => t.pnl < 0).length;
    const slCount = closed.filter(t => t.reason === "SL").length;
    const tpCount = closed.filter(t => t.reason === "TP").length;
    const beCount = closed.filter(t => t.reason === "BE").length;
    const eodCount = closed.filter(t => t.reason === "EOD").length;
    totalPnl += result.totalPnl; totalTrades += closed.length; totalWins += wins; totalLosses += losses;
    totalSL += slCount; totalTP += tpCount; totalBE += beCount; totalEOD += eodCount;
    daily.push({ date, pnl: result.totalPnl, trades: closed.length });
    allTrades.push(...closed);
  }
  
  results.push({ label: params.label, totalPnl, trades: totalTrades, wins: totalWins, losses: totalLosses, slCount: totalSL, tpCount: totalTP, beCount: totalBE, eodCount: totalEOD, daily, allTrades });
}

// ソートして表示
console.log("=".repeat(100));
console.log("結果ランキング（損益順）");
console.log("=".repeat(100));
console.log("");

const sorted2 = [...results].sort((a, b) => b.totalPnl - a.totalPnl);
const baseline = results[0];

console.log("順位 | パラメータ                          | 合計損益      | 差分         | 取引 | 勝率  | SL | TP | BE | EOD | PF");
console.log("-----|--------------------------------------|--------------|-------------|------|-------|----|----|----|----|------");
for (let i = 0; i < sorted2.length; i++) {
  const r = sorted2[i];
  const diff = r.totalPnl - baseline.totalPnl;
  const wr = r.trades > 0 ? (r.wins / r.trades * 100).toFixed(1) : "0";
  const grossProfit = r.allTrades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(r.allTrades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
  const pf = grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : "∞";
  console.log(`${String(i+1).padStart(4)} | ${r.label.padEnd(36)} | ${(r.totalPnl >= 0 ? "+" : "") + Math.round(r.totalPnl).toLocaleString().padStart(10)}円 | ${(diff >= 0 ? "+" : "") + Math.round(diff).toLocaleString().padStart(9)}円 | ${String(r.trades).padStart(4)} | ${wr.padStart(5)}% | ${String(r.slCount).padStart(2)} | ${String(r.tpCount).padStart(2)} | ${String(r.beCount).padStart(2)} | ${String(r.eodCount).padStart(2)} | ${pf}`);
}

// 日別比較（ベースライン vs 上位3）
console.log("");
console.log("=".repeat(100));
console.log("日別損益比較");
console.log("=".repeat(100));
console.log("");

const topN = sorted2.slice(0, 4);
console.log(`${"日付".padEnd(12)} | ${topN.map(r => r.label.substring(0, 20).padEnd(20)).join(" | ")}`);
console.log("-".repeat(12 + topN.length * 23));
for (const date of DATES) {
  const vals = topN.map(r => {
    const d = r.daily.find(dd => dd.date === date);
    const pnl = d ? d.pnl : 0;
    return `${(pnl >= 0 ? "+" : "") + Math.round(pnl).toLocaleString().padStart(10)}円(${d?.trades ?? 0}T)`;
  });
  console.log(`${date.padEnd(12)} | ${vals.join(" | ")}`);
}

// 7/3の詳細比較
console.log("");
console.log("=".repeat(100));
console.log("7/3 取引詳細比較（ベースライン vs 最良パターン）");
console.log("=".repeat(100));
console.log("");

const baselineTrades73 = baseline.allTrades.filter(t => t.date === "2026-07-03");
const bestPattern = sorted2[0];
const bestTrades73 = bestPattern.allTrades.filter(t => t.date === "2026-07-03");

console.log(`--- ベースライン（${baseline.label}）7/3 ---`);
for (const t of baselineTrades73) {
  console.log(`  ${t.time} ${t.sym} ${t.side} @${t.price.toLocaleString()} → ${t.reason} ${t.pnl >= 0 ? "+" : ""}${t.pnl.toLocaleString()}円`);
}
console.log(`  合計: ${baselineTrades73.reduce((s, t) => s + t.pnl, 0).toLocaleString()}円`);

console.log("");
console.log(`--- 最良パターン（${bestPattern.label}）7/3 ---`);
for (const t of bestTrades73) {
  console.log(`  ${t.time} ${t.sym} ${t.side} @${t.price.toLocaleString()} → ${t.reason} ${t.pnl >= 0 ? "+" : ""}${t.pnl.toLocaleString()}円`);
}
console.log(`  合計: ${bestTrades73.reduce((s, t) => s + t.pnl, 0).toLocaleString()}円`);
