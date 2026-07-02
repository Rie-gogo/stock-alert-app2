/**
 * sim_board_improvements.ts
 *
 * 板情報活用の改善提案1〜3をシミュレーション
 * 
 * 提案1: アイスバーグ解釈の反転
 *   - icebergAsk + SHORT → +2（現行: -1）
 *   - icebergBid + LONG → +2（現行: -1）
 *   - icebergAsk + LONG → -2（現行: +1）
 *   - icebergBid + SHORT → -2（現行: +1）
 *
 * 提案2: 板キャンセル検出の閾値緩和
 *   - CANCEL_DROP_RATIO: 0.7 → 0.5
 *   - (シミュでは既にDBに保存されたフラグを使うため、閾値変更の効果を
 *     largeBidWallRatio/largeAskWallRatioの閾値で代替シミュレーション)
 *   - 代替: キャンセル検出時のtrapペナルティを-2→-1に軽減
 *
 * 提案3: 大口壁検出の閾値緩和
 *   - LARGE_WALL_MULTIPLIER: 5.0 → 3.0
 *   - シミュではlargeBidWallRatio/largeAskWallRatioの閾値を5.0→3.0に変更
 *   - 壁検出時の板アノマリー効果を強化（±1 → ±2）
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
// 改善パターン設定
// ============================================================
type ProposalMode = "baseline" | "proposal1" | "proposal2" | "proposal3" | "all_combined";

interface ProposalConfig {
  /** 提案1: アイスバーグ解釈反転 */
  reverseIcebergInterpretation: boolean;
  /** 提案2: キャンセル検出ペナルティ軽減 */
  reduceCancelPenalty: boolean;
  /** 提案3: 大口壁閾値緩和 + 壁効果強化 */
  relaxWallThreshold: boolean;
}

const CONFIGS: Record<ProposalMode, ProposalConfig> = {
  baseline: { reverseIcebergInterpretation: false, reduceCancelPenalty: false, relaxWallThreshold: false },
  proposal1: { reverseIcebergInterpretation: true, reduceCancelPenalty: false, relaxWallThreshold: false },
  proposal2: { reverseIcebergInterpretation: false, reduceCancelPenalty: true, relaxWallThreshold: false },
  proposal3: { reverseIcebergInterpretation: false, reduceCancelPenalty: false, relaxWallThreshold: true },
  all_combined: { reverseIcebergInterpretation: true, reduceCancelPenalty: true, relaxWallThreshold: true },
};

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

