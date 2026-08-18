/**
 * 逆三尊LONGのみ: MA期間別の最適値検証（20営業日）
 * isBullish=trueの時のみ逆三尊LONGを許可する前提で、MA期間を変えた場合の成績比較
 */
import mysql from "mysql2/promise";
const DATABASE_URL = process.env.DATABASE_URL!;
const TP_PCT = 1.5;
const SL_MAP: Record<string, {long: number; short: number}> = {
  "8035": {long:0.5, short:0.8}, "6857": {long:0.6, short:0.6}, "6976": {long:0.6, short:0.8},
  "6526": {long:0.9, short:1.0}, "5803": {long:0.5, short:0.6}, "6981": {long:0.4, short:0.9},
  "285A": {long:0.8, short:0.6}, "6146": {long:0.8, short:0.8}, "6594": {long:0.5, short:0.5},
  "8316": {long:0.5, short:0.5},
};
const SYMBOLS = ["8035","6857","6976","6526","5803","6981","285A","6146","6594","8316"];
const NO_REENTRY_MIN = 30;

function timeToMin(t: string): number { const [h, m] = t.split(":").map(Number); return h * 60 + m; }

function calcIsBullish(allCloses: number[], maPeriod: number): boolean {
  if (allCloses.length < maPeriod + 1) return false;
  const current = allCloses.slice(allCloses.length - maPeriod);
  const prev = allCloses.slice(allCloses.length - maPeriod - 1, allCloses.length - 1);
  const ma = current.reduce((s, v) => s + v, 0) / maPeriod;
  const prevMa = prev.reduce((s, v) => s + v, 0) / maPeriod;
  return (ma - prevMa) / prevMa * 100 > 0;
}

