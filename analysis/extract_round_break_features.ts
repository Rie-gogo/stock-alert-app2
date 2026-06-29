/**
 * extract_round_break_features.ts
 * 
 * 現行72件の大台割れ取引を全件抽出し、各取引のエントリー時点での特徴量を計算。
 * CSVとJSONで出力し、Python側でML分析に使用する。
 */

import { getDb } from "../server/db";
import { rtCandles } from "../drizzle/schema";
import { asc } from "drizzle-orm";
import * as fs from "fs";

// ============================================================
// 定数
// ============================================================
const INITIAL_CAPITAL = 3_000_000;
const STOP_LOSS_RATIO = 0.005;
const TAKE_PROFIT_RATIO = 0.015;
const TRAIL_TRIGGER = 0.01;
const TRAIL_GAP = 0.005;
const BREAKEVEN_TRIGGER = 0.005;
const LOT_RATIO = 0.30;
const MAX_TRADES_PER_DAY = 10;
const WARMUP_BARS = 10;
const SHORT_MAX_HOLD_BARS = 60;
const SLOPE_THRESHOLD = 0.0001;
const ATR_BLOCK_THRESHOLD = 0.0012;

// ============================================================
// Types
// ============================================================
interface BoardData {
  signal: string;
  buyPressureRatio: number;
  largeBuyWall: boolean;
  largeSellWall: boolean;
  totalAskQty: number;
  totalBidQty: number;
  icebergAskDetected: boolean;
  icebergBidDetected: boolean;
  marketOrderDirection: string;
}

interface Candle {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  board?: BoardData;
  ma5?: number;
  ma25?: number;
  rsi?: number;
  vwap?: number;
  bbUpper?: number;
  bbLower?: number;
  atr?: number;
}

interface TradeFeatures {
  date: string;
  symbol: string;
  entryTime: string;
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  win: boolean;
  // Features
  hour: number;
  minute: number;
  timeMinutes: number;
  volumeRatio: number;
  atrRatio: number;
  adx: number;
  boardScore: number;
  boardSignal: string;
  buyPressureRatio: number;
  largeBuyWall: boolean;
  largeSellWall: boolean;
  regime: string;
  slope: number;
  vwapDeviation: number;
  ma5_above_ma25_5m: boolean;
  ma5_5m: number;
  ma25_5m: number;
  rsi: number;
  bbPosition: number;
  roundUnit: number;
  barsAboveRound: number;
}

// ============================================================
// Indicators
// ============================================================
function computeIndicators(candles: Candle[]): void {
  let cumPV = 0, cumVol = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const tp = (c.high + c.low + c.close) / 3;
    cumPV += tp * c.volume;
    cumVol += c.volume;
    c.vwap = cumVol > 0 ? cumPV / cumVol : c.close;
  }
  for (let i = 0; i < candles.length; i++) {
    if (i >= 4) {
      let sum = 0;
      for (let j = i - 4; j <= i; j++) sum += candles[j].close;
      candles[i].ma5 = sum / 5;
    }
    if (i >= 24) {
      let sum = 0;
      for (let j = i - 24; j <= i; j++) sum += candles[j].close;
      candles[i].ma25 = sum / 25;
    }
  }
  for (let i = 14; i < candles.length; i++) {
    let gains = 0, losses = 0;
    for (let j = i - 13; j <= i; j++) {
      const diff = candles[j].close - candles[j - 1].close;
      if (diff > 0) gains += diff; else losses -= diff;
    }
    const avgGain = gains / 14, avgLoss = losses / 14;
    candles[i].rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  for (let i = 19; i < candles.length; i++) {
    let sum = 0;
    for (let j = i - 19; j <= i; j++) sum += candles[j].close;
    const mean = sum / 20;
    let sqSum = 0;
    for (let j = i - 19; j <= i; j++) sqSum += (candles[j].close - mean) ** 2;
    const std = Math.sqrt(sqSum / 20);
    candles[i].bbUpper = mean + 2 * std;
    candles[i].bbLower = mean - 2 * std;
  }
  for (let i = 1; i < candles.length; i++) {
    const tr = Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - candles[i - 1].close), Math.abs(candles[i].low - candles[i - 1].close));
    (candles[i] as any)._tr = tr;
  }
  for (let i = 14; i < candles.length; i++) {
    let sum = 0;
    for (let j = i - 13; j <= i; j++) sum += (candles[j] as any)._tr || 0;
    candles[i].atr = sum / 14;
  }
}

