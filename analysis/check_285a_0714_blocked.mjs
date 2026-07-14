import mysql from "mysql2/promise";
const conn = await mysql.createConnection(process.env.DATABASE_URL);

const today = '2026-07-14';

// 1. Get ALL trades for today to understand position timeline
const [allTrades] = await conn.query(`
  SELECT symbol, action, tradeTime, price, shares, pnl, reason
  FROM rt_trades
  WHERE tradeDate = ?
  ORDER BY tradeTime ASC
`, [today]);

console.log("=== 7/14 全取引タイムライン ===\n");
for (const t of allTrades) {
  console.log(`${t.tradeTime} | ${t.symbol.padEnd(6)} | ${t.action.padEnd(6)} | @${Number(t.price).toLocaleString().padStart(7)} x${t.shares} | ${t.reason?.substring(0, 60) || ''}`);
}

// 2. Reconstruct position state at each point in time
console.log("\n\n=== ポジション状態の推移 ===\n");
const positions = new Map(); // symbol -> { entryPrice, shares, direction }
const timeline = [];

for (const t of allTrades) {
  if (t.action === 'buy' || t.action === 'short') {
    positions.set(t.symbol, {
      entryPrice: Number(t.price),
      shares: Number(t.shares),
      direction: t.action === 'buy' ? 'LONG' : 'SHORT'
    });
  } else {
    positions.delete(t.symbol);
  }
  
  // Calculate exposure
  let totalExposure = 0;
  for (const [sym, pos] of positions) {
    totalExposure += pos.entryPrice * pos.shares;
  }
  
  const posStr = [...positions.entries()].map(([s, p]) => `${s}(${p.direction}@${p.entryPrice.toLocaleString()})`).join(', ');
  timeline.push({
    time: t.tradeTime,
    exposure: totalExposure,
    posCount: positions.size,
    posStr
  });
  
  console.log(`${t.tradeTime} | ${t.action.padEnd(6)} ${t.symbol.padEnd(6)} | ポジション数:${positions.size} | 証拠金使用: ${Math.round(totalExposure).toLocaleString()}円 | ${posStr}`);
}

// 3. Check what was happening at 13:43 specifically
console.log("\n\n=== 13:43時点のポジション状態 ===\n");
const posAt1343 = new Map();
for (const t of allTrades) {
  if (t.tradeTime > '13:43') break;
  if (t.action === 'buy' || t.action === 'short') {
    posAt1343.set(t.symbol, {
      entryPrice: Number(t.price),
      shares: Number(t.shares),
      direction: t.action === 'buy' ? 'LONG' : 'SHORT'
    });
  } else {
    posAt1343.delete(t.symbol);
  }
}

let exposure1343 = 0;
for (const [sym, pos] of posAt1343) {
  exposure1343 += pos.entryPrice * pos.shares;
  console.log(`  ${sym}: ${pos.direction} @${pos.entryPrice.toLocaleString()} x${pos.shares} = ${(pos.entryPrice * pos.shares).toLocaleString()}円`);
}
console.log(`  合計証拠金使用: ${exposure1343.toLocaleString()}円`);
console.log(`  上限(891万円)までの余力: ${(8910000 - exposure1343).toLocaleString()}円`);
console.log(`  285A 100株に必要な証拠金: 約${(66070 * 100).toLocaleString()}円`);

if (posAt1343.size === 0) {
  console.log("  → 13:43時点でポジションなし！証拠金制限ではない。");
}

// 4. Check if there's a re-entry restriction
console.log("\n\n=== 再エントリー制限の確認 ===\n");
const firstEntry285A = allTrades.find(t => t.symbol === '285A' && (t.action === 'buy' || t.action === 'short'));
const firstExit285A = allTrades.find(t => t.symbol === '285A' && (t.action === 'sell' || t.action === 'cover'));
const secondEntry285A = allTrades.filter(t => t.symbol === '285A' && (t.action === 'buy' || t.action === 'short'))[1];

console.log(`1回目エントリー: ${firstEntry285A?.tradeTime} ${firstEntry285A?.action} @${Number(firstEntry285A?.price).toLocaleString()}`);
console.log(`1回目決済: ${firstExit285A?.tradeTime} ${firstExit285A?.action} @${Number(firstExit285A?.price).toLocaleString()} (${firstExit285A?.reason})`);
console.log(`2回目エントリー: ${secondEntry285A?.tradeTime} ${secondEntry285A?.action} @${Number(secondEntry285A?.price).toLocaleString()}`);
console.log(`\n1回目決済→2回目エントリーまでの時間: ${firstExit285A?.tradeTime} → ${secondEntry285A?.tradeTime}`);

// 5. Check the signal history for 285A to see if signals were generated but blocked
console.log("\n\n=== rt_signal_history テーブルの確認 ===");
try {
  const [sigHist] = await conn.query(`
    SELECT * FROM rt_signal_history
    WHERE tradeDate = ? AND symbol = '285A'
    ORDER BY detectedAt ASC
  `, [today]);
  if (sigHist.length > 0) {
    for (const s of sigHist) {
      console.log(`${s.detectedAt} | ${s.signalType} | ${s.action} | ${s.status || ''} | ${s.reason || ''}`);
    }
  } else {
    console.log("rt_signal_historyにデータなし");
  }
} catch (e) {
  console.log(`テーブルなし: ${e.message}`);
}

// 6. Check if there's a "same symbol same direction" cooldown in the engine
console.log("\n\n=== 大台超えシグナル: 5本維持の条件 ===");
console.log("エンジンの大台超えシグナルは「5本連続で大台を維持」が条件。");
console.log("13:43に66000超えが発生したが、5本維持の確認が必要。");

// Check 66000 maintenance
const [candles66k] = await conn.query(`
  SELECT candleTime, close FROM rt_candles
  WHERE tradeDate = ? AND symbol = '285A' AND candleTime >= '13:43' AND candleTime <= '13:50'
  ORDER BY candleTime
`, [today]);
console.log("\n66000大台超え後の5本維持チェック:");
for (const c of candles66k) {
  console.log(`  ${c.candleTime}: ${Number(c.close).toLocaleString()} ${Number(c.close) >= 66000 ? '✅ 維持' : '❌ 割れ'}`);
}

// Check 67000 maintenance
const [candles67k] = await conn.query(`
  SELECT candleTime, close FROM rt_candles
  WHERE tradeDate = ? AND symbol = '285A' AND candleTime >= '13:55' AND candleTime <= '14:02'
  ORDER BY candleTime
`, [today]);
console.log("\n67000大台超え後の5本維持チェック:");
for (const c of candles67k) {
  console.log(`  ${c.candleTime}: ${Number(c.close).toLocaleString()} ${Number(c.close) >= 67000 ? '✅ 維持' : '❌ 割れ'}`);
}

// Check 68000 maintenance
const [candles68k] = await conn.query(`
  SELECT candleTime, close FROM rt_candles
  WHERE tradeDate = ? AND symbol = '285A' AND candleTime >= '14:10' AND candleTime <= '14:17'
  ORDER BY candleTime
`, [today]);
console.log("\n68000大台超え後の5本維持チェック:");
for (const c of candles68k) {
  console.log(`  ${c.candleTime}: ${Number(c.close).toLocaleString()} ${Number(c.close) >= 68000 ? '✅ 維持' : '❌ 割れ'}`);
}

await conn.end();
