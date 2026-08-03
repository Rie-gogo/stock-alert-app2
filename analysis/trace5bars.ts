import { getDb } from "../server/db";
import { sql } from 'drizzle-orm';

/**
 * 正確なトレース: 実際のエンジンの挙動を再現
 * 
 * 実績のトレード:
 * #2: 6857 BUY 13:48 @32620 「大台確認(4本維持): 大台超え (32400円突破)｜[信頼度：中] トレンド一致・勢い一致・出来高薄 (押し目確認後」
 * #4: 6857 BUY 14:20 @32710 「大台確認(4本維持): 大台超え (32500円突破)｜[信頼度：中] トレンド一致・勢い一致・出来高薄 (押し目確認後」
 * 
 * 「押し目確認後」とあるので、確認完了→押し目待ち→押し目確認→エントリーの流れ。
 * 
 * CONFIRM_BARS=5の場合:
 * - 確認完了が1本遅れる
 * - その1本遅れた時点でのcloseがsignalPriceになる
 * - 押し目待ちの挙動が変わる可能性
 * 
 * ただし重要: 実際のエンジンには多くのフィルターがある
 * - MAX_CONCURRENT_POSITIONS=3
 * - MAX_PER_SECTOR=2
 * - isBullish判定
 * - board score check
 * - confidence check (medium → 大台確認ステートマシン経由なら通過)
 * 
 * 最も正確な方法: 実際のエンジンコードを一時的にCONFIRM_BARS=5に変えて
 * 本日のrt_candlesを再処理する。
 * 
 * しかしここでは、大台確認の2件について手動トレースする。
 */

