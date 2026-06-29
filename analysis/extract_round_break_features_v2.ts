/**
 * 大台割れ全件抽出 V2 - 全8日分を正しく処理
 * rt_candlesから日付/銘柄ごとにクエリして特徴量を計算
 */
import { getDb } from '../server/db';
import { rtCandles } from '../drizzle/schema';
import { sql } from 'drizzle-orm';
import * as fs from 'fs';

// --- Constants (現行仕様) ---
const WARMUP_BARS = 10;
const ATR_BLOCK_THRESHOLD = 0.0012;
const SLOPE_THRESHOLD = 0.0002;
const STOP_LOSS_RATIO = 0.005;
const TAKE_PROFIT_RATIO = 0.015;
const BREAKEVEN_TRIGGER = 0.005;
const TRAIL_TRIGGER = 0.01;
const TRAIL_GAP = 0.005;
const SHORT_MAX_HOLD_BARS = 60;
const INITIAL_CAPITAL = 3_000_000;
const LOT_RATIO = 0.33;

interface Bar {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  atr?: number;
  ma5?: number;
  ma25?: number;
  rsi?: number;
  bbUpper?: number;
  bbLower?: number;
  bbMid?: number;
  vwap?: number;
  adx?: number;
  board?: {
    buyPressureRatio: number;
    largeBuyWall: boolean;
    largeSellWall: boolean;
    signal: string;
    score?: number;
  } | null;
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
  timeMinutes: number;
  hour: number;
  volumeRatio: number;
  atrRatio: number;
  adx: number;
  boardScore: number;
  buyPressureRatio: number;
  slope: number;
  vwapDeviation: number;
  rsi: number;
  bbPosition: number;
  barsAboveRound: number;
  regime: string;
  boardSignal: string;
  largeBuyWall: boolean;
  largeSellWall: boolean;
  ma5_above_ma25_5m: boolean;
}

function computeIndicators(bars: Bar[]) {
  // ATR (14)
  for (let i = 1; i < bars.length; i++) {
    const tr = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close)
    );
    if (i < 14) {
      bars[i].atr = tr;
    } else if (i === 14) {
      let sum = 0;
      for (let j = 1; j <= 14; j++) {
        sum += Math.max(bars[j].high - bars[j].low, Math.abs(bars[j].high - bars[j - 1].close), Math.abs(bars[j].low - bars[j - 1].close));
      }
      bars[i].atr = sum / 14;
    } else {
      bars[i].atr = ((bars[i - 1].atr || tr) * 13 + tr) / 14;
    }
  }

  // MA5, MA25
  for (let i = 0; i < bars.length; i++) {
    if (i >= 4) {
      let sum = 0;
      for (let j = i - 4; j <= i; j++) sum += bars[j].close;
      bars[i].ma5 = sum / 5;
    }
    if (i >= 24) {
      let sum = 0;
      for (let j = i - 24; j <= i; j++) sum += bars[j].close;
      bars[i].ma25 = sum / 25;
    }
  }

  // RSI (14)
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i < bars.length; i++) {
    const change = bars[i].close - bars[i - 1].close;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    if (i <= 14) {
      avgGain += gain / 14;
      avgLoss += loss / 14;
      bars[i].rsi = i === 14 ? (avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)) : 50;
    } else {
      avgGain = (avgGain * 13 + gain) / 14;
      avgLoss = (avgLoss * 13 + loss) / 14;
      bars[i].rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
  }

  // Bollinger Bands (20, 2)
  for (let i = 19; i < bars.length; i++) {
    let sum = 0;
    for (let j = i - 19; j <= i; j++) sum += bars[j].close;
    const mean = sum / 20;
    let variance = 0;
    for (let j = i - 19; j <= i; j++) variance += (bars[j].close - mean) ** 2;
    const std = Math.sqrt(variance / 20);
    bars[i].bbMid = mean;
    bars[i].bbUpper = mean + 2 * std;
    bars[i].bbLower = mean - 2 * std;
  }

  // VWAP
  let cumVol = 0, cumPV = 0;
  for (let i = 0; i < bars.length; i++) {
    const typical = (bars[i].high + bars[i].low + bars[i].close) / 3;
    cumVol += bars[i].volume;
    cumPV += typical * bars[i].volume;
    bars[i].vwap = cumVol > 0 ? cumPV / cumVol : bars[i].close;
  }

  // ADX (14) - simplified
  let prevPlusDM = 0, prevMinusDM = 0, prevTR = 0;
  let adxSmooth = 0;
  for (let i = 1; i < bars.length; i++) {
    const highDiff = bars[i].high - bars[i - 1].high;
    const lowDiff = bars[i - 1].low - bars[i].low;
    const plusDM = highDiff > lowDiff && highDiff > 0 ? highDiff : 0;
    const minusDM = lowDiff > highDiff && lowDiff > 0 ? lowDiff : 0;
    const tr = Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - bars[i - 1].close), Math.abs(bars[i].low - bars[i - 1].close));

    if (i <= 14) {
      prevPlusDM += plusDM;
      prevMinusDM += minusDM;
      prevTR += tr;
      if (i === 14) {
        prevPlusDM /= 14; prevMinusDM /= 14; prevTR /= 14;
      }
    } else {
      prevPlusDM = (prevPlusDM * 13 + plusDM) / 14;
      prevMinusDM = (prevMinusDM * 13 + minusDM) / 14;
      prevTR = (prevTR * 13 + tr) / 14;
    }

    if (i >= 14 && prevTR > 0) {
      const plusDI = (prevPlusDM / prevTR) * 100;
      const minusDI = (prevMinusDM / prevTR) * 100;
      const dx = Math.abs(plusDI - minusDI) / (plusDI + minusDI + 0.0001) * 100;
      if (i === 14) {
        adxSmooth = dx;
      } else {
        adxSmooth = (adxSmooth * 13 + dx) / 14;
      }
      bars[i].adx = adxSmooth;
    }
  }
}

