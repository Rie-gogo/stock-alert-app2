import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

type Trade = {
  date: string;
  time: string;
  type: 'CB' | '反転';
  entry: number;
  pnl: number;
  exitType: string;
  exitTime: string;
  rise?: number;
  drop?: number;
  wait?: number;
};

const CAPITAL = 3_000_000;
const LOT_RATIO = 0.9;
const SL = 0.8;
const TP = 1.5;

function shares(price: number) {
  return Math.max(100, Math.floor(Math.floor(CAPITAL * LOT_RATIO / price) / 100) * 100);
}

function calcMa(candles: any[], index: number, period: number) {
  if (index - period + 1 < 0) return null;
  const values = candles.slice(index - period + 1, index + 1).map(c => Number(c.close));
  return values.reduce((sum, value) => sum + value, 0) / period;
}

function summary(label: string, trades: Trade[]) {
  const wins = trades.filter(trade => trade.pnl > 0).length;
  const total = trades.reduce((sum, trade) => sum + trade.pnl, 0);
  const winRate = trades.length ? wins / trades.length * 100 : 0;
  console.log(`${label}: ${trades.length}件 ${wins}勝${trades.length - wins}敗 勝率${winRate.toFixed(1)}% 損益${total >= 0 ? '+' : ''}${total.toLocaleString()}円`);
}

async function main() {
  const db = await getDb();
  const datesResult = await db.execute(sql`
    SELECT DISTINCT tradeDate FROM rt_candles WHERE symbol = '285A' ORDER BY tradeDate
  `);
  const dates = ((datesResult as any)[0] as any[]).map(row => row.tradeDate as string);
  const candlesByDate: Record<string, any[]> = {};
  for (const date of dates) {
    const r = await db.execute(sql`
      SELECT candleTime, open, high, low, close, volume FROM rt_candles
      WHERE symbol = '285A' AND tradeDate = ${date}
      ORDER BY candleTime
    `);
    candlesByDate[date] = (r as any)[0] as any[];
  }

  // CBフィルター検証済みの安全な4取引
  const cbTrades: Trade[] = [
    { date: '2026-07-07', time: '09:43', type: 'CB', entry: 75660, pnl: 113490, exitType: '利確', exitTime: '09:47' },
    { date: '2026-07-07', time: '10:13', type: 'CB', entry: 74570, pnl: 111855, exitType: '利確', exitTime: '10:20' },
    { date: '2026-07-13', time: '09:49', type: 'CB', entry: 73240, pnl: 109860, exitType: '利確', exitTime: '09:57' },
    { date: '2026-08-07', time: '10:15', type: 'CB', entry: 45770, pnl: 68655, exitType: '利確', exitTime: '10:23' },
  ];
  const cbDates = new Set(cbTrades.map(trade => trade.date));
  const reversals: Trade[] = [];

  // 正のリスクリワードをより大きく取る候補: 始値から3%以上上昇後、当日高値から1.5%以上反落、
  // MA8下向き、直近10本安値更新。09:45〜14:30。SL0.8% / TP1.5%（TP > SL）。
  for (const date of dates) {
    if (cbDates.has(date)) continue; // 同日CBがある場合はCBを優先
    const candles = candlesByDate[date];
    if (!candles || candles.length < 10) continue;
    const dayOpen = Number(candles[0].open);
    let dayHigh = 0;
    let highIndex = 0;
    let entered = false;
    for (let i = 0; i < candles.length; i++) {
      const candle = candles[i];
      const time = candle.candleTime as string;
      const high = Number(candle.high);
      const close = Number(candle.close);
      if (high > dayHigh) { dayHigh = high; highIndex = i; }
      if (entered || time < '09:45' || time > '14:30' || i < 10) continue;
      const rise = (dayHigh - dayOpen) / dayOpen * 100;
      const drop = (dayHigh - close) / dayHigh * 100;
      const wait = i - highIndex;
      if (rise < 3.0 || drop < 1.5 || wait < 0) continue;
      const now = calcMa(candles, i, 8)!;
      const prev = calcMa(candles, i - 1, 8)!;
      if (now >= prev) continue;
      const priorLows = candles.slice(Math.max(0, i - 10), i).map(c => Number(c.low));
      if (Number(candle.low) >= Math.min(...priorLows)) continue;
      entered = true;
      const stop = close * (1 + SL / 100);
      const target = close * (1 - TP / 100);
      let exitType = '大引け';
      let exitTime = candles[candles.length - 1].candleTime as string;
      let pnlPerShare = close - Number(candles[candles.length - 1].close);
      for (let j = i + 1; j < candles.length; j++) {
        if (Number(candles[j].high) >= stop) {
          exitType = '損切り';
          exitTime = candles[j].candleTime;
          pnlPerShare = close - stop;
          break;
        }
        if (Number(candles[j].low) <= target) {
          exitType = '利確';
          exitTime = candles[j].candleTime;
          pnlPerShare = close - target;
          break;
        }
        if (candles[j].candleTime >= '15:00') {
          exitType = '大引け';
          exitTime = candles[j].candleTime;
          pnlPerShare = close - Number(candles[j].close);
          break;
        }
      }
      reversals.push({ date, time, type: '反転', entry: close, pnl: pnlPerShare * shares(close), exitType, exitTime, rise, drop, wait });
    }
  }

  const allTrades = [...cbTrades, ...reversals].sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
  console.log('=== 候補設定 ===');
  console.log('CB: 前場の大台割れCBのみ。日中-8%超の追撃と当日安値から1%超の反発後を除外。');
  console.log('反転: 始値+3.0%到達 → 高値から1.5%反落 → MA8下向き・10本安値更新。09:45〜14:30。');
  console.log(`反転のSL=${SL}% / TP=${TP}%（リスクリワード ${Math.round(TP / SL * 100) / 100}:1）。\n`);

  console.log('=== 全取引 ===');
  for (const trade of allTrades) {
    const meta = trade.type === '反転' ? ` | 上${trade.rise!.toFixed(1)}% 落${trade.drop!.toFixed(1)}% 待${trade.wait}分` : '';
    console.log(`${trade.pnl > 0 ? '○' : '×'} ${trade.date} ${trade.time} ${trade.type} @${trade.entry} → ${trade.exitType}(${trade.exitTime}) ${trade.pnl >= 0 ? '+' : ''}${trade.pnl.toLocaleString()}円${meta}`);
  }
  console.log();
  summary('全40営業日', allTrades);
  summary('CBのみ', cbTrades);
  summary('反転のみ（CB優先で重複日除外）', reversals);

  // 時系列分割（選定に用いた期間との重なりに注意を明示するため）
  const splitDate = '2026-07-22';
  summary(`前半（〜${splitDate}）`, allTrades.filter(trade => trade.date <= splitDate));
  summary(`後半（${splitDate}より後）`, allTrades.filter(trade => trade.date > splitDate));

  const aug19 = allTrades.filter(trade => trade.date === '2026-08-19');
  const aug20 = allTrades.filter(trade => trade.date === '2026-08-20');
  console.log(`\n8/19: ${aug19.length ? aug19.map(t => `${t.time} ${t.type} ${t.pnl >= 0 ? '+' : ''}${t.pnl.toLocaleString()}円`).join(' / ') : '発火なし'}`);
  console.log(`8/20: ${aug20.length ? aug20.map(t => `${t.time} ${t.type} ${t.pnl >= 0 ? '+' : ''}${t.pnl.toLocaleString()}円`).join(' / ') : '発火なし'}`);
  process.exit(0);
}
main();
