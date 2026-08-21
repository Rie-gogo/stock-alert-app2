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

type Side = 'LONG' | 'SHORT';
type Trade = {
  time: string;
  type: '反転LONG' | '反転SHORT' | '安全CB SHORT';
  side: Side;
  entry: number;
  exitTime: string;
  exitReason: '利確' | '損切り' | '前場強制決済';
  pnl: number;
};

const CAPITAL = 3_000_000;
const LOT_RATIO = 0.9;
const FORCE_EXIT_TIME = '11:27';

function shares(price: number) {
  const raw = Math.floor(CAPITAL * LOT_RATIO / price);
  return Math.max(100, Math.floor(raw / 100) * 100);
}

function sma(candles: Candle[], index: number, period: number) {
  if (index - period + 1 < 0) return null;
  return candles.slice(index - period + 1, index + 1).reduce((sum, candle) => sum + candle.close, 0) / period;
}

function simulateExit(candles: Candle[], entryIndex: number, entry: number, side: Side, slPct: number, tpPct: number): Omit<Trade, 'time' | 'type' | 'side' | 'entry'> {
  const size = shares(entry);
  const stopLine = side === 'LONG' ? entry * (1 - slPct / 100) : entry * (1 + slPct / 100);
  const targetLine = side === 'LONG' ? entry * (1 + tpPct / 100) : entry * (1 - tpPct / 100);
  for (let i = entryIndex + 1; i < candles.length; i++) {
    const candle = candles[i];
    const stopped = side === 'LONG' ? candle.low <= stopLine : candle.high >= stopLine;
    if (stopped) return { exitTime: candle.candleTime, exitReason: '損切り', pnl: (side === 'LONG' ? stopLine - entry : entry - stopLine) * size };
    const profited = side === 'LONG' ? candle.high >= targetLine : candle.low <= targetLine;
    if (profited) return { exitTime: candle.candleTime, exitReason: '利確', pnl: (side === 'LONG' ? targetLine - entry : entry - targetLine) * size };
    if (candle.candleTime >= FORCE_EXIT_TIME) return { exitTime: candle.candleTime, exitReason: '前場強制決済', pnl: (side === 'LONG' ? candle.close - entry : entry - candle.close) * size };
  }
  const last = candles[candles.length - 1];
  return { exitTime: last.candleTime, exitReason: '前場強制決済', pnl: (side === 'LONG' ? last.close - entry : entry - last.close) * size };
}

