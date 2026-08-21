import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

type CbTrade = {
  date: string;
  time: string;
  entry: number;
  pnl: number;
  win: boolean;
};

function average(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

async function getCandles(db: any, date: string) {
  const r = await db.execute(sql`
    SELECT candleTime, open, high, low, close, volume, boardSnapshot
    FROM rt_candles
    WHERE symbol = '285A' AND tradeDate = ${date}
    ORDER BY candleTime
  `);
  return (r as any)[0] as any[];
}

function parseBoard(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  try { return JSON.parse(String(raw)); } catch { return {}; }
}

async function main() {
  const db = await getDb();
  const r = await db.execute(sql`
    SELECT id, tradeDate, tradeTime, action, side, price, pnl, reason
    FROM rt_trades
    WHERE symbol = '285A'
    ORDER BY id
  `);
  const rows = (r as any)[0] as any[];
  const cbTrades: CbTrade[] = [];
  for (let i = 0; i < rows.length; i++) {
    const entry = rows[i];
    if (entry.action !== 'short' || entry.side !== 'short' || !String(entry.reason || '').includes('大台割れ') || entry.tradeTime > '11:27') continue;
    for (let j = i + 1; j < rows.length; j++) {
      const cover = rows[j];
      if (cover.action === 'cover' && cover.side === 'short' && cover.tradeDate === entry.tradeDate) {
        cbTrades.push({ date: entry.tradeDate, time: entry.tradeTime, entry: Number(entry.price), pnl: Number(cover.pnl), win: Number(cover.pnl) > 0 });
        break;
      }
    }
  }

  const allDatesResult = await db.execute(sql`
    SELECT DISTINCT tradeDate FROM rt_candles WHERE symbol = '285A' ORDER BY tradeDate
  `);
  const dates = ((allDatesResult as any)[0] as any[]).map(row => row.tradeDate as string);

  console.log('=== キオクシア 前場大台割れCB SHORT: 損切り分離の追加分析 ===');
  console.log('結果 | 日付       時刻 | 日中% | 前日比ギャップ | 当日安値から | 20本安値から | 20本高値から | 20本値幅 | 30分変化 | 直近3本 | 出来高比 | 損益');
  console.log('-'.repeat(170));

  const features: Array<CbTrade & Record<string, number>> = [];
  for (const trade of cbTrades) {
    const candles = await getCandles(db, trade.date);
    const index = candles.findIndex(candle => candle.candleTime === trade.time);
    if (index < 0) continue;
    const candle = candles[index];
    const previousDate = dates[dates.indexOf(trade.date) - 1];
    const previousCandles = previousDate ? await getCandles(db, previousDate) : [];
    const previousClose = previousCandles.length ? Number(previousCandles[previousCandles.length - 1].close) : Number(candles[0].open);
    const dayOpen = Number(candles[0].open);
    const prior = candles.slice(0, index + 1);
    const close = Number(candle.close);
    const dayLow = Math.min(...prior.map(c => Number(c.low)));
    const dayHigh = Math.max(...prior.map(c => Number(c.high)));
    const lb20 = candles.slice(Math.max(0, index - 20), index + 1);
    const high20 = Math.max(...lb20.map(c => Number(c.high)));
    const low20 = Math.min(...lb20.map(c => Number(c.low)));
    const volBase = average(candles.slice(Math.max(0, index - 20), index).map(c => Number(c.volume)));
    const return3 = index >= 3 ? (close - Number(candles[index - 3].close)) / Number(candles[index - 3].close) * 100 : 0;
    const return30 = index >= 30 ? (close - Number(candles[index - 30].close)) / Number(candles[index - 30].close) * 100 : 0;
    const gap = previousClose ? (dayOpen - previousClose) / previousClose * 100 : 0;
    const board = parseBoard(candle.boardSnapshot);
    const bpr = Number(board.buyPressureRatio ?? board.bpr ?? board.buySellRatio ?? 0);

    const feature = {
      ...trade,
      dayChange: (close - dayOpen) / dayOpen * 100,
      gap,
      reboundFromDayLow: dayLow ? (close - dayLow) / dayLow * 100 : 0,
      reboundFromLow20: low20 ? (close - low20) / low20 * 100 : 0,
      dropFromHigh20: high20 ? (high20 - close) / high20 * 100 : 0,
      range20: dayOpen ? (high20 - low20) / dayOpen * 100 : 0,
      return3,
      return30,
      volRatio: volBase ? Number(candle.volume) / volBase : 0,
      bpr,
      dayRange: dayOpen ? (dayHigh - dayLow) / dayOpen * 100 : 0,
    };
    features.push(feature);
    console.log(`${trade.win ? '○' : '×'} | ${trade.date} ${trade.time} | ${feature.dayChange.toFixed(2)}% | ${feature.gap.toFixed(2)}% | ${feature.reboundFromDayLow.toFixed(2)}% | ${feature.reboundFromLow20.toFixed(2)}% | ${feature.dropFromHigh20.toFixed(2)}% | ${feature.range20.toFixed(2)}% | ${feature.return30.toFixed(2)}% | ${feature.return3.toFixed(2)}% | ${feature.volRatio.toFixed(2)}x | ${trade.pnl > 0 ? '+' : ''}${trade.pnl.toLocaleString()}円`);
  }

  const candidates: Array<{ name: string; test: (t: typeof features[number]) => boolean }> = [
    { name: '日中下落率 > -8.0%（極端な下落日の追撃を回避）', test: t => t.dayChange > -8.0 },
    { name: '日中下落率 > -7.5%', test: t => t.dayChange > -7.5 },
    { name: '当日安値からの反発 < 1.0%（底値から大きく戻した後を回避）', test: t => t.reboundFromDayLow < 1.0 },
    { name: '当日安値からの反発 < 0.5%', test: t => t.reboundFromDayLow < 0.5 },
    { name: '直近20本安値からの反発 < 0.8%', test: t => t.reboundFromLow20 < 0.8 },
    { name: '直近20本高値からの下落 < 9.0%', test: t => t.dropFromHigh20 < 9.0 },
    { name: '直近20本高値からの下落 < 8.8%', test: t => t.dropFromHigh20 < 8.8 },
    { name: '30分変化 > -5.0%', test: t => t.return30 > -5.0 },
    { name: '前日比ギャップ > -5.0%', test: t => t.gap > -5.0 },
    { name: '前日比ギャップ > -3.0%', test: t => t.gap > -3.0 },
    { name: '直近3本変化 <= -0.3%', test: t => t.return3 <= -0.3 },
  ];

  console.log('\n=== 単独フィルター ===');
  for (const candidate of candidates) {
    const selected = features.filter(candidate.test);
    const w = selected.filter(t => t.win).length;
    const l = selected.length - w;
    const pnl = selected.reduce((sum, t) => sum + t.pnl, 0);
    console.log(`${candidate.name}: ${selected.length}件 ${w}勝${l}敗 勝率${selected.length ? (w / selected.length * 100).toFixed(1) : 0}% 損益${pnl >= 0 ? '+' : ''}${pnl.toLocaleString()}円 | 除外=${features.filter(t => !candidate.test(t)).map(t => `${t.date}${t.win ? '○' : '×'}`).join(', ') || 'なし'}`);
  }

  console.log('\n=== 2条件の組み合わせ（最低3件・勝率70%以上） ===');
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const selected = features.filter(t => candidates[i].test(t) && candidates[j].test(t));
      const w = selected.filter(t => t.win).length;
      const l = selected.length - w;
      const pnl = selected.reduce((sum, t) => sum + t.pnl, 0);
      if (selected.length >= 3 && w / selected.length >= 0.7) {
        console.log(`${candidates[i].name} AND ${candidates[j].name}: ${selected.length}件 ${w}勝${l}敗 勝率${(w / selected.length * 100).toFixed(1)}% 損益${pnl >= 0 ? '+' : ''}${pnl.toLocaleString()}円`);
      }
    }
  }
  process.exit(0);
}
main();
