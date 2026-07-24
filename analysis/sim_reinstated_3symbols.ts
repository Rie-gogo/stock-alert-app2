/**
 * 復活3銘柄（6920, 6758, 8316）の過去20営業日シミュレーション
 * 既存のrealtimeSimEngineのロジックを参考に、SL=0.5%, TP=1.5%, EOD=15:25で計算
 */
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { sql } from "drizzle-orm";

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const pool = mysql.createPool(DATABASE_URL);
const db = drizzle(pool);

const SYMBOLS = ['6920', '6758', '8316'];
const SL_PCT = 0.005; // 0.5%
const TP_PCT = 0.015; // 1.5%
const POSITION_SIZE = 3_000_000; // 300万円

interface Candle {
  symbol: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: string;
}

interface Trade {
  symbol: string;
  direction: 'LONG' | 'SHORT';
  entryPrice: number;
  entryTime: string;
  exitPrice: number;
  exitTime: string;
  exitReason: string;
  pnl: number;
}

// Get all available trade dates for our symbols
async function getAvailableDates(): Promise<string[]> {
  const result = await db.execute(sql`
    SELECT DISTINCT tradeDate
    FROM rt_candles
    WHERE symbol IN ('6920', '6758', '8316')
    ORDER BY tradeDate DESC
    LIMIT 20
  `);
  return (result[0] as any[]).map(r => r.tradeDate).reverse();
}

// Get candles for a symbol on a specific date
async function getCandles(symbol: string, tradeDate: string): Promise<Candle[]> {
  const result = await db.execute(sql`
    SELECT symbol, open, high, low, close, volume, candleTime
    FROM rt_candles
    WHERE symbol = ${symbol} AND tradeDate = ${tradeDate}
    ORDER BY candleTime ASC
  `);
  return (result[0] as any[]).map(r => ({
    symbol: r.symbol,
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
    volume: Number(r.volume),
    timestamp: r.candleTime,
  }));
}

// Simple signal detection (大台割れ/超え + VWAP cross simplified)
function detectSignals(candles: Candle[], idx: number): { direction: 'LONG' | 'SHORT' } | null {
  if (idx < 25) return null; // Need enough history for MA
  
  const current = candles[idx];
  const prev = candles[idx - 1];
  if (!current || !prev) return null;
  
  // Skip if before 9:05 or after 15:20
  const time = current.timestamp;
  if (time < '09:05' || time > '15:20') return null;
  
  // Calculate MA5 and MA25
  const closes5 = candles.slice(idx - 4, idx + 1).map(c => c.close);
  const closes25 = candles.slice(idx - 24, idx + 1).map(c => c.close);
  const ma5 = closes5.reduce((a, b) => a + b, 0) / 5;
  const ma25 = closes25.reduce((a, b) => a + b, 0) / 25;
  
  // Calculate VWAP
  let cumVol = 0, cumPV = 0;
  for (let i = 0; i <= idx; i++) {
    const typical = (candles[i].high + candles[i].low + candles[i].close) / 3;
    cumVol += candles[i].volume;
    cumPV += typical * candles[i].volume;
  }
  const vwap = cumVol > 0 ? cumPV / cumVol : current.close;
  
  // 大台割れ (SHORT signal): price breaks below round number
  const price = current.close;
  const roundNumbers = getRoundNumbers(price);
  for (const round of roundNumbers) {
    const distPct = Math.abs(price - round) / round;
    if (distPct > 0.008) continue; // 0.8% filter
    
    if (prev.close >= round && current.close < round) {
      // 大台割れ - SHORT signal
      if (ma5 < ma25 && price < vwap) {
        return { direction: 'SHORT' };
      }
    }
    if (prev.close <= round && current.close > round) {
      // 大台超え - LONG signal
      if (ma5 > ma25 && price > vwap) {
        return { direction: 'LONG' };
      }
    }
  }
  
  // VWAP cross
  const prevVwap = (() => {
    let cv = 0, cpv = 0;
    for (let i = 0; i <= idx - 1; i++) {
      const typical = (candles[i].high + candles[i].low + candles[i].close) / 3;
      cv += candles[i].volume;
      cpv += typical * candles[i].volume;
    }
    return cv > 0 ? cpv / cv : prev.close;
  })();
  
  if (prev.close < prevVwap && current.close > vwap && ma5 > ma25) {
    return { direction: 'LONG' };
  }
  if (prev.close > prevVwap && current.close < vwap && ma5 < ma25) {
    return { direction: 'SHORT' };
  }
  
  return null;
}

