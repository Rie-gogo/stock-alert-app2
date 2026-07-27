import { getDb } from "../server/db";
import { sql } from "drizzle-orm";
async function main() {
  const db = await getDb();
  const result = await db.execute(sql`
    SELECT tradeDate, 
           SUM(CASE WHEN action NOT IN ('buy','short') THEN pnl ELSE 0 END) as dailyPnl,
           SUM(CASE WHEN action NOT IN ('buy','short') AND pnl > 0 THEN 1 ELSE 0 END) as wins,
           SUM(CASE WHEN action NOT IN ('buy','short') AND pnl <= 0 THEN 1 ELSE 0 END) as losses,
           SUM(CASE WHEN action NOT IN ('buy','short') THEN 1 ELSE 0 END) as exitCount
    FROM rt_trades 
    WHERE tradeDate >= '2026-07-01' AND tradeDate <= '2026-07-27'
    GROUP BY tradeDate
    ORDER BY tradeDate
  `);
  const rows = (result as any)[0];
  
  let cumPnl = 0;
  console.log(`${"日付".padEnd(12)} ${"取引".padStart(4)} ${"勝敗".padStart(7)} ${"勝率".padStart(5)} ${"日次損益".padStart(12)} ${"累計損益".padStart(12)}`);
  console.log("─".repeat(60));
  
  for (const row of rows) {
    const pnl = Number(row.dailyPnl) || 0;
    cumPnl += pnl;
    const wins = Number(row.wins);
    const losses = Number(row.losses);
    const exits = Number(row.exitCount);
    const wr = exits > 0 ? (wins / exits * 100).toFixed(0) + "%" : "-";
    console.log(
      `${row.tradeDate.padEnd(12)} ${String(exits).padStart(4)} ${(wins + "勝" + losses + "敗").padStart(7)} ${wr.padStart(5)} ${((pnl >= 0 ? "+" : "") + pnl.toLocaleString() + "円").padStart(12)} ${((cumPnl >= 0 ? "+" : "") + cumPnl.toLocaleString() + "円").padStart(12)}`
    );
  }
  console.log("─".repeat(60));
  console.log(`合計: ${cumPnl >= 0 ? "+" : ""}${cumPnl.toLocaleString()}円`);
  
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
