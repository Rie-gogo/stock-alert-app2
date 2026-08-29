import mysql from "mysql2/promise";

function compactSnapshot(raw) {
  if (!raw) return null;
  const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  return {
    buyPressureRatio: Number(parsed.buyPressureRatio ?? 1),
    marketOrderDirection: parsed.marketOrderDirection ?? "neutral",
    signal: parsed.signal ?? "neutral",
  };
}

const connection = await mysql.createConnection(process.env.DATABASE_URL);
const [rows] = await connection.query(
  `SELECT c.id, c.tradeDate, c.candleTime, c.open, c.high, c.low, c.close, c.volume, c.boardSnapshot
     FROM rt_candles c
     INNER JOIN (
       SELECT tradeDate, candleTime, MAX(id) AS maxId
       FROM rt_candles
       WHERE symbol = '6976'
       GROUP BY tradeDate, candleTime
     ) latest ON latest.maxId = c.id
     ORDER BY c.tradeDate, c.candleTime, c.id`,
);
await connection.end();

const byDate = new Map();
for (const row of rows) {
  const candles = byDate.get(row.tradeDate) ?? [];
  candles.push([
    row.candleTime,
    Number(row.open),
    Number(row.high),
    Number(row.low),
    Number(row.close),
    Number(row.volume),
    compactSnapshot(row.boardSnapshot),
  ]);
  byDate.set(row.tradeDate, candles);
}
const segments = [...byDate.entries()].map(([tradeDate, candles]) => ({
  purpose: "full_saved_day",
  tradeDate,
  candles,
}));

const output = `${JSON.stringify({
  schemaVersion: 2,
  provenance: {
    source: "rt_candles/KABU Station",
    symbol: "6976",
    duplicateRule: "tradeDate+candleTimeごとに最大id",
    coverage: "全46保存日・全重複除去足。取引非発生日も省略しない",
    causality: "各日をcandleTime昇順で実エンジンへ投入。未来足・外部データなし",
    generatedAt: "2026-08-29",
  },
  dateCount: segments.length,
  rowCount: rows.length,
  rowFormat: ["candleTime", "open", "high", "low", "close", "volume", "boardSnapshot"],
  segments,
}, null, 1)}\n`;
process.stdout.write(output, () => process.exit(0));
