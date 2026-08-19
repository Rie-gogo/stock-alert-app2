import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

async function main() {
  const db = await getDb();
  // rt_tradesのカラム名を確認
  const [cols] = await db.execute(sql`SHOW COLUMNS FROM rt_trades`);
  const colNames = (cols as any[]).map(c => c.Field);
  console.log("rt_trades columns:", colNames.join(", "));
  
  // 8/7の本番取引を取得
  const timeCol = colNames.includes("candle_time") ? "candle_time" : "candleTime";
  const dateCol = "tradeDate";

  const [rows] = await db.execute(sql.raw(`
    SELECT symbol, action, tradeTime as ctime, price, shares, pnl, reason
    FROM rt_trades WHERE tradeDate = '2026-08-07' ORDER BY tradeTime
  `));
  const trades = rows as any[];
  console.log(`\n=== 8/7 本番取引 (${trades.length}件) ===`);
  let total = 0;
  let entries = 0;
  for (const t of trades) {
    const pnl = t.pnl ? +t.pnl : 0;
    total += pnl;
    if (t.action === "short" || t.action === "buy") {
      entries++;
      console.log(`  ${t.ctime} ${t.symbol} ${t.action} @${t.price} x${t.shares} ${(t.reason||"").substring(0,60)}`);
    } else {
      console.log(`  ${t.ctime} ${t.symbol} ${t.action} @${t.price} x${t.shares} PnL:${pnl.toLocaleString()}円 ${(t.reason||"").substring(0,40)}`);
    }
  }
  console.log(`\nエントリー: ${entries}件, 合計損益: ${total.toLocaleString()}円`);
  console.log(`勝: ${trades.filter(t=>t.pnl&&+t.pnl>0).length}, 負: ${trades.filter(t=>t.pnl&&+t.pnl<=0&&t.pnl!==null).length}`);
  
  process.exit(0);
}
main();
