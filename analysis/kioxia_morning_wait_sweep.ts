import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

type Candle = { candleTime: string; open: number; high: number; low: number; close: number; volume: number };
type Side = 'LONG' | 'SHORT';
type Trade = { date: string; time: string; side: Side; label: string; entry: number; exitTime: string; pnl: number; result: string };

const CAPITAL = 3_000_000;
const LOT_RATIO = 0.9;

function shares(price: number) {
  return Math.max(100, Math.floor(Math.floor(CAPITAL * LOT_RATIO / price) / 100) * 100);
}
function sma(candles: Candle[], index: number, period: number) {
  if (index - period + 1 < 0) return null;
  return candles.slice(index - period + 1, index + 1).reduce((total, item) => total + item.close, 0) / period;
}
function volumeRatio(candles: Candle[], index: number) {
  if (index < 10) return 0;
  const average = candles.slice(index - 10, index).reduce((total, item) => total + item.volume, 0) / 10;
  return average ? candles[index].volume / average : 0;
}
function closeTrade(date: string, candles: Candle[], index: number, entry: number, side: Side, label: string, endTime: string): Trade {
  const slPct = side === 'LONG' ? 0.6 : 0.8;
  const tpPct = side === 'LONG' ? 0.8 : 1.2;
  const amount = shares(entry);
  const stop = side === 'LONG' ? entry * (1 - slPct / 100) : entry * (1 + slPct / 100);
  const target = side === 'LONG' ? entry * (1 + tpPct / 100) : entry * (1 - tpPct / 100);
  for (let i = index + 1; i < candles.length; i++) {
    const c = candles[i];
    if ((side === 'LONG' && c.low <= stop) || (side === 'SHORT' && c.high >= stop)) return { date, time: candles[index].candleTime, side, label, entry, exitTime: c.candleTime, pnl: (side === 'LONG' ? stop - entry : entry - stop) * amount, result: 'SL' };
    if ((side === 'LONG' && c.high >= target) || (side === 'SHORT' && c.low <= target)) return { date, time: candles[index].candleTime, side, label, entry, exitTime: c.candleTime, pnl: (side === 'LONG' ? target - entry : entry - target) * amount, result: 'TP' };
    if (c.candleTime >= endTime) return { date, time: candles[index].candleTime, side, label, entry, exitTime: c.candleTime, pnl: (side === 'LONG' ? c.close - entry : entry - c.close) * amount, result: '時間決済' };
  }
  const last = candles.at(-1)!;
  return { date, time: candles[index].candleTime, side, label, entry, exitTime: last.candleTime, pnl: (side === 'LONG' ? last.close - entry : entry - last.close) * amount, result: '時間決済' };
}

function rawReversalShort(date: string, candles: Candle[]) {
  const dayOpen = candles[0].open;
  let high = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    high = Math.max(high, c.high);
    if (c.candleTime < '09:45' || c.candleTime > '11:27' || i < 10) continue;
    const ma = sma(candles, i, 8); const prev = sma(candles, i - 1, 8);
    const recentLow = Math.min(...candles.slice(i - 10, i).map(item => item.low));
    if ((high - dayOpen) / dayOpen * 100 >= 3.0 && (high - c.close) / high * 100 >= 1.5 && ma !== null && prev !== null && ma < prev && c.low < recentLow) {
      return { index: i, trade: closeTrade(date, candles, i, c.close, 'SHORT', '反転SHORT', '11:27') };
    }
  }
  return null;
}

function waitForExhaustion(date: string, candles: Candle[]) {
  const raw = rawReversalShort(date, candles);
  if (!raw) return { trade: null as Trade | null, suppressed: false };
  const from = raw.index + 1;
  const until = Math.min(raw.index + 2, candles.length - 1);
  const initialLow = Math.min(...candles.slice(Math.max(0, raw.index - 10), raw.index).map(item => item.low));
  const exhausted = candles.slice(from, until + 1).some((candle, offset) => candle.low < initialLow && volumeRatio(candles, from + offset) >= 2.0);
  if (exhausted) return { trade: null, suppressed: true };
  const entryIndex = until;
  const entry = candles[entryIndex].close;
  return { trade: closeTrade(date, candles, entryIndex, entry, 'SHORT', '確認反転SHORT', '11:27'), suppressed: false };
}

