/**
 * 売られすぎ逆張りLONG シミュレーション
 * 
 * 条件の組み合わせ:
 * A) RSI(14) ≤ 30 + 大台割れ → LONG
 * B) ボリンジャーバンド -2σ以下 + 大台割れ → LONG
 * C) RSI(14) ≤ 30 + BB -2σ以下 → LONG（大台関係なし）
 * D) RSI(14) ≤ 30 + BB -2σ以下 + 大台割れ → LONG（全条件）
 * E) RSI(14) ≤ 25 + BB -2σ以下 → LONG（より厳しい条件）
 */

import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

const ACTIVE_SYMBOLS = ['8035', '6857', '6976', '6526', '5803', '6981', '285A', '6146', '6594', '8316'];

const SYMBOL_SL_MAP: Record<string, number> = {
  "8035": 0.8, "6857": 0.6, "6976": 0.5, "6526": 0.9,
  "5803": 0.5, "6981": 0.9, "285A": 0.8, "6146": 0.8,
  "6594": 0.5, "8316": 0.5,
};
const TP_PCT = 1.5;

interface Candle {
  open: number; high: number; low: number; close: number;
  candleTime: string; volume: number;
}

interface Trade {
  symbol: string; date: string; entryTime: string; exitTime: string;
  entryPrice: number; exitPrice: number; pnl: number; pnlPct: number;
  exitReason: string; condition: string; rsi: number; bbPos: number;
}

