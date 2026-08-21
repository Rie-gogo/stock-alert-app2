import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

type Candle = { candleTime: string; open: number; high: number; low: number; close: number; volume: number };

function sma(candles: Candle[], index: number, period: number) {
  if (index - period + 1 < 0) return null;
  return candles.slice(index - period + 1, index + 1).reduce((sum, item) => sum + item.close, 0) / period;
}

async function main() {
  const db = await getDb();
  const rows = await db.execute(sql`
    SELECT candleTime, open, high, low, close, volume FROM rt_candles
    WHERE symbol = '285A' AND tradeDate = '2026-08-17' ORDER BY candleTime
  `);
  const candles = ((rows as any)[0] as any[]).map(row => ({
    candleTime: String(row.candleTime), open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: Number(row.volume),
  })) as Candle[];
  if (!candles.length) throw new Error('8/17のデータがありません');

  let dayHigh = 0;
  let maxDecline = { pct: 0, time: '', high: 0, close: 0 };
  const otherConditions: Array<{ time: string; close: number; decline: number; slope: number; highBreak: boolean }> = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    dayHigh = Math.max(dayHigh, c.high);
    const decline = (dayHigh - c.close) / dayHigh * 100;
    if (decline > maxDecline.pct) maxDecline = { pct: decline, time: c.candleTime, high: dayHigh, close: c.close };
    if (c.candleTime < '09:45' || c.candleTime > '11:27' || i < 10) continue;
    const now = sma(candles, i, 8);
    const twoAgo = sma(candles, i - 2, 8);
    const slope = now && twoAgo ? (now - twoAgo) / twoAgo * 100 : NaN;
    const high10 = Math.max(...candles.slice(i - 10, i).map(item => item.high));
    const highBreak = c.high > high10;
    if (slope >= 0.02 && highBreak) otherConditions.push({ time: c.candleTime, close: c.close, decline, slope, highBreak });
  }
  const am = candles.filter(candle => candle.candleTime <= '11:27');
  const pm = candles.filter(candle => candle.candleTime >= '12:30');
  console.log(`全日: 始値${candles[0].open}円 高値${Math.max(...candles.map(c => c.high))}円 安値${Math.min(...candles.map(c => c.low))}円 終値${candles.at(-1)!.close}円`);
  console.log(`前場: 始値${am[0].open}円 高値${Math.max(...am.map(c => c.high))}円 終値${am.at(-1)!.close}円`);
  console.log(`後場: 始値${pm[0].open}円 高値${Math.max(...pm.map(c => c.high))}円 終値${pm.at(-1)!.close}円`);
  console.log(`当日高値からの最大下落: ${maxDecline.pct.toFixed(3)}% (${maxDecline.time}, 高値${maxDecline.high}→終値${maxDecline.close})`);
  console.log(`MA8上向き>=0.02% かつ 直近10本高値更新: ${otherConditions.length}回`);
  otherConditions.forEach(item => console.log(`${item.time} close=${item.close} slope=${item.slope.toFixed(3)}% highから${item.decline.toFixed(3)}%下落`));
}

main().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
