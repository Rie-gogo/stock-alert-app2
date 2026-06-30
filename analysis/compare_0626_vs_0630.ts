/**
 * 6/26 vs 6/30 シグナル比較シミュレーション
 * ① 条件に変更がないか確認
 * ② シグナル本数の比較
 */
import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';
import { detectSignals, calcMA, calcRSI, calcBollinger } from '../server/routers/stockData';
import { boardReadingScore } from '../server/realtimeSimEngine';

async function main() {
  const db = await getDb();
  const symbols = ['6526', '9984', '6976', '6920', '8035', '6857'];
  
  console.log('=== ① 6/26 vs 6/30 取引結果比較 ===\n');
  
  // Get trades for both days
  for (const date of ['2026-06-26', '2026-06-30']) {
    const [trades] = await db.execute(sql`
      SELECT symbol, tradeTime, action, side, price, pnl, reason
      FROM rt_trades
      WHERE tradeDate = ${date}
      ORDER BY tradeTime ASC
    `);
    const tArr = trades as any[];
    const entries = tArr.filter(t => t.action === 'long' || t.action === 'short');
    const exits = tArr.filter(t => t.action === 'cover' || t.action === 'sell');
    const totalPnl = exits.reduce((sum, t) => sum + Number(t.pnl || 0), 0);
    const wins = exits.filter(t => Number(t.pnl || 0) > 0).length;
    
    console.log(`【${date}】 エントリー: ${entries.length}件 | 決済: ${exits.length}件 | 勝率: ${exits.length > 0 ? (wins/exits.length*100).toFixed(0) : 0}% | 損益: ${totalPnl.toLocaleString()}円`);
    for (const t of tArr) {
      const pnlStr = t.pnl ? ` pnl=${Number(t.pnl).toLocaleString()}` : '';
      console.log(`  ${t.tradeTime} ${t.symbol} ${t.action}(${t.side}) ${t.price}円${pnlStr} | ${(t.reason || '').substring(0, 55)}`);
    }
    console.log('');
  }
  
  console.log('\n=== ② シグナル本数比較 ===\n');
  
  for (const date of ['2026-06-26', '2026-06-30']) {
    console.log(`\n【${date}】`);
    let totalBuy = 0, totalSell = 0;
    let strongBuy = 0, strongSell = 0;
    let mediumBuy = 0, mediumSell = 0;
    
    const signalReasons: Record<string, {buy: number, sell: number}> = {};
    
    for (const sym of symbols) {
      const [rows] = await db.execute(sql`
        SELECT candleTime, open, high, low, close, volume, boardSnapshot
        FROM rt_candles
        WHERE tradeDate = ${date} AND symbol = ${sym}
        ORDER BY candleTime ASC
      `);
      const candles = (rows as any[]).map(r => ({
        time: r.candleTime,
        open: Number(r.open),
        high: Number(r.high),
        low: Number(r.low),
        close: Number(r.close),
        volume: Number(r.volume),
        boardSnapshot: r.boardSnapshot,
      }));
      
      if (candles.length === 0) continue;
      
      const closes = candles.map(c => c.close);
      const ma5 = calcMA(closes, 5);
      const ma25 = calcMA(closes, 25);
      const rsi = calcRSI(closes, 14);
      const bbResult = calcBollinger(closes, 20, 2);
      
      const buf = candles.map((c, i) => ({
        ...c,
        ma5: ma5[i] ?? null,
        ma25: ma25[i] ?? null,
        rsi: rsi[i] ?? null,
        bbUpper: bbResult.upper[i] ?? null,
        bbLower: bbResult.lower[i] ?? null,
        bbMiddle: bbResult.middle[i] ?? null,
        signal: null as any,
      }));
      
      const withSignals = detectSignals(buf);
      const buySignals = withSignals.filter(c => c.signal?.type === 'buy');
      const sellSignals = withSignals.filter(c => c.signal?.type === 'sell');
      
      totalBuy += buySignals.length;
      totalSell += sellSignals.length;
      strongBuy += buySignals.filter(c => c.signal?.confidence === 'strong').length;
      strongSell += sellSignals.filter(c => c.signal?.confidence === 'strong').length;
      mediumBuy += buySignals.filter(c => c.signal?.confidence === 'medium').length;
      mediumSell += sellSignals.filter(c => c.signal?.confidence === 'medium').length;
      
      // Categorize reasons
      for (const c of [...buySignals, ...sellSignals]) {
        const reason = c.signal!.reason.split('|')[0].split('(')[0].trim();
        if (!signalReasons[reason]) signalReasons[reason] = {buy: 0, sell: 0};
        if (c.signal!.type === 'buy') signalReasons[reason].buy++;
        else signalReasons[reason].sell++;
      }
    }
    
    console.log(`  BUYシグナル: ${totalBuy}件 (strong: ${strongBuy}, medium: ${mediumBuy})`);
    console.log(`  SELLシグナル: ${totalSell}件 (strong: ${strongSell}, medium: ${mediumSell})`);
    console.log(`  合計: ${totalBuy + totalSell}件`);
    
    console.log(`\n  シグナル種別内訳:`);
    const sorted = Object.entries(signalReasons).sort((a, b) => (b[1].buy + b[1].sell) - (a[1].buy + a[1].sell));
    for (const [reason, counts] of sorted) {
      console.log(`    ${reason}: BUY=${counts.buy} SELL=${counts.sell}`);
    }
  }
  
  console.log('\n\n=== ③ BUYシグナルのフィルター通過率比較 ===\n');
  
  for (const date of ['2026-06-26', '2026-06-30']) {
    console.log(`\n【${date}】`);
    let vwapUpBlocked = 0, sellPressureBlocked = 0, boardScoreBlocked = 0;
    let mediumBlocked = 0, timeBlocked = 0, htfBlocked = 0, wouldPass = 0;
    let totalBuySignals = 0;
    
    for (const sym of symbols) {
      const [rows] = await db.execute(sql`
        SELECT candleTime, open, high, low, close, volume, boardSnapshot
        FROM rt_candles
        WHERE tradeDate = ${date} AND symbol = ${sym}
        ORDER BY candleTime ASC
      `);
      const candles = (rows as any[]).map(r => ({
        time: r.candleTime,
        open: Number(r.open),
        high: Number(r.high),
        low: Number(r.low),
        close: Number(r.close),
        volume: Number(r.volume),
        boardSnapshot: r.boardSnapshot,
      }));
      
      if (candles.length === 0) continue;
      
      const closes = candles.map(c => c.close);
      const ma5 = calcMA(closes, 5);
      const ma25 = calcMA(closes, 25);
      const rsi = calcRSI(closes, 14);
      const bbResult = calcBollinger(closes, 20, 2);
      
      const buf = candles.map((c, i) => ({
        ...c,
        ma5: ma5[i] ?? null,
        ma25: ma25[i] ?? null,
        rsi: rsi[i] ?? null,
        bbUpper: bbResult.upper[i] ?? null,
        bbLower: bbResult.lower[i] ?? null,
        bbMiddle: bbResult.middle[i] ?? null,
        signal: null as any,
      }));
      
      const withSignals = detectSignals(buf);
      const buySignals = withSignals.filter(c => c.signal?.type === 'buy');
      totalBuySignals += buySignals.length;
      
      for (const c of buySignals) {
        const sig = c.signal!;
        const idx = candles.findIndex(x => x.time === c.time);
        const bs = candles[idx]?.boardSnapshot;
        const boardSig = bs?.signal || 'neutral';
        
        // Time filter
        if (c.time >= '11:00' && c.time < '11:30') { timeBlocked++; continue; }
        if (c.time >= '12:30' && c.time < '13:00') { timeBlocked++; continue; }
        
        // VWAPクロス上抜け無効化
        if (sig.reason.includes('VWAPクロス上抜け')) { vwapUpBlocked++; continue; }
        
        // sell_pressure時LONG禁止
        if (boardSig === 'sell_pressure') { sellPressureBlocked++; continue; }
        
        // Board reading score
        const brScore = boardReadingScore(sym, 'long', bs);
        if (brScore < 1) { boardScoreBlocked++; continue; }
        
        // medium品質ブロック (ダウ理論以外)
        if (sig.confidence === 'medium' && !sig.reason.startsWith('ダウ理論')) { mediumBlocked++; continue; }
        
        // ダウ理論は押し目待機
        if (sig.reason.startsWith('ダウ理論: 直近高値更新')) { htfBlocked++; continue; }
        
        wouldPass++;
      }
    }
    
    console.log(`  BUYシグナル合計: ${totalBuySignals}件`);
    console.log(`  ├─ 時間帯フィルター: ${timeBlocked}件`);
    console.log(`  ├─ VWAPクロス上抜け無効化: ${vwapUpBlocked}件`);
    console.log(`  ├─ sell_pressure時LONG禁止: ${sellPressureBlocked}件`);
    console.log(`  ├─ 板読みスコア不足(<1): ${boardScoreBlocked}件`);
    console.log(`  ├─ medium品質ブロック: ${mediumBlocked}件`);
    console.log(`  ├─ ダウ理論→押し目待機: ${htfBlocked}件`);
    console.log(`  └─ 通過候補: ${wouldPass}件`);
  }
  
  console.log('\n\n=== ④ 板状況比較 ===\n');
  
  for (const date of ['2026-06-26', '2026-06-30']) {
    console.log(`\n【${date}】`);
    for (const sym of symbols) {
      const [rows] = await db.execute(sql`
        SELECT 
          SUM(CASE WHEN JSON_EXTRACT(boardSnapshot, '$.signal') = 'sell_pressure' THEN 1 ELSE 0 END) as sp,
          SUM(CASE WHEN JSON_EXTRACT(boardSnapshot, '$.signal') = 'buy_pressure' THEN 1 ELSE 0 END) as bp,
          SUM(CASE WHEN JSON_EXTRACT(boardSnapshot, '$.signal') = 'neutral' THEN 1 ELSE 0 END) as nt,
          COUNT(*) as total
        FROM rt_candles
        WHERE tradeDate = ${date} AND symbol = ${sym}
      `);
      const r = (rows as any[])[0];
      console.log(`  ${sym}: sell_pressure=${r.sp}(${(r.sp/r.total*100).toFixed(0)}%) buy_pressure=${r.bp}(${(r.bp/r.total*100).toFixed(0)}%) neutral=${r.nt}(${(r.nt/r.total*100).toFixed(0)}%)`);
    }
  }
  
  console.log('\n\n=== ⑤ 価格変動比較 ===\n');
  
  for (const date of ['2026-06-26', '2026-06-30']) {
    console.log(`\n【${date}】`);
    for (const sym of symbols) {
      const [rows] = await db.execute(sql`
        SELECT open, close FROM rt_candles
        WHERE tradeDate = ${date} AND symbol = ${sym}
        ORDER BY candleTime ASC
      `);
      const arr = rows as any[];
      if (arr.length === 0) { console.log(`  ${sym}: データなし`); continue; }
      const dayOpen = Number(arr[0].open);
      const dayClose = Number(arr[arr.length - 1].close);
      const change = ((dayClose - dayOpen) / dayOpen * 100).toFixed(2);
      const highs = arr.map(r => Number(r.close));
      const dayHigh = Math.max(...highs);
      const dayLow = Math.min(...highs);
      const range = ((dayHigh - dayLow) / dayOpen * 100).toFixed(2);
      console.log(`  ${sym}: 始値=${dayOpen} 終値=${dayClose} 騰落=${change}% レンジ=${range}%`);
    }
  }
  
  process.exit(0);
}
main();
