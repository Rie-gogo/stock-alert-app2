/**
 * replay_improved_7days.ts
 * 改良提案A〜Fを全て組み込んだシミュレーション（7営業日分バッチ実行）
 * 
 * 改良案A: MA60・MA100追加 + パーフェクトオーダーシグナル
 * 改良案B: 歩み値近似（marketOrderRatio + BPR方向で推定）→ 板読みスコア要素F(±2)
 * 改良案C: 見せ板検出の活用強化（cancel→trap強制、iceberg→信頼度UP）
 * 改良案D: 板の状態変化による動的損切り（根拠崩壊ロジック）
 * 改良案E: 日足トレンド近似（当日始値比 + 前日終値比）
 * 改良案F: 並び抜けシグナル
 * 
 * 実行: cd /home/ubuntu/stock-alert-app && npx tsx analysis/replay_improved_7days.ts
 */
import * as fs from "fs";
import { detectSignals, calcMA, calcRSI, calcBollinger, type CandleWithSignal } from "../server/routers/stockData";
import { TARGET_STOCKS } from "../shared/stocks";
import { getHigherTfTrend } from "../server/vwap";
import { calcATR } from "../server/intradayRegime";
import type { BoardSnapshot } from "../drizzle/schema";

// ============================================================
// 定数（realtimeSimEngine.tsと完全一致 + 改良案追加分）
// ============================================================
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
const NO_ENTRY_LUNCH_START = "12:00";
const NO_ENTRY_LUNCH_END = "12:59";
const VOLUME_UNAVAILABLE_RATIO = 0.9;
const BOARD_SCORE_THRESHOLD = 1;
const BOARD_EARLY_EXIT_MIN_PROFIT_PCT = 0.05;
const ROUND_LEVEL_CONFIRM_BARS = 5;

// 改良案D: 動的損切り閾値
const BOARD_EARLY_STOPLOSS_MIN_LOSS_PCT = 0.1; // -0.1%以上の含み損で発動

// 改良案F: 並び抜け検出パラメータ
const NARABI_LOOKBACK = 6; // 直近6本
const NARABI_ATR_RATIO = 0.5; // ATRの0.5倍以内

const ALLOWED_SYMBOLS = new Set(TARGET_STOCKS.map(s => s.symbol));

// ============================================================
// 型定義
// ============================================================
interface RtCandleRow {
  symbol: string;
  tradeDate: string;
  candleTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  boardSnapshot: BoardSnapshot | null;
}

interface OpenPosition {
  symbol: string;
  side: "long" | "short";
  entryPrice: number;
  shares: number;
  entryTime: string;
  entryReason: string;
  boardSignal?: string;
}

interface Trade {
  symbol: string;
  symbolName: string;
  action: string;
  price: number;
  shares: number;
  pnl: number | null;
  reason: string;
  tradeTime: string;
  side: "long" | "short";
  tradeDate: string;
}

interface PullbackState {
  recentSwingLow: number;
  signalPrice: number;
  waitCount: number;
  pulledBack: boolean;
  reason: string;
}

interface RoundLevelPending {
  direction: "buy" | "sell";
  level: number;
  confirmCount: number;
  reason: string;
}

interface RoundPullback {
  direction: "buy" | "sell";
  level: number;
  signalPrice: number;
  waitCount: number;
  pulledBack: boolean;
  reason: string;
}

// ============================================================
// ヘルパー関数
// ============================================================
function calcShares(price: number): number {
  const amount = INITIAL_CAPITAL_PER_STOCK * LOT_RATIO;
  const rawShares = Math.floor(amount / price);
  return Math.max(100, Math.floor(rawShares / 100) * 100);
}

function timeToMinutes(timeStr: string): number {
  const [h, m] = timeStr.split(":").map(Number);
  return h * 60 + m;
}

function checkVolumeUnavailable(buffer: CandleWithSignal[]): boolean {
  if (buffer.length < 10) return false;
  const lookback = Math.min(buffer.length, 20);
  const recentCandles = buffer.slice(buffer.length - lookback);
  const zeroVolumeCount = recentCandles.filter(c => c.volume === 0).length;
  return (zeroVolumeCount / lookback) >= VOLUME_UNAVAILABLE_RATIO;
}

function getStockName(symbol: string): string {
  const stock = TARGET_STOCKS.find(s => s.symbol === symbol);
  return stock?.name ?? symbol;
}

function calcCurrentExposure(openPositions: Map<string, OpenPosition>): number {
  let total = 0;
  for (const pos of openPositions.values()) {
    total += pos.entryPrice * pos.shares;
  }
  return total;
}

// ============================================================
// 改良案A: MA60・MA100計算 + パーフェクトオーダー判定
// ============================================================
function checkPerfectOrder(buffer: CandleWithSignal[], closes: number[]): "buy" | "sell" | null {
  if (closes.length < 100) return null;
  const ma5 = calcMA(closes, 5);
  const ma25 = calcMA(closes, 25);
  const ma60 = calcMA(closes, 60);
  const ma100 = calcMA(closes, 100);
  const i = closes.length - 1;
  const v5 = ma5[i], v25 = ma25[i], v60 = ma60[i], v100 = ma100[i];
  if (v5 == null || v25 == null || v60 == null || v100 == null) return null;
  
  // パーフェクトオーダー（買い）: MA5 > MA25 > MA60 > MA100
  if (v5 > v25 && v25 > v60 && v60 > v100) return "buy";
  // 逆パーフェクトオーダー（売り）: MA5 < MA25 < MA60 < MA100
  if (v5 < v25 && v25 < v60 && v60 < v100) return "sell";
  return null;
}

// 改良案A追加: MA60の傾きによるレジーム強化
function getMA60Slope(closes: number[]): number {
  if (closes.length < 65) return 0;
  const ma60 = calcMA(closes, 60);
  const i = closes.length - 1;
  const cur = ma60[i];
  const prev = ma60[i - 5]; // 5本前との比較
  if (cur == null || prev == null) return 0;
  return (cur - prev) / prev * 100;
}

