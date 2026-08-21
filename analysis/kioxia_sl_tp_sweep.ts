import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

type Side = 'LONG' | 'SHORT';
type Strategy = '反転LONG' | '安全CB SHORT' | '反転SHORT';

type Candidate = {
  date: string;
  time: string;
  index: number;
  entry: number;
  side: Side;
  strategy: Strategy;
  candles: Candle[];
};

type Candle = {
  candleTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type TradeResult = Candidate & {
  exitTime: string;
  exitReason: 'TP' | 'SL' | '前場強制決済';
  pnl: number;
};

const CAPITAL = 3_000_000;
const LOT_RATIO = 0.9;
const END_OF_AM = '11:27';
const SAFE_CB_ENTRIES: Array<Pick<Candidate, 'date' | 'time' | 'entry'>> = [
  { date: '2026-07-07', time: '09:43', entry: 75660 },
  { date: '2026-07-07', time: '10:13', entry: 74570 },
  { date: '2026-07-13', time: '09:49', entry: 73240 },
  { date: '2026-08-07', time: '10:15', entry: 45770 },
];

function shares(price: number): number {
  const raw = Math.floor((CAPITAL * LOT_RATIO) / price);
  return Math.max(100, Math.floor(raw / 100) * 100);
}

function sma(candles: Candle[], index: number, period: number): number | null {
  if (index - period + 1 < 0) return null;
  return candles
    .slice(index - period + 1, index + 1)
    .reduce((total, candle) => total + candle.close, 0) / period;
}

/**
 * 本番エンジンと同じく、同一足でSL/TP双方に触れた場合はSLを先に判定する。
 * 前場11:27は決済足として扱い、その足の高安値でSL/TPを先に判定する。
 */
function simulateExit(candidate: Candidate, slPct: number, tpPct: number): TradeResult {
  const size = shares(candidate.entry);
  const stopLine = candidate.side === 'LONG'
    ? candidate.entry * (1 - slPct / 100)
    : candidate.entry * (1 + slPct / 100);
  const takeProfitLine = candidate.side === 'LONG'
    ? candidate.entry * (1 + tpPct / 100)
    : candidate.entry * (1 - tpPct / 100);

  for (let j = candidate.index + 1; j < candidate.candles.length; j++) {
    const candle = candidate.candles[j];
    const stopped = candidate.side === 'LONG'
      ? candle.low <= stopLine
      : candle.high >= stopLine;
    if (stopped) {
      const pnl = candidate.side === 'LONG'
        ? (stopLine - candidate.entry) * size
        : (candidate.entry - stopLine) * size;
      return { ...candidate, exitTime: candle.candleTime, exitReason: 'SL', pnl };
    }

    const profited = candidate.side === 'LONG'
      ? candle.high >= takeProfitLine
      : candle.low <= takeProfitLine;
    if (profited) {
      const pnl = candidate.side === 'LONG'
        ? (takeProfitLine - candidate.entry) * size
        : (candidate.entry - takeProfitLine) * size;
      return { ...candidate, exitTime: candle.candleTime, exitReason: 'TP', pnl };
    }

    if (candle.candleTime >= END_OF_AM) {
      const pnl = candidate.side === 'LONG'
        ? (candle.close - candidate.entry) * size
        : (candidate.entry - candle.close) * size;
      return { ...candidate, exitTime: candle.candleTime, exitReason: '前場強制決済', pnl };
    }
  }

  const last = candidate.candles[candidate.candles.length - 1];
  const pnl = candidate.side === 'LONG'
    ? (last.close - candidate.entry) * size
    : (candidate.entry - last.close) * size;
  return { ...candidate, exitTime: last.candleTime, exitReason: '前場強制決済', pnl };
}

function summarise(candidates: Candidate[], sl: number, tp: number) {
  const trades = candidates.map(candidate => simulateExit(candidate, sl, tp));
  const wins = trades.filter(trade => trade.pnl > 0).length;
  const pnl = trades.reduce((total, trade) => total + trade.pnl, 0);
  const grossProfit = trades.filter(trade => trade.pnl > 0).reduce((total, trade) => total + trade.pnl, 0);
  const grossLoss = Math.abs(trades.filter(trade => trade.pnl < 0).reduce((total, trade) => total + trade.pnl, 0));
  const splitDate = '2026-07-22';
  const laterTrades = trades.filter(trade => trade.date > splitDate);
  const laterWins = laterTrades.filter(trade => trade.pnl > 0).length;
  const laterPnl = laterTrades.reduce((total, trade) => total + trade.pnl, 0);
  return {
    sl,
    tp,
    rr: tp / sl,
    count: trades.length,
    wins,
    winRate: trades.length ? wins / trades.length * 100 : 0,
    pnl,
    pf: grossLoss ? grossProfit / grossLoss : Number.POSITIVE_INFINITY,
    tpCount: trades.filter(trade => trade.exitReason === 'TP').length,
    slCount: trades.filter(trade => trade.exitReason === 'SL').length,
    amCloseCount: trades.filter(trade => trade.exitReason === '前場強制決済').length,
    laterCount: laterTrades.length,
    laterWins,
    laterWinRate: laterTrades.length ? laterWins / laterTrades.length * 100 : 0,
    laterPnl,
  };
}

function format(result: ReturnType<typeof summarise>): string {
  const pf = Number.isFinite(result.pf) ? result.pf.toFixed(2) : '∞';
  return [
    `SL${result.sl.toFixed(1)}%/TP${result.tp.toFixed(1)}%`,
    `RR1:${result.rr.toFixed(2)}`,
    `${result.count}件 ${result.wins}勝${result.count - result.wins}敗`,
    `勝率${result.winRate.toFixed(1)}%`,
    `損益${result.pnl >= 0 ? '+' : ''}${Math.round(result.pnl).toLocaleString()}円`,
    `PF${pf}`,
    `TP/SL/前場=${result.tpCount}/${result.slCount}/${result.amCloseCount}`,
    `後半${result.laterCount}件 ${result.laterWins}勝${result.laterCount - result.laterWins}敗 ${result.laterWinRate.toFixed(1)}% ${result.laterPnl >= 0 ? '+' : ''}${Math.round(result.laterPnl).toLocaleString()}円`,
  ].join(' | ');
}

function summariseIntegrated(
  label: string,
  longs: Candidate[],
  safeCbs: Candidate[],
  reversals: Candidate[],
  config: { long: [number, number]; cb: [number, number]; reversal: [number, number] },
): void {
  const simulated = [
    ...longs.map(candidate => simulateExit(candidate, config.long[0], config.long[1])),
    ...safeCbs.map(candidate => simulateExit(candidate, config.cb[0], config.cb[1])),
    ...reversals.map(candidate => simulateExit(candidate, config.reversal[0], config.reversal[1])),
  ].sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));

  const accepted: TradeResult[] = [];
  for (const date of [...new Set(simulated.map(trade => trade.date))]) {
    const dayTrades = simulated.filter(trade => trade.date === date);
    let active: TradeResult | null = null;
    for (const trade of dayTrades) {
      if (active && trade.time <= active.exitTime) continue;
      accepted.push(trade);
      active = trade;
    }
  }
  const wins = accepted.filter(trade => trade.pnl > 0).length;
  const pnl = accepted.reduce((total, trade) => total + trade.pnl, 0);
  const later = accepted.filter(trade => trade.date > '2026-07-22');
  const laterWins = later.filter(trade => trade.pnl > 0).length;
  const laterPnl = later.reduce((total, trade) => total + trade.pnl, 0);
  console.log(`${label}: ${accepted.length}件 ${wins}勝${accepted.length - wins}敗 勝率${(wins / accepted.length * 100).toFixed(1)}% 損益${pnl >= 0 ? '+' : ''}${Math.round(pnl).toLocaleString()}円 | 後半${later.length}件 ${laterWins}勝${later.length - laterWins}敗 勝率${(laterWins / later.length * 100).toFixed(1)}% 損益${laterPnl >= 0 ? '+' : ''}${Math.round(laterPnl).toLocaleString()}円`);
}

