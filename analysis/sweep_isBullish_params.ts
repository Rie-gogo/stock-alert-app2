/**
 * 案A（動的MA傾き判定）のパラメータスイープ
 * 対象: 全10アクティブ銘柄 × 直近20営業日
 * スイープ: MA期間 [5,7,10,15,20] × 傾き閾値 [-0.02,-0.03,-0.05,-0.07,-0.10,-0.15]
 * SHORTのみ対象
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

const ACTIVE_SYMBOLS = ['8035', '6857', '6976', '6526', '5803', '6981', '285A', '6920', '6758', '8316'];
const SL_PCT = 0.5;
const TP_PCT = 1.5;
const POSITION_SIZE = 3_000_000;
const NO_ENTRY_BEFORE = "09:30";
const NO_ENTRY_AFTER = "15:05";
const MARKET_CLOSE = "15:25";

// スイープパラメータ
const MA_PERIODS = [5, 7, 10, 15, 20];
const SLOPE_THRESHOLDS = [-0.02, -0.03, -0.05, -0.07, -0.10, -0.15];

function detectRoundLevel(prev: number, curr: number): { crossedBelow: boolean; level: number | null } {
  const step = curr >= 10000 ? 100 : 10;
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
  entryTime: string;
  entryPrice: number;
  exitTime: string;
  exitPrice: number;
  exitReason: string;
  pnl: number;
}

function simulate(
  candles: Candle[],
  isBullishFn: (i: number, candles: Candle[]) => boolean
): Trade[] {
  const trades: Trade[] = [];
  let position: { entryTime: string; entryPrice: number } | null = null;
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

    if (position) {
      const slPrice = position.entryPrice * (1 + SL_PCT / 100);
      if (c.high >= slPrice) {
        trades.push({ ...position, exitTime: c.time, exitPrice: slPrice, exitReason: "SL", pnl: Math.round((position.entryPrice - slPrice) / position.entryPrice * POSITION_SIZE) });
        position = null; continue;
      }
      const tpPrice = position.entryPrice * (1 - TP_PCT / 100);
      if (c.low <= tpPrice) {
        trades.push({ ...position, exitTime: c.time, exitPrice: tpPrice, exitReason: "TP", pnl: Math.round((position.entryPrice - tpPrice) / position.entryPrice * POSITION_SIZE) });
        position = null; continue;
      }
      if (c.time >= MARKET_CLOSE) {
        trades.push({ ...position, exitTime: c.time, exitPrice: c.close, exitReason: "EOD", pnl: Math.round((position.entryPrice - c.close) / position.entryPrice * POSITION_SIZE) });
        position = null; continue;
      }
      continue;
    }

    if (c.time < NO_ENTRY_BEFORE || c.time >= NO_ENTRY_AFTER) continue;
    if (isBullishFn(i, candles)) continue;

    let signal = false;
    const { crossedBelow } = detectRoundLevel(prev.close, c.close);
    if (crossedBelow) signal = true;
    if (!signal && ma5[i] !== null && ma25[i] !== null && ma5[i - 1] !== null && ma25[i - 1] !== null) {
      if (ma5[i - 1]! >= ma25[i - 1]! && ma5[i]! < ma25[i]!) signal = true;
    }
    if (!signal && prev.close > vwap[i - 1] && c.close <= vwap[i]) signal = true;

    if (signal) {
      position = { entryTime: c.time, entryPrice: c.close };
    }
  }
  return trades;
}

async function main() {
  const pool = mysql.createPool({ uri: process.env.DATABASE_URL || "", connectionLimit: 5 });
  const db = drizzle(pool);

  // 全銘柄の直近20営業日のデータを一括取得
  type SymbolData = Map<string, Candle[]>; // date -> candles
  const allData = new Map<string, SymbolData>(); // symbol -> SymbolData

  for (const sym of ACTIVE_SYMBOLS) {
    const dates = await db.execute(sql`
      SELECT DISTINCT tradeDate FROM rt_candles
      WHERE symbol = ${sym} ORDER BY tradeDate DESC LIMIT 20
    `);
    const tradeDates = (dates[0] as any[]).map(r => r.tradeDate).reverse();
    const symData: SymbolData = new Map();

    for (const date of tradeDates) {
      const r = await db.execute(sql`
        SELECT candleTime as time, open, high, low, close, volume
        FROM rt_candles WHERE symbol = ${sym} AND tradeDate = ${date}
        ORDER BY candleTime ASC
      `);
      const candles: Candle[] = (r[0] as any[]).map((x: any) => ({
        time: x.time, open: Number(x.open), high: Number(x.high),
        low: Number(x.low), close: Number(x.close), volume: Number(x.volume),
      }));
      if (candles.length >= 30) symData.set(date, candles);
    }
    allData.set(sym, symData);
    process.stdout.write(`  ${sym}: ${symData.size}日分ロード完了\n`);
  }

  // 現行ロジックのベースライン
  let baselinePnl = 0;
  let baselineTrades = 0;
  let baselineWins = 0;
  for (const [sym, symData] of allData) {
    for (const [, candles] of symData) {
      const trades = simulate(candles, (i, cds) => {
        return (cds[i].close - cds[0].open) / cds[0].open * 100 >= 0.2;
      });
      baselinePnl += trades.reduce((s, t) => s + t.pnl, 0);
      baselineTrades += trades.length;
      baselineWins += trades.filter(t => t.pnl > 0).length;
    }
  }

  console.log(`\n=== ベースライン（現行 isBullish 始値比0.2%） ===`);
  console.log(`取引数: ${baselineTrades}, 勝率: ${(baselineWins / baselineTrades * 100).toFixed(1)}%, 損益: ${baselinePnl.toLocaleString()}円\n`);

  // パラメータスイープ
  interface SweepResult {
    maPeriod: number;
    slopeThreshold: number;
    totalPnl: number;
    totalTrades: number;
    wins: number;
    winRate: number;
    vsCurrent: number;
    avgPnlPerTrade: number;
    maxDrawdown: number; // 最大日次損失
    profitDays: number;
    totalDays: number;
  }

  const results: SweepResult[] = [];

  for (const maPeriod of MA_PERIODS) {
    for (const slopeThreshold of SLOPE_THRESHOLDS) {
      let totalPnl = 0;
      let totalTrades = 0;
      let wins = 0;
      let maxDrawdown = 0;
      let profitDays = 0;
      let totalDays = 0;

      for (const [, symData] of allData) {
        for (const [, candles] of symData) {
          const trades = simulate(candles, (i, cds) => {
            if (i < maPeriod) return (cds[i].close - cds[0].open) / cds[0].open * 100 >= 0.2;
            const cls = cds.slice(i - maPeriod + 1, i + 1).map(c => c.close);
            const ma = cls.reduce((a, b) => a + b, 0) / cls.length;
            const pcls = cds.slice(i - maPeriod, i).map(c => c.close);
            const pma = pcls.reduce((a, b) => a + b, 0) / pcls.length;
            return (ma - pma) / pma * 100 > slopeThreshold;
          });
          const dayPnl = trades.reduce((s, t) => s + t.pnl, 0);
          totalPnl += dayPnl;
          totalTrades += trades.length;
          wins += trades.filter(t => t.pnl > 0).length;
          if (dayPnl < maxDrawdown) maxDrawdown = dayPnl;
          if (dayPnl > 0) profitDays++;
          totalDays++;
        }
      }

      results.push({
        maPeriod,
        slopeThreshold,
        totalPnl,
        totalTrades,
        wins,
        winRate: totalTrades > 0 ? wins / totalTrades * 100 : 0,
        vsCurrent: totalPnl - baselinePnl,
        avgPnlPerTrade: totalTrades > 0 ? Math.round(totalPnl / totalTrades) : 0,
        maxDrawdown,
        profitDays,
        totalDays,
      });
    }
  }

  // 結果をソート（損益順）
  results.sort((a, b) => b.totalPnl - a.totalPnl);

  console.log("=== パラメータスイープ結果（損益順 TOP 15） ===");
  console.log("MA期間 | 傾き閾値 | 取引数 | 勝率   | 損益         | vs現行       | 1件平均  | 勝ち日 | 最大日損");
  console.log("-------|----------|--------|--------|-------------|-------------|---------|--------|--------");
  for (const r of results.slice(0, 15)) {
    const fmtPnl = (n: number) => (n >= 0 ? "+" : "") + n.toLocaleString();
    console.log(
      `${String(r.maPeriod).padStart(5)}  | ${r.slopeThreshold.toFixed(2).padStart(6)} | ${String(r.totalTrades).padStart(5)}  | ${r.winRate.toFixed(1).padStart(5)}% | ${fmtPnl(r.totalPnl).padStart(11)} | ${fmtPnl(r.vsCurrent).padStart(11)} | ${fmtPnl(r.avgPnlPerTrade).padStart(7)} | ${r.profitDays}/${r.totalDays} | ${fmtPnl(r.maxDrawdown).padStart(8)}`
    );
  }

  console.log("\n=== パラメータスイープ結果（損益順 WORST 5） ===");
  for (const r of results.slice(-5)) {
    const fmtPnl = (n: number) => (n >= 0 ? "+" : "") + n.toLocaleString();
    console.log(
      `${String(r.maPeriod).padStart(5)}  | ${r.slopeThreshold.toFixed(2).padStart(6)} | ${String(r.totalTrades).padStart(5)}  | ${r.winRate.toFixed(1).padStart(5)}% | ${fmtPnl(r.totalPnl).padStart(11)} | ${fmtPnl(r.vsCurrent).padStart(11)} | ${fmtPnl(r.avgPnlPerTrade).padStart(7)} | ${r.profitDays}/${r.totalDays} | ${fmtPnl(r.maxDrawdown).padStart(8)}`
    );
  }

  // 銘柄別の最適パラメータ分析
  console.log("\n=== 銘柄別分析（最適パラメータ: MA10, 傾き-0.05 vs 現行） ===");
  const bestMA = results[0].maPeriod;
  const bestSlope = results[0].slopeThreshold;
  console.log(`最適パラメータ: MA${bestMA}, 傾き閾値=${bestSlope}`);
  console.log("");
  console.log("銘柄   | 現行損益     | 案A損益      | 差分         | 現行件数 | 案A件数");
  console.log("-------|-------------|-------------|-------------|---------|--------");

  for (const sym of ACTIVE_SYMBOLS) {
    const symData = allData.get(sym)!;
    let currentPnl = 0, planAPnl = 0, currentN = 0, planAN = 0;
    for (const [, candles] of symData) {
      const ct = simulate(candles, (i, cds) => (cds[i].close - cds[0].open) / cds[0].open * 100 >= 0.2);
      const at = simulate(candles, (i, cds) => {
        if (i < bestMA) return (cds[i].close - cds[0].open) / cds[0].open * 100 >= 0.2;
        const cls = cds.slice(i - bestMA + 1, i + 1).map(c => c.close);
        const ma = cls.reduce((a, b) => a + b, 0) / cls.length;
        const pcls = cds.slice(i - bestMA, i).map(c => c.close);
        const pma = pcls.reduce((a, b) => a + b, 0) / pcls.length;
        return (ma - pma) / pma * 100 > bestSlope;
      });
      currentPnl += ct.reduce((s, t) => s + t.pnl, 0);
      planAPnl += at.reduce((s, t) => s + t.pnl, 0);
      currentN += ct.length;
      planAN += at.length;
    }
    const fmtPnl = (n: number) => (n >= 0 ? "+" : "") + n.toLocaleString();
    const diff = planAPnl - currentPnl;
    console.log(`${sym.padEnd(6)} | ${fmtPnl(currentPnl).padStart(11)} | ${fmtPnl(planAPnl).padStart(11)} | ${fmtPnl(diff).padStart(11)} | ${String(currentN).padStart(7)} | ${String(planAN).padStart(6)}`);
  }

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