// ============================================================
// 改良案B: 歩み値近似（marketOrderRatio + BPR方向で推定）
// ============================================================
function estimateTickDirection(snapshot: BoardSnapshot | null): { uptickRatio: number; downtickRatio: number } {
  if (!snapshot) return { uptickRatio: 0.5, downtickRatio: 0.5 };
  const { marketOrderRatio, buyPressureRatio } = snapshot;
  // marketOrderRatioが高い = 成行注文が多い = 方向性がある
  // BPR > 1 = 買い板が厚い = 売り板にぶつかる成行買いが多い → アップティック
  // BPR < 1 = 売り板が厚い = 買い板にぶつかる成行売りが多い → ダウンティック
  if (marketOrderRatio < 0.02) return { uptickRatio: 0.5, downtickRatio: 0.5 }; // 成行少ない→中立
  
  const bprBias = Math.min(Math.max((buyPressureRatio - 1.0) * 2, -1), 1); // -1 to +1
  const uptickRatio = 0.5 + bprBias * 0.3 + marketOrderRatio * (bprBias > 0 ? 1 : -1) * 0.5;
  const clamped = Math.min(Math.max(uptickRatio, 0.1), 0.9);
  return { uptickRatio: clamped, downtickRatio: 1 - clamped };
}

function tickDirectionScore(side: "long" | "short", snapshot: BoardSnapshot | null): number {
  const { uptickRatio, downtickRatio } = estimateTickDirection(snapshot);
  if (side === "long") {
    if (uptickRatio >= 0.7) return 2;
    if (uptickRatio <= 0.3) return -2;
  } else {
    if (downtickRatio >= 0.7) return 2;
    if (downtickRatio <= 0.3) return -2;
  }
  return 0;
}

// ============================================================
// 改良案C: 見せ板検出の活用強化
// ============================================================
function checkFakeOrderImpact(snapshot: BoardSnapshot | null): { forceTrap: boolean; icebergDirection: "buy" | "sell" | null } {
  if (!snapshot) return { forceTrap: false, icebergDirection: null };
  const forceTrap = !!(snapshot.askCancelDetected || snapshot.bidCancelDetected);
  let icebergDirection: "buy" | "sell" | null = null;
  if (snapshot.icebergAskDetected) icebergDirection = "sell"; // 売り板にアイスバーグ → 上方向ブレイク有利
  if (snapshot.icebergBidDetected) icebergDirection = "buy"; // 買い板にアイスバーグ → 下方向ブレイク有利
  return { forceTrap, icebergDirection };
}

// ============================================================
// 改良案F: 並び抜け検出
// ============================================================
function detectNarabiBreakout(buffer: CandleWithSignal[]): "buy" | "sell" | null {
  if (buffer.length < NARABI_LOOKBACK + 1) return null;
  
  // ATR計算
  const highs = buffer.map(c => c.high);
  const lows = buffer.map(c => c.low);
  const closes = buffer.map(c => c.close);
  const atrSeries = calcATR(highs, lows, closes, 14);
  const currentATR = atrSeries[atrSeries.length - 1];
  if (currentATR == null || currentATR === 0) return null;
  
  // 直近NARABI_LOOKBACK本（現在足を除く）の高値・安値レンジ
  const lookback = buffer.slice(buffer.length - NARABI_LOOKBACK - 1, buffer.length - 1);
  const rangeHigh = Math.max(...lookback.map(c => c.high));
  const rangeLow = Math.min(...lookback.map(c => c.low));
  const range = rangeHigh - rangeLow;
  
  // レンジがATRの0.5倍以内 = 並び（拮抗）状態
  if (range > currentATR * NARABI_ATR_RATIO) return null;
  
  const currentCandle = buffer[buffer.length - 1];
  // 上方向に放れた
  if (currentCandle.close > rangeHigh) return "buy";
  // 下方向に放れた
  if (currentCandle.close < rangeLow) return "sell";
  
  return null;
}

// ============================================================
// 板読みスコア計算（改良版: 要素F追加 + 見せ板検出強化）
// ============================================================
function boardReadingScoreImproved(
  bprHistoryArr: number[],
  side: "long" | "short",
  snapshot: BoardSnapshot | null
): number {
  if (!snapshot) return 1;

  let score = 0;
  const bpr = snapshot.buyPressureRatio;

  // 改良案C: キャンセル検出時はtrap強制
  const { forceTrap } = checkFakeOrderImpact(snapshot);
  if (forceTrap) return -2; // 即座にブロック

  // 要素A: アグレッシブ注文検出 (±2)
  if (snapshot.marketOrderRatio >= 0.08) {
    if (side === "long" && bpr > 1.0) score += 2;
    else if (side === "long" && bpr < 1.0) score -= 2;
    else if (side === "short" && bpr < 1.0) score += 2;
    else if (side === "short" && bpr > 1.0) score -= 2;
  }

  // 要素B: 厚い板のアノマリー (±1)
  if (side === "long") {
    if (snapshot.largeSellWall) score += 1;
    if (snapshot.largeBuyWall) score -= 1;
  } else {
    if (snapshot.largeBuyWall) score += 1;
    if (snapshot.largeSellWall) score -= 1;
  }

  // 要素C: 板圧力トレンド (±1)
  if (bprHistoryArr.length >= 3) {
    const oldest = bprHistoryArr[0];
    const newest = bprHistoryArr[bprHistoryArr.length - 1];
    const delta = newest - oldest;
    if (side === "long" && delta >= 0.15) score += 1;
    else if (side === "long" && delta <= -0.15) score -= 1;
    else if (side === "short" && delta <= -0.15) score += 1;
    else if (side === "short" && delta >= 0.15) score -= 1;
  }

  // 要素D: 相場モード判定 (+1/-2)
  const mode = detectMarketMode(bprHistoryArr, snapshot);
  if (mode === "active" || mode === "building") {
    score += 1;
  } else if (mode === "trap" || mode === "quiet") {
    score -= 2;
  }

  // 要素E: 板圧力の強さ (±1)
  if (side === "long" && bpr >= 1.4) score += 1;
  else if (side === "long" && bpr <= 0.65) score -= 1;
  else if (side === "short" && bpr <= 0.65) score += 1;
  else if (side === "short" && bpr >= 1.4) score -= 1;

  // 【改良案B】要素F: 歩み値方向推定 (±2)
  score += tickDirectionScore(side, snapshot);

  return score;
}

