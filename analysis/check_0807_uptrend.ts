/**
 * 8/7の10:40頃からの上昇トレンドをシグナルが捉えられたか分析
 * 村田製作所(6981): 6,948円(底)→7,350円付近(12時頃) = +5.8%上昇
 * 東京エレクトロン(8035): 53,270円(底)→55,000円付近(12時頃) = +3.2%上昇
 */

import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

async function main() {
  const db = await getDb();
  
  const symbols = ['6981', '8035'];
  
  for (const sym of symbols) {
    console.log('\n' + '='.repeat(80));
    console.log(`  ${sym} — 8/7 の1分足データ分析（10:20〜11:30）`);
    console.log('='.repeat(80));
    
    const res = await db.execute(sql.raw(
      `SELECT open, high, low, close, volume, candleTime FROM rt_candles 
       WHERE tradeDate = '2026-08-07' AND symbol = '${sym}' 
       ORDER BY candleTime`
    ));
    const allCandles = (res as any)[0].map((r: any) => ({
      open: Number(r.open), high: Number(r.high), low: Number(r.low), 
      close: Number(r.close), volume: Number(r.volume || 0), candleTime: r.candleTime,
    }));
    
    if (allCandles.length === 0) { console.log('  データなし'); continue; }
    
    // Show candles around 10:20-11:30
    console.log('\n  時刻    | 始値     | 高値     | 安値     | 終値     | 出来高  | MA5      | MA10     | MA20     | GC?');
    console.log('  ' + '─'.repeat(100));
    
    const closes: number[] = [];
    const volumes: number[] = [];
    let prevMA5 = 0, prevMA10 = 0;
    
    for (const c of allCandles) {
      closes.push(c.close);
      volumes.push(c.volume);
      
      const timeMin = parseInt(c.candleTime.split(':')[0]) * 60 + parseInt(c.candleTime.split(':')[1]);
      
      // Calculate MAs
      const ma5 = closes.length >= 5 ? closes.slice(-5).reduce((s, v) => s + v, 0) / 5 : 0;
      const ma10 = closes.length >= 10 ? closes.slice(-10).reduce((s, v) => s + v, 0) / 10 : 0;
      const ma20 = closes.length >= 20 ? closes.slice(-20).reduce((s, v) => s + v, 0) / 20 : 0;
      
      // Detect GC (MA5 crosses above MA10)
      const gcNow = prevMA5 > 0 && prevMA10 > 0 && ma5 > ma10 && prevMA5 <= prevMA10;
      
      // Detect volume spike
      const avgVol = volumes.length >= 20 ? volumes.slice(-21, -1).reduce((s, v) => s + v, 0) / 20 : 0;
      const volRatio = avgVol > 0 ? c.volume / avgVol : 0;
      
      // Only show 10:20-11:30
      if (timeMin >= 620 && timeMin <= 690) {
        const gcStr = gcNow ? '★GC' : '';
        const volStr = volRatio >= 2.0 ? ` Vol${volRatio.toFixed(1)}x` : '';
        const bullish = c.close > c.open ? '陽' : '陰';
        console.log(`  ${c.candleTime} | ${c.open.toLocaleString().padStart(7)} | ${c.high.toLocaleString().padStart(7)} | ${c.low.toLocaleString().padStart(7)} | ${c.close.toLocaleString().padStart(7)} | ${c.volume.toLocaleString().padStart(6)} | ${ma5.toFixed(0).padStart(7)} | ${ma10.toFixed(0).padStart(7)} | ${ma20.toFixed(0).padStart(7)} | ${gcStr}${volStr} ${bullish}`);
      }
      
      prevMA5 = ma5;
      prevMA10 = ma10;
    }
    
    // Find the bottom and subsequent rise
    const bottomIdx = allCandles.findIndex((c: any) => {
      const t = parseInt(c.candleTime.split(':')[0]) * 60 + parseInt(c.candleTime.split(':')[1]);
      return t >= 600 && t <= 660 && c.low === Math.min(...allCandles.filter((x: any) => {
        const xt = parseInt(x.candleTime.split(':')[0]) * 60 + parseInt(x.candleTime.split(':')[1]);
        return xt >= 570 && xt <= 660;
      }).map((x: any) => x.low));
    });
    
    // Find actual bottom
    let minLow = Infinity, minTime = '';
    for (const c of allCandles) {
      const t = parseInt(c.candleTime.split(':')[0]) * 60 + parseInt(c.candleTime.split(':')[1]);
      if (t >= 570 && t <= 680 && c.low < minLow) {
        minLow = c.low;
        minTime = c.candleTime;
      }
    }
    
    // Find when MA5 > MA10 first occurred after bottom
    let gcTime = '';
    let gcPrice = 0;
    const closesForGC: number[] = [];
    let prevMA5gc = 0, prevMA10gc = 0;
    for (const c of allCandles) {
      closesForGC.push(c.close);
      const ma5 = closesForGC.length >= 5 ? closesForGC.slice(-5).reduce((s, v) => s + v, 0) / 5 : 0;
      const ma10 = closesForGC.length >= 10 ? closesForGC.slice(-10).reduce((s, v) => s + v, 0) / 10 : 0;
      
      const t = parseInt(c.candleTime.split(':')[0]) * 60 + parseInt(c.candleTime.split(':')[1]);
      if (t > 630 && prevMA5gc > 0 && prevMA10gc > 0 && ma5 > ma10 && prevMA5gc <= prevMA10gc && !gcTime) {
        gcTime = c.candleTime;
        gcPrice = c.close;
      }
      prevMA5gc = ma5;
      prevMA10gc = ma10;
    }
    
    // Find 3-bar consecutive bullish after bottom
    let threeBullTime = '';
    let threeBullPrice = 0;
    for (let i = 2; i < allCandles.length; i++) {
      const t = parseInt(allCandles[i].candleTime.split(':')[0]) * 60 + parseInt(allCandles[i].candleTime.split(':')[1]);
      if (t <= 630) continue; // After 10:30 only
      if (allCandles[i].close > allCandles[i].open && 
          allCandles[i-1].close > allCandles[i-1].open && 
          allCandles[i-2].close > allCandles[i-2].open &&
          allCandles[i].close > allCandles[i-1].close &&
          allCandles[i-1].close > allCandles[i-2].close &&
          !threeBullTime) {
        threeBullTime = allCandles[i].candleTime;
        threeBullPrice = allCandles[i].close;
      }
    }
    
    // Find when close > MA20 after bottom
    let aboveMA20Time = '';
    let aboveMA20Price = 0;
    const closesForMA20: number[] = [];
    for (const c of allCandles) {
      closesForMA20.push(c.close);
      const ma20 = closesForMA20.length >= 20 ? closesForMA20.slice(-20).reduce((s, v) => s + v, 0) / 20 : 0;
      const t = parseInt(c.candleTime.split(':')[0]) * 60 + parseInt(c.candleTime.split(':')[1]);
      if (t > 630 && ma20 > 0 && c.close > ma20 && !aboveMA20Time) {
        aboveMA20Time = c.candleTime;
        aboveMA20Price = c.close;
      }
    }
    
    // Summary
    const peakAfter = Math.max(...allCandles.filter((c: any) => {
      const t = parseInt(c.candleTime.split(':')[0]) * 60 + parseInt(c.candleTime.split(':')[1]);
      return t >= 660 && t <= 780;
    }).map((c: any) => c.high));
    
    console.log('\n  ─── サマリー ───');
    console.log(`  底値: ${minLow.toLocaleString()}円 (${minTime})`);
    console.log(`  その後の高値: ${peakAfter.toLocaleString()}円 (11:00〜13:00)`);
    console.log(`  上昇幅: +${((peakAfter - minLow) / minLow * 100).toFixed(2)}%`);
    console.log(`  TP 1.5%到達価格: ${Math.round(minLow * 1.015).toLocaleString()}円`);
    console.log('');
    console.log('  ─── 上昇シグナル検出タイミング ───');
    console.log(`  GC (MA5>MA10クロス): ${gcTime || 'なし'} @ ${gcPrice.toLocaleString()}円 → 底から+${gcPrice ? ((gcPrice - minLow) / minLow * 100).toFixed(2) : '?'}%`);
    console.log(`  3本連続陽線: ${threeBullTime || 'なし'} @ ${threeBullPrice.toLocaleString()}円 → 底から+${threeBullPrice ? ((threeBullPrice - minLow) / minLow * 100).toFixed(2) : '?'}%`);
    console.log(`  Close > MA20: ${aboveMA20Time || 'なし'} @ ${aboveMA20Price.toLocaleString()}円 → 底から+${aboveMA20Price ? ((aboveMA20Price - minLow) / minLow * 100).toFixed(2) : '?'}%`);
    
    if (gcPrice && peakAfter) {
      const potentialPnl = ((peakAfter - gcPrice) / gcPrice * 100).toFixed(2);
      console.log(`\n  GCでエントリーした場合の最大利益: +${potentialPnl}% (${gcPrice.toLocaleString()}→${peakAfter.toLocaleString()})`);
      const tpReached = peakAfter >= gcPrice * 1.015;
      console.log(`  TP 1.5%到達: ${tpReached ? '○ YES' : '× NO'} (必要: ${Math.round(gcPrice * 1.015).toLocaleString()}円)`);
    }
  }
  
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
