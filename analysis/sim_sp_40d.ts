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
interface Trade { date: string; symbol: string; entryTime: string; entryPrice: number; result: string; pnl: number; volRatio: number; bearCount: number; }

async function main() {
  const conn = await mysql.createConnection(DATABASE_URL);
  
  // 直近40営業日取得
  const [dateRows] = await conn.query(`
    SELECT DISTINCT tradeDate FROM rt_candles 
    WHERE symbol = '8035' AND tradeDate <= '2026-08-18'
    ORDER BY tradeDate DESC LIMIT 40
  `) as any[];
  const dates = (dateRows as any[]).map(r => r.tradeDate).reverse();
  console.log(`対象期間: ${dates[0]} 〜 ${dates[dates.length-1]} (${dates.length}営業日)\n`);

  // 全データ取得
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

  const tradesWithSP: Trade[] = [];
  const tradesNoSP: Trade[] = [];

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
        const volCondition = volRatio >= FAST_ENTRY_VOL_RATIO;

        const recent3 = candles.slice(Math.max(0, sigIdx - 2), sigIdx + 1);
        const bearCount = recent3.filter(c => c.c < c.o).length;
        const spCondition = bearCount >= 2;

        if (!volCondition) continue;

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

        tradesNoSP.push({ date, symbol, entryTime: timeStr, entryPrice, result, pnl, volRatio, bearCount });
        if (spCondition) {
          tradesWithSP.push({ date, symbol, entryTime: timeStr, entryPrice, result, pnl, volRatio, bearCount });
        }
      }
    }
  }

  function summarize(trades: Trade[], label: string) {
    const wins = trades.filter(t => t.pnl > 0).length;
    const losses = trades.filter(t => t.pnl <= 0).length;
    const total = trades.reduce((s, t) => s + t.pnl, 0);
    const winRate = trades.length > 0 ? (wins / trades.length * 100).toFixed(1) : "0";
    const avgWin = wins > 0 ? Math.round(trades.filter(t=>t.pnl>0).reduce((s,t)=>s+t.pnl,0)/wins) : 0;
    const avgLoss = losses > 0 ? Math.round(trades.filter(t=>t.pnl<=0).reduce((s,t)=>s+t.pnl,0)/losses) : 0;
    const grossProfit = trades.filter(t=>t.pnl>0).reduce((s,t)=>s+t.pnl,0);
    const grossLoss = Math.abs(trades.filter(t=>t.pnl<=0).reduce((s,t)=>s+t.pnl,0));
    const pf = grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : "∞";
    console.log(`\n【${label}】`);
    console.log(`  取引数: ${trades.length}件 (${wins}勝${losses}敗)`);
    console.log(`  勝率: ${winRate}%`);
    console.log(`  合計損益: ${total >= 0 ? "+" : ""}${total.toLocaleString()}円`);
    console.log(`  平均利益: +${avgWin.toLocaleString()}円 / 平均損失: ${avgLoss.toLocaleString()}円`);
    console.log(`  PF: ${pf}`);
    console.log(`  1日あたり: ${(total / dates.length).toFixed(0)}円/日`);
  }

  console.log(`${"=".repeat(60)}`);
  console.log(`即エントリー条件: sell_pressureの必要性検証（40営業日）`);
  console.log(`${"=".repeat(60)}`);
  
  summarize(tradesWithSP, "A: sell_pressure + 出来高1.5倍（現行）");
  summarize(tradesNoSP, "B: 出来高1.5倍のみ（sell_pressureなし）");

  const additionalTrades = tradesNoSP.filter(t => !tradesWithSP.some(w => w.date === t.date && w.symbol === t.symbol && w.entryTime === t.entryTime));
  summarize(additionalTrades, "C: sell_pressureなしで追加される取引");

  // 追加取引の詳細
  console.log(`\n\n=== 追加される取引の全詳細 ===\n`);
  console.log(`日付       | 銘柄 | 時刻  | 価格       | 出来高倍率 | 陰線 | 結果 | 損益`);
  console.log(`${"─".repeat(85)}`);
  for (const t of additionalTrades) {
    console.log(`${t.date} | ${t.symbol.padEnd(4)} | ${t.entryTime} | ${t.entryPrice.toLocaleString().padStart(8)}円 | ${t.volRatio.toFixed(2).padStart(5)}倍 | ${t.bearCount}本  | ${t.result.padEnd(3)} | ${t.pnl >= 0 ? "+" : ""}${t.pnl.toLocaleString()}円`);
  }

  // 銘柄別集計
  console.log(`\n\n=== 銘柄別比較 ===\n`);
  for (const sym of SYMBOLS) {
    const a = tradesWithSP.filter(t => t.symbol === sym);
    const b = tradesNoSP.filter(t => t.symbol === sym);
    if (b.length === 0) continue;
    const aWin = a.filter(t=>t.pnl>0).length;
    const bWin = b.filter(t=>t.pnl>0).length;
    const aTotal = a.reduce((s,t)=>s+t.pnl,0);
    const bTotal = b.reduce((s,t)=>s+t.pnl,0);
    console.log(`${sym}: A=${a.length}件(${aWin}勝) ${aTotal>=0?"+":""}${aTotal.toLocaleString()}円 → B=${b.length}件(${bWin}勝) ${bTotal>=0?"+":""}${bTotal.toLocaleString()}円 [差分: ${(bTotal-aTotal)>=0?"+":""}${(bTotal-aTotal).toLocaleString()}円]`);
  }

  await conn.end();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
