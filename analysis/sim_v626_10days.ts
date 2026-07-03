/**
 * sim_v626_10days.ts
 *
 * 6/26時点のエンジン仕様で直近10日間をシミュレーション。
 * 
 * 6/26版の特徴（現行との差分）:
 * - BEストップなし（SL/TPのみ）
 * - 後場BPRフィルターなし
 * - VWAP急落フィルターなし
 * - 17銘柄（現行は10銘柄）
 * - isBullish方式（B2方式ではない）: 各銘柄の始値比+0.2%以上で上昇相場判定
 * - BUY medium: ステートマシントリガー以外は全ブロック
 * - SHORT medium: 全ブロック
 * - 板読みスコア7要素（A〜G）
 * - v8板スナップショット集約なし
 */

import { getDb } from "../server/db";
import { detectSignals, calcMA, calcRSI, calcBollinger, type CandleWithSignal } from "../server/routers/stockData";
import { evaluateConfirmation, trailingAvgVolume, priceMomentum, type SignalConfidence } from "../server/signalConfirmation";
import { calcATR } from "../server/intradayRegime";
import { getStockName } from "../shared/stocks";

// ============================================================
// 定数（6/26版）
// ============================================================
const INITIAL_CAPITAL_PER_STOCK = 3_000_000;
const LOT_RATIO = 0.9;
const STOP_LOSS_PERCENT = 0.5;
const TAKE_PROFIT_PERCENT = 1.5;
// BEストップなし（6/26版にはない）
const MARGIN_CAPITAL = 3_000_000;
const MARGIN_MULTIPLIER = 3.3;
const MARGIN_USAGE_LIMIT = 0.9;
const MAX_TOTAL_EXPOSURE = MARGIN_CAPITAL * MARGIN_MULTIPLIER * MARGIN_USAGE_LIMIT;
const MARKET_CLOSE_TIME = "15:30";
const NO_ENTRY_AFTER = "15:15";
const NO_ENTRY_BEFORE = "09:30";
const NO_ENTRY_PRE_LUNCH_START = "11:00";
const NO_ENTRY_PRE_LUNCH_END = "11:30";
const NO_ENTRY_POST_LUNCH_START = "12:30";
const NO_ENTRY_POST_LUNCH_END = "13:00";
// VWAP急落フィルターなし（6/26版にはない）
const MIN_CANDLES_FOR_SIGNAL = 30;
const PULLBACK_MAX_WAIT = 5;
const ROUND_LEVEL_CONFIRM_BARS = 5;
const ROUND_PULLBACK_MAX_WAIT = 5;
const BOARD_SCORE_THRESHOLD = 1;
const ATR_FILTER_PERIOD = 7;
const ATR_FILTER_THRESHOLD = 0.0012;
const PULLBACK_DEPTH_MIN = 0.30;
const PULLBACK_DEPTH_MAX = 0.70;
const PULLBACK_DEPTH_LOOKBACK = 20;
const BOARD_EARLY_EXIT_MIN_PROFIT_PCT = 0.05;
const VOLUME_UNAVAILABLE_RATIO = 0.9;
const NO_REENTRY_AFTER_STOPLOSS_MIN = 30;
const IS_BULLISH_THRESHOLD = 0.2; // isBullish方式: 始値比+0.2%以上

// 17銘柄（6/26版）
const SEVENTEEN_SYMBOLS = [
  '6526', '6920', '6857', '9107', '8306', '9984', '8035',
  '7011', '4568', '285A', '6981', '6976', '5803', '5016',
  '8316', '6758', '7203'
];

// ============================================================
// 型定義
// ============================================================
interface OpenPosition {
  symbol: string;
  side: "long" | "short";
  entryPrice: number;
  shares: number;
  entryTime: string;
  entryReason: string;
  confidence: SignalConfidence;
}

interface PullbackState {
  recentSwingLow: number;
  signalPrice: number;
  waitCount: number;
  pulledBack: boolean;
  reason: string;
}

interface RoundLevelPendingState {
  direction: "buy" | "sell";
  level: number;
  confirmCount: number;
  reason: string;
}

interface RoundPullbackState {
  direction: "buy" | "sell";
  level: number;
  signalPrice: number;
  waitCount: number;
  pulledBack: boolean;
  reason: string;
}

interface Trade {
  date: string; symbol: string; side: "long" | "short";
  entryTime: string; entryPrice: number; exitTime: string; exitPrice: number;
  pnl: number; exitReason: string; signalReason: string; confidence: string;
  session: "am" | "pm"; shares: number;
}

// ============================================================
// ヘルパー関数
// ============================================================
function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function calcShares(price: number): number {
  const amount = INITIAL_CAPITAL_PER_STOCK * LOT_RATIO;
  const rawShares = Math.floor(amount / price);
  return Math.max(100, Math.floor(rawShares / 100) * 100);
}

function checkVolumeUnavailable(buffer: CandleWithSignal[]): boolean {
  if (buffer.length < 10) return false;
  const lookback = Math.min(buffer.length, 20);
  const recent = buffer.slice(buffer.length - lookback);
  const zeroCount = recent.filter(c => c.volume === 0).length;
  return (zeroCount / lookback) >= VOLUME_UNAVAILABLE_RATIO;
}

