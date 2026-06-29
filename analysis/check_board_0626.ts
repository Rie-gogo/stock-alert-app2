import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { eq } from "drizzle-orm";
import * as schema from "../drizzle/schema";

async function main() {
  const connection = await mysql.createConnection(process.env.DATABASE_URL!);
  const db = drizzle(connection, { schema, mode: "default" });

  const trades = await db
    .select({
      symbol: schema.rtTrades.symbol,
      tradeTime: schema.rtTrades.tradeTime,
      action: schema.rtTrades.action,
      boardSignal: schema.rtTrades.boardSignal,
      reason: schema.rtTrades.reason,
    })
    .from(schema.rtTrades)
    .where(eq(schema.rtTrades.tradeDate, "2026-06-26"))
    .orderBy(schema.rtTrades.id);

  console.log("=== 板読みシグナル（boardSignal）確認 ===\n");
  for (const t of trades) {
    console.log(`${t.tradeTime} ${t.symbol} ${t.action.padEnd(6)} boardSignal=${t.boardSignal ?? "null"} | reason=${t.reason.slice(0, 80)}`);
  }

  // boardSignal の統計
  const withBoard = trades.filter(t => t.boardSignal && t.boardSignal !== "null" && t.boardSignal !== "");
  const withoutBoard = trades.filter(t => !t.boardSignal || t.boardSignal === "null" || t.boardSignal === "");
  console.log(`\n板読みシグナルあり: ${withBoard.length}件`);
  console.log(`板読みシグナルなし: ${withoutBoard.length}件`);

  if (withBoard.length > 0) {
    console.log("\n板読みシグナル内訳:");
    const signals: Record<string, number> = {};
    for (const t of withBoard) {
      const sig = t.boardSignal!;
      signals[sig] = (signals[sig] || 0) + 1;
    }
    for (const [sig, count] of Object.entries(signals).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${sig}: ${count}件`);
    }
  }

  await connection.end();
}

main().catch(console.error);