function computeADX(candles: Candle[], i: number, period = 14): number {
  if (i < period * 2) return 0;
  let plusDMs: number[] = [];
  let minusDMs: number[] = [];
  let trs: number[] = [];
  for (let j = i - period * 2 + 1; j <= i; j++) {
    const upMove = candles[j].high - candles[j - 1].high;
    const downMove = candles[j - 1].low - candles[j].low;
    plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0);
    trs.push(Math.max(candles[j].high - candles[j].low, Math.abs(candles[j].high - candles[j - 1].close), Math.abs(candles[j].low - candles[j - 1].close)));
  }
  // Smoothed
  let smoothPlusDM = plusDMs.slice(0, period).reduce((a, b) => a + b, 0);
  let smoothMinusDM = minusDMs.slice(0, period).reduce((a, b) => a + b, 0);
  let smoothTR = trs.slice(0, period).reduce((a, b) => a + b, 0);
  let dxValues: number[] = [];
  for (let k = period; k < plusDMs.length; k++) {
    smoothPlusDM = smoothPlusDM - smoothPlusDM / period + plusDMs[k];
    smoothMinusDM = smoothMinusDM - smoothMinusDM / period + minusDMs[k];
    smoothTR = smoothTR - smoothTR / period + trs[k];
    const plusDI = smoothTR > 0 ? (smoothPlusDM / smoothTR) * 100 : 0;
    const minusDI = smoothTR > 0 ? (smoothMinusDM / smoothTR) * 100 : 0;
    const diSum = plusDI + minusDI;
    const dx = diSum > 0 ? (Math.abs(plusDI - minusDI) / diSum) * 100 : 0;
    dxValues.push(dx);
  }
  if (dxValues.length === 0) return 0;
  return dxValues.reduce((a, b) => a + b, 0) / dxValues.length;
}

function getSlope(candles: Candle[], i: number, period = 10): number {
  if (i < period) return 0;
  return (candles[i].close - candles[i - period].close) / candles[i - period].close / period;
}

function trailingAvgVolume(candles: Candle[], i: number, period: number): number {
  if (i < period) return candles[i].volume || 1;
  let sum = 0;
  for (let j = i - period; j < i; j++) sum += candles[j].volume;
  return (sum / period) || 1;
}

function computeBoardScore(board: BoardData | undefined): number {
  if (!board) return 0;
  let score = 0;
  if (board.signal === "sell_pressure") score++;
  if (board.totalAskQty > board.totalBidQty * 1.2) score++;
  if (board.icebergAskDetected) score++;
  if (board.largeSellWall) score++;
  if (board.marketOrderDirection === "sell") score++;
  return score;
}

function build5mMA(candles1m: Candle[], barIdx: number): { ma5: number; ma25: number } {
  // Build 5m candles up to current bar
  const bars5m: { close: number }[] = [];
  for (let i = 0; i <= barIdx; i += 5) {
    const end = Math.min(i + 5, barIdx + 1);
    if (end <= i) continue;
    const chunk = candles1m.slice(i, end);
    bars5m.push({ close: chunk[chunk.length - 1].close });
  }
  let ma5 = 0, ma25 = 0;
  const len = bars5m.length;
  if (len >= 5) {
    let sum = 0;
    for (let j = len - 5; j < len; j++) sum += bars5m[j].close;
    ma5 = sum / 5;
  }
  if (len >= 25) {
    let sum = 0;
    for (let j = len - 25; j < len; j++) sum += bars5m[j].close;
    ma25 = sum / 25;
  }
  return { ma5, ma25 };
}

