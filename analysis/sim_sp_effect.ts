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

interface C { t: string; o: number; h: number; l: number; c: number; v: number; }

async function main() {
  const conn = await mysql.createConnection(DATABASE_URL);
  
  // 40営業日
  const [dateRows] = await conn.query(`
    SELECT DISTINCT tradeDate FROM rt_candles 
    WHERE symbol = '8035' AND tradeDate <= '2026-08-18'
    ORDER BY tradeDate DESC LIMIT 40
  `) as any[];
  const dates = (dateRows as any[]).map(r => r.tradeDate).reverse();
  console.log(`対象期間: ${dates[0]} 〜 ${dates[dates.length-1]} (${dates.length}営業日)\n`);

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

  // ダウ理論LONGシグナル検出（直近高値更新）
  function detectDowLong(candles: C[], idx: number): boolean {
    if (idx < 20) return false;
    // 直近20本の最高値を更新
    const recentHighs = candles.slice(idx - 20, idx).map(c => c.h);
    const maxHigh = Math.max(...recentHighs);
    return candles[idx].h > maxHigh;
  }

  // sell_pressure判定
  function isSellPressure(candles: C[], idx: number): boolean {
    const recent3 = candles.slice(Math.max(0, idx - 2), idx + 1);
    const bearCount = recent3.filter(c => c.c < c.o).length;
    return bearCount >= 2;
  }

  interface Trade { date: string; symbol: string; time: string; price: number; result: string; pnl: number; }
  const blockedTrades: Trade[] = []; // sell_pressureでブロックされるLONG
  const passedTrades: Trade[] = [];  // sell_pressureなしで通過するLONG

  for (const date of dates) {
    for (const symbol of SYMBOLS) {
      const candles = data[date]?.[symbol];
      if (!candles || candles.length < 25) continue;
      const sl = SL_MAP[symbol].long;
      let lastEntryIdx = -10; // 同一銘柄で連続エントリー防止

      for (let i = 20; i < candles.length - 1; i++) {
        if (candles[i].t < "09:05" || candles[i].t > "14:30") continue;
        if (i - lastEntryIdx < 10) continue; // 最低10本間隔

        if (detectDowLong(candles, i)) {
          const sp = isSellPressure(candles, i);
          const entryPrice = candles[i].c;
          const shares = Math.floor(3000000 / entryPrice / 100) * 100 || 100;
          const slPrice = entryPrice * (1 - sl / 100);
          const tpPrice = entryPrice * (1 + TP_PCT / 100);

          let result = "EOD";
          let pnl = 0;
          for (let j = i + 1; j < candles.length; j++) {
            if (candles[j].l <= slPrice) { result = "SL"; pnl = Math.round((slPrice - entryPrice) * shares); break; }
            if (candles[j].h >= tpPrice) { result = "TP"; pnl = Math.round((tpPrice - entryPrice) * shares); break; }
          }
          if (result === "EOD") {
            const lastC = candles[candles.length - 1].c;
            pnl = Math.round((lastC - entryPrice) * shares);
          }

          const trade = { date, symbol, time: candles[i].t, price: entryPrice, result, pnl };
          if (sp) {
            blockedTrades.push(trade);
          } else {
            passedTrades.push(trade);
          }
          lastEntryIdx = i;
        }
      }
    }
  }

  function summarize(trades: Trade[], label: string) {
    if (trades.length === 0) { console.log(`\n【${label}】 0件`); return; }
    const wins = trades.filter(t => t.pnl > 0).length;
    const losses = trades.filter(t => t.pnl <= 0).length;
    const total = trades.reduce((s, t) => s + t.pnl, 0);
    const winRate = (wins / trades.length * 100).toFixed(1);
    const avgWin = wins > 0 ? Math.round(trades.filter(t=>t.pnl>0).reduce((s,t)=>s+t.pnl,0)/wins) : 0;
    const avgLoss = losses > 0 ? Math.round(trades.filter(t=>t.pnl<=0).reduce((s,t)=>s+t.pnl,0)/losses) : 0;
    const grossProfit = trades.filter(t=>t.pnl>0).reduce((s,t)=>s+t.pnl,0);
    const grossLoss = Math.abs(trades.filter(t=>t.pnl<=0).reduce((s,t)=>s+t.pnl,0));
    const pf = grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : "∞";
    console.log(`\n【${label}】`);
    console.log(`  ${trades.length}件 (${wins}勝${losses}敗) 勝率${winRate}%`);
    console.log(`  合計損益: ${total >= 0 ? "+" : ""}${total.toLocaleString()}円`);
    console.log(`  平均利益: +${avgWin.toLocaleString()}円 / 平均損失: ${avgLoss.toLocaleString()}円`);
    console.log(`  PF: ${pf}`);
  }

  console.log(`${"=".repeat(60)}`);
  console.log(`sell_pressureフィルターの効果検証（ダウ理論LONG）`);
  console.log(`${"=".repeat(60)}`);
  
  summarize(blockedTrades, "sell_pressure時のLONG（ブロック対象 → もしエントリーしていたら）");
  summarize(passedTrades, "sell_pressureなし時のLONG（通過）");

  // 全体（フィルターなし）
  const allTrades = [...blockedTrades, ...passedTrades];
  summarize(allTrades, "全体（sell_pressureフィルターなし）");

  console.log(`\n\n--- フィルターの効果まとめ ---`);
  const blockedTotal = blockedTrades.reduce((s,t)=>s+t.pnl, 0);
  const passedTotal = passedTrades.reduce((s,t)=>s+t.pnl, 0);
  console.log(`  ブロックされる取引の損益: ${blockedTotal >= 0 ? "+" : ""}${blockedTotal.toLocaleString()}円`);
  console.log(`  → ブロックが${blockedTotal <= 0 ? "正しい（マイナス取引を防いでいる）" : "間違い（プラス取引を逃している）"}`);
  
  const blockedWinRate = blockedTrades.length > 0 ? (blockedTrades.filter(t=>t.pnl>0).length / blockedTrades.length * 100).toFixed(1) : "0";
  const passedWinRate = passedTrades.length > 0 ? (passedTrades.filter(t=>t.pnl>0).length / passedTrades.length * 100).toFixed(1) : "0";
  console.log(`  ブロック対象の勝率: ${blockedWinRate}% vs 通過の勝率: ${passedWinRate}%`);

  await conn.end();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
