import mysql from "mysql2/promise";

const conn = await mysql.createConnection(process.env.DATABASE_URL);

// realtimeSimEngine records blocked signals in a JSON column or separate mechanism
// Let's check the rt_trades table for any "block" actions or check the candle data

// First, let's look at what the engine actually logs - check if there's a signalHistory or similar
const [cols] = await conn.execute("SHOW COLUMNS FROM rt_daily_summaries");
console.log("rt_daily_summaries columns:", cols.map(c => c.Field));

// Check if there's a report or notes field
const [sum] = await conn.execute("SELECT * FROM rt_daily_summaries WHERE tradeDate = '2026-07-21'");
if (sum.length > 0) {
  console.log("\nFull daily summary:");
  for (const [k, v] of Object.entries(sum[0])) {
    console.log(`  ${k}: ${v}`);
  }
}

// The engine stores blocked signals in signalHistory - but that's in-memory
// Let's check the server logs or the notification system
// Actually, let's look at the scheduled handler output - it should have run at 16:00

// Check if there's a notifications table or log
const [tables] = await conn.execute("SHOW TABLES");
console.log("\nAll tables:", tables.map(t => Object.values(t)[0]));

await conn.end();