function detectMarketMode(bprHistoryArr: number[], snapshot: BoardSnapshot): "active" | "building" | "trap" | "quiet" {
  const bpr = snapshot.buyPressureRatio;
  if (bprHistoryArr.length >= 3) {
    const allNeutral = bprHistoryArr.every(h => h >= 0.85 && h <= 1.15);
    if (allNeutral && bpr >= 0.85 && bpr <= 1.15) return "quiet";
  }
  if (bpr > 1.2 || bpr < 0.8) return "active";
  if (bprHistoryArr.length >= 3) {
    const oldest = bprHistoryArr[0];
    const newest = bprHistoryArr[bprHistoryArr.length - 1];
    const delta = Math.abs(newest - oldest);
    if (delta >= 0.1) return "building";
  }
  return "trap";
}

// ============================================================
// 改良案D: 板読み早期損切り
// ============================================================
function shouldBoardEarlyStopLoss(
  pos: OpenPosition,
  currentPrice: number,
  snapshot: BoardSnapshot | null
): boolean {
  if (!snapshot) return false;
  const { side, entryPrice } = pos;
  const lossPct = side === "long"
    ? (entryPrice - currentPrice) / entryPrice * 100
    : (currentPrice - entryPrice) / entryPrice * 100;
  // 含み損が-0.1%以上（lossPctが正の値 = 含み損）
  if (lossPct < BOARD_EARLY_STOPLOSS_MIN_LOSS_PCT) return false;

  // LONGポジション中にsell_pressure（BPR≦0.67）
  if (side === "long" && snapshot.buyPressureRatio <= 0.67) return true;
  // SHORTポジション中にbuy_pressure（BPR≧1.5）
  if (side === "short" && snapshot.buyPressureRatio >= 1.5) return true;
  return false;
}

function shouldBoardEarlyExit(
  pos: OpenPosition,
  currentPrice: number,
  snapshot: BoardSnapshot | null
): boolean {
  if (!snapshot) return false;
  const { side, entryPrice } = pos;
  const profitPct = side === "long"
    ? (currentPrice - entryPrice) / entryPrice * 100
    : (entryPrice - currentPrice) / entryPrice * 100;
  if (profitPct < BOARD_EARLY_EXIT_MIN_PROFIT_PCT) return false;

  if (side === "long" && (snapshot.signal === "sell_pressure" || snapshot.signal === "large_sell_wall")) return true;
  if (side === "short" && (snapshot.signal === "buy_pressure" || snapshot.signal === "large_buy_wall")) return true;
  return false;
}

// ============================================================
// 改良案E: 日足トレンド近似
// ============================================================
function getDailyTrendBias(buffer: CandleWithSignal[], prevDayClose: number | null): "bullish" | "bearish" | "neutral" {
  if (buffer.length < 5) return "neutral";
  const firstOpen = buffer[0].open;
  const currentClose = buffer[buffer.length - 1].close;
  
  // 当日の始値比
  const intradayChange = (currentClose - firstOpen) / firstOpen * 100;
  
  // 前日終値との比較（ギャップ）
  let gapBias = 0;
  if (prevDayClose) {
    const gap = (firstOpen - prevDayClose) / prevDayClose * 100;
    if (gap > 0.3) gapBias = 1;
    else if (gap < -0.3) gapBias = -1;
  }
  
  if (intradayChange > 0.3 || gapBias > 0) return "bullish";
  if (intradayChange < -0.3 || gapBias < 0) return "bearish";
  return "neutral";
}

