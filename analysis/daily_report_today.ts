/**
 * daily_report_today.ts
 * 本日のrt_trades/rt_daily_summariesからシミュレーション結果を集計
 * 実行: cd /home/ubuntu/stock-alert-app && npx tsx analysis/daily_report_today.ts
 */
import mysql from "mysql2/promise";

async function main() {
  const conn = await mysql.createConnection(process.env.DATABASE_URL as string);
  
  // 今日の日付（JST）
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const today = jst.toISOString().split("T")[0];
  console.log(`対象日: ${today}`);

  // 1. rt_daily_summaries
  const [summaries] = await conn.execute(
    `SELECT * FROM rt_daily_summaries WHERE tradeDate = ?`, [today]
  ) as any[];
  console.log("\n=== rt_daily_summaries ===");
  if (summaries.length > 0) {
    console.log(JSON.stringify(summaries[0], null, 2));
  } else {
    console.log("(レコードなし)");
  }

  // 2. rt_trades
  const [trades] = await conn.execute(
    `SELECT * FROM rt_trades WHERE tradeDate = ? ORDER BY tradeTime`, [today]
  ) as any[];
  console.log(`\n=== rt_trades (${trades.length}件) ===`);
  for (const t of trades) {
    console.log(`  ${t.tradeTime} ${t.symbol} ${t.symbolName} ${t.action} ${t.side} @${t.price} x${t.shares} pnl=${t.pnl || '-'} | ${(t.reason || '').substring(0, 60)}`);
  }

  // 3. 集計
  const closedTrades = trades.filter((t: any) => t.pnl !== null && t.pnl !== undefined);
  const entryTrades = trades.filter((t: any) => t.action === 'buy' || t.action === 'short');
  const exitTrades = trades.filter((t: any) => t.action === 'sell' || t.action === 'cover');
  
  const totalPnl = closedTrades.reduce((sum: number, t: any) => sum + Number(t.pnl), 0);
  const wins = closedTrades.filter((t: any) => Number(t.pnl) > 0).length;
  const losses = closedTrades.filter((t: any) => Number(t.pnl) <= 0).length;
  
  console.log(`\n=== 集計 ===`);
  console.log(`  エントリー: ${entryTrades.length}件`);
  console.log(`  決済: ${exitTrades.length}件`);
  console.log(`  損益確定: ${closedTrades.length}件`);
  console.log(`  勝敗: ${wins}勝${losses}敗`);
  console.log(`  勝率: ${closedTrades.length > 0 ? (wins / closedTrades.length * 100).toFixed(1) : 0}%`);
  console.log(`  総損益: ${totalPnl >= 0 ? '+' : ''}${Math.round(totalPnl).toLocaleString()}円`);

  // 4. 銘柄別
  const bySymbol = new Map<string, { pnl: number; count: number; wins: number; name: string }>();
  for (const t of closedTrades) {
    const key = t.symbol;
    const existing = bySymbol.get(key) || { pnl: 0, count: 0, wins: 0, name: t.symbolName };
    existing.pnl += Number(t.pnl);
    existing.count++;
    if (Number(t.pnl) > 0) existing.wins++;
    bySymbol.set(key, existing);
  }
  console.log(`\n=== 銘柄別損益 ===`);
  for (const [sym, data] of [...bySymbol.entries()].sort((a, b) => b[1].pnl - a[1].pnl)) {
    console.log(`  ${sym} ${data.name}: ${data.pnl >= 0 ? '+' : ''}${Math.round(data.pnl).toLocaleString()}円 (${data.wins}勝${data.count - data.wins}敗)`);
  }

  // 5. シグナル別（reasonから抽出）
  const byReason = new Map<string, { pnl: number; count: number; wins: number }>();
  for (const t of closedTrades) {
    const reason = (t.reason || '').split('|')[0].trim().substring(0, 30);
    const existing = byReason.get(reason) || { pnl: 0, count: 0, wins: 0 };
    existing.pnl += Number(t.pnl);
    existing.count++;
    if (Number(t.pnl) > 0) existing.wins++;
    byReason.set(reason, existing);
  }
  console.log(`\n=== シグナル/決済理由別 ===`);
  for (const [reason, data] of [...byReason.entries()].sort((a, b) => b[1].pnl - a[1].pnl)) {
    console.log(`  ${reason}: ${data.pnl >= 0 ? '+' : ''}${Math.round(data.pnl).toLocaleString()}円 (${data.count}件, ${data.wins}勝)`);
  }

  // 6. データ受信状況
  const [candleCounts] = await conn.execute(
    `SELECT symbol, COUNT(*) as cnt, MIN(candleTime) as firstBar, MAX(candleTime) as lastBar 
     FROM rt_candles WHERE tradeDate = ? GROUP BY symbol ORDER BY symbol`, [today]
  ) as any[];
  console.log(`\n=== データ受信状況 ===`);
  let totalBars = 0;
  for (const r of candleCounts) {
    totalBars += Number(r.cnt);
    console.log(`  ${r.symbol}: ${r.cnt}本 (${r.firstBar}〜${r.lastBar})`);
  }
  console.log(`  合計: ${totalBars}本`);

  await conn.end();
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
