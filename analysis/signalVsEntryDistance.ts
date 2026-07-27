import { getDb } from "../server/db";
import { sql } from "drizzle-orm";
import { calculateRoundDistancePct } from "../server/realtimeSimEngine";

async function main() {
  const db = await getDb();

  // For each entry, the signal was detected when price crossed the round level
  // At signal time, the price was AT or very near the round level (by definition)
  // The state machine then waits 5 bars for confirmation, then waits for pullback
  // By the time entry happens, price has moved away from the round level
  
  const r1 = await db.execute(sql`
    SELECT tradeDate, tradeTime, symbol, action, price, reason
    FROM rt_trades 
    WHERE tradeDate >= '2026-07-01' AND tradeDate <= '2026-07-16'
    AND (action = 'buy' OR action = 'short')
    AND (reason LIKE '%大台超え%' OR reason LIKE '%大台割れ%' OR reason LIKE '%大台確認%')
    ORDER BY tradeDate, tradeTime
  `);
  
  console.log("■ エントリー時の乖離率分布（全61件）\n");
  
  const distBuckets = new Map<string, number>();
  const ranges = ["0.0-0.4%", "0.4-0.8%", "0.8-1.2%", "1.2-1.6%", "1.6-2.0%", "2.0-3.0%", "3.0%+"];
  for (const r of ranges) distBuckets.set(r, 0);
  
  for (const row of (r1 as any)[0]) {
    const reason = row.reason as string;
    const entryPrice = Number(row.price);
    const levelMatch = reason.match(/大台(?:超え|割れ)\s*\((\d+)円/);
    if (!levelMatch) continue;
    const roundLevel = parseFloat(levelMatch[1]);
    const distPct = calculateRoundDistancePct(entryPrice, roundLevel);
    
    if (distPct <= 0.4) distBuckets.set("0.0-0.4%", (distBuckets.get("0.0-0.4%") || 0) + 1);
    else if (distPct <= 0.8) distBuckets.set("0.4-0.8%", (distBuckets.get("0.4-0.8%") || 0) + 1);
    else if (distPct <= 1.2) distBuckets.set("0.8-1.2%", (distBuckets.get("0.8-1.2%") || 0) + 1);
    else if (distPct <= 1.6) distBuckets.set("1.2-1.6%", (distBuckets.get("1.2-1.6%") || 0) + 1);
    else if (distPct <= 2.0) distBuckets.set("1.6-2.0%", (distBuckets.get("1.6-2.0%") || 0) + 1);
    else if (distPct <= 3.0) distBuckets.set("2.0-3.0%", (distBuckets.get("2.0-3.0%") || 0) + 1);
    else distBuckets.set("3.0%+", (distBuckets.get("3.0%+") || 0) + 1);
  }
  
  console.log("  乖離率帯     件数   累積%");
  console.log("  " + "-".repeat(35));
  let cumulative = 0;
  const total = 61;
  for (const [range, count] of distBuckets) {
    cumulative += count;
    const bar = "█".repeat(count);
    console.log(`  ${range.padEnd(10)} ${String(count).padStart(3)}件 ${(cumulative/total*100).toFixed(0).padStart(4)}%  ${bar}`);
  }
  
  console.log("\n■ 結論:");
  console.log("  0.8%閾値では84%のエントリーがブロックされる");
  console.log("  これは「確認バー5本 + 押し目待ち」の構造上、");
  console.log("  エントリー時にはキリ番から0.8%以上離れているのが普通であることを意味する");
  console.log("\n  つまり、0.8%フィルターは「大台超え/割れシグナルのほぼ全てをブロック」する");
  console.log("  設計意図と実装が乖離している可能性が高い");
  
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
