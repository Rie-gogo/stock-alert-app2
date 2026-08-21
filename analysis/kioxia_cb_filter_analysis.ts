import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

type CbTrade = {
  date: string;
  time: string;
  entry: number;
  pnl: number;
  shares: number;
  exitTime: string;
  win: boolean;
};

type FeatureTrade = CbTrade & {
  dayChangePct: number;
  dropFromHighPct: number;
  dayRangePct: number;
  ma8Slope: number;
  ma20Slope: number;
  priceVsMa8: number;
  recent5Change: number;
  recent10Change: number;
  recent5BearCount: number;
  volRatio: number;
  minutesFromHigh: number;
  minutesFromLow: number;
  opening30Change: number;
};

function avg(values: number[]) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function movingAverage(candles: any[], endIndex: number, length: number): number | null {
  if (endIndex - length + 1 < 0) return null;
  return avg(candles.slice(endIndex - length + 1, endIndex + 1).map(c => Number(c.close)));
}

async function main() {
  const db = await getDb();
  const raw = await db.execute(sql`
    SELECT id, tradeDate, tradeTime, action, side, price, shares, pnl, reason
    FROM rt_trades
    WHERE symbol = '285A'
    ORDER BY id
  `);
  const rows = (raw as any)[0] as any[];

  const allShorts: CbTrade[] = [];
  for (let i = 0; i < rows.length; i++) {
    const entry = rows[i];
    if (entry.action !== 'short' || entry.side !== 'short' || !String(entry.reason || '').includes('大台割れ')) continue;
    for (let j = i + 1; j < rows.length; j++) {
      const exit = rows[j];
      if (exit.action === 'cover' && exit.side === 'short' && exit.tradeDate === entry.tradeDate) {
        allShorts.push({
          date: entry.tradeDate,
          time: entry.tradeTime,
          entry: Number(entry.price),
          shares: Number(entry.shares),
          pnl: Number(exit.pnl),
          exitTime: exit.tradeTime,
          win: Number(exit.pnl) > 0,
        });
        break;
      }
    }
  }

  const cbAm = allShorts.filter(t => t.time <= '11:27');
  console.log(`前場CB SHORT: ${cbAm.length}件（${cbAm.filter(t => t.win).length}勝${cbAm.filter(t => !t.win).length}敗）\n`);

  const features: FeatureTrade[] = [];
  for (const trade of cbAm) {
    const result = await db.execute(sql`
      SELECT candleTime, open, high, low, close, volume, boardSnapshot
      FROM rt_candles
      WHERE symbol = '285A' AND tradeDate = ${trade.date}
      ORDER BY candleTime
    `);
    const candles = (result as any)[0] as any[];
    const idx = candles.findIndex(c => c.candleTime === trade.time);
    if (idx < 0) {
      console.log(`警告: ${trade.date} ${trade.time}のローソク足を取得できません`);
      continue;
    }
    const c = candles[idx];
    const prior = candles.slice(0, idx + 1);
    const dayOpen = Number(candles[0].open);
    const dayHigh = Math.max(...prior.map(x => Number(x.high)));
    const dayLow = Math.min(...prior.map(x => Number(x.low)));
    const highIdx = prior.findIndex(x => Number(x.high) === dayHigh);
    const lowIdx = prior.findIndex(x => Number(x.low) === dayLow);
    const ma8 = movingAverage(candles, idx, 8) ?? trade.entry;
    const ma8TwoAgo = movingAverage(candles, idx - 2, 8) ?? ma8;
    const ma20 = movingAverage(candles, idx, 20) ?? ma8;
    const ma20TwoAgo = movingAverage(candles, idx - 2, 20) ?? ma20;
    const volBase = avg(candles.slice(Math.max(0, idx - 20), idx).map(x => Number(x.volume)));
    const recent5Start = Number(candles[Math.max(0, idx - 5)].close);
    const recent10Start = Number(candles[Math.max(0, idx - 10)].close);
    const recent5 = candles.slice(Math.max(0, idx - 4), idx + 1);

    features.push({
      ...trade,
      dayChangePct: (Number(c.close) - dayOpen) / dayOpen * 100,
      dropFromHighPct: (dayHigh - Number(c.close)) / dayHigh * 100,
      dayRangePct: (dayHigh - dayLow) / dayOpen * 100,
      ma8Slope: (ma8 - ma8TwoAgo) / ma8TwoAgo * 100,
      ma20Slope: (ma20 - ma20TwoAgo) / ma20TwoAgo * 100,
      priceVsMa8: (Number(c.close) - ma8) / ma8 * 100,
      recent5Change: (Number(c.close) - recent5Start) / recent5Start * 100,
      recent10Change: (Number(c.close) - recent10Start) / recent10Start * 100,
      recent5BearCount: recent5.filter(x => Number(x.close) < Number(x.open)).length,
      volRatio: volBase > 0 ? Number(c.volume) / volBase : 0,
      minutesFromHigh: idx - highIdx,
      minutesFromLow: idx - lowIdx,
      opening30Change: idx >= 30 ? (Number(candles[29].close) - dayOpen) / dayOpen * 100 : 0,
    });
  }

  console.log('=== 前場CB SHORT 取引別の特徴量 ===');
  console.log('結果 | 日付       時刻  | 日中% | 高値下落 | 値幅 | MA8傾 | MA20傾 | MA8乖離 | 5本% | 10本% | 陰線 | 出来高 | 高値後 | 安値後 | 損益');
  console.log('-'.repeat(150));
  for (const t of features) {
    console.log(`${t.win ? '○' : '×'} | ${t.date} ${t.time} | ${t.dayChangePct.toFixed(2)}% | ${t.dropFromHighPct.toFixed(2)}% | ${t.dayRangePct.toFixed(2)}% | ${t.ma8Slope.toFixed(3)}% | ${t.ma20Slope.toFixed(3)}% | ${t.priceVsMa8.toFixed(2)}% | ${t.recent5Change.toFixed(2)}% | ${t.recent10Change.toFixed(2)}% | ${t.recent5BearCount} | ${t.volRatio.toFixed(2)}x | ${t.minutesFromHigh}分 | ${t.minutesFromLow}分 | ${t.pnl > 0 ? '+' : ''}${t.pnl.toLocaleString()}円`);
  }

  const wins = features.filter(t => t.win);
  const losses = features.filter(t => !t.win);
  const fields: Array<keyof Omit<FeatureTrade, keyof CbTrade | 'win'>> = [
    'dayChangePct', 'dropFromHighPct', 'dayRangePct', 'ma8Slope', 'ma20Slope', 'priceVsMa8',
    'recent5Change', 'recent10Change', 'recent5BearCount', 'volRatio', 'minutesFromHigh', 'minutesFromLow', 'opening30Change',
  ];
  console.log('\n=== 勝ち・負けの平均比較 ===');
  console.log('指標 | 利確（5件） | 損切り（2件） | 差');
  console.log('-'.repeat(75));
  for (const field of fields) {
    const w = avg(wins.map(x => Number(x[field])));
    const l = avg(losses.map(x => Number(x[field])));
    console.log(`${field} | ${w.toFixed(3)} | ${l.toFixed(3)} | ${(w - l).toFixed(3)}`);
  }

  type Candidate = { name: string; pass: (t: FeatureTrade) => boolean };
  const candidates: Candidate[] = [
    { name: '日中騰落率<=0%（始値を下回る）', pass: t => t.dayChangePct <= 0 },
    { name: '日中騰落率<=-1%', pass: t => t.dayChangePct <= -1 },
    { name: 'MA8傾き<=-0.05%', pass: t => t.ma8Slope <= -0.05 },
    { name: 'MA8傾き<=-0.10%', pass: t => t.ma8Slope <= -0.10 },
    { name: 'MA20傾き<=-0.03%', pass: t => t.ma20Slope <= -0.03 },
    { name: '高値から下落>=1.5%', pass: t => t.dropFromHighPct >= 1.5 },
    { name: '高値から下落>=2.0%', pass: t => t.dropFromHighPct >= 2.0 },
    { name: '直近5本変化<=-0.5%', pass: t => t.recent5Change <= -0.5 },
    { name: '直近10本変化<=-1.0%', pass: t => t.recent10Change <= -1.0 },
    { name: '直近5本の陰線>=3本', pass: t => t.recent5BearCount >= 3 },
    { name: '出来高比<=1.0x', pass: t => t.volRatio <= 1.0 },
    { name: '高値から>=10分経過', pass: t => t.minutesFromHigh >= 10 },
  ];
  console.log('\n=== 候補フィルター別のCB成績 ===');
  for (const candidate of candidates) {
    const filtered = features.filter(candidate.pass);
    const w = filtered.filter(t => t.win).length;
    const l = filtered.filter(t => !t.win).length;
    const pnl = filtered.reduce((sum, t) => sum + t.pnl, 0);
    console.log(`${candidate.name}: ${filtered.length}件 ${w}勝${l}敗 勝率${filtered.length ? (w / filtered.length * 100).toFixed(1) : 0}% 損益${pnl >= 0 ? '+' : ''}${pnl.toLocaleString()}円 | 除外: ${features.filter(t => !candidate.pass).map(t => `${t.date} ${t.win ? '○' : '×'}`).join(', ')}`);
  }

  // 2条件の組み合わせ（勝ちを維持し、損切りを減らす）
  console.log('\n=== 2条件の組み合わせ ===');
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const filtered = features.filter(t => candidates[i].pass(t) && candidates[j].pass(t));
      if (filtered.length < 3) continue;
      const w = filtered.filter(t => t.win).length;
      const l = filtered.filter(t => !t.win).length;
      const pnl = filtered.reduce((sum, t) => sum + t.pnl, 0);
      if (w / filtered.length >= 0.7) {
        console.log(`${candidates[i].name} AND ${candidates[j].name}: ${filtered.length}件 ${w}勝${l}敗 勝率${(w / filtered.length * 100).toFixed(1)}% 損益${pnl >= 0 ? '+' : ''}${pnl.toLocaleString()}円`);
      }
    }
  }

  process.exit(0);
}

main();