async function runSim(maPeriod: number | null, label: string, dates: string[], rawBuffers: Record<string, any[]>) {
  let trades: {date:string; time:string; symbol:string; pnl:number; result:string}[] = [];

  for (const date of dates) {
    const positions: Record<string, {price: number; shares: number; entryTime: string}> = {};
    const lastSLTime: Record<string, number> = {};

    for (const symbol of SYMBOLS) {
      const allBuf = rawBuffers[symbol];
      if (!allBuf) continue;
      const todayCandles = allBuf.filter((b: any) => b.date === date).map((b: any) => b.c);
      if (todayCandles.length < 35) continue;
      const prevDayCloses = allBuf.filter((b: any) => b.date < date).map((b: any) => b.c.c);

      for (let i = 30; i < todayCandles.length; i++) {
        const candle = todayCandles[i];
        const tMin = timeToMin(candle.t);

        // 前場強制決済
        if (candle.t >= "11:27" && candle.t < "11:30" && positions[symbol]) {
          const pos = positions[symbol];
          const pnl = Math.round((candle.c - pos.price) * pos.shares);
          trades.push({ date, time: pos.entryTime, symbol, pnl, result: "前場決済" });
          delete positions[symbol]; continue;
        }
        // 大引け強制決済
        if (candle.t >= "15:25" && positions[symbol]) {
          const pos = positions[symbol];
          const pnl = Math.round((candle.c - pos.price) * pos.shares);
          trades.push({ date, time: pos.entryTime, symbol, pnl, result: "大引け" });
          delete positions[symbol]; continue;
        }

        // ポジション保有中: SL/TP
        if (positions[symbol]) {
          const pos = positions[symbol];
          const sl = SL_MAP[symbol]?.long || 0.5;
          const slPrice = pos.price * (1 - sl / 100);
          const tpPrice = pos.price * (1 + TP_PCT / 100);
          if (candle.l <= slPrice) { trades.push({ date, time: pos.entryTime, symbol, pnl: Math.round((slPrice - pos.price) * pos.shares), result: "SL" }); lastSLTime[symbol] = tMin; delete positions[symbol]; }
          else if (candle.h >= tpPrice) { trades.push({ date, time: pos.entryTime, symbol, pnl: Math.round((tpPrice - pos.price) * pos.shares), result: "TP" }); delete positions[symbol]; }
          continue;
        }

        // エントリー判定
        if (candle.t < "09:30" || candle.t >= "15:05") continue;
        if (candle.t >= "12:30" && candle.t < "12:50") continue;
        if (positions[symbol]) continue;
        if (lastSLTime[symbol] && tMin - lastSLTime[symbol] < NO_REENTRY_MIN) continue;

        // isBullish判定
        if (maPeriod !== null) {
          const allCloses = [...prevDayCloses, ...todayCandles.slice(0, i + 1).map((c: any) => c.c)];
          if (allCloses.length < maPeriod + 1) continue;
          const isBullish = calcIsBullish(allCloses, maPeriod);
          if (!isBullish) continue;
        }

        // 逆三尊LONG検出
        const seg1 = todayCandles.slice(i - 30, i - 20);
        const seg2 = todayCandles.slice(i - 20, i - 10);
        const seg3 = todayCandles.slice(i - 10, i);
        const low1 = Math.min(...seg1.map((c: any) => c.l));
        const low2 = Math.min(...seg2.map((c: any) => c.l));
        const low3 = Math.min(...seg3.map((c: any) => c.l));
        if (low2 < low1 && low3 > low2 && candle.c > candle.o) {
          const price = candle.c;
          const shares = Math.floor(3000000 / price / 100) * 100 || 100;
          positions[symbol] = { price, shares, entryTime: candle.t };
        }
      }

      // 日末残ポジション
      if (positions[symbol]) {
        const lastCandle = todayCandles[todayCandles.length - 1];
        const pos = positions[symbol];
        const pnl = Math.round((lastCandle.c - pos.price) * pos.shares);
        trades.push({ date, time: pos.entryTime, symbol, pnl, result: "EOD" });
        delete positions[symbol];
      }
    }
  }

  const wins = trades.filter(t => t.pnl > 0).length;
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const gross = trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const loss = Math.abs(trades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
  const pf = loss > 0 ? (gross / loss).toFixed(2) : "∞";
  return { label, count: trades.length, wins, pnl: totalPnl, pf, wr: (wins/trades.length*100).toFixed(1) };
}

async function main() {
  const conn = await mysql.createConnection(DATABASE_URL);
  
  const [dateRows] = await conn.query(`
    SELECT DISTINCT tradeDate FROM rt_candles WHERE symbol = '8035' AND tradeDate <= '2026-08-18'
    ORDER BY tradeDate DESC LIMIT 22
  `) as any[];
  const allDates = (dateRows as any[]).map((r: any) => r.tradeDate).reverse();
  const dates = allDates.slice(2);
  console.log(`対象期間: ${dates[0]} 〜 ${dates[dates.length-1]} (${dates.length}営業日)\n`);

  const [allRows] = await conn.query(`
    SELECT tradeDate, symbol, candleTime as t, open as o, high as h, low as l, close as c, volume as v
    FROM rt_candles WHERE tradeDate IN (${allDates.map((d: string) => `'${d}'`).join(',')})
      AND symbol IN (${SYMBOLS.map(s => `'${s}'`).join(',')})
    ORDER BY symbol, tradeDate, candleTime
  `) as any[];

  const rawBuffers: Record<string, any[]> = {};
  for (const r of allRows as any[]) {
    if (!rawBuffers[r.symbol]) rawBuffers[r.symbol] = [];
    rawBuffers[r.symbol].push({ date: String(r.tradeDate), c: { t: r.t, o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c), v: Number(r.v) } });
  }

  const patterns: [number | null, string][] = [
    [null, "isBullishなし（全許可）"],
    [5, "MA5"],
    [10, "MA10"],
    [15, "MA15"],
    [20, "MA20（現行）"],
    [30, "MA30"],
    [50, "MA50"],
  ];

  console.log(`| MA期間 | 件数 | 勝率 | 損益 | PF |`);
  console.log(`|--------|------|------|------|-----|`);
  for (const [ma, label] of patterns) {
    const r = await runSim(ma, label, dates, rawBuffers);
    console.log(`| ${label} | ${r.count}件 | ${r.wr}% | ${r.pnl>=0?"+":""}${r.pnl.toLocaleString()}円 | ${r.pf} |`);
  }

  await conn.end();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
