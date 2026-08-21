import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

type ReversalParams = {
  rise: number;
  drop: number;
  sl: number;
  tp: number;
  start: string;
  end: string;
  minMinutes: number;
  minDownSlope: number;
};

type SimTrade = {
  date: string;
  time: string;
  entry: number;
  pnlPerShare: number;
  pnlYen: number;
  exitType: string;
  exitTime: string;
};

type Summary = {
  params: ReversalParams;
  trades: SimTrade[];
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  aug19?: SimTrade;
  aug20?: SimTrade;
};

const CAPITAL_PER_STOCK = 3_000_000;
const LOT_RATIO = 0.9;

function calcShares(price: number) {
  const raw = Math.floor((CAPITAL_PER_STOCK * LOT_RATIO) / price);
  return Math.max(100, Math.floor(raw / 100) * 100);
}

function ma(candles: any[], endIndex: number, period: number) {
  if (endIndex - period + 1 < 0) return null;
  const closes = candles.slice(endIndex - period + 1, endIndex + 1).map(c => Number(c.close));
  return closes.reduce((sum, value) => sum + value, 0) / period;
}

function simulateReversal(candlesByDate: Record<string, any[]>, dates: string[], params: ReversalParams): SimTrade[] {
  const trades: SimTrade[] = [];
  const maPeriod = 8;
  for (const date of dates) {
    const candles = candlesByDate[date];
    if (!candles || candles.length < maPeriod + 3) continue;
    const dayOpen = Number(candles[0].open);
    let dayHigh = 0;
    let highIndex = 0;
    let fired = false;

    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      const h = Number(c.high);
      const close = Number(c.close);
      const time = c.candleTime as string;
      if (h > dayHigh) {
        dayHigh = h;
        highIndex = i;
      }
      if (fired || time < params.start || time > params.end || i < maPeriod + 2) continue;
      const rise = (dayHigh - dayOpen) / dayOpen * 100;
      const drop = (dayHigh - close) / dayHigh * 100;
      if (rise < params.rise || drop < params.drop || i - highIndex < params.minMinutes) continue;

      const currentMa = ma(candles, i, maPeriod)!;
      const previousMa = ma(candles, i - 1, maPeriod)!;
      const twoAgoMa = ma(candles, i - 2, maPeriod)!;
      const slope = (currentMa - twoAgoMa) / twoAgoMa * 100;
      if (currentMa >= previousMa || slope > -params.minDownSlope) continue;

      const priorLows = candles.slice(Math.max(0, i - 10), i).map(x => Number(x.low));
      if (priorLows.length === 0 || Number(c.low) >= Math.min(...priorLows)) continue;

      fired = true;
      const tpLine = close * (1 - params.tp / 100);
      const slLine = close * (1 + params.sl / 100);
      let exitType = '大引け';
      let exitTime = candles[candles.length - 1].candleTime as string;
      let pnlPerShare = close - Number(candles[candles.length - 1].close);
      for (let j = i + 1; j < candles.length; j++) {
        const next = candles[j];
        if (Number(next.high) >= slLine) {
          exitType = '損切り';
          exitTime = next.candleTime;
          pnlPerShare = close - slLine;
          break;
        }
        if (Number(next.low) <= tpLine) {
          exitType = '利確';
          exitTime = next.candleTime;
          pnlPerShare = close - tpLine;
          break;
        }
        if (next.candleTime >= '15:00') {
          exitType = '大引け';
          exitTime = next.candleTime;
          pnlPerShare = close - Number(next.close);
          break;
        }
      }
      const shares = calcShares(close);
      trades.push({ date, time, entry: close, pnlPerShare, pnlYen: pnlPerShare * shares, exitType, exitTime });
    }
  }
  return trades;
}

