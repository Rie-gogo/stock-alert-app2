/**
 * sim_ablation_test.ts
 *
 * アブレーションテスト: 各機能を個別にON/OFFして影響を測定
 * 
 * ベースライン: 6/26版（最良パフォーマンス）
 * テスト対象機能:
 *   A: BEストップ（現行で追加）
 *   B: B2方式 vs isBullish方式（地合い判定）
 *   C: SHORT medium許可方式（全ブロック vs B2条件付き）
 *   D: 後場BPRフィルター（現行で追加）
 *   E: VWAP急落フィルター（現行で追加）
 *   F: 銘柄数（17銘柄 vs 10銘柄）
 * 
 * パターン:
 *   Base: 6/26版そのまま（17銘柄, isBullish, medium全ブロック, BEなし, PMBPRなし, VWAPDropなし）
 *   +A: 6/26版 + BEストップ追加
 *   +B: 6/26版 + B2方式に変更
 *   +C: 6/26版 + SHORT medium B2条件付き許可
 *   +D: 6/26版 + 後場BPRフィルター追加
 *   +E: 6/26版 + VWAP急落フィルター追加
 *   +F: 6/26版 + 10銘柄に絞り込み
 *   Current: 現行版（全機能ON, 10銘柄）
 *   Best: 6/26版ベース + 有効な機能のみ追加
 */

import { getDb } from "../server/db";
import { detectSignals, calcMA, calcRSI, calcBollinger, type CandleWithSignal } from "../server/routers/stockData";
import { evaluateConfirmation, trailingAvgVolume, priceMomentum, type SignalConfidence } from "../server/signalConfirmation";
import { calcATR } from "../server/intradayRegime";
import { getStockName } from "../shared/stocks";

// ============================================================
// 定数
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
const IS_BULLISH_THRESHOLD = 0.2;
const B2_THRESHOLD = 0.2;

const SEVENTEEN_SYMBOLS = [
  '6526', '6920', '6857', '9107', '8306', '9984', '8035',
  '7011', '4568', '285A', '6981', '6976', '5803', '5016',
  '8316', '6758', '7203'
];
const TEN_SYMBOLS = ['6920', '8035', '6857', '6976', '6526', '9984', '8316', '7011', '5803', '6981'];

// ============================================================
// 設定パターン
// ============================================================
interface Config {
  name: string;
  description: string;
  useBE: boolean;
  useB2: boolean;           // true=B2方式, false=isBullish方式
  shortMediumAllow: boolean; // true=B2条件付き許可, false=全ブロック
  usePmBprFilter: boolean;
  useVwapDropFilter: boolean;
  symbols: string[];
}

