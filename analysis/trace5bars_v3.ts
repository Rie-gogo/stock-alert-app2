import { getDb } from "../server/db";
import { sql } from 'drizzle-orm';

async function main() {
  const db = await getDb();
  
  const [candles] = await db.execute(sql`
    SELECT candleTime, open, high, low, close, volume
    FROM rt_candles
    WHERE tradeDate = '2026-07-31' AND symbol = '6857'
    AND candleTime >= '13:30' AND candleTime <= '14:35'
    ORDER BY candleTime ASC
  `);
  
  const bars = (candles as any[]).map((c: any) => ({
    time: c.candleTime as string,
    close: Number(c.close),
    low: Number(c.low),
    high: Number(c.high),
  }));
  
  function traceRoundLevel(level: number, startSearchTime: string) {
    console.log(`\n=== ${level}円突破トレース (${startSearchTime}以降) ===`);
    
    // Find all signal candidates
    const candidates: number[] = [];
    for (let i = 1; i < bars.length; i++) {
      if (bars[i].time < startSearchTime) continue;
      if (bars[i-1].close < level && bars[i].close >= level) {
        candidates.push(i);
      }
    }
    console.log(`  シグナル候補: ${candidates.map(i => `${bars[i].time}(${bars[i].close})`).join(', ')}`);
    
    // Try each candidate - the engine tries the first one, if it fails, the next signal fires
    for (const sigIdx of candidates) {
      console.log(`\n  --- シグナル: ${bars[sigIdx].time} close=${bars[sigIdx].close} ---`);
      
      // CONFIRM_BARS=4
      let valid4 = true;
      let confirmEnd4 = -1;
      for (let j = 1; j <= 4; j++) {
        const idx = sigIdx + j;
        if (idx >= bars.length) { valid4 = false; break; }
        if (bars[idx].close < level) { valid4 = false; console.log(`    4本: ${j}本目 ${bars[idx].time} close=${bars[idx].close} < ${level} → FAIL`); break; }
        if (j === 4) confirmEnd4 = idx;
      }
      
      // CONFIRM_BARS=5
      let valid5 = true;
      let confirmEnd5 = -1;
      for (let j = 1; j <= 5; j++) {
        const idx = sigIdx + j;
        if (idx >= bars.length) { valid5 = false; break; }
        if (bars[idx].close < level) { valid5 = false; console.log(`    5本: ${j}本目 ${bars[idx].time} close=${bars[idx].close} < ${level} → FAIL`); break; }
        if (j === 5) confirmEnd5 = idx;
      }
      
      if (valid4) {
        const sp4 = bars[confirmEnd4].close;
        console.log(`    4本確認OK: ${bars[confirmEnd4].time} signalPrice=${sp4}`);
        
        // 押し目待ち
        let pb = false;
        let entryTime4 = '';
        let entryPrice4 = 0;
        for (let w = 1; w <= 5; w++) {
          const idx = confirmEnd4 + w;
          if (idx >= bars.length) break;
          if (bars[idx].close < sp4) pb = true;
          if (pb && bars[idx].close > sp4) {
            entryTime4 = bars[idx].time;
            entryPrice4 = bars[idx].close;
            break;
          }
          if (w === 5) {
            entryTime4 = bars[idx].time;
            entryPrice4 = bars[idx].close;
            console.log(`    4本: タイムアウトエントリー`);
          }
        }
        if (entryTime4) {
          console.log(`    4本エントリー: ${entryTime4} @${entryPrice4}`);
          // 決済
          const sl = Math.round(entryPrice4 * 0.995 * 100) / 100;
          const tp = Math.round(entryPrice4 * 1.015 * 100) / 100;
          const entryIdx = bars.findIndex(b => b.time === entryTime4);
          for (let k = entryIdx + 1; k < bars.length; k++) {
            if (bars[k].low <= sl) {
              console.log(`    4本結果: 損切り ${bars[k].time} PnL=${Math.round((sl - entryPrice4) * 100).toLocaleString()}円`);
              break;
            }
            if (bars[k].high >= tp) {
              console.log(`    4本結果: 利確 ${bars[k].time} PnL=+${Math.round((tp - entryPrice4) * 100).toLocaleString()}円`);
              break;
            }
          }
        }
      } else {
        console.log(`    4本確認: FAIL → キャンセル`);
      }
      
      if (valid5) {
        const sp5 = bars[confirmEnd5].close;
        console.log(`    5本確認OK: ${bars[confirmEnd5].time} signalPrice=${sp5}`);
        
        let pb = false;
        let entryTime5 = '';
        let entryPrice5 = 0;
        for (let w = 1; w <= 5; w++) {
          const idx = confirmEnd5 + w;
          if (idx >= bars.length) break;
          if (bars[idx].close < sp5) pb = true;
          if (pb && bars[idx].close > sp5) {
            entryTime5 = bars[idx].time;
            entryPrice5 = bars[idx].close;
            break;
          }
          if (w === 5) {
            entryTime5 = bars[idx].time;
            entryPrice5 = bars[idx].close;
            console.log(`    5本: タイムアウトエントリー`);
          }
        }
        if (entryTime5) {
          console.log(`    5本エントリー: ${entryTime5} @${entryPrice5}`);
          const sl = Math.round(entryPrice5 * 0.995 * 100) / 100;
          const tp = Math.round(entryPrice5 * 1.015 * 100) / 100;
          const entryIdx = bars.findIndex(b => b.time === entryTime5);
          for (let k = entryIdx + 1; k < bars.length; k++) {
            if (bars[k].low <= sl) {
              console.log(`    5本結果: 損切り ${bars[k].time} PnL=${Math.round((sl - entryPrice5) * 100).toLocaleString()}円`);
              break;
            }
            if (bars[k].high >= tp) {
              console.log(`    5本結果: 利確 ${bars[k].time} PnL=+${Math.round((tp - entryPrice5) * 100).toLocaleString()}円`);
              break;
            }
          }
        }
      } else {
        console.log(`    5本確認: FAIL → キャンセル`);
      }
      
      // If 4-bar confirmed, this is the signal that actually fired (engine uses first valid)
      if (valid4) {
        console.log(`    ★ このシグナルが実際に発動 (4本確認成功)`);
        break;
      }
      // If 4-bar failed, engine cancels and next bar's signal might fire
    }
  }
  
  // Trace 32400 breakout
  traceRoundLevel(32400, '13:30');
  
  // Trace 32500 breakout (after first trade exits at 13:51)
  traceRoundLevel(32500, '13:51');
  
  process.exit(0);
}
main().catch(console.error);