// ============================================================
// メインシミュレーション（1日分）
// ============================================================
function simulateDay(candles: RtCandleRow[], prevDayCloses: Map<string, number>): { totalPnl: number; winCount: number; lossCount: number; trades: Trade[]; dayCloses: Map<string, number> } {
  const tradeDate = candles[0]?.tradeDate ?? "unknown";
  
  // 型変換（DBからの取得時にstring型になっている場合がある）
  for (const c of candles) {
    c.open = Number(c.open);
    c.high = Number(c.high);
    c.low = Number(c.low);
    c.close = Number(c.close);
    c.volume = Number(c.volume);
    if (typeof c.boardSnapshot === 'string') c.boardSnapshot = JSON.parse(c.boardSnapshot);
  }
  
  // 昼休みスキップ + 対象銘柄フィルター
  const allCandlesSorted = candles
    .filter(c => ALLOWED_SYMBOLS.has(c.symbol))
    .filter(c => !(c.candleTime >= "11:30" && c.candleTime < "12:30"))
    .sort((a, b) => a.candleTime < b.candleTime ? -1 : a.candleTime > b.candleTime ? 1 : a.symbol < b.symbol ? -1 : 1);

  // 銘柄ごとにグループ化（引け強制決済用）
  const bySymbol = new Map<string, RtCandleRow[]>();
  for (const c of allCandlesSorted) {
    if (!bySymbol.has(c.symbol)) bySymbol.set(c.symbol, []);
    bySymbol.get(c.symbol)!.push(c);
  }

  // 状態管理
  const buffers = new Map<string, CandleWithSignal[]>();
  const openPositions = new Map<string, OpenPosition>();
  const pullbackStates = new Map<string, PullbackState>();
  const roundLevelPendingStates = new Map<string, RoundLevelPending>();
  const roundPullbackStates = new Map<string, RoundPullback>();
  const bprHistories = new Map<string, number[]>();
  const lastStopLossTime = new Map<string, string>();

  const allTrades: Trade[] = [];
  let totalPnl = 0;
  let winCount = 0;
  let lossCount = 0;

  for (const candle of allCandlesSorted) {
    const { symbol, candleTime, open, high, low, close, volume, boardSnapshot } = candle;

    if (!buffers.has(symbol)) buffers.set(symbol, []);
    const buffer = buffers.get(symbol)!;

    // bprHistory更新
    if (boardSnapshot) {
      const history = bprHistories.get(symbol) ?? [];
      history.push(boardSnapshot.buyPressureRatio);
      if (history.length > 5) history.shift();
      bprHistories.set(symbol, history);
    }

    // CandleWithSignal形式に変換
    const candleForSignal: CandleWithSignal = {
      time: `${tradeDate}T${candleTime}:00`,
      dayKey: tradeDate,
      timestamp: new Date(`${tradeDate}T${candleTime}:00+09:00`).getTime(),
      open, high, low, close, volume,
      ma5: null, ma25: null, rsi: null,
      bbUpper: null, bbMiddle: null, bbLower: null,
    };
    buffer.push(candleForSignal);

    // MA5・MA25・RSI・BB計算
    const closes = buffer.map(c => c.close);
    const ma5S = calcMA(closes, 5);
    const ma25S = calcMA(closes, 25);
    const rsiS = calcRSI(closes, 14);
    const bbS = calcBollinger(closes, 20);
    const li = buffer.length - 1;
    buffer[li].ma5 = ma5S[li];
    buffer[li].ma25 = ma25S[li];
    buffer[li].rsi = rsiS[li];
    buffer[li].bbUpper = bbS.upper[li];
    buffer[li].bbMiddle = bbS.middle[li];
    buffer[li].bbLower = bbS.lower[li];

    // ---- 既存ポジションの決済チェック ----
    const existingPos = openPositions.get(symbol);
    if (existingPos) {
      const { entryPrice, shares, side } = existingPos;

      // 大引け強制決済
      if (candleTime >= MARKET_CLOSE_TIME) {
        const pnl = side === "long"
          ? (close - entryPrice) * shares
          : (entryPrice - close) * shares;
        totalPnl += pnl;
        if (pnl > 0) winCount++; else lossCount++;
        allTrades.push({ symbol, symbolName: getStockName(symbol), action: "forced_close", price: close, shares, pnl, reason: "大引け強制決済", tradeTime: candleTime, side, tradeDate });
        openPositions.delete(symbol);
        continue;
      }

      let exitPrice: number | null = null;
      let exitReason = "";
      let exitAction = "exit";

      if (side === "long") {
        const stopLine = entryPrice * (1 - STOP_LOSS_PERCENT / 100);
        const tpLine = entryPrice * (1 + TAKE_PROFIT_PERCENT / 100);
        if (low <= stopLine) { exitPrice = stopLine; exitReason = `損切り`; exitAction = "stop_loss"; }
        else if (high >= tpLine) { exitPrice = tpLine; exitReason = `利確`; exitAction = "take_profit"; }
      } else {
        const stopLine = entryPrice * (1 + STOP_LOSS_PERCENT / 100);
        const tpLine = entryPrice * (1 - TAKE_PROFIT_PERCENT / 100);
        if (high >= stopLine) { exitPrice = stopLine; exitReason = `損切り`; exitAction = "stop_loss"; }
        else if (low <= tpLine) { exitPrice = tpLine; exitReason = `利確`; exitAction = "take_profit"; }
      }

      // 【改良案D】板読み早期損切り（固定損切りに達する前）
      if (exitPrice === null && shouldBoardEarlyStopLoss(existingPos, close, boardSnapshot)) {
        exitPrice = close;
        exitReason = `板読み早期損切り (根拠崩壊)`;
        exitAction = "stop_loss";
      }

      // シグナル反転決済
      if (exitPrice === null && buffer.length >= MIN_CANDLES_FOR_SIGNAL) {
        const withSignals = detectSignals(buffer);
        const latest = withSignals[withSignals.length - 1];
        buffer[buffer.length - 1] = latest;
        if (latest.signal) {
          if (side === "long" && latest.signal.type === "sell") {
            exitPrice = close; exitReason = `シグナル反転決済`; exitAction = "exit";
          } else if (side === "short" && latest.signal.type === "buy") {
            exitPrice = close; exitReason = `シグナル反転決済`; exitAction = "exit";
          }
        }
      }

      // 板読み早期利確
      if (exitPrice === null && shouldBoardEarlyExit(existingPos, close, boardSnapshot)) {
        exitPrice = close; exitReason = `板読み早期利確`; exitAction = "take_profit";
      }

      if (exitPrice !== null) {
        const pnl = side === "long"
          ? (exitPrice - entryPrice) * shares
          : (entryPrice - exitPrice) * shares;
        totalPnl += pnl;
        if (pnl > 0) winCount++; else lossCount++;
        allTrades.push({ symbol, symbolName: getStockName(symbol), action: exitAction, price: exitPrice, shares, pnl, reason: exitReason, tradeTime: candleTime, side, tradeDate });
        openPositions.delete(symbol);
        if (exitAction === "stop_loss") lastStopLossTime.set(symbol, candleTime);
        continue;
      }
      continue;
    }

    // ---- エントリー禁止時間帯 ----
    if (candleTime < NO_ENTRY_BEFORE || candleTime >= NO_ENTRY_AFTER) continue;

    // ---- ウォームアップ ----
    if (buffer.length < MIN_CANDLES_FOR_SIGNAL) continue;

    // ---- シグナル検出 ----
    const withSignals = detectSignals(buffer);
    const latestSignal = withSignals[withSignals.length - 1];
    buffer[buffer.length - 1] = latestSignal;

    // 【改良案A】パーフェクトオーダー検出
    const perfectOrder = checkPerfectOrder(buffer, closes);
    
    // 【改良案F】並び抜け検出
    const narabiBreakout = detectNarabiBreakout(buffer);

    // 【改良案E】日足トレンドバイアス
    const prevDayClose = prevDayCloses.get(symbol) ?? null;
    const dailyBias = getDailyTrendBias(buffer, prevDayClose);

    // 【改良案A】MA60傾きによるレジーム強化
    const ma60Slope = getMA60Slope(closes);

    // ---- 押し目確認ステートマシン処理 ----
    const pullbackState = pullbackStates.get(symbol);
    if (pullbackState) {
      pullbackState.waitCount++;
      if (low < pullbackState.recentSwingLow) { pullbackStates.delete(symbol); continue; }
      if (pullbackState.waitCount > PULLBACK_MAX_WAIT) { pullbackStates.delete(symbol); continue; }
      if (!pullbackState.pulledBack && close < pullbackState.signalPrice) pullbackState.pulledBack = true;
      if (pullbackState.pulledBack && close > pullbackState.signalPrice) {
        pullbackStates.delete(symbol);
        if (boardSnapshot && boardSnapshot.signal === "sell_pressure") continue;
        const brScore = boardReadingScoreImproved(bprHistories.get(symbol) ?? [], "long", boardSnapshot);
        if (brScore < BOARD_SCORE_THRESHOLD) continue;
        const shares = calcShares(close);
        const amount = close * shares;
        if (buffer.length >= ATR_FILTER_PERIOD + 1) {
          const highs = buffer.map(c => c.high);
          const lows = buffer.map(c => c.low);
          const closesArr = buffer.map(c => c.close);
          const atrSeries = calcATR(highs, lows, closesArr, ATR_FILTER_PERIOD);
          const latestATR = atrSeries[atrSeries.length - 1];
          if (latestATR !== null && close > 0 && (latestATR / close) < ATR_FILTER_THRESHOLD) continue;
        }
        const exposure = calcCurrentExposure(openPositions);
        if (exposure + amount > MAX_TOTAL_EXPOSURE) continue;
        if (checkVolumeUnavailable(buffer)) continue;
        const lastSL = lastStopLossTime.get(symbol);
        if (lastSL) {
          const minSince = timeToMinutes(candleTime) - timeToMinutes(lastSL);
          if (minSince >= 0 && minSince < NO_REENTRY_AFTER_STOPLOSS_MIN) continue;
        }
        openPositions.set(symbol, { symbol, side: "long", entryPrice: close, shares, entryTime: candleTime, entryReason: `押し目確認: ${pullbackState.reason}` });
        allTrades.push({ symbol, symbolName: getStockName(symbol), action: "buy", price: close, shares, pnl: null, reason: `押し目確認: ${pullbackState.reason}`, tradeTime: candleTime, side: "long", tradeDate });
        continue;
      }
      continue;
    }

    // ---- 大台確認バーステートマシン処理 ----
    const roundPending = roundLevelPendingStates.get(symbol);
    if (roundPending) {
      if (openPositions.has(symbol)) { roundLevelPendingStates.delete(symbol); }
      else {
        const stillValid = roundPending.direction === "buy" ? close >= roundPending.level : close <= roundPending.level;
        if (stillValid) {
          roundPending.confirmCount++;
          if (roundPending.confirmCount >= ROUND_LEVEL_CONFIRM_BARS) {
            roundLevelPendingStates.delete(symbol);
            roundPullbackStates.set(symbol, { direction: roundPending.direction, level: roundPending.level, signalPrice: close, waitCount: 0, pulledBack: false, reason: roundPending.reason });
          }
        } else { roundLevelPendingStates.delete(symbol); }
        continue;
      }
    }

    // ---- 大台確認後の押し目待ちステートマシン処理 ----
    const roundPb = roundPullbackStates.get(symbol);
    if (roundPb) {
      roundPb.waitCount++;
      const side: "long" | "short" = roundPb.direction === "buy" ? "long" : "short";
      if (roundPb.direction === "buy" && close < roundPb.level) { roundPullbackStates.delete(symbol); continue; }
      if (roundPb.direction === "sell" && close > roundPb.level) { roundPullbackStates.delete(symbol); continue; }

      if (roundPb.waitCount > ROUND_PULLBACK_MAX_WAIT) {
        roundPullbackStates.delete(symbol);
        if (boardSnapshot && side === "long" && boardSnapshot.signal === "sell_pressure") continue;
        if (boardSnapshot && side === "short" && boardSnapshot.signal === "buy_pressure") continue;
        const brScore = boardReadingScoreImproved(bprHistories.get(symbol) ?? [], side, boardSnapshot);
        if (brScore < BOARD_SCORE_THRESHOLD) continue;
        const shares = calcShares(close);
        const amount = close * shares;
        if (buffer.length >= ATR_FILTER_PERIOD + 1) {
          const highs = buffer.map(c => c.high); const lows = buffer.map(c => c.low); const closesArr = buffer.map(c => c.close);
          const atrSeries = calcATR(highs, lows, closesArr, ATR_FILTER_PERIOD);
          const latestATR = atrSeries[atrSeries.length - 1];
          if (latestATR !== null && close > 0 && (latestATR / close) < ATR_FILTER_THRESHOLD) continue;
        }
        const exposure = calcCurrentExposure(openPositions);
        if (exposure + amount > MAX_TOTAL_EXPOSURE) continue;
        if (checkVolumeUnavailable(buffer)) continue;
        openPositions.set(symbol, { symbol, side, entryPrice: close, shares, entryTime: candleTime, entryReason: `${roundPb.reason} (押し目なし・強トレンド)` });
        allTrades.push({ symbol, symbolName: getStockName(symbol), action: side === "long" ? "buy" : "short", price: close, shares, pnl: null, reason: `${roundPb.reason} (押し目なし・強トレンド)`, tradeTime: candleTime, side, tradeDate });
        continue;
      }

      if (roundPb.direction === "buy") {
        if (!roundPb.pulledBack && close < roundPb.signalPrice) roundPb.pulledBack = true;
        if (roundPb.pulledBack && close > roundPb.signalPrice) {
          roundPullbackStates.delete(symbol);
          if (boardSnapshot && boardSnapshot.signal === "sell_pressure") continue;
          const brScore = boardReadingScoreImproved(bprHistories.get(symbol) ?? [], "long", boardSnapshot);
          if (brScore < BOARD_SCORE_THRESHOLD) continue;
          const shares = calcShares(close); const amount = close * shares;
          if (buffer.length >= ATR_FILTER_PERIOD + 1) {
            const highs = buffer.map(c => c.high); const lows = buffer.map(c => c.low); const closesArr = buffer.map(c => c.close);
            const atrSeries = calcATR(highs, lows, closesArr, ATR_FILTER_PERIOD);
            const latestATR = atrSeries[atrSeries.length - 1];
            if (latestATR !== null && close > 0 && (latestATR / close) < ATR_FILTER_THRESHOLD) continue;
          }
          const exposure = calcCurrentExposure(openPositions);
          if (exposure + amount > MAX_TOTAL_EXPOSURE) continue;
          openPositions.set(symbol, { symbol, side: "long", entryPrice: close, shares, entryTime: candleTime, entryReason: `${roundPb.reason} (押し目確認後)` });
          allTrades.push({ symbol, symbolName: getStockName(symbol), action: "buy", price: close, shares, pnl: null, reason: `${roundPb.reason} (押し目確認後)`, tradeTime: candleTime, side: "long", tradeDate });
          continue;
        }
      } else {
        if (!roundPb.pulledBack && close > roundPb.signalPrice) roundPb.pulledBack = true;
        if (roundPb.pulledBack && close < roundPb.signalPrice) {
          roundPullbackStates.delete(symbol);
          if (boardSnapshot && boardSnapshot.signal === "buy_pressure") continue;
          const brScore = boardReadingScoreImproved(bprHistories.get(symbol) ?? [], "short", boardSnapshot);
          if (brScore < BOARD_SCORE_THRESHOLD) continue;
          const shares = calcShares(close); const amount = close * shares;
          if (buffer.length >= ATR_FILTER_PERIOD + 1) {
            const highs = buffer.map(c => c.high); const lows = buffer.map(c => c.low); const closesArr = buffer.map(c => c.close);
            const atrSeries = calcATR(highs, lows, closesArr, ATR_FILTER_PERIOD);
            const latestATR = atrSeries[atrSeries.length - 1];
            if (latestATR !== null && close > 0 && (latestATR / close) < ATR_FILTER_THRESHOLD) continue;
          }
          const exposure = calcCurrentExposure(openPositions);
          if (exposure + amount > MAX_TOTAL_EXPOSURE) continue;
          openPositions.set(symbol, { symbol, side: "short", entryPrice: close, shares, entryTime: candleTime, entryReason: `${roundPb.reason} (押し目確認後)` });
          allTrades.push({ symbol, symbolName: getStockName(symbol), action: "short", price: close, shares, pnl: null, reason: `${roundPb.reason} (押し目確認後)`, tradeTime: candleTime, side: "short", tradeDate });
          continue;
        }
      }
      continue;
    }

    // ---- 既存シグナルに基づくエントリー ----
    const hasBuySignal = latestSignal.signal?.type === "buy";
    const hasSellSignal = latestSignal.signal?.type === "sell";
    
    // 【改良案A】パーフェクトオーダーもシグナルとして扱う
    const perfectBuy = perfectOrder === "buy" && !hasBuySignal;
    const perfectSell = perfectOrder === "sell" && !hasSellSignal;
    
    // 【改良案F】並び抜けもシグナルとして扱う
    const narabiBuy = narabiBreakout === "buy" && !hasBuySignal && !perfectBuy;
    const narabiSell = narabiBreakout === "sell" && !hasSellSignal && !perfectSell;

    // HybridAフィルター
    const firstCandle = buffer[0];
    const openPrice = firstCandle?.open ?? close;
    const priceChangeRatio = (close - openPrice) / openPrice * 100;
    const isBullish = priceChangeRatio >= 0.2;

    // ---- 買いエントリー ----
    const sig = latestSignal.signal;
    const shouldBuy = (sig && sig.type === "buy") || perfectBuy || narabiBuy;
    
    if (shouldBuy && !openPositions.has(symbol)) {
      const buyReason = sig?.type === "buy" ? sig.reason : (perfectBuy ? "パーフェクトオーダー (MA5>MA25>MA60>MA100)" : "並び上抜け");
      
      // VWAPクロス上抜け無効化
      if (sig?.reason?.includes("VWAPクロス上抜け")) { /* skip */ }
      else {
        // sell_pressure時のLONG禁止
        if (boardSnapshot && boardSnapshot.signal === "sell_pressure") { /* skip */ }
        else {
          // 【改良案A】MA60傾きフィルター: MA60が下向きならLONG見送り
          if (ma60Slope < -0.02 && !perfectBuy) { /* skip - MA60下向きでLONG見送り */ }
          else {
            // 【改良案E】日足トレンドバイアス: bearish時はLONGのスコアを下げる
            let biasAdjust = 0;
            if (dailyBias === "bullish") biasAdjust = 1;
            else if (dailyBias === "bearish") biasAdjust = -1;

            const brScore = boardReadingScoreImproved(bprHistories.get(symbol) ?? [], "long", boardSnapshot) + biasAdjust;
            if (brScore >= BOARD_SCORE_THRESHOLD) {
              // ダウ理論 → 押し目確認ステートマシン
              if (sig?.reason?.startsWith("ダウ理論: 直近高値更新") && sig.recentSwingLow != null) {
                const htfTrend = getHigherTfTrend(buffer, buffer.length - 1, 5);
                if (htfTrend === "up") {
                  if (buffer.length >= PULLBACK_DEPTH_LOOKBACK) {
                    const lookbackWindow = buffer.slice(buffer.length - PULLBACK_DEPTH_LOOKBACK);
                    const swingHigh = Math.max(...lookbackWindow.map(c => c.high));
                    const swingLow = Math.min(...lookbackWindow.map(c => c.low));
                    if (swingHigh > swingLow) {
                      const pullbackDepth = (swingHigh - close) / (swingHigh - swingLow);
                      if (pullbackDepth >= PULLBACK_DEPTH_MIN && pullbackDepth <= PULLBACK_DEPTH_MAX) {
                        pullbackStates.set(symbol, { recentSwingLow: sig.recentSwingLow, signalPrice: close, waitCount: 0, pulledBack: false, reason: sig.reason });
                      }
                    }
                  }
                }
              }
              // 大台超え → 確認バーステートマシン
              else if (sig?.reason?.startsWith("大台超え")) {
                const m = sig.reason.match(/(\d+(?:\.\d+)?)円/);
                const level = m ? parseFloat(m[1]) : close;
                roundLevelPendingStates.set(symbol, { direction: "buy", level, confirmCount: 0, reason: sig.reason });
              }
              // 直接エントリー（パーフェクトオーダー、並び抜け、その他シグナル）
              else {
                const shares = calcShares(close);
                const amount = close * shares;
                let canEntry = true;
                if (buffer.length >= ATR_FILTER_PERIOD + 1) {
                  const highs = buffer.map(c => c.high); const lows = buffer.map(c => c.low); const closesArr = buffer.map(c => c.close);
                  const atrSeries = calcATR(highs, lows, closesArr, ATR_FILTER_PERIOD);
                  const latestATR = atrSeries[atrSeries.length - 1];
                  if (latestATR !== null && close > 0 && (latestATR / close) < ATR_FILTER_THRESHOLD) canEntry = false;
                }
                const exposure = calcCurrentExposure(openPositions);
                if (exposure + amount > MAX_TOTAL_EXPOSURE) canEntry = false;
                if (checkVolumeUnavailable(buffer)) canEntry = false;
                const lastSL = lastStopLossTime.get(symbol);
                if (lastSL) {
                  const minSince = timeToMinutes(candleTime) - timeToMinutes(lastSL);
                  if (minSince >= 0 && minSince < NO_REENTRY_AFTER_STOPLOSS_MIN) canEntry = false;
                }
                if (canEntry) {
                  openPositions.set(symbol, { symbol, side: "long", entryPrice: close, shares, entryTime: candleTime, entryReason: buyReason });
                  allTrades.push({ symbol, symbolName: getStockName(symbol), action: "buy", price: close, shares, pnl: null, reason: buyReason, tradeTime: candleTime, side: "long", tradeDate });
                }
              }
            }
          }
        }
      }
    }

    // ---- 売り（空売り）エントリー ----
    const shouldSell = (sig && sig.type === "sell") || perfectSell || narabiSell;
    
    if (shouldSell && !openPositions.has(symbol)) {
      const sellReason = sig?.type === "sell" ? sig.reason : (perfectSell ? "逆パーフェクトオーダー (MA5<MA25<MA60<MA100)" : "並び下抜け");
      
      if (isBullish && !perfectSell) { /* skip - HybridA */ }
      else {
        if (boardSnapshot && boardSnapshot.signal === "buy_pressure") { /* skip */ }
        else {
          // 【改良案A】MA60傾きフィルター: MA60が上向きならSHORT見送り
          if (ma60Slope > 0.02 && !perfectSell) { /* skip */ }
          else {
            // 【改良案E】日足トレンドバイアス
            let biasAdjust = 0;
            if (dailyBias === "bearish") biasAdjust = 1;
            else if (dailyBias === "bullish") biasAdjust = -1;

            const brScore = boardReadingScoreImproved(bprHistories.get(symbol) ?? [], "short", boardSnapshot) + biasAdjust;
            if (brScore >= BOARD_SCORE_THRESHOLD) {
              // ダウ理論SHORT → 5分足フィルター
              if (sig?.reason?.startsWith("ダウ理論: 直近安値更新")) {
                const htfTrend = getHigherTfTrend(buffer, buffer.length - 1, 5);
                if (htfTrend !== "down") { /* skip */ }
                else {
                  if (buffer.length >= PULLBACK_DEPTH_LOOKBACK) {
                    const lookbackWindow = buffer.slice(buffer.length - PULLBACK_DEPTH_LOOKBACK);
                    const swingHigh = Math.max(...lookbackWindow.map(c => c.high));
                    const swingLow = Math.min(...lookbackWindow.map(c => c.low));
                    if (swingHigh > swingLow) {
                      const pullbackDepth = (close - swingLow) / (swingHigh - swingLow);
                      if (pullbackDepth < PULLBACK_DEPTH_MIN || pullbackDepth > PULLBACK_DEPTH_MAX) { /* skip */ }
                    }
                  }
                }
              }
              // 大台割れ → 確認バーステートマシン
              else if (sig?.reason?.startsWith("大台割れ")) {
                const m = sig.reason.match(/(\d+(?:\.\d+)?)円/);
                const level = m ? parseFloat(m[1]) : close;
                roundLevelPendingStates.set(symbol, { direction: "sell", level, confirmCount: 0, reason: sig.reason });
              }
              // 直接エントリー
              else {
                const shares = calcShares(close);
                const amount = close * shares;
                let canEntry = true;
                if (buffer.length >= ATR_FILTER_PERIOD + 1) {
                  const highs = buffer.map(c => c.high); const lows = buffer.map(c => c.low); const closesArr = buffer.map(c => c.close);
                  const atrSeries = calcATR(highs, lows, closesArr, ATR_FILTER_PERIOD);
                  const latestATR = atrSeries[atrSeries.length - 1];
                  if (latestATR !== null && close > 0 && (latestATR / close) < ATR_FILTER_THRESHOLD) canEntry = false;
                }
                const exposure = calcCurrentExposure(openPositions);
                if (exposure + amount > MAX_TOTAL_EXPOSURE) canEntry = false;
                if (checkVolumeUnavailable(buffer)) canEntry = false;
                const lastSL = lastStopLossTime.get(symbol);
                if (lastSL) {
                  const minSince = timeToMinutes(candleTime) - timeToMinutes(lastSL);
                  if (minSince >= 0 && minSince < NO_REENTRY_AFTER_STOPLOSS_MIN) canEntry = false;
                }
                if (canEntry) {
                  openPositions.set(symbol, { symbol, side: "short", entryPrice: close, shares, entryTime: candleTime, entryReason: sellReason });
                  allTrades.push({ symbol, symbolName: getStockName(symbol), action: "short", price: close, shares, pnl: null, reason: sellReason, tradeTime: candleTime, side: "short", tradeDate });
                }
              }
            }
          }
        }
      }
    }
  }

  // 引け後も残ったポジションを最終足の終値で強制決済
  for (const [symbol, pos] of openPositions.entries()) {
    const symbolCandles = bySymbol.get(symbol);
    if (!symbolCandles || symbolCandles.length === 0) continue;
    const lastCandle = symbolCandles[symbolCandles.length - 1];
    const { entryPrice, shares, side } = pos;
    const pnl = side === "long"
      ? (lastCandle.close - entryPrice) * shares
      : (entryPrice - lastCandle.close) * shares;
    totalPnl += pnl;
    if (pnl > 0) winCount++; else lossCount++;
    allTrades.push({ symbol, symbolName: getStockName(symbol), action: "forced_close", price: lastCandle.close, shares, pnl, reason: "引け強制決済", tradeTime: lastCandle.candleTime, side, tradeDate });
  }

  // 当日の終値を記録（翌日のギャップ判定用）
  const dayCloses = new Map<string, number>();
  for (const [sym, candles] of bySymbol.entries()) {
    if (candles.length > 0) dayCloses.set(sym, candles[candles.length - 1].close);
  }

  return { totalPnl, winCount, lossCount, trades: allTrades, dayCloses };
}

