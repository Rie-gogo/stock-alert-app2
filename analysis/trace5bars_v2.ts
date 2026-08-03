import { getDb } from "../server/db";
import { sql } from 'drizzle-orm';

/**
 * 正確なトレース v2
 * 
 * 実績: 6857 BUY 13:48 @32620 「大台確認(4本維持): 大台超え (32400円突破) (押し目確認後)」
 * 
 * エントリー価格=32620, SL=32620*0.995=32457 → 実際のSL=32457円
 * 
 * フロー:
 * 1. シグナル発火: 大台超え(32400円突破) → confirmCount=0, level=32400
 * 2. 4本連続 close>=32400 → 確認完了, signalPrice=その時のclose
 * 3. 押し目待ち: close < signalPrice → pulledBack=true
 * 4. 回復: close > signalPrice → エントリー @close
 * 
 * エントリー@32620 → signalPriceは32620未満のはず（回復時のclose=32620）
 * 
 * CONFIRM_BARS=5の場合:
 * - 確認完了が1本遅れる → signalPriceが変わる → 押し目判定が変わる
 * - もしくは5本目でclose<32400になりキャンセル
 * 
 * 実際のタイミングを逆算:
 * エントリー13:48 @32620 (押し目確認後)
 * → 13:48のclose=32620で、これがpulledBack後の回復close
 * → signalPrice < 32620 (signalPriceを下回ってから回復)
 * 
 * 13:48のデータ: O:32470 H:32620 L:32470 C:32620
 * 前のバーでclose < signalPriceだったはず
 * 
 * 4本確認完了時のsignalPrice → 確認完了バーのclose
 * 確認完了から押し目確認まで何本かかったか
 */

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
  
  console.log("=== 6857 午後のバーデータ (13:30-14:35) ===\n");
  console.log("time   | close   | low     | high    | >=32400 | >=32500");
  for (const b of bars) {
    console.log(`${b.time} | ${b.close.toFixed(0).padStart(7)} | ${b.low.toFixed(0).padStart(7)} | ${b.high.toFixed(0).padStart(7)} | ${b.close >= 32400 ? 'Y' : 'N'}       | ${b.close >= 32500 ? 'Y' : 'N'}`);
  }
  
  // 32400突破シグナルの発火タイミング
  // エンジンのシグナル検出は各バー処理時に行われる
  // 「大台超え」は前のバーのcloseが大台未満で今のバーのcloseが大台以上の時に発火
  // ただし、既にpendingやpullbackステートがある場合は新規シグナルは発火しない
  
  console.log("\n\n=== 32400円突破シグナル候補 ===");
  for (let i = 1; i < bars.length; i++) {
    if (bars[i-1].close < 32400 && bars[i].close >= 32400) {
      console.log(`  ${bars[i].time}: close=${bars[i].close} (前バー=${bars[i-1].close})`);
    }
  }
  
  console.log("\n=== 32500円突破シグナル候補 ===");
  for (let i = 1; i < bars.length; i++) {
    if (bars[i-1].close < 32500 && bars[i].close >= 32500) {
      console.log(`  ${bars[i].time}: close=${bars[i].close} (前バー=${bars[i-1].close})`);
    }
  }
  
  // ケース1: 32400突破
  // 最初の候補を使ってトレース
  console.log("\n\n=== ケース1トレース: 32400円突破 ===");
  let sigIdx1 = -1;
  for (let i = 1; i < bars.length; i++) {
    if (bars[i-1].close < 32400 && bars[i].close >= 32400) {
      sigIdx1 = i;
      break;
    }
  }
  
  if (sigIdx1 >= 0) {
    console.log(`\nシグナル発火: ${bars[sigIdx1].time} close=${bars[sigIdx1].close}`);
    
    // CONFIRM_BARS=4
    console.log("\n--- CONFIRM_BARS=4 ---");
    let valid = true;
    let confirmEndIdx4 = -1;
    for (let j = 1; j <= 4; j++) {
      const idx = sigIdx1 + j;
      if (idx >= bars.length) { valid = false; break; }
      const ok = bars[idx].close >= 32400;
      console.log(`  確認${j}: ${bars[idx].time} close=${bars[idx].close} ${ok ? '✓' : '✗'}`);
      if (!ok) { valid = false; break; }
      if (j === 4) confirmEndIdx4 = idx;
    }
    
    if (valid && confirmEndIdx4 >= 0) {
      const sp4 = bars[confirmEndIdx4].close;
      console.log(`  確認完了: ${bars[confirmEndIdx4].time} signalPrice=${sp4}`);
      
      // 押し目待ち
      let pulledBack = false;
      for (let w = 1; w <= 5; w++) {
        const idx = confirmEndIdx4 + w;
        if (idx >= bars.length) break;
        if (bars[idx].close < sp4) pulledBack = true;
        const recovery = pulledBack && bars[idx].close > sp4;
        console.log(`  wait${w}: ${bars[idx].time} C=${bars[idx].close} | pb=${pulledBack} rec=${recovery}`);
        if (recovery) {
          console.log(`  → エントリー: ${bars[idx].time} @${bars[idx].close}`);
          break;
        }
        if (w === 5 && !recovery) {
          console.log(`  → タイムアウト: ${bars[idx].time} @${bars[idx].close}`);
        }
      }
    } else {
      console.log("  → 確認失敗（キャンセル）");
    }
    
    // CONFIRM_BARS=5
    console.log("\n--- CONFIRM_BARS=5 ---");
    valid = true;
    let confirmEndIdx5 = -1;
    for (let j = 1; j <= 5; j++) {
      const idx = sigIdx1 + j;
      if (idx >= bars.length) { valid = false; break; }
      const ok = bars[idx].close >= 32400;
      console.log(`  確認${j}: ${bars[idx].time} close=${bars[idx].close} ${ok ? '✓' : '✗'}`);
      if (!ok) { valid = false; break; }
      if (j === 5) confirmEndIdx5 = idx;
    }
    
    if (valid && confirmEndIdx5 >= 0) {
      const sp5 = bars[confirmEndIdx5].close;
      console.log(`  確認完了: ${bars[confirmEndIdx5].time} signalPrice=${sp5}`);
      
      let pulledBack = false;
      for (let w = 1; w <= 5; w++) {
        const idx = confirmEndIdx5 + w;
        if (idx >= bars.length) break;
        if (bars[idx].close < sp5) pulledBack = true;
        const recovery = pulledBack && bars[idx].close > sp5;
        console.log(`  wait${w}: ${bars[idx].time} C=${bars[idx].close} | pb=${pulledBack} rec=${recovery}`);
        if (recovery) {
          console.log(`  → エントリー: ${bars[idx].time} @${bars[idx].close}`);
          
          // 決済シミュレーション
          const ep = bars[idx].close;
          const sl = Math.round(ep * 0.995 * 100) / 100;
          const tp = Math.round(ep * 1.015 * 100) / 100;
          console.log(`  → SL:${sl} TP:${tp}`);
          for (let k = idx + 1; k < bars.length; k++) {
            if (bars[k].low <= sl) {
              const pnl = Math.round((sl - ep) * 100);
              console.log(`  → 損切り: ${bars[k].time} PnL=${pnl.toLocaleString()}円`);
              break;
            }
            if (bars[k].high >= tp) {
              const pnl = Math.round((tp - ep) * 100);
              console.log(`  → 利確: ${bars[k].time} PnL=+${pnl.toLocaleString()}円`);
              break;
            }
          }
          break;
        }
        if (w === 5 && !recovery) {
          console.log(`  → タイムアウトエントリー: ${bars[idx].time} @${bars[idx].close}`);
          const ep = bars[idx].close;
          const sl = Math.round(ep * 0.995 * 100) / 100;
          const tp = Math.round(ep * 1.015 * 100) / 100;
          console.log(`  → SL:${sl} TP:${tp}`);
          for (let k = idx + 1; k < bars.length; k++) {
            if (bars[k].low <= sl) {
              const pnl = Math.round((sl - ep) * 100);
              console.log(`  → 損切り: ${bars[k].time} PnL=${pnl.toLocaleString()}円`);
              break;
            }
            if (bars[k].high >= tp) {
              const pnl = Math.round((tp - ep) * 100);
              console.log(`  → 利確: ${bars[k].time} PnL=+${pnl.toLocaleString()}円`);
              break;
            }
          }
        }
      }
    } else {
      console.log("  → 確認失敗（キャンセル）→ このシグナルは発動しない");
    }
  }
  
  process.exit(0);
}
main().catch(console.error);
