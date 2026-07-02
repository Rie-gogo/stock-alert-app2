/**
 * sim_faithful_10days.ts
 *
 * 本番エンジン（realtimeSimEngine.ts）に完全準拠したバックテスト。
 * 
 * 本番との一致点:
 * - 全銘柄を時系列順にインターリーブ処理（銘柄別独立ではない）
 * - 1銘柄1ポジション制限（openPositions Map）
 * - MAX_TOTAL_EXPOSURE制限（891万円）
 * - ステートマシン3種（pullbackStates, roundLevelPendingStates, roundPullbackStates）
 * - 板読みスコア（BPR履歴ベースの簡易再現）
 * - 板読み早期利確（shouldBoardEarlyExit）
 * - シグナル反転決済
 * - sell_pressure/buy_pressureブロック
 * - ATRフィルター（7期間, 0.12%閾値）
 * - 出来高取得不可フィルター（90%以上volume=0）
 * - 5分足上位足フィルター（ダウ理論のみ）
 * - 押し目深さフィルター（30-70%範囲）
 * - VWAPクロス上抜け無効化
 * - VWAP急落フィルター
 * - BUY medium全ブロック
 * - SHORT medium: B2方式（前場bullish時のみブロック）
 * - 後場BPRフィルター（13:00以降SHORT, BPR>=0.65ブロック）
 * - 時間帯制限（09:30前禁止, 11:00-11:30禁止, 11:30-12:30スキップ, 12:30-13:00禁止, 15:15以降禁止）
 * - 大引け強制決済（15:30）
 * - BE/SL/TP（0.5%/0.5%/1.5%）
 * - 損切り後30分再エントリー禁止（出来高不可時のみ）
 */

import { getDb } from "../server/db";
import { detectSignals, calcMA, calcRSI, calcBollinger, type CandleWithSignal } from "../server/routers/stockData";
import { evaluateConfirmation, trailingAvgVolume, priceMomentum, type SignalConfidence } from "../server/signalConfirmation";
import { calcATR } from "../server/intradayRegime";
import { TARGET_STOCKS, getStockName } from "../shared/stocks";

// ============================================================
// 定数（本番と完全一致）
// ============================================================
const INITIAL_CAPITAL_PER_STOCK = 3_000_000;
const LOT_RATIO = 0.9;
const STOP_LOSS_PERCENT = 0.5;
const TAKE_PROFIT_PERCENT = 1.5;
const BE_TRIGGER_PERCENT = 0.5;
const PM_BPR_BLOCK_THRESHOLD = 0.65;
const PM_BPR_FILTER_START = "13:00";
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
const VWAP_DROP_FILTER_5BARS = -0.8;
const VWAP_DROP_FILTER_3BARS = -0.6;
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
const B2_THRESHOLD = 0.2;

const TEN_SYMBOLS = TARGET_STOCKS.map(s => s.symbol);

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
  beTriggered: boolean;
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
  beTriggered: boolean; session: "am" | "pm"; shares: number;
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

/** 5分足上位足トレンド判定（本番getHigherTfTrendの再現） */
function getHigherTfTrend(buffer: CandleWithSignal[], currentIdx: number): "up" | "down" | "neutral" {
  const candlesSoFar = buffer.slice(0, currentIdx + 1);
  // 5分足に合成
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
  // MA5
  const fast5 = closes.slice(closes.length - 5).reduce((s, v) => s + v, 0) / 5;
  // MA25
  const slow25 = closes.slice(closes.length - 25).reduce((s, v) => s + v, 0) / 25;
  
  if (fast5 > slow25) return "up";
  if (fast5 < slow25) return "down";
  return "neutral";
}