// ============================================================
// 7日分バッチ実行
// ============================================================
const DATA_FILES = [
  "/tmp/rt_candles_20260617.json",
  "/tmp/rt_candles_20260618.json",
  "/tmp/rt_candles_20260619.json",
  "/tmp/rt_candles_20260622.json",
  "/tmp/rt_candles_20260623.json",
  "/tmp/rt_candles_20260624.json",
  "/tmp/rt_candles_20260625.json",
];

console.log("=== 改良版シミュレーション（7営業日） ===");
console.log("改良案A: MA60/MA100 + パーフェクトオーダー");
console.log("改良案B: 歩み値方向推定（板読みスコア要素F）");
console.log("改良案C: 見せ板検出→trap強制 / アイスバーグ→信頼度UP");
console.log("改良案D: 板読み早期損切り（根拠崩壊ロジック）");
console.log("改良案E: 日足トレンドバイアス");
console.log("改良案F: 並び抜けシグナル");
console.log("---");

let grandTotalPnl = 0;
let grandWin = 0;
let grandLoss = 0;
const allTradesAll: Trade[] = [];
let prevDayCloses = new Map<string, number>();
const dailyResults: { date: string; pnl: number; win: number; loss: number; trades: number }[] = [];

for (const dataFile of DATA_FILES) {
  if (!fs.existsSync(dataFile)) {
    console.log(`SKIP: ${dataFile} not found`);
    continue;
  }
  const candles: RtCandleRow[] = JSON.parse(fs.readFileSync(dataFile, "utf8"));
  if (candles.length === 0) { console.log(`SKIP: ${dataFile} empty`); continue; }
  
  const tradeDate = candles[0].tradeDate;
  const result = simulateDay(candles, prevDayCloses);
  
  grandTotalPnl += result.totalPnl;
  grandWin += result.winCount;
  grandLoss += result.lossCount;
  allTradesAll.push(...result.trades);
  prevDayCloses = result.dayCloses;
  
  const exitTrades = result.trades.filter(t => t.pnl !== null);
  dailyResults.push({ date: tradeDate, pnl: result.totalPnl, win: result.winCount, loss: result.lossCount, trades: exitTrades.length });
  
  console.log(`${tradeDate}: ${result.totalPnl >= 0 ? "+" : ""}${Math.round(result.totalPnl).toLocaleString()}円 (${result.winCount}勝${result.lossCount}敗, ${exitTrades.length}取引)`);
}

