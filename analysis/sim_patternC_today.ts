/**
 * sim_patternC_today.ts
 * 
 * 7/8のデータで:
 * 1. LONGシグナルがどこでブロックされたかを分析
 * 2. パターンC（LONG改善案）を適用した場合の損益をシミュレーション
 * 
 * パターンC（ハイブリッド）の内容:
 * - sell_pressureブロックの条件付き解除: price > MA5 AND close > 当日始値 の場合のみLONG通過許可
 * - 板スコア閾値引き下げ（LONGのみ）: 閾値1 → 閾値0
 * - medium confidence（大台確認ステートマシン経由のみ許可）
 * - SHORTは完全に現行維持
 */

import { getDb } from "../server/db";
import { detectSignals, calcMA, calcRSI, calcBollinger, type CandleWithSignal } from "../server/routers/stockData";
import { evaluateConfirmation, trailingAvgVolume, priceMomentum, type SignalConfidence } from "../server/signalConfirmation";
import { calcATR } from "../server/intradayRegime";
import { TARGET_STOCKS, getStockName } from "../shared/stocks";
import { sql } from "drizzle-orm";

// ============================================================
// 定数（本番と完全一致）
// ============================================================
const INITIAL_CAPITAL_PER_STOCK = 3_000_000;
const LOT_RATIO = 0.9;
const STOP_LOSS_PERCENT = 0.5;
const TAKE_PROFIT_PERCENT = 1.5;
const IS_BULLISH_THRESHOLD = 0.2;
const PM_BPR_BLOCK_THRESHOLD = 0.65;
const PM_BPR_FILTER_START = "13:00";
const MARGIN_CAPITAL = 3_000_000;
const MARGIN_MULTIPLIER = 3.3;
const MARGIN_USAGE_LIMIT = 0.9;
const MAX_TOTAL_EXPOSURE = MARGIN_CAPITAL * MARGIN_MULTIPLIER * MARGIN_USAGE_LIMIT;
const MARKET_CLOSE_TIME = "15:25";
const NO_ENTRY_AFTER = "15:05";
const NO_ENTRY_BEFORE = "09:30";
const NO_ENTRY_PRE_LUNCH_START = "11:00";
const NO_ENTRY_PRE_LUNCH_END = "11:30";
const NO_ENTRY_POST_LUNCH_START = "12:30";
const NO_ENTRY_POST_LUNCH_END = "13:00";
const MIN_CANDLES_FOR_SIGNAL = 30;
const PULLBACK_MAX_WAIT = 5;
const ROUND_LEVEL_CONFIRM_BARS = 5;
const ROUND_PULLBACK_MAX_WAIT = 5;
const BOARD_SCORE_THRESHOLD = 1;
const BOARD_SCORE_THRESHOLD_LONG_PATTERNC = 0; // パターンC: LONGのみ閾値0
const ATR_FILTER_PERIOD = 7;
const ATR_FILTER_THRESHOLD = 0.0012;
const PULLBACK_DEPTH_MIN = 0.30;
const PULLBACK_DEPTH_MAX = 0.70;
const PULLBACK_DEPTH_LOOKBACK = 20;
const BOARD_EARLY_EXIT_MIN_PROFIT_PCT = 0.05;
const VOLUME_UNAVAILABLE_RATIO = 0.9;
const NO_REENTRY_AFTER_STOPLOSS_MIN = 30;

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