function getRoundNumbers(price: number): number[] {
  const results: number[] = [];
  if (price >= 10000) {
    const base = Math.round(price / 1000) * 1000;
    results.push(base - 1000, base, base + 1000);
  } else if (price >= 1000) {
    const base = Math.round(price / 100) * 100;
    results.push(base - 100, base, base + 100);
  } else {
    const base = Math.round(price / 50) * 50;
    results.push(base - 50, base, base + 50);
  }
  return results;
}

// Simulate trades for a symbol on a given day
function simulateDay(candles: Candle[]): Trade[] {
  const trades: Trade[] = [];
  let inPosition = false;
  let entryPrice = 0;
  let entryTime = '';
  let direction: 'LONG' | 'SHORT' = 'LONG';
  let slPrice = 0;
  let tpPrice = 0;
  
  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    
    // Force close at 15:25
    if (inPosition && candle.timestamp >= '15:25') {
      const exitPrice = candle.open;
      const lots = Math.floor(POSITION_SIZE / entryPrice);
      const pnl = direction === 'LONG'
        ? (exitPrice - entryPrice) * lots
        : (entryPrice - exitPrice) * lots;
      trades.push({
        symbol: candle.symbol,
        direction,
        entryPrice,
        entryTime,
        exitPrice,
        exitTime: candle.timestamp,
        exitReason: 'EOD',
        pnl: Math.round(pnl),
      });
      inPosition = false;
      continue;
    }
    
    // Check SL/TP if in position
    if (inPosition) {
      if (direction === 'LONG') {
        if (candle.low <= slPrice) {
          const lots = Math.floor(POSITION_SIZE / entryPrice);
          const pnl = (slPrice - entryPrice) * lots;
          trades.push({ symbol: candle.symbol, direction, entryPrice, entryTime, exitPrice: slPrice, exitTime: candle.timestamp, exitReason: 'SL', pnl: Math.round(pnl) });
          inPosition = false;
        } else if (candle.high >= tpPrice) {
          const lots = Math.floor(POSITION_SIZE / entryPrice);
          const pnl = (tpPrice - entryPrice) * lots;
          trades.push({ symbol: candle.symbol, direction, entryPrice, entryTime, exitPrice: tpPrice, exitTime: candle.timestamp, exitReason: 'TP', pnl: Math.round(pnl) });
          inPosition = false;
        }
      } else {
        if (candle.high >= slPrice) {
          const lots = Math.floor(POSITION_SIZE / entryPrice);
          const pnl = (entryPrice - slPrice) * lots;
          trades.push({ symbol: candle.symbol, direction, entryPrice, entryTime, exitPrice: slPrice, exitTime: candle.timestamp, exitReason: 'SL', pnl: Math.round(pnl) });
          inPosition = false;
        } else if (candle.low <= tpPrice) {
          const lots = Math.floor(POSITION_SIZE / entryPrice);
          const pnl = (entryPrice - tpPrice) * lots;
          trades.push({ symbol: candle.symbol, direction, entryPrice, entryTime, exitPrice: tpPrice, exitTime: candle.timestamp, exitReason: 'TP', pnl: Math.round(pnl) });
          inPosition = false;
        }
      }
      continue;
    }
    
    // Detect signal if not in position
    const signal = detectSignals(candles, i);
    if (signal && !inPosition) {
      direction = signal.direction;
      entryPrice = candle.close;
      entryTime = candle.timestamp;
      inPosition = true;
      
      if (direction === 'LONG') {
        slPrice = entryPrice * (1 - SL_PCT);
        tpPrice = entryPrice * (1 + TP_PCT);
      } else {
        slPrice = entryPrice * (1 + SL_PCT);
        tpPrice = entryPrice * (1 - TP_PCT);
      }
    }
  }
  
  // Close any remaining position at last candle
  if (inPosition && candles.length > 0) {
    const lastCandle = candles[candles.length - 1];
    const lots = Math.floor(POSITION_SIZE / entryPrice);
    const pnl = direction === 'LONG'
      ? (lastCandle.close - entryPrice) * lots
      : (entryPrice - lastCandle.close) * lots;
    trades.push({
      symbol: lastCandle.symbol,
      direction,
      entryPrice,
      entryTime,
      exitPrice: lastCandle.close,
      exitTime: lastCandle.timestamp,
      exitReason: 'EOD_FINAL',
      pnl: Math.round(pnl),
    });
  }
  
  return trades;
}