const CONFIGS: Config[] = [
  {
    name: "Base(6/26版)",
    description: "6/26版そのまま",
    useBE: false, useB2: false, shortMediumAllow: false,
    usePmBprFilter: false, useVwapDropFilter: false, symbols: SEVENTEEN_SYMBOLS,
  },
  {
    name: "+A(BE追加)",
    description: "6/26版 + BEストップ",
    useBE: true, useB2: false, shortMediumAllow: false,
    usePmBprFilter: false, useVwapDropFilter: false, symbols: SEVENTEEN_SYMBOLS,
  },
  {
    name: "+B(B2方式)",
    description: "6/26版 + B2方式に変更",
    useBE: false, useB2: true, shortMediumAllow: false,
    usePmBprFilter: false, useVwapDropFilter: false, symbols: SEVENTEEN_SYMBOLS,
  },
  {
    name: "+C(medium許可)",
    description: "6/26版 + SHORT medium B2条件付き許可",
    useBE: false, useB2: false, shortMediumAllow: true,
    usePmBprFilter: false, useVwapDropFilter: false, symbols: SEVENTEEN_SYMBOLS,
  },
  {
    name: "+D(PM_BPR)",
    description: "6/26版 + 後場BPRフィルター",
    useBE: false, useB2: false, shortMediumAllow: false,
    usePmBprFilter: true, useVwapDropFilter: false, symbols: SEVENTEEN_SYMBOLS,
  },
  {
    name: "+E(VWAPDrop)",
    description: "6/26版 + VWAP急落フィルター",
    useBE: false, useB2: false, shortMediumAllow: false,
    usePmBprFilter: false, useVwapDropFilter: true, symbols: SEVENTEEN_SYMBOLS,
  },
  {
    name: "+F(10銘柄)",
    description: "6/26版 + 10銘柄に絞り込み",
    useBE: false, useB2: false, shortMediumAllow: false,
    usePmBprFilter: false, useVwapDropFilter: false, symbols: TEN_SYMBOLS,
  },
  {
    name: "Current(現行)",
    description: "現行版（全機能ON, 10銘柄）",
    useBE: true, useB2: true, shortMediumAllow: true,
    usePmBprFilter: true, useVwapDropFilter: true, symbols: TEN_SYMBOLS,
  },
  // 追加: 有望な組み合わせ
  {
    name: "Best1(D+F)",
    description: "6/26版 + PM_BPR + 10銘柄",
    useBE: false, useB2: false, shortMediumAllow: false,
    usePmBprFilter: true, useVwapDropFilter: false, symbols: TEN_SYMBOLS,
  },
  {
    name: "Best2(D+E+F)",
    description: "6/26版 + PM_BPR + VWAPDrop + 10銘柄",
    useBE: false, useB2: false, shortMediumAllow: false,
    usePmBprFilter: true, useVwapDropFilter: true, symbols: TEN_SYMBOLS,
  },
  {
    name: "Best3(E+F)",
    description: "6/26版 + VWAPDrop + 10銘柄",
    useBE: false, useB2: false, shortMediumAllow: false,
    usePmBprFilter: false, useVwapDropFilter: true, symbols: TEN_SYMBOLS,
  },
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
  if (group.length > 0) htf.push({ close: group[group.length - 1].close });
  if (htf.length < 25) return "neutral";
  const closes = htf.map(c => c.close);
  const fast5 = closes.slice(closes.length - 5).reduce((s, v) => s + v, 0) / 5;
  const slow25 = closes.slice(closes.length - 25).reduce((s, v) => s + v, 0) / 25;
  if (fast5 > slow25) return "up";
  if (fast5 < slow25) return "down";
  return "neutral";
}

function boardReadingScore(side: "long" | "short", snapshot: any | null, bprHistory: number[]): number {
  if (!snapshot) return 1;
  const bpr = snapshot.buyPressureRatio ?? 1.0;
  let score = 0;
  if ((snapshot.marketOrderRatio ?? 0) >= 0.08) {
    if (side === "long" && bpr > 1.0) score += 2;
    else if (side === "long" && bpr < 1.0) score -= 2;
    else if (side === "short" && bpr < 1.0) score += 2;
    else if (side === "short" && bpr > 1.0) score -= 2;
  }
  if (side === "long") { if (snapshot.largeSellWall) score += 1; if (snapshot.largeBuyWall) score -= 1; }
  else { if (snapshot.largeBuyWall) score += 1; if (snapshot.largeSellWall) score -= 1; }
  if (bprHistory.length >= 3) {
    const delta = bprHistory[bprHistory.length - 1] - bprHistory[0];
    if (side === "long" && delta >= 0.15) score += 1;
    else if (side === "long" && delta <= -0.15) score -= 1;
    else if (side === "short" && delta <= -0.15) score += 1;
    else if (side === "short" && delta >= 0.15) score -= 1;
  }
  const cancelDetected = !!(snapshot.askCancelDetected || snapshot.bidCancelDetected);
  let mode: "active" | "building" | "trap" | "quiet";
  if (cancelDetected) { mode = "trap"; }
  else if (bprHistory.length >= 3) {
    const allNeutral = bprHistory.every(h => h >= 0.85 && h <= 1.15);
    if (allNeutral && bpr >= 0.85 && bpr <= 1.15) mode = "quiet";
    else if (bpr > 1.2 || bpr < 0.8) mode = "active";
    else { mode = Math.abs(bprHistory[bprHistory.length - 1] - bprHistory[0]) >= 0.1 ? "building" : "trap"; }
  } else { mode = (bpr > 1.2 || bpr < 0.8) ? "active" : "trap"; }
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
    const trend = bprHistory[bprHistory.length - 1] - bprHistory[0];
    if (trend >= 0.2) tickDir = "uptick";
    else if (trend <= -0.2) tickDir = "downtick";
    else if (bprHistory[bprHistory.length - 1] >= 1.3) tickDir = "uptick";
    else if (bprHistory[bprHistory.length - 1] <= 0.7) tickDir = "downtick";
  }
  if (tickDir === "uptick") { if (side === "long") score += 2; else score -= 2; }
  else if (tickDir === "downtick") { if (side === "short") score += 2; else score -= 2; }
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

