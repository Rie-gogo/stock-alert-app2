import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

async function main() {
  const db = await getDb();
  
  // Get sample reasons to understand the format
  const r1 = await db.execute(sql`
    SELECT tradeDate, symbol, price, reason
    FROM rt_trades 
    WHERE tradeDate >= '2026-07-01' AND tradeDate <= '2026-07-03'
    AND (action = 'buy' OR action = 'short')
    AND (reason LIKE '%大台超え%' OR reason LIKE '%大台割れ%' OR reason LIKE '%大台確認%')
    ORDER BY tradeDate, tradeTime
    LIMIT 10
  `);
  
  console.log("■ reason フィールドの実際のフォーマット:");
  for (const row of (r1 as any)[0]) {
    console.log(`\n  ${row.tradeDate} ${row.symbol} @${row.price}`);
    console.log(`  reason: ${row.reason}`);
    
    // The reason format is like:
    // "大台確認(5本維持): 大台割れ (32600円割り込み)｜[信頼度：中] トレンド一致・勢い一致・出来高薄 (押し目確認後)"
    // The round level is in the "大台割れ (XXXXX円割り込み)" or "大台超え (XXXXX円突破)" part
    const reason = row.reason as string;
    
    // Try to extract the round level more accurately
    const roundMatch = reason.match(/大台(?:超え|割れ)\s*\((\d+)円/);
    if (roundMatch) {
      console.log(`  → キリ番(正確): ${roundMatch[1]}円`);
    }
    
    // Also check the first number match (what the previous script used)
    const firstMatch = reason.match(/(\d+(?:\.\d+)?)円/);
    if (firstMatch) {
      console.log(`  → 最初の円数値: ${firstMatch[1]}円`);
    }
  }

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
