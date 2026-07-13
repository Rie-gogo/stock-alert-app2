import mysql from "mysql2/promise";
const conn = await mysql.createConnection(process.env.DATABASE_URL);

// Current 13 symbols
const symbols = ['6920','8035','6857','6976','6526','8316','5803','6981','9107','8306','4568','285A','7203'];

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
    AND symbol IN (${symbols.map(s => `'${s}'`).join(',')})
  GROUP BY symbol
  ORDER BY SUM(pnl) DESC
`);

console.log("=== 現在の13銘柄 7/1以降 損益 ===\n");

let totalPnl = 0, totalTrades = 0, totalWins = 0, totalLosses = 0, totalGross = 0, totalLoss = 0;

for (const r of rows) {
  const trades = Number(r.trades);
  const wins = Number(r.wins);
  const losses = Number(r.losses);
  const pnl = Number(r.totalPnl);
  const gross = Number(r.grossProfit);
  const loss = Math.abs(Number(r.grossLoss));
  const pf = loss > 0 ? (gross / loss).toFixed(2) : '∞';
  const wr = ((wins / trades) * 100).toFixed(0);
  
  totalPnl += pnl; totalTrades += trades; totalWins += wins; totalLosses += losses;
  totalGross += gross; totalLoss += loss;
  
  console.log(`${r.symbol.padEnd(6)} | ${trades}件 | ${wins}勝${losses}敗 | 勝率${wr}% | PF ${pf} | ${pnl >= 0 ? '+' : ''}${Math.round(pnl).toLocaleString()}円 | 最大+${Math.round(Number(r.bestTrade)).toLocaleString()} / ${Math.round(Number(r.worstTrade)).toLocaleString()}円`);
}

// Symbols with no trades
const tradedSymbols = rows.map(r => r.symbol);
const noTrades = symbols.filter(s => !tradedSymbols.includes(s));
for (const s of noTrades) {
  console.log(`${s.padEnd(6)} | 0件 | 取引なし`);
}

console.log(`\n--- 合計 ---`);
console.log(`取引数: ${totalTrades}件 | ${totalWins}勝${totalLosses}敗 | 勝率${((totalWins/totalTrades)*100).toFixed(0)}% | PF ${(totalGross/totalLoss).toFixed(2)} | ${totalPnl >= 0 ? '+' : ''}${Math.round(totalPnl).toLocaleString()}円`);

// Compare with full 17 symbols
const [allRows] = await conn.query(`
  SELECT SUM(pnl) as total FROM rt_trades
  WHERE tradeDate >= '2026-07-01' AND (action = 'sell' OR action = 'cover')
`);
const allTotal = Number(allRows[0].total);
console.log(`\n全銘柄(除外前): ${allTotal >= 0 ? '+' : ''}${Math.round(allTotal).toLocaleString()}円`);
console.log(`13銘柄(除外後): ${totalPnl >= 0 ? '+' : ''}${Math.round(totalPnl).toLocaleString()}円`);
console.log(`除外効果: +${Math.round(totalPnl - allTotal).toLocaleString()}円`);

await conn.end();
