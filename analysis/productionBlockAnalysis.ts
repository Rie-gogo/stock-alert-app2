import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

async function main() {
  const db = await getDb();

  // The fullFilterTrace simulation is DIFFERENT from production because:
  // 1. It runs on ALL 20 symbols (production excludes 10)
  // 2. It doesn't apply board score filter (no board data in simulation)
  // 3. It doesn't apply HTF filter
  // 4. It doesn't apply sell_pressure filter
  // 5. It doesn't apply TRADE_EXCLUDED_SYMBOLS filter
  
  // In production, the filter chain for BUY is:
  // 1. TRADE_EXCLUDED_SYMBOLS → blocks 10 symbols entirely
  // 2. VWAPクロス上抜け無効化
  // 3. sell_pressure → blocks if board shows sell pressure
  // 4. 板読みスコア < 1 → blocks if board data gives low score
  // 5. 3分足HTFフィルター → blocks if 3-min trend is down
  // 6. ダウ理論 → push-back state machine
  // 7. 大台超え → confirmation state machine
  // 8. medium直接ブロック
  // 9. Only strong signals with non-大台超え/ダウ理論 pass through directly
  
  // For SHORT:
  // 1. TRADE_EXCLUDED_SYMBOLS
  // 2. buy_pressure → blocks if board shows buy pressure
  // 3. 板読みスコア < 1
  // 4. 3分足HTFフィルター (blocks if htf=up)
  // 5. isBullish → blocks SHORT if market is bullish
  // 6. 大台割れ → confirmation state machine
  // 7. medium直接ブロック
  
  // The key insight: before 7/16, there were 20 active symbols
  // After 7/16, only 7 active symbols (then 10 after 7/23)
  // This alone reduces potential entries by 50-65%!
  
  // Let's verify: how many of the 7/1-7/16 entries were from now-excluded symbols?
  const r1 = await db.execute(sql`
    SELECT symbol, COUNT(*) as entries
    FROM rt_trades 
    WHERE tradeDate >= '2026-07-01' AND tradeDate <= '2026-07-16'
    AND (action = 'buy' OR action = 'short')
    GROUP BY symbol
    ORDER BY entries DESC
  `);
  console.log("■ 7/1-7/16 エントリー数（銘柄別）");
  let totalBefore = 0;
  let excludedBefore = 0;
  const excludedSymbols = new Set(['9984', '7011', '9107', '8306', '4568', '5016', '7203', '3778', '3436', '6723']);
  for (const row of (r1 as any)[0]) {
    const isExcluded = excludedSymbols.has(row.symbol);
    const marker = isExcluded ? ' ← 7/16以降除外' : '';
    console.log(`  ${row.symbol}: ${row.entries}件${marker}`);
    totalBefore += Number(row.entries);
    if (isExcluded) excludedBefore += Number(row.entries);
  }
  console.log(`\n  合計: ${totalBefore}件`);
  console.log(`  うち除外銘柄: ${excludedBefore}件 (${(excludedBefore/totalBefore*100).toFixed(1)}%)`);
  console.log(`  アクティブ銘柄のみ: ${totalBefore - excludedBefore}件`);

  // Also check: were there entries from 6920, 6758, 8316 before 7/16?
  // These were excluded 7/16 but restored 7/23
  const r2 = await db.execute(sql`
    SELECT symbol, COUNT(*) as entries
    FROM rt_trades 
    WHERE tradeDate >= '2026-07-01' AND tradeDate <= '2026-07-16'
    AND (action = 'buy' OR action = 'short')
    AND symbol IN ('6920', '6758', '8316')
    GROUP BY symbol
  `);
  console.log("\n■ 7/23復活銘柄の7/1-7/16エントリー:");
  for (const row of (r2 as any)[0]) {
    console.log(`  ${row.symbol}: ${row.entries}件`);
  }

  // Now check: medium block was added when?
  // The "★改良策3改: medium直接エントリー禁止" - when was this added?
  console.log("\n■ medium直接エントリー禁止の影響:");
  console.log("  7/1-7/16のエントリーのうちmedium信頼度のものを確認");
  
  const r3 = await db.execute(sql`
    SELECT tradeDate, COUNT(*) as cnt
    FROM rt_trades 
    WHERE tradeDate >= '2026-07-01' AND tradeDate <= '2026-07-16'
    AND (action = 'buy' OR action = 'short')
    AND reason LIKE '%medium%'
    GROUP BY tradeDate
    ORDER BY tradeDate
  `);
  console.log("  medium含むエントリー:");
  for (const row of (r3 as any)[0]) {
    console.log(`    ${row.tradeDate}: ${row.cnt}件`);
  }

  // Check confidence levels in reason field
  const r4 = await db.execute(sql`
    SELECT 
      CASE 
        WHEN reason LIKE '%信頼度：強%' THEN 'strong'
        WHEN reason LIKE '%信頼度：中%' OR reason LIKE '%medium%' THEN 'medium'
        ELSE 'unknown'
      END as confidence,
      COUNT(*) as cnt
    FROM rt_trades 
    WHERE tradeDate >= '2026-07-01' AND tradeDate <= '2026-07-16'
    AND (action = 'buy' OR action = 'short')
    GROUP BY confidence
  `);
  console.log("\n  信頼度別エントリー (7/1-7/16):");
  for (const row of (r4 as any)[0]) {
    console.log(`    ${row.confidence}: ${row.cnt}件`);
  }

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
