import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

type Candle = {
  candleTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

function sma(candles: Candle[], index: number, period: number) {
  if (index - period + 1 < 0) return null;
  return candles.slice(index - period + 1, index + 1).reduce((sum, candle) => sum + candle.close, 0) / period;
}

function pct(numerator: number, denominator: number) {
  return denominator ? numerator / denominator * 100 : 0;
}

async function main() {
  const db = await getDb();
  const result = await db.execute(sql`
    SELECT candleTime, open, high, low, close, volume FROM rt_candles
    WHERE symbol = '285A' AND tradeDate = '2026-08-21'
    ORDER BY candleTime
  `);
  const candles = ((result as any)[0] as any[]).map(row => ({
    candleTime: String(row.candleTime),
    open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: Number(row.volume),
  })) as Candle[];
  if (!candles.length) throw new Error('8/21の285Aデータがありません。');

  let dayHigh = 0;
  let dayLow = Number.POSITIVE_INFINITY;
  const dayOpen = candles[0].open;
  console.log('time O H L C | MA8 slope2% | 高値から% 安値から% | 3本高値/安値更新 | 出来高比');
  console.log('=== LONG確認帯 09:55〜10:30 ===');
  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    dayHigh = Math.max(dayHigh, candle.high);
    dayLow = Math.min(dayLow, candle.low);
    if (candle.candleTime < '09:55' || candle.candleTime > '10:30') continue;
    const now = sma(candles, i, 8);
    const twoAgo = sma(candles, i - 2, 8);
    const slope = now !== null && twoAgo !== null ? pct(now - twoAgo, twoAgo) : NaN;
    const previous3 = candles.slice(Math.max(0, i - 3), i);
    const high3 = previous3.length ? Math.max(...previous3.map(item => item.high)) : NaN;
    const low3 = previous3.length ? Math.min(...previous3.map(item => item.low)) : NaN;
    const avgVol = candles.slice(Math.max(0, i - 10), i).reduce((sum, item) => sum + item.volume, 0) / Math.min(10, i);
    const volumeRatio = avgVol ? candle.volume / avgVol : NaN;
    console.log(`${candle.candleTime} ${candle.open} ${candle.high} ${candle.low} ${candle.close} | ${now?.toFixed(1) ?? '-'} ${slope.toFixed(3)} | ${pct(dayHigh - candle.close, dayHigh).toFixed(2)} ${pct(candle.close - dayLow, dayLow).toFixed(2)} | H3:${candle.high > high3 ? 'Y' : 'n'} L3:${candle.low < low3 ? 'Y' : 'n'} | ${volumeRatio.toFixed(2)}`);
  }

  console.log('\n=== SHORT確認帯 12:50〜14:25 ===');
  dayHigh = 0;
  dayLow = Number.POSITIVE_INFINITY;
  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    dayHigh = Math.max(dayHigh, candle.high);
    dayLow = Math.min(dayLow, candle.low);
    if (candle.candleTime < '12:50' || candle.candleTime > '14:25') continue;
    const now = sma(candles, i, 8);
    const twoAgo = sma(candles, i - 2, 8);
    const slope = now !== null && twoAgo !== null ? pct(now - twoAgo, twoAgo) : NaN;
    const previous3 = candles.slice(Math.max(0, i - 3), i);
    const high3 = previous3.length ? Math.max(...previous3.map(item => item.high)) : NaN;
    const low3 = previous3.length ? Math.min(...previous3.map(item => item.low)) : NaN;
    const avgVol = candles.slice(Math.max(0, i - 10), i).reduce((sum, item) => sum + item.volume, 0) / Math.min(10, i);
    const volumeRatio = avgVol ? candle.volume / avgVol : NaN;
    console.log(`${candle.candleTime} ${candle.open} ${candle.high} ${candle.low} ${candle.close} | ${now?.toFixed(1) ?? '-'} ${slope.toFixed(3)} | ${pct(dayHigh - candle.close, dayHigh).toFixed(2)} ${pct(candle.close - dayLow, dayLow).toFixed(2)} | H3:${candle.high > high3 ? 'Y' : 'n'} L3:${candle.low < low3 ? 'Y' : 'n'} | ${volumeRatio.toFixed(2)}`);
  }
}

main().then(() => process.exit(0)).catch(error => {
  console.error(error);
  process.exit(1);
});
