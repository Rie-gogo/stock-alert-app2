/**
 * 大台割れ(即vol)のみ: MA期間別の最適値検証（20営業日）
 * 出来高1.5倍で即エントリーするSHORTについて、isBullishブロックのMA期間を変えた場合の比較
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
const FAST_ENTRY_VOL_RATIO = 1.5;
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

async function runSim(maPeriod: number | null, label: string, dates: string[], rawBuffers: Record<string, any[]>) {
  let trades: {date:string; time:string; symbol:string; pnl:number; result:string}[] = [];

  for (const date of dates) {
    const positions: Record<string, {price: number; shares: number; entryTime: string}> = {};
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

        // 前場強制決済
        if (candle.t >= "11:27" && candle.t < "11:30" && positions[symbol]) {
          const pos = positions[symbol];
          const pnl = Math.round((pos.price - candle.c) * pos.shares);
          trades.push({ date, time: pos.entryTime, symbol, pnl, result: "前場決済" });
          delete positions[symbol]; continue;
        }
        // 大引け強制決済
        if (candle.t >= "15:25" && positions[symbol]) {
          const pos = positions[symbol];
          const pnl = Math.round((pos.price - candle.c) * pos.shares);
          trades.push({ date, time: pos.entryTime, symbol, pnl, result: "大引け" });
          delete positions[symbol]; continue;
        }

        // ポジション保有中: SL/TP
        if (positions[symbol]) {
          const pos = positions[symbol];
          const sl = SL_MAP[symbol]?.short || 0.8;
          const slPrice = pos.price * (1 + sl / 100);
          const tpPrice = pos.price * (1 - TP_PCT / 100);
          if (candle.h >= slPrice) { trades.push({ date, time: pos.entryTime, symbol, pnl: Math.round((pos.price - slPrice) * pos.shares), result: "SL" }); lastSLTime[symbol] = tMin; delete positions[symbol]; }
          else if (candle.l <= tpPrice) { trades.push({ date, time: pos.entryTime, symbol, pnl: Math.round((pos.price - tpPrice) * pos.shares), result: "TP" }); delete positions[symbol]; }
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
          if (isBullish) continue; // isBullish=trueならSHORTブロック
        }

        // 大台割れ検出 + 出来高1.5倍のみ
        const prevClose = todayCandles[i-1]?.c;
        if (!prevClose) continue;
        const levels = getRoundLevels(prevClose);
        for (const level of levels) {
          if (prevClose >= level && candle.c < level) {
            const volSlice = todayCandles.slice(Math.max(0, i - 20), i).map((c: any) => c.v);
            const avgVol = volSlice.length > 0 ? volSlice.reduce((s: number, v: number) => s + v, 0) / volSlice.length : 0;
            const volRatio = avgVol > 0 ? candle.v / avgVol : 0;
            if (volRatio >= FAST_ENTRY_VOL_RATIO) {
              const price = candle.c;
              const shares = Math.floor(3000000 / price / 100) * 100 || 100;
              positions[symbol] = { price, shares, entryTime: candle.t };
            }
            break;
          }
        }
      }

      // 日末残ポジション
      if (positions[symbol]) {
        const lastCandle = todayCandles[todayCandles.length - 1];
        const pos = positions[symbol];
        const pnl = Math.round((pos.price - lastCandle.c) * pos.shares);
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

  // ブロックされた取引数を計算
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