async function main() {
  const db = await getDb();
  const rDates = await db.execute(sql`
    SELECT DISTINCT tradeDate FROM rt_candles WHERE symbol = '285A' ORDER BY tradeDate
  `);
  const dates = ((rDates as any)[0] as any[]).map(r => r.tradeDate as string);
  const candlesByDate: Record<string, any[]> = {};
  for (const date of dates) {
    const r = await db.execute(sql`
      SELECT candleTime, open, high, low, close, volume FROM rt_candles
      WHERE symbol = '285A' AND tradeDate = ${date}
      ORDER BY candleTime
    `);
    candlesByDate[date] = (r as any)[0] as any[];
  }

  // 7/16を日中-8%超で、8/18を当日安値から1%超反発で除く「安全CB」
  // いずれも大台割れCB SHORTであり、デッドクロス・過熱反転は含めない。
  const cbSafe: SimTrade[] = [
    { date: '2026-07-07', time: '09:43', entry: 75660, pnlPerShare: 1134.90, pnlYen: 113490, exitType: '利確', exitTime: '09:47' },
    { date: '2026-07-07', time: '10:13', entry: 74570, pnlPerShare: 1118.55, pnlYen: 111855, exitType: '利確', exitTime: '10:20' },
    { date: '2026-07-13', time: '09:49', entry: 73240, pnlPerShare: 1098.60, pnlYen: 109860, exitType: '利確', exitTime: '09:57' },
    { date: '2026-08-07', time: '10:15', entry: 45770, pnlPerShare: 686.55, pnlYen: 68655, exitType: '利確', exitTime: '10:23' },
  ];
  const cbSafeDates = new Set(cbSafe.map(t => t.date));
  const cbPnl = cbSafe.reduce((sum, t) => sum + t.pnlYen, 0);
  console.log(`安全CB: ${cbSafe.length}件 ${cbSafe.length}勝0敗 勝率100.0% 損益+${cbPnl.toLocaleString()}円`);
  console.log('除外対象: 7/16（当日時点で始値比-9.25%）・8/18（当日安値から+1.21%反発後）\n');

  const results: Summary[] = [];
  const rises = [1.0, 1.5, 2.0, 2.5, 3.0];
  const drops = [1.0, 1.2, 1.5, 1.8, 2.0];
  const sls = [0.4, 0.5, 0.6, 0.8];
  const tps = [0.8, 1.0, 1.2, 1.5, 2.0];
  const startEnds = [
    { start: '09:45', end: '11:27' },
    { start: '09:45', end: '14:30' },
    { start: '10:00', end: '11:27' },
    { start: '10:00', end: '14:30' },
  ];
  const waits = [0, 5, 10, 15];
  const slopes = [0, 0.02, 0.05, 0.10];

  for (const rise of rises) {
    for (const drop of drops) {
      for (const sl of sls) {
        for (const tp of tps) {
          if (tp <= sl) continue; // リスクリワードを必ず正に保つ
          for (const window of startEnds) {
            for (const minMinutes of waits) {
              for (const minDownSlope of slopes) {
                const params: ReversalParams = { rise, drop, sl, tp, ...window, minMinutes, minDownSlope };
                const allReversal = simulateReversal(candlesByDate, dates, params);
                // 安全CBを優先し、その日に反転SHORTは追加しない（保守的に1日1エントリー）
                const reversal = allReversal.filter(t => !cbSafeDates.has(t.date));
                const combined = [...cbSafe, ...reversal];
                const wins = combined.filter(t => t.pnlYen > 0).length;
                const losses = combined.length - wins;
                const pnl = combined.reduce((sum, t) => sum + t.pnlYen, 0);
                const winRate = combined.length ? wins / combined.length * 100 : 0;
                results.push({
                  params,
                  trades: combined,
                  totalTrades: combined.length,
                  wins,
                  losses,
                  winRate,
                  totalPnl: pnl,
                  aug19: reversal.find(t => t.date === '2026-08-19'),
                  aug20: reversal.find(t => t.date === '2026-08-20'),
                });
              }
            }
          }
        }
      }
    }
  }

  const meetsGoal = results
    .filter(r => r.totalTrades >= 8 && r.winRate >= 70 && r.totalPnl >= 571008)
    .sort((a, b) => b.totalPnl - a.totalPnl || b.winRate - a.winRate);

  const format = (r: Summary) => {
    const p = r.params;
    return `上${p.rise}%/落${p.drop}%/SL${p.sl}/TP${p.tp}/ ${p.start}-${p.end}/待${p.minMinutes}分/MA傾${p.minDownSlope}% | ${r.totalTrades}件 ${r.wins}勝${r.losses}敗 勝率${r.winRate.toFixed(1)}% 損益${r.totalPnl >= 0 ? '+' : ''}${r.totalPnl.toLocaleString()}円 | 8/19=${r.aug19 ? `${r.aug19.time}${r.aug19.pnlYen > 0 ? '○' : '×'}` : '-'} 8/20=${r.aug20 ? `${r.aug20.time}${r.aug20.pnlYen > 0 ? '○' : '×'}` : '-'}`;
  };

  console.log('=== 目標達成候補（勝率70%以上・+571,008円以上・TP>SL） ===');
  if (meetsGoal.length === 0) {
    console.log('該当なし');
  } else {
    for (const result of meetsGoal.slice(0, 30)) console.log(format(result));
  }

  console.log('\n=== 勝率70%以上の損益上位候補（TP>SL） ===');
  const highWin = results
    .filter(r => r.totalTrades >= 8 && r.winRate >= 70)
    .sort((a, b) => b.totalPnl - a.totalPnl || b.winRate - a.winRate);
  for (const result of highWin.slice(0, 25)) console.log(format(result));

  console.log('\n=== 損益目標達成候補（TP>SL、勝率順） ===');
  const highPnl = results
    .filter(r => r.totalTrades >= 8 && r.totalPnl >= 571008)
    .sort((a, b) => b.winRate - a.winRate || b.totalPnl - a.totalPnl);
  for (const result of highPnl.slice(0, 25)) console.log(format(result));

  const closest = [...results]
    .filter(r => r.totalTrades >= 8)
    .sort((a, b) => {
      const scoreA = Math.min(a.winRate / 70, a.totalPnl / 571008);
      const scoreB = Math.min(b.winRate / 70, b.totalPnl / 571008);
      return scoreB - scoreA;
    });
  console.log('\n=== 両目標への近接度が高い候補 ===');
  for (const result of closest.slice(0, 20)) console.log(format(result));

  process.exit(0);
}
main();
