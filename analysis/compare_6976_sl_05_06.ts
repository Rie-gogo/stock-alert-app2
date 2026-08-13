/**
 * 6976 太陽誘電: 実際に記録された直近30営業日のエントリーを固定し、
 * KABU rt_candlesの次足以降でSL 0.5%と0.6%を比較する読み取り専用分析。
 */
import mysql from "mysql2/promise";

const SYMBOL = "6976";
const TP_PCT = 1.5;
const SL_VALUES = [0.5, 0.6] as const;

type TradeRow = {
  tradeDate: string; tradeTime: string; action: string; side: "long" | "short";
  price: string; shares: number | string; pnl: number | string | null; reason: string | null;
};
type Candle = { candleTime: string; high: string; low: string; close: string };
type Simulation = { sl: number; pnl: number; result: "SL" | "TP" | "EOD"; exitTime: string; exitPrice: number };

function simulate(entry: TradeRow, candles: Candle[], sl: number): Simulation {
  const entryPrice = Number(entry.price);
  const shares = Number(entry.shares);
  const isLong = entry.side === "long";
  const start = candles.findIndex(c => c.candleTime === entry.tradeTime);
  const afterEntry = start >= 0 ? candles.slice(start + 1) : [];
  for (const candle of afterEntry) {
    const high = Number(candle.high);
    const low = Number(candle.low);
    const slPrice = isLong ? entryPrice * (1 - sl / 100) : entryPrice * (1 + sl / 100);
    const tpPrice = isLong ? entryPrice * (1 + TP_PCT / 100) : entryPrice * (1 - TP_PCT / 100);
    // 本番エンジンと同じく、同じ1分足で両方に触れた場合はSLを先に判定する。
    if ((isLong && low <= slPrice) || (!isLong && high >= slPrice)) {
      return { sl, result: "SL", exitTime: candle.candleTime, exitPrice: slPrice, pnl: -entryPrice * sl / 100 * shares };
    }
    if ((isLong && high >= tpPrice) || (!isLong && low <= tpPrice)) {
      return { sl, result: "TP", exitTime: candle.candleTime, exitPrice: tpPrice, pnl: entryPrice * TP_PCT / 100 * shares };
    }
  }
  const eod = candles[candles.length - 1];
  const eodPrice = Number(eod.close);
  return {
    sl, result: "EOD", exitTime: eod.candleTime, exitPrice: eodPrice,
    pnl: (isLong ? eodPrice - entryPrice : entryPrice - eodPrice) * shares,
  };
}

function summary(rows: Simulation[]) {
  const total = rows.reduce((sum, r) => sum + r.pnl, 0);
  const wins = rows.filter(r => r.pnl > 0);
  const losses = rows.filter(r => r.pnl <= 0);
  const grossWin = wins.reduce((sum, r) => sum + r.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, r) => sum + r.pnl, 0));
  return {
    count: rows.length, totalPnl: Math.round(total), wins: wins.length, losses: losses.length,
    winRate: rows.length ? wins.length / rows.length * 100 : 0,
    pf: grossLoss ? grossWin / grossLoss : null,
    tp: rows.filter(r => r.result === "TP").length,
    sl: rows.filter(r => r.result === "SL").length,
    eod: rows.filter(r => r.result === "EOD").length,
  };
}

async function main() {
  const conn = await mysql.createConnection(process.env.DATABASE_URL!);
  const [dates] = await conn.query<Array<{ tradeDate: string }>>("SELECT DISTINCT tradeDate FROM rt_candles ORDER BY tradeDate DESC LIMIT 30");
  const oldestDate = dates[dates.length - 1]?.tradeDate;
  if (!oldestDate) throw new Error("rt_candlesの対象期間がありません");
  const [trades] = await conn.query<TradeRow[]>(
    "SELECT tradeDate, tradeTime, action, side, price, shares, pnl, reason FROM rt_trades WHERE symbol = ? AND tradeDate >= ? ORDER BY tradeDate, tradeTime",
    [SYMBOL, oldestDate],
  );
  const opens = new Map<string, TradeRow>();
  const pairs: Array<{ entry: TradeRow; exit: TradeRow }> = [];
  for (const trade of trades) {
    const key = `${trade.tradeDate}_${trade.symbol ?? SYMBOL}_${trade.side}`;
    if (trade.action === "buy" || trade.action === "short") opens.set(key, trade);
    if ((trade.action === "sell" || trade.action === "cover") && opens.has(key)) {
      pairs.push({ entry: opens.get(key)!, exit: trade });
      opens.delete(key);
    }
  }
  const byDate = new Map<string, Candle[]>();
  for (const pair of pairs) {
    if (byDate.has(pair.entry.tradeDate)) continue;
    const [candles] = await conn.query<Candle[]>(
      "SELECT candleTime, high, low, close FROM rt_candles WHERE tradeDate = ? AND symbol = ? ORDER BY candleTime",
      [pair.entry.tradeDate, SYMBOL],
    );
    byDate.set(pair.entry.tradeDate, candles);
  }
  await conn.end();
  const compared = pairs.map(({ entry, exit }) => {
    const candles = byDate.get(entry.tradeDate) ?? [];
    return { entry, actual: exit, s05: simulate(entry, candles, 0.5), s06: simulate(entry, candles, 0.6) };
  });
  const s05 = compared.map(r => r.s05);
  const s06 = compared.map(r => r.s06);
  const changed = compared.filter(r => r.s05.result !== r.s06.result || Math.round(r.s05.pnl) !== Math.round(r.s06.pnl));
  console.log(JSON.stringify({
    period: { from: oldestDate, to: dates[0]?.tradeDate, entryCount: compared.length },
    sl05: summary(s05), sl06: summary(s06),
    difference: Math.round(summary(s06).totalPnl - summary(s05).totalPnl),
    changedTrades: changed.map(r => ({
      tradeDate: r.entry.tradeDate, entryTime: r.entry.tradeTime, side: r.entry.side, entryPrice: Number(r.entry.price), shares: Number(r.entry.shares),
      sl05: r.s05, sl06: r.s06,
    })),
  }, null, 2));
}

main().catch(error => { console.error(error); process.exit(1); });
