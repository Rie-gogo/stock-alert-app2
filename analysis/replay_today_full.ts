/**
 * replay_today_full.ts
 * 本日(2026-06-25)のDBデータ（1分足+板情報）を使い、realtimeSimEngineのロジックを
 * 忠実に再現するオフラインシミュレーション。
 * サーバー再起動の影響を排除した正確な損益を計算する。
 *
 * 実行: cd /home/ubuntu/stock-alert-app && npx tsx analysis/replay_today_full.ts
 */
import * as fs from "fs";
import { detectSignals, calcMA, calcRSI, calcBollinger, type CandleWithSignal } from "../server/routers/stockData";
import { TARGET_STOCKS } from "../shared/stocks";
import { getHigherTfTrend } from "../server/vwap";
import { calcATR } from "../server/intradayRegime";
import type { BoardSnapshot } from "../drizzle/schema";

// ============================================================
// 定数（realtimeSimEngine.tsと完全一致）
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

/**
 * 板読みスコア計算（realtimeSimEngine.tsのboardReadingScoreを忠実に再現）
 */
function boardReadingScore(
  bprHistoryArr: number[],
  side: "long" | "short",
  snapshot: BoardSnapshot | null
): number {
  if (!snapshot) return 1; // 板情報なし → 中立（シグナルを通す）

  let score = 0;
  const bpr = snapshot.buyPressureRatio;

  // 要素A: アグレッシブ注文検出 (±2)
  if (snapshot.marketOrderRatio >= 0.08) {
    if (side === "long" && bpr > 1.0) score += 2;
    else if (side === "long" && bpr < 1.0) score -= 2;
    else if (side === "short" && bpr < 1.0) score += 2;
    else if (side === "short" && bpr > 1.0) score -= 2;
  }

  // 要素B: 厚い板のアノマリー (±1)
  // 「板の厚い方に動く」→ 逆側の壁はブレイクスルーのサイン
  if (side === "long") {
    if (snapshot.largeSellWall) score += 1;  // 売り壁を突破する勢い
    if (snapshot.largeBuyWall) score -= 1;   // 買い壁がサポート→過信になりやすい
  } else {
    if (snapshot.largeBuyWall) score += 1;   // 買い壁を突破する勢い
    if (snapshot.largeSellWall) score -= 1;  // 売り壁がサポート→過信になりやすい
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

  return score;
}

function detectMarketMode(bprHistoryArr: number[], snapshot: BoardSnapshot): "active" | "building" | "trap" | "quiet" {
  const bpr = snapshot.buyPressureRatio;

  // quiet: 板圧力がほぼ1.0で変化がない
  if (bprHistoryArr.length >= 3) {
    const allNeutral = bprHistoryArr.every(h => h >= 0.85 && h <= 1.15);
    if (allNeutral && bpr >= 0.85 && bpr <= 1.15) return "quiet";
  }

  // active: 板圧力が明確に一方向
  if (bpr > 1.2 || bpr < 0.8) return "active";

  // building: 変化トレンドがある
  if (bprHistoryArr.length >= 3) {
    const oldest = bprHistoryArr[0];
    const newest = bprHistoryArr[bprHistoryArr.length - 1];
    const delta = Math.abs(newest - oldest);
    if (delta >= 0.1) return "building";
  }

  // trap: 板圧力はあるが変化がない（大口が板を固めている）
  return "trap";
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
// メインシミュレーション
// ============================================================
function simulate(candles: RtCandleRow[]): { totalPnl: number; winCount: number; lossCount: number; trades: Trade[] } {
  // 銘柄ごとにグループ化
  const bySymbol = new Map<string, RtCandleRow[]>();
  for (const c of candles) {
    if (!ALLOWED_SYMBOLS.has(c.symbol)) continue;
    // 昼休みスキップ
    if (c.candleTime >= "11:30" && c.candleTime < "12:30") continue;
    if (!bySymbol.has(c.symbol)) bySymbol.set(c.symbol, []);
    bySymbol.get(c.symbol)!.push(c);
  }

  // 時系列順に全銘柄を処理（実際のエンジンと同じく時刻順）
  const allCandlesSorted = candles
    .filter(c => ALLOWED_SYMBOLS.has(c.symbol))
    .filter(c => !(c.candleTime >= "11:30" && c.candleTime < "12:30"))
    .sort((a, b) => a.candleTime < b.candleTime ? -1 : a.candleTime > b.candleTime ? 1 : a.symbol < b.symbol ? -1 : 1);

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

    // バッファ初期化
    if (!buffers.has(symbol)) buffers.set(symbol, []);
    const buffer = buffers.get(symbol)!;

    // bprHistory更新
    if (boardSnapshot) {
      const history = bprHistories.get(symbol) ?? [];
      history.push(boardSnapshot.buyPressureRatio);
      if (history.length > 5) history.shift();
      bprHistories.set(symbol, history);
    }

    // CandleWithSignal形式に変換してバッファに追加
    const candleForSignal: CandleWithSignal = {
      time: `${candle.tradeDate}T${candleTime}:00`,
      dayKey: candle.tradeDate,
      timestamp: new Date(`${candle.tradeDate}T${candleTime}:00+09:00`).getTime(),
      open, high, low, close, volume,
      ma5: null, ma25: null, rsi: null,
      bbUpper: null, bbMiddle: null, bbLower: null,
    };
    buffer.push(candleForSignal);

    // MA5・MA25・RSI・BBを計算
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

    // ---- 既存ポジションの損切り・利確チェック ----
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
        allTrades.push({
          symbol, symbolName: getStockName(symbol),
          action: "forced_close", price: close, shares,
          pnl, reason: "大引け強制決済", tradeTime: candleTime, side,
        });
        openPositions.delete(symbol);
        continue;
      }

      let exitPrice: number | null = null;
      let exitReason = "";
      let exitAction = "exit";

      if (side === "long") {
        const stopLine = entryPrice * (1 - STOP_LOSS_PERCENT / 100);
        const tpLine = entryPrice * (1 + TAKE_PROFIT_PERCENT / 100);
        if (low <= stopLine) { exitPrice = stopLine; exitReason = `損切り (${stopLine.toFixed(0)}円)`; exitAction = "stop_loss"; }
        else if (high >= tpLine) { exitPrice = tpLine; exitReason = `利確 (${tpLine.toFixed(0)}円)`; exitAction = "take_profit"; }
      } else {
        const stopLine = entryPrice * (1 + STOP_LOSS_PERCENT / 100);
        const tpLine = entryPrice * (1 - TAKE_PROFIT_PERCENT / 100);
        if (high >= stopLine) { exitPrice = stopLine; exitReason = `損切り (${stopLine.toFixed(0)}円)`; exitAction = "stop_loss"; }
        else if (low <= tpLine) { exitPrice = tpLine; exitReason = `利確 (${tpLine.toFixed(0)}円)`; exitAction = "take_profit"; }
      }

      // シグナル反転決済
      if (exitPrice === null && buffer.length >= MIN_CANDLES_FOR_SIGNAL) {
        const withSignals = detectSignals(buffer);
        const latest = withSignals[withSignals.length - 1];
        buffer[buffer.length - 1] = latest;
        if (latest.signal) {
          if (side === "long" && latest.signal.type === "sell") {
            exitPrice = close; exitReason = `シグナル反転決済: ${latest.signal.reason}`; exitAction = "exit";
          } else if (side === "short" && latest.signal.type === "buy") {
            exitPrice = close; exitReason = `シグナル反転決済: ${latest.signal.reason}`; exitAction = "exit";
          }
        }
      }

      // 板読み早期利確
      if (exitPrice === null && shouldBoardEarlyExit(existingPos, close, boardSnapshot)) {
        exitPrice = close;
        exitReason = `板読み早期利確 (逆方向板圧力検出)`;
        exitAction = "take_profit";
      }

      if (exitPrice !== null) {
        const pnl = side === "long"
          ? (exitPrice - entryPrice) * shares
          : (entryPrice - exitPrice) * shares;
        totalPnl += pnl;
        if (pnl > 0) winCount++; else lossCount++;
        allTrades.push({
          symbol, symbolName: getStockName(symbol),
          action: side === "long" ? "sell" : "cover",
          price: exitPrice, shares,
          pnl, reason: exitReason, tradeTime: candleTime, side,
        });
        openPositions.delete(symbol);
        if (exitAction === "stop_loss") {
          lastStopLossTime.set(symbol, candleTime);
        }
        continue;
      }

      // ポジション保有中は新規エントリーしない
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

    // ---- 押し目確認ステートマシン処理 ----
    const pullbackState = pullbackStates.get(symbol);
    if (pullbackState) {
      pullbackState.waitCount++;
      if (low < pullbackState.recentSwingLow) {
        pullbackStates.delete(symbol);
        continue;
      }
      if (pullbackState.waitCount > PULLBACK_MAX_WAIT) {
        pullbackStates.delete(symbol);
        continue;
      }
      if (!pullbackState.pulledBack && close < pullbackState.signalPrice) {
        pullbackState.pulledBack = true;
      }
      if (pullbackState.pulledBack && close > pullbackState.signalPrice) {
        pullbackStates.delete(symbol);
        // 板読みチェック
        if (boardSnapshot && boardSnapshot.signal === "sell_pressure") continue;
        const brScore = boardReadingScore(bprHistories.get(symbol) ?? [], "long", boardSnapshot);
        if (brScore < BOARD_SCORE_THRESHOLD) continue;
        // エントリー
        const shares = calcShares(close);
        const amount = close * shares;
        // ATRフィルター
        if (buffer.length >= ATR_FILTER_PERIOD + 1) {
          const highs = buffer.map(c => c.high);
          const lows = buffer.map(c => c.low);
          const closesArr = buffer.map(c => c.close);
          const atrSeries = calcATR(highs, lows, closesArr, ATR_FILTER_PERIOD);
          const latestATR = atrSeries[atrSeries.length - 1];
          if (latestATR !== null && close > 0 && (latestATR / close) < ATR_FILTER_THRESHOLD) continue;
        }
        // 証拠金チェック
        const exposure = calcCurrentExposure(openPositions);
        if (exposure + amount > MAX_TOTAL_EXPOSURE) continue;
        // 出来高不可チェック
        if (checkVolumeUnavailable(buffer)) {
          if (candleTime >= NO_ENTRY_LUNCH_START && candleTime <= NO_ENTRY_LUNCH_END) continue;
          const lastSL = lastStopLossTime.get(symbol);
          if (lastSL) {
            const minSince = timeToMinutes(candleTime) - timeToMinutes(lastSL);
            if (minSince >= 0 && minSince < NO_REENTRY_AFTER_STOPLOSS_MIN) continue;
          }
        }
        openPositions.set(symbol, { symbol, side: "long", entryPrice: close, shares, entryTime: candleTime, entryReason: `押し目確認: ${pullbackState.reason}` });
        allTrades.push({
          symbol, symbolName: getStockName(symbol),
          action: "buy", price: close, shares,
          pnl: null, reason: `押し目確認: ${pullbackState.reason}`, tradeTime: candleTime, side: "long",
        });
        continue;
      }
      continue;
    }

    // ---- 大台確認バーステートマシン処理 ----
    const roundPending = roundLevelPendingStates.get(symbol);
    if (roundPending) {
      if (openPositions.has(symbol)) {
        roundLevelPendingStates.delete(symbol);
      } else {
        const stillValid = roundPending.direction === "buy"
          ? close >= roundPending.level
          : close <= roundPending.level;
        if (stillValid) {
          roundPending.confirmCount++;
          if (roundPending.confirmCount >= 5) {
            roundLevelPendingStates.delete(symbol);
            // 大台確認後の押し目待ちステートマシンに移行
            roundPullbackStates.set(symbol, {
              direction: roundPending.direction,
              level: roundPending.level,
              signalPrice: close,
              waitCount: 0,
              pulledBack: false,
              reason: roundPending.reason,
            });
          }
        } else {
          roundLevelPendingStates.delete(symbol);
        }
        continue;
      }
    }

    // ---- 大台確認後の押し目待ちステートマシン処理 ----
    const roundPb = roundPullbackStates.get(symbol);
    if (roundPb) {
      roundPb.waitCount++;
      const side: "long" | "short" = roundPb.direction === "buy" ? "long" : "short";

      if (roundPb.direction === "buy" && close < roundPb.level) {
        roundPullbackStates.delete(symbol);
        continue;
      }
      if (roundPb.direction === "sell" && close > roundPb.level) {
        roundPullbackStates.delete(symbol);
        continue;
      }

      // タイムアウト
      if (roundPb.waitCount > ROUND_PULLBACK_MAX_WAIT) {
        roundPullbackStates.delete(symbol);
        if (boardSnapshot && side === "long" && boardSnapshot.signal === "sell_pressure") continue;
        if (boardSnapshot && side === "short" && boardSnapshot.signal === "buy_pressure") continue;
        const brScore = boardReadingScore(bprHistories.get(symbol) ?? [], side, boardSnapshot);
        if (brScore < BOARD_SCORE_THRESHOLD) continue;
        // エントリー
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
        if (checkVolumeUnavailable(buffer)) {
          if (candleTime >= NO_ENTRY_LUNCH_START && candleTime <= NO_ENTRY_LUNCH_END) continue;
          const lastSL = lastStopLossTime.get(symbol);
          if (lastSL) {
            const minSince = timeToMinutes(candleTime) - timeToMinutes(lastSL);
            if (minSince >= 0 && minSince < NO_REENTRY_AFTER_STOPLOSS_MIN) continue;
          }
        }
        openPositions.set(symbol, { symbol, side, entryPrice: close, shares, entryTime: candleTime, entryReason: `${roundPb.reason} (押し目なし・強トレンド)` });
        allTrades.push({
          symbol, symbolName: getStockName(symbol),
          action: side === "long" ? "buy" : "short", price: close, shares,
          pnl: null, reason: `${roundPb.reason} (押し目なし・強トレンド)`, tradeTime: candleTime, side,
        });
        continue;
      }

      // 押し目判定
      if (roundPb.direction === "buy") {
        if (!roundPb.pulledBack && close < roundPb.signalPrice) roundPb.pulledBack = true;
        if (roundPb.pulledBack && close > roundPb.signalPrice) {
          roundPullbackStates.delete(symbol);
          if (boardSnapshot && boardSnapshot.signal === "sell_pressure") continue;
          const brScore = boardReadingScore(bprHistories.get(symbol) ?? [], "long", boardSnapshot);
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
          openPositions.set(symbol, { symbol, side: "long", entryPrice: close, shares, entryTime: candleTime, entryReason: `${roundPb.reason} (押し目確認後)` });
          allTrades.push({
            symbol, symbolName: getStockName(symbol),
            action: "buy", price: close, shares,
            pnl: null, reason: `${roundPb.reason} (押し目確認後)`, tradeTime: candleTime, side: "long",
          });
          continue;
        }
      } else {
        if (!roundPb.pulledBack && close > roundPb.signalPrice) roundPb.pulledBack = true;
        if (roundPb.pulledBack && close < roundPb.signalPrice) {
          roundPullbackStates.delete(symbol);
          if (boardSnapshot && boardSnapshot.signal === "buy_pressure") continue;
          const brScore = boardReadingScore(bprHistories.get(symbol) ?? [], "short", boardSnapshot);
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
          openPositions.set(symbol, { symbol, side: "short", entryPrice: close, shares, entryTime: candleTime, entryReason: `${roundPb.reason} (押し目確認後)` });
          allTrades.push({
            symbol, symbolName: getStockName(symbol),
            action: "short", price: close, shares,
            pnl: null, reason: `${roundPb.reason} (押し目確認後)`, tradeTime: candleTime, side: "short",
          });
          continue;
        }
      }
      continue;
    }

    if (!latestSignal.signal) continue;
    const sig = latestSignal.signal;

    // HybridAフィルター
    const firstCandle = buffer[0];
    const openPrice = firstCandle?.open ?? close;
    const priceChangeRatio = (close - openPrice) / openPrice * 100;
    const isBullish = priceChangeRatio >= 0.2;

    // ---- 買いエントリー ----
    if (sig.type === "buy") {
      // VWAPクロス上抜け無効化
      if (sig.reason.includes("VWAPクロス上抜け")) continue;
      // sell_pressure時のLONG禁止
      if (boardSnapshot && boardSnapshot.signal === "sell_pressure") continue;
      // 板読みスコア
      const brScore = boardReadingScore(bprHistories.get(symbol) ?? [], "long", boardSnapshot);
      if (brScore < BOARD_SCORE_THRESHOLD) continue;

      // ダウ理論（上昇）→ 押し目確認ステートマシン
      if (sig.reason.startsWith("ダウ理論: 直近高値更新") && sig.recentSwingLow != null) {
        // 5分足フィルター
        const htfTrend = getHigherTfTrend(buffer, buffer.length - 1, 5);
        if (htfTrend !== "up") continue;
        // 押し目深さフィルター
        if (buffer.length >= PULLBACK_DEPTH_LOOKBACK) {
          const lookbackWindow = buffer.slice(buffer.length - PULLBACK_DEPTH_LOOKBACK);
          const swingHigh = Math.max(...lookbackWindow.map(c => c.high));
          const swingLow = Math.min(...lookbackWindow.map(c => c.low));
          if (swingHigh > swingLow) {
            const pullbackDepth = (swingHigh - close) / (swingHigh - swingLow);
            if (pullbackDepth < PULLBACK_DEPTH_MIN || pullbackDepth > PULLBACK_DEPTH_MAX) continue;
          }
        }
        pullbackStates.set(symbol, {
          recentSwingLow: sig.recentSwingLow,
          signalPrice: close,
          waitCount: 0,
          pulledBack: false,
          reason: sig.reason,
        });
        continue;
      }

      // 大台超え → 確認バーステートマシン
      if (sig.reason.startsWith("大台超え")) {
        const m = sig.reason.match(/(\d+(?:\.\d+)?)円/);
        const level = m ? parseFloat(m[1]) : close;
        roundLevelPendingStates.set(symbol, {
          direction: "buy",
          level,
          confirmCount: 0,
          reason: sig.reason,
        });
        continue;
      }

      // 直接エントリー
      const shares = calcShares(close);
      const amount = close * shares;
      // ATRフィルター
      if (buffer.length >= ATR_FILTER_PERIOD + 1) {
        const highs = buffer.map(c => c.high);
        const lows = buffer.map(c => c.low);
        const closesArr = buffer.map(c => c.close);
        const atrSeries = calcATR(highs, lows, closesArr, ATR_FILTER_PERIOD);
        const latestATR = atrSeries[atrSeries.length - 1];
        if (latestATR !== null && close > 0 && (latestATR / close) < ATR_FILTER_THRESHOLD) continue;
      }
      // 証拠金チェック
      const exposure = calcCurrentExposure(openPositions);
      if (exposure + amount > MAX_TOTAL_EXPOSURE) continue;
      // 出来高不可チェック
      if (checkVolumeUnavailable(buffer)) {
        if (candleTime >= NO_ENTRY_LUNCH_START && candleTime <= NO_ENTRY_LUNCH_END) continue;
        const lastSL = lastStopLossTime.get(symbol);
        if (lastSL) {
          const minSince = timeToMinutes(candleTime) - timeToMinutes(lastSL);
          if (minSince >= 0 && minSince < NO_REENTRY_AFTER_STOPLOSS_MIN) continue;
        }
      }
      openPositions.set(symbol, { symbol, side: "long", entryPrice: close, shares, entryTime: candleTime, entryReason: sig.reason });
      allTrades.push({
        symbol, symbolName: getStockName(symbol),
        action: "buy", price: close, shares,
        pnl: null, reason: sig.reason, tradeTime: candleTime, side: "long",
      });
    }

    // ---- 売り（空売り）エントリー ----
    else if (sig.type === "sell") {
      if (isBullish) continue;
      if (boardSnapshot && boardSnapshot.signal === "buy_pressure") continue;
      const brScore = boardReadingScore(bprHistories.get(symbol) ?? [], "short", boardSnapshot);
      if (brScore < BOARD_SCORE_THRESHOLD) continue;

      // ダウ理論SHORT → 5分足フィルター
      if (sig.reason.startsWith("ダウ理論: 直近安値更新")) {
        const htfTrend = getHigherTfTrend(buffer, buffer.length - 1, 5);
        if (htfTrend !== "down") continue;
        // 押し目深さフィルター (SHORT)
        if (buffer.length >= PULLBACK_DEPTH_LOOKBACK) {
          const lookbackWindow = buffer.slice(buffer.length - PULLBACK_DEPTH_LOOKBACK);
          const swingHigh = Math.max(...lookbackWindow.map(c => c.high));
          const swingLow = Math.min(...lookbackWindow.map(c => c.low));
          if (swingHigh > swingLow) {
            const pullbackDepth = (close - swingLow) / (swingHigh - swingLow);
            if (pullbackDepth < PULLBACK_DEPTH_MIN || pullbackDepth > PULLBACK_DEPTH_MAX) continue;
          }
        }
      }

      // 大台割れ → 確認バーステートマシン
      if (sig.reason.startsWith("大台割れ")) {
        const m = sig.reason.match(/(\d+(?:\.\d+)?)円/);
        const level = m ? parseFloat(m[1]) : close;
        roundLevelPendingStates.set(symbol, {
          direction: "sell",
          level,
          confirmCount: 0,
          reason: sig.reason,
        });
        continue;
      }

      const shares = calcShares(close);
      const amount = close * shares;
      // ATRフィルター
      if (buffer.length >= ATR_FILTER_PERIOD + 1) {
        const highs = buffer.map(c => c.high);
        const lows = buffer.map(c => c.low);
        const closesArr = buffer.map(c => c.close);
        const atrSeries = calcATR(highs, lows, closesArr, ATR_FILTER_PERIOD);
        const latestATR = atrSeries[atrSeries.length - 1];
        if (latestATR !== null && close > 0 && (latestATR / close) < ATR_FILTER_THRESHOLD) continue;
      }
      // 証拠金チェック
      const exposure = calcCurrentExposure(openPositions);
      if (exposure + amount > MAX_TOTAL_EXPOSURE) continue;
      // 出来高不可チェック
      if (checkVolumeUnavailable(buffer)) {
        if (candleTime >= NO_ENTRY_LUNCH_START && candleTime <= NO_ENTRY_LUNCH_END) continue;
        const lastSL = lastStopLossTime.get(symbol);
        if (lastSL) {
          const minSince = timeToMinutes(candleTime) - timeToMinutes(lastSL);
          if (minSince >= 0 && minSince < NO_REENTRY_AFTER_STOPLOSS_MIN) continue;
        }
      }
      openPositions.set(symbol, { symbol, side: "short", entryPrice: close, shares, entryTime: candleTime, entryReason: sig.reason });
      allTrades.push({
        symbol, symbolName: getStockName(symbol),
        action: "short", price: close, shares,
        pnl: null, reason: sig.reason, tradeTime: candleTime, side: "short",
      });
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
    allTrades.push({
      symbol, symbolName: getStockName(symbol),
      action: "forced_close", price: lastCandle.close, shares,
      pnl, reason: "引け強制決済(シミュレーション終了)", tradeTime: lastCandle.candleTime, side,
    });
  }

  return { totalPnl, winCount, lossCount, trades: allTrades };
}

// ============================================================
// 実行
// ============================================================
const dataPath = "/tmp/rt_candles_20260625.json";
if (!fs.existsSync(dataPath)) {
  console.error(`データファイルが見つかりません: ${dataPath}`);
  console.error("先に node analysis/export_today.mjs を実行してください");
  process.exit(1);
}

const candles: RtCandleRow[] = JSON.parse(fs.readFileSync(dataPath, "utf8"));
console.log(`=== 2026-06-25 フルシミュレーション ===`);
console.log(`入力データ: ${candles.length}本 (昼休みスキップ後)`);
console.log(`対象銘柄: ${TARGET_STOCKS.length}銘柄`);
console.log(`定数: SL=${STOP_LOSS_PERCENT}%, TP=${TAKE_PROFIT_PERCENT}%, 証拠金上限=${(MAX_TOTAL_EXPOSURE/10000).toFixed(0)}万円`);
console.log(`---`);

const result = simulate(candles);

console.log(`\n=== 結果サマリー ===`);
console.log(`合計損益: ${result.totalPnl >= 0 ? "+" : ""}${Math.round(result.totalPnl).toLocaleString()}円`);
console.log(`勝ち: ${result.winCount}回, 負け: ${result.lossCount}回`);
console.log(`勝率: ${result.winCount + result.lossCount > 0 ? ((result.winCount / (result.winCount + result.lossCount)) * 100).toFixed(1) : 0}%`);

// 銘柄別サマリー
const bySymbolPnl = new Map<string, { pnl: number; count: number }>();
for (const t of result.trades) {
  if (t.pnl === null) continue;
  const cur = bySymbolPnl.get(t.symbol) ?? { pnl: 0, count: 0 };
  cur.pnl += t.pnl;
  cur.count++;
  bySymbolPnl.set(t.symbol, cur);
}

console.log(`\n=== 銘柄別損益 ===`);
for (const [sym, data] of [...bySymbolPnl.entries()].sort((a, b) => b[1].pnl - a[1].pnl)) {
  console.log(`  ${sym} ${getStockName(sym).padEnd(15)} ${data.count}回  ${data.pnl >= 0 ? "+" : ""}${Math.round(data.pnl).toLocaleString()}円`);
}

console.log(`\n=== 全取引詳細 ===`);
for (const t of result.trades) {
  const pnlStr = t.pnl !== null ? ` → ${t.pnl >= 0 ? "+" : ""}${Math.round(t.pnl).toLocaleString()}円` : "";
  console.log(`  ${t.tradeTime} ${t.symbol} ${t.action.padEnd(12)} @${t.price.toLocaleString()}円 ×${t.shares}株  [${t.reason.slice(0, 50)}]${pnlStr}`);
}