async function buildCandidates(candlesByDate: Record<string, Candle[]>): Promise<{ longs: Candidate[]; safeCbs: Candidate[]; reversals: Candidate[] }> {
  const longs: Candidate[] = [];
  const reversals: Candidate[] = [];
  const safeCbs: Candidate[] = [];

  for (const entry of SAFE_CB_ENTRIES) {
    const candles = candlesByDate[entry.date];
    const index = candles.findIndex(candle => candle.candleTime === entry.time);
    if (index >= 0) safeCbs.push({ ...entry, index, side: 'SHORT', strategy: '安全CB SHORT', candles });
  }

  for (const [date, candles] of Object.entries(candlesByDate)) {
    if (candles.length < 12) continue;
    const dayOpen = candles[0].open;
    let dayHigh = 0;
    let longFired = false;
    let shortFired = false;

    for (let i = 0; i < candles.length; i++) {
      const candle = candles[i];
      if (candle.high > dayHigh) dayHigh = candle.high;
      if (candle.candleTime < '09:45' || candle.candleTime > END_OF_AM || i < 10) continue;

      if (!longFired) {
        const longMa = sma(candles, i, 8);
        const longMaTwoAgo = sma(candles, i - 2, 8);
        const declinedFromHigh = (dayHigh - candle.close) / dayHigh * 100;
        const recentHigh = Math.max(...candles.slice(Math.max(0, i - 10), i).map(previous => previous.high));
        const slope = longMa && longMaTwoAgo ? (longMa - longMaTwoAgo) / longMaTwoAgo * 100 : -Infinity;
        if (declinedFromHigh >= 2.5 && slope >= 0.02 && candle.high > recentHigh) {
          longFired = true;
          longs.push({ date, time: candle.candleTime, index: i, entry: candle.close, side: 'LONG', strategy: '反転LONG', candles });
        }
      }

      if (!shortFired) {
        const shortMa = sma(candles, i, 8);
        const shortMaPrevious = sma(candles, i - 1, 8);
        const riseFromOpen = (dayHigh - dayOpen) / dayOpen * 100;
        const declinedFromHigh = (dayHigh - candle.close) / dayHigh * 100;
        const recentLow = Math.min(...candles.slice(Math.max(0, i - 10), i).map(previous => previous.low));
        if (riseFromOpen >= 3.0 && declinedFromHigh >= 1.5 && shortMa !== null && shortMaPrevious !== null && shortMa < shortMaPrevious && candle.low < recentLow) {
          shortFired = true;
          reversals.push({ date, time: candle.candleTime, index: i, entry: candle.close, side: 'SHORT', strategy: '反転SHORT', candles });
        }
      }
    }
  }
  return { longs, safeCbs, reversals };
}

