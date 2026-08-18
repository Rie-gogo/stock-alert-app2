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
  
  const [dateRows] = await conn.query(`
    SELECT DISTINCT tradeDate FROM rt_candles WHERE symbol = '8035' AND tradeDate <= '2026-08-18'
    ORDER BY tradeDate DESC LIMIT 20
  `) as any[];
  const dates = (dateRows as any[]).map((r: any) => r.tradeDate).reverse();
  console.log(`対象期間: ${dates[0]} 〜 ${dates[dates.length-1]} (${dates.length}営業日)\n`);

  // 各銘柄について前日バッファ込みでデータ取得
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

  const buffers: Record<string, {date: string; candle: C}[]> = {};
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

  // 閾値パターン
  const configs = [
    { name: "現行(0.3%/0.1%/3本)", maDev: 0.3, body: 0.1, bear: 3 },
    { name: "緩和A(0.5%/0.2%/4本)", maDev: 0.5, body: 0.2, bear: 4 },
    { name: "緩和B(0.5%/0.1%/3本)", maDev: 0.5, body: 0.1, bear: 3 },
    { name: "緩和C(0.3%/0.2%/4本)", maDev: 0.3, body: 0.2, bear: 4 },
    { name: "緩和D(0.5%/0.2%/5本)", maDev: 0.5, body: 0.2, bear: 5 },
    { name: "緩和E(1.0%/0.3%/5本)", maDev: 1.0, body: 0.3, bear: 5 },
    { name: "全許可(isBullishのみ)", maDev: 999, body: 999, bear: 999 },
  ];

  const results: Record<string, {cnt: number; wins: number; pnl: number; details: any[]}> = {};

  for (const config of configs) {
    const trades: any[] = [];

    for (const block of blockRows as any[]) {
      const { trade_date, symbol, candle_time, entry_price } = block;
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
      if (!isBullish) continue; // isBullishでなければどの設定でもブロック

      const maDeviation = Math.abs(buf[entryIdx].candle.c - ma20) / ma20 * 100;
      const bodyPct = Math.abs(buf[entryIdx].candle.c - buf[entryIdx].candle.o) / buf[entryIdx].candle.o * 100;
      const recent10 = buf.slice(Math.max(0, entryIdx - 9), entryIdx + 1).map(b => b.candle);
      const bearBars = recent10.filter(c => c.c < c.o).length;

      const bypass = maDeviation < config.maDev && bodyPct < config.body && bearBars <= config.bear;
      if (!bypass) continue;

      // シミュレーション
      const sl = SL_MAP[symbol]?.long || 0.5;
      const price = Number(entry_price);
      const shares = Math.floor(3000000 / price / 100) * 100 || 100;
      const slPrice = price * (1 - sl / 100);
      const tpPrice = price * (1 + TP_PCT / 100);

      const todayBuf = buf.filter(b => String(b.date) === String(trade_date)).map(b => b.candle);
      const todayIdx = todayBuf.findIndex(c => c.t === candle_time);
      let result = "EOD"; let pnl = 0;
      if (todayIdx >= 0) {
        for (let j = todayIdx + 1; j < todayBuf.length; j++) {
          if (todayBuf[j].t >= "11:27" && todayBuf[j].t < "11:30") { result = "前場決済"; pnl = Math.round((todayBuf[j].c - price) * shares); break; }
          if (todayBuf[j].t >= "15:25") { result = "大引け"; pnl = Math.round((todayBuf[j].c - price) * shares); break; }
          if (todayBuf[j].l <= slPrice) { result = "SL"; pnl = Math.round((slPrice - price) * shares); break; }
          if (todayBuf[j].h >= tpPrice) { result = "TP"; pnl = Math.round((tpPrice - price) * shares); break; }
        }
        if (result === "EOD") { pnl = Math.round((todayBuf[todayBuf.length-1].c - price) * shares); }
      }
      trades.push({ date: trade_date, symbol, time: candle_time, price, pnl, result });
    }

    results[config.name] = { cnt: trades.length, wins: trades.filter(t => t.pnl > 0).length, pnl: trades.reduce((s, t) => s + t.pnl, 0), details: trades };
  }

  // 結果表示
  console.log(`| 閾値設定 | 適用件数 | 勝率 | 損益 | PF | 1件平均 |`);
  console.log(`|----------|----------|------|------|-----|---------|`);
  for (const config of configs) {
    const r = results[config.name];
    const losses = r.cnt - r.wins;
    const gp = r.details.filter(t => t.pnl > 0).reduce((s: number, t: any) => s + t.pnl, 0);
    const gl = Math.abs(r.details.filter(t => t.pnl <= 0).reduce((s: number, t: any) => s + t.pnl, 0));
    const pf = gl > 0 ? (gp / gl).toFixed(2) : "∞";
    const avg = r.cnt > 0 ? Math.round(r.pnl / r.cnt) : 0;
    const winRate = r.cnt > 0 ? (r.wins / r.cnt * 100).toFixed(1) : "-";
    console.log(`| ${config.name} | ${r.cnt}件 | ${winRate}% (${r.wins}勝${losses}敗) | ${r.pnl >= 0 ? "+" : ""}${r.pnl.toLocaleString()}円 | ${pf} | ${avg >= 0 ? "+" : ""}${avg.toLocaleString()}円 |`);
  }

  // 緩和Aの詳細（8/17分）
  console.log(`\n\n--- 緩和A(0.5%/0.2%/4本)の8/17分 ---\n`);
  const aDetails = results["緩和A(0.5%/0.2%/4本)"].details.filter((t: any) => String(t.date) === '2026-08-17');
  for (const t of aDetails) {
    console.log(`  ${t.time} ${t.symbol} @${t.price}円 → ${t.result} ${t.pnl >= 0 ? "+" : ""}${t.pnl.toLocaleString()}円`);
  }

  await conn.end();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
