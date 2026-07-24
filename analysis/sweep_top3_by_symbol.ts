/**
 * TOP3パラメータの銘柄別比較
 * 1. MA10, slope=-0.02
 * 2. MA20, slope=-0.03
 * 3. MA5, slope=-0.05
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
const SYMBOL_NAMES: Record<string, string> = {
  '8035': '東京エレク', '6857': 'アドバンテ', '6976': '太陽誘電',
  '6526': 'ソシオネクス', '5803': 'フジクラ', '6981': '村田製作',
  '285A': 'キオクシア', '6920': 'レーザーテ', '6758': 'ソニー',
  '8316': '三井住友FG'
};
const SL_PCT = 0.5;
const TP_PCT = 1.5;
const POSITION_SIZE = 3_000_000;
const NO_ENTRY_BEFORE = "09:30";
const NO_ENTRY_AFTER = "15:05";
const MARKET_CLOSE = "15:25";

const CANDIDATES = [
  { name: "MA10/-0.02", maPeriod: 10, slope: -0.02 },
  { name: "MA20/-0.03", maPeriod: 20, slope: -0.03 },
  { name: "MA5/-0.05", maPeriod: 5, slope: -0.05 },
];

function detectRoundLevel(prev: number, curr: number): boolean {
  const step = curr >= 10000 ? 100 : 10;
  const prevLevel = Math.floor(prev / step) * step;
  const currLevel = Math.floor(curr / step) * step;
  return currLevel < prevLevel;
}

function calcMA(closes: number[], period: number): (number | null)[] {
  return closes.map((_, i) => {
    if (i < period - 1) return null;
    return closes.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period;
  });
}

interface Trade { pnl: number; exitReason: string; }

function simulate(candles: Candle[], maPeriod: number, slopeThreshold: number): Trade[] {
  const trades: Trade[] = [];
  let position: { entryPrice: number } | null = null;
  const closes = candles.map(c => c.close);
  const ma5 = calcMA(closes, 5);
  const ma25 = calcMA(closes, 25);
  let cumVol = 0, cumPV = 0;
  const vwap: number[] = [];
  for (const c of candles) {
    cumVol += c.volume;
    cumPV += (c.high + c.low + c.close) / 3 * c.volume;
    vwap.push(cumVol > 0 ? cumPV / cumVol : c.close);
  }

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];

    if (position) {
      const slPrice = position.entryPrice * (1 + SL_PCT / 100);
      if (c.high >= slPrice) { trades.push({ pnl: Math.round((position.entryPrice - slPrice) / position.entryPrice * POSITION_SIZE), exitReason: "SL" }); position = null; continue; }
      const tpPrice = position.entryPrice * (1 - TP_PCT / 100);
      if (c.low <= tpPrice) { trades.push({ pnl: Math.round((position.entryPrice - tpPrice) / position.entryPrice * POSITION_SIZE), exitReason: "TP" }); position = null; continue; }
      if (c.time >= MARKET_CLOSE) { trades.push({ pnl: Math.round((position.entryPrice - c.close) / position.entryPrice * POSITION_SIZE), exitReason: "EOD" }); position = null; continue; }
      continue;
    }

    if (c.time < NO_ENTRY_BEFORE || c.time >= NO_ENTRY_AFTER) continue;

    // isBullish check (dynamic MA slope)
    let isBullish: boolean;
    if (i < maPeriod) {
      isBullish = (candles[i].close - candles[0].open) / candles[0].open * 100 >= 0.2;
    } else {
      const cls = candles.slice(i - maPeriod + 1, i + 1).map(x => x.close);
      const ma = cls.reduce((a, b) => a + b, 0) / cls.length;
      const pcls = candles.slice(i - maPeriod, i).map(x => x.close);
      const pma = pcls.reduce((a, b) => a + b, 0) / pcls.length;
      isBullish = (ma - pma) / pma * 100 > slopeThreshold;
    }
    if (isBullish) continue;

    // Signal detection
    let signal = false;
    if (detectRoundLevel(prev.close, c.close)) signal = true;
    if (!signal && ma5[i] !== null && ma25[i] !== null && ma5[i - 1] !== null && ma25[i - 1] !== null) {
      if (ma5[i - 1]! >= ma25[i - 1]! && ma5[i]! < ma25[i]!) signal = true;
    }
    if (!signal && prev.close > vwap[i - 1] && c.close <= vwap[i]) signal = true;

    if (signal) position = { entryPrice: c.close };
  }
  return trades;
}

async function main() {
  const pool = mysql.createPool({ uri: process.env.DATABASE_URL || "", connectionLimit: 5 });
  const db = drizzle(pool);

  // Load all data
  type SymbolData = Map<string, Candle[]>;
  const allData = new Map<string, SymbolData>();

  for (const sym of ACTIVE_SYMBOLS) {
    const dates = await db.execute(sql`SELECT DISTINCT tradeDate FROM rt_candles WHERE symbol = ${sym} ORDER BY tradeDate DESC LIMIT 20`);
    const tradeDates = (dates[0] as any[]).map(r => r.tradeDate).reverse();
    const symData: SymbolData = new Map();
    for (const date of tradeDates) {
      const r = await db.execute(sql`SELECT candleTime as time, open, high, low, close, volume FROM rt_candles WHERE symbol = ${sym} AND tradeDate = ${date} ORDER BY candleTime ASC`);
      const candles: Candle[] = (r[0] as any[]).map((x: any) => ({ time: x.time, open: Number(x.open), high: Number(x.high), low: Number(x.low), close: Number(x.close), volume: Number(x.volume) }));
      if (candles.length >= 30) symData.set(date, candles);
    }
    allData.set(sym, symData);
  }

  // Run simulations
  console.log("=== 銘柄別 TOP3パラメータ比較 ===\n");
  console.log("銘柄       | 現行         | MA10/-0.02   | MA20/-0.03   | MA5/-0.05    | 最良案");
  console.log("-----------|-------------|-------------|-------------|-------------|-------");

  const totals = { current: 0, c1: 0, c2: 0, c3: 0 };
  const totalN = { current: 0, c1: 0, c2: 0, c3: 0 };
  const totalWins = { current: 0, c1: 0, c2: 0, c3: 0 };

  for (const sym of ACTIVE_SYMBOLS) {
    const symData = allData.get(sym)!;
    let currentPnl = 0, c1Pnl = 0, c2Pnl = 0, c3Pnl = 0;
    let currentN = 0, c1N = 0, c2N = 0, c3N = 0;
    let currentW = 0, c1W = 0, c2W = 0, c3W = 0;

    for (const [, candles] of symData) {
      // Current
      const ct = simulate(candles, 999, 999); // Will always use fallback (basic isBullish)
      // Actually need to implement current logic properly
      const currentTrades: Trade[] = [];
      let pos: { entryPrice: number } | null = null;
      const closes = candles.map(c => c.close);
      const ma5c = calcMA(closes, 5);
      const ma25c = calcMA(closes, 25);
      let cv = 0, cpv = 0;
      const vwapc: number[] = [];
      for (const c of candles) { cv += c.volume; cpv += (c.high + c.low + c.close) / 3 * c.volume; vwapc.push(cv > 0 ? cpv / cv : c.close); }
      for (let i = 1; i < candles.length; i++) {
        const c = candles[i]; const prev = candles[i - 1];
        if (pos) {
          const sl = pos.entryPrice * (1 + SL_PCT / 100);
          if (c.high >= sl) { currentTrades.push({ pnl: Math.round((pos.entryPrice - sl) / pos.entryPrice * POSITION_SIZE), exitReason: "SL" }); pos = null; continue; }
          const tp = pos.entryPrice * (1 - TP_PCT / 100);
          if (c.low <= tp) { currentTrades.push({ pnl: Math.round((pos.entryPrice - tp) / pos.entryPrice * POSITION_SIZE), exitReason: "TP" }); pos = null; continue; }
          if (c.time >= MARKET_CLOSE) { currentTrades.push({ pnl: Math.round((pos.entryPrice - c.close) / pos.entryPrice * POSITION_SIZE), exitReason: "EOD" }); pos = null; continue; }
          continue;
        }
        if (c.time < NO_ENTRY_BEFORE || c.time >= NO_ENTRY_AFTER) continue;
        if ((c.close - candles[0].open) / candles[0].open * 100 >= 0.2) continue;
        let sig = false;
        if (detectRoundLevel(prev.close, c.close)) sig = true;
        if (!sig && ma5c[i] !== null && ma25c[i] !== null && ma5c[i - 1] !== null && ma25c[i - 1] !== null) { if (ma5c[i - 1]! >= ma25c[i - 1]! && ma5c[i]! < ma25c[i]!) sig = true; }
        if (!sig && prev.close > vwapc[i - 1] && c.close <= vwapc[i]) sig = true;
        if (sig) pos = { entryPrice: c.close };
      }

      // Candidates
      const t1 = simulate(candles, 10, -0.02);
      const t2 = simulate(candles, 20, -0.03);
      const t3 = simulate(candles, 5, -0.05);

      currentPnl += currentTrades.reduce((s, t) => s + t.pnl, 0);
      c1Pnl += t1.reduce((s, t) => s + t.pnl, 0);
      c2Pnl += t2.reduce((s, t) => s + t.pnl, 0);
      c3Pnl += t3.reduce((s, t) => s + t.pnl, 0);
      currentN += currentTrades.length; c1N += t1.length; c2N += t2.length; c3N += t3.length;
      currentW += currentTrades.filter(t => t.pnl > 0).length;
      c1W += t1.filter(t => t.pnl > 0).length;
      c2W += t2.filter(t => t.pnl > 0).length;
      c3W += t3.filter(t => t.pnl > 0).length;
    }

    totals.current += currentPnl; totals.c1 += c1Pnl; totals.c2 += c2Pnl; totals.c3 += c3Pnl;
    totalN.current += currentN; totalN.c1 += c1N; totalN.c2 += c2N; totalN.c3 += c3N;
    totalWins.current += currentW; totalWins.c1 += c1W; totalWins.c2 += c2W; totalWins.c3 += c3W;

    const fmtPnl = (n: number) => (n >= 0 ? "+" : "") + n.toLocaleString();
    const best = [
      { name: "現行", pnl: currentPnl },
      { name: "MA10/-0.02", pnl: c1Pnl },
      { name: "MA20/-0.03", pnl: c2Pnl },
      { name: "MA5/-0.05", pnl: c3Pnl },
    ].sort((a, b) => b.pnl - a.pnl)[0].name;

    const name = `${sym}(${SYMBOL_NAMES[sym]})`;
    console.log(`${name.padEnd(10)} | ${fmtPnl(currentPnl).padStart(11)} | ${fmtPnl(c1Pnl).padStart(11)} | ${fmtPnl(c2Pnl).padStart(11)} | ${fmtPnl(c3Pnl).padStart(11)} | ${best}`);
  }

  console.log("-----------|-------------|-------------|-------------|-------------|-------");
  const fmtPnl = (n: number) => (n >= 0 ? "+" : "") + n.toLocaleString();
  console.log(`合計       | ${fmtPnl(totals.current).padStart(11)} | ${fmtPnl(totals.c1).padStart(11)} | ${fmtPnl(totals.c2).padStart(11)} | ${fmtPnl(totals.c3).padStart(11)} |`);
  console.log(`取引数     | ${String(totalN.current).padStart(11)} | ${String(totalN.c1).padStart(11)} | ${String(totalN.c2).padStart(11)} | ${String(totalN.c3).padStart(11)} |`);
  console.log(`勝率       | ${(totalWins.current / totalN.current * 100).toFixed(1).padStart(10)}% | ${(totalWins.c1 / totalN.c1 * 100).toFixed(1).padStart(10)}% | ${(totalWins.c2 / totalN.c2 * 100).toFixed(1).padStart(10)}% | ${(totalWins.c3 / totalN.c3 * 100).toFixed(1).padStart(10)}% |`);
  console.log(`1件平均    | ${fmtPnl(Math.round(totals.current / totalN.current)).padStart(11)} | ${fmtPnl(Math.round(totals.c1 / totalN.c1)).padStart(11)} | ${fmtPnl(Math.round(totals.c2 / totalN.c2)).padStart(11)} | ${fmtPnl(Math.round(totals.c3 / totalN.c3)).padStart(11)} |`);

  // Robustness check: how many symbols improve vs worsen
  console.log("\n=== ロバスト性チェック ===");
  for (const cand of CANDIDATES) {
    let improved = 0, worsened = 0;
    for (const sym of ACTIVE_SYMBOLS) {
      const symData = allData.get(sym)!;
      let currentPnl = 0, candPnl = 0;
      for (const [, candles] of symData) {
        // Current (inline)
        let pos: { ep: number } | null = null;
        const cls = candles.map(c => c.close);
        const m5 = calcMA(cls, 5); const m25 = calcMA(cls, 25);
        let cv2 = 0, cpv2 = 0; const vw: number[] = [];
        for (const c of candles) { cv2 += c.volume; cpv2 += (c.high + c.low + c.close) / 3 * c.volume; vw.push(cv2 > 0 ? cpv2 / cv2 : c.close); }
        for (let i = 1; i < candles.length; i++) {
          const c = candles[i]; const prev = candles[i - 1];
          if (pos) {
            const sl = pos.ep * (1 + SL_PCT / 100);
            if (c.high >= sl) { currentPnl += Math.round((pos.ep - sl) / pos.ep * POSITION_SIZE); pos = null; continue; }
            const tp = pos.ep * (1 - TP_PCT / 100);
            if (c.low <= tp) { currentPnl += Math.round((pos.ep - tp) / pos.ep * POSITION_SIZE); pos = null; continue; }
            if (c.time >= MARKET_CLOSE) { currentPnl += Math.round((pos.ep - c.close) / pos.ep * POSITION_SIZE); pos = null; continue; }
            continue;
          }
          if (c.time < NO_ENTRY_BEFORE || c.time >= NO_ENTRY_AFTER) continue;
          if ((c.close - candles[0].open) / candles[0].open * 100 >= 0.2) continue;
          let sig = false;
          if (detectRoundLevel(prev.close, c.close)) sig = true;
          if (!sig && m5[i] !== null && m25[i] !== null && m5[i - 1] !== null && m25[i - 1] !== null) { if (m5[i - 1]! >= m25[i - 1]! && m5[i]! < m25[i]!) sig = true; }
          if (!sig && prev.close > vw[i - 1] && c.close <= vw[i]) sig = true;
          if (sig) pos = { ep: c.close };
        }
        // Candidate
        const t = simulate(candles, cand.maPeriod, cand.slope);
        candPnl += t.reduce((s, x) => s + x.pnl, 0);
      }
      if (candPnl > currentPnl) improved++; else worsened++;
    }
    console.log(`${cand.name}: 改善${improved}銘柄 / 悪化${worsened}銘柄`);
  }

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
