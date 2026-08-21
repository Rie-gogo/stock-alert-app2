import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

type Candle = { candleTime: string; open: number; high: number; low: number; close: number; volume: number };
type Side = 'LONG' | 'SHORT';
type Signal = { date: string; time: string; side: Side; entry: number; exitTime: string; exitReason: string; pnl: number };

const CAPITAL = 3_000_000;
const LOT_RATIO = 0.9;

function shares(price: number) {
  return Math.max(100, Math.floor(Math.floor(CAPITAL * LOT_RATIO / price) / 100) * 100);
}

function sma(candles: Candle[], index: number, period: number) {
  if (index - period + 1 < 0) return null;
  return candles.slice(index - period + 1, index + 1).reduce((total, candle) => total + candle.close, 0) / period;
}

function closeTrade(candles: Candle[], index: number, entry: number, side: Side, endTime: string): Omit<Signal, 'date' | 'time' | 'side' | 'entry'> {
  const slPct = side === 'LONG' ? 0.6 : 0.8;
  const tpPct = side === 'LONG' ? 0.8 : 1.2;
  const size = shares(entry);
  const stop = side === 'LONG' ? entry * (1 - slPct / 100) : entry * (1 + slPct / 100);
  const tp = side === 'LONG' ? entry * (1 + tpPct / 100) : entry * (1 - tpPct / 100);
  for (let i = index + 1; i < candles.length; i++) {
    const candle = candles[i];
    if ((side === 'LONG' && candle.low <= stop) || (side === 'SHORT' && candle.high >= stop)) {
      return { exitTime: candle.candleTime, exitReason: 'SL', pnl: (side === 'LONG' ? stop - entry : entry - stop) * size };
    }
    if ((side === 'LONG' && candle.high >= tp) || (side === 'SHORT' && candle.low <= tp)) {
      return { exitTime: candle.candleTime, exitReason: 'TP', pnl: (side === 'LONG' ? tp - entry : entry - tp) * size };
    }
    if (candle.candleTime >= endTime) {
      return { exitTime: candle.candleTime, exitReason: '時間決済', pnl: (side === 'LONG' ? candle.close - entry : entry - candle.close) * size };
    }
  }
  const last = candles.at(-1)!;
  return { exitTime: last.candleTime, exitReason: '時間決済', pnl: (side === 'LONG' ? last.close - entry : entry - last.close) * size };
}

/**
 * LONG案: 一度の下落幅を記憶し、反発後の高値更新で入る。
 * 既存案との違いは「高値からの下落がエントリー足時点でも残っている」ことを要求しない点。
 */
function memoryPullbackLong(date: string, candles: Candle[], minPullbackPct: number): Signal[] {
  let dayHigh = 0;
  let pullbackSeen = false;
  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    dayHigh = Math.max(dayHigh, candle.high);
    if (candle.candleTime < '09:45' || candle.candleTime > '11:27' || i < 10) continue;
    if ((dayHigh - candle.close) / dayHigh * 100 >= minPullbackPct) pullbackSeen = true;
    if (!pullbackSeen) continue;
    const now = sma(candles, i, 8);
    const twoAgo = sma(candles, i - 2, 8);
    const slope = now && twoAgo ? (now - twoAgo) / twoAgo * 100 : -Infinity;
    const recentHigh = Math.max(...candles.slice(i - 10, i).map(previous => previous.high));
    if (slope >= 0.02 && candle.high > recentHigh) {
      return [{ date, time: candle.candleTime, side: 'LONG', entry: candle.close, ...closeTrade(candles, i, candle.close, 'LONG', '11:27') }];
    }
  }
  return [];
}

/** 記憶型LONGに強い陽線と出来高を追加した厳選版。 */
function impulsePullbackLong(date: string, candles: Candle[], minBodyPct: number, minVolRatio: number): Signal[] {
  let dayHigh = 0;
  let pullbackSeen = false;
  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    dayHigh = Math.max(dayHigh, candle.high);
    if (candle.candleTime < '09:45' || candle.candleTime > '11:27' || i < 10) continue;
    if ((dayHigh - candle.close) / dayHigh * 100 >= 2.0) pullbackSeen = true;
    if (!pullbackSeen) continue;
    const now = sma(candles, i, 8);
    const twoAgo = sma(candles, i - 2, 8);
    const slope = now && twoAgo ? (now - twoAgo) / twoAgo * 100 : -Infinity;
    const recentHigh = Math.max(...candles.slice(i - 10, i).map(previous => previous.high));
    const averageVolume = candles.slice(i - 10, i).reduce((sum, previous) => sum + previous.volume, 0) / 10;
    const bodyPct = (candle.close - candle.open) / candle.open * 100;
    const volRatio = averageVolume ? candle.volume / averageVolume : 0;
    if (slope >= 0.02 && candle.high > recentHigh && bodyPct >= minBodyPct && volRatio >= minVolRatio) {
      return [{ date, time: candle.candleTime, side: 'LONG', entry: candle.close, ...closeTrade(candles, i, candle.close, 'LONG', '11:27') }];
    }
  }
  return [];
}

