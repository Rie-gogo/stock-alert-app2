import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

/**
 * 悪化日（7/21, 7/23, 7/31）+ 全敗日の方向性分析
 * エントリー後の値動きを追跡し、方向が正しかったか判定する
 */

async function main() {
  const db = await getDb();
  
  // 悪化日 = 新設定で旧設定より悪化した日
  const targetDates = ['2026-07-21', '2026-07-23', '2026-07-31'];
  
  for (const date of targetDates) {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`  ${date} 方向性分析`);
    console.log(`${'='.repeat(80)}`);
    
    // Get trades
    const tradesRes = await db.execute(sql.raw(
      `SELECT * FROM rt_trades WHERE tradeDate = '${date}' ORDER BY tradeTime`
    ));
    const trades = (tradesRes as any)[0] || [];
    
    // Get candles
    const candlesRes = await db.execute(sql.raw(
      `SELECT symbol, candleTime, open, high, low, close, volume FROM rt_candles WHERE tradeDate = '${date}' ORDER BY candleTime`
    ));
    const allCandles = (candlesRes as any)[0] || [];
    
    // Get day's open prices for each symbol
    const symbolFirstCandles: Record<string, any> = {};
    const symbolLastCandles: Record<string, any> = {};
    for (const c of allCandles) {
      if (!symbolFirstCandles[c.symbol]) symbolFirstCandles[c.symbol] = c;
      symbolLastCandles[c.symbol] = c;
    }
    
    // Analyze each entry
    for (let i = 0; i < trades.length; i++) {
      const t = trades[i];
      if (t.action !== 'buy' && t.action !== 'short') continue;
      
      const symbol = t.symbol;
      const entryPrice = Number(t.price);
      const entryTime = t.tradeTime;
      const side = t.side;
      
      // Get candles for this symbol after entry
      const symbolCandles = allCandles.filter((c: any) => c.symbol === symbol);
      const postEntry = symbolCandles.filter((c: any) => c.candleTime > entryTime);
      
      // Calculate key metrics
      const dayOpen = symbolFirstCandles[symbol] ? Number(symbolFirstCandles[symbol].open) : entryPrice;
      const dayClose = symbolLastCandles[symbol] ? Number(symbolLastCandles[symbol].close) : entryPrice;
      const dayHigh = Math.max(...symbolCandles.map((c: any) => Number(c.high)));
      const dayLow = Math.min(...symbolCandles.map((c: any) => Number(c.low)));
      
      // Post-entry metrics
      let postHigh = entryPrice;
      let postLow = entryPrice;
      let postClose = entryPrice;
      let maxFavorable = 0; // Maximum favorable excursion (MFE)
      let maxAdverse = 0;   // Maximum adverse excursion (MAE)
      
      // Track price movement in 5min, 15min, 30min, 60min, and end-of-day
      const timeframes = [5, 15, 30, 60];
      const priceAt: Record<number, number | null> = {};
      
      for (const tf of timeframes) {
        const targetMinutes = timeToMinutes(entryTime) + tf;
        const targetTime = minutesToTime(targetMinutes);
        const candleAtTf = postEntry.find((c: any) => c.candleTime >= targetTime);
        priceAt[tf] = candleAtTf ? Number(candleAtTf.close) : null;
      }
      
      if (postEntry.length > 0) {
        postHigh = Math.max(...postEntry.map((c: any) => Number(c.high)));
        postLow = Math.min(...postEntry.map((c: any) => Number(c.low)));
        postClose = Number(postEntry[postEntry.length - 1].close);
        
        if (side === 'long') {
          maxFavorable = ((postHigh - entryPrice) / entryPrice) * 100;
          maxAdverse = ((entryPrice - postLow) / entryPrice) * 100;
        } else {
          maxFavorable = ((entryPrice - postLow) / entryPrice) * 100;
          maxAdverse = ((postHigh - entryPrice) / entryPrice) * 100;
        }
      }
      
      // Determine if direction was correct
      let directionCorrect: string;
      if (side === 'long') {
        const endMove = ((postClose - entryPrice) / entryPrice) * 100;
        directionCorrect = endMove > 0 ? '○ 正解' : endMove < -0.3 ? '× 不正解' : '△ 微妙';
      } else {
        const endMove = ((entryPrice - postClose) / entryPrice) * 100;
        directionCorrect = endMove > 0 ? '○ 正解' : endMove < -0.3 ? '× 不正解' : '△ 微妙';
      }
      
      // Was TP reachable?
      const tpReachable = maxFavorable >= 1.5;
      
      console.log(`\n  ${entryTime} | ${symbol} ${t.symbolName} | ${side.toUpperCase()} @${entryPrice.toLocaleString()}`);
      console.log(`  シグナル: ${t.reason.substring(0, 60)}`);
      console.log(`  板シグナル: ${t.boardSignal}`);
      console.log(`  ---`);
      console.log(`  日足: 始値=${dayOpen.toLocaleString()} → 終値=${dayClose.toLocaleString()} (${((dayClose-dayOpen)/dayOpen*100).toFixed(2)}%)`);
      console.log(`  エントリー後の値動き:`);
      for (const tf of timeframes) {
        if (priceAt[tf] !== null) {
          const move = side === 'long' 
            ? ((priceAt[tf]! - entryPrice) / entryPrice * 100).toFixed(2)
            : ((entryPrice - priceAt[tf]!) / entryPrice * 100).toFixed(2);
          console.log(`    ${tf}分後: ${priceAt[tf]!.toLocaleString()}円 (${Number(move) >= 0 ? '+' : ''}${move}%)`);
        }
      }
      console.log(`    引け: ${postClose.toLocaleString()}円 (${side === 'long' ? ((postClose-entryPrice)/entryPrice*100).toFixed(2) : ((entryPrice-postClose)/entryPrice*100).toFixed(2)}%)`);
      console.log(`  MFE(最大有利方向): +${maxFavorable.toFixed(2)}% ${tpReachable ? '→ TP到達可能だった' : '→ TP未到達'}`);
      console.log(`  MAE(最大逆行): -${maxAdverse.toFixed(2)}%`);
      console.log(`  方向判定: ${directionCorrect}`);
      console.log(`  TP(1.5%)到達可能: ${tpReachable ? 'YES' : 'NO'}`);
      
      if (tpReachable && maxAdverse > 0.5) {
        console.log(`  ★ TPは到達可能だったが、途中で-${maxAdverse.toFixed(2)}%の逆行あり（SL問題）`);
      } else if (!tpReachable) {
        console.log(`  ★ そもそもTPに到達する値動きがなかった（方向性の問題）`);
      }
    }
  }
  
  process.exit(0);
}

function timeToMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

function minutesToTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

main().catch(e => { console.error(e); process.exit(1); });
