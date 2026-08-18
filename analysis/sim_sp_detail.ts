import mysql from "mysql2/promise";
const DATABASE_URL = process.env.DATABASE_URL!;
const TP_PCT = 1.5;
const SL_MAP: Record<string, {long: number; short: number}> = {
  "8035": {long:0.5, short:0.8}, "6857": {long:0.6, short:0.6}, "6976": {long:0.6, short:0.8},
  "6526": {long:0.9, short:1.0}, "5803": {long:0.5, short:0.6}, "6981": {long:0.4, short:0.9},
  "285A": {long:0.8, short:0.6}, "6146": {long:0.8, short:0.8}, "6594": {long:0.5, short:0.5},
  "8316": {long:0.5, short:0.5},
};
const FAST_ENTRY_VOL_RATIO = 1.5;
const FAST_ENTRY_VOL_LOOKBACK = 20;
const SYMBOLS = ["8035","6857","6976","6526","5803","6981","285A","6146","6594","8316"];

interface C { t: string; o: number; h: number; l: number; c: number; v: number; }

async function main() {
  const conn = await mysql.createConnection(DATABASE_URL);
  const [dateRows] = await conn.query(`
    SELECT DISTINCT tradeDate FROM rt_candles 
    WHERE symbol = '8035' AND tradeDate <= '2026-08-18'
    ORDER BY tradeDate DESC LIMIT 20
  `) as any[];
  const dates = (dateRows as any[]).map(r => r.tradeDate).reverse();

  const [allRows] = await conn.query(`
    SELECT tradeDate, symbol, candleTime as t, open as o, high as h, low as l, close as c, volume as v
    FROM rt_candles WHERE tradeDate IN (${dates.map(d=>`'${d}'`).join(',')}) AND symbol IN (${SYMBOLS.map(s=>`'${s}'`).join(',')})
    ORDER BY tradeDate, symbol, candleTime
  `) as any[];

  const data: Record<string, Record<string, C[]>> = {};
  for (const r of allRows as any[]) {
    if (!data[r.tradeDate]) data[r.tradeDate] = {};
    if (!data[r.tradeDate][r.symbol]) data[r.tradeDate][r.symbol] = [];
    data[r.tradeDate][r.symbol].push({ t: r.t, o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c), v: Number(r.v) });
  }

  function detectRoundBreak(candles: C[]): {idx: number; level: number}[] {
    const breaks: {idx: number; level: number}[] = [];
    for (let i = 1; i < candles.length; i++) {
      const prev = candles[i-1];
      const curr = candles[i];
      const price = curr.c;
      let step: number;
      if (price >= 50000) step = 1000;
      else if (price >= 10000) step = 500;
      else if (price >= 5000) step = 100;
      else step = 50;
      const level = Math.ceil(prev.c / step) * step;
      if (prev.c >= level && curr.c < level) {
        breaks.push({ idx: i, level });
      }
    }
    return breaks;
  }

  console.log(`\n=== sell_pressureなしで追加される取引の詳細 ===\n`);
  console.log(`日付       | 銘柄 | 時刻  | 大台  | 価格     | 出来高倍率 | 陰線数 | 結果 | 損益`);
  console.log(`${"─".repeat(90)}`);

  for (const date of dates) {
    for (const symbol of SYMBOLS) {
      const candles = data[date]?.[symbol];
      if (!candles || candles.length < 30) continue;
      const breaks = detectRoundBreak(candles);
      const sl = SL_MAP[symbol].short;

      for (const brk of breaks) {
        const sigIdx = brk.idx;
        if (sigIdx < FAST_ENTRY_VOL_LOOKBACK) continue;
        const timeStr = candles[sigIdx].t;
        if (timeStr < "09:05" || timeStr > "14:30") continue;

        const recentVols = candles.slice(sigIdx - FAST_ENTRY_VOL_LOOKBACK, sigIdx);
        const avgVol = recentVols.reduce((s, c) => s + c.v, 0) / recentVols.length;
        const volRatio = avgVol > 0 ? candles[sigIdx].v / avgVol : 0;
        if (volRatio < FAST_ENTRY_VOL_RATIO) continue;

        const recent3 = candles.slice(Math.max(0, sigIdx - 2), sigIdx + 1);
        const bearCount = recent3.filter(c => c.c < c.o).length;
        const spCondition = bearCount >= 2;
        if (spCondition) continue; // sell_pressureありは除外（追加分のみ表示）

        const entryPrice = candles[sigIdx].c;
        const shares = Math.floor(3000000 / entryPrice / 100) * 100 || 100;
        const slPrice = entryPrice * (1 + sl / 100);
        const tpPrice = entryPrice * (1 - TP_PCT / 100);

        let result = "EOD";
        let pnl = 0;
        for (let j = sigIdx + 1; j < candles.length; j++) {
          if (candles[j].h >= slPrice) { result = "SL"; pnl = Math.round((entryPrice - slPrice) * shares); break; }
          if (candles[j].l <= tpPrice) { result = "TP"; pnl = Math.round((entryPrice - tpPrice) * shares); break; }
        }
        if (result === "EOD") {
          const lastC = candles[candles.length - 1].c;
          pnl = Math.round((entryPrice - lastC) * shares);
        }

        console.log(`${date} | ${symbol.padEnd(4)} | ${timeStr} | ${brk.level.toLocaleString().padStart(6)} | ${entryPrice.toLocaleString().padStart(8)}円 | ${volRatio.toFixed(2).padStart(5)}倍 | ${bearCount}本   | ${result.padEnd(3)} | ${pnl >= 0 ? "+" : ""}${pnl.toLocaleString()}円`);
      }
    }
  }

  await conn.end();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
