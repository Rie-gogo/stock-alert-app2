/**
 * 日中レンジ内位置フィルター シミュレーション
 * 
 * 全銘柄に適用した場合の30日間シミュレーション
 * - SHORT: Entry位置 <= X% ならブロック
 * - LONG: Entry位置 >= (100-X)% ならブロック
 * 
 * 複数の閾値で比較
 */

import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

const EXCLUDED = new Set(['6920', '6758', '9984', '7011', '9107', '8306', '4568', '5016', '7203', '3778', '3436', '6723']);

interface TradePair {
  symbol: string;
  name: string;
  date: string;
  side: string;
  entryPrice: number;
  exitPrice: number;
  shares: number;
  pnl: number;
  entryTime: string;
  exitTime: string;
  reason: string;
  exitReason: string;
}

async function main() {
  const db = await getDb();
  
  // Get last 30 trade dates
  const datesRes = await db.execute(sql.raw(
    `SELECT DISTINCT tradeDate FROM rt_candles ORDER BY tradeDate DESC LIMIT 30`
  ));
  const dates = (datesRes as any)[0].map((r: any) => r.tradeDate).reverse();
  
  // Get all trades in this period
  const tradesRes = await db.execute(sql.raw(
    `SELECT * FROM rt_trades WHERE tradeDate >= '${dates[0]}' ORDER BY tradeDate, tradeTime`
  ));
  const allTrades = (tradesRes as any)[0] || [];
  
  // Pair entries with exits
  const pairs: TradePair[] = [];
  const processed = new Set<number>();
  
  for (let i = 0; i < allTrades.length; i++) {
    if (processed.has(i)) continue;
    const t = allTrades[i];
    if (t.action !== 'buy' && t.action !== 'short') continue;
    if (EXCLUDED.has(t.symbol)) continue;
    
    for (let j = i + 1; j < allTrades.length; j++) {
      if (processed.has(j)) continue;
      const e = allTrades[j];
      if (e.symbol === t.symbol && e.tradeDate === t.tradeDate && 
          (e.action === 'sell' || e.action === 'cover') && e.pnl !== null) {
        pairs.push({
          symbol: t.symbol,
          name: t.symbolName || t.symbol,
          date: t.tradeDate,
          side: t.side,
          entryPrice: Number(t.price),
          exitPrice: Number(e.price),
          shares: Number(t.shares),
          pnl: Number(e.pnl),
          entryTime: t.tradeTime,
          exitTime: e.tradeTime,
          reason: t.reason || '',
          exitReason: e.reason || '',
        });
        processed.add(j);
        break;
      }
    }
  }
  
  console.log('='.repeat(80));
  console.log('  日中レンジ内位置フィルター 30日間シミュレーション');
  console.log('  期間: ' + dates[0] + ' 〜 ' + dates[dates.length - 1]);
  console.log('  対象: ' + pairs.length + '件');
  console.log('='.repeat(80));
  
  // For each trade, calculate entry position within intraday range
  interface TradeWithPosition extends TradePair {
    dayHigh: number;
    dayLow: number;
    highAtEntry: number;  // entry時点までの高値
    lowAtEntry: number;   // entry時点までの安値
    entryPosition: number; // 0-100%
    rangeAtEntry: number;  // entry時点のレンジ幅(%)
  }
  
  const results: TradeWithPosition[] = [];
  
  for (const pair of pairs) {
    // Get candles up to entry time to calculate range at entry
    const candlesRes = await db.execute(sql.raw(
      `SELECT candleTime, high, low FROM rt_candles 
       WHERE tradeDate = '${pair.date}' AND symbol = '${pair.symbol}' 
       AND candleTime <= '${pair.entryTime}'
       ORDER BY candleTime`
    ));
    const candles = (candlesRes as any)[0] || [];
    
    if (candles.length === 0) continue;
    
    let highAtEntry = 0, lowAtEntry = Infinity;
    for (const c of candles) {
      highAtEntry = Math.max(highAtEntry, Number(c.high));
      lowAtEntry = Math.min(lowAtEntry, Number(c.low));
    }
    
    // Also get full day high/low for reference
    const dayRes = await db.execute(sql.raw(
      `SELECT MAX(high) as dayHigh, MIN(low) as dayLow FROM rt_candles 
       WHERE tradeDate = '${pair.date}' AND symbol = '${pair.symbol}'`
    ));
    const day = (dayRes as any)[0][0];
    
    const range = highAtEntry - lowAtEntry;
    const rangeAtEntry = range / highAtEntry * 100;
    const entryPosition = range > 0 ? (pair.entryPrice - lowAtEntry) / range * 100 : 50;
    
    results.push({
      ...pair,
      dayHigh: Number(day.dayHigh),
      dayLow: Number(day.dayLow),
      highAtEntry,
      lowAtEntry,
      entryPosition,
      rangeAtEntry,
    });
  }
  
  // Test multiple thresholds
  const thresholds = [15, 20, 25, 30];
  const MIN_RANGE = 0.5; // レンジが0.5%未満の場合はフィルター無効
  
  console.log('\n' + '─'.repeat(80));
  console.log('  閾値別比較（SHORT: Entry位置<=X%でブロック、LONG: Entry位置>=(100-X)%でブロック）');
  console.log('  ※レンジ幅0.5%未満の場合はフィルター無効');
  console.log('─'.repeat(80));
  
  // Baseline (no filter)
  const baselinePnl = results.reduce((s, r) => s + r.pnl, 0);
  const baselineWins = results.filter(r => r.pnl > 0).length;
  console.log(`\n  【フィルターなし（現行）】`);
  console.log(`  件数: ${results.length} | 勝率: ${(baselineWins / results.length * 100).toFixed(1)}% | 総PnL: ${baselinePnl.toLocaleString()}円`);
  
  for (const threshold of thresholds) {
    const blocked: TradeWithPosition[] = [];
    const passed: TradeWithPosition[] = [];
    
    for (const r of results) {
      // Skip filter if range is too small
      if (r.rangeAtEntry < MIN_RANGE) {
        passed.push(r);
        continue;
      }
      
      const shouldBlock = 
        (r.side === 'short' && r.entryPosition <= threshold) ||
        (r.side === 'long' && r.entryPosition >= (100 - threshold));
      
      if (shouldBlock) {
        blocked.push(r);
      } else {
        passed.push(r);
      }
    }
    
    const passedPnl = passed.reduce((s, r) => s + r.pnl, 0);
    const passedWins = passed.filter(r => r.pnl > 0).length;
    const blockedPnl = blocked.reduce((s, r) => s + r.pnl, 0);
    const blockedWins = blocked.filter(r => r.pnl > 0).length;
    const blockedLosses = blocked.filter(r => r.pnl <= 0).length;
    
    console.log(`\n  【閾値 ${threshold}% / ${100-threshold}%】`);
    console.log(`  通過: ${passed.length}件 | 勝率: ${(passedWins / passed.length * 100).toFixed(1)}% | 総PnL: ${passedPnl.toLocaleString()}円`);
    console.log(`  ブロック: ${blocked.length}件（勝ち${blockedWins}件/負け${blockedLosses}件）| ブロック分PnL: ${blockedPnl.toLocaleString()}円`);
    console.log(`  改善効果: ${(passedPnl - baselinePnl >= 0 ? '+' : '')}${(passedPnl - baselinePnl).toLocaleString()}円 (= -ブロック分${blockedPnl >= 0 ? '+' : ''}${blockedPnl.toLocaleString()}円)`);
    
    // Show blocked trades detail
    if (blocked.length > 0 && blocked.length <= 20) {
      console.log(`  ── ブロックされたトレード ──`);
      for (const b of blocked) {
        const pnlStr = b.pnl >= 0 ? '+' + b.pnl.toLocaleString() : b.pnl.toLocaleString();
        console.log(`    ${b.date} ${b.entryTime} ${b.name}(${b.symbol}) ${b.side} Entry位置:${b.entryPosition.toFixed(0)}% レンジ:${b.rangeAtEntry.toFixed(2)}% PnL:${pnlStr}円`);
      }
    }
  }
  
  // Best threshold: detailed breakdown by symbol
  const bestThreshold = 20;
  console.log('\n\n' + '='.repeat(80));
  console.log(`  閾値${bestThreshold}%: 銘柄別詳細`);
  console.log('='.repeat(80));
  
  const bySymbol: Record<string, { passed: TradeWithPosition[], blocked: TradeWithPosition[] }> = {};
  for (const r of results) {
    if (!bySymbol[r.symbol]) bySymbol[r.symbol] = { passed: [], blocked: [] };
    
    if (r.rangeAtEntry < MIN_RANGE) {
      bySymbol[r.symbol].passed.push(r);
      continue;
    }
    
    const shouldBlock = 
      (r.side === 'short' && r.entryPosition <= bestThreshold) ||
      (r.side === 'long' && r.entryPosition >= (100 - bestThreshold));
    
    if (shouldBlock) {
      bySymbol[r.symbol].blocked.push(r);
    } else {
      bySymbol[r.symbol].passed.push(r);
    }
  }
  
  console.log(`\n  銘柄    | 通過件数 | 通過PnL      | ブロック | ブロックPnL  | 改善効果`);
  console.log(`  ${'─'.repeat(80)}`);
  
  const symbolNames: Record<string, string> = {
    '8035': '東京エレクトロン', '6857': 'アドバンテスト', '6976': '太陽誘電',
    '6526': 'ソシオネクスト', '5803': 'フジクラ', '6981': '村田製作所',
    '285A': 'キオクシアHD', '8316': '三井住友FG', '6146': 'ディスコ', '6594': 'ニデック'
  };
  
  for (const [sym, data] of Object.entries(bySymbol).sort((a, b) => {
    const aEffect = -(a[1].blocked.reduce((s, r) => s + r.pnl, 0));
    const bEffect = -(b[1].blocked.reduce((s, r) => s + r.pnl, 0));
    return bEffect - aEffect;
  })) {
    const passedPnl = data.passed.reduce((s, r) => s + r.pnl, 0);
    const blockedPnl = data.blocked.reduce((s, r) => s + r.pnl, 0);
    const totalPnl = passedPnl + blockedPnl;
    const effect = -blockedPnl; // positive = improvement
    const name = symbolNames[sym] || sym;
    console.log(`  ${name.padEnd(12)} | ${String(data.passed.length).padStart(4)}件 | ${passedPnl.toLocaleString().padStart(12)}円 | ${String(data.blocked.length).padStart(4)}件 | ${blockedPnl.toLocaleString().padStart(12)}円 | ${(effect >= 0 ? '+' : '')}${effect.toLocaleString()}円`);
  }
  
  // Daily breakdown with best threshold
  console.log('\n\n' + '='.repeat(80));
  console.log(`  閾値${bestThreshold}%: 日別比較`);
  console.log('='.repeat(80));
  
  const byDate: Record<string, { baseline: number, filtered: number, blocked: number }> = {};
  for (const r of results) {
    if (!byDate[r.date]) byDate[r.date] = { baseline: 0, filtered: 0, blocked: 0 };
    byDate[r.date].baseline += r.pnl;
    
    if (r.rangeAtEntry < MIN_RANGE) {
      byDate[r.date].filtered += r.pnl;
      continue;
    }
    
    const shouldBlock = 
      (r.side === 'short' && r.entryPosition <= bestThreshold) ||
      (r.side === 'long' && r.entryPosition >= (100 - bestThreshold));
    
    if (shouldBlock) {
      byDate[r.date].blocked += r.pnl;
    } else {
      byDate[r.date].filtered += r.pnl;
    }
  }
  
  console.log(`\n  日付       | 現行PnL      | フィルター後   | 差分         | ブロック分`);
  console.log(`  ${'─'.repeat(75)}`);
  
  let cumBaseline = 0, cumFiltered = 0;
  for (const date of Object.keys(byDate).sort()) {
    const d = byDate[date];
    cumBaseline += d.baseline;
    cumFiltered += d.filtered;
    const diff = d.filtered - d.baseline;
    console.log(`  ${date} | ${d.baseline.toLocaleString().padStart(12)}円 | ${d.filtered.toLocaleString().padStart(12)}円 | ${(diff >= 0 ? '+' : '')}${diff.toLocaleString().padStart(10)}円 | ${d.blocked.toLocaleString().padStart(10)}円`);
  }
  console.log(`  ${'─'.repeat(75)}`);
  console.log(`  累計       | ${cumBaseline.toLocaleString().padStart(12)}円 | ${cumFiltered.toLocaleString().padStart(12)}円 | ${(cumFiltered - cumBaseline >= 0 ? '+' : '')}${(cumFiltered - cumBaseline).toLocaleString().padStart(10)}円`);
  
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