async function main() {
  const db = await getDb();
  
  const [candles] = await db.execute(sql`
    SELECT candleTime, open, high, low, close, volume
    FROM rt_candles
    WHERE tradeDate = '2026-07-31' AND symbol = '6857'
    ORDER BY candleTime ASC
  `);
  
  const bars = (candles as any[]).map((c: any) => ({
    time: c.candleTime as string,
    open: Number(c.open),
    high: Number(c.high),
    low: Number(c.low),
    close: Number(c.close),
    volume: Number(c.volume),
  }));
  
  // ケース1: 32400円突破
  // エントリーreason: "大台超え (32400円突破)" → level=32400
  // 実績: 4本確認完了 → 押し目確認後 → 13:48 @32620 エントリー
  
  // 32400を超えた最初のバー（午後）を特定
  // 午前中にも32400超えがあるが、午前のトレードは別（VWAPクロスのみ）
  // 実際のエンジンでは、一度ポジションを持つと同一銘柄のpendingはキャンセルされる
  // 午前中はVWAPクロスのSHORTポジション(10:54-11:14)があった
  
  console.log("=== ケース1: 32400円突破 (BUY) ===\n");
  
  // 13:00以降で32400を初めて超えたバーを探す
  // ただし実際のエンジンでは、前のバーのcloseが32400未満で今のバーが32400以上の時にシグナル発火
  let signalTime1 = '';
  for (let i = 1; i < bars.length; i++) {
    if (bars[i].time < '13:00') continue;
    if (bars[i-1].close < 32400 && bars[i].close >= 32400) {
      signalTime1 = bars[i].time;
      console.log(`  シグナル発火: ${bars[i].time} close=${bars[i].close} (前バー close=${bars[i-1].close})`);
      
      // 確認バー (CONFIRM_BARS=4)
      console.log(`\n  --- CONFIRM_BARS=4 ---`);
      let valid4 = true;
      for (let j = 1; j <= 4; j++) {
        const b = bars[i+j];
        if (b) {
          const ok = b.close >= 32400;
          console.log(`    ${j}本目: ${b.time} close=${b.close} >= 32400? ${ok}`);
          if (!ok) { valid4 = false; break; }
        }
      }
      if (valid4) {
        const confirmBar4 = bars[i+4];
        console.log(`  → 4本確認完了: ${confirmBar4.time} signalPrice=${confirmBar4.close}`);
        
        // 押し目待ち
        const sp4 = confirmBar4.close;
        console.log(`  → 押し目待ち (signalPrice=${sp4}):`);
        let entered4 = false;
        let pulledBack4 = false;
        for (let w = 1; w <= 5; w++) {
          const b = bars[i+4+w];
          if (b) {
            if (b.low < sp4) pulledBack4 = true;
            const recovery = pulledBack4 && b.close >= sp4;
            console.log(`    wait${w}: ${b.time} L=${b.low} C=${b.close} | 押し目:${pulledBack4} 回復:${recovery}`);
            if (recovery) {
              console.log(`  → エントリー: ${b.time} @${b.close}`);
              entered4 = true;
              break;
            }
          }
        }
        if (!entered4) {
          const timeoutBar = bars[i+4+5];
          if (timeoutBar) console.log(`  → タイムアウトエントリー: ${timeoutBar.time} @${timeoutBar.close}`);
        }
      }
      
      // 確認バー (CONFIRM_BARS=5)
      console.log(`\n  --- CONFIRM_BARS=5 ---`);
      let valid5 = true;
      for (let j = 1; j <= 5; j++) {
        const b = bars[i+j];
        if (b) {
          const ok = b.close >= 32400;
          console.log(`    ${j}本目: ${b.time} close=${b.close} >= 32400? ${ok}`);
          if (!ok) { valid5 = false; break; }
        }
      }
      if (valid5) {
        const confirmBar5 = bars[i+5];
        console.log(`  → 5本確認完了: ${confirmBar5.time} signalPrice=${confirmBar5.close}`);
        
        const sp5 = confirmBar5.close;
        console.log(`  → 押し目待ち (signalPrice=${sp5}):`);
        let entered5 = false;
        let pulledBack5 = false;
        for (let w = 1; w <= 5; w++) {
          const b = bars[i+5+w];
          if (b) {
            if (b.low < sp5) pulledBack5 = true;
            const recovery = pulledBack5 && b.close >= sp5;
            console.log(`    wait${w}: ${b.time} L=${b.low} C=${b.close} | 押し目:${pulledBack5} 回復:${recovery}`);
            if (recovery) {
              console.log(`  → エントリー: ${b.time} @${b.close}`);
              entered5 = true;
              
              // SL/TP計算
              const ep = b.close;
              const sl = Math.round(ep * 0.995 * 100) / 100;
              const tp = Math.round(ep * 1.015 * 100) / 100;
              console.log(`  → SL:${sl} TP:${tp}`);
              
              // 決済シミュレーション
              const entryIdx = bars.indexOf(b);
              for (let k = entryIdx + 1; k < bars.length; k++) {
                if (bars[k].low <= sl) {
                  const pnl = Math.round((sl - ep) * 100);
                  console.log(`  → 損切り: ${bars[k].time} @${sl} PnL=${pnl.toLocaleString()}円`);
                  break;
                }
                if (bars[k].high >= tp) {
                  const pnl = Math.round((tp - ep) * 100);
                  console.log(`  → 利確: ${bars[k].time} @${tp} PnL=+${pnl.toLocaleString()}円`);
                  break;
                }
                if (bars[k].time >= '15:25') {
                  const pnl = Math.round((bars[k].close - ep) * 100);
                  console.log(`  → EOD: ${bars[k].time} @${bars[k].close} PnL=${pnl.toLocaleString()}円`);
                  break;
                }
              }
              break;
            }
          }
        }
        if (!entered5) {
          const timeoutBar = bars[i+5+5];
          if (timeoutBar) {
            console.log(`  → タイムアウトエントリー: ${timeoutBar.time} @${timeoutBar.close}`);
            const ep = timeoutBar.close;
            const sl = Math.round(ep * 0.995 * 100) / 100;
            const tp = Math.round(ep * 1.015 * 100) / 100;
            console.log(`  → SL:${sl} TP:${tp}`);
            const entryIdx = bars.indexOf(timeoutBar);
            for (let k = entryIdx + 1; k < bars.length; k++) {
              if (bars[k].low <= sl) {
                const pnl = Math.round((sl - ep) * 100);
                console.log(`  → 損切り: ${bars[k].time} @${sl} PnL=${pnl.toLocaleString()}円`);
                break;
              }
              if (bars[k].high >= tp) {
                const pnl = Math.round((tp - ep) * 100);
                console.log(`  → 利確: ${bars[k].time} @${tp} PnL=+${pnl.toLocaleString()}円`);
                break;
              }
              if (bars[k].time >= '15:25') {
                const pnl = Math.round((bars[k].close - ep) * 100);
                console.log(`  → EOD: ${bars[k].time} @${bars[k].close} PnL=${pnl.toLocaleString()}円`);
                break;
              }
            }
          }
        }
      } else {
        console.log(`  → 5本確認失敗 → シグナルキャンセル`);
      }
      
      break;
    }
  }
  
  // ケース2: 32500円突破
  console.log("\n\n=== ケース2: 32500円突破 (BUY) ===\n");
  
  // 14:00以降で32500を初めて超えたバーを探す
  for (let i = 1; i < bars.length; i++) {
    if (bars[i].time < '14:00') continue;
    if (bars[i-1].close < 32500 && bars[i].close >= 32500) {
      console.log(`  シグナル発火: ${bars[i].time} close=${bars[i].close} (前バー close=${bars[i-1].close})`);
      
      // CONFIRM_BARS=4
      console.log(`\n  --- CONFIRM_BARS=4 ---`);
      let valid4 = true;
      for (let j = 1; j <= 4; j++) {
        const b = bars[i+j];
        if (b) {
          const ok = b.close >= 32500;
          console.log(`    ${j}本目: ${b.time} close=${b.close} >= 32500? ${ok}`);
          if (!ok) { valid4 = false; break; }
        }
      }
      
      // CONFIRM_BARS=5
      console.log(`\n  --- CONFIRM_BARS=5 ---`);
      let valid5 = true;
      for (let j = 1; j <= 5; j++) {
        const b = bars[i+j];
        if (b) {
          const ok = b.close >= 32500;
          console.log(`    ${j}本目: ${b.time} close=${b.close} >= 32500? ${ok}`);
          if (!ok) { valid5 = false; break; }
        }
      }
      
      if (!valid5) {
        console.log(`  → 5本確認失敗 → シグナルキャンセル`);
      } else {
        const confirmBar5 = bars[i+5];
        console.log(`  → 5本確認完了: ${confirmBar5.time} signalPrice=${confirmBar5.close}`);
        // 押し目待ち
        const sp5 = confirmBar5.close;
        console.log(`  → 押し目待ち (signalPrice=${sp5}):`);
        let entered5 = false;
        let pulledBack5 = false;
        for (let w = 1; w <= 5; w++) {
          const b = bars[i+5+w];
          if (b) {
            if (b.low < sp5) pulledBack5 = true;
            const recovery = pulledBack5 && b.close >= sp5;
            console.log(`    wait${w}: ${b.time} L=${b.low} C=${b.close} | 押し目:${pulledBack5} 回復:${recovery}`);
            if (recovery) {
              console.log(`  → エントリー: ${b.time} @${b.close}`);
              entered5 = true;
              const ep = b.close;
              const sl = Math.round(ep * 0.995 * 100) / 100;
              const tp = Math.round(ep * 1.015 * 100) / 100;
              console.log(`  → SL:${sl} TP:${tp}`);
              const entryIdx = bars.indexOf(b);
              for (let k = entryIdx + 1; k < bars.length; k++) {
                if (bars[k].low <= sl) {
                  const pnl = Math.round((sl - ep) * 100);
                  console.log(`  → 損切り: ${bars[k].time} @${sl} PnL=${pnl.toLocaleString()}円`);
                  break;
                }
                if (bars[k].high >= tp) {
                  const pnl = Math.round((tp - ep) * 100);
                  console.log(`  → 利確: ${bars[k].time} @${tp} PnL=+${pnl.toLocaleString()}円`);
                  break;
                }
                if (bars[k].time >= '15:25') {
                  const pnl = Math.round((bars[k].close - ep) * 100);
                  console.log(`  → EOD: ${bars[k].time} @${bars[k].close} PnL=${pnl.toLocaleString()}円`);
                  break;
                }
              }
              break;
            }
          }
        }
        if (!entered5) {
          const timeoutBar = bars[i+5+5];
          if (timeoutBar) {
            console.log(`  → タイムアウトエントリー: ${timeoutBar.time} @${timeoutBar.close}`);
            const ep = timeoutBar.close;
            const sl = Math.round(ep * 0.995 * 100) / 100;
            const tp = Math.round(ep * 1.015 * 100) / 100;
            console.log(`  → SL:${sl} TP:${tp}`);
            const entryIdx = bars.indexOf(timeoutBar);
            for (let k = entryIdx + 1; k < bars.length; k++) {
              if (bars[k].low <= sl) {
                const pnl = Math.round((sl - ep) * 100);
                console.log(`  → 損切り: ${bars[k].time} @${sl} PnL=${pnl.toLocaleString()}円`);
                break;
              }
              if (bars[k].high >= tp) {
                const pnl = Math.round((tp - ep) * 100);
                console.log(`  → 利確: ${bars[k].time} @${tp} PnL=+${pnl.toLocaleString()}円`);
                break;
              }
              if (bars[k].time >= '15:25') {
                const pnl = Math.round((bars[k].close - ep) * 100);
                console.log(`  → EOD: ${bars[k].time} @${bars[k].close} PnL=${pnl.toLocaleString()}円`);
                break;
              }
            }
          }
        }
      }
      break;
    }
  }
  
  process.exit(0);
}
main().catch(console.error);
