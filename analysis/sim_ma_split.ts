/**
 * ① LONGとSHORTでMA期間を分けたシミュレーション
 * ② 静かな上昇バイパスLONGのMA最適期間検証
 * 
 * パターン:
 * A: SHORT=MA50, LONG=MA20（提案）
 * B: SHORT=MA50, LONG=MA10
 * C: SHORT=MA50, LONG=MA5
 * D: SHORT=MA50, LONG=MA50（統一）
 * E: SHORT=MA20, LONG=MA20（現行）
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
const ATR_PERIOD = 7;
const ATR_THRESHOLD = 0.0012;
const FAST_ENTRY_VOL_RATIO = 1.5;
const FAST_ENTRY_PREV_DIST_PCT = 0.05;
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

function calcATR(candles: {h:number;l:number;c:number}[], period: number): number | null {
  if (candles.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    trs.push(Math.max(candles[i].h - candles[i].l, Math.abs(candles[i].h - candles[i-1].c), Math.abs(candles[i].l - candles[i-1].c)));
  }
  if (trs.length < period) return null;
  let atr = trs.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < trs.length; i++) { atr = (atr * (period - 1) + trs[i]) / period; }
  return atr;
}

function timeToMin(t: string): number { const [h, m] = t.split(":").map(Number); return h * 60 + m; }

function calcIsBullish(bufUpToDate: any[], globalIdx: number, maPeriod: number): boolean {
  if (globalIdx < maPeriod + 1) return false;
  const w = bufUpToDate.slice(globalIdx - maPeriod + 1, globalIdx + 1).map((b: any) => b.c.c);
  const pw = bufUpToDate.slice(globalIdx - maPeriod, globalIdx).map((b: any) => b.c.c);
  if (w.length < maPeriod || pw.length < maPeriod) return false;
  const ma = w.reduce((s: number, v: number) => s + v, 0) / maPeriod;
  const prevMa = pw.reduce((s: number, v: number) => s + v, 0) / maPeriod;
  return (ma - prevMa) / prevMa * 100 > 0;
}

interface Trade { date: string; time: string; symbol: string; side: string; pnl: number; result: string; }

async function runSim(shortMaPeriod: number, longMaPeriod: number, label: string, dates: string[], rawBuffers: Record<string, any[]>) {
  const trades: Trade[] = [];

  for (const date of dates) {
    const positions: Record<string, {price: number; shares: number; side: string; entryTime: string}> = {};
    const lastSLTime: Record<string, number> = {};

    for (const symbol of SYMBOLS) {
      const allBuf = rawBuffers[symbol];
      if (!allBuf) continue;
      const bufUpToDate = allBuf.filter((b: any) => b.date <= date);
      const todayCandles = allBuf.filter((b: any) => b.date === date).map((b: any) => b.c);
      if (todayCandles.length < 25) continue;

      for (let i = 1; i < todayCandles.length; i++) {
        const candle = todayCandles[i];
        const tMin = timeToMin(candle.t);

        // 前場強制決済
        if (candle.t >= "11:27" && candle.t < "11:30" && positions[symbol]) {
          const pos = positions[symbol];
          const pnl = pos.side === "short" ? Math.round((pos.price - candle.c) * pos.shares) : Math.round((candle.c - pos.price) * pos.shares);
          trades.push({ date, time: pos.entryTime, symbol, side: pos.side, pnl, result: "前場決済" });
          delete positions[symbol]; continue;
        }
        // 大引け強制決済
        if (candle.t >= "15:25" && positions[symbol]) {
          const pos = positions[symbol];
          const pnl = pos.side === "short" ? Math.round((pos.price - candle.c) * pos.shares) : Math.round((candle.c - pos.price) * pos.shares);
          trades.push({ date, time: pos.entryTime, symbol, side: pos.side, pnl, result: "大引け" });
          delete positions[symbol]; continue;
        }

        // ポジション保有中: SL/TP
        if (positions[symbol]) {
          const pos = positions[symbol];
          const sl = pos.side === "short" ? SL_MAP[symbol]?.short || 0.8 : SL_MAP[symbol]?.long || 0.5;
          const slPrice = pos.side === "short" ? pos.price * (1 + sl / 100) : pos.price * (1 - sl / 100);
          const tpPrice = pos.side === "short" ? pos.price * (1 - TP_PCT / 100) : pos.price * (1 + TP_PCT / 100);
          if (pos.side === "short" && candle.h >= slPrice) { trades.push({ date, time: pos.entryTime, symbol, side: "short", pnl: Math.round((pos.price - slPrice) * pos.shares), result: "SL" }); lastSLTime[symbol] = tMin; delete positions[symbol]; }
          else if (pos.side === "short" && candle.l <= tpPrice) { trades.push({ date, time: pos.entryTime, symbol, side: "short", pnl: Math.round((pos.price - tpPrice) * pos.shares), result: "TP" }); delete positions[symbol]; }
          else if (pos.side === "long" && candle.l <= slPrice) { trades.push({ date, time: pos.entryTime, symbol, side: "long", pnl: Math.round((slPrice - pos.price) * pos.shares), result: "SL" }); lastSLTime[symbol] = tMin; delete positions[symbol]; }
          else if (pos.side === "long" && candle.h >= tpPrice) { trades.push({ date, time: pos.entryTime, symbol, side: "long", pnl: Math.round((tpPrice - pos.price) * pos.shares), result: "TP" }); delete positions[symbol]; }
          continue;
        }

        // エントリー判定
        if (candle.t < "09:30" || candle.t >= "15:05") continue;
        if (candle.t >= "12:30" && candle.t < "12:50") continue;
        if (positions[symbol]) continue;
        if (lastSLTime[symbol] && tMin - lastSLTime[symbol] < NO_REENTRY_MIN) continue;

        const globalIdx = bufUpToDate.findIndex((b: any) => b.date === date && b.c.t === candle.t);
        if (globalIdx < Math.max(shortMaPeriod, longMaPeriod) + 2) continue;

        // isBullish判定（方向別）
        const isBullishForShort = calcIsBullish(bufUpToDate, globalIdx, shortMaPeriod);
        const isBullishForLong = calcIsBullish(bufUpToDate, globalIdx, longMaPeriod);

        // ATRフィルター
        const atrSlice = bufUpToDate.slice(globalIdx - ATR_PERIOD, globalIdx + 1).map((b: any) => b.c);
        const atr = calcATR(atrSlice, ATR_PERIOD);
        if (atr !== null && candle.c > 0 && atr / candle.c < ATR_THRESHOLD) continue;

        // 大台割れSHORT
        const prevClose = todayCandles[i-1]?.c;
        if (!prevClose) continue;
        const levels = getRoundLevels(prevClose);
        let shortSignal = false; let roundLevel = 0;
        for (const level of levels) {
          if (prevClose >= level && candle.c < level) { shortSignal = true; roundLevel = level; break; }
        }

        if (shortSignal && !isBullishForShort) {
          const price = candle.c;
          const shares = Math.floor(3000000 / price / 100) * 100 || 100;
          positions[symbol] = { price, shares, side: "short", entryTime: candle.t };
          continue;
        }

        // ダウ理論LONG（isBullishForLong=trueの時のみ）
        if (i >= 20 && isBullishForLong) {
          const recent20 = todayCandles.slice(i - 20, i);
          const maxHigh = Math.max(...recent20.map((c: any) => c.h));
          if (candle.h > maxHigh) {
            const price = candle.c;
            const shares = Math.floor(3000000 / price / 100) * 100 || 100;
            positions[symbol] = { price, shares, side: "long", entryTime: candle.t };
            continue;
          }
        }
      }

      // 日末残ポジション
      if (positions[symbol]) {
        const lastCandle = todayCandles[todayCandles.length - 1];
        const pos = positions[symbol];
        const pnl = pos.side === "short" ? Math.round((pos.price - lastCandle.c) * pos.shares) : Math.round((lastCandle.c - pos.price) * pos.shares);
        trades.push({ date, time: pos.entryTime, symbol, side: pos.side, pnl, result: "EOD" });
        delete positions[symbol];
      }
    }
  }

  const shortTrades = trades.filter(t => t.side === "short");
  const longTrades = trades.filter(t => t.side === "long");
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const wins = trades.filter(t => t.pnl > 0).length;
  const shortPnl = shortTrades.reduce((s, t) => s + t.pnl, 0);
  const longPnl = longTrades.reduce((s, t) => s + t.pnl, 0);
  const shortWins = shortTrades.filter(t => t.pnl > 0).length;
  const longWins = longTrades.filter(t => t.pnl > 0).length;

  return { label, trades: trades.length, wins, shortTrades: shortTrades.length, shortWins, shortPnl, longTrades: longTrades.length, longWins, longPnl, totalPnl };
}

async function main() {
  const conn = await mysql.createConnection(DATABASE_URL);
  
  const [dateRows] = await conn.query(`
    SELECT DISTINCT tradeDate FROM rt_candles WHERE symbol = '8035' AND tradeDate <= '2026-08-18'
    ORDER BY tradeDate DESC LIMIT 21
  `) as any[];
  const allDates = (dateRows as any[]).map((r: any) => r.tradeDate).reverse();
  const dates = allDates.slice(1);
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

  // パターン: [shortMA, longMA, label]
  const patterns: [number, number, string][] = [
    [20, 20, "E: 現行 (S=MA20, L=MA20)"],
    [50, 20, "A: S=MA50, L=MA20"],
    [50, 10, "B: S=MA50, L=MA10"],
    [50, 5,  "C: S=MA50, L=MA5"],
    [50, 50, "D: 統一 (S=MA50, L=MA50)"],
    [30, 20, "F: S=MA30, L=MA20"],
    [50, 30, "G: S=MA50, L=MA30"],
  ];

  const results: any[] = [];
  for (const [sma, lma, label] of patterns) {
    const r = await runSim(sma, lma, label, dates, rawBuffers);
    results.push(r);
  }

  console.log(`| パターン | 全体件数 | 全体勝率 | 全体損益 | SHORT件数 | SHORT勝率 | SHORT損益 | LONG件数 | LONG勝率 | LONG損益 |`);
  console.log(`|----------|---------|---------|---------|----------|----------|----------|---------|---------|---------|`);
  for (const r of results) {
    const wr = (r.wins / r.trades * 100).toFixed(1);
    const swr = r.shortTrades > 0 ? (r.shortWins / r.shortTrades * 100).toFixed(1) : "-";
    const lwr = r.longTrades > 0 ? (r.longWins / r.longTrades * 100).toFixed(1) : "-";
    console.log(`| ${r.label} | ${r.trades}件 | ${wr}% | ${r.totalPnl>=0?"+":""}${r.totalPnl.toLocaleString()}円 | ${r.shortTrades}件 | ${swr}% | ${r.shortPnl>=0?"+":""}${r.shortPnl.toLocaleString()}円 | ${r.longTrades}件 | ${lwr}% | ${r.longPnl>=0?"+":""}${r.longPnl.toLocaleString()}円 |`);
  }

  await conn.end();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
