/**
 * 8035の直近20営業日バックテスト: 案A vs 案B vs 現行
 * SHORTのみ対象（isBullishフィルターはSHORTにのみ影響するため）
 */
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { sql } from "drizzle-orm";

interface Candle {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const SL_PCT = 0.5;
const TP_PCT = 1.5;
const POSITION_SIZE = 3_000_000;
const NO_ENTRY_BEFORE = "09:30";
const NO_ENTRY_AFTER = "15:05";
const MARKET_CLOSE = "15:25";
const MA_PERIOD_A = 10;
const SLOPE_THRESHOLD_A = -0.05;
const HIGH_DROP_THRESHOLD_B = 1.0;

function detectRoundLevel(prev: number, curr: number): { crossedBelow: boolean; level: number | null } {
  const step = 100;
  const prevLevel = Math.floor(prev / step) * step;
  const currLevel = Math.floor(curr / step) * step;
  if (currLevel < prevLevel) return { crossedBelow: true, level: currLevel + step };
  return { crossedBelow: false, level: null };
}

function calcMA(closes: number[], period: number): (number | null)[] {
  return closes.map((_, i) => {
    if (i < period - 1) return null;
    const slice = closes.slice(i - period + 1, i + 1);
    return slice.reduce((a, b) => a + b, 0) / period;
  });
}

interface Trade {
  date: string;
  entryTime: string;
  entryPrice: number;
  exitTime: string;
  exitPrice: number;
  exitReason: string;
  pnl: number;
  signal: string;
}

function simulate(candles: Candle[], date: string, isBullishFn: (i: number, candles: Candle[], dayHigh: number) => boolean): Trade[] {
  const trades: Trade[] = [];
  let position: { entryTime: string; entryPrice: number; signal: string } | null = null;
  let dayHigh = 0;
  const closes = candles.map(c => c.close);
  const ma5 = calcMA(closes, 5);
  const ma25 = calcMA(closes, 25);
  let cumVol = 0, cumPV = 0;
  const vwap: number[] = [];
  for (const c of candles) {
    const tp = (c.high + c.low + c.close) / 3;
    cumVol += c.volume;
    cumPV += tp * c.volume;
    vwap.push(cumVol > 0 ? cumPV / cumVol : c.close);
  }

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    dayHigh = Math.max(dayHigh, c.high);

    if (position) {
      const slPrice = position.entryPrice * (1 + SL_PCT / 100);
      if (c.high >= slPrice) {
        trades.push({ date, ...position, exitTime: c.time, exitPrice: slPrice, exitReason: "SL", pnl: Math.round((position.entryPrice - slPrice) / position.entryPrice * POSITION_SIZE) });
        position = null; continue;
      }
      const tpPrice = position.entryPrice * (1 - TP_PCT / 100);
      if (c.low <= tpPrice) {
        trades.push({ date, ...position, exitTime: c.time, exitPrice: tpPrice, exitReason: "TP", pnl: Math.round((position.entryPrice - tpPrice) / position.entryPrice * POSITION_SIZE) });
        position = null; continue;
      }
      if (c.time >= MARKET_CLOSE) {
        trades.push({ date, ...position, exitTime: c.time, exitPrice: c.close, exitReason: "EOD", pnl: Math.round((position.entryPrice - c.close) / position.entryPrice * POSITION_SIZE) });
        position = null; continue;
      }
      continue;
    }

    if (c.time < NO_ENTRY_BEFORE || c.time >= NO_ENTRY_AFTER) continue;
    if (isBullishFn(i, candles, dayHigh)) continue;

    let signal: string | null = null;
    const { crossedBelow, level } = detectRoundLevel(prev.close, c.close);
    if (crossedBelow && level !== null) signal = `大台割れ (${level}円)`;
    if (!signal && ma5[i] !== null && ma25[i] !== null && ma5[i - 1] !== null && ma25[i - 1] !== null) {
      if (ma5[i - 1]! >= ma25[i - 1]! && ma5[i]! < ma25[i]!) signal = `デッドクロス`;
    }
    if (!signal && prev.close > vwap[i - 1] && c.close <= vwap[i]) {
      signal = `VWAPクロス下抜け`;
    }

    if (signal) {
      position = { entryTime: c.time, entryPrice: c.close, signal };
    }
  }
  return trades;
}

