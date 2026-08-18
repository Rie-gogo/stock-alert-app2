import mysql from "mysql2/promise";
const DATABASE_URL = process.env.DATABASE_URL!;
const TP_PCT = 1.5;
const SL_MAP: Record<string, {long: number; short: number}> = {
  "8035": {long:0.5, short:0.8}, "6857": {long:0.6, short:0.6}, "6976": {long:0.6, short:0.8},
  "6526": {long:0.9, short:1.0}, "5803": {long:0.5, short:0.6}, "6981": {long:0.4, short:0.9},
  "285A": {long:0.8, short:0.6}, "6146": {long:0.8, short:0.8}, "6594": {long:0.5, short:0.5},
  "8316": {long:0.5, short:0.5}, "6920": {long:0.8, short:0.8},
};

async function main() {
  const conn = await mysql.createConnection(DATABASE_URL);
  
  const [blockRows] = await conn.query(`
    SELECT trade_date, symbol, candle_time, entry_price, confidence, signal_reason
    FROM rt_score0_blocks WHERE side = 'SHORT'
    ORDER BY trade_date, candle_time
  `) as any[];
  
  console.log(`=== SHORTスコア0ブロック検証 ===\n`);
  console.log(`ブロック件数: ${(blockRows as any[]).length}件\n`);

  const trades: any[] = [];

  for (const block of blockRows as any[]) {
    const { trade_date, symbol, candle_time, entry_price } = block;
    
    // 当日のrt_candlesを取得
    const [candleRows] = await conn.query(`
      SELECT candleTime as t, open as o, high as h, low as l, close as c, volume as v
      FROM rt_candles WHERE tradeDate = '${trade_date}' AND symbol = '${symbol}'
      ORDER BY candleTime
    `) as any[];
    const candles = (candleRows as any[]).map((r: any) => ({ t: r.t, o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c), v: Number(r.v) }));
    
    const entryIdx = candles.findIndex((c: any) => c.t === candle_time);
    if (entryIdx < 0) continue;

    const sl = SL_MAP[symbol]?.short || 0.8;
    const price = Number(entry_price);
    const shares = Math.floor(3000000 / price / 100) * 100 || 100;
    const slPrice = price * (1 + sl / 100);
    const tpPrice = price * (1 - TP_PCT / 100);

    let result = "EOD"; let pnl = 0; let exitTime = "";
    for (let j = entryIdx + 1; j < candles.length; j++) {
      if (candles[j].t >= "11:27" && candles[j].t < "11:30") { result = "前場決済"; pnl = Math.round((price - candles[j].c) * shares); exitTime = candles[j].t; break; }
      if (candles[j].t >= "15:25") { result = "大引け"; pnl = Math.round((price - candles[j].c) * shares); exitTime = candles[j].t; break; }
      if (candles[j].h >= slPrice) { result = "SL"; pnl = Math.round((price - slPrice) * shares); exitTime = candles[j].t; break; }
      if (candles[j].l <= tpPrice) { result = "TP"; pnl = Math.round((price - tpPrice) * shares); exitTime = candles[j].t; break; }
    }
    if (result === "EOD" && !exitTime) { pnl = Math.round((price - candles[candles.length-1].c) * shares); exitTime = candles[candles.length-1].t; }

    trades.push({ date: trade_date, symbol, time: candle_time, price, shares, result, pnl, exitTime, reason: block.signal_reason.substring(0, 40) });
  }

  // 結果表示
  console.log(`| # | 日付 | 時刻 | 銘柄 | エントリー | 決済 | 損益 | シグナル |`);
  console.log(`|---|------|------|------|-----------|------|------|----------|`);
  let totalPnl = 0;
  let wins = 0;
  for (let i = 0; i < trades.length; i++) {
    const t = trades[i];
    totalPnl += t.pnl;
    if (t.pnl > 0) wins++;
    console.log(`| ${i+1} | ${t.date} | ${t.time} | ${t.symbol} | @${t.price.toLocaleString()}円×${t.shares} | ${t.result}(${t.exitTime}) | ${t.pnl >= 0 ? "+" : ""}${t.pnl.toLocaleString()}円 | ${t.reason} |`);
  }

  console.log(`\n**合計: ${trades.length}件 ${wins}勝${trades.length-wins}敗 ${totalPnl >= 0 ? "+" : ""}${totalPnl.toLocaleString()}円**`);
  const gp = trades.filter(t => t.pnl > 0).reduce((s: number, t: any) => s + t.pnl, 0);
  const gl = Math.abs(trades.filter(t => t.pnl <= 0).reduce((s: number, t: any) => s + t.pnl, 0));
  console.log(`PF: ${gl > 0 ? (gp/gl).toFixed(2) : "∞"}`);
  console.log(`勝率: ${(wins/trades.length*100).toFixed(1)}%`);

  // 銘柄別
  console.log(`\n--- 銘柄別 ---`);
  const bySymbol: Record<string, {cnt:number;wins:number;pnl:number}> = {};
  for (const t of trades) {
    if (!bySymbol[t.symbol]) bySymbol[t.symbol] = {cnt:0,wins:0,pnl:0};
    bySymbol[t.symbol].cnt++;
    if (t.pnl > 0) bySymbol[t.symbol].wins++;
    bySymbol[t.symbol].pnl += t.pnl;
  }
  for (const [sym, v] of Object.entries(bySymbol).sort((a,b) => b[1].pnl - a[1].pnl)) {
    console.log(`  ${sym}: ${v.cnt}件 ${v.wins}勝${v.cnt-v.wins}敗 ${v.pnl >= 0 ? "+" : ""}${v.pnl.toLocaleString()}円`);
  }

  await conn.end();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
