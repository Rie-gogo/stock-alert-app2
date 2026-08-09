/**
 * GCシグナル medium品質ブロック解除シミュレーション
 * 
 * 条件パターン:
 * A: GC medium無条件許可
 * B: GC medium + sell_pressure以外（neutral/buy_pressure）
 * C: GC medium + 安値切り上げ確認（直近3本の安値が上昇）
 * D: GC medium + 安値切り上げ + sell_pressure以外
 * E: GC medium + close > MA20（上昇トレンド中のみ）
 * F: GC medium + 安値切り上げ + close > MA10
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
  entryPrice: number; exitPrice: number; pnl: number;
  exitReason: string; condition: string; holdMin: number;
}

function calcMA(values: number[], period: number): number {
  if (values.length < period) return 0;
  const slice = values.slice(-period);
  return slice.reduce((s, v) => s + v, 0) / period;
}

async function main() {
  const db = await getDb();
  
  const datesRes = await db.execute(sql.raw(
    `SELECT DISTINCT tradeDate FROM rt_candles WHERE symbol IN ('8035','6857','6976','6526','5803','6981','285A') ORDER BY tradeDate DESC LIMIT 30`
  ));
  const dates = (datesRes as any)[0].map((r: any) => r.tradeDate).reverse();
  
  console.log('='.repeat(80));
  console.log('  GC medium品質ブロック解除シミュレーション');
  console.log('  期間: ' + dates[0] + ' 〜 ' + dates[dates.length - 1] + ' (' + dates.length + '日)');
  console.log('='.repeat(80));
  
  const conditions = [
    { name: 'A: GC medium無条件許可', needNonSell: false, needHigherLows: false, needAboveMA20: false, needAboveMA10: false },
    { name: 'B: GC + sell_pressure以外', needNonSell: true, needHigherLows: false, needAboveMA20: false, needAboveMA10: false },
    { name: 'C: GC + 安値切り上げ3本', needNonSell: false, needHigherLows: true, needAboveMA20: false, needAboveMA10: false },
    { name: 'D: GC + 安値切り上げ + 非sell', needNonSell: true, needHigherLows: true, needAboveMA20: false, needAboveMA10: false },
    { name: 'E: GC + close>MA20', needNonSell: false, needHigherLows: false, needAboveMA20: true, needAboveMA10: false },
    { name: 'F: GC + 安値切り上げ + close>MA10', needNonSell: false, needHigherLows: true, needAboveMA20: false, needAboveMA10: true },
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
        let cooldown = 0;
        
        const closes: number[] = [];
        const lows: number[] = [];
        let prevMA5 = 0, prevMA10 = 0;
        
        for (let i = 0; i < candles.length; i++) {
          const curr = candles[i];
          closes.push(curr.close);
          lows.push(curr.low);
          
          if (cooldown > 0) cooldown--;
          
          // Position management
          if (inPosition) {
            const tpPrice = entryPrice * (1 + TP_PCT / 100);
            const slPrice = entryPrice * (1 - slPct / 100);
            
            if (curr.high >= tpPrice) {
              const lots = Math.floor(2000000 / entryPrice);
              const pnl = Math.round((tpPrice - entryPrice) * lots);
              const entryMin = parseInt(entryTime.split(':')[0]) * 60 + parseInt(entryTime.split(':')[1]);
              const exitMin = parseInt(curr.candleTime.split(':')[0]) * 60 + parseInt(curr.candleTime.split(':')[1]);
              trades.push({ symbol: sym, date, entryTime, exitTime: curr.candleTime, entryPrice, exitPrice: tpPrice, pnl, exitReason: '利確(TP)', condition: cond.name, holdMin: exitMin - entryMin });
              inPosition = false; cooldown = 10;
            } else if (curr.low <= slPrice) {
              const lots = Math.floor(2000000 / entryPrice);
              const pnl = Math.round((slPrice - entryPrice) * lots);
              const entryMin = parseInt(entryTime.split(':')[0]) * 60 + parseInt(entryTime.split(':')[1]);
              const exitMin = parseInt(curr.candleTime.split(':')[0]) * 60 + parseInt(curr.candleTime.split(':')[1]);
              trades.push({ symbol: sym, date, entryTime, exitTime: curr.candleTime, entryPrice, exitPrice: slPrice, pnl, exitReason: '損切り(SL)', condition: cond.name, holdMin: exitMin - entryMin });
              inPosition = false; cooldown = 10;
            } else if (i === candles.length - 1) {
              const lots = Math.floor(2000000 / entryPrice);
              const pnl = Math.round((curr.close - entryPrice) * lots);
              const entryMin = parseInt(entryTime.split(':')[0]) * 60 + parseInt(entryTime.split(':')[1]);
              const exitMin = parseInt(curr.candleTime.split(':')[0]) * 60 + parseInt(curr.candleTime.split(':')[1]);
              trades.push({ symbol: sym, date, entryTime, exitTime: curr.candleTime, entryPrice, exitPrice: curr.close, pnl, exitReason: '大引け', condition: cond.name, holdMin: exitMin - entryMin });
              inPosition = false;
            }
            continue;
          }
          
          if (closes.length < 21 || cooldown > 0) continue;
          
          // Time filter: 09:30-15:05
          const hour = parseInt(curr.candleTime.split(':')[0]);
          const min = parseInt(curr.candleTime.split(':')[1]);
          const timeMin = hour * 60 + min;
          if (timeMin < 570 || timeMin > 905) continue;
          // Lunch break
          if (timeMin >= 660 && timeMin < 690) continue;
          if (timeMin >= 750 && timeMin < 780) continue;
          
          // Calculate MAs
          const ma5 = calcMA(closes, 5);
          const ma10 = calcMA(closes, 10);
          const ma20 = calcMA(closes, 20);
          
          // Detect GC (MA5 crosses above MA10)
          const isGC = prevMA5 > 0 && prevMA10 > 0 && ma5 > ma10 && prevMA5 <= prevMA10;
          
          prevMA5 = ma5;
          prevMA10 = ma10;
          
          if (!isGC) continue;
          
          // Check additional conditions
          // Higher lows: last 3 lows are ascending
          let higherLowsOK = true;
          if (cond.needHigherLows) {
            if (lows.length >= 3) {
              const l1 = lows[lows.length - 3];
              const l2 = lows[lows.length - 2];
              const l3 = lows[lows.length - 1];
              higherLowsOK = l3 > l2 && l2 > l1;
            } else {
              higherLowsOK = false;
            }
          }
          
          // Above MA20
          const aboveMA20OK = !cond.needAboveMA20 || curr.close > ma20;
          
          // Above MA10
          const aboveMA10OK = !cond.needAboveMA10 || curr.close > ma10;
          
          // Non-sell pressure (we don't have board data in candles, so simulate with price action)
          // Proxy: if current candle is bullish (close > open), assume not sell_pressure
          const nonSellOK = !cond.needNonSell || curr.close > curr.open;
          
          if (higherLowsOK && aboveMA20OK && aboveMA10OK && nonSellOK) {
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
  console.log('  条件                              | 件数 | 勝率   | 総PnL         | 平均PnL      | PF    | 平均保有');
  console.log('  ' + '─'.repeat(100));
  
  for (const cond of conditions) {
    const trades = resultsByCondition.get(cond.name)!;
    if (trades.length === 0) { console.log('  ' + cond.name.padEnd(34) + ' |   0件'); continue; }
    const wins = trades.filter(t => t.pnl > 0);
    const losses = trades.filter(t => t.pnl <= 0);
    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
    const avgPnl = Math.round(totalPnl / trades.length);
    const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    const pf = grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : 'INF';
    const avgHold = Math.round(trades.reduce((s, t) => s + t.holdMin, 0) / trades.length);
    console.log('  ' + cond.name.padEnd(34) + ' | ' + String(trades.length).padStart(3) + '件 | ' + (wins.length / trades.length * 100).toFixed(1).padStart(5) + '% | ' + totalPnl.toLocaleString().padStart(12) + '円 | ' + avgPnl.toLocaleString().padStart(10) + '円 | ' + pf.padStart(5) + ' | ' + avgHold + '分');
  }
  
  // Best condition detail
  let bestName = '';
  let bestPF = 0;
  for (const cond of conditions) {
    const trades = resultsByCondition.get(cond.name)!;
    if (trades.length < 5) continue;
    const gw = trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
    const gl = Math.abs(trades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
    const pf = gl > 0 ? gw / gl : 0;
    if (pf > bestPF) { bestPF = pf; bestName = cond.name; }
  }
  
  if (bestName) {
    const trades = resultsByCondition.get(bestName)!;
    console.log('\n\n  ─── 最良条件「' + bestName + '」銘柄別 ───\n');
    const symMap = new Map<string, Trade[]>();
    for (const t of trades) { const arr = symMap.get(t.symbol) || []; arr.push(t); symMap.set(t.symbol, arr); }
    for (const [sym, st] of [...symMap.entries()].sort((a, b) => b[1].reduce((s, t) => s + t.pnl, 0) - a[1].reduce((s, t) => s + t.pnl, 0))) {
      const w = st.filter(t => t.pnl > 0).length;
      const p = st.reduce((s, t) => s + t.pnl, 0);
      console.log('    ' + sym.padEnd(6) + ' | ' + String(st.length).padStart(2) + '件 | 勝率: ' + (w / st.length * 100).toFixed(1).padStart(5) + '% | PnL: ' + p.toLocaleString().padStart(10) + '円');
    }
    
    // Show winning trades
    console.log('\n  勝ちトレード:');
    const winTrades = trades.filter(t => t.pnl > 0).sort((a, b) => b.pnl - a.pnl).slice(0, 10);
    for (const t of winTrades) {
      console.log('    ○ ' + t.date + ' | ' + t.symbol + ' | ' + t.entryTime + '→' + t.exitTime + ' | +' + t.pnl.toLocaleString() + '円 | ' + t.holdMin + '分');
    }
  }
  
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
