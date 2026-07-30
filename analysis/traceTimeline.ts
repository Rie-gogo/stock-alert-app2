import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

async function main() {
  const db = await getDb();
  
  // For 285A: entry at 10:02 at ¥42,230
  // Entry reason: "大台確認(5本維持): 大台超え (38900円突破)｜[信頼度：強]... (押し目なし・強トレンド)"
  // This means: 38900円 was the round level that triggered the signal
  // Then 5 bars of confirmation were needed
  // Then pullback wait (max 5 bars), timed out → "押し目なし・強トレンド" entry
  
  // From the candle data:
  // 09:10 - first 38900 crossing (close=39330)
  // But price dropped back below 38900 after that (09:11 close=38260, 09:12 close=38030)
  // So the confirmation would fail (price went below the round level)
  
  // 09:23 - second 38900 crossing (close=39060)
  // 09:24 close=39210, 09:25 close=39420, 09:26 close=40320, 09:27 close=40400
  // But then 09:28 close=40720... wait let me check if it dropped below 38900
  
  console.log('=== 285A 38900円突破の確認バー追跡 ===\n');
  
  const allCandles = await db.execute(sql`
    SELECT candleTime, open, high, low, close, volume
    FROM rt_candles 
    WHERE tradeDate = '2026-07-30' AND symbol = '285A'
      AND candleTime >= '09:00' AND candleTime <= '10:05'
    ORDER BY candleTime
  `);
  
  const rows = (allCandles as any)[0];
  
  // Simulate the round level state machine for 38900
  // The signal is: prev.close < 38900 AND curr.close >= 38900
  // Then need 5 consecutive bars with close >= 38900
  
  let pendingState: { level: number; confirmCount: number; startTime: string } | null = null;
  let pullbackState: { signalPrice: number; waitCount: number; startTime: string } | null = null;
  
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i-1];
    const curr = rows[i];
    const prevClose = Number(prev.close);
    const currClose = Number(curr.close);
    
    // Check for round level crossing (using step=100)
    const prevLevel = Math.floor(prevClose / 100) * 100;
    const currLevel = Math.floor(currClose / 100) * 100;
    
    // Process pending state
    if (pendingState) {
      if (currClose < pendingState.level) {
        console.log(`  ${curr.candleTime} | 確認失敗: close=${currClose} < level=${pendingState.level} (count=${pendingState.confirmCount})`);
        pendingState = null;
      } else {
        pendingState.confirmCount++;
        if (pendingState.confirmCount >= 5) {
          console.log(`  ${curr.candleTime} | ★確認完了(5本維持): close=${currClose} → 押し目待ち開始 (signalPrice=${currClose})`);
          pullbackState = { signalPrice: currClose, waitCount: 0, startTime: curr.candleTime };
          pendingState = null;
        }
      }
    }
    
    // Process pullback state
    if (pullbackState) {
      pullbackState.waitCount++;
      if (pullbackState.waitCount > 5) {
        console.log(`  ${curr.candleTime} | ★押し目タイムアウト(5本超) → 強トレンドエントリー: close=${currClose}`);
        pullbackState = null;
        // Don't continue - this would be the entry point
      }
    }
    
    // Detect new round level crossing (only if no pending state)
    if (!pendingState && !pullbackState && currLevel > prevLevel) {
      // Multiple levels could be crossed - check which ones
      // The signal detection in stockData.ts only fires once per candle
      // and uses step=100
      // For the specific 38900 level:
      if (prevClose < 38900 && currClose >= 38900) {
        console.log(`  ${curr.candleTime} | 大台超え検出: 38900円突破 (prev=${prevClose} → curr=${currClose})`);
        pendingState = { level: 38900, confirmCount: 0, startTime: curr.candleTime };
      }
    }
  }
  
  // Now the key insight: the signal detection in detectSignals uses step=100
  // But for a stock at 42000, MANY round levels are crossed during a strong rally
  // The FIRST one that gets confirmed (5 bars above) triggers the entry
  // But by that time, price has moved far from the original round level
  
  console.log('\n\n=== 重要な発見 ===');
  console.log('detectRoundLevel()は100円刻みのキリ番を使用');
  console.log('285Aは09:00の37300円から10:02の42230円まで急騰（+13.2%）');
  console.log('この間に多数のキリ番を突破するが、detectSignals()は1足につき1シグナルのみ');
  console.log('かつ、他のシグナル（ダウ理論等）が優先されると大台超えは検出されない');
  console.log('');
  console.log('エントリーまでの遅延:');
  console.log('  1. 大台超え検出: 1分（キリ番を超えた足）');
  console.log('  2. 確認バー: 5分（5本連続でキリ番上に維持）');
  console.log('  3. 押し目待ち: 最大5分（押し目が来なければタイムアウト）');
  console.log('  合計: 最低6分、最大11分の遅延');
  console.log('');
  console.log('5分早くエントリーするには:');
  console.log('  A) 確認バーを5本→3本に短縮 → 2分短縮');
  console.log('  B) 押し目待ちを5本→2本に短縮 → 3分短縮');
  console.log('  C) 確認バー3本 + 押し目待ち2本 → 合計5分短縮');
  console.log('  D) 確認バーを撤廃し即エントリー → 5分短縮（ただしダマシ増加リスク）');

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
