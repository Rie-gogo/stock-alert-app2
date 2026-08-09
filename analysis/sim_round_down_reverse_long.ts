/**
 * 大台割れ10本維持 → 逆張りLONGエントリー シミュレーション
 * 
 * ロジック: 大台を下に割ってから10本維持 = 売られすぎ → 反発を狙ってLONG
 * 
 * 比較:
 * - 現行: 大台割れ4本維持 → SHORT（順張り）
 * - 提案: 大台割れ10本維持 → LONG（逆張り・反発狙い）
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

function detectRoundLevelCrossBelow(prevClose: number, currClose: number): { crossedBelow: boolean; level: number | null } {
  const step = getRoundLevel(prevClose);
  const prevLevel = Math.floor(prevClose / step) * step;
  const currLevel = Math.floor(currClose / step) * step;
  
  // Price crossed below a round level
  if (currClose < prevLevel && prevClose >= prevLevel) {
    return { crossedBelow: true, level: prevLevel };
  }
  return { crossedBelow: false, level: null };
}

interface Candle {
  open: number; high: number; low: number; close: number;
  candleTime: string; volume: number;
}

interface Trade {
  symbol: string; date: string; entryTime: string; exitTime: string;
  entryPrice: number; exitPrice: number; pnl: number; pnlPct: number;
  exitReason: string; level: number; confirmBars: number;
}

async function main() {
  const db = await getDb();
  
  // Get last 30 trade dates
  const datesRes = await db.execute(sql.raw(
    `SELECT DISTINCT tradeDate FROM rt_candles WHERE symbol IN ('8035','6857','6976','6526','5803','6981','285A') ORDER BY tradeDate DESC LIMIT 30`
  ));
  const dates = (datesRes as any)[0].map((r: any) => r.tradeDate).reverse();
  
  console.log('='.repeat(80));
  console.log('  大台割れ → 逆張りLONG シミュレーション');
  console.log('  ロジック: 大台割れN本維持 → 売られすぎ → 反発狙いLONG');
  console.log('  期間: ' + dates[0] + ' 〜 ' + dates[dates.length - 1] + ' (' + dates.length + '日)');
  console.log('='.repeat(80));
  
  // Test multiple confirm bar counts for the reverse LONG
  const confirmBarOptions = [6, 8, 10, 12, 15, 20];
  const resultsByBars: Map<number, Trade[]> = new Map();
  
  for (const confirmBars of confirmBarOptions) {
    resultsByBars.set(confirmBars, []);
  }
  
  for (const sym of ACTIVE_SYMBOLS) {
    for (const date of dates) {
      const candlesRes = await db.execute(sql.raw(
        `SELECT open, high, low, close, candleTime, volume FROM rt_candles WHERE tradeDate = '${date}' AND symbol = '${sym}' ORDER BY candleTime`
      ));
      const candles: Candle[] = ((candlesRes as any)[0] || []).map((r: any) => ({
        open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close),
        candleTime: r.candleTime, volume: Number(r.volume || 0),
      }));
      
      if (candles.length < 20) continue;
      
      const slPct = SYMBOL_SL_MAP[sym] || 0.5;
      
      for (const confirmBars of confirmBarOptions) {
        const trades = resultsByBars.get(confirmBars)!;
        
        let pendingLevel: number | null = null;
        let confirmCount = 0;
        let inPosition = false;
        let entryPrice = 0;
        let entryTime = '';
        let entryLevel = 0;
        
        for (let i = 1; i < candles.length; i++) {
          const prev = candles[i - 1];
          const curr = candles[i];
          
          // If in LONG position, check SL/TP
          if (inPosition) {
            // LONG: TP is price going UP, SL is price going DOWN
            const tpPrice = entryPrice * (1 + TP_PCT / 100);
            const slPrice = entryPrice * (1 - slPct / 100);
            
            if (curr.high >= tpPrice) {
              const lots = Math.floor(2000000 / entryPrice);
              const pnl = Math.round((tpPrice - entryPrice) * lots);
              trades.push({
                symbol: sym, date, entryTime, exitTime: curr.candleTime,
                entryPrice, exitPrice: tpPrice, pnl, pnlPct: TP_PCT,
                exitReason: '利確(TP)', level: entryLevel, confirmBars,
              });
              inPosition = false;
            } else if (curr.low <= slPrice) {
              const lots = Math.floor(2000000 / entryPrice);
              const pnl = Math.round((slPrice - entryPrice) * lots);
              trades.push({
                symbol: sym, date, entryTime, exitTime: curr.candleTime,
                entryPrice, exitPrice: slPrice, pnl, pnlPct: -slPct,
                exitReason: '損切り(SL)', level: entryLevel, confirmBars,
              });
              inPosition = false;
            } else if (i === candles.length - 1) {
              const lots = Math.floor(2000000 / entryPrice);
              const pnl = Math.round((curr.close - entryPrice) * lots);
              const pnlPct = (curr.close - entryPrice) / entryPrice * 100;
              trades.push({
                symbol: sym, date, entryTime, exitTime: curr.candleTime,
                entryPrice, exitPrice: curr.close, pnl, pnlPct,
                exitReason: '大引け', level: entryLevel, confirmBars,
              });
              inPosition = false;
            }
            continue;
          }
          
          // Detect round level cross BELOW (price drops below a round number)
          const { crossedBelow, level } = detectRoundLevelCrossBelow(prev.close, curr.close);
          
          if (crossedBelow && level !== null) {
            // New round level break down - start confirmation
            pendingLevel = level;
            confirmCount = 1;
          } else if (pendingLevel !== null) {
            // Check if price is STILL below the level (confirming the break)
            if (curr.close < pendingLevel) {
              confirmCount++;
              
              if (confirmCount >= confirmBars) {
                // Confirmed N bars below! Enter REVERSE LONG (betting on bounce)
                entryPrice = curr.close;
                entryTime = curr.candleTime;
                entryLevel = pendingLevel;
                inPosition = true;
                pendingLevel = null;
                confirmCount = 0;
              }
            } else {
              // Price recovered above level - cancel (no need for reverse LONG)
              pendingLevel = null;
              confirmCount = 0;
            }
          }
        }
      }
    }
  }
  
  // Print results
  console.log('\n  ─── 確認本数別 総合結果 ───\n');
  console.log('  確認本数 | 件数 | 勝率   | 総PnL         | 平均PnL      | PF    | 勝ち平均   | 負け平均');
  console.log('  ' + '─'.repeat(95));
  
  for (const confirmBars of confirmBarOptions) {
    const trades = resultsByBars.get(confirmBars)!;
    if (trades.length === 0) {
      console.log('  ' + String(confirmBars).padStart(4) + '本   | 0件  | N/A');
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
    
    const marker = confirmBars === 10 ? ' ← 提案' : '';
    console.log('  ' + String(confirmBars).padStart(4) + '本   | ' + String(trades.length).padStart(3) + '件 | ' + (wins.length / trades.length * 100).toFixed(1).padStart(5) + '% | ' + totalPnl.toLocaleString().padStart(12) + '円 | ' + avgPnl.toLocaleString().padStart(10) + '円 | ' + pf.padStart(5) + ' | ' + avgWin.toLocaleString().padStart(9) + '円 | ' + avgLoss.toLocaleString().padStart(9) + '円' + marker);
  }
  
  // Detailed for 10 bars
  const trades10 = resultsByBars.get(10)!;
  
  // By symbol
  console.log('\n\n  ─── 10本確認 銘柄別 ───\n');
  const symMap = new Map<string, Trade[]>();
  for (const t of trades10) {
    const arr = symMap.get(t.symbol) || [];
    arr.push(t);
    symMap.set(t.symbol, arr);
  }
  
  console.log('  銘柄    | 件数 | 勝率   | 総PnL        | PF');
  console.log('  ' + '─'.repeat(60));
  for (const [sym, trades] of [...symMap.entries()].sort((a, b) => b[1].reduce((s, t) => s + t.pnl, 0) - a[1].reduce((s, t) => s + t.pnl, 0))) {
    const wins = trades.filter(t => t.pnl > 0).length;
    const pnl = trades.reduce((s, t) => s + t.pnl, 0);
    const grossWin = trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(trades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
    const pf = grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : 'INF';
    console.log('  ' + sym.padEnd(6) + ' | ' + String(trades.length).padStart(3) + '件 | ' + (wins / trades.length * 100).toFixed(1).padStart(5) + '% | ' + pnl.toLocaleString().padStart(11) + '円 | ' + pf);
  }
  
  // Compare with current SHORT (4-bar confirmation)
  console.log('\n\n  ─── 現行SHORT(4本)との比較 ───');
  const trades4short = resultsByBars.get(10)!; // We need to also simulate the current SHORT for comparison
  // Let's also run the current 4-bar SHORT for reference
  const shortTrades: Trade[] = [];
  
  for (const sym of ACTIVE_SYMBOLS) {
    for (const date of dates) {
      const candlesRes = await db.execute(sql.raw(
        `SELECT open, high, low, close, candleTime, volume FROM rt_candles WHERE tradeDate = '${date}' AND symbol = '${sym}' ORDER BY candleTime`
      ));
      const candles: Candle[] = ((candlesRes as any)[0] || []).map((r: any) => ({
        open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close),
        candleTime: r.candleTime, volume: Number(r.volume || 0),
      }));
      
      if (candles.length < 20) continue;
      
      const slPct = SYMBOL_SL_MAP[sym] || 0.5;
      const confirmBars = 4; // Current setting
      
      let pendingLevel: number | null = null;
      let confirmCount = 0;
      let inPosition = false;
      let entryPrice = 0;
      let entryTime = '';
      let entryLevel = 0;
      
      for (let i = 1; i < candles.length; i++) {
        const prev = candles[i - 1];
        const curr = candles[i];
        
        if (inPosition) {
          // SHORT: TP is price going DOWN, SL is price going UP
          const tpPrice = entryPrice * (1 - TP_PCT / 100);
          const slPrice = entryPrice * (1 + slPct / 100);
          
          if (curr.low <= tpPrice) {
            const lots = Math.floor(2000000 / entryPrice);
            const pnl = Math.round((entryPrice - tpPrice) * lots);
            shortTrades.push({
              symbol: sym, date, entryTime, exitTime: curr.candleTime,
              entryPrice, exitPrice: tpPrice, pnl, pnlPct: TP_PCT,
              exitReason: '利確(TP)', level: entryLevel, confirmBars,
            });
            inPosition = false;
          } else if (curr.high >= slPrice) {
            const lots = Math.floor(2000000 / entryPrice);
            const pnl = Math.round((entryPrice - slPrice) * lots);
            shortTrades.push({
              symbol: sym, date, entryTime, exitTime: curr.candleTime,
              entryPrice, exitPrice: slPrice, pnl, pnlPct: -slPct,
              exitReason: '損切り(SL)', level: entryLevel, confirmBars,
            });
            inPosition = false;
          } else if (i === candles.length - 1) {
            const lots = Math.floor(2000000 / entryPrice);
            const pnl = Math.round((entryPrice - curr.close) * lots);
            shortTrades.push({
              symbol: sym, date, entryTime, exitTime: curr.candleTime,
              entryPrice, exitPrice: curr.close, pnl, pnlPct: (entryPrice - curr.close) / entryPrice * 100,
              exitReason: '大引け', level: entryLevel, confirmBars,
            });
            inPosition = false;
          }
          continue;
        }
        
        const { crossedBelow, level } = detectRoundLevelCrossBelow(prev.close, curr.close);
        
        if (crossedBelow && level !== null) {
          pendingLevel = level;
          confirmCount = 1;
        } else if (pendingLevel !== null) {
          if (curr.close < pendingLevel) {
            confirmCount++;
            if (confirmCount >= confirmBars) {
              entryPrice = curr.close;
              entryTime = curr.candleTime;
              entryLevel = pendingLevel;
              inPosition = true;
              pendingLevel = null;
              confirmCount = 0;
            }
          } else {
            pendingLevel = null;
            confirmCount = 0;
          }
        }
      }
    }
  }
  
  const shortWins = shortTrades.filter(t => t.pnl > 0).length;
  const shortPnl = shortTrades.reduce((s, t) => s + t.pnl, 0);
  const shortGrossWin = shortTrades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const shortGrossLoss = Math.abs(shortTrades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
  
  const long10Wins = trades10.filter(t => t.pnl > 0).length;
  const long10Pnl = trades10.reduce((s, t) => s + t.pnl, 0);
  
  console.log('\n  方式              | 件数 | 勝率   | 総PnL         | PF');
  console.log('  ' + '─'.repeat(70));
  console.log('  現行SHORT(4本)    | ' + String(shortTrades.length).padStart(3) + '件 | ' + (shortWins / shortTrades.length * 100).toFixed(1).padStart(5) + '% | ' + shortPnl.toLocaleString().padStart(12) + '円 | ' + (shortGrossWin / shortGrossLoss).toFixed(2));
  console.log('  逆張りLONG(10本)  | ' + String(trades10.length).padStart(3) + '件 | ' + (long10Wins / trades10.length * 100).toFixed(1).padStart(5) + '% | ' + long10Pnl.toLocaleString().padStart(12) + '円 | ' + (trades10.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0) / Math.abs(trades10.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0))).toFixed(2));
  console.log('  両方併用          | ' + String(shortTrades.length + trades10.length).padStart(3) + '件 | ' + ((shortWins + long10Wins) / (shortTrades.length + trades10.length) * 100).toFixed(1).padStart(5) + '% | ' + (shortPnl + long10Pnl).toLocaleString().padStart(12) + '円 |');
  
  // Show some winning examples for 10-bar reverse LONG
  console.log('\n\n  ─── 10本確認 逆張りLONG 勝ちトレード例（上位10件） ───\n');
  const winTrades = trades10.filter(t => t.pnl > 0).sort((a, b) => b.pnl - a.pnl).slice(0, 10);
  console.log('  # | 日付       | 銘柄    | Entry    | Level  | PnL        | 決済理由  | 保有');
  console.log('  ' + '─'.repeat(85));
  for (let i = 0; i < winTrades.length; i++) {
    const t = winTrades[i];
    const entryMin = parseInt(t.entryTime.split(':')[0]) * 60 + parseInt(t.entryTime.split(':')[1]);
    const exitMin = parseInt(t.exitTime.split(':')[0]) * 60 + parseInt(t.exitTime.split(':')[1]);
    console.log('  ○' + String(i + 1).padStart(2) + ' | ' + t.date + ' | ' + t.symbol.padEnd(6) + ' | ' + t.entryPrice.toLocaleString().padStart(8) + ' | ' + t.level.toLocaleString().padStart(6) + ' | +' + t.pnl.toLocaleString().padStart(9) + '円 | ' + t.exitReason.padEnd(8) + ' | ' + (exitMin - entryMin) + '分');
  }
  
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