console.log("\n=== 7日間サマリー ===");
console.log(`合計損益: ${grandTotalPnl >= 0 ? "+" : ""}${Math.round(grandTotalPnl).toLocaleString()}円`);
console.log(`勝ち: ${grandWin}回, 負け: ${grandLoss}回`);
console.log(`勝率: ${grandWin + grandLoss > 0 ? ((grandWin / (grandWin + grandLoss)) * 100).toFixed(1) : 0}%`);
console.log(`取引回数: ${grandWin + grandLoss}回`);
console.log(`1日平均損益: ${Math.round(grandTotalPnl / dailyResults.length).toLocaleString()}円`);

// 銘柄別サマリー
const bySymbolPnl = new Map<string, { pnl: number; count: number; win: number; loss: number }>();
for (const t of allTradesAll) {
  if (t.pnl === null) continue;
  const cur = bySymbolPnl.get(t.symbol) ?? { pnl: 0, count: 0, win: 0, loss: 0 };
  cur.pnl += t.pnl;
  cur.count++;
  if (t.pnl > 0) cur.win++; else cur.loss++;
  bySymbolPnl.set(t.symbol, cur);
}

console.log("\n=== 銘柄別損益 ===");
const sortedSymbols = [...bySymbolPnl.entries()].sort((a, b) => b[1].pnl - a[1].pnl);
for (const [sym, data] of sortedSymbols) {
  console.log(`${sym} ${getStockName(sym)}: ${data.pnl >= 0 ? "+" : ""}${Math.round(data.pnl).toLocaleString()}円 (${data.win}勝${data.loss}敗)`);
}

