import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

async function main() {
  const db = await getDb();

  // Check rt_daily_summaries for reportSent status
  const r1 = await db.execute(sql`
    SELECT tradeDate, reportSent, reportSentAt, totalPnl, tradesCount
    FROM rt_daily_summaries 
    WHERE tradeDate >= '2026-07-17'
    ORDER BY tradeDate
  `);
  console.log("■ 日次レポート送信状況 (7/17以降)");
  for (const row of (r1 as any)[0]) {
    console.log(`  ${row.tradeDate}: sent=${row.reportSent} at=${row.reportSentAt} pnl=${row.totalPnl} trades=${row.tradesCount}`);
  }

  // The key issue: when CB v2 has 0 SHORT blocks, it shows:
  // "候補なし（0.8%ブロックSHORTが0件）"
  // This is the ONLY mention of the 0.8% filter in the report
  // If there ARE SHORT blocks, it shows "候補数: X件"
  
  // But the user is asking about the "14件" from the fullFilterTrace
  // That number was from the SIMULATION, not from production
  
  console.log("\n■ 結論:");
  console.log("  「14件ブロック」はfullFilterTraceシミュレーション（7/17-7/24, 全20銘柄, フィルターなし）の結果");
  console.log("  本番の日次レポートでは:");
  console.log("  - CB v2セクションに「候補数: X件」(SHORTのみ) or 「候補なし」と表示");
  console.log("  - LONGブロックは一切報告されない");
  console.log("  - 本番では前段フィルターにより大台乖離率チェックに到達する件数が少ない");
  console.log("  - そのため「0.8%フィルターでX件ブロック」という明示的な報告が日次レポートにない");

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
