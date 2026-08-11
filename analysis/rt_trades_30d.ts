/**
 * rt_tradesテーブルから直近30日間の実績を集計
 * 本番エンジンの実際の取引記録
 */
import mysql from "mysql2/promise";

async function main() {
  const dbUrl = new URL(process.env.DATABASE_URL!.replace(/\?ssl=.*$/, ""));
  const conn = await mysql.createConnection({
    host: dbUrl.hostname,
    port: parseInt(dbUrl.port || "4000"),
    user: decodeURIComponent(dbUrl.username),
    password: decodeURIComponent(dbUrl.password),
    database: dbUrl.pathname.slice(1),
    ssl: { rejectUnauthorized: true },
  });

  // rt_tradesから決済済み取引を集計（action = 'sell' or 'cover'）
  const [rows] = await conn.query(`
    SELECT 
      tradeDate,
      symbol,
      action,
      price,
      shares,
      pnl,
      tradeTime,
      reason
    FROM rt_trades
    WHERE (action = 'sell' OR action = 'cover')
      AND pnl IS NOT NULL
    ORDER BY tradeDate ASC, tradeTime ASC
  `);
  
  const trades = rows as any[];
  
  if (trades.length === 0) {
    console.log("rt_tradesに決済済み取引がありません。");
    await conn.end();
    process.exit(0);
  }
  
  // 日別集計
  const dailyMap = new Map<string, { pnl: number; trades: number; wins: number; details: any[] }>();
  
  for (const t of trades) {
    const date = t.tradeDate;
    if (!dailyMap.has(date)) {
      dailyMap.set(date, { pnl: 0, trades: 0, wins: 0, details: [] });
    }
    const day = dailyMap.get(date)!;
    const pnl = Number(t.pnl);
    day.pnl += pnl;
    day.trades++;
    if (pnl > 0) day.wins++;
    day.details.push({ symbol: t.symbol, pnl, signal: t.reason, time: t.tradeTime });
  }
  
  // 直近30日分のみ
  const allDates = Array.from(dailyMap.keys()).sort();
  const dates = allDates.slice(-30);
  
  console.log(`\n=== rt_trades 実績集計（本番エンジン） ===`);
  console.log(`期間: ${dates[0]} 〜 ${dates[dates.length - 1]}（${dates.length}営業日）\n`);
  
  let totalPnl = 0;
  let totalTrades = 0;
  let totalWins = 0;
  
  console.log("日付        | 損益        | 取引数 | 勝率");
  console.log("------------|------------|--------|------");
  
  for (const date of dates) {
    const d = dailyMap.get(date)!;
    const pnlStr = (d.pnl >= 0 ? "+" : "") + d.pnl.toLocaleString() + "円";
    const winRate = d.trades > 0 ? ((d.wins / d.trades) * 100).toFixed(0) + "%" : "-";
    console.log(`${date} | ${pnlStr.padStart(10)} | ${String(d.trades).padStart(6)} | ${winRate}`);
    totalPnl += d.pnl;
    totalTrades += d.trades;
    totalWins += d.wins;
  }
  
  // サマリー
  const winRate = totalTrades > 0 ? ((totalWins / totalTrades) * 100).toFixed(1) : "0";
  const winDays = dates.filter(d => dailyMap.get(d)!.pnl > 0).length;
  const lossDays = dates.filter(d => dailyMap.get(d)!.pnl < 0).length;
  const zeroDays = dates.filter(d => dailyMap.get(d)!.pnl === 0).length;
  const grossProfit = dates.filter(d => dailyMap.get(d)!.pnl > 0).reduce((s, d) => s + dailyMap.get(d)!.pnl, 0);
  const grossLoss = Math.abs(dates.filter(d => dailyMap.get(d)!.pnl < 0).reduce((s, d) => s + dailyMap.get(d)!.pnl, 0));
  const pf = grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : "∞";
  
  console.log(`\n=== サマリー ===`);
  console.log(`期間: ${dates[0]} 〜 ${dates[dates.length - 1]}（${dates.length}営業日）`);
  console.log(`総損益: ${(totalPnl >= 0 ? "+" : "")}${totalPnl.toLocaleString()}円`);
  console.log(`取引数: ${totalTrades}件`);
  console.log(`勝率: ${winRate}%（${totalWins}勝 ${totalTrades - totalWins}敗）`);
  console.log(`勝ち日: ${winDays}日 / 負け日: ${lossDays}日 / ±0日: ${zeroDays}日`);
  console.log(`PF: ${pf}（総利益 +${grossProfit.toLocaleString()}円 / 総損失 -${grossLoss.toLocaleString()}円）`);
  console.log(`日平均損益: ${(totalPnl / dates.length >= 0 ? "+" : "")}${Math.round(totalPnl / dates.length).toLocaleString()}円`);
  
  await conn.end();
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