async function main() {
  const db = await getDb();
  const dateRows = await db.execute(sql`SELECT DISTINCT tradeDate FROM rt_candles WHERE symbol = '285A' ORDER BY tradeDate`);
  const dates = ((dateRows as any)[0] as Array<{ tradeDate: string }>).map(row => row.tradeDate);
  const candlesByDate: Record<string, Candle[]> = {};
  for (const date of dates) {
    const rows = await db.execute(sql`
      SELECT candleTime, open, high, low, close, volume FROM rt_candles
      WHERE symbol = '285A' AND tradeDate = ${date}
      ORDER BY candleTime
    `);
    candlesByDate[date] = ((rows as any)[0] as any[]).map(row => ({
      candleTime: row.candleTime,
      open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: Number(row.volume),
    }));
  }

  const { longs, safeCbs, reversals } = await buildCandidates(candlesByDate);
  console.log(`対象: KABUステーション285A 1分足 ${dates[0]}〜${dates[dates.length - 1]}（${dates.length}営業日）`);
  console.log(`候補数: 反転LONG ${longs.length}件 / 安全CB SHORT ${safeCbs.length}件 / 反転SHORT ${reversals.length}件`);

  const longSl = [0.4, 0.5, 0.6, 0.7, 0.8, 1.0];
  const longTp = [0.5, 0.6, 0.8, 1.0, 1.2, 1.5];
  const shortSl = [0.4, 0.5, 0.6, 0.7, 0.8, 1.0];
  const shortTp = [0.8, 1.0, 1.2, 1.5, 1.8, 2.0];

  const longResults = longSl.flatMap(sl => longTp.filter(tp => tp >= sl).map(tp => summarise(longs, sl, tp)));
  const cbResults = shortSl.flatMap(sl => shortTp.filter(tp => tp > sl).map(tp => summarise(safeCbs, sl, tp)));
  const reversalResults = shortSl.flatMap(sl => shortTp.filter(tp => tp > sl).map(tp => summarise(reversals, sl, tp)));

  const byPnl = (a: ReturnType<typeof summarise>, b: ReturnType<typeof summarise>) => b.pnl - a.pnl || b.winRate - a.winRate;
  const byWinRate = (a: ReturnType<typeof summarise>, b: ReturnType<typeof summarise>) => b.winRate - a.winRate || b.pnl - a.pnl;

  console.log('\n=== LONG: 現行 SL0.6%/TP0.8% ===');
  console.log(format(summarise(longs, 0.6, 0.8)));
  console.log('\n=== LONG: 損益上位5（TP>=SL） ===');
  longResults.sort(byPnl).slice(0, 5).forEach(result => console.log(format(result)));
  console.log('\n=== LONG: 勝率上位5（TP>=SL） ===');
  longResults.sort(byWinRate).slice(0, 5).forEach(result => console.log(format(result)));

  console.log('\n=== 安全CB SHORT: 現行 SL0.6%/TP1.5% ===');
  console.log(format(summarise(safeCbs, 0.6, 1.5)));
  console.log('\n=== 安全CB SHORT: 損益上位5（TP>SL） ===');
  cbResults.sort(byPnl).slice(0, 5).forEach(result => console.log(format(result)));
  console.log('\n=== 安全CB SHORT: 勝率上位5（TP>SL） ===');
  cbResults.sort(byWinRate).slice(0, 5).forEach(result => console.log(format(result)));

  console.log('\n=== 反転SHORT: 現行 SL0.8%/TP1.5% ===');
  console.log(format(summarise(reversals, 0.8, 1.5)));
  console.log('\n=== 反転SHORT: 損益上位5（TP>SL） ===');
  reversalResults.sort(byPnl).slice(0, 5).forEach(result => console.log(format(result)));
  console.log('\n=== 反転SHORT: 勝率上位5（TP>SL） ===');
  reversalResults.sort(byWinRate).slice(0, 5).forEach(result => console.log(format(result)));

  console.log('\n=== LONG・SHORT統合（時刻順・1ポジション制御） ===');
  summariseIntegrated('現行 LONG0.6/0.8・CB0.6/1.5・反転SHORT0.8/1.5', longs, safeCbs, reversals, {
    long: [0.6, 0.8], cb: [0.6, 1.5], reversal: [0.8, 1.5],
  });
  summariseIntegrated('推奨候補 LONG0.6/0.8・CB0.6/1.5・反転SHORT0.8/1.2', longs, safeCbs, reversals, {
    long: [0.6, 0.8], cb: [0.6, 1.5], reversal: [0.8, 1.2],
  });
  summariseIntegrated('候補 LONG0.7/0.8・CB0.6/1.5・反転SHORT0.8/1.2', longs, safeCbs, reversals, {
    long: [0.7, 0.8], cb: [0.6, 1.5], reversal: [0.8, 1.2],
  });

  const latestFiveDates = dates.slice(-5);
  const latestFiveCandidates = [
    ...longs.map(candidate => simulateExit(candidate, 0.6, 0.8)),
    ...safeCbs.map(candidate => simulateExit(candidate, 0.6, 1.5)),
    ...reversals.map(candidate => simulateExit(candidate, 0.8, 1.2)),
  ].filter(trade => latestFiveDates.includes(trade.date))
    .sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
  const latestFiveAccepted: TradeResult[] = [];
  for (const date of latestFiveDates) {
    let active: TradeResult | null = null;
    for (const trade of latestFiveCandidates.filter(item => item.date === date)) {
      if (active && trade.time <= active.exitTime) continue;
      latestFiveAccepted.push(trade);
      active = trade;
    }
  }
  console.log(`\n=== 直近5営業日: ${latestFiveDates.join(', ')} ===`);
  for (const date of latestFiveDates) {
    const daily = latestFiveAccepted.filter(trade => trade.date === date);
    const dailyPnl = daily.reduce((total, trade) => total + trade.pnl, 0);
    console.log(`${date}: ${daily.length}件 ${dailyPnl >= 0 ? '+' : ''}${Math.round(dailyPnl).toLocaleString()}円`);
    daily.forEach(trade => console.log(`  ${trade.time} ${trade.strategy} ${trade.side} @${trade.entry.toLocaleString()} → ${trade.exitTime} ${trade.exitReason} ${trade.pnl >= 0 ? '+' : ''}${Math.round(trade.pnl).toLocaleString()}円`));
  }
  const fivePnl = latestFiveAccepted.reduce((total, trade) => total + trade.pnl, 0);
  const fiveWins = latestFiveAccepted.filter(trade => trade.pnl > 0).length;
  console.log(`直近5営業日合計: ${latestFiveAccepted.length}件 ${fiveWins}勝${latestFiveAccepted.length - fiveWins}敗 勝率${latestFiveAccepted.length ? (fiveWins / latestFiveAccepted.length * 100).toFixed(1) : '0'}% ${fivePnl >= 0 ? '+' : ''}${Math.round(fivePnl).toLocaleString()}円`);
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