/** 5分足上位足トレンド判定 */
function getHigherTfTrend(buffer: CandleWithSignal[], currentIdx: number): "up" | "down" | "neutral" {
  const candlesSoFar = buffer.slice(0, currentIdx + 1);
  const htf: { close: number }[] = [];
  let group: CandleWithSignal[] = [];
  let currentBarIdx = -1;
  
  for (const c of candlesSoFar) {
    const timeStr = (c as any).time;
    let barIdx = currentBarIdx;
    if (timeStr) {
      const parts = timeStr.split("T");
      const timePart = parts.length > 1 ? parts[1] : parts[0];
      const [hStr, mStr] = timePart.split(":");
      const totalMin = parseInt(hStr, 10) * 60 + parseInt(mStr, 10);
      barIdx = Math.floor(totalMin / 5);
    }
    if (group.length > 0 && barIdx !== currentBarIdx) {
      htf.push({ close: group[group.length - 1].close });
      group = [];
    }
    currentBarIdx = barIdx;
    group.push(c);
  }
  if (group.length > 0) {
    htf.push({ close: group[group.length - 1].close });
  }
  
  if (htf.length < 25) return "neutral";
  
  const closes = htf.map(c => c.close);
  const fast5 = closes.slice(closes.length - 5).reduce((s, v) => s + v, 0) / 5;
  const slow25 = closes.slice(closes.length - 25).reduce((s, v) => s + v, 0) / 25;
  
  if (fast5 > slow25) return "up";
  if (fast5 < slow25) return "down";
  return "neutral";
}

