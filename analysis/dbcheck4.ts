import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

async function main() {
  const db = await getDb();
  
  const r = await db.execute(sql`
    SELECT tradeDate, tradeTime, symbol, symbolName, side, action, 
           SUBSTRING(reason, 1, 200) as reason, boardSignal, price
    FROM rt_trades 
    WHERE tradeDate >= '2026-07-14' AND action IN ('buy', 'short')
    ORDER BY tradeDate, tradeTime
  `);
  const trades = (r as any)[0];
  
  // Categorize
  let mediumLongSM = 0, strongLongDirect = 0, mediumShortSM = 0, strongShortDirect = 0;
  let mediumLongSM_after = 0, strongLongDirect_after = 0, mediumShortSM_after = 0, strongShortDirect_after = 0;
  
  for (const t of trades) {
    const reason = (t.reason || "") as string;
    const isMedium = reason.includes("信頼度：中");
    const isStateMachine = reason.includes("押し目確認") || reason.includes("タイムアウト") || reason.includes("押し目なし") || reason.includes("強トレンド");
    const isAfter716 = t.tradeDate > '2026-07-16';
    
    if (t.action === 'buy') {
      if (isMedium && isStateMachine) { mediumLongSM++; if (isAfter716) mediumLongSM_after++; }
      else { strongLongDirect++; if (isAfter716) strongLongDirect_after++; }
    } else {
      if (isMedium && isStateMachine) { mediumShortSM++; if (isAfter716) mediumShortSM_after++; }
      else { strongShortDirect++; if (isAfter716) strongShortDirect_after++; }
    }
  }
  
  console.log("=== TRADE CATEGORY ANALYSIS ===");
  console.log(`\n7/14-7/16 (before drop):`);
  console.log(`  Medium LONG via SM: ${mediumLongSM - mediumLongSM_after}`);
  console.log(`  Strong LONG direct: ${strongLongDirect - strongLongDirect_after}`);
  console.log(`  Medium SHORT via SM: ${mediumShortSM - mediumShortSM_after}`);
  console.log(`  Strong SHORT direct: ${strongShortDirect - strongShortDirect_after}`);
  
  console.log(`\n7/17-7/24 (after drop):`);
  console.log(`  Medium LONG via SM: ${mediumLongSM_after}`);
  console.log(`  Strong LONG direct: ${strongLongDirect_after}`);
  console.log(`  Medium SHORT via SM: ${mediumShortSM_after}`);
  console.log(`  Strong SHORT direct: ${strongShortDirect_after}`);
  
  // Now let's look at what happened: 7/14-7/16 had LONG entries that were medium + SM
  // 7/17+ has ZERO LONG entries. Why?
  console.log("\n=== KEY QUESTION: Why no LONG entries after 7/16? ===");
  console.log("7/14-7/16 LONG entries were mostly medium via state machine (大台超え)");
  console.log("7/17+ has only 1 LONG entry (5803 on 7/24, strong direct)");
  console.log("\nPossible causes:");
  console.log("1. Market was bearish (下落相場) → no LONG signals generated");
  console.log("2. isBullish was blocking SHORTs but not generating LONGs");
  console.log("3. HTF filter blocking LONG state machine entries");
  
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
