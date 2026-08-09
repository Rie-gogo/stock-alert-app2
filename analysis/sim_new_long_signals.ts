/**
 * 新規LONGシグナル シミュレーション
 * 
 * B1: 出来高急増 + 陽線
 *   - 現在足の出来高 ≥ 直近20本平均の2.0倍
 *   - 現在足が陽線（close > open）
 *   - 終値 > MA(10)
 *   - 追加フィルター: MA(10) > MA(20)（上昇トレンド中のみ）
 * 
 * B4: ブレイクアウト（レンジ上限突破 + 出来高増）
 *   - 終値が直近20本の高値を更新
 *   - 出来高 ≥ 直近20本平均の1.5倍
 *   - 追加フィルター: MA(5) > MA(10)（短期上昇中）
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
  exitReason: string; signal: string; volRatio: number; holdMin: number;
}

function calcMA(values: number[], period: number): number {
  if (values.length < period) return values[values.length - 1];
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
  console.log('  新規LONGシグナル シミュレーション');
  console.log('  B1: 出来高急増 + 陽線 / B4: ブレイクアウト + 出来高増');
  console.log('  期間: ' + dates[0] + ' 〜 ' + dates[dates.length - 1] + ' (' + dates.length + '日)');
  console.log('='.repeat(80));
  
  // Multiple variations of each signal
  const signalConfigs = [
    // B1 variations
    { name: 'B1a: Vol≥2.0x + 陽線 + close>MA10', volMult: 2.0, needBullish: true, needAboveMA10: true, needMA10gtMA20: false, needBreakout: false, breakoutPeriod: 0, needMA5gtMA10: false },
    { name: 'B1b: Vol≥2.0x + 陽線 + MA10>MA20', volMult: 2.0, needBullish: true, needAboveMA10: true, needMA10gtMA20: true, needBreakout: false, breakoutPeriod: 0, needMA5gtMA10: false },
    { name: 'B1c: Vol≥2.5x + 陽線 + close>MA10', volMult: 2.5, needBullish: true, needAboveMA10: true, needMA10gtMA20: false, needBreakout: false, breakoutPeriod: 0, needMA5gtMA10: false },
    { name: 'B1d: Vol≥3.0x + 陽線 + MA10>MA20', volMult: 3.0, needBullish: true, needAboveMA10: true, needMA10gtMA20: true, needBreakout: false, breakoutPeriod: 0, needMA5gtMA10: false },
    // B4 variations
    { name: 'B4a: 20本高値更新 + Vol≥1.5x', volMult: 1.5, needBullish: false, needAboveMA10: false, needMA10gtMA20: false, needBreakout: true, breakoutPeriod: 20, needMA5gtMA10: false },
    { name: 'B4b: 20本高値更新 + Vol≥1.5x + MA5>MA10', volMult: 1.5, needBullish: false, needAboveMA10: false, needMA10gtMA20: false, needBreakout: true, breakoutPeriod: 20, needMA5gtMA10: true },
    { name: 'B4c: 30本高値更新 + Vol≥2.0x', volMult: 2.0, needBullish: false, needAboveMA10: false, needMA10gtMA20: false, needBreakout: true, breakoutPeriod: 30, needMA5gtMA10: false },
    { name: 'B4d: 30本高値更新 + Vol≥2.0x + MA5>MA10', volMult: 2.0, needBullish: false, needAboveMA10: false, needMA10gtMA20: false, needBreakout: true, breakoutPeriod: 30, needMA5gtMA10: true },
    // Combined
    { name: 'B1+B4: Vol≥2.0x + 陽線 + 20本高値更新', volMult: 2.0, needBullish: true, needAboveMA10: false, needMA10gtMA20: false, needBreakout: true, breakoutPeriod: 20, needMA5gtMA10: false },
  ];
  
  const resultsBySignal: Map<string, Trade[]> = new Map();
  for (const cfg of signalConfigs) resultsBySignal.set(cfg.name, []);
  
  for (const sym of ACTIVE_SYMBOLS) {
    for (const date of dates) {
      const candlesRes = await db.execute(sql.raw(
        `SELECT open, high, low, close, candleTime, volume FROM rt_candles WHERE tradeDate = '${date}' AND symbol = '${sym}' ORDER BY candleTime`
      ));
      const candles: Candle[] = ((candlesRes as any)[0] || []).map((r: any) => ({
        open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close),
        candleTime: r.candleTime, volume: Number(r.volume || 0),
      }));
      
      if (candles.length < 35) continue;
      
      const slPct = SYMBOL_SL_MAP[sym] || 0.5;
      
      for (const cfg of signalConfigs) {
        const trades = resultsBySignal.get(cfg.name)!;
        let inPosition = false;
        let entryPrice = 0;
        let entryTime = '';
        let cooldown = 0;
        
        const closes: number[] = [];
        const volumes: number[] = [];
        const highs: number[] = [];
        
        for (let i = 0; i < candles.length; i++) {
          const curr = candles[i];
          closes.push(curr.close);
          volumes.push(curr.volume);
          highs.push(curr.high);
          
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
              trades.push({
                symbol: sym, date, entryTime, exitTime: curr.candleTime,
                entryPrice, exitPrice: tpPrice, pnl, pnlPct: TP_PCT,
                exitReason: '利確(TP)', signal: cfg.name, volRatio: 0, holdMin: exitMin - entryMin,
              });
              inPosition = false;
              cooldown = 10;
            } else if (curr.low <= slPrice) {
              const lots = Math.floor(2000000 / entryPrice);
              const pnl = Math.round((slPrice - entryPrice) * lots);
              const entryMin = parseInt(entryTime.split(':')[0]) * 60 + parseInt(entryTime.split(':')[1]);
              const exitMin = parseInt(curr.candleTime.split(':')[0]) * 60 + parseInt(curr.candleTime.split(':')[1]);
              trades.push({
                symbol: sym, date, entryTime, exitTime: curr.candleTime,
                entryPrice, exitPrice: slPrice, pnl, pnlPct: -slPct,
                exitReason: '損切り(SL)', signal: cfg.name, volRatio: 0, holdMin: exitMin - entryMin,
              });
              inPosition = false;
              cooldown = 10;
            } else if (i === candles.length - 1) {
              const lots = Math.floor(2000000 / entryPrice);
              const pnl = Math.round((curr.close - entryPrice) * lots);
              const entryMin = parseInt(entryTime.split(':')[0]) * 60 + parseInt(entryTime.split(':')[1]);
              const exitMin = parseInt(curr.candleTime.split(':')[0]) * 60 + parseInt(curr.candleTime.split(':')[1]);
              trades.push({
                symbol: sym, date, entryTime, exitTime: curr.candleTime,
                entryPrice, exitPrice: curr.close, pnl,
                pnlPct: (curr.close - entryPrice) / entryPrice * 100,
                exitReason: '大引け', signal: cfg.name, volRatio: 0, holdMin: exitMin - entryMin,
              });
              inPosition = false;
            }
            continue;
          }
          
          // Need enough data
          const lookback = Math.max(20, cfg.breakoutPeriod || 20);
          if (closes.length < lookback + 1 || cooldown > 0) continue;
          
          // Skip first 10 minutes (noisy open)
          const timeStr = curr.candleTime;
          const hour = parseInt(timeStr.split(':')[0]);
          const min = parseInt(timeStr.split(':')[1]);
          if (hour === 9 && min < 10) continue;
          
          // Calculate indicators
          const avgVol = volumes.slice(-21, -1).reduce((s, v) => s + v, 0) / 20;
          const volRatio = avgVol > 0 ? curr.volume / avgVol : 0;
          const ma5 = calcMA(closes, 5);
          const ma10 = calcMA(closes, 10);
          const ma20 = calcMA(closes, 20);
          const isBullishCandle = curr.close > curr.open;
          
          // Check breakout (high exceeds N-bar high)
          let isBreakout = false;
          if (cfg.needBreakout) {
            const period = cfg.breakoutPeriod;
            const prevHighs = highs.slice(-(period + 1), -1);
            const maxPrevHigh = Math.max(...prevHighs);
            isBreakout = curr.close > maxPrevHigh;
          }
          
          // Check all conditions
          const volOK = volRatio >= cfg.volMult;
          const bullishOK = !cfg.needBullish || isBullishCandle;
          const aboveMA10OK = !cfg.needAboveMA10 || curr.close > ma10;
          const ma10gtMA20OK = !cfg.needMA10gtMA20 || ma10 > ma20;
          const breakoutOK = !cfg.needBreakout || isBreakout;
          const ma5gtMA10OK = !cfg.needMA5gtMA10 || ma5 > ma10;
          
          if (volOK && bullishOK && aboveMA10OK && ma10gtMA20OK && breakoutOK && ma5gtMA10OK) {
            entryPrice = curr.close;
            entryTime = curr.candleTime;
            inPosition = true;
          }
        }
      }
    }
  }
  
  // Print results
  console.log('\n  ─── シグナル別 総合結果 ───\n');
  console.log('  シグナル                              | 件数 | 勝率   | 総PnL         | 平均PnL      | PF    | 平均保有');
  console.log('  ' + '─'.repeat(105));
  
  for (const cfg of signalConfigs) {
    const trades = resultsBySignal.get(cfg.name)!;
    if (trades.length === 0) {
      console.log('  ' + cfg.name.padEnd(38) + ' |   0件 | N/A');
      continue;
    }
    const wins = trades.filter(t => t.pnl > 0);
    const losses = trades.filter(t => t.pnl <= 0);
    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
    const avgPnl = Math.round(totalPnl / trades.length);
    const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    const pf = grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : 'INF';
    const avgHold = Math.round(trades.reduce((s, t) => s + t.holdMin, 0) / trades.length);
    
    console.log('  ' + cfg.name.padEnd(38) + ' | ' + String(trades.length).padStart(3) + '件 | ' + (wins.length / trades.length * 100).toFixed(1).padStart(5) + '% | ' + totalPnl.toLocaleString().padStart(12) + '円 | ' + avgPnl.toLocaleString().padStart(10) + '円 | ' + pf.padStart(5) + ' | ' + avgHold + '分');
  }
  
  // Detail for best signals (PF > 1.0)
  const bestSignals = signalConfigs.filter(cfg => {
    const trades = resultsBySignal.get(cfg.name)!;
    if (trades.length < 5) return false;
    const grossWin = trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(trades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
    return grossLoss > 0 && grossWin / grossLoss >= 1.0;
  });
  
  for (const cfg of bestSignals) {
    const trades = resultsBySignal.get(cfg.name)!;
    console.log('\n\n  ─── 「' + cfg.name + '」銘柄別 ───\n');
    
    const symMap = new Map<string, Trade[]>();
    for (const t of trades) {
      const arr = symMap.get(t.symbol) || [];
      arr.push(t);
      symMap.set(t.symbol, arr);
    }
    
    for (const [sym, st] of [...symMap.entries()].sort((a, b) => b[1].reduce((s, t) => s + t.pnl, 0) - a[1].reduce((s, t) => s + t.pnl, 0))) {
      const w = st.filter(t => t.pnl > 0).length;
      const p = st.reduce((s, t) => s + t.pnl, 0);
      const gw = st.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
      const gl = Math.abs(st.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
      const spf = gl > 0 ? (gw / gl).toFixed(2) : 'INF';
      console.log('    ' + sym.padEnd(6) + ' | ' + String(st.length).padStart(2) + '件 | 勝率: ' + (w / st.length * 100).toFixed(1).padStart(5) + '% | PnL: ' + p.toLocaleString().padStart(10) + '円 | PF: ' + spf);
    }
    
    // Show sample trades
    console.log('\n  勝ちトレード例（上位5件）:');
    const winTrades = trades.filter(t => t.pnl > 0).sort((a, b) => b.pnl - a.pnl).slice(0, 5);
    for (const t of winTrades) {
      console.log('    ○ ' + t.date + ' | ' + t.symbol + ' | ' + t.entryTime + ' | Entry: ' + t.entryPrice.toLocaleString() + ' | +' + t.pnl.toLocaleString() + '円 | ' + t.holdMin + '分');
    }
    console.log('\n  負けトレード例（下位5件）:');
    const lossTrades = trades.filter(t => t.pnl < 0).sort((a, b) => a.pnl - b.pnl).slice(0, 5);
    for (const t of lossTrades) {
      console.log('    × ' + t.date + ' | ' + t.symbol + ' | ' + t.entryTime + ' | Entry: ' + t.entryPrice.toLocaleString() + ' | ' + t.pnl.toLocaleString() + '円 | ' + t.holdMin + '分');
    }
  }
  
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
