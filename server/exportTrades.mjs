import "dotenv/config";
import mysql from "mysql2/promise";
import fs from "fs";

const conn = await mysql.createConnection(process.env.DATABASE_URL);

const [rows] = await conn.execute(
  `SELECT s.symbol, s.name, s.profitAmount, s.tradesCount, s.winCount, s.winRate, s.trades, s.signals, s.lossCauses, s.countermeasures
   FROM stock_reports s JOIN daily_reports d ON s.dailyReportId = d.id
   WHERE d.reportDate = '2026-06-02'
   ORDER BY s.profitAmount ASC`
);

const parsed = rows.map((r) => ({
  symbol: r.symbol,
  name: r.name,
  profitAmount: r.profitAmount,
  tradesCount: r.tradesCount,
  winCount: r.winCount,
  winRate: Number(r.winRate),
  trades: typeof r.trades === "string" ? JSON.parse(r.trades) : r.trades,
  signals: typeof r.signals === "string" ? JSON.parse(r.signals) : r.signals,
  lossCauses: typeof r.lossCauses === "string" ? JSON.parse(r.lossCauses) : r.lossCauses,
  countermeasures: typeof r.countermeasures === "string" ? JSON.parse(r.countermeasures) : r.countermeasures,
}));

fs.writeFileSync("/home/ubuntu/today_trades.json", JSON.stringify(parsed, null, 2));
console.log("Exported", parsed.length, "stock reports");
await conn.end();
