import { getDb } from "../server/db";
import { sql } from "drizzle-orm";
import { calculateRoundDistancePct } from "../server/realtimeSimEngine";

async function main() {
  const db = await getDb();

  const r1 = await db.execute(sql`
    SELECT tradeDate, symbol, action, price, reason
    FROM rt_trades 
    WHERE tradeDate >= '2026-07-01' AND tradeDate <= '2026-07-16'
    AND (action = 'buy' OR action = 'short')
    AND (reason LIKE '%大台超え%' OR reason LIKE '%大台割れ%' OR reason LIKE '%大台確認%')
    ORDER BY tradeDate, tradeTime
  `);
  
  let longTotal = 0, longBlocked = 0;
  let shortTotal = 0, shortBlocked = 0;
  
  for (const row of (r1 as any)[0]) {
    const reason = row.reason as string;
    const entryPrice = Number(row.price);
    const action = row.action as string;
    
    const levelMatch = reason.match(/大台(?:超え|割れ)\s*\((\d+)円/);
    if (!levelMatch) continue;
    const roundLevel = parseFloat(levelMatch[1]);
    const distPct = calculateRoundDistancePct(entryPrice, roundLevel);
    const blocked = distPct > 0.8;
    
    if (action === "buy") {
      longTotal++;
      if (blocked) longBlocked++;
    } else {
      shortTotal++;
      if (blocked) shortBlocked++;
    }
  }
  
  console.log("■ LONG vs SHORT ブロック分析（7/1-7/16）");
  console.log(`  LONG: ${longTotal}件中 ${longBlocked}件ブロック (${(longBlocked/longTotal*100).toFixed(0)}%)`);
  console.log(`  SHORT: ${shortTotal}件中 ${shortBlocked}件ブロック (${(shortBlocked/shortTotal*100).toFixed(0)}%)`);
  console.log(`  合計: ${longTotal+shortTotal}件中 ${longBlocked+shortBlocked}件ブロック (${((longBlocked+shortBlocked)/(longTotal+shortTotal)*100).toFixed(0)}%)`);
  
  console.log("\n■ 日次レポートでの報告状況:");
  console.log("  CB v2セクション: SHORTブロックのみ報告");
  console.log(`  → 報告されるブロック: ${shortBlocked}件（SHORT）`);
  console.log(`  → 報告されないブロック: ${longBlocked}件（LONG）`);
  console.log("\n  ※ ただし、signalHistoryはin-memoryのため、サーバー再起動で消失");
  console.log("  ※ 日次レポート生成時にsignalHistoryが空の場合、「候補なし」と表示される");
  
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