interface BlockedSignal {
  time: string;
  symbol: string;
  signalType: string;
  reason: string;
  blockReason: string;
  close: number;
  boardSignal: string;
  boardScore: number;
  ma5: number;
  openPrice: number;
  patternCWouldPass: boolean;
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

function boardReadingScore(
  side: "long" | "short",
  snapshot: any | null,
  bprHistory: number[]
): number {
  if (!snapshot) return 1;
  
  const bpr = snapshot.buyPressureRatio ?? 1.0;
  let score = 0;
  
  if ((snapshot.marketOrderRatio ?? 0) >= 0.08) {
    if (side === "long" && bpr > 1.0) score += 2;
    else if (side === "long" && bpr < 1.0) score -= 2;
    else if (side === "short" && bpr < 1.0) score += 2;
    else if (side === "short" && bpr > 1.0) score -= 2;
  }
  
  if (side === "long") {
    if (snapshot.largeSellWall) score += 1;
    if (snapshot.largeBuyWall) score -= 1;
  } else {
    if (snapshot.largeBuyWall) score += 1;
    if (snapshot.largeSellWall) score -= 1;
  }
  
  if (bprHistory.length >= 3) {
    const oldest = bprHistory[0];
    const newest = bprHistory[bprHistory.length - 1];
    const delta = newest - oldest;
    if (side === "long" && delta >= 0.15) score += 1;
    else if (side === "long" && delta <= -0.15) score -= 1;
    else if (side === "short" && delta <= -0.15) score += 1;
    else if (side === "short" && delta >= 0.15) score -= 1;
  }
  
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
  
  if (side === "long" && bpr >= 1.4) score += 1;
  else if (side === "long" && bpr <= 0.65) score -= 1;
  else if (side === "short" && bpr <= 0.65) score += 1;
  else if (side === "short" && bpr >= 1.4) score -= 1;
  
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
// パターンC: sell_pressure緩和条件
// price > MA5 AND close > 当日始値 の場合のみLONG通過許可
// ============================================================
function patternCSellPressureBypass(
  close: number,
  buffer: CandleWithSignal[],
  openPrice: number
): boolean {
  if (buffer.length < 5) return false;
  // MA5計算
  const recent5 = buffer.slice(buffer.length - 5);
  const ma5 = recent5.reduce((s, c) => s + c.close, 0) / 5;
  return close > ma5 && close > openPrice;
}

// ============================================================
// メインシミュレーション
// ============================================================
async function main() {
  const db = await getDb();
  const date = process.argv[2] || "2026-07-08";
  
  console.log(`=== パターンC LONGシグナル分析 (${date}) ===\n`);
  
  // ---- データ取得 ----
  const [candles] = await db.execute(
    sql`SELECT symbol, tradeDate, candleTime, open, high, low, close, volume, boardSnapshot
         FROM rt_candles
         WHERE tradeDate = ${date}
         ORDER BY candleTime, symbol`
  ) as any;
  
  if (!candles || candles.length === 0) {
    console.log("データなし");
    process.exit(0);
  }
  
  console.log(`データ件数: ${candles.length}本\n`);
  
  // ---- 状態変数 ----
  const openPositions = new Map<string, OpenPosition>();
  const pullbackStates = new Map<string, PullbackState>();
  const roundLevelPendingStates = new Map<string, RoundLevelPendingState>();
  const roundPullbackStates = new Map<string, RoundPullbackState>();
  const candleBuffers = new Map<string, CandleWithSignal[]>();
  const bprHistories = new Map<string, number[]>();
  const lastStopLossTime = new Map<string, string>();
  const symbolOpenPrices = new Map<string, number>();
  
  const blockedSignals: BlockedSignal[] = [];
  const baselineTrades: Trade[] = [];
  const patternCTrades: Trade[] = [];
  
  // パターンC用の別状態
  const pcOpenPositions = new Map<string, OpenPosition>();
  const pcPullbackStates = new Map<string, PullbackState>();
  const pcRoundLevelPendingStates = new Map<string, RoundLevelPendingState>();
  const pcRoundPullbackStates = new Map<string, RoundPullbackState>();
  const pcLastStopLossTime = new Map<string, string>();
  
  // ---- 時系列処理 ----
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
    
    // 始値記録
    if (!symbolOpenPrices.has(symbol)) {
      symbolOpenPrices.set(symbol, open);
    }
    
    // 板情報
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
    
    // バッファ
    if (!candleBuffers.has(symbol)) candleBuffers.set(symbol, []);
    const buffer = candleBuffers.get(symbol)!;
    
    const candleForSignal: CandleWithSignal = {
      time: `${date}T${candleTime}:00`,
      open, high, low, close, volume,
    };
    buffer.push(candleForSignal);
    
    const bprHist = bprHistories.get(symbol) ?? [];
    const boardSignal = getBoardSignal(boardSnap);
    const symOpen = symbolOpenPrices.get(symbol) ?? open;
    
    // ---- ウォームアップ ----
    if (buffer.length < MIN_CANDLES_FOR_SIGNAL) continue;
    
    // ---- 既存ポジション決済チェック（ベースライン） ----
    const existingPos = openPositions.get(symbol);
    if (existingPos) {
      const slLine = existingPos.side === "long"
        ? existingPos.entryPrice * (1 - STOP_LOSS_PERCENT / 100)
        : existingPos.entryPrice * (1 + STOP_LOSS_PERCENT / 100);
      const tpLine = existingPos.side === "long"
        ? existingPos.entryPrice * (1 + TAKE_PROFIT_PERCENT / 100)
        : existingPos.entryPrice * (1 - TAKE_PROFIT_PERCENT / 100);
      
      let exitPrice: number | null = null;
      let exitReason = "";
      
      if (existingPos.side === "long" && low <= slLine) {
        exitPrice = slLine; exitReason = "損切り";
      } else if (existingPos.side === "short" && high >= slLine) {
        exitPrice = slLine; exitReason = "損切り";
      } else if (existingPos.side === "long" && high >= tpLine) {
        exitPrice = tpLine; exitReason = "利確";
      } else if (existingPos.side === "short" && low <= tpLine) {
        exitPrice = tpLine; exitReason = "利確";
      } else if (shouldBoardEarlyExit(existingPos, close, boardSnap)) {
        exitPrice = close; exitReason = "板読み早期利確";
      } else if (candleTime >= MARKET_CLOSE_TIME) {
        exitPrice = close; exitReason = "大引け強制決済";
      }
      
      if (exitPrice !== null) {
        const pnl = existingPos.side === "long"
          ? Math.round((exitPrice - existingPos.entryPrice) * existingPos.shares)
          : Math.round((existingPos.entryPrice - exitPrice) * existingPos.shares);
        baselineTrades.push({
          date, symbol, side: existingPos.side,
          entryTime: existingPos.entryTime, entryPrice: existingPos.entryPrice,
          exitTime: candleTime, exitPrice, pnl, exitReason,
          signalReason: existingPos.entryReason, confidence: existingPos.confidence,
          session: timeToMinutes(existingPos.entryTime) < 12 * 60 + 30 ? "am" : "pm",
          shares: existingPos.shares,
        });
        openPositions.delete(symbol);
        if (exitReason === "損切り") lastStopLossTime.set(symbol, candleTime);
      }
    }
    
    // ---- パターンCポジション決済チェック ----
    const pcPos = pcOpenPositions.get(symbol);
    if (pcPos) {
      const slLine = pcPos.side === "long"
        ? pcPos.entryPrice * (1 - STOP_LOSS_PERCENT / 100)
        : pcPos.entryPrice * (1 + STOP_LOSS_PERCENT / 100);
      const tpLine = pcPos.side === "long"
        ? pcPos.entryPrice * (1 + TAKE_PROFIT_PERCENT / 100)
        : pcPos.entryPrice * (1 - TAKE_PROFIT_PERCENT / 100);
      
      let exitPrice: number | null = null;
      let exitReason = "";
      
      if (pcPos.side === "long" && low <= slLine) {
        exitPrice = slLine; exitReason = "損切り";
      } else if (pcPos.side === "short" && high >= slLine) {
        exitPrice = slLine; exitReason = "損切り";
      } else if (pcPos.side === "long" && high >= tpLine) {
        exitPrice = tpLine; exitReason = "利確";
      } else if (pcPos.side === "short" && low <= tpLine) {
        exitPrice = tpLine; exitReason = "利確";
      } else if (shouldBoardEarlyExit(pcPos, close, boardSnap)) {
        exitPrice = close; exitReason = "板読み早期利確";
      } else if (candleTime >= MARKET_CLOSE_TIME) {
        exitPrice = close; exitReason = "大引け強制決済";
      }
      
      if (exitPrice !== null) {
        const pnl = pcPos.side === "long"
          ? Math.round((exitPrice - pcPos.entryPrice) * pcPos.shares)
          : Math.round((pcPos.entryPrice - exitPrice) * pcPos.shares);
        patternCTrades.push({
          date, symbol, side: pcPos.side,
          entryTime: pcPos.entryTime, entryPrice: pcPos.entryPrice,
          exitTime: candleTime, exitPrice, pnl, exitReason,
          signalReason: pcPos.entryReason, confidence: pcPos.confidence,
          session: timeToMinutes(pcPos.entryTime) < 12 * 60 + 30 ? "am" : "pm",
          shares: pcPos.shares,
        });
        pcOpenPositions.delete(symbol);
        if (exitReason === "損切り") pcLastStopLossTime.set(symbol, candleTime);
      }
    }
    
    // ---- 時間帯チェック ----
    if (candleTime >= MARKET_CLOSE_TIME) continue;
    if (candleTime < NO_ENTRY_BEFORE) continue;
    if (candleTime >= NO_ENTRY_AFTER) continue;
    if (candleTime >= NO_ENTRY_PRE_LUNCH_START && candleTime < NO_ENTRY_PRE_LUNCH_END) continue;
    if (candleTime >= NO_ENTRY_POST_LUNCH_START && candleTime < NO_ENTRY_POST_LUNCH_END) continue;
    
    // ---- シグナル検出 ----
    const withSignals = detectSignals(buffer);
    const latestSignal = withSignals[withSignals.length - 1];
    buffer[buffer.length - 1] = latestSignal;
    
    if (!latestSignal.signal) continue;
    const sig = latestSignal.signal;
    
    // ---- BUYシグナル分析 ----
    if (sig.type === "buy") {
      if (sig.reason.includes("VWAPクロス上抜け")) continue;
      
      const brScore = boardReadingScore("long", boardSnap, bprHist);
      const ma5 = buffer.length >= 5 
        ? buffer.slice(buffer.length - 5).reduce((s, c) => s + c.close, 0) / 5 
        : close;
      const wouldBypassSellPressure = patternCSellPressureBypass(close, buffer, symOpen);
      
      // ベースライン: sell_pressure → ブロック
      let baselineBlocked = false;
      let blockReason = "";
      
      if (boardSignal === "sell_pressure") {
        baselineBlocked = true;
        blockReason = "sell_pressure";
      } else if (brScore < BOARD_SCORE_THRESHOLD) {
        baselineBlocked = true;
        blockReason = `板スコア不足(${brScore}<${BOARD_SCORE_THRESHOLD})`;
      } else if (sig.confidence === "medium" && !sig.reason.startsWith("大台超え")) {
        baselineBlocked = true;
        blockReason = "BUY medium全ブロック";
      }
      
      if (baselineBlocked && !openPositions.has(symbol)) {
        blockedSignals.push({
          time: candleTime,
          symbol,
          signalType: sig.type,
          reason: sig.reason,
          blockReason,
          close,
          boardSignal,
          boardScore: brScore,
          ma5,
          openPrice: symOpen,
          patternCWouldPass: blockReason === "sell_pressure" 
            ? wouldBypassSellPressure 
            : blockReason.startsWith("板スコア") 
              ? brScore >= BOARD_SCORE_THRESHOLD_LONG_PATTERNC
              : false,
        });
      }
      
      // ---- パターンCエントリー判定 ----
      if (!pcOpenPositions.has(symbol)) {
        let pcBlocked = false;
        
        // パターンC: sell_pressure条件付き解除
        if (boardSignal === "sell_pressure") {
          if (!wouldBypassSellPressure) pcBlocked = true;
        }
        
        // パターンC: 板スコア閾値0
        if (!pcBlocked && brScore < BOARD_SCORE_THRESHOLD_LONG_PATTERNC) pcBlocked = true;
        
        // BUY medium: 大台確認ステートマシン経由のみ許可（直接はブロック）
        if (!pcBlocked && sig.confidence === "medium" && !sig.reason.startsWith("大台超え")) pcBlocked = true;
        
        if (!pcBlocked) {
          // 損切り後再エントリー禁止チェック
          const lastSL = pcLastStopLossTime.get(symbol);
          if (lastSL && timeToMinutes(candleTime) - timeToMinutes(lastSL) < NO_REENTRY_AFTER_STOPLOSS_MIN) {
            // skip
          } else {
            // ATRフィルター
            const highs = buffer.map(c => c.high);
            const lows = buffer.map(c => c.low);
            const closes = buffer.map(c => c.close);
            const atrArr = calcATR(highs, lows, closes, ATR_FILTER_PERIOD);
            const atrVal = atrArr[atrArr.length - 1];
            const atrPct = atrVal ? atrVal / close : 0;
            if (atrPct >= ATR_FILTER_THRESHOLD) {
              // ダウ理論 → ステートマシン（簡略化: 直接エントリーで近似）
              const shares = calcShares(close);
              pcOpenPositions.set(symbol, {
                symbol, side: "long", entryPrice: close, shares,
                entryTime: candleTime, entryReason: sig.reason,
                confidence: sig.confidence as SignalConfidence,
              });
            }
          }
        }
      }
      
      // ---- ベースラインエントリー判定（SHORT同様の処理） ----
      if (!baselineBlocked && !openPositions.has(symbol)) {
        const lastSL = lastStopLossTime.get(symbol);
        if (lastSL && timeToMinutes(candleTime) - timeToMinutes(lastSL) < NO_REENTRY_AFTER_STOPLOSS_MIN) {
          // skip
        } else {
          const highs2 = buffer.map(c => c.high);
          const lows2 = buffer.map(c => c.low);
          const closes2 = buffer.map(c => c.close);
          const atrArr2 = calcATR(highs2, lows2, closes2, ATR_FILTER_PERIOD);
          const atrVal2 = atrArr2[atrArr2.length - 1];
          const atrPct2 = atrVal2 ? atrVal2 / close : 0;
          if (atrPct2 >= ATR_FILTER_THRESHOLD) {
            const shares = calcShares(close);
            openPositions.set(symbol, {
              symbol, side: "long", entryPrice: close, shares,
              entryTime: candleTime, entryReason: sig.reason,
              confidence: sig.confidence as SignalConfidence,
            });
            baselineTrades.push({
              date, symbol, side: "long",
              entryTime: candleTime, entryPrice: close,
              exitTime: "", exitPrice: 0, pnl: 0, exitReason: "OPEN",
              signalReason: sig.reason, confidence: sig.confidence ?? "medium",
              session: timeToMinutes(candleTime) < 12 * 60 + 30 ? "am" : "pm",
              shares: calcShares(close),
            });
          }
        }
      }
      continue;
    }
    
    // ---- SELLシグナル（ベースライン＋パターンC共通: SHORTは同じ） ----
    if (sig.type === "sell") {
      if (boardSignal === "buy_pressure") continue;
      
      const symOpenP = symbolOpenPrices.get(symbol);
      if (symOpenP && close > symOpenP * (1 + IS_BULLISH_THRESHOLD / 100)) continue;
      
      const brScore = boardReadingScore("short", boardSnap, bprHist);
      if (brScore < BOARD_SCORE_THRESHOLD) continue;
      
      if (sig.confidence === "medium") continue;
      
      if (candleTime >= PM_BPR_FILTER_START && bpr !== null && bpr >= PM_BPR_BLOCK_THRESHOLD) continue;
      
      // ベースラインエントリー
      if (!openPositions.has(symbol)) {
        const lastSL = lastStopLossTime.get(symbol);
        if (lastSL && timeToMinutes(candleTime) - timeToMinutes(lastSL) < NO_REENTRY_AFTER_STOPLOSS_MIN) {
          // skip
        } else {
          const hArr = buffer.map(c => c.high);
          const lArr = buffer.map(c => c.low);
          const cArr = buffer.map(c => c.close);
          const atrA = calcATR(hArr, lArr, cArr, ATR_FILTER_PERIOD);
          const atrV = atrA[atrA.length - 1];
          const atrPct = atrV ? atrV / close : 0;
          if (atrPct >= ATR_FILTER_THRESHOLD) {
            const shares = calcShares(close);
            openPositions.set(symbol, {
              symbol, side: "short", entryPrice: close, shares,
              entryTime: candleTime, entryReason: sig.reason,
              confidence: sig.confidence as SignalConfidence,
            });
          }
        }
      }
      
      // パターンCエントリー（SHORTは同じ）
      if (!pcOpenPositions.has(symbol)) {
        const lastSL = pcLastStopLossTime.get(symbol);
        if (lastSL && timeToMinutes(candleTime) - timeToMinutes(lastSL) < NO_REENTRY_AFTER_STOPLOSS_MIN) {
          // skip
        } else {
          const hArr2 = buffer.map(c => c.high);
          const lArr2 = buffer.map(c => c.low);
          const cArr2 = buffer.map(c => c.close);
          const atrA2 = calcATR(hArr2, lArr2, cArr2, ATR_FILTER_PERIOD);
          const atrV2 = atrA2[atrA2.length - 1];
          const atrPct2 = atrV2 ? atrV2 / close : 0;
          if (atrPct2 >= ATR_FILTER_THRESHOLD) {
            const shares = calcShares(close);
            pcOpenPositions.set(symbol, {
              symbol, side: "short", entryPrice: close, shares,
              entryTime: candleTime, entryReason: sig.reason,
              confidence: sig.confidence as SignalConfidence,
            });
          }
        }
      }
    }
  }
  
  // ---- 残ポジション強制決済 ----
  for (const [symbol, pos] of Array.from(openPositions.entries())) {
    const lastCandle = candleBuffers.get(symbol);
    if (!lastCandle || lastCandle.length === 0) continue;
    const lastClose = lastCandle[lastCandle.length - 1].close;
    const pnl = pos.side === "long"
      ? Math.round((lastClose - pos.entryPrice) * pos.shares)
      : Math.round((pos.entryPrice - lastClose) * pos.shares);
    baselineTrades.push({
      date, symbol, side: pos.side,
      entryTime: pos.entryTime, entryPrice: pos.entryPrice,
      exitTime: "15:25", exitPrice: lastClose,
      pnl, exitReason: "EOD",
      signalReason: pos.entryReason, confidence: pos.confidence,
      session: timeToMinutes(pos.entryTime) < 12 * 60 + 30 ? "am" : "pm",
      shares: pos.shares,
    });
  }
  for (const [symbol, pos] of Array.from(pcOpenPositions.entries())) {
    const lastCandle = candleBuffers.get(symbol);
    if (!lastCandle || lastCandle.length === 0) continue;
    const lastClose = lastCandle[lastCandle.length - 1].close;
    const pnl = pos.side === "long"
      ? Math.round((lastClose - pos.entryPrice) * pos.shares)
      : Math.round((pos.entryPrice - lastClose) * pos.shares);
    patternCTrades.push({
      date, symbol, side: pos.side,
      entryTime: pos.entryTime, entryPrice: pos.entryPrice,
      exitTime: "15:25", exitPrice: lastClose,
      pnl, exitReason: "EOD",
      signalReason: pos.entryReason, confidence: pos.confidence,
      session: timeToMinutes(pos.entryTime) < 12 * 60 + 30 ? "am" : "pm",
      shares: pos.shares,
    });
  }
  
  // ============================================================
  // 結果出力
  // ============================================================
  console.log("=".repeat(70));
  console.log("1. ブロックされたLONGシグナル一覧");
  console.log("=".repeat(70));
  
  if (blockedSignals.length === 0) {
    console.log("  LONGシグナルは検出されませんでした（前場データ欠損のため）\n");
  } else {
    console.log(`  合計: ${blockedSignals.length}件\n`);
    
    // ブロック理由別集計
    const byReason = new Map<string, number>();
    for (const b of blockedSignals) {
      byReason.set(b.blockReason, (byReason.get(b.blockReason) ?? 0) + 1);
    }
    console.log("  ブロック理由別:");
    for (const [reason, count] of byReason.entries()) {
      console.log(`    ${reason}: ${count}件`);
    }
    
    console.log("\n  パターンCで通過するシグナル:");
    const wouldPass = blockedSignals.filter(b => b.patternCWouldPass);
    if (wouldPass.length === 0) {
      console.log("    なし");
    } else {
      for (const b of wouldPass) {
        console.log(`    ${b.time} ${b.symbol}(${getStockName(b.symbol)}) ${b.reason} @${b.close} [板:${b.boardSignal} スコア:${b.boardScore}]`);
      }
    }
  }
  
  console.log("\n" + "=".repeat(70));
  console.log("2. ベースライン（現行ロジック）結果");
  console.log("=".repeat(70));
  
  const closedBaseline = baselineTrades.filter(t => t.exitReason !== "OPEN");
  const baselinePnl = closedBaseline.reduce((s, t) => s + t.pnl, 0);
  const baselineWins = closedBaseline.filter(t => t.pnl > 0).length;
  console.log(`  決済件数: ${closedBaseline.length}件`);
  console.log(`  勝率: ${closedBaseline.length > 0 ? ((baselineWins / closedBaseline.length) * 100).toFixed(1) : "0"}%`);
  console.log(`  総損益: ${baselinePnl >= 0 ? "+" : ""}${baselinePnl.toLocaleString()}円`);
  
  if (closedBaseline.length > 0) {
    console.log("\n  取引一覧:");
    for (const t of closedBaseline) {
      console.log(`    ${t.entryTime}-${t.exitTime} ${t.symbol}(${getStockName(t.symbol)}) ${t.side} @${t.entryPrice}→${t.exitPrice} ${t.pnl >= 0 ? "+" : ""}${t.pnl.toLocaleString()}円 [${t.exitReason}]`);
    }
  }
  
  console.log("\n" + "=".repeat(70));
  console.log("3. パターンC（LONG改善）結果");
  console.log("=".repeat(70));
  
  const pcPnl = patternCTrades.reduce((s, t) => s + t.pnl, 0);
  const pcWins = patternCTrades.filter(t => t.pnl > 0).length;
  const pcLongs = patternCTrades.filter(t => t.side === "long");
  const pcShorts = patternCTrades.filter(t => t.side === "short");
  
  console.log(`  決済件数: ${patternCTrades.length}件 (LONG: ${pcLongs.length}, SHORT: ${pcShorts.length})`);
  console.log(`  勝率: ${patternCTrades.length > 0 ? ((pcWins / patternCTrades.length) * 100).toFixed(1) : "0"}%`);
  console.log(`  総損益: ${pcPnl >= 0 ? "+" : ""}${pcPnl.toLocaleString()}円`);
  console.log(`  LONG損益: ${pcLongs.reduce((s, t) => s + t.pnl, 0) >= 0 ? "+" : ""}${pcLongs.reduce((s, t) => s + t.pnl, 0).toLocaleString()}円`);
  console.log(`  SHORT損益: ${pcShorts.reduce((s, t) => s + t.pnl, 0) >= 0 ? "+" : ""}${pcShorts.reduce((s, t) => s + t.pnl, 0).toLocaleString()}円`);
  
  if (patternCTrades.length > 0) {
    console.log("\n  取引一覧:");
    for (const t of patternCTrades) {
      console.log(`    ${t.entryTime}-${t.exitTime} ${t.symbol}(${getStockName(t.symbol)}) ${t.side} @${t.entryPrice}→${t.exitPrice} ${t.pnl >= 0 ? "+" : ""}${t.pnl.toLocaleString()}円 [${t.exitReason}] ${t.signalReason}`);
    }
  }
  
  console.log("\n" + "=".repeat(70));
  console.log("4. 比較サマリー");
  console.log("=".repeat(70));
  console.log(`  ベースライン: ${baselinePnl >= 0 ? "+" : ""}${baselinePnl.toLocaleString()}円 (${closedBaseline.length}件)`);
  console.log(`  パターンC:    ${pcPnl >= 0 ? "+" : ""}${pcPnl.toLocaleString()}円 (${patternCTrades.length}件)`);
  console.log(`  差分:         ${(pcPnl - baselinePnl) >= 0 ? "+" : ""}${(pcPnl - baselinePnl).toLocaleString()}円`);
  
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
