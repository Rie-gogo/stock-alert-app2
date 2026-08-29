import mysql from "mysql2/promise";

const expectedTrades = [
  ["2026-06-25", "12:58", "13:12"], ["2026-06-26", "10:33", "10:58"],
  ["2026-06-29", "09:59", "10:05"], ["2026-06-30", "10:14", "10:16"],
  ["2026-07-03", "10:03", "10:09"], ["2026-07-06", "10:04", "10:08"],
  ["2026-07-07", "10:25", "10:27"], ["2026-07-09", "09:53", "09:58"],
  ["2026-07-13", "10:38", "10:47"], ["2026-07-27", "11:10", "11:27"],
  ["2026-07-30", "12:59", "13:14"], ["2026-08-03", "10:16", "10:22"],
  ["2026-08-06", "10:28", "10:34"], ["2026-08-07", "10:21", "10:27"],
  ["2026-08-13", "09:53", "09:59"], ["2026-08-14", "10:02", "10:08"],
  ["2026-08-18", "09:59", "10:02"], ["2026-08-19", "10:06", "10:12"],
  ["2026-08-26", "09:52", "09:58"], ["2026-08-27", "09:50", "09:56"],
  ["2026-08-28", "10:12", "10:17"],
];
const boardRejectionOnlySegments = [
  ["2026-07-01", "10:16"],
  ["2026-07-21", "10:16"],
  ["2026-07-23", "10:26"],
];

function compactSnapshot(raw) {
  if (!raw) return null;
  const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  return Object.fromEntries(Object.entries(parsed).filter(([, value]) => value !== undefined));
}

const connection = await mysql.createConnection(process.env.DATABASE_URL);
const segments = [];
for (const [tradeDate, expectedEntryTime, expectedExitTime] of expectedTrades) {
  const [rows] = await connection.query(
    `SELECT c.id, c.candleTime, c.open, c.high, c.low, c.close, c.volume, c.boardSnapshot
       FROM rt_candles c
       INNER JOIN (
         SELECT candleTime, MAX(id) AS maxId
         FROM rt_candles
         WHERE symbol = '6976' AND tradeDate = ? AND candleTime <= ?
         GROUP BY candleTime
       ) latest ON latest.maxId = c.id
       ORDER BY c.candleTime, c.id`,
    [tradeDate, expectedExitTime],
  );
  segments.push({
    purpose: "expected_trade",
    tradeDate,
    expectedEntryTime,
    expectedExitTime,
    candles: rows.map(row => [
      row.candleTime,
      Number(row.open),
      Number(row.high),
      Number(row.low),
      Number(row.close),
      Number(row.volume),
      compactSnapshot(row.boardSnapshot),
    ]),
  });
}
for (const [tradeDate, endTime] of boardRejectionOnlySegments) {
  const [rows] = await connection.query(
    `SELECT c.id, c.candleTime, c.open, c.high, c.low, c.close, c.volume, c.boardSnapshot
       FROM rt_candles c
       INNER JOIN (
         SELECT candleTime, MAX(id) AS maxId
         FROM rt_candles
         WHERE symbol = '6976' AND tradeDate = ? AND candleTime <= ?
         GROUP BY candleTime
       ) latest ON latest.maxId = c.id
       ORDER BY c.candleTime, c.id`,
    [tradeDate, endTime],
  );
  segments.push({
    purpose: "board_rejection_only",
    tradeDate,
    expectedEntryTime: null,
    expectedExitTime: null,
    candles: rows.map(row => [
      row.candleTime,
      Number(row.open),
      Number(row.high),
      Number(row.low),
      Number(row.close),
      Number(row.volume),
      compactSnapshot(row.boardSnapshot),
    ]),
  });
}
await connection.end();

const output = `${JSON.stringify({
  schemaVersion: 1,
  provenance: {
    source: "rt_candles/KABU Station",
    symbol: "6976",
    duplicateRule: "tradeDate+candleTimeごとに最大id",
    causality: "各segmentは09:00台の先頭保存足から期待決済足まで。未来足・外部データなし",
    generatedAt: "2026-08-29",
  },
  rowFormat: ["candleTime", "open", "high", "low", "close", "volume", "boardSnapshot"],
  segments,
}, null, 2)}\n`;
process.stdout.write(output, () => process.exit(0));
