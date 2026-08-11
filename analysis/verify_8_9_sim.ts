/**
 * 8/9のシミュレーション結果を検証
 * rt_tradesから6/24〜8/7の期間で、アクティブ銘柄のみの実績を集計
 */
import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

const ACTIVE = new Set(['8035', '6857', '6976', '6526', '5803', '6981', '285A', '6146', '6594', '8316']);

async function main() {
  const db = await getDb();
  
  const res = await db.execute(sql.raw(`
    SELECT tradeDate, symbol, action, pnl, reason, tradeTime
    FROM rt_trades
    WHERE tradeDate >= '2026-06-24' AND tradeDate <= '2026-08-07'
      AND (action = 'sell' OR action = 'cover')
      AND pnl IS NOT NULL
    ORDER BY tradeDate, tradeTime
  `));
  
  const rows = (res as any)[0] as any[];
  
  // アクティブ銘柄のみフィルター
  const activeRows = rows.filter((r: any) => ACTIVE.has(r.symbol));
  
  let total = 0, wins = 0, totalPnl = 0;
  const byDate = new Map<string, { pnl: number; cnt: number; w: number }>();
  
  for (const r of activeRows) {
    const pnl = Number(r.pnl);
    total++;
    totalPnl += pnl;
    if (pnl > 0) wins++;
    
    const d = r.tradeDate;
    if (!byDate.has(d)) byDate.set(d, { pnl: 0, cnt: 0, w: 0 });
    const day = byDate.get(d)!;
    day.pnl += pnl;
    day.cnt++;
    if (pnl > 0) day.w++;
  }
  
  // 全取引（除外銘柄含む）
  let allTotal = 0, allWins = 0, allPnl = 0;
  for (const r of rows) {
    const pnl = Number(r.pnl);
    allTotal++;
    allPnl += pnl;
    if (pnl > 0) allWins++;
  }
  
  console.log("=== rt_trades 実績（6/24〜8/7） ===\n");
  console.log("【全銘柄（除外含む）】");
  console.log(`  取引数: ${allTotal}件, 勝率: ${((allWins/allTotal)*100).toFixed(1)}%, 総損益: ${allPnl.toLocaleString()}円\n`);
  console.log("【アクティブ10銘柄のみ】");
  console.log(`  取引数: ${total}件, 勝率: ${((wins/total)*100).toFixed(1)}%, 総損益: ${totalPnl.toLocaleString()}円\n`);
  
  console.log("日付        | 損益        | 取引数 | 勝率");
  console.log("------------|------------|--------|------");
  const sortedDates = Array.from(byDate.keys()).sort();
  for (const d of sortedDates) {
    const day = byDate.get(d)!;
    const pnlStr = (day.pnl >= 0 ? "+" : "") + day.pnl.toLocaleString() + "円";
    const wr = day.cnt > 0 ? ((day.w / day.cnt) * 100).toFixed(0) + "%" : "-";
    console.log(`${d} | ${pnlStr.padStart(10)} | ${String(day.cnt).padStart(6)} | ${wr}`);
  }
  
  console.log(`\n取引日数: ${sortedDates.length}日`);
  
  // 除外銘柄の取引を別途表示
  const excludedRows = rows.filter((r: any) => !ACTIVE.has(r.symbol));
  if (excludedRows.length > 0) {
    console.log(`\n【除外銘柄の取引（参考）】`);
    const bySymbol = new Map<string, { cnt: number; pnl: number }>();
    for (const r of excludedRows) {
      const s = r.symbol;
      if (!bySymbol.has(s)) bySymbol.set(s, { cnt: 0, pnl: 0 });
      bySymbol.get(s)!.cnt++;
      bySymbol.get(s)!.pnl += Number(r.pnl);
    }
    for (const [sym, data] of bySymbol) {
      console.log(`  ${sym}: ${data.cnt}件, ${data.pnl.toLocaleString()}円`);
    }
  }
  
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
