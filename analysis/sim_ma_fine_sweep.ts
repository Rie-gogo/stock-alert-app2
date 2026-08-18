/**
 * MA1〜20 + 30, 50, なし の細かいスイープ
 * 大台割れSHORT（isBullish=trueでブロック）で検証
 * 20営業日
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

function getRoundLevels(price: number): number[] {
  const levels: number[] = [];
  if (price >= 100000) { const b = Math.floor(price/1000)*1000; for(let i=-3;i<=3;i++) levels.push(b+i*1000); }
  else if (price >= 10000) { const b = Math.floor(price/500)*500; for(let i=-3;i<=3;i++) levels.push(b+i*500); }
  else if (price >= 5000) { const b = Math.floor(price/200)*200; for(let i=-3;i<=3;i++) levels.push(b+i*200); }
  else if (price >= 2000) { const b = Math.floor(price/100)*100; for(let i=-3;i<=3;i++) levels.push(b+i*100); }
  else { const b = Math.floor(price/50)*50; for(let i=-3;i<=3;i++) levels.push(b+i*50); }
  return levels.filter(l => l > 0);
}

function timeToMin(t: string): number { const [h, m] = t.split(":").map(Number); return h * 60 + m; }

function calcIsBullish(allCloses: number[], maPeriod: number): boolean {
  if (allCloses.length < maPeriod + 1) return false;
  const current = allCloses.slice(allCloses.length - maPeriod);
  const prev = allCloses.slice(allCloses.length - maPeriod - 1, allCloses.length - 1);
  const ma = current.reduce((s, v) => s + v, 0) / maPeriod;
  const prevMa = prev.reduce((s, v) => s + v, 0) / maPeriod;
  return (ma - prevMa) / prevMa * 100 > 0;
}

async function runShortSim(maPeriod: number | null, dates: string[], rawBuffers: Record<string, any[]>) {
  let trades: {pnl: number}[] = [];
  let blocked = 0;

  for (const date of dates) {
    const positions: Record<string, {price: number; shares: number; side: string}> = {};
    const lastSLTime: Record<string, number> = {};

    for (const symbol of SYMBOLS) {
      const allBuf = rawBuffers[symbol];
      if (!allBuf) continue;
      const todayCandles = allBuf.filter((b: any) => b.date === date).map((b: any) => b.c);
      if (todayCandles.length < 25) continue;
      const prevDayCloses = allBuf.filter((b: any) => b.date < date).map((b: any) => b.c.c);

      for (let i = 1; i < todayCandles.length; i++) {
        const candle = todayCandles[i];
        const tMin = timeToMin(candle.t);

        if (candle.t >= "11:27" && candle.t < "11:30" && positions[symbol]) {
          const pos = positions[symbol];
          trades.push({ pnl: Math.round((pos.price - candle.c) * pos.shares) });
          delete positions[symbol]; continue;
        }
        if (candle.t >= "15:25" && positions[symbol]) {
          const pos = positions[symbol];
          trades.push({ pnl: Math.round((pos.price - candle.c) * pos.shares) });
          delete positions[symbol]; continue;
        }
        if (positions[symbol]) {
          const pos = positions[symbol];
          const sl = SL_MAP[symbol]?.short || 0.8;
          const slPrice = pos.price * (1 + sl / 100);
          const tpPrice = pos.price * (1 - TP_PCT / 100);
          if (candle.h >= slPrice) { trades.push({ pnl: Math.round((pos.price - slPrice) * pos.shares) }); lastSLTime[symbol] = tMin; delete positions[symbol]; }
          else if (candle.l <= tpPrice) { trades.push({ pnl: Math.round((pos.price - tpPrice) * pos.shares) }); delete positions[symbol]; }
          continue;
        }
        if (candle.t < "09:30" || candle.t >= "15:05") continue;
        if (candle.t >= "12:30" && candle.t < "12:50") continue;
        if (positions[symbol]) continue;
        if (lastSLTime[symbol] && tMin - lastSLTime[symbol] < NO_REENTRY_MIN) continue;

        if (maPeriod !== null) {
          const allCloses = [...prevDayCloses, ...todayCandles.slice(0, i + 1).map((c: any) => c.c)];
          if (allCloses.length < maPeriod + 1) continue;
          const isBullish = calcIsBullish(allCloses, maPeriod);
          if (isBullish) { blocked++; continue; }
        }

        const prevClose = todayCandles[i-1]?.c;
        if (!prevClose) continue;
        const levels = getRoundLevels(prevClose);
        for (const level of levels) {
          if (prevClose >= level && candle.c < level) {
            const price = candle.c;
            const shares = Math.floor(3000000 / price / 100) * 100 || 100;
            positions[symbol] = { price, shares, side: "short" };
            break;
          }
        }
      }
      if (positions[symbol]) {
        const lastCandle = todayCandles[todayCandles.length - 1];
        const pos = positions[symbol];
        trades.push({ pnl: Math.round((pos.price - lastCandle.c) * pos.shares) });
        delete positions[symbol];
      }
    }
  }
  const wins = trades.filter(t => t.pnl > 0).length;
  const pnl = trades.reduce((s, t) => s + t.pnl, 0);
  const gross = trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const loss = Math.abs(trades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
  const pf = loss > 0 ? (gross / loss).toFixed(2) : "∞";
  return { count: trades.length, wins, pnl, pf, blocked };
}

async function runLongSim(maPeriod: number | null, dates: string[], rawBuffers: Record<string, any[]>) {
  let trades: {pnl: number}[] = [];
  let blocked = 0;

  for (const date of dates) {
    const positions: Record<string, {price: number; shares: number}> = {};
    const lastSLTime: Record<string, number> = {};

    for (const symbol of SYMBOLS) {
      const allBuf = rawBuffers[symbol];
      if (!allBuf) continue;
      const todayCandles = allBuf.filter((b: any) => b.date === date).map((b: any) => b.c);
      if (todayCandles.length < 25) continue;
      const prevDayCloses = allBuf.filter((b: any) => b.date < date).map((b: any) => b.c.c);

      for (let i = 20; i < todayCandles.length; i++) {
        const candle = todayCandles[i];
        const tMin = timeToMin(candle.t);
        if (candle.t >= "11:27" && candle.t < "11:30" && positions[symbol]) {
          const pos = positions[symbol];
          trades.push({ pnl: Math.round((candle.c - pos.price) * pos.shares) });
          delete positions[symbol]; continue;
        }
        if (candle.t >= "15:25" && positions[symbol]) {
          const pos = positions[symbol];
          trades.push({ pnl: Math.round((candle.c - pos.price) * pos.shares) });
          delete positions[symbol]; continue;
        }
        if (positions[symbol]) {
          const pos = positions[symbol];
          const sl = SL_MAP[symbol]?.long || 0.5;
          const slPrice = pos.price * (1 - sl / 100);
          const tpPrice = pos.price * (1 + TP_PCT / 100);
          if (candle.l <= slPrice) { trades.push({ pnl: Math.round((slPrice - pos.price) * pos.shares) }); lastSLTime[symbol] = tMin; delete positions[symbol]; }
          else if (candle.h >= tpPrice) { trades.push({ pnl: Math.round((tpPrice - pos.price) * pos.shares) }); delete positions[symbol]; }
          continue;
        }
        if (candle.t < "09:30" || candle.t >= "15:05") continue;
        if (candle.t >= "12:30" && candle.t < "12:50") continue;
        if (positions[symbol]) continue;
        if (lastSLTime[symbol] && tMin - lastSLTime[symbol] < NO_REENTRY_MIN) continue;

        if (maPeriod !== null) {
          const allCloses = [...prevDayCloses, ...todayCandles.slice(0, i + 1).map((c: any) => c.c)];
          if (allCloses.length < maPeriod + 1) continue;
          const isBullish = calcIsBullish(allCloses, maPeriod);
          if (!isBullish) { blocked++; continue; }
        }

        const recent20 = todayCandles.slice(i - 20, i);
        const maxHigh = Math.max(...recent20.map((c: any) => c.h));
        if (candle.h > maxHigh) {
          const price = candle.c;
          const shares = Math.floor(3000000 / price / 100) * 100 || 100;
          positions[symbol] = { price, shares };
        }
      }
      if (positions[symbol]) {
        const lastCandle = todayCandles[todayCandles.length - 1];
        const pos = positions[symbol];
        trades.push({ pnl: Math.round((lastCandle.c - pos.price) * pos.shares) });
        delete positions[symbol];
      }
    }
  }
  const wins = trades.filter(t => t.pnl > 0).length;
  const pnl = trades.reduce((s, t) => s + t.pnl, 0);
  const gross = trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const loss = Math.abs(trades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
  const pf = loss > 0 ? (gross / loss).toFixed(2) : "∞";
  return { count: trades.length, wins, pnl, pf, blocked };
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

  const periods = [null, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 20, 30, 50];

  console.log(`=== 大台割れSHORT（isBullish=trueでブロック） ===`);
  console.log(`| MA期間 | 件数 | 勝率 | 損益 | PF | ブロック数 |`);
  console.log(`|--------|------|------|------|-----|----------|`);
  for (const p of periods) {
    const r = await runShortSim(p, dates, rawBuffers);
    const label = p === null ? "なし" : `MA${p}`;
    console.log(`| ${label} | ${r.count}件 | ${(r.wins/r.count*100).toFixed(1)}% | ${r.pnl>=0?"+":""}${r.pnl.toLocaleString()}円 | ${r.pf} | ${r.blocked}件 |`);
  }

  console.log(`\n=== ダウ理論LONG（isBullish=trueで許可） ===`);
  console.log(`| MA期間 | 件数 | 勝率 | 損益 | PF | ブロック数 |`);
  console.log(`|--------|------|------|------|-----|----------|`);
  for (const p of periods) {
    const r = await runLongSim(p, dates, rawBuffers);
    const label = p === null ? "なし" : `MA${p}`;
    console.log(`| ${label} | ${r.count}件 | ${(r.wins/r.count*100).toFixed(1)}% | ${r.pnl>=0?"+":""}${r.pnl.toLocaleString()}円 | ${r.pf} | ${r.blocked}件 |`);
  }

  await conn.end();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
