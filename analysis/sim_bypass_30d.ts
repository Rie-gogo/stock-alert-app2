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

async function main() {
  const conn = await mysql.createConnection(DATABASE_URL);
  
  // 30営業日取得
  const [dateRows] = await conn.query(`
    SELECT DISTINCT tradeDate FROM rt_candles WHERE symbol = '8035' AND tradeDate <= '2026-08-18'
    ORDER BY tradeDate DESC LIMIT 30
  `) as any[];
  const dates = (dateRows as any[]).map((r: any) => r.tradeDate).reverse();
  console.log(`対象期間: ${dates[0]} 〜 ${dates[dates.length-1]} (${dates.length}営業日)\n`);

  // 前日バッファ用
  const [prevDateRows] = await conn.query(`
    SELECT DISTINCT tradeDate FROM rt_candles WHERE symbol = '8035' AND tradeDate < '${dates[0]}'
    ORDER BY tradeDate DESC LIMIT 1
  `) as any[];
  const prevDate = (prevDateRows as any[])[0]?.tradeDate;
  const allDates = prevDate ? [prevDate, ...dates] : dates;

  const [allRows] = await conn.query(`
    SELECT tradeDate, symbol, candleTime as t, open as o, high as h, low as l, close as c, volume as v
    FROM rt_candles WHERE tradeDate IN (${allDates.map((d: string) => `'${d}'`).join(',')})
      AND symbol IN (${SYMBOLS.map(s => `'${s}'`).join(',')})
    ORDER BY symbol, tradeDate, candleTime
  `) as any[];

  const buffers: Record<string, {date: string; candle: {t:string;o:number;h:number;l:number;c:number;v:number}}[]> = {};
  for (const r of allRows as any[]) {
    if (!buffers[r.symbol]) buffers[r.symbol] = [];
    buffers[r.symbol].push({ date: String(r.tradeDate), candle: { t: r.t, o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c), v: Number(r.v) } });
  }

  // スコア0ブロック対象を取得
  const [blockRows] = await conn.query(`
    SELECT trade_date, symbol, candle_time, entry_price, confidence, side, signal_reason
    FROM rt_score0_blocks 
    WHERE trade_date IN (${dates.map((d: string) => `'${d}'`).join(',')}) AND side = 'BUY'
    ORDER BY trade_date, candle_time
  `) as any[];
  console.log(`スコア0ブロック(BUY): ${(blockRows as any[]).length}件\n`);

  // 緩和A: MA乖離<0.5%, 実体<0.2%, 陰線≤4本
  const CONFIG = { maDev: 0.5, body: 0.2, bear: 4 };
  
  const trades: any[] = [];
  const blockedByReason: Record<string, number> = {};

  for (const block of blockRows as any[]) {
    const { trade_date, symbol, candle_time, entry_price, signal_reason } = block;
    const buf = buffers[symbol];
    if (!buf) continue;

    const entryIdx = buf.findIndex(b => String(b.date) === String(trade_date) && b.candle.t === candle_time);
    if (entryIdx < 21) continue;

    // isBullish計算
    const window = buf.slice(entryIdx - 19, entryIdx + 1).map(b => b.candle);
    const prevWindow = buf.slice(entryIdx - 20, entryIdx).map(b => b.candle);
    const ma20 = window.reduce((s, c) => s + c.c, 0) / 20;
    const prevMa20 = prevWindow.reduce((s, c) => s + c.c, 0) / 20;
    const slope = (ma20 - prevMa20) / prevMa20 * 100;
    const isBullish = slope > 0;
    
    if (!isBullish) { blockedByReason["isBullish=false"] = (blockedByReason["isBullish=false"] || 0) + 1; continue; }

    const maDeviation = Math.abs(buf[entryIdx].candle.c - ma20) / ma20 * 100;
    const bodyPct = Math.abs(buf[entryIdx].candle.c - buf[entryIdx].candle.o) / buf[entryIdx].candle.o * 100;
    const recent10 = buf.slice(Math.max(0, entryIdx - 9), entryIdx + 1).map(b => b.candle);
    const bearBars = recent10.filter(c => c.c < c.o).length;

    const bypass = maDeviation < CONFIG.maDev && bodyPct < CONFIG.body && bearBars <= CONFIG.bear;
    if (!bypass) {
      const reasons: string[] = [];
      if (maDeviation >= CONFIG.maDev) reasons.push("MA乖離");
      if (bodyPct >= CONFIG.body) reasons.push("実体");
      if (bearBars > CONFIG.bear) reasons.push("陰線");
      const key = reasons.join("+");
      blockedByReason[key] = (blockedByReason[key] || 0) + 1;
      continue;
    }

    // シミュレーション
    const sl = SL_MAP[symbol]?.long || 0.5;
    const price = Number(entry_price);
    const shares = Math.floor(3000000 / price / 100) * 100 || 100;
    const slPrice = price * (1 - sl / 100);
    const tpPrice = price * (1 + TP_PCT / 100);

    const todayBuf = buf.filter(b => String(b.date) === String(trade_date)).map(b => b.candle);
    const todayIdx = todayBuf.findIndex(c => c.t === candle_time);
    let result = "EOD"; let pnl = 0; let exitTime = "";
    if (todayIdx >= 0) {
      for (let j = todayIdx + 1; j < todayBuf.length; j++) {
        if (todayBuf[j].t >= "11:27" && todayBuf[j].t < "11:30") { result = "前場決済"; pnl = Math.round((todayBuf[j].c - price) * shares); exitTime = todayBuf[j].t; break; }
        if (todayBuf[j].t >= "15:25") { result = "大引け"; pnl = Math.round((todayBuf[j].c - price) * shares); exitTime = todayBuf[j].t; break; }
        if (todayBuf[j].l <= slPrice) { result = "SL"; pnl = Math.round((slPrice - price) * shares); exitTime = todayBuf[j].t; break; }
        if (todayBuf[j].h >= tpPrice) { result = "TP"; pnl = Math.round((tpPrice - price) * shares); exitTime = todayBuf[j].t; break; }
      }
      if (result === "EOD") { pnl = Math.round((todayBuf[todayBuf.length-1].c - price) * shares); exitTime = todayBuf[todayBuf.length-1].t; }
    }
    trades.push({ date: trade_date, symbol, time: candle_time, price, pnl, result, exitTime, shares, signal_reason });
  }

  // サマリー
  const wins = trades.filter(t => t.pnl > 0).length;
  const gp = trades.filter(t => t.pnl > 0).reduce((s: number, t: any) => s + t.pnl, 0);
  const gl = Math.abs(trades.filter(t => t.pnl <= 0).reduce((s: number, t: any) => s + t.pnl, 0));
  const pf = gl > 0 ? (gp / gl).toFixed(2) : "∞";
  const totalPnl = trades.reduce((s: number, t: any) => s + t.pnl, 0);

  console.log(`=== 緩和A（MA乖離<0.5% / 実体<0.2% / 陰線≤4本）30営業日 ===\n`);
  console.log(`適用件数: ${trades.length}件`);
  console.log(`勝率: ${(wins/trades.length*100).toFixed(1)}% (${wins}勝${trades.length-wins}敗)`);
  console.log(`損益: ${totalPnl >= 0 ? "+" : ""}${totalPnl.toLocaleString()}円`);
  console.log(`PF: ${pf}`);
  console.log(`1件平均: ${Math.round(totalPnl/trades.length).toLocaleString()}円`);
  console.log(`1日平均: ${Math.round(totalPnl/30).toLocaleString()}円\n`);

  // ブロック理由
  console.log(`--- ブロック内訳（バイパス不適用） ---`);
  for (const [reason, cnt] of Object.entries(blockedByReason).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${reason}: ${cnt}件`);
  }

  // 銘柄別
  console.log(`\n--- 銘柄別 ---`);
  const bySymbol: Record<string, {cnt: number; wins: number; pnl: number}> = {};
  for (const t of trades) {
    if (!bySymbol[t.symbol]) bySymbol[t.symbol] = {cnt:0, wins:0, pnl:0};
    bySymbol[t.symbol].cnt++;
    if (t.pnl > 0) bySymbol[t.symbol].wins++;
    bySymbol[t.symbol].pnl += t.pnl;
  }
  console.log(`| 銘柄 | 件数 | 勝敗 | 損益 |`);
  console.log(`|------|------|------|------|`);
  for (const [sym, v] of Object.entries(bySymbol).sort((a, b) => b[1].pnl - a[1].pnl)) {
    console.log(`| ${sym} | ${v.cnt}件 | ${v.wins}勝${v.cnt-v.wins}敗 | ${v.pnl >= 0 ? "+" : ""}${v.pnl.toLocaleString()}円 |`);
  }

  // 決済理由別
  console.log(`\n--- 決済理由別 ---`);
  const byResult: Record<string, {cnt: number; pnl: number}> = {};
  for (const t of trades) {
    if (!byResult[t.result]) byResult[t.result] = {cnt:0, pnl:0};
    byResult[t.result].cnt++;
    byResult[t.result].pnl += t.pnl;
  }
  for (const [r, v] of Object.entries(byResult)) {
    console.log(`  ${r}: ${v.cnt}件 ${v.pnl >= 0 ? "+" : ""}${v.pnl.toLocaleString()}円`);
  }

  // 全取引詳細
  console.log(`\n--- 全取引詳細 ---`);
  console.log(`| 日付 | 時刻 | 銘柄 | エントリー | 決済 | 損益 |`);
  console.log(`|------|------|------|-----------|------|------|`);
  for (const t of trades) {
    console.log(`| ${t.date} | ${t.time} | ${t.symbol} | @${t.price.toLocaleString()}円×${t.shares} | ${t.result}(${t.exitTime}) | ${t.pnl >= 0 ? "+" : ""}${t.pnl.toLocaleString()}円 |`);
  }

  await conn.end();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
