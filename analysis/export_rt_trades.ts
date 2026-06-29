/**
 * export_rt_trades.ts
 * DBからrt_tradesの全データをJSONファイルにエクスポートする
 */
import { getDb } from "../server/db";
import { rtTrades } from "../drizzle/schema";
import { asc } from "drizzle-orm";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const db = await getDb();
  if (!db) { console.error('DB not available'); process.exit(1); }
  const allTrades = await db.select().from(rtTrades).orderBy(asc(rtTrades.tradeDate), asc(rtTrades.tradeTime));
  
  const outPath = path.join(process.cwd(), "analysis", "rt_trades_export.json");
  fs.writeFileSync(outPath, JSON.stringify(allTrades, null, 2), "utf8");
  
  console.log(`Exported ${allTrades.length} trades to ${outPath}`);
  
  // Summary
  const dates = [...new Set(allTrades.map(t => t.tradeDate))];
  console.log(`Date range: ${dates[0]} ~ ${dates[dates.length - 1]} (${dates.length} days)`);
  
  const shorts = allTrades.filter(t => t.action === "short");
  const covers = allTrades.filter(t => t.action === "cover");
  console.log(`SHORT entries: ${shorts.length}, Covers: ${covers.length}`);
  
  const totalPnl = covers.reduce((sum, t) => sum + (Number(t.pnl) || 0), 0);
  console.log(`Total P&L: ${totalPnl.toLocaleString()}円`);
  
  // Per-date summary
  for (const date of dates) {
    const dayTrades = allTrades.filter(t => t.tradeDate === date);
    const dayCovers = dayTrades.filter(t => t.action === "cover");
    const dayPnl = dayCovers.reduce((sum, t) => sum + (Number(t.pnl) || 0), 0);
    const wins = dayCovers.filter(t => (Number(t.pnl) || 0) > 0).length;
    const losses = dayCovers.filter(t => (Number(t.pnl) || 0) < 0).length;
    console.log(`  ${date}: ${dayTrades.length} trades, ${wins}W/${losses}L, P&L: ${dayPnl.toLocaleString()}円`);
  }
  
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