// ============================================================
// Main
// ============================================================
async function main() {
  const db = await getDb();
  if (!db) { console.error("DB not available"); process.exit(1); }

  const allCandles = await db.select().from(rtCandles).orderBy(asc(rtCandles.tradeDate), asc(rtCandles.candleTime));
  console.log(`Total candles: ${allCandles.length}`);

  // Group by date/symbol
  const grouped: Record<string, Record<string, Candle[]>> = {};
  for (const c of allCandles) {
    if (!grouped[c.tradeDate]) grouped[c.tradeDate] = {};
    if (!grouped[c.tradeDate][c.symbol]) grouped[c.tradeDate][c.symbol] = [];
    const board = c.boardSnapshot ? (c.boardSnapshot as any as BoardData) : undefined;
    grouped[c.tradeDate][c.symbol].push({
      time: c.candleTime, open: Number(c.open), high: Number(c.high),
      low: Number(c.low), close: Number(c.close), volume: Number(c.volume),
      board,
    });
  }

  const dates = Object.keys(grouped).sort();
  console.log(`Dates: ${dates.join(", ")}`);

  const allFeatures: TradeFeatures[] = [];

  for (const date of dates) {
    for (const symbol of Object.keys(grouped[date])) {
      const candles = grouped[date][symbol];
      if (candles.length < 30) continue;
      computeIndicators(candles);

      // Extract ALL round_number_break signals independently
      // Each signal is simulated in isolation to capture all occurrences
      for (let i = WARMUP_BARS; i < candles.length; i++) {
        const curr = candles[i];
        const prev = candles[i - 1];
        const slope = getSlope(candles, i);
        const atrRatio = curr.atr ? curr.atr / curr.close : 0;
        if (atrRatio < ATR_BLOCK_THRESHOLD) continue;
        const isStrongUp = slope > SLOPE_THRESHOLD * 3;
        if (isStrongUp) continue;
        const avgVol = trailingAvgVolume(candles, i, 10);
        const volConfirmed = curr.volume >= avgVol * 0.8;
        if (!volConfirmed) continue;

        // Round number break detection
        const roundUnit = curr.close >= 10000 ? 100 : curr.close >= 1000 ? 100 : 10;
        const prevRound = Math.ceil(prev.close / roundUnit) * roundUnit;
        const currRoundNum = Math.ceil(curr.close / roundUnit) * roundUnit;
        if (currRoundNum < prevRound && curr.close < prevRound - roundUnit * 0.1) {
          let maintained = true;
          for (let j = Math.max(0, i - 4); j < i; j++) {
            if (candles[j].close > prevRound) { maintained = false; break; }
          }
          if (maintained && slope <= 0) {
            // Signal detected - simulate this trade independently
            const shares = Math.floor((INITIAL_CAPITAL * LOT_RATIO) / curr.close / 100) * 100;
            if (shares <= 0) continue;
            const entryPrice = curr.close;
            let lowWater = entryPrice;
            let exitPrice = entryPrice;
            let pnl = 0;
            let win = false;

            // Simulate exit
            for (let k = i + 1; k < Math.min(i + SHORT_MAX_HOLD_BARS, candles.length); k++) {
              const bar = candles[k];
              if (bar.close < lowWater) lowWater = bar.close;
              const gain = (entryPrice - lowWater) / entryPrice;
              let stopPrice = entryPrice * (1 + STOP_LOSS_RATIO);
              if (gain >= TRAIL_TRIGGER) {
                stopPrice = lowWater * (1 + TRAIL_GAP);
              } else if (gain >= BREAKEVEN_TRIGGER) {
                stopPrice = Math.min(stopPrice, entryPrice);
              }
              const profitRate = (entryPrice - bar.close) / entryPrice;
              if (profitRate >= TAKE_PROFIT_RATIO) {
                exitPrice = bar.close; pnl = (entryPrice - bar.close) * shares; win = true; break;
              }
              if (bar.close >= stopPrice) {
                exitPrice = bar.close; pnl = (entryPrice - bar.close) * shares; win = pnl > 0; break;
              }
              if (k === Math.min(i + SHORT_MAX_HOLD_BARS - 1, candles.length - 1)) {
                exitPrice = bar.close; pnl = (entryPrice - bar.close) * shares; win = pnl > 0; break;
              }
            }

            const [h, m] = curr.time.split(":").map(Number);
            const timeMinutes = h * 60 + m;
            const volumeRatio = curr.volume / avgVol;
            const adx = computeADX(candles, i);
            const boardScore = computeBoardScore(curr.board);
            const regime = slope < -SLOPE_THRESHOLD ? "down" : slope > SLOPE_THRESHOLD ? "up" : "neutral";
            const vwapDev = curr.vwap ? (curr.close - curr.vwap) / curr.vwap : 0;
            const { ma5: ma5_5m, ma25: ma25_5m } = build5mMA(candles, i);
            const bbPos = (curr.bbUpper && curr.bbLower) ? (curr.close - curr.bbLower) / (curr.bbUpper - curr.bbLower) : 0.5;

            // Count bars below round
            let barsAbove = 0;
            for (let j = Math.max(0, i - 10); j < i; j++) {
              if (candles[j].close <= prevRound) barsAbove++;
            }

            allFeatures.push({
              date, symbol, entryTime: curr.time, entryPrice, exitPrice, pnl, win,
              hour: h, minute: m, timeMinutes,
              volumeRatio,
              atrRatio,
              adx,
              boardScore,
              boardSignal: curr.board?.signal || "none",
              buyPressureRatio: curr.board?.buyPressureRatio || 0,
              largeBuyWall: curr.board?.largeBuyWall || false,
              largeSellWall: curr.board?.largeSellWall || false,
              regime,
              slope,
              vwapDeviation: vwapDev,
              ma5_above_ma25_5m: ma5_5m > 0 && ma25_5m > 0 && ma5_5m > ma25_5m,
              ma5_5m, ma25_5m,
              rsi: curr.rsi || 50,
              bbPosition: bbPos,
              roundUnit,
              barsAboveRound: barsAbove,
            });
          }
        }
      }
    }
  }

  console.log(`\nTotal round_number_break trades: ${allFeatures.length}`);
  console.log(`  Wins: ${allFeatures.filter(f => f.win).length}`);
  console.log(`  Losses: ${allFeatures.filter(f => !f.win).length}`);

  // Save as JSON
  const outPath = "/home/ubuntu/stock-alert-app/analysis/round_break_features.json";
  fs.writeFileSync(outPath, JSON.stringify(allFeatures, null, 2));
  console.log(`Saved to: ${outPath}`);

  // Save as CSV
  const csvPath = "/home/ubuntu/stock-alert-app/analysis/round_break_features.csv";
  const headers = Object.keys(allFeatures[0]);
  const csvLines = [headers.join(",")];
  for (const f of allFeatures) {
    csvLines.push(headers.map(h => {
      const v = (f as any)[h];
      if (typeof v === "boolean") return v ? "1" : "0";
      if (typeof v === "string") return `"${v}"`;
      return String(v);
    }).join(","));
  }
  fs.writeFileSync(csvPath, csvLines.join("\n"));
  console.log(`CSV saved to: ${csvPath}`);

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