function impulseMemoryLong(date: string, candles: Candle[]) {
  let dayHigh = 0;
  let pullbackSeen = false;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]; dayHigh = Math.max(dayHigh, c.high);
    if (c.candleTime < '09:45' || c.candleTime > '11:27' || i < 10) continue;
    if ((dayHigh - c.close) / dayHigh * 100 >= 2.0) pullbackSeen = true;
    if (!pullbackSeen) continue;
    const ma = sma(candles, i, 8); const ma2 = sma(candles, i - 2, 8);
    const high10 = Math.max(...candles.slice(i - 10, i).map(item => item.high));
    const body = (c.close - c.open) / c.open * 100;
    if (ma !== null && ma2 !== null && (ma - ma2) / ma2 * 100 >= 0.02 && c.high > high10 && body >= 0.5 && volumeRatio(candles, i) >= 1.2) {
      return closeTrade(date, candles, i, c.close, 'LONG', '勢い付き記憶LONG', '11:27');
    }
  }
  return null;
}

function summary(label: string, trades: Trade[]) {
  const wins = trades.filter(trade => trade.pnl > 0).length;
  const pnl = trades.reduce((total, trade) => total + trade.pnl, 0);
  console.log(`${label}: ${trades.length}件 ${wins}勝${trades.length - wins}敗 勝率${trades.length ? (wins / trades.length * 100).toFixed(1) : '0'}% 損益${pnl >= 0 ? '+' : ''}${Math.round(pnl).toLocaleString()}円`);
}

async function main() {
  const db = await getDb();
  const dateRows = await db.execute(sql`SELECT DISTINCT tradeDate FROM rt_candles WHERE symbol='285A' ORDER BY tradeDate`);
  const dates = ((dateRows as any)[0] as Array<{ tradeDate: string }>).map(row => row.tradeDate);
  const allRaw: Trade[] = [], allWait: Trade[] = [], allLong: Trade[] = [];
  let suppressed = 0;
  const todayDetails: string[] = [];
  for (const date of dates) {
    const rows = await db.execute(sql`SELECT candleTime, open, high, low, close, volume FROM rt_candles WHERE symbol='285A' AND tradeDate=${date} ORDER BY candleTime`);
    const candles = ((rows as any)[0] as any[]).map(row => ({ candleTime: String(row.candleTime), open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: Number(row.volume) })) as Candle[];
    const raw = rawReversalShort(date, candles); if (raw) allRaw.push(raw.trade);
    const waited = waitForExhaustion(date, candles); if (waited.trade) allWait.push(waited.trade); if (waited.suppressed) suppressed++;
    const long = impulseMemoryLong(date, candles); if (long) allLong.push(long);
    if (date === '2026-08-21') {
      todayDetails.push(`8/21 現行SHORT=${raw ? `${raw.trade.time} ${raw.trade.result} ${Math.round(raw.trade.pnl)}円` : 'なし'}`);
      todayDetails.push(`8/21 売り枯れ待機=${waited.suppressed ? '10:05の出来高2倍超・安値更新でSHORT抑止' : waited.trade ? `${waited.trade.time} ${waited.trade.result} ${Math.round(waited.trade.pnl)}円` : 'なし'}`);
      todayDetails.push(`8/21 LONG=${long ? `${long.time} ${long.result} +${Math.round(long.pnl)}円` : 'なし'}`);
    }
  }
  summary('現行反転SHORT（技術条件のみ）', allRaw);
  summary(`売り枯れ待機SHORT（抑止${suppressed}件）`, allWait);
  summary('勢い付き記憶LONG', allLong);
  const combined: Trade[] = [];
  for (const date of dates) {
    const daily = [...allWait.filter(trade => trade.date === date), ...allLong.filter(trade => trade.date === date)].sort((a, b) => a.time.localeCompare(b.time));
    for (const trade of daily) {
      const last = combined.filter(item => item.date === date).at(-1);
      if (!last || trade.time > last.exitTime) combined.push(trade);
    }
  }
  summary('売り枯れ待機SHORT＋勢い付き記憶LONG（時刻順1ポジション）', combined);
  console.log(todayDetails.join('\n'));
}

main().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
