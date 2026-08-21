import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

type Side = 'LONG' | 'SHORT';

type Signal = {
  date: string;
  time: string;
  side: Side;
  type: '反転LONG' | '安全CB SHORT' | '反転SHORT';
  entry: number;
  exitTime: string;
  exitType: string;
  pnl: number;
};

const CAPITAL = 3_000_000;
const LOT_RATIO = 0.9;

function shares(price: number) {
  const raw = Math.floor(CAPITAL * LOT_RATIO / price);
  return Math.max(100, Math.floor(raw / 100) * 100);
}

function ma(candles: any[], index: number, period: number): number | null {
  if (index - period + 1 < 0) return null;
  const closes = candles.slice(index - period + 1, index + 1).map(c => Number(c.close));
  return closes.reduce((sum, close) => sum + close, 0) / period;
}

function closeLong(candles: any[], index: number, entry: number): Pick<Signal, 'exitTime' | 'exitType' | 'pnl'> {
  const tp = entry * 1.008;
  const sl = entry * 0.994;
  const size = shares(entry);
  for (let j = index + 1; j < candles.length; j++) {
    const candle = candles[j];
    if (Number(candle.low) <= sl) return { exitTime: candle.candleTime, exitType: '損切り', pnl: (sl - entry) * size };
    if (Number(candle.high) >= tp) return { exitTime: candle.candleTime, exitType: '利確', pnl: (tp - entry) * size };
    if (candle.candleTime >= '11:27') return { exitTime: candle.candleTime, exitType: '前場強制決済', pnl: (Number(candle.close) - entry) * size };
  }
  const last = candles[candles.length - 1];
  return { exitTime: last.candleTime, exitType: '大引け', pnl: (Number(last.close) - entry) * size };
}

function closeShort(candles: any[], index: number, entry: number): Pick<Signal, 'exitTime' | 'exitType' | 'pnl'> {
  const tp = entry * 0.985;
  const sl = entry * 1.008;
  const size = shares(entry);
  for (let j = index + 1; j < candles.length; j++) {
    const candle = candles[j];
    if (Number(candle.high) >= sl) return { exitTime: candle.candleTime, exitType: '損切り', pnl: (entry - sl) * size };
    if (Number(candle.low) <= tp) return { exitTime: candle.candleTime, exitType: '利確', pnl: (entry - tp) * size };
    if (candle.candleTime >= '15:00') return { exitTime: candle.candleTime, exitType: '大引け', pnl: (entry - Number(candle.close)) * size };
  }
  const last = candles[candles.length - 1];
  return { exitTime: last.candleTime, exitType: '大引け', pnl: (entry - Number(last.close)) * size };
}

function summary(label: string, signals: Signal[]) {
  const wins = signals.filter(signal => signal.pnl > 0).length;
  const pnl = signals.reduce((sum, signal) => sum + signal.pnl, 0);
  console.log(`${label}: ${signals.length}件 ${wins}勝${signals.length - wins}敗 勝率${signals.length ? (wins / signals.length * 100).toFixed(1) : '0'}% 損益${pnl >= 0 ? '+' : ''}${pnl.toLocaleString()}円`);
}

