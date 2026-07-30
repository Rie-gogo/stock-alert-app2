import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

async function main() {
  const db = await getDb();
  const todayStr = '2026-07-30';
  
  console.log('=== 7/30 「強トレンドエントリー廃止」シミュレーション ===\n');
  
  // Get all today's entries
  const entries = await db.execute(sql`
    SELECT symbol, symbolName, action, tradeTime, price, shares, pnl, reason, side, boardSignal
    FROM rt_trades 
    WHERE tradeDate = ${todayStr}
    ORDER BY tradeTime
  `);
  const rows = (entries as any)[0];
  
  console.log('--- 本日の全エントリー（現行ロジック） ---\n');
  
  let currentPnl = 0;
  let newPnl = 0;
  let removedEntries: string[] = [];
  let keptEntries: string[] = [];
  
  for (let i = 0; i < rows.length; i += 2) {
    const entry = rows[i];
    const exit = rows[i + 1];
    if (!entry || !exit) continue;
    
    const isStrongTrend = entry.reason.includes('押し目なし・強トレンド');
    const isPullback = entry.reason.includes('押し目確認後');
    const pnl = exit.pnl ? Number(exit.pnl) : 0;
    currentPnl += pnl;
    
    const status = isStrongTrend ? '【廃止対象】' : isPullback ? '【維持】' : '【維持（その他）】';
    
    console.log(`${status} ${entry.tradeTime} | ${entry.symbol}(${entry.symbolName}) | ${entry.side} | ¥${entry.price}`);
    console.log(`  理由: ${entry.reason.substring(0, 80)}`);
    console.log(`  決済: ${exit.tradeTime} | ¥${exit.price} | PnL=${pnl.toLocaleString()}円 | ${exit.reason.substring(0, 40)}`);
    console.log('');
    
    if (isStrongTrend) {
      removedEntries.push(`${entry.symbol} ${entry.tradeTime} PnL=${pnl.toLocaleString()}円`);
    } else {
      keptEntries.push(`${entry.symbol} ${entry.tradeTime} PnL=${pnl.toLocaleString()}円`);
      newPnl += pnl;
    }
  }
  
  console.log('\n--- 結果比較 ---\n');
  console.log(`現行ロジック: ${rows.length / 2}件のエントリー | 総PnL = ${currentPnl.toLocaleString()}円`);
  console.log(`改善後:       ${keptEntries.length}件のエントリー | 総PnL = ${newPnl.toLocaleString()}円`);
  console.log(`差分:         ${(newPnl - currentPnl).toLocaleString()}円の改善`);
  
  console.log('\n--- 廃止されるエントリー ---');
  for (const e of removedEntries) {
    console.log(`  ✕ ${e}`);
  }
  
  console.log('\n--- 維持されるエントリー ---');
  for (const e of keptEntries) {
    console.log(`  ✓ ${e}`);
  }
  
  // Now check: would there have been pullback entries for the removed symbols?
  // i.e., if we didn't enter on strong trend timeout, would a pullback have occurred later?
  console.log('\n\n=== 廃止対象の銘柄: 押し目は来たか？ ===\n');
  
  // For each strong trend entry, check if price pulled back and then recovered
  for (let i = 0; i < rows.length; i += 2) {
    const entry = rows[i];
    if (!entry.reason.includes('押し目なし・強トレンド')) continue;
    
    const entryPrice = Number(entry.price);
    const entryTime = entry.tradeTime;
    
    // Get candles after entry to see if a pullback occurred
    const afterCandles = await db.execute(sql`
      SELECT candleTime, open, high, low, close
      FROM rt_candles 
      WHERE tradeDate = ${todayStr} AND symbol = ${entry.symbol}
        AND candleTime > ${entryTime} AND candleTime <= '15:30'
      ORDER BY candleTime
      LIMIT 30
    `);
    
    const afterRows = (afterCandles as any)[0];
    console.log(`[${entry.symbol}] エントリー: ${entryTime} ¥${entryPrice}`);
    
    // Check if price dropped below entry and then recovered
    let minAfter = Infinity;
    let maxAfter = 0;
    let minTime = '';
    let maxTime = '';
    
    for (const c of afterRows) {
      const low = Number(c.low);
      const high = Number(c.high);
      if (low < minAfter) { minAfter = low; minTime = c.candleTime; }
      if (high > maxAfter) { maxAfter = high; maxTime = c.candleTime; }
    }
    
    const dropPct = ((entryPrice - minAfter) / entryPrice * 100).toFixed(2);
    const risePct = ((maxAfter - entryPrice) / entryPrice * 100).toFixed(2);
    
    console.log(`  エントリー後30分の値動き:`);
    console.log(`  最安値: ¥${minAfter} (${minTime}) → -${dropPct}%`);
    console.log(`  最高値: ¥${maxAfter} (${maxTime}) → +${risePct}%`);
    
    // Check if there was a pullback pattern (drop then recovery above entry)
    let pulledBack = false;
    let recovered = false;
    let pullbackTime = '';
    let recoveryTime = '';
    
    for (const c of afterRows) {
      const close = Number(c.close);
      if (!pulledBack && close < entryPrice * 0.998) {
        pulledBack = true;
        pullbackTime = c.candleTime;
      }
      if (pulledBack && !recovered && close > entryPrice) {
        recovered = true;
        recoveryTime = c.candleTime;
      }
    }
    
    if (pulledBack && recovered) {
      console.log(`  → 押し目あり！ ${pullbackTime}に下落 → ${recoveryTime}に回復`);
      console.log(`  → 押し目確認後エントリーなら${recoveryTime}にエントリー可能だった`);
    } else if (pulledBack && !recovered) {
      console.log(`  → 下落のみ（回復なし）→ エントリーしないのが正解`);
    } else {
      console.log(`  → 押し目なし（一方的に下落 or 横ばい）`);
    }
    console.log('');
  }
  
  // Also check the 6976 entry (the only winner today) - it was NOT a 大台確認 entry
  console.log('\n=== 6976（本日唯一の勝ちトレード）の詳細 ===');
  const trade6976 = rows.filter((r: any) => r.symbol === '6976');
  for (const t of trade6976) {
    console.log(`  ${t.tradeTime} | ${t.action} | ¥${t.price} | PnL=${t.pnl || '-'} | ${t.reason.substring(0, 80)}`);
  }

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