function getSlope(bars: Bar[], i: number): number {
  const lookback = Math.min(5, i);
  if (lookback === 0) return 0;
  return (bars[i].close - bars[i - lookback].close) / bars[i - lookback].close / lookback;
}

function getRegime(bars: Bar[], i: number): string {
  if (!bars[i].ma5 || !bars[i].ma25) return 'neutral';
  const slope = getSlope(bars, i);
  if (bars[i].ma5 > bars[i].ma25 && slope > SLOPE_THRESHOLD) return 'up';
  if (bars[i].ma5 < bars[i].ma25 && slope < -SLOPE_THRESHOLD) return 'down';
  return 'neutral';
}

function getBoardScore(board: Bar['board']): number {
  if (!board) return 0;
  let score = 0;
  if (board.signal === 'sell_pressure') score++;
  if (board.buyPressureRatio < 0.8) score++;
  if (board.largeSellWall) score++;
  return score;
}

function get5mMA(bars: Bar[], i: number): { ma5_5m: number; ma25_5m: number } | null {
  // Build 5-minute bars up to current position
  const fiveMinBars: number[] = [];
  for (let j = 0; j <= i; j += 5) {
    const end = Math.min(j + 4, i);
    fiveMinBars.push(bars[end].close);
  }
  if (fiveMinBars.length < 25) return null;
  const ma5 = fiveMinBars.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const ma25 = fiveMinBars.slice(-25).reduce((a, b) => a + b, 0) / 25;
  return { ma5_5m: ma5, ma25_5m: ma25 };
}

