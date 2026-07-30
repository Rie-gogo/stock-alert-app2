import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

async function main() {
  const db = await getDb();
  
  // The actual entry was at 10:02 at ¥42,230
  // But my simulation shows the 38900 confirmation would have completed at 09:28 or 09:50
  // The actual system must have had other signals taking priority, or the state machine
  // was occupied by earlier signals
  
  // Key insight: the system uses detectSignals() which evaluates signals in priority order
  // If a higher-priority signal (ダウ理論, デッドクロス, etc.) fires first, 大台超え won't be detected
  // Also, only ONE pending state per symbol is allowed (Map<string, state>)
  
  // The actual entry reason says "大台超え (38900円突破)" - this is the ORIGINAL signal reason
  // But the entry happened much later because:
  // 1. The state machine was occupied by earlier signals/states
  // 2. Other filters blocked the entry
  // 3. The position was already occupied
  
  // Let me check if there was a position open during 09:28-10:02
  console.log('=== 285A 本日の全トレード ===');
  const trades = await db.execute(sql`
    SELECT action, tradeTime, price, pnl, reason
    FROM rt_trades 
    WHERE tradeDate = '2026-07-30' AND symbol = '285A'
    ORDER BY tradeTime
  `);
  for (const t of (trades as any)[0]) {
    console.log(`  ${t.tradeTime} | ${t.action} | ¥${t.price} | PnL=${t.pnl || '-'} | ${t.reason}`);
  }
  
  // The entry at 10:02 says "大台確認(5本維持): 大台超え (38900円突破)｜[信頼度：強]"
  // But the price at 10:02 was ¥42,230 - that's 8.5% above 38900!
  // This means the signal was detected much earlier but entry was delayed
  
  // Actually wait - looking at the code again:
  // roundLevelPendingStates is a Map<string, state> - only ONE pending per symbol
  // If a new 大台超え signal fires while one is pending, it REPLACES the old one
  // 
  // The actual flow must be:
  // - Multiple 大台超え signals fire as price keeps rising through 100-yen levels
  // - Each new one replaces the previous pending state
  // - The LAST one that successfully confirms 5 bars is what triggers the entry
  
  // For 285A at 10:02 with close=42230:
  // The round level that was confirmed must be much higher than 38900
  // Let me check what round level crossing happened ~5-10 minutes before 10:02
  
  console.log('\n\n=== 285A 09:50-10:02のキリ番超え追跡 ===');
  const candles = await db.execute(sql`
    SELECT candleTime, open, high, low, close, volume
    FROM rt_candles 
    WHERE tradeDate = '2026-07-30' AND symbol = '285A'
      AND candleTime >= '09:50' AND candleTime <= '10:05'
    ORDER BY candleTime
  `);
  
  let prevClose = 0;
  for (const c of (candles as any)[0]) {
    const close = Number(c.close);
    const prevLevel = Math.floor(prevClose / 100) * 100;
    const currLevel = Math.floor(close / 100) * 100;
    if (prevClose > 0) {
      if (currLevel > prevLevel) {
        console.log(`  ${c.candleTime} | キリ番超え: ${prevLevel}→${currLevel} (close=${close})`);
      } else {
        console.log(`  ${c.candleTime} | close=${close} (変化なし)`);
      }
    } else {
      console.log(`  ${c.candleTime} | close=${close} (初期)`);
    }
    prevClose = close;
  }
  
  // The entry reason says "38900円突破" - but this is the ORIGINAL signal reason from detectSignals
  // The state machine preserves the original reason when setting pendingState
  // So even though many round levels were crossed, the REASON stored is from the first detection
  // that eventually confirmed
  
  // Actually re-reading the code:
  // roundLevelPendingStates.set(symbol, { direction: "buy", level, confirmCount: 0, reason: sig.reason })
  // Each new 大台超え signal REPLACES the pending state
  // So the reason should be from the LATEST signal that was set
  
  // Unless... the pending state was already set and a new signal couldn't replace it
  // because detectSignals only fires ONE signal per candle, and if the pending state
  // is already set, the processCandle function checks the pending state FIRST (line 1008)
  // before looking for new signals
  
  console.log('\n\n=== 結論: エントリー遅延の構造 ===');
  console.log('');
  console.log('現在のフロー（大台超えBUY）:');
  console.log('  Step 1: detectSignals()が「大台超え」を検出');
  console.log('  Step 2: roundLevelPendingStatesに登録（確認待ち開始）');
  console.log('  Step 3: 5本連続でキリ番の上に維持 → 確認完了');
  console.log('  Step 4: roundPullbackStatesに移行（押し目待ち開始）');
  console.log('  Step 5a: 押し目が来た → 押し目確認後エントリー');
  console.log('  Step 5b: 5本待っても押し目なし → 強トレンドエントリー');
  console.log('');
  console.log('遅延の内訳:');
  console.log('  確認バー: 5分（ROUND_LEVEL_CONFIRM_BARS = 5）');
  console.log('  押し目待ち: 最大5分（ROUND_PULLBACK_MAX_WAIT = 5）');
  console.log('  合計最大: 10分の遅延');
  console.log('');
  console.log('5分早くエントリーする方法:');
  console.log('');
  console.log('【方法A】確認バーを3本に短縮（ROUND_LEVEL_CONFIRM_BARS = 3）');
  console.log('  効果: 2分短縮');
  console.log('  リスク: ダマシ（一時的な突破後の反落）が増える');
  console.log('');
  console.log('【方法B】押し目待ちを2本に短縮（ROUND_PULLBACK_MAX_WAIT = 2）');
  console.log('  効果: 3分短縮');
  console.log('  リスク: 押し目を待てず高値掴みが増える可能性');
  console.log('  ただし本日のケースでは押し目が来ていないので、これが最も効果的');
  console.log('');
  console.log('【方法C】A+B併用（確認3本 + 押し目待ち2本）');
  console.log('  効果: 5分短縮');
  console.log('  リスク: 両方のリスクが加算される');
  console.log('');
  console.log('【方法D】押し目待ちを撤廃（確認完了後即エントリー）');
  console.log('  効果: 最大5分短縮');
  console.log('  リスク: 押し目確認なしでエントリーするため、高値掴みリスク増');
  console.log('  ただし「押し目なし・強トレンド」エントリーが多い場合は実質変わらない');

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