/** 板読みスコア（改善提案に応じて変更） */
function boardReadingScore(
  side: "long" | "short",
  snapshot: any | null,
  bprHistory: number[],
  config: ProposalConfig
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
  
  // 要素B: 厚い板のアノマリー (±1 or ±2)
  const wallScore = config.relaxWallThreshold ? 2 : 1;
  const WALL_THRESHOLD = config.relaxWallThreshold ? 3.0 : 5.0;
  
  // 提案3: 閾値緩和版 - largeBidWallRatio/largeAskWallRatioを直接使用
  if (config.relaxWallThreshold) {
    const hasLargeSellWall = (snapshot.largeAskWallRatio ?? 0) >= WALL_THRESHOLD;
    const hasLargeBuyWall = (snapshot.largeBidWallRatio ?? 0) >= WALL_THRESHOLD;
    if (side === "long") {
      if (hasLargeSellWall) score += wallScore;
      if (hasLargeBuyWall) score -= wallScore;
    } else {
      if (hasLargeBuyWall) score += wallScore;
      if (hasLargeSellWall) score -= wallScore;
    }
  } else {
    // 現行: boolean フラグを使用
    if (side === "long") {
      if (snapshot.largeSellWall) score += wallScore;
      if (snapshot.largeBuyWall) score -= wallScore;
    } else {
      if (snapshot.largeBuyWall) score += wallScore;
      if (snapshot.largeSellWall) score -= wallScore;
    }
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
  
  // 要素D: 相場モード判定 (+1/-2 or +1/-1)
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
  
  if (mode === "active" || mode === "building") {
    score += 1;
  } else if (mode === "trap" || mode === "quiet") {
    // 提案2: キャンセルペナルティ軽減 (-2 → -1)
    const penalty = config.reduceCancelPenalty ? -1 : -2;
    score += penalty;
  }
  
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
  
  // 要素G: アイスバーグ検出
  if (config.reverseIcebergInterpretation) {
    // 提案1: 解釈反転（±2に強化）
    // icebergAsk = 売り板が食われている → 大口が売り板を補充 = 大口は売りたい → SHORTに有利
    // icebergBid = 買い板が食われている → 大口が買い板を補充 = 大口は買いたい → LONGに有利
    if (snapshot.icebergAskDetected) {
      if (side === "short") score += 2;  // 大口が売り板を補充 → SHORT有利
      else score -= 2;                    // LONG不利
    }
    if (snapshot.icebergBidDetected) {
      if (side === "long") score += 2;   // 大口が買い板を補充 → LONG有利
      else score -= 2;                    // SHORT不利
    }
  } else {
    // 現行ロジック (±1)
    let icebergSide: "buy" | "sell" | null = null;
    if (snapshot.icebergAskDetected) icebergSide = "buy";
    if (snapshot.icebergBidDetected) icebergSide = "sell";
    if (icebergSide) {
      if (side === "long" && icebergSide === "buy") score += 1;
      else if (side === "short" && icebergSide === "sell") score += 1;
      else if (side === "long" && icebergSide === "sell") score -= 1;
      else if (side === "short" && icebergSide === "buy") score -= 1;
    }
  }
  
  return score;
}

function getBoardSignal(snapshot: any | null): "buy_pressure" | "sell_pressure" | "neutral" {
  if (!snapshot) return "neutral";
  const sig = snapshot.signal;
  if (sig === "buy_pressure" || sig === "large_buy_wall") return "buy_pressure";
  if (sig === "sell_pressure" || sig === "large_sell_wall") return "sell_pressure";
  return "neutral";
}

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
// シミュレーション実行
// ============================================================
async function runSimulation(mode: ProposalMode, db: any, dates: string[]): Promise<Trade[]> {
  const config = CONFIGS[mode];
  const allTrades: Trade[] = [];
  
  for (const date of dates) {
    const openPositions = new Map<string, OpenPosition>();
    const pullbackStates = new Map<string, PullbackState>();
    const roundLevelPendingStates = new Map<string, RoundLevelPendingState>();
    const roundPullbackStates = new Map<string, RoundPullbackState>();
    const candleBuffers = new Map<string, CandleWithSignal[]>();
    const bprHistories = new Map<string, number[]>();
    const lastStopLossTime = new Map<string, string>();
    let b2Direction: "bullish" | "bearish" | "neutral" = "neutral";
    let b2Determined = false;
    
    const [candles] = await db.execute(
      `SELECT symbol, tradeDate, candleTime, open, high, low, close, volume, boardSnapshot
       FROM rt_candles
       WHERE tradeDate = '${date}'
       ORDER BY candleTime, symbol`
    ) as any;
    
    if (candles.length === 0) continue;
    
    const processCandleCount = new Map<string, number>();
    
    for (const row of candles) {
      const symbol = row.symbol;
      const candleTime = row.candleTime;
      const open = Number(row.open);
      const high = Number(row.high);
      const low = Number(row.low);
      const close = Number(row.close);
      const volume = row.volume ?? 0;
      
      if (!TEN_SYMBOLS.includes(symbol)) continue;
      if (candleTime >= "11:30" && candleTime < "12:30") continue;
      
      let bpr: number | null = null;
      let boardSnap: any | null = null;
      if (row.boardSnapshot) {
        try {
          boardSnap = typeof row.boardSnapshot === "string" ? JSON.parse(row.boardSnapshot) : row.boardSnapshot;
          bpr = boardSnap.buyPressureRatio ?? null;
        } catch {}
      }
      
      if (bpr !== null) {
        const hist = bprHistories.get(symbol) ?? [];
        hist.push(bpr);
        if (hist.length > 5) hist.shift();
        bprHistories.set(symbol, hist);
      }
      
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
      
      if (candleTime < "09:30") continue;
      
      const pcCount = (processCandleCount.get(symbol) ?? 0) + 1;
      processCandleCount.set(symbol, pcCount);
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
        
        if (!existingPos.beTriggered) {
          const beLine = existingPos.side === "long"
            ? existingPos.entryPrice * (1 + BE_TRIGGER_PERCENT / 100)
            : existingPos.entryPrice * (1 - BE_TRIGGER_PERCENT / 100);
          const beHit = existingPos.side === "long" ? high >= beLine : low <= beLine;
          if (beHit) existingPos.beTriggered = true;
        }
        
        if (existingPos.side === "long") {
          const stopLine = existingPos.beTriggered ? existingPos.entryPrice : existingPos.entryPrice * (1 - STOP_LOSS_PERCENT / 100);
          if (low <= stopLine) { exitPrice = stopLine; exitReason = existingPos.beTriggered ? "BE" : "SL"; }
          const tpLine = existingPos.entryPrice * (1 + TAKE_PROFIT_PERCENT / 100);
          if (high >= tpLine && exitPrice === null) { exitPrice = tpLine; exitReason = "TP"; }
        } else {
          const stopLine = existingPos.beTriggered ? existingPos.entryPrice : existingPos.entryPrice * (1 + STOP_LOSS_PERCENT / 100);
          if (high >= stopLine) { exitPrice = stopLine; exitReason = existingPos.beTriggered ? "BE" : "SL"; }
          const tpLine = existingPos.entryPrice * (1 - TAKE_PROFIT_PERCENT / 100);
          if (low <= tpLine && exitPrice === null) { exitPrice = tpLine; exitReason = "TP"; }
        }
        
        if (exitPrice === null && buffer.length >= 2) {
          const prevCandle = buffer[buffer.length - 2];
          if (prevCandle.signal) {
            if (existingPos.side === "long" && prevCandle.signal.type === "sell") { exitPrice = close; exitReason = "REVERSAL"; }
            else if (existingPos.side === "short" && prevCandle.signal.type === "buy") { exitPrice = close; exitReason = "REVERSAL"; }
          }
        }
        
        if (exitPrice === null && shouldBoardEarlyExit(existingPos, close, boardSnap)) { exitPrice = close; exitReason = "BOARD_EXIT"; }
        if (exitPrice === null && candleTime >= MARKET_CLOSE_TIME) { exitPrice = close; exitReason = "EOD"; }
        
        if (exitPrice !== null) {
          const pnl = existingPos.side === "long"
            ? Math.round((exitPrice - existingPos.entryPrice) * existingPos.shares)
            : Math.round((existingPos.entryPrice - exitPrice) * existingPos.shares);
          allTrades.push({
            date, symbol, side: existingPos.side,
            entryTime: existingPos.entryTime, entryPrice: existingPos.entryPrice,
            exitTime: candleTime, exitPrice, pnl, exitReason,
            signalReason: existingPos.entryReason, confidence: existingPos.confidence,
            beTriggered: existingPos.beTriggered,
            session: timeToMinutes(existingPos.entryTime) < 12 * 60 + 30 ? "am" : "pm",
            shares: existingPos.shares,
          });
          openPositions.delete(symbol);
          if (exitReason === "SL") lastStopLossTime.set(symbol, candleTime);
          continue;
        }
        continue;
      }
      
      // ---- 時間帯制限 ----
      if (candleTime < NO_ENTRY_BEFORE) continue;
      if (candleTime >= NO_ENTRY_AFTER) continue;
      if (candleTime >= NO_ENTRY_PRE_LUNCH_START && candleTime < NO_ENTRY_PRE_LUNCH_END) continue;
      if (candleTime >= NO_ENTRY_POST_LUNCH_START && candleTime < NO_ENTRY_POST_LUNCH_END) continue;
      
      // ---- B2方式 ----
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
      
      // ---- ステートマシン: 押し目確認 ----
      const pullbackState = pullbackStates.get(symbol);
      if (pullbackState) {
        pullbackState.waitCount++;
        if (low < pullbackState.recentSwingLow) { pullbackStates.delete(symbol); continue; }
        if (pullbackState.waitCount > PULLBACK_MAX_WAIT) { pullbackStates.delete(symbol); continue; }
        if (!pullbackState.pulledBack && close < pullbackState.signalPrice) pullbackState.pulledBack = true;
        if (pullbackState.pulledBack && close > pullbackState.signalPrice) {
          pullbackStates.delete(symbol);
          if (boardSignal === "sell_pressure") continue;
          const brScore = boardReadingScore("long", boardSnap, bprHist, config);
          if (brScore < BOARD_SCORE_THRESHOLD) continue;
          const entryResult = tryEnterPosition("long", symbol, close, candleTime, date,
            `押し目確認: ${pullbackState.reason}`, buffer, bpr, bprHist, openPositions, lastStopLossTime);
          if (entryResult) openPositions.set(symbol, entryResult);
          continue;
        }
        continue;
      }
      
      // ---- ステートマシン: 大台確認バー ----
      const roundPending = roundLevelPendingStates.get(symbol);
      if (roundPending) {
        if (openPositions.has(symbol)) { roundLevelPendingStates.delete(symbol); }
        else {
          const stillValid = roundPending.direction === "buy" ? close >= roundPending.level : close <= roundPending.level;
          if (stillValid) {
            roundPending.confirmCount++;
            if (roundPending.confirmCount >= ROUND_LEVEL_CONFIRM_BARS) {
              roundLevelPendingStates.delete(symbol);
              if (candleTime < NO_ENTRY_AFTER) {
                roundPullbackStates.set(symbol, {
                  direction: roundPending.direction, level: roundPending.level,
                  signalPrice: close, waitCount: 0, pulledBack: false,
                  reason: `大台確認(${ROUND_LEVEL_CONFIRM_BARS}本維持): ${roundPending.reason}`,
                });
              }
            }
          } else { roundLevelPendingStates.delete(symbol); }
          continue;
        }
      }
      
      // ---- ステートマシン: 大台押し目待ち ----
      const roundPb = roundPullbackStates.get(symbol);
      if (roundPb) {
        roundPb.waitCount++;
        const side: "long" | "short" = roundPb.direction === "buy" ? "long" : "short";
        
        if (roundPb.direction === "buy" && close < roundPb.level) { roundPullbackStates.delete(symbol); continue; }
        if (roundPb.direction === "sell" && close > roundPb.level) { roundPullbackStates.delete(symbol); continue; }
        
        if (roundPb.waitCount > ROUND_PULLBACK_MAX_WAIT) {
          roundPullbackStates.delete(symbol);
          if (side === "long" && boardSignal === "sell_pressure") continue;
          if (side === "short" && boardSignal === "buy_pressure") continue;
          const brScore = boardReadingScore(side, boardSnap, bprHist, config);
          if (brScore < BOARD_SCORE_THRESHOLD) continue;
          const entryResult = tryEnterPosition(side, symbol, close, candleTime, date,
            `${roundPb.reason} (押し目なし・強トレンド)`, buffer, bpr, bprHist, openPositions, lastStopLossTime);
          if (entryResult) openPositions.set(symbol, entryResult);
          continue;
        }
        
        if (roundPb.direction === "buy") {
          if (!roundPb.pulledBack && close < roundPb.signalPrice) roundPb.pulledBack = true;
          if (roundPb.pulledBack && close > roundPb.signalPrice) {
            roundPullbackStates.delete(symbol);
            if (boardSignal === "sell_pressure") continue;
            const brScore = boardReadingScore("long", boardSnap, bprHist, config);
            if (brScore < BOARD_SCORE_THRESHOLD) continue;
            const entryResult = tryEnterPosition("long", symbol, close, candleTime, date,
              `${roundPb.reason} (押し目確認後)`, buffer, bpr, bprHist, openPositions, lastStopLossTime);
            if (entryResult) openPositions.set(symbol, entryResult);
            continue;
          }
        } else {
          if (!roundPb.pulledBack && close > roundPb.signalPrice) roundPb.pulledBack = true;
          if (roundPb.pulledBack && close < roundPb.signalPrice) {
            roundPullbackStates.delete(symbol);
            if (boardSignal === "buy_pressure") continue;
            const brScore = boardReadingScore("short", boardSnap, bprHist, config);
            if (brScore < BOARD_SCORE_THRESHOLD) continue;
            const entryResult = tryEnterPosition("short", symbol, close, candleTime, date,
              `${roundPb.reason} (押し目確認後)`, buffer, bpr, bprHist, openPositions, lastStopLossTime);
            if (entryResult) openPositions.set(symbol, entryResult);
            continue;
          }
        }
        continue;
      }
      
      // ---- シグナル検出 ----
      const withSignals = detectSignals(buffer);
      const latestSignal = withSignals[withSignals.length - 1];
      buffer[buffer.length - 1] = latestSignal;
      
      if (!latestSignal.signal) continue;
      const sig = latestSignal.signal;
      
      // ---- 買いエントリー ----
      if (sig.type === "buy") {
        if (sig.reason.includes("VWAPクロス上抜け")) continue;
        if (boardSignal === "sell_pressure") continue;
        const brScore = boardReadingScore("long", boardSnap, bprHist, config);
        if (brScore < BOARD_SCORE_THRESHOLD) continue;
        
        if (sig.reason.startsWith("ダウ理論: 直近高値更新") && sig.recentSwingLow != null) {
          const htfTrend = getHigherTfTrend(buffer, buffer.length - 1);
          if (htfTrend !== "up") continue;
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
            recentSwingLow: sig.recentSwingLow, signalPrice: close,
            waitCount: 0, pulledBack: false, reason: sig.reason,
          });
          continue;
        }
        
        if (sig.reason.startsWith("大台超え")) {
          const m = sig.reason.match(/(\d+(?:\.\d+)?)円/);
          const level = m ? parseFloat(m[1]) : close;
          roundLevelPendingStates.set(symbol, { direction: "buy", level, confirmCount: 0, reason: sig.reason });
          continue;
        }
        
        if (sig.confidence === "medium") continue;
        
        const entryResult = tryEnterPosition("long", symbol, close, candleTime, date, sig.reason,
          buffer, bpr, bprHist, openPositions, lastStopLossTime);
        if (entryResult) openPositions.set(symbol, entryResult);
        continue;
      }
      
      // ---- 売りエントリー ----
      if (sig.type === "sell") {
        if (boardSignal === "buy_pressure") continue;
        
        if (sig.reason.includes("VWAPクロス下抜け") && buffer.length >= 5) {
          const len = buffer.length;
          const close5ago = buffer[len - 5].close;
          const close3ago = buffer[len - 3].close;
          const drop5 = ((close - close5ago) / close5ago) * 100;
          const drop3 = ((close - close3ago) / close3ago) * 100;
          if (drop5 <= VWAP_DROP_FILTER_5BARS || drop3 <= VWAP_DROP_FILTER_3BARS) continue;
        }
        
        const brScore = boardReadingScore("short", boardSnap, bprHist, config);
        if (brScore < BOARD_SCORE_THRESHOLD) continue;
        
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
        
        if (sig.reason.startsWith("大台割れ")) {
          const m = sig.reason.match(/(\d+(?:\.\d+)?)円/);
          const level = m ? parseFloat(m[1]) : close;
          roundLevelPendingStates.set(symbol, { direction: "sell", level, confirmCount: 0, reason: sig.reason });
          continue;
        }
        
        if (sig.confidence === "medium") {
          if (isAM && b2Direction === "bullish") continue;
        }
        
        if (candleTime >= PM_BPR_FILTER_START && bpr !== null && bpr >= PM_BPR_BLOCK_THRESHOLD) continue;
        
        const entryResult = tryEnterPosition("short", symbol, close, candleTime, date, sig.reason,
          buffer, bpr, bprHist, openPositions, lastStopLossTime);
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
  }
  
  return allTrades;
}

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
  
  const isVolumeUnavailable = checkVolumeUnavailable(buffer);
  if (isVolumeUnavailable) {
    if (candleTime >= "12:00" && candleTime <= "12:59") return null;
    const lastSL = lastStopLossTime.get(symbol);
    if (lastSL) {
      const minSinceStop = timeToMinutes(candleTime) - timeToMinutes(lastSL);
      if (minSinceStop >= 0 && minSinceStop < NO_REENTRY_AFTER_STOPLOSS_MIN) return null;
    }
  }
  
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
  
  if (side === "short" && candleTime >= PM_BPR_FILTER_START && bpr !== null && bpr >= PM_BPR_BLOCK_THRESHOLD) return null;
  
  let currentExposure = 0;
  for (const pos of Array.from(openPositions.values())) {
    currentExposure += pos.entryPrice * pos.shares;
  }
  if (currentExposure + amount > MAX_TOTAL_EXPOSURE) return null;
  
  let confidence: SignalConfidence = "medium";
  if (buffer.length > 1) {
    const volumes = buffer.map(c => c.volume);
    const closes = buffer.map(c => c.close);
    const idx = buffer.length - 1;
    const ma5Val = buffer[idx]?.ma5 ?? null;
    const ma25Val = buffer[idx]?.ma25 ?? null;
    const confResult = evaluateConfirmation({
      type: side === "long" ? "buy" : "sell",
      close: price, volume: buffer[idx].volume,
      avgVolume: trailingAvgVolume(volumes, idx, 10),
      ma5: ma5Val, ma25: ma25Val,
      momentum: priceMomentum(closes, idx, 3),
    });
    confidence = confResult.confidence;
  }
  
  return { symbol, side, entryPrice: price, shares, entryTime: candleTime, entryReason: reason, confidence, beTriggered: false };
}

