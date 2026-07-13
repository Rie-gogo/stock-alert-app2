import mysql from "mysql2/promise";
const conn = await mysql.createConnection(process.env.DATABASE_URL);

// Get all 285A entries
const [entries] = await conn.query(`
  SELECT tradeTime, tradeDate, price, shares, action FROM rt_trades 
  WHERE symbol = '285A' AND (action = 'buy' OR action = 'short')
  ORDER BY tradeDate, tradeTime
`);

console.log(`=== キオクシアHD (285A) 利確/損切りマトリクス シミュレーション ===`);
console.log(`対象: ${entries.length}件のエントリー\n`);

// TP/SL combinations to test
const tpLevels = [0.015, 0.02, 0.025, 0.03];
const slLevels = [0.005, 0.0075, 0.01, 0.012, 0.015];

// Results matrix
const results = {};
for (const tp of tpLevels) {
  for (const sl of slLevels) {
    results[`${tp}_${sl}`] = { wins: 0, losses: 0, totalPnl: 0, trades: [] };
  }
}

for (const entry of entries) {
  const entryPrice = Number(entry.price);
  const shares = Number(entry.shares);
  const isShort = entry.action === 'short';
  
  // Get candles after entry
  const [candles] = await conn.query(`
    SELECT candleTime, high, low, close FROM rt_candles
    WHERE symbol = '285A' AND tradeDate = ? AND candleTime > ? AND candleTime <= '15:30'
    ORDER BY candleTime ASC
  `, [entry.tradeDate, entry.tradeTime]);
  
  for (const tp of tpLevels) {
    for (const sl of slLevels) {
      const key = `${tp}_${sl}`;
      let tpPrice, slPrice;
      
      if (isShort) {
        tpPrice = entryPrice * (1 - tp);
        slPrice = entryPrice * (1 + sl);
      } else {
        tpPrice = entryPrice * (1 + tp);
        slPrice = entryPrice * (1 - sl);
      }
      
      let pnl = null;
      let reason = '';
      let exitTime = '';
      
      for (const c of candles) {
        const high = Number(c.high);
        const low = Number(c.low);
        
        if (isShort) {
          // SL check first (high >= slPrice)
          if (high >= slPrice) {
            pnl = (entryPrice - slPrice) * shares;
            reason = 'SL';
            exitTime = c.candleTime;
            break;
          }
          // TP check (low <= tpPrice)
          if (low <= tpPrice) {
            pnl = (entryPrice - tpPrice) * shares;
            reason = 'TP';
            exitTime = c.candleTime;
            break;
          }
        } else {
          // BUY: SL check (low <= slPrice)
          if (low <= slPrice) {
            pnl = (slPrice - entryPrice) * shares;
            reason = 'SL';
            exitTime = c.candleTime;
            break;
          }
          // TP check (high >= tpPrice)
          if (high >= tpPrice) {
            pnl = (tpPrice - entryPrice) * shares;
            reason = 'TP';
            exitTime = c.candleTime;
            break;
          }
        }
      }
      
      // End of day forced exit
      if (pnl === null && candles.length > 0) {
        const lastClose = Number(candles[candles.length - 1].close);
        if (isShort) {
          pnl = (entryPrice - lastClose) * shares;
        } else {
          pnl = (lastClose - entryPrice) * shares;
        }
        reason = 'EOD';
        exitTime = candles[candles.length - 1].candleTime;
      }
      
      if (pnl === null) pnl = 0;
      
      results[key].totalPnl += pnl;
      if (pnl > 0) results[key].wins++;
      else results[key].losses++;
      results[key].trades.push({ date: entry.tradeDate, time: entry.tradeTime, pnl, reason, exitTime });
    }
  }
}

// Print matrix
console.log("=== 損益マトリクス (総損益) ===\n");
const header = "SL \\ TP    | " + tpLevels.map(tp => `${(tp*100).toFixed(1)}%`.padStart(10)).join(" | ");
console.log(header);
console.log("-".repeat(header.length));

