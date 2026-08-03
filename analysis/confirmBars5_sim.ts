import { getDb } from "../server/db";
import { sql } from 'drizzle-orm';

/**
 * CONFIRM_BARS=5だった場合の本日(7/31)のシミュレーション
 * 
 * 大台確認ステートマシンの動作:
 * 1. 大台超えシグナル発火 → confirmCount=0 で登録
 * 2. 次のバーからconfirmCount++, close >= level を確認
 * 3. confirmCount >= CONFIRM_BARS で確認完了 → 押し目待ちへ
 * 
 * つまり CONFIRM_BARS=4 → シグナル発火後4本で確認完了
 *        CONFIRM_BARS=5 → シグナル発火後5本で確認完了
 * 
 * 本日のエントリー:
 * - 6857 BUY 13:48 大台32400円突破 (4本維持)
 * - 6857 BUY 14:20 大台32500円突破 (4本維持)
 * 
 * 押し目待ちステート: 確認完了後、MAX_WAIT=5本以内に押し目→反発でエントリー
 * 押し目タイムアウト: 5本以内に押し目なければ強トレンドエントリー（※廃止済み？確認要）
 */

async function main() {
  const db = await getDb();
  
  // 6857の全1分足を取得
  const [candles] = await db.execute(sql`
    SELECT candleTime, open, high, low, close, volume
    FROM rt_candles
    WHERE tradeDate = '2026-07-31' AND symbol = '6857'
    ORDER BY candleTime ASC
  `);
  
  const candleArr = candles as any[];
  
  // ケース1: 大台32400円突破
  // シグナル発火時刻を特定: エントリーが13:48で4本確認 → シグナルは13:44
  // confirmCount: 13:45=1, 13:46=2, 13:47=3, 13:48=4 → 確認完了 → 押し目待ち
  // 
  // CONFIRM_BARS=5の場合: 13:45=1, 13:46=2, 13:47=3, 13:48=4, 13:49=5 → 確認完了
  
  console.log("=== ケース1: 大台32400円突破 ===\n");
  
  // 実際のシグナル発火タイミングを逆算
  // エントリー13:48 = 押し目確認後のエントリー
  // 押し目待ちは確認完了後に始まる
  // 確認完了=13:48 (4本目) → 押し目待ち開始
  // 実際のエントリーは押し目確認後
  
  // ログから: 大台確認(4本維持) → 押し目確認後エントリー
  // エントリー13:48のreasonが「大台確認(4本維持)...押し目確認後」
  // つまり13:48は押し目確認完了時刻 = エントリー時刻
  
  // 大台確認完了 → 押し目待ち → 押し目確認 → エントリー
  // 4本確認完了が何時か、押し目確認が何時かを分離する必要がある
  
  // tradeTimeが13:48 = エントリー時刻
  // reasonに「押し目確認後」とある → 確認完了後に押し目待ちを経てエントリー
  // 確認完了時刻 ≠ エントリー時刻
  
  // 正確に再現するには、シグナル発火時刻を知る必要がある
  // rt_tradesのエントリーreasonから: 大台超え (32400円突破)
  // 32400円を最初に超えたバーを探す
  
  let firstAbove32400 = '';
  for (const c of candleArr) {
    if (Number(c.close) > 32400 && !firstAbove32400) {
      // ただし直前が32400以下である必要がある
      const idx = candleArr.indexOf(c);
      if (idx > 0 && Number(candleArr[idx-1].close) <= 32400) {
        firstAbove32400 = c.candleTime;
        console.log(`  32400円突破シグナル発火: ${c.candleTime} (close=${c.close})`);
      }
    }
  }
  
  // 13:00以降で32400を突破したバーを探す（午後の取引）
  console.log("\n  午後の32400円突破を探す:");
  let signalBar1 = '';
  for (let i = 1; i < candleArr.length; i++) {
    const prev = candleArr[i-1];
    const curr = candleArr[i];
    if (curr.candleTime >= '13:00' && Number(curr.close) > 32400 && Number(prev.close) <= 32400) {
      signalBar1 = curr.candleTime;
      console.log(`  → ${curr.candleTime}: close=${curr.close} (前バー close=${prev.close})`);
      break;
    }
  }
  
  if (signalBar1) {
    const sigIdx = candleArr.findIndex((c: any) => c.candleTime === signalBar1);
    console.log(`\n  確認バー推移 (シグナル: ${signalBar1}):`);
    for (let i = 1; i <= 6; i++) {
      if (sigIdx + i < candleArr.length) {
        const bar = candleArr[sigIdx + i];
        const valid = Number(bar.close) >= 32400;
        console.log(`    ${i}本目: ${bar.candleTime} close=${bar.close} >= 32400? ${valid}`);
      }
    }
    
    // CONFIRM_BARS=4: 4本目で確認完了
    const confirm4Time = candleArr[sigIdx + 4]?.candleTime;
    const confirm5Time = candleArr[sigIdx + 5]?.candleTime;
    console.log(`\n  CONFIRM_BARS=4 確認完了: ${confirm4Time}`);
    console.log(`  CONFIRM_BARS=5 確認完了: ${confirm5Time}`);
    
    // 確認完了後の押し目待ち(MAX_WAIT=5)
    console.log(`\n  --- CONFIRM_BARS=5 確認完了後の押し目待ち ---`);
    if (confirm5Time) {
      const c5Idx = candleArr.findIndex((c: any) => c.candleTime === confirm5Time);
      const signalPrice5 = Number(candleArr[c5Idx].close);
      console.log(`  確認完了時close(signalPrice): ${signalPrice5}`);
      for (let w = 1; w <= 5; w++) {
        if (c5Idx + w < candleArr.length) {
          const bar = candleArr[c5Idx + w];
          const pullback = Number(bar.low) < signalPrice5;
          const recovery = Number(bar.close) >= signalPrice5;
          console.log(`    wait${w}: ${bar.candleTime} L=${bar.low} C=${bar.close} | 押し目:${pullback} 回復:${recovery}`);
        }
      }
    }
  }
  
  // ケース2: 大台32500円突破
  console.log("\n\n=== ケース2: 大台32500円突破 ===\n");
  
  let signalBar2 = '';
  for (let i = 1; i < candleArr.length; i++) {
    const prev = candleArr[i-1];
    const curr = candleArr[i];
    if (curr.candleTime >= '14:00' && Number(curr.close) > 32500 && Number(prev.close) <= 32500) {
      signalBar2 = curr.candleTime;
      console.log(`  32500円突破シグナル発火: ${curr.candleTime} (close=${curr.close})`);
      break;
    }
  }
  
  if (signalBar2) {
    const sigIdx = candleArr.findIndex((c: any) => c.candleTime === signalBar2);
    console.log(`\n  確認バー推移 (シグナル: ${signalBar2}):`);
    for (let i = 1; i <= 6; i++) {
      if (sigIdx + i < candleArr.length) {
        const bar = candleArr[sigIdx + i];
        const valid = Number(bar.close) >= 32500;
        console.log(`    ${i}本目: ${bar.candleTime} close=${bar.close} >= 32500? ${valid}`);
      }
    }
    
    const confirm4Time = candleArr[sigIdx + 4]?.candleTime;
    const confirm5Time = candleArr[sigIdx + 5]?.candleTime;
    console.log(`\n  CONFIRM_BARS=4 確認完了: ${confirm4Time}`);
    console.log(`  CONFIRM_BARS=5 確認完了: ${confirm5Time}`);
    
    // 5本目が有効か確認
    if (sigIdx + 5 < candleArr.length) {
      const bar5 = candleArr[sigIdx + 5];
      console.log(`  5本目: ${bar5.candleTime} close=${bar5.close} >= 32500? ${Number(bar5.close) >= 32500}`);
    }
    
    if (confirm5Time) {
      const c5Idx = candleArr.findIndex((c: any) => c.candleTime === confirm5Time);
      const signalPrice5 = Number(candleArr[c5Idx].close);
      console.log(`\n  --- CONFIRM_BARS=5 確認完了後の押し目待ち ---`);
      console.log(`  確認完了時close(signalPrice): ${signalPrice5}`);
      for (let w = 1; w <= 5; w++) {
        if (c5Idx + w < candleArr.length) {
          const bar = candleArr[c5Idx + w];
          const pullback = Number(bar.low) < signalPrice5;
          const recovery = Number(bar.close) >= signalPrice5;
          console.log(`    wait${w}: ${bar.candleTime} L=${bar.low} C=${bar.close} | 押し目:${pullback} 回復:${recovery}`);
        }
      }
    }
  }
  
  // VWAPクロスと逆三尊はCONFIRM_BARSに無関係
  console.log("\n\n=== CONFIRM_BARSに無関係なトレード ===");
  console.log("  6758 VWAPクロス SHORT: -13,016円 → 変わらず");
  console.log("  6526 逆三尊 BUY: -12,600円 → 変わらず");
  
  process.exit(0);
}
main().catch(console.error);
