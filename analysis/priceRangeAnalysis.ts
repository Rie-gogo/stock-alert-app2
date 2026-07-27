import { getDb } from "../server/db";
import { sql } from "drizzle-orm";
import { calculateRoundDistancePct } from "../server/realtimeSimEngine";

async function main() {
  const db = await getDb();

  // Get all 大台 entries 7/1-7/16 with their details
  const r1 = await db.execute(sql`
    SELECT tradeDate, tradeTime, symbol, action, price, reason, pnl
    FROM rt_trades 
    WHERE tradeDate >= '2026-07-01' AND tradeDate <= '2026-07-16'
    AND (action = 'buy' OR action = 'short')
    AND (reason LIKE '%大台超え%' OR reason LIKE '%大台割れ%' OR reason LIKE '%大台確認%')
    ORDER BY tradeDate, tradeTime
  `);
  
  // Categorize by whether they'd be blocked
  const bySymbol: Record<string, { total: number, blocked: number, passed: number, blockedPnl: number, passedPnl: number }> = {};
  
  for (const row of (r1 as any)[0]) {
    const reason = row.reason as string;
    const entryPrice = Number(row.price);
    const sym = row.symbol as string;
    
    if (!bySymbol[sym]) bySymbol[sym] = { total: 0, blocked: 0, passed: 0, blockedPnl: 0, passedPnl: 0 };
    bySymbol[sym].total++;
    
    const levelMatch = reason.match(/大台(?:超え|割れ)\s*\((\d+)円/);
    if (!levelMatch) continue;
    const roundLevel = parseFloat(levelMatch[1]);
    const distPct = calculateRoundDistancePct(entryPrice, roundLevel);
    
    // Get exit PnL
    const exitResult = await db.execute(sql`
      SELECT pnl FROM rt_trades 
      WHERE tradeDate = ${row.tradeDate} AND symbol = ${sym}
      AND action NOT IN ('buy', 'short') AND tradeTime > ${row.tradeTime}
      ORDER BY tradeTime ASC LIMIT 1
    `);
    const pnl = (exitResult as any)[0][0] ? Number((exitResult as any)[0][0].pnl) : 0;
    
    if (distPct > 0.8) {
      bySymbol[sym].blocked++;
      bySymbol[sym].blockedPnl += pnl;
    } else {
      bySymbol[sym].passed++;
      bySymbol[sym].passedPnl += pnl;
    }
  }
  
  console.log("■ 銘柄別 0.8%フィルター影響分析（7/1-7/16）\n");
  console.log(`${"銘柄".padEnd(8)} ${"株価帯".padStart(8)} ${"全件".padStart(4)} ${"ブロック".padStart(6)} ${"通過".padStart(4)} ${"ブロック率".padStart(8)} ${"ブロック損益".padStart(12)} ${"通過損益".padStart(12)}`);
  console.log("-".repeat(80));
  
  const priceRanges: Record<string, number> = {
    "6526": 2500, "5016": 4000, "5803": 5000, "9984": 6000,
    "6981": 7500, "6976": 15000, "6857": 30000, "6920": 45000,
    "8035": 65000, "285A": 75000
  };
  
  for (const [sym, data] of Object.entries(bySymbol).sort((a, b) => (priceRanges[a[0]] || 0) - (priceRanges[b[0]] || 0))) {
    const price = priceRanges[sym] || 0;
    const blockRate = (data.blocked / data.total * 100).toFixed(0);
    console.log(
      `${sym.padEnd(8)} ${(price + "円").padStart(8)} ${String(data.total).padStart(4)} ${String(data.blocked).padStart(6)} ${String(data.passed).padStart(4)} ${(blockRate + "%").padStart(8)} ${(data.blockedPnl >= 0 ? "+" : "") + data.blockedPnl.toLocaleString() + "円".padStart(12)} ${(data.passedPnl >= 0 ? "+" : "") + data.passedPnl.toLocaleString() + "円"}`
    );
  }
  
  // Now check what the ACTUAL behavior is in production 7/17-7/24
  console.log("\n\n■ 7/17-7/24 実際の大台エントリー（0.8%フィルター適用後）:");
  const r2 = await db.execute(sql`
    SELECT tradeDate, tradeTime, symbol, action, price, reason
    FROM rt_trades 
    WHERE tradeDate >= '2026-07-17'
    AND (action = 'buy' OR action = 'short')
    AND (reason LIKE '%大台超え%' OR reason LIKE '%大台割れ%' OR reason LIKE '%大台確認%')
    ORDER BY tradeDate, tradeTime
  `);
  
  for (const row of (r2 as any)[0]) {
    const reason = row.reason as string;
    const entryPrice = Number(row.price);
    const levelMatch = reason.match(/大台(?:超え|割れ)\s*\((\d+)円/);
    const roundLevel = levelMatch ? parseFloat(levelMatch[1]) : 0;
    const distPct = roundLevel > 0 ? calculateRoundDistancePct(entryPrice, roundLevel) : -1;
    const exitResult = await db.execute(sql`
      SELECT pnl FROM rt_trades 
      WHERE tradeDate = ${row.tradeDate} AND symbol = ${row.symbol}
      AND action NOT IN ('buy', 'short') AND tradeTime > ${row.tradeTime}
      ORDER BY tradeTime ASC LIMIT 1
    `);
    const pnl = (exitResult as any)[0][0] ? Number((exitResult as any)[0][0].pnl) : 0;
    console.log(`  ${row.tradeDate} ${row.tradeTime} ${row.symbol} ${row.action} @${entryPrice} キリ番=${roundLevel} 乖離=${distPct.toFixed(2)}% → ${pnl >= 0 ? "+" : ""}${pnl.toLocaleString()}円`);
  }

  // Summary
  console.log("\n■ 構造的問題のまとめ:");
  console.log("  キリ番ステップ: 固定100円");
  console.log("  確認バー: 5本（5分）");
  console.log("  押し目待ち: 最大5本（5分）");
  console.log("  → エントリーまで最短5分、最長10分の遅延");
  console.log("  → この間に価格がキリ番から0.8%以上動くと全てブロック");
  console.log("  → 高ボラティリティ銘柄ほど影響大");

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