async function main() {
  const dates = await getAvailableDates();
  console.log(`\n=== 復活3銘柄 20営業日シミュレーション ===`);
  console.log(`期間: ${dates[0]} ～ ${dates[dates.length - 1]} (${dates.length}日間)`);
  console.log(`パラメータ: SL=0.5%, TP=1.5%, ポジション=300万円, 強制決済=15:25`);
  console.log(`${'='.repeat(90)}`);
  
  const dailyResults: { date: string; symbol: string; trades: Trade[] }[] = [];
  
  for (const date of dates) {
    for (const symbol of SYMBOLS) {
      const candles = await getCandles(symbol, date);
      if (candles.length < 30) continue; // Not enough data
      const trades = simulateDay(candles);
      if (trades.length > 0) {
        dailyResults.push({ date, symbol, trades });
      }
    }
  }
  
  // Print daily summary
  console.log(`\n${'─'.repeat(90)}`);
  console.log(`日付        | 6920(レーザーテック) | 6758(ソニー)     | 8316(三井住友FG)  | 合計`);
  console.log(`${'─'.repeat(90)}`);
  
  let totalAll = 0;
  const symbolTotals: Record<string, number> = { '6920': 0, '6758': 0, '8316': 0 };
  const symbolWins: Record<string, number> = { '6920': 0, '6758': 0, '8316': 0 };
  const symbolTrades: Record<string, number> = { '6920': 0, '6758': 0, '8316': 0 };
  
  for (const date of dates) {
    const dayPnl: Record<string, number> = { '6920': 0, '6758': 0, '8316': 0 };
    const dayTrades: Record<string, string[]> = { '6920': [], '6758': [], '8316': [] };
    
    for (const result of dailyResults.filter(r => r.date === date)) {
      for (const trade of result.trades) {
        dayPnl[trade.symbol] += trade.pnl;
        dayTrades[trade.symbol].push(`${trade.direction[0]}${trade.exitReason === 'TP' ? '✓' : trade.exitReason === 'SL' ? '✗' : '→'}`);
        symbolTotals[trade.symbol] += trade.pnl;
        symbolTrades[trade.symbol]++;
        if (trade.pnl > 0) symbolWins[trade.symbol]++;
      }
    }
    
    const dayTotal = dayPnl['6920'] + dayPnl['6758'] + dayPnl['8316'];
    totalAll += dayTotal;
    
    const fmt = (v: number, trades: string[]) => {
      if (trades.length === 0) return '    ---     ';
      const sign = v >= 0 ? '+' : '';
      return `${sign}${v.toLocaleString().padStart(8)} (${trades.join(',')})`;
    };
    
    console.log(`${date} | ${fmt(dayPnl['6920'], dayTrades['6920']).padEnd(19)} | ${fmt(dayPnl['6758'], dayTrades['6758']).padEnd(16)} | ${fmt(dayPnl['8316'], dayTrades['8316']).padEnd(17)} | ${dayTotal >= 0 ? '+' : ''}${dayTotal.toLocaleString()}`);
  }
  
  console.log(`${'─'.repeat(90)}`);
  console.log(`\n=== 銘柄別サマリー ===`);
  for (const sym of SYMBOLS) {
    const name = sym === '6920' ? 'レーザーテック' : sym === '6758' ? 'ソニーグループ' : '三井住友FG';
    const winRate = symbolTrades[sym] > 0 ? ((symbolWins[sym] / symbolTrades[sym]) * 100).toFixed(1) : '---';
    console.log(`${sym} ${name}: ${symbolTrades[sym]}取引, ${symbolWins[sym]}勝${symbolTrades[sym] - symbolWins[sym]}敗, 勝率${winRate}%, 損益 ${symbolTotals[sym] >= 0 ? '+' : ''}${symbolTotals[sym].toLocaleString()}円`);
  }
  console.log(`\n合計: ${totalAll >= 0 ? '+' : ''}${totalAll.toLocaleString()}円`);
  
  // Print detailed trade log
  console.log(`\n\n=== 全取引詳細 ===`);
  for (const result of dailyResults) {
    for (const trade of result.trades) {
      const name = trade.symbol === '6920' ? 'レーザーテック' : trade.symbol === '6758' ? 'ソニー' : '三井住友FG';
      console.log(`${result.date} ${name}(${trade.symbol}) ${trade.direction} ${trade.entryTime}@${trade.entryPrice} → ${trade.exitTime}@${trade.exitPrice} [${trade.exitReason}] ${trade.pnl >= 0 ? '+' : ''}${trade.pnl.toLocaleString()}円`);
    }
  }
  
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
