import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

async function main() {
  const db = await getDb();
  const result = await db.execute(sql`
    SELECT tradeDate, tradeTime, symbol, symbolName, side, action, reason, boardSignal, price
    FROM rt_trades 
    WHERE tradeDate >= '2026-07-14' AND action = 'entry'
    ORDER BY tradeDate, tradeTime
  `);
  // drizzle mysql2 returns [rows, fields]
  const trades = Array.isArray(result) && Array.isArray(result[0]) ? result[0] : result;
  console.log("=== ALL ENTRIES 7/14-7/24 ===");
  console.log(`Total entries: ${(trades as any[]).length}`);
  for (const t of trades as any[]) {
    const reason = (t.reason || "") as string;
    const isMedium = reason.includes("信頼度：中");
    const isStrong = reason.includes("信頼度：強");
    const isStateMachine = reason.includes("押し目確認") || reason.includes("タイムアウト") || reason.includes("押し目なし");
    const isRound = reason.includes("大台");
    const conf = isMedium ? "中" : isStrong ? "強" : "弱";
    console.log(`${t.tradeDate} ${t.tradeTime} ${t.symbol}(${t.symbolName}) ${t.side} conf=${conf} SM=${isStateMachine} round=${isRound} board=${t.boardSignal || 'null'}`);
    console.log(`  reason: ${reason.substring(0, 150)}`);
  }
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