async function main() {
  const db = await getDb();
  const result = await db.execute(sql`
    SELECT DISTINCT tradeDate FROM rt_candles WHERE symbol = '285A' ORDER BY tradeDate
  `);
  const dates = ((result as any)[0] as any[]).map(row => row.tradeDate as string);
  const candlesByDate: Record<string, any[]> = {};
  for (const date of dates) {
    const r = await db.execute(sql`
      SELECT candleTime, open, high, low, close, volume FROM rt_candles
      WHERE symbol = '285A' AND tradeDate = ${date}
      ORDER BY candleTime
    `);
    candlesByDate[date] = (r as any)[0] as any[];
  }

  const safeCb: Signal[] = [
    { date: '2026-07-07', time: '09:43', side: 'SHORT', type: '安全CB SHORT', entry: 75660, exitTime: '09:47', exitType: '利確', pnl: 113490 },
    { date: '2026-07-07', time: '10:13', side: 'SHORT', type: '安全CB SHORT', entry: 74570, exitTime: '10:20', exitType: '利確', pnl: 111855 },
    { date: '2026-07-13', time: '09:49', side: 'SHORT', type: '安全CB SHORT', entry: 73240, exitTime: '09:57', exitType: '利確', pnl: 109860 },
    { date: '2026-08-07', time: '10:15', side: 'SHORT', type: '安全CB SHORT', entry: 45770, exitTime: '10:23', exitType: '利確', pnl: 68655 },
  ];
  const cbDays = new Set(safeCb.map(signal => signal.date));
  const longSignals: Signal[] = [];
  const shortSignals: Signal[] = [];

  for (const date of dates) {
    const candles = candlesByDate[date];
    if (candles.length < 12) continue;
    const dayOpen = Number(candles[0].open);

    // 現行の285A反転LONG: 高値から2.5%下落後、MA8傾き>=0.02%、直近10本高値更新、09:45〜11:27。
    let longDayHigh = 0;
    let longFired = false;
    for (let i = 0; i < candles.length; i++) {
      const candle = candles[i];
      const time = candle.candleTime as string;
      const high = Number(candle.high);
      const close = Number(candle.close);
      if (high > longDayHigh) longDayHigh = high;
      if (longFired || time < '09:45' || time > '11:27' || i < 10) continue;
      const decline = (longDayHigh - close) / longDayHigh * 100;
      if (decline < 2.5) continue;
      const currentMa = ma(candles, i, 8)!;
      const twoAgoMa = ma(candles, i - 2, 8)!;
      const slope = (currentMa - twoAgoMa) / twoAgoMa * 100;
      if (slope < 0.02) continue;
      const recentHigh = Math.max(...candles.slice(Math.max(0, i - 10), i).map(c => Number(c.high)));
      if (Number(candle.high) <= recentHigh) continue;
      longFired = true;
      longSignals.push({ date, time, side: 'LONG', type: '反転LONG', entry: close, ...closeLong(candles, i, close) });
    }

    // 提案する反転SHORT: 同時刻または保有時間が重なる場合のみ、後段の時刻順処理でCBを優先する。
    // 将来のCB発火を事前に知ることはできないため、同日の反転SHORTを一律には除外しない。
    let shortDayHigh = 0;
    let highIndex = 0;
    let shortFired = false;
    for (let i = 0; i < candles.length; i++) {
      const candle = candles[i];
      const time = candle.candleTime as string;
      const high = Number(candle.high);
      const close = Number(candle.close);
      if (high > shortDayHigh) { shortDayHigh = high; highIndex = i; }
      if (shortFired || time < '09:45' || time > '11:27' || i < 10) continue;
      const rise = (shortDayHigh - dayOpen) / dayOpen * 100;
      const decline = (shortDayHigh - close) / shortDayHigh * 100;
      if (rise < 3.0 || decline < 1.5) continue;
      const nowMa = ma(candles, i, 8)!;
      const previousMa = ma(candles, i - 1, 8)!;
      if (nowMa >= previousMa) continue;
      const recentLow = Math.min(...candles.slice(Math.max(0, i - 10), i).map(c => Number(c.low)));
      if (Number(candle.low) >= recentLow) continue;
      shortFired = true;
      shortSignals.push({ date, time, side: 'SHORT', type: '反転SHORT', entry: close, ...closeShort(candles, i, close) });
    }
  }

  const proposedShorts = [...safeCb, ...shortSignals];
  const raw = [...longSignals, ...proposedShorts].sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));

  // ポジション競合を考慮: 同一銘柄で保有中なら後の候補をブロックし、決済後のみ次の候補を許可。
  const accepted: Signal[] = [];
  const blocked: Array<Signal & { blocker: Signal }> = [];
  for (const date of dates) {
    const daySignals = raw.filter(signal => signal.date === date).sort((a, b) => a.time.localeCompare(b.time));
    let active: Signal | null = null;
    for (const signal of daySignals) {
      if (active && signal.time <= active.exitTime) {
        blocked.push({ ...signal, blocker: active });
      } else {
        accepted.push(signal);
        active = signal;
      }
    }
  }

  console.log('=== 候補シグナル件数（40営業日） ===');
  summary('反転LONG', longSignals);
  summary('安全CB + 反転SHORT', proposedShorts);
  summary('単純合算（競合未調整）', raw);
  summary('保有時間の競合を調整後', accepted);
  console.log(`\n1日あたり: 単純合算 ${(raw.length / dates.length).toFixed(2)}件/日、競合調整後 ${(accepted.length / dates.length).toFixed(2)}件/日`);
  console.log(`シグナルが1件以上ある日: ${new Set(accepted.map(s => s.date)).size}/${dates.length}営業日`);
  console.log(`ポジション重複でブロックされた候補: ${blocked.length}件`);

  console.log('\n=== 日別の競合調整後シグナル ===');
  for (const date of dates) {
    const day = accepted.filter(signal => signal.date === date);
    if (!day.length) continue;
    console.log(`${date}: ${day.map(s => `${s.time} ${s.type} ${s.side} ${s.pnl >= 0 ? '+' : ''}${s.pnl.toLocaleString()}円`).join(' / ')}`);
  }
  if (blocked.length) {
    console.log('\n=== ポジション競合で発火しない候補 ===');
    for (const signal of blocked) {
      console.log(`${signal.date} ${signal.time} ${signal.type} は ${signal.blocker.time} ${signal.blocker.type} の保有中（${signal.blocker.exitTime}決済）`);
    }
  }
  process.exit(0);
}
main();