async function main() {
  const db = await getDb();
  const dateQuery = await db.execute(sql`SELECT MAX(tradeDate) AS tradeDate FROM rt_candles WHERE symbol = '285A'`);
  const tradeDate = String(((dateQuery as any)[0] as any[])[0]?.tradeDate ?? '');
  if (!tradeDate) throw new Error('285Aの受信済み1分足がありません。');

  const candleQuery = await db.execute(sql`
    SELECT candleTime, open, high, low, close, volume FROM rt_candles
    WHERE symbol = '285A' AND tradeDate = ${tradeDate}
    ORDER BY candleTime
  `);
  const candles = ((candleQuery as any)[0] as any[]).map(row => ({
    candleTime: String(row.candleTime),
    open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: Number(row.volume),
  })) as Candle[];
  if (candles.length < 12) throw new Error(`${tradeDate}の1分足が不足しています（${candles.length}本）。`);

  const candidates: Trade[] = [];
  let dayHigh = 0;
  let longFired = false;
  let shortFired = false;
  const dayOpen = candles[0].open;

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    if (candle.high > dayHigh) dayHigh = candle.high;
    if (candle.candleTime < '09:45' || candle.candleTime > FORCE_EXIT_TIME || i < 10) continue;

    if (!longFired) {
      const nowMa = sma(candles, i, 8);
      const twoAgoMa = sma(candles, i - 2, 8);
      const decline = (dayHigh - candle.close) / dayHigh * 100;
      const recentHigh = Math.max(...candles.slice(Math.max(0, i - 10), i).map(previous => previous.high));
      const slope = nowMa && twoAgoMa ? (nowMa - twoAgoMa) / twoAgoMa * 100 : -Infinity;
      if (decline >= 2.5 && slope >= 0.02 && candle.high > recentHigh) {
        longFired = true;
        candidates.push({
          time: candle.candleTime, type: '反転LONG', side: 'LONG', entry: candle.close,
          ...simulateExit(candles, i, candle.close, 'LONG', 0.6, 0.8),
        });
      }
    }

    if (!shortFired) {
      const nowMa = sma(candles, i, 8);
      const prevMa = sma(candles, i - 1, 8);
      const rise = (dayHigh - dayOpen) / dayOpen * 100;
      const decline = (dayHigh - candle.close) / dayHigh * 100;
      const recentLow = Math.min(...candles.slice(Math.max(0, i - 10), i).map(previous => previous.low));
      if (rise >= 3.0 && decline >= 1.5 && nowMa !== null && prevMa !== null && nowMa < prevMa && candle.low < recentLow) {
        shortFired = true;
        candidates.push({
          time: candle.candleTime, type: '反転SHORT', side: 'SHORT', entry: candle.close,
          ...simulateExit(candles, i, candle.close, 'SHORT', 0.8, 1.2),
        });
      }
    }
  }

  // 本番に記録済みの大台割れSHORTだけを、同日CB候補の参照情報として併記する。
  const existingCbQuery = await db.execute(sql`
    SELECT * FROM rt_trades
    WHERE symbol = '285A' AND tradeDate = ${tradeDate} AND action = 'short' AND reason LIKE '%大台割れ%'
    ORDER BY tradeTime
  `);
  const existingCb = (existingCbQuery as any)[0] as Array<Record<string, unknown>>;

  const accepted: Trade[] = [];
  for (const candidate of candidates.sort((a, b) => a.time.localeCompare(b.time))) {
    const active = accepted.at(-1);
    if (!active || candidate.time > active.exitTime) accepted.push(candidate);
  }
  const pnl = accepted.reduce((sum, trade) => sum + trade.pnl, 0);
  const dayHighCandle = candles.reduce((best, candle) => candle.high > best.high ? candle : best, candles[0]);
  const dayLowCandle = candles.reduce((best, candle) => candle.low < best.low ? candle : best, candles[0]);

  console.log(`対象日: ${tradeDate}`);
  console.log(`受信足: ${candles.length}本 (${candles[0].candleTime}〜${candles.at(-1)!.candleTime})`);
  console.log(`始値: ${dayOpen.toLocaleString()}円 / 高値: ${dayHighCandle.high.toLocaleString()}円(${dayHighCandle.candleTime}) / 安値: ${dayLowCandle.low.toLocaleString()}円(${dayLowCandle.candleTime}) / 終値: ${candles.at(-1)!.close.toLocaleString()}円`);
  console.log(`\n現行285A専用ロジック候補: ${candidates.length}件、競合調整後: ${accepted.length}件、損益: ${pnl >= 0 ? '+' : ''}${Math.round(pnl).toLocaleString()}円`);
  for (const trade of accepted) {
    console.log(`${trade.time} ${trade.type} ${trade.side} @${trade.entry.toLocaleString()} → ${trade.exitTime} ${trade.exitReason} ${trade.pnl >= 0 ? '+' : ''}${Math.round(trade.pnl).toLocaleString()}円`);
  }
  if (!accepted.length) console.log('現行の反転LONG・反転SHORT条件を満たす候補はありません。');
  console.log(`\n記録済み大台割れSHORT: ${existingCb.length}件`);
  existingCb.forEach(row => {
    const time = String(row.tradeTime ?? row.trade_time ?? '時刻不明');
    const price = Number(row.entryPrice ?? row.entry_price ?? 0);
    console.log(`${time} @${price.toLocaleString()} ${String(row.reason ?? '')}`);
  });
  console.log('\n注記: 反転LONG・反転SHORTは1分足で再現。大台割れCBは板読み・既存ステートを伴うため、本日のDBに記録済みのエントリーだけを参照表示。');
}

main().then(() => process.exit(0)).catch(error => {
  console.error(error);
  process.exit(1);
});