// ============================================================
// メイン
// ============================================================
async function main() {
  const db = await getDb();
  
  const [dateRows] = await db.execute(
    `SELECT DISTINCT tradeDate FROM rt_candles 
     WHERE tradeDate >= '2026-06-19' AND tradeDate <= '2026-07-02'
     ORDER BY tradeDate`
  ) as any;
  const dates = (dateRows as any[]).map((r: any) => r.tradeDate);
  console.log(`=== 板情報活用改善シミュレーション（${dates.length}日間: ${dates[0]}〜${dates[dates.length - 1]}） ===\n`);
  
  const modes: ProposalMode[] = ["baseline", "proposal1", "proposal2", "proposal3", "all_combined"];
  const labels: Record<ProposalMode, string> = {
    baseline: "A) 現行（ベースライン）",
    proposal1: "B) 提案1: アイスバーグ解釈反転",
    proposal2: "C) 提案2: キャンセルペナルティ軽減",
    proposal3: "D) 提案3: 大口壁閾値緩和+強化",
    all_combined: "E) 全提案統合",
  };
  
  const results: Record<string, { trades: Trade[], totalPnl: number, winRate: number, pf: number, count: number }> = {};
  
  for (const mode of modes) {
    console.log(`--- ${labels[mode]} を実行中... ---`);
    const trades = await runSimulation(mode, db, dates);
    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
    const wins = trades.filter(t => t.pnl > 0);
    const losses = trades.filter(t => t.pnl < 0);
    const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    const pf = grossLoss > 0 ? grossProfit / grossLoss : Infinity;
    const winRate = trades.length > 0 ? (wins.length / trades.length) * 100 : 0;
    
    results[mode] = { trades, totalPnl, winRate, pf, count: trades.length };
    console.log(`  完了: ${trades.length}件, ${totalPnl >= 0 ? "+" : ""}${totalPnl.toLocaleString()}円, PF=${pf.toFixed(2)}, 勝率${winRate.toFixed(1)}%`);
  }
  
  // ============================================================
  // 比較テーブル
  // ============================================================
  console.log("\n" + "=".repeat(100));
  console.log("=== 比較テーブル ===\n");
  console.log("| パターン | 取引数 | 勝率 | 総損益 | PF | 期待値/回 | 現行比 |");
  console.log("|----------|--------|------|--------|------|-----------|--------|");
  
  const baselinePnl = results["baseline"].totalPnl;
  for (const mode of modes) {
    const r = results[mode];
    const diff = r.totalPnl - baselinePnl;
    const diffStr = mode === "baseline" ? "—" : `${diff >= 0 ? "+" : ""}${diff.toLocaleString()}円`;
    const expectation = r.count > 0 ? Math.round(r.totalPnl / r.count) : 0;
    console.log(
      `| ${labels[mode].padEnd(30)} | ${r.count.toString().padStart(4)}件 | ${r.winRate.toFixed(1).padStart(5)}% | ` +
      `${(r.totalPnl >= 0 ? "+" : "") + r.totalPnl.toLocaleString().padStart(10)}円 | ${r.pf.toFixed(2).padStart(4)} | ` +
      `${(expectation >= 0 ? "+" : "") + expectation.toLocaleString().padStart(7)}円 | ${diffStr.padStart(12)} |`
    );
  }
  
  // ============================================================
  // 日別比較
  // ============================================================
  console.log("\n=== 日別損益比較 ===\n");
  console.log("| 日付 | 現行 | 提案1 | 提案2 | 提案3 | 全統合 |");
  console.log("|------|------|-------|-------|-------|--------|");
  
  for (const date of dates) {
    const cols: string[] = [date];
    for (const mode of modes) {
      const dayTrades = results[mode].trades.filter(t => t.date === date);
      const dayPnl = dayTrades.reduce((s, t) => s + t.pnl, 0);
      cols.push(`${dayPnl >= 0 ? "+" : ""}${dayPnl.toLocaleString()}円`);
    }
    console.log(`| ${cols.join(" | ")} |`);
  }
  
  // ============================================================
  // 7/2の詳細比較
  // ============================================================
  console.log("\n=== 7/2 取引詳細比較 ===\n");
  for (const mode of modes) {
    const jul2 = results[mode].trades.filter(t => t.date === "2026-07-02");
    const jul2Pnl = jul2.reduce((s, t) => s + t.pnl, 0);
    console.log(`\n--- ${labels[mode]} (${jul2.length}件, ${jul2Pnl >= 0 ? "+" : ""}${jul2Pnl.toLocaleString()}円) ---`);
    for (const t of jul2) {
      const pnlStr = (t.pnl >= 0 ? "+" : "") + t.pnl.toLocaleString() + "円";
      console.log(
        `  ${t.entryTime}→${t.exitTime} | ${getStockName(t.symbol).padEnd(10)} | ${t.side.padEnd(5)} | ` +
        `@${t.entryPrice}→${t.exitPrice} | ${pnlStr.padStart(12)} | ${t.exitReason} | ${t.signalReason?.substring(0, 35) || ""}`
      );
    }
  }
  
  // ============================================================
  // 提案1の影響分析（アイスバーグ関連取引の詳細）
  // ============================================================
  console.log("\n=== 提案1: アイスバーグ解釈反転の影響詳細 ===\n");
  
  // baselineで通過したがproposal1でブロックされた取引
  const baselineTrades = results["baseline"].trades;
  const p1Trades = results["proposal1"].trades;
  
  // 取引をキーで比較
  const baselineKeys = new Set(baselineTrades.map(t => `${t.date}_${t.symbol}_${t.entryTime}_${t.side}`));
  const p1Keys = new Set(p1Trades.map(t => `${t.date}_${t.symbol}_${t.entryTime}_${t.side}`));
  
  const blockedByP1 = baselineTrades.filter(t => !p1Keys.has(`${t.date}_${t.symbol}_${t.entryTime}_${t.side}`));
  const addedByP1 = p1Trades.filter(t => !baselineKeys.has(`${t.date}_${t.symbol}_${t.entryTime}_${t.side}`));
  
  console.log(`提案1でブロックされた取引: ${blockedByP1.length}件`);
  const blockedPnl = blockedByP1.reduce((s, t) => s + t.pnl, 0);
  console.log(`  ブロックされた取引の合計損益: ${blockedPnl >= 0 ? "+" : ""}${blockedPnl.toLocaleString()}円`);
  for (const t of blockedByP1) {
    console.log(`  ${t.date} ${t.entryTime} ${getStockName(t.symbol)} ${t.side} ${(t.pnl >= 0 ? "+" : "") + t.pnl.toLocaleString()}円 (${t.signalReason?.substring(0, 30)})`);
  }
  
  console.log(`\n提案1で新たに通過した取引: ${addedByP1.length}件`);
  const addedPnl = addedByP1.reduce((s, t) => s + t.pnl, 0);
  console.log(`  新規通過取引の合計損益: ${addedPnl >= 0 ? "+" : ""}${addedPnl.toLocaleString()}円`);
  for (const t of addedByP1) {
    console.log(`  ${t.date} ${t.entryTime} ${getStockName(t.symbol)} ${t.side} ${(t.pnl >= 0 ? "+" : "") + t.pnl.toLocaleString()}円 (${t.signalReason?.substring(0, 30)})`);
  }
  
  process.exit(0);
}

main().catch(console.error);