// Calculate RSI
function calcRSI(closes: number[], period: number = 14): number {
  if (closes.length < period + 1) return 50; // default neutral
  const changes = [];
  for (let i = closes.length - period; i < closes.length; i++) {
    changes.push(closes[i] - closes[i - 1]);
  }
  let avgGain = 0, avgLoss = 0;
  for (const c of changes) {
    if (c > 0) avgGain += c;
    else avgLoss += Math.abs(c);
  }
  avgGain /= period;
  avgLoss /= period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

// Calculate Bollinger Bands
function calcBB(closes: number[], period: number = 20): { upper: number; middle: number; lower: number; pctB: number } {
  if (closes.length < period) return { upper: 0, middle: 0, lower: 0, pctB: 0.5 };
  const slice = closes.slice(-period);
  const mean = slice.reduce((s, v) => s + v, 0) / period;
  const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period;
  const std = Math.sqrt(variance);
  const upper = mean + 2 * std;
  const lower = mean - 2 * std;
  const current = closes[closes.length - 1];
  const pctB = std > 0 ? (current - lower) / (upper - lower) : 0.5;
  return { upper, middle: mean, lower, pctB };
}

// Round level detection
function getRoundLevel(price: number): number {
  if (price >= 100000) return 5000;
  if (price >= 50000) return 2000;
  if (price >= 10000) return 1000;
  if (price >= 5000) return 500;
  if (price >= 3000) return 200;
  if (price >= 1000) return 100;
  if (price >= 500) return 50;
  return 10;
}

function isBelowRoundLevel(price: number): boolean {
  const step = getRoundLevel(price);
  const nearestAbove = Math.ceil(price / step) * step;
  const distPct = (nearestAbove - price) / price * 100;
  return distPct < 0.3; // Within 0.3% below a round level
}

function detectRoundLevelCrossBelow(prevClose: number, currClose: number): boolean {
  const step = getRoundLevel(prevClose);
  const prevLevel = Math.floor(prevClose / step) * step;
  return prevClose >= prevLevel && currClose < prevLevel;
}

async function main() {
  const db = await getDb();
  
  const datesRes = await db.execute(sql.raw(
    `SELECT DISTINCT tradeDate FROM rt_candles WHERE symbol IN ('8035','6857','6976','6526','5803','6981','285A') ORDER BY tradeDate DESC LIMIT 30`
  ));
  const dates = (datesRes as any)[0].map((r: any) => r.tradeDate).reverse();
  
  console.log('='.repeat(80));
  console.log('  売られすぎ逆張りLONG シミュレーション（RSI + ボリンジャーバンド）');
  console.log('  期間: ' + dates[0] + ' 〜 ' + dates[dates.length - 1] + ' (' + dates.length + '日)');
  console.log('='.repeat(80));
  
  // Conditions to test
  const conditions = [
    { name: 'A: RSI≤30 + 大台割れ', rsiThresh: 30, needBB: false, needRound: true },
    { name: 'B: BB≤-2σ + 大台割れ', rsiThresh: 100, needBB: true, needRound: true },
    { name: 'C: RSI≤30 + BB≤-2σ', rsiThresh: 30, needBB: true, needRound: false },
    { name: 'D: RSI≤30 + BB≤-2σ + 大台割れ', rsiThresh: 30, needBB: true, needRound: true },
    { name: 'E: RSI≤25 + BB≤-2σ', rsiThresh: 25, needBB: true, needRound: false },
    { name: 'F: RSI≤20 + BB≤-2σ', rsiThresh: 20, needBB: true, needRound: false },
    { name: 'G: RSI≤30 + BB≤-2.5σ', rsiThresh: 30, needBB: true, needRound: false, bbMult: 2.5 },
  ];
  
  const resultsByCondition: Map<string, Trade[]> = new Map();
  for (const c of conditions) resultsByCondition.set(c.name, []);
  
  for (const sym of ACTIVE_SYMBOLS) {
    for (const date of dates) {
      const candlesRes = await db.execute(sql.raw(
        `SELECT open, high, low, close, candleTime, volume FROM rt_candles WHERE tradeDate = '${date}' AND symbol = '${sym}' ORDER BY candleTime`
      ));
      const candles: Candle[] = ((candlesRes as any)[0] || []).map((r: any) => ({
        open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close),
        candleTime: r.candleTime, volume: Number(r.volume || 0),
      }));
      
      if (candles.length < 25) continue;
      
      const slPct = SYMBOL_SL_MAP[sym] || 0.5;
      
      for (const cond of conditions) {
        const trades = resultsByCondition.get(cond.name)!;
        let inPosition = false;
        let entryPrice = 0;
        let entryTime = '';
        let cooldown = 0; // Prevent multiple entries in same signal
        
        const closes: number[] = [];
        
        for (let i = 0; i < candles.length; i++) {
          const curr = candles[i];
          closes.push(curr.close);
          
          if (cooldown > 0) { cooldown--; }
          
          // If in LONG position, check SL/TP
          if (inPosition) {
            const tpPrice = entryPrice * (1 + TP_PCT / 100);
            const slPrice = entryPrice * (1 - slPct / 100);
            
            if (curr.high >= tpPrice) {
              const lots = Math.floor(2000000 / entryPrice);
              const pnl = Math.round((tpPrice - entryPrice) * lots);
              trades.push({
                symbol: sym, date, entryTime, exitTime: curr.candleTime,
                entryPrice, exitPrice: tpPrice, pnl, pnlPct: TP_PCT,
                exitReason: '利確(TP)', condition: cond.name,
                rsi: calcRSI(closes.slice(0, -1), 14), bbPos: 0,
              });
              inPosition = false;
              cooldown = 5; // Wait 5 bars before next entry
            } else if (curr.low <= slPrice) {
              const lots = Math.floor(2000000 / entryPrice);
              const pnl = Math.round((slPrice - entryPrice) * lots);
              trades.push({
                symbol: sym, date, entryTime, exitTime: curr.candleTime,
                entryPrice, exitPrice: slPrice, pnl, pnlPct: -slPct,
                exitReason: '損切り(SL)', condition: cond.name,
                rsi: calcRSI(closes.slice(0, -1), 14), bbPos: 0,
              });
              inPosition = false;
              cooldown = 5;
            } else if (i === candles.length - 1) {
              const lots = Math.floor(2000000 / entryPrice);
              const pnl = Math.round((curr.close - entryPrice) * lots);
              trades.push({
                symbol: sym, date, entryTime, exitTime: curr.candleTime,
                entryPrice, exitPrice: curr.close, pnl,
                pnlPct: (curr.close - entryPrice) / entryPrice * 100,
                exitReason: '大引け', condition: cond.name,
                rsi: calcRSI(closes.slice(0, -1), 14), bbPos: 0,
              });
              inPosition = false;
            }
            continue;
          }
          
          // Need at least 20 bars for indicators
          if (closes.length < 21 || cooldown > 0) continue;
          
          // Calculate indicators
          const rsi = calcRSI(closes, 14);
          const bbMult = (cond as any).bbMult || 2;
          const bbPeriod = 20;
          const bbSlice = closes.slice(-bbPeriod);
          const bbMean = bbSlice.reduce((s, v) => s + v, 0) / bbPeriod;
          const bbVariance = bbSlice.reduce((s, v) => s + (v - bbMean) ** 2, 0) / bbPeriod;
          const bbStd = Math.sqrt(bbVariance);
          const bbLower = bbMean - bbMult * bbStd;
          const pctB = bbStd > 0 ? (curr.close - bbLower) / (bbMult * 2 * bbStd) : 0.5;
          
          // Check conditions
          const rsiOK = rsi <= cond.rsiThresh;
          const bbOK = !cond.needBB || curr.close <= bbLower;
          const roundOK = !cond.needRound || (i > 0 && detectRoundLevelCrossBelow(candles[i - 1].close, curr.close));
          
          if (rsiOK && bbOK && roundOK) {
            // Entry LONG
            entryPrice = curr.close;
            entryTime = curr.candleTime;
            inPosition = true;
          }
        }
      }
    }
  }
  
  // Print results
  console.log('\n  ─── 条件別 総合結果 ───\n');
  console.log('  条件                          | 件数 | 勝率   | 総PnL         | 平均PnL      | PF    | RR比');
  console.log('  ' + '─'.repeat(100));
  
  for (const cond of conditions) {
    const trades = resultsByCondition.get(cond.name)!;
    if (trades.length === 0) {
      console.log('  ' + cond.name.padEnd(30) + ' |   0件 | N/A');
      continue;
    }
    const wins = trades.filter(t => t.pnl > 0);
    const losses = trades.filter(t => t.pnl <= 0);
    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
    const avgPnl = Math.round(totalPnl / trades.length);
    const avgWin = wins.length > 0 ? Math.round(wins.reduce((s, t) => s + t.pnl, 0) / wins.length) : 0;
    const avgLoss = losses.length > 0 ? Math.round(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : 0;
    const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    const pf = grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : 'INF';
    const rr = avgLoss !== 0 ? (avgWin / Math.abs(avgLoss)).toFixed(2) : 'N/A';
    
    console.log('  ' + cond.name.padEnd(30) + ' | ' + String(trades.length).padStart(3) + '件 | ' + (wins.length / trades.length * 100).toFixed(1).padStart(5) + '% | ' + totalPnl.toLocaleString().padStart(12) + '円 | ' + avgPnl.toLocaleString().padStart(10) + '円 | ' + pf.padStart(5) + ' | ' + rr);
  }
  
  // Detail for best condition
  // Find best PF condition
  let bestCond = '';
  let bestPF = 0;
  for (const cond of conditions) {
    const trades = resultsByCondition.get(cond.name)!;
    if (trades.length < 5) continue;
    const grossWin = trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(trades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
    const pf = grossLoss > 0 ? grossWin / grossLoss : 0;
    if (pf > bestPF) { bestPF = pf; bestCond = cond.name; }
  }
  
  if (bestCond) {
    const trades = resultsByCondition.get(bestCond)!;
    console.log('\n\n  ─── 最良条件「' + bestCond + '」詳細 ───\n');
    
    // By symbol
    console.log('  銘柄別:');
    const symMap = new Map<string, Trade[]>();
    for (const t of trades) {
      const arr = symMap.get(t.symbol) || [];
      arr.push(t);
      symMap.set(t.symbol, arr);
    }
    for (const [sym, st] of [...symMap.entries()].sort((a, b) => b[1].reduce((s, t) => s + t.pnl, 0) - a[1].reduce((s, t) => s + t.pnl, 0))) {
      const w = st.filter(t => t.pnl > 0).length;
      const p = st.reduce((s, t) => s + t.pnl, 0);
      console.log('    ' + sym.padEnd(6) + ' | ' + st.length + '件 | 勝率: ' + (w / st.length * 100).toFixed(1) + '% | PnL: ' + p.toLocaleString() + '円');
    }
    
    // All trades detail
    console.log('\n  全トレード:');
    console.log('  # | 日付       | 銘柄    | Entry    | PnL        | 決済理由  | RSI  | 保有');
    console.log('  ' + '─'.repeat(80));
    for (let i = 0; i < Math.min(trades.length, 30); i++) {
      const t = trades[i];
      const pnlStr = t.pnl >= 0 ? '+' + t.pnl.toLocaleString() : t.pnl.toLocaleString();
      const mark = t.pnl > 0 ? '○' : '×';
      const entryMin = parseInt(t.entryTime.split(':')[0]) * 60 + parseInt(t.entryTime.split(':')[1]);
      const exitMin = parseInt(t.exitTime.split(':')[0]) * 60 + parseInt(t.exitTime.split(':')[1]);
      console.log('  ' + mark + String(i + 1).padStart(2) + ' | ' + t.date + ' | ' + t.symbol.padEnd(6) + ' | ' + t.entryPrice.toLocaleString().padStart(8) + ' | ' + pnlStr.padStart(10) + '円 | ' + t.exitReason.padEnd(8) + ' | ' + t.rsi.toFixed(1).padStart(4) + ' | ' + (exitMin - entryMin) + '分');
    }
  }
  
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
