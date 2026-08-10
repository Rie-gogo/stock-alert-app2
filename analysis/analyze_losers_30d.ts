/**
 * 負け取引64件の共通点分析
 */
import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

const EXCLUDED = new Set(['6920', '6758', '9984', '7011', '9107', '8306', '4568', '5016', '7203', '3778', '3436', '6723']);

const SYMBOL_SL_MAP: Record<string, number> = {
  "8035": 0.8, "6857": 0.6, "6976": 0.5, "6526": 0.9,
  "5803": 0.5, "6981": 0.9, "285A": 0.8, "6146": 0.8,
  "6594": 0.5, "8316": 0.5,
};

async function main() {
  const db = await getDb();
  
  // Get all trades from last 30 days
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
    reason: string; boardSignal: string; confidence: string;
    signalReason: string;
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
          confidence: t.confidence || 'unknown',
          signalReason: t.reason || '',
        });
        processed.add(j);
        break;
      }
    }
  }
  
  // Recalculate with current SL
  const simPairs: (TradePair & { simPnl: number; simReason: string })[] = [];
  
  for (const pair of pairs) {
    const sl = SYMBOL_SL_MAP[pair.symbol] ?? 0.5;
    const candlesRes = await db.execute(sql.raw(
      `SELECT candleTime, open, high, low, close, volume FROM rt_candles 
       WHERE tradeDate = '${pair.date}' AND symbol = '${pair.symbol}' 
       AND candleTime >= '${pair.entryTime}' ORDER BY candleTime`
    ));
    const candles = (candlesRes as any)[0] || [];
    
    const tpPrice = pair.side === 'long' 
      ? pair.entryPrice * (1 + 1.5 / 100)
      : pair.entryPrice * (1 - 1.5 / 100);
    const slPrice = pair.side === 'long'
      ? pair.entryPrice * (1 - sl / 100)
      : pair.entryPrice * (1 + sl / 100);
    
    let simPnl = pair.pnl;
    let simReason = pair.reason;
    let exited = false;
    
    for (const c of candles) {
      if (c.candleTime === pair.entryTime) continue;
      const high = Number(c.high); const low = Number(c.low);
      if (pair.side === 'long') {
        if (low <= slPrice) { simPnl = (slPrice - pair.entryPrice) * pair.shares; simReason = `損切り(SL:${sl}%)`; exited = true; break; }
        if (high >= tpPrice) { simPnl = (tpPrice - pair.entryPrice) * pair.shares; simReason = `利確(TP)`; exited = true; break; }
      } else {
        if (high >= slPrice) { simPnl = (pair.entryPrice - slPrice) * pair.shares; simReason = `損切り(SL:${sl}%)`; exited = true; break; }
        if (low <= tpPrice) { simPnl = (pair.entryPrice - tpPrice) * pair.shares; simReason = `利確(TP)`; exited = true; break; }
      }
    }
    if (!exited && candles.length > 0) {
      const last = candles[candles.length - 1];
      simPnl = pair.side === 'long' ? (Number(last.close) - pair.entryPrice) * pair.shares : (pair.entryPrice - Number(last.close)) * pair.shares;
      simReason = '大引け強制';
    }
    
    simPairs.push({ ...pair, simPnl, simReason });
  }
  
  const losers = simPairs.filter(t => t.simPnl <= 0);
  const winners = simPairs.filter(t => t.simPnl > 0);
  
  console.log(`${'='.repeat(80)}`);
  console.log(`  負け取引の共通点分析`);
  console.log(`  全${simPairs.length}件中: 勝ち${winners.length}件 / 負け${losers.length}件`);
  console.log(`${'='.repeat(80)}`);
  
  // 1. 時間帯別
  console.log(`\n── 1. エントリー時間帯別 ──`);
  const hourBuckets: Record<string, { wins: number; losses: number; lossPnl: number }> = {};
  for (const t of simPairs) {
    const hour = t.entryTime.substring(0, 2);
    if (!hourBuckets[hour]) hourBuckets[hour] = { wins: 0, losses: 0, lossPnl: 0 };
    if (t.simPnl > 0) hourBuckets[hour].wins++;
    else { hourBuckets[hour].losses++; hourBuckets[hour].lossPnl += t.simPnl; }
  }
  console.log(`  時間 | 勝ち | 負け | 負け率 | 負けPnL`);
  for (const [h, v] of Object.entries(hourBuckets).sort()) {
    const total = v.wins + v.losses;
    console.log(`  ${h}時 | ${String(v.wins).padStart(4)} | ${String(v.losses).padStart(4)} | ${(v.losses/total*100).toFixed(0).padStart(4)}% | ${v.lossPnl.toLocaleString()}円`);
  }
  
  // 2. 板シグナル別
  console.log(`\n── 2. 板シグナル別 ──`);
  const boardBuckets: Record<string, { wins: number; losses: number; lossPnl: number }> = {};
  for (const t of simPairs) {
    const key = t.boardSignal;
    if (!boardBuckets[key]) boardBuckets[key] = { wins: 0, losses: 0, lossPnl: 0 };
    if (t.simPnl > 0) boardBuckets[key].wins++;
    else { boardBuckets[key].losses++; boardBuckets[key].lossPnl += t.simPnl; }
  }
  console.log(`  板シグナル | 勝ち | 負け | 負け率 | 負けPnL`);
  for (const [k, v] of Object.entries(boardBuckets).sort((a, b) => b[1].lossPnl - a[1].lossPnl)) {
    const total = v.wins + v.losses;
    console.log(`  ${k.padEnd(14)} | ${String(v.wins).padStart(4)} | ${String(v.losses).padStart(4)} | ${(v.losses/total*100).toFixed(0).padStart(4)}% | ${v.lossPnl.toLocaleString()}円`);
  }
  
  // 3. 信頼度別
  console.log(`\n── 3. 信頼度別 ──`);
  const confBuckets: Record<string, { wins: number; losses: number; lossPnl: number }> = {};
  for (const t of simPairs) {
    const key = t.confidence;
    if (!confBuckets[key]) confBuckets[key] = { wins: 0, losses: 0, lossPnl: 0 };
    if (t.simPnl > 0) confBuckets[key].wins++;
    else { confBuckets[key].losses++; confBuckets[key].lossPnl += t.simPnl; }
  }
  console.log(`  信頼度 | 勝ち | 負け | 負け率 | 負けPnL`);
  for (const [k, v] of Object.entries(confBuckets).sort((a, b) => b[1].lossPnl - a[1].lossPnl)) {
    const total = v.wins + v.losses;
    console.log(`  ${k.padEnd(10)} | ${String(v.wins).padStart(4)} | ${String(v.losses).padStart(4)} | ${(v.losses/total*100).toFixed(0).padStart(4)}% | ${v.lossPnl.toLocaleString()}円`);
  }
  
  // 4. 方向別
  console.log(`\n── 4. 方向別 ──`);
  const sideBuckets: Record<string, { wins: number; losses: number; lossPnl: number; winPnl: number }> = {};
  for (const t of simPairs) {
    if (!sideBuckets[t.side]) sideBuckets[t.side] = { wins: 0, losses: 0, lossPnl: 0, winPnl: 0 };
    if (t.simPnl > 0) { sideBuckets[t.side].wins++; sideBuckets[t.side].winPnl += t.simPnl; }
    else { sideBuckets[t.side].losses++; sideBuckets[t.side].lossPnl += t.simPnl; }
  }
  console.log(`  方向 | 勝ち | 負け | 負け率 | 勝ちPnL | 負けPnL`);
  for (const [k, v] of Object.entries(sideBuckets)) {
    const total = v.wins + v.losses;
    console.log(`  ${k.padEnd(6)} | ${String(v.wins).padStart(4)} | ${String(v.losses).padStart(4)} | ${(v.losses/total*100).toFixed(0).padStart(4)}% | +${v.winPnl.toLocaleString()}円 | ${v.lossPnl.toLocaleString()}円`);
  }
  
  // 5. 保有時間別
  console.log(`\n── 5. 保有時間別 ──`);
  function timeDiffMin(t1: string, t2: string): number {
    const [h1, m1] = t1.split(':').map(Number);
    const [h2, m2] = t2.split(':').map(Number);
    return (h2 * 60 + m2) - (h1 * 60 + m1);
  }
  
  const holdBuckets: Record<string, { wins: number; losses: number; lossPnl: number }> = {};
  for (const t of simPairs) {
    const mins = timeDiffMin(t.entryTime, t.exitTime);
    let bucket: string;
    if (mins <= 5) bucket = '0-5分';
    else if (mins <= 15) bucket = '6-15分';
    else if (mins <= 30) bucket = '16-30分';
    else if (mins <= 60) bucket = '31-60分';
    else bucket = '60分超';
    if (!holdBuckets[bucket]) holdBuckets[bucket] = { wins: 0, losses: 0, lossPnl: 0 };
    if (t.simPnl > 0) holdBuckets[bucket].wins++;
    else { holdBuckets[bucket].losses++; holdBuckets[bucket].lossPnl += t.simPnl; }
  }
  console.log(`  保有時間 | 勝ち | 負け | 負け率 | 負けPnL`);
  for (const bucket of ['0-5分', '6-15分', '16-30分', '31-60分', '60分超']) {
    const v = holdBuckets[bucket];
    if (!v) continue;
    const total = v.wins + v.losses;
    console.log(`  ${bucket.padEnd(8)} | ${String(v.wins).padStart(4)} | ${String(v.losses).padStart(4)} | ${(v.losses/total*100).toFixed(0).padStart(4)}% | ${v.lossPnl.toLocaleString()}円`);
  }
  
  // 6. 同日複数エントリー分析
  console.log(`\n── 6. 同日同銘柄の2回目以降 ──`);
  const daySymCount: Record<string, number> = {};
  const nthEntry: { first: { wins: number; losses: number; pnl: number }; later: { wins: number; losses: number; pnl: number } } = {
    first: { wins: 0, losses: 0, pnl: 0 },
    later: { wins: 0, losses: 0, pnl: 0 },
  };
  for (const t of simPairs) {
    const key = `${t.date}_${t.symbol}`;
    daySymCount[key] = (daySymCount[key] || 0) + 1;
    const isFirst = daySymCount[key] === 1;
    const bucket = isFirst ? nthEntry.first : nthEntry.later;
    if (t.simPnl > 0) bucket.wins++;
    else bucket.losses++;
    bucket.pnl += t.simPnl;
  }
  console.log(`  1回目: 勝ち${nthEntry.first.wins} / 負け${nthEntry.first.losses} | 勝率${(nthEntry.first.wins/(nthEntry.first.wins+nthEntry.first.losses)*100).toFixed(1)}% | PnL: ${nthEntry.first.pnl.toLocaleString()}円`);
  console.log(`  2回目以降: 勝ち${nthEntry.later.wins} / 負け${nthEntry.later.losses} | 勝率${(nthEntry.later.wins/(nthEntry.later.wins+nthEntry.later.losses)*100).toFixed(1)}% | PnL: ${nthEntry.later.pnl.toLocaleString()}円`);
  
  // 7. シグナル種別
  console.log(`\n── 7. シグナル種別別 ──`);
  const sigBuckets: Record<string, { wins: number; losses: number; winPnl: number; lossPnl: number }> = {};
  for (const t of simPairs) {
    let sigType = '不明';
    if (t.signalReason.includes('大台確認') || t.signalReason.includes('大台割れ') || t.signalReason.includes('大台超え')) sigType = '大台確認';
    else if (t.signalReason.includes('ゴールデンクロス') || t.signalReason.includes('GC')) sigType = 'GC';
    else if (t.signalReason.includes('デッドクロス') || t.signalReason.includes('DC')) sigType = 'DC';
    else if (t.signalReason.includes('三尊') || t.signalReason.includes('逆三尊')) sigType = '三尊/逆三尊';
    else if (t.signalReason.includes('VWAP')) sigType = 'VWAPクロス';
    else if (t.signalReason.includes('ダウ')) sigType = 'ダウ理論';
    else sigType = 'その他';
    if (!sigBuckets[sigType]) sigBuckets[sigType] = { wins: 0, losses: 0, winPnl: 0, lossPnl: 0 };
    if (t.simPnl > 0) { sigBuckets[sigType].wins++; sigBuckets[sigType].winPnl += t.simPnl; }
    else { sigBuckets[sigType].losses++; sigBuckets[sigType].lossPnl += t.simPnl; }
  }
  console.log(`  シグナル | 勝ち | 負け | 勝率 | 勝ちPnL | 負けPnL | net`);
  for (const [k, v] of Object.entries(sigBuckets).sort((a, b) => (b[1].winPnl + b[1].lossPnl) - (a[1].winPnl + a[1].lossPnl))) {
    const total = v.wins + v.losses;
    const net = v.winPnl + v.lossPnl;
    console.log(`  ${k.padEnd(10)} | ${String(v.wins).padStart(4)} | ${String(v.losses).padStart(4)} | ${(v.wins/total*100).toFixed(0).padStart(4)}% | +${v.winPnl.toLocaleString().padStart(10)} | ${v.lossPnl.toLocaleString().padStart(10)} | ${net >= 0 ? '+' : ''}${net.toLocaleString()}円`);
  }
  
  // 8. 負けの大きさ分布
  console.log(`\n── 8. 負け金額の分布 ──`);
  const lossBuckets = { small: 0, medium: 0, large: 0, xlarge: 0 };
  const lossBucketPnl = { small: 0, medium: 0, large: 0, xlarge: 0 };
  for (const t of losers) {
    const loss = Math.abs(t.simPnl);
    if (loss < 15000) { lossBuckets.small++; lossBucketPnl.small += t.simPnl; }
    else if (loss < 30000) { lossBuckets.medium++; lossBucketPnl.medium += t.simPnl; }
    else if (loss < 50000) { lossBuckets.large++; lossBucketPnl.large += t.simPnl; }
    else { lossBuckets.xlarge++; lossBucketPnl.xlarge += t.simPnl; }
  }
  console.log(`  〜15,000円: ${lossBuckets.small}件 (${lossBucketPnl.small.toLocaleString()}円)`);
  console.log(`  15,000〜30,000円: ${lossBuckets.medium}件 (${lossBucketPnl.medium.toLocaleString()}円)`);
  console.log(`  30,000〜50,000円: ${lossBuckets.large}件 (${lossBucketPnl.large.toLocaleString()}円)`);
  console.log(`  50,000円超: ${lossBuckets.xlarge}件 (${lossBucketPnl.xlarge.toLocaleString()}円)`);
  
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
