import { getDb } from "../server/db";
import { sql } from "drizzle-orm";
import { processCandle, forceCloseAllPositions, getOpenPositions } from "../server/realtimeSimEngine";
import type { RtCandle1Min } from "../server/realtimeSimEngine";

async function main() {
  const db = await getDb();
  
  // 全日付を取得
  const r = await db.execute(sql`
    SELECT DISTINCT tradeDate FROM rt_candles WHERE symbol = '285A' ORDER BY tradeDate ASC
  `);
  const dates = (r as any)[0].map((d: any) => d.tradeDate);
  console.log(`対象: ${dates.length}日 (${dates[0]}〜${dates[dates.length-1]})`);
  
  let totalPnl = 0, totalTrades = 0, totalWins = 0;
  interface Trade { date: string; entryTime: string; exitTime: string; side: string; entryPrice: number; exitPrice: number; pnl: number; reason: string; exitReason: string; }
  const allTrades: Trade[] = [];
  
  for (const date of dates) {
    const cr = await db.execute(sql`
      SELECT candleTime, open, high, low, close, volume
      FROM rt_candles
      WHERE symbol = '285A' AND tradeDate = ${date}
      ORDER BY candleTime
    `);
    const candles = (cr as any)[0] as any[];
    
    let dayTrades: Trade[] = [];
    let currentEntry: any = null;
    
    for (const c of candles) {
      const candle: RtCandle1Min = {
        symbol: '285A',
        tradeDate: date,
        candleTime: c.candleTime,
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
        volume: Number(c.volume),
      };
      
      const result = await processCandle(candle);
      
      if (result.action === 'entry') {
        currentEntry = { date, entryTime: c.candleTime, entryPrice: Number(c.close), reason: result.reason || '', side: '' };
        const pos = getOpenPositions().find(p => p.symbol === '285A');
        if (pos) currentEntry.side = pos.side;
      } else if (['exit', 'stop_loss', 'take_profit', 'forced_close'].includes(result.action)) {
        if (currentEntry) {
          const pnl = result.pnl || 0;
          dayTrades.push({
            ...currentEntry,
            exitTime: c.candleTime,
            exitPrice: Number(c.close),
            pnl,
            exitReason: result.reason || result.action,
          });
          currentEntry = null;
        }
      }
    }
    
    // 大引け決済
    const openPos = getOpenPositions().filter(p => p.symbol === '285A');
    if (openPos.length > 0) {
      const lastCandle = candles[candles.length - 1];
      await forceCloseAllPositions(date, Number(lastCandle.close));
      if (currentEntry) {
        const lastPrice = Number(lastCandle.close);
        const pnl = currentEntry.side === 'long' 
          ? (lastPrice - currentEntry.entryPrice) * 100
          : (currentEntry.entryPrice - lastPrice) * 100;
        dayTrades.push({
          ...currentEntry,
          exitTime: lastCandle.candleTime,
          exitPrice: lastPrice,
          pnl,
          exitReason: '大引け決済',
        });
      }
    }
    
    for (const t of dayTrades) {
      totalTrades++;
      if (t.pnl > 0) totalWins++;
      totalPnl += t.pnl;
      allTrades.push(t);
    }
  }
  
  console.log(`\n全体: ${totalTrades}件 ${totalWins}勝${totalTrades-totalWins}敗 勝率${totalTrades > 0 ? (totalWins/totalTrades*100).toFixed(1) : 0}% 合計${totalPnl > 0 ? '+' : ''}${Math.round(totalPnl)}円`);
  
  for (const t of allTrades) {
    const mark = t.pnl > 0 ? '✓' : '✗';
    console.log(`${mark} ${t.date} ${t.entryTime}→${t.exitTime} ${t.side} @${t.entryPrice}→${t.exitPrice} ${t.pnl > 0 ? '+' : ''}${Math.round(t.pnl)}円 [${t.reason.substring(0, 50)}] exit:${t.exitReason.substring(0, 30)}`);
  }
  
  process.exit(0);
}
main();