/**
 * SHORT案: 後場に付けた新高値からの反落を、MA8下向き+直近3本安値更新で売る。
 * 朝の高値を使わず、12:50以降のピークだけを対象にする。
 */
function afternoonPeakShort(date: string, candles: Candle[], minDropPct: number, startTime = '12:50'): Signal[] {
  const dayOpen = candles[0].open;
  let afternoonHigh = 0;
  let highEstablished = false;
  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    if (candle.candleTime < startTime) continue;
    if (candle.high > afternoonHigh) {
      afternoonHigh = candle.high;
      highEstablished = true;
    }
    if (!highEstablished || candle.candleTime > '14:20' || i < 10) continue;
    const riseFromOpen = (afternoonHigh - dayOpen) / dayOpen * 100;
    const dropFromHigh = (afternoonHigh - candle.close) / afternoonHigh * 100;
    const now = sma(candles, i, 8);
    const prev = sma(candles, i - 1, 8);
    const recent3Low = Math.min(...candles.slice(i - 3, i).map(previous => previous.low));
    if (riseFromOpen >= 3.0 && dropFromHigh >= minDropPct && now !== null && prev !== null && now < prev && candle.low < recent3Low) {
      return [{ date, time: candle.candleTime, side: 'SHORT', entry: candle.close, ...closeTrade(candles, i, candle.close, 'SHORT', '14:20') }];
    }
  }
  return [];
}

function report(label: string, signals: Signal[]) {
  const wins = signals.filter(signal => signal.pnl > 0).length;
  const pnl = signals.reduce((total, signal) => total + signal.pnl, 0);
  const grossProfit = signals.filter(signal => signal.pnl > 0).reduce((total, signal) => total + signal.pnl, 0);
  const grossLoss = Math.abs(signals.filter(signal => signal.pnl < 0).reduce((total, signal) => total + signal.pnl, 0));
  const pf = grossLoss ? grossProfit / grossLoss : Number.POSITIVE_INFINITY;
  const today = signals.filter(signal => signal.date === '2026-08-21');
  console.log(`${label}: ${signals.length}件 ${wins}勝${signals.length - wins}敗 勝率${signals.length ? (wins / signals.length * 100).toFixed(1) : '0'}% 損益${pnl >= 0 ? '+' : ''}${Math.round(pnl).toLocaleString()}円 PF${Number.isFinite(pf) ? pf.toFixed(2) : '∞'} | 8/21 ${today.length ? today.map(signal => `${signal.time}→${signal.exitTime} ${signal.exitReason} ${signal.pnl >= 0 ? '+' : ''}${Math.round(signal.pnl).toLocaleString()}円`).join(' / ') : '発火なし'}`);
}

async function main() {
  const db = await getDb();
  const datesResult = await db.execute(sql`SELECT DISTINCT tradeDate FROM rt_candles WHERE symbol = '285A' ORDER BY tradeDate`);
  const dates = ((datesResult as any)[0] as Array<{ tradeDate: string }>).map(row => row.tradeDate);
  const byDate: Record<string, Candle[]> = {};
  for (const date of dates) {
    const rows = await db.execute(sql`
      SELECT candleTime, open, high, low, close, volume FROM rt_candles
      WHERE symbol = '285A' AND tradeDate = ${date} ORDER BY candleTime
    `);
    byDate[date] = ((rows as any)[0] as any[]).map(row => ({
      candleTime: String(row.candleTime), open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: Number(row.volume),
    }));
  }

  console.log(`対象: KABUステーション285A 1分足 ${dates[0]}〜${dates.at(-1)}（${dates.length}営業日）`);
  console.log('=== 記憶型反転LONG（SL0.6%/TP0.8%、09:45〜11:27） ===');
  for (const threshold of [1.5, 2.0, 2.5]) {
    report(`下落記憶${threshold.toFixed(1)}%`, dates.flatMap(date => memoryPullbackLong(date, byDate[date], threshold)));
  }
  console.log('\n=== 勢い付き記憶型LONG（下落記憶2.0%、SL0.6%/TP0.8%） ===');
  for (const [body, vol] of [[0.3, 1.2], [0.5, 1.2], [0.5, 1.5], [0.6, 1.5]]) {
    report(`実体${body.toFixed(1)}%・出来高${vol.toFixed(1)}倍`, dates.flatMap(date => impulsePullbackLong(date, byDate[date], body, vol)));
  }
  console.log('\n=== 後場ピーク反転SHORT（SL0.8%/TP1.2%、12:50〜14:20） ===');
  for (const threshold of [0.6, 0.8, 1.0, 1.2]) {
    report(`高値反落${threshold.toFixed(1)}%`, dates.flatMap(date => afternoonPeakShort(date, byDate[date], threshold)));
  }
  console.log('\n=== 13:00以降ピーク反転SHORT（SL0.8%/TP1.2%、〜14:20） ===');
  for (const threshold of [0.6, 0.8, 1.0]) {
    report(`13:00開始・高値反落${threshold.toFixed(1)}%`, dates.flatMap(date => afternoonPeakShort(date, byDate[date], threshold, '13:00')));
  }
}

main().then(() => process.exit(0)).catch(error => {
  console.error(error);
  process.exit(1);
});
