import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

async function main() {
  const db = await getDb();
  
  // For 285A entry at 10:02 with reason "大台確認(5本維持): 大台超え (38900円突破)"
  // The signal says 38900円突破 but entry was at 42230円
  // This means the round level detected was 38900 (step=100 for this price range?)
  // Wait - 285A is priced at ~42000. Let me check the actual candle data
  
  console.log('=== 285A 7/30 大台超えシグナルのタイムライン ===\n');
  
  // Get candles around the entry time
  const candles285A = await db.execute(sql`
    SELECT candleTime, open, high, low, close, volume
    FROM rt_candles 
    WHERE tradeDate = '2026-07-30' AND symbol = '285A'
      AND candleTime >= '09:50' AND candleTime <= '10:10'
    ORDER BY candleTime
  `);
  
  console.log('285A 09:50-10:10の1分足:');
  for (const c of (candles285A as any)[0]) {
    console.log(`  ${c.candleTime} | O=${c.open} H=${c.high} L=${c.low} C=${c.close} | Vol=${c.volume}`);
  }
  
  // The entry reason says "大台超え (38900円突破)" but price is ~42000
  // This is suspicious - let's check what round levels exist for 285A
  // detectRoundLevel uses step=100, so for 42000 range, round levels are 42000, 42100, etc.
  // But the reason says 38900... this might be from the signal detection earlier
  
  // Let me check when the actual round level crossing happened
  console.log('\n\n=== 285A 大台超えの実際のタイミング ===');
  console.log('大台確認(5本維持)の仕組み:');
  console.log('  1. detectSignals()で「大台超え」を検出 → roundLevelPendingStatesに登録');
  console.log('  2. 5本連続でキリ番の上に維持 → 確認完了');
  console.log('  3. 押し目待ち(最大5本) or 強トレンドエントリー');
  console.log('  合計: 最低5分 + 最大5分 = 5〜10分の遅延\n');
  
  // Check 8035 entry at 10:06 - reason "大台超え (51800円突破)"
  console.log('\n=== 8035 7/30 大台超えシグナルのタイムライン ===\n');
  const candles8035 = await db.execute(sql`
    SELECT candleTime, open, high, low, close, volume
    FROM rt_candles 
    WHERE tradeDate = '2026-07-30' AND symbol = '8035'
      AND candleTime >= '09:50' AND candleTime <= '10:10'
    ORDER BY candleTime
  `);
  
  console.log('8035 09:50-10:10の1分足:');
  for (const c of (candles8035 as any)[0]) {
    console.log(`  ${c.candleTime} | O=${c.open} H=${c.high} L=${c.low} C=${c.close} | Vol=${c.volume}`);
  }
  
  // Check 6981 entry at 10:06 - reason "大台超え (6500円突破)"
  console.log('\n\n=== 6981 7/30 大台超えシグナルのタイムライン ===\n');
  const candles6981 = await db.execute(sql`
    SELECT candleTime, open, high, low, close, volume
    FROM rt_candles 
    WHERE tradeDate = '2026-07-30' AND symbol = '6981'
      AND candleTime >= '09:50' AND candleTime <= '10:10'
    ORDER BY candleTime
  `);
  
  console.log('6981 09:50-10:10の1分足:');
  for (const c of (candles6981 as any)[0]) {
    console.log(`  ${c.candleTime} | O=${c.open} H=${c.high} L=${c.low} C=${c.close} | Vol=${c.volume}`);
  }
  
  // Now let's trace when the round level was actually crossed
  // For 285A: "38900円突破" means prev < 38900 and curr >= 38900
  // But wait - 285A opened at 37300 on 7/30. So 38900 crossing happened during the rally
  console.log('\n\n=== 285A キリ番38900円突破のタイミング ===');
  const candles285A_early = await db.execute(sql`
    SELECT candleTime, open, high, low, close, volume
    FROM rt_candles 
    WHERE tradeDate = '2026-07-30' AND symbol = '285A'
      AND candleTime >= '09:00' AND candleTime <= '10:05'
    ORDER BY candleTime
  `);
  
  let prevClose = 0;
  for (const c of (candles285A_early as any)[0]) {
    const close = Number(c.close);
    if (prevClose > 0 && prevClose < 38900 && close >= 38900) {
      console.log(`  ★38900円突破: ${c.candleTime} (prev=${prevClose} → curr=${close})`);
    }
    // Also check other round levels
    const prevLevel = Math.floor(prevClose / 100) * 100;
    const currLevel = Math.floor(close / 100) * 100;
    if (prevClose > 0 && currLevel > prevLevel) {
      console.log(`  キリ番超え: ${c.candleTime} | ${prevLevel}→${currLevel} (close=${close})`);
    }
    prevClose = close;
  }
  
  // For 8035: "51800円突破" 
  console.log('\n\n=== 8035 キリ番突破のタイミング ===');
  const candles8035_early = await db.execute(sql`
    SELECT candleTime, open, high, low, close, volume
    FROM rt_candles 
    WHERE tradeDate = '2026-07-30' AND symbol = '8035'
      AND candleTime >= '09:00' AND candleTime <= '10:10'
    ORDER BY candleTime
  `);
  
  prevClose = 0;
  for (const c of (candles8035_early as any)[0]) {
    const close = Number(c.close);
    const prevLevel = Math.floor(prevClose / 100) * 100;
    const currLevel = Math.floor(close / 100) * 100;
    if (prevClose > 0 && currLevel > prevLevel && close >= 51800) {
      console.log(`  キリ番超え: ${c.candleTime} | ${prevLevel}→${currLevel} (close=${close})`);
    }
    prevClose = close;
  }

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
