/**
 * 5分以内損切り25件の詳細分析
 * - 方向が合っていたか（損切り後にTP到達したか）
 * - エントリーが早すぎたのか（もう少し待てば良かったか）
 */
import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

const EXCLUDED = new Set(['6920', '6758', '9984', '7011', '9107', '8306', '4568', '5016', '7203', '3778', '3436', '6723']);
const SYMBOL_SL_MAP: Record<string, number> = {
  "8035": 0.8, "6857": 0.6, "6976": 0.5, "6526": 0.9,
  "5803": 0.5, "6981": 0.9, "285A": 0.8, "6146": 0.8,
  "6594": 0.5, "8316": 0.5,
};

function timeDiffMin(t1: string, t2: string): number {
  const [h1, m1] = t1.split(':').map(Number);
  const [h2, m2] = t2.split(':').map(Number);
  return (h2 * 60 + m2) - (h1 * 60 + m1);
}

async function main() {
  const db = await getDb();
  
  const datesRes = await db.execute(sql.raw(
    `SELECT DISTINCT tradeDate FROM rt_candles ORDER BY tradeDate DESC LIMIT 30`
  ));
  const dates = (datesRes as any)[0].map((r: any) => r.tradeDate).reverse();
  
  const tradesRes = await db.execute(sql.raw(
    `SELECT * FROM rt_trades WHERE tradeDate >= '${dates[0]}' ORDER BY tradeDate, tradeTime`
  ));
  const allTrades = (tradesRes as any)[0] || [];
  
  // Pair entries with exits
  interface TradePair {
    symbol: string; date: string; side: string;
    entryPrice: number; exitPrice: number; shares: number;
    pnl: number; entryTime: string; exitTime: string;
    reason: string; boardSignal: string; signalReason: string;
  }
  
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
          symbol: t.symbol, date: t.tradeDate, side: t.side,
          entryPrice: Number(t.price), exitPrice: Number(e.price),
          shares: Number(t.shares), pnl: Number(e.pnl),
          entryTime: t.tradeTime, exitTime: e.tradeTime,
          reason: e.reason || '', boardSignal: t.boardSignal || 'unknown',
          signalReason: t.reason || '',
        });
        processed.add(j);
        break;
      }
    }
  }
  
  // Filter 5-min stopouts
  const fiveMinStops = pairs.filter(t => {
    const holdMin = timeDiffMin(t.entryTime, t.exitTime);
    return holdMin <= 5 && t.pnl <= 0;
  });
  
  console.log(`${'='.repeat(80)}`);
  console.log(`  5分以内損切り ${fiveMinStops.length}件の詳細分析`);
  console.log(`${'='.repeat(80)}`);
  
  // For each, check what happened AFTER the stop
  let directionCorrect = 0;
  let directionWrong = 0;
  let tpReachedAfter = 0;
  let entryTooEarly = 0;
  
  const details: any[] = [];
  
  for (const t of fiveMinStops) {
    const sl = SYMBOL_SL_MAP[t.symbol] ?? 0.5;
    
    // Get ALL candles for the rest of the day after entry
    const candlesRes = await db.execute(sql.raw(
      `SELECT candleTime, open, high, low, close FROM rt_candles 
       WHERE tradeDate = '${t.date}' AND symbol = '${t.symbol}' 
       AND candleTime >= '${t.entryTime}' ORDER BY candleTime`
    ));
    const candles = (candlesRes as any)[0] || [];
    
    // Calculate MFE (max favorable excursion) after stop
    const tpPrice = t.side === 'long' 
      ? t.entryPrice * (1 + 1.5 / 100)
      : t.entryPrice * (1 - 1.5 / 100);
    
    let maxFavorable = 0;  // from entry price, in %
    let maxAdverse = 0;    // from entry price, in %
    let tpReached = false;
    let tpReachedTime = '';
    let afterStopMFE = 0;  // MFE after the stop time
    let afterStopTPReached = false;
    let afterStopTPTime = '';
    
    let passedStopTime = false;
    
    for (const c of candles) {
      if (c.candleTime === t.entryTime) continue;
      
      const high = Number(c.high);
      const low = Number(c.low);
      
      if (t.side === 'long') {
        const favorable = (high - t.entryPrice) / t.entryPrice * 100;
        const adverse = (t.entryPrice - low) / t.entryPrice * 100;
        if (favorable > maxFavorable) maxFavorable = favorable;
        if (adverse > maxAdverse) maxAdverse = adverse;
        if (high >= tpPrice && !tpReached) { tpReached = true; tpReachedTime = c.candleTime; }
        
        if (passedStopTime) {
          if (favorable > afterStopMFE) afterStopMFE = favorable;
          if (high >= tpPrice && !afterStopTPReached) { afterStopTPReached = true; afterStopTPTime = c.candleTime; }
        }
      } else {
        const favorable = (t.entryPrice - low) / t.entryPrice * 100;
        const adverse = (high - t.entryPrice) / t.entryPrice * 100;
        if (favorable > maxFavorable) maxFavorable = favorable;
        if (adverse > maxAdverse) maxAdverse = adverse;
        if (low <= tpPrice && !tpReached) { tpReached = true; tpReachedTime = c.candleTime; }
        
        if (passedStopTime) {
          if (favorable > afterStopMFE) afterStopMFE = favorable;
          if (low <= tpPrice && !afterStopTPReached) { afterStopTPReached = true; afterStopTPTime = c.candleTime; }
        }
      }
      
      if (c.candleTime === t.exitTime) passedStopTime = true;
    }
    
    // Determine category
    let category: string;
    if (tpReached) {
      category = 'A: 方向正解・TP到達可能（SLが狭すぎ/エントリー早すぎ）';
      entryTooEarly++;
      directionCorrect++;
    } else if (maxFavorable >= 0.5) {
      category = 'B: 方向正解だがTP未到達（値幅不足）';
      directionCorrect++;
    } else {
      category = 'C: 方向不正解（即座に逆行）';
      directionWrong++;
    }
    
    if (afterStopTPReached) tpReachedAfter++;
    
    details.push({
      date: t.date,
      time: t.entryTime,
      symbol: t.symbol,
      side: t.side,
      sl,
      pnl: t.pnl,
      holdMin: timeDiffMin(t.entryTime, t.exitTime),
      maxFavorable: maxFavorable.toFixed(2),
      maxAdverse: maxAdverse.toFixed(2),
      tpReached,
      tpReachedTime,
      afterStopTPReached,
      afterStopTPTime,
      category,
      boardSignal: t.boardSignal,
    });
  }
  
  // Summary
  console.log(`\n── カテゴリ別集計 ──`);
  const catA = details.filter(d => d.category.startsWith('A'));
  const catB = details.filter(d => d.category.startsWith('B'));
  const catC = details.filter(d => d.category.startsWith('C'));
  
  console.log(`  A: 方向正解・TP到達可能（SLが狭すぎ/エントリー早すぎ）: ${catA.length}件 (${(catA.length/fiveMinStops.length*100).toFixed(0)}%)`);
  console.log(`     → 損切り後にTP到達: ${catA.filter(d => d.afterStopTPReached).length}件`);
  console.log(`     → 合計損失: ${catA.reduce((s: number, d: any) => s + d.pnl, 0).toLocaleString()}円`);
  console.log(`  B: 方向正解だがTP未到達（値幅不足）: ${catB.length}件 (${(catB.length/fiveMinStops.length*100).toFixed(0)}%)`);
  console.log(`     → 合計損失: ${catB.reduce((s: number, d: any) => s + d.pnl, 0).toLocaleString()}円`);
  console.log(`  C: 方向不正解（即座に逆行）: ${catC.length}件 (${(catC.length/fiveMinStops.length*100).toFixed(0)}%)`);
  console.log(`     → 合計損失: ${catC.reduce((s: number, d: any) => s + d.pnl, 0).toLocaleString()}円`);
  
  console.log(`\n  方向正解率: ${((directionCorrect/fiveMinStops.length)*100).toFixed(0)}% (${directionCorrect}/${fiveMinStops.length})`);
  console.log(`  損切り後にTP到達: ${tpReachedAfter}件 (${(tpReachedAfter/fiveMinStops.length*100).toFixed(0)}%)`);
  
  // Detail table
  console.log(`\n── 全${fiveMinStops.length}件の詳細 ──`);
  console.log(`  日付       | 時刻  | 銘柄  | 方向  | SL   | 保有 | MFE   | MAE   | TP到達 | 後TP | 板        | カテゴリ`);
  console.log(`  ${'─'.repeat(110)}`);
  
  for (const d of details.sort((a: any, b: any) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time))) {
    console.log(`  ${d.date} | ${d.time} | ${d.symbol.padEnd(5)} | ${d.side.padEnd(5)} | ${(d.sl+'%').padStart(4)} | ${d.holdMin}分 | ${(d.maxFavorable+'%').padStart(6)} | ${(d.maxAdverse+'%').padStart(6)} | ${d.tpReached ? '○' : '×'}    | ${d.afterStopTPReached ? '○' : '×'}  | ${d.boardSignal.padEnd(14)} | ${d.category.charAt(0)}`);
  }
  
  // Category A breakdown by symbol
  console.log(`\n── カテゴリA（SLが狭すぎ）の銘柄別 ──`);
  const catABySymbol: Record<string, number> = {};
  for (const d of catA) {
    catABySymbol[d.symbol] = (catABySymbol[d.symbol] || 0) + 1;
  }
  for (const [sym, count] of Object.entries(catABySymbol).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${sym}: ${count}件`);
  }
  
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