function shouldBoardEarlyExit(pos: OpenPosition, currentPrice: number, snapshot: any | null): boolean {
  if (!snapshot) return false;
  const pnlPct = pos.side === "long"
    ? (currentPrice - pos.entryPrice) / pos.entryPrice * 100
    : (pos.entryPrice - currentPrice) / pos.entryPrice * 100;
  if (pnlPct < BOARD_EARLY_EXIT_MIN_PROFIT_PCT) return false;
  if (pos.side === "long") return snapshot.signal === "sell_pressure" || snapshot.signal === "large_sell_wall";
  else return snapshot.signal === "buy_pressure" || snapshot.signal === "large_buy_wall";
}

// ============================================================
// シミュレーション実行（設定パラメータ化）
// ============================================================
async function runSimulation(config: Config, db: any, dates: string[]): Promise<Trade[]> {
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
       FROM rt_candles WHERE tradeDate = '${date}' ORDER BY candleTime, symbol`
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
      
      if (!config.symbols.includes(symbol)) continue;
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
        time: `${date}T${candleTime}:00`, dayKey: date,
        timestamp: new Date(`${date}T${candleTime}:00+09:00`).getTime(),
        open, high, low, close, volume,
        ma5: null, ma25: null, rsi: null, bbUpper: null, bbMiddle: null, bbLower: null,
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
      
      // ---- B2方式: 市場方向性判定 ----
      if (config.useB2 && !b2Determined && candleTime >= "09:30") {
        let totalChange = 0, count = 0;
        for (const [, buf] of Array.from(candleBuffers.entries())) {
          if (buf.length >= 2) {
            const changeRate = (buf[buf.length - 1].close - buf[0].open) / buf[0].open * 100;
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
      
      // ---- 既存ポジションの決済チェック ----
      const existingPos = openPositions.get(symbol);
      if (existingPos) {
        let exitPrice: number | null = null;
        let exitReason = "";
        
        // BEトリガー（config.useBE時のみ）
        if (config.useBE && !existingPos.beTriggered) {
          const beLine = existingPos.side === "long"
            ? existingPos.entryPrice * (1 + BE_TRIGGER_PERCENT / 100)
            : existingPos.entryPrice * (1 - BE_TRIGGER_PERCENT / 100);
          const beHit = existingPos.side === "long" ? high >= beLine : low <= beLine;
          if (beHit) existingPos.beTriggered = true;
        }
        
        // SL/BE/TP
        if (existingPos.side === "long") {
          const stopLine = (config.useBE && existingPos.beTriggered)
            ? existingPos.entryPrice
            : existingPos.entryPrice * (1 - STOP_LOSS_PERCENT / 100);
          if (low <= stopLine) {
            exitPrice = stopLine;
            exitReason = (config.useBE && existingPos.beTriggered) ? "BE" : "SL";
          }
          const tpLine = existingPos.entryPrice * (1 + TAKE_PROFIT_PERCENT / 100);
          if (high >= tpLine && exitPrice === null) { exitPrice = tpLine; exitReason = "TP"; }
        } else {
          const stopLine = (config.useBE && existingPos.beTriggered)
            ? existingPos.entryPrice
            : existingPos.entryPrice * (1 + STOP_LOSS_PERCENT / 100);
          if (high >= stopLine) {
            exitPrice = stopLine;
            exitReason = (config.useBE && existingPos.beTriggered) ? "BE" : "SL";
          }
          const tpLine = existingPos.entryPrice * (1 - TAKE_PROFIT_PERCENT / 100);
          if (low <= tpLine && exitPrice === null) { exitPrice = tpLine; exitReason = "TP"; }
        }
        
        // シグナル反転決済
        if (exitPrice === null && buffer.length >= 2) {
          const prevCandle = buffer[buffer.length - 2];
          if (prevCandle.signal) {
            if (existingPos.side === "long" && prevCandle.signal.type === "sell") { exitPrice = close; exitReason = "REVERSAL"; }
            else if (existingPos.side === "short" && prevCandle.signal.type === "buy") { exitPrice = close; exitReason = "REVERSAL"; }
          }
        }
        
        // 板読み早期利確
        if (exitPrice === null && shouldBoardEarlyExit(existingPos, close, boardSnap)) { exitPrice = close; exitReason = "BOARD_EXIT"; }
        
        // 大引け
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
            session: timeToMinutes(existingPos.entryTime) < 12 * 60 + 30 ? "am" : "pm",
            shares: existingPos.shares,
          });
          openPositions.delete(symbol);
          if (exitReason === "SL") lastStopLossTime.set(symbol, candleTime);
          continue;
        }
      }
      
      // ---- 新規エントリー判定 ----
      if (candleTime < NO_ENTRY_BEFORE) continue;
      if (candleTime >= NO_ENTRY_AFTER) continue;
      if (candleTime >= NO_ENTRY_PRE_LUNCH_START && candleTime < NO_ENTRY_PRE_LUNCH_END) continue;
      if (candleTime >= NO_ENTRY_POST_LUNCH_START && candleTime < NO_ENTRY_POST_LUNCH_END) continue;
      
      // isBullish方式（銘柄別）
      const firstCandle = buffer[0];
      const openPrice = firstCandle?.open ?? close;
      const priceChangeRatio = (close - openPrice) / openPrice * 100;
      const isBullish = priceChangeRatio >= IS_BULLISH_THRESHOLD;
      
      // ---- ステートマシン: 押し目確認 ----
      const pullbackState = pullbackStates.get(symbol);
      if (pullbackState) {
        pullbackState.waitCount++;
        if (low < pullbackState.recentSwingLow) { pullbackStates.delete(symbol); }
        else if (pullbackState.waitCount > PULLBACK_MAX_WAIT) {
          if (boardSignal !== "sell_pressure") {
            const brScore = boardReadingScore("long", boardSnap, bprHist);
            if (brScore >= BOARD_SCORE_THRESHOLD) {
              const entry = tryEnterPosition("long", symbol, close, candleTime, date,
                `${pullbackState.reason} (タイムアウト)`, buffer, bpr, bprHist, openPositions, lastStopLossTime, config);
              if (entry) openPositions.set(symbol, entry);
            }
          }
          pullbackStates.delete(symbol);
        } else {
          if (!pullbackState.pulledBack && close < pullbackState.signalPrice) pullbackState.pulledBack = true;
          if (pullbackState.pulledBack && close > pullbackState.signalPrice) {
            if (boardSignal !== "sell_pressure") {
              const brScore = boardReadingScore("long", boardSnap, bprHist);
              if (brScore >= BOARD_SCORE_THRESHOLD) {
                const entry = tryEnterPosition("long", symbol, close, candleTime, date,
                  `${pullbackState.reason} (押し目確認後)`, buffer, bpr, bprHist, openPositions, lastStopLossTime, config);
                if (entry) openPositions.set(symbol, entry);
              }
            }
            pullbackStates.delete(symbol);
          }
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
        }
        continue;
      }
      
      // ---- ステートマシン: 大台確認後押し目待ち ----
      const roundPb = roundPullbackStates.get(symbol);
      if (roundPb) {
        if (roundPb.direction === "buy" && close < roundPb.level) { roundPullbackStates.delete(symbol); continue; }
        if (roundPb.direction === "sell" && close > roundPb.level) { roundPullbackStates.delete(symbol); continue; }
        roundPb.waitCount++;
        if (roundPb.waitCount > ROUND_PULLBACK_MAX_WAIT) {
          const side = roundPb.direction === "buy" ? "long" as const : "short" as const;
          const oppSignal = side === "long" ? "sell_pressure" : "buy_pressure";
          if (boardSignal !== oppSignal) {
            const brScore = boardReadingScore(side, boardSnap, bprHist);
            if (brScore >= BOARD_SCORE_THRESHOLD) {
              const entry = tryEnterPosition(side, symbol, close, candleTime, date,
                `${roundPb.reason} (タイムアウト)`, buffer, bpr, bprHist, openPositions, lastStopLossTime, config);
              if (entry) openPositions.set(symbol, entry);
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
          const recovered = roundPb.direction === "buy" ? close > roundPb.signalPrice : close < roundPb.signalPrice;
          if (recovered) {
            const side = roundPb.direction === "buy" ? "long" as const : "short" as const;
            const oppSignal = side === "long" ? "sell_pressure" : "buy_pressure";
            if (boardSignal !== oppSignal) {
              const brScore = boardReadingScore(side, boardSnap, bprHist);
              if (brScore >= BOARD_SCORE_THRESHOLD) {
                const entry = tryEnterPosition(side, symbol, close, candleTime, date,
                  `${roundPb.reason} (押し目確認後)`, buffer, bpr, bprHist, openPositions, lastStopLossTime, config);
                if (entry) openPositions.set(symbol, entry);
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
        if (sig.reason.includes("VWAPクロス上抜け")) continue;
        if (boardSignal === "sell_pressure") continue;
        const brScore = boardReadingScore("long", boardSnap, bprHist);
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
          pullbackStates.set(symbol, { recentSwingLow: sig.recentSwingLow, signalPrice: close, waitCount: 0, pulledBack: false, reason: sig.reason });
          continue;
        }
        
        if (sig.reason.startsWith("大台超え")) {
          const m = sig.reason.match(/(\d+(?:\.\d+)?)円/);
          const level = m ? parseFloat(m[1]) : close;
          roundLevelPendingStates.set(symbol, { direction: "buy", level, confirmCount: 0, reason: sig.reason });
          continue;
        }
        
        if (sig.confidence === "medium") continue;
        
        const entry = tryEnterPosition("long", symbol, close, candleTime, date, sig.reason,
          buffer, bpr, bprHist, openPositions, lastStopLossTime, config);
        if (entry) openPositions.set(symbol, entry);
        continue;
      }
      
      // ---- 売りエントリー ----
      if (sig.type === "sell") {
        // 地合いフィルター
        if (config.useB2) {
          // B2方式: bullish時は前場のmedium SHORTのみブロック（後で処理）
          // ここではisBullishブロックなし
        } else {
          // isBullish方式: BULLISH相場ではSHORT全面禁止
          if (isBullish) continue;
        }
        
        if (boardSignal === "buy_pressure") continue;
        
        // VWAP急落フィルター
        if (config.useVwapDropFilter && buffer.length >= 5) {
          const vwapValues: number[] = [];
          for (let i = Math.max(0, buffer.length - 5); i < buffer.length; i++) {
            vwapValues.push(buffer[i].close); // 簡易VWAP代替
          }
          if (vwapValues.length >= 5) {
            const drop5 = ((vwapValues[4] - vwapValues[0]) / vwapValues[0]) * 100;
            if (drop5 <= VWAP_DROP_FILTER_5BARS) continue;
          }
          if (vwapValues.length >= 3) {
            const drop3 = ((vwapValues[vwapValues.length - 1] - vwapValues[vwapValues.length - 3]) / vwapValues[vwapValues.length - 3]) * 100;
            if (drop3 <= VWAP_DROP_FILTER_3BARS) continue;
          }
        }
        
        const brScore = boardReadingScore("short", boardSnap, bprHist);
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
        
        // SHORT medium判定
        if (sig.confidence === "medium") {
          if (config.shortMediumAllow) {
            // B2条件付き許可: 前場bullish時のみブロック
            if (config.useB2 && isAM && b2Direction === "bullish") continue;
            // それ以外は許可（下のエントリーへ進む）
          } else {
            // 全ブロック
            continue;
          }
        }
        
        // 後場BPRフィルター
        if (config.usePmBprFilter && candleTime >= PM_BPR_FILTER_START && bpr !== null && bpr >= PM_BPR_BLOCK_THRESHOLD) continue;
        
        const entry = tryEnterPosition("short", symbol, close, candleTime, date, sig.reason,
          buffer, bpr, bprHist, openPositions, lastStopLossTime, config);
        if (entry) openPositions.set(symbol, entry);
        continue;
      }
    }
    
    // 日末強制決済
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
        exitTime: "15:30", exitPrice: lastClose, pnl, exitReason: "EOD",
        signalReason: pos.entryReason, confidence: pos.confidence,
        session: timeToMinutes(pos.entryTime) < 12 * 60 + 30 ? "am" : "pm",
        shares: pos.shares,
      });
    }
  }
  
  return allTrades;
}

function tryEnterPosition(
  side: "long" | "short", symbol: string, price: number, candleTime: string, date: string, reason: string,
  buffer: CandleWithSignal[], bpr: number | null, bprHist: number[],
  openPositions: Map<string, OpenPosition>, lastStopLossTime: Map<string, string>, config: Config,
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
  
  // 後場BPRフィルター（enterPosition内でも再チェック）
  if (config.usePmBprFilter && side === "short" && candleTime >= PM_BPR_FILTER_START && bpr !== null && bpr >= PM_BPR_BLOCK_THRESHOLD) {
    return null;
  }
  
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
    const confResult = evaluateConfirmation({
      type: side === "long" ? "buy" : "sell",
      close: price, volume: buffer[idx].volume,
      avgVolume: trailingAvgVolume(volumes, idx, 10),
      ma5: buffer[idx]?.ma5 ?? null, ma25: buffer[idx]?.ma25 ?? null,
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
     WHERE tradeDate >= '2026-06-19' AND tradeDate <= '2026-07-03'
     ORDER BY tradeDate`
  ) as any;
  const dates = (dateRows as any[]).map((r: any) => r.tradeDate);
  
  console.log(`=== アブレーションテスト（${dates.length}日間: ${dates[0]}〜${dates[dates.length - 1]}） ===\n`);
  console.log("各機能を個別にON/OFFして影響を測定\n");
  
  // ヘッダー
  console.log("パターン".padEnd(20) + "| 件数 | 勝率   | 総損益        | PF    | 期待値     | SHORT件 | SHORT勝率 | SHORT損益");
  console.log("-".repeat(130));
  
  const results: { name: string; trades: Trade[]; pnl: number; pf: number }[] = [];
  
  for (const config of CONFIGS) {
    const trades = await runSimulation(config, db, dates);
    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
    const wins = trades.filter(t => t.pnl > 0);
    const losses = trades.filter(t => t.pnl < 0);
    const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    const pf = grossLoss > 0 ? grossProfit / grossLoss : 999;
    const winRate = trades.length > 0 ? (wins.length / trades.length * 100) : 0;
    const expectancy = trades.length > 0 ? Math.round(totalPnl / trades.length) : 0;
    
    const shorts = trades.filter(t => t.side === "short");
    const shortWins = shorts.filter(t => t.pnl > 0);
    const shortPnl = shorts.reduce((s, t) => s + t.pnl, 0);
    const shortWinRate = shorts.length > 0 ? (shortWins.length / shorts.length * 100) : 0;
    
    console.log(
      `${config.name.padEnd(20)}| ${trades.length.toString().padStart(4)} | ${winRate.toFixed(1).padStart(5)}% | ` +
      `${(totalPnl >= 0 ? "+" : "")}${totalPnl.toLocaleString().padStart(11)}円 | ${pf.toFixed(2).padStart(5)} | ` +
      `${(expectancy >= 0 ? "+" : "")}${expectancy.toLocaleString().padStart(8)}円 | ` +
      `${shorts.length.toString().padStart(7)} | ${shortWinRate.toFixed(1).padStart(8)}% | ` +
      `${(shortPnl >= 0 ? "+" : "")}${shortPnl.toLocaleString().padStart(10)}円`
    );
    
    results.push({ name: config.name, trades, pnl: totalPnl, pf });
  }
  
  // ---- 各機能の影響度分析 ----
  console.log("\n" + "=".repeat(80));
  console.log("=== 各機能の影響度（Base比） ===\n");
  
  const basePnl = results[0].pnl;
  for (let i = 1; i < results.length; i++) {
    const diff = results[i].pnl - basePnl;
    const diffPct = basePnl !== 0 ? (diff / Math.abs(basePnl) * 100).toFixed(1) : "N/A";
    const impact = diff > 0 ? "✅プラス" : diff < 0 ? "❌マイナス" : "→中立";
    console.log(`${results[i].name.padEnd(20)} → ${impact} ${diff >= 0 ? "+" : ""}${diff.toLocaleString()}円 (${diffPct}%)`);
  }
  
  // ---- 日別比較 ----
  console.log("\n" + "=".repeat(80));
  console.log("=== 日別損益比較 ===\n");
  console.log("日付".padEnd(12) + CONFIGS.map(c => c.name.substring(0, 10).padEnd(12)).join(""));
  console.log("-".repeat(12 + CONFIGS.length * 12));
  
  for (const date of dates) {
    let line = date.padEnd(12);
    for (const r of results) {
      const dayTrades = r.trades.filter(t => t.date === date);
      const dayPnl = dayTrades.reduce((s, t) => s + t.pnl, 0);
      const pnlStr = dayPnl === 0 ? "0" : `${dayPnl >= 0 ? "+" : ""}${(dayPnl / 1000).toFixed(0)}k`;
      line += pnlStr.padEnd(12);
    }
    console.log(line);
  }
  
  process.exit(0);
}

main();