for (const sl of slLevels) {
  const row = slLevels.map(() => '').join('');
  const cells = tpLevels.map(tp => {
    const key = `${tp}_${sl}`;
    const r = results[key];
    const pnl = Math.round(r.totalPnl);
    return `${pnl >= 0 ? '+' : ''}${pnl.toLocaleString()}`.padStart(10);
  }).join(" | ");
  console.log(`${(sl*100).toFixed(2)}%`.padEnd(10) + "| " + cells);
}

console.log("\n=== 勝率マトリクス ===\n");
const header2 = "SL \\ TP    | " + tpLevels.map(tp => `${(tp*100).toFixed(1)}%`.padStart(10)).join(" | ");
console.log(header2);
console.log("-".repeat(header2.length));

for (const sl of slLevels) {
  const cells = tpLevels.map(tp => {
    const key = `${tp}_${sl}`;
    const r = results[key];
    const total = r.wins + r.losses;
    const wr = ((r.wins / total) * 100).toFixed(0);
    return `${wr}%(${r.wins}勝${r.losses}敗)`.padStart(10);
  }).join(" | ");
  console.log(`${(sl*100).toFixed(2)}%`.padEnd(10) + "| " + cells);
}

// PF matrix
console.log("\n=== PF(プロフィットファクター)マトリクス ===\n");
const header3 = "SL \\ TP    | " + tpLevels.map(tp => `${(tp*100).toFixed(1)}%`.padStart(10)).join(" | ");
console.log(header3);
console.log("-".repeat(header3.length));

for (const sl of slLevels) {
  const cells = tpLevels.map(tp => {
    const key = `${tp}_${sl}`;
    const r = results[key];
    const gross = r.trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
    const loss = Math.abs(r.trades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
    const pf = loss > 0 ? (gross / loss).toFixed(2) : '∞';
    return `${pf}`.padStart(10);
  }).join(" | ");
  console.log(`${(sl*100).toFixed(2)}%`.padEnd(10) + "| " + cells);
}

// Best combinations
console.log("\n=== ベスト5組み合わせ（総損益順） ===\n");
const sorted = Object.entries(results)
  .map(([key, r]) => {
    const [tp, sl] = key.split('_').map(Number);
    const gross = r.trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
    const loss = Math.abs(r.trades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
    const pf = loss > 0 ? gross / loss : 999;
    return { tp, sl, ...r, pf };
  })
  .sort((a, b) => b.totalPnl - a.totalPnl);

console.log("順位 | TP    | SL    | 勝率       | PF   | 総損益");
console.log("-----|-------|-------|------------|------|-------");
for (let i = 0; i < Math.min(10, sorted.length); i++) {
  const s = sorted[i];
  const total = s.wins + s.losses;
  const wr = ((s.wins / total) * 100).toFixed(0);
  const marker = (s.tp === 0.015 && s.sl === 0.005) ? ' ← 現在' : '';
  console.log(`  ${i+1}  | ${(s.tp*100).toFixed(1)}% | ${(s.sl*100).toFixed(2)}% | ${wr}%(${s.wins}勝${s.losses}敗) | ${s.pf.toFixed(2)} | ${s.totalPnl >= 0 ? '+' : ''}${Math.round(s.totalPnl).toLocaleString()}円${marker}`);
}

// Detail for top combinations
console.log("\n=== トップ3のトレード詳細 ===\n");
for (let i = 0; i < 3; i++) {
  const s = sorted[i];
  const key = `${s.tp}_${s.sl}`;
  console.log(`--- TP${(s.tp*100).toFixed(1)}% / SL${(s.sl*100).toFixed(2)}% (総損益: ${Math.round(s.totalPnl).toLocaleString()}円) ---`);
  for (const t of results[key].trades) {
    console.log(`  ${t.date} ${t.time}: ${t.reason} @${t.exitTime} → ${t.pnl >= 0 ? '+' : ''}${Math.round(t.pnl).toLocaleString()}円`);
  }
  console.log('');
}

await conn.end();
