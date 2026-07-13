import mysql from "mysql2/promise";
const conn = await mysql.createConnection(process.env.DATABASE_URL);

const [rows] = await conn.query(`
  SELECT 
    symbol,
    COUNT(*) as trades,
    SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
    SUM(CASE WHEN pnl <= 0 THEN 1 ELSE 0 END) as losses,
    SUM(pnl) as totalPnl,
    SUM(CASE WHEN pnl > 0 THEN pnl ELSE 0 END) as grossProfit,
    SUM(CASE WHEN pnl < 0 THEN pnl ELSE 0 END) as grossLoss,
    MAX(pnl) as bestTrade,
    MIN(pnl) as worstTrade
  FROM rt_trades
  WHERE tradeDate >= '2026-07-01'
    AND (action = 'sell' OR action = 'cover')
  GROUP BY symbol
  ORDER BY SUM(pnl) DESC
`);

console.log("=== 7/1以降 銘柄別損益 ===\n");
console.log("銘柄     | 取引数 | 勝敗      | 勝率  | PF   | 総損益       | 最大利益    | 最大損失");
console.log("---------|--------|-----------|-------|------|-------------|------------|--------");

let totalPnl = 0;
let totalTrades = 0;
let totalWins = 0;
let totalLosses = 0;
let totalGross = 0;
let totalLoss = 0;

for (const r of rows) {
  const trades = Number(r.trades);
  const wins = Number(r.wins);
  const losses = Number(r.losses);
  const pnl = Number(r.totalPnl);
  const gross = Number(r.grossProfit);
  const loss = Math.abs(Number(r.grossLoss));
  const pf = loss > 0 ? (gross / loss).toFixed(2) : '∞';
  const wr = ((wins / trades) * 100).toFixed(0);
  const best = Number(r.bestTrade);
  const worst = Number(r.worstTrade);
  
  totalPnl += pnl;
  totalTrades += trades;
  totalWins += wins;
  totalLosses += losses;
  totalGross += gross;
  totalLoss += loss;
  
  console.log(
    `${r.symbol.padEnd(8)} | ${String(trades).padStart(4)}件 | ${wins}勝${losses}敗`.padEnd(40) +
    ` | ${wr.padStart(3)}% | ${pf.padStart(4)} | ${(pnl >= 0 ? '+' : '') + Math.round(pnl).toLocaleString() + '円'}`.padEnd(25) +
    ` | ${(best >= 0 ? '+' : '') + Math.round(best).toLocaleString()}円 | ${Math.round(worst).toLocaleString()}円`
  );
}

console.log("---------|--------|-----------|-------|------|-------------|------------|--------");
const totalWR = ((totalWins / totalTrades) * 100).toFixed(0);
const totalPF = totalLoss > 0 ? (totalGross / totalLoss).toFixed(2) : '∞';
console.log(
  `合計     | ${String(totalTrades).padStart(4)}件 | ${totalWins}勝${totalLosses}敗`.padEnd(40) +
  ` | ${totalWR.padStart(3)}% | ${totalPF.padStart(4)} | ${(totalPnl >= 0 ? '+' : '') + Math.round(totalPnl).toLocaleString() + '円'}`
);

// Also show daily breakdown
console.log("\n\n=== 7/1以降 日別損益 ===\n");
const [daily] = await conn.query(`
  SELECT 
    tradeDate,
    COUNT(*) as trades,
    SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
    SUM(CASE WHEN pnl <= 0 THEN 1 ELSE 0 END) as losses,
    SUM(pnl) as totalPnl
  FROM rt_trades
  WHERE tradeDate >= '2026-07-01'
    AND (action = 'sell' OR action = 'cover')
  GROUP BY tradeDate
  ORDER BY tradeDate
`);

let cumPnl = 0;
console.log("日付       | 取引数 | 勝敗      | 日次損益      | 累計損益");
console.log("-----------|--------|-----------|--------------|--------");
for (const d of daily) {
  const pnl = Number(d.totalPnl);
  cumPnl += pnl;
  console.log(
    `${d.tradeDate} | ${String(Number(d.trades)).padStart(4)}件 | ${d.wins}勝${d.losses}敗`.padEnd(38) +
    ` | ${(pnl >= 0 ? '+' : '') + Math.round(pnl).toLocaleString() + '円'}`.padEnd(15) +
    ` | ${(cumPnl >= 0 ? '+' : '') + Math.round(cumPnl).toLocaleString()}円`
  );
}

await conn.end();
