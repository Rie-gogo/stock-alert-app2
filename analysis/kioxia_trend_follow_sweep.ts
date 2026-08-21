import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

type Candle = { candleTime: string; open: number; high: number; low: number; close: number; volume: number };
type Side = 'LONG' | 'SHORT';
type Trade = { date: string; time: string; side: Side; entry: number; exitTime: string; reason: string; pnl: number };

const CAPITAL = 3_000_000;
const LOT_RATIO = 0.9;
const AM_END = '11:27';
const PM_START = '12:50';
const PM_END = '14:20';

function shares(price: number) {
  return Math.max(100, Math.floor(Math.floor(CAPITAL * LOT_RATIO / price) / 100) * 100);
}
function sma(candles: Candle[], index: number, period: number) {
  if (index - period + 1 < 0) return null;
  return candles.slice(index - period + 1, index + 1).reduce((sum, item) => sum + item.close, 0) / period;
}
function inEntryWindow(time: string) {
  return (time >= '09:45' && time <= AM_END) || (time >= PM_START && time <= PM_END);
}
function sessionEnd(time: string) { return time <= AM_END ? AM_END : PM_END; }
function volumeRatio(candles: Candle[], index: number, period = 20) {
  if (index < period) return 0;
  const avg = candles.slice(index - period, index).reduce((sum, item) => sum + item.volume, 0) / period;
  return avg ? candles[index].volume / avg : 0;
}
function exitTrade(date: string, candles: Candle[], index: number, side: Side, entry: number, sl: number, tp: number): Trade {
  const stop = side === 'LONG' ? entry * (1 - sl / 100) : entry * (1 + sl / 100);
  const target = side === 'LONG' ? entry * (1 + tp / 100) : entry * (1 - tp / 100);
  const amount = shares(entry);
  const end = sessionEnd(candles[index].candleTime);
  for (let i = index + 1; i < candles.length; i++) {
    const c = candles[i];
    if ((side === 'LONG' && c.low <= stop) || (side === 'SHORT' && c.high >= stop)) return { date, time: candles[index].candleTime, side, entry, exitTime: c.candleTime, reason: 'SL', pnl: (side === 'LONG' ? stop - entry : entry - stop) * amount };
    if ((side === 'LONG' && c.high >= target) || (side === 'SHORT' && c.low <= target)) return { date, time: candles[index].candleTime, side, entry, exitTime: c.candleTime, reason: 'TP', pnl: (side === 'LONG' ? target - entry : entry - target) * amount };
    if (c.candleTime >= end) return { date, time: candles[index].candleTime, side, entry, exitTime: c.candleTime, reason: '時間決済', pnl: (side === 'LONG' ? c.close - entry : entry - c.close) * amount };
  }
  const last = candles.at(-1)!;
  return { date, time: candles[index].candleTime, side, entry, exitTime: last.candleTime, reason: '時間決済', pnl: (side === 'LONG' ? last.close - entry : entry - last.close) * amount };
}

/** 上昇継続: MA8上向き、直近N本高値更新、出来高を伴う順張りLONG。 */
function trendLong(date: string, candles: Candle[], lookback: number, minVol: number, sl = 0.6, tp = 0.8, startTime = '09:45', minOpenGain = -Infinity): Trade | null {
  for (let i = Math.max(20, lookback); i < candles.length; i++) {
    const c = candles[i];
    if (!inEntryWindow(c.candleTime) || c.candleTime < startTime) continue;
    const ma = sma(candles, i, 8); const ma2 = sma(candles, i - 2, 8);
    const high = Math.max(...candles.slice(i - lookback, i).map(item => item.high));
    const slope = ma && ma2 ? (ma - ma2) / ma2 * 100 : -Infinity;
    const openGain = (c.close - candles[0].open) / candles[0].open * 100;
    if (slope >= 0.02 && c.high > high && c.close > c.open && openGain >= minOpenGain && volumeRatio(candles, i) >= minVol) return exitTrade(date, candles, i, 'LONG', c.close, sl, tp);
  }
  return null;
}

/** 下落継続: MA8下向き、直近N本安値更新、出来高を伴う順張りSHORT。 */
function trendShort(date: string, candles: Candle[], lookback: number, minVol: number, sl = 0.8, tp = 1.2, startTime = '09:45', maxOpenGain = Infinity): Trade | null {
  for (let i = Math.max(20, lookback); i < candles.length; i++) {
    const c = candles[i];
    if (!inEntryWindow(c.candleTime) || c.candleTime < startTime) continue;
    const ma = sma(candles, i, 8); const ma1 = sma(candles, i - 1, 8); const ma2 = sma(candles, i - 2, 8);
    const low = Math.min(...candles.slice(i - lookback, i).map(item => item.low));
    const slope = ma && ma2 ? (ma - ma2) / ma2 * 100 : Infinity;
    const openGain = (c.close - candles[0].open) / candles[0].open * 100;
    if (slope <= -0.02 && ma !== null && ma1 !== null && ma <= ma1 && c.low < low && c.close < c.open && openGain <= maxOpenGain && volumeRatio(candles, i) >= minVol) return exitTrade(date, candles, i, 'SHORT', c.close, sl, tp);
  }
  return null;
}

