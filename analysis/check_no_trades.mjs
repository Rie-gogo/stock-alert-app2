import mysql from "mysql2/promise";
const conn = await mysql.createConnection(process.env.DATABASE_URL);

// Current 16 symbols (excluding 5016)
const CURRENT_SYMBOLS = [
  '6920', '8035', '6857', '6526', '6976', '6981', '9984', '3436',
  '9107', '8306', '4568', '285A', '6758', '7203', '8316', '7011'
];

// Check which symbols have trades in rt_trades
const [trades] = await conn.query(`
  SELECT symbol, COUNT(*) as cnt, 
    SUM(CASE WHEN pnl IS NOT NULL THEN 1 ELSE 0 END) as exits,
    MIN(tradeDate) as firstDate, MAX(tradeDate) as lastDate
  FROM rt_trades
  WHERE symbol IN (${CURRENT_SYMBOLS.map(() => '?').join(',')})
  GROUP BY symbol
`, CURRENT_SYMBOLS);

const tradedSymbols = new Set(trades.map(t => t.symbol));

console.log("=== 現在の16銘柄の取引状況 ===\n");
console.log("取引あり:");
for (const t of trades) {
  console.log(`  ${t.symbol}: ${t.cnt}件 (決済${t.exits}件) | ${t.firstDate} 〜 ${t.lastDate}`);
}

console.log("\n取引なし（1度もエントリーなし）:");
const noTrades = CURRENT_SYMBOLS.filter(s => !tradedSymbols.has(s));
if (noTrades.length === 0) {
  console.log("  なし（全銘柄で取引実績あり）");
} else {
  for (const s of noTrades) {
    console.log(`  ${s}`);
  }
}

await conn.end();
