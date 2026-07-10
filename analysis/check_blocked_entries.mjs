import mysql from "mysql2/promise";
const conn = await mysql.createConnection(process.env.DATABASE_URL);

// On 7/7, exposure hit 881万/891万 (99%) at 13:50 with 6920 holding 435万
// If 6920 wasn't there, exposure would be 446万 → 445万 headroom for new entries
// Check if there were any signals around that time that could have entered

// Look at all entry signals on 7/7 between 13:25 and 14:15 (when 6920 was holding position)
const [trades] = await conn.query(`
  SELECT tradeDate, symbol, symbolName, action, price, shares, tradeTime, reason, amount
  FROM rt_trades
  WHERE tradeDate = '2026-07-07'
    AND tradeTime >= '13:25' AND tradeTime <= '14:15'
  ORDER BY tradeTime
`);

console.log("=== 7/7 13:25-14:15 の全取引（6920保有中）===");
for (const t of trades) {
  const amt = Number(t.amount) || Number(t.price) * Number(t.shares);
  console.log(`  ${t.tradeTime} ${t.symbol}(${t.symbolName}) ${t.action} @${t.price} x${t.shares} = ${(amt/10000).toFixed(0)}万円`);
  if (t.reason) console.log(`    理由: ${t.reason.substring(0, 80)}`);
}

// The key question: at 13:50, 6981 entered with exposure at 881万 (with 6920's 435万)
// Without 6920, exposure would be 446万 at that point
// Was there another signal that was blocked because exposure was too high?
// We can't know from rt_trades alone - blocked entries don't get recorded there.
// But we can check: after 6981 entered at 13:50 (exposure=881万), 
// the next entry was 6976 at 14:02 (after 6920 exited at 13:31 and 6981 exited)
// So the sequence was:
// 13:25 6920 SHORT (435万)
// 13:31 5016 COVER (exit)  
// 13:40 5803 SHORT (258万) → exposure = 435+258 = 693万
// 13:50 6981 SHORT (188万) → exposure = 435+258+188 = 881万 ← NEAR LIMIT!
// At this point, if another signal came, it would be BLOCKED (only 10万 headroom)
// 13:31 6920 COVER (exit) → but wait, 6920 exited at 14:03!

// Let me re-check the exact timeline
console.log("\n=== 7/7 全取引タイムライン ===");
const [allDay] = await conn.query(`
  SELECT tradeDate, symbol, symbolName, action, price, shares, tradeTime, amount
  FROM rt_trades
  WHERE tradeDate = '2026-07-07'
  ORDER BY tradeTime
`);

const openPos = new Map();
for (const t of allDay) {
  const amt = Number(t.amount) || Number(t.price) * Number(t.shares);
  if (t.action === 'buy' || t.action === 'short') {
    openPos.set(t.symbol, amt);
  } else {
    openPos.delete(t.symbol);
  }
  const totalExp = Array.from(openPos.values()).reduce((s, v) => s + v, 0);
  const expWithout = Array.from(openPos.entries())
    .filter(([sym]) => !['5016', '6920'].includes(sym))
    .reduce((s, [_, v]) => s + v, 0);
  const headroom = 8910000 - totalExp;
  const headroomWithout = 8910000 - expWithout;
  
  if (totalExp > 6000000) { // Only show high-exposure moments
    console.log(`  ${t.tradeTime} ${t.symbol} ${t.action} | 合計: ${(totalExp/10000).toFixed(0)}万円 | 除外なし: ${(expWithout/10000).toFixed(0)}万円 | 余力: ${(headroom/10000).toFixed(0)}万円 → 除外後余力: ${(headroomWithout/10000).toFixed(0)}万円`);
  }
}

await conn.end();