function report(label: string, trades: Trade[]) {
  const wins = trades.filter(trade => trade.pnl > 0).length;
  const pnl = trades.reduce((sum, trade) => sum + trade.pnl, 0);
  const profit = trades.filter(trade => trade.pnl > 0).reduce((sum, trade) => sum + trade.pnl, 0);
  const loss = Math.abs(trades.filter(trade => trade.pnl < 0).reduce((sum, trade) => sum + trade.pnl, 0));
  const pf = loss ? profit / loss : Infinity;
  const aug17 = trades.filter(trade => trade.date === '2026-08-17');
  console.log(`${label}: ${trades.length}件 ${wins}勝${trades.length - wins}敗 勝率${trades.length ? (wins / trades.length * 100).toFixed(1) : '0'}% 損益${pnl >= 0 ? '+' : ''}${Math.round(pnl).toLocaleString()}円 PF${Number.isFinite(pf) ? pf.toFixed(2) : '∞'} | 8/17 ${aug17.length ? aug17.map(t => `${t.time}→${t.exitTime} ${t.reason} ${t.pnl >= 0 ? '+' : ''}${Math.round(t.pnl).toLocaleString()}円`).join(' / ') : 'なし'}`);
}

async function main() {
  const db = await getDb();
  const dateRows = await db.execute(sql`SELECT DISTINCT tradeDate FROM rt_candles WHERE symbol='285A' ORDER BY tradeDate`);
  const dates = ((dateRows as any)[0] as Array<{ tradeDate: string }>).map(row => row.tradeDate);
  const data: Record<string, Candle[]> = {};
  for (const date of dates) {
    const rows = await db.execute(sql`SELECT candleTime, open, high, low, close, volume FROM rt_candles WHERE symbol='285A' AND tradeDate=${date} ORDER BY candleTime`);
    data[date] = ((rows as any)[0] as any[]).map(row => ({ candleTime: String(row.candleTime), open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: Number(row.volume) }));
  }
  console.log(`対象: 285A KABUステーション1分足 ${dates[0]}〜${dates.at(-1)} (${dates.length}営業日)`);
  console.log('=== 順張りLONG ===');
  for (const [lookback, vol] of [[5, 1.0], [5, 1.2], [10, 1.0], [10, 1.2], [20, 1.0], [20, 1.2]]) report(`H${lookback}・出来高${vol.toFixed(1)}倍`, dates.flatMap(date => { const trade = trendLong(date, data[date], lookback, vol); return trade ? [trade] : []; }));
  console.log('=== 順張りSHORT ===');
  for (const [lookback, vol] of [[5, 1.0], [5, 1.2], [10, 1.0], [10, 1.2], [20, 1.0], [20, 1.2]]) report(`L${lookback}・出来高${vol.toFixed(1)}倍`, dates.flatMap(date => { const trade = trendShort(date, data[date], lookback, vol); return trade ? [trade] : []; }));
  console.log('=== 有望な順張りLONG（H20・出来高1.2倍）のSL/TP ===');
  for (const [sl, tp] of [[0.6, 0.8], [0.8, 1.2], [1.0, 1.2], [1.0, 1.5], [1.2, 1.5]]) {
    report(`SL${sl.toFixed(1)}%/TP${tp.toFixed(1)}%`, dates.flatMap(date => { const trade = trendLong(date, data[date], 20, 1.2, sl, tp); return trade ? [trade] : []; }));
  }
  console.log('=== 順張りSHORT（L10・出来高1.0倍）のSL/TP ===');
  for (const [sl, tp] of [[0.8, 1.2], [1.0, 1.2], [1.0, 1.5], [1.2, 1.5], [1.2, 2.0]]) {
    report(`SL${sl.toFixed(1)}%/TP${tp.toFixed(1)}%`, dates.flatMap(date => { const trade = trendShort(date, data[date], 10, 1.0, sl, tp); return trade ? [trade] : []; }));
  }
  console.log('=== 順張りLONG（H20・出来高1.2倍）の開始時刻 ===');
  for (const startTime of ['09:45', '10:00', '10:15', '10:30']) {
    report(`${startTime}以降`, dates.flatMap(date => { const trade = trendLong(date, data[date], 20, 1.2, 0.6, 0.8, startTime); return trade ? [trade] : []; }));
  }
  console.log('=== 順張りSHORT（L10・出来高1.0倍）の開始時刻 ===');
  for (const startTime of ['09:45', '10:00', '10:15', '10:30']) {
    report(`${startTime}以降`, dates.flatMap(date => { const trade = trendShort(date, data[date], 10, 1.0, 0.8, 1.2, startTime); return trade ? [trade] : []; }));
  }
  console.log('=== 当日方向一致フィルター（10:15以降） ===');
  for (const gain of [0.0, 0.5, 1.0]) {
    report(`LONG 始値比+${gain.toFixed(1)}%以上`, dates.flatMap(date => { const trade = trendLong(date, data[date], 20, 1.2, 0.6, 0.8, '10:15', gain); return trade ? [trade] : []; }));
  }
  for (const gain of [0.0, -0.5, -1.0]) {
    report(`SHORT 始値比${gain.toFixed(1)}%以下`, dates.flatMap(date => { const trade = trendShort(date, data[date], 10, 1.0, 0.8, 1.2, '10:15', gain); return trade ? [trade] : []; }));
  }
}

main().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