/** 板読みスコア完全版（7要素）— DBのboardSnapshotを直接使用 */
function boardReadingScore(
  side: "long" | "short",
  snapshot: any | null,
  bprHistory: number[]
): number {
  if (!snapshot) return 1; // 板情報なし → 中立（シグナルを通す）
  
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

/** 板シグナル判定（DBのsnapshot.signalを直接使用） */
function getBoardSignal(snapshot: any | null): "buy_pressure" | "sell_pressure" | "neutral" {
  if (!snapshot) return "neutral";
  const sig = snapshot.signal;
  if (sig === "buy_pressure" || sig === "large_buy_wall") return "buy_pressure";
  if (sig === "sell_pressure" || sig === "large_sell_wall") return "sell_pressure";
  return "neutral";
}

/** 板読み早期利確チェック（本番準拠: snapshot.signalを使用） */
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
     WHERE tradeDate >= '2026-06-19' AND tradeDate <= '2026-07-02'
     ORDER BY tradeDate`
  ) as any;
  const dates = (dateRows as any[]).map((r: any) => r.tradeDate);
  console.log(`=== 本番準拠シミュレーション（${dates.length}日間: ${dates[0]}〜${dates[dates.length - 1]}） ===\n`);
  
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
    let b2Direction: "bullish" | "bearish" | "neutral" = "neutral";
    let b2Determined = false;
    
    // ---- 全銘柄の1分足を時系列順に取得 ----
    const [candles] = await db.execute(
      `SELECT symbol, tradeDate, candleTime, open, high, low, close, volume, boardSnapshot
       FROM rt_candles
       WHERE tradeDate = '${date}'
       ORDER BY candleTime, symbol`
    ) as any;
    
    if (candles.length === 0) continue;
    
    // processCandle呼び出しカウンター（09:30以降の足のみカウント）
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
      
      // 対象銘柄チェック
      if (!TEN_SYMBOLS.includes(symbol)) continue;
      
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
      
      // 09:30以前の足はバッファ蓄積のみ（本番のrestoreBuffersFromDb相当）
      if (candleTime < "09:30") continue;
      
      // processCandle呼び出しカウント（09:30以降からカウント開始）
      const pcCount = (processCandleCount.get(symbol) ?? 0) + 1;
      processCandleCount.set(symbol, pcCount);
      
      // ウォームアップチェック: processCandle 30回呼ばれるまでシグナル検出しない
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
        let exitAction = "";
        
        // BEトリガー
        if (!existingPos.beTriggered) {
          const beLine = existingPos.side === "long"
            ? existingPos.entryPrice * (1 + BE_TRIGGER_PERCENT / 100)
            : existingPos.entryPrice * (1 - BE_TRIGGER_PERCENT / 100);
          const beHit = existingPos.side === "long" ? high >= beLine : low <= beLine;
          if (beHit) existingPos.beTriggered = true;
        }
        
        // SL/BE決済
        if (existingPos.side === "long") {
          const stopLine = existingPos.beTriggered ? existingPos.entryPrice : existingPos.entryPrice * (1 - STOP_LOSS_PERCENT / 100);
          if (low <= stopLine) {
            exitPrice = stopLine;
            exitReason = existingPos.beTriggered ? "BE" : "SL";
            exitAction = existingPos.beTriggered ? "exit" : "stop_loss";
          }
          // TP
          const tpLine = existingPos.entryPrice * (1 + TAKE_PROFIT_PERCENT / 100);
          if (high >= tpLine && exitPrice === null) {
            exitPrice = tpLine;
            exitReason = "TP";
            exitAction = "take_profit";
          }
        } else {
          const stopLine = existingPos.beTriggered ? existingPos.entryPrice : existingPos.entryPrice * (1 + STOP_LOSS_PERCENT / 100);
          if (high >= stopLine) {
            exitPrice = stopLine;
            exitReason = existingPos.beTriggered ? "BE" : "SL";
            exitAction = existingPos.beTriggered ? "exit" : "stop_loss";
          }
          // TP
          const tpLine = existingPos.entryPrice * (1 - TAKE_PROFIT_PERCENT / 100);
          if (low <= tpLine && exitPrice === null) {
            exitPrice = tpLine;
            exitReason = "TP";
            exitAction = "take_profit";
          }
        }
        
        // シグナル反転決済（本番準拠: 前の足のシグナルを参照）
        // 本番では buffer[buffer.length - 1].signal は前回processCandle時に検出されたもの
        // シミュでは前の足（buffer.length - 2）のシグナルを使う
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
            pnl, exitReason,
            signalReason: existingPos.entryReason,
            confidence: existingPos.confidence,
            beTriggered: existingPos.beTriggered,
            session: timeToMinutes(existingPos.entryTime) < 12 * 60 + 30 ? "am" : "pm",
            shares: existingPos.shares,
          });
          
          openPositions.delete(symbol);
          if (exitReason === "SL") lastStopLossTime.set(symbol, candleTime);
          continue; // 決済した足ではエントリーしない
        }
        
        // ポジションあり → 新規エントリーしない
        continue;
      }
      
      // ---- 大引け強制決済チェック（ポジションなしの場合はスキップ） ----
      
      // ---- 時間帯制限 ----
      if (candleTime < NO_ENTRY_BEFORE) continue;
      if (candleTime >= NO_ENTRY_AFTER) continue;
      if (candleTime >= NO_ENTRY_PRE_LUNCH_START && candleTime < NO_ENTRY_PRE_LUNCH_END) continue;
      if (candleTime >= NO_ENTRY_POST_LUNCH_START && candleTime < NO_ENTRY_POST_LUNCH_END) continue;
      
      // ---- B2方式: 9:30時点の市場方向性判定 ----
      if (!b2Determined && candleTime >= "09:30") {
        let totalChange = 0, count = 0;
        for (const [sym, buf] of Array.from(candleBuffers.entries())) {
          if (buf.length >= 2) {
            const firstC = buf[0];
            const latestC = buf[buf.length - 1];
            const changeRate = (latestC.close - firstC.open) / firstC.open * 100;
            totalChange += changeRate;
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
      
      // ---- ステートマシン処理: 押し目確認（ダウ理論上昇） ----
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
          // sell_pressure時LONG禁止
          if (boardSignal === "sell_pressure") continue;
          // 板読みスコア
          const brScore = boardReadingScore("long", boardSnap, bprHist);
          if (brScore < BOARD_SCORE_THRESHOLD) continue;
          // エントリー実行（後述のenterPositionロジックへ）
          const entryResult = tryEnterPosition(
            "long", symbol, close, candleTime, date,
            `押し目確認: ${pullbackState.reason}`,
            buffer, bpr, bprHist, openPositions, lastStopLossTime
          );
          if (entryResult) {
            openPositions.set(symbol, entryResult);
          }
          continue;
        }
        continue; // 待機中
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
          continue;
        }
      }
      
      // ---- ステートマシン処理: 大台確認後の押し目待ち ----
      const roundPb = roundPullbackStates.get(symbol);
      if (roundPb) {
        roundPb.waitCount++;
        const side: "long" | "short" = roundPb.direction === "buy" ? "long" : "short";
        
        // キリ番割れチェック
        if (roundPb.direction === "buy" && close < roundPb.level) {
          roundPullbackStates.delete(symbol);
          continue;
        }
        if (roundPb.direction === "sell" && close > roundPb.level) {
          roundPullbackStates.delete(symbol);
          continue;
        }
        
        // タイムアウト → 強トレンドエントリー
        if (roundPb.waitCount > ROUND_PULLBACK_MAX_WAIT) {
          roundPullbackStates.delete(symbol);
          if (side === "long" && boardSignal === "sell_pressure") continue;
          if (side === "short" && boardSignal === "buy_pressure") continue;
          const brScore = boardReadingScore(side, boardSnap, bprHist);
          if (brScore < BOARD_SCORE_THRESHOLD) continue;
          const entryResult = tryEnterPosition(
            side, symbol, close, candleTime, date,
            `${roundPb.reason} (押し目なし・強トレンド)`,
            buffer, bpr, bprHist, openPositions, lastStopLossTime
          );
          if (entryResult) openPositions.set(symbol, entryResult);
          continue;
        }
        
        // 押し目判定
        if (roundPb.direction === "buy") {
          if (!roundPb.pulledBack && close < roundPb.signalPrice) roundPb.pulledBack = true;
          if (roundPb.pulledBack && close > roundPb.signalPrice) {
            roundPullbackStates.delete(symbol);
            if (boardSignal === "sell_pressure") continue;
            const brScore = boardReadingScore("long", boardSnap, bprHist);
            if (brScore < BOARD_SCORE_THRESHOLD) continue;
            const entryResult = tryEnterPosition(
              "long", symbol, close, candleTime, date,
              `${roundPb.reason} (押し目確認後)`,
              buffer, bpr, bprHist, openPositions, lastStopLossTime
            );
            if (entryResult) openPositions.set(symbol, entryResult);
            continue;
          }
        } else {
          if (!roundPb.pulledBack && close > roundPb.signalPrice) roundPb.pulledBack = true;
          if (roundPb.pulledBack && close < roundPb.signalPrice) {
            roundPullbackStates.delete(symbol);
            if (boardSignal === "buy_pressure") continue;
            const brScore = boardReadingScore("short", boardSnap, bprHist);
            if (brScore < BOARD_SCORE_THRESHOLD) continue;
            const entryResult = tryEnterPosition(
              "short", symbol, close, candleTime, date,
              `${roundPb.reason} (押し目確認後)`,
              buffer, bpr, bprHist, openPositions, lastStopLossTime
            );
            if (entryResult) openPositions.set(symbol, entryResult);
            continue;
          }
        }
        continue; // 待機中
      }
      
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
          // 5分足上位足フィルター
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
        
        // BUY medium全ブロック
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
        // buy_pressure時SHORT禁止
        if (boardSignal === "buy_pressure") continue;
        
        // VWAP急落フィルター
        if (sig.reason.includes("VWAPクロス下抜け") && buffer.length >= 5) {
          const len = buffer.length;
          const close5ago = buffer[len - 5].close;
          const close3ago = buffer[len - 3].close;
          const drop5 = ((close - close5ago) / close5ago) * 100;
          const drop3 = ((close - close3ago) / close3ago) * 100;
          if (drop5 <= VWAP_DROP_FILTER_5BARS || drop3 <= VWAP_DROP_FILTER_3BARS) continue;
        }
        
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
        
        // SHORT medium: B2方式
        if (sig.confidence === "medium") {
          if (isAM && b2Direction === "bullish") continue;
          // それ以外は許可
        }
        
        // 後場BPRフィルター
        if (candleTime >= PM_BPR_FILTER_START && bpr !== null && bpr >= PM_BPR_BLOCK_THRESHOLD) continue;
        
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
        beTriggered: pos.beTriggered,
        session: timeToMinutes(pos.entryTime) < 12 * 60 + 30 ? "am" : "pm",
        shares: pos.shares,
      });
    }
    
    // 日別サマリー出力
    const dayTrades = allTrades.filter(t => t.date === date);
    const dayPnl = dayTrades.reduce((s, t) => s + t.pnl, 0);
    const dayWins = dayTrades.filter(t => t.pnl > 0).length;
    console.log(`${date} | B2=${b2Direction.padEnd(7)} | 取引${dayTrades.length.toString().padStart(3)}件 | ` +
      `勝率${dayTrades.length > 0 ? ((dayWins / dayTrades.length) * 100).toFixed(1) : "0.0"}% | ` +
      `損益${dayPnl >= 0 ? "+" : ""}${dayPnl.toLocaleString()}円`);
  }
  
  // ============================================================
  // 集計
  // ============================================================
  console.log("\n" + "=".repeat(80));
  console.log("=== 総合パフォーマンス ===\n");
  
  const totalPnl = allTrades.reduce((s, t) => s + t.pnl, 0);
  const wins = allTrades.filter(t => t.pnl > 0);
  const losses = allTrades.filter(t => t.pnl < 0);
  const bes = allTrades.filter(t => t.pnl === 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf = grossLoss > 0 ? grossProfit / grossLoss : Infinity;
  
  console.log(`取引数: ${allTrades.length}件 (1日平均: ${(allTrades.length / dates.length).toFixed(1)}件)`);
  console.log(`勝率: ${((wins.length / allTrades.length) * 100).toFixed(1)}% (${wins.length}勝${losses.length}敗${bes.length}引分)`);
  console.log(`総損益: ${totalPnl >= 0 ? "+" : ""}${totalPnl.toLocaleString()}円`);
  console.log(`1日平均: ${(totalPnl / dates.length) >= 0 ? "+" : ""}${Math.round(totalPnl / dates.length).toLocaleString()}円`);
  console.log(`PF: ${pf.toFixed(2)}`);
  console.log(`期待値: ${(totalPnl / allTrades.length) >= 0 ? "+" : ""}${Math.round(totalPnl / allTrades.length).toLocaleString()}円/回`);
  console.log(`平均利益: +${Math.round(grossProfit / wins.length).toLocaleString()}円`);
  console.log(`平均損失: -${Math.round(grossLoss / losses.length).toLocaleString()}円`);
  
  // LONG/SHORT別
  console.log("\n--- LONG/SHORT別 ---");
  const longs = allTrades.filter(t => t.side === "long");
  const shorts = allTrades.filter(t => t.side === "short");
  const longPnl = longs.reduce((s, t) => s + t.pnl, 0);
  const shortPnl = shorts.reduce((s, t) => s + t.pnl, 0);
  const longWins = longs.filter(t => t.pnl > 0).length;
  const shortWins = shorts.filter(t => t.pnl > 0).length;
  console.log(`LONG:  ${longs.length}件 | ${longPnl >= 0 ? "+" : ""}${longPnl.toLocaleString()}円 | 勝率${longs.length > 0 ? ((longWins / longs.length) * 100).toFixed(1) : "0"}%`);
  console.log(`SHORT: ${shorts.length}件 | ${shortPnl >= 0 ? "+" : ""}${shortPnl.toLocaleString()}円 | 勝率${shorts.length > 0 ? ((shortWins / shorts.length) * 100).toFixed(1) : "0"}%`);
  
  // 前場/後場別
  console.log("\n--- 前場/後場別 ---");
  const amTrades = allTrades.filter(t => t.session === "am");
  const pmTrades = allTrades.filter(t => t.session === "pm");
  const amPnl = amTrades.reduce((s, t) => s + t.pnl, 0);
  const pmPnl = pmTrades.reduce((s, t) => s + t.pnl, 0);
  console.log(`前場: ${amTrades.length}件 | ${amPnl >= 0 ? "+" : ""}${amPnl.toLocaleString()}円 | 勝率${amTrades.length > 0 ? ((amTrades.filter(t => t.pnl > 0).length / amTrades.length) * 100).toFixed(1) : "0"}%`);
  console.log(`後場: ${pmTrades.length}件 | ${pmPnl >= 0 ? "+" : ""}${pmPnl.toLocaleString()}円 | 勝率${pmTrades.length > 0 ? ((pmTrades.filter(t => t.pnl > 0).length / pmTrades.length) * 100).toFixed(1) : "0"}%`);
  
  // 決済理由別
  console.log("\n--- 決済理由別 ---");
  const reasons = ["SL", "BE", "TP", "REVERSAL", "BOARD_EXIT", "EOD"];
  for (const r of reasons) {
    const rTrades = allTrades.filter(t => t.exitReason === r);
    if (rTrades.length === 0) continue;
    const rPnl = rTrades.reduce((s, t) => s + t.pnl, 0);
    console.log(`${r.padEnd(12)} | ${rTrades.length.toString().padStart(3)}件 | ${rPnl >= 0 ? "+" : ""}${rPnl.toLocaleString()}円`);
  }
  
  // 銘柄別
  console.log("\n--- 銘柄別 ---");
  for (const sym of TEN_SYMBOLS) {
    const symTrades = allTrades.filter(t => t.symbol === sym);
    if (symTrades.length === 0) continue;
    const symPnl = symTrades.reduce((s, t) => s + t.pnl, 0);
    const symWins = symTrades.filter(t => t.pnl > 0).length;
    console.log(`${sym} ${getStockName(sym).padEnd(12)} | ${symTrades.length.toString().padStart(3)}件 | ` +
      `${symPnl >= 0 ? "+" : ""}${symPnl.toLocaleString().padStart(10)}円 | ` +
      `勝率${((symWins / symTrades.length) * 100).toFixed(1)}%`);
  }
  
  // 日別累計
  console.log("\n--- 日別累計 ---");
  let cumPnl = 0;
  for (const date of dates) {
    const dayTrades = allTrades.filter(t => t.date === date);
    const dayPnl = dayTrades.reduce((s, t) => s + t.pnl, 0);
    cumPnl += dayPnl;
    console.log(`${date} | ${dayTrades.length.toString().padStart(3)}件 | ${dayPnl >= 0 ? "+" : ""}${dayPnl.toLocaleString().padStart(10)}円 | 累計${cumPnl >= 0 ? "+" : ""}${cumPnl.toLocaleString()}円`);
  }
  
  // リアルタイム結果との比較
  console.log("\n--- リアルタイム結果との比較（7/2） ---");
  const jul2Trades = allTrades.filter(t => t.date === "2026-07-02");
  
  // 7/2の個別取引詳細
  console.log("\n--- 7/2 シミュレーション取引詳細 ---");
  for (const t of jul2Trades) {
    const pnlStr = (t.pnl >= 0 ? "+" : "") + t.pnl.toLocaleString() + "円";
    console.log(
      `${t.entryTime}→${t.exitTime} | ${getStockName(t.symbol).padEnd(10)} | ${t.side.padEnd(5)} | ` +
      `@${t.entryPrice}→${t.exitPrice} | ${pnlStr.padStart(12)} | ${t.exitReason} | ${t.signalReason?.substring(0, 30) || ""}`
    );
  }
  console.log(`シミュ: ${jul2Trades.length}件, ${jul2Trades.reduce((s, t) => s + t.pnl, 0).toLocaleString()}円`);
  console.log(`本番:   10件, +1,029円`);
  
  process.exit(0);
}

// ============================================================
// enterPosition相当（フィルター適用）
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
  
  // 後場BPRフィルター（SHORTのみ、enterPosition内でも再チェック）
  if (side === "short" && candleTime >= PM_BPR_FILTER_START && bpr !== null && bpr >= PM_BPR_BLOCK_THRESHOLD) {
    return null;
  }
  
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
    confidence, beTriggered: false,
  };
}

main().catch(console.error);