async function main() {
  const db = await getDb();

  // Get all date/symbol combinations
  const dateSym = await db.select({
    tradeDate: rtCandles.tradeDate,
    symbol: rtCandles.symbol,
  }).from(rtCandles).groupBy(rtCandles.tradeDate, rtCandles.symbol).orderBy(rtCandles.tradeDate, rtCandles.symbol);

  const dates = [...new Set(dateSym.map(r => r.tradeDate))].sort();
  console.log(`Processing ${dates.length} dates...`);

  const allFeatures: TradeFeatures[] = [];

  for (const date of dates) {
    const symbols = dateSym.filter(r => r.tradeDate === date).map(r => r.symbol);
    let dateSignals = 0;

    for (const symbol of symbols) {
      const rawCandles = await db.select().from(rtCandles)
        .where(sql`${rtCandles.tradeDate} = ${date} AND ${rtCandles.symbol} = ${symbol}`)
        .orderBy(rtCandles.candleTime);

      if (rawCandles.length < 30) continue;

      const bars: Bar[] = rawCandles.map(c => {
        const boardData = c.boardSnapshot as any;
        let board: Bar['board'] = null;
        if (boardData && typeof boardData === 'object') {
          board = {
            buyPressureRatio: boardData.buyPressureRatio || 0.5,
            largeBuyWall: !!boardData.largeBuyWall,
            largeSellWall: !!boardData.largeSellWall,
            signal: boardData.signal || 'neutral',
          };
          board.score = getBoardScore(board);
        }
        return {
          time: c.candleTime,
          open: Number(c.open),
          high: Number(c.high),
          low: Number(c.low),
          close: Number(c.close),
          volume: Number(c.volume),
          board,
        };
      });

      computeIndicators(bars);

      // Detect round number break signals
      for (let i = WARMUP_BARS; i < bars.length; i++) {
        const curr = bars[i];
        const prev = bars[i - 1];
        const slope = getSlope(bars, i);
        const atrRatio = curr.atr ? curr.atr / curr.close : 0;
        if (atrRatio < ATR_BLOCK_THRESHOLD) continue;
        if (slope > SLOPE_THRESHOLD * 3) continue;

        const avgVol = (() => {
          let sum = 0;
          const n = Math.min(10, i);
          for (let j = i - n; j < i; j++) sum += bars[j].volume;
          return sum / n;
        })();
        if (curr.volume < avgVol * 0.8) continue;

        // Round number break detection
        const roundUnit = curr.close >= 10000 ? 100 : curr.close >= 1000 ? 100 : 10;
        const prevRound = Math.ceil(prev.close / roundUnit) * roundUnit;
        const currRoundNum = Math.ceil(curr.close / roundUnit) * roundUnit;

        if (currRoundNum < prevRound && curr.close < prevRound - roundUnit * 0.1) {
          let maintained = true;
          let barsAbove = 0;
          for (let j = Math.max(0, i - 9); j < i; j++) {
            if (bars[j].close <= prevRound) barsAbove++;
            if (bars[j].close > prevRound) { maintained = false; break; }
          }
          if (!maintained || slope > 0) continue;

          // Signal detected - simulate trade
          const shares = Math.floor((INITIAL_CAPITAL * LOT_RATIO) / curr.close / 100) * 100;
          if (shares <= 0) continue;

          const entryPrice = curr.close;
          let lowWater = entryPrice;
          let exitPrice = entryPrice;
          let pnl = 0;
          let win = false;

          for (let k = i + 1; k < Math.min(i + SHORT_MAX_HOLD_BARS, bars.length); k++) {
            const bar = bars[k];
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
            if (k === Math.min(i + SHORT_MAX_HOLD_BARS - 1, bars.length - 1)) {
              exitPrice = bar.close; pnl = (entryPrice - bar.close) * shares; win = pnl > 0; break;
            }
          }

          // Compute features
          const timeParts = curr.time.split(':');
          const timeMinutes = parseInt(timeParts[0]) * 60 + parseInt(timeParts[1]);
          const boardScore = curr.board ? getBoardScore(curr.board) : 0;
          const vwapDev = curr.vwap ? (curr.close - curr.vwap) / curr.vwap : 0;
          const bbPos = (curr.bbUpper && curr.bbLower) ?
            (curr.close - curr.bbLower) / (curr.bbUpper - curr.bbLower) : 0.5;
          const regime = getRegime(bars, i);
          const ma5m = get5mMA(bars, i);
          const ma5AboveMa25_5m = ma5m ? ma5m.ma5_5m > ma5m.ma25_5m : false;

          allFeatures.push({
            date,
            symbol,
            entryTime: curr.time,
            entryPrice,
            exitPrice,
            pnl: Math.round(pnl),
            win,
            timeMinutes,
            hour: parseInt(timeParts[0]),
            volumeRatio: avgVol > 0 ? curr.volume / avgVol : 1,
            atrRatio,
            adx: curr.adx || 0,
            boardScore,
            buyPressureRatio: curr.board?.buyPressureRatio || 0.5,
            slope,
            vwapDeviation: vwapDev,
            rsi: curr.rsi || 50,
            bbPosition: bbPos,
            barsAboveRound: barsAbove,
            regime,
            boardSignal: curr.board?.signal || 'neutral',
            largeBuyWall: curr.board?.largeBuyWall || false,
            largeSellWall: curr.board?.largeSellWall || false,
            ma5_above_ma25_5m: ma5AboveMa25_5m,
          });
          dateSignals++;
        }
      }
    }
    console.log(`  ${date}: ${dateSignals} signals`);
  }

  console.log(`\nTotal round_number_break trades: ${allFeatures.length}`);
  console.log(`  Wins: ${allFeatures.filter(f => f.win).length}`);
  console.log(`  Losses: ${allFeatures.filter(f => !f.win).length}`);
  console.log(`  Total P&L: ${allFeatures.reduce((s, f) => s + f.pnl, 0).toLocaleString()}円`);

  fs.writeFileSync('analysis/round_break_features_v2.json', JSON.stringify(allFeatures, null, 2));
  console.log('Saved to: analysis/round_break_features_v2.json');

  // CSV
  const header = Object.keys(allFeatures[0]).join(',');
  const rows = allFeatures.map(f => Object.values(f).join(','));
  fs.writeFileSync('analysis/round_break_features_v2.csv', [header, ...rows].join('\n'));
  console.log('CSV saved to: analysis/round_break_features_v2.csv');

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
