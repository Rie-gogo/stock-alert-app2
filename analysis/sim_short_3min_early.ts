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
  
  // 20営業日取得
  const [dateRows] = await conn.query(`
    SELECT DISTINCT tradeDate FROM rt_candles 
    WHERE symbol = '8035' AND tradeDate <= '2026-08-18'
    ORDER BY tradeDate DESC LIMIT 20
  `) as any[];
  const dates = (dateRows as any[]).map((r: any) => r.tradeDate).reverse();
  console.log(`対象期間: ${dates[0]} 〜 ${dates[dates.length-1]} (${dates.length}営業日)\n`);

  // 実際のSHORTエントリーを取得
  const [shortEntries] = await conn.query(`
    SELECT t1.tradeDate, t1.symbol, t1.tradeTime as entryTime, t1.price as entryPrice, 
           t1.shares, t1.reason,
           t2.price as exitPrice, t2.pnl, t2.reason as exitReason
    FROM rt_trades t1
    LEFT JOIN rt_trades t2 ON t1.tradeDate = t2.tradeDate AND t1.symbol = t2.symbol 
      AND t2.action = 'cover' AND t2.side = 'short'
    WHERE t1.action = 'short' AND t1.side = 'short' 
      AND t1.tradeDate IN (${dates.map((d: string) => `'${d}'`).join(',')})
    ORDER BY t1.tradeDate, t1.tradeTime
  `) as any[];

  console.log(`SHORTエントリー件数: ${(shortEntries as any[]).length}件\n`);

  // 全rt_candlesデータ取得
  const [allCandles] = await conn.query(`
    SELECT tradeDate, symbol, candleTime as t, open as o, high as h, low as l, close as c, volume as v
    FROM rt_candles WHERE tradeDate IN (${dates.map((d: string) => `'${d}'`).join(',')}) 
      AND symbol IN (${SYMBOLS.map(s => `'${s}'`).join(',')})
    ORDER BY tradeDate, symbol, candleTime
  `) as any[];

  const data: Record<string, Record<string, C[]>> = {};
  for (const r of allCandles as any[]) {
    if (!data[r.tradeDate]) data[r.tradeDate] = {};
    if (!data[r.tradeDate][r.symbol]) data[r.tradeDate][r.symbol] = [];
    data[r.tradeDate][r.symbol].push({ t: r.t, o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c), v: Number(r.v) });
  }

  // 3分前の足のclose価格でエントリーした場合をシミュレーション
  interface TradeResult {
    date: string; symbol: string; entryTime: string; 
    currentPrice: number; earlyPrice: number;
    currentPnl: number; earlyPnl: number;
    currentResult: string; earlyResult: string;
    shares: number;
  }
  const results: TradeResult[] = [];

  for (const entry of shortEntries as any[]) {
    const { tradeDate, symbol, entryTime, entryPrice, shares, pnl, exitReason } = entry;
    const candles = data[tradeDate]?.[symbol];
    if (!candles || candles.length < 5) continue;

    const sl = SL_MAP[symbol]?.short || 0.8;
    const currentShares = Number(shares) || 100;
    const currentEntryPrice = Number(entryPrice);
    const currentPnl = Number(pnl) || 0;

    // エントリー時刻の3分前を計算
    const [hh, mm] = entryTime.split(":").map(Number);
    const earlyMin = mm - 3;
    const earlyHH = earlyMin < 0 ? hh - 1 : hh;
    const earlyMM = earlyMin < 0 ? earlyMin + 60 : earlyMin;
    const earlyTime = `${String(earlyHH).padStart(2, "0")}:${String(earlyMM).padStart(2, "0")}`;

    // 3分前の足を探す
    const earlyIdx = candles.findIndex(c => c.t === earlyTime);
    if (earlyIdx < 0) continue;

    const earlyEntryPrice = candles[earlyIdx].c;
    const slPrice = earlyEntryPrice * (1 + sl / 100);
    const tpPrice = earlyEntryPrice * (1 - TP_PCT / 100);

    // 3分前エントリーの損益シミュレーション
    let earlyResult = "EOD";
    let earlyPnl = 0;
    for (let j = earlyIdx + 1; j < candles.length; j++) {
      if (candles[j].t >= "11:27" && candles[j].t < "11:30") {
        // 前場強制決済
        earlyResult = "AM_CLOSE";
        earlyPnl = Math.round((earlyEntryPrice - candles[j].c) * currentShares);
        break;
      }
      if (candles[j].h >= slPrice) { 
        earlyResult = "SL"; 
        earlyPnl = Math.round((earlyEntryPrice - slPrice) * currentShares); 
        break; 
      }
      if (candles[j].l <= tpPrice) { 
        earlyResult = "TP"; 
        earlyPnl = Math.round((earlyEntryPrice - tpPrice) * currentShares); 
        break; 
      }
    }
    if (earlyResult === "EOD") {
      const lastC = candles[candles.length - 1].c;
      earlyPnl = Math.round((earlyEntryPrice - lastC) * currentShares);
    }

    // 現行の結果
    let currentResult = "EOD";
    if (exitReason?.includes("損切り") || exitReason?.includes("SL")) currentResult = "SL";
    else if (exitReason?.includes("利確") || exitReason?.includes("TP")) currentResult = "TP";
    else if (exitReason?.includes("強制")) currentResult = "FORCE";

    results.push({
      date: tradeDate, symbol, entryTime,
      currentPrice: currentEntryPrice, earlyPrice: earlyEntryPrice,
      currentPnl, earlyPnl,
      currentResult, earlyResult,
      shares: currentShares,
    });
  }

  // 集計
  const totalCurrent = results.reduce((s, r) => s + r.currentPnl, 0);
  const totalEarly = results.reduce((s, r) => s + r.earlyPnl, 0);
  const currentWins = results.filter(r => r.currentPnl > 0).length;
  const earlyWins = results.filter(r => r.earlyPnl > 0).length;

  console.log(`${"=".repeat(70)}`);
  console.log(`ショートエントリー 3分早めた場合の比較（20営業日）`);
  console.log(`${"=".repeat(70)}\n`);

  console.log(`| 指標 | 現行 | 3分早い | 差分 |`);
  console.log(`|------|------|---------|------|`);
  console.log(`| 取引数 | ${results.length}件 | ${results.length}件 | - |`);
  console.log(`| 勝数 | ${currentWins}勝 | ${earlyWins}勝 | ${earlyWins - currentWins >= 0 ? "+" : ""}${earlyWins - currentWins} |`);
  console.log(`| 勝率 | ${(currentWins/results.length*100).toFixed(1)}% | ${(earlyWins/results.length*100).toFixed(1)}% | ${((earlyWins-currentWins)/results.length*100).toFixed(1)}pt |`);
  console.log(`| 合計損益 | ${totalCurrent >= 0 ? "+" : ""}${totalCurrent.toLocaleString()}円 | ${totalEarly >= 0 ? "+" : ""}${totalEarly.toLocaleString()}円 | ${(totalEarly-totalCurrent) >= 0 ? "+" : ""}${(totalEarly-totalCurrent).toLocaleString()}円 |`);

  // 詳細一覧
  console.log(`\n\n--- 取引詳細 ---\n`);
  console.log(`日付       | 銘柄 | 時刻  | 現行価格  | 3分前価格 | 現行損益     | 3分前損益     | 差分`);
  console.log(`${"─".repeat(100)}`);
  for (const r of results) {
    const diff = r.earlyPnl - r.currentPnl;
    console.log(`${r.date} | ${r.symbol.padEnd(4)} | ${r.entryTime} | ${r.currentPrice.toLocaleString().padStart(8)}円 | ${r.earlyPrice.toLocaleString().padStart(8)}円 | ${(r.currentPnl >= 0 ? "+" : "") + r.currentPnl.toLocaleString().padStart(8)}円(${r.currentResult.padEnd(3)}) | ${(r.earlyPnl >= 0 ? "+" : "") + r.earlyPnl.toLocaleString().padStart(8)}円(${r.earlyResult.padEnd(3)}) | ${(diff >= 0 ? "+" : "") + diff.toLocaleString()}円`);
  }

  // 銘柄別集計
  console.log(`\n\n--- 銘柄別集計 ---\n`);
  const bySymbol: Record<string, {current: number; early: number; cnt: number}> = {};
  for (const r of results) {
    if (!bySymbol[r.symbol]) bySymbol[r.symbol] = {current: 0, early: 0, cnt: 0};
    bySymbol[r.symbol].current += r.currentPnl;
    bySymbol[r.symbol].early += r.earlyPnl;
    bySymbol[r.symbol].cnt++;
  }
  console.log(`| 銘柄 | 件数 | 現行損益 | 3分前損益 | 差分 |`);
  console.log(`|------|------|----------|----------|------|`);
  for (const [sym, v] of Object.entries(bySymbol).sort((a,b) => (b[1].early - b[1].current) - (a[1].early - a[1].current))) {
    const diff = v.early - v.current;
    console.log(`| ${sym} | ${v.cnt}件 | ${v.current >= 0 ? "+" : ""}${v.current.toLocaleString()}円 | ${v.early >= 0 ? "+" : ""}${v.early.toLocaleString()}円 | ${diff >= 0 ? "+" : ""}${diff.toLocaleString()}円 |`);
  }

  await conn.end();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