async function main() {
  const pool = mysql.createPool(process.env.DATABASE_URL || "");
  const db = drizzle(pool);

  // 直近20営業日を取得
  const dates = await db.execute(sql`
    SELECT DISTINCT tradeDate FROM rt_candles
    WHERE symbol = '8035'
    ORDER BY tradeDate DESC LIMIT 20
  `);
  const tradeDates = (dates[0] as any[]).map(r => r.tradeDate).reverse();
  console.log(`=== 8035 直近${tradeDates.length}営業日 SHORT シミュレーション ===`);
  console.log(`期間: ${tradeDates[0]} ～ ${tradeDates[tradeDates.length - 1]}\n`);

  const results: { date: string; current: number; planA: number; planB: number; currentN: number; planAN: number; planBN: number }[] = [];

  for (const date of tradeDates) {
    const r = await db.execute(sql`
      SELECT candleTime as time, open, high, low, close, volume
      FROM rt_candles WHERE symbol = '8035' AND tradeDate = ${date}
      ORDER BY candleTime ASC
    `);
    const candles: Candle[] = (r[0] as any[]).map((x: any) => ({
      time: x.time, open: Number(x.open), high: Number(x.high),
      low: Number(x.low), close: Number(x.close), volume: Number(x.volume),
    }));
    if (candles.length < 30) continue;

    // 現行
    const currentTrades = simulate(candles, date, (i, cds) => {
      return (cds[i].close - cds[0].open) / cds[0].open * 100 >= 0.2;
    });
    // 案A
    const planATrades = simulate(candles, date, (i, cds) => {
      if (i < MA_PERIOD_A) return (cds[i].close - cds[0].open) / cds[0].open * 100 >= 0.2;
      const cls = cds.slice(i - MA_PERIOD_A + 1, i + 1).map(c => c.close);
      const ma = cls.reduce((a, b) => a + b, 0) / cls.length;
      const pcls = cds.slice(i - MA_PERIOD_A, i).map(c => c.close);
      const pma = pcls.reduce((a, b) => a + b, 0) / pcls.length;
      return (ma - pma) / pma * 100 > SLOPE_THRESHOLD_A;
    });
    // 案B
    const planBTrades = simulate(candles, date, (i, cds, dayHigh) => {
      const basicBullish = (cds[i].close - cds[0].open) / cds[0].open * 100 >= 0.2;
      if (!basicBullish) return false;
      const drop = (dayHigh - cds[i].close) / dayHigh * 100;
      return drop < HIGH_DROP_THRESHOLD_B;
    });

    const currentPnl = currentTrades.reduce((s, t) => s + t.pnl, 0);
    const planAPnl = planATrades.reduce((s, t) => s + t.pnl, 0);
    const planBPnl = planBTrades.reduce((s, t) => s + t.pnl, 0);
    results.push({ date, current: currentPnl, planA: planAPnl, planB: planBPnl, currentN: currentTrades.length, planAN: planATrades.length, planBN: planBTrades.length });
  }

  // 日別結果
  console.log("日付       | 現行(件/損益)    | 案A(件/損益)     | 案B(件/損益)");
  console.log("-----------|-----------------|-----------------|----------------");
  for (const r of results) {
    const fmtPnl = (n: number) => (n >= 0 ? "+" : "") + n.toLocaleString();
    console.log(`${r.date} | ${r.currentN}件/${fmtPnl(r.current).padStart(10)} | ${r.planAN}件/${fmtPnl(r.planA).padStart(10)} | ${r.planBN}件/${fmtPnl(r.planB).padStart(10)}`);
  }

  // サマリー
  const totalCurrent = results.reduce((s, r) => s + r.current, 0);
  const totalPlanA = results.reduce((s, r) => s + r.planA, 0);
  const totalPlanB = results.reduce((s, r) => s + r.planB, 0);
  const totalCurrentN = results.reduce((s, r) => s + r.currentN, 0);
  const totalPlanAN = results.reduce((s, r) => s + r.planAN, 0);
  const totalPlanBN = results.reduce((s, r) => s + r.planBN, 0);
  const winCurrent = results.filter(r => r.current > 0).length;
  const winPlanA = results.filter(r => r.planA > 0).length;
  const winPlanB = results.filter(r => r.planB > 0).length;

  console.log("\n=== サマリー ===");
  console.log(`現行: ${totalCurrentN}件, 損益=${totalCurrent.toLocaleString()}円, 勝ち日=${winCurrent}/${results.length}`);
  console.log(`案A:  ${totalPlanAN}件, 損益=${totalPlanA.toLocaleString()}円, 勝ち日=${winPlanA}/${results.length}`);
  console.log(`案B:  ${totalPlanBN}件, 損益=${totalPlanB.toLocaleString()}円, 勝ち日=${winPlanB}/${results.length}`);
  console.log(`\n案A vs 現行: ${(totalPlanA - totalCurrent >= 0 ? "+" : "")}${(totalPlanA - totalCurrent).toLocaleString()}円`);
  console.log(`案B vs 現行: ${(totalPlanB - totalCurrent >= 0 ? "+" : "")}${(totalPlanB - totalCurrent).toLocaleString()}円`);

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
