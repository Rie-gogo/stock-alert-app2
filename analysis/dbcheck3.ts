import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

async function main() {
  const db = await getDb();
  
  // Get all entries (buy/short) from 7/14 onwards
  const r = await db.execute(sql`
    SELECT tradeDate, tradeTime, symbol, symbolName, side, action, 
           SUBSTRING(reason, 1, 200) as reason, boardSignal, price
    FROM rt_trades 
    WHERE tradeDate >= '2026-07-14' AND action IN ('buy', 'short')
    ORDER BY tradeDate, tradeTime
  `);
  const trades = (r as any)[0];
  console.log(`=== ALL ENTRIES (buy/short) 7/14-7/24: ${trades.length} total ===\n`);
  
  let currentDate = "";
  for (const t of trades) {
    if (t.tradeDate !== currentDate) {
      currentDate = t.tradeDate;
      console.log(`\n--- ${currentDate} ---`);
    }
    const reason = (t.reason || "") as string;
    const isMedium = reason.includes("信頼度：中");
    const isStrong = reason.includes("信頼度：強");
    const isStateMachine = reason.includes("押し目確認") || reason.includes("タイムアウト") || reason.includes("押し目なし") || reason.includes("強トレンド");
    const isRound = reason.includes("大台");
    const conf = isMedium ? "中" : isStrong ? "強" : "弱";
    console.log(`  ${t.tradeTime} ${t.symbol}(${t.symbolName}) ${t.action} conf=${conf} SM=${isStateMachine} round=${isRound}`);
    console.log(`    ${reason.substring(0, 160)}`);
  }
  
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