/** 板読みスコア7要素版（6/26版: A〜G） */
function boardReadingScore(
  side: "long" | "short",
  snapshot: any | null,
  bprHistory: number[]
): number {
  if (!snapshot) return 1;
  
  const bpr = snapshot.buyPressureRatio ?? 1.0;
  let score = 0;
  
  // 要素A: アグレッシブ注文検出 (±2)
  if ((snapshot.marketOrderRatio ?? 0) >= 0.08) {
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
  if (bprHistory.length >= 3) {
    const oldest = bprHistory[0];
    const newest = bprHistory[bprHistory.length - 1];
    const delta = newest - oldest;
    if (side === "long" && delta >= 0.15) score += 1;
    else if (side === "long" && delta <= -0.15) score -= 1;
    else if (side === "short" && delta <= -0.15) score += 1;
    else if (side === "short" && delta >= 0.15) score -= 1;
  }
  
  // 要素D: 相場モード判定 (+1/-2)
  const cancelDetected = !!(snapshot.askCancelDetected || snapshot.bidCancelDetected);
  let mode: "active" | "building" | "trap" | "quiet";
  if (cancelDetected) {
    mode = "trap";
  } else if (bprHistory.length >= 3) {
    const allNeutral = bprHistory.every(h => h >= 0.85 && h <= 1.15);
    if (allNeutral && bpr >= 0.85 && bpr <= 1.15) {
      mode = "quiet";
    } else if (bpr > 1.2 || bpr < 0.8) {
      mode = "active";
    } else {
      const oldest = bprHistory[0];
      const newest = bprHistory[bprHistory.length - 1];
      if (Math.abs(newest - oldest) >= 0.1) {
        mode = "building";
      } else {
        mode = "trap";
      }
    }
  } else {
    mode = (bpr > 1.2 || bpr < 0.8) ? "active" : "trap";
  }
  if (mode === "active" || mode === "building") score += 1;
  else if (mode === "trap" || mode === "quiet") score -= 2;
  
  // 要素E: 板圧力の強さ (±1)
  if (side === "long" && bpr >= 1.4) score += 1;
  else if (side === "long" && bpr <= 0.65) score -= 1;
  else if (side === "short" && bpr <= 0.65) score += 1;
  else if (side === "short" && bpr >= 1.4) score -= 1;
  
  // 要素F: 歩み値方向推定 (±2)
  let tickDir: "uptick" | "downtick" | "neutral" = "neutral";
  const mod = snapshot.marketOrderDirection;
  if (mod === "buy") tickDir = "uptick";
  else if (mod === "sell") tickDir = "downtick";
  else if (bprHistory.length >= 3) {
    const first = bprHistory[0];
    const last = bprHistory[bprHistory.length - 1];
    const trend = last - first;
    if (trend >= 0.2) tickDir = "uptick";
    else if (trend <= -0.2) tickDir = "downtick";
    else if (last >= 1.3) tickDir = "uptick";
    else if (last <= 0.7) tickDir = "downtick";
  }
  if (tickDir === "uptick") {
    if (side === "long") score += 2; else score -= 2;
  } else if (tickDir === "downtick") {
    if (side === "short") score += 2; else score -= 2;
  }
  
  // 要素G: アイスバーグ検出 (±1)
  let icebergSide: "buy" | "sell" | null = null;
  if (snapshot.icebergAskDetected) icebergSide = "buy";
  if (snapshot.icebergBidDetected) icebergSide = "sell";
  if (icebergSide) {
    if (side === "long" && icebergSide === "buy") score += 1;
    else if (side === "short" && icebergSide === "sell") score += 1;
    else if (side === "long" && icebergSide === "sell") score -= 1;
    else if (side === "short" && icebergSide === "buy") score -= 1;
  }
  
  return score;
}

/** 板シグナル判定 */
function getBoardSignal(snapshot: any | null): "buy_pressure" | "sell_pressure" | "neutral" {
  if (!snapshot) return "neutral";
  const sig = snapshot.signal;
  if (sig === "buy_pressure" || sig === "large_buy_wall") return "buy_pressure";
  if (sig === "sell_pressure" || sig === "large_sell_wall") return "sell_pressure";
  return "neutral";
}

/** 板読み早期利確チェック */
function shouldBoardEarlyExit(
  pos: OpenPosition,
  currentPrice: number,
  snapshot: any | null
): boolean {
  if (!snapshot) return false;
  
  const pnlPct = pos.side === "long"
    ? (currentPrice - pos.entryPrice) / pos.entryPrice * 100
    : (pos.entryPrice - currentPrice) / pos.entryPrice * 100;
  
  if (pnlPct < BOARD_EARLY_EXIT_MIN_PROFIT_PCT) return false;
  
  if (pos.side === "long") {
    return snapshot.signal === "sell_pressure" || snapshot.signal === "large_sell_wall";
  } else {
    return snapshot.signal === "buy_pressure" || snapshot.signal === "large_buy_wall";
  }
}

// ============================================================
// メインシミュレーション
// ============================================================
async function main() {
  const db = await getDb();
  
  // 直近10営業日を取得
  const [dateRows] = await db.execute(
    `SELECT DISTINCT tradeDate FROM rt_candles 
     WHERE tradeDate >= '2026-06-19' AND tradeDate <= '2026-07-03'
     ORDER BY tradeDate`
  ) as any;
  const dates = (dateRows as any[]).map((r: any) => r.tradeDate);
  console.log(`=== 6/26版エンジン シミュレーション（${dates.length}日間: ${dates[0]}〜${dates[dates.length - 1]}） ===\n`);
  
  const allTrades: Trade[] = [];
  
  for (const date of dates) {
    // ---- 日次状態リセット ----
    const openPositions = new Map<string, OpenPosition>();
    const pullbackStates = new Map<string, PullbackState>();
    const roundLevelPendingStates = new Map<string, RoundLevelPendingState>();
    const roundPullbackStates = new Map<string, RoundPullbackState>();
    const candleBuffers = new Map<string, CandleWithSignal[]>();
    const bprHistories = new Map<string, number[]>();
    const lastStopLossTime = new Map<string, string>();
    
    // ---- 全銘柄の1分足を時系列順に取得 ----
    const [candles] = await db.execute(
      `SELECT symbol, tradeDate, candleTime, open, high, low, close, volume, boardSnapshot
       FROM rt_candles
       WHERE tradeDate = '${date}'
       ORDER BY candleTime, symbol`
    ) as any;
    
    if (candles.length === 0) continue;
    
    // processCandle呼び出しカウンター
    const processCandleCount = new Map<string, number>();
    
    // ---- 時系列順にインターリーブ処理 ----
    for (const row of candles) {
      const symbol = row.symbol;
      const candleTime = row.candleTime;
      const open = Number(row.open);
      const high = Number(row.high);
      const low = Number(row.low);
      const close = Number(row.close);
      const volume = row.volume ?? 0;
      
      // 対象銘柄チェック（17銘柄）
      if (!SEVENTEEN_SYMBOLS.includes(symbol)) continue;
      
      // 昼休みスキップ
      if (candleTime >= "11:30" && candleTime < "12:30") continue;
      
      // 板情報取得
      let bpr: number | null = null;
      let boardSnap: any | null = null;
      if (row.boardSnapshot) {
        try {
          boardSnap = typeof row.boardSnapshot === "string" ? JSON.parse(row.boardSnapshot) : row.boardSnapshot;
          bpr = boardSnap.buyPressureRatio ?? null;
        } catch {}
      }
      
      // BPR履歴更新
      if (bpr !== null) {
        const hist = bprHistories.get(symbol) ?? [];
        hist.push(bpr);
        if (hist.length > 5) hist.shift();
        bprHistories.set(symbol, hist);
      }
      
      // バッファに追加
      if (!candleBuffers.has(symbol)) candleBuffers.set(symbol, []);
      const buffer = candleBuffers.get(symbol)!;
      
      const candleForSignal: CandleWithSignal = {
        time: `${date}T${candleTime}:00`,
        dayKey: date,
        timestamp: new Date(`${date}T${candleTime}:00+09:00`).getTime(),
        open, high, low, close, volume,
        ma5: null, ma25: null, rsi: null,
        bbUpper: null, bbMiddle: null, bbLower: null,
      };
      buffer.push(candleForSignal);
      
      // MA/RSI/BB計算
      const closes = buffer.map(c => c.close);
      const ma5Series = calcMA(closes, 5);
      const ma25Series = calcMA(closes, 25);
      const rsiSeries = calcRSI(closes, 14);
      const bbSeries = calcBollinger(closes, 20);
      const lastIdx = buffer.length - 1;
      buffer[lastIdx].ma5 = ma5Series[lastIdx];
      buffer[lastIdx].ma25 = ma25Series[lastIdx];
      buffer[lastIdx].rsi = rsiSeries[lastIdx];
      buffer[lastIdx].bbUpper = bbSeries.upper[lastIdx];
      buffer[lastIdx].bbMiddle = bbSeries.middle[lastIdx];
      buffer[lastIdx].bbLower = bbSeries.lower[lastIdx];
      
      // 09:30以前の足はバッファ蓄積のみ
      if (candleTime < "09:30") continue;
      
      // processCandle呼び出しカウント
      const pcCount = (processCandleCount.get(symbol) ?? 0) + 1;
      processCandleCount.set(symbol, pcCount);
      
      // ウォームアップチェック
      if (pcCount < MIN_CANDLES_FOR_SIGNAL) continue;
      
      const timeMin = timeToMinutes(candleTime);
      const isAM = timeMin < 11 * 60 + 30;
      const boardSignal = getBoardSignal(boardSnap);
      const bprHist = bprHistories.get(symbol) ?? [];
      
      // ---- 既存ポジションの決済チェック ----
      const existingPos = openPositions.get(symbol);
      if (existingPos) {
        let exitPrice: number | null = null;
        let exitReason = "";
        
        // 6/26版: BEなし、SL/TPのみ
        if (existingPos.side === "long") {
          const stopLine = existingPos.entryPrice * (1 - STOP_LOSS_PERCENT / 100);
          if (low <= stopLine) {
            exitPrice = stopLine;
            exitReason = "SL";
          }
          const tpLine = existingPos.entryPrice * (1 + TAKE_PROFIT_PERCENT / 100);
          if (high >= tpLine && exitPrice === null) {
            exitPrice = tpLine;
            exitReason = "TP";
          }
        } else {
          const stopLine = existingPos.entryPrice * (1 + STOP_LOSS_PERCENT / 100);
          if (high >= stopLine) {
            exitPrice = stopLine;
            exitReason = "SL";
          }
          const tpLine = existingPos.entryPrice * (1 - TAKE_PROFIT_PERCENT / 100);
          if (low <= tpLine && exitPrice === null) {
            exitPrice = tpLine;
            exitReason = "TP";
          }
        }
        
        // シグナル反転決済
        if (exitPrice === null && buffer.length >= 2) {
          const prevCandle = buffer[buffer.length - 2];
          if (prevCandle.signal) {
            if (existingPos.side === "long" && prevCandle.signal.type === "sell") {
              exitPrice = close;
              exitReason = "REVERSAL";
            } else if (existingPos.side === "short" && prevCandle.signal.type === "buy") {
              exitPrice = close;
              exitReason = "REVERSAL";
            }
          }
        }
        
        // 板読み早期利確
        if (exitPrice === null && shouldBoardEarlyExit(existingPos, close, boardSnap)) {
          exitPrice = close;
          exitReason = "BOARD_EXIT";
        }
        
        // 大引け強制決済
        if (exitPrice === null && candleTime >= MARKET_CLOSE_TIME) {
          exitPrice = close;
          exitReason = "EOD";
        }
        
        if (exitPrice !== null) {
          const pnl = existingPos.side === "long"
            ? Math.round((exitPrice - existingPos.entryPrice) * existingPos.shares)
            : Math.round((existingPos.entryPrice - exitPrice) * existingPos.shares);
          allTrades.push({
            date, symbol, side: existingPos.side,
            entryTime: existingPos.entryTime, entryPrice: existingPos.entryPrice,
            exitTime: candleTime, exitPrice,
            pnl, exitReason, signalReason: existingPos.entryReason,
            confidence: existingPos.confidence,
            session: timeToMinutes(existingPos.entryTime) < 12 * 60 + 30 ? "am" : "pm",
            shares: existingPos.shares,
          });
          openPositions.delete(symbol);
          if (exitReason === "SL") lastStopLossTime.set(symbol, candleTime);
          continue;
        }
      }
      
      // ---- 新規エントリー判定 ----
      // 時間帯制限
      if (candleTime < NO_ENTRY_BEFORE) continue;
      if (candleTime >= NO_ENTRY_AFTER) continue;
      if (candleTime >= NO_ENTRY_PRE_LUNCH_START && candleTime < NO_ENTRY_PRE_LUNCH_END) continue;
      if (candleTime >= NO_ENTRY_POST_LUNCH_START && candleTime < NO_ENTRY_POST_LUNCH_END) continue;
      
      // ---- isBullish方式: 各銘柄の始値比で地合い判定 ----
      const firstCandle = buffer[0];
      const openPrice = firstCandle?.open ?? close;
      const priceChangeRatio = (close - openPrice) / openPrice * 100;
      const isBullish = priceChangeRatio >= IS_BULLISH_THRESHOLD;
      
      // ---- ステートマシン処理: 押し目確認（ダウ理論上昇） ----
      const pullbackState = pullbackStates.get(symbol);
      if (pullbackState) {
        pullbackState.waitCount++;
        
        if (low < pullbackState.recentSwingLow) {
          pullbackStates.delete(symbol);
        } else if (pullbackState.waitCount > PULLBACK_MAX_WAIT) {
          // タイムアウト: 強トレンドとしてエントリー
          if (boardSignal !== "sell_pressure") {
            const brScore = boardReadingScore("long", boardSnap, bprHist);
            if (brScore >= BOARD_SCORE_THRESHOLD) {
              const entryResult = tryEnterPosition(
                "long", symbol, close, candleTime, date,
                `${pullbackState.reason} (タイムアウト)`,
                buffer, bpr, bprHist, openPositions, lastStopLossTime
              );
              if (entryResult) openPositions.set(symbol, entryResult);
            }
          }
          pullbackStates.delete(symbol);
        } else {
          if (!pullbackState.pulledBack && close < pullbackState.signalPrice) {
            pullbackState.pulledBack = true;
          }
          if (pullbackState.pulledBack && close > pullbackState.signalPrice) {
            if (boardSignal !== "sell_pressure") {
              const brScore = boardReadingScore("long", boardSnap, bprHist);
              if (brScore >= BOARD_SCORE_THRESHOLD) {
                const entryResult = tryEnterPosition(
                  "long", symbol, close, candleTime, date,
                  `${pullbackState.reason} (押し目確認後)`,
                  buffer, bpr, bprHist, openPositions, lastStopLossTime
                );
                if (entryResult) openPositions.set(symbol, entryResult);
              }
            }
            pullbackStates.delete(symbol);
          }
        }
        continue;
      }
      
      // ---- ステートマシン処理: 大台確認バー ----
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
            if (roundPending.confirmCount >= ROUND_LEVEL_CONFIRM_BARS) {
              roundLevelPendingStates.delete(symbol);
              // 確認完了 → 押し目待ちステートに移行
              if (candleTime < NO_ENTRY_AFTER) {
                roundPullbackStates.set(symbol, {
                  direction: roundPending.direction,
                  level: roundPending.level,
                  signalPrice: close,
                  waitCount: 0,
                  pulledBack: false,
                  reason: `大台確認(${ROUND_LEVEL_CONFIRM_BARS}本維持): ${roundPending.reason}`,
                });
              }
            }
          } else {
            roundLevelPendingStates.delete(symbol);
          }
        }
        continue;
      }
      
      // ---- ステートマシン処理: 大台確認後の押し目待ち ----
      const roundPb = roundPullbackStates.get(symbol);
      if (roundPb) {
        // キリ番割れチェック
        if (roundPb.direction === "buy" && close < roundPb.level) {
          roundPullbackStates.delete(symbol);
          continue;
        }
        if (roundPb.direction === "sell" && close > roundPb.level) {
          roundPullbackStates.delete(symbol);
          continue;
        }
        
        roundPb.waitCount++;
        if (roundPb.waitCount > ROUND_PULLBACK_MAX_WAIT) {
          // タイムアウト: 強トレンドとしてエントリー
          const side = roundPb.direction === "buy" ? "long" : "short";
          const oppSignal = side === "long" ? "sell_pressure" : "buy_pressure";
          if (boardSignal !== oppSignal) {
            const brScore = boardReadingScore(side, boardSnap, bprHist);
            if (brScore >= BOARD_SCORE_THRESHOLD) {
              const entryResult = tryEnterPosition(
                side, symbol, close, candleTime, date,
                `${roundPb.reason} (タイムアウト)`,
                buffer, bpr, bprHist, openPositions, lastStopLossTime
              );
              if (entryResult) openPositions.set(symbol, entryResult);
            }
          }
          roundPullbackStates.delete(symbol);
          continue;
        }
        
        if (!roundPb.pulledBack) {
          if (roundPb.direction === "buy" && close < roundPb.signalPrice) roundPb.pulledBack = true;
          if (roundPb.direction === "sell" && close > roundPb.signalPrice) roundPb.pulledBack = true;
        }
        
        if (roundPb.pulledBack) {
          const recovered = roundPb.direction === "buy"
            ? close > roundPb.signalPrice
            : close < roundPb.signalPrice;
          if (recovered) {
            const side = roundPb.direction === "buy" ? "long" : "short";
            const oppSignal = side === "long" ? "sell_pressure" : "buy_pressure";
            if (boardSignal !== oppSignal) {
              const brScore = boardReadingScore(side, boardSnap, bprHist);
              if (brScore >= BOARD_SCORE_THRESHOLD) {
                const entryResult = tryEnterPosition(
                  side, symbol, close, candleTime, date,
                  `${roundPb.reason} (押し目確認後)`,
                  buffer, bpr, bprHist, openPositions, lastStopLossTime
                );
                if (entryResult) openPositions.set(symbol, entryResult);
              }
            }
            roundPullbackStates.delete(symbol);
            continue;
          }
        }
        continue;
      }
      
      // ---- 既にポジションあり → スキップ ----
      if (openPositions.has(symbol)) continue;
      
      // ---- シグナル検出 ----
      const withSignals = detectSignals(buffer);
      const latestSignal = withSignals[withSignals.length - 1];
      buffer[buffer.length - 1] = latestSignal;
      
      if (!latestSignal.signal) continue;
      const sig = latestSignal.signal;
      
      // ---- 買いエントリー ----
      if (sig.type === "buy") {
        // VWAPクロス上抜け無効化
        if (sig.reason.includes("VWAPクロス上抜け")) continue;
        // sell_pressure時LONG禁止
        if (boardSignal === "sell_pressure") continue;
        // 板読みスコア
        const brScore = boardReadingScore("long", boardSnap, bprHist);
        if (brScore < BOARD_SCORE_THRESHOLD) continue;
        
        // ダウ理論上昇 → 押し目確認ステートマシンへ
        if (sig.reason.startsWith("ダウ理論: 直近高値更新") && sig.recentSwingLow != null) {
          const htfTrend = getHigherTfTrend(buffer, buffer.length - 1);
          if (htfTrend !== "up") continue;
          // 押し目深さフィルター
          if (buffer.length >= PULLBACK_DEPTH_LOOKBACK) {
            const window = buffer.slice(buffer.length - PULLBACK_DEPTH_LOOKBACK);
            const swingHigh = Math.max(...window.map(c => c.high));
            const swingLow = Math.min(...window.map(c => c.low));
            if (swingHigh > swingLow) {
              const depth = (swingHigh - close) / (swingHigh - swingLow);
              if (depth < PULLBACK_DEPTH_MIN || depth > PULLBACK_DEPTH_MAX) continue;
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
        
        // 大台超え → 確認バーステートマシンへ
        if (sig.reason.startsWith("大台超え")) {
          const m = sig.reason.match(/(\d+(?:\.\d+)?)円/);
          const level = m ? parseFloat(m[1]) : close;
          roundLevelPendingStates.set(symbol, {
            direction: "buy", level, confirmCount: 0, reason: sig.reason,
          });
          continue;
        }
        
        // ★6/26版: BUY medium全ブロック（ステートマシントリガー以外）
        if (sig.confidence === "medium") continue;
        
        // strong直接エントリー
        const entryResult = tryEnterPosition(
          "long", symbol, close, candleTime, date, sig.reason,
          buffer, bpr, bprHist, openPositions, lastStopLossTime
        );
        if (entryResult) openPositions.set(symbol, entryResult);
        continue;
      }
      
      // ---- 売りエントリー ----
      if (sig.type === "sell") {
        // ★6/26版: isBullish方式 → BULLISH相場ではSHORT全面禁止
        if (isBullish) continue;
        // buy_pressure時SHORT禁止
        if (boardSignal === "buy_pressure") continue;
        
        // ★6/26版: VWAP急落フィルターなし
        
        // 板読みスコア
        const brScore = boardReadingScore("short", boardSnap, bprHist);
        if (brScore < BOARD_SCORE_THRESHOLD) continue;
        
        // ダウ理論SHORT: 5分足フィルター + 押し目深さフィルター
        if (sig.reason.startsWith("ダウ理論: 直近安値更新")) {
          const htfTrend = getHigherTfTrend(buffer, buffer.length - 1);
          if (htfTrend !== "down") continue;
          if (buffer.length >= PULLBACK_DEPTH_LOOKBACK) {
            const window = buffer.slice(buffer.length - PULLBACK_DEPTH_LOOKBACK);
            const swingHigh = Math.max(...window.map(c => c.high));
            const swingLow = Math.min(...window.map(c => c.low));
            if (swingHigh > swingLow) {
              const depth = (close - swingLow) / (swingHigh - swingLow);
              if (depth < PULLBACK_DEPTH_MIN || depth > PULLBACK_DEPTH_MAX) continue;
            }
          }
        }
        
        // 大台割れ → 確認バーステートマシンへ
        if (sig.reason.startsWith("大台割れ")) {
          const m = sig.reason.match(/(\d+(?:\.\d+)?)円/);
          const level = m ? parseFloat(m[1]) : close;
          roundLevelPendingStates.set(symbol, {
            direction: "sell", level, confirmCount: 0, reason: sig.reason,
          });
          continue;
        }
        
        // ★6/26版: SHORT medium全ブロック
        if (sig.confidence === "medium") continue;
        
        // ★6/26版: 後場BPRフィルターなし
        
        // エントリー
        const entryResult = tryEnterPosition(
          "short", symbol, close, candleTime, date, sig.reason,
          buffer, bpr, bprHist, openPositions, lastStopLossTime
        );
        if (entryResult) openPositions.set(symbol, entryResult);
        continue;
      }
    }
    
    // ---- 日末: 残ポジション強制決済 ----
    for (const [symbol, pos] of Array.from(openPositions.entries())) {
      const lastCandle = candleBuffers.get(symbol);
      if (!lastCandle || lastCandle.length === 0) continue;
      const lastClose = lastCandle[lastCandle.length - 1].close;
      const pnl = pos.side === "long"
        ? Math.round((lastClose - pos.entryPrice) * pos.shares)
        : Math.round((pos.entryPrice - lastClose) * pos.shares);
      allTrades.push({
        date, symbol, side: pos.side,
        entryTime: pos.entryTime, entryPrice: pos.entryPrice,
        exitTime: "15:30", exitPrice: lastClose,
        pnl, exitReason: "EOD",
        signalReason: pos.entryReason, confidence: pos.confidence,
        session: timeToMinutes(pos.entryTime) < 12 * 60 + 30 ? "am" : "pm",
        shares: pos.shares,
      });
    }
    
    // 日別サマリー出力
    const dayTrades = allTrades.filter(t => t.date === date);
    const dayPnl = dayTrades.reduce((s, t) => s + t.pnl, 0);
    const dayWins = dayTrades.filter(t => t.pnl > 0).length;
    console.log(`${date} | 取引${dayTrades.length.toString().padStart(3)}件 | ` +
      `勝率${dayTrades.length > 0 ? ((dayWins / dayTrades.length) * 100).toFixed(1) : "0.0"}% | ` +
      `損益${dayPnl >= 0 ? "+" : ""}${dayPnl.toLocaleString()}円`);
  }
  
  // ============================================================
  // 集計
  // ============================================================
  console.log("\n" + "=".repeat(80));
  console.log("=== 6/26版エンジン 総合パフォーマンス ===\n");
  
  const totalPnl = allTrades.reduce((s, t) => s + t.pnl, 0);
  const wins = allTrades.filter(t => t.pnl > 0);
  const losses = allTrades.filter(t => t.pnl < 0);
  const draws = allTrades.filter(t => t.pnl === 0);
  const winRate = allTrades.length > 0 ? (wins.length / allTrades.length * 100).toFixed(1) : "0.0";
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf = grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : "∞";
  const avgWin = wins.length > 0 ? Math.round(grossProfit / wins.length) : 0;
  const avgLoss = losses.length > 0 ? Math.round(grossLoss / losses.length) : 0;
  const expectancy = allTrades.length > 0 ? Math.round(totalPnl / allTrades.length) : 0;
  
  console.log(`取引数: ${allTrades.length}件 (${wins.length}勝${losses.length}敗${draws.length}引分)`);
  console.log(`勝率: ${winRate}%`);
  console.log(`総損益: ${totalPnl >= 0 ? "+" : ""}${totalPnl.toLocaleString()}円`);
  console.log(`PF: ${pf}`);
  console.log(`期待値: ${expectancy >= 0 ? "+" : ""}${expectancy.toLocaleString()}円/回`);
  console.log(`平均利益: +${avgWin.toLocaleString()}円 | 平均損失: -${avgLoss.toLocaleString()}円`);
  console.log(`1日平均: ${(totalPnl / dates.length >= 0 ? "+" : "")}${Math.round(totalPnl / dates.length).toLocaleString()}円`);
  
  // LONG/SHORT別
  console.log("\n--- LONG/SHORT別 ---");
  const longs = allTrades.filter(t => t.side === "long");
  const shorts = allTrades.filter(t => t.side === "short");
  const longPnl = longs.reduce((s, t) => s + t.pnl, 0);
  const shortPnl = shorts.reduce((s, t) => s + t.pnl, 0);
  const longWins = longs.filter(t => t.pnl > 0).length;
  const shortWins = shorts.filter(t => t.pnl > 0).length;
  console.log(`LONG:  ${longs.length}件 | ${longPnl >= 0 ? "+" : ""}${longPnl.toLocaleString()}円 | 勝率${longs.length > 0 ? (longWins / longs.length * 100).toFixed(1) : "0.0"}%`);
  console.log(`SHORT: ${shorts.length}件 | ${shortPnl >= 0 ? "+" : ""}${shortPnl.toLocaleString()}円 | 勝率${shorts.length > 0 ? (shortWins / shorts.length * 100).toFixed(1) : "0.0"}%`);
  
  // 前場/後場別
  console.log("\n--- 前場/後場別 ---");
  const amTrades = allTrades.filter(t => t.session === "am");
  const pmTrades = allTrades.filter(t => t.session === "pm");
  const amPnl = amTrades.reduce((s, t) => s + t.pnl, 0);
  const pmPnl = pmTrades.reduce((s, t) => s + t.pnl, 0);
  console.log(`前場: ${amTrades.length}件 | ${amPnl >= 0 ? "+" : ""}${amPnl.toLocaleString()}円 | 勝率${amTrades.length > 0 ? (amTrades.filter(t => t.pnl > 0).length / amTrades.length * 100).toFixed(1) : "0.0"}%`);
  console.log(`後場: ${pmTrades.length}件 | ${pmPnl >= 0 ? "+" : ""}${pmPnl.toLocaleString()}円 | 勝率${pmTrades.length > 0 ? (pmTrades.filter(t => t.pnl > 0).length / pmTrades.length * 100).toFixed(1) : "0.0"}%`);
  
  // 決済理由別
  console.log("\n--- 決済理由別 ---");
  const reasons = ["SL", "TP", "BE", "REVERSAL", "BOARD_EXIT", "EOD"];
  for (const r of reasons) {
    const rTrades = allTrades.filter(t => t.exitReason === r);
    if (rTrades.length === 0) continue;
    const rPnl = rTrades.reduce((s, t) => s + t.pnl, 0);
    console.log(`${r.padEnd(12)}: ${rTrades.length.toString().padStart(3)}件 | ${rPnl >= 0 ? "+" : ""}${rPnl.toLocaleString()}円`);
  }
  
  // 銘柄別
  console.log("\n--- 銘柄別パフォーマンス ---");
  const symbolStats = new Map<string, { trades: number; pnl: number; wins: number }>();
  for (const t of allTrades) {
    const s = symbolStats.get(t.symbol) ?? { trades: 0, pnl: 0, wins: 0 };
    s.trades++;
    s.pnl += t.pnl;
    if (t.pnl > 0) s.wins++;
    symbolStats.set(t.symbol, s);
  }
  const sorted = Array.from(symbolStats.entries()).sort((a, b) => b[1].pnl - a[1].pnl);
  for (const [sym, s] of sorted) {
    console.log(`${getStockName(sym).padEnd(16)} | ${s.trades.toString().padStart(3)}件 | ${s.pnl >= 0 ? "+" : ""}${s.pnl.toLocaleString().padStart(10)}円 | 勝率${(s.wins / s.trades * 100).toFixed(1)}%`);
  }
  
  // 日別累計
  console.log("\n--- 日別累計推移 ---");
  let cumPnl = 0;
  for (const date of dates) {
    const dayTrades = allTrades.filter(t => t.date === date);
    const dayPnl = dayTrades.reduce((s, t) => s + t.pnl, 0);
    cumPnl += dayPnl;
    console.log(`${date} | ${dayTrades.length.toString().padStart(3)}件 | 日次${dayPnl >= 0 ? "+" : ""}${dayPnl.toLocaleString().padStart(10)}円 | 累計${cumPnl >= 0 ? "+" : ""}${cumPnl.toLocaleString().padStart(10)}円`);
  }
  
  process.exit(0);
}

// ============================================================
// enterPosition相当（フィルター適用）- 6/26版: 後場BPRフィルターなし
// ============================================================
function tryEnterPosition(
  side: "long" | "short",
  symbol: string,
  price: number,
  candleTime: string,
  date: string,
  reason: string,
  buffer: CandleWithSignal[],
  bpr: number | null,
  bprHist: number[],
  openPositions: Map<string, OpenPosition>,
  lastStopLossTime: Map<string, string>,
): OpenPosition | null {
  const shares = calcShares(price);
  const amount = price * shares;
  
  // 出来高取得不可フィルター
  const isVolumeUnavailable = checkVolumeUnavailable(buffer);
  if (isVolumeUnavailable) {
    if (candleTime >= "12:00" && candleTime <= "12:59") return null;
    const lastSL = lastStopLossTime.get(symbol);
    if (lastSL) {
      const minSinceStop = timeToMinutes(candleTime) - timeToMinutes(lastSL);
      if (minSinceStop >= 0 && minSinceStop < NO_REENTRY_AFTER_STOPLOSS_MIN) return null;
    }
  }
  
  // ATRフィルター
  if (buffer.length >= ATR_FILTER_PERIOD + 1) {
    const highs = buffer.map(c => c.high);
    const lows = buffer.map(c => c.low);
    const closes = buffer.map(c => c.close);
    const atrSeries = calcATR(highs, lows, closes, ATR_FILTER_PERIOD);
    const latestATR = atrSeries[atrSeries.length - 1];
    if (latestATR !== null && price > 0) {
      const atrRatio = (latestATR as number) / price;
      if (atrRatio < ATR_FILTER_THRESHOLD) return null;
    }
  }
  
  // ★6/26版: 後場BPRフィルターなし
  
  // エクスポージャー制限
  let currentExposure = 0;
  for (const pos of Array.from(openPositions.values())) {
    currentExposure += pos.entryPrice * pos.shares;
  }
  if (currentExposure + amount > MAX_TOTAL_EXPOSURE) return null;
  
  // 信頼度計算
  let confidence: SignalConfidence = "medium";
  if (buffer.length > 1) {
    const volumes = buffer.map(c => c.volume);
    const closes = buffer.map(c => c.close);
    const idx = buffer.length - 1;
    const ma5Val = buffer[idx]?.ma5 ?? null;
    const ma25Val = buffer[idx]?.ma25 ?? null;
    const confResult = evaluateConfirmation({
      type: side === "long" ? "buy" : "sell",
      close: price,
      volume: buffer[idx].volume,
      avgVolume: trailingAvgVolume(volumes, idx, 10),
      ma5: ma5Val,
      ma25: ma25Val,
      momentum: priceMomentum(closes, idx, 3),
    });
    confidence = confResult.confidence;
  }
  
  return {
    symbol, side, entryPrice: price, shares,
    entryTime: candleTime, entryReason: reason,
    confidence,
  };
}

main();
