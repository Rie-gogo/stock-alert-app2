/**
 * sim_bc_only.ts
 * 現行版ベースに改良案B（歩み値方向判定）と改良案C（見せ板検出強化）のみを追加した
 * シミュレーション。7営業日（2026-06-17〜06-25）で現行版と比較する。
 *
 * 改良案B: BPRの変化率から約定方向（アップティック/ダウンティック）を近似推定し、
 *          板読みスコアに新要素F（±2点）を追加
 *          - 直近5件のBPR変化が+0.1以上の連続上昇 → アップティック優勢 → LONG +2, SHORT -2
 *          - 直近5件のBPR変化が-0.1以上の連続下降 → ダウンティック優勢 → LONG -2, SHORT +2
 *
 * 改良案C: 見せ板（フェイクオーダー）検出の活用強化
 *          - キャンセル検出時（cancelDetected=true）: 相場モードを強制的にtrapに変更、スコア-2
 *          - アイスバーグ検出時（icebergDetected=true）: その方向への信頼度+1
 *
 * 実行: cd /home/ubuntu/stock-alert-app && npx tsx analysis/sim_bc_only.ts
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
interface OpenPosition { symbol: string; side: "long" | "short"; entryPrice: number; shares: number; entryTime: string; entryReason: string; }
interface Trade { date: string; time: string; sym: string; action: string; price: number; pnl?: number; reason: string; shares: number; }

// === ヘルパー ===
function calcShares(price: number): number { return Math.max(100, Math.floor(Math.floor(INITIAL_CAPITAL_PER_STOCK * LOT_RATIO / price) / 100) * 100); }
function timeToMinutes(t: string): number { const [h, m] = t.split(":").map(Number); return h * 60 + m; }
function checkVolumeUnavailable(buffer: CandleWithSignal[]): boolean { if (buffer.length < 10) return false; const lb = Math.min(buffer.length, 20); const rc = buffer.slice(-lb); return (rc.filter(c => c.volume === 0).length / lb) >= VOLUME_UNAVAILABLE_RATIO; }
function calcCurrentExposure(op: Map<string, OpenPosition>): number { let t = 0; for (const p of op.values()) t += p.entryPrice * p.shares; return t; }

// === 改良案B: 歩み値方向推定（marketOrderDirection + BPRトレンド） ===
// データにmarketOrderDirectionフィールドがあるのでそれを直接活用
// さらにBPRの絶対値トレンド（直近3件の平均方向）も加味
function estimateTickDirection(bprHistoryArr: number[], snapshot: BoardSnapshot | null): "uptick" | "downtick" | "neutral" {
  if (!snapshot) return "neutral";
  
  // marketOrderDirectionが明確な場合はそれを使用
  const mod = (snapshot as any).marketOrderDirection;
  if (mod === "buy") return "uptick";
  if (mod === "sell") return "downtick";
  
  // BPRの直近トレンドで判定（閾値を緩和）
  if (bprHistoryArr.length < 3) return "neutral";
  const recent = bprHistoryArr.slice(-Math.min(5, bprHistoryArr.length));
  const first = recent[0];
  const last = recent[recent.length - 1];
  const trend = last - first;
  
  // BPRが明確に上昇トレンド → 買い圧力増加 → アップティック
  if (trend >= 0.2) return "uptick";
  if (trend <= -0.2) return "downtick";
  
  // BPRの絶対値で判定（強い買い圧力/売り圧力）
  if (last >= 1.3) return "uptick";
  if (last <= 0.7) return "downtick";
  
  return "neutral";
}

// === 改良案C: 見せ板検出強化（データの既存フラグを直接活用） ===
// データにaskCancelDetected/bidCancelDetected/icebergAskDetected/icebergBidDetectedが既に存在
function detectFakeOrder(snapshot: BoardSnapshot | null): { cancelDetected: boolean; icebergDetected: boolean; icebergSide: "buy" | "sell" | null } {
  if (!snapshot) return { cancelDetected: false, icebergDetected: false, icebergSide: null };
  
  const snap = snapshot as any;
  
  // キャンセル検出: データの既存フラグを使用
  const cancelDetected = !!(snap.askCancelDetected || snap.bidCancelDetected);
  
  // アイスバーグ検出: データの既存フラグを使用
  let icebergDetected = false;
  let icebergSide: "buy" | "sell" | null = null;
  
  if (snap.icebergAskDetected) {
    // 売り板にアイスバーグ → 売り板が食われている → 買い方向の勢い
    icebergDetected = true;
    icebergSide = "buy";
  }
  if (snap.icebergBidDetected) {
    // 買い板にアイスバーグ → 買い板が食われている → 売り方向の勢い
    icebergDetected = true;
    icebergSide = "sell";
  }
  
  return { cancelDetected, icebergDetected, icebergSide };
}

// === 改良版 板読みスコア（B・C追加） ===
function boardReadingScoreBC(
  bprHistoryArr: number[],
  side: "long" | "short",
  snapshot: BoardSnapshot | null,
  prevSnapshot: BoardSnapshot | null,
): number {
  if (!snapshot) return 1;
  let score = 0;
  const bpr = snapshot.buyPressureRatio;

  // 要素A: アグレッシブ注文検出 (±2)
  if (snapshot.marketOrderRatio >= 0.08) {
    if (side === "long" && bpr > 1.0) score += 2; else if (side === "long" && bpr < 1.0) score -= 2;
    else if (side === "short" && bpr < 1.0) score += 2; else if (side === "short" && bpr > 1.0) score -= 2;
  }

  // 要素B: 厚い板のアノマリー (±1)
  if (side === "long") { if (snapshot.largeSellWall) score += 1; if (snapshot.largeBuyWall) score -= 1; }
  else { if (snapshot.largeBuyWall) score += 1; if (snapshot.largeSellWall) score -= 1; }

  // 要素C: 板圧力トレンド (±1)
  if (bprHistoryArr.length >= 3) {
    const delta = bprHistoryArr[bprHistoryArr.length - 1] - bprHistoryArr[0];
    if (side === "long" && delta >= 0.15) score += 1; else if (side === "long" && delta <= -0.15) score -= 1;
    else if (side === "short" && delta <= -0.15) score += 1; else if (side === "short" && delta >= 0.15) score -= 1;
  }

  // 要素D: 相場モード判定 (+1/-2)
  // ★改良案C: キャンセル検出時はtrap強制
  const { cancelDetected, icebergDetected, icebergSide } = detectFakeOrder(snapshot);
  let mode: string;
  if (cancelDetected) {
    mode = "trap"; // 見せ板検出 → 強制trap
  } else {
    mode = detectMarketMode(bprHistoryArr, snapshot);
  }
  if (mode === "active" || mode === "building") score += 1; else if (mode === "trap" || mode === "quiet") score -= 2;

  // 要素E: 板圧力の強さ (±1)
  if (side === "long" && bpr >= 1.4) score += 1; else if (side === "long" && bpr <= 0.65) score -= 1;
  else if (side === "short" && bpr <= 0.65) score += 1; else if (side === "short" && bpr >= 1.4) score -= 1;

  // ★改良案B: 歩み値方向推定 (±2)
  const tickDir = estimateTickDirection(bprHistoryArr, snapshot);
  if (tickDir === "uptick") {
    if (side === "long") score += 2; else score -= 2;
  } else if (tickDir === "downtick") {
    if (side === "short") score += 2; else score -= 2;
  }

  // ★改良案C: アイスバーグ検出時の信頼度引き上げ (+1)
  if (icebergDetected && icebergSide) {
    if (side === "long" && icebergSide === "buy") score += 1;
    else if (side === "short" && icebergSide === "sell") score += 1;
    // 逆方向のアイスバーグは減点
    else if (side === "long" && icebergSide === "sell") score -= 1;
    else if (side === "short" && icebergSide === "buy") score -= 1;
  }

  return score;
}

// === 現行版 板読みスコア（比較用） ===
function boardReadingScoreOriginal(bprHistoryArr: number[], side: "long" | "short", snapshot: BoardSnapshot | null): number {
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

// === シミュレーション関数 ===
function simulateDay(
  dayData: RtCandleRow[],
  useBC: boolean,  // true = 改良案B・C適用, false = 現行版
): { trades: Trade[]; totalPnl: number } {
  
  const buffers = new Map<string, CandleWithSignal[]>();
  const openPositions = new Map<string, OpenPosition>();
  const pullbackStates = new Map<string, any>();
  const roundLevelPendingStates = new Map<string, any>();
  const roundPullbackStates = new Map<string, any>();
  const bprHistories = new Map<string, number[]>();
  const prevSnapshots = new Map<string, BoardSnapshot | null>();  // 改良案C用
  const lastStopLossTime = new Map<string, string>();
  const trades: Trade[] = [];
  let totalPnl = 0;

  const sorted = dayData
    .filter(c => ALLOWED_SYMBOLS.has(c.symbol))
    .filter(c => !(c.candleTime >= "11:30" && c.candleTime < "12:30"))
    .sort((a, b) => a.candleTime < b.candleTime ? -1 : a.candleTime > b.candleTime ? 1 : a.symbol < b.symbol ? -1 : 1);

  for (const candle of sorted) {
    const { symbol, candleTime, open, high, low, close, volume, boardSnapshot } = candle;
    const tradeDate = candle.tradeDate;
    
    if (!buffers.has(symbol)) buffers.set(symbol, []);
    const buffer = buffers.get(symbol)!;
    
    // prevSnapshot保存（改良案C用）
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
      const { entryPrice, shares, side } = existingPos;
      if (candleTime >= MARKET_CLOSE_TIME) {
        const pnl = side === "long" ? (close - entryPrice) * shares : (entryPrice - close) * shares;
        totalPnl += pnl; trades.push({ date: tradeDate, time: candleTime, sym: symbol, action: "forced_close", price: close, pnl, reason: "大引け強制決済", shares });
        openPositions.delete(symbol); continue;
      }
      let exitPrice: number | null = null, exitReason = "";
      if (side === "long") {
        const sl = entryPrice * (1 - STOP_LOSS_PERCENT / 100); const tp = entryPrice * (1 + TAKE_PROFIT_PERCENT / 100);
        if (low <= sl) { exitPrice = sl; exitReason = "損切り"; } else if (high >= tp) { exitPrice = tp; exitReason = "利確"; }
      } else {
        const sl = entryPrice * (1 + STOP_LOSS_PERCENT / 100); const tp = entryPrice * (1 - TAKE_PROFIT_PERCENT / 100);
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

    // 板読みスコア計算関数を選択
    const getBoardScore = (side: "long" | "short") => {
      if (useBC) {
        return boardReadingScoreBC(bprHistories.get(symbol) ?? [], side, boardSnapshot, prevSnap);
      } else {
        return boardReadingScoreOriginal(bprHistories.get(symbol) ?? [], side, boardSnapshot);
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
        openPositions.set(symbol, { symbol, side: "long", entryPrice: close, shares, entryTime: candleTime, entryReason: sig.reason });
        trades.push({ date: tradeDate, time: candleTime, sym: symbol, action: "buy", price: close, reason: sig.reason, shares });
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
    trades.push({ date: last.tradeDate, time: last.candleTime, sym: symbol, action: "forced_close", price: last.close, pnl, reason: "データ終了時決済", shares: pos.shares });
  }

  return { trades, totalPnl };
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
console.log("改良案B・C シミュレーション比較（7営業日: 2026-06-17〜06-25）");
console.log("=".repeat(80));
console.log("");
console.log("改良案B: 歩み値方向推定（BPR変化率→アップティック/ダウンティック判定、±2点）");
console.log("改良案C: 見せ板検出強化（キャンセル→trap強制、アイスバーグ→信頼度±1点）");
console.log("");

// 現行版
const resultsOriginal: { date: string; pnl: number; trades: number; wins: number; losses: number }[] = [];
console.log("--- 現行版（ベースライン） ---");
for (const date of DATES) {
  const dayData = loadDayData(date);
  if (dayData.length === 0) { console.log(`${date}: データなし`); continue; }
  const result = simulateDay(dayData, false);
  const closedTrades = result.trades.filter(t => t.pnl !== undefined);
  const wins = closedTrades.filter(t => (t.pnl ?? 0) > 0).length;
  const losses = closedTrades.filter(t => (t.pnl ?? 0) < 0).length;
  resultsOriginal.push({ date, pnl: result.totalPnl, trades: closedTrades.length, wins, losses });
  console.log(`${date}: 損益 ${result.totalPnl >= 0 ? "+" : ""}${Math.round(result.totalPnl).toLocaleString()}円 (${closedTrades.length}取引, 勝${wins}/負${losses}, 勝率${closedTrades.length > 0 ? Math.round(wins/closedTrades.length*100) : 0}%)`);
}

console.log("");

// 改良案B・C適用版
const resultsBC: { date: string; pnl: number; trades: number; wins: number; losses: number }[] = [];
console.log("--- 改良案B・C適用版 ---");
for (const date of DATES) {
  const dayData = loadDayData(date);
  if (dayData.length === 0) { console.log(`${date}: データなし`); continue; }
  const result = simulateDay(dayData, true);
  const closedTrades = result.trades.filter(t => t.pnl !== undefined);
  const wins = closedTrades.filter(t => (t.pnl ?? 0) > 0).length;
  const losses = closedTrades.filter(t => (t.pnl ?? 0) < 0).length;
  resultsBC.push({ date, pnl: result.totalPnl, trades: closedTrades.length, wins, losses });
  console.log(`${date}: 損益 ${result.totalPnl >= 0 ? "+" : ""}${Math.round(result.totalPnl).toLocaleString()}円 (${closedTrades.length}取引, 勝${wins}/負${losses}, 勝率${closedTrades.length > 0 ? Math.round(wins/closedTrades.length*100) : 0}%)`);
}

console.log("");
console.log("=".repeat(80));
console.log("比較サマリー");
console.log("=".repeat(80));
console.log("");
console.log("日付        | 現行版               | B・C適用版           | 差分");
console.log("------------|---------------------|---------------------|----------");
for (let i = 0; i < DATES.length; i++) {
  const o = resultsOriginal[i]; const bc = resultsBC[i];
  if (!o || !bc) continue;
  const diff = bc.pnl - o.pnl;
  console.log(`${o.date}  | ${(o.pnl >= 0 ? "+" : "") + Math.round(o.pnl).toLocaleString().padStart(10)}円 (${o.trades}T, W${o.wins}) | ${(bc.pnl >= 0 ? "+" : "") + Math.round(bc.pnl).toLocaleString().padStart(10)}円 (${bc.trades}T, W${bc.wins}) | ${(diff >= 0 ? "+" : "") + Math.round(diff).toLocaleString()}円`);
}
const totalO = resultsOriginal.reduce((s, r) => s + r.pnl, 0);
const totalBC = resultsBC.reduce((s, r) => s + r.pnl, 0);
const totalTradesO = resultsOriginal.reduce((s, r) => s + r.trades, 0);
const totalTradesBC = resultsBC.reduce((s, r) => s + r.trades, 0);
const totalWinsO = resultsOriginal.reduce((s, r) => s + r.wins, 0);
const totalWinsBC = resultsBC.reduce((s, r) => s + r.wins, 0);
const totalLossesO = resultsOriginal.reduce((s, r) => s + r.losses, 0);
const totalLossesBC = resultsBC.reduce((s, r) => s + r.losses, 0);
console.log("------------|---------------------|---------------------|----------");
console.log(`合計        | ${(totalO >= 0 ? "+" : "") + Math.round(totalO).toLocaleString().padStart(10)}円 (${totalTradesO}T, W${totalWinsO}) | ${(totalBC >= 0 ? "+" : "") + Math.round(totalBC).toLocaleString().padStart(10)}円 (${totalTradesBC}T, W${totalWinsBC}) | ${(totalBC - totalO >= 0 ? "+" : "") + Math.round(totalBC - totalO).toLocaleString()}円`);
console.log(`勝率        | ${Math.round(totalWinsO/totalTradesO*100)}% (${totalWinsO}/${totalTradesO})          | ${Math.round(totalWinsBC/totalTradesBC*100)}% (${totalWinsBC}/${totalTradesBC})          |`);
console.log("");

// 銘柄別比較
console.log("=".repeat(80));
console.log("銘柄別損益比較");
console.log("=".repeat(80));
console.log("");

const bySymbolO = new Map<string, number>();
const bySymbolBC = new Map<string, number>();
for (const date of DATES) {
  const dayData = loadDayData(date);
  if (dayData.length === 0) continue;
  const rO = simulateDay(dayData, false);
  const rBC = simulateDay(dayData, true);
  for (const t of rO.trades) { if (t.pnl !== undefined) bySymbolO.set(t.sym, (bySymbolO.get(t.sym) ?? 0) + t.pnl); }
  for (const t of rBC.trades) { if (t.pnl !== undefined) bySymbolBC.set(t.sym, (bySymbolBC.get(t.sym) ?? 0) + t.pnl); }
}

const allSymbols = new Set([...bySymbolO.keys(), ...bySymbolBC.keys()]);
const symResults: { sym: string; name: string; original: number; bc: number; diff: number }[] = [];
for (const sym of allSymbols) {
  const name = TARGET_STOCKS.find(s => s.symbol === sym)?.name ?? sym;
  const original = bySymbolO.get(sym) ?? 0;
  const bc = bySymbolBC.get(sym) ?? 0;
  symResults.push({ sym, name, original, bc, diff: bc - original });
}
symResults.sort((a, b) => b.diff - a.diff);

console.log("銘柄          | 現行版        | B・C適用版    | 差分");
console.log("--------------|--------------|--------------|----------");
for (const r of symResults) {
  console.log(`${r.name.padEnd(12)} | ${(r.original >= 0 ? "+" : "") + Math.round(r.original).toLocaleString().padStart(10)}円 | ${(r.bc >= 0 ? "+" : "") + Math.round(r.bc).toLocaleString().padStart(10)}円 | ${(r.diff >= 0 ? "+" : "") + Math.round(r.diff).toLocaleString()}円`);
}

console.log("");
console.log("=".repeat(80));
console.log("結論");
console.log("=".repeat(80));
const improvement = totalBC - totalO;
const winRateO = Math.round(totalWinsO / totalTradesO * 100);
const winRateBC = Math.round(totalWinsBC / totalTradesBC * 100);
console.log(`改良案B・Cの効果: ${improvement >= 0 ? "+" : ""}${Math.round(improvement).toLocaleString()}円 (${improvement >= 0 ? "改善" : "悪化"})`);
console.log(`勝率変化: ${winRateO}% → ${winRateBC}% (${winRateBC - winRateO >= 0 ? "+" : ""}${winRateBC - winRateO}pt)`);
console.log(`取引回数変化: ${totalTradesO}回 → ${totalTradesBC}回 (${totalTradesBC - totalTradesO >= 0 ? "+" : ""}${totalTradesBC - totalTradesO}回)`);
if (improvement > 0) {
  console.log("→ 改良案B・Cは現行版に対してプラスの効果あり。本番適用を推奨。");
} else {
  console.log("→ 改良案B・Cは現行版に対してマイナスの効果。適用は見送り。");
}