// 決済理由別サマリー
const byReason = new Map<string, { pnl: number; count: number }>();
for (const t of allTradesAll) {
  if (t.pnl === null) continue;
  // reasonを正規化
  let reasonKey = t.reason;
  if (reasonKey.includes("損切り")) reasonKey = "損切り";
  else if (reasonKey.includes("利確")) reasonKey = "利確";
  else if (reasonKey.includes("シグナル反転")) reasonKey = "シグナル反転決済";
  else if (reasonKey.includes("板読み早期損切り")) reasonKey = "板読み早期損切り";
  else if (reasonKey.includes("板読み早期利確")) reasonKey = "板読み早期利確";
  else if (reasonKey.includes("強制決済")) reasonKey = "大引け強制決済";
  const cur = byReason.get(reasonKey) ?? { pnl: 0, count: 0 };
  cur.pnl += t.pnl;
  cur.count++;
  byReason.set(reasonKey, cur);
}

console.log("\n=== 決済理由別 ===");
for (const [reason, data] of [...byReason.entries()].sort((a, b) => b[1].pnl - a[1].pnl)) {
  console.log(`${reason}: ${data.pnl >= 0 ? "+" : ""}${Math.round(data.pnl).toLocaleString()}円 (${data.count}回)`);
}

// エントリー理由別サマリー
const byEntryReason = new Map<string, { pnl: number; count: number; win: number; loss: number }>();
for (const t of allTradesAll) {
  if (t.pnl === null) continue;
  // エントリー理由を探す（同じsymbol+tradeDateのbuy/shortアクション）
  const entryTrade = allTradesAll.find(e => e.symbol === t.symbol && e.tradeDate === t.tradeDate && (e.action === "buy" || e.action === "short") && e.pnl === null && e.tradeTime <= t.tradeTime);
  if (!entryTrade) continue;
  let entryKey = entryTrade.reason;
  if (entryKey.includes("パーフェクトオーダー")) entryKey = "パーフェクトオーダー";
  else if (entryKey.includes("並び")) entryKey = "並び抜け";
  else if (entryKey.includes("大台")) entryKey = "大台超え/割れ";
  else if (entryKey.includes("ダウ理論")) entryKey = "ダウ理論";
  else if (entryKey.includes("押し目確認")) entryKey = "押し目確認";
  else entryKey = "その他シグナル";
  
  const cur = byEntryReason.get(entryKey) ?? { pnl: 0, count: 0, win: 0, loss: 0 };
  cur.pnl += t.pnl;
  cur.count++;
  if (t.pnl > 0) cur.win++; else cur.loss++;
  byEntryReason.set(entryKey, cur);
}

console.log("\n=== エントリー理由別成績 ===");
for (const [reason, data] of [...byEntryReason.entries()].sort((a, b) => b[1].pnl - a[1].pnl)) {
  const winRate = data.count > 0 ? ((data.win / data.count) * 100).toFixed(1) : "0";
  console.log(`${reason}: ${data.pnl >= 0 ? "+" : ""}${Math.round(data.pnl).toLocaleString()}円 (${data.count}回, 勝率${winRate}%)`);
}
